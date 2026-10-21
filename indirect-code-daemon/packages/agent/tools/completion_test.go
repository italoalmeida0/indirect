package tools

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"indirect/indirect-code-daemon/packages/provider"
)

func TestFinishEntireRequestTool(t *testing.T) {
	called := false
	tool := &FinishEntireRequestTool{
		OnFinish: func() error {
			called = true
			return nil
		},
	}
	if tool.Name() != "finish_entire_request" {
		t.Fatalf("unexpected name: %s", tool.Name())
	}
	// final_message_to_user is the only accepted key; legacy aliases are gone.
	res, err := tool.Execute(context.Background(), json.RawMessage(`{"notes":"done"}`), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error when final_message_to_user is missing")
	}
	if called {
		t.Fatal("OnFinish must not run without final_message_to_user")
	}

	res, err = tool.Execute(context.Background(), json.RawMessage(`{"final_message_to_user":"Everything is done."}`), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected tool error: %+v", res.Content)
	}
	if !called {
		t.Fatal("expected OnFinish callback to be invoked")
	}
	if got := envAttr(res, "info"); !strings.Contains(got, "final_message_to_user") {
		t.Fatalf("info attr = %q", got)
	}
}

// An incomplete-work check blocks the finish before OnFinish runs:
// the warning becomes the tool error, the turn keeps going, and the
// model can resolve the block and call again.
func TestFinishEntireRequestToolIncompleteCheckBlocks(t *testing.T) {
	called := false
	blocked := true
	tool := &FinishEntireRequestTool{
		OnFinish: func() error {
			called = true
			return nil
		},
		IncompleteCheck: func() string {
			if blocked {
				return "Cannot finish yet: open todo items remain."
			}
			return ""
		},
	}
	res, err := tool.Execute(context.Background(), json.RawMessage(`{"final_message_to_user":"All done."}`), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected the finish to be blocked while the check warns")
	}
	if called {
		t.Fatal("OnFinish must not run while the finish is blocked")
	}
	var text strings.Builder
	for _, c := range res.Content {
		if tb, ok := c.(provider.TextBlock); ok {
			text.WriteString(tb.Text)
		}
	}
	if !strings.Contains(text.String(), "Cannot finish yet") {
		t.Fatalf("expected the block warning as the tool error, got %q", text.String())
	}

	blocked = false
	res, err = tool.Execute(context.Background(), json.RawMessage(`{"final_message_to_user":"All done."}`), nil)
	if err != nil || res.IsError {
		t.Fatalf("expected finish to succeed once the check passes: err=%v res=%+v", err, res)
	}
	if !called {
		t.Fatal("expected OnFinish after the block clears")
	}
}

// The same tool serves every mode: only the description variant changes,
// and plan mode must expose the very same name.
func TestFinishEntireRequestToolOneNameAcrossModes(t *testing.T) {
	build := &FinishEntireRequestTool{}
	learning := &FinishEntireRequestTool{Mode: "learning"}
	plan := &FinishEntireRequestTool{Mode: "plan"}
	for _, tool := range []*FinishEntireRequestTool{build, learning, plan} {
		if tool.Name() != "finish_entire_request" {
			t.Fatalf("mode %q exposes name %q", tool.Mode, tool.Name())
		}
		if tool.Description() == "" {
			t.Fatalf("mode %q has an empty description", tool.Mode)
		}
		if !strings.Contains(tool.Description(), "final_message_to_user") {
			t.Fatalf("mode %q description must document final_message_to_user", tool.Mode)
		}
	}
}
