package main

import (
	"strings"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/skills"
)

// registryForTest builds a registry with every builtin tool name so
// modeRegistry filtering can be asserted per mode.
func registryForTest() core.Registry {
	return core.NewRegistry(
		&tools.ReadTool{}, &tools.WriteTool{}, &tools.EditTool{},
		&tools.BashTool{}, &tools.PythonTool{}, &tools.GlobTool{}, &tools.SearchTool{},
		&tools.InspectTool{}, &tools.SearchWebTool{}, &tools.FetchURLTool{},
		&tools.QuestionTool{}, &tools.TodoTool{}, &tools.SummaryTool{},
		&tools.FinishEntireRequestTool{},
		&tools.BgAwaitTool{}, &tools.BgCheckTool{}, &tools.BgCancelTool{},
		&tools.UseSkillTool{},
		&tools.WidgetSetTool{}, &tools.WidgetListTool{}, &tools.WidgetLintTool{},
		&tools.WidgetReadTool{}, &tools.WidgetEditTool{},
	)
}

func registryNames(reg core.Registry) map[string]bool {
	names := map[string]bool{}
	for name := range reg {
		names[name] = true
	}
	return names
}

// The base registry carries ONLY the mode's auto tools (use_skill
// everywhere; summary + completion on agentic). Everything else is
// skill-granted — nothing else is present until a skill grants it.
func TestModeRegistryAllowlistPerMode(t *testing.T) {
	full := registryForTest()
	for mode, want := range map[string][]string{
		"agentic": {"use_skill", "summary", "finish_entire_request"},
		"talk":    {"use_skill"},
		// Legacy wire values normalize to the base modes.
		"build": {"use_skill", "summary", "finish_entire_request"},
	} {
		got := registryNames(modeRegistry(full, mode))
		for _, name := range want {
			if !got[name] {
				t.Errorf("mode %q: missing auto tool %q", mode, name)
			}
		}
		if len(got) != len(want) {
			t.Errorf("mode %q: registry has %d tools, want %d (%v)", mode, len(got), len(want), got)
		}
	}
}

// The chain grants tools (an explicit ask/yolo entry anywhere in the
// inherit chain); the base is deny — a tool no scope lists never appears.
// Being listed in a mode's exclusive ceiling never auto-activates a tool.
func TestSkillsRegistryDenyProjection(t *testing.T) {
	full := registryForTest()
	eff := skills.Effective{
		Mode:       "agentic",
		HasVisible: true,
		Chain: []skills.Skill{
			{Name: "main", Permissions: map[string]skills.PermSpec{
				"bash": {Policy: skills.PolicyYolo},
				"read": {Policy: skills.PolicyAsk},
			}},
			{Name: "base", Permissions: map[string]skills.PermSpec{
				"write": {Policy: skills.PolicyDeny},
				"edit":  {Policy: skills.PolicyDeny},
				"bash":  {Policy: skills.PolicyDeny},
			}},
		},
	}
	got := registryNames(skillsRegistry(full, eff))
	// main answers bash (yolo) over base (deny); write/edit hit the base.
	for _, banned := range []string{"write", "edit", "patch"} {
		if got[banned] {
			t.Errorf("denied tool %q must vanish from the registry", banned)
		}
	}
	for _, keep := range []string{"bash", "read", "summary", "finish_entire_request", "use_skill"} {
		if !got[keep] {
			t.Errorf("tool %q must be present", keep)
		}
	}
	// Tools no scope lists are denied — the base is deny for everything.
	for _, absent := range []string{"search_web", "fetch_url", "question", "todo"} {
		if got[absent] {
			t.Errorf("ungranted tool %q must not appear", absent)
		}
	}
}

// No visible skill (only usable:never contributing) -> no use_skill tool.
func TestSkillsRegistryHidesUseSkillWithoutVisibleSkills(t *testing.T) {
	full := registryForTest()
	eff := skills.Effective{Mode: "agentic", HasVisible: false}
	got := registryNames(skillsRegistry(full, eff))
	if got["use_skill"] {
		t.Error("use_skill must not appear when no skill is visible to the AI")
	}
	if !got["summary"] {
		t.Error("auto tools stay")
	}
}

// Exclusive ceilings: workspace tools never appear in talk even when a
// skill grants them; talk has no exclusive tools.
func TestSkillsRegistryModeCeiling(t *testing.T) {
	full := registryForTest()
	eff := skills.Effective{
		Mode:       "talk",
		HasVisible: true,
		Chain: []skills.Skill{{Name: "talky", Permissions: map[string]skills.PermSpec{
			"read":       {Policy: skills.PolicyYolo},
			"bash":       {Policy: skills.PolicyYolo},
			"search_web": {Policy: skills.PolicyAsk},
			"widget_set": {Policy: skills.PolicyAsk},
		}}},
	}
	got := registryNames(skillsRegistry(full, eff))
	for _, banned := range []string{"read", "bash", "write", "edit", "patch", "summary", "finish_entire_request"} {
		if got[banned] {
			t.Errorf("talk must never expose %q", banned)
		}
	}
	for _, keep := range []string{"search_web", "widget_set", "use_skill"} {
		if !got[keep] {
			t.Errorf("talk must expose %q (granted or auto)", keep)
		}
	}
}

// talk never advertises workspace tools; agentic keeps the completion
// signal (the same tool name everywhere).
func TestModeRegistryExcludesForeignModeTools(t *testing.T) {
	full := registryForTest()
	talk := registryNames(modeRegistry(full, "talk"))
	for _, banned := range []string{"read", "write", "edit", "patch", "bash", "python", "glob", "search", "inspect", "summary", "bg_await", "bg_check", "bg_cancel", "finish_entire_request"} {
		if talk[banned] {
			t.Errorf("talk must not advertise %q", banned)
		}
	}
	if !registryNames(modeRegistry(full, "agentic"))["finish_entire_request"] {
		t.Errorf("agentic must advertise finish_entire_request")
	}
	// Completion and summary are mode machinery: always present on
	// agentic, immune to skill rules (they are not configurable in .md).
	eff := skills.Effective{Mode: "agentic", HasVisible: true, Chain: []skills.Skill{
		{Name: "x", Permissions: map[string]skills.PermSpec{
			"summary":               {Policy: skills.PolicyDeny},
			"finish_entire_request": {Policy: skills.PolicyDeny},
			"use_skill":             {Policy: skills.PolicyDeny},
		}},
	}}
	got := registryNames(skillsRegistry(full, eff))
	for _, keep := range []string{"summary", "finish_entire_request", "use_skill"} {
		if !got[keep] {
			t.Errorf("auto tool %q must stay despite skill deny", keep)
		}
	}
}

// The system prompt is rebuilt per mode and must be self-contained: it
// describes the active mode and never the sibling modes.
func TestSessionSystemPromptIsModeClean(t *testing.T) {
	cfg := DaemonConfig{}
	modeNames := map[string]string{
		"agentic": "Build mode", "talk": "Talk mode",
	}
	completionTools := map[string]string{
		"agentic": "finish_entire_request", "talk": "",
	}
	for _, mode := range []string{"agentic", "talk"} {
		prompt := sessionSystemPrompt(cfg, "/tmp/work", SessionOptions{Mode: mode})
		for _, leak := range []string{"Modes of operation", "current active mode", "system-reminder> at the beginning", "Build and Learning", "Plan and Learning", "build and learning", "switch to"} {
			if strings.Contains(prompt, leak) {
				t.Errorf("prompt for mode %q leaks %q", mode, leak)
			}
		}
		// Sibling mode names must never appear; the active mode's own name is fine.
		for other, name := range modeNames {
			if other == mode {
				continue
			}
			if strings.Contains(prompt, name) {
				t.Errorf("prompt for mode %q leaks sibling mode %q", mode, name)
			}
		}
		// No legacy completion tool name may ever appear again.
		for _, name := range []string{"mark_task_as_complete", "mark_plan_as_ready_to_execute"} {
			if name == completionTools[mode] {
				continue
			}
			if strings.Contains(prompt, name) {
				t.Errorf("prompt for mode %q leaks foreign completion tool %q", mode, name)
			}
		}
	}
	// The BARE system prompt no longer names the completion tool — the
	// behavioral instructions live in skills (agentic_base carries the
	// completion contract; talk_base must never mention it).
	agenticBase := mustBuiltinSkill(t, "agentic_base.md")
	if !strings.Contains(agenticBase, "finish_entire_request") {
		t.Error("agentic_base skill must name the completion tool")
	}
	talkBase := mustBuiltinSkill(t, "talk_base.md")
	if strings.Contains(talkBase, "finish_entire_request") {
		t.Error("talk_base must not name a completion tool")
	}
}

// mustBuiltinSkill reads one builtin skill definition from the embedded FS.
func mustBuiltinSkill(t *testing.T, name string) string {
	t.Helper()
	data, err := builtinSkillsFS.ReadFile("builtin_skills/" + name)
	if err != nil {
		t.Fatalf("builtin skill %s: %v", name, err)
	}
	return string(data)
}

// The completion tool description is mode-specific: the learning variant
// carries the tutoring contract, the build variant does not mention it.
func TestMarkTaskDescriptionPerMode(t *testing.T) {
	build := (&tools.FinishEntireRequestTool{Mode: "build"}).Description()
	learning := (&tools.FinishEntireRequestTool{Mode: "learning"}).Description()
	if build == learning {
		t.Fatalf("build and learning descriptions must differ")
	}
	if strings.Contains(build, "guiding question") || strings.Contains(build, "solution") {
		t.Errorf("build description leaks learning guidance: %q", build)
	}
	if !strings.Contains(learning, "guiding question") {
		t.Errorf("learning description missing tutoring contract: %q", learning)
	}
	for _, desc := range []string{build, learning} {
		for _, leak := range []string{"Build or Learning", "in Plan mode", "Learning mode", "Build mode"} {
			if strings.Contains(desc, leak) {
				t.Errorf("description %q leaks %q", desc, leak)
			}
		}
	}
	plan := (&tools.FinishEntireRequestTool{Mode: "plan"}).Description()
	if strings.Contains(plan, "Plan mode") {
		t.Errorf("plan description leaks mode name: %q", plan)
	}
	// One tool, one name: only the description varies with the mode.
	if (&tools.FinishEntireRequestTool{Mode: "plan"}).Name() != (&tools.FinishEntireRequestTool{Mode: "build"}).Name() {
		t.Errorf("plan and build must expose the same tool name")
	}
}

// Tool descriptions must not enumerate the modes they are available in —
// availability is expressed by the per-mode registry alone.
func TestToolDescriptionsDoNotEnumerateModes(t *testing.T) {
	all := []core.Tool{
		&tools.ReadTool{}, &tools.WriteTool{}, &tools.EditTool{},
		&tools.BashTool{}, &tools.GlobTool{}, &tools.SearchTool{},
		&tools.InspectTool{}, &tools.SearchWebTool{}, &tools.FetchURLTool{},
		&tools.QuestionTool{}, &tools.TodoTool{}, &tools.SummaryTool{},
		&tools.FinishEntireRequestTool{Mode: "build"}, &tools.FinishEntireRequestTool{Mode: "plan"},
		&tools.BgAwaitTool{}, &tools.BgCheckTool{}, &tools.BgCancelTool{},
	}
	for _, tool := range all {
		desc := tool.Description()
		for _, leak := range []string{"Available in", "only available", "Build or Learning", "plan, build and learning", "in Plan mode", "in Build mode", "in Learning mode", "in talk mode"} {
			if strings.Contains(desc, leak) {
				t.Errorf("%s description leaks availability %q: %q", tool.Name(), leak, desc)
			}
		}
	}
}
