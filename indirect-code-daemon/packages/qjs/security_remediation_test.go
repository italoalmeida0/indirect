package qjs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Plan 2.7a: Worker IPC listener must require a cryptographically random
// per-worker token (__INDIRECT_WT_TOKEN), rejecting unauthenticated local
// connections immediately; external __INDIRECT_WT_* and __INDIRECT_FORK_IPC
// must be stripped at exec_script entry; forged worker ports in child spawn
// must be stripped; and NetAllow=["__NONE__"] must not be bypassed.
func TestSecurity_WorkerIPCAuthTokenAndNetAllow(t *testing.T) {
	// 1. Direct opWorkerListen rejects unauthenticated TCP client immediately
	// while still accepting the authenticated client with the issued token.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	en := &rtEntry{
		ctx:         ctx,
		cancel:      cancel,
		env:         map[string]string{},
		eventsWake:  make(chan struct{}, 1),
		eventsSpace: make(chan struct{}, 1),
		workerChans: make(map[int32]*rtWorkerChannel),
	}
	resJSON, _, _, errCode, err := en.opWorkerListen("7")
	if err != nil || errCode != "" {
		t.Fatalf("opWorkerListen failed: code=%q err=%v", errCode, err)
	}
	defer func() { _, _, _, _, _ = en.opWorkerClose("7") }()

	var info struct {
		Port  int    `json:"port"`
		Token string `json:"token"`
	}
	if err := json.Unmarshal([]byte(resJSON), &info); err != nil {
		t.Fatalf("opWorkerListen did not return JSON {port,token}: %q (%v)", resJSON, err)
	}
	if info.Port <= 0 || len(info.Token) != 64 {
		t.Fatalf("unexpected listen info: port=%d tokenLen=%d", info.Port, len(info.Token))
	}

	addr := fmt.Sprintf("127.0.0.1:%d", info.Port)
	// Connect with an invalid token: server MUST close the connection immediately
	// and keep listening for the legitimate worker.
	badConn, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		t.Fatalf("dial bad client: %v", err)
	}
	_, _ = badConn.Write([]byte(strings.Repeat("0", 64)))
	_ = badConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 16)
	if _, rerr := badConn.Read(buf); rerr == nil {
		_ = badConn.Close()
		t.Fatalf("expected unauthenticated worker IPC connection to be closed")
	}
	_ = badConn.Close()

	// Now connect with the valid token: handshake must succeed and stay open.
	goodConn, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		t.Fatalf("dial good client after bad attempt: %v", err)
	}
	defer goodConn.Close()
	if _, werr := goodConn.Write([]byte(info.Token)); werr != nil {
		t.Fatalf("write valid token: %v", werr)
	}
	// Send one framed worker message and verify parent receives it.
	msg := []byte("hello-worker")
	frame := make([]byte, 4+len(msg))
	frame[3] = byte(len(msg))
	copy(frame[4:], msg)
	if _, werr := goodConn.Write(frame); werr != nil {
		t.Fatalf("write frame: %v", werr)
	}
	deadline := time.Now().Add(2 * time.Second)
	gotMsg := false
	for time.Now().Before(deadline) {
		en.eventsMu.Lock()
		for _, ev := range en.eventsQueue {
			if ev.kind == rtEventWorkerMessage && string(ev.bin) == "hello-worker" {
				gotMsg = true
			}
		}
		en.eventsMu.Unlock()
		if gotMsg {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	if !gotMsg {
		t.Fatalf("authenticated worker message was not received")
	}

	// 2. Top-level exec_script entry strips external __INDIRECT_WT_* and __INDIRECT_FORK_IPC.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	var probeHits atomic.Int32
	go func() {
		for {
			c, aerr := ln.Accept()
			if aerr != nil {
				return
			}
			probeHits.Add(1)
			_ = c.Close()
		}
	}()
	probePort := ln.Addr().(*net.TCPAddr).Port

	var outBuf, errBuf bytes.Buffer
	code, runErr := RunScript(context.Background(), ScriptOptions{
		Filename: "<exec_script>",
		Code: `
			const hasSend = typeof process.send === "function";
			const hasPort = "__INDIRECT_WT_CTL_PORT" in process.env;
			const hasTok = "__INDIRECT_WT_TOKEN" in process.env;
			const hasFork = "__INDIRECT_FORK_IPC" in process.env;
			console.log(JSON.stringify({ hasSend, hasPort, hasTok, hasFork }));
		`,
		CWD:       t.TempDir(),
		JailRoots: []string{t.TempDir()},
		Env: map[string]string{
			"__INDIRECT_FORK_IPC":    "1",
			"__INDIRECT_WT_CTL_PORT": fmt.Sprintf("%d", probePort),
			"__INDIRECT_WT_TOKEN":    strings.Repeat("a", 64),
		},
		Stdout: &outBuf,
		Stderr: &errBuf,
	})
	if runErr != nil || code != 0 {
		t.Fatalf("exec_script entry failed: code=%d err=%v stderr=%s", code, runErr, errBuf.String())
	}
	want := `{"hasSend":false,"hasPort":false,"hasTok":false,"hasFork":false}`
	if strings.TrimSpace(outBuf.String()) != want {
		t.Fatalf("external __INDIRECT_WT_*/FORK_IPC leaked into exec_script: got %q, want %q", strings.TrimSpace(outBuf.String()), want)
	}
	if probeHits.Load() != 0 {
		t.Fatalf("exec_script probed arbitrary port via forged __INDIRECT_WT_CTL_PORT (%d hits)", probeHits.Load())
	}

	// 3. ensureChildWorkerChannel must enforce NetAllow=["__NONE__"] even when checkAccess is set.
	enNoNet := &rtEntry{
		ctx:         ctx,
		cancel:      cancel,
		netAllow:    []string{"__NONE__"},
		checkAccess: func(context.Context, string, string, []string) error { return nil },
		env: map[string]string{
			"__INDIRECT_WT_CTL_PORT": fmt.Sprintf("%d", probePort),
			"__INDIRECT_WT_TOKEN":    strings.Repeat("b", 64),
		},
		workerChans: make(map[int32]*rtWorkerChannel),
	}
	if _, derr := enNoNet.ensureChildWorkerChannel(); derr == nil {
		t.Fatalf("ensureChildWorkerChannel bypassed NetAllow=['__NONE__'] when checkAccess != nil")
	}
	if probeHits.Load() != 0 {
		t.Fatalf("NetAllow=['__NONE__'] still dialed 127.0.0.1:%d (%d hits)", probePort, probeHits.Load())
	}

	// 4. enforceChildEnvMap strips forged __INDIRECT_WT_CTL_PORT / __INDIRECT_WT_TOKEN / __INDIRECT_FORK_IPC.
	enSandbox := &rtEntry{
		ctx:         ctx,
		cancel:      cancel,
		jailRoots:   []string{t.TempDir()},
		workerChans: make(map[int32]*rtWorkerChannel),
	}
	forgedEnv := map[string]string{
		"__INDIRECT_FORK_IPC":    "1",
		"__INDIRECT_WT_CTL_PORT": fmt.Sprintf("%d", probePort),
		"__INDIRECT_WT_TOKEN":    strings.Repeat("c", 64),
		"SAFE_VAR":               "ok",
	}
	enSandbox.enforceChildEnvMap(forgedEnv)
	for _, k := range []string{"__INDIRECT_FORK_IPC", "__INDIRECT_WT_CTL_PORT", "__INDIRECT_WT_TOKEN"} {
		if _, exists := forgedEnv[k]; exists {
			t.Fatalf("enforceChildEnvMap failed to strip forged %s", k)
		}
	}
	if forgedEnv["SAFE_VAR"] != "ok" {
		t.Fatalf("enforceChildEnvMap stripped benign SAFE_VAR")
	}
}

// Plan 2.7b: opFSSymlink and opFSCp must resolve relative symlink targets
// against the canonical parent directory before checking jail containment.
func TestSecurity_SymlinkAndCpResolveCanonicalParent(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX relative symlink test")
	}
	parent := t.TempDir()
	ws := filepath.Join(parent, "ws")
	if err := os.MkdirAll(filepath.Join(ws, "a", "b"), 0o755); err != nil {
		t.Fatal(err)
	}
	outsideSecret := filepath.Join(parent, "outside_secret.txt")
	if err := os.WriteFile(outsideSecret, []byte("OUTSIDE_SECRET_DATA"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ws, "inside.txt"), []byte("INSIDE_OK"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Symlink ws/a/b/linkdir -> ws (completely inside jail).
	if err := os.Symlink(ws, filepath.Join(ws, "a", "b", "linkdir")); err != nil {
		t.Fatal(err)
	}
	// Also create a legitimate in-jail relative symlink inside ws/a/b/ok_rel -> ../inside_unused (or ../../inside.txt)
	// whose relative target "../outside_secret.txt" stays inside ws when under ws/a/b,
	// but escapes ws when copied under ws/a/b/linkdir (whose canonical parent is ws)!
	if err := os.WriteFile(filepath.Join(ws, "a", "outside_secret.txt"), []byte("DECOY_INSIDE"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../outside_secret.txt", filepath.Join(ws, "a", "b", "rel_link")); err != nil {
		t.Fatal(err)
	}

	var outBuf, errBuf bytes.Buffer
	code, runErr := RunScript(context.Background(), ScriptOptions{
		Code: `
			import fs from "node:fs";

			let symlinkBlocked = false;
			try {
				fs.symlinkSync("../outside_secret.txt", "a/b/linkdir/escape_link");
			} catch (e) {
				symlinkBlocked = e.code === "EACCES";
			}

			let cpSingleBlocked = false;
			try {
				fs.cpSync("a/b/rel_link", "a/b/linkdir/copied_escape", { dereference: false });
			} catch (e) {
				cpSingleBlocked = e.code === "EACCES";
			}

			// Legitimate relative symlink staying within canonical jail still succeeds.
			fs.symlinkSync("inside.txt", "good_rel_link");
			const goodVal = fs.readFileSync("good_rel_link", "utf8");

			console.log(JSON.stringify({ symlinkBlocked, cpSingleBlocked, goodVal }));
		`,
		CWD:       ws,
		JailRoots: []string{ws},
		Stdout:    &outBuf,
		Stderr:    &errBuf,
	})
	if runErr != nil || code != 0 {
		t.Fatalf("symlink/cp canonical parent script failed: code=%d err=%v stderr=%s", code, runErr, errBuf.String())
	}
	want := `{"symlinkBlocked":true,"cpSingleBlocked":true,"goodVal":"INSIDE_OK"}`
	if strings.TrimSpace(outBuf.String()) != want {
		t.Fatalf("unexpected canonical symlink test result: got %q, want %q", strings.TrimSpace(outBuf.String()), want)
	}
	if _, serr := os.Lstat(filepath.Join(ws, "escape_link")); !os.IsNotExist(serr) {
		t.Fatalf("escape_link was created in ws root despite jail check")
	}
	if _, serr := os.Lstat(filepath.Join(ws, "copied_escape")); !os.IsNotExist(serr) {
		t.Fatalf("copied_escape was created in ws root despite jail check")
	}
}

// Plan 2.7c: checkDirectExec must consult checkAccess("exec") even when
// spawning the self binary with --js or --js-exec-direct.
func TestSecurity_CheckDirectExecEnforcesDenyOnSelfJS(t *testing.T) {
	ws := t.TempDir()
	var execChecks atomic.Int32
	var outBuf, errBuf bytes.Buffer
	code, runErr := RunScript(context.Background(), ScriptOptions{
		Code: `
			import cp from "node:child_process";

			const r1 = cp.spawnSync(process.execPath, ["--js", "-e", "console.log('SHOULD_NOT_RUN')"], { encoding: "utf8" });
			const r2 = cp.spawnSync(process.execPath, ["--js-exec-direct", "console.log('SHOULD_NOT_RUN')"], { encoding: "utf8" });

			console.log(JSON.stringify({
				r1Code: r1.error ? r1.error.code : "",
				r2Code: r2.error ? r2.error.code : "",
				r1Out: String(r1.stdout || ""),
				r2Out: String(r2.stdout || ""),
			}));
		`,
		CWD: ws,
		CheckAccess: func(ctx context.Context, kind, target string, argv []string) error {
			if kind == "exec" {
				execChecks.Add(1)
				return errors.New("explicit deny exec rule")
			}
			return nil
		},
		Stdout: &outBuf,
		Stderr: &errBuf,
	})
	if runErr != nil || code != 0 {
		t.Fatalf("checkDirectExec test script failed: code=%d err=%v stderr=%s", code, runErr, errBuf.String())
	}
	if execChecks.Load() < 2 {
		t.Fatalf("expected checkAccess('exec') to be called for both --js and --js-exec-direct, got %d calls", execChecks.Load())
	}
	want := `{"r1Code":"EACCES","r2Code":"EACCES","r1Out":"","r2Out":""}`
	if strings.TrimSpace(outBuf.String()) != want {
		t.Fatalf("self --js/--js-exec-direct bypassed CheckAccess('exec'): got %q, want %q", strings.TrimSpace(outBuf.String()), want)
	}
}
