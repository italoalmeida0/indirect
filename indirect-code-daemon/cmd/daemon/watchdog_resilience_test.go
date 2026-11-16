package main

import (
	"context"
	"encoding/json"
	"net/http"
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
