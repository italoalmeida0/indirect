package tools

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"strings"
	"testing"

	"golang.org/x/image/bmp"
)

func TestNormalizeImageOpaque4KPNGConvertsToCompactJPEG(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 3840, 2160))
	seed := uint32(0x12345678)
	for y := 0; y < 2160; y++ {
		baseG := uint8((y * 255) / 2160)
		for x := 0; x < 3840; x++ {
			seed = seed*1664525 + 1013904223
			dither := uint8((seed >> 28) & 0x07)
			baseR := uint8((x * 255) / 3840)
			img.SetRGBA(x, y, color.RGBA{
				R: baseR ^ dither,
				G: baseG ^ dither,
				B: uint8(((x/16 + y/16) * 7) & 0xff),
				A: 255,
			})
		}
	}
	var buf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestSpeed}
	if err := enc.Encode(&buf, img); err != nil {
		t.Fatalf("encode 4k png: %v", err)
	}
	rawPNG := buf.Bytes()
	if len(rawPNG) <= passthroughMaxRawBytes {
		t.Fatalf("expected 4k screenshot PNG > 260 KiB, got %d bytes", len(rawPNG))
	}

	norm, err := NormalizeImage(rawPNG, "image/png")
	if err != nil {
		t.Fatalf("NormalizeImage failed: %v", err)
	}
	if norm.MimeType != "image/jpeg" {
		t.Fatalf("expected opaque 4K PNG to compress as image/jpeg, got %s", norm.MimeType)
	}
	if norm.OrigMime != "image/png" {
		t.Fatalf("expected OrigMime image/png, got %s", norm.OrigMime)
	}
	if norm.OrigWidth != 3840 || norm.OrigHeight != 2160 {
		t.Fatalf("unexpected OrigWidthxOrigHeight: %dx%d", norm.OrigWidth, norm.OrigHeight)
	}
	if norm.Width != 1568 || norm.Height != 882 {
		t.Fatalf("expected 1568x882 target dimensions, got %dx%d", norm.Width, norm.Height)
	}
	if len(norm.RawBytes) > maxImageRawBytes {
		t.Fatalf("wire bytes %d exceed maxImageRawBytes %d", len(norm.RawBytes), maxImageRawBytes)
	}
	if len(norm.RawBytes) >= len(rawPNG)/2 {
		t.Fatalf("expected substantial byte reduction from %d PNG bytes, got %d JPEG bytes", len(rawPNG), len(norm.RawBytes))
	}
	if len(norm.SHA256) != 64 {
		t.Fatalf("expected 64-char SHA256 hex, got %q", norm.SHA256)
	}
	if !strings.HasPrefix(norm.PreviewDataURL, "data:image/jpeg;base64,") {
		t.Fatalf("expected jpeg preview data URL, got prefix %q", norm.PreviewDataURL[:min(32, len(norm.PreviewDataURL))])
	}
	if len(norm.PreviewDataURL) > 66_000 {
		t.Fatalf("preview data URL too large: %d chars", len(norm.PreviewDataURL))
	}
	joinedHints := strings.Join(norm.Hints, "\n")
	if !strings.Contains(joinedHints, "converted from image/png to image/jpeg") {
		t.Fatalf("expected format conversion hint, got %q", joinedHints)
	}
	if !strings.Contains(joinedHints, "displayed at 1568x882") {
		t.Fatalf("expected coordinate scale hint, got %q", joinedHints)
	}
}

func TestNormalizeImageTransparentPNGPreservedWhenCompactAndFlattenedWhenHuge(t *testing.T) {
	// 1. Compact semi-transparent PNG (>1568px wide so it goes through encode path, <=450 KiB output).
	smallAlpha := image.NewNRGBA(image.Rect(0, 0, 1800, 600))
	for y := 0; y < 600; y++ {
		for x := 0; x < 1800; x++ {
			alpha := uint8(255)
			if x < 200 {
				alpha = 96
			}
			smallAlpha.SetNRGBA(x, y, color.NRGBA{R: 30, G: 120, B: 210, A: alpha})
		}
	}
	var smallBuf bytes.Buffer
	if err := png.Encode(&smallBuf, smallAlpha); err != nil {
		t.Fatalf("encode small alpha png: %v", err)
	}
	normAlpha, err := NormalizeImage(smallBuf.Bytes(), "image/png")
	if err != nil {
		t.Fatalf("NormalizeImage compact alpha failed: %v", err)
	}
	if normAlpha.MimeType != "image/png" {
		t.Fatalf("expected compact transparent image to stay image/png, got %s", normAlpha.MimeType)
	}
	if normAlpha.Width != 1568 {
		t.Fatalf("expected resized width 1568, got %d", normAlpha.Width)
	}
	if len(normAlpha.RawBytes) > transparentPNGMaxRawBytes {
		t.Fatalf("expected PNG <= %d bytes, got %d", transparentPNGMaxRawBytes, len(normAlpha.RawBytes))
	}

	// 2. High-entropy semi-transparent PNG whose PNG encoding exceeds 450 KiB -> flattened to JPEG.
	noisyAlpha := image.NewNRGBA(image.Rect(0, 0, 1400, 1400))
	seed := uint32(0x9e3779b9)
	for y := 0; y < 1400; y++ {
		for x := 0; x < 1400; x++ {
			seed = seed*1664525 + 1013904223
			a := uint8(255)
			if x == 0 && y == 0 {
				a = 128 // single translucent pixel triggers !isOpaque
			}
			noisyAlpha.SetNRGBA(x, y, color.NRGBA{
				R: uint8(seed >> 24),
				G: uint8(seed >> 16),
				B: uint8(seed >> 8),
				A: a,
			})
		}
	}
	var noisyBuf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestSpeed}
	if err := enc.Encode(&noisyBuf, noisyAlpha); err != nil {
		t.Fatalf("encode noisy alpha png: %v", err)
	}
	normNoisy, err := NormalizeImage(noisyBuf.Bytes(), "image/png")
	if err != nil {
		t.Fatalf("NormalizeImage noisy alpha failed: %v", err)
	}
	if normNoisy.MimeType != "image/jpeg" {
		t.Fatalf("expected >450 KiB transparent PNG to composite & encode as image/jpeg, got %s", normNoisy.MimeType)
	}
	if len(normNoisy.RawBytes) > maxImageRawBytes {
		t.Fatalf("expected output <= %d bytes, got %d", maxImageRawBytes, len(normNoisy.RawBytes))
	}
}

func TestNormalizeImageSmallPassthroughBMPConversionWebPAnd50MBCap(t *testing.T) {
	// 1. Small JPEG passthrough verbatim.
	tiny := image.NewRGBA(image.Rect(0, 0, 120, 80))
	for y := 0; y < 80; y++ {
		for x := 0; x < 120; x++ {
			tiny.SetRGBA(x, y, color.RGBA{R: 20, G: 60, B: 100, A: 255})
		}
	}
	var jpgBuf bytes.Buffer
	if err := jpeg.Encode(&jpgBuf, tiny, &jpeg.Options{Quality: 80}); err != nil {
		t.Fatalf("encode jpeg: %v", err)
	}
	normJPG, err := NormalizeImage(jpgBuf.Bytes(), "image/jpeg")
	if err != nil {
		t.Fatalf("NormalizeImage small jpeg: %v", err)
	}
	if !bytes.Equal(normJPG.RawBytes, jpgBuf.Bytes()) {
		t.Fatalf("expected small JPEG bytes to pass through verbatim")
	}
	if normJPG.Width != 120 || normJPG.Height != 80 || normJPG.PreviewDataURL == "" {
		t.Fatalf("unexpected passthrough metadata: %+v", normJPG)
	}

	// 2. BMP always converts even when small.
	var bmpBuf bytes.Buffer
	if err := bmp.Encode(&bmpBuf, tiny); err != nil {
		t.Fatalf("encode bmp: %v", err)
	}
	normBMP, err := NormalizeImage(bmpBuf.Bytes(), "image/bmp")
	if err != nil {
		t.Fatalf("NormalizeImage bmp: %v", err)
	}
	if normBMP.OrigMime != "image/bmp" {
		t.Fatalf("expected OrigMime image/bmp, got %s", normBMP.OrigMime)
	}
	if normBMP.MimeType != "image/jpeg" && normBMP.MimeType != "image/png" {
		t.Fatalf("expected BMP converted to jpeg/png, got %s", normBMP.MimeType)
	}

	// 3. Undecodable/animated WebP container <= maxImageRawBytes passes through gracefully; > maxImageRawBytes errors cleanly.
	webpHeader := append([]byte("RIFF\x00\x00\x00\x00WEBPVP8X"), make([]byte, 300*1024)...)
	normWebP, err := NormalizeImage(webpHeader, "image/webp")
	if err != nil {
		t.Fatalf("expected undecodable WebP <= maxImageRawBytes to pass through, got %v", err)
	}
	if normWebP.MimeType != "image/webp" || len(normWebP.SHA256) != 64 {
		t.Fatalf("unexpected WebP passthrough result: mime=%s sha=%s", normWebP.MimeType, normWebP.SHA256)
	}
	oversizeWebP := append([]byte("RIFF\x00\x00\x00\x00WEBPVP8X"), make([]byte, maxImageRawBytes+1024)...)
	if _, err := NormalizeImage(oversizeWebP, "image/webp"); err == nil {
		t.Fatalf("expected oversize undecodable WebP to fail cleanly")
	}

	// 4. Hard 50 MiB input cap rejected immediately.
	huge := make([]byte, MaxRawImageFileBytes+1)
	if _, err := NormalizeImage(huge, "image/png"); err == nil || !strings.Contains(err.Error(), "50MB") {
		t.Fatalf("expected 50MB cap error, got %v", err)
	}
}
