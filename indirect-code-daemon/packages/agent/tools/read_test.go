package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"indirect/indirect-code-daemon/packages/provider"
)

func TestReadToolRejectsOver50MBImagePreReadAndEmitsSharedWireContract(t *testing.T) {
	dir := t.TempDir()

	// 1. Sparse >50 MiB PNG file (valid PNG magic header, sparse 50 MiB+ body)
	// rejected via os.Stat BEFORE os.ReadFile.
	sparsePath := filepath.Join(dir, "huge.png")
	f, err := os.Create(sparsePath)
	if err != nil {
		t.Fatalf("create sparse file: %v", err)
	}
	if _, err := f.Write([]byte("\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR")); err != nil {
		f.Close()
		t.Fatalf("write png magic: %v", err)
	}
	if err := f.Truncate(MaxRawImageFileBytes + 4096); err != nil {
		f.Close()
		t.Fatalf("truncate sparse file: %v", err)
	}
	f.Close()

	rt := &ReadTool{CWD: dir}
	rawHugeArgs, _ := json.Marshal(map[string]any{"path": "huge.png"})
	if _, err := rt.Execute(context.Background(), rawHugeArgs, nil); err == nil || !strings.Contains(err.Error(), "exceeds 50 MB") {
		t.Fatalf("expected pre-read >50MB error, got %v", err)
	}

	// 2. 4K opaque PNG read emits exact Attrs + Details.preview_data_url + ImageBlock metadata.
	img := image.NewRGBA(image.Rect(0, 0, 3840, 2160))
	for y := 0; y < 2160; y++ {
		for x := 0; x < 3840; x++ {
			img.SetRGBA(x, y, color.RGBA{
				R: uint8((x*11 + y*7) & 0xff),
				G: uint8((x*3 + y*19) & 0xff),
				B: uint8((x + y) & 0xff),
				A: 255,
			})
		}
	}
	var pngBuf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestSpeed}
	if err := enc.Encode(&pngBuf, img); err != nil {
		t.Fatalf("encode 4k png: %v", err)
	}
	shotPath := filepath.Join(dir, "dashboard-4k.png")
	if err := os.WriteFile(shotPath, pngBuf.Bytes(), 0o600); err != nil {
		t.Fatalf("write screenshot: %v", err)
	}

	rawArgs, _ := json.Marshal(map[string]any{"path": "dashboard-4k.png"})
	res, err := rt.Execute(context.Background(), rawArgs, nil)
	if err != nil {
		t.Fatalf("ReadTool Execute failed: %v", err)
	}

	attrs := map[string]string{}
	for _, a := range res.Attrs {
		attrs[a.Key] = a.Value
	}
	for _, wantKey := range []string{"media", "orig_media", "width", "height", "orig_width", "orig_height", "bytes", "orig_bytes", "sha256"} {
		if attrs[wantKey] == "" {
			t.Fatalf("missing Attr %q in %+v", wantKey, attrs)
		}
	}
	if attrs["media"] != "image/jpeg" || attrs["orig_media"] != "image/png" {
		t.Fatalf("unexpected media/orig_media attrs: %+v", attrs)
	}
	if attrs["width"] != "1568" || attrs["height"] != "882" || attrs["orig_width"] != "3840" || attrs["orig_height"] != "2160" {
		t.Fatalf("unexpected dimension attrs: %+v", attrs)
	}
	if len(attrs["sha256"]) != 16 {
		t.Fatalf("expected 16-char sha256 attr prefix, got %q", attrs["sha256"])
	}

	det, ok := res.Details.(map[string]any)
	if !ok {
		t.Fatalf("expected map[string]any Details, got %T", res.Details)
	}
	preview, _ := det["preview_data_url"].(string)
	if !strings.HasPrefix(preview, "data:image/jpeg;base64,") {
		t.Fatalf("expected Details.preview_data_url jpeg data URL, got %q", preview[:min(32, len(preview))])
	}
	if det["path"] != "dashboard-4k.png" || det["width"] != 1568 || det["orig_width"] != 3840 {
		t.Fatalf("unexpected Details map: %+v", det)
	}

	var gotImg *provider.ImageBlock
	for _, c := range res.Content {
		if ib, ok := c.(provider.ImageBlock); ok {
			cp := ib
			gotImg = &cp
		}
	}
	if gotImg == nil {
		t.Fatalf("expected provider.ImageBlock in ToolResult.Content")
	}
	if gotImg.SourcePath != "dashboard-4k.png" || gotImg.Width != 1568 || gotImg.Height != 882 || gotImg.OrigWidth != 3840 || gotImg.OrigHeight != 2160 || len(gotImg.SHA256) != 64 {
		t.Fatalf("unexpected ImageBlock metadata: source=%q %dx%d orig=%dx%d sha=%q", gotImg.SourcePath, gotImg.Width, gotImg.Height, gotImg.OrigWidth, gotImg.OrigHeight, gotImg.SHA256)
	}
}

func TestSessionHistoryIndexesAndRecallsVisualDigests(t *testing.T) {
	userImg := provider.ImageBlock{
		MimeType:   "image/jpeg",
		Data:       []byte("fake-jpeg-user"),
		SourcePath: "modal-crash.png",
		Width:      1280,
		Height:     720,
	}
	toolImg := provider.ImageBlock{
		MimeType:   "image/jpeg",
		Data:       []byte("fake-jpeg-tool"),
		SourcePath: "screens/console-error.png",
		Width:      1568,
		Height:     882,
	}
	digests := map[string]string{
		provider.ImageKey(userImg): "- Modal dialog shows `ERR_TLS_CERT_ALTNAME_INVALID` on port 8443",
		provider.ImageKey(toolImg): "- Browser console logs `Uncaught ReferenceError: hydrateWidgetStore is not defined` at line 412",
	}
	msgs := []provider.Message{
		{
			Role: provider.RoleUser,
			Content: []provider.Content{
				provider.TextBlock{Text: "Check this pasted dialog"},
				userImg,
			},
		},
		{
			Role: provider.RoleAssistant,
			Content: []provider.Content{
				provider.ToolCallBlock{ID: "call_read_1", Name: "read", Arguments: json.RawMessage(`{"path":"screens/console-error.png"}`)},
			},
		},
		{
			Role: provider.RoleTool,
			Content: []provider.Content{
				provider.ToolResultBlock{
					CallID: "call_read_1",
					Content: []provider.Content{
						provider.TextBlock{Text: `<tool_result media="image/jpeg" path="screens/console-error.png">Read image file [image/jpeg]</tool_result>`},
						toolImg,
					},
				},
			},
		},
	}

	histTool := &SessionHistoryTool{
		Source: func() SessionHistorySnapshot {
			return SessionHistorySnapshot{
				Messages:     msgs,
				KeepFrom:     len(msgs),
				ImageDigests: digests,
			}
		},
	}

	// 1. Search OCR identifier from RoleTool screenshot.
	searchArgs, _ := json.Marshal(map[string]any{
		"action":            "search",
		"query":             "hydrateWidgetStore",
		"include_live_tail": true,
	})
	searchRes, err := histTool.Execute(context.Background(), searchArgs, nil)
	if err != nil {
		t.Fatalf("session_history search failed: %v", err)
	}
	searchText := searchRes.Content[0].(provider.TextBlock).Text
	if !strings.Contains(searchText, "msg #2") || !strings.Contains(searchText, "hydrateWidgetStore") {
		t.Fatalf("expected BM25 hit on msg #2 OCR text, got:\n%s", searchText)
	}

	// 2. Search OCR error code from RoleUser pasted image.
	searchUserArgs, _ := json.Marshal(map[string]any{
		"action":            "search",
		"query":             "ERR_TLS_CERT_ALTNAME_INVALID",
		"include_live_tail": true,
	})
	searchUserRes, err := histTool.Execute(context.Background(), searchUserArgs, nil)
	if err != nil {
		t.Fatalf("session_history user image search failed: %v", err)
	}
	if !strings.Contains(searchUserRes.Content[0].(provider.TextBlock).Text, "msg #0") {
		t.Fatalf("expected BM25 hit on msg #0 user image digest, got:\n%s", searchUserRes.Content[0].(provider.TextBlock).Text)
	}

	// 3. Recall renders [Visual Digest — ...] for both user and tool images.
	start := 0
	end := 2
	recallArgs, _ := json.Marshal(SessionHistoryArgs{
		Action:   "recall",
		StartMsg: &start,
		EndMsg:   &end,
	})
	recallRes, err := histTool.Execute(context.Background(), recallArgs, nil)
	if err != nil {
		t.Fatalf("session_history recall failed: %v", err)
	}
	recallBody := recallRes.Content[0].(provider.TextBlock).Text
	if !strings.Contains(recallBody, "[Visual Digest — modal-crash.png") || !strings.Contains(recallBody, "ERR_TLS_CERT_ALTNAME_INVALID") {
		t.Fatalf("expected user image visual digest in recall output, got:\n%s", recallBody)
	}
	if !strings.Contains(recallBody, "[Visual Digest — screens/console-error.png") || !strings.Contains(recallBody, "hydrateWidgetStore") {
		t.Fatalf("expected tool image visual digest in recall output, got:\n%s", recallBody)
	}
}
