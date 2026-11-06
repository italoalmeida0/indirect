package core

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"indirect/indirect-code-daemon/packages/provider"
)

type cancelOnExecuteTool struct {
	name   string
	cancel context.CancelFunc
	calls  int
}

func (t *cancelOnExecuteTool) Name() string            { return t.name }
func (t *cancelOnExecuteTool) Description() string     { return "cancels the turn" }
func (t *cancelOnExecuteTool) Schema() json.RawMessage { return json.RawMessage(`{"type":"object"}`) }
func (t *cancelOnExecuteTool) Execute(context.Context, json.RawMessage, func(string)) (ToolResult, error) {
	t.calls++
	if t.cancel != nil {
		t.cancel()
	}
	return ToolResult{Content: []provider.Content{provider.TextBlock{Text: "ok"}}}, nil
}

type countingTool struct {
	name  string
	calls int
}

func (t *countingTool) Name() string            { return t.name }
func (t *countingTool) Description() string     { return "counts calls" }
func (t *countingTool) Schema() json.RawMessage { return json.RawMessage(`{"type":"object"}`) }
func (t *countingTool) Execute(context.Context, json.RawMessage, func(string)) (ToolResult, error) {
	t.calls++
	return ToolResult{Content: []provider.Content{provider.TextBlock{Text: "ran"}}}, nil
}

// A cancelled tool batch must not run its remaining side effects. The
// unexecuted calls still get an error result so every tool_use has a
// matching tool_result in the persisted transcript.
func TestExecuteToolsStopsBatchAfterCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	first := &cancelOnExecuteTool{name: "write", cancel: cancel}
	second := &countingTool{name: "edit"}
	a := NewAgent(nil, "test", "", Registry{"write": first, "edit": second})

	msg, hadError := a.executeTools(ctx, provider.Message{
		Role: provider.RoleAssistant,
		Content: []provider.Content{
			provider.ToolCallBlock{ID: "c1", Name: "write"},
			provider.ToolCallBlock{ID: "c2", Name: "edit"},
		},
	}, func(AgentEvent) {})

	if first.calls != 1 {
		t.Fatalf("first tool calls = %d, want 1", first.calls)
	}
	if second.calls != 0 {
		t.Fatalf("second tool ran after cancellation: calls = %d", second.calls)
	}
	if !hadError {
		t.Fatal("cancelled batch must report an error")
	}
	if len(msg.Content) != 2 {
		t.Fatalf("results = %d, want one per tool call", len(msg.Content))
	}
	secondResult, ok := msg.Content[1].(provider.ToolResultBlock)
	if !ok || secondResult.CallID != "c2" {
		t.Fatalf("second result = %+v, want c2", msg.Content[1])
	}
	if !secondResult.IsError {
		t.Fatal("cancelled call must be an error result")
	}
	body, _ := json.Marshal(secondResult.Content)
	if !strings.Contains(string(body), "aborted") || !strings.Contains(string(body), "context canceled") {
		t.Fatalf("cancelled result body = %s", body)
	}
}
