package main

import (
	"strings"
	"testing"

	"indirect/indirect-code-daemon/packages/core"
	"indirect/indirect-code-daemon/packages/provider"
	"indirect/indirect-code-daemon/packages/skills"
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
	prev := skillRegistry()
	ask := skills.PermSpec{Policy: skills.PolicyAsk}
	yolo := skills.PermSpec{Policy: skills.PolicyYolo}
	swapSkillRegistry(&skillStore{list: map[string]skills.Skill{
		"build": {Name: "build", Mode: "agentic", Permissions: map[string]skills.PermSpec{
			"read": ask, "write": ask, "edit": ask, "bash": ask, "exec_script": ask,
			"glob": ask, "search": ask, "inspect": ask,
			"search_web": ask, "fetch_url": ask,
			"bg_await": ask, "bg_check": ask, "bg_cancel": ask,
			"question": yolo, "todo": yolo,
		}},
	}})
	t.Cleanup(func() { swapSkillRegistry(prev) })
	return map[string]skills.SessionSkill{"build": {Priority: 1, Active: true}}
}

// The use_skill usable gate (spec §1): the approvalMode never influences
// it. yolo runs free; ask always asks the human; deny/never refuse. There
// is no file-level "inherit": a missing usable key in the skill module falls
// back to deny. At session level, a missing usable or explicit "inherit"
// means "use the skill file original" (no override).
func TestUseSkillUsableGate(t *testing.T) {
	prev := skillRegistry()
	defer func() { swapSkillRegistry(prev) }()
	swapSkillRegistry(&skillStore{list: map[string]skills.Skill{
		"free":   {Name: "free", Usable: "yolo"},
		"gate":   {Name: "gate", Usable: "ask"},
		"hidden": {Name: "hidden", Usable: "deny"},
		"base":   {Name: "base", Usable: "never"},
		"plain":  {Name: "plain"}, // no usable key in the skill module: deny fallback
		"pinned": {Name: "pinned", Usable: "ask"},
		"talky":  {Name: "talky", Usable: "yolo", Mode: "talk"},
		"agent":  {Name: "agent", Usable: "yolo", Mode: "agentic"},
	}})
	args := func(name string) []byte { return []byte(`{"name":"` + name + `"}`) }
	noOverrides := map[string]skills.SessionSkill{}

	cases := map[string]string{
		"free":    "approve",
		"gate":    "ask",
		"hidden":  "refuse",
		"base":    "refuse",
		"plain":   "refuse", // absent file usable = deny
		"unknown": "refuse", // nothing to approve: the load can only fail
		"talky":   "refuse", // pinned to another mode: hidden AND refused
		"agent":   "approve",
	}
	for skill, want := range cases {
		verdict, _ := useSkillUsableGate(noOverrides, "agentic", args(skill))
		if verdict != want {
			t.Errorf("gate(%q) = %q, want %q", skill, verdict, want)
		}
	}

	// Session "inherit" carries no override: an ask-original skill still
	// asks. An explicit session yolo override on that same original runs
	// free, while fallback-deny originals stay locked.
	inherit := map[string]skills.SessionSkill{"pinned": {Usable: "inherit"}}
	if v, _ := useSkillUsableGate(inherit, "agentic", args("pinned")); v != "ask" {
		t.Errorf("session inherit must keep the file original (ask), got %q", v)
	}
	over := map[string]skills.SessionSkill{"plain": {Usable: "yolo"}, "pinned": {Usable: "yolo"}}
	if v, _ := useSkillUsableGate(over, "agentic", args("plain")); v != "refuse" {
		t.Errorf("fallback deny original must stay locked, got %q", v)
	}
	if v, _ := useSkillUsableGate(over, "agentic", args("pinned")); v != "approve" {
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
	out, _ := stripSkillArtifacts(msgs, 7, -1)
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

// An assistant step whose only remaining content after the use_skill call
// was stripped is reasoning must not survive as an empty thinking bubble.
// Steps that never called use_skill, or still show text/image/other calls,
// stay.
func TestStripSkillArtifactsDropsReasoningOnlyUseSkillStep(t *testing.T) {
	msgs := []provider.Message{
		{ID: "plain-thinking", Role: provider.RoleAssistant, TurnIndex: 4, Content: []provider.Content{
			provider.ReasoningBlock{Summary: "no skill here"},
		}},
		{ID: "skill-thinking", Role: provider.RoleAssistant, TurnIndex: 4, Content: []provider.Content{
			provider.ReasoningBlock{Summary: "weighing a skill"},
			provider.ToolCallBlock{ID: "c1", Name: "use_skill"},
		}},
		{ID: "skill-result", Role: provider.RoleTool, TurnIndex: 4, Content: []provider.Content{
			provider.ToolResultBlock{CallID: "c1", Details: map[string]any{"skill": "foo"}},
		}},
		{ID: "skill-and-text", Role: provider.RoleAssistant, TurnIndex: 4, Content: []provider.Content{
			provider.ReasoningBlock{Summary: "answer next"},
			provider.ToolCallBlock{ID: "c2", Name: "use_skill"},
			provider.TextBlock{Text: "visible answer"},
		}},
		{ID: "skill-and-image", Role: provider.RoleAssistant, TurnIndex: 4, Content: []provider.Content{
			provider.ToolCallBlock{ID: "c3", Name: "use_skill"},
			provider.ImageBlock{MimeType: "image/png", Data: []byte{1}},
		}},
	}
	out, _ := stripSkillArtifacts(msgs, 4, -1)
	got := make([]string, 0, len(out))
	for _, m := range out {
		got = append(got, m.ID)
	}
	want := []string{"plain-thinking", "skill-and-text", "skill-and-image"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("surviving messages = %v, want %v", got, want)
	}
	for _, m := range out {
		for _, c := range m.Content {
			if call, ok := c.(provider.ToolCallBlock); ok && call.Name == "use_skill" {
				t.Fatalf("%s kept a use_skill call", m.ID)
			}
		}
	}
	if len(out[1].Content) != 2 {
		t.Fatalf("text step must keep reasoning + text, got %+v", out[1].Content)
	}
	if len(out[2].Content) != 1 {
		t.Fatalf("image step must keep the image, got %+v", out[2].Content)
	}
}

// Mid-turn compaction stores KeepFrom against the pre-strip transcript.
// finishTurn's strip removes use_skill rows/notices below that anchor, so
// the persisted anchor must shift left by exactly those removals.
func TestFinishTurnShiftsCompactionKeepFromAfterStrip(t *testing.T) {
	rec := &SessionRecord{
		ID:      "skill-keepfrom",
		TurnSeq: 2,
		Compaction: &core.CompactionState{
			PreviousSummary: "earlier work",
			KeepFrom:        6,
		},
		Messages: []provider.Message{
			{ID: "u1", Role: provider.RoleUser, TurnIndex: 1, Content: []provider.Content{provider.TextBlock{Text: "old question"}}},
			{ID: "a1", Role: provider.RoleAssistant, TurnIndex: 1, Content: []provider.Content{provider.TextBlock{Text: "old answer"}}},
			{ID: "u2", Role: provider.RoleUser, TurnIndex: 2, Content: []provider.Content{provider.TextBlock{Text: "new request"}}},
			{ID: "a2", Role: provider.RoleAssistant, TurnIndex: 2, Content: []provider.Content{
				provider.ReasoningBlock{Summary: "load it"},
				provider.ToolCallBlock{ID: "c1", Name: "use_skill"},
			}},
			{ID: "t2", Role: provider.RoleTool, TurnIndex: 2, Content: []provider.Content{
				provider.ToolResultBlock{CallID: "c1", Details: map[string]any{"skill": "foo"}},
			}},
			{ID: "n2", Role: provider.RoleUser, TurnIndex: 2, Meta: map[string]string{skillNoticeMetaKey: "foo"}, Content: []provider.Content{
				provider.TextBlock{Text: "[system notice] The user deactivated the skill foo"},
			}},
			{ID: "a3", Role: provider.RoleAssistant, TurnIndex: 2, Content: []provider.Content{provider.TextBlock{Text: "kept reply"}}},
			{ID: "u3", Role: provider.RoleUser, TurnIndex: 2, Content: []provider.Content{provider.TextBlock{Text: "kept tail"}}},
		},
	}
	a, _ := darActor(t, rec)
	a.finishTurn(true)

	got := make([]string, 0, len(a.rec.Messages))
	for _, m := range a.rec.Messages {
		got = append(got, m.ID)
	}
	want := []string{"u1", "a1", "u2", "a3", "u3"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("committed messages = %v, want %v", got, want)
	}
	if a.rec.Compaction == nil {
		t.Fatal("compaction state lost")
	}
	if a.rec.Compaction.KeepFrom != 3 {
		t.Fatalf("KeepFrom = %d, want 3 (three rows stripped below the old anchor 6)", a.rec.Compaction.KeepFrom)
	}
	if a.rec.Compaction.KeepFrom > len(a.rec.Messages) {
		t.Fatalf("KeepFrom %d out of range for %d messages", a.rec.Compaction.KeepFrom, len(a.rec.Messages))
	}
}

// An anchor that pointed at the old transcript end no longer exists after
// the strip; it must clamp to the new end (projectionAnchor fails open on an
// out-of-range index and silently drops the summary).
func TestStripSkillArtifactsClampsAnchorAtNewEnd(t *testing.T) {
	msgs := []provider.Message{
		{ID: "u", Role: provider.RoleUser, TurnIndex: 2, Content: []provider.Content{provider.TextBlock{Text: "hi"}}},
		{ID: "a", Role: provider.RoleAssistant, TurnIndex: 2, Content: []provider.Content{
			provider.ReasoningBlock{Summary: "load"},
			provider.ToolCallBlock{ID: "c1", Name: "use_skill"},
		}},
		{ID: "t", Role: provider.RoleTool, TurnIndex: 2, Content: []provider.Content{
			provider.ToolResultBlock{CallID: "c1", Details: map[string]any{"skill": "foo"}},
		}},
		{ID: "n", Role: provider.RoleUser, TurnIndex: 2, Meta: map[string]string{skillNoticeMetaKey: "foo"}, Content: []provider.Content{
			provider.TextBlock{Text: "[system notice] The user deactivated the skill foo"},
		}},
	}
	out, anchor := stripSkillArtifacts(msgs, 2, len(msgs))
	if len(out) != 1 || out[0].ID != "u" {
		t.Fatalf("stripped transcript = %+v, want only the user row", out)
	}
	if anchor != len(out) {
		t.Fatalf("anchor = %d, want clamped to %d", anchor, len(out))
	}
}
