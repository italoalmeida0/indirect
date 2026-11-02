package main

import (
	"testing"
	"time"

	"indirect/indirect-code-daemon/packages/skills"
)

// mirrorSessionItem pulls the sessions collection once and returns the item
// for id. The mirror summary is the web client's list source, so it must
// carry the same skill selection as the full session payload.
func mirrorSessionItem(t *testing.T, h *wsHarness, id string) map[string]any {
	t.Helper()
	h.mu.Lock()
	before := len(h.sent)
	h.mu.Unlock()
	h.send(map[string]any{"type": "pull", "collection": "sessions", "id": float64(1)})
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		h.mu.Lock()
		for i := before; i < len(h.sent); i++ {
			m := h.sent[i]
			if m["type"] != "pull-response" || m["error"] != nil {
				continue
			}
			items, _ := m["items"].([]map[string]any)
			for _, item := range items {
				if item["id"] == id {
					h.mu.Unlock()
					return item
				}
			}
		}
		h.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("session %q missing from mirror pull", id)
	return nil
}

// The sessions mirror summary is the source the frontend re-applies on every
// list refresh and session selection. It MUST include the persisted skill
// selection and the resolved approval mode; omitting them reset the picker to
// its default primary skill and the permissions UI to "ask" (changing a skill
// during a turn, while an action was pending or while idle all re-pulled the
// list and wiped the selection).
func TestSessionMirrorSummaryCarriesSkillsAndApprovalMode(t *testing.T) {
	prev := skillRegistry()
	defer func() { swapSkillRegistry(prev) }()
	swapSkillRegistry(&skillStore{list: map[string]skills.Skill{
		"build": {Name: "build", Mode: "agentic", Usable: "deny", ApprovalMode: "yolo"},
		"notes": {Name: "notes", Mode: "agentic", Usable: "ask"},
		"plan":  {Name: "plan", Mode: "agentic", Usable: "deny"},
	}})

	h := newWSHarness(t)
	st := newDiskStore(h.dir)
	rec := &SessionRecord{
		ID: "sess_mirrorskills01", CWD: "/tmp", Title: "skills", Model: "m",
		Status: "idle", CreatedAt: 1, UpdatedAt: 2,
		Options: SessionOptions{Effort: "medium", Mode: "agentic", Access: "full"},
		Skills: map[string]skills.SessionSkill{
			"build": {Priority: 1, Active: true},
			"notes": {Priority: 2, Active: true, Usable: "yolo"},
			"plan":  {Priority: 3},
		},
	}
	if err := st.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}

	item := mirrorSessionItem(t, h, rec.ID)
	skillsOut, ok := item["skills"].(map[string]any)
	if !ok {
		t.Fatalf("mirror summary must carry skills, got %+v", item)
	}
	build, _ := skillsOut["build"].(map[string]any)
	if build["active"] != true || build["priority"] != 1 {
		t.Fatalf("build must stay active priority 1 in the mirror: %+v", build)
	}
	notes, _ := skillsOut["notes"].(map[string]any)
	if notes["active"] != true || notes["priority"] != 2 || notes["usable"] != "yolo" {
		t.Fatalf("notes selection (active + usable override) must ride the mirror: %+v", notes)
	}
	plan, _ := skillsOut["plan"].(map[string]any)
	if plan["active"] != false {
		t.Fatalf("inactive entries must ride the mirror with active=false: %+v", plan)
	}
	if item["approvalMode"] != "yolo" {
		t.Fatalf("resolved approvalMode must ride the mirror, got %v", item["approvalMode"])
	}
}

// Resident sessions are summarized from actor RAM; a live update_skills must
// be visible in the next mirror pull immediately (the frontend applies that
// pull, so a stale summary would undo the user's change).
func TestSessionMirrorSummaryTracksLiveSkillUpdates(t *testing.T) {
	prev := skillRegistry()
	defer func() { swapSkillRegistry(prev) }()
	swapSkillRegistry(&skillStore{list: map[string]skills.Skill{
		"build": {Name: "build", Mode: "agentic", Usable: "deny", ApprovalMode: "yolo"},
		"notes": {Name: "notes", Mode: "agentic", Usable: "ask"},
	}})

	h := newWSHarness(t)
	h.send(map[string]any{
		"type": "create_session", "requestId": "r1", "cwd": "/tmp", "title": "s", "model": "m",
		"options": map[string]any{
			"mode":   "agentic",
			"skills": []any{map[string]any{"name": "build"}, map[string]any{"name": "notes"}},
		},
	})
	created := h.lastType("session_created")
	if created == nil {
		t.Fatal("no session_created")
	}
	sess := created["session"].(map[string]any)
	id := sess["id"].(string)

	item := mirrorSessionItem(t, h, id)
	skillsOut, _ := item["skills"].(map[string]any)
	if notes, _ := skillsOut["notes"].(map[string]any); notes["active"] != true {
		t.Fatalf("created selection must be in the mirror: %+v", skillsOut)
	}

	// Deactivate notes through the granular wire command the picker sends.
	h.mu.Lock()
	beforeUpdate := len(h.sent)
	h.mu.Unlock()
	h.send(map[string]any{
		"type": "update_skills", "sessionId": id,
		"set":   map[string]any{"notes": map[string]any{"active": false}},
		"order": []any{"build"},
	})
	deadline := time.Now().Add(3 * time.Second)
	for {
		h.mu.Lock()
		ack := false
		for i := beforeUpdate; i < len(h.sent); i++ {
			if h.sent[i]["type"] == "session_data" {
				ack = true
				break
			}
		}
		h.mu.Unlock()
		if ack {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no session_data ack for update_skills")
		}
		time.Sleep(10 * time.Millisecond)
	}

	item = mirrorSessionItem(t, h, id)
	skillsOut, _ = item["skills"].(map[string]any)
	if notes, _ := skillsOut["notes"].(map[string]any); notes["active"] != false {
		t.Fatalf("live deactivation must reach the mirror: %+v", skillsOut)
	}
	if item["approvalMode"] != "yolo" {
		t.Fatalf("approvalMode must stay resolved from the primary skill: %v", item["approvalMode"])
	}
}
