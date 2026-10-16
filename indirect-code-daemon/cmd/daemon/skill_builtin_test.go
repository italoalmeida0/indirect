package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/skills"
)

// Builtin skills live ONLY in the binary: builtin_skills/*.md is embedded
// and parsed from RAM, never written to the machine's skills directory.
func TestBuiltinSkillsParseFromBinary(t *testing.T) {
	list, errs := builtinSkills()
	if len(errs) > 0 {
		t.Fatalf("builtin parse errors: %v", errs)
	}
	for _, name := range []string{"agentic_base", "talk", "build", "plan", "learning", "generative_ui", "generative_ui_agentic", "generative_ui_talk"} {
		if _, ok := list[name]; !ok {
			t.Fatalf("builtin %q missing from the embedded set", name)
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
	body := "---\nname: build\ndescription: MINE\nusable: yolo\n---\nmy body\n"
	if err := os.WriteFile(filepath.Join(dir, "skills", "build.md"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	custom := "---\nname: minha_skill\ndescription: custom\ntools:\n  permissions:\n    read: yolo\n---\ncustom body\n"
	if err := os.WriteFile(filepath.Join(dir, "skills", "minha.md"), []byte(custom), 0o644); err != nil {
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

// The embedded set must parse with the same parser as disk skills (a syntax
// change in packages/skills breaks the builtins loudly).
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
