// Package sessionstore implements Indirect Code's v2 tiered segmented session
// storage engine (Hot window queries, Warm append-only segments, Cold 64 KiB
// seekable Zstandard archives, content-addressed blob storage, streaming v1
// JSONL migration, and auxiliary disk garbage collection).
package sessionstore

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"net/http"
	"os"
	"path/filepath"
	"unicode/utf8"

	"golang.org/x/image/bmp"
	"golang.org/x/image/webp"

	"indirect/indirect-code-daemon/internal/durable"
	"indirect/indirect-code-daemon/packages/provider"
)

const (
	// MaxInlineDetailThresholdBytes is the threshold above which legacy inline
	// tool result detail strings (output/stdout/stderr/content) are scrubbed on
	// write or migration.
	MaxInlineDetailThresholdBytes = 64 * 1024

	// MaxInlineDetailPreviewBytes is the UTF-8 rune-safe head+tail preview cap
	// retained inside scrubbed tool result Details.
	MaxInlineDetailPreviewBytes = 32 * 1024
)

// ErrInvalidBlobHash indicates a malformed or non-SHA256 blob identifier.
var ErrInvalidBlobHash = errors.New("sessionstore: invalid sha256 blob hash")

// CASStore manages content-addressed binary blobs (images and large attachments)
// under <slotDir>/blobs/sha256/<first2>/<sha256>.blob.
type CASStore struct {
	slotDir string
	rootDir string
}

// NewCASStore returns a content-addressed blob store rooted inside slotDir.
func NewCASStore(slotDir string) *CASStore {
	return &CASStore{
		slotDir: slotDir,
		rootDir: filepath.Join(slotDir, "blobs", "sha256"),
	}
}

// RootDir returns the <slotDir>/blobs/sha256 directory path.
func (c *CASStore) RootDir() string {
	return c.rootDir
}

// NormalizeSHA256 validates that h is an exact 64-character hexadecimal SHA-256
// digest and returns its lowercase representation.
func NormalizeSHA256(h string) (string, bool) {
	if len(h) != 64 {
		return "", false
	}
	var buf [64]byte
	for i := 0; i < 64; i++ {
		ch := h[i]
		switch {
		case ch >= '0' && ch <= '9':
			buf[i] = ch
		case ch >= 'a' && ch <= 'f':
			buf[i] = ch
		case ch >= 'A' && ch <= 'F':
			buf[i] = ch + ('a' - 'A')
		default:
			return "", false
		}
	}
	return string(buf[:]), true
}

// BlobPath resolves the on-disk path for sha256Hex, rejecting invalid hashes.
func (c *CASStore) BlobPath(sha256Hex string) (string, error) {
	norm, ok := NormalizeSHA256(sha256Hex)
	if !ok {
		return "", fmt.Errorf("%w: %q", ErrInvalidBlobHash, sha256Hex)
	}
	return filepath.Join(c.rootDir, norm[:2], norm+".blob"), nil
}

// Has reports whether sha256Hex exists as a regular file in the CAS store.
func (c *CASStore) Has(sha256Hex string) bool {
	p, err := c.BlobPath(sha256Hex)
	if err != nil {
		return false
	}
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular()
}

// PutBytes stores data in the CAS store using a deduplicated atomic write and
// returns its 64-character lowercase SHA-256 hex digest.
func (c *CASStore) PutBytes(mediaType string, data []byte) (string, error) {
	_ = mediaType
	sum := sha256.Sum256(data)
	hexHash := hex.EncodeToString(sum[:])
	path := filepath.Join(c.rootDir, hexHash[:2], hexHash+".blob")
	if st, err := os.Stat(path); err == nil && st.Mode().IsRegular() && st.Size() == int64(len(data)) {
		return hexHash, nil
	}
	if err := durable.Write(path, data); err != nil {
		return "", fmt.Errorf("sessionstore: cas put %s: %w", hexHash, err)
	}
	return hexHash, nil
}

// GetBytes reads the raw bytes for sha256Hex from the CAS store.
func (c *CASStore) GetBytes(sha256Hex string) ([]byte, error) {
	path, err := c.BlobPath(sha256Hex)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return data, nil
}

// GetBlob reads the raw bytes for sha256Hex and sniffs its media type.
func (c *CASStore) GetBlob(sha256Hex string) ([]byte, string, error) {
	data, err := c.GetBytes(sha256Hex)
	if err != nil {
		return nil, "", err
	}
	return data, DetectMediaType(data, "application/octet-stream"), nil
}

// DetectMediaType inspects magic bytes for common image formats and falls back
// to http.DetectContentType or fallback.
func DetectMediaType(data []byte, fallback string) string {
	if len(data) >= 8 && bytes.Equal(data[:8], []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}) {
		return "image/png"
	}
	if len(data) >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff {
		return "image/jpeg"
	}
	if len(data) >= 6 && (bytes.Equal(data[:6], []byte("GIF87a")) || bytes.Equal(data[:6], []byte("GIF89a"))) {
		return "image/gif"
	}
	if len(data) >= 12 && bytes.Equal(data[:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP")) {
		return "image/webp"
	}
	if len(data) >= 2 && data[0] == 'B' && data[1] == 'M' {
		return "image/bmp"
	}
	if fallback != "" {
		return fallback
	}
	if len(data) > 0 {
		return http.DetectContentType(data)
	}
	return "application/octet-stream"
}

func decodeImageDims(data []byte) (int, int) {
	if len(data) == 0 {
		return 0, 0
	}
	if cfg, _, err := image.DecodeConfig(bytes.NewReader(data)); err == nil && cfg.Width > 0 && cfg.Height > 0 {
		return cfg.Width, cfg.Height
	}
	if cfg, err := webp.DecodeConfig(bytes.NewReader(data)); err == nil && cfg.Width > 0 && cfg.Height > 0 {
		return cfg.Width, cfg.Height
	}
	if cfg, err := bmp.DecodeConfig(bytes.NewReader(data)); err == nil && cfg.Width > 0 && cfg.Height > 0 {
		return cfg.Width, cfg.Height
	}
	return 0, 0
}

func (c *CASStore) externalizeImageBlock(ib provider.ImageBlock) (provider.ImageBlock, bool, error) {
	if len(ib.Data) == 0 {
		// Normalize MIME fields when already externalized.
		if ib.MimeType == "" && ib.MediaType != "" {
			ib.MimeType = ib.MediaType
			return ib, true, nil
		}
		if ib.MediaType == "" && ib.MimeType != "" && ib.BlobSHA256 != "" {
			ib.MediaType = ib.MimeType
			return ib, true, nil
		}
		return ib, false, nil
	}
	mime := ib.MediaType
	if mime == "" {
		mime = ib.MimeType
	}
	if mime == "" {
		mime = DetectMediaType(ib.Data, "application/octet-stream")
	}
	if ib.Width <= 0 || ib.Height <= 0 {
		if w, h := decodeImageDims(ib.Data); w > 0 && h > 0 {
			ib.Width = w
			ib.Height = h
		}
	}
	hash, err := c.PutBytes(mime, ib.Data)
	if err != nil {
		return ib, false, err
	}
	ib.MimeType = mime
	ib.MediaType = mime
	ib.BlobSHA256 = hash
	ib.ByteLen = len(ib.Data)
	if ib.SHA256 == "" {
		ib.SHA256 = hash
	}
	ib.Data = nil
	return ib, true, nil
}

// ExternalizeMessageImages stores any non-empty ImageBlock.Data (both top-level
// message content and nested ToolResultBlock content) into CAS, sets BlobSHA256,
// ByteLen, Width, Height, MediaType, and MimeType, and clears Data = nil.
// Caller slices are never mutated in place.
func (c *CASStore) ExternalizeMessageImages(msgs []provider.Message) ([]provider.Message, error) {
	if len(msgs) == 0 {
		return nil, nil
	}
	out := make([]provider.Message, len(msgs))
	copy(out, msgs)
	for i, m := range out {
		var newContent []provider.Content
		for j, blk := range m.Content {
			switch v := blk.(type) {
			case provider.ImageBlock:
				ext, changed, err := c.externalizeImageBlock(v)
				if err != nil {
					return nil, err
				}
				if changed {
					if newContent == nil {
						newContent = make([]provider.Content, len(m.Content))
						copy(newContent, m.Content)
					}
					newContent[j] = ext
				}
			case provider.ToolResultBlock:
				var newInner []provider.Content
				for k, inner := range v.Content {
					ib, ok := inner.(provider.ImageBlock)
					if !ok {
						continue
					}
					ext, changed, err := c.externalizeImageBlock(ib)
					if err != nil {
						return nil, err
					}
					if changed {
						if newInner == nil {
							newInner = make([]provider.Content, len(v.Content))
							copy(newInner, v.Content)
						}
						newInner[k] = ext
					}
				}
				if newInner != nil {
					if newContent == nil {
						newContent = make([]provider.Content, len(m.Content))
						copy(newContent, m.Content)
					}
					vCopy := v
					vCopy.Content = newInner
					newContent[j] = vCopy
				}
			}
		}
		if newContent != nil {
			mCopy := m
			mCopy.Content = newContent
			out[i] = mCopy
		}
	}
	return out, nil
}

func (c *CASStore) hydrateImageBlock(ib provider.ImageBlock) (provider.ImageBlock, bool, error) {
	if len(ib.Data) > 0 || ib.BlobSHA256 == "" {
		return ib, false, nil
	}
	data, err := c.GetBytes(ib.BlobSHA256)
	if err != nil {
		return ib, false, fmt.Errorf("sessionstore: hydrate blob %s: %w", ib.BlobSHA256, err)
	}
	ib.Data = data
	if ib.ByteLen <= 0 {
		ib.ByteLen = len(data)
	}
	if ib.MimeType == "" && ib.MediaType != "" {
		ib.MimeType = ib.MediaType
	} else if ib.MimeType == "" {
		ib.MimeType = DetectMediaType(data, "application/octet-stream")
	}
	if ib.MediaType == "" {
		ib.MediaType = ib.MimeType
	}
	return ib, true, nil
}

// HydrateMessageImages clones and populates ImageBlock.Data from CAS ONLY for
// the messages passed in, leaving caller slices untouched.
func (c *CASStore) HydrateMessageImages(msgs []provider.Message) ([]provider.Message, error) {
	if len(msgs) == 0 {
		return nil, nil
	}
	out := make([]provider.Message, len(msgs))
	copy(out, msgs)
	for i, m := range out {
		var newContent []provider.Content
		for j, blk := range m.Content {
			switch v := blk.(type) {
			case provider.ImageBlock:
				hyd, changed, err := c.hydrateImageBlock(v)
				if err != nil {
					return nil, err
				}
				if changed {
					if newContent == nil {
						newContent = make([]provider.Content, len(m.Content))
						copy(newContent, m.Content)
					}
					newContent[j] = hyd
				}
			case provider.ToolResultBlock:
				var newInner []provider.Content
				for k, inner := range v.Content {
					ib, ok := inner.(provider.ImageBlock)
					if !ok {
						continue
					}
					hyd, changed, err := c.hydrateImageBlock(ib)
					if err != nil {
						return nil, err
					}
					if changed {
						if newInner == nil {
							newInner = make([]provider.Content, len(v.Content))
							copy(newInner, v.Content)
						}
						newInner[k] = hyd
					}
				}
				if newInner != nil {
					if newContent == nil {
						newContent = make([]provider.Content, len(m.Content))
						copy(newContent, m.Content)
					}
					vCopy := v
					vCopy.Content = newInner
					newContent[j] = vCopy
				}
			}
		}
		if newContent != nil {
			mCopy := m
			mCopy.Content = newContent
			out[i] = mCopy
		}
	}
	return out, nil
}

// CollectMessageBlobRefs returns deduplicated normalized 64-char SHA-256 blob
// hashes referenced by ImageBlocks in msgs.
func CollectMessageBlobRefs(msgs []provider.Message) []string {
	var refs []string
	seen := make(map[string]struct{})
	add := func(h string) {
		if norm, ok := NormalizeSHA256(h); ok {
			if _, ok := seen[norm]; !ok {
				seen[norm] = struct{}{}
				refs = append(refs, norm)
			}
		}
	}
	for _, m := range msgs {
		for _, blk := range m.Content {
			switch v := blk.(type) {
			case provider.ImageBlock:
				add(v.BlobSHA256)
			case provider.ToolResultBlock:
				for _, inner := range v.Content {
					if ib, ok := inner.(provider.ImageBlock); ok {
						add(ib.BlobSHA256)
					}
				}
			}
		}
	}
	return refs
}

// capUTF8Preview retains at most maxBytes of text using a rune-safe 75%/25%
// head+tail split.
func capUTF8Preview(text string, maxBytes int) (string, bool) {
	if maxBytes <= 0 || len(text) <= maxBytes {
		return text, false
	}
	const sep = "\n... [inline detail preview capped] ...\n"
	if maxBytes <= len(sep)+16 {
		end := maxBytes
		for end > 0 && !utf8.RuneStart(text[end]) {
			end--
		}
		return text[:end], true
	}
	avail := maxBytes - len(sep)
	headBudget := (avail * 3) / 4
	tailBudget := avail - headBudget
	for headBudget > 0 && !utf8.RuneStart(text[headBudget]) {
		headBudget--
	}
	tailStart := len(text) - tailBudget
	for tailStart < len(text) && !utf8.RuneStart(text[tailStart]) {
		tailStart++
	}
	return text[:headBudget] + sep + text[tailStart:], true
}

func scrubDetailsValue(details any) (any, bool) {
	if details == nil {
		return nil, false
	}
	switch d := details.(type) {
	case map[string]any:
		changed := false
		var cloned map[string]any
		ensureClone := func() {
			if cloned != nil {
				return
			}
			cloned = make(map[string]any, len(d)+1)
			for k, v := range d {
				cloned[k] = v
			}
		}
		if _, hasPreview := d["preview_data_url"]; hasPreview {
			ensureClone()
			delete(cloned, "preview_data_url")
			changed = true
		}
		for k, v := range d {
			if k == "preview_data_url" {
				continue
			}
			s, ok := v.(string)
			if !ok || len(s) <= MaxInlineDetailThresholdBytes {
				continue
			}
			ensureClone()
			capped, _ := capUTF8Preview(s, MaxInlineDetailPreviewBytes)
			cloned[k] = capped
			if k == "output" || k == "stdout" || k == "stderr" || k == "content" {
				cloned["truncated"] = true
			}
			changed = true
		}
		if !changed {
			return details, false
		}
		return cloned, true

	case json.RawMessage:
		// Fast skip: if raw JSON is small and lacks preview_data_url, avoid unmarshaling.
		if len(d) <= MaxInlineDetailThresholdBytes && !bytes.Contains(d, []byte("preview_data_url")) {
			return details, false
		}
		var m map[string]any
		if err := json.Unmarshal(d, &m); err != nil {
			return details, false
		}
		scrubbed, changed := scrubDetailsValue(m)
		if !changed {
			return details, false
		}
		enc, err := json.Marshal(scrubbed)
		if err != nil {
			return details, false
		}
		return json.RawMessage(enc), true

	default:
		raw, err := json.Marshal(details)
		if err != nil {
			return details, false
		}
		if len(raw) <= MaxInlineDetailThresholdBytes && !bytes.Contains(raw, []byte("preview_data_url")) {
			return details, false
		}
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			return details, false
		}
		scrubbed, changed := scrubDetailsValue(m)
		if !changed {
			return details, false
		}
		return scrubbed, true
	}
}

// ScrubMessageDetails strips transient UI fields (preview_data_url) and caps
// bloated legacy inline tool result detail strings (> 64 KiB) to <= 32 KiB
// UTF-8 rune-safe previews without mutating the caller's message.
func ScrubMessageDetails(msg provider.Message) provider.Message {
	if len(msg.Content) == 0 {
		return msg
	}
	var newContent []provider.Content
	for i, blk := range msg.Content {
		tr, ok := blk.(provider.ToolResultBlock)
		if !ok || tr.Details == nil {
			continue
		}
		scrubbed, changed := scrubDetailsValue(tr.Details)
		if !changed {
			continue
		}
		if newContent == nil {
			newContent = make([]provider.Content, len(msg.Content))
			copy(newContent, msg.Content)
		}
		tr.Details = scrubbed
		newContent[i] = tr
	}
	if newContent != nil {
		msg.Content = newContent
	}
	return msg
}

// ScrubMessagesDetails applies ScrubMessageDetails across a slice of messages.
func ScrubMessagesDetails(msgs []provider.Message) []provider.Message {
	if len(msgs) == 0 {
		return nil
	}
	out := make([]provider.Message, len(msgs))
	for i, m := range msgs {
		out[i] = ScrubMessageDetails(stringsCloneMsg(m))
	}
	return out
}

func stringsCloneMsg(m provider.Message) provider.Message {
	return m
}
