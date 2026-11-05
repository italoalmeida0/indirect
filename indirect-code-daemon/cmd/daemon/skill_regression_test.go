package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"indirect/indirect-code-daemon/packages/provider"
	"indirect/indirect-code-daemon/packages/skills"
)

func waitActorIdle(t *testing.T, act *sessionActor) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		repCh := make(chan any, 1)
		act.control <- watchdogPingMsg{Reply: repCh}
		if rep := (<-repCh).(watchdogReport); rep.State == stateIdle {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("turn did not finish")
}

// runSkillTurn runs one turn whose worker sends the given activations, then
// returns the session skill map after the turn ended.
func runSkillTurn(t *testing.T, rec *SessionRecord, activations ...skillActivateMsg) map[string]skills.SessionSkill {
	t.Helper()
	worker := func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		for _, m := range activations {
			m.gen = snap.gen
			env.inbox <- Envelope{Payload: m, Epoch: snap.epoch}
		}
		env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen}, Epoch: snap.epoch}
	}
	act, _, _, stop := newTestActor(t, rec, worker)
	defer stop()
	reply := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "go", Reply: reply}}
	if res := (<-reply).(promptResult); !res.Accepted {
		t.Fatalf("prompt rejected: %+v", res)
	}
	waitActorIdle(t, act)
	return cloneSkillsMap(act.rec.Skills)
}

// The AI "loading" a skill the USER activated never takes it over: a
// once=true use_skill must not deactivate the user's persistent activation
// at turn end, nor mark it as an AI activation.
func TestUseSkillOnceKeepsUserActivation(t *testing.T) {
	prev := skillRegistry()
	defer swapSkillRegistry(prev)
	swapSkillRegistry(&skillStore{list: map[string]skills.Skill{
		"mine": {Name: "mine", Usable: "yolo", Body: "b"},
		"ai":   {Name: "ai", Usable: "yolo", Body: "b"},
	}})
	rec := newTestRecord("skill_once_user")
	rec.Options.Mode = "agentic"
	rec.Skills = map[string]skills.SessionSkill{"mine": {Priority: 1, Active: true}}
	got := runSkillTurn(t, rec,
		skillActivateMsg{name: "mine", once: true},
		skillActivateMsg{name: "ai", once: true, delivered: true},
	)
	if st := got["mine"]; !st.Active || st.ByAI || st.Once {
		t.Fatalf("user-activated skill taken over by an AI once-load: %+v", st)
	}
	// The AI's own once activation still expires at turn end.
	if st := got["ai"]; st.Active || !st.ByAI {
		t.Fatalf("AI once skill must deactivate at turn end and stay AI-owned: %+v", st)
	}
}

// A new AI activation lands after every stored priority, even when
// deletions left gaps (the map size would collide with a survivor).
func TestUseSkillPriorityNeverCollides(t *testing.T) {
	prev := skillRegistry()
	defer swapSkillRegistry(prev)
	swapSkillRegistry(&skillStore{list: map[string]skills.Skill{
		"a": {Name: "a", Usable: "yolo"}, "b": {Name: "b", Usable: "yolo"}, "c": {Name: "c", Usable: "yolo"},
	}})
	rec := newTestRecord("skill_priority_gap")
	rec.Options.Mode = "agentic"
	rec.Skills = map[string]skills.SessionSkill{"b": {Priority: 2, Active: true}, "c": {Priority: 3, Active: true}}
	got := runSkillTurn(t, rec, skillActivateMsg{name: "a"})
	if p := got["a"].Priority; p != 4 {
		t.Fatalf("new AI skill priority = %d, want 4 (after c)", p)
	}
}

// A refused or failed use_skill carries no Details marker: its result must
// still leave with the stripped call (matched by call id), never as an
// orphan tool_result.
func TestStripSkillArtifactsDropsFailedUseSkillResult(t *testing.T) {
	msgs := []provider.Message{
		{Role: provider.RoleUser, TurnIndex: 3, Content: []provider.Content{provider.TextBlock{Text: "hi"}}},
		{Role: provider.RoleAssistant, TurnIndex: 3, Content: []provider.Content{
			provider.ToolCallBlock{ID: "c1", Name: "use_skill"},
			provider.ToolCallBlock{ID: "c2", Name: "read"},
		}},
		{Role: provider.RoleUser, TurnIndex: 3, Content: []provider.Content{
			provider.ToolResultBlock{CallID: "c1", IsError: true},
			provider.ToolResultBlock{CallID: "c2"},
		}},
	}
	out := stripSkillArtifacts(msgs, 3)
	var results []string
	for _, m := range out {
		for _, c := range m.Content {
			if tr, ok := c.(provider.ToolResultBlock); ok {
				results = append(results, tr.CallID)
			}
		}
	}
	if strings.Join(results, ",") != "c2" {
		t.Fatalf("results after strip = %v, want only the read result c2", results)
	}
}

// The "patch" alias follows edit's skill grant instead of being denied as
// an unlisted tool.
func TestSkillPolicyPatchAliasFollowsEdit(t *testing.T) {
	eff := skills.Effective{Mode: "agentic", Chain: []skills.Skill{{Name: "b", Permissions: map[string]skills.PermSpec{
		"edit": {Policy: skills.PolicyYolo, Args: map[string]skills.Policy{"secret": skills.PolicyDeny}},
	}}}}
	if p := skillsApproval(eff, "patch", json.RawMessage(`{"path":"x"}`)); p != skills.PolicyYolo {
		t.Fatalf("patch approval = %q, want yolo (edit's grant)", p)
	}
	if reason := skillsArgRestriction(eff, "patch", json.RawMessage(`{"secret":1}`)); reason == "" {
		t.Fatal("patch must inherit edit's argument restrictions")
	}
}

// LoadSkill never repeats a body already in the turn's context: an active
// skill rides the <skill> prefix, and a second load in the same response
// gets the ack — and only a delivered body marks the skill in-context.
func TestLoadSkillSendsBodyOncePerTurn(t *testing.T) {
	prev := skillRegistry()
	defer swapSkillRegistry(prev)
	swapSkillRegistry(&skillStore{list: map[string]skills.Skill{
		"active": {Name: "active", Usable: "yolo", Body: "ACTIVE BODY"},
		"fresh":  {Name: "fresh", Usable: "yolo", Body: "FRESH BODY"},
		"talky":  {Name: "talky", Usable: "yolo", Mode: "talk", Body: "TALK"},
	}})
	inbox := make(chan Envelope, 8)
	w := &turnBridge{}
	w.env.inbox = inbox
	w.snap.options.Mode = "agentic"
	w.snap.skills = map[string]skills.SessionSkill{"active": {Priority: 1, Active: true}}
	if err := w.resolveSkillPolicy(); err != nil {
		t.Fatal(err)
	}

	body, err := w.LoadSkill("active")
	if err != nil || body == "ACTIVE BODY" {
		t.Fatalf("active skill body re-sent (%q, %v): it is already in the prefix", body, err)
	}
	w.RecordSkillUse("active", false)
	if m := (<-inbox).Payload.(skillActivateMsg); m.delivered {
		t.Fatal("an ack must not mark the skill in-context (the prefix still carries it)")
	}

	if body, _ := w.LoadSkill("fresh"); body != "FRESH BODY" {
		t.Fatalf("first load must return the body, got %q", body)
	}
	w.RecordSkillUse("fresh", false)
	if m := (<-inbox).Payload.(skillActivateMsg); !m.delivered {
		t.Fatal("a delivered body must mark the skill in-context")
	}
	if body, _ := w.LoadSkill("fresh"); body == "FRESH BODY" {
		t.Fatal("second load in the same turn repeated the body")
	}

	if _, err := w.LoadSkill("talky"); err == nil {
		t.Fatal("another mode's skill must not load")
	}
}

// Editing the skills directory reloads the registry and pings the clients
// without a daemon restart.
func TestSkillWatcherReloadsOnChange(t *testing.T) {
	prevInterval := skillWatchInterval
	skillWatchInterval = 20 * time.Millisecond
	defer func() { skillWatchInterval = prevInterval }()

	dir := t.TempDir()
	if err := os.MkdirAll(skillsDir(dir), 0o755); err != nil {
		t.Fatal(err)
	}
	store := &skillStore{}
	store.initFrom(dir)
	if _, ok := store.get("fresh"); ok {
		t.Fatal("unexpected skill before the file exists")
	}
	changed := make(chan struct{}, 4)
	stop := make(chan struct{})
	defer close(stop)
	go store.watch(stop, func() { changed <- struct{}{} })

	src := `export default { name: "fresh", description: "d", usable: "ask", body: "x" };`
	if err := os.WriteFile(filepath.Join(skillsDir(dir), "fresh.js"), []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	select {
	case <-changed:
	case <-time.After(5 * time.Second):
		t.Fatal("watcher never reported the new skill file")
	}
	if _, ok := store.get("fresh"); !ok {
		t.Fatal("new skill missing after the watcher reload")
	}
}
