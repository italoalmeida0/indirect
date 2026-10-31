package main

import (
	"strings"
	"testing"

	"indirect/indirect-code-daemon/packages/provider"
	"indirect/indirect-code-daemon/packages/skills"
)

func TestBuildSkillPrefixOrdersAndWraps(t *testing.T) {
	eff := skills.Effective{
		Order:  []string{"plan", "review"},
		Bodies: map[string]string{"plan": "plan body", "review": "review body"},
	}
	got := buildSkillPrefix(eff)
	want := "<skill id=\"plan\">plan body</skill>\n<skill id=\"review\">review body</skill>"
	if got != want {
		t.Fatalf("prefix:\n%q\nwant:\n%q", got, want)
	}
	if buildSkillPrefix(skills.Effective{}) != "" {
		t.Fatal("empty skill set must produce no prefix")
	}
}

func TestInjectSkillsPrefixIsRequestOnly(t *testing.T) {
	meta := map[string]string{}
	markTurnPrompt(meta)
	msgs := []provider.Message{
		{ID: "m1", Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "old turn"}}},
		{ID: "m2", Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "reply"}}},
		{ID: "m3", Role: provider.RoleUser, Meta: meta, Content: []provider.Content{provider.TextBlock{Text: "current"}}},
	}
	out := injectSkillsPrefix(msgs, "<skill id=\"x\">body</skill>")

	// The marked message gains the prefix as its first block...
	blocks := out[2].Content
	if len(blocks) != 2 {
		t.Fatalf("expected 2 blocks, got %d", len(blocks))
	}
	if tb, ok := blocks[0].(provider.TextBlock); !ok || tb.Text != "<skill id=\"x\">body</skill>" {
		t.Fatalf("first block must be the prefix, got %v", blocks[0])
	}
	// ...while the ORIGINAL list is untouched (request-only injection).
	if len(msgs[2].Content) != 1 {
		t.Fatal("transcript copy must not carry the skill prefix")
	}
	// Other messages are untouched.
	if out[0].ID != "m1" || len(out[0].Content) != 1 {
		t.Fatal("non-marked messages must stay as they are")
	}
	// No prefix, no transformation.
	same := injectSkillsPrefix(msgs, "")
	if len(same) != 3 || len(same[2].Content) != 1 {
		t.Fatal("empty prefix must be a no-op")
	}
	// Unmarked history: injection is skipped entirely.
	unmarked := []provider.Message{{ID: "u", Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "hi"}}}}
	if got := injectSkillsPrefix(unmarked, "<skill/>"); len(got[0].Content) != 1 {
		t.Fatal("must not inject without a marked message")
	}
}

func TestSkillsDescriptionListsAvailableSkills(t *testing.T) {
	prev := skillRegistry()
	defer func() { swapSkillRegistry(prev) }()
	swapSkillRegistry(&skillStore{list: map[string]skills.Skill{
		"plan":   {Name: "plan", Description: "planning", Mode: "agentic", Usable: "ask"},
		"secret": {Name: "secret", Description: "hidden", Mode: "agentic", Usable: "deny"},
		"talky":  {Name: "talky", Description: "chat", Mode: "talk"},
	}})
	sec := skillRegistry().skillsDescription("agentic", map[string]skills.SessionSkill{
		"plan": {Active: true},
	})
	if !strings.Contains(sec, "- plan: planning") {
		t.Fatalf("available skill must be listed:\n%s", sec)
	}
	if strings.Contains(sec, "secret") {
		t.Fatalf("usable:deny skill must stay hidden:\n%s", sec)
	}
	if strings.Contains(sec, "talky") {
		t.Fatalf("other-mode skill must not be listed:\n%s", sec)
	}
}
