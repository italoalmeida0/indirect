package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"indirect/indirect-code-daemon/packages/core"
	"indirect/indirect-code-daemon/packages/provider"
)

type heartbeatingSlowTool struct {
	runs atomic.Int32
}

func (t *heartbeatingSlowTool) Name() string        { return "search" }
func (t *heartbeatingSlowTool) Description() string { return "slow heartbeating search" }
func (t *heartbeatingSlowTool) Schema() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{}}`)
}

func (t *heartbeatingSlowTool) Execute(ctx context.Context, _ json.RawMessage, progress func(string)) (core.ToolResult, error) {
	t.runs.Add(1)
	// Run > 3x tuneWaitTool while emitting empty liveness heartbeats every 20ms.
	for i := 0; i < 12; i++ {
		select {
		case <-ctx.Done():
			return core.ToolResult{}, ctx.Err()
		case <-time.After(20 * time.Millisecond):
			if progress != nil {
				progress("")
			}
		}
	}
	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: "scan complete"}},
	}, nil
}

func TestWatchdogSparesHeartbeatingToolPastInitialToolWait(t *testing.T) {
	prevWatch := tuneWatchEvery
	prevWaitTool := tuneWaitTool
	tuneWatchEvery = 30 * time.Millisecond
	tuneWaitTool = 70 * time.Millisecond
	defer func() {
		tuneWatchEvery = prevWatch
		tuneWaitTool = prevWaitTool
	}()

	var step atomic.Int32
	srv := reviewGateway(t, func(w http.ResponseWriter, _ *http.Request) {
		n := step.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		if n == 1 {
			_, _ = w.Write([]byte("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"m\",\"usage\":{\"input_tokens\":10}}}\n\n"))
			_, _ = w.Write([]byte("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tc_hb\",\"name\":\"search\"}}\n\n"))
			_, _ = w.Write([]byte("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"pattern\\\":\\\"x\\\"}\"}}\n\n"))
			_, _ = w.Write([]byte("event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n"))
			_, _ = w.Write([]byte("event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":5}}\n\n"))
			_, _ = w.Write([]byte("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"))
			return
		}
		reviewTextSSE(w)
	})

	var emptyToolProgressFrames atomic.Int32
	a := reviewActor(t)
	a.supCfg.store(&DaemonConfig{HostID: "h", GatewayURL: srv.URL, Settings: HarnessSettings{NoAutoTitle: true}})
	a.rec.Options = SessionOptions{Access: "full", Mode: "talk", Effort: "none"}

	sup := newSessionSupervisor(a.store.dataDir, a.supCfg, nil, nil)
	sup.resident[a.id] = &residentEntry{handle: &sessionHandle{inbox: a.inbox, control: a.control, done: a.done}}

	// Configure running state BEFORE starting actor goroutine (race-free).
	a.gen = 1
	a.state = stateRunning
	snap, env := snapshotTurn(a, 1, "test", nil)
	origEmit := env.emit
	env.emit = func(v any) {
		if m, ok := v.(map[string]any); ok && m["type"] == "agent_event" {
			if ev, ok := m["event"].(map[string]any); ok && ev["type"] == "tool_progress" && ev["text"] == "" {
				emptyToolProgressFrames.Add(1)
			}
		}
		if origEmit != nil {
			origEmit(v)
		}
	}
	go a.run()
	defer func() { a.control <- shutdownMsg{}; <-a.done }()

	// Test handleEvent directly on a turnBridge wired to the live actor so we
	// verify empty progress heartbeats extend WaitUntil without WS noise.
	tb := &turnBridge{
		env:       env,
		snap:      snap,
		cfg:       *a.supCfg.load(),
		ctx:       context.Background(),
		toolNames: map[string]string{"tc_hb": "search"},
	}
	_ = srv

	tb.handleEvent(core.EvToolExecutionStart{ID: "tc_hb", Name: "search", StartedAt: time.Now().UnixMilli()})
	for i := 0; i < 6; i++ {
		time.Sleep(45 * time.Millisecond)
		tb.handleEvent(core.EvToolProgress{ID: "tc_hb", Text: ""})
		sup.watchdogRound()
	}

	repCh := make(chan any, 1)
	a.control <- watchdogPingMsg{Reply: repCh}
	rep := (<-repCh).(watchdogReport)
	if rep.State != stateRunning {
		t.Fatalf("expected actor to remain stateRunning across heartbeating tool (>3x tuneWaitTool), got %s", rep.State)
	}
	if emptyToolProgressFrames.Load() != 0 {
		t.Fatalf("empty heartbeat progress must not emit WS frames, got %d", emptyToolProgressFrames.Load())
	}
}

func flushActorInbox(t *testing.T, a *sessionActor) {
	t.Helper()
	flushed := make(chan struct{})
	a.inbox <- Envelope{Payload: hookMsg{fn: func() { close(flushed) }}}
	select {
	case <-flushed:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for actor inbox flush")
	}
}

func TestWatchdogWaitClearRefreshesLastProgress(t *testing.T) {
	prevWatch := tuneWatchEvery
	prevWaitProvider := tuneWaitProvider
	tuneWatchEvery = 30 * time.Millisecond
	tuneWaitProvider = 250 * time.Millisecond
	defer func() {
		tuneWatchEvery = prevWatch
		tuneWaitProvider = prevWaitProvider
	}()

	a := reviewActor(t)
	a.gen = 1
	a.state = stateRunning
	a.workerDone = make(chan struct{})
	var closeOnce sync.Once
	a.cancel = func() { closeOnce.Do(func() { close(a.workerDone) }) }
	// Simulate lastProgress already older than 2*tuneWatchEvery while a declared
	// wait (e.g. compaction or silent provider request) was in flight.
	oldProgress := time.Now().Add(-time.Hour).UnixMilli()
	a.lastProgress = oldProgress
	a.waitOp = "provider"
	a.waitUntil = time.Now().Add(tuneWaitProvider).UnixMilli()

	sup := newSessionSupervisor(a.store.dataDir, a.supCfg, nil, nil)
	sup.resident[a.id] = &residentEntry{handle: &sessionHandle{inbox: a.inbox, control: a.control, done: a.done}}
	go a.run()
	defer func() { a.control <- shutdownMsg{}; <-a.done }()

	// Stale generation wait clear must NOT touch lastProgress or clear the active wait.
	a.inbox <- Envelope{Payload: workerWaitMsg{gen: 99, op: "", until: 0}}
	flushActorInbox(t, a)
	repStale := sup.ping(a.id)
	if repStale == nil || repStale.WaitOp != "provider" || repStale.LastProgress != oldProgress {
		t.Fatalf("stale-gen workerWaitMsg mutated actor state: %+v", repStale)
	}

	// Valid wait clear refreshes lastProgress so the immediate watchdog tick
	// after waitLive flips to false does NOT trip watchdog_stale.
	beforeClear := time.Now().UnixMilli()
	a.inbox <- Envelope{Payload: workerWaitMsg{gen: 1, op: "", until: 0}}
	flushActorInbox(t, a)
	repAfterClear := sup.ping(a.id)
	if repAfterClear == nil {
		t.Fatal("ping returned nil")
	}
	if repAfterClear.WaitOp != "" || repAfterClear.WaitUntil != 0 {
		t.Fatalf("expected wait cleared, got %+v", repAfterClear)
	}
	if repAfterClear.LastProgress < beforeClear {
		t.Fatalf("expected workerWaitMsg clear to refresh lastProgress >= %d, got %d", beforeClear, repAfterClear.LastProgress)
	}

	sup.watchdogRound()
	repAfterWD := sup.ping(a.id)
	if repAfterWD == nil || repAfterWD.State != stateRunning {
		t.Fatalf("watchdog falsely cancelled healthy turn right after declared wait cleared: %+v", repAfterWD)
	}
}

func TestWatchdogSparesEmptyProviderProgressLivenessPulses(t *testing.T) {
	prevWatch := tuneWatchEvery
	prevWaitProvider := tuneWaitProvider
	tuneWatchEvery = 30 * time.Millisecond
	tuneWaitProvider = 80 * time.Millisecond
	defer func() {
		tuneWatchEvery = prevWatch
		tuneWaitProvider = prevWaitProvider
	}()

	var emittedFrames atomic.Int32
	a := reviewActor(t)
	a.supCfg.store(&DaemonConfig{HostID: "h", Settings: HarnessSettings{NoAutoTitle: true}})
	a.gen = 1
	a.state = stateRunning
	a.workerDone = make(chan struct{})
	var closeOnce sync.Once
	a.cancel = func() { closeOnce.Do(func() { close(a.workerDone) }) }
	a.wsSend = func(v any) {
		if m, ok := v.(map[string]any); ok && m["type"] == "agent_event" {
			if ev, ok := m["event"].(map[string]any); ok {
				if ev["type"] == "compact_progress" || ev["type"] == "tool_progress" {
					emittedFrames.Add(1)
				}
			}
		}
	}

	sup := newSessionSupervisor(a.store.dataDir, a.supCfg, nil, nil)
	sup.resident[a.id] = &residentEntry{handle: &sessionHandle{inbox: a.inbox, control: a.control, done: a.done}}
	snap, env := snapshotTurn(a, 1, "test", nil)
	go a.run()
	defer func() { a.control <- shutdownMsg{}; <-a.done }()

	tb := &turnBridge{
		env:  env,
		snap: snap,
		cfg:  *a.supCfg.load(),
		ctx:  context.Background(),
	}

	// Clearing a previous wait must NOT throttle the very next empty liveness pulse.
	tb.declareWait("provider", time.Now().Add(tuneWaitProvider))
	tb.declareWait("", time.Time{})
	tb.handleEvent(core.EvToolProgress{ID: "", Text: ""})
	flushActorInbox(t, a)
	if rep := sup.ping(a.id); rep == nil || rep.WaitOp != "provider" || rep.WaitUntil <= time.Now().UnixMilli() {
		t.Fatalf("expected immediate provider wait re-declaration after clear, got %+v", rep)
	}

	// Repeated empty provider liveness pulses over >3x tuneWaitProvider keep the wait alive.
	for i := 0; i < 8; i++ {
		time.Sleep(35 * time.Millisecond)
		tb.handleEvent(core.EvToolProgress{ID: "", Text: ""})
		flushActorInbox(t, a)
		sup.watchdogRound()
	}

	rep := sup.ping(a.id)
	if rep == nil || rep.State != stateRunning {
		t.Fatalf("expected actor to remain stateRunning across empty provider pulses, got %+v", rep)
	}
	if rep.WaitOp != "provider" || rep.WaitUntil <= time.Now().UnixMilli() {
		t.Fatalf("expected live provider wait extended by empty pulses, got %+v", rep)
	}
	if emittedFrames.Load() != 0 {
		t.Fatalf("empty provider liveness pulses must not emit WS frames, got %d", emittedFrames.Load())
	}
}

func makeMessagesOfApproxTokens(targetTokens int) []provider.Message {
	// Keep at least 10 messages so compaction cut logic has multiple turns.
	const pairs = 6
	chunkWords := max(20, targetTokens/(pairs*2))
	// "token " is ~1 token per repetition; construct deterministic text.
	unit := strings.Repeat("alpha ", chunkWords)
	msgs := make([]provider.Message, 0, pairs*2)
	for i := 0; i < pairs; i++ {
		msgs = append(msgs,
			provider.Message{Role: provider.RoleUser, TurnIndex: i + 1, Content: []provider.Content{provider.TextBlock{Text: unit}}},
			provider.Message{Role: provider.RoleAssistant, TurnIndex: i + 1, Content: []provider.Content{provider.TextBlock{Text: unit}}},
		)
	}
	return msgs
}

func TestAutoCompactSkipsBelowThresholdOnReasoningModel(t *testing.T) {
	// 100k reasoning model (DefaultReasoningOutputTokenMax = 64k): old bug
	// computed usable = 100000 - 64000 - 20000 = 16000 (16%), causing banner
	// flicker and duplicate btdby4 work on every step from 16%..79%.
	for _, approxTok := range []int{22000, 50000, 72000} {
		client := &noopStreamClient{}
		ag := core.NewAgent(client, "r-model", "sys", core.NewRegistry())
		ag.SetMessages(makeMessagesOfApproxTokens(approxTok))

		system, tls, msgs := ag.ContextSnapshot()
		used := provider.ContextTokens(system, tls, msgs)
		if used <= 16000 || used >= 80000 {
			t.Fatalf("test setup expected 16000 < used < 80000, got used=%d (approxTok=%d)", used, approxTok)
		}

		var cfgCell configCell
		cfgCell.store(&DaemonConfig{HostID: "h", Settings: HarnessSettings{AutoCompactThreshold: 80}})
		var progressEvents []core.EvToolProgress
		var emitted []map[string]any
		w := &turnBridge{
			ctx:       context.Background(),
			cfg:       *cfgCell.load(),
			env:       workerEnv{cfg: &cfgCell, actorID: "s1", emit: func(v any) {
				if m, ok := v.(map[string]any); ok {
					emitted = append(emitted, m)
				}
			}},
			modelInfo: provider.Model{ID: "r-model", ContextWindow: 100000, Reasoning: true},
			agent:     ag,
		}
		if err := w.autoCompact(context.Background(), func(ev core.AgentEvent) {
			if tp, ok := ev.(core.EvToolProgress); ok {
				progressEvents = append(progressEvents, tp)
			}
			w.handleEvent(ev)
		}); err != nil {
			t.Fatalf("autoCompact(used=%d) returned error: %v", used, err)
		}
		if client.calls != 0 || ag.CompactionChain() != nil {
			t.Fatalf("used=%d (%.1f%% of 100k, threshold=80%%) must NOT trigger compaction: calls=%d chain=%+v",
				used, float64(used)*100/100000, client.calls, ag.CompactionChain())
		}
		if len(progressEvents) != 0 || len(emitted) != 0 {
			t.Fatalf("used=%d below threshold must NOT emit compact_progress banner: progress=%+v emitted=%+v",
				used, progressEvents, emitted)
		}
	}

	// Above threshold (>80k on 100k reasoning model): MUST trigger cleanly.
	client := &noopStreamClient{}
	ag := core.NewAgent(client, "r-model", "sys", core.NewRegistry())
	ag.SetMessages(makeMessagesOfApproxTokens(86000))
	system, tls, msgs := ag.ContextSnapshot()
	used := provider.ContextTokens(system, tls, msgs)
	if used <= 80000 {
		t.Fatalf("test setup expected used > 80000, got %d", used)
	}
	var cfgCell configCell
	cfgCell.store(&DaemonConfig{HostID: "h", Settings: HarnessSettings{AutoCompactThreshold: 80}})
	var sawCompactBanner bool
	w := &turnBridge{
		ctx:       context.Background(),
		cfg:       *cfgCell.load(),
		env:       workerEnv{cfg: &cfgCell, actorID: "s1", emit: func(any) {}},
		modelInfo: provider.Model{ID: "r-model", ContextWindow: 100000, Reasoning: true},
		agent:     ag,
	}
	ag.OnCompactionState = w.onCompactionState
	if err := w.autoCompact(context.Background(), func(ev core.AgentEvent) {
		if tp, ok := ev.(core.EvToolProgress); ok && tp.Text == "Compacting older context…" {
			sawCompactBanner = true
		}
		w.handleEvent(ev)
	}); err != nil {
		t.Fatalf("autoCompact(used=%d) failed: %v", used, err)
	}
	if !sawCompactBanner || client.calls == 0 || ag.CompactionChain() == nil {
		t.Fatalf("expected autoCompact to trigger above threshold (used=%d): banner=%v calls=%d chain=%+v",
			used, sawCompactBanner, client.calls, ag.CompactionChain())
	}
}

func TestAutoCompactRespectsEffectiveContextWindow(t *testing.T) {
	client := &noopStreamClient{}
	ag := core.NewAgent(client, "aliased-model", "sys", core.NewRegistry())
	ag.SetMessages(makeMessagesOfApproxTokens(36000))
	// Configured window is 200k (36k is 18%), but learned upstream ceiling is 40k (36k is 90% > 80%).
	ag.SeedCompactionState(&core.CompactionState{
		LearnedContextWindow: 40000,
		LearnedContextModel:  "aliased-model",
	})

	var cfgCell configCell
	cfgCell.store(&DaemonConfig{HostID: "h", Settings: HarnessSettings{AutoCompactThreshold: 80}})
	w := &turnBridge{
		ctx:       context.Background(),
		cfg:       *cfgCell.load(),
		env:       workerEnv{cfg: &cfgCell, actorID: "s-eff", emit: func(any) {}},
		modelInfo: provider.Model{ID: "aliased-model", ContextWindow: 200000, Reasoning: true},
		agent:     ag,
	}
	if err := w.autoCompact(context.Background(), func(core.AgentEvent) {}); err != nil {
		t.Fatalf("autoCompact failed: %v", err)
	}
	if client.calls == 0 {
		t.Fatal("expected autoCompact to honor Agent.EffectiveContextWindow (learned 40k ceiling)")
	}
}

func TestAutoCompactClearsBannerWhenNothingCompacted(t *testing.T) {
	client := &noopStreamClient{}
	ag := core.NewAgent(client, "m", "sys", core.NewRegistry())
	// Single huge message > 80% of 8k window: ShouldCompactAt is true, but
	// MaybeAutoCompactAt cannot fold a 1-message transcript and returns (false, nil).
	ag.SetMessages([]provider.Message{
		{Role: provider.RoleUser, TurnIndex: 1, Content: []provider.Content{provider.TextBlock{Text: strings.Repeat("word ", 7500)}}},
	})

	var cfgCell configCell
	cfgCell.store(&DaemonConfig{HostID: "h", Settings: HarnessSettings{AutoCompactThreshold: 80}})
	var compactTexts []string
	w := &turnBridge{
		ctx:  context.Background(),
		cfg:  *cfgCell.load(),
		snap: workerSnapshot{turnIndex: 1},
		env: workerEnv{cfg: &cfgCell, actorID: "s-clear", emit: func(v any) {
			if m, ok := v.(map[string]any); ok && m["type"] == "agent_event" {
				if ev, ok := m["event"].(map[string]any); ok && ev["type"] == "compact_progress" {
					if txt, ok := ev["text"].(string); ok {
						compactTexts = append(compactTexts, txt)
					}
				}
			}
		}},
		modelInfo: provider.Model{ID: "m", ContextWindow: 8000},
		agent:     ag,
	}
	if err := w.autoCompact(context.Background(), func(ev core.AgentEvent) { w.handleEvent(ev) }); err != nil {
		t.Fatalf("autoCompact returned unexpected error: %v", err)
	}
	if len(compactTexts) != 2 || compactTexts[0] != "Compacting older context…" || compactTexts[1] != "" {
		t.Fatalf("expected compact_progress start followed by explicit empty clear, got %q", compactTexts)
	}
}

type blockingCancelClient struct {
	started chan struct{}
}

func (c *blockingCancelClient) Name() string { return "anthropic" }

func (c *blockingCancelClient) Stream(ctx context.Context, _ provider.Request) (<-chan provider.Event, error) {
	select {
	case c.started <- struct{}{}:
	default:
	}
	<-ctx.Done()
	return nil, ctx.Err()
}

type slowPulsingSummaryClient struct {
	delay time.Duration
	ticks int
}

func (c *slowPulsingSummaryClient) Name() string { return "anthropic" }

func (c *slowPulsingSummaryClient) Stream(ctx context.Context, _ provider.Request) (<-chan provider.Event, error) {
	ch := make(chan provider.Event, c.ticks+2)
	go func() {
		defer close(ch)
		for i := 0; i < c.ticks; i++ {
			select {
			case <-ctx.Done():
				ch <- provider.EventDone{Err: ctx.Err(), Stop: provider.StopAborted}
				return
			case <-time.After(c.delay):
				ch <- provider.EventTextDelta{Delta: "ok "}
			}
		}
		msg := provider.Message{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "## Goal\n- Compacted slowly."}}}
		ch <- provider.EventDone{Message: msg}
	}()
	return ch, nil
}

func TestAutoCompactPropagatesCtxErrAndMaintainsWatchdogLiveness(t *testing.T) {
	t.Run("pre-cancelled context returns ctx.Err", func(t *testing.T) {
		client := &noopStreamClient{}
		ag := core.NewAgent(client, "m", "sys", core.NewRegistry())
		ag.SetMessages(makeMessagesOfApproxTokens(10000))
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		w := &turnBridge{
			ctx:       ctx,
			cfg:       DaemonConfig{Settings: HarnessSettings{AutoCompactThreshold: 50}},
			modelInfo: provider.Model{ID: "m", ContextWindow: 8000},
			agent:     ag,
		}
		err := w.autoCompact(ctx, func(core.AgentEvent) {})
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("expected context.Canceled, got %v", err)
		}
		if client.calls != 0 {
			t.Fatalf("expected 0 provider calls on pre-cancelled ctx, got %d", client.calls)
		}
	})

	t.Run("mid-compaction cancellation propagates ctx.Err and clears banner", func(t *testing.T) {
		client := &blockingCancelClient{started: make(chan struct{}, 1)}
		ag := core.NewAgent(client, "m", "sys", core.NewRegistry())
		ag.SetMessages(makeMessagesOfApproxTokens(36000))
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		var mu sync.Mutex
		var compactTexts []string
		w := &turnBridge{
			ctx: ctx,
			cfg: DaemonConfig{HostID: "h", Settings: HarnessSettings{AutoCompactThreshold: 70}},
			env: workerEnv{actorID: "s-cancel", emit: func(v any) {
				if m, ok := v.(map[string]any); ok && m["type"] == "agent_event" {
					if ev, ok := m["event"].(map[string]any); ok && ev["type"] == "compact_progress" {
						if txt, ok := ev["text"].(string); ok {
							mu.Lock()
							compactTexts = append(compactTexts, txt)
							mu.Unlock()
						}
					}
				}
			}},
			modelInfo: provider.Model{ID: "m", ContextWindow: 40000},
			agent:     ag,
		}
		done := make(chan error, 1)
		go func() {
			done <- w.autoCompact(ctx, func(ev core.AgentEvent) { w.handleEvent(ev) })
		}()
		select {
		case <-client.started:
		case <-time.After(5 * time.Second):
			t.Fatal("timed out waiting for compaction summarizer request to start")
		}
		cancel()
		err := <-done
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("expected context.Canceled when cancelled mid-compaction, got %v", err)
		}
		mu.Lock()
		got := append([]string(nil), compactTexts...)
		mu.Unlock()
		if len(got) < 2 || got[len(got)-1] != "" {
			t.Fatalf("expected compact_progress to be cleared on cancel, got %q", got)
		}
	})

	t.Run("slow compaction keeps watchdog alive during and immediately after clear", func(t *testing.T) {
		prevWatch := tuneWatchEvery
		prevWaitProvider := tuneWaitProvider
		tuneWatchEvery = 30 * time.Millisecond
		tuneWaitProvider = 90 * time.Millisecond
		defer func() {
			tuneWatchEvery = prevWatch
			tuneWaitProvider = prevWaitProvider
		}()

		a := reviewActor(t)
		a.gen = 1
		a.state = stateRunning
		a.workerDone = make(chan struct{})
		var closeOnce sync.Once
		a.cancel = func() { closeOnce.Do(func() { close(a.workerDone) }) }
		a.supCfg.store(&DaemonConfig{HostID: "h", Settings: HarnessSettings{AutoCompactThreshold: 70}})
		sup := newSessionSupervisor(a.store.dataDir, a.supCfg, nil, nil)
		sup.resident[a.id] = &residentEntry{handle: &sessionHandle{inbox: a.inbox, control: a.control, done: a.done}}
		snap, env := snapshotTurn(a, 1, "test", nil)
		go a.run()
		defer func() { a.control <- shutdownMsg{}; <-a.done }()

		// 8 * 30ms = 240ms (> 2.5x tuneWaitProvider and > 8x tuneWatchEvery).
		client := &slowPulsingSummaryClient{delay: 30 * time.Millisecond, ticks: 8}
		ag := core.NewAgent(client, "m", "sys", core.NewRegistry())
		ag.SetMessages(makeMessagesOfApproxTokens(36000))
		w := &turnBridge{
			ctx:       context.Background(),
			cfg:       *a.supCfg.load(),
			snap:      snap,
			env:       env,
			modelInfo: provider.Model{ID: "m", ContextWindow: 40000},
			client:    client,
			reg:       core.NewRegistry(),
			agent:     ag,
		}
		ag.OnCompactionState = w.onCompactionState

		errCh := make(chan error, 1)
		go func() {
			errCh <- w.autoCompact(context.Background(), func(ev core.AgentEvent) { w.handleEvent(ev) })
		}()

		ticker := time.NewTicker(25 * time.Millisecond)
		defer ticker.Stop()
		var compactErr error
	waitLoop:
		for {
			select {
			case compactErr = <-errCh:
				break waitLoop
			case <-ticker.C:
				sup.watchdogRound()
			}
		}
		if compactErr != nil {
			t.Fatalf("slow autoCompact failed: %v", compactErr)
		}
		flushActorInbox(t, a)
		// Immediately after autoCompact returns (defer declareWait("", zero)),
		// watchdog must NOT falsely cancel the session.
		sup.watchdogRound()
		rep := sup.ping(a.id)
		if rep == nil || rep.State != stateRunning {
			t.Fatalf("expected actor stateRunning after slow autoCompact completed, got %+v", rep)
		}
	})
}

func TestOnUsageDeduplicatesImmediateEvUsageWithoutBreakingStandalone(t *testing.T) {
	inbox := make(chan Envelope, 16)
	ag := core.NewAgent(nil, "m", "sys", core.NewRegistry())
	w := &turnBridge{
		ctx:       context.Background(),
		snap:      workerSnapshot{gen: 1, epoch: 1, turnIndex: 1},
		cfg:       DaemonConfig{HostID: "h"},
		env:       workerEnv{inbox: inbox, actorID: "s-usage"},
		modelInfo: provider.Model{ID: "m", ContextWindow: 100000},
		agent:     ag,
	}

	drainUsageWAL := func() []walEvent {
		var out []walEvent
		for len(inbox) > 0 {
			env := <-inbox
			if wa, ok := env.Payload.(walAppendMsg); ok && wa.ev.Type == walTypeUsage {
				out = append(out, wa.ev)
			}
		}
		return out
	}

	// Simulate oneTurn: EvUsage followed immediately by OnUsage with identical cumulative totals.
	stepDelta := provider.Usage{InputTokens: 500, OutputTokens: 100, CostUSD: 0.01}
	stepCum := provider.Usage{InputTokens: 500, OutputTokens: 100, CostUSD: 0.01}
	w.handleEvent(core.EvUsage{Usage: stepDelta, Cumulative: stepCum})
	w.onUsage(stepCum)

	first := drainUsageWAL()
	if len(first) != 1 {
		t.Fatalf("expected EvUsage + immediate OnUsage to emit exactly 1 walTypeUsage row, got %d", len(first))
	}

	// Simulate compaction/vision standalone OnUsage with updated cumulative totals (no EvUsage).
	compCum := provider.Usage{InputTokens: 800, OutputTokens: 250, CostUSD: 0.02}
	w.onUsage(compCum)

	second := drainUsageWAL()
	if len(second) != 1 || second[0].Usage == nil || *second[0].Usage != compCum {
		t.Fatalf("expected standalone onUsage to persist updated cumulative usage %+v, got %+v", compCum, second)
	}
}

func TestDefaultConfigAutoCompactThresholdAligned(t *testing.T) {
	if got := defaultConfig().Settings.AutoCompactThreshold; got != 80 {
		t.Fatalf("defaultConfig().Settings.AutoCompactThreshold = %d, want 80", got)
	}
}
