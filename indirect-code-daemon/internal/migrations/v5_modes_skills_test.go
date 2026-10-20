package migrations

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/skills"
)

func TestV5SeedsSkillsAndCollapsesModes(t *testing.T) {
	dir := t.TempDir()
	sessions := filepath.Join(dir, "sessions")
	if err := os.MkdirAll(sessions, 0o755); err != nil {
		t.Fatal(err)
	}
	meta := func(mode string) string {
		b, _ := json.Marshal(map[string]any{
			"kind": "meta", "id": "sess-x", "options": map[string]any{"mode": mode, "access": "ask", "skills": []string{}},
		})
		return string(b)
	}
	body := strings.Join([]string{
		meta("build"),
		meta("plan"),
		meta("learning"),
		meta("talk"),
		`{"kind":"header","turn":1}`,
	}, "\n")
	path := filepath.Join(sessions, "sess-x.jsonl")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := applyV5(dir); err != nil {
		t.Fatal(err)
	}
	if err := verifyV5(dir); err != nil {
		t.Fatal(err)
	}

	// Skill DEFINITIONS live embedded in the daemon binary
	// (builtin_skills/*.js) and are never seeded to disk — with no
	// pre-existing user skills to convert, no skills/ file may appear.
	if _, err := os.Stat(filepath.Join(dir, "skills")); err == nil {
		entries, _ := os.ReadDir(filepath.Join(dir, "skills"))
		if len(entries) > 0 {
			t.Fatalf("migration must not seed skill files, found %d", len(entries))
		}
	}

	out, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(string(out), "\n")
	modes := map[string]string{}
	skillEntries := 0
	for _, line := range lines {
		var obj struct {
			Kind    string          `json:"kind"`
			Options json.RawMessage `json:"options"`
			Skills  json.RawMessage `json:"skills"`
		}
		if err := json.Unmarshal([]byte(line), &obj); err != nil || obj.Kind != "meta" {
			continue
		}
		var options struct {
			Mode string `json:"mode"`
		}
		_ = json.Unmarshal(obj.Options, &options)
		modes[options.Mode] = options.Mode
		var skills map[string]json.RawMessage
		_ = json.Unmarshal(obj.Skills, &skills)
		skillEntries += len(skills)
	}
	if _, legacy := modes["build"]; legacy {
		t.Fatal("legacy build mode survived")
	}
	if _, legacy := modes["plan"]; legacy {
		t.Fatal("legacy plan mode survived")
	}
	if modes["agentic"] != "agentic" || modes["talk"] != "talk" {
		t.Fatalf("expected agentic+talk, got %v", modes)
	}
	// build/plan/learning meta lines each gained one main skill entry.
	if skillEntries != 3 {
		t.Fatalf("expected 3 main skill entries, got %d", skillEntries)
	}

	// Idempotent: a second run rewrites nothing and verify stays green.
	before, _ := os.ReadFile(path)
	if err := applyV5(dir); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("second run must be a no-op")
	}
	if err := verifyV5(dir); err != nil {
		t.Fatal(err)
	}
}

// Talk sessions move to the default Home project (meta cwd -> $HOME);
// agentic sessions keep their project cwd. Already-home talk metas are
// untouched (idempotent).
func TestV5MovesTalkSessionsHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := t.TempDir()
	sessions := filepath.Join(dir, "sessions")
	if err := os.MkdirAll(sessions, 0o755); err != nil {
		t.Fatal(err)
	}
	meta := func(id, mode, cwd string) string {
		b, _ := json.Marshal(map[string]any{
			"kind": "meta", "id": id, "cwd": cwd,
			"options": map[string]any{"mode": mode, "access": "ask", "skills": []string{}},
		})
		return string(b)
	}
	write := func(name, body string) string {
		p := filepath.Join(sessions, name)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	talkPath := write("sess-talk.jsonl", meta("sess-talk", "talk", "/some/project"))
	agenticPath := write("sess-agentic.jsonl", meta("sess-agentic", "build", "/some/project"))
	homePath := write("sess-home.jsonl", meta("sess-home", "talk", home))

	if err := applyV5(dir); err != nil {
		t.Fatal(err)
	}
	if err := verifyV5(dir); err != nil {
		t.Fatal(err)
	}

	cwdOf := func(p string) string {
		raw, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		var obj struct {
			CWD string `json:"cwd"`
		}
		if err := json.Unmarshal(raw, &obj); err != nil {
			t.Fatalf("%s: %v", p, err)
		}
		return obj.CWD
	}
	if got := cwdOf(talkPath); got != home {
		t.Fatalf("talk session cwd = %q, want home %q", got, home)
	}
	if got := cwdOf(agenticPath); got != "/some/project" {
		t.Fatalf("agentic session cwd must stay, got %q", got)
	}
	if got := cwdOf(homePath); got != home {
		t.Fatalf("already-home talk cwd = %q, want %q", got, home)
	}
}

// v5 retires Markdown skills: every parseable user skills/*.md becomes an
// equivalent .js module (same fields, body verbatim) and the .md is
// removed. Unparseable files (already dropped by the old loader) and
// same-stem .md+.js collisions are left untouched rather than destroying
// data.
func TestV5ConvertsMarkdownSkillsToJS(t *testing.T) {
	dir := t.TempDir()
	skillsDir := filepath.Join(dir, "skills")
	if err := os.MkdirAll(skillsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(skillsDir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	read := func(name string) string {
		t.Helper()
		data, err := os.ReadFile(filepath.Join(skillsDir, name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		return string(data)
	}
	exists := func(name string) bool {
		_, err := os.Stat(filepath.Join(skillsDir, name))
		return err == nil
	}

	customBody := "Review body with ` and ${ sequences, plus </script>.\nSecond line."
	write("custom.md", "---\nname: custom_review\ndescription: Review \"strict\" code\nusable: ask\nmode: agentic\ninherit: [agentic_base, other_base]\ntools:\n  approvalMode: yolo\n  permissions:\n    read: inherit\n    edit: deny\n    widget_set: inherit { src_file: deny }\n---\n"+customBody+"\n")
	// A reserved builtin name still converts (the runtime ignores it, the
	// user's content is not deleted).
	write("plan.md", "---\nname: plan\ndescription: mine\n---\ncustom plan body\n")
	broken := "---\nname: broken\n---\nno description\n"
	write("broken.md", broken)
	collideMD := "---\nname: collide\ndescription: markdown side\n---\nmd body\n"
	collideJS := "export default { name: \"collide\", description: \"js side\", body: \"js body\" };\n"
	write("collide.md", collideMD)
	write("collide.js", collideJS)

	if err := applyV5(dir); err != nil {
		t.Fatal(err)
	}
	if err := verifyV5(dir); err != nil {
		t.Fatal(err)
	}

	if exists("custom.md") || exists("plan.md") {
		t.Fatal("converted .md files must be removed")
	}
	generated := read("custom.js")
	if !strings.Contains(generated, "\\`") || !strings.Contains(generated, "\\${") {
		t.Fatalf("body with a backtick and ${{ must be escaped in the template literal:\n%s", generated)
	}
	// `inherit:` became real imports plus spreads: the converted file must
	// load through the real module loader against the bases it names, and
	// compose to the same grants and body order the old chain produced.
	if strings.Contains(generated, "inherit:") {
		t.Fatalf("converted module still carries the retired inherit key:\n%s", generated)
	}
	bases := []skills.Source{
		{Path: "builtin_skills/agentic_base.js", Data: []byte(`
export default {
  name: "agentic_base",
  description: "agentic base",
  usable: "never",
  permissions: { read: "ask", edit: "ask", widget_set: "yolo" },
  body: "agentic base body",
};
`)},
		{Path: "builtin_skills/other_base.js", Data: []byte(`
export default {
  name: "other_base",
  description: "other base",
  usable: "never",
  permissions: { read: "deny", widget_set: { policy: "ask", args: { other: "deny" } } },
  body: "other base body",
};
`)},
	}
	list, loadErrs := skills.LoadSet([]skills.Source{{Path: "custom.js", Data: []byte(generated)}}, bases)
	if len(loadErrs) > 0 {
		t.Fatalf("converted skill must load with the JS loader: %v\n%s", loadErrs, generated)
	}
	sk, ok := list["custom_review"]
	if !ok {
		t.Fatalf("converted skill missing from the load result:\n%s", generated)
	}
	if sk.Name != "custom_review" || sk.Description != `Review "strict" code` || sk.Usable != "ask" || sk.Mode != "agentic" || sk.ApprovalMode != "yolo" {
		t.Fatalf("converted fields drifted: %+v", sk)
	}
	// The higher-priority base (base0 = agentic_base) grants the policy, the
	// own argument override survives, and the base order is lowest first.
	if got := sk.Permissions["read"].Policy; got != skills.PolicyAsk {
		t.Fatalf("read policy = %q, want the agentic_base grant", got)
	}
	if got := sk.Permissions["widget_set"].Policy; got != skills.PolicyYolo {
		t.Fatalf("widget_set policy = %q, want the agentic_base grant", got)
	}
	if got := sk.Permissions["widget_set"].Args; got["src_file"] != skills.PolicyDeny || got["other"] != skills.PolicyDeny {
		t.Fatalf("widget_set args drifted: %v", got)
	}
	if sk.Permissions["edit"].Policy != skills.PolicyDeny {
		t.Fatalf("own deny lost: %+v", sk.Permissions["edit"])
	}
	if want := customBody + "agentic base bodyother base body"; sk.Body != want {
		t.Fatalf("converted body = %q, want %q", sk.Body, want)
	}
	plan, err := skills.Parse("plan.js", []byte(read("plan.js")))
	if err != nil || plan.Name != "plan" || plan.Usable != "deny" || plan.Body != "custom plan body" {
		t.Fatalf("reserved-name conversion drifted: %+v (%v)", plan, err)
	}
	if read("broken.md") != broken || exists("broken.js") {
		t.Fatal("unparseable .md must stay untouched with no .js")
	}
	if read("collide.md") != collideMD || read("collide.js") != collideJS {
		t.Fatal("same-stem .md+.js collision must stay untouched")
	}

	// Idempotent: a second run changes nothing.
	before := map[string]string{}
	entries, err := os.ReadDir(skillsDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		before[e.Name()] = read(e.Name())
	}
	if err := applyV5(dir); err != nil {
		t.Fatal(err)
	}
	entries, err = os.ReadDir(skillsDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != len(before) {
		t.Fatalf("second run changed the file set: %v", entries)
	}
	for _, e := range entries {
		if read(e.Name()) != before[e.Name()] {
			t.Fatalf("second run rewrote %s", e.Name())
		}
	}
	if err := verifyV5(dir); err != nil {
		t.Fatal(err)
	}
}
