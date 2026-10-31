package migrations

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
	// os.UserHomeDir reads USERPROFILE on Windows and HOME elsewhere, so
	// stubbing only HOME left the migration resolving the real profile and this
	// assertion failing on the Windows runners.
	t.Setenv("USERPROFILE", home)
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
