package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"golang.org/x/image/bmp"

	"indirect/indirect-code-daemon/packages/core"
	"indirect/indirect-code-daemon/packages/provider"
)

func TestDebugPayloadHookScrubsLargeBase64WhileWireStaysIntact(t *testing.T) {
	largeRaw := bytes.Repeat([]byte("A1B2C3D4"), 1024) // 8192 raw bytes -> 10924 base64 chars (> 4096 threshold)
	expectedB64 := base64.StdEncoding.EncodeToString(largeRaw)

	var wireMu sync.Mutex
	var wireBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		wireMu.Lock()
		wireBody = b
		wireMu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"m\",\"usage\":{\"input_tokens\":10,\"output_tokens\":1}}}\n\n")
		_, _ = io.WriteString(w, "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n")
		_, _ = io.WriteString(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}\n\n")
		_, _ = io.WriteString(w, "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n")
		_, _ = io.WriteString(w, "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\n")
		_, _ = io.WriteString(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	}))
	defer srv.Close()

	var emittedMu sync.Mutex
	var emittedEvents []any
	sid := "sess_debug_scrub_test"
	clearSessionDebugPayloads(sid)
	defer clearSessionDebugPayloads(sid)

	tb := &turnBridge{
		env: workerEnv{
			actorID: sid,
			emit: func(ev any) {
				emittedMu.Lock()
				emittedEvents = append(emittedEvents, ev)
				emittedMu.Unlock()
			},
		},
		snap: workerSnapshot{turnIndex: 1},
		cfg:  DaemonConfig{HostID: "h1"},
	}

	client := tb.wrapClient(provider.NewGatewayAnthropic("test-key", srv.URL, provider.Model{ID: "claude-sonnet-4-6"}))
	stream, err := client.Stream(context.Background(), provider.Request{
		Model:     "claude-sonnet-4-6",
		MaxTokens: 128,
		Messages: []provider.Message{
			{
				Role: provider.RoleUser,
				Content: []provider.Content{
					provider.TextBlock{Text: "check screenshot"},
					provider.ImageBlock{MimeType: "image/jpeg", Data: largeRaw, SourcePath: "shot.jpg"},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("Stream failed: %v", err)
	}
	for range stream {
	}

	// 1. Real wire request body MUST still contain the exact full base64 payload untouched!
	wireMu.Lock()
	gotWire := string(wireBody)
	wireMu.Unlock()
	if !strings.Contains(gotWire, expectedB64) {
		t.Fatalf("expected wire HTTP body to preserve full %d-char base64 untouched", len(expectedB64))
	}

	// 2. Stored sessionDebugRecords MUST scrub inline base64 in both RawPayload and Messages!
	sessionDebugMu.RLock()
	recs := append([]SessionDebugPayload(nil), sessionDebugRecords[sid]...)
	sessionDebugMu.RUnlock()
	if len(recs) != 1 {
		t.Fatalf("expected 1 recorded debug payload, got %d", len(recs))
	}
	wantPlaceholder := "[base64 omitted: "
	rawDebugStr := string(recs[0].RawPayload)
	if strings.Contains(rawDebugStr, expectedB64) || !strings.Contains(rawDebugStr, wantPlaceholder) {
		t.Fatalf("expected RawPayload to omit base64 with placeholder, got: %s", rawDebugStr)
	}
	msgJSON, _ := json.Marshal(recs[0].Messages)
	if strings.Contains(string(msgJSON), expectedB64) {
		t.Fatalf("expected debug Messages ImageBlock.Data to be scrubbed")
	}

	// 3. Emitted WS debug_llm_request event MUST also carry scrubbed payload.
	emittedMu.Lock()
	evs := append([]any(nil), emittedEvents...)
	emittedMu.Unlock()
	if len(evs) == 0 {
		t.Fatalf("expected emitted debug_llm_request event")
	}
	evBytes, _ := json.Marshal(evs[0])
	if strings.Contains(string(evBytes), expectedB64) || !strings.Contains(string(evBytes), wantPlaceholder) {
		t.Fatalf("expected WS debug_llm_request event to scrub base64, got: %s", string(evBytes))
	}
}

func clearSessionDebugPayloads(sid string) {
	sessionDebugMu.Lock()
	delete(sessionDebugRecords, sid)
	sessionDebugMu.Unlock()
}

func TestBuildTurnPromptNormalizes4KPNGAndBMPAttachmentsKeepingDiskFilesIntact(t *testing.T) {
	dir := t.TempDir()

	// Create 4K opaque PNG attachment on disk.
	img4K := image.NewRGBA(image.Rect(0, 0, 3840, 2160))
	for y := 0; y < 2160; y++ {
		for x := 0; x < 3840; x++ {
			img4K.SetRGBA(x, y, color.RGBA{
				R: uint8((x*7 + y*13) & 0xff),
				G: uint8((x*19 + y*5) & 0xff),
				B: uint8((x ^ y) & 0xff),
				A: 255,
			})
		}
	}
	var pngBuf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestSpeed}
	if err := enc.Encode(&pngBuf, img4K); err != nil {
		t.Fatalf("encode 4k png: %v", err)
	}
	pngPath := filepath.Join(dir, "att-4k.png")
	origPNGBytes := pngBuf.Bytes()
	if err := os.WriteFile(pngPath, origPNGBytes, 0o600); err != nil {
		t.Fatalf("write png attachment: %v", err)
	}

	// Create BMP attachment on disk.
	bmpImg := image.NewRGBA(image.Rect(0, 0, 200, 120))
	var bmpBuf bytes.Buffer
	if err := bmp.Encode(&bmpBuf, bmpImg); err != nil {
		t.Fatalf("encode bmp: %v", err)
	}
	bmpPath := filepath.Join(dir, "att-shot.bmp")
	origBMPBytes := bmpBuf.Bytes()
	if err := os.WriteFile(bmpPath, origBMPBytes, 0o600); err != nil {
		t.Fatalf("write bmp attachment: %v", err)
	}

	refs := []AttachmentRef{
		{ID: "a1", Name: "paste-4k.png", Mime: "image/png", Size: int64(len(origPNGBytes)), Path: pngPath},
		{ID: "a2", Name: "capture.bmp", Mime: "image/bmp", Size: int64(len(origBMPBytes)), Path: bmpPath},
	}

	fullText, images := buildTurnPrompt(refs, "Analyze both", []string{"a1", "a2"}, "build")
	if len(images) != 2 {
		t.Fatalf("expected 2 normalized ImageBlocks, got %d", len(images))
	}
	if images[0].MimeType != "image/jpeg" || images[0].Width != 1568 || images[0].Height != 882 || images[0].OrigWidth != 3840 || len(images[0].SHA256) != 64 {
		t.Fatalf("unexpected normalized 4K attachment ImageBlock: mime=%s %dx%d orig=%dx%d sha=%s", images[0].MimeType, images[0].Width, images[0].Height, images[0].OrigWidth, images[0].OrigHeight, images[0].SHA256)
	}
	if images[1].MimeType != "image/jpeg" && images[1].MimeType != "image/png" {
		t.Fatalf("expected BMP attachment converted to jpeg/png, got %s", images[1].MimeType)
	}
	if !strings.Contains(fullText, "displayed at 1568x882") {
		t.Fatalf("expected coordinate scale hint in attachment prompt text, got:\n%s", fullText)
	}

	// Disk attachment files MUST remain untouched for UI display!
	diskPNG, err := os.ReadFile(pngPath)
	if err != nil || !bytes.Equal(diskPNG, origPNGBytes) {
		t.Fatalf("expected disk PNG attachment to remain byte-for-byte untouched")
	}
}

func TestCompactionVisionStatePersistsAcrossDiskStoreWALAndSilentHysteresis(t *testing.T) {
	dir := t.TempDir()
	store := newDiskStore(dir)

	capVal := 2
	origComp := &core.CompactionState{
		ImageDigests: map[string]string{
			strings.Repeat("b", 64): "- OCR: `FATAL: database \"prod\" does not exist`",
		},
		EvictedImages: map[string]bool{
			"0:1:" + strings.Repeat("b", 64): true,
			"4:1:" + strings.Repeat("c", 64): true,
		},
		LearnedMaxImages: &capVal,
	}

	rec := &SessionRecord{
		ID:         "sess_vision_persist",
		CWD:        dir,
		Title:      "Vision Persistence",
		Model:      "claude-sonnet-4-6",
		Status:     "idle",
		Options:    SessionOptions{Mode: "build", Access: "full"},
		TurnSeq:    2,
		Compaction: origComp.Clone(),
		Messages: []provider.Message{
			{ID: "m0", Role: provider.RoleUser, TurnIndex: 1, Content: []provider.Content{provider.TextBlock{Text: "turn 1"}}},
			{ID: "m1", Role: provider.RoleAssistant, TurnIndex: 1, Content: []provider.Content{provider.TextBlock{Text: "ok 1"}}},
			{ID: "m2", Role: provider.RoleUser, TurnIndex: 2, Content: []provider.Content{provider.TextBlock{Text: "turn 2"}}},
			{ID: "m3", Role: provider.RoleAssistant, TurnIndex: 2, Content: []provider.Content{provider.TextBlock{Text: "ok 2"}}},
		},
	}
	if err := store.saveSessionSync(rec); err != nil {
		t.Fatalf("saveSessionSync: %v", err)
	}

	loaded, err := store.loadSession(rec.ID)
	if err != nil {
		t.Fatalf("loadSession: %v", err)
	}
	if loaded.Compaction == nil || loaded.Compaction.LearnedMaxImages == nil || *loaded.Compaction.LearnedMaxImages != 2 {
		t.Fatalf("expected LearnedMaxImages=2 after reload, got %+v", loaded.Compaction)
	}
	if loaded.Compaction.ImageDigests[strings.Repeat("b", 64)] == "" || !loaded.Compaction.EvictedImages["0:1:"+strings.Repeat("b", 64)] {
		t.Fatalf("expected ImageDigests and EvictedImages preserved after reload, got %+v", loaded.Compaction)
	}

	// Truncating at message index 2 must prune EvictedImages at msgIdx=4 while keeping msgIdx=0, ImageDigests, and LearnedMaxImages!
	truncated := truncateSessionCompaction(loaded.Compaction, 2)
	if truncated == nil {
		t.Fatalf("expected non-nil CompactionState preserving vision state across tail cut")
	}
	if !truncated.EvictedImages["0:1:"+strings.Repeat("b", 64)] || truncated.EvictedImages["4:1:"+strings.Repeat("c", 64)] {
		t.Fatalf("expected EvictedImages pruned above cut=2 only, got %+v", truncated.EvictedImages)
	}
	if truncated.LearnedMaxImages == nil || *truncated.LearnedMaxImages != 2 {
		t.Fatalf("expected LearnedMaxImages preserved across cut, got %+v", truncated.LearnedMaxImages)
	}

	// Verify turnBridge.onCompactionState journals vision-only hysteresis updates to WAL without emitting spurious "session_compacted" toast!
	inbox := make(chan Envelope, 8)
	var emittedTypes []string
	tb := &turnBridge{
		env: workerEnv{
			actorID: rec.ID,
			inbox:   inbox,
			done:    make(chan struct{}),
		},
		snap:        workerSnapshot{gen: 1, turnIndex: 3},
		cfg:         DaemonConfig{HostID: "h1"},
		agent:       core.NewAgent(nil, "m", "sys", core.NewRegistry()),
		lastFoldSig: foldSigOf(nil),
	}
	tb.onCompactionState(truncated)

	// Drain inbox: expect walAppendMsg(walTypeCompaction) and ZERO workerEmitMsg("session_compacted").
	close(inbox)
	walCompCount := 0
	for env := range inbox {
		switch p := env.Payload.(type) {
		case walAppendMsg:
			if p.ev.Type == walTypeCompaction && p.ev.Compaction != nil {
				walCompCount++
			}
		case workerEmitMsg:
			if m, ok := p.event.(map[string]any); ok {
				if tp, _ := m["type"].(string); tp != "" {
					emittedTypes = append(emittedTypes, tp)
				}
			}
		}
	}
	if walCompCount != 1 {
		t.Fatalf("expected 1 walTypeCompaction write, got %d", walCompCount)
	}
	if len(emittedTypes) != 0 {
		t.Fatalf("expected silent vision hysteresis update (no session_compacted toast), got emitted events: %v", emittedTypes)
	}
}
