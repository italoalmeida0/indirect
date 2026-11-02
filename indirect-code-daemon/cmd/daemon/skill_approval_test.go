package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"indirect/indirect-code-daemon/packages/skills"
)

// A session_data snapshot is complete: it carries the actor-owned client
// overlay (pending approval/question, live tool state). Changing a skill while
// the agent waits for an approval must not clear the approval card — the turn
// would stay blocked with no UI to answer it.
func TestSkillsUpdateSnapshotKeepsPendingApproval(t *testing.T) {
	prev := skillRegistry()
	defer func() { swapSkillRegistry(prev) }()
	swapSkillRegistry(&skillStore{list: map[string]skills.Skill{
		"build": {Name: "build", Mode: "agentic", Permissions: map[string]skills.PermSpec{
			"bash": {Policy: skills.PolicyAsk},
		}},
		"quick": {Name: "quick", Mode: "agentic", Usable: "yolo"},
	}})

	rec := newTestRecord("sess_skillapproval")
	rec.Options.Mode = "agentic"
	rec.Skills = map[string]skills.SessionSkill{"build": {Priority: 1, Active: true}}

	approval := make(chan approvalOutcome, 1)
	worker := func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		env.inbox <- Envelope{Payload: workerApprovalReqMsg{
			gen: snap.gen, id: "ap1", callID: "ap1", tool: "bash",
			args: json.RawMessage(`{"cmd":"ls"}`), reply: approval,
		}, Epoch: snap.epoch}
		<-approval
		env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen}, Epoch: snap.epoch}
	}
	act, _, wsCh, stop := newTestActor(t, rec, worker)
	defer stop()

	reply := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "run", Reply: reply}}
	if res := (<-reply).(promptResult); !res.Accepted {
		t.Fatalf("prompt rejected: %+v", res)
	}

	deadline := time.Now().Add(5 * time.Second)
	approvalSeen := false
	for !approvalSeen && time.Now().Before(deadline) {
		select {
		case ev := <-wsCh:
			if m, ok := ev.(map[string]any); ok && m["type"] == "tool_approval_request" {
				approvalSeen = true
			}
		case <-time.After(50 * time.Millisecond):
		}
	}
	if !approvalSeen {
		t.Fatal("worker approval request never reached the client")
	}

	// The user edits skills while the approval card is on screen.
	act.inbox <- Envelope{Payload: skillsUpdateMsg{
		Set:   map[string]skills.SessionSkill{"quick": {Active: true, Usable: "yolo"}},
		Order: []string{"build", "quick"},
	}}

	var snapshot map[string]any
	for snapshot == nil && time.Now().Before(deadline) {
		select {
		case ev := <-wsCh:
			m, ok := ev.(map[string]any)
			if !ok || m["type"] != "session_data" {
				continue
			}
			snapshot, _ = m["session"].(map[string]any)
		case <-time.After(50 * time.Millisecond):
		}
	}
	if snapshot == nil {
		t.Fatal("no session_data snapshot after the skill update")
	}
	if snapshot["pendingApproval"] == nil {
		t.Fatalf("skill update snapshot lost the pending approval: %+v", snapshot)
	}
	skillsOut, _ := snapshot["skills"].(map[string]any)
	if quick, _ := skillsOut["quick"].(map[string]any); quick["active"] != true {
		t.Fatalf("skill update missing from the snapshot: %+v", skillsOut)
	}

	// The waiter is still alive: answering completes the turn.
	act.inbox <- Envelope{Payload: approvalResponseMsg{ID: "ap1", Approved: true}}
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		repCh := make(chan any, 1)
		act.control <- watchdogPingMsg{Reply: repCh}
		if rep := (<-repCh).(watchdogReport); rep.State == stateIdle {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("turn did not finish after the pending approval was answered")
}
