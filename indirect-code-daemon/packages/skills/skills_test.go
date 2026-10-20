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
