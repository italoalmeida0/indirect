package tools

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"indirect/indirect-code-daemon/packages/unishcli"
)

func TestMain(m *testing.M) {
	if ok, code := unishcli.MaybeRunArgs(os.Args); ok {
		os.Exit(code)
	}
	os.Exit(m.Run())
}

func TestEmbeddedEnsureShellAndMultiCall(t *testing.T) {
	t.Cleanup(ClearShellOverride)
	if err := EnsureShell(t.TempDir()); err != nil {
		t.Fatalf("EnsureShell failed: %v", err)
	}
	if !ShellAvailable() {
		t.Fatal("expected ShellAvailable() == true")
	}
	shPath, shFlag := ShellForTests()
	if shPath == "" || shFlag != "--sh-c" {
		t.Fatalf("unexpected ShellForTests() = (%q, %q)", shPath, shFlag)
	}
	if desc := ShellDescription(); !strings.Contains(desc, "unish") {
		t.Fatalf("expected ShellDescription() to mention embedded unish, got %q", desc)
	}

	out, err := exec.Command(shPath, "--sh-c", "printf 'embedded-%s' ok").CombinedOutput()
	if err != nil {
		t.Fatalf("child --sh-c failed: %v (out=%q)", err, string(out))
	}
	if string(out) != "embedded-ok" {
		t.Fatalf("unexpected --sh-c output: %q", string(out))
	}

	verOut, err := exec.Command(shPath, "--sh", "--version").CombinedOutput()
	if err != nil {
		t.Fatalf("child --sh --version failed: %v (out=%q)", err, string(verOut))
	}
	if !strings.Contains(string(verOut), "unish") {
		t.Fatalf("unexpected --sh --version output: %q", string(verOut))
	}
}

func TestDirectBashProcessIsolationAndApprover(t *testing.T) {
	t.Cleanup(ClearShellOverride)
	if err := EnsureShell(t.TempDir()); err != nil {
		t.Fatalf("EnsureShell failed: %v", err)
	}
	shPath, shFlag := ShellForTests()
	if shPath == "" || shFlag != "--sh-c" {
		t.Fatalf("expected embedded unish shell, got (%q, %q)", shPath, shFlag)
	}
	selfPID := os.Getpid()

	t.Run("unjailed_without_approver_spawns_real_child", func(t *testing.T) {
		dir := t.TempDir()
		proc, err := startDirect(context.Background(), ExecSpec{
			Kind:      "bash",
			Command:   "printf child-ok",
			RawScript: "printf child-ok",
			Argv:      []string{shPath, shFlag, "printf child-ok"},
			CWD:       dir,
			LogDir:    dir,
		})
		if err != nil {
			t.Fatalf("startDirect failed: %v", err)
		}
		defer proc.Cleanup(true)
		if proc.PID <= 0 || proc.PID == selfPID {
			t.Fatalf("expected direct bash without approver to spawn a real child PID != %d, got %d", selfPID, proc.PID)
		}
		if err := proc.Wait(); err != nil {
			t.Fatalf("child exited with error: %v", err)
		}
		out, err := os.ReadFile(proc.LogPath)
		if err != nil {
			t.Fatalf("read log: %v", err)
		}
		if string(out) != "child-ok" {
			t.Fatalf("unexpected child output: %q", string(out))
		}

		// Also verify BashTool background detach hands off a real child PID.
		origAfter := AutoBackgroundAfter
		AutoBackgroundAfter = 30 * time.Millisecond
		defer func() { AutoBackgroundAfter = origAfter }()

		var bgPID atomic.Int64
		doneCh := make(chan struct{}, 1)
		var bgLabel, bgCmd string
		tool := &BashTool{
			CWD:    dir,
			LogDir: dir,
			Slow: func(_, cmd string, p BackgroundProcess) (string, string, func(string), func(string, bool, int)) {
				bgPID.Store(int64(p.PID))
				bgLabel = p.Label
				bgCmd = cmd
				return "bg-direct-test", p.BrainLog, func(string) {}, func(string, bool, int) {
					select {
					case doneCh <- struct{}{}:
					default:
					}
				}
			},
		}
		if _, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
			"command": "sleep 0.25; echo detached-ok",
			"summary": "Detached echo test",
		}), nil); err != nil {
			t.Fatalf("BashTool.Execute failed: %v", err)
		}
		if bgLabel != "Detached echo test" || bgCmd != "sleep 0.25; echo detached-ok" {
			t.Fatalf("expected summary label and full command in SlowHook, got label=%q cmd=%q", bgLabel, bgCmd)
		}
		gotPID := int(bgPID.Load())
		if gotPID <= 0 || gotPID == selfPID {
			t.Fatalf("expected detached BashTool job to record real child PID != %d, got %d", selfPID, gotPID)
		}
		select {
		case <-doneCh:
		case <-time.After(10 * time.Second):
			t.Fatal("detached direct bash job did not finish")
		}
	})

	t.Run("jailed_without_approver_spawns_child_and_enforces_jail", func(t *testing.T) {
		ws := t.TempDir()
		brain := t.TempDir()
		outside := t.TempDir()
		if err := os.WriteFile(filepath.Join(ws, "inside.txt"), []byte("INSIDE_OK"), 0o600); err != nil {
			t.Fatal(err)
		}
		outsideFile := filepath.Join(outside, "secret.txt")
		if err := os.WriteFile(outsideFile, []byte("OUTSIDE_SECRET_42"), 0o600); err != nil {
			t.Fatal(err)
		}

		sb := NewSandbox(ws)
		sb.SetInteractivePolicy("auto", nil)
		jailSpec := sb.BuildRuntimeJail(brain)
		if jailSpec == nil {
			t.Fatal("expected non-nil RuntimeJailSpec for interactive auto sandbox")
		}

		// Direct startDirect with Jail != nil and Approver == nil must still spawn a child process.
		proc, err := startDirect(context.Background(), ExecSpec{
			Kind:      "bash",
			Command:   "cat inside.txt",
			RawScript: "cat inside.txt",
			Argv:      []string{shPath, shFlag, "cat inside.txt"},
			CWD:       ws,
			Jail:      jailSpec,
			LogDir:    brain,
		})
		if err != nil {
			t.Fatalf("startDirect jailed failed: %v", err)
		}
		defer proc.Cleanup(true)
		if proc.PID <= 0 || proc.PID == selfPID {
			t.Fatalf("expected jailed direct bash without approver to spawn a real child PID != %d, got %d", selfPID, proc.PID)
		}
		if err := proc.Wait(); err != nil {
			t.Fatalf("jailed inside read failed: %v", err)
		}
		out, err := os.ReadFile(proc.LogPath)
		if err != nil {
			t.Fatalf("read log: %v", err)
		}
		if string(out) != "INSIDE_OK" {
			t.Fatalf("unexpected jailed inside output: %q", string(out))
		}

		// Child process must enforce EnvRuntimeJailSpec and block outside reads.
		tool := &BashTool{CWD: ws, Sandbox: sb, LogDir: brain, BrainDir: brain}
		outsideSlash := filepath.ToSlash(outsideFile)
		res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
			"command": "cat '" + outsideSlash + "'",
			"summary": "Outside file read attempt",
		}), nil)
		if err != nil {
			t.Fatalf("unexpected tool-level error: %v", err)
		}
		body := envBody(t, res)
		if strings.Contains(body, "OUTSIDE_SECRET_42") {
			t.Fatalf("jailed child bash leaked outside file: %q", body)
		}
		if envAttr(res, "exit") == "0" {
			t.Fatalf("expected non-zero exit when child jail denies outside read, body=%q", body)
		}
	})

	t.Run("jailed_with_approver_runs_in_process_and_invokes_callback", func(t *testing.T) {
		ws := t.TempDir()
		brain := t.TempDir()
		outside := t.TempDir()
		outsideFile := filepath.Join(outside, "secret.txt")
		if err := os.WriteFile(outsideFile, []byte("APPROVAL_SECRET_99"), 0o600); err != nil {
			t.Fatal(err)
		}
		outsideSlash := filepath.ToSlash(outsideFile)

		sb := NewSandbox(ws)
		sb.SetInteractivePolicy("auto", nil)
		jailSpec := sb.BuildRuntimeJail(brain)
		if jailSpec == nil {
			t.Fatal("expected non-nil RuntimeJailSpec")
		}

		// Verify startDirect runs in-process when Jail != nil && Approver != nil.
		proc, err := startDirect(context.Background(), ExecSpec{
			Kind:      "bash",
			Command:   "printf inproc-ok",
			RawScript: "printf inproc-ok",
			Argv:      []string{shPath, shFlag, "printf inproc-ok"},
			CWD:       ws,
			Jail:      jailSpec,
			Approver: func(context.Context, MidExecApprovalReq) (MidExecApprovalResp, error) {
				return MidExecApprovalResp{Decision: "deny"}, nil
			},
			LogDir: brain,
		})
		if err != nil {
			t.Fatalf("startDirect with approver failed: %v", err)
		}
		defer proc.Cleanup(true)
		if proc.PID != selfPID {
			t.Fatalf("expected direct bash with approver to run in-process (PID=%d), got %d", selfPID, proc.PID)
		}
		if err := proc.Wait(); err != nil {
			t.Fatalf("in-process wait failed: %v", err)
		}

		// Verify interactive approval callback fires and can grant or deny an outside read.
		var mu sync.Mutex
		var reqs []MidExecApprovalReq
		sb.SetMidExecApprover(func(_ context.Context, req MidExecApprovalReq) (MidExecApprovalResp, error) {
			mu.Lock()
			reqs = append(reqs, req)
			mu.Unlock()
			return MidExecApprovalResp{Decision: "once"}, nil
		}, nil)
		tool := &BashTool{CWD: ws, Sandbox: sb, LogDir: brain, BrainDir: brain}
		res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
			"command": "cat '" + outsideSlash + "'",
			"summary": "Outside file read attempt",
		}), nil)
		if err != nil {
			t.Fatalf("BashTool with approver failed: %v", err)
		}
		mu.Lock()
		gotReqs := append([]MidExecApprovalReq(nil), reqs...)
		mu.Unlock()
		if len(gotReqs) == 0 {
			t.Fatal("expected interactive MidExecApprover to be called for outside read")
		}
		if gotReqs[0].Capability != "fs_read" {
			t.Fatalf("expected fs_read approval request, got %+v", gotReqs[0])
		}
		if body := envBody(t, res); !strings.Contains(body, "APPROVAL_SECRET_99") {
			t.Fatalf("expected approved read to return secret content, got %q (exit=%q)", body, envAttr(res, "exit"))
		}

		// Now verify denying callback blocks the read.
		sbDeny := NewSandbox(ws)
		sbDeny.SetInteractivePolicy("auto", nil)
		var denyCalled atomic.Bool
		sbDeny.SetMidExecApprover(func(_ context.Context, _ MidExecApprovalReq) (MidExecApprovalResp, error) {
			denyCalled.Store(true)
			return MidExecApprovalResp{Decision: "deny"}, nil
		}, nil)
		denyTool := &BashTool{CWD: ws, Sandbox: sbDeny, LogDir: brain, BrainDir: brain}
		denyRes, err := denyTool.Execute(context.Background(), mustJSON(t, map[string]any{
			"command": "cat '" + outsideSlash + "'",
			"summary": "Denied outside read",
		}), nil)
		if err != nil {
			t.Fatalf("unexpected tool-level error on denied read: %v", err)
		}
		if !denyCalled.Load() {
			t.Fatal("expected denying MidExecApprover to be invoked")
		}
		if body := envBody(t, denyRes); strings.Contains(body, "APPROVAL_SECRET_99") || envAttr(denyRes, "exit") == "0" {
			t.Fatalf("denied outside read should fail without leaking secret: exit=%q body=%q", envAttr(denyRes, "exit"), body)
		}
	})
}
