package main

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"indirect/indirect-code-daemon/packages/skills"
)

// Builtin skills live ONLY in the binary: builtin_skills/*.js is embedded
// and parsed from RAM, never written to the machine's skills directory.
func TestBuiltinSkillsParseFromBinary(t *testing.T) {
	entries, err := fs.ReadDir(builtinSkillsFS, "builtin_skills")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 19 {
		t.Fatalf("embedded builtin files = %d, want 19", len(entries))
	}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".js") {
			t.Fatalf("builtin skill file %q is not a JavaScript module", e.Name())
		}
	}

	list, errs := builtinSkills()
	if len(errs) > 0 {
		t.Fatalf("builtin parse errors: %v", errs)
	}
	if len(list) != 19 {
		t.Fatalf("parsed builtins = %d, want 19: %v", len(list), list)
	}
	for _, name := range []string{
		"agentic_base", "talk", "build", "plan", "learning",
		"generative_ui", "generative_ui_agentic", "generative_ui_talk",
		"genui_games", "genui_visualizers", "genui_dashboards", "genui_engineering",
		"genui_ai_apps", "genui_forms", "genui_science", "genui_spatial",
		"genui_business", "genui_education", "genui_creative",
	} {
		if _, ok := list[name]; !ok {
			t.Fatalf("builtin %q missing from the embedded set", name)
		}
	}

	// Composition happens in JavaScript: each mode imports its base, spreads
	// it and appends its own body, so the loaded skill carries the complete
	// result — there is no dependency list left for Go to walk.
	for name, sk := range list {
		if strings.Contains(fmt.Sprint(sk.Permissions), "inherit") {
			t.Fatalf("%s still carries an unresolved inherit policy: %+v", name, sk.Permissions)
		}
	}
	agentic := list["agentic_base"]
	if agentic.Usable != "never" || agentic.Mode != "agentic" || len(agentic.Permissions) != 17 {
		t.Fatalf("agentic_base conversion drifted: %+v", agentic)
	}
	if agentic.Permissions["read"].Policy != skills.PolicyAsk || agentic.Permissions["session_history"].Policy != skills.PolicyYolo || agentic.Permissions["explore"].Policy != skills.PolicyAsk {
		t.Fatalf("agentic_base must keep the base grants: %+v", agentic.Permissions)
	}
	talk := list["talk"]
	if talk.Mode != "talk" || talk.ApprovalMode != "yolo" || talk.Usable != "deny" || talk.Permissions["search_web"].Policy != skills.PolicyYolo || talk.Permissions["session_history"].Policy != skills.PolicyYolo || !strings.HasPrefix(talk.Body, "You are a helpful AI assistant.") {
		t.Fatalf("talk conversion drifted: %+v", talk)
	}
	if talk.Permissions["widget_set"].Policy != skills.PolicyYolo || talk.Permissions["widget_set"].Args["src_file"] != skills.PolicyDeny {
		t.Fatalf("talk widget_set must keep the concrete policy plus the denied argument: %+v", talk.Permissions["widget_set"])
	}
	if !containsStr(talk.Provides, "generative_ui_talk") || !containsStr(talk.Provides, "generative_ui") {
		t.Fatalf("talk must spread generative_ui_talk provides: %+v", talk.Provides)
	}
	build := list["build"]
	if build.Mode != "agentic" || build.Usable != "deny" || build.Permissions["read"].Policy != skills.PolicyAsk {
		t.Fatalf("build conversion drifted: %+v", build)
	}
	gen := list["generative_ui"]
	if gen.Usable != "never" || gen.Permissions["widget_set"].Policy != skills.PolicyYolo || !strings.HasPrefix(gen.Body, "# Interactive widgets (generative_ui)") || !containsStr(gen.Provides, "generative_ui") {
		t.Fatalf("generative_ui conversion drifted: usable=%q provides=%v body=%q...", gen.Usable, gen.Provides, gen.Body[:min(40, len(gen.Body))])
	}
	genTalk := list["generative_ui_talk"]
	// The base grants widget_set as "yolo"; talk narrows one argument, so the
	// policy is restated as the concrete value a chain would have resolved to.
	if genTalk.Usable != "never" || genTalk.Permissions["widget_set"].Policy != skills.PolicyYolo || genTalk.Permissions["widget_set"].Args["src_file"] != skills.PolicyDeny || !containsStr(genTalk.Provides, "generative_ui_talk") {
		t.Fatalf("generative_ui_talk conversion drifted: %+v", genTalk)
	}
	// Agentic widgets are discoverable and self-activatable by the agent via
	// use_skill (usable: "yolo"), pinned to agentic sessions.
	if genAgentic := list["generative_ui_agentic"]; genAgentic.Usable != "yolo" || genAgentic.Mode != "agentic" || !containsStr(genAgentic.Provides, "generative_ui_agentic") || genAgentic.Permissions["widget_read"].Policy != skills.PolicyDeny || genAgentic.Permissions["widget_edit"].Policy != skills.PolicyDeny || genAgentic.Permissions["widget_set"].Policy != skills.PolicyYolo {
		t.Fatalf("generative_ui_agentic conversion drifted: %+v", genAgentic)
	}
	// Text-only gated Gen-UI subskills: no extra tool permissions, usable:"yolo",
	// properly gated behind their parent Gen-UI skill(s).
	sharedSubskills := []string{
		"genui_visualizers", "genui_dashboards",
		"genui_ai_apps", "genui_forms", "genui_science", "genui_spatial",
		"genui_business", "genui_education", "genui_creative",
	}
	allSubskills := append([]string{"genui_games", "genui_engineering"}, sharedSubskills...)
	for _, name := range allSubskills {
		sk := list[name]
		if sk.Usable != "yolo" || !sk.IsGated() || len(sk.Permissions) != 0 || strings.TrimSpace(sk.Body) == "" {
			t.Fatalf("gated subskill %q drifted: usable=%q gated=%v perms=%v", name, sk.Usable, sk.IsGated(), sk.Permissions)
		}
	}
	if sk := list["genui_games"]; sk.Mode != "talk" || !containsStr(sk.Requires, "generative_ui_talk") {
		t.Fatalf("genui_games gating drifted: %+v", sk)
	}
	if sk := list["genui_engineering"]; sk.Mode != "agentic" || !containsStr(sk.Requires, "generative_ui_agentic") {
		t.Fatalf("genui_engineering gating drifted: %+v", sk)
	}
	for _, name := range sharedSubskills {
		sk := list[name]
		if sk.Mode != "" || !containsStr(sk.RequiresAny, "generative_ui_talk") || !containsStr(sk.RequiresAny, "generative_ui_agentic") {
			t.Fatalf("%s gating drifted: %+v", name, sk)
		}
	}
	for _, name := range []string{"plan", "learning"} {
		sk := list[name]
		if sk.Mode != "agentic" || sk.Permissions["write"].Policy != skills.PolicyDeny || sk.Permissions["edit"].Policy != skills.PolicyDeny {
			t.Fatalf("%s conversion drifted: %+v", name, sk)
		}
	}
}

func containsStr(list []string, target string) bool {
	for _, s := range list {
		if s == target {
			return true
		}
	}
	return false
}

// Verifies the REAL embedded builtin skills end-to-end across Talk, Build,
// Plan, and Learning modes: Talk immediately unlocks Talk + shared subskills;
// Agentic modes discover generative_ui_agentic while hiding all subskills
// until generative_ui_agentic activates (and Plan/Learning stay read-only).
func TestBuiltinGenUISubskillGatingEndToEnd(t *testing.T) {
	builtins, errs := builtinSkills()
	if len(errs) > 0 {
		t.Fatalf("builtin parse errors: %v", errs)
	}
	prev := skillRegistry()
	defer swapSkillRegistry(prev)
	swapSkillRegistry(&skillStore{list: builtins})

	// Talk: talk active -> genui_games + all shared subskills unlocked immediately.
	sharedSubskills := []string{
		"genui_visualizers", "genui_dashboards",
		"genui_ai_apps", "genui_forms", "genui_science", "genui_spatial",
		"genui_business", "genui_education", "genui_creative",
	}
	talkSel := map[string]skills.SessionSkill{"talk": {Priority: 1, Active: true}}
	talkEff, err := skillRegistry().resolveSession(talkSel, "talk")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range append([]string{"genui_games"}, sharedSubskills...) {
		if !talkEff.Listed[want] {
			t.Errorf("talk must list %q immediately: %+v", want, talkEff.Listed)
		}
	}
	for _, hidden := range []string{"generative_ui_agentic", "genui_engineering"} {
		if talkEff.Listed[hidden] {
			t.Errorf("talk must hide %q: %+v", hidden, talkEff.Listed)
		}
	}

	// Build, Plan, Learning: before & after generative_ui_agentic activation.
	allHiddenBefore := append([]string{"genui_games", "genui_engineering"}, sharedSubskills...)
	allWantAfter := append([]string{"generative_ui_agentic", "genui_engineering"}, sharedSubskills...)
	for _, modeSkill := range []string{"build", "plan", "learning"} {
		beforeSel := map[string]skills.SessionSkill{modeSkill: {Priority: 1, Active: true}}
		effBefore, err := skillRegistry().resolveSession(beforeSel, "agentic")
		if err != nil {
			t.Fatalf("%s before: %v", modeSkill, err)
		}
		if !effBefore.Listed["generative_ui_agentic"] {
			t.Errorf("%s must list generative_ui_agentic: %+v", modeSkill, effBefore.Listed)
		}
		for _, hidden := range allHiddenBefore {
			if effBefore.Listed[hidden] {
				t.Errorf("%s before genui must hide %q: %+v", modeSkill, hidden, effBefore.Listed)
			}
		}
		if effBefore.ToolDecision("widget_set") != skills.PolicyDeny {
			t.Errorf("%s before genui must not grant widget_set", modeSkill)
		}

		afterSel := map[string]skills.SessionSkill{
			modeSkill:               {Priority: 1, Active: true},
			"generative_ui_agentic": {Priority: 2, Active: true},
		}
		effAfter, err := skillRegistry().resolveSession(afterSel, "agentic")
		if err != nil {
			t.Fatalf("%s after: %v", modeSkill, err)
		}
		for _, want := range allWantAfter {
			if !effAfter.Listed[want] {
				t.Errorf("%s after genui must list %q: %+v", modeSkill, want, effAfter.Listed)
			}
		}
		if effAfter.Listed["genui_games"] {
			t.Errorf("%s must keep talk-only genui_games hidden", modeSkill)
		}
		if effAfter.ToolDecision("widget_set") != skills.PolicyYolo || effAfter.ToolDecision("widget_list") != skills.PolicyYolo || effAfter.ToolDecision("widget_lint") != skills.PolicyYolo {
			t.Errorf("%s after genui must grant widget_set/list/lint", modeSkill)
		}
		if effAfter.ToolDecision("widget_read") != skills.PolicyDeny || effAfter.ToolDecision("widget_edit") != skills.PolicyDeny {
			t.Errorf("%s after genui must keep widget_read/edit denied", modeSkill)
		}
		if modeSkill != "build" {
			if effAfter.ToolDecision("write") != skills.PolicyDeny || effAfter.ToolDecision("edit") != skills.PolicyDeny {
				t.Errorf("%s after genui must remain read-only for write/edit", modeSkill)
			}
		}
	}
}

// Builtin names are RESERVED: a user skill with the same NAME as a builtin
// is ignored entirely — builtins cannot be overridden from the skills
// directory. Distinct names merge.
func TestSkillStoreBuiltinsShadowDisk(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "skills"), 0o755); err != nil {
		t.Fatal(err)
	}
	body := `export default { name: "build", description: "MINE", usable: "yolo", body: "my body" };`
	if err := os.WriteFile(filepath.Join(dir, "skills", "build.js"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	custom := `export default { name: "minha_skill", description: "custom", permissions: { read: "yolo" }, body: "custom body" };`
	if err := os.WriteFile(filepath.Join(dir, "skills", "minha.js"), []byte(custom), 0o644); err != nil {
		t.Fatal(err)
	}

	var store skillStore
	store.initFrom(dir)

	// The builtin wins: the user's same-name file must not change a byte
	// of it (compared against the embedded set itself, not a literal).
	builtins, _ := builtinSkills()
	want := builtins["build"]
	sk, ok := store.get("build")
	if !ok {
		t.Fatal("build missing")
	}
	if sk.Description != want.Description || sk.Body != want.Body {
		t.Fatalf("builtin must shadow the disk skill: got %+v, want builtin %+v", sk, want)
	}
	// The ignored override is reported, never applied silently.
	found := false
	for _, e := range store.loadErrors() {
		if strings.Contains(e.Error(), `"build"`) && strings.Contains(e.Error(), "builtin") {
			found = true
		}
	}
	if !found {
		t.Fatalf("shadowed user skill must surface a load error, got %v", store.loadErrors())
	}
	if _, ok := store.get("minha_skill"); !ok {
		t.Fatal("custom disk skill missing")
	}
	// Builtins without a same-name disk file are still merged in.
	if _, ok := store.get("agentic_base"); !ok {
		t.Fatal("unshadowed builtin must stay available")
	}
	// Builtins are never written to the machine's skills directory.
	entries, err := os.ReadDir(filepath.Join(dir, "skills"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("skills dir must hold only the user's files, got %d", len(entries))
	}
}

// Disk skills compose ON TOP of builtins: a disk file imports an embedded
// module by its stem, even though the builtin name stays reserved.
func TestSkillStoreDiskSkillImportsBuiltin(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "skills"), 0o755); err != nil {
		t.Fatal(err)
	}
	combo := `
import agenticBase from "skill:agentic_base";

export default {
  ...agenticBase,
  name: "custom_combo",
  description: "combo over a builtin",
  usable: "ask",
  mode: "agentic",
  permissions: { ...agenticBase.permissions, edit: "deny" },
  body: agenticBase.body + "\ncombo body",
};
`
	if err := os.WriteFile(filepath.Join(dir, "skills", "combo.js"), []byte(combo), 0o644); err != nil {
		t.Fatal(err)
	}
	var store skillStore
	store.initFrom(dir)
	sk, ok := store.get("custom_combo")
	if !ok {
		t.Fatalf("disk combo missing (load errors: %v)", store.loadErrors())
	}
	if sk.Mode != "agentic" || sk.Permissions["read"].Policy != skills.PolicyAsk || sk.Permissions["edit"].Policy != skills.PolicyDeny {
		t.Fatalf("combo lost the imported base: %+v", sk)
	}
	if !strings.HasSuffix(sk.Body, "combo body") || !strings.Contains(sk.Body, "You are an expert autonomous AI software engineering agent") {
		t.Fatalf("combo body must concatenate the imported base body, got %q", sk.Body)
	}
}

// The embedded set must parse with the same module loader as disk skills
// (a syntax change in packages/skills breaks the builtins loudly).
func TestBuiltinSkillsFollowDiskParser(t *testing.T) {
	list, errs := builtinSkills()
	if len(errs) > 0 {
		t.Fatalf("builtin parse errors: %v", errs)
	}
	for name, sk := range list {
		if sk.Name != name {
			t.Fatalf("builtin %q parses as %q", name, sk.Name)
		}
		if _, err := skills.UsableValue(sk, ""); err != nil {
			t.Fatalf("builtin %q: %v", name, err)
		}
	}
}
