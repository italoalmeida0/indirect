package core

import (
	"strings"
	"testing"

	"indirect/indirect-code-daemon/packages/provider"
)

// TestRepairToolUseResultPairsAppendsStub covers the most common
// corruption shape: assistant tool_use row on disk, no
// corresponding tool_result row after it. The repair must inject
// a stub tool_result so the next request passes the provider's
// validity check.
func TestRepairToolUseResultPairsAppendsStub(t *testing.T) {
	msgs := []provider.Message{
		{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "hi"}}},
		{Role: provider.RoleAssistant, Content: []provider.Content{
			provider.ToolCallBlock{ID: "t1", Name: "read", Arguments: []byte(`{"path":"/tmp/a"}`)},
		}},
	}
	out := repairToolUseResultPairs(msgs)
	if len(out) != 3 {
		t.Fatalf("expected 3 messages after repair, got %d", len(out))
	}
	if out[2].Role != provider.RoleTool {
		t.Fatalf("expected tool-role message at index 2, got %v", out[2].Role)
	}
	tr, ok := out[2].Content[0].(provider.ToolResultBlock)
	if !ok {
		t.Fatalf("expected ToolResultBlock, got %T", out[2].Content[0])
	}
	if tr.CallID != "t1" {
		t.Errorf("CallID: want t1, got %q", tr.CallID)
	}
	if !tr.IsError {
		t.Errorf("expected IsError=true on stub")
	}
}

// TestRepairToolUseResultPairsMergesIntoExistingToolMessage covers
// the case where a tool-role message exists but is missing one of
// the call ids. The stub must be merged into it (no new message)
// so the ordering stays tool_use, tool_result, tool_use, tool_result.
func TestRepairToolUseResultPairsMergesIntoExistingToolMessage(t *testing.T) {
	msgs := []provider.Message{
		{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "hi"}}},
		{Role: provider.RoleAssistant, Content: []provider.Content{
			provider.ToolCallBlock{ID: "t1", Name: "read"},
			provider.ToolCallBlock{ID: "t2", Name: "bash"},
		}},
		{Role: provider.RoleTool, Content: []provider.Content{
			provider.ToolResultBlock{CallID: "t1", Content: []provider.Content{provider.TextBlock{Text: "ok"}}},
		}},
	}
	out := repairToolUseResultPairs(msgs)
	if len(out) != 3 {
		t.Fatalf("expected 3 messages (merged), got %d", len(out))
	}
	if out[2].Role != provider.RoleTool {
		t.Fatalf("expected tool-role at index 2")
	}
	if len(out[2].Content) != 2 {
		t.Fatalf("expected 2 tool_result blocks after merge, got %d", len(out[2].Content))
	}
	// second block must be the stub for t2
	tr, ok := out[2].Content[1].(provider.ToolResultBlock)
	if !ok {
		t.Fatalf("expected ToolResultBlock at [1], got %T", out[2].Content[1])
	}
	if tr.CallID != "t2" {
		t.Errorf("merged stub CallID: want t2, got %q", tr.CallID)
	}
}

// TestRepairToolUseResultPairsLeavesValidTranscriptsAlone verifies
// the repair is a no-op when everything is already paired.
func TestRepairToolUseResultPairsLeavesValidTranscriptsAlone(t *testing.T) {
	msgs := []provider.Message{
		{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "hi"}}},
		{Role: provider.RoleAssistant, Content: []provider.Content{
			provider.ToolCallBlock{ID: "t1", Name: "read"},
		}},
		{Role: provider.RoleTool, Content: []provider.Content{
			provider.ToolResultBlock{CallID: "t1", Content: []provider.Content{provider.TextBlock{Text: "ok"}}},
		}},
		{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "done"}}},
	}
	out := repairToolUseResultPairs(msgs)
	if len(out) != len(msgs) {
		t.Fatalf("no-op expected, len %d -> %d", len(msgs), len(out))
	}
	for i := range msgs {
		if msgs[i].Role != out[i].Role {
			t.Errorf("msg %d role changed", i)
		}
	}
}

// TestRepairToolUseResultPairsEmpty handles the zero-value case.
func TestRepairToolUseResultPairsEmpty(t *testing.T) {
	if out := repairToolUseResultPairs(nil); len(out) != 0 {
		t.Fatalf("expected empty, got %d", len(out))
	}
}

func TestRepairToolUseResultPairsSkipsServerTools(t *testing.T) {
	msgs := []provider.Message{
		{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "hi"}}},
		{Role: provider.RoleAssistant, Content: []provider.Content{
			provider.ToolCallBlock{ID: "srv", Name: "openrouter:datetime", Server: true},
			provider.TextBlock{Text: "noon"},
		}},
	}
	out := repairToolUseResultPairs(msgs)
	if len(out) != len(msgs) {
		t.Fatalf("server tools should not get stub results, len %d -> %d", len(msgs), len(out))
	}
}

// collectToolResults returns every tool_result text for callID, in order.
func collectToolResults(msgs []provider.Message, callID string) []string {
	var texts []string
	for _, m := range msgs {
		for _, c := range m.Content {
			tr, ok := c.(provider.ToolResultBlock)
			if !ok || tr.CallID != callID {
				continue
			}
			var sb strings.Builder
			for _, inner := range tr.Content {
				if tb, ok := inner.(provider.TextBlock); ok {
					sb.WriteString(tb.Text)
				}
			}
			texts = append(texts, sb.String())
		}
	}
	return texts
}

func countToolResultBlocks(msgs []provider.Message) int {
	n := 0
	for _, m := range msgs {
		for _, c := range m.Content {
			if _, ok := c.(provider.ToolResultBlock); ok {
				n++
			}
		}
	}
	return n
}

// TestRepairToolUseResultPairsPerResultMessages covers the on-disk
// PersistentTurns shape: each tool result is committed as its own
// tool-role message, so a two-call batch reads as
// [assistant(t1,t2)] [tool(t1)] [tool(t2)]. Only inspecting the
// message immediately after the assistant stubs t2 even though its
// real result is present one message later.
func TestRepairToolUseResultPairsPerResultMessages(t *testing.T) {
	msgs := []provider.Message{
		{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "hi"}}},
		{Role: provider.RoleAssistant, Content: []provider.Content{
			provider.ToolCallBlock{ID: "t1", Name: "bash"},
			provider.ToolCallBlock{ID: "t2", Name: "bash"},
		}},
		{Role: provider.RoleTool, Content: []provider.Content{
			provider.ToolResultBlock{CallID: "t1", Content: []provider.Content{provider.TextBlock{Text: "one"}}},
		}},
		{Role: provider.RoleTool, Content: []provider.Content{
			provider.ToolResultBlock{CallID: "t2", Content: []provider.Content{provider.TextBlock{Text: "two"}}},
		}},
	}
	out := repairToolUseResultPairs(msgs)
	if len(out) != len(msgs) {
		t.Fatalf("paired per-result transcript changed shape: len %d -> %d", len(msgs), len(out))
	}
	if n := countToolResultBlocks(out); n != 2 {
		t.Fatalf("expected 2 real tool_results and no stub, got %d blocks", n)
	}
	for id, want := range map[string]string{"t1": "one", "t2": "two"} {
		got := collectToolResults(out, id)
		if len(got) != 1 || got[0] != want {
			t.Errorf("%s: want [%q], got %v", id, want, got)
		}
	}
}

// TestRepairToolUseResultPairsPerResultMessagesPartial covers the
// same per-result shape when the batch genuinely stops midway (an
// interrupted execution): only the missing id gets a stub, merged
// into the existing tool message.
func TestRepairToolUseResultPairsPerResultMessagesPartial(t *testing.T) {
	msgs := []provider.Message{
		{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "hi"}}},
		{Role: provider.RoleAssistant, Content: []provider.Content{
			provider.ToolCallBlock{ID: "t1", Name: "bash"},
			provider.ToolCallBlock{ID: "t2", Name: "bash"},
		}},
		{Role: provider.RoleTool, Content: []provider.Content{
			provider.ToolResultBlock{CallID: "t1", Content: []provider.Content{provider.TextBlock{Text: "one"}}},
		}},
	}
	out := repairToolUseResultPairs(msgs)
	if len(out) != len(msgs) {
		t.Fatalf("expected stub merged into tool message, len %d -> %d", len(msgs), len(out))
	}
	if len(out[2].Content) != 2 {
		t.Fatalf("expected 2 tool_result blocks after merge, got %d", len(out[2].Content))
	}
	tr, ok := out[2].Content[1].(provider.ToolResultBlock)
	if !ok || tr.CallID != "t2" || !tr.IsError {
		t.Fatalf("expected error stub for t2 at [1], got %+v", out[2].Content[1])
	}
	got := collectToolResults(out, "t2")
	if len(got) != 1 || !strings.Contains(got[0], "Tool outcome is unknown") {
		t.Errorf("expected unknown-outcome stub for t2, got %v", got)
	}
}

// TestRepairToolUseResultPairsResultAfterUserNotice covers an
// actor-folded user notice (background completion) that landed in
// the durable transcript between the assistant tool_use row and its
// result row. The real result still pairs with the call; stubbing
// it would shadow the real output.
func TestRepairToolUseResultPairsResultAfterUserNotice(t *testing.T) {
	msgs := []provider.Message{
		{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "hi"}}},
		{Role: provider.RoleAssistant, Content: []provider.Content{
			provider.ToolCallBlock{ID: "t1", Name: "bash"},
		}},
		{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "background job finished"}}, Meta: map[string]string{"background_delivery": "job1"}},
		{Role: provider.RoleTool, Content: []provider.Content{
			provider.ToolResultBlock{CallID: "t1", Content: []provider.Content{provider.TextBlock{Text: "real output"}}},
		}},
	}
	out := repairToolUseResultPairs(msgs)
	if len(out) != len(msgs) {
		t.Fatalf("notice-split pair should be left alone, len %d -> %d", len(msgs), len(out))
	}
	if n := countToolResultBlocks(out); n != 1 {
		t.Fatalf("expected only the real tool_result, got %d blocks", n)
	}
	if got := collectToolResults(out, "t1"); len(got) != 1 || got[0] != "real output" {
		t.Errorf("expected the real result to survive, got %v", got)
	}
}

// TestRepairToolUseResultPairsStopsAtNextAssistant pins the scan
// boundary: a tool_result that only shows up after the NEXT
// assistant message does not pair with the earlier call, so the
// earlier call still gets its stub immediately after it.
func TestRepairToolUseResultPairsStopsAtNextAssistant(t *testing.T) {
	msgs := []provider.Message{
		{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "hi"}}},
		{Role: provider.RoleAssistant, Content: []provider.Content{
			provider.ToolCallBlock{ID: "t1", Name: "bash"},
		}},
		{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "next"}}},
		{Role: provider.RoleTool, Content: []provider.Content{
			provider.ToolResultBlock{CallID: "t1", Content: []provider.Content{provider.TextBlock{Text: "late"}}},
		}},
	}
	out := repairToolUseResultPairs(msgs)
	if len(out) != len(msgs)+1 {
		t.Fatalf("expected a synthetic stub message, len %d -> %d", len(msgs), len(out))
	}
	if out[2].Role != provider.RoleTool {
		t.Fatalf("expected synthetic tool message at index 2, got %v", out[2].Role)
	}
	got := collectToolResults(out, "t1")
	if len(got) != 2 || !strings.Contains(got[0], "Tool outcome is unknown") || got[1] != "late" {
		t.Errorf("expected stub first and late result untouched, got %v", got)
	}
}
