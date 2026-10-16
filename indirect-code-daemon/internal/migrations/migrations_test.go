package migrations

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMigrateFreshSlotStampsBaseline(t *testing.T) {
	slotDir := t.TempDir()
	applied, err := Migrate(slotDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied) != 1 || applied[0] != CurrentVersion {
		t.Fatalf("fresh slot must stamp baseline, applied = %v", applied)
	}
	if v, _ := StoredVersion(slotDir); v != CurrentVersion {
		t.Fatalf("version = %d, want %d", v, CurrentVersion)
	}
	// Idempotent re-run: nothing to do.
	applied, err = Migrate(slotDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied) != 0 {
		t.Fatalf("re-run applied %v", applied)
	}
}

func TestMigrateKeepsSessionsUntouched(t *testing.T) {
	slotDir := t.TempDir()
	sessDir := filepath.Join(slotDir, "sessions")
	os.MkdirAll(sessDir, 0o700)
	raw := []byte("{\"v\":1,\"kind\":\"turn\",\"id\":\"s1\",\"messages\":[]}\n{\"v\":1,\"kind\":\"meta\",\"id\":\"s1\",\"title\":\"T\"}\n")
	os.WriteFile(filepath.Join(sessDir, "s1.jsonl"), raw, 0o600)
	if _, err := Migrate(slotDir); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(sessDir, "s1.jsonl"))
	if err != nil || string(got) != string(raw) {
		t.Fatal("migration must not touch session files")
	}
}

func TestMigrateV1ToV2SweepsBgFiles(t *testing.T) {
	slotDir := t.TempDir()
	// Stamp v1 manually, then plant v1 bg leftovers.
	os.WriteFile(filepath.Join(slotDir, "storage_version.json"), []byte("{\"version\": 1}"), 0o600)
	runners := filepath.Join(slotDir, "runners", "out")
	os.MkdirAll(runners, 0o700)
	os.WriteFile(filepath.Join(slotDir, "runners", "j1.state.json"), []byte("{}"), 0o600)
	os.WriteFile(filepath.Join(slotDir, "runners", "j1.disposition"), []byte("background\n"), 0o600)
	os.WriteFile(filepath.Join(slotDir, "runners", "j1.launch"), []byte(""), 0o600)
	os.WriteFile(filepath.Join(runners, "s__j1__123.log"), []byte("out"), 0o600)
	os.WriteFile(filepath.Join(slotDir, "runners", "indirect-code-runner-v1"), []byte("bin"), 0o600)
	os.MkdirAll(filepath.Join(slotDir, "bg"), 0o700)
	os.WriteFile(filepath.Join(slotDir, "bg", "j1.pid.json"), []byte("{}"), 0o600)
	os.WriteFile(filepath.Join(slotDir, "bg", "j1.notice.json"), []byte("{}"), 0o600)
	os.MkdirAll(filepath.Join(slotDir, "brain", "s1"), 0o700)
	os.WriteFile(filepath.Join(slotDir, "brain", "s1", "bg_bash__j1.log"), []byte("brain"), 0o600)
	// A session file must survive.
	os.MkdirAll(filepath.Join(slotDir, "sessions"), 0o700)
	sess := []byte("{\"v\":1,\"kind\":\"meta\",\"id\":\"s1\"}\n")
	os.WriteFile(filepath.Join(slotDir, "sessions", "s1.jsonl"), sess, 0o600)

	applied, err := Migrate(slotDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied) != CurrentVersion-1 || applied[0] != 2 || applied[len(applied)-1] != CurrentVersion {
		t.Fatalf("applied = %v, want the full chain 2..%d", applied, CurrentVersion)
	}
	for _, p := range []string{
		"runners/j1.state.json", "runners/j1.disposition", "runners/j1.launch",
		"runners/out/s__j1__123.log", "runners/indirect-code-runner-v1",
		"bg/j1.pid.json", "bg/j1.notice.json", "brain/s1/bg_bash__j1.log",
	} {
		if _, err := os.Stat(filepath.Join(slotDir, p)); !os.IsNotExist(err) {
			t.Fatalf("%s must be swept", p)
		}
	}
	got, _ := os.ReadFile(filepath.Join(slotDir, "sessions", "s1.jsonl"))
	if string(got) != string(sess) {
		t.Fatal("session files must survive v2")
	}
	// Idempotent.
	if _, err := Migrate(slotDir); err != nil {
		t.Fatal(err)
	}
}

func TestMigrateV3WrapsLegacyToolResults(t *testing.T) {
	slotDir := t.TempDir()
	sessDir := filepath.Join(slotDir, "sessions")
	os.MkdirAll(sessDir, 0o700)
	// One turn with a legacy tool_result (plain text), one already-wrapped,
	// one image block, and a meta line that must stay untouched.
	legacy := `{"v":1,"kind":"turn","turn":1,"messages":[{"role":"assistant","content":[{"name":"read","id":"tu_1","arguments":{}},{"call_id":"tu_1","is_error":false,"content":[{"text":"package main"}]},{"call_id":"tu_2","is_error":true,"content":[{"text":"permission denied"}]}]},{"role":"assistant","content":[{"call_id":"tu_3","content":[{"text":"<tool_result type=\"ok\">already wrapped</tool_result>"}]}]}]}`
	legacy += "\n" + `{"v":1,"kind":"meta","id":"s1","title":"T"}` + "\n"
	sessPath := filepath.Join(sessDir, "s1.jsonl")
	if err := os.WriteFile(sessPath, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}

	// Start at v2 so the chain resumes from v3.
	os.WriteFile(filepath.Join(slotDir, "storage_version.json"), []byte(`{"version": 2}`), 0o600)
	applied, err := Migrate(slotDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied) != CurrentVersion-2 || applied[0] != 3 || applied[len(applied)-1] != CurrentVersion {
		t.Fatalf("applied = %v, want the chain 3..%d", applied, CurrentVersion)
	}
	got, err := os.ReadFile(sessPath)
	if err != nil {
		t.Fatal(err)
	}
	text := string(got)
	// Go escapes < > in JSON; match the escaped form.
	for _, want := range []string{
		`\u003ctool_result type=\"ok\"\u003epackage main\u003c/tool_result\u003e`,
		`\u003ctool_result type=\"error\"\u003epermission denied\u003c/tool_result\u003e`,
		`\u003ctool_result type=\"ok\"\u003ealready wrapped\u003c/tool_result\u003e`,
		`"title":"T"`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in:\n%s", want, text)
		}
	}
	// The already-wrapped body must not be double-wrapped.
	if strings.Contains(text, "already wrapped\u003c/tool_result\u003e\u003c/tool_result") {
		t.Fatal("double-wrapped body")
	}
	// Idempotent: re-run changes nothing.
	before := string(got)
	if _, err := Migrate(slotDir); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(sessPath)
	if string(after) != before {
		t.Fatal("re-run must be a no-op")
	}
}

// Bug 11: a legacy pre-versioning slot (sessions present, no
// storage_version.json) is NOT fresh: Migrate must run the whole conversion
// chain from the assumed v1 instead of stamping a silent baseline that
// skips v2-v4 (bg sweep, tool_result envelope, tool vocabulary).
func TestMigrateLegacySlotWithoutVersionFileRunsChain(t *testing.T) {
	slotDir := t.TempDir()
	sessDir := filepath.Join(slotDir, "sessions")
	if err := os.MkdirAll(sessDir, 0o700); err != nil {
		t.Fatal(err)
	}
	// One legacy v1 turn: tool call with v1 vocabulary ("sleep", "seconds",
	// "summary") plus an unwrapped legacy tool_result body.
	legacy := `{"v":1,"kind":"turn","turn":1,"messages":[{"role":"assistant","content":[{"id":"tu_1","name":"sleep","arguments":{"seconds":5,"summary":"done"}},{"call_id":"tu_1","is_error":false,"content":[{"text":"output"}]}]}]}`
	legacy += "\n" + `{"v":1,"kind":"meta","id":"s1","title":"T"}` + "\n"
	sessPath := filepath.Join(sessDir, "s1.jsonl")
	if err := os.WriteFile(sessPath, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	// v1 bg leftovers: only the v2 sweep removes them (evidence the chain ran).
	runners := filepath.Join(slotDir, "runners", "out")
	if err := os.MkdirAll(runners, 0o700); err != nil {
		t.Fatal(err)
	}
	leftover := filepath.Join(runners, "s__j1__123.log")
	if err := os.WriteFile(leftover, []byte("out"), 0o600); err != nil {
		t.Fatal(err)
	}

	applied, err := Migrate(slotDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied) != CurrentVersion-1 || applied[0] != 2 || applied[len(applied)-1] != CurrentVersion {
		t.Fatalf("legacy slot must run the chain from v1, applied = %v, want 2..%d", applied, CurrentVersion)
	}
	if v, _ := StoredVersion(slotDir); v != CurrentVersion {
		t.Fatalf("stored version = %d, want %d", v, CurrentVersion)
	}
	if _, err := os.Stat(leftover); !os.IsNotExist(err) {
		t.Fatalf("v1 bg leftover must be swept by v2; stat err = %v", err)
	}
	text, err := os.ReadFile(sessPath)
	if err != nil {
		t.Fatal(err)
	}
	got := string(text)
	// v4 vocabulary renames + v3 tool_result envelope must all be applied.
	for _, want := range []string{
		`"name":"bg_await"`,
		`"max_wait_seconds":5`,
		`"reason":"done"`,
		// Go escapes < > in JSON; match the escaped form.
		`\u003ctool_result type=\"ok\"\u003eoutput\u003c/tool_result\u003e`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q after migration (conversions skipped?):\n%s", want, got)
		}
	}
	for _, gone := range []string{`"name":"sleep"`, `"seconds":5`, `"summary":"done"`} {
		if strings.Contains(got, gone) {
			t.Fatalf("legacy %q still present after migration:\n%s", gone, got)
		}
	}
	// Idempotent re-run: chain complete, nothing applied.
	applied, err = Migrate(slotDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied) != 0 {
		t.Fatalf("re-run applied %v", applied)
	}
}
