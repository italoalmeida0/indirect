package runner

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"indirect/indirect-code-daemon/packages/agent/tools"
)

func TestRunnerMidExecApprovalIPC_BashAndExecScript(t *testing.T) {
	root := t.TempDir()
	ws := t.TempDir()
	tmp := t.TempDir()
	outsideDir := filepath.Join(t.TempDir(), "ext-target")
	if err := os.MkdirAll(outsideDir, 0o755); err != nil {
		t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}

	// 1. Mid-execution bash approval over loopback IPC.
	outFile1 := filepath.Join(outsideDir, "approved-bash.txt")
	started1 := NowMs()
	spec1 := Spec{
		JobID:         "ipc_bash_1",
		SessionID:     "sess_ipc",
		Kind:          "bash",
		Label:         "write outside",
		Path:          exe,
		Args:          []string{"--sh-c", fmt.Sprintf("printf 'bash-ok' > '%s'", filepath.ToSlash(outFile1))},
		RawScript:     fmt.Sprintf("printf 'bash-ok' > '%s'", filepath.ToSlash(outFile1)),
		Env:           os.Environ(),
		CWD:           ws,
		Root:          root,
		RunnerVersion: "vtest",
		OutPath:       filepath.Join(OutDir(root), OutName("sess_ipc", "ipc_bash_1", started1)),
		BrainPath:     filepath.Join(root, "brain", "sess_ipc", "ipc_bash_1.log"),
		Jail: &tools.RuntimeJailSpec{
			AccessMode: "auto",
			Workspace:  ws,
			TmpDir:     tmp,
		},
	}

	var seenPrompts atomic.Int32
	ctx1, cancel1 := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel1()
	go func() {
		_ = AttachApprovalHandler(ctx1, root, spec1.JobID, 5*time.Second, func(ctx context.Context, req tools.MidExecApprovalReq) (tools.MidExecApprovalResp, error) {
			seenPrompts.Add(1)
			return tools.MidExecApprovalResp{
				Decision:    "session",
				GrantedRule: req.ProposedRule,
			}, nil
		})
	}()

	code1 := Run(spec1)
	if code1 != 0 {
		outBytes, _ := os.ReadFile(spec1.OutPath)
		t.Fatalf("expected exit 0 after approval, got %d; out=%s", code1, string(outBytes))
	}
	if seenPrompts.Load() != 1 {
		t.Fatalf("expected 1 mid-exec prompt, got %d", seenPrompts.Load())
	}
	got1, err := os.ReadFile(outFile1)
	if err != nil || string(got1) != "bash-ok" {
		t.Fatalf("expected %q = 'bash-ok', got %q (%v)", outFile1, string(got1), err)
	}
	rawState, err := os.ReadFile(StatePath(root, spec1.JobID))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(rawState), "rawScript") || strings.Contains(string(rawState), "jail") {
		t.Fatalf("state.json must not persist RawScript or Jail: %s", string(rawState))
	}

	// 2. Mid-execution exec_script ($`...` + fs.readFileSync) approval over loopback IPC.
	outFile2 := filepath.Join(outsideDir, "approved-qjs.txt")
	started2 := NowMs()
	jsCode := fmt.Sprintf(
		"import * as fs from 'fs';\nawait $`printf 'qjs-shell-ok' > '%s'`;\nconsole.log(fs.readFileSync('%s', 'utf8'));\n",
		filepath.ToSlash(outFile2),
		filepath.ToSlash(outFile2),
	)
	spec2 := Spec{
		JobID:         "ipc_qjs_2",
		SessionID:     "sess_ipc",
		Kind:          "exec_script",
		Label:         "qjs outside",
		Path:          exe,
		Code:          jsCode,
		Env:           os.Environ(),
		CWD:           ws,
		Root:          root,
		RunnerVersion: "vtest",
		OutPath:       filepath.Join(OutDir(root), OutName("sess_ipc", "ipc_qjs_2", started2)),
		BrainPath:     filepath.Join(root, "brain", "sess_ipc", "ipc_qjs_2.log"),
		Jail: &tools.RuntimeJailSpec{
			AccessMode: "auto",
			Workspace:  ws,
			TmpDir:     tmp,
		},
	}

	var qjsPrompts atomic.Int32
	ctx2, cancel2 := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel2()
	go func() {
		_ = AttachApprovalHandler(ctx2, root, spec2.JobID, 5*time.Second, func(ctx context.Context, req tools.MidExecApprovalReq) (tools.MidExecApprovalResp, error) {
			qjsPrompts.Add(1)
			return tools.MidExecApprovalResp{Decision: "once"}, nil
		})
	}()

	code2 := Run(spec2)
	if code2 != 0 {
		outBytes, _ := os.ReadFile(spec2.OutPath)
		t.Fatalf("exec_script expected exit 0 after approval, got %d; out=%s", code2, string(outBytes))
	}
	if qjsPrompts.Load() < 2 {
		t.Fatalf("expected prompts for both $ write and fs read, got %d", qjsPrompts.Load())
	}
	outBytes2, _ := os.ReadFile(spec2.OutPath)
	if !strings.Contains(string(outBytes2), "qjs-shell-ok") {
		t.Fatalf("expected 'qjs-shell-ok' in output, got %q", string(outBytes2))
	}
}

func TestRunnerMidExecApprovalIPC_FailClosedOnUnattachedAndDetach(t *testing.T) {
	root := t.TempDir()
	ws := t.TempDir()
	tmp := t.TempDir()
	outsideDir := filepath.Join(t.TempDir(), "blocked-ext")
	if err := os.MkdirAll(outsideDir, 0o755); err != nil {
		t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}

	// 1. Unattached runner (background task) -> immediately denies without hanging!
	blockedFile1 := filepath.Join(outsideDir, "unattached.txt")
	started1 := NowMs()
	spec1 := Spec{
		JobID:         "fail_closed_1",
		SessionID:     "sess_fc",
		Kind:          "bash",
		Label:         "unattached",
		Path:          exe,
		RawScript:     fmt.Sprintf("printf 'nope' > '%s'", filepath.ToSlash(blockedFile1)),
		Env:           os.Environ(),
		CWD:           ws,
		Root:          root,
		RunnerVersion: "vtest",
		OutPath:       filepath.Join(OutDir(root), OutName("sess_fc", "fail_closed_1", started1)),
		BrainPath:     filepath.Join(root, "brain", "sess_fc", "fail_closed_1.log"),
		Jail: &tools.RuntimeJailSpec{
			AccessMode: "auto",
			Workspace:  ws,
			TmpDir:     tmp,
		},
	}
	code1 := Run(spec1)
	if code1 == 0 {
		t.Fatalf("expected non-zero exit when unattached runner hits mid-exec approval")
	}
	if _, serr := os.Stat(blockedFile1); serr == nil {
		t.Fatalf("unattached runner must NOT create %s", blockedFile1)
	}

	// 2. Daemon detaches mid-prompt -> runner immediately unblocks with "deny"!
	blockedFile2 := filepath.Join(outsideDir, "detached.txt")
	started2 := NowMs()
	spec2 := Spec{
		JobID:         "fail_closed_2",
		SessionID:     "sess_fc",
		Kind:          "bash",
		Label:         "detached",
		Path:          exe,
		RawScript:     fmt.Sprintf("printf 'nope' > '%s'", filepath.ToSlash(blockedFile2)),
		Env:           os.Environ(),
		CWD:           ws,
		Root:          root,
		RunnerVersion: "vtest",
		OutPath:       filepath.Join(OutDir(root), OutName("sess_fc", "fail_closed_2", started2)),
		BrainPath:     filepath.Join(root, "brain", "sess_fc", "fail_closed_2.log"),
		Jail: &tools.RuntimeJailSpec{
			AccessMode: "auto",
			Workspace:  ws,
			TmpDir:     tmp,
		},
	}

	attachCtx, detachNow := context.WithCancel(context.Background())
	defer detachNow()
	go func() {
		_ = AttachApprovalHandler(attachCtx, root, spec2.JobID, 5*time.Second, func(ctx context.Context, req tools.MidExecApprovalReq) (tools.MidExecApprovalResp, error) {
			// Simulate foreground->background detach while waiting on user!
			detachNow()
			<-ctx.Done()
			return tools.MidExecApprovalResp{}, ctx.Err()
		})
	}()

	done := make(chan int, 1)
	go func() { done <- Run(spec2) }()
	select {
	case code2 := <-done:
		if code2 == 0 {
			t.Fatalf("expected non-zero exit when daemon detaches mid-prompt")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("runner hung instead of failing closed when daemon detached mid-prompt")
	}
	if _, serr := os.Stat(blockedFile2); serr == nil {
		t.Fatalf("detached runner must NOT create %s", blockedFile2)
	}
}
