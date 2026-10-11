package main

// Regression tests for the crash-only boot contract (Bug 14): an UNREQUESTED
// clean worker exit (0, nil) must consume a respawn attempt exactly like a
// crash — only an explicit stop request (stop.req) or an update handoff may
// end supervision without a restart.

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// stubExec swaps the child-launch seam and restores it (plus the crash
// budget and backoff) on cleanup.
func stubExec(t *testing.T, fn func(daemonPath, dataDir string, daemonArgs []string) (int, error)) {
	t.Helper()
	prevExec, prevBudget, prevBackoff := execDaemonFn, superviseCrashBudget, superviseBackoff
	execDaemonFn = fn
	superviseCrashBudget = 2
	superviseBackoff = time.Millisecond
	t.Cleanup(func() {
		execDaemonFn, superviseCrashBudget, superviseBackoff = prevExec, prevBudget, prevBackoff
	})
}

// Bug 14: exit classification. A clean exit without an explicit stop is a
// crash; stop.req / update handoff are the only intentional stops.
func TestBootNextActionCleanExitWithoutStopIsCrash(t *testing.T) {
	dir := t.TempDir()
	if got := bootNextAction(0, nil, dir); got != "restart" {
		t.Fatalf("unrequested clean exit: got %q, want \"restart\"", got)
	}
	if got := bootNextAction(9, errors.New("daemon exited 9"), dir); got != "restart" {
		t.Fatalf("crash exit: got %q, want \"restart\"", got)
	}
	if got := bootNextAction(0, errUpdateHandoff, dir); got != "stop" {
		t.Fatalf("update handoff: got %q, want \"stop\"", got)
	}
	mustWriteFile(filepath.Join(dir, "stop.req"), "stop\n")
	if got := bootNextAction(0, nil, dir); got != "stop" {
		t.Fatalf("stop.req present: got %q, want \"stop\"", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "stop.req")); !os.IsNotExist(err) {
		t.Fatalf("stop.req must be consumed by the classification; stat err = %v", err)
	}
}

// Bug 14: the supervision loop must ATTEMPT A RESTART after an unrequested
// clean exit (respawning until the crash budget is exhausted), not shut the
// boot down forever on the first exit 0.
func TestSuperviseWorkerLoopRestartsUnrequestedCleanExit(t *testing.T) {
	dir := t.TempDir()
	calls := 0
	stubExec(t, func(_, _ string, _ []string) (int, error) {
		calls++
		return 0, nil // clean exit, no stop.req
	})
	code := superviseWorkerLoop("daemon", dir, nil)
	if code != 1 {
		t.Fatalf("give-up exit code = %d, want 1", code)
	}
	// Initial run + 2 respawns (budget 2), then give up on the 3rd exit.
	if calls != 3 {
		t.Fatalf("execDaemon calls = %d, want 3 (initial + %d respawns)", calls, superviseCrashBudget)
	}
}

// The intentional-stop paths still end supervision without a respawn: the
// loop exits with the child's code.
func TestSuperviseWorkerLoopStopsOnRequest(t *testing.T) {
	dir := t.TempDir()
	calls := 0
	stubExec(t, func(_, dataDir string, _ []string) (int, error) {
		calls++
		if calls == 1 {
			return 0, nil // unrequested clean exit: must restart
		}
		mustWriteFile(filepath.Join(dataDir, "stop.req"), "stop\n")
		return 0, nil // --stop request
	})
	code := superviseWorkerLoop("daemon", dir, nil)
	if code != 0 {
		t.Fatalf("exit code = %d, want 0 (child's code)", code)
	}
	if calls != 2 {
		t.Fatalf("execDaemon calls = %d, want 2 (one restart, then stop)", calls)
	}
}

// An update handoff also ends supervision without a respawn.
func TestSuperviseWorkerLoopStopsOnUpdateHandoff(t *testing.T) {
	dir := t.TempDir()
	calls := 0
	stubExec(t, func(_, _ string, _ []string) (int, error) {
		calls++
		return 0, errUpdateHandoff
	})
	if code := superviseWorkerLoop("daemon", dir, nil); code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	if calls != 1 {
		t.Fatalf("execDaemon calls = %d, want 1 (no respawn after handoff)", calls)
	}
}
