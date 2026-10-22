package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"indirect/indirect-code-daemon/packages/filetrack"
	"indirect/indirect-code-daemon/packages/provider"
)

// BUG-01: browseFolders with non-existent directory returns empty entries and nil error
func TestBrowseFoldersNonExistent(t *testing.T) {
	tempDir := t.TempDir()
	nonExistent := filepath.Join(tempDir, "brand-new-project-dir")

	cur, parent, entries, err := browseFolders(nonExistent)
	if err != nil {
		t.Fatalf("browseFolders on non-existent directory returned error: %v", err)
	}
	if cur != nonExistent {
		t.Fatalf("expected cur %q, got %q", nonExistent, cur)
	}
	if parent != tempDir {
		t.Fatalf("expected parent %q, got %q", tempDir, parent)
	}
	if len(entries) != 0 {
		t.Fatalf("expected 0 entries, got %d", len(entries))
	}

	// If parent is a file (not directory), it must return error
	filePath := filepath.Join(tempDir, "regular_file.txt")
	if err := os.WriteFile(filePath, []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}
	invalidChild := filepath.Join(filePath, "subfolder")
	_, _, _, err = browseFolders(invalidChild)
	if err == nil {
		t.Fatalf("expected error when parent is a regular file, got nil")
	}
}

// BUG-03: undoTurnBalloon marks f.Undone = true on files in the balloon
func TestUndoTurnBalloonMarksUndone(t *testing.T) {
	tempDir := t.TempDir()
	testFile := filepath.Join(tempDir, "test.txt")
	if err := os.WriteFile(testFile, []byte("modified content\n"), 0644); err != nil {
		t.Fatal(err)
	}

	b := &filetrack.TurnChanges{
		TurnIndex: 1,
		Files: []filetrack.ChangedFile{
			{
				Path:         testFile,
				Rel:          "test.txt",
				Status:       "modified",
				ReversePatch: "@@ -1 +1 @@\n-modified content\n+original content\n",
				Undone:       false,
			},
		},
	}

	results, complete := undoTurnBalloon(tempDir, b, "")
	if !complete {
		t.Fatalf("undoTurnBalloon incomplete: %+v", results)
	}
	if !b.Files[0].Undone {
		t.Fatalf("expected b.Files[0].Undone == true, got false")
	}

	// Verify restored content on disk
	content, err := os.ReadFile(testFile)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(content)) != "original content" {
		t.Fatalf("unexpected content on disk: %q", string(content))
	}
}

// BUG-06: onBgTaskRegister preserves StartedAt and emits it in bg_task_registered
func TestBgTaskRegisterPreservesStartedAt(t *testing.T) {
	a, _ := darActor(t, &SessionRecord{ID: "sess-bg-start", CWD: t.TempDir()})

	var emitted []map[string]any
	a.wsSend = func(v any) {
		if m, ok := v.(map[string]any); ok {
			emitted = append(emitted, m)
		}
	}

	explicitStart := time.Now().UnixMilli() - 15000
	a.onBgTaskRegister(bgTaskRegisterMsg{
		JobID:     "bg_custom_time",
		Kind:      "bash",
		Label:     "long command",
		StartedAt: explicitStart,
	})

	idx := findBgTask(a.rec, "bg_custom_time")
	if idx < 0 {
		t.Fatalf("expected bg task to be found in session")
	}
	task := a.rec.BgTasks[idx]
	if task.StartedAt != explicitStart {
		t.Fatalf("expected task.StartedAt %d, got %d", explicitStart, task.StartedAt)
	}

	// Check emitted frame
	foundEmit := false
	for _, ev := range emitted {
		if ev["type"] == "bg_task_registered" && ev["jobId"] == "bg_custom_time" {
			foundEmit = true
			if ev["startedAt"] != explicitStart {
				t.Fatalf("expected emitted startedAt %d, got %v", explicitStart, ev["startedAt"])
			}
		}
	}
	if !foundEmit {
		t.Fatalf("bg_task_registered event not emitted")
	}
}

// BUG-12: builtin_skills/build.js does not instruct to use widget_set
func TestBuildSkillPromptNoWidgetSet(t *testing.T) {
	code, err := os.ReadFile("builtin_skills/build.js")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(code), "widget_set") {
		t.Fatalf("builtin_skills/build.js should not contain 'widget_set'")
	}
}

// BUG-14: isTitleRefusal catches refusal messages and fallback uses user prompt
func TestTitleRefusalFilter(t *testing.T) {
	refusals := []string{
		"I can't invoke the todo or finish_entire_request tools in this mode",
		"I cannot invoke tools directly",
		"As an AI, I don't have access to the file system",
		"I don't have access to execute commands",
		"I am unable to perform that operation",
		"Cannot invoke tool without permission",
	}

	for _, r := range refusals {
		if !isTitleRefusal(r) {
			t.Errorf("expected isTitleRefusal(%q) to be true, got false", r)
		}
	}

	nonRefusals := []string{
		"Build a React widget",
		"Fix the authentication bug",
		"Add database migration script",
		"Implement user profile page",
	}

	for _, nr := range nonRefusals {
		if isTitleRefusal(nr) {
			t.Errorf("expected isTitleRefusal(%q) to be false, got true", nr)
		}
	}

	// Test actor rejecting refusal title and using first user prompt fallback
	a, _ := darActor(t, &SessionRecord{
		ID:          "sess-refusal-title",
		CWD:         t.TempDir(),
		Title:       "New conversation",
		TitleSource: "pending",
		Messages: []provider.Message{
			{
				Role:    provider.RoleUser,
				Content: []provider.Content{provider.TextBlock{Text: "Fix the button styling on checkout page"}},
			},
		},
	})

	// When worker sends refusal title
	a.handleData(Envelope{Payload: workerTitleMsg{
		gen:      a.gen,
		title:    "I can't invoke the todo or finish_entire_request tools...",
		original: a.rec.Title,
	}})

	// Verify title is NOT the refusal message
	if strings.Contains(a.rec.Title, "can't invoke") {
		t.Fatalf("session title became refusal text: %q", a.rec.Title)
	}
	if !strings.Contains(a.rec.Title, "Fix the button") {
		t.Fatalf("session title expected fallback prompt, got: %q", a.rec.Title)
	}
}
