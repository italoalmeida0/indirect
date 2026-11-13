package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"indirect/indirect-code-daemon/packages/core"
	"indirect/indirect-code-daemon/packages/filetrack"
	"indirect/indirect-code-daemon/packages/provider"
	"indirect/indirect-code-daemon/packages/searchindex"
	"indirect/indirect-code-daemon/packages/sessionstore"
)

func makeDeterministicPNG(seed int, w, h int) []byte {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			r := uint8((seed*73 + x*17 + y*31) ^ (x * y))
			g := uint8((seed*41 + x*53 + y*19) ^ (x + y*7))
			b := uint8((seed*97 + x*29 + y*61) ^ (x*3 + y))
			img.SetNRGBA(x, y, color.NRGBA{R: r, G: g, B: b, A: 255})
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

func waitForWSResponse(t *testing.T, h *wsHarness, typ, reqID string, timeout time.Duration) map[string]any {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		h.mu.Lock()
		for i := len(h.sent) - 1; i >= 0; i-- {
			m := h.sent[i]
			if m["type"] != typ {
				continue
			}
			if reqID != "" && m["requestId"] != reqID {
				continue
			}
			h.mu.Unlock()
			return m
		}
		h.mu.Unlock()
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for WS event type=%q requestId=%q", typ, reqID)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func TestOneYearOpenSessionScaleAndLatency(t *testing.T) {
	h := newWSHarness(t)
	st := newDiskStore(h.dir)
	sid := "sess_one_year_open"
	nowMs := time.Now().UnixMilli()
	oldTs := time.Now().Add(-30 * 24 * time.Hour).Unix()

	const totalSeededTurns = 5100 // 10,200 messages + 102 externalized CAS images

	var sampleSHA256 string
	var sampleRawPNG []byte
	var hotImageSHA256 string

	// Seed 5,100 turns in batches into v2 sessionstore (turns 1..5000 stamped 30d old so AgeSession zstd-archives them).
	const batchSize = 250
	for batchStart := 1; batchStart <= totalSeededTurns; batchStart += batchSize {
		batchEnd := min(batchStart+batchSize-1, totalSeededTurns)
		writes := make([]sessionstore.TurnWrite, 0, batchEnd-batchStart+1)
		for turn := batchStart; turn <= batchEnd; turn++ {
			userContent := []provider.Content{
				provider.TextBlock{Text: fmt.Sprintf("Turn %d user request discussing subsystem-%d architecture and invariants.", turn, turn%37)},
			}
			if turn == 42 {
				userContent = []provider.Content{
					provider.TextBlock{Text: "COLD_TURN_42_EXACT_NEEDLE_MARKER: verify cold zstd random access jump."},
				}
			}
			if turn%50 == 0 {
				rawPNG := makeDeterministicPNG(turn, 96, 96)
				userContent = append(userContent, provider.ImageBlock{
					MimeType:  "image/png",
					MediaType: "image/png",
					Data:      rawPNG,
				})
				if sampleSHA256 == "" {
					extPreview, err := st.cas.ExternalizeMessageImages([]provider.Message{{
						Role:    provider.RoleUser,
						Content: []provider.Content{provider.ImageBlock{MimeType: "image/png", Data: rawPNG}},
					}})
					if err != nil {
						t.Fatalf("externalize preview: %v", err)
					}
					sampleSHA256 = extPreview[0].Content[0].(provider.ImageBlock).BlobSHA256
					sampleRawPNG = rawPNG
				}
				if turn == 5050 {
					extHot, err := st.cas.ExternalizeMessageImages([]provider.Message{{
						Role:    provider.RoleUser,
						Content: []provider.Content{provider.ImageBlock{MimeType: "image/png", Data: rawPNG}},
					}})
					if err != nil {
						t.Fatalf("externalize hot preview: %v", err)
					}
					hotImageSHA256 = extHot[0].Content[0].(provider.ImageBlock).BlobSHA256
				}
			}

			msgs := []provider.Message{
				{
					ID:        fmt.Sprintf("u-%d", turn),
					Role:      provider.RoleUser,
					TurnIndex: turn,
					Content:   userContent,
				},
				{
					ID:        fmt.Sprintf("a-%d", turn),
					Role:      provider.RoleAssistant,
					TurnIndex: turn,
					Content: []provider.Content{
						provider.TextBlock{Text: fmt.Sprintf("Turn %d assistant analysis: verified invariant-%d with zero regressions.", turn, turn)},
					},
				},
			}
			extMsgs, err := st.cas.ExternalizeMessageImages(msgs)
			if err != nil {
				t.Fatalf("ExternalizeMessageImages turn %d: %v", turn, err)
			}
			var balloon *filetrack.TurnChanges
			if turn == 42 || turn%200 == 0 {
				balloon = &filetrack.TurnChanges{
					TurnIndex: turn,
					Files: []filetrack.ChangedFile{{
						Path:   fmt.Sprintf("pkg/mod_%d.go", turn),
						Rel:    fmt.Sprintf("pkg/mod_%d.go", turn),
						Status: "modified",
						Diff:   "+func Check() bool { return true }\n",
					}},
				}
			}
			ts := oldTs
			if turn > 5000 {
				ts = time.Now().Unix()
			}
			writes = append(writes, sessionstore.TurnWrite{
				TurnSeq:       turn,
				Messages:      extMsgs,
				DiffBalloon:   balloon,
				CreatedAtUnix: ts,
			})
		}
		if _, err := st.v2.AppendTurns(sid, writes); err != nil {
			t.Fatalf("AppendTurns %d..%d: %v", batchStart, batchEnd, err)
		}
	}

	// Compaction covers turns 1..5000 (messages [0, 10000)); post-compaction active era is [10000, 10200).
	comp := &core.CompactionState{
		KeepFrom:         10000,
		FirstKeptEntryID: "h10000",
		PreviousSummary:  "Compacted 5,000 turns of year-long engineering work.",
		Blocks: []core.FoldBlock{{
			ID:       "b1",
			StartIdx: 0,
			EndIdx:   10000,
			Topic:    "Year 1 Architecture & History",
			Summary:  "Compacted 5,000 turns of year-long engineering work.",
		}},
		NextBlockSeq: 1,
	}
	initRec := &SessionRecord{
		ID:         sid,
		CWD:        h.dir,
		Title:      "1-Year Open Engineering Session",
		Model:      "claude-sonnet-4-5",
		Options:    SessionOptions{Mode: "talk", Access: "full", Effort: "none"},
		Status:     "idle",
		CreatedAt:  nowMs - 365*24*3600*1000,
		UpdatedAt:  nowMs,
		TurnSeq:    totalSeededTurns,
		Compaction: comp,
	}
	if err := st.writeMetaV2(sid, recordMeta(initRec)); err != nil {
		t.Fatalf("writeMetaV2: %v", err)
	}

	// Age warm segments older than 7d into Cold .zst archives!
	agedCount, err := st.v2.AgeSession(context.Background(), sid, sessionstore.DefaultAgePolicy())
	if err != nil {
		t.Fatalf("AgeSession: %v", err)
	}
	if agedCount == 0 {
		t.Fatalf("expected warm segments to be archived into cold .zst")
	}
	stats, err := st.v2.SessionStats(sid)
	if err != nil || stats.ColdSegments == 0 {
		t.Fatalf("expected cold .zst segments on disk, err=%v stats=%+v", err, stats)
	}
	sessFiles, err := os.ReadDir(filepath.Join(h.dir, "sessions", sid))
	hasZst := false
	for _, e := range sessFiles {
		if strings.HasSuffix(e.Name(), ".zst") {
			hasZst = true
			break
		}
	}
	if err != nil || !hasZst {
		t.Fatalf("expected cold .zst archive files on disk, err=%v files=%d", err, len(sessFiles))
	}

	// Measure Go HeapAlloc delta when spawning & holding the active resident sessionActor!
	runtime.GC()
	debug.FreeOSMemory()
	var memBefore runtime.MemStats
	runtime.ReadMemStats(&memBefore)

	routeRes := h.sup.route(sid, false)
	if routeRes.Error != "" {
		t.Fatalf("route(%s) failed: %s", sid, routeRes.Error)
	}
	rep := h.sup.ping(sid)
	if rep == nil {
		t.Fatalf("watchdog ping returned nil")
	}

	runtime.GC()
	var memAfter runtime.MemStats
	runtime.ReadMemStats(&memAfter)
	var heapDelta int64
	if memAfter.HeapAlloc > memBefore.HeapAlloc {
		heapDelta = int64(memAfter.HeapAlloc - memBefore.HeapAlloc)
	}

	const maxAllowedResidentBytes = 15 << 20 // 15 MiB
	if rep.ResidentBytes >= maxAllowedResidentBytes {
		t.Fatalf("estimateResidentBytes = %d (%.2f MiB), want < 15 MiB", rep.ResidentBytes, float64(rep.ResidentBytes)/(1<<20))
	}
	if heapDelta >= maxAllowedResidentBytes {
		t.Fatalf("HeapAlloc delta = %d (%.2f MiB), want < 15 MiB", heapDelta, float64(heapDelta)/(1<<20))
	}

	// Verify resident window only holds the hot tail and zero inline ImageBlock.Data bytes!
	rr := make(chan any, 1)
	routeRes.Inbox <- Envelope{Payload: readReqMsg{What: "data", Reply: rr}}
	rd := (<-rr).(readResult)
	hotRec := rd.Payload.(*SessionRecord)
	if hotRec.HotBaseTurn < 4900 || hotRec.HotBaseMsgIdx < 9800 {
		t.Fatalf("expected HotBaseTurn >= 4900 & HotBaseMsgIdx >= 9800, got turn=%d msgIdx=%d (len=%d)",
			hotRec.HotBaseTurn, hotRec.HotBaseMsgIdx, len(hotRec.Messages))
	}
	for _, m := range hotRec.Messages {
		for _, c := range m.Content {
			if ib, ok := c.(provider.ImageBlock); ok {
				if len(ib.Data) != 0 || ib.BlobSHA256 == "" {
					t.Fatalf("resident hot message leaked inline ImageBlock.Data=%d or missing BlobSHA256=%q", len(ib.Data), ib.BlobSHA256)
				}
			}
		}
	}

	// Run a REAL live turn (Turn 5101) through a mock Anthropic gateway to verify:
	// 1. FoldBlock compaction projection works with HotBaseMsgIdx > 0
	// 2. CAS images in the active era (Turn 5050) are transiently hydrated ONLY on wire
	// 3. Turn commit + WAL seal is O(turn_size) (< 15 ms) and resident ImageBlock.Data stays nil!
	var wireMu sync.Mutex
	var capturedWireBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/messages") {
			body, _ := io.ReadAll(r.Body)
			wireMu.Lock()
			capturedWireBody = body
			wireMu.Unlock()
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_live\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-sonnet-4-5\",\"usage\":{\"input_tokens\":120,\"output_tokens\":1}}}\n\n")
			_, _ = io.WriteString(w, "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n")
			_, _ = io.WriteString(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Live turn 5101 complete.\"}}\n\n")
			_, _ = io.WriteString(w, "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n")
			_, _ = io.WriteString(w, "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":8}}\n\n")
			_, _ = io.WriteString(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"context_window":200000,"max_output_tokens":8192,"vision":true}`)
	}))
	defer srv.Close()
	h.cfg.store(&DaemonConfig{
		HostID:     "h",
		GatewayURL: srv.URL,
		APIKey:     "test-key",
		Settings:   HarnessSettings{NoAutoTitle: true},
	})

	h.send(map[string]any{
		"type":      "prompt",
		"sessionId": sid,
		"requestId": "prompt-5101",
		"text":      "Continue year-long session turn 5101",
	})
	_ = waitForWSResponse(t, h, "prompt_accepted", "prompt-5101", 5*time.Second)

	// Wait until actor returns to stateIdle after committing Turn 5101.
	deadline := time.Now().Add(5 * time.Second)
	for {
		p := h.sup.ping(sid)
		if p != nil && p.State == stateIdle {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("turn 5101 did not finish in time")
		}
		time.Sleep(5 * time.Millisecond)
	}

	wireMu.Lock()
	wireCopy := append([]byte(nil), capturedWireBody...)
	wireMu.Unlock()
	if !bytes.Contains(wireCopy, []byte("Compacted 5,000 turns of year-long engineering work.")) {
		t.Fatalf("wire request missing projected compaction FoldBlock summary")
	}
	if !bytes.Contains(wireCopy, []byte(`"media_type":"image/png"`)) {
		t.Fatalf("wire request did not transiently hydrate CAS image for vision model")
	}

	// Re-check resident actor after live turn: ImageBlock.Data MUST still be nil!
	rr2 := make(chan any, 1)
	routeRes.Inbox <- Envelope{Payload: readReqMsg{What: "data", Reply: rr2}}
	hotRecAfter := (<-rr2).(readResult).Payload.(*SessionRecord)
	for _, m := range hotRecAfter.Messages {
		for _, c := range m.Content {
			if ib, ok := c.(provider.ImageBlock); ok && len(ib.Data) != 0 {
				t.Fatalf("transient wire hydration mutated resident ImageBlock.Data (%d bytes)!", len(ib.Data))
			}
		}
	}

	// Measure interleaved 1-turn baseline vs 5,100+-turn commitWAL on the same
	// filesystem so both experience identical OS IO queue pressure (Windows NTFS +
	// Defender has a ~15-30ms per-commit FlushFileBuffers floor across 3 synced files).
	baseRec := &SessionRecord{ID: "sess_1turn_base", CWD: h.dir, Title: "base"}
	{
		// Seed turn 1 on baseRec so subsequent commits append to an existing turn.idx.
		baseRec.TurnSeq = 1
		initWW, err := st.openWAL(baseRec.ID, &walHeader{TurnIndex: 1, StartedAt: time.Now().UnixMilli(), Prompt: "init"})
		if err != nil {
			t.Fatalf("openWAL baseline init: %v", err)
		}
		baseRec.Messages = append(baseRec.Messages,
			provider.Message{ID: "bu-1", Role: provider.RoleUser, TurnIndex: 1, Content: []provider.Content{provider.TextBlock{Text: "Bench turn"}}},
			provider.Message{ID: "ba-1", Role: provider.RoleAssistant, TurnIndex: 1, Content: []provider.Content{provider.TextBlock{Text: "Ack"}}},
		)
		if err := st.commitWAL(baseRec.ID, baseRec, initWW); err != nil {
			t.Fatalf("commitWAL baseline init: %v", err)
		}
	}

	commitRec := cloneRecord(hotRecAfter)
	var baseSamples, commitSamples []time.Duration
	for step := 0; step < 5; step++ {
		baseStep := step + 2
		baseRec.TurnSeq = baseStep
		baseWW, err := st.openWAL(baseRec.ID, &walHeader{TurnIndex: baseStep, StartedAt: time.Now().UnixMilli(), Prompt: "b"})
		if err != nil {
			t.Fatalf("openWAL baseline %d: %v", baseStep, err)
		}
		baseRec.Messages = append(baseRec.Messages,
			provider.Message{ID: fmt.Sprintf("bu-%d", baseStep), Role: provider.RoleUser, TurnIndex: baseStep, Content: []provider.Content{provider.TextBlock{Text: "Bench turn"}}},
			provider.Message{ID: fmt.Sprintf("ba-%d", baseStep), Role: provider.RoleAssistant, TurnIndex: baseStep, Content: []provider.Content{provider.TextBlock{Text: "Ack"}}},
		)
		b0 := time.Now()
		if err := st.commitWAL(baseRec.ID, baseRec, baseWW); err != nil {
			t.Fatalf("commitWAL baseline %d: %v", baseStep, err)
		}
		baseSamples = append(baseSamples, time.Since(b0))

		commitRec.TurnSeq = totalSeededTurns + 2 + step
		ww, err := st.openWAL(sid, &walHeader{TurnIndex: commitRec.TurnSeq, StartedAt: time.Now().UnixMilli(), Prompt: "bench"})
		if err != nil {
			t.Fatalf("openWAL bench %d: %v", step, err)
		}
		commitRec.Messages = append(commitRec.Messages,
			provider.Message{ID: fmt.Sprintf("u-%d", commitRec.TurnSeq), Role: provider.RoleUser, TurnIndex: commitRec.TurnSeq, Content: []provider.Content{provider.TextBlock{Text: "Bench turn"}}},
			provider.Message{ID: fmt.Sprintf("a-%d", commitRec.TurnSeq), Role: provider.RoleAssistant, TurnIndex: commitRec.TurnSeq, Content: []provider.Content{provider.TextBlock{Text: "Ack"}}},
		)
		t0 := time.Now()
		if err := st.commitWAL(sid, commitRec, ww); err != nil {
			t.Fatalf("commitWAL bench %d failed: %v", step, err)
		}
		commitSamples = append(commitSamples, time.Since(t0))
	}
	slices.Sort(baseSamples)
	slices.Sort(commitSamples)
	baseOneTurnDur := baseSamples[1] // P25 avoids single-spike OS fsync stalls
	commitDur := commitSamples[1]
	maxCommitAllowed := 15 * time.Millisecond
	if runtime.GOOS == "windows" {
		// Windows FlushFileBuffers + atomic MoveFileExW on %TEMP% serializes NTFS
		// journal flushes across parallel test processes; enforce O(1) parity with 1-turn!
		maxCommitAllowed = max(35*time.Millisecond, min(100*time.Millisecond, 3*baseOneTurnDur))
	}
	if commitDur >= maxCommitAllowed {
		t.Fatalf("commitWAL P25 took %v on 5,100+-turn session (1-turn P25=%v), want < %v", commitDur, baseOneTurnDur, maxCommitAllowed)
	}

	// Benchmark get_session tail latency (< 5ms) and verify wire CAS image ref shape!
	_, _ = h.server.buildSessionData(sid, "warm")
	var tailEv map[string]any
	var errMsg string
	tailDur := time.Hour
	for i := 0; i < 3; i++ {
		tailStart := time.Now()
		tailEv, errMsg = h.server.buildSessionData(sid, "tail-bench")
		if d := time.Since(tailStart); d < tailDur {
			tailDur = d
		}
	}
	if tailEv == nil || errMsg != "" {
		t.Fatalf("buildSessionData failed: %s", errMsg)
	}
	if tailDur >= 5*time.Millisecond {
		t.Fatalf("get_session tail took %v, want < 5ms", tailDur)
	}
	sessMap := tailEv["session"].(map[string]any)
	histMap := sessMap["history"].(map[string]any)
	if histMap["hasOlder"] != true {
		t.Fatalf("expected hasOlder=true on 5,100+ turn session, got %+v", histMap)
	}
	tailJSON, _ := json.Marshal(sessMap["messages"])
	if hotImageSHA256 != "" && !bytes.Contains(tailJSON, []byte(hotImageSHA256)) {
		t.Fatalf("expected hot window wire messages to emit blobSha256 %s", hotImageSHA256)
	}

	measureHistoryReq := func(req readReqMsg) (historyBlock, time.Duration) {
		warm := req
		warm.Reply = make(chan any, 1)
		routeRes.Inbox <- Envelope{Payload: warm}
		<-warm.Reply

		best := time.Hour
		var out historyBlock
		for i := 0; i < 3; i++ {
			c := req
			c.Reply = make(chan any, 1)
			t0 := time.Now()
			routeRes.Inbox <- Envelope{Payload: c}
			out = (<-c.Reply).(readResult).Payload.(historyBlock)
			if d := time.Since(t0); d < best {
				best = d
			}
		}
		return out, best
	}

	// Benchmark get_history into Cold .zst Turn #42 (aroundMsgIdx=82, beforeTurn=42, afterTurn=42) (< 5ms each)!
	targetColdIdx := 82 // Turn #42 user message (0-based: (42-1)*2 = 82)
	aroundBlock, aroundDur := measureHistoryReq(readReqMsg{What: "historyBlock", AroundMsgIdx: &targetColdIdx})
	if aroundDur >= 5*time.Millisecond {
		t.Fatalf("aroundMsgIdx(82) into Cold .zst Turn #42 took %v, want < 5ms", aroundDur)
	}
	if aroundBlock.Direction != "around" || aroundBlock.HasOlder != (aroundBlock.FirstIndex > 0) || !aroundBlock.HasNewer {
		t.Fatalf("unexpected aroundBlock cursor: dir=%q firstIdx=%d hasOlder=%v hasNewer=%v", aroundBlock.Direction, aroundBlock.FirstIndex, aroundBlock.HasOlder, aroundBlock.HasNewer)
	}
	// Also verify interior Cold .zst Turn #500 (msgIdx=998) sets BOTH hasOlder=true and hasNewer=true in < 5ms!
	midColdIdx := 998
	midBlock, midDur := measureHistoryReq(readReqMsg{What: "historyBlock", AroundMsgIdx: &midColdIdx})
	if midDur >= 5*time.Millisecond {
		t.Fatalf("aroundMsgIdx(998) into interior Cold .zst Turn #500 took %v, want < 5ms", midDur)
	}
	if midBlock.Direction != "around" || !midBlock.HasOlder || !midBlock.HasNewer {
		t.Fatalf("interior Cold Turn #500 cursor invalid: dir=%q hasOlder=%v hasNewer=%v", midBlock.Direction, midBlock.HasOlder, midBlock.HasNewer)
	}
	if aroundBlock.TargetMsgIdx == nil || *aroundBlock.TargetMsgIdx != targetColdIdx {
		t.Fatalf("expected TargetMsgIdx=%d, got %v", targetColdIdx, aroundBlock.TargetMsgIdx)
	}
	local42 := targetColdIdx - aroundBlock.FirstIndex
	if local42 < 0 || local42 >= len(aroundBlock.Messages) {
		t.Fatalf("targetMsgIdx %d out of returned window [firstIndex=%d, len=%d)", targetColdIdx, aroundBlock.FirstIndex, len(aroundBlock.Messages))
	}
	gotNeedle := aroundBlock.Messages[local42].Content[0].(provider.TextBlock).Text
	if !strings.Contains(gotNeedle, "COLD_TURN_42_EXACT_NEEDLE_MARKER") {
		t.Fatalf("expected COLD_TURN_42_EXACT_NEEDLE_MARKER at index 82, got %q", gotNeedle)
	}

	beforeBlock, beforeDur := measureHistoryReq(readReqMsg{What: "historyBlock", BeforeTurn: 42})
	if beforeDur >= 5*time.Millisecond {
		t.Fatalf("beforeTurn(42) took %v, want < 5ms", beforeDur)
	}
	if beforeBlock.Direction != "older" || beforeBlock.NewestTurn != 41 {
		t.Fatalf("beforeTurn(42) expected direction=older newestTurn=41, got dir=%q newest=%d", beforeBlock.Direction, beforeBlock.NewestTurn)
	}

	afterBlock, afterDur := measureHistoryReq(readReqMsg{What: "historyBlock", AfterTurn: 42})
	if afterDur >= 5*time.Millisecond {
		t.Fatalf("afterTurn(42) took %v, want < 5ms", afterDur)
	}
	if afterBlock.Direction != "newer" || afterBlock.OldestTurn != 43 || !afterBlock.HasNewer {
		t.Fatalf("afterTurn(42) expected direction=newer oldestTurn=43 hasNewer=true, got dir=%q oldest=%d hasNewer=%v",
			afterBlock.Direction, afterBlock.OldestTurn, afterBlock.HasNewer)
	}

	// Verify explicit aroundMsgIdx=0 (pointer to 0!) on WS get_history jumps to Turn #1 rather than tail!
	h.send(map[string]any{
		"type":         "get_history",
		"sessionId":    sid,
		"aroundMsgIdx": 0,
		"requestId":    "hist-zero",
	})
	zeroEv := waitForWSResponse(t, h, "session_content", "hist-zero", 5*time.Second)
	zeroHist := zeroEv["history"].(map[string]any)
	if zeroEv["direction"] != "around" || zeroHist["firstIndex"] != 0 || zeroHist["oldestTurn"] != 1 {
		t.Fatalf("aroundMsgIdx=0 failed: dir=%v hist=%+v", zeroEv["direction"], zeroHist)
	}

	// Verify get_blob hydrates exact CAS PNG bytes!
	h.send(map[string]any{
		"type":      "get_blob",
		"sha256":    sampleSHA256,
		"requestId": "blob-1",
	})
	blobEv := waitForWSResponse(t, h, "blob_data", "blob-1", 5*time.Second)
	if blobEv["mediaType"] != "image/png" {
		t.Fatalf("expected mediaType=image/png, got %v", blobEv["mediaType"])
	}
	decodedPNG, err := base64.StdEncoding.DecodeString(blobEv["data"].(string))
	if err != nil || !bytes.Equal(decodedPNG, sampleRawPNG) {
		t.Fatalf("get_blob decoded bytes mismatch (len=%d want=%d err=%v)", len(decodedPNG), len(sampleRawPNG), err)
	}

	t.Logf("1-Year Scale Metrics: turns=%d coldSegs=%d residentBytes=%d (%.2f MiB) heapAllocDelta=%d (%.2f MiB) commitWAL=%v get_session=%v aroundMsgIdx(82)=%v beforeTurn(42)=%v afterTurn(42)=%v",
		commitRec.TurnSeq, stats.ColdSegments, rep.ResidentBytes, float64(rep.ResidentBytes)/(1<<20),
		heapDelta, float64(heapDelta)/(1<<20), commitDur, tailDur, aroundDur, beforeDur, afterDur)

	t.Logf("1-Year Open Session Metrics (5,102 turns, 102 CAS PNGs, zstd Cold archived): estimateResidentBytes=%.2f MiB, HeapAllocDelta=%.2f MiB, commitWAL=%v, get_session=%v, aroundMsgIdx(42)=%v, beforeTurn(42)=%v, afterTurn(42)=%v",
		float64(rep.ResidentBytes)/(1<<20), float64(heapDelta)/(1<<20), commitDur, tailDur, aroundDur, beforeDur, afterDur)
}

func TestBM25FWSSearchColdAgenticDiacriticsAndCancel(t *testing.T) {
	h := newWSHarness(t)
	st := newDiskStore(h.dir)
	oldTs := time.Now().Add(-20 * 24 * time.Hour).Unix()

	// Session 1: Cold .zst archived session with unique needle + agentic finish_entire_request answer!
	sidCold := "sess_bm25_cold"
	var coldTurns []sessionstore.TurnWrite
	for turn := 1; turn <= 140; turn++ {
		uText := fmt.Sprintf("Routine turn %d checking metrics.", turn)
		aContent := []provider.Content{
			provider.TextBlock{Text: fmt.Sprintf("Metrics ok on turn %d.", turn)},
		}
		if turn == 12 {
			uText = "Investigate zyxwv99coldneedle anomaly in consensus layer."
			aContent = []provider.Content{
				provider.ToolCallBlock{
					ID:        "tc-finish-12",
					Name:      "finish_entire_request",
					Arguments: json.RawMessage(`{"final_message_to_user":"Implemented distributed raft quorum lease renewal with fencing"}`),
				},
			}
		}
		coldTurns = append(coldTurns, sessionstore.TurnWrite{
			TurnSeq:       turn,
			CreatedAtUnix: oldTs,
			Messages: []provider.Message{
				{ID: fmt.Sprintf("cu-%d", turn), Role: provider.RoleUser, TurnIndex: turn, Content: []provider.Content{provider.TextBlock{Text: uText}}},
				{ID: fmt.Sprintf("ca-%d", turn), Role: provider.RoleAssistant, TurnIndex: turn, Content: aContent},
			},
		})
	}
	if _, err := st.v2.AppendTurns(sidCold, coldTurns); err != nil {
		t.Fatalf("AppendTurns cold: %v", err)
	}
	if err := st.writeMetaV2(sidCold, recordMeta(&SessionRecord{
		ID: sidCold, CWD: h.dir, Title: "Consensus Storage Audit", UpdatedAt: 1000, TurnSeq: 140,
	})); err != nil {
		t.Fatalf("writeMetaV2 cold: %v", err)
	}
	if _, err := st.v2.AgeSession(context.Background(), sidCold, sessionstore.DefaultAgePolicy()); err != nil {
		t.Fatalf("AgeSession cold: %v", err)
	}

	// Session 2: PT-BR diacritics in both title and transcript!
	sidPT := "sess_bm25_ptbr"
	_, err := st.v2.AppendTurns(sidPT, []sessionstore.TurnWrite{{
		TurnSeq:       1,
		CreatedAtUnix: time.Now().Unix(),
		Messages: []provider.Message{
			{ID: "pu-1", Role: provider.RoleUser, TurnIndex: 1, Content: []provider.Content{provider.TextBlock{Text: "A sessão expirou durante a conexão simultânea no módulo de produção."}}},
			{ID: "pa-1", Role: provider.RoleAssistant, TurnIndex: 1, Content: []provider.Content{provider.TextBlock{Text: "Corrigimos a validação do token de sessão e reconexão automática."}}},
		},
	}})
	if err != nil {
		t.Fatalf("AppendTurns ptbr: %v", err)
	}
	if err := st.writeMetaV2(sidPT, recordMeta(&SessionRecord{
		ID: sidPT, CWD: h.dir, Title: "Configuração de autenticação", UpdatedAt: 2000, TurnSeq: 1,
	})); err != nil {
		t.Fatalf("writeMetaV2 ptbr: %v", err)
	}

	// Run maintenance backfill + Flush so segments live on disk!
	maint := &maintenanceWorker{rootDir: h.dir, dataDir: h.dir, sup: h.sup, search: h.sup.searchRef()}
	maint.backfillSearch(context.Background())

	// 1. Search Cold-archived Turn #12 token.
	h.send(map[string]any{"type": "search", "query": "zyxwv99coldneedle", "requestId": "req-cold"})
	resCold := waitForWSResponse(t, h, "search_results", "req-cold", 5*time.Second)
	hitsCold := resCold["results"].([]any)
	if len(hitsCold) != 1 {
		t.Fatalf("expected 1 hit for cold token, got %+v", hitsCold)
	}
	hit0 := hitsCold[0].(map[string]any)
	if hit0["sessionId"] != sidCold || hit0["turnIndex"] != 12 || hit0["messageIdx"] != 22 {
		t.Fatalf("unexpected cold hit coordinates: %+v", hit0)
	}

	// 2. Search finish_entire_request summary text.
	h.send(map[string]any{"type": "search", "query": "raft quorum lease", "requestId": "req-finish"})
	resFinish := waitForWSResponse(t, h, "search_results", "req-finish", 5*time.Second)
	hitsFinish := resFinish["results"].([]any)
	if len(hitsFinish) != 1 {
		t.Fatalf("expected 1 hit for finish_entire_request summary, got %+v", hitsFinish)
	}
	hitFin := hitsFinish[0].(map[string]any)
	if hitFin["sessionId"] != sidCold || hitFin["field"] != "assistant" || hitFin["turnIndex"] != 12 {
		t.Fatalf("expected assistant-field hit on turn 12 for finish_entire_request, got %+v", hitFin)
	}

	// 3. Search PT-BR diacritics (accented <-> unaccented).
	h.send(map[string]any{"type": "search", "query": "sessao conexao configuracao", "requestId": "req-ptbr-ascii"})
	resPT1 := waitForWSResponse(t, h, "search_results", "req-ptbr-ascii", 5*time.Second)
	if hits := resPT1["results"].([]any); len(hits) != 1 || hits[0].(map[string]any)["sessionId"] != sidPT {
		t.Fatalf("expected PT-BR ascii query to match %s, got %+v", sidPT, hits)
	}
	h.send(map[string]any{"type": "search", "query": "sessão", "requestId": "req-ptbr-acc"})
	resPT2 := waitForWSResponse(t, h, "search_results", "req-ptbr-acc", 5*time.Second)
	if hits := resPT2["results"].([]any); len(hits) != 1 || hits[0].(map[string]any)["sessionId"] != sidPT {
		t.Fatalf("expected PT-BR accented query to match %s, got %+v", sidPT, hits)
	}

	// 4. Off-hostLane execution & superseding cancellation!
	// Deliberately block hostLane completely and verify search still executes and supersedes stale queries!
	hostGate := make(chan struct{})
	hostBlocked := make(chan struct{})
	h.server.hostLane.pushFn(func() {
		close(hostBlocked)
		<-hostGate
	}, func() {})
	<-hostBlocked
	defer close(hostGate)

	// Saturate all 4 searchSem slots temporarily so queued stale searches get cancelled before running!
	semHold := make(chan struct{})
	for i := 0; i < 4; i++ {
		h.server.sem() <- struct{}{}
	}
	for i := 0; i < 8; i++ {
		h.send(map[string]any{
			"type":      "search",
			"query":     "sessao",
			"requestId": fmt.Sprintf("stale-%d", i),
		})
	}
	// Dispatch the winning superseding search!
	h.send(map[string]any{
		"type":      "search",
		"query":     "zyxwv99coldneedle",
		"requestId": "winner-while-hostlane-blocked",
	})
	close(semHold)
	for i := 0; i < 4; i++ {
		<-h.server.sem()
	}

	winnerEv := waitForWSResponse(t, h, "search_results", "winner-while-hostlane-blocked", 5*time.Second)
	if len(winnerEv["results"].([]any)) != 1 {
		t.Fatalf("expected winner search to succeed while hostLane is blocked, got %+v", winnerEv)
	}
	// Verify NONE of stale-0..stale-7 emitted results!
	h.mu.Lock()
	for _, ev := range h.sent {
		if ev["type"] == "search_results" {
			if rid, _ := ev["requestId"].(string); strings.HasPrefix(rid, "stale-") {
				h.mu.Unlock()
				t.Fatalf("superseded stale search %q should have been cancelled without emitting!", rid)
			}
		}
	}
	h.mu.Unlock()
}

func TestPurgeAndDebugMemoryBounds(t *testing.T) {
	h := newWSHarness(t)
	st := newDiskStore(h.dir)

	// 1. Verify sessionDebugRecords per-session cap (3), per-string scrub (16 KiB), global cap (16 MiB), and clear on evictIdle!
	sidEvict := "sess_debug_evict"
	if err := st.writeMetaV2(sidEvict, recordMeta(&SessionRecord{
		ID: sidEvict, CWD: h.dir, Title: "Debug Evict Test", Status: "idle", UpdatedAt: time.Now().UnixMilli(),
	})); err != nil {
		t.Fatalf("writeMetaV2: %v", err)
	}
	if r := h.sup.route(sidEvict, true); r.Error != "" {
		t.Fatalf("route: %s", r.Error)
	}

	hugeText := strings.Repeat("X", 128*1024) // 128 KiB
	hugeRaw, _ := json.Marshal(map[string]any{"system": hugeText, "messages": []string{hugeText}})
	for step := 1; step <= 8; step++ {
		recordSessionDebugPayload(sidEvict, SessionDebugPayload{
			SessionID:  sidEvict,
			TurnIndex:  1,
			Step:       step,
			System:     hugeText,
			Messages:   []provider.Message{{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: hugeText}}}},
			RawPayload: hugeRaw,
			Timestamp:  int64(step),
		})
	}
	recs := getSessionDebugPayloads(sidEvict)
	if len(recs) != maxSessionDebugRecords {
		t.Fatalf("expected %d capped debug records, got %d", maxSessionDebugRecords, len(recs))
	}
	if recs[0].Step != 6 || recs[2].Step != 8 {
		t.Fatalf("expected steps 6..8 retained, got %d..%d", recs[0].Step, recs[2].Step)
	}
	if len(recs[0].System) > maxSessionDebugStringBytes+64 {
		t.Fatalf("expected System string scrubbed to ~16 KiB, got %d bytes", len(recs[0].System))
	}
	if !json.Valid(recs[0].RawPayload) {
		t.Fatalf("scrubbed RawPayload must remain valid JSON")
	}

	// Push 50 extra dummy sessions with large debug payloads and verify global 16 MiB cap holds!
	for i := 0; i < 50; i++ {
		dsid := fmt.Sprintf("sess_dummy_dbg_%d", i)
		for step := 1; step <= 3; step++ {
			recordSessionDebugPayload(dsid, SessionDebugPayload{
				SessionID:  dsid,
				Step:       step,
				System:     hugeText,
				RawPayload: hugeRaw,
				Timestamp:  int64(100 + i),
			})
		}
		t.Cleanup(func() { clearSessionDebug(dsid) })
	}
	sessionDebugMu.RLock()
	totalDbgBytes := totalSessionDebugBytesLocked()
	sessionDebugMu.RUnlock()
	if totalDbgBytes > maxSessionDebugTotalBytes {
		t.Fatalf("global sessionDebugRecords bytes = %d, exceeded cap %d", totalDbgBytes, maxSessionDebugTotalBytes)
	}

	// Passivate via evictIdle(true) -> must clear sessionDebugRecords[sidEvict]!
	h.sup.evictIdle(true)
	if rem := getSessionDebugPayloads(sidEvict); len(rem) != 0 {
		t.Fatalf("expected evictIdle to clear debug records for %s, still have %d", sidEvict, len(rem))
	}

	// 2. Verify purgeSession cleans runners/out/<sid>__*, v2 dir, CAS orphan blob (via GC), epochs, lanes, debug, and BM25 postings!
	sidPurge := "sess_purge_everything"
	rawImg := makeDeterministicPNG(9999, 64, 64)
	extMsgs, err := st.cas.ExternalizeMessageImages([]provider.Message{{
		ID: "pu-1", Role: provider.RoleUser, TurnIndex: 1,
		Content: []provider.Content{
			provider.TextBlock{Text: "unique_purge_bm25_marker_token"},
			provider.ImageBlock{MimeType: "image/png", Data: rawImg},
		},
	}})
	if err != nil {
		t.Fatalf("ExternalizeMessageImages: %v", err)
	}
	blobHash := extMsgs[0].Content[1].(provider.ImageBlock).BlobSHA256
	if _, err := st.v2.AppendTurns(sidPurge, []sessionstore.TurnWrite{{
		TurnSeq:  1,
		Messages: extMsgs,
	}}); err != nil {
		t.Fatalf("AppendTurns: %v", err)
	}
	if err := st.writeMetaV2(sidPurge, recordMeta(&SessionRecord{
		ID: sidPurge, CWD: h.dir, Title: "Purge Target", Status: "idle", UpdatedAt: time.Now().UnixMilli(), TurnSeq: 1,
	})); err != nil {
		t.Fatalf("writeMetaV2: %v", err)
	}
	indexColdSessionIntoSearch(st, h.sup.searchRef(), sidPurge)
	_ = h.sup.searchRef().Flush()

	// Create brain dir + runner output log <rootDir>/runners/out/<sidPurge>__job42__12345.log!
	brainDir := st.ensureBrainDir(sidPurge)
	_ = os.WriteFile(filepath.Join(brainDir, "out.log"), []byte("brain log"), 0o600)
	runnerOutDir := filepath.Join(st.rootDir(), "runners", "out")
	_ = os.MkdirAll(runnerOutDir, 0o700)
	runnerLog := filepath.Join(runnerOutDir, sidPurge+"__job42__12345.log")
	if err := os.WriteFile(runnerLog, []byte("runner output"), 0o600); err != nil {
		t.Fatalf("write runner log: %v", err)
	}

	// Route + send a session command + record debug payload so resident, epochs, lane, and debug all exist!
	h.send(map[string]any{"type": "get_session", "sessionId": sidPurge, "requestId": "pre-purge-get"})
	_ = waitForWSResponse(t, h, "session_data", "pre-purge-get", 5*time.Second)
	recordSessionDebugPayload(sidPurge, SessionDebugPayload{SessionID: sidPurge, Step: 1, System: "debug"})

	// Verify searchable BEFORE purge.
	h.send(map[string]any{"type": "search", "query": "unique_purge_bm25_marker_token", "requestId": "pre-purge-search"})
	preSearch := waitForWSResponse(t, h, "search_results", "pre-purge-search", 5*time.Second)
	if len(preSearch["results"].([]any)) != 1 {
		t.Fatalf("expected 1 BM25 hit before purge, got %+v", preSearch)
	}

	// Execute purgeSession!
	h.admin.purgeSession(sidPurge)

	if _, err := os.Stat(filepath.Join(st.sessionsDir(), sidPurge)); !os.IsNotExist(err) {
		t.Fatalf("v2 session dir still exists after purge: %v", err)
	}
	if _, err := os.Stat(runnerLog); !os.IsNotExist(err) {
		t.Fatalf("runners/out/<sid>__* log still exists after purge: %v", err)
	}
	if _, err := os.Stat(brainDir); !os.IsNotExist(err) {
		t.Fatalf("brain/<sid> dir still exists after purge: %v", err)
	}
	if len(getSessionDebugPayloads(sidPurge)) != 0 {
		t.Fatalf("debug payloads still retained after purge")
	}
	h.sup.mu.Lock()
	_, hasEpoch := h.sup.epochs[sidPurge]
	h.sup.mu.Unlock()
	if hasEpoch {
		t.Fatalf("supervisor epochs[%s] leaked after purge", sidPurge)
	}
	h.server.lanesMu.Lock()
	_, hasLane := h.server.lanes[sidPurge]
	h.server.lanesMu.Unlock()
	if hasLane {
		t.Fatalf("wsServer.lanes[%s] leaked after purge", sidPurge)
	}

	// Verify BM25 postings are tombstoned immediately AND physically stripped on Compact!
	h.send(map[string]any{"type": "search", "query": "unique_purge_bm25_marker_token", "requestId": "post-purge-search"})
	postSearch := waitForWSResponse(t, h, "search_results", "post-purge-search", 5*time.Second)
	if len(postSearch["results"].([]any)) != 0 {
		t.Fatalf("expected 0 BM25 hits after purge, got %+v", postSearch)
	}
	if err := h.sup.searchRef().Compact(context.Background()); err != nil {
		t.Fatalf("search Compact after purge: %v", err)
	}

	// Verify unreferenced CAS blob is reclaimed by RunDiskGC!
	gcStats, err := sessionstore.RunDiskGC(context.Background(), st.rootDir(), h.dir, sessionstore.GCPolicy{
		CASGracePeriod: -1 * time.Second,
		Now:            time.Now().Add(2 * time.Hour),
	})
	if err != nil {
		t.Fatalf("RunDiskGC: %v", err)
	}
	_, _, getErr := st.cas.GetBlob(blobHash)
	if gcStats.DeletedBlobs < 1 || getErr == nil {
		t.Fatalf("expected orphaned CAS blob %s deleted by GC, stats=%+v getErr=%v", blobHash, gcStats, getErr)
	}
}

func TestConcurrentPurgeVsSearchBackfillAndWSSearchNeverResurrects(t *testing.T) {
	h := newWSHarness(t)
	st := newDiskStore(h.dir)
	eng := h.sup.searchRef()
	mw := &maintenanceWorker{
		rootDir: st.rootDir(),
		dataDir: h.dir,
		sup:     h.sup,
		search:  eng,
	}

	const sessionsCount = 6
	sids := make([]string, sessionsCount)
	for i := 0; i < sessionsCount; i++ {
		sid := fmt.Sprintf("sess_purge_search_race_%d", i)
		sids[i] = sid
		turns := make([]sessionstore.TurnWrite, 140)
		for turn := 1; turn <= 140; turn++ {
			turns[turn-1] = sessionstore.TurnWrite{
				TurnSeq:       turn,
				CreatedAtUnix: time.Now().Add(-10 * 24 * time.Hour).Unix(),
				Messages: []provider.Message{
					{
						ID:        fmt.Sprintf("u-%d-%d", i, turn),
						Role:      provider.RoleUser,
						TurnIndex: turn,
						Content:   []provider.Content{provider.TextBlock{Text: fmt.Sprintf("resurrection_audit_sentinel_xyz session %d turn %d", i, turn)}},
					},
					{
						ID:        fmt.Sprintf("a-%d-%d", i, turn),
						Role:      provider.RoleAssistant,
						TurnIndex: turn,
						Content:   []provider.Content{provider.TextBlock{Text: "ok"}},
					},
				},
			}
		}
		if _, err := st.v2.AppendTurns(sid, turns); err != nil {
			t.Fatalf("AppendTurns %s: %v", sid, err)
		}
		if err := st.writeMetaV2(sid, recordMeta(&SessionRecord{
			ID: sid, CWD: h.dir, Title: "Purge Race Session", UpdatedAt: 1000, TurnSeq: 140,
		})); err != nil {
			t.Fatalf("writeMetaV2 %s: %v", sid, err)
		}
	}

	start := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(3 + sessionsCount)
	go func() {
		defer wg.Done()
		<-start
		mw.backfillSearch(context.Background())
	}()
	go func() {
		defer wg.Done()
		<-start
		for r := 0; r < 6; r++ {
			h.server.onSearchWithContext(context.Background(), "resurrection_audit_sentinel_xyz", 30, fmt.Sprintf("race-s-%d", r))
		}
	}()
	go func() {
		defer wg.Done()
		<-start
		for _, sid := range sids {
			_, _, _ = st.v2.ReadTurnRange(sid, 1, 140)
		}
	}()
	purgeErrs := make([]error, sessionsCount)
	for i, sid := range sids {
		go func(idx int, id string) {
			defer wg.Done()
			<-start
			time.Sleep(time.Duration(idx*250) * time.Microsecond)
			purgeErrs[idx] = h.sup.purge(id)
		}(i, sid)
	}
	close(start)
	wg.Wait()
	h.server.waitForLanes()

	for i, err := range purgeErrs {
		if err != nil {
			t.Fatalf("sup.purge(%s) failed: %v", sids[i], err)
		}
		if _, ok := eng.HasSession(sids[i]); ok {
			t.Fatalf("deleted session %s resurrected in BM25F catalog!", sids[i])
		}
		if _, statErr := os.Stat(filepath.Join(st.sessionsDir(), sids[i])); !os.IsNotExist(statErr) {
			t.Fatalf("deleted session %s resurrected on disk: %v", sids[i], statErr)
		}
	}
	if err := eng.Flush(); err != nil {
		t.Fatalf("eng.Flush: %v", err)
	}
	hits, err := eng.Search(context.Background(), searchindex.Query{Text: "resurrection_audit_sentinel_xyz", Limit: 30})
	if err != nil || len(hits) != 0 {
		t.Fatalf("expected 0 BM25 hits after concurrent purge+backfill+search, got %d (err=%v): %+v", len(hits), err, hits)
	}

	// Reopen search engine from disk to verify catalog + .sidx segments contain zero resurrected docs.
	closeSearchEngine(h.dir)
	reopened := getSearchEngine(h.dir)
	if reopened == nil {
		t.Fatal("failed to reopen search engine")
	}
	reHits, err := reopened.Search(context.Background(), searchindex.Query{Text: "resurrection_audit_sentinel_xyz", Limit: 30})
	if err != nil || len(reHits) != 0 {
		t.Fatalf("expected 0 persisted BM25 hits after reopen, got %d (err=%v)", len(reHits), err)
	}
}

func TestEditMidTurnSteeredMessagePreservesBM25MsgIdx(t *testing.T) {
	h := newWSHarness(t)
	st := newDiskStore(h.dir)
	sid := "sess_edit_steered_bm25"

	// Turn 1: messages [0, 1].
	// Turn 2: initial user [2], assistant tool_call [3], tool_result [4], steered user [5], assistant reply [6].
	turns := []sessionstore.TurnWrite{
		{
			TurnSeq: 1,
			Messages: []provider.Message{
				{ID: "t1-u", Role: provider.RoleUser, TurnIndex: 1, Content: []provider.Content{provider.TextBlock{Text: "Initial setup turn"}}},
				{ID: "t1-a", Role: provider.RoleAssistant, TurnIndex: 1, Content: []provider.Content{provider.TextBlock{Text: "Setup complete"}}},
			},
		},
		{
			TurnSeq: 2,
			Messages: []provider.Message{
				{ID: "t2-u0", Role: provider.RoleUser, TurnIndex: 2, Content: []provider.Content{provider.TextBlock{Text: "Run diagnostic tool"}}},
				{
					ID: "t2-a0", Role: provider.RoleAssistant, TurnIndex: 2,
					Content: []provider.Content{provider.ToolCallBlock{ID: "call-diag", Name: "bash", Arguments: json.RawMessage(`{"command":"echo ok"}`)}},
				},
				{
					ID: "t2-tr", Role: provider.RoleTool, TurnIndex: 2,
					Content: []provider.Content{provider.ToolResultBlock{CallID: "call-diag", Content: []provider.Content{provider.TextBlock{Text: "unique_diag_tool_output_marker\n"}}}},
				},
				{ID: "t2-steer", Role: provider.RoleUser, TurnIndex: 2, Content: []provider.Content{provider.TextBlock{Text: "original steered follow-up"}}},
				{ID: "t2-a1", Role: provider.RoleAssistant, TurnIndex: 2, Content: []provider.Content{provider.TextBlock{Text: "Handled follow-up"}}},
			},
		},
	}
	if _, err := st.v2.AppendTurns(sid, turns); err != nil {
		t.Fatalf("AppendTurns: %v", err)
	}
	if err := st.writeMetaV2(sid, recordMeta(&SessionRecord{
		ID: sid, CWD: h.dir, Title: "Steered Edit Session", UpdatedAt: 2000, TurnSeq: 2,
	})); err != nil {
		t.Fatalf("writeMetaV2: %v", err)
	}
	indexColdSessionIntoSearch(st, h.sup.searchRef(), sid)

	routeRes := h.sup.route(sid, true)
	if routeRes.Error != "" {
		t.Fatalf("route(%s): %s", sid, routeRes.Error)
	}
	// Edit the mid-turn steered user message at global/local index 5 (where Turn 2 starts at index 2!).
	// Before the fix, firstMsgIdx was passed as HotBaseMsgIdx+localIdx (5) instead of HotBaseMsgIdx+start (2),
	// shifting UserMsgIdx from 2 -> 5 and ToolMsgIdx from 4 -> 7 (past TotalMsgs=6!).
	reply := make(chan any, 1)
	routeRes.Inbox <- Envelope{
		Payload: editApplyMsg{
			Index: 5,
			Text:  "steered_edit_bm25_exact_idx_token",
			Reply: reply,
		},
		Reply: reply,
	}
	res := (<-reply).(editApplyResult)
	if res.Error != "" {
		t.Fatalf("editApplyMsg(5) failed: %s", res.Error)
	}

	asInt := func(v any) int {
		switch x := v.(type) {
		case int:
			return x
		case *int:
			if x != nil {
				return *x
			}
		case float64:
			return int(x)
		}
		return -1
	}

	h.send(map[string]any{"type": "search", "query": "steered_edit_bm25_exact_idx_token", "requestId": "search-steered-edit"})
	searchEv := waitForWSResponse(t, h, "search_results", "search-steered-edit", 5*time.Second)
	results := searchEv["results"].([]any)
	if len(results) != 1 {
		t.Fatalf("expected 1 search hit for edited steered message, got %+v", searchEv)
	}
	hit := results[0].(map[string]any)
	gotMsgIdx := asInt(hit["messageIdx"])
	if gotMsgIdx != 2 {
		t.Fatalf("Turn 2 UserMsgIdx = %d, want 2 (start of Turn 2, not shifted by localIdx-start=+3; hit=%+v)", gotMsgIdx, hit)
	}

	h.send(map[string]any{"type": "search", "query": "unique_diag_tool_output_marker", "requestId": "search-steered-tool"})
	toolSearchEv := waitForWSResponse(t, h, "search_results", "search-steered-tool", 5*time.Second)
	toolResults := toolSearchEv["results"].([]any)
	if len(toolResults) != 1 {
		t.Fatalf("expected 1 search hit for Turn 2 tool output, got %+v", toolSearchEv)
	}
	toolHit := toolResults[0].(map[string]any)
	gotToolIdx := asInt(toolHit["messageIdx"])
	if gotToolIdx != 3 {
		t.Fatalf("Turn 2 ToolMsgIdx = %d, want exact carrier index 3 (was shifted to 6 >= TotalMsgs=6 before fix; hit=%+v)", gotToolIdx, toolHit)
	}

	// Verify aroundMsgIdx=3 jumps cleanly to the exact tool carrier in Turn 2!
	h.send(map[string]any{"type": "get_history", "sessionId": sid, "aroundMsgIdx": gotToolIdx, "requestId": "hist-steered-3"})
	histEv := waitForWSResponse(t, h, "session_content", "hist-steered-3", 5*time.Second)
	histMeta := histEv["history"].(map[string]any)
	if asInt(histMeta["targetMsgIdx"]) != 3 {
		t.Fatalf("expected targetMsgIdx=3 after steered edit, got %+v", histMeta)
	}
}

func TestGetBlobBoundedQueueRejectsExcessWithHostBusy(t *testing.T) {
	h := newWSHarness(t)
	st := newDiskStore(h.dir)
	rawPNG := makeDeterministicPNG(77, 16, 16)
	extMsgs, err := st.cas.ExternalizeMessageImages([]provider.Message{{
		ID:        "img-m",
		Role:      provider.RoleUser,
		TurnIndex: 1,
		Content:   []provider.Content{provider.ImageBlock{MimeType: "image/png", Data: rawPNG}},
	}})
	if err != nil {
		t.Fatalf("ExternalizeMessageImages: %v", err)
	}
	blobHash := extMsgs[0].Content[0].(provider.ImageBlock).BlobSHA256

	// Saturate all worker tokens on s.sem() so queued get_blob items accumulate in blobQueue.
	sem := h.server.sem()
	held := cap(sem)
	for i := 0; i < held; i++ {
		sem <- struct{}{}
	}
	released := false
	defer func() {
		if !released {
			for i := 0; i < held; i++ {
				<-sem
			}
		}
	}()

	baselineGoroutines := runtime.NumGoroutine()
	const overflow = 8
	totalSent := tuneDispatchQueue + overflow
	for i := 0; i < totalSent; i++ {
		h.send(map[string]any{
			"type":      "get_blob",
			"sha256":    blobHash,
			"sessionId": "sess_blob_burst",
			"requestId": fmt.Sprintf("blob-burst-%d", i),
		})
	}

	// Excess frames beyond tuneDispatchQueue must be rejected immediately with "Host busy"
	// while sem is still saturated, without spawning unbounded goroutines!
	for i := tuneDispatchQueue; i < totalSent; i++ {
		reqID := fmt.Sprintf("blob-burst-%d", i)
		ev := waitForWSResponse(t, h, "blob_data", reqID, 5*time.Second)
		if ev["error"] != "Host busy" || ev["sha256"] != blobHash || ev["sessionId"] != "sess_blob_burst" {
			t.Fatalf("expected Host busy blob_data for %s, got %+v", reqID, ev)
		}
	}
	if gotBusy := h.server.blobBusy.Load(); gotBusy != overflow {
		t.Fatalf("blobBusy counter = %d, want %d", gotBusy, overflow)
	}
	if gDelta := runtime.NumGoroutine() - baselineGoroutines; gDelta > 16 {
		t.Fatalf("unbounded goroutine growth during get_blob burst: delta=%d (want <= 16)", gDelta)
	}

	// Release sem tokens and verify all tuneDispatchQueue admitted requests succeed!
	released = true
	for i := 0; i < held; i++ {
		<-sem
	}
	for i := 0; i < tuneDispatchQueue; i++ {
		reqID := fmt.Sprintf("blob-burst-%d", i)
		ev := waitForWSResponse(t, h, "blob_data", reqID, 5*time.Second)
		if ev["error"] != nil || ev["mediaType"] != "image/png" {
			t.Fatalf("admitted request %s failed: %+v", reqID, ev)
		}
	}
	h.server.waitForLanes()
}
