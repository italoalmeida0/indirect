package main

import (
	"os"
	"path/filepath"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/runner"
)

// Regression (audit bug 28): repairTerminalCopy re-copied the brain log but
// never healed OutputReady (only the runner's second write sets it), so a
// run recovered from a crash between the terminal state write and the copy
// reported unknownExecution forever. A successful repair IS the publication
// the flag describes: it must set OutputReady and persist the state.
func TestRepairTerminalCopyHealsOutputReady(t *testing.T) {
	root := t.TempDir()
	out := filepath.Join(t.TempDir(), "out.log")
	if err := os.WriteFile(out, []byte("command output\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	code := 0
	st := &runner.State{
		JobID:     "bg_1",
		SessionID: "s1",
		Status:    runner.StatusDone,
		ExitCode:  &code,
		LogPath:   out,
		BrainPath: filepath.Join(t.TempDir(), "brain.log"),
		// The crash window: terminal state written, but the runner died
		// before the copy + OutputReady publication.
	}
	if err := repairTerminalCopy(root, st); err != nil {
		t.Fatal(err)
	}
	if !st.OutputReady {
		t.Fatal("repairTerminalCopy must heal OutputReady: the copy IS the publication the flag describes")
	}
	got, err := runner.ReadState(runner.StatePath(root, st.JobID))
	if err != nil {
		t.Fatalf("healed state must be persisted (tool_receipt reads it from disk): %v", err)
	}
	if !got.OutputReady {
		t.Fatalf("persisted state lost the healed OutputReady: %+v", got)
	}
	if b, err := os.ReadFile(st.BrainPath); err != nil || string(b) != "command output\n" {
		t.Fatalf("brain copy wrong: %q (%v)", b, err)
	}
}
