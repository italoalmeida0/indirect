package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"indirect/indirect-code-daemon/packages/provider"
)

type stubLSMTool struct {
	name string
}

func (t stubLSMTool) Name() string        { return t.name }
func (t stubLSMTool) Description() string { return "Read file" }
func (t stubLSMTool) Schema() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"}}}`)
}
func (t stubLSMTool) Execute(ctx context.Context, args json.RawMessage, progress func(string)) (ToolResult, error) {
	return ToolResult{Content: []provider.Content{provider.TextBlock{Text: "ok"}}}, nil
}

type recordingWarmClient struct {
	mu          sync.Mutex
	requests    []provider.Request
	forkReplies []string
	mainReply   string
	emitToolUse bool
	stopLength  int // number of initial summarizer calls that return StopLength
	calls       int
}

func (c *recordingWarmClient) Name() string { return "anthropic" }

func (c *recordingWarmClient) Stream(ctx context.Context, req provider.Request) (<-chan provider.Event, error) {
	c.mu.Lock()
	c.calls++
	callNum := c.calls
	reqCopy := req
	reqCopy.Messages = append([]provider.Message(nil), req.Messages...)
	reqCopy.Tools = append([]provider.Tool(nil), req.Tools...)
	c.requests = append(c.requests, reqCopy)

	isSummarizer := req.System == SummarizationSystemPrompt
	if !isSummarizer && len(req.Messages) > 0 {
		lastMeta := req.Messages[len(req.Messages)-1].Meta
		if lastMeta != nil && lastMeta["compaction"] == "summarizer_fork" {
			isSummarizer = true
		}
	}
	emitTool := c.emitToolUse && isSummarizer
	retStopLen := false
	if isSummarizer && c.stopLength > 0 {
		c.stopLength--
		retStopLen = true
	}
	reply := c.mainReply
	if reply == "" {
		reply = "ok"
	}
	if isSummarizer && len(c.forkReplies) > 0 {
		reply = c.forkReplies[0]
		c.forkReplies = c.forkReplies[1:]
	} else if isSummarizer {
		reply = "## Goal\n- Compacted span.\n\n## Progress\n- Folded cleanly."
	}
	c.mu.Unlock()

	_ = callNum
	out := make(chan provider.Event, 16)
	go func() {
		defer close(out)
		out <- provider.EventStart{Provider: "anthropic", Model: req.Model}
		if emitTool {
			out <- provider.EventToolStart{ID: "bad_tc_1", Name: "bash"}
			// Wait for immediate cancellation from streamSummarizerRequest.
			select {
			case <-ctx.Done():
				return
			case <-time.After(2 * time.Second):
				out <- provider.EventDone{Stop: provider.StopToolUse}
				return
			}
		}
		out <- provider.EventTextDelta{Delta: reply}
		out <- provider.EventUsage{Usage: provider.Usage{InputTokens: 120, OutputTokens: 40}}
		stop := provider.StopEnd
		if retStopLen {
			stop = provider.StopLength
		}
		out <- provider.EventDone{
			Stop: stop,
			Message: provider.Message{
				Role:    provider.RoleAssistant,
				Content: []provider.Content{provider.TextBlock{Text: reply}},
			},
		}
	}()
	return out, nil
}

func TestMultiBlockSlicingPreservesPriorBlocksImmutably(t *testing.T) {
	client := &scriptableFakeClient{
		summaries: []string{
			"era 1 narrative summary",
			"era 2 narrative summary",
			"era 3 narrative summary",
			"era 4 narrative summary",
			"era 5 narrative summary",
			"era 6 narrative summary",
			"era 7 narrative summary",
			"era 8 narrative summary",
		},
	}
	a := NewAgent(client, "m", "", nil)

	// Build ~102K btdby4 tokens across 9 user/assistant pairs (~11.3K tokens per pair)
	// on a 100K window (80% = 80K target) so Wave 1 slices into multiple Tier-1 blocks (<8).
	var msgs []provider.Message
	for i := 0; i < 9; i++ {
		msgs = append(msgs, textMsg(provider.RoleUser, fmt.Sprintf("turn %d prompt %s", i, strings.Repeat("u", 30000))))
		msgs = append(msgs, textMsg(provider.RoleAssistant, fmt.Sprintf("turn %d answer %s", i, strings.Repeat("a", 30000))))
	}
	a.SetMessages(msgs)

	did, err := a.MaybeAutoCompactAt(context.Background(), 100000, 80, nil)
	if err != nil || !did {
		t.Fatalf("first MaybeAutoCompactAt: did=%v err=%v", did, err)
	}

	chain1 := a.CompactionChain()
	active1 := chain1.ActiveBlocks()
	if len(active1) < 2 {
		t.Fatalf("expected multi-block ~45K slicing (>=2 blocks), got %d block(s)", len(active1))
	}
	for i, b := range active1 {
		if b.Tier != 1 {
			t.Fatalf("block %d tier = %d, want 1", i, b.Tier)
		}
		if i > 0 && b.StartIdx != active1[i-1].EndIdx {
			t.Fatalf("non-contiguous FoldBlock spans: %+v then %+v", active1[i-1], b)
		}
	}

	// Capture exact rendered bytes of active1 blocks in projected context.
	proj1 := a.Messages()
	renderedWave1 := make([]string, len(active1))
	lastBlockStamps := 0
	for i := range active1 {
		renderedWave1[i] = extractText(proj1[i])
		if proj1[i].Meta["compaction"] != "true" || proj1[i].Meta["block_id"] != active1[i].ID {
			t.Fatalf("projected block %d missing metadata: %+v", i, proj1[i].Meta)
		}
		if proj1[i].Meta["compaction_last_block"] == "true" {
			lastBlockStamps++
			if i != len(active1)-1 {
				t.Fatalf("compaction_last_block stamped on non-final block %d", i)
			}
		}
	}
	if lastBlockStamps != 1 {
		t.Fatalf("expected exactly 1 compaction_last_block stamp, got %d", lastBlockStamps)
	}

	// Append 6 more large pairs (~68K tokens) and compact again on the 100K window:
	// prior blocks b1..bk must stay 100% byte-identical!
	for i := 9; i < 15; i++ {
		msgs = append(msgs, textMsg(provider.RoleUser, fmt.Sprintf("turn %d prompt %s", i, strings.Repeat("u", 30000))))
		msgs = append(msgs, textMsg(provider.RoleAssistant, fmt.Sprintf("turn %d answer %s", i, strings.Repeat("a", 30000))))
	}
	a.SetMessages(msgs)

	did2, err := a.MaybeAutoCompactAt(context.Background(), 100000, 80, nil)
	if err != nil || !did2 {
		t.Fatalf("second MaybeAutoCompactAt: did=%v err=%v", did2, err)
	}

	chain2 := a.CompactionChain()
	active2 := chain2.ActiveBlocks()
	if len(active2) <= len(active1) {
		t.Fatalf("expected new FoldBlock appended on second compaction: had %d, got %d", len(active1), len(active2))
	}
	proj2 := a.Messages()
	for i := range active1 {
		if got := extractText(proj2[i]); got != renderedWave1[i] {
			t.Fatalf("FoldBlock %s was rewritten on subsequent compaction (busts KV cache)!\nbefore:\n%s\nafter:\n%s",
				active1[i].ID, renderedWave1[i], got)
		}
		if proj2[i].Meta["compaction_last_block"] != "" {
			t.Fatalf("older block %s retained compaction_last_block after new block appended!", active1[i].ID)
		}
	}
	if proj2[len(active2)-1].Meta["compaction_last_block"] != "true" {
		t.Fatalf("newest active FoldBlock missing compaction_last_block=true")
	}
}

func TestTombstoneHeaderAndActivatedToolsPreserved(t *testing.T) {
	client := &scriptableFakeClient{summaries: []string{"Implemented auth handler and checked tests."}}
	a := NewAgent(client, "m", "", nil)

	readAsst := provider.Message{
		Role: provider.RoleAssistant,
		Content: []provider.Content{
			provider.ToolCallBlock{ID: "r1", Name: "read", Arguments: mustRaw(`{"path":"server/auth.ts","offset":10,"limit":40}`)},
		},
	}
	readTool := provider.Message{
		Role:           provider.RoleTool,
		AddedToolNames: []string{"mcp_github_pr"},
		Content: []provider.Content{
			provider.ToolResultBlock{CallID: "r1", Content: []provider.Content{provider.TextBlock{Text: "export function verify() {}"}}},
		},
	}
	editAsst, editTool := toolTurn("edit", `{"path":"server/auth.ts"}`, "applied")
	bashAsst := provider.Message{
		Role: provider.RoleAssistant,
		Content: []provider.Content{
			provider.ToolCallBlock{ID: "b1", Name: "bash", Arguments: mustRaw(`{"command":"bun test test/auth.test.ts"}`)},
		},
	}
	bashTool := provider.Message{
		Role: provider.RoleTool,
		Content: []provider.Content{
			provider.ToolResultBlock{
				CallID:  "b1",
				IsError: false,
				Content: []provider.Content{provider.TextBlock{
					Text: ToolEnvelope("ok", []Attr{{Key: "exit", Value: "1"}}, "Running auth tests...\nerror: expected 200 but received 401"),
				}},
			},
		},
	}

	a.SetMessages([]provider.Message{
		textMsg(provider.RoleUser, "Fix token check in server/auth.ts"),
		readAsst, readTool,
		editAsst, editTool,
		bashAsst, bashTool,
		textMsg(provider.RoleUser, "Continue fixing the 401"),
		textMsg(provider.RoleAssistant, "Inspecting middleware next."),
	})

	if _, err := a.Compact(context.Background(), 2, nil); err != nil {
		t.Fatalf("Compact: %v", err)
	}

	proj := a.Messages()
	head := proj[0]
	txt := extractText(head)
	for _, want := range []string{
		"[FoldBlock b1 · Tier 1 · msgs #0–#6]",
		"Files modified: server/auth.ts",
		"Files read: server/auth.ts",
		"File spans: server/auth.ts:10-49, server/auth.ts (edit)",
		"bun test test/auth.test.ts",
		"(exit 1)",
		"error: expected 200 but received 401",
		`call ` + "`session_history`" + ` with ` + "`{\"action\":\"recall\",\"block_id\":\"b1\"}`",
	} {
		if !strings.Contains(txt, want) {
			t.Fatalf("Tombstone header missing %q:\n%s", want, txt)
		}
	}
	if !containsString(head.AddedToolNames, "mcp_github_pr") {
		t.Fatalf("ActivatedTools lost across FoldBlock projection: %v", head.AddedToolNames)
	}
}

func TestPrefixWarmForkedSummarizerWireIdentityAndCheckpoints(t *testing.T) {
	client := &recordingWarmClient{
		forkReplies: []string{"## Goal\n- Shipped LSM compaction.\n\n## Progress\n- Verified cache hit."},
		mainReply:   "turn completed",
	}
	reg := NewRegistry(stubLSMTool{name: "read"})
	a := NewAgent(client, "claude-opus-4-6", "You are Indirect Code.", reg)
	a.Reasoning = "high"
	a.SessionID = "sess-warm-42"
	a.RequestMessages = func(msgs []provider.Message) []provider.Message {
		out := append([]provider.Message(nil), msgs...)
		for i := len(out) - 1; i >= 0; i-- {
			if out[i].Role == provider.RoleUser {
				cp := out[i]
				cp.Content = []provider.Content{provider.TextBlock{Text: "<system-reminder><skill name=\"build\">build-rules</skill></system-reminder>\n" + extractText(cp)}}
				out[i] = cp
				break
			}
		}
		return out
	}

	// Seed conversation including both a summary tool call (for_me) and a summary_checkpoint meta note.
	sumCall := provider.Message{
		Role: provider.RoleAssistant,
		Content: []provider.Content{
			provider.ToolCallBlock{
				ID:        "sum-1",
				Name:      "summary",
				Arguments: mustRaw(`{"for_user":"Halfway there","for_me":"ANCHOR_FOR_ME_1: finished provider tokens"}`),
			},
		},
	}
	sumRes := provider.Message{
		Role:    provider.RoleTool,
		Content: []provider.Content{provider.ToolResultBlock{CallID: "sum-1", Content: []provider.Content{provider.TextBlock{Text: "ok"}}}},
	}
	metaCheckpoint := provider.Message{
		Role:    provider.RoleUser,
		Meta:    map[string]string{"summary_checkpoint": "true", "for_me": "ANCHOR_FOR_ME_2: verify 4th cache_control slot"},
		Content: []provider.Content{provider.TextBlock{Text: "checkpoint"}},
	}

	a.SetMessages([]provider.Message{
		textMsg(provider.RoleUser, "Implement compaction"),
		sumCall,
		sumRes,
		metaCheckpoint,
		textMsg(provider.RoleAssistant, "Ready for next step"),
	})

	// Run one real turn first to capture exact main-loop request wire shape.
	if err := a.Prompt(context.Background(), "Now add tests", nil, nil); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	if len(client.requests) != 1 {
		t.Fatalf("expected 1 main turn request, got %d", len(client.requests))
	}

	// Snapshot expected warm prefix right before Compact.
	expectedSys, expectedTools, expectedPrefixMsgs := a.ContextSnapshot()

	if _, err := a.Compact(context.Background(), 2, nil); err != nil {
		t.Fatalf("Compact: %v", err)
	}
	if len(client.requests) != 2 {
		t.Fatalf("expected 2nd request to be Prefix-Warm Forked Summarizer, got %d total", len(client.requests))
	}

	forkReq := client.requests[1]
	if forkReq.System != expectedSys {
		t.Fatalf("fork System mismatch: got %q, want %q", forkReq.System, expectedSys)
	}
	if len(forkReq.Tools) != len(expectedTools) || forkReq.Tools[0].Name != "read" {
		t.Fatalf("fork Tools mismatch: got %+v, want %+v", forkReq.Tools, expectedTools)
	}
	if forkReq.Reasoning != "high" {
		t.Fatalf("fork Reasoning = %q, want %q verbatim so Anthropic thinking/effort KV cache stays intact", forkReq.Reasoning, "high")
	}
	if forkReq.SessionID != "sess-warm-42" {
		t.Fatalf("fork SessionID = %q, want sess-warm-42", forkReq.SessionID)
	}
	if len(forkReq.Messages) != len(expectedPrefixMsgs)+1 {
		t.Fatalf("fork Messages len = %d, want %d (warm prefix + 1 trailing directive)", len(forkReq.Messages), len(expectedPrefixMsgs)+1)
	}
	if mustJSONContext(t, forkReq.Messages[:len(expectedPrefixMsgs)]) != mustJSONContext(t, expectedPrefixMsgs) {
		t.Fatalf("fork prefix messages diverged from BuildContextLocked()+RequestMessages() — KV cache busted!")
	}

	trailing := extractText(forkReq.Messages[len(forkReq.Messages)-1])
	for _, want := range []string{
		"DO NOT CALL ANY TOOLS",
		"ANCHOR_FOR_ME_1: finished provider tokens",
		"ANCHOR_FOR_ME_2: verify 4th cache_control slot",
	} {
		if !strings.Contains(trailing, want) {
			t.Fatalf("fork directive missing %q:\n%s", want, trailing)
		}
	}
}

func TestForkedSummarizerCancelsImmediatelyOnToolStartAndFallsBackMechanically(t *testing.T) {
	client := &recordingWarmClient{emitToolUse: true}
	a := NewAgent(client, "claude-sonnet-4-6", "You are Indirect Code.", nil)
	a.SetMessages([]provider.Message{
		textMsg(provider.RoleUser, "Refactor packages/core/prune.go"),
		textMsg(provider.RoleAssistant, "Checking references."),
		textMsg(provider.RoleUser, "Run unit tests"),
		textMsg(provider.RoleAssistant, "All green."),
	})

	start := time.Now()
	summary, err := a.Compact(context.Background(), 2, nil)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("Compact must fall back to MechanicalBlockSummary instead of failing: %v", err)
	}
	if elapsed > 1*time.Second {
		t.Fatalf("EventToolStart did not cancel stream immediately (took %v)", elapsed)
	}
	if !strings.Contains(summary, "Refactor packages/core/prune.go") {
		t.Fatalf("expected MechanicalBlockSummary to capture user goal, got:\n%s", summary)
	}
}

func TestNetShrinkToleranceEnforcesMechanicalFallback(t *testing.T) {
	// Regurgitative model output (~3,200 tokens) larger than raw span (~2,000 tokens).
	bloated := "## Goal\n" + strings.Repeat("regurgitated verbatim token bloat ", 800)
	client := &recordingWarmClient{forkReplies: []string{bloated}}
	a := NewAgent(client, "claude-sonnet-4-6", "You are Indirect Code.", nil)

	a.SetMessages([]provider.Message{
		textMsg(provider.RoleUser, "Optimize SQLite WAL checkpointing in server/db.ts "+strings.Repeat("x", 3500)),
		textMsg(provider.RoleAssistant, "Updated WAL pragma settings "+strings.Repeat("y", 3500)),
		textMsg(provider.RoleUser, "Next task"),
		textMsg(provider.RoleAssistant, "Ack"),
	})

	summary, err := a.Compact(context.Background(), 2, nil)
	if err != nil {
		t.Fatalf("Compact: %v", err)
	}
	if strings.Contains(summary, "regurgitated verbatim token bloat") {
		t.Fatalf("NET_SHRINK_TOLERANCE failed to reject bloated regurgitative summary!")
	}
	blk := a.CompactionChain().ActiveBlocks()[0]
	if blk.BlockTokens >= blk.RawTokens {
		t.Fatalf("expected mechanical fallback BlockTokens (%d) < RawTokens (%d)", blk.BlockTokens, blk.RawTokens)
	}
}

func TestChainedSerializeSkipsSyntheticFoldBlocksAndUsesLogSelect(t *testing.T) {
	syn := renderFoldBlockMessage(FoldBlock{
		ID:       "b1",
		Tier:     1,
		StartIdx: 0,
		EndIdx:   4,
		Summary:  "SECRET_PRIOR_FOLD_SUMMARY_DO_NOT_RESERIALIZE",
	}, true, 1, nil)

	var logLines []string
	for i := 1; i <= 220; i++ {
		if i == 195 {
			logLines = append(logLines, "packages/core/compact.go:88:12: undefined: missingHelperSymbol")
		} else {
			logLines = append(logLines, fmt.Sprintf("ok   package/module_%03d  0.012s", i))
		}
	}
	call, res := toolTurn("bash", `{"command":"go test ./..."}`, strings.Join(logLines, "\n"))

	serialized := SerializeConversation([]provider.Message{
		syn,
		textMsg(provider.RoleUser, "Run full suite"),
		call,
		res,
	})
	if strings.Contains(serialized, "SECRET_PRIOR_FOLD_SUMMARY_DO_NOT_RESERIALIZE") {
		t.Fatalf("SerializeConversation serialized synthetic FoldBlock as raw turn!")
	}
	if !strings.Contains(serialized, "undefined: missingHelperSymbol") {
		t.Fatalf("SerializeConversation dropped late compiler error line instead of preserving via LogSelect!")
	}
}

func TestSplitTurnStopLengthRetryRecoversCleanly(t *testing.T) {
	client := &recordingWarmClient{
		stopLength: 1, // First SplitTurn call hits StopLength, retry succeeds!
		forkReplies: []string{
			"truncated partial...",
			"Recovered history summary after concise retry.",
			"Clean split-turn prefix summary.",
		},
	}
	a := NewAgent(client, "claude-sonnet-4-6", "You are Indirect Code.", nil)

	var msgs []provider.Message
	msgs = append(msgs, textMsg(provider.RoleUser, "initial setup"))
	msgs = append(msgs, textMsg(provider.RoleAssistant, "setup complete"))
	msgs = append(msgs, textMsg(provider.RoleUser, "run multi-step refactor"))
	for i := 0; i < 4; i++ {
		c, r := toolTurn("edit", fmt.Sprintf(`{"path":"pkg/f%d.go"}`, i), "edited")
		msgs = append(msgs, c, r)
	}
	a.SetMessages(msgs)

	summary, err := a.Compact(context.Background(), 2, nil)
	if err != nil {
		t.Fatalf("SplitTurn Compact failed on StopLength: %v", err)
	}
	if !strings.Contains(summary, "Recovered history summary after concise retry.") {
		t.Fatalf("expected retried history summary, got:\n%s", summary)
	}
	if !strings.Contains(summary, "**Turn Context (split turn):**") || !strings.Contains(summary, "Clean split-turn prefix summary.") {
		t.Fatalf("missing split turn context in:\n%s", summary)
	}
}

func TestTier2MergeUnionsTombstonesAndTruncateUnretiresChildren(t *testing.T) {
	client := &recordingWarmClient{
		forkReplies: []string{
			"## Goal\n- New Tier-1 block b9.",
			"## Goal\n- Consolidated Tier-2 narrative (prose omits file names intentionally).",
		},
	}
	a := NewAgent(client, "claude-sonnet-4-6", "You are Indirect Code.", nil)

	// Build 22 raw messages: 8 existing Tier-1 blocks covering [0, 16) (2 msgs each),
	// plus [16, 22) unfolded. Folding [16, 18) creates b9 (9th active block > 8),
	// triggering Tier-2 merge of b1..b4 into b10!
	var msgs []provider.Message
	for i := 0; i < 11; i++ {
		msgs = append(msgs, textMsg(provider.RoleUser, fmt.Sprintf("era %d user", i)))
		msgs = append(msgs, textMsg(provider.RoleAssistant, fmt.Sprintf("era %d assistant", i)))
	}
	a.SetMessages(msgs)

	var seedBlocks []FoldBlock
	for i := 0; i < 8; i++ {
		id := fmt.Sprintf("b%d", i+1)
		blk := FoldBlock{
			ID:             id,
			Tier:           1,
			StartIdx:       i * 2,
			EndIdx:         (i + 1) * 2,
			Topic:          fmt.Sprintf("Topic %d", i+1),
			Summary:        fmt.Sprintf("Summary for %s", id),
			ReadFiles:      []string{fmt.Sprintf("read_%d.go", i+1)},
			ModifiedFiles:  []string{fmt.Sprintf("mod_%d.go", i+1)},
			FileSpans:      []string{fmt.Sprintf("mod_%d.go:1-20", i+1)},
			ActivatedTools: []string{fmt.Sprintf("tool_%d", i+1)},
			FailedCommands: []FailedCommandSummary{{
				Command:    fmt.Sprintf("go test ./pkg%d", i+1),
				ExitCode:   "1",
				FirstError: fmt.Sprintf("FAIL pkg%d", i+1),
			}},
			RawTokens: 2000,
			CreatedAt: int64(1000 + i),
		}
		blk.BlockTokens = estimateFoldBlockTokens(blk)
		seedBlocks = append(seedBlocks, blk)
	}
	seed := &CompactionState{
		Blocks:       seedBlocks,
		NextBlockSeq: 8,
		Count:        8,
	}
	seed.SyncMirrors()
	a.SeedCompactionState(seed)

	// Compact keeping last 4 messages ([18, 22)), so [16, 18) becomes b9 -> 9 active blocks -> b1..b4 merge into b10!
	if _, err := a.Compact(context.Background(), 4, nil); err != nil {
		t.Fatalf("Compact triggering Tier-2 merge: %v", err)
	}

	chain := a.CompactionChain()
	active := chain.ActiveBlocks()
	// 9 blocks - 4 retired + 1 T2 = 6 active blocks: [b10 (T2: 0..8), b5, b6, b7, b8, b9].
	if len(active) != 6 {
		t.Fatalf("active block count = %d, want 6", len(active))
	}
	t2 := active[0]
	if t2.Tier != 2 || t2.StartIdx != 0 || t2.EndIdx != 8 {
		t.Fatalf("unexpected Tier-2 block header: %+v", t2)
	}
	if strings.Join(t2.SourceBlockIDs, ",") != "b1,b2,b3,b4" {
		t.Fatalf("Tier-2 SourceBlockIDs = %v, want [b1 b2 b3 b4]", t2.SourceBlockIDs)
	}
	// Verify mechanical Tombstone union across all 4 merged T1 blocks even though LLM prose omitted them!
	for i := 1; i <= 4; i++ {
		if !containsString(t2.ReadFiles, fmt.Sprintf("read_%d.go", i)) {
			t.Fatalf("Tier-2 missing unioned ReadFile read_%d.go: %v", i, t2.ReadFiles)
		}
		if !containsString(t2.ModifiedFiles, fmt.Sprintf("mod_%d.go", i)) {
			t.Fatalf("Tier-2 missing unioned ModifiedFile mod_%d.go: %v", i, t2.ModifiedFiles)
		}
		if !containsString(t2.FileSpans, fmt.Sprintf("mod_%d.go:1-20", i)) {
			t.Fatalf("Tier-2 missing unioned FileSpan: %v", t2.FileSpans)
		}
		if !containsString(t2.ActivatedTools, fmt.Sprintf("tool_%d", i)) {
			t.Fatalf("Tier-2 missing unioned ActivatedTool: %v", t2.ActivatedTools)
		}
	}
	if len(t2.FailedCommands) != 4 {
		t.Fatalf("Tier-2 FailedCommands len = %d, want 4", len(t2.FailedCommands))
	}

	// Verify retired blocks b1..b4 carry RetiredByBlockID == t2.ID.
	retiredCount := 0
	for _, b := range chain.Blocks {
		if b.ID == "b1" || b.ID == "b2" || b.ID == "b3" || b.ID == "b4" {
			if b.RetiredByBlockID != t2.ID {
				t.Fatalf("expected %s RetiredByBlockID=%q, got %q", b.ID, t2.ID, b.RetiredByBlockID)
			}
			retiredCount++
		}
	}
	if retiredCount != 4 {
		t.Fatalf("retiredCount = %d, want 4", retiredCount)
	}

	// Now test TruncateCompaction straddling t2 ([0, 8)) at effectiveCut = 5:
	// t2 (EndIdx=8 > 5) must be dropped, and its children b1 ([0,2)) and b2 ([2,4))
	// MUST be un-retired so [0, 4) remains compacted while [4, 5) becomes raw!
	truncated := TruncateCompaction(chain, 5)
	if truncated == nil {
		t.Fatal("expected non-nil state when b1 and b2 lie below effectiveCut=5")
	}
	truncActive := truncated.ActiveBlocks()
	if len(truncActive) != 2 || truncActive[0].ID != "b1" || truncActive[1].ID != "b2" {
		t.Fatalf("expected un-retired [b1, b2] after straddling truncate, got %+v", truncActive)
	}
	if truncated.KeepFrom != 4 {
		t.Fatalf("truncated.KeepFrom = %d, want 4", truncated.KeepFrom)
	}

	// Truncating below the very first block (effectiveCut = 1 < b1.EndIdx=2) returns nil.
	if gotNil := TruncateCompaction(chain, 1); gotNil != nil {
		t.Fatalf("expected nil when effectiveCut=1 drops all blocks, got %+v", gotNil)
	}
}

func TestTier2MergeTriggersOnWindowFifteenPercentBudget(t *testing.T) {
	client := &recordingWarmClient{
		forkReplies: []string{
			"## Goal\n- Block 4.",
			"## Goal\n- Merged 4 blocks under 15% window cap.",
		},
	}
	a := NewAgent(client, "claude-sonnet-4-6", "You are Indirect Code.", nil)

	var msgs []provider.Message
	for i := 0; i < 6; i++ {
		msgs = append(msgs, textMsg(provider.RoleUser, fmt.Sprintf("u%d", i)))
		msgs = append(msgs, textMsg(provider.RoleAssistant, fmt.Sprintf("a%d", i)))
	}
	a.SetMessages(msgs)

	// Seed 3 active T1 blocks with BlockTokens=600 each, set contextWindow=10000 (15% = 1500 tokens).
	// Adding b4 pushes active block tokens > 1500 with 4 T1 blocks -> triggers Tier-2 merge even though 4 <= 8!
	seed := &CompactionState{
		Blocks: []FoldBlock{
			{ID: "b1", Tier: 1, StartIdx: 0, EndIdx: 2, Summary: strings.Repeat("word ", 350), RawTokens: 2000, BlockTokens: 600},
			{ID: "b2", Tier: 1, StartIdx: 2, EndIdx: 4, Summary: strings.Repeat("word ", 350), RawTokens: 2000, BlockTokens: 600},
			{ID: "b3", Tier: 1, StartIdx: 4, EndIdx: 6, Summary: strings.Repeat("word ", 350), RawTokens: 2000, BlockTokens: 600},
		},
		NextBlockSeq: 3,
		Count:        3,
	}
	seed.SyncMirrors()
	a.SeedCompactionState(seed)
	a.contextWindow = 10000

	if _, err := a.Compact(context.Background(), 4, nil); err != nil {
		t.Fatalf("Compact: %v", err)
	}
	active := a.CompactionChain().ActiveBlocks()
	if len(active) != 1 || active[0].Tier != 2 {
		t.Fatalf("expected 4 T1 blocks exceeding 15%% window to merge into 1 T2 block, got %+v", active)
	}
}

func TestShiftCompactionOnDropUpdatesIndices(t *testing.T) {
	st := &CompactionState{
		Blocks: []FoldBlock{
			{ID: "b1", Tier: 1, StartIdx: 0, EndIdx: 4, Summary: "era 1"},
			{ID: "b2", Tier: 1, StartIdx: 4, EndIdx: 8, Summary: "era 2"},
		},
		NextBlockSeq: 2,
		Count:        2,
		PrunedBefore: 10,
	}
	st.SyncMirrors()

	// Drop message at index 2 (inside b1): b1 becomes [0,3), b2 becomes [3,7), KeepFrom=7, PrunedBefore=9.
	ShiftCompactionOnDrop(st, 2)
	active := st.ActiveBlocks()
	if active[0].StartIdx != 0 || active[0].EndIdx != 3 {
		t.Fatalf("b1 indices after drop = [%d,%d), want [0,3)", active[0].StartIdx, active[0].EndIdx)
	}
	if active[1].StartIdx != 3 || active[1].EndIdx != 7 {
		t.Fatalf("b2 indices after drop = [%d,%d), want [3,7)", active[1].StartIdx, active[1].EndIdx)
	}
	if st.KeepFrom != 7 || st.FirstKeptEntryID != "h7" || st.PrunedBefore != 9 {
		t.Fatalf("mirrored anchors wrong after drop: KeepFrom=%d FirstKept=%q PrunedBefore=%d", st.KeepFrom, st.FirstKeptEntryID, st.PrunedBefore)
	}
}

func TestLegacyCompactionSeamlessUpgradeAndTwoPassOverflowRecovery(t *testing.T) {
	// Part 1: Legacy state (len(Blocks)==0 && KeepFrom>0) upgrades [0, KeepFrom) into immutable b1.
	client := &scriptableFakeClient{summaries: []string{"new block b2 summary"}}
	a := NewAgent(client, "m", "", nil)
	a.SetMessages(bigHistory(6)) // 12 messages
	a.SeedCompactionState(&CompactionState{
		PreviousSummary: "legacy monolithic summary",
		ReadFiles:       []string{"legacy.go"},
		KeepFrom:        4,
		Count:           1,
	})

	if _, err := a.Compact(context.Background(), 4, nil); err != nil {
		t.Fatalf("Compact from legacy state: %v", err)
	}
	active := a.CompactionChain().ActiveBlocks()
	if len(active) != 2 {
		t.Fatalf("expected 2 blocks (migrated legacy b1 + new b2), got %d", len(active))
	}
	if active[0].StartIdx != 0 || active[0].EndIdx != 4 || active[0].Summary != "legacy monolithic summary" {
		t.Fatalf("migrated b1 altered legacy summary: %+v", active[0])
	}
	if !containsString(active[0].ReadFiles, "legacy.go") {
		t.Fatalf("migrated b1 lost legacy ReadFiles: %+v", active[0].ReadFiles)
	}
	if active[1].StartIdx != 4 || active[1].EndIdx != 8 || active[1].Summary != "new block b2 summary" {
		t.Fatalf("new b2 wrong: %+v", active[1])
	}

	// Part 2: Reactive 2-pass token-based overflow recovery in Agent.Prompt.
	mainAttempts := 0
	sumFake := &scriptableFakeClient{summaries: []string{"pass1 summary", "pass2 summary"}}
	overflowClient := &overflowMockClient{
		onStream: func(req provider.Request) (<-chan provider.Event, error) {
			mainAttempts++
			// Fail BOTH attempt 1 AND attempt 2 (after pass-1 10K budget), succeed on attempt 3 (after pass-2 2.5K budget)!
			if mainAttempts <= 2 {
				return nil, errors.New("context_length_exceeded: request exceeds window")
			}
			return sumFake.Stream(context.Background(), req)
		},
	}
	b := NewAgent(overflowClient, "m", "", nil)
	var tall []provider.Message
	for i := 0; i < 6; i++ {
		tall = append(tall, textMsg(provider.RoleUser, fmt.Sprintf("u%d %s", i, strings.Repeat("x", 9000))))
		tall = append(tall, textMsg(provider.RoleAssistant, fmt.Sprintf("a%d %s", i, strings.Repeat("y", 9000))))
	}
	b.SetMessages(tall)

	if err := b.Prompt(context.Background(), "final question", nil, nil); err != nil {
		t.Fatalf("2-pass overflow recovery Prompt failed: %v", err)
	}
	if mainAttempts != 3 {
		t.Fatalf("expected 3 main attempts (2 overflows + 1 success), got %d", mainAttempts)
	}
	if b.CompactionChain() == nil || b.CompactionChain().Count < 2 {
		t.Fatalf("expected 2 compaction passes recorded, got %+v", b.CompactionChain())
	}
}

func TestPrefixWarmForkedSummarizerAnthropicWireByteIdentity(t *testing.T) {
	type wireEnvelope struct {
		Model        string            `json:"model"`
		System       json.RawMessage   `json:"system"`
		Tools        json.RawMessage   `json:"tools"`
		Thinking     json.RawMessage   `json:"thinking"`
		OutputConfig json.RawMessage   `json:"output_config"`
		MaxTokens    int               `json:"max_tokens"`
		Messages     []json.RawMessage `json:"messages"`
	}

	models := []struct {
		name      string
		model     provider.Model
		maxTokens int
		wantMax   int
	}{
		{
			name:      "adaptive_claude_opus_4_6",
			model:     provider.Model{ID: "claude-opus-4-6", ContextWindow: 200000, MaxOutput: 64000, Reasoning: true},
			maxTokens: 64000,
			wantMax:   20480, // 16384 thinking + 4096 summary cap
		},
		{
			name:      "budget_claude_sonnet_4_5_64k",
			model:     provider.Model{ID: "claude-sonnet-4-5", ContextWindow: 200000, MaxOutput: 64000, Reasoning: true},
			maxTokens: 64000,
			wantMax:   20480,
		},
		{
			name:      "budget_claude_sonnet_4_5_8k_clamped",
			model:     provider.Model{ID: "claude-sonnet-4-5", ContextWindow: 200000, MaxOutput: 8192, Reasoning: true},
			maxTokens: 8192,
			wantMax:   8192, // clamped to agent MaxTokens so BudgetTokens == 8191 matches oneTurn
		},
	}

	for _, tc := range models {
		t.Run(tc.name, func(t *testing.T) {
			anth := provider.NewGatewayAnthropic("gw_key", "http://gw/anthropic/v1", tc.model)
			rec := &recordingWarmClient{
				forkReplies: []string{"## Goal\n- Verified byte-identical Anthropic KV prefix.\n\n## Progress\n- Done."},
			}
			reg := NewRegistry(stubLSMTool{name: "read"})
			a := NewAgent(rec, tc.model.ID, "You are Indirect Code.", reg)
			a.Reasoning = "high"
			a.MaxTokens = tc.maxTokens
			a.SessionID = "sess-kv-byte-id"

			// Seed an existing FoldBlock + tool call/result tail so the fork directives
			// coalesce onto a RoleTool user turn (hardest Anthropic Breakpoint-4 case!).
			seed := &CompactionState{
				Count:        1,
				NextBlockSeq: 1,
				Blocks: []FoldBlock{
					{ID: "b1", Tier: 1, StartIdx: 0, EndIdx: 2, Summary: "era 1"},
				},
			}
			seed.SyncMirrors()
			a.SeedCompactionState(seed)
			a.SetMessages([]provider.Message{
				textMsg(provider.RoleUser, "turn 1 u"),
				textMsg(provider.RoleAssistant, "turn 1 a"),
				textMsg(provider.RoleUser, "turn 2 u"),
				textMsg(provider.RoleAssistant, "turn 2 a"),
				textMsg(provider.RoleUser, "turn 3 u"),
				{
					Role: provider.RoleAssistant,
					Content: []provider.Content{
						provider.ToolCallBlock{ID: "tc-9", Name: "read", Arguments: mustRaw(`{"path":"main.go"}`)},
					},
				},
				{
					Role: provider.RoleTool,
					Content: []provider.Content{
						provider.ToolResultBlock{CallID: "tc-9", Content: []provider.Content{provider.TextBlock{Text: "package main"}}},
					},
				},
			})

			// Build exact wire request that oneTurn would send on the same agent state.
			sys, tls, baseMsgs := a.ContextSnapshot()
			oneTurnReq := provider.Request{
				Model:     a.Model,
				System:    sys,
				Messages:  baseMsgs,
				Tools:     tls,
				Reasoning: a.Reasoning,
				MaxTokens: a.MaxTokens,
				SessionID: a.SessionID,
			}
			_, oneTurnBytes, err := provider.BuildWireRequest(anth, oneTurnReq)
			if err != nil {
				t.Fatalf("BuildWireRequest(oneTurn): %v", err)
			}

			if _, err := a.Compact(context.Background(), 3, nil); err != nil {
				t.Fatalf("Compact: %v", err)
			}
			if len(rec.requests) != 1 {
				t.Fatalf("expected 1 fork request, got %d", len(rec.requests))
			}
			forkReq := rec.requests[0]
			if forkReq.MaxTokens != tc.wantMax {
				t.Fatalf("forkReq.MaxTokens = %d, want %d", forkReq.MaxTokens, tc.wantMax)
			}
			_, forkBytes, err := provider.BuildWireRequest(anth, forkReq)
			if err != nil {
				t.Fatalf("BuildWireRequest(fork): %v", err)
			}

			var mainWire, forkWire wireEnvelope
			if err := json.Unmarshal(oneTurnBytes, &mainWire); err != nil {
				t.Fatalf("unmarshal mainWire: %v", err)
			}
			if err := json.Unmarshal(forkBytes, &forkWire); err != nil {
				t.Fatalf("unmarshal forkWire: %v", err)
			}

			if string(mainWire.System) != string(forkWire.System) {
				t.Fatalf("system wire bytes diverged:\nmain=%s\nfork=%s", mainWire.System, forkWire.System)
			}
			if string(mainWire.Tools) != string(forkWire.Tools) {
				t.Fatalf("tools wire bytes diverged:\nmain=%s\nfork=%s", mainWire.Tools, forkWire.Tools)
			}
			if string(mainWire.Thinking) != string(forkWire.Thinking) {
				t.Fatalf("thinking wire bytes diverged (KV cache busted!):\nmain=%s\nfork=%s", mainWire.Thinking, forkWire.Thinking)
			}
			if string(mainWire.OutputConfig) != string(forkWire.OutputConfig) {
				t.Fatalf("output_config wire bytes diverged:\nmain=%s\nfork=%s", mainWire.OutputConfig, forkWire.OutputConfig)
			}

			// Because baseMsgs ended with RoleTool ("user" on wire), forkReq's trailing RoleUser
			// coalesced onto the final wire message: messages[0..N-2] must be 100% byte-identical,
			// and messages[N-1].content[0..K-1] (including cache_control on content[K-1]!) must
			// be 100% byte-identical to mainWire.Messages[N-1].content!
			if len(forkWire.Messages) != len(mainWire.Messages) {
				t.Fatalf("coalesced message count mismatch: main=%d fork=%d", len(mainWire.Messages), len(forkWire.Messages))
			}
			for i := 0; i < len(mainWire.Messages)-1; i++ {
				if string(mainWire.Messages[i]) != string(forkWire.Messages[i]) {
					t.Fatalf("wire message[%d] diverged:\nmain=%s\nfork=%s", i, mainWire.Messages[i], forkWire.Messages[i])
				}
			}
			var mainTail, forkTail struct {
				Role    string            `json:"role"`
				Content []json.RawMessage `json:"content"`
			}
			_ = json.Unmarshal(mainWire.Messages[len(mainWire.Messages)-1], &mainTail)
			_ = json.Unmarshal(forkWire.Messages[len(forkWire.Messages)-1], &forkTail)
			if len(forkTail.Content) != len(mainTail.Content)+1 {
				t.Fatalf("expected forkTail blocks = %d, got %d", len(mainTail.Content)+1, len(forkTail.Content))
			}
			for i := range mainTail.Content {
				if string(mainTail.Content[i]) != string(forkTail.Content[i]) {
					t.Fatalf("tail block[%d] (incl. cache_control) diverged:\nmain=%s\nfork=%s", i, mainTail.Content[i], forkTail.Content[i])
				}
			}
			if strings.Contains(string(forkTail.Content[len(forkTail.Content)-1]), `"cache_control"`) {
				t.Fatalf("trailing summarizer_fork block must NOT carry cache_control: %s", forkTail.Content[len(forkTail.Content)-1])
			}
		})
	}
}

func TestAgentAddSubagentUsageConcurrentSafety(t *testing.T) {
	a := NewAgent(nil, "m", "", nil)
	a.SeedCost(provider.Usage{InputTokens: 100, OutputTokens: 50})
	a.SeedLastTurnUsage(provider.Usage{InputTokens: 20, OutputTokens: 10})

	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			a.AddSubagentUsage(provider.Usage{InputTokens: 10, OutputTokens: 5})
			_ = a.Cost()
			_ = a.LastTurnUsage()
		}()
	}
	wg.Wait()

	if tot := a.Cost(); tot.InputTokens != 260 || tot.OutputTokens != 130 {
		t.Fatalf("Cost() = %+v, want InputTokens=260 OutputTokens=130", tot)
	}
	if last := a.LastTurnUsage(); last.InputTokens != 180 || last.OutputTokens != 90 {
		t.Fatalf("LastTurnUsage() = %+v, want InputTokens=180 OutputTokens=90", last)
	}
}
