package tools

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteToolCompactedFileAdvisory(t *testing.T) {
	dir := t.TempDir()
	brainDir := t.TempDir()
	sb := NewSandbox(dir)
	sb.AllowExtra(brainDir)
	sb.Lock()

	advisoryCalls := 0
	tool := &WriteTool{
		CWD:      dir,
		Sandbox:  sb,
		BrainDir: brainDir,
		CompactedFileAdvisory: func(absPath string) string {
			advisoryCalls++
			if strings.HasSuffix(filepath.ToSlash(absPath), "/existing.go") {
				return "Era b2 (msgs #10-#24): switched retry backoff to full jitter; preserve MaxAttempts=5."
			}
			return ""
		},
	}

	// 1. Brand-new file: must NOT trigger advisory or emit body text.
	resNew, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path":    "brand_new.go",
		"content": "package main\n",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := envBody(t, resNew); got != "" {
		t.Fatalf("expected empty body when creating new file, got %q", got)
	}
	if advisoryCalls != 0 {
		t.Fatalf("CompactedFileAdvisory must not be called for brand-new files, called %d times", advisoryCalls)
	}

	// 2. Overwriting an existing file with compacted history: includes concise advisory in result.
	existingPath := filepath.Join(dir, "existing.go")
	if err := os.WriteFile(existingPath, []byte("package main\nconst MaxAttempts = 5\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	resOverwrite, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path":    "existing.go",
		"content": "package main\nconst MaxAttempts = 5\nfunc init() {}\n",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	body := envBody(t, resOverwrite)
	if !strings.Contains(body, "Era b2") || !strings.Contains(body, "MaxAttempts=5") {
		t.Fatalf("expected compacted advisory in overwrite result, got %q", body)
	}
	if envAttr(resOverwrite, "compacted_advisory") != "true" {
		t.Fatalf("expected compacted_advisory=true attr, got %q", envAttr(resOverwrite, "compacted_advisory"))
	}

	// 3. Overwriting a scratch file in BrainDir: never triggers project compacted advisory.
	prevCalls := advisoryCalls
	scratchFile := filepath.Join(brainDir, "notes.md")
	if err := os.WriteFile(scratchFile, []byte("v1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	resBrain, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path":    scratchFile,
		"content": "v2\n",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := envBody(t, resBrain); got != "" {
		t.Fatalf("expected no advisory on brain file write, got %q", got)
	}
	if advisoryCalls != prevCalls {
		t.Fatalf("CompactedFileAdvisory must not run on brain scratch files")
	}
}

func TestEditToolCompactedFileAdvisoryNeverBlocksValidEditsAndEnrichesFailedMatch(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "service.go")
	initial := "package service\n\nfunc Handle() string {\n\treturn \"v2-token-format\"\n}\n"
	if err := os.WriteFile(target, []byte(initial), 0o644); err != nil {
		t.Fatal(err)
	}

	advisoryCalls := 0
	tool := &EditTool{
		CWD:     dir,
		Sandbox: NewSandbox(dir),
		CompactedFileAdvisory: func(absPath string) string {
			advisoryCalls++
			return "Modified in compacted block b3 (msgs #31-#44): migrated return value from v1-legacy to v2-token-format."
		},
	}

	// 1. Valid exact-match edit MUST succeed cleanly and NEVER be blocked or call CompactedFileAdvisory!
	resOK, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path": "service.go",
		"edits": []map[string]any{
			{"old_text": "return \"v2-token-format\"", "new_text": "return \"v2-token-format-strict\""},
		},
	}), nil)
	if err != nil {
		t.Fatalf("valid edit must never fail, got: %v", err)
	}
	if advisoryCalls != 0 {
		t.Fatalf("CompactedFileAdvisory must not be called on valid edits, called %d times", advisoryCalls)
	}
	if got := envBody(t, resOK); got != "" {
		t.Fatalf("valid edit body must stay empty, got %q", got)
	}

	// 2. Failed target-match edit (stale old_text from before compaction): appends advisory + read/session_history hint.
	_, err = tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path": "service.go",
		"edits": []map[string]any{
			{"old_text": "return \"v1-legacy\"", "new_text": "return \"v1-patched\""},
		},
	}), nil)
	if err == nil {
		t.Fatal("expected failed edit error when old_text does not match")
	}
	errMsg := err.Error()
	for _, want := range []string{
		"Could not find the exact text in service.go",
		"Modified in compacted block b3",
		`read("service.go")`,
		"session_history",
	} {
		if !strings.Contains(errMsg, want) {
			t.Fatalf("failed edit error missing %q:\n%s", want, errMsg)
		}
	}

	// 3. Ambiguous duplicate match also appends the compacted-file hint.
	dupFile := filepath.Join(dir, "dup.go")
	if err := os.WriteFile(dupFile, []byte("x := 1\nx := 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, dupErr := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path": "dup.go",
		"edits": []map[string]any{
			{"old_text": "x := 1", "new_text": "x := 2"},
		},
	}), nil)
	if dupErr == nil || !strings.Contains(dupErr.Error(), "session_history") {
		t.Fatalf("expected duplicate target failure to include compacted history hint, got: %v", dupErr)
	}
}
