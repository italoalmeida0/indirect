package core

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"indirect/indirect-code-daemon/packages/provider"
)

// ---- helpers ----

func parallelToolGroup(prefix string, n int, payloadChars int) []provider.Message {
	calls := make([]provider.Content, 0, n)
	for i := 1; i <= n; i++ {
		calls = append(calls, provider.ToolCallBlock{
			ID:        fmt.Sprintf("%s_%d", prefix, i),
			Name:      "read",
			Arguments: mustRaw(fmt.Sprintf(`{"path":"pkg/file_%s_%d.go"}`, prefix, i)),
		})
	}
	msgs := make([]provider.Message, 0, 1+n)
	msgs = append(msgs, provider.Message{
		Role:    provider.RoleAssistant,
		Content: calls,
	})
	body := strings.Repeat("x", payloadChars)
	for i := 1; i <= n; i++ {
		msgs = append(msgs, provider.Message{
			Role: provider.RoleTool,
			Content: []provider.Content{
				provider.ToolResultBlock{
					CallID:  fmt.Sprintf("%s_%d", prefix, i),
					Content: []provider.Content{provider.TextBlock{Text: fmt.Sprintf("res_%s_%d:%s", prefix, i, body)}},
				},
			},
		})
	}
	return msgs
}

func assertNoOrphanedToolResultsInTail(t *testing.T, msgs []provider.Message, cut int) {
	t.Helper()
	if cut <= 0 || cut >= len(msgs) {
		return
	}
	if !isPairSafeCut(msgs, cut) {
		t.Fatalf("cut %d failed isPairSafeCut (len=%d)", cut, len(msgs))
	}
	priorCalls := map[string]bool{}
	for i := 0; i < cut; i++ {
		for _, c := range msgs[i].Content {
			if tc, ok := c.(provider.ToolCallBlock); ok && !tc.Server && tc.ID != "" {
				priorCalls[tc.ID] = true
			}
		}
	}
	for i := cut; i < len(msgs); i++ {
		for _, c := range msgs[i].Content {
			if tr, ok := c.(provider.ToolResultBlock); ok && priorCalls[tr.CallID] {
				t.Fatalf("cut %d orphaned ToolResultBlock %q at msg[%d] (owning ToolCallBlock is in msgs[:%d])", cut, tr.CallID, i, cut)
			}
		}
	}
}

// scriptedEventClient emits custom provider.Event sequences per Stream call.
type scriptedEventClient struct {
	mu      sync.Mutex
	handler func(ctx context.Context, callIdx int, req provider.Request) ([]provider.Event, error)
	calls   int
	reqs    []provider.Request
}

func (c *scriptedEventClient) Name() string { return "anthropic" }

func (c *scriptedEventClient) Stream(ctx context.Context, req provider.Request) (<-chan provider.Event, error) {
	c.mu.Lock()
	idx := c.calls
	c.calls++
	cp := req
	cp.Messages = append([]provider.Message(nil), req.Messages...)
	cp.Tools = append([]provider.Tool(nil), req.Tools...)
	c.reqs = append(c.reqs, cp)
	h := c.handler
	c.mu.Unlock()

	events, err := h(ctx, idx, req)
	if err != nil {
		return nil, err
	}
	ch := make(chan provider.Event, len(events))
	for _, ev := range events {
		ch <- ev
	}
	close(ch)
	return ch, nil
}

// ---- 1. Watchdog liveness gaps & post-cancel mutation guards ----

func TestStreamSummarizerRequestPulsesLivenessOnReasoningStartUsageAndToolStart(t *testing.T) {
	t.Run("start_reasoning_text_usage", func(t *testing.T) {
		client := &scriptedEventClient{
			handler: func(_ context.Context, _ int, req provider.Request) ([]provider.Event, error) {
				return []provider.Event{
					provider.EventStart{Provider: "anthropic", Model: req.Model},
					provider.EventReasoningDelta{Delta: "thinking step 1..."},
					provider.EventReasoningDelta{Delta: "thinking step 2..."},
					provider.EventReasoningDelta{Delta: "thinking step 3..."},
					provider.EventTextDelta{Delta: "## Goal\n- Done."},
					provider.EventUsage{Usage: provider.Usage{InputTokens: 100, OutputTokens: 20}},
					provider.EventDone{Stop: provider.StopEnd},
				}, nil
			},
		}
		a := NewAgent(client, "claude-opus-4-6", "sys", nil)
		var deltas []string
		var concat strings.Builder
		got, stopLen, usage, err := a.streamSummarizerRequest(context.Background(), provider.Request{Model: "claude-opus-4-6"}, func(d string) {
			deltas = append(deltas, d)
			concat.WriteString(d)
		})
		if err != nil || stopLen {
			t.Fatalf("streamSummarizerRequest: err=%v stopLen=%v", err, stopLen)
		}
		if got != "## Goal\n- Done." {
			t.Fatalf("summary = %q", got)
		}
		if concat.String() != "## Goal\n- Done." {
			t.Fatalf("concatenated sink deltas polluted: %q", concat.String())
		}
		// Expect 1 EventStart + 3 EventReasoningDelta + 1 EventTextDelta + 1 EventUsage = 6 pulses.
		if len(deltas) != 6 {
			t.Fatalf("expected 6 liveness/delta sink calls, got %d (%q)", len(deltas), deltas)
		}
		emptyPulses := 0
		for _, d := range deltas {
			if d == "" {
				emptyPulses++
			}
		}
		if emptyPulses != 5 {
			t.Fatalf("expected 5 empty liveness pulses (start+3*reasoning+usage), got %d", emptyPulses)
		}
		if usage.InputTokens != 100 || usage.OutputTokens != 20 {
			t.Fatalf("unexpected usage: %+v", usage)
		}
	})

	t.Run("tool_start_pulses_and_cancels", func(t *testing.T) {
		client := &scriptedEventClient{
			handler: func(_ context.Context, _ int, req provider.Request) ([]provider.Event, error) {
				return []provider.Event{
					provider.EventStart{Provider: "anthropic", Model: req.Model},
					provider.EventToolStart{ID: "tc1", Name: "bash"},
					provider.EventDone{Stop: provider.StopToolUse},
				}, nil
			},
		}
		a := NewAgent(client, "claude-opus-4-6", "sys", nil)
		pulses := 0
		_, _, _, err := a.streamSummarizerRequest(context.Background(), provider.Request{Model: "claude-opus-4-6"}, func(d string) {
			if d != "" {
				t.Fatalf("unexpected non-empty delta %q on tool start", d)
			}
			pulses++
		})
		if !errors.Is(err, errSummarizerToolCall) {
			t.Fatalf("expected errSummarizerToolCall, got %v", err)
		}
		if pulses < 2 {
			t.Fatalf("expected liveness pulses on EventStart and EventToolStart, got %d", pulses)
		}
	})
}

func TestEnsureSpanImageDigestsPulsesLivenessSink(t *testing.T) {
	client := &scriptedEventClient{
		handler: func(_ context.Context, _ int, req provider.Request) ([]provider.Event, error) {
			if req.System == VisionTranscriberSystemPrompt {
				return []provider.Event{
					provider.EventStart{Provider: "anthropic", Model: req.Model},
					provider.EventReasoningDelta{Delta: "examining screenshot"},
					provider.EventTextDelta{Delta: "- OCR: status 500"},
					provider.EventUsage{Usage: provider.Usage{InputTokens: 80, OutputTokens: 15}},
					provider.EventDone{Stop: provider.StopEnd},
				}, nil
			}
			return []provider.Event{
				provider.EventStart{Provider: "anthropic", Model: req.Model},
				provider.EventTextDelta{Delta: "## Goal\n- Summarized span with image."},
				provider.EventDone{Stop: provider.StopEnd},
			}, nil
		},
	}
	a := NewAgent(client, "claude-sonnet-4-6", "sys", nil)

	img1 := provider.ImageBlock{MimeType: "image/png", Data: []byte("img-bytes-1"), SourcePath: "a.png", Width: 800, Height: 600}
	img2 := provider.ImageBlock{MimeType: "image/png", Data: []byte("img-bytes-2"), SourcePath: "b.png", Width: 800, Height: 600}
	history := []provider.Message{
		{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "see img1"}, img1}},
		{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "ack1"}}},
		{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "see img2"}, img2}},
		{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "ack2"}}},
	}

	st := &CompactionState{}
	var pulses int
	// Deliberately non-atomic counter: ensureImageDigests must serialize sink calls across workers.
	a.ensureSpanImageDigestsAt(context.Background(), history, 0, 0, len(history), st, func(d string) {
		if d != "" {
			t.Errorf("expected empty liveness pulse during image digestion, got %q", d)
		}
		pulses++
	})
	if len(st.ImageDigests) != 2 {
		t.Fatalf("expected 2 image digests, got %d", len(st.ImageDigests))
	}
	if pulses < 6 {
		t.Fatalf("expected multiple liveness pulses across image transcription events, got %d", pulses)
	}
}

func TestReactiveCompactOverflowAndVisionShedEmitProgressPulses(t *testing.T) {
	var mainCalls atomic.Int32
	client := &scriptedEventClient{
		handler: func(_ context.Context, _ int, req provider.Request) ([]provider.Event, error) {
			if req.System == VisionTranscriberSystemPrompt {
				return []provider.Event{
					provider.EventStart{Provider: "anthropic", Model: req.Model},
					provider.EventReasoningDelta{Delta: "ocr thinking"},
					provider.EventTextDelta{Delta: "- OCR text"},
					provider.EventDone{Stop: provider.StopEnd},
				}, nil
			}
			if req.System == SummarizationSystemPrompt {
				return []provider.Event{
					provider.EventStart{Provider: "anthropic", Model: req.Model},
					provider.EventReasoningDelta{Delta: "summarizer thinking"},
					provider.EventTextDelta{Delta: "## Goal\n- Overflow summary."},
					provider.EventUsage{Usage: provider.Usage{InputTokens: 120, OutputTokens: 30}},
					provider.EventDone{Stop: provider.StopEnd},
				}, nil
			}
			if mainCalls.Add(1) == 1 {
				return nil, errors.New(`anthropic: http 400: maximum context length is 32000 tokens`)
			}
			return []provider.Event{
				provider.EventStart{Provider: "anthropic", Model: req.Model},
				provider.EventTextDelta{Delta: "recovered"},
				provider.EventDone{
					Stop:    provider.StopEnd,
					Message: provider.Message{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "recovered"}}},
				},
			}, nil
		},
	}

	a := NewAgent(client, "claude-opus-4-6", "sys", NewRegistry())
	var msgs []provider.Message
	for i := 0; i < 4; i++ {
		img := provider.ImageBlock{MimeType: "image/png", Data: []byte(fmt.Sprintf("raw-img-%d", i)), SourcePath: fmt.Sprintf("shot_%d.png", i), Width: 1024, Height: 768}
		msgs = append(msgs,
			provider.Message{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: fmt.Sprintf("u%d %s", i, strings.Repeat("a", 8000))}, img}},
			textMsg(provider.RoleAssistant, fmt.Sprintf("a%d %s", i, strings.Repeat("b", 8000))),
		)
	}
	a.SetMessages(msgs)

	emptyPulses := 0
	err := a.Prompt(context.Background(), "continue", nil, func(ev AgentEvent) {
		if tp, ok := ev.(EvToolProgress); ok && tp.ID == "" && tp.Text == "" {
			emptyPulses++
		}
	})
	if err != nil {
		t.Fatalf("Prompt failed: %v", err)
	}
	if emptyPulses == 0 {
		t.Fatalf("expected EvToolProgress{ID:\"\", Text:\"\"} liveness pulses during reactive CompactOverflow / shedWireImagesReactive, got 0")
	}
}

func TestReactiveCompactOverflowCancelSkipsPostCancelLatchAndRollup(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	client := &scriptedEventClient{
		handler: func(_ context.Context, _ int, req provider.Request) ([]provider.Event, error) {
			if req.System == SummarizationSystemPrompt {
				// Simulate user Stop / watchdog cancel arriving mid-CompactOverflow.
				cancel()
				return nil, context.Canceled
			}
			return nil, errors.New("context_length_exceeded: maximum context length is 32000 tokens")
		},
	}

	a := NewAgent(client, "claude-opus-4-6", "sys", NewRegistry())
	heavy := strings.Repeat("Z", ToolOutputMaxChars+6000)
	var msgs []provider.Message
	for i := 0; i < 4; i++ {
		msgs = append(msgs,
			textMsg(provider.RoleUser, fmt.Sprintf("turn %d", i)),
			textMsg(provider.RoleAssistant, fmt.Sprintf("ans %d", i)),
		)
	}
	c1, r1 := toolTurn("bash", `{"command":"cat big"}`, heavy)
	msgs = append(msgs, c1, r1)
	a.SetMessages(msgs)

	// Seed 2 active blocks so forceRollupActiveBlocks would merge them if called post-cancel,
	// and PrunedBefore=0 so latchOverflowTail would advance it if called post-cancel.
	seed := &CompactionState{
		Blocks: []FoldBlock{
			{ID: "b1", Tier: 1, StartIdx: 0, EndIdx: 2, Summary: "era 1"},
			{ID: "b2", Tier: 1, StartIdx: 2, EndIdx: 4, Summary: "era 2"},
		},
		NextBlockSeq: 2,
		Count:        2,
		PrunedBefore: 0,
	}
	seed.SyncMirrors()
	a.SeedCompactionState(seed)

	err := a.Prompt(ctx, "next", nil, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled when cancelled during CompactOverflow, got: %v", err)
	}
	after := a.CompactionChain()
	if after == nil {
		t.Fatal("expected seeded CompactionChain to remain intact")
	}
	if after.PrunedBefore != 0 {
		t.Fatalf("cancelled turn mutated PrunedBefore to %d (latchOverflowTail must not run post-cancel)", after.PrunedBefore)
	}
	if active := after.ActiveBlocks(); len(active) != 2 || active[0].ID != "b1" || active[1].ID != "b2" {
		t.Fatalf("cancelled turn rolled up active blocks post-cancel: %+v", active)
	}
}

// ---- 2. MaybeAutoCompactAt cancel propagation, attempt 0->1 fallback, <=6 msgs, Tier-2 ----

func TestMaybeAutoCompactAtPropagatesContextCancel(t *testing.T) {
	t.Run("pre_cancelled", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		a := NewAgent(&scriptableFakeClient{summaries: []string{"s"}}, "m", "", nil)
		a.SetMessages(bigTokenHistory(8))
		did, err := a.MaybeAutoCompactAt(ctx, 20000, 80, nil)
		if did || !errors.Is(err, context.Canceled) {
			t.Fatalf("pre-cancelled MaybeAutoCompactAt = (%v, %v), want (false, context.Canceled)", did, err)
		}
	})

	t.Run("cancelled_on_attempt_0", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		client := &scriptedEventClient{
			handler: func(_ context.Context, _ int, _ provider.Request) ([]provider.Event, error) {
				cancel()
				return nil, context.Canceled
			},
		}
		a := NewAgent(client, "m", "", nil)
		a.SetMessages(bigTokenHistory(8))
		did, err := a.MaybeAutoCompactAt(ctx, 20000, 80, nil)
		if did || !errors.Is(err, context.Canceled) {
			t.Fatalf("cancel on attempt 0 = (%v, %v), want (false, context.Canceled)", did, err)
		}
	})

	t.Run("cancelled_on_attempt_1_after_attempt_0_succeeded", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		var a *Agent
		client := &scriptedEventClient{
			handler: func(_ context.Context, _ int, req provider.Request) ([]provider.Event, error) {
				// Let attempt 0 commit its FoldBlock, then cancel as soon as attempt 1 starts.
				if a.CompactionChain() != nil {
					cancel()
					return nil, context.Canceled
				}
				return []provider.Event{
					provider.EventStart{Provider: "anthropic", Model: req.Model},
					provider.EventTextDelta{Delta: "first pass summary"},
					provider.EventDone{Stop: provider.StopEnd},
				}, nil
			},
		}
		a = NewAgent(client, "m", "", nil)
		// ~36k tokens across 12 pairs: attempt 0 keeps ~20k tail (still > target 9616
		// on a 26k window), committing b1, then attempt 1 begins and gets cancelled.
		a.SetMessages(bigTokenHistory(12))
		did, err := a.MaybeAutoCompactAt(ctx, 26000, 80, nil)
		if !did || !errors.Is(err, context.Canceled) {
			t.Fatalf("cancel on attempt 1 = (%v, %v), want (true, context.Canceled)", did, err)
		}
	})
}

func TestMaybeAutoCompactAtFallsThroughFromAttempt0UnderKeepFloorToAttempt1(t *testing.T) {
	// Window = 40,000, threshold 80% -> target = 23,616 (window - reserve 16,384).
	// Heavy system prompt (~12k tokens) + unfolded tail (~14k tokens across 8 msgs):
	// total ~26k > 23,616 (ShouldCompactAt == true), YET the 14k unfolded tail fits
	// strictly under hybridKeepFloor (>= 20,000), so attempt 0 fails with
	// "nothing to compact: transcript fits under the keep floor".
	// MaybeAutoCompactAt MUST NOT abort — it must fall through to attempt 1 (forceCut).
	client := &scriptableFakeClient{summaries: []string{"forced pass 1 summary", "forced pass 2 summary"}}
	bigSystem := strings.Repeat("system instruction word ", 12000)
	a := NewAgent(client, "m", bigSystem, nil)

	var msgs []provider.Message
	for i := 0; i < 4; i++ {
		msgs = append(msgs,
			textMsg(provider.RoleUser, fmt.Sprintf("u%d %s", i, strings.Repeat("hello ", 1500))),
			textMsg(provider.RoleAssistant, fmt.Sprintf("a%d %s", i, strings.Repeat("world ", 1500))),
		)
	}
	a.SetMessages(msgs)

	sys, tls, snap := a.ContextSnapshot()
	usedBefore := provider.ContextTokens(sys, tls, snap)
	tailOnly := provider.ContextTokens("", nil, msgs)
	if !ShouldCompactAt(40000, usedBefore, 80) {
		t.Fatalf("precondition failed: usedBefore=%d must exceed target %d", usedBefore, compactTargetTokens(40000, 80))
	}
	if tailOnly >= CompactionKeepRecentTokens {
		t.Fatalf("precondition failed: tailOnly=%d must fit under keep floor %d so attempt 0 fails", tailOnly, CompactionKeepRecentTokens)
	}

	did, err := a.MaybeAutoCompactAt(context.Background(), 40000, 80, nil)
	if err != nil {
		t.Fatalf("MaybeAutoCompactAt error: %v", err)
	}
	if !did {
		t.Fatalf("expected MaybeAutoCompactAt to fall through to attempt 1 and compact")
	}
	if a.CompactionChain() == nil || len(a.CompactionChain().ActiveBlocks()) == 0 {
		t.Fatalf("expected FoldBlock created by attempt 1 fallback, got %+v", a.CompactionChain())
	}
	sys, tls, snapAfter := a.ContextSnapshot()
	usedAfter := provider.ContextTokens(sys, tls, snapAfter)
	if usedAfter >= usedBefore {
		t.Fatalf("expected context tokens to drop: before=%d after=%d", usedBefore, usedAfter)
	}
}

func TestMaybeAutoCompactAtCompactsFewMessagesOverThresholdAndOver100Pct(t *testing.T) {
	t.Run("six_messages_over_100pct_window", func(t *testing.T) {
		client := &scriptableFakeClient{summaries: []string{"compacted 6-msg session", "pass 2"}}
		a := NewAgent(client, "m", "", nil)
		// Exactly 6 messages (<= CompactionMinMessages) totaling > 50k tokens on a 40k window (>100%!).
		var msgs []provider.Message
		for i := 0; i < 3; i++ {
			msgs = append(msgs,
				textMsg(provider.RoleUser, fmt.Sprintf("u%d %s", i, strings.Repeat("alpha ", 8000))),
				textMsg(provider.RoleAssistant, fmt.Sprintf("a%d %s", i, strings.Repeat("beta ", 8000))),
			)
		}
		a.SetMessages(msgs)

		sys, tls, snap := a.ContextSnapshot()
		usedBefore := provider.ContextTokens(sys, tls, snap)
		if usedBefore <= 40000 {
			t.Fatalf("precondition failed: want >100%% of 40k window, got %d", usedBefore)
		}

		did, err := a.MaybeAutoCompactAt(context.Background(), 40000, 80, nil)
		if err != nil || !did {
			t.Fatalf("MaybeAutoCompactAt on 6 msgs >100%% = (%v, %v), want (true, nil)", did, err)
		}
		sys, tls, snapAfter := a.ContextSnapshot()
		usedAfter := provider.ContextTokens(sys, tls, snapAfter)
		if usedAfter >= usedBefore {
			t.Fatalf("expected context reduction on 6-msg session: before=%d after=%d", usedBefore, usedAfter)
		}
	})

	t.Run("three_messages_with_giant_tool_result_latches_instead_of_deadlocking", func(t *testing.T) {
		client := &scriptableFakeClient{summaries: []string{"user prompt folded"}}
		a := NewAgent(client, "m", "", nil)
		giantOut := strings.Repeat("log line with diagnostics and stack trace\n", 4000) // >40k tokens
		asst, tool := toolTurn("bash", `{"command":"cat huge.log"}`, giantOut)
		a.SetMessages([]provider.Message{
			textMsg(provider.RoleUser, "inspect huge.log"),
			asst,
			tool,
		})

		sys, tls, snap := a.ContextSnapshot()
		usedBefore := provider.ContextTokens(sys, tls, snap)
		if usedBefore <= 30000 {
			t.Fatalf("precondition failed: want >30k tokens, got %d", usedBefore)
		}

		did, err := a.MaybeAutoCompactAt(context.Background(), 30000, 80, nil)
		if err != nil || !did {
			t.Fatalf("MaybeAutoCompactAt on 3-msg giant tool result = (%v, %v), want (true, nil)", did, err)
		}
		sys, tls, snapAfter := a.ContextSnapshot()
		usedAfter := provider.ContextTokens(sys, tls, snapAfter)
		if ShouldCompactAt(30000, usedAfter, 80) {
			t.Fatalf("expected latched giant tool result to drop under target %d, got %d", compactTargetTokens(30000, 80), usedAfter)
		}
	})
}

func TestTier2RollupRunsWhenLocalCutIsZeroAndMergesExcessiveTier2Blocks(t *testing.T) {
	t.Run("localCut_zero_triggers_tier2_rollup_when_blocks_exceed_budget", func(t *testing.T) {
		client := &scriptableFakeClient{summaries: []string{"## Goal\n- Consolidated 4 blocks.", "## Goal\n- Consolidated again."}}
		a := NewAgent(client, "m", "", nil)

		// 8 folded messages covered by 4 huge Tier-1 blocks + ONLY 1 unfolded user message (localCut == 0).
		var msgs []provider.Message
		for i := 0; i < 4; i++ {
			msgs = append(msgs, textMsg(provider.RoleUser, fmt.Sprintf("u%d", i)), textMsg(provider.RoleAssistant, fmt.Sprintf("a%d", i)))
		}
		msgs = append(msgs, textMsg(provider.RoleUser, "latest single message"))
		a.SetMessages(msgs)

		bigSummary := "## Progress\n" + strings.Repeat("detailed milestone note with file paths and metrics ", 600)
		var blocks []FoldBlock
		for i := 0; i < 4; i++ {
			blk := FoldBlock{
				ID:       fmt.Sprintf("b%d", i+1),
				Tier:     1,
				StartIdx: i * 2,
				EndIdx:   (i + 1) * 2,
				Summary:  bigSummary,
				RawTokens: 10000,
			}
			blk.BlockTokens = estimateFoldBlockTokens(blk)
			blocks = append(blocks, blk)
		}
		seed := &CompactionState{Blocks: blocks, NextBlockSeq: 4, Count: 4}
		seed.SyncMirrors()
		a.SeedCompactionState(seed)

		// Total context is ~16k-20k tokens across the 4 FoldBlocks + 1 msg;
		// set window=24000 (target = 7616, 15% = 3600).
		did, err := a.MaybeAutoCompactAt(context.Background(), 24000, 80, nil)
		if err != nil || !did {
			t.Fatalf("expected rollup-only compaction when localCut==0, got (%v, %v)", did, err)
		}
		active := a.CompactionChain().ActiveBlocks()
		if len(active) != 1 || active[0].Tier != 2 {
			t.Fatalf("expected 4 Tier-1 blocks to merge into 1 Tier-2 block with localCut==0, got %+v", active)
		}
		if a.CompactionChain().KeepFrom != 8 {
			t.Fatalf("KeepFrom shifted unexpectedly: got %d, want 8", a.CompactionChain().KeepFrom)
		}
	})

	t.Run("excessive_tier2_blocks_merge_and_truncate_unretires", func(t *testing.T) {
		client := &scriptableFakeClient{summaries: []string{"## Goal\n- Super-consolidated Tier-2 era."}}
		a := NewAgent(client, "m", "", nil)

		var msgs []provider.Message
		for i := 0; i < 18; i++ {
			msgs = append(msgs, textMsg(provider.RoleUser, fmt.Sprintf("u%d", i)))
		}
		msgs = append(msgs, textMsg(provider.RoleUser, "tail"))
		a.SetMessages(msgs)

		// 9 active Tier-2 blocks (> Tier2MergeBlockThreshold == 8), covering [0, 18).
		var blocks []FoldBlock
		for i := 0; i < 9; i++ {
			blk := FoldBlock{
				ID:            fmt.Sprintf("b%d", i+1),
				Tier:          2,
				StartIdx:      i * 2,
				EndIdx:        (i + 1) * 2,
				Topic:         fmt.Sprintf("Era %d", i+1),
				Summary:       fmt.Sprintf("Tier-2 era %d summary %s", i+1, strings.Repeat("details ", 40)),
				ModifiedFiles: []string{fmt.Sprintf("mod_%d.go", i+1)},
				RawTokens:     5000,
			}
			blk.BlockTokens = estimateFoldBlockTokens(blk)
			blocks = append(blocks, blk)
		}
		seed := &CompactionState{Blocks: blocks, NextBlockSeq: 9, Count: 9}
		seed.SyncMirrors()
		a.SeedCompactionState(seed)

		// Run maybeMergeTier2Blocks directly (and via localCut==0 Compact path).
		if _, err := a.Compact(context.Background(), 0, nil); err != nil {
			t.Fatalf("Compact with 9 Tier-2 blocks failed: %v", err)
		}
		chain := a.CompactionChain()
		active := chain.ActiveBlocks()
		// 9 - 4 retired + 1 new Tier-2 = 6 active blocks (<= 8).
		if len(active) != 6 {
			t.Fatalf("expected 9 Tier-2 blocks to merge down to 6 active blocks, got %d", len(active))
		}
		merged := active[0]
		if merged.Tier != 2 || merged.StartIdx != 0 || merged.EndIdx != 8 {
			t.Fatalf("unexpected merged Tier-2 block: %+v", merged)
		}
		for i := 1; i <= 4; i++ {
			if !containsString(merged.ModifiedFiles, fmt.Sprintf("mod_%d.go", i)) {
				t.Fatalf("merged Tier-2 block lost mod_%d.go: %v", i, merged.ModifiedFiles)
			}
		}

		// TruncateCompaction straddling the merged Tier-2 block [0, 8) at effectiveCut=5
		// must un-retire b1 ([0,2)) and b2 ([2,4)).
		trunc := TruncateCompaction(chain, 5)
		if trunc == nil {
			t.Fatal("expected non-nil TruncateCompaction")
		}
		truncActive := trunc.ActiveBlocks()
		if len(truncActive) != 2 || truncActive[0].ID != "b1" || truncActive[1].ID != "b2" {
			t.Fatalf("expected [b1, b2] un-retired after truncating merged Tier-2 block, got %+v", truncActive)
		}
	})
}

// ---- 3. Warm-prefix fork headroom skip & stopLen skipWarmFork latch ----

func TestWarmPrefixForkSkipsImmediatelyOnLowHeadroom(t *testing.T) {
	cases := []struct {
		name      string
		window    int
		reasoning string
		maxTokens int
	}{
		{
			name:      "plain_low_headroom_under_2048",
			window:    22000,
			reasoning: "",
			maxTokens: 8192,
		},
		{
			name:      "reasoning_high_low_headroom",
			window:    35000, // prefix ~22k -> headroom ~12.7k < 16384+1024
			reasoning: "high",
			maxTokens: 64000,
		},
		{
			name:      "prefix_exceeds_window",
			window:    18000, // prefix ~22k > window -> negative headroom
			reasoning: "",
			maxTokens: 8192,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var warmForkCalls, standaloneCalls atomic.Int32
			client := &scriptedEventClient{
				handler: func(_ context.Context, _ int, req provider.Request) ([]provider.Event, error) {
					isWarm := len(req.Messages) > 0 && req.Messages[len(req.Messages)-1].Meta["compaction"] == "summarizer_fork"
					if isWarm {
						warmForkCalls.Add(1)
					} else if req.System == SummarizationSystemPrompt {
						standaloneCalls.Add(1)
					}
					return []provider.Event{
						provider.EventStart{Provider: "anthropic", Model: req.Model},
						provider.EventTextDelta{Delta: "## Goal\n- Standalone summary succeeded."},
						provider.EventDone{Stop: provider.StopEnd},
					}, nil
				},
			}
			a := NewAgent(client, "claude-opus-4-6", "You are Indirect Code.", NewRegistry(stubLSMTool{name: "read"}))
			a.Reasoning = tc.reasoning
			a.MaxTokens = tc.maxTokens
			a.contextWindow = tc.window
			a.SetMessages(bigTokenHistory(8)) // ~22k-24k tokens

			summary, err := a.Compact(context.Background(), 2, nil)
			if err != nil {
				t.Fatalf("Compact failed: %v", err)
			}
			if !strings.Contains(summary, "Standalone summary succeeded.") {
				t.Fatalf("expected standalone summary, got: %q", summary)
			}
			if got := warmForkCalls.Load(); got != 0 {
				t.Fatalf("expected 0 warm-prefix fork calls when headroom is insufficient, got %d", got)
			}
			if got := standaloneCalls.Load(); got == 0 {
				t.Fatalf("expected standalone summarizer to run")
			}
		})
	}
}

func TestWarmPrefixForkLatchesSkipOnRepeatedStopLength(t *testing.T) {
	var warmForkCalls, standaloneCalls atomic.Int32
	client := &scriptedEventClient{
		handler: func(_ context.Context, _ int, req provider.Request) ([]provider.Event, error) {
			isWarm := len(req.Messages) > 0 && req.Messages[len(req.Messages)-1].Meta["compaction"] == "summarizer_fork"
			if isWarm {
				warmForkCalls.Add(1)
				return []provider.Event{
					provider.EventStart{Provider: "anthropic", Model: req.Model},
					provider.EventTextDelta{Delta: "truncated"},
					provider.EventDone{Stop: provider.StopLength},
				}, nil
			}
			standaloneCalls.Add(1)
			return []provider.Event{
				provider.EventStart{Provider: "anthropic", Model: req.Model},
				provider.EventTextDelta{Delta: "## Goal\n- Clean standalone summary."},
				provider.EventDone{Stop: provider.StopEnd},
			}, nil
		},
	}

	a := NewAgent(client, "claude-opus-4-6", "You are Indirect Code.", NewRegistry(stubLSMTool{name: "read"}))
	// Build a split-turn transcript that produces TWO summarizeChunkWithWarmOpt calls
	// (prior history chunk + split-turn prefix chunk) in a single Compact pass.
	var msgs []provider.Message
	msgs = append(msgs,
		textMsg(provider.RoleUser, "turn 1 task"),
		textMsg(provider.RoleAssistant, "turn 1 complete"),
		textMsg(provider.RoleUser, "turn 2 huge work"),
	)
	for i := 0; i < 4; i++ {
		c, r := toolTurn("read", fmt.Sprintf(`{"path":"f%d.go"}`, i), "file contents")
		msgs = append(msgs, c, r)
	}
	a.SetMessages(msgs)

	summary, err := a.Compact(context.Background(), 2, nil)
	if err != nil {
		t.Fatalf("Compact failed: %v", err)
	}
	if !strings.Contains(summary, "Clean standalone summary.") {
		t.Fatalf("expected standalone fallback summary, got:\n%s", summary)
	}
	// Chunk 1 tries warm-fork (1) + conciseRetry warm-fork (2) -> both StopLength -> latches skipWarmFork=true!
	// Chunk 2 (split-turn prefix) MUST skip warm-fork completely (0 warm calls) and go straight to standalone!
	if got := warmForkCalls.Load(); got != 2 {
		t.Fatalf("expected exactly 2 warm-fork calls (initial + conciseRetry on chunk 1, then latched skip), got %d", got)
	}
	if got := standaloneCalls.Load(); got != 2 {
		t.Fatalf("expected 2 standalone calls (chunk 1 fallback + chunk 2 direct), got %d", got)
	}
}

// ---- 4. Pair-safety in FindCutPointMsgs / ownsToolCall / adjustPairSafeLocalCut / sliceFoldSpans & orphan repair ----

func TestOwnsToolCallInvariant(t *testing.T) {
	group := parallelToolGroup("inv", 3, 50)
	msgs := append([]provider.Message{textMsg(provider.RoleUser, "run tools")}, group...)

	// RoleTool messages at indices 2, 3, 4 NEVER own their own tool calls,
	// even though msgs[1] is an assistant ToolCallBlock right before them!
	for idx := 2; idx < len(msgs); idx++ {
		if ownsToolCall(msgs, idx) {
			t.Fatalf("ownsToolCall(msgs, %d) = true for RoleTool message; must be false (must not look backward into folded prefix)", idx)
		}
	}

	// Self-contained hybrid assistant carrying both matching ToolCallBlock and ToolResultBlock.
	hybrid := []provider.Message{
		{
			Role: provider.RoleAssistant,
			Content: []provider.Content{
				provider.ToolCallBlock{ID: "self_1", Name: "calc"},
				provider.ToolResultBlock{CallID: "self_1", Content: []provider.Content{provider.TextBlock{Text: "42"}}},
			},
		},
	}
	if !ownsToolCall(hybrid, 0) {
		t.Fatalf("expected ownsToolCall=true for self-contained assistant message")
	}

	// Assistant carrying ToolResultBlock without matching ToolCallBlock.
	unmatched := []provider.Message{
		{
			Role: provider.RoleAssistant,
			Content: []provider.Content{
				provider.ToolResultBlock{CallID: "missing_1", Content: []provider.Content{provider.TextBlock{Text: "42"}}},
			},
		},
	}
	if ownsToolCall(unmatched, 0) {
		t.Fatalf("expected ownsToolCall=false for assistant with unmatched ToolResultBlock")
	}
}

func TestFindCutPointMsgsNeverSplitsParallelToolCalls(t *testing.T) {
	for _, n := range []int{1, 3, 5, 10} {
		t.Run(fmt.Sprintf("N=%d_with_prefix_and_suffix", n), func(t *testing.T) {
			var msgs []provider.Message
			msgs = append(msgs,
				textMsg(provider.RoleUser, "early turn "+strings.Repeat("u", 2000)),
				textMsg(provider.RoleAssistant, "early reply "+strings.Repeat("a", 2000)),
				textMsg(provider.RoleUser, "run parallel reads"),
			)
			msgs = append(msgs, parallelToolGroup("p", n, 3000)...)
			msgs = append(msgs,
				textMsg(provider.RoleAssistant, "summarized all reads "+strings.Repeat("d", 1000)),
				textMsg(provider.RoleUser, "follow up"),
				textMsg(provider.RoleAssistant, "done"),
			)

			total, perMsg := provider.ContextTokensByMessage("", nil, msgs)
			for keep := 1; keep <= total+500; keep += max(1, total/40) {
				cut := FindCutPointMsgs(msgs, keep, perMsg)
				assertNoOrphanedToolResultsInTail(t, msgs, cut.Index)
				if cut.Index > 0 && cut.Index < len(msgs) && isToolResultHead(msgs[cut.Index]) && !ownsToolCall(msgs, cut.Index) {
					t.Fatalf("N=%d keep=%d: cut.Index=%d landed on RoleTool/ToolResultHead", n, keep, cut.Index)
				}
			}
		})

		t.Run(fmt.Sprintf("N=%d_at_index_zero_with_trailing", n), func(t *testing.T) {
			msgs := parallelToolGroup("z", n, 3000)
			msgs = append(msgs,
				textMsg(provider.RoleUser, "after parallel group"),
				textMsg(provider.RoleAssistant, "continuing"),
			)
			total, perMsg := provider.ContextTokensByMessage("", nil, msgs)
			for keep := 1; keep <= total+500; keep += max(1, total/30) {
				cut := FindCutPointMsgs(msgs, keep, perMsg)
				assertNoOrphanedToolResultsInTail(t, msgs, cut.Index)
				// When a cut happens, it must fold the entire [0..n] group and start at >= n+1.
				if cut.Index != 0 && cut.Index < n+1 {
					t.Fatalf("N=%d keep=%d: cut.Index=%d split tool group starting at 0 (want 0 or >=%d)", n, keep, cut.Index, n+1)
				}
			}
		})

		t.Run(fmt.Sprintf("N=%d_entire_transcript_is_one_tool_group", n), func(t *testing.T) {
			msgs := parallelToolGroup("only", n, 3000)
			total, perMsg := provider.ContextTokensByMessage("", nil, msgs)
			for keep := 0; keep <= total+500; keep += max(1, total/20) {
				cut := FindCutPointMsgs(msgs, keep, perMsg)
				if cut.Index != 0 {
					t.Fatalf("N=%d keep=%d: inseparable tool group returned cut.Index=%d, want 0", n, keep, cut.Index)
				}
			}
			// adjustPairSafeLocalCut and oldestGroupStartAt must also refuse to split.
			for mid := 1; mid < len(msgs); mid++ {
				if adj := adjustPairSafeLocalCut(msgs, mid); adj != 0 {
					t.Fatalf("N=%d adjustPairSafeLocalCut(%d) = %d, want 0", n, mid, adj)
				}
				if og := oldestGroupStartAt(msgs, mid); og != 0 {
					t.Fatalf("N=%d oldestGroupStartAt(%d) = %d, want 0", n, mid, og)
				}
			}
		})
	}

	t.Run("interleaved_user_notice_inside_parallel_tool_results", func(t *testing.T) {
		group := parallelToolGroup("bg", 3, 2000)
		// [User(0), Asst(bg_1..bg_3)(1), Tool(bg_1)(2), User(bg notice)(3), Tool(bg_2)(4), Tool(bg_3)(5), Asst(6)]
		msgs := []provider.Message{
			textMsg(provider.RoleUser, "start"),
			group[0],
			group[1],
			{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "background job completed"}}, Meta: map[string]string{"background_delivery": "j1"}},
			group[2],
			group[3],
			textMsg(provider.RoleAssistant, "finished"),
		}
		for cand := 1; cand < len(msgs); cand++ {
			adj := adjustPairSafeLocalCut(msgs, cand)
			assertNoOrphanedToolResultsInTail(t, msgs, adj)
		}
		total, perMsg := provider.ContextTokensByMessage("", nil, msgs)
		for keep := 1; keep <= total; keep += max(1, total/25) {
			cut := FindCutPointMsgs(msgs, keep, perMsg)
			assertNoOrphanedToolResultsInTail(t, msgs, cut.Index)
		}
	})
}

func TestFindCutPointMsgsAndSliceFoldSpansHandleAlignedAndMisalignedPerMsg(t *testing.T) {
	// Include reasoning-only assistant messages (nil wire content -> 0 tokens in aligned perMsg,
	// skipped in misaligned perMsg) alongside parallel tool calls.
	var msgs []provider.Message
	for i := 0; i < 4; i++ {
		msgs = append(msgs,
			textMsg(provider.RoleUser, fmt.Sprintf("prompt %d %s", i, strings.Repeat("q", 2500))),
			provider.Message{Role: provider.RoleAssistant, Content: []provider.Content{provider.ReasoningBlock{Summary: "private thinking summary"}}},
		)
		msgs = append(msgs, parallelToolGroup(fmt.Sprintf("g%d", i), 4, 2500)...)
		msgs = append(msgs, textMsg(provider.RoleAssistant, fmt.Sprintf("done %d", i)))
	}

	// Build an explicitly 1:1 aligned perMsg slice (with 0 for reasoning-only rows)
	// AND a deliberately shortened/misaligned perMsg slice (omitting 0s).
	aligned := make([]int, len(msgs))
	var misaligned []int
	for i, m := range msgs {
		if len(m.Content) == 1 {
			if _, isReason := m.Content[0].(provider.ReasoningBlock); isReason {
				aligned[i] = 0
				continue
			}
		}
		tok := provider.ContextTokens("", nil, msgs[i:i+1])
		aligned[i] = tok
		misaligned = append(misaligned, tok)
	}
	if len(misaligned) == len(aligned) {
		t.Fatal("precondition failed: misaligned slice must be shorter than msgs")
	}

	cutAligned := FindCutPointMsgs(msgs, 5000, aligned)
	cutMisaligned := FindCutPointMsgs(msgs, 5000, misaligned)
	assertNoOrphanedToolResultsInTail(t, msgs, cutAligned.Index)
	assertNoOrphanedToolResultsInTail(t, msgs, cutMisaligned.Index)
	if cutAligned.Index <= 0 || cutMisaligned.Index <= 0 {
		t.Fatalf("expected positive cuts: aligned=%+v misaligned=%+v", cutAligned, cutMisaligned)
	}

	// sliceFoldSpans with targetTokens small enough to force multiple spans across parallel tool calls.
	spans := sliceFoldSpans(msgs, 0, len(msgs), 4000)
	if len(spans) < 2 {
		t.Fatalf("expected >=2 spans, got %d", len(spans))
	}
	for i, sp := range spans {
		if sp[0] >= sp[1] {
			t.Fatalf("empty/inverted span %d: %v", i, sp)
		}
		if i > 0 && sp[0] != spans[i-1][1] {
			t.Fatalf("non-contiguous spans: %v then %v", spans[i-1], sp)
		}
		if sp[1] < len(msgs) {
			assertNoOrphanedToolResultsInTail(t, msgs, sp[1])
		}
	}
}

func TestBuildContextAndContextSnapshotStripOrphanedToolResults(t *testing.T) {
	a := NewAgent(nil, "claude-opus-4-6", "sys", NewRegistry())

	// Simulate a transcript where a prior legacy compaction anchor (KeepFrom=2)
	// split an assistant with 3 parallel tool calls away from 2 of its RoleTool results,
	// leaving ~20k phantom tokens of orphaned RoleTool messages in the tail.
	group := parallelToolGroup("legacy", 3, 25000)
	history := []provider.Message{
		textMsg(provider.RoleUser, "old task"),
		group[0], // idx 1: Asst(legacy_1, legacy_2, legacy_3)
		group[1], // idx 2: Tool(legacy_1) -> orphaned when KeepFrom=2!
		group[2], // idx 3: Tool(legacy_2) -> orphaned when KeepFrom=2!
		group[3], // idx 4: Tool(legacy_3) -> orphaned when KeepFrom=2!
		textMsg(provider.RoleUser, "current question"),
		textMsg(provider.RoleAssistant, "current answer"),
	}
	a.SetMessages(history)
	a.SeedCompactionState(&CompactionState{
		Blocks: []FoldBlock{
			{ID: "b1", Tier: 1, StartIdx: 0, EndIdx: 2, Summary: "old summary"},
		},
		KeepFrom:     2,
		NextBlockSeq: 1,
		Count:        1,
	})

	sys, tls, snapMsgs := a.ContextSnapshot()
	for i, m := range snapMsgs {
		if m.Role == provider.RoleTool {
			t.Fatalf("ContextSnapshot leaked orphaned RoleTool at index %d: %+v", i, m)
		}
	}

	snapTokens := provider.ContextTokens(sys, tls, snapMsgs)
	wireTokens := provider.ContextTokens(sys, tls, provider.RepairOrphanedToolResults(snapMsgs))
	if snapTokens != wireTokens {
		t.Fatalf("ContextSnapshot token drift vs RepairOrphanedToolResults: snap=%d wire=%d", snapTokens, wireTokens)
	}
	rawTailTokens := provider.ContextTokens(sys, tls, history[2:])
	if snapTokens >= rawTailTokens/5 {
		t.Fatalf("ContextSnapshot still counted phantom orphaned RoleTool tokens: snap=%d rawTail=%d", snapTokens, rawTailTokens)
	}
	// History must remain untouched (append-only contract).
	if len(a.History()) != len(history) {
		t.Fatalf("BuildContext/ContextSnapshot mutated History: %d -> %d", len(history), len(a.History()))
	}
}
