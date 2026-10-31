package main

import (
	"testing"
	"time"

	"indirect/indirect-code-daemon/packages/skills"
)

// Session creation is passive: the MODE comes from the wire (the frontend
// derives it from the primary skill — the daemon never re-derives it and
// an invalid mode falls back to "talk"), the skills array carries only
// the active skills sorted by priority, and a usable override is stored
// verbatim (missing usable = inherit; no lock validation at ingestion).
func TestCreateSessionTakesModeAndSkillsFromWire(t *testing.T) {
	prev := skillRegistry()
	defer func() { swapSkillRegistry(prev) }()
	swapSkillRegistry(&skillStore{list: map[string]skills.Skill{
		// Primary declares agentic + a deny-locked usable: both must be
		// overridden by the wire below, proving the daemon is passive.
		"build": {Name: "build", Description: "d", Mode: "agentic", Usable: "deny"},
		"extra": {Name: "extra", Description: "d", Usable: "ask"},
	}})

	h := newWSHarness(t)
	h.send(map[string]any{
		"type": "create_session", "requestId": "r1", "cwd": "/tmp", "title": "s", "model": "m",
		"options": map[string]any{
			"mode": "talk", // deliberately NOT the primary skill's mode
			"skills": []any{
				map[string]any{"name": "build", "usable": "yolo"}, // lock-violating on purpose
				map[string]any{"name": "extra"},                   // usable omitted = inherit
			},
		},
	})
	created := h.lastType("session_created")
	if created == nil {
		t.Fatalf("no session_created")
	}
	sess := created["session"].(map[string]any)
	opts, _ := sess["options"].(SessionOptions)
	if opts.Mode != "talk" {
		t.Fatalf("mode must come from the wire, got %q (primary skill declares agentic)", opts.Mode)
	}
	sk := sess["skills"].(map[string]any)
	build := sk["build"].(map[string]any)
	if build["priority"] != 1 || build["active"] != true {
		t.Fatalf("build must be priority 1 active, got %+v", build)
	}
	if build["usable"] != "yolo" {
		t.Fatalf("usable must be stored verbatim (passive daemon), got %v", build["usable"])
	}
	extra := sk["extra"].(map[string]any)
	if extra["priority"] != 2 || extra["active"] != true {
		t.Fatalf("extra must be priority 2 active, got %+v", extra)
	}
	if extra["usable"] != "" {
		t.Fatalf("omitted usable must stay \"\" (inherit), got %v", extra["usable"])
	}

	// Invalid mode falls back to talk; the legacy bare-string skill shape
	// is still accepted as a name-only entry.
	h.send(map[string]any{
		"type": "create_session", "requestId": "r2", "cwd": "/tmp", "title": "s2", "model": "m",
		"options": map[string]any{
			"mode":   "bogus",
			"skills": []any{"extra"},
		},
	})
	// Wait for a session_created OTHER than the first one.
	var sess2 map[string]any
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline) && sess2 == nil; time.Sleep(10 * time.Millisecond) {
		h.mu.Lock()
		for _, m := range h.sent {
			if m["type"] == "session_created" {
				if s, ok := m["session"].(map[string]any); ok && s["id"] != sess["id"] {
					sess2 = s
				}
			}
		}
		h.mu.Unlock()
	}
	if sess2 == nil {
		t.Fatalf("second create did not land")
	}
	opts2, _ := sess2["options"].(SessionOptions)
	if opts2.Mode != "talk" {
		t.Fatalf("invalid mode must fall back to talk, got %q", opts2.Mode)
	}
	sk2 := sess2["skills"].(map[string]any)
	if _, ok := sk2["extra"]; !ok {
		t.Fatalf("bare-string skill entry must be accepted, got %+v", sk2)
	}
}
