package main

import (
	"context"
	"sync"
	"testing"
	"time"

	"indirect/indirect-code-daemon/packages/core"
	"indirect/indirect-code-daemon/packages/provider"
	"indirect/indirect-code-daemon/packages/skills"
)

// When the user deactivates an AI-activated skill mid-turn, the notice is a
// turn-scoped transcript row: the worker history and a.rec.Messages stay
// index-aligned (so a later compaction anchor is valid), the row never reaches
// the frontend as a fake user bubble, and finishTurn strips it.
func TestSkillNoticeStaysIndexAlignedAndNeverRenders(t *testing.T) {
	a := reviewActor(t)
	a.state, a.rec.TurnSeq = stateRunning, 2
	a.rec.Messages = []provider.Message{
		{ID: "u1", Role: provider.RoleUser, TurnIndex: 1, Content: []provider.Content{provider.TextBlock{Text: "old question"}}},
		{ID: "a1", Role: provider.RoleAssistant, TurnIndex: 1, Content: []provider.Content{provider.TextBlock{Text: "old answer"}}},
	}
	// The worker starts BEFORE the mid-turn skill edit.
	snap, env := snapshotTurn(a, 1, "", nil)
	a.rec.Skills = map[string]skills.SessionSkill{"foo": {Priority: 1, Active: true, ByAI: true}}
	a.noticeSkillDeactivation("foo")
	// A queue promotion appends its user row and hands the same row to the
	// worker, exactly like the actor's refresh handler.
	queued := provider.Message{ID: "queued", Role: provider.RoleUser, TurnIndex: 2,
		Content: []provider.Content{provider.TextBlock{Text: "queued prompt"}}}
	a.rec.Messages = append(a.rec.Messages, queued)
	a.pendingContext = append(a.pendingContext, queued)
	if len(a.pendingContext) != 2 {
		t.Fatalf("pending context = %d messages, want notice + queued row", len(a.pendingContext))
	}

	inbox := make(chan Envelope, 32)
	done := make(chan struct{})
	var mu sync.Mutex
	var events []map[string]any
	eventCh := make(chan struct{}, 8)
	ctxMsgs := append([]provider.Message(nil), a.pendingContext...)
	a.pendingContext = nil
	go func() {
		for {
			select {
			case <-done:
				return
			case envelope := <-inbox:
				switch p := envelope.Payload.(type) {
				case workerRefreshMsg:
					p.Reply <- workerRefreshResult{
						model:   "m",
						options: SessionOptions{Mode: "agentic", Effort: "none"},
						context: ctxMsgs,
						skills:  map[string]skills.SessionSkill{},
					}
				case workerEmitMsg:
					if ev, ok := p.event.(map[string]any); ok {
						mu.Lock()
						events = append(events, ev)
						mu.Unlock()
						select {
						case eventCh <- struct{}{}:
						default:
						}
					}
				}
			}
		}
	}()
	defer close(done)
	env.inbox = inbox
	env.done = done
	w := &turnBridge{
		snap: snap, env: env, cfg: *env.cfg.load(), ctx: context.Background(),
		modelInfo: provider.Model{ID: "m"}, reg: core.NewRegistry(),
	}
	w.agent = core.NewAgent(nil, "m", "", core.NewRegistry())
	w.agent.SetMessages(snap.messages)

	if err := w.beforeRequest(context.Background()); err != nil {
		t.Fatal(err)
	}

	hist := w.agent.History()
	if len(hist) != len(a.rec.Messages) {
		t.Fatalf("worker history has %d messages, actor record has %d (indexes drifted)", len(hist), len(a.rec.Messages))
	}
	for i := range hist {
		if hist[i].ID != a.rec.Messages[i].ID {
			t.Fatalf("history[%d] = %q, record[%d] = %q", i, hist[i].ID, i, a.rec.Messages[i].ID)
		}
	}
	if len(hist) < 2 || hist[len(hist)-2].Meta[skillNoticeMetaKey] == "" {
		t.Fatalf("notice missing from the aligned history: %+v", hist)
	}

	select {
	case <-eventCh:
	case <-time.After(2 * time.Second):
		t.Fatal("queued user row never reached the frontend stream")
	}
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(events) != 1 {
		t.Fatalf("frontend got %d user events, want only the queued prompt: %+v", len(events), events)
	}
	ev := events[0]
	if ev["type"] != "agent_event" {
		t.Fatalf("unexpected event %+v", ev)
	}
	inner, _ := ev["event"].(map[string]any)
	if inner["type"] != "user_message" {
		t.Fatalf("unexpected inner event %+v", inner)
	}
	msg, ok := inner["message"].(provider.Message)
	if !ok || msg.ID != "queued" {
		t.Fatalf("frontend user message = %+v, want the queued prompt only", inner["message"])
	}
	if msg.Meta[skillNoticeMetaKey] != "" {
		t.Fatalf("skill notice leaked as a user message: %+v", msg)
	}

	// Turn end: the notice never commits, and no compaction anchor exists to
	// adjust in this fixture.
	a.finishTurn(true)
	for _, m := range a.rec.Messages {
		if _, isNotice := m.Meta[skillNoticeMetaKey]; isNotice {
			t.Fatalf("skill notice survived turn end: %+v", m)
		}
	}
}
