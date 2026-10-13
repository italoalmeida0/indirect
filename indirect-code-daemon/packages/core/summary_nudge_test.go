package core

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

func TestSummaryNudgeTriggerOn30Tools(t *testing.T) {
	var responses [][]provider.Event
	// Generate 30 tool turns
	for i := 0; i < 30; i++ {
		callID := "call_" + string(rune('a'+i))
		responses = append(responses, []provider.Event{
			provider.EventToolStart{ID: callID, Name: "bash"},
			provider.EventToolEnd{ID: callID},
			provider.EventDone{
				Stop: provider.StopToolUse,
				Message: provider.Message{
					Role:    provider.RoleAssistant,
					Content: []provider.Content{provider.ToolCallBlock{ID: callID, Name: "bash"}},
				},
			},
		})
	}
	// 31st response after receiving SummaryWarnNudge: model calls summary tool
	responses = append(responses, []provider.Event{
		provider.EventToolStart{ID: "call_sum", Name: "summary"},
		provider.EventToolEnd{ID: "call_sum"},
		provider.EventDone{
			Stop: provider.StopToolUse,
			Message: provider.Message{
				Role:    provider.RoleAssistant,
				Content: []provider.Content{provider.ToolCallBlock{ID: "call_sum", Name: "summary"}},
			},
		},
	})
	// 32nd response: mark completion
	responses = append(responses, []provider.Event{
		provider.EventToolStart{ID: "call_done", Name: "finish_entire_request"},
		provider.EventToolEnd{ID: "call_done"},
		provider.EventDone{
			Stop: provider.StopToolUse,
			Message: provider.Message{
				Role:    provider.RoleAssistant,
				Content: []provider.Content{provider.ToolCallBlock{ID: "call_done", Name: "finish_entire_request"}},
			},
		},
	})

	client := &scriptedClient{responses: responses}
	tools := NewRegistry(
		&dummyTool{name: "bash"},
		&dummyTool{name: "summary"},
		&dummyTool{name: "finish_entire_request"},
	)
	agent := NewAgent(client, "test-model", "system", tools)
	agent.PersistentTurns = true

	var nudgeReceived bool
	_ = agent.Continue(context.Background(), func(e AgentEvent) {
		if ev, ok := e.(EvUserMessage); ok {
			if strings.Contains(extractText(ev.Message), "Multiple tools have been executed without a progress update") {
				nudgeReceived = true
			}
		}
	})

	if !nudgeReceived {
		t.Fatal("expected SummaryWarnNudge to be triggered after 30 tool calls")
	}
}

// TestSummaryNoticeTextAlternatesExtra pins the notice arithmetic:
// extra host state folds into every SECOND summary notice (2nd, 4th,
// ...), inside the system-warn envelope; odd notices and empty or
// missing extras keep the plain notice.
func TestSummaryNoticeTextAlternatesExtra(t *testing.T) {
	notice := "<system-warn>base</system-warn>"
	calls := 0
	extra := func() string {
		calls++
		return "state lines"
	}
	for count, wantExtra := range map[int]bool{1: false, 2: true, 3: false, 4: true} {
		got := summaryNoticeText(notice, count, extra)
		if strings.Contains(got, "state lines") != wantExtra {
			t.Errorf("count %d: extra present=%v, want %v (%q)", count, strings.Contains(got, "state lines"), wantExtra, got)
		}
		if wantExtra && !strings.HasSuffix(got, "</system-warn>") {
			t.Errorf("count %d: extra must stay inside the envelope, got %q", count, got)
		}
	}
	if calls != 2 {
		t.Fatalf("extra hook invoked %d times, want only on even notices (2)", calls)
	}
	if got := summaryNoticeText(notice, 2, nil); got != notice {
		t.Fatalf("nil hook must keep the plain notice, got %q", got)
	}
	if got := summaryNoticeText(notice, 2, func() string { return "  " }); got != notice {
		t.Fatalf("empty extra must keep the plain notice, got %q", got)
	}
}

// TestSummaryNudgeExtraOnSecondNotice drives a full turn: the model
// ignores the first progress notice (30 tools), so the second notice
// (30 more) escalates the gate — and carries the host extra, while
// the first one did not.
func TestSummaryNudgeExtraOnSecondNotice(t *testing.T) {
	toolTurn := func(id, name string) []provider.Event {
		return []provider.Event{
			provider.EventToolStart{ID: id, Name: name},
			provider.EventToolEnd{ID: id},
			provider.EventDone{
				Stop: provider.StopToolUse,
				Message: provider.Message{
					Role:    provider.RoleAssistant,
					Content: []provider.Content{provider.ToolCallBlock{ID: id, Name: name}},
				},
			},
		}
	}
	var responses [][]provider.Event
	for i := 0; i < 60; i++ {
		responses = append(responses, toolTurn(fmt.Sprintf("call_%02d", i), "bash"))
	}
	responses = append(responses, toolTurn("call_sum", "summary"))
	responses = append(responses, toolTurn("call_done", "finish_entire_request"))

	client := &scriptedClient{responses: responses}
	tools := NewRegistry(
		&dummyTool{name: "bash"},
		&dummyTool{name: "summary"},
		&dummyTool{name: "finish_entire_request"},
	)
	agent := NewAgent(client, "test-model", "system", tools)
	agent.PersistentTurns = true
	agent.CompletionTool = "finish_entire_request"
	hookCalls := 0
	agent.SummaryNudgeExtra = func() string {
		hookCalls++
		return "STATE-SNAPSHOT-MARKER"
	}

	var notices []string
	_ = agent.Continue(context.Background(), func(e AgentEvent) {
		if ev, ok := e.(EvUserMessage); ok {
			if text := extractText(ev.Message); strings.Contains(text, "Automated system notice") {
				notices = append(notices, text)
			}
		}
	})
	if len(notices) != 2 {
		t.Fatalf("expected 2 summary notices, got %d: %q", len(notices), notices)
	}
	if strings.Contains(notices[0], "STATE-SNAPSHOT-MARKER") {
		t.Fatalf("first notice must not carry the extra:\n%s", notices[0])
	}
	if !strings.Contains(notices[1], "STATE-SNAPSHOT-MARKER") {
		t.Fatalf("second notice must carry the extra:\n%s", notices[1])
	}
	if hookCalls != 1 {
		t.Fatalf("extra hook invoked %d times, want 1 (even notices only)", hookCalls)
	}
}
