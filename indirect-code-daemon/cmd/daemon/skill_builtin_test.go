package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/skills"
)

// Builtin skills live ONLY in the binary: builtin_skills/*.js is embedded
// and parsed from RAM, never written to the machine's skills directory.
func TestBuiltinSkillsParseFromBinary(t *testing.T) {
	entries, err := fs.ReadDir(builtinSkillsFS, "builtin_skills")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 8 {
		t.Fatalf("embedded builtin files = %d, want 8", len(entries))
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
	if len(list) != 8 {
		t.Fatalf("parsed builtins = %d, want 8: %v", len(list), list)
	}
	for _, name := range []string{"agentic_base", "talk", "build", "plan", "learning", "generative_ui", "generative_ui_agentic", "generative_ui_talk"} {
		if _, ok := list[name]; !ok {
			t.Fatalf("builtin %q missing from the embedded set", name)
		}
	}

	// The module conversion must preserve the graph, policies and bodies.
	agentic := list["agentic_base"]
	if agentic.Usable != "never" || agentic.Mode != "agentic" || strings.Join(agentic.Inherit, ",") != "generative_ui_agentic" || len(agentic.Permissions) != 15 {
		t.Fatalf("agentic_base conversion drifted: %+v", agentic)
	}
	talk := list["talk"]
	if talk.Mode != "talk" || talk.ApprovalMode != "yolo" || talk.Usable != "deny" || strings.Join(talk.Inherit, ",") != "generative_ui_talk" || talk.Permissions["search_web"].Policy != skills.PolicyYolo || !strings.HasPrefix(talk.Body, "You are a helpful AI assistant.") {
		t.Fatalf("talk conversion drifted: %+v", talk)
	}
	if build := list["build"]; build.Mode != "agentic" || build.Usable != "deny" || strings.Join(build.Inherit, ",") != "agentic_base" || len(build.Permissions) != 0 {
		t.Fatalf("build conversion drifted: %+v", build)
	}
	gen := list["generative_ui"]
	if gen.Usable != "never" || gen.Permissions["widget_set"].Policy != skills.PolicyYolo || !strings.HasPrefix(gen.Body, "# Interactive widgets (generative_ui)") || !strings.HasSuffix(gen.Body, "are fully allowed.") {
		t.Fatalf("generative_ui conversion drifted: usable=%q body=%q...%q", gen.Usable, gen.Body[:min(40, len(gen.Body))], gen.Body[max(0, len(gen.Body)-40):])
	}
	genTalk := list["generative_ui_talk"]
	if genTalk.Usable != "deny" || genTalk.Permissions["widget_set"].Policy != skills.PolicyInherit || genTalk.Permissions["widget_set"].Args["src_file"] != skills.PolicyDeny {
		t.Fatalf("generative_ui_talk conversion drifted: %+v", genTalk)
	}
	if genAgentic := list["generative_ui_agentic"]; genAgentic.Usable != "yolo" || genAgentic.Permissions["widget_read"].Policy != skills.PolicyDeny {
		t.Fatalf("generative_ui_agentic conversion drifted: %+v", genAgentic)
	}
	for _, name := range []string{"plan", "learning"} {
		sk := list[name]
		if sk.Mode != "agentic" || sk.Permissions["write"].Policy != skills.PolicyDeny || sk.Permissions["edit"].Policy != skills.PolicyDeny {
			t.Fatalf("%s conversion drifted: %+v", name, sk)
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

// Disk skills compose ON TOP of builtins: require/skill.extend can import
// an embedded module even though its name stays reserved.
func TestSkillStoreDiskSkillCanExtendBuiltin(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "skills"), 0o755); err != nil {
		t.Fatal(err)
	}
	combo := `
export default skill.extend(require("agentic_base"), {
  name: "custom_combo",
  description: "combo over a builtin",
  usable: "ask",
  permissions: { edit: "deny" },
  body: "combo body",
});
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
	if strings.Join(sk.Inherit, ",") != "generative_ui_agentic,agentic_base" {
		t.Fatalf("combo inherit = %v, want the builtin chain registered", sk.Inherit)
	}
	if sk.Mode != "agentic" || sk.Permissions["read"].Policy != skills.PolicyAsk || sk.Permissions["edit"].Policy != skills.PolicyDeny {
		t.Fatalf("combo lost the builtin merge: %+v", sk)
	}
	if sk.Body != "combo body" {
		t.Fatalf("combo body must be only its own delta, got %q", sk.Body)
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
