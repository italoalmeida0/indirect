package skills

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const validSkill = `
export default {
  name: "revisor-estrito",
  description: "Analisa codigo sem permissao de alterar nada ou rodar scripts.",
  usable: "ask",
  mode: "agentic",
  approvalMode: "ask",
  permissions: {
    read: "inherit",
    edit: "deny",
    bash: "deny",
    custom_tool: {
      policy: "inherit",
      args: { param_a: "ask", param_b: "deny" },
    },
  },
  body: [
    "Instrucoes detalhadas da skill ate o fim do arquivo JavaScript.",
    "Apenas este corpo de texto sera carregado dentro da tag <skill></skill>.",
  ].join("\n"),
};
`

func TestParseValidSkill(t *testing.T) {
	s, err := Parse("revisor-estrito.js", []byte(validSkill))
	if err != nil {
		t.Fatal(err)
	}
	if s.Name != "revisor-estrito" || s.Mode != "agentic" || s.Usable != "ask" {
		t.Fatalf("basic fields lost: %+v", s)
	}
	if s.ApprovalMode != "ask" {
		t.Fatalf("approvalMode lost: %q", s.ApprovalMode)
	}
	if got := s.Permissions["custom_tool"]; got.Policy != PolicyInherit || got.Args["param_a"] != PolicyAsk || got.Args["param_b"] != PolicyDeny {
		t.Fatalf("arg-key overrides lost: %+v", got)
	}
	if s.Body == "" || !strings.HasPrefix(s.Body, "Instrucoes detalhadas") {
		t.Fatalf("body lost: %q", s.Body)
	}
	if strings.HasSuffix(s.Body, "\n") {
		t.Fatalf("body must not keep the long-string closing newline: %q", s.Body)
	}
}

func TestParseToolsAliasAndDefaults(t *testing.T) {
	s, err := Parse("alias.js", []byte(`
export default {
  name: "alias",
  description: "nested tools shape",
  _meta: { version: 1, experimental: true },
  tools: {
    approvalMode: "yolo",
    permissions: {
      widget_set: { policy: "inherit", src_file: "deny" },
    },
  },
  body: "body",
};
`))
	if err != nil {
		t.Fatal(err)
	}
	if s.Usable != "deny" {
		t.Fatalf("missing usable = %q, want deny fallback", s.Usable)
	}
	if s.ApprovalMode != "yolo" {
		t.Fatalf("tools.approvalMode lost: %q", s.ApprovalMode)
	}
	if got := s.Permissions["widget_set"]; got.Policy != PolicyInherit || got.Args["src_file"] != PolicyDeny {
		t.Fatalf("direct arg-key override lost: %+v", got)
	}
}

func TestParseRejectsUnknownKeysAndBadValues(t *testing.T) {
	cases := map[string]string{
		"unknown key":          `export default { name: "x", description: "d", banana: 1, body: "b" };`,
		"bad usable":           `export default { name: "x", description: "d", usable: "sometimes", body: "b" };`,
		"file inherit":         `export default { name: "x", description: "d", usable: "inherit", body: "b" };`,
		"bad mode":             `export default { name: "x", description: "d", mode: "build", body: "b" };`,
		"missing name":         `export default { description: "d", body: "b" };`,
		"missing description":  `export default { name: "x", body: "b" };`,
		"inline tools":         `export default { name: "x", description: "d", tools: "all", body: "b" };`,
		"duplicate tools":      `export default { name: "x", description: "d", approvalMode: "ask", tools: { approvalMode: "ask" }, body: "b" };`,
		"numeric name":         `export default { name: 42, description: "d", body: "b" };`,
		"boolean description":  `export default { name: "x", description: true, body: "b" };`,
		"function body":        `export default { name: "x", description: "d", body: function () { return "b"; } };`,
		"no default export":    `const x = 1;`,
		"non-object export":    `export default "x";`,
		"class instance":       `class Box {} export default new Box();`,
		"cyclic returned data": `const t = { name: "x", description: "d", body: "b" }; t._self = t; export default t;`,
		"not a module":         "---\nname: x\ndescription: d\n---\nb\n",
	}
	for label, src := range cases {
		if _, err := Parse("x.js", []byte(src)); err == nil {
			t.Fatalf("%s: expected error", label)
		}
	}
}

func TestParseValuedEntries(t *testing.T) {
	sk, err := Parse("x.js", []byte(`
export default {
  name: "x",
  description: "d",
  permissions: {
    bash: "ask",
    edit: "deny",
    yolo_tool: "yolo",
  },
  body: "body",
};
`))
	if err != nil {
		t.Fatal(err)
	}
	if p := sk.Permissions["bash"].Policy; p != PolicyAsk {
		t.Fatalf("ask entry policy = %q", p)
	}
	if p := sk.Permissions["edit"].Policy; p != PolicyDeny {
		t.Fatalf("deny entry policy = %q", p)
	}
	if p := sk.Permissions["yolo_tool"].Policy; p != PolicyYolo {
		t.Fatalf("yolo entry policy = %q", p)
	}
	// A listed tool or argument key MUST carry a policy value: an object
	// without `policy`, an empty string and non-string values are errors
	// (leave the key out to inherit).
	for _, src := range []string{
		`export default { name: "x", description: "d", permissions: { bash: { args: { cmd: "deny" } } }, body: "b" };`,
		`export default { name: "x", description: "d", permissions: { bash: "" }, body: "b" };`,
		`export default { name: "x", description: "d", permissions: { bash: true }, body: "b" };`,
		`export default { name: "x", description: "d", permissions: { bash: { policy: "ask", args: { cmd: false } } }, body: "b" };`,
	} {
		if _, err := Parse("x.js", []byte(src)); err == nil {
			t.Fatalf("expected error for value-less key in %q", src)
		}
	}
}

func TestParseArgKeyOverridesOnly(t *testing.T) {
	src := `
export default {
  name: "x",
  description: "d",
  permissions: {
    bash: { policy: "inherit", args: { cmd: "deny" } },
  },
  body: "b",
};
`
	s, err := Parse("x.js", []byte(src))
	if err != nil {
		t.Fatal(err)
	}
	spec := s.Permissions["bash"]
	if spec.Policy != PolicyInherit || spec.Args["cmd"] != PolicyDeny {
		t.Fatalf("arg-key override lost: %+v", spec)
	}
	if _, ok := spec.Args["other"]; ok {
		t.Fatal("unlisted args must not carry overrides")
	}

	// Direct arg keys and an `args` table may combine (skill.extend can
	// deep-merge specs written in either form); a conflicting duplicate
	// policy for the same argument is an error.
	mixed, err := Parse("mixed.js", []byte(`
export default {
  name: "mixed",
  description: "d",
  permissions: {
    bash: { policy: "ask", timeout: "yolo", args: { cmd: "deny" } },
  },
  body: "b",
};
`))
	if err != nil {
		t.Fatal(err)
	}
	if got := mixed.Permissions["bash"]; got.Args["cmd"] != PolicyDeny || got.Args["timeout"] != PolicyYolo {
		t.Fatalf("mixed arg forms must merge: %+v", got)
	}
	if _, err := Parse("conflict.js", []byte(`
export default {
  name: "conflict",
  description: "d",
  permissions: {
    bash: { policy: "ask", cmd: "yolo", args: { cmd: "deny" } },
  },
  body: "b",
};
`)); err == nil {
		t.Fatal("conflicting duplicate argument policies must be rejected")
	}
}

// The chain: arg -> tool -> the high-priority skill -> lower-priority
// skills -> DENY (the universal base). A base is composed in JavaScript, so
// there is no dependency list to walk.
func TestResolveChainFallbackToDeny(t *testing.T) {
	store := map[string]Skill{
		"base": {
			Name: "base", Usable: "never",
			Permissions: map[string]PermSpec{"bash": {Policy: PolicyDeny}, "write": {Policy: PolicyDeny}},
		},
		"main": {
			Name: "main", ApprovalMode: "ask",
			Permissions: map[string]PermSpec{
				"bash": {Policy: PolicyYolo},
				"edit": {Policy: PolicyDeny},
			},
		},
	}
	eff, err := Resolve(store, map[string]SessionSkill{
		"base": {Priority: 1, Active: true},
		"main": {Priority: 2, Active: true},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	// main (higher priority) wins where it speaks; base answers the rest.
	if p := eff.ToolDecision("bash"); p != PolicyYolo {
		t.Errorf("bash = %v, want yolo (main beats base)", p)
	}
	if p := eff.ToolDecision("write"); p != PolicyDeny {
		t.Errorf("write = %v, want deny (base answer)", p)
	}
	if p := eff.ToolDecision("edit"); p != PolicyDeny {
		t.Errorf("edit = %v, want deny (explicit)", p)
	}
	// Unlisted tools fall through the chain to deny. There is no implicit
	// "everyone gets everything".
	if p := eff.ToolDecision("read"); p != PolicyDeny {
		t.Errorf("read = %v, want deny (chain fallback)", p)
	}
	if p := eff.ToolDecision("search_web"); p != PolicyDeny {
		t.Errorf("search_web = %v, want deny (chain fallback)", p)
	}
	// Arg decision: arg -> tool -> chain -> deny. An unlisted arg of an
	// explicitly granted tool follows THAT tool's policy (arg -> tool).
	if p := eff.ArgDecision("bash", "cmd"); p != PolicyYolo {
		t.Errorf("arg cmd = %v, want yolo (unlisted arg follows the tool policy)", p)
	}
	if p := eff.ArgDecision("read", "path"); p != PolicyDeny {
		t.Errorf("arg of denied tool = %v, want deny", p)
	}
}

// An arg override inside a scope beats that scope's tool policy; the chain
// walks on down to lower-priority skills and then deny.
func TestResolveArgOverridesWalkChain(t *testing.T) {
	store := map[string]Skill{
		"low": {
			Name: "low",
			Permissions: map[string]PermSpec{
				"custom": {Policy: PolicyAsk, Args: map[string]Policy{"a": PolicyDeny}},
			},
		},
		"high": {
			Name: "high",
			Permissions: map[string]PermSpec{
				"custom": {Policy: PolicyYolo},
			},
		},
	}
	eff, err := Resolve(store, map[string]SessionSkill{
		"low":  {Priority: 1, Active: true},
		"high": {Priority: 2, Active: true},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	// The arg dimension walks the WHOLE chain: "low" carries the only
	// entry for arg "a" (deny) and it applies even under "high".
	if p := eff.ArgDecision("custom", "a"); p != PolicyDeny {
		t.Errorf("arg a = %v, want deny (arg entries chain-first across scopes)", p)
	}
	// Unconfigured arg keys inherit the tool's own resolved policy.
	if p := eff.ArgDecision("custom", "b"); p != PolicyYolo {
		t.Errorf("arg b = %v, want yolo (unconfigured key inherits the tool)", p)
	}
	// "low" alone: arg override beats its ask tool policy.
	eff2, _ := Resolve(store, map[string]SessionSkill{"low": {Priority: 1, Active: true}}, "")
	if p := eff2.ArgDecision("custom", "a"); p != PolicyDeny {
		t.Errorf("arg a = %v, want deny (arg override wins within scope)", p)
	}
	if p := eff2.ToolDecision("custom"); p != PolicyAsk {
		t.Errorf("custom = %v, want ask", p)
	}
	if p := eff2.ArgDecision("custom", "b"); p != PolicyAsk {
		t.Errorf("arg b = %v, want ask (falls to the tool policy)", p)
	}
}

// Two active skills: the LAST by priority is the highest scope; earlier
// skills (lower index) are its fallback.
func TestResolvePriorityScopeOrder(t *testing.T) {
	store := map[string]Skill{
		"first": {
			Name: "first",
			Permissions: map[string]PermSpec{
				"bash": {Policy: PolicyDeny},
				"read": {Policy: PolicyAsk},
			},
		},
		"second": {
			Name:        "second",
			Permissions: map[string]PermSpec{"bash": {Policy: PolicyYolo}},
		},
	}
	eff, err := Resolve(store, map[string]SessionSkill{
		"first":  {Priority: 1, Active: true},
		"second": {Priority: 2, Active: true},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if p := eff.ToolDecision("bash"); p != PolicyYolo {
		t.Errorf("bash = %v, want yolo (last skill wins)", p)
	}
	if p := eff.ToolDecision("read"); p != PolicyAsk {
		t.Errorf("read = %v, want ask (earlier skill answers)", p)
	}
	if p := eff.ToolDecision("edit"); p != PolicyDeny {
		t.Errorf("edit = %v, want deny", p)
	}
}

// The session mode is CALLER-SUPPLIED (the frontend derives it from the
// primary skill and sends it; the daemon never re-derives it): Resolve
// takes it as-is, with anything but "agentic" falling back to "talk" —
// including when the primary skill declares a different mode. Only the
// approvalMode still comes from the primary skill: "yolo" auto-approves
// resolved "ask" policies, "ask" (default) shows human approval.
func TestResolveModeIsCallerSupplied(t *testing.T) {
	store := map[string]Skill{
		"p": {Name: "p", Mode: "agentic", ApprovalMode: "yolo"},
		"q": {Name: "q", Mode: "talk"},
	}
	sel := map[string]SessionSkill{
		"p": {Priority: 1, Active: true},
		"q": {Priority: 2, Active: true},
	}
	eff, err := Resolve(store, sel, "agentic")
	if err != nil {
		t.Fatal(err)
	}
	if eff.Mode != "agentic" || !eff.AskAutoApprove {
		t.Fatalf("supplied mode / primary approvalMode not applied: %+v", eff)
	}
	// A mixed selection is not an error, and the supplied mode wins over
	// the primary skill's own declared mode.
	talk, err := Resolve(store, sel, "talk")
	if err != nil {
		t.Fatalf("mixed selection must resolve: %v", err)
	}
	if talk.Mode != "talk" {
		t.Fatalf("mode must be the supplied one, got %q", talk.Mode)
	}
	// Invalid or missing mode falls back to talk; the mode survives an
	// empty selection (it belongs to the session, not to the skills).
	if bad, _ := Resolve(store, sel, "bogus"); bad.Mode != "talk" {
		t.Fatalf("invalid mode = %q, want talk", bad.Mode)
	}
	empty, _ := Resolve(store, map[string]SessionSkill{}, "agentic")
	if empty.Mode != "agentic" {
		t.Fatalf("empty selection mode = %q, want the supplied agentic", empty.Mode)
	}
	if empty.AskAutoApprove {
		t.Fatal("empty selection must not auto-approve")
	}
}

// usable:never skills are base-only: a stale selection entry is ignored,
// because they only contribute when another module imports them.
func TestResolveSkipsNeverSkillsAsDirectSelection(t *testing.T) {
	store := map[string]Skill{
		"base": {Name: "base", Body: "b", Usable: "never"},
		"main": {Name: "main", Body: "m", Usable: "ask"},
	}
	eff, err := Resolve(store, map[string]SessionSkill{
		"base": {Priority: 1, Active: true},
		"main": {Priority: 2, Active: true},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(eff.Order) != 1 || eff.Order[0] != "main" {
		t.Fatalf("order = %v, want only the visible skill", eff.Order)
	}
	if _, listed := eff.Listed["base"]; listed {
		t.Error("never base must stay unlisted to the AI")
	}
	if _, contributed := eff.Bodies["base"]; contributed {
		t.Error("an imported base contributes through its importer's body, never on its own")
	}
}

// Imported bases are not separate scopes: the importing module produced the
// final body and permissions, so Resolve sees exactly one skill and lists
// only the skills the session actually selected.
func TestResolveImportedBaseIsOneScope(t *testing.T) {
	store := map[string]Skill{
		"base": {Name: "base", Body: "base body", Usable: "never",
			Permissions: map[string]PermSpec{"widget_set": {Policy: PolicyYolo}}},
		"main": {Name: "main", Body: "main body\nbase body", Usable: "ask",
			Permissions: map[string]PermSpec{
				"bash":       {Policy: PolicyYolo},
				"widget_set": {Policy: PolicyYolo},
			}},
	}
	eff, err := Resolve(store, map[string]SessionSkill{"main": {Priority: 1, Active: true}}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(eff.Order) != 1 || eff.Order[0] != "main" {
		t.Fatalf("order = %v, want just the selected skill", eff.Order)
	}
	if eff.Bodies["main"] != "main body\nbase body" {
		t.Fatalf("body = %q", eff.Bodies["main"])
	}
	if p := eff.ToolDecision("widget_set"); p != PolicyYolo {
		t.Errorf("widget_set = %v, want the merged yolo", p)
	}
	if eff.Listed["base"] {
		t.Error("an imported base must never be listed")
	}
	if !eff.Listed["main"] || !eff.HasVisible {
		t.Error("the visible skill must be listed")
	}
}

func TestResolveNoVisibleSkill(t *testing.T) {
	store := map[string]Skill{
		"base": {Name: "base", Usable: "never"},
	}
	eff, err := Resolve(store, map[string]SessionSkill{"base": {Priority: 1, Active: true}}, "")
	if err != nil {
		t.Fatal(err)
	}
	if eff.HasVisible {
		t.Error("a never-only session must have no visible skill")
	}
}

func TestUsableValueLocks(t *testing.T) {
	cases := []struct {
		def, override, want string
		wantErr             bool
	}{
		{"", "", "deny", false},         // no usable key in the skill module: deny fallback
		{"", "inherit", "deny", false},  // session inherit = the file original (deny here)
		{"", "ask", "deny", false},      // fallback deny is the locked original
		{"deny", "yolo", "deny", false}, // locked
		{"never", "ask", "never", false},
		{"yolo", "deny", "yolo", false}, // locked
		{"ask", "", "ask", false},
		{"ask", "deny", "deny", false},
		{"ask", "yolo", "yolo", false},
		{"ask", "inherit", "ask", false}, // session inherit = no override
		{"inherit", "", "", true},        // inherit is not a skill file value
		{"ask", "sometimes", "", true},
	}
	for _, c := range cases {
		got, err := UsableValue(Skill{Usable: c.def}, c.override)
		if c.wantErr {
			if err == nil {
				t.Errorf("usable(%q,%q): expected error", c.def, c.override)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Errorf("usable(%q,%q) = %q,%v want %q", c.def, c.override, got, err, c.want)
		}
	}
}

func TestLoadSkipsInvalidFilesAndIgnoresOtherExtensions(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "good.js"), []byte(validSkill), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "bad.js"), []byte(`export default { name: "x" };`), 0o644); err != nil {
		t.Fatal(err)
	}
	// Only .js modules are skills: anything else in the directory is
	// ignored (not loaded, not an error).
	other := "---\nname: legacy\ndescription: not a module\n---\nlegacy body\n"
	if err := os.WriteFile(filepath.Join(dir, "legacy.md"), []byte(other), 0o644); err != nil {
		t.Fatal(err)
	}
	list, errs := Load(dir)
	if len(list) != 1 || len(errs) != 1 {
		t.Fatalf("list=%v errs=%v, want one JavaScript skill and one load error", list, errs)
	}
	if _, ok := list["legacy"]; ok {
		t.Fatal("a non-module file must not load")
	}
}

func TestLoadDuplicateNamesFirstFileWins(t *testing.T) {
	dir := t.TempDir()
	first := `export default { name: "dup", description: "first", body: "first body" };`
	second := `export default { name: "dup", description: "second", body: "second body" };`
	if err := os.WriteFile(filepath.Join(dir, "a.js"), []byte(first), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "b.js"), []byte(second), 0o644); err != nil {
		t.Fatal(err)
	}
	list, errs := Load(dir)
	if got := list["dup"]; got.Description != "first" || got.Body != "first body" {
		t.Fatalf("duplicate winner = %+v, want the first file", got)
	}
	if len(errs) != 1 || !strings.Contains(errs[0].Error(), "duplicate") {
		t.Fatalf("duplicate errors = %v", errs)
	}
}

func TestParseConditionalSubskillFields(t *testing.T) {
	dir := t.TempDir()
	baseSrc := `
export default {
  name: "gen_base",
  description: "base gen ui",
  usable: "never",
  provides: ["generative_ui", "generative_ui_talk", "generative_ui"],
  body: "base",
};
`
	talkSrc := `
import base from "skill:gen_base";
export default {
  ...base,
  name: "talk",
  description: "talk mode",
  usable: "deny",
  mode: "talk",
  body: "talk " + base.body,
};
`
	clearedSrc := `
import base from "skill:gen_base";
export default {
  ...base,
  name: "plain_talk",
  description: "talk without genui",
  usable: "deny",
  mode: "talk",
  provides: [],
  body: "plain",
};
`
	subSrc := `
export default {
  name: "genui_sub",
  description: "subskill",
  usable: "yolo",
  requires: ["  parent_a  ", "parent_a"],
  requiresAny: ["generative_ui_talk", "generative_ui_agentic"],
  body: "sub body",
};
`
	for name, src := range map[string]string{
		"gen_base.js":   baseSrc,
		"talk.js":       talkSrc,
		"plain_talk.js": clearedSrc,
		"genui_sub.js":  subSrc,
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(src), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	list, errs := Load(dir)
	if len(errs) > 0 {
		t.Fatalf("unexpected load errors: %v", errs)
	}
	talk := list["talk"]
	if len(talk.Provides) != 2 || talk.Provides[0] != "generative_ui" || talk.Provides[1] != "generative_ui_talk" {
		t.Fatalf("spread provides lost/not deduped: %+v", talk.Provides)
	}
	if talk.IsGated() {
		t.Fatalf("talk must not be gated: %+v", talk)
	}
	if plain := list["plain_talk"]; len(plain.Provides) != 0 {
		t.Fatalf("empty provides array must clear spread provides, got %+v", plain.Provides)
	}
	sub := list["genui_sub"]
	if !sub.IsGated() {
		t.Fatal("subskill must report IsGated() == true")
	}
	if len(sub.Requires) != 1 || sub.Requires[0] != "parent_a" {
		t.Fatalf("requires = %+v, want [parent_a]", sub.Requires)
	}
	if len(sub.RequiresAny) != 2 || sub.RequiresAny[0] != "generative_ui_talk" || sub.RequiresAny[1] != "generative_ui_agentic" {
		t.Fatalf("requiresAny = %+v", sub.RequiresAny)
	}

	// Reject malformed gating / provides values and non-plain QuickJS data.
	bad := map[string]string{
		"requires string":      `export default { name: "x", description: "d", requires: "p", body: "b" };`,
		"requiresAny object":   `export default { name: "x", description: "d", requiresAny: { a: true }, body: "b" };`,
		"provides number":      `export default { name: "x", description: "d", provides: 1, body: "b" };`,
		"requires non-string":  `export default { name: "x", description: "d", requires: [42], body: "b" };`,
		"requires empty elem":  `export default { name: "x", description: "d", requires: ["   "], body: "b" };`,
		"requiresAny func":     `export default { name: "x", description: "d", requiresAny: [() => "a"], body: "b" };`,
		"provides sparse":      `const a = []; a[1] = "x"; export default { name: "x", description: "d", provides: a, body: "b" };`,
		"requires cyclic":      `const a = []; a.push(a); export default { name: "x", description: "d", requires: a, body: "b" };`,
	}
	for label, src := range bad {
		if _, err := Parse("bad.js", []byte(src)); err == nil {
			t.Fatalf("%s: expected parse error", label)
		}
	}
}

func TestResolveConditionalSubskillGating(t *testing.T) {
	store := map[string]Skill{
		"talk": {
			Name:     "talk",
			Mode:     "talk",
			Usable:   "deny",
			Provides: []string{"generative_ui", "generative_ui_talk"},
			Body:     "talk body",
		},
		"build": {
			Name:   "build",
			Mode:   "agentic",
			Usable: "deny",
			Body:   "build body",
		},
		"gen_agentic": {
			Name:     "gen_agentic",
			Mode:     "agentic",
			Usable:   "yolo",
			Provides: []string{"generative_ui", "generative_ui_agentic"},
			Body:     "gen agentic body",
		},
		"games": {
			Name:     "games",
			Mode:     "talk",
			Usable:   "yolo",
			Requires: []string{"generative_ui_talk"},
			Body:     "games body",
		},
		"viz": {
			Name:        "viz",
			Usable:      "yolo",
			RequiresAny: []string{"generative_ui_talk", "generative_ui_agentic"},
			Body:        "viz body",
		},
		"eng": {
			Name:     "eng",
			Mode:     "agentic",
			Usable:   "yolo",
			Requires: []string{"generative_ui_agentic"},
			Body:     "eng body",
		},
		"combo": {
			Name:        "combo",
			Mode:        "agentic",
			Usable:      "yolo",
			Requires:    []string{"build", "generative_ui_agentic"},
			RequiresAny: []string{"eng", "viz"},
			Body:        "combo body",
		},
		"cycle_a": {Name: "cycle_a", Usable: "yolo", Requires: []string{"cycle_b"}, Body: "ca"},
		"cycle_b": {Name: "cycle_b", Usable: "yolo", Requires: []string{"cycle_a"}, Body: "cb"},
	}

	// 1. Agentic before gen_agentic active: only gen_agentic is listed; gated subskills stay hidden.
	effBefore, err := Resolve(store, map[string]SessionSkill{
		"build": {Priority: 1, Active: true},
	}, "agentic")
	if err != nil {
		t.Fatal(err)
	}
	if !effBefore.Listed["gen_agentic"] {
		t.Fatalf("gen_agentic must be listed in agentic mode: %+v", effBefore.Listed)
	}
	for _, hidden := range []string{"games", "viz", "eng", "combo", "cycle_a", "cycle_b"} {
		if effBefore.Listed[hidden] {
			t.Errorf("%q must be hidden before parent is active: %+v", hidden, effBefore.Listed)
		}
	}

	// 2. Agentic after gen_agentic active: viz & eng unlock, games stays mode+parent hidden, combo still needs eng or viz.
	effAfter, err := Resolve(store, map[string]SessionSkill{
		"build":       {Priority: 1, Active: true},
		"gen_agentic": {Priority: 2, Active: true},
	}, "agentic")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"gen_agentic", "viz", "eng"} {
		if !effAfter.Listed[want] {
			t.Errorf("%q must unlock once gen_agentic is active: %+v", want, effAfter.Listed)
		}
	}
	if effAfter.Listed["games"] {
		t.Errorf("talk-only games must stay hidden in agentic: %+v", effAfter.Listed)
	}
	if effAfter.Listed["combo"] {
		t.Errorf("combo requires (build AND generative_ui_agentic) AND (eng OR viz); must stay hidden until eng or viz activates")
	}

	// 3. Transitive activation: activating eng unlocks combo too!
	effChain, err := Resolve(store, map[string]SessionSkill{
		"build":       {Priority: 1, Active: true},
		"gen_agentic": {Priority: 2, Active: true},
		"eng":         {Priority: 3, Active: true},
	}, "agentic")
	if err != nil {
		t.Fatal(err)
	}
	if !effChain.Listed["combo"] {
		t.Fatalf("combo must unlock once build + gen_agentic + eng are active: %+v", effChain.Listed)
	}

	// 4. Talk session: talk spreads provides:["generative_ui","generative_ui_talk"], unlocking games & viz immediately.
	effTalk, err := Resolve(store, map[string]SessionSkill{
		"talk": {Priority: 1, Active: true},
	}, "talk")
	if err != nil {
		t.Fatal(err)
	}
	if !effTalk.Listed["games"] || !effTalk.Listed["viz"] {
		t.Fatalf("talk must unlock games and viz immediately, got %+v", effTalk.Listed)
	}
	if effTalk.Listed["gen_agentic"] || effTalk.Listed["eng"] || effTalk.Listed["combo"] {
		t.Fatalf("agentic skills must stay hidden in talk, got %+v", effTalk.Listed)
	}

	// 5. Orphan active gated skills and cycles without an active root are excluded from Order/Bodies/Chain/Satisfied.
	effOrphan, err := Resolve(store, map[string]SessionSkill{
		"build":   {Priority: 1, Active: true},
		"eng":     {Priority: 2, Active: true}, // parent gen_agentic NOT active
		"cycle_a": {Priority: 3, Active: true},
		"cycle_b": {Priority: 4, Active: true},
	}, "agentic")
	if err != nil {
		t.Fatal(err)
	}
	if len(effOrphan.Order) != 1 || effOrphan.Order[0] != "build" {
		t.Fatalf("unsatisfied gated skills and cycles must not enter Order: %v", effOrphan.Order)
	}
	if _, ok := effOrphan.Bodies["eng"]; ok {
		t.Fatal("unsatisfied gated skill body must not leak into Bodies")
	}
	if effOrphan.Satisfied["eng"] || effOrphan.Satisfied["cycle_a"] || effOrphan.Satisfied["cycle_b"] {
		t.Fatalf("unsatisfied gated skills must not populate Satisfied: %+v", effOrphan.Satisfied)
	}
}
