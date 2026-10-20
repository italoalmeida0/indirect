package skills

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeSkill(t *testing.T, dir, name, src string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
}

func errorsText(errs []error) string {
	parts := make([]string, len(errs))
	for i, err := range errs {
		parts[i] = err.Error()
	}
	return strings.Join(parts, "\n")
}

// A skill imports another module by file stem and composes it with plain
// JavaScript: spreading the base copies its values, and the copy is
// independent (mutating the derived skill must not touch the base).
func TestLoadImportByStemComposesInJS(t *testing.T) {
	dir := t.TempDir()
	writeSkill(t, dir, "z_base_file.js", `
export default {
  name: "base",
  description: "base skill",
  usable: "ask",
  mode: "agentic",
  permissions: { read: "ask", bash: "ask" },
  body: "base body",
};
`)
	writeSkill(t, dir, "a_combo.js", `
import base from "skill:z_base_file";

const permissions = { ...base.permissions, bash: "deny" };
export default {
  ...base,
  name: "combo",
  description: "combo skill",
  permissions,
  body: base.body + "\ncombo body",
};
`)

	list, errs := Load(dir)
	if len(errs) > 0 {
		t.Fatalf("load errors: %s", errorsText(errs))
	}
	combo := list["combo"]
	if combo.Body != "base body\ncombo body" || combo.Permissions["bash"].Policy != PolicyDeny {
		t.Fatalf("combo lost the composed values: %+v", combo)
	}
	if combo.Permissions["read"].Policy != PolicyAsk {
		t.Fatalf("spread dropped an inherited permission: %+v", combo.Permissions)
	}
	base := list["base"]
	if base.Body != "base body" || base.Permissions["bash"].Policy != PolicyAsk {
		t.Fatalf("composed skill mutated the base skill: %+v", base)
	}
}

// A specifier names the MODULE (its file stem), not the skill name the module
// declares: resolution must not need another module evaluated first.
func TestLoadImportUsesTheFileStem(t *testing.T) {
	dir := t.TempDir()
	writeSkill(t, dir, "z_file.js", `
export default { name: "published", description: "d", usable: "ask", body: "published body" };
`)
	writeSkill(t, dir, "combo.js", `
import published from "skill:published";
export default { ...published, name: "combo", description: "c", body: published.body + "!" };
`)
	list, errs := Load(dir)
	if len(list) != 1 || list["published"].Body != "published body" {
		t.Fatalf("only the base file may load, got %v", list)
	}
	text := errorsText(errs)
	if !strings.Contains(text, `no skill module "published"`) || !strings.Contains(text, "z_file") {
		t.Fatalf("the error must name the specifier and the modules that exist:\n%s", text)
	}
}

// Stem matching ignores case, so a hand-written import does not fail on
// capitalization.
func TestLoadImportStemIsCaseInsensitive(t *testing.T) {
	dir := t.TempDir()
	writeSkill(t, dir, "Agentic_Base.js", `
export default { name: "agentic_base", description: "d", usable: "never", body: "base body" };
`)
	writeSkill(t, dir, "combo.js", `
import base from "skill:agentic_base";
export default { ...base, name: "combo", description: "c", body: base.body + "!" };
`)
	list, errs := Load(dir)
	if len(errs) > 0 {
		t.Fatalf("load errors: %s", errorsText(errs))
	}
	if got := list["combo"].Body; got != "base body!" {
		t.Fatalf("case-insensitive import gave %q", got)
	}
}

// The removed features are gone on purpose: `inherit` is refused with a
// message that shows the replacement, and require()/skill.extend() no
// longer exist in the sandbox.
func TestLoadRejectsRetiredComposition(t *testing.T) {
	cases := map[string]string{
		"inherit.js": `export default {
  name: "inheritbad",
  description: "d",
  body: "b",
  inherit: ["agentic_base"],
};
`,
		"require.js": `const base = require("agentic_base");
export default { name: "requirebad", description: "d", body: base.body };
`,
		"extend.js": `export default skill.extend({ name: "extendsbad", description: "d", body: "b" });
`,
	}
	for file, src := range cases {
		dir := t.TempDir()
		writeSkill(t, dir, file, src)
		list, errs := Load(dir)
		if len(list) != 0 {
			t.Fatalf("%s: retired composition still loaded as a skill: %v", file, list)
		}
		text := errorsText(errs)
		if text == "" {
			t.Fatalf("%s: retired composition was accepted silently", file)
		}
		if file == "inherit.js" && !strings.Contains(text, "skill:agentic_base") {
			t.Fatalf("the inherit error must show the import replacement:\n%s", text)
		}
	}
}

func TestLoadImportCycleAndMissingModule(t *testing.T) {
	dir := t.TempDir()
	writeSkill(t, dir, "a.js", `
import b from "skill:b";
export default { name: "a", description: "a", body: b.body };
`)
	writeSkill(t, dir, "b.js", `
import a from "skill:a";
export default { name: "b", description: "b", body: a.body };
`)
	writeSkill(t, dir, "c.js", `
import missing from "skill:does_not_exist";
export default { name: "c", description: "c", body: missing.body };
`)

	done := make(chan struct{})
	go func() {
		defer close(done)
		list, errs := Load(dir)
		if len(list) != 0 {
			t.Errorf("cycle/missing skills must not load, got %v", list)
		}
		text := errorsText(errs)
		if !strings.Contains(text, "cyclic") && !strings.Contains(text, "cycle") {
			t.Errorf("errors must name the import cycle:\n%s", text)
		}
		if !strings.Contains(text, "does_not_exist") {
			t.Errorf("errors must name the missing module:\n%s", text)
		}
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("Load hung on an import cycle")
	}
}

// Only `skill:<name>` resolves. Everything else — a package, a node:
// builtin, a relative or absolute path — is refused at link time.
func TestLoadImportSchemeIsLimited(t *testing.T) {
	cases := map[string]string{
		"package.js":  `import os from "node:os"; export default { name: "pkg", description: os.hostname(), body: "b" };`,
		"relative.js": `import x from "./a.js"; export default { name: "rel", description: "d", body: "b" };`,
		"absolute.js": `import x from "/etc/passwd"; export default { name: "abs", description: "d", body: "b" };`,
		"bare.js":     `import x from "agentic_base"; export default { name: "bare", description: "d", body: "b" };`,
	}
	for file, src := range cases {
		dir := t.TempDir()
		writeSkill(t, dir, file, src)
		list, errs := Load(dir)
		if len(list) != 0 {
			t.Fatalf("%s: non-skill import loaded: %v", file, list)
		}
		if text := errorsText(errs); !strings.Contains(text, "skill:") {
			t.Fatalf("%s: error should point at the skill: scheme, got:\n%s", file, text)
		}
	}
}

// Nothing outside the skill set is reachable: no host globals, no filesystem,
// no process, no network and no way to compile code. Every attempt below
// must fail to load, not silently read the host.
func TestLoadSandboxDeniesHostAccess(t *testing.T) {
	dir := t.TempDir()
	cases := map[string]string{
		"env.js":      `export default { name: "envbad", description: process.env.HOME, body: "b" };`,
		"file.js":     `const f = File; export default { name: "filebad", description: "d", body: "b" };`,
		"os.js":       `const os = require("node:os"); export default { name: "osbad", description: os.hostname(), body: "b" };`,
		"fetch.js":    `const r = fetch("http://example.com"); export default { name: "netbad", description: "d", body: "b" };`,
		"eval.js":     `export default { name: "evalbad", description: String(eval("1 + 1")), body: "b" };`,
		"func.js":     `const f = new Function("return 1"); export default { name: "funcbad", description: String(f()), body: "b" };`,
		"import.js":   `import * as os from "node:os"; export default { name: "importbad", description: os.hostname(), body: "b" };`,
		"dynamic.js":  `const m = await import("skill:agentic_base"); export default { name: "dynbad", description: "d", body: "b" };`,
		"importer.js": `import x from "skill:../agentic_base"; export default { name: "pathbad", description: "d", body: "b" };`,
	}
	for file, src := range cases {
		writeSkill(t, dir, file, src)
	}
	list, errs := Load(dir)
	if len(list) != 0 {
		t.Fatalf("sandbox escapes loaded as skills: %v", list)
	}
	if len(errs) < len(cases) {
		t.Fatalf("sandbox errors = %s", errorsText(errs))
	}
}

func TestParseTimeout(t *testing.T) {
	old := moduleTimeout
	moduleTimeout = 100 * time.Millisecond
	defer func() { moduleTimeout = old }()

	start := time.Now()
	_, err := Parse("loop.js", []byte(`while (true) {} export default { name: "loop", description: "d", body: "b" };`))
	if err == nil {
		t.Fatal("infinite JavaScript loop must be reported as a load error")
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("timeout took too long: %v", time.Since(start))
	}
	if !strings.Contains(err.Error(), "loop.js") {
		t.Fatalf("timeout error must name the skill file: %v", err)
	}
}

// Extra module sources (the builtin layer) are importable from disk skills
// but are not returned as disk skills themselves.
func TestLoadWithModulesImportsExtraLayer(t *testing.T) {
	dir := t.TempDir()
	writeSkill(t, dir, "combo.js", `
import base from "skill:embedded_base";

export default {
  ...base,
  name: "disk_combo",
  description: "disk combo",
  usable: "ask",
  body: base.body + " + disk body",
};
`)
	modules := []Source{{
		Path: "builtin_skills/embedded_base.js",
		Data: []byte(`
export default {
  name: "embedded_base",
  description: "embedded base",
  usable: "never",
  mode: "talk",
  permissions: { search_web: "yolo" },
  body: "embedded body",
};
`),
	}}
	list, errs := LoadWithModules(dir, modules)
	if len(errs) > 0 {
		t.Fatalf("load errors: %s", errorsText(errs))
	}
	if _, ok := list["embedded_base"]; ok {
		t.Fatal("module-only source must not be returned as a disk skill")
	}
	combo := list["disk_combo"]
	if combo.Mode != "talk" || combo.Permissions["search_web"].Policy != PolicyYolo {
		t.Fatalf("extra-layer import lost fields: %+v", combo)
	}
	if combo.Body != "embedded body + disk body" {
		t.Fatalf("extra-layer body = %q", combo.Body)
	}
}

// Imported modules share one VM and one deadline, so a runaway IMPORT is
// interrupted instead of stalling the loader.
func TestLoadImportSharesTheTimeout(t *testing.T) {
	old := moduleTimeout
	moduleTimeout = 150 * time.Millisecond
	defer func() { moduleTimeout = old }()

	dir := t.TempDir()
	writeSkill(t, dir, "spin.js", `while (true) {} export default { name: "spin", description: "d", body: "b" };`)
	writeSkill(t, dir, "root.js", `
import spin from "skill:spin";
export default { ...spin, name: "root" };
`)
	start := time.Now()
	list, errs := Load(dir)
	if len(list) != 0 {
		t.Fatalf("a runaway import loaded: %v", list)
	}
	if !strings.Contains(errorsText(errs), "timeout") {
		t.Fatalf("errors should report the timeout: %s", errorsText(errs))
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("interrupt took %s", time.Since(start))
	}
}

// The snapshot boundary still rejects oversized values: a shared-subtree
// DAG is charged every visit instead of expanding without bound.
func TestSnapshotRejectsOversizedSharedTable(t *testing.T) {
	src := `
let t = { leaf: "x" };
for (let i = 0; i < 24; i++) {
  t = { a: t, b: t };
}
export default { name: "big", description: "d", body: "b", extra: t };
`
	start := time.Now()
	if _, err := Parse("big.js", []byte(src)); err == nil {
		t.Fatal("oversized shared subtree must be rejected")
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("oversized snapshot took too long: %v", time.Since(start))
	}
}
