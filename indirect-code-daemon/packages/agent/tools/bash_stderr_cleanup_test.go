package tools

import (
	"context"
	"os"
	"strings"
	"testing"
)

func TestBashStderrCapture(t *testing.T) {
	tool := &BashTool{CWD: t.TempDir()}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"command": "printf 'stdout-msg\n'; printf 'stderr-msg\n' >&2",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	details, ok := res.Details.(map[string]any)
	if !ok {
		t.Fatalf("expected details map, got %T", res.Details)
	}
	stdout, _ := details["stdout"].(string)
	stderr, _ := details["stderr"].(string)

	if !strings.Contains(stdout, "stdout-msg") {
		t.Fatalf("expected stdout-msg in stdout, got %q", stdout)
	}
	if !strings.Contains(stderr, "stderr-msg") {
		t.Fatalf("expected stderr-msg in stderr, got %q", stderr)
	}
}

func TestBashTempLogCleanup(t *testing.T) {
	tool := &BashTool{CWD: t.TempDir()}
	// Generate >50KB of output so that openTempFile is triggered
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"command": "seq 1 4000",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	details, ok := res.Details.(map[string]any)
	if !ok {
		t.Fatal("expected details map")
	}
	path, _ := details["full_output_path"].(string)
	if path == "" {
		t.Fatal("expected non-empty full_output_path in details")
	}
	// Verify that the temporary log file has been cleaned up and does not leak
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expected temporary log file %s to be deleted, but stat returned: %v", path, err)
	}
}

func TestBashUserFallback(t *testing.T) {
	origUser := os.Getenv("USER")
	defer func() {
		if origUser != "" {
			_ = os.Setenv("USER", origUser)
		}
	}()
	_ = os.Unsetenv("USER")

	tool := &BashTool{CWD: t.TempDir()}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"command": "echo USER=$USER",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	body := envBody(t, res)
	if !strings.Contains(body, "USER=") || strings.TrimSpace(body) == "USER=" {
		t.Fatalf("expected fallback USER to be populated, got: %q", body)
	}
}
