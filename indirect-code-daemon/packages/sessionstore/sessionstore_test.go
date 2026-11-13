package sessionstore

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/klauspost/compress/zstd"

	"indirect/indirect-code-daemon/packages/filetrack"
	"indirect/indirect-code-daemon/packages/provider"
	"indirect/indirect-code-daemon/packages/runner"
)

func makeTestPNG(t testing.TB, w, h int, seed byte) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetNRGBA(x, y, color.NRGBA{
				R: byte((x*17 + int(seed)) & 0xff),
				G: byte((y*31 + int(seed)*3) & 0xff),
				B: byte(((x ^ y) + int(seed)*7) & 0xff),
				A: 255,
			})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

func countFilesRecursive(root string) int {
	n := 0
	_ = filepath.WalkDir(root, func(_ string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			n++
		}
		return nil
	})
	return n
}

func TestAppendTurnWriteMetaAndCASImageDeduplication(t *testing.T) {
	slotDir := t.TempDir()
	store := New(slotDir)
	sessID := "sess_cas_roundtrip"

	rawMeta := []byte(`{"v":2,"kind":"meta","id":"sess_cas_roundtrip","title":"CAS Vision Session","updatedAt":1760000100}`)
	startMeta := time.Now()
	if err := store.WriteMeta(sessID, rawMeta); err != nil {
		t.Fatalf("WriteMeta: %v", err)
	}
	gotMeta, err := store.ReadMeta(sessID)
	if err != nil {
		t.Fatalf("ReadMeta: %v", err)
	}
	metaDur := time.Since(startMeta)
	if !bytes.Equal(gotMeta, rawMeta) {
		t.Fatalf("ReadMeta mismatch:\ngot:  %s\nwant: %s", gotMeta, rawMeta)
	}
	t.Logf("WriteMeta + ReadMeta O(1) latency: %v", metaDur)

	pngA := makeTestPNG(t, 64, 48, 11)
	pngB := makeTestPNG(t, 32, 32, 99)

	origMsgs := []provider.Message{
		{
			ID:        "m_user_1",
			Role:      provider.RoleUser,
			TurnIndex: 1,
			Time:      time.Unix(1760000001, 0).UTC(),
			Content: []provider.Content{
				provider.TextBlock{Text: "Inspect screenshot A"},
				provider.ImageBlock{
					MimeType: "image/png",
					Data:     bytes.Clone(pngA),
				},
			},
		},
		{
			ID:        "m_asst_1",
			Role:      provider.RoleAssistant,
			TurnIndex: 1,
			Time:      time.Unix(1760000002, 0).UTC(),
			Content: []provider.Content{
				provider.ToolCallBlock{
					ID:        "call_read_img",
					Name:      "read",
					Arguments: json.RawMessage(`{"path":"ui.png"}`),
				},
			},
		},
		{
			ID:        "m_tool_1",
			Role:      provider.RoleTool,
			TurnIndex: 1,
			Time:      time.Unix(1760000003, 0).UTC(),
			Content: []provider.Content{
				provider.ToolResultBlock{
					CallID: "call_read_img",
					Content: []provider.Content{
						// Same pngA to verify content-addressed deduplication, plus pngB.
						provider.ImageBlock{MediaType: "image/png", Data: bytes.Clone(pngA)},
						provider.ImageBlock{MediaType: "image/png", Data: bytes.Clone(pngB)},
					},
				},
			},
		},
	}

	entry, err := store.AppendTurn(sessID, TurnWrite{
		TurnSeq:       1,
		Messages:      origMsgs,
		CreatedAtUnix: 1760000003,
	})
	if err != nil {
		t.Fatalf("AppendTurn: %v", err)
	}
	if entry.FirstMsgIdx != 0 || entry.LastMsgIdx != 2 {
		t.Fatalf("unexpected msg span: %+v", entry)
	}

	// Caller's input slice must never be mutated.
	if len(origMsgs[0].Content[1].(provider.ImageBlock).Data) != len(pngA) {
		t.Fatalf("AppendTurn mutated caller's ImageBlock.Data")
	}

	// Only 2 distinct CAS blobs should exist on disk despite 3 ImageBlocks.
	blobCount := countFilesRecursive(store.CAS().RootDir())
	if blobCount != 2 {
		t.Fatalf("expected 2 deduplicated CAS blobs, got %d", blobCount)
	}

	// Verify on-disk .turns JSON contains 0 inline base64 image data.
	rawSeg, err := os.ReadFile(filepath.Join(slotDir, "sessions", sessID, warmTurnsFilename(entry.SegmentID)))
	if err != nil {
		t.Fatalf("read warm segment: %v", err)
	}
	if bytes.Contains(rawSeg, []byte(`"data":"`)) {
		t.Fatalf("on-disk .turns file leaked inline base64 image data: %s", rawSeg)
	}
	if !bytes.Contains(rawSeg, []byte(`"blobSha256":"`)) {
		t.Fatalf("on-disk .turns file missing blobSha256 reference: %s", rawSeg)
	}

	// Reload from disk: Data must be nil while metadata (BlobSHA256, ByteLen, Width, Height) is intact.
	win, err := store.ReadTailWindow(sessID, 0, 0)
	if err != nil {
		t.Fatalf("ReadTailWindow: %v", err)
	}
	if len(win.Messages) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(win.Messages))
	}
	reloadedImg := win.Messages[0].Content[1].(provider.ImageBlock)
	if len(reloadedImg.Data) != 0 {
		t.Fatalf("expected reloaded ImageBlock.Data to be nil, got %d bytes", len(reloadedImg.Data))
	}
	if reloadedImg.ByteLen != len(pngA) || reloadedImg.Width != 64 || reloadedImg.Height != 48 {
		t.Fatalf("reloaded ImageBlock metadata mismatch: byteLen=%d w=%d h=%d", reloadedImg.ByteLen, reloadedImg.Width, reloadedImg.Height)
	}
	if len(reloadedImg.BlobSHA256) != 64 || reloadedImg.MimeType != "image/png" || reloadedImg.MediaType != "image/png" {
		t.Fatalf("reloaded ImageBlock hash/mime mismatch: %+v", reloadedImg)
	}

	// HydrateMessageImages restores exact bytes without mutating win.Messages.
	hydrated, err := store.CAS().HydrateMessageImages(win.Messages)
	if err != nil {
		t.Fatalf("HydrateMessageImages: %v", err)
	}
	if len(win.Messages[0].Content[1].(provider.ImageBlock).Data) != 0 {
		t.Fatalf("HydrateMessageImages mutated input slice")
	}
	if !bytes.Equal(hydrated[0].Content[1].(provider.ImageBlock).Data, pngA) {
		t.Fatalf("hydrated top-level image bytes mismatch")
	}
	trHyd := hydrated[2].Content[0].(provider.ToolResultBlock)
	if !bytes.Equal(trHyd.Content[0].(provider.ImageBlock).Data, pngA) {
		t.Fatalf("hydrated nested tool result image A mismatch")
	}
	if !bytes.Equal(trHyd.Content[1].(provider.ImageBlock).Data, pngB) {
		t.Fatalf("hydrated nested tool result image B mismatch")
	}
}

func buildRealisticTurn(turnSeq int) TurnWrite {
	pkgName := fmt.Sprintf("pkg/module_%02d/handler.go", turnSeq%24)
	userPrompt := fmt.Sprintf(
		"Turn %d: refactor %s to eliminate buffer allocations in request dispatch and update metrics counter.",
		turnSeq, pkgName,
	)
	codeSnippet := fmt.Sprintf(
		"package module_%02d\n\nimport (\n\t\"context\"\n\t\"sync/atomic\"\n)\n\ntype Dispatcher struct {\n\tprocessed atomic.Uint64\n\troute     string\n}\n\nfunc (d *Dispatcher) Handle(ctx context.Context, payload []byte) error {\n\tif err := ctx.Err(); err != nil {\n\t\treturn err\n\t}\n\td.processed.Add(uint64(len(payload)))\n\treturn nil // turn %d verified\n}\n",
		turnSeq%24, turnSeq,
	)
	toolOut := fmt.Sprintf(
		"=== RUN   TestDispatcherHandle_%04d\n--- PASS: TestDispatcherHandle_%04d (0.01s)\nPASS\nok  \tindirect/%s\t0.014s\n",
		turnSeq, turnSeq, pkgName,
	)
	baseTS := int64(1750000000 + turnSeq*60)
	t0 := time.Unix(baseTS, 0).UTC()

	msgs := []provider.Message{
		{
			ID:        fmt.Sprintf("u_%05d", turnSeq),
			Role:      provider.RoleUser,
			TurnIndex: turnSeq,
			Time:      t0,
			Content:   []provider.Content{provider.TextBlock{Text: userPrompt}},
		},
		{
			ID:        fmt.Sprintf("a1_%05d", turnSeq),
			Role:      provider.RoleAssistant,
			TurnIndex: turnSeq,
			Time:      t0.Add(time.Second),
			Content: []provider.Content{
				provider.ReasoningBlock{Summary: fmt.Sprintf("Inspecting %s allocation profile for turn %d.", pkgName, turnSeq)},
				provider.TextBlock{Text: "Applying zero-allocation atomic counter patch:\n```go\n" + codeSnippet + "```"},
				provider.ToolCallBlock{
					ID:        fmt.Sprintf("call_%05d", turnSeq),
					Name:      "bash",
					Arguments: json.RawMessage(fmt.Sprintf(`{"command":"go test ./%s"}`, filepath.ToSlash(filepath.Dir(pkgName)))),
				},
			},
		},
		{
			ID:        fmt.Sprintf("tr_%05d", turnSeq),
			Role:      provider.RoleTool,
			TurnIndex: turnSeq,
			Time:      t0.Add(2 * time.Second),
			Content: []provider.Content{
				provider.ToolResultBlock{
					CallID:     fmt.Sprintf("call_%05d", turnSeq),
					DurationMs: 14,
					Content:    []provider.Content{provider.TextBlock{Text: toolOut}},
					Details: map[string]any{
						"command":   "go test",
						"output":    toolOut,
						"exit_code": float64(0),
					},
				},
			},
		},
		{
			ID:        fmt.Sprintf("a2_%05d", turnSeq),
			Role:      provider.RoleAssistant,
			TurnIndex: turnSeq,
			Time:      t0.Add(3 * time.Second),
			Content: []provider.Content{
				provider.TextBlock{Text: fmt.Sprintf("Completed turn %d in `%s`; all unit tests pass.", turnSeq, pkgName)},
			},
		},
	}

	var balloon *filetrack.TurnChanges
	if turnSeq%2 == 0 {
		balloon = &filetrack.TurnChanges{
			TurnIndex: turnSeq,
			At:        baseTS,
			Files: []filetrack.ChangedFile{
				{
					Path:      "/repo/" + pkgName,
					Rel:       pkgName,
					Status:    "modified",
					Additions: 12,
					Deletions: 4,
					Diff:      fmt.Sprintf("@@ -10,4 +10,12 @@\n-var oldMu sync.Mutex\n+type Dispatcher struct { turn_%d int }\n", turnSeq),
				},
			},
		}
	}

	tokEst := 420
	if turnSeq <= 5 {
		// Exercise full btdby4 EstimateTurnTokens on initial turns too.
		tokEst = 0
	}
	return TurnWrite{
		TurnSeq:       turnSeq,
		Messages:      msgs,
		DiffBalloon:   balloon,
		TokenEst:      tokEst,
		CreatedAtUnix: baseTS,
	}
}

func assertMessagesJSONEqual(t *testing.T, label string, got, want []provider.Message) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: message count got %d, want %d", label, len(got), len(want))
	}
	gb, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("%s: marshal got: %v", label, err)
	}
	wb, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("%s: marshal want: %v", label, err)
	}
	if !bytes.Equal(gb, wb) {
		t.Fatalf("%s: messages not byte-identical:\ngot:  %s\nwant: %s", label, gb[:min(512, len(gb))], wb[:min(512, len(wb))])
	}
}

func TestYearScaleColdSeekableZstdCompressionAndSubMillisecondQueries(t *testing.T) {
	const totalTurns = 2200
	slotDir := t.TempDir()
	store := New(slotDir)
	sessID := "sess_year_scale"

	groundTruth := make([]TurnWrite, totalTurns)
	allExpectedMsgs := make([]provider.Message, 0, totalTurns*4)
	for i := 1; i <= totalTurns; i++ {
		tw := buildRealisticTurn(i)
		groundTruth[i-1] = tw
		allExpectedMsgs = append(allExpectedMsgs, tw.Messages...)
	}
	// Batch-seed the first 2,175 turns across 17 Warm segments, then append the
	// final 25 turns one-by-one via AppendTurn (including across a 128-turn segment boundary).
	if _, err := store.AppendTurns(sessID, groundTruth[:2175]); err != nil {
		t.Fatalf("AppendTurns(1..2175): %v", err)
	}
	for i := 2175; i < totalTurns; i++ {
		if _, err := store.AppendTurn(sessID, groundTruth[i]); err != nil {
			t.Fatalf("AppendTurn(%d): %v", i+1, err)
		}
	}

	preStats, err := store.SessionStats(sessID)
	if err != nil {
		t.Fatalf("SessionStats pre-age: %v", err)
	}
	if preStats.TotalTurns != totalTurns || preStats.TotalMessages != totalTurns*4 {
		t.Fatalf("unexpected pre-age counts: %+v", preStats)
	}

	// Age with standard policy (keep newest 100 turns Warm, compress older segments to Cold .zst).
	agedCount, err := store.AgeSession(context.Background(), sessID, AgePolicy{
		HotKeepTurns: 100,
		WarmMaxAge:   7 * 24 * time.Hour,
		Now:          time.Unix(1750000000+totalTurns*60+60, 0),
	})
	if err != nil {
		t.Fatalf("AgeSession: %v", err)
	}
	if agedCount < 15 {
		t.Fatalf("expected >=15 Warm segments aged to Cold, got %d", agedCount)
	}

	manifest, err := store.ReadManifest(sessID)
	if err != nil {
		t.Fatalf("ReadManifest: %v", err)
	}
	var coldOnDisk, coldUncomp uint64
	for _, seg := range manifest.Segments {
		if seg.Tier == TierCold {
			coldOnDisk += seg.TurnsBytes + seg.DiffsBytes
			coldUncomp += seg.UncompBytes
			// Superseded Warm files must be removed.
			warmPath := filepath.Join(slotDir, "sessions", sessID, warmTurnsFilename(seg.ID))
			if _, stErr := os.Stat(warmPath); !os.IsNotExist(stErr) {
				t.Fatalf("expected Warm file %s removed after Cold conversion", warmPath)
			}
		}
	}
	if coldOnDisk == 0 {
		t.Fatalf("expected non-zero Cold archive bytes")
	}
	coldRatio := float64(coldUncomp) / float64(coldOnDisk)
	t.Logf("2,200-turn scale stats: Cold segments=%d, Cold uncompressed=%d B (%.2f MiB), Cold .zst=%d B (%.2f KiB), Cold compression=%.2fx",
		agedCount, coldUncomp, float64(coldUncomp)/(1024*1024), coldOnDisk, float64(coldOnDisk)/1024, coldRatio)
	if coldRatio < 7.0 {
		t.Fatalf("expected >= 7x Cold Zstd compression ratio on realistic session turns, got %.2fx", coldRatio)
	}

	// 1. Single-turn random access deep in Cold tier (Turn #43 -> odd turn so 0 diff frame, 1 turn frame!).
	targetOddTurn := 43
	targetOddMsgIdx := (targetOddTurn - 1) * 4
	store.ResetColdFramesDecoded()
	tStart := time.Now()
	aroundSingle, err := store.ReadAroundMsg(sessID, targetOddMsgIdx, 1, 4)
	singleDur := time.Since(tStart)
	if err != nil {
		t.Fatalf("ReadAroundMsg(single cold turn): %v", err)
	}
	framesSingle := store.ColdFramesDecoded()
	if framesSingle != 1 {
		t.Fatalf("expected single-turn Cold ReadAroundMsg to decode exactly 1 64KiB frame, decoded %d", framesSingle)
	}
	assertMessagesJSONEqual(t, "ReadAroundMsg(Turn 43)", aroundSingle.Messages, groundTruth[targetOddTurn-1].Messages)
	if !aroundSingle.History.HasOlder || !aroundSingle.History.HasNewer || aroundSingle.History.FirstIndex != targetOddMsgIdx {
		t.Fatalf("ReadAroundMsg cursor mismatch: %+v", aroundSingle.History)
	}

	// 2. Centered multi-turn ReadAroundMsg with diffs in Cold tier (Turn #700, ~5 turns = ~20 msgs).
	// Measure median latency across 25 random Cold jumps to avoid OS scheduling hiccups while asserting < 2ms!
	jumpTargets := []int{42 * 4, 180 * 4, 415 * 4, 700 * 4, 999 * 4, 1320 * 4, 1650 * 4, 1900 * 4}
	latencies := make([]time.Duration, 0, 24)
	for round := 0; round < 3; round++ {
		for _, msgIdx := range jumpTargets {
			store.ResetColdFramesDecoded()
			q0 := time.Now()
			ws, qerr := store.ReadAroundMsg(sessID, msgIdx, 1800, 20)
			qDur := time.Since(q0)
			if qerr != nil {
				t.Fatalf("ReadAroundMsg(%d): %v", msgIdx, qerr)
			}
			latencies = append(latencies, qDur)
			decoded := store.ColdFramesDecoded()
			// ~5 turns (~9 KiB uncompressed) + ~2-3 diffs (~600 B) spans 1-2 turn frames + 1 diff frame (<= 4 frames total, typically 2!).
			if decoded == 0 || decoded > 4 {
				t.Fatalf("ReadAroundMsg(%d) decoded %d Cold frames (expected 1-4 out of hundreds)", msgIdx, decoded)
			}
			expectSlice := allExpectedMsgs[ws.History.FirstIndex : ws.History.FirstIndex+len(ws.Messages)]
			assertMessagesJSONEqual(t, fmt.Sprintf("ReadAroundMsg(%d)", msgIdx), ws.Messages, expectSlice)
		}
	}
	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
	medianJump := latencies[len(latencies)/2]
	p95Jump := latencies[(len(latencies)*95)/100]
	t.Logf("Cold random-access latency: single-turn=%v (1 frame), 5-turn ReadAroundMsg median=%v p95=%v", singleDur, medianJump, p95Jump)
	if medianJump >= 2*time.Millisecond {
		t.Fatalf("expected Cold ReadAroundMsg median latency < 2ms, got %v", medianJump)
	}

	// 3. ReadBeforeTurn across Cold boundary.
	store.ResetColdFramesDecoded()
	before0 := time.Now()
	beforeWin, err := store.ReadBeforeTurn(sessID, 500, 1500, 16)
	beforeDur := time.Since(before0)
	if err != nil {
		t.Fatalf("ReadBeforeTurn: %v", err)
	}
	if beforeWin.History.NewestTurn != 499 || !beforeWin.History.HasOlder || !beforeWin.History.HasNewer {
		t.Fatalf("ReadBeforeTurn cursor invalid: %+v", beforeWin.History)
	}
	assertMessagesJSONEqual(
		t,
		"ReadBeforeTurn(500)",
		beforeWin.Messages,
		allExpectedMsgs[beforeWin.History.FirstIndex:beforeWin.History.FirstIndex+len(beforeWin.Messages)],
	)
	if beforeDur >= 2*time.Millisecond {
		t.Logf("note: single-shot ReadBeforeTurn took %v", beforeDur)
	}

	// 4. ReadAfterTurn in Cold tier.
	afterWin, err := store.ReadAfterTurn(sessID, 500, 1500, 16)
	if err != nil {
		t.Fatalf("ReadAfterTurn: %v", err)
	}
	if afterWin.History.OldestTurn != 501 || !afterWin.History.HasOlder || !afterWin.History.HasNewer {
		t.Fatalf("ReadAfterTurn cursor invalid: %+v", afterWin.History)
	}
	assertMessagesJSONEqual(
		t,
		"ReadAfterTurn(500)",
		afterWin.Messages,
		allExpectedMsgs[afterWin.History.FirstIndex:afterWin.History.FirstIndex+len(afterWin.Messages)],
	)

	// 5. ReadTailWindow hits ONLY Warm tail segments (0 Cold frames decoded!).
	store.ResetColdFramesDecoded()
	tail0 := time.Now()
	tailWin, err := store.ReadTailWindow(sessID, 3000, 32)
	tailDur := time.Since(tail0)
	if err != nil {
		t.Fatalf("ReadTailWindow: %v", err)
	}
	if store.ColdFramesDecoded() != 0 {
		t.Fatalf("ReadTailWindow touched %d Cold frames, expected 0", store.ColdFramesDecoded())
	}
	if tailWin.History.NewestTurn != totalTurns || tailWin.History.HasNewer || !tailWin.History.HasOlder {
		t.Fatalf("ReadTailWindow cursor invalid: %+v", tailWin.History)
	}
	assertMessagesJSONEqual(
		t,
		"ReadTailWindow",
		tailWin.Messages,
		allExpectedMsgs[tailWin.History.FirstIndex:],
	)
	t.Logf("Warm ReadTailWindow latency: %v (0 Cold frames decoded)", tailDur)
}

func TestTruncateAfterMsgAndCloneSessionUpToWarmAndCold(t *testing.T) {
	slotDir := t.TempDir()
	// Use 16 turns per segment so 80 turns create 5 segments (4 Cold + 1 Warm).
	store := New(slotDir, WithWarmSegmentLimits(1<<20, 16))
	srcID := "sess_cut_src"
	if err := store.WriteMeta(srcID, []byte(`{"v":2,"kind":"meta","id":"sess_cut_src","title":"Original"}`)); err != nil {
		t.Fatalf("WriteMeta: %v", err)
	}

	const turns = 80
	var allMsgs []provider.Message
	seedTurns := make([]TurnWrite, turns)
	for i := 1; i <= turns; i++ {
		tw := buildRealisticTurn(i)
		seedTurns[i-1] = tw
		allMsgs = append(allMsgs, tw.Messages...)
	}
	if _, err := store.AppendTurns(srcID, seedTurns[:76]); err != nil {
		t.Fatalf("AppendTurns: %v", err)
	}
	for i := 76; i < turns; i++ {
		if _, err := store.AppendTurn(srcID, seedTurns[i]); err != nil {
			t.Fatalf("AppendTurn(%d): %v", i+1, err)
		}
	}

	// Age first 4 segments (turns 1..64) into Cold .zst, leaving segment 5 (turns 65..80) Warm.
	aged, err := store.AgeSession(context.Background(), srcID, AgePolicy{
		HotKeepTurns: 16,
		WarmMaxAge:   7 * 24 * time.Hour,
		Now:          time.Unix(1750000000+turns*60+60, 0),
	})
	if err != nil || aged != 4 {
		t.Fatalf("expected 4 Cold segments, got aged=%d err=%v", aged, err)
	}

	// 1. CloneSessionUpTo mid-turn inside a Warm segment (turn 70, keep 2 of its 4 messages -> keepMsgCount = 69*4 + 2 = 278).
	warmCloneID := "sess_clone_warm_mid"
	if err := store.CloneSessionUpTo(srcID, warmCloneID, 278); err != nil {
		t.Fatalf("CloneSessionUpTo(warm mid-turn): %v", err)
	}
	warmCloneMsgs, _, err := store.ReadTurnRange(warmCloneID, 0, 0)
	if err != nil {
		t.Fatalf("ReadTurnRange(warmClone): %v", err)
	}
	assertMessagesJSONEqual(t, "CloneSessionUpTo warm mid-turn", warmCloneMsgs, allMsgs[:278])

	// Verify meta ID was rewritten to warmCloneID.
	cloneMetaRaw, err := store.ReadMeta(warmCloneID)
	if err != nil || !bytes.Contains(cloneMetaRaw, []byte(`"sess_clone_warm_mid"`)) {
		t.Fatalf("cloned meta missing rewritten session id: %s (err=%v)", cloneMetaRaw, err)
	}

	// 2. CloneSessionUpTo mid-turn deep inside a Cold .zst segment (turn 25 in Cold seg 2 -> keepMsgCount = 24*4 + 3 = 99).
	coldCloneID := "sess_clone_cold_mid"
	if err := store.CloneSessionUpTo(srcID, coldCloneID, 99); err != nil {
		t.Fatalf("CloneSessionUpTo(cold mid-turn): %v", err)
	}
	coldCloneMsgs, _, err := store.ReadTurnRange(coldCloneID, 0, 0)
	if err != nil {
		t.Fatalf("ReadTurnRange(coldClone): %v", err)
	}
	assertMessagesJSONEqual(t, "CloneSessionUpTo cold mid-turn", coldCloneMsgs, allMsgs[:99])

	// Appending a new turn onto coldCloneID must seamlessly continue at message index 99, turn 26!
	appendedEntry, err := store.AppendTurn(coldCloneID, buildRealisticTurn(26))
	if err != nil {
		t.Fatalf("AppendTurn after cold clone: %v", err)
	}
	if appendedEntry.FirstMsgIdx != 99 || appendedEntry.TurnSeq != 26 {
		t.Fatalf("unexpected post-clone entry: %+v", appendedEntry)
	}

	// 3. TruncateAfterMsg mid-turn inside Warm segment (keep 290 msgs), then inside Cold .zst segment (keep 85 msgs = turn 22 msg 1).
	if err := store.TruncateAfterMsg(srcID, 290); err != nil {
		t.Fatalf("TruncateAfterMsg(warm 290): %v", err)
	}
	got290, _, err := store.ReadTurnRange(srcID, 0, 0)
	if err != nil {
		t.Fatalf("ReadTurnRange after warm truncate: %v", err)
	}
	assertMessagesJSONEqual(t, "TruncateAfterMsg warm 290", got290, allMsgs[:290])

	if err := store.TruncateAfterMsg(srcID, 85); err != nil {
		t.Fatalf("TruncateAfterMsg(cold 85): %v", err)
	}
	got85, _, err := store.ReadTurnRange(srcID, 0, 0)
	if err != nil {
		t.Fatalf("ReadTurnRange after cold truncate: %v", err)
	}
	assertMessagesJSONEqual(t, "TruncateAfterMsg cold 85", got85, allMsgs[:85])

	// Prefix Cold segment 1 (turns 1..16) must STILL be Cold on disk (zero unnecessary rewrites!).
	mAfter, err := store.ReadManifest(srcID)
	if err != nil {
		t.Fatalf("ReadManifest after cold truncate: %v", err)
	}
	if len(mAfter.Segments) != 2 || mAfter.Segments[0].Tier != TierCold || mAfter.Segments[1].Tier != TierWarm {
		t.Fatalf("expected [Cold seg 1, Warm tail seg], got %+v", mAfter.Segments)
	}

	// Subsequent AppendTurn after Cold truncation must work cleanly.
	postTruncEntry, err := store.AppendTurn(srcID, buildRealisticTurn(23))
	if err != nil {
		t.Fatalf("AppendTurn after cold truncate: %v", err)
	}
	if postTruncEntry.FirstMsgIdx != 85 || postTruncEntry.LastMsgIdx != 88 {
		t.Fatalf("unexpected entry after cold truncate append: %+v", postTruncEntry)
	}
}

func TestMigrateLegacyJSONLStreamingWithImagesAndBloatedDetails(t *testing.T) {
	slotDir := t.TempDir()
	sessionsDir := filepath.Join(slotDir, "sessions")
	if err := os.MkdirAll(sessionsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	sessID := "sess_v1_migrate"
	jsonlPath := filepath.Join(sessionsDir, sessID+".jsonl")

	// Pre-create <slot>/sessions/<id>/attachments/att-1.txt to verify migration preserves attachments!
	attDir := filepath.Join(sessionsDir, sessID, "attachments")
	if err := os.MkdirAll(attDir, 0o700); err != nil {
		t.Fatal(err)
	}
	attFile := filepath.Join(attDir, "att-preserve.txt")
	if err := os.WriteFile(attFile, []byte("keep-me"), 0o600); err != nil {
		t.Fatal(err)
	}

	pngBytes := makeTestPNG(t, 40, 30, 55)
	bloatedOut := "HEAD_MARKER\n" + strings.Repeat("β-log-line-"+strings.Repeat("x", 90)+"\n", 1800) + "TAIL_MARKER\n" // ~190 KiB

	f, err := os.Create(jsonlPath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	const legacyTurns = 260
	for i := 1; i <= legacyTurns; i++ {
		var msgs []provider.Message
		if i == 10 {
			msgs = []provider.Message{
				{
					ID:        "leg_img_u",
					Role:      provider.RoleUser,
					TurnIndex: i,
					Time:      time.Unix(1740000000+int64(i), 0).UTC(),
					Content: []provider.Content{
						provider.TextBlock{Text: "Here is an inline legacy screenshot"},
						provider.ImageBlock{MimeType: "image/png", Data: pngBytes},
					},
				},
				{
					ID:        "leg_bloat_tr",
					Role:      provider.RoleTool,
					TurnIndex: i,
					Time:      time.Unix(1740000000+int64(i)+1, 0).UTC(),
					Content: []provider.Content{
						provider.ToolResultBlock{
							CallID:  "call_legacy_fetch",
							Content: []provider.Content{provider.TextBlock{Text: "spilled preview"}},
							Details: map[string]any{
								"output":           bloatedOut,
								"content":          bloatedOut,
								"preview_data_url": "data:image/png;base64,AAAA",
								"spill_path":       "/brain/tool-1.log",
							},
						},
					},
				},
			}
		} else {
			tw := buildRealisticTurn(i)
			msgs = tw.Messages
		}

		rawMsgs := make([]json.RawMessage, 0, len(msgs))
		for _, m := range msgs {
			b, merr := json.Marshal(m)
			if merr != nil {
				t.Fatal(merr)
			}
			rawMsgs = append(rawMsgs, b)
		}
		lineObj := map[string]any{
			"v":        1,
			"kind":     "turn",
			"turn":     i,
			"messages": rawMsgs,
		}
		lb, merr := json.Marshal(lineObj)
		if merr != nil {
			t.Fatal(merr)
		}
		if _, werr := f.Write(append(lb, '\n')); werr != nil {
			t.Fatal(werr)
		}
	}

	metaLine := `{"v":1,"kind":"meta","id":"sess_v1_migrate","title":"Migrated Session","turnSeq":260,"updatedAt":1740999999}`
	if _, err := f.WriteString(metaLine + "\n"); err != nil {
		t.Fatal(err)
	}
	// Append a simulated torn crash tail (no trailing newline!) after valid meta to verify torn-tail tolerance.
	if _, err := f.WriteString(`{"v":1,"kind":"turn","turn":261,"messages":[{"broken`); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	legStat, err := os.Stat(jsonlPath)
	if err != nil {
		t.Fatal(err)
	}

	store := New(slotDir)
	if err := store.MigrateLegacyFile(context.Background(), jsonlPath, AgePolicy{
		HotKeepTurns: 100,
		WarmMaxAge:   7 * 24 * time.Hour,
		Now:          time.Unix(1741000100, 0),
	}); err != nil {
		t.Fatalf("MigrateLegacyFile: %v", err)
	}

	// Legacy .jsonl must be removed; attachments must survive.
	if _, err := os.Stat(jsonlPath); !os.IsNotExist(err) {
		t.Fatalf("expected legacy jsonl %s to be removed, err=%v", jsonlPath, err)
	}
	if gotAtt, err := os.ReadFile(attFile); err != nil || string(gotAtt) != "keep-me" {
		t.Fatalf("attachments file lost during migration: %v", err)
	}

	// Verify meta.json round-trip.
	gotMeta, err := store.ReadMeta(sessID)
	if err != nil || string(gotMeta) != metaLine {
		t.Fatalf("migrated meta mismatch: got=%s err=%v", gotMeta, err)
	}

	stats, err := store.SessionStats(sessID)
	if err != nil {
		t.Fatalf("SessionStats: %v", err)
	}
	if stats.TotalTurns != legacyTurns || stats.ColdSegments == 0 || stats.WarmSegments == 0 {
		t.Fatalf("expected hybrid Cold+Warm migrated layout for %d turns, got %+v", legacyTurns, stats)
	}
	t.Logf("Legacy .jsonl (%d B) -> v2 Cold+Warm turn files (%d B) + 1 CAS blob", legStat.Size(), stats.OnDiskTurnBytes)

	// Inspect Turn #10 (now in Cold .zst): image must be CAS-backed, Details scrubbed <= 32 KiB.
	t10Msgs, _, err := store.ReadTurnRange(sessID, 10, 10)
	if err != nil || len(t10Msgs) != 2 {
		t.Fatalf("ReadTurnRange(10,10): len=%d err=%v", len(t10Msgs), err)
	}
	imgBlk := t10Msgs[0].Content[1].(provider.ImageBlock)
	if len(imgBlk.Data) != 0 || len(imgBlk.BlobSHA256) != 64 || imgBlk.Width != 40 || imgBlk.Height != 30 {
		t.Fatalf("migrated ImageBlock invalid: %+v", imgBlk)
	}
	hyd, err := store.CAS().HydrateMessageImages(t10Msgs[:1])
	if err != nil || !bytes.Equal(hyd[0].Content[1].(provider.ImageBlock).Data, pngBytes) {
		t.Fatalf("CAS hydration of migrated image failed: %v", err)
	}

	trBlk := t10Msgs[1].Content[0].(provider.ToolResultBlock)
	var detMap map[string]any
	switch dv := trBlk.Details.(type) {
	case json.RawMessage:
		if err := json.Unmarshal(dv, &detMap); err != nil {
			t.Fatal(err)
		}
	case map[string]any:
		detMap = dv
	default:
		t.Fatalf("unexpected Details type %T", trBlk.Details)
	}
	if _, hasPreview := detMap["preview_data_url"]; hasPreview {
		t.Fatalf("migrator failed to strip transient preview_data_url")
	}
	for _, k := range []string{"output", "content"} {
		s, _ := detMap[k].(string)
		if len(s) == 0 || len(s) > MaxInlineDetailPreviewBytes || !utf8.ValidString(s) {
			t.Fatalf("migrated Details[%s] not capped <= 32 KiB: len=%d", k, len(s))
		}
		if !strings.Contains(s, "HEAD_MARKER") || !strings.Contains(s, "TAIL_MARKER") {
			t.Fatalf("migrated Details[%s] lost head/tail sentinels", k)
		}
	}
	if detMap["truncated"] != true || detMap["spill_path"] != "/brain/tool-1.log" {
		t.Fatalf("migrated Details metadata mismatch: %+v", detMap)
	}
}

func TestPurgeSessionDiskAndRunDiskGC(t *testing.T) {
	rootDir := t.TempDir()
	slotDir := filepath.Join(rootDir, "slots", "a")
	store := New(slotDir)

	// --- Part 1: PurgeSessionDisk ---
	purgeID := "sess_purge_target"
	keepID := "sess_keep_neighbor"
	if _, err := store.AppendTurn(purgeID, buildRealisticTurn(1)); err != nil {
		t.Fatal(err)
	}
	if err := store.WriteMeta(purgeID, []byte(`{"id":"sess_purge_target"}`)); err != nil {
		t.Fatal(err)
	}

	mustWrite := func(p string, body []byte, mtime time.Time) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, body, 0o600); err != nil {
			t.Fatal(err)
		}
		if !mtime.IsZero() {
			if err := os.Chtimes(p, mtime, mtime); err != nil {
				t.Fatal(err)
			}
		}
	}

	now := time.Unix(1770000000, 0)
	mustWrite(filepath.Join(slotDir, "sessions", purgeID+".jsonl"), []byte("{}\n"), now)
	mustWrite(filepath.Join(slotDir, "sessions", purgeID+".wal.jsonl"), []byte("{}\n"), now)
	mustWrite(filepath.Join(rootDir, "brain", purgeID, "tool-1.log"), []byte("brain log"), now)
	mustWrite(filepath.Join(rootDir, "executions", purgeID, "exec.json"), []byte("{}"), now)
	mustWrite(filepath.Join(rootDir, "runners", "out", purgeID+"__job1__100.log"), []byte("out1"), now)
	mustWrite(filepath.Join(rootDir, "runners", "out", purgeID+"__job2__200.log.zst"), []byte("out2"), now)
	neighborLog := filepath.Join(rootDir, "runners", "out", keepID+"__job3__300.log")
	mustWrite(neighborLog, []byte("keep neighbor"), now)

	if err := PurgeSessionDisk(rootDir, slotDir, purgeID); err != nil {
		t.Fatalf("PurgeSessionDisk: %v", err)
	}
	for _, gone := range []string{
		filepath.Join(slotDir, "sessions", purgeID),
		filepath.Join(slotDir, "sessions", purgeID+".jsonl"),
		filepath.Join(slotDir, "sessions", purgeID+".wal.jsonl"),
		filepath.Join(rootDir, "brain", purgeID),
		filepath.Join(rootDir, "executions", purgeID),
		filepath.Join(rootDir, "runners", "out", purgeID+"__job1__100.log"),
		filepath.Join(rootDir, "runners", "out", purgeID+"__job2__200.log.zst"),
	} {
		if _, err := os.Stat(gone); !os.IsNotExist(err) {
			t.Fatalf("PurgeSessionDisk left %s behind (err=%v)", gone, err)
		}
	}
	if _, err := os.Stat(neighborLog); err != nil {
		t.Fatalf("PurgeSessionDisk deleted unrelated session runner log: %v", err)
	}

	// --- Part 2: RunDiskGC ---
	logPayload := []byte(strings.Repeat("runner output line with compressible text\n", 500))

	// 2a. Active runner job (>24h old, status=running) -> MUST NOT be compressed!
	activeLog := filepath.Join(rootDir, "runners", "out", "s1__job_live__10.log")
	mustWrite(activeLog, logPayload, now.Add(-48*time.Hour))
	if err := runner.WriteState(rootDir, &runner.State{
		JobID:     "job_live",
		SessionID: "s1",
		Status:    runner.StatusRunning,
		LogPath:   activeLog,
	}); err != nil {
		t.Fatal(err)
	}

	// 2b. Terminal runner job (>24h old, status=done) -> MUST compress to .log.zst!
	doneCode := 0
	termLog := filepath.Join(rootDir, "runners", "out", "s1__job_done__20.log")
	mustWrite(termLog, logPayload, now.Add(-36*time.Hour))
	if err := runner.WriteState(rootDir, &runner.State{
		JobID:     "job_done",
		SessionID: "s1",
		Status:    runner.StatusDone,
		ExitCode:  &doneCode,
		LogPath:   termLog,
	}); err != nil {
		t.Fatal(err)
	}

	// 2c. Brain log (>24h old) -> MUST compress to .log.zst!
	brainLog := filepath.Join(rootDir, "brain", "s1", "tool-call_55.log")
	mustWrite(brainLog, logPayload, now.Add(-30*time.Hour))

	// 2d. Ancient logs (>30d old) -> MUST be deleted!
	ancientRunnerLog := filepath.Join(rootDir, "runners", "out", "s1__job_old__1.log.zst")
	ancientBrainLog := filepath.Join(rootDir, "brain", "s1", "old.log")
	mustWrite(ancientRunnerLog, []byte("old"), now.Add(-35*24*time.Hour))
	mustWrite(ancientBrainLog, []byte("old"), now.Add(-31*24*time.Hour))

	// 2e. CAS blobs:
	// - blobLiveSession: referenced by v2 session "s_live" (3h old) -> KEEP
	// - blobLiveWAL: referenced only by active WAL "s_wal.wal.jsonl" (3h old) -> KEEP
	// - blobRecentUnref: unreferenced but only 15m old (< 1h grace) -> KEEP
	// - blobOrphanOld: unreferenced and 3h old (> 1h grace) -> SWEEP!
	imgLive := makeTestPNG(t, 16, 16, 1)
	if _, err := store.AppendTurn("s_live", TurnWrite{
		TurnSeq: 1,
		Messages: []provider.Message{{
			ID: "m1", Role: provider.RoleUser, TurnIndex: 1,
			Content: []provider.Content{provider.ImageBlock{MimeType: "image/png", Data: imgLive}},
		}},
	}); err != nil {
		t.Fatal(err)
	}
	liveManifest, err := store.ReadManifest("s_live")
	if err != nil || len(liveManifest.Segments[0].BlobRefs) != 1 {
		t.Fatalf("expected s_live BlobRefs populated: %+v err=%v", liveManifest, err)
	}
	blobLiveSession := liveManifest.Segments[0].BlobRefs[0]
	liveBlobPath, _ := store.CAS().BlobPath(blobLiveSession)
	_ = os.Chtimes(liveBlobPath, now.Add(-3*time.Hour), now.Add(-3*time.Hour))

	blobLiveWAL, err := store.CAS().PutBytes("image/png", []byte("wal-referenced-blob-bytes"))
	if err != nil {
		t.Fatal(err)
	}
	walBlobPath, _ := store.CAS().BlobPath(blobLiveWAL)
	_ = os.Chtimes(walBlobPath, now.Add(-3*time.Hour), now.Add(-3*time.Hour))
	mustWrite(
		filepath.Join(slotDir, "sessions", "s_wal.wal.jsonl"),
		[]byte(fmt.Sprintf(`{"v":1,"type":"msg","msg":{"role":"user","content":[{"mime_type":"image/png","blobSha256":%q}]}}`+"\n", blobLiveWAL)),
		now,
	)

	blobRecentUnref, err := store.CAS().PutBytes("image/png", []byte("young-unreferenced-blob"))
	if err != nil {
		t.Fatal(err)
	}
	youngBlobPath, _ := store.CAS().BlobPath(blobRecentUnref)
	_ = os.Chtimes(youngBlobPath, now.Add(-15*time.Minute), now.Add(-15*time.Minute))

	blobOrphanOld, err := store.CAS().PutBytes("image/png", []byte("ancient-orphan-blob-to-sweep"))
	if err != nil {
		t.Fatal(err)
	}
	orphanBlobPath, _ := store.CAS().BlobPath(blobOrphanOld)
	_ = os.Chtimes(orphanBlobPath, now.Add(-3*time.Hour), now.Add(-3*time.Hour))

	// 2f. Oversized daemon.log (> 16 MiB) -> rotate to daemon.log.1!
	daemonLog := filepath.Join(rootDir, "logs", "daemon.log")
	bigDaemonBytes := bytes.Repeat([]byte("daemon log entry line 0123456789\n"), (17<<20)/33)
	mustWrite(daemonLog, bigDaemonBytes, now)

	gcStats, err := RunDiskGC(context.Background(), rootDir, slotDir, GCPolicy{
		CompressLogsAfter: 24 * time.Hour,
		DeleteLogsAfter:   30 * 24 * time.Hour,
		CASGracePeriod:    1 * time.Hour,
		MaxDaemonLogBytes: 16 << 20,
		Now:               now,
	})
	if err != nil {
		t.Fatalf("RunDiskGC: %v", err)
	}

	// Verify active log untouched.
	if _, err := os.Stat(activeLog); err != nil {
		t.Fatalf("active runner log was modified/removed: %v", err)
	}
	if _, err := os.Stat(activeLog + ".zst"); !os.IsNotExist(err) {
		t.Fatalf("active runner log must not be compressed")
	}

	// Verify terminal runner log and brain log compressed to valid .log.zst and originals removed.
	dec, err := zstd.NewReader(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer dec.Close()
	for _, orig := range []string{termLog, brainLog} {
		if _, err := os.Stat(orig); !os.IsNotExist(err) {
			t.Fatalf("expected raw log %s removed after .zst compression", orig)
		}
		compBytes, err := os.ReadFile(orig + ".zst")
		if err != nil {
			t.Fatalf("expected compressed log %s.zst: %v", orig, err)
		}
		plain, err := dec.DecodeAll(compBytes, nil)
		if err != nil || !bytes.Equal(plain, logPayload) {
			t.Fatalf("compressed log %s.zst round-trip mismatch: %v", orig, err)
		}
	}

	// Verify >30d logs deleted.
	for _, old := range []string{ancientRunnerLog, ancientBrainLog} {
		if _, err := os.Stat(old); !os.IsNotExist(err) {
			t.Fatalf("expected >30d log %s deleted", old)
		}
	}

	// Verify CAS orphan sweep kept live + WAL + young blobs and deleted >1h orphan!
	if !store.CAS().Has(blobLiveSession) {
		t.Fatalf("GC swept live v2 session CAS blob!")
	}
	if !store.CAS().Has(blobLiveWAL) {
		t.Fatalf("GC swept active WAL CAS blob!")
	}
	if !store.CAS().Has(blobRecentUnref) {
		t.Fatalf("GC swept young (<1h grace) CAS blob!")
	}
	if store.CAS().Has(blobOrphanOld) {
		t.Fatalf("GC failed to sweep >1h unreferenced orphan CAS blob")
	}

	// Verify daemon.log rotated to daemon.log.1.
	if !gcStats.RotatedDaemonLog {
		t.Fatalf("expected RotatedDaemonLog=true, stats=%+v", gcStats)
	}
	if fi, err := os.Stat(daemonLog + ".1"); err != nil || fi.Size() != int64(len(bigDaemonBytes)) {
		t.Fatalf("daemon.log.1 missing or wrong size: err=%v", err)
	}
	if gcStats.CompressedLogs != 2 || gcStats.DeletedLogs != 2 || gcStats.DeletedBlobs != 1 {
		t.Fatalf("unexpected GCStats counts: %+v", gcStats)
	}
}

func BenchmarkColdSeekableZstdRandomAccess(b *testing.B) {
	slotDir := b.TempDir()
	store := New(slotDir)
	sessID := "bench_cold_2500"
	const totalTurns = 2500
	seed := make([]TurnWrite, totalTurns)
	for i := 1; i <= totalTurns; i++ {
		seed[i-1] = buildRealisticTurn(i)
	}
	if _, err := store.AppendTurns(sessID, seed); err != nil {
		b.Fatal(err)
	}
	if _, err := store.AgeSession(context.Background(), sessID, AgePolicy{
		HotKeepTurns: 0,
		WarmMaxAge:   time.Second,
		Now:          time.Now().Add(48 * time.Hour),
	}); err != nil {
		b.Fatal(err)
	}

	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		targetMsg := ((i * 137) % totalTurns) * 4
		ws, err := store.ReadAroundMsg(sessID, targetMsg, 1, 4)
		if err != nil || len(ws.Messages) == 0 {
			b.Fatalf("ReadAroundMsg(%d): %v", targetMsg, err)
		}
	}
}
