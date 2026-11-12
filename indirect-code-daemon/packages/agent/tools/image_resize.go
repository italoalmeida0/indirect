package tools

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"math"
	"strconv"
	"strings"

	"golang.org/x/image/bmp"
	"golang.org/x/image/draw"
	"golang.org/x/image/webp"
)

const (
	// MaxRawImageFileBytes is the hard pre-read / pre-decode input ceiling (50 MiB).
	MaxRawImageFileBytes = 50 * 1024 * 1024
	maxRawImageFileBytes = MaxRawImageFileBytes

	// maxImageDimension caps the longest edge at Anthropic/OpenAI optimal tile size,
	// avoiding multi-tile token explosion and Anthropic's >20-image 2000px cliff.
	maxImageDimension = 1568

	// maxImageRawBytes caps wire image bytes (~1.5 MiB base64).
	maxImageRawBytes = 1_125_000

	// passthroughMaxRawBytes allows small, already-compact supported images through verbatim.
	passthroughMaxRawBytes = 260 * 1024

	// transparentPNGMaxRawBytes preserves alpha as PNG only when compact.
	transparentPNGMaxRawBytes = 450 * 1024

	previewMaxDimension    = 320
	previewMaxDataURLBytes = 48 * 1024
)

var jpegQualitySchedule = []int{82, 72, 60, 45}

// NormalizedImage holds wire-safe image bytes, dimensions, content hash, and UI preview.
type NormalizedImage struct {
	Data           string
	RawBytes       []byte
	MimeType       string
	OrigMime       string
	Width          int
	Height         int
	OrigWidth      int
	OrigHeight     int
	OrigBytes      int
	SHA256         string
	PreviewDataURL string
	Hints          []string
}

type processedImage struct {
	data           []byte
	mimeType       string
	originalWidth  int
	originalHeight int
	width          int
	height         int
	wasResized     bool
	hints          []string
}

var (
	errUnsupportedImage = errors.New("[Image omitted: could not be converted to a supported inline image format.]")
	errImageTooLarge    = errors.New("[Image omitted: could not be resized below the inline image size limit.]")
)

// NormalizeImage validates, resizes (<=1568px), smart-compresses (opaque -> JPEG first,
// transparent -> PNG only if <=450 KiB), hashes, and builds a <=320px UI thumbnail.
func NormalizeImage(data []byte, mimeHint string) (NormalizedImage, error) {
	if len(data) == 0 {
		return NormalizedImage{}, errUnsupportedImage
	}
	if len(data) > MaxRawImageFileBytes {
		return NormalizedImage{}, fmt.Errorf("[Image omitted: %d bytes exceeds 50MB input limit.]", len(data))
	}

	origMime := canonicalSourceMIME(sniffImageMIME(data))
	if origMime == "" {
		origMime = canonicalSourceMIME(mimeHint)
	}
	if origMime == "" {
		return NormalizedImage{}, errUnsupportedImage
	}

	origBytes := len(data)
	cfg, format, err := decodeImageConfig(data)
	if err != nil {
		// Extended/animated WebP variants that golang.org/x/image/webp cannot
		// decode can still pass through verbatim when within the wire byte cap.
		if origMime == "image/webp" {
			if len(data) <= maxImageRawBytes {
				rawCopy := bytes.Clone(data)
				return NormalizedImage{
					Data:      base64.StdEncoding.EncodeToString(rawCopy),
					RawBytes:  rawCopy,
					MimeType:  "image/webp",
					OrigMime:  "image/webp",
					OrigBytes: origBytes,
					SHA256:    sha256Hex(rawCopy),
				}, nil
			}
			return NormalizedImage{}, errImageTooLarge
		}
		return NormalizedImage{}, errUnsupportedImage
	}

	origW, origH := cfg.Width, cfg.Height
	if origW <= 0 || origH <= 0 {
		return NormalizedImage{}, errUnsupportedImage
	}

	canPassthroughFormat := origMime == "image/jpeg" ||
		(origMime == "image/png" && format == "png") ||
		origMime == "image/gif" ||
		origMime == "image/webp"

	if canPassthroughFormat && origW <= maxImageDimension && origH <= maxImageDimension && len(data) <= passthroughMaxRawBytes {
		rawCopy := bytes.Clone(data)
		b64 := base64.StdEncoding.EncodeToString(rawCopy)
		preview := buildPassthroughPreview(rawCopy, b64, format, origMime, origW, origH)
		return NormalizedImage{
			Data:           b64,
			RawBytes:       rawCopy,
			MimeType:       origMime,
			OrigMime:       origMime,
			Width:          origW,
			Height:         origH,
			OrigWidth:      origW,
			OrigHeight:     origH,
			OrigBytes:      origBytes,
			SHA256:         sha256Hex(rawCopy),
			PreviewDataURL: preview,
		}, nil
	}

	img, err := decodeImage(data, format)
	if err != nil {
		if origMime == "image/webp" && len(data) <= maxImageRawBytes {
			rawCopy := bytes.Clone(data)
			return NormalizedImage{
				Data:       base64.StdEncoding.EncodeToString(rawCopy),
				RawBytes:   rawCopy,
				MimeType:   "image/webp",
				OrigMime:   "image/webp",
				Width:      origW,
				Height:     origH,
				OrigWidth:  origW,
				OrigHeight: origH,
				OrigBytes:  origBytes,
				SHA256:     sha256Hex(rawCopy),
			}, nil
		}
		return NormalizedImage{}, errUnsupportedImage
	}

	baseW, baseH := fitDimensions(origW, origH, maxImageDimension, maxImageDimension)
	scaleSteps := []float64{1.0, 0.75, 0.5}
	targetW, targetH := baseW, baseH

	for stepIdx := 0; ; stepIdx++ {
		if stepIdx < len(scaleSteps) {
			s := scaleSteps[stepIdx]
			if s < 1.0 {
				targetW = maxInt(1, int(math.Round(float64(baseW)*s)))
				targetH = maxInt(1, int(math.Round(float64(baseH)*s)))
			}
		} else {
			if targetW == 1 && targetH == 1 {
				break
			}
			nextW := maxInt(1, int(math.Floor(float64(targetW)*0.75)))
			nextH := maxInt(1, int(math.Floor(float64(targetH)*0.75)))
			if nextW == targetW && nextH == targetH {
				break
			}
			targetW, targetH = nextW, nextH
		}

		working := resizeImageIfNeeded(img, origW, origH, targetW, targetH)
		opaque := isOpaque(working)

		chosen, ok := selectSmartEncoding(working, opaque)
		if !ok {
			if targetW == 1 && targetH == 1 {
				break
			}
			continue
		}

		var hints []string
		if chosen.mimeType != origMime {
			hints = append(hints, "[Image converted from "+origMime+" to "+chosen.mimeType+".]")
		}
		if targetW != origW || targetH != origH {
			scale := float64(origW) / float64(targetW)
			hints = append(hints, "[Image: original "+strconv.Itoa(origW)+"x"+strconv.Itoa(origH)+", displayed at "+strconv.Itoa(targetW)+"x"+strconv.Itoa(targetH)+". Multiply coordinates by "+strconv.FormatFloat(scale, 'f', 2, 64)+" to map to original image.]")
		}

		b64 := base64.StdEncoding.EncodeToString(chosen.data)
		preview := buildPreviewFromDecoded(working, targetW, targetH, opaque, chosen.mimeType, b64)
		return NormalizedImage{
			Data:           b64,
			RawBytes:       chosen.data,
			MimeType:       chosen.mimeType,
			OrigMime:       origMime,
			Width:          targetW,
			Height:         targetH,
			OrigWidth:      origW,
			OrigHeight:     origH,
			OrigBytes:      origBytes,
			SHA256:         sha256Hex(chosen.data),
			PreviewDataURL: preview,
			Hints:          hints,
		}, nil
	}

	return NormalizedImage{}, errImageTooLarge
}

// processImage wraps NormalizeImage for legacy internal callers.
func processImage(input []byte, detectedMIME string) (*processedImage, error) {
	norm, err := NormalizeImage(input, detectedMIME)
	if err != nil {
		return nil, err
	}
	return &processedImage{
		data:           norm.RawBytes,
		mimeType:       norm.MimeType,
		originalWidth:  norm.OrigWidth,
		originalHeight: norm.OrigHeight,
		width:          norm.Width,
		height:         norm.Height,
		wasResized:     norm.Width != norm.OrigWidth || norm.Height != norm.OrigHeight,
		hints:          norm.Hints,
	}, nil
}

type encodedImage struct {
	data     []byte
	mimeType string
}

func resizeImageIfNeeded(src image.Image, srcW, srcH, targetW, targetH int) image.Image {
	if srcW == targetW && srcH == targetH && src.Bounds().Min == image.Pt(0, 0) {
		return src
	}
	dst := image.NewRGBA(image.Rect(0, 0, targetW, targetH))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Src, nil)
	return dst
}

// isOpaque reports whether every pixel in img has full alpha (100% opaque).
func isOpaque(img image.Image) bool {
	if o, ok := img.(interface{ Opaque() bool }); ok {
		return o.Opaque()
	}
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			if _, _, _, a := img.At(x, y).RGBA(); a != 0xffff {
				return false
			}
		}
	}
	return true
}

func compositeOverNeutral(src image.Image) *image.RGBA {
	b := src.Bounds()
	dst := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	bg := image.NewUniform(color.RGBA{R: 248, G: 249, B: 250, A: 255})
	draw.Draw(dst, dst.Bounds(), bg, image.Point{}, draw.Src)
	draw.Draw(dst, dst.Bounds(), src, b.Min, draw.Over)
	return dst
}

func selectSmartEncoding(img image.Image, opaque bool) (encodedImage, bool) {
	if !opaque {
		var pngBuf bytes.Buffer
		if err := png.Encode(&pngBuf, img); err == nil {
			pngBytes := pngBuf.Bytes()
			if len(pngBytes) <= transparentPNGMaxRawBytes && len(pngBytes) <= maxImageRawBytes {
				return encodedImage{data: pngBytes, mimeType: "image/png"}, true
			}
		}
		img = compositeOverNeutral(img)
	}

	for _, q := range jpegQualitySchedule {
		var jpegBuf bytes.Buffer
		if err := jpeg.Encode(&jpegBuf, img, &jpeg.Options{Quality: q}); err == nil {
			jb := jpegBuf.Bytes()
			if len(jb) <= maxImageRawBytes {
				return encodedImage{data: jb, mimeType: "image/jpeg"}, true
			}
		}
	}
	return encodedImage{}, false
}

func buildPassthroughPreview(raw []byte, rawB64, format, mime string, w, h int) string {
	if w <= previewMaxDimension && h <= previewMaxDimension {
		url := "data:" + mime + ";base64," + rawB64
		if len(url) <= previewMaxDataURLBytes {
			return url
		}
	}
	img, err := decodeImage(raw, format)
	if err != nil {
		return ""
	}
	return buildPreviewFromDecoded(img, w, h, isOpaque(img), mime, rawB64)
}

func buildPreviewFromDecoded(img image.Image, w, h int, opaque bool, chosenMime, chosenB64 string) string {
	if w <= previewMaxDimension && h <= previewMaxDimension && chosenB64 != "" {
		url := "data:" + chosenMime + ";base64," + chosenB64
		if len(url) <= previewMaxDataURLBytes {
			return url
		}
	}
	pw, ph := fitDimensions(w, h, previewMaxDimension, previewMaxDimension)
	thumb := resizeImageIfNeeded(img, w, h, pw, ph)
	if !opaque {
		var pngBuf bytes.Buffer
		if err := png.Encode(&pngBuf, thumb); err == nil {
			url := "data:image/png;base64," + base64.StdEncoding.EncodeToString(pngBuf.Bytes())
			if len(url) <= previewMaxDataURLBytes {
				return url
			}
		}
		thumb = compositeOverNeutral(thumb)
	}
	for _, q := range []int{75, 60, 45, 30} {
		var jpegBuf bytes.Buffer
		if err := jpeg.Encode(&jpegBuf, thumb, &jpeg.Options{Quality: q}); err == nil {
			url := "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(jpegBuf.Bytes())
			if len(url) <= previewMaxDataURLBytes {
				return url
			}
		}
	}
	return ""
}

func decodeImageConfig(data []byte) (image.Config, string, error) {
	if cfg, format, err := image.DecodeConfig(bytes.NewReader(data)); err == nil {
		return cfg, format, nil
	}
	if cfg, err := webp.DecodeConfig(bytes.NewReader(data)); err == nil {
		return cfg, "webp", nil
	}
	if cfg, err := bmp.DecodeConfig(bytes.NewReader(data)); err == nil {
		return cfg, "bmp", nil
	}
	return image.Config{}, "", errors.New("unsupported image")
}

func decodeImage(data []byte, format string) (image.Image, error) {
	switch format {
	case "webp":
		return webp.Decode(bytes.NewReader(data))
	case "bmp":
		return bmp.Decode(bytes.NewReader(data))
	case "gif":
		return gif.Decode(bytes.NewReader(data))
	default:
		img, _, err := image.Decode(bytes.NewReader(data))
		return img, err
	}
}

func canonicalSourceMIME(mime string) string {
	mime = strings.ToLower(strings.TrimSpace(strings.Split(mime, ";")[0]))
	switch mime {
	case "image/png":
		return "image/png"
	case "image/jpeg", "image/jpg":
		return "image/jpeg"
	case "image/gif":
		return "image/gif"
	case "image/webp":
		return "image/webp"
	case "image/bmp", "image/x-bmp", "image/x-ms-bmp":
		return "image/bmp"
	default:
		return ""
	}
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func fitDimensions(width, height, maxWidth, maxHeight int) (int, int) {
	w, h := width, height
	if w > maxWidth {
		h = int(math.Round(float64(h) * float64(maxWidth) / float64(w)))
		w = maxWidth
	}
	if h > maxHeight {
		w = int(math.Round(float64(w) * float64(maxHeight) / float64(h)))
		h = maxHeight
	}
	return maxInt(1, w), maxInt(1, h)
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
