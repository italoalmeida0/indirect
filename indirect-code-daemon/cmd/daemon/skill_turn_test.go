package main

import (
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
	"llm-gateway/indirect-code-daemon/packages/skills"
)

// installGrantingTestSkills swaps the global skill registry for one whose
// "build" skill grants the workspace tools at ask (mirroring the builtin
// build -> agentic_base chain) and returns a session skill map activating
// it. Approval-machinery tests use it so their sessions live in the
// skills-grant world (the base policy is deny: a skill-less session's
// tool calls are refused by the gate before ever reaching a human, which
// is correct product behavior but not what those tests exercise).
func installGrantingTestSkills(t *testing.T) map[string]skills.SessionSkill {
	t.Helper()
	prev := skillRegistry
	ask := skills.PermSpec{Policy: skills.PolicyAsk}
	yolo := skills.PermSpec{Policy: skills.PolicyYolo}
	skillRegistry = &skillStore{list: map[string]skills.Skill{
		"build": {Name: "build", Mode: "agentic", Permissions: map[string]skills.PermSpec{
			"read": ask, "write": ask, "edit": ask, "bash": ask, "python": ask,
			"glob": ask, "search": ask, "inspect": ask,
			"search_web": ask, "fetch_url": ask,
			"bg_await": ask, "bg_check": ask, "bg_cancel": ask,
			"question": yolo, "todo": yolo,
		}},
	}}
	t.Cleanup(func() { skillRegistry = prev })
	return map[string]skills.SessionSkill{"build": {Priority: 1, Active: true}}
}

// The use_skill usable gate (spec §1): the approvalMode never influences
// it. yolo runs free; ask always asks the human; deny/never refuse. There
// is no file-level "inherit": a missing usable key in the skill module falls
// back to deny. At session level, a missing usable or explicit "inherit"
// means "use the skill file original" (no override).
func TestUseSkillUsableGate(t *testing.T) {
	prev := skillRegistry
	defer func() { skillRegistry = prev }()
	skillRegistry = &skillStore{list: map[string]skills.Skill{
		"free":   {Name: "free", Usable: "yolo"},
		"gate":   {Name: "gate", Usable: "ask"},
		"hidden": {Name: "hidden", Usable: "deny"},
		"base":   {Name: "base", Usable: "never"},
		"plain":  {Name: "plain"}, // no usable key in the skill module: deny fallback
		"pinned": {Name: "pinned", Usable: "ask"},
	}}
	args := func(name string) []byte { return []byte(`{"name":"` + name + `"}`) }
	noOverrides := map[string]skills.SessionSkill{}

	cases := map[string]string{
		"free":    "approve",
		"gate":    "ask",
		"hidden":  "refuse",
		"base":    "refuse",
		"plain":   "refuse", // absent file usable = deny
		"unknown": "",       // unknown: the tool's own error speaks
	}
	for skill, want := range cases {
		verdict, _ := useSkillUsableGate(noOverrides, args(skill))
		if verdict != want {
			t.Errorf("gate(%q) = %q, want %q", skill, verdict, want)
		}
	}

	// Session "inherit" carries no override: an ask-original skill still
	// asks. An explicit session yolo override on that same original runs
	// free, while fallback-deny originals stay locked.
	inherit := map[string]skills.SessionSkill{"pinned": {Usable: "inherit"}}
	if v, _ := useSkillUsableGate(inherit, args("pinned")); v != "ask" {
		t.Errorf("session inherit must keep the file original (ask), got %q", v)
	}
	over := map[string]skills.SessionSkill{"plain": {Usable: "yolo"}, "pinned": {Usable: "yolo"}}
	if v, _ := useSkillUsableGate(over, args("plain")); v != "refuse" {
		t.Errorf("fallback deny original must stay locked, got %q", v)
	}
	if v, _ := useSkillUsableGate(over, args("pinned")); v != "approve" {
		t.Errorf("session yolo override must approve, got %q", v)
	}
}

// Turn-end commit hygiene (spec §6): neither use_skill calls/results nor
// the ephemeral user-deactivated-skill notices may join the persisted
// transcript; ordinary messages of the turn (and older turns) survive.
func TestStripSkillArtifactsDropsNoticesAndUseSkill(t *testing.T) {
	notice := skillNoticeMessage("foo")
	notice.TurnIndex = 7
	msgs := []provider.Message{
		{Role: provider.RoleUser, TurnIndex: 7, Content: []provider.Content{provider.TextBlock{Text: "hi"}}},
		{Role: provider.RoleAssistant, TurnIndex: 7, Content: []provider.Content{
			provider.ToolCallBlock{Name: "use_skill"},
			provider.ToolCallBlock{Name: "read"},
		}},
		{Role: provider.RoleUser, TurnIndex: 7, Content: []provider.Content{
			provider.ToolResultBlock{Details: map[string]any{"skill": "foo"}},
		}},
		notice,
		{Role: provider.RoleAssistant, TurnIndex: 6, Content: []provider.Content{provider.ToolCallBlock{Name: "use_skill"}}},
	}
	out := stripSkillArtifacts(msgs, 7)
	joined := ""
	for _, m := range out {
		for _, c := range m.Content {
			switch b := c.(type) {
			case provider.TextBlock:
				joined += b.Text + "|"
			case provider.ToolCallBlock:
				joined += "call:" + b.Name + "|"
			case provider.ToolResultBlock:
				joined += "result|"
			}
		}
	}
	want := "hi|call:read|call:use_skill|"
	if joined != want {
		t.Fatalf("stripped turn = %q, want %q (use_skill pair + notice dropped, other turns untouched)", joined, want)
	}
}
