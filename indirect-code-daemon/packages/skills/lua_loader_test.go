package skills

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeLuaSkill(t *testing.T, dir, name, src string) {
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

// require resolves a skill by its DECLARED name even when the requiring
// file sorts first and the dependency lives in a differently named file.
// The returned table is a copy: mutating it must not change the base skill.
func TestLoadRequireByDeclaredNameReturnsCopy(t *testing.T) {
	dir := t.TempDir()
	writeLuaSkill(t, dir, "z_base_file.lua", `
return {
  name = "base",
  description = "base skill",
  usable = "ask",
  mode = "agentic",
  permissions = { read = "ask", bash = "ask" },
  body = "base body",
}
`)
	writeLuaSkill(t, dir, "a_combo.lua", `
local by_name = require("base")
local by_stem = require("z_base_file")
if by_stem.name ~= "base" then error("stem require returned the wrong module") end
by_name.name = "combo"
by_name.description = "combo skill"
by_name.body = by_name.body .. "\ncombo body"
by_name.permissions.bash = "deny"
return by_name
`)

	list, errs := Load(dir)
	if len(errs) > 0 {
		t.Fatalf("load errors: %s", errorsText(errs))
	}
	combo := list["combo"]
	if combo.Body != "base body\ncombo body" || combo.Permissions["bash"].Policy != PolicyDeny {
		t.Fatalf("combo lost required copy edits: %+v", combo)
	}
	base := list["base"]
	if base.Body != "base body" || base.Permissions["bash"].Policy != PolicyAsk {
		t.Fatalf("require mutation leaked into the base skill: %+v", base)
	}
}

// skill.extend merges metadata/permissions, registers every base as an
// inherit dependency, and keeps only the override body on the new skill:
// base bodies arrive through Resolve's inherit chain, never twice.
func TestLoadSkillExtendMergesAndRegistersInherit(t *testing.T) {
	dir := t.TempDir()
	writeLuaSkill(t, dir, "a.lua", `
return {
  name = "a",
  description = "a skill",
  usable = "never",
  mode = "agentic",
  permissions = { read = "ask", edit = "ask" },
  body = "a body",
}
`)
	writeLuaSkill(t, dir, "b.lua", `
return {
  name = "b",
  description = "b skill",
  usable = "never",
  tools = {
    approvalMode = "ask",
    permissions = { bash = "ask", edit = "deny" },
  },
  body = "b body",
}
`)
	writeLuaSkill(t, dir, "combo.lua", `
return skill.extend("a", require("b"), {
  name = "combo",
  description = "combo skill",
  usable = "yolo",
  permissions = { write = "yolo" },
  body = "combo body",
})
`)

	list, errs := Load(dir)
	if len(errs) > 0 {
		t.Fatalf("load errors: %s", errorsText(errs))
	}
	combo := list["combo"]
	if strings.Join(combo.Inherit, ",") != "a,b" {
		t.Fatalf("extend inherit = %v, want [a b]", combo.Inherit)
	}
	if combo.Body != "combo body" || combo.Mode != "agentic" || combo.ApprovalMode != "ask" {
		t.Fatalf("extend result lost merged fields: %+v", combo)
	}
	for tool, want := range map[string]Policy{
		"read": PolicyAsk, "bash": PolicyAsk, "edit": PolicyDeny, "write": PolicyYolo,
	} {
		if got := combo.Permissions[tool].Policy; got != want {
			t.Fatalf("extend permission %s = %q, want %q (%+v)", tool, got, want, combo.Permissions)
		}
	}
	eff, err := Resolve(list, map[string]SessionSkill{"combo": {Priority: 1, Active: true}}, "agentic")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"combo", "a", "b"} {
		if eff.Bodies[name] == "" {
			t.Fatalf("resolved bodies missing %q: %v", name, eff.Order)
		}
	}
}

func TestLoadRequireCycleAndMissingModule(t *testing.T) {
	dir := t.TempDir()
	writeLuaSkill(t, dir, "a.lua", `
local b = require("b")
return { name = "a", description = "a", body = b.body }
`)
	writeLuaSkill(t, dir, "b.lua", `
local a = require("a")
return { name = "b", description = "b", body = a.body }
`)
	writeLuaSkill(t, dir, "c.lua", `
local missing = require("does_not_exist")
return { name = "c", description = "c", body = missing.body }
`)

	done := make(chan struct{})
	go func() {
		defer close(done)
		list, errs := Load(dir)
		if len(list) != 0 {
			t.Errorf("cycle/missing skills must not load, got %v", list)
		}
		text := errorsText(errs)
		if !strings.Contains(text, "cycle") {
			t.Errorf("errors must name the require cycle:\n%s", text)
		}
		if !strings.Contains(text, "does_not_exist") {
			t.Errorf("errors must name the missing module:\n%s", text)
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Load hung on a require cycle")
	}
}

func TestLoadSandboxDeniesHostAccess(t *testing.T) {
	dir := t.TempDir()
	cases := map[string]string{
		"os.lua":        `return { name = "osbad", description = os.getenv("HOME"), body = "b" }`,
		"io.lua":        `local f = io.open("/etc/passwd"); return { name = "iobad", description = "d", body = "b" }`,
		"package.lua":   `local m = require("os"); return { name = "pkgbad", description = "d", body = "b" }`,
		"dofile.lua":    `dofile("/tmp/evil.lua"); return { name = "dobad", description = "d", body = "b" }`,
		"load.lua":      `local f = loadstring("return 1"); return { name = "loadbad", description = "d", body = "b" }`,
		"globalenv.lua": `return { name = "envbad", description = getfenv(0).os.date(), body = "b" }`,
	}
	for file, src := range cases {
		writeLuaSkill(t, dir, file, src)
	}
	list, errs := Load(dir)
	if len(list) != 0 {
		t.Fatalf("sandbox escapes loaded as skills: %v", list)
	}
	if len(errs) < len(cases) {
		t.Fatalf("sandbox errors = %s", errorsText(errs))
	}
}

func TestParseLuaTimeout(t *testing.T) {
	old := moduleTimeout
	moduleTimeout = 100 * time.Millisecond
	defer func() { moduleTimeout = old }()

	start := time.Now()
	_, err := Parse("loop.lua", []byte(`while true do end`))
	if err == nil {
		t.Fatal("infinite Lua loop must be reported as a load error")
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("timeout took too long: %v", time.Since(start))
	}
	if !strings.Contains(err.Error(), "loop.lua") {
		t.Fatalf("timeout error must name the skill file: %v", err)
	}
}

// Extra module sources (the builtin layer) are requireable from disk
// skills but are not returned as disk skills themselves.
func TestLoadWithModulesRequiresExtraLayer(t *testing.T) {
	dir := t.TempDir()
	writeLuaSkill(t, dir, "combo.lua", `
return skill.extend(require("embedded_base"), {
  name = "disk_combo",
  description = "disk combo",
  usable = "ask",
  body = "disk body",
})
`)
	modules := []Source{{
		Path: "builtin_skills/embedded_base.lua",
		Data: []byte(`
return {
  name = "embedded_base",
  description = "embedded base",
  usable = "never",
  mode = "talk",
  permissions = { search_web = "yolo" },
  body = "embedded body",
}
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
		t.Fatalf("extra-layer extend lost fields: %+v", combo)
	}
	if strings.Join(combo.Inherit, ",") != "embedded_base" {
		t.Fatalf("extra-layer inherit = %v", combo.Inherit)
	}
}

// A shared-subtable DAG must hit the extend size budget instead of
// expanding exponentially inside the host deep-copy.
func TestSkillExtendRejectsOversizedSharedTable(t *testing.T) {
	src := `
local t = { leaf = "x" }
for _ = 1, 24 do t = { t, t } end
return skill.extend(t, { name = "big", description = "d", body = "b" })
`
	start := time.Now()
	if _, err := Parse("big.lua", []byte(src)); err == nil {
		t.Fatal("oversized shared table must be rejected")
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("oversized extend took too long: %v", time.Since(start))
	}
}
