package tools

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// A cancelled turn must not mutate the filesystem through tools whose work
// is otherwise synchronous.
func TestWriteAndEditHonorCancelledContext(t *testing.T) {
	dir := t.TempDir()
	existing := filepath.Join(dir, "existing.txt")
	if err := os.WriteFile(existing, []byte("before"), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	writeTool := &WriteTool{CWD: dir}
	if _, err := writeTool.Execute(ctx, mustJSON(t, map[string]any{"path": "new.txt", "content": "x"}), nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("write error = %v, want context.Canceled", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "new.txt")); !os.IsNotExist(err) {
		t.Fatalf("cancelled write created the file (stat err = %v)", err)
	}

	editTool := &EditTool{CWD: dir}
	if _, err := editTool.Execute(ctx, mustJSON(t, map[string]any{
		"path":  "existing.txt",
		"edits": []map[string]string{{"old_text": "before", "new_text": "after"}},
	}), nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("edit error = %v, want context.Canceled", err)
	}
	got, err := os.ReadFile(existing)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "before" {
		t.Fatalf("cancelled edit changed the file: %q", got)
	}
}
