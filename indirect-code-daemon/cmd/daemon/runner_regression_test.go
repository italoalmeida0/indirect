package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"indirect/indirect-code-daemon/packages/agent/tools"
	"indirect/indirect-code-daemon/packages/runner"
)

func TestRegressionRunnerExecScriptStdin(t *testing.T) {
	root, dataDir := runnerTestRoot(t)
	app, err := buildRealApp()
	if err != nil {
		t.Fatal(err)
	}
	old := runnerSourceOverride
	runnerSourceOverride = app
	defer func() { runnerSourceOverride = old }()
	tool := &tools.ExecScriptTool{CWD: t.TempDir(), Starter: runnerStarter(root, "sess1", filepath.Join(dataDir, "brain", "sess1"))}
	raw, _ := json.Marshal(map[string]string{"code": "import fs from 'node:fs'; console.log('got:' + fs.readFileSync(0, 'utf8'));", "stdin": "ping"})
	result, err := tool.Execute(context.Background(), raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(resultText(result), "got:ping") {
		t.Fatalf("runner discarded exec_script stdin: %q", resultText(result))
	}
}

func TestMultiCallJSRole(t *testing.T) {
	root, _ := runnerTestRoot(t)
	app, err := buildRealApp()
	if err != nil {
		t.Fatal(err)
	}
	old := runnerSourceOverride
	runnerSourceOverride = app
	defer func() { runnerSourceOverride = old }()
	bin, err := ensureRunnerBinary(root)
	if err != nil {
		t.Fatal(err)
	}
	// 1. -e flag: process.argv[1] is omitted so user args start at process.argv[1] (matching node -e)
	out, err := exec.Command(bin, "--js", "-e", "import os from 'node:os'; console.log('js-cli:' + os.platform() + ':' + process.argv.slice(1).join(','));", "arg1", "arg2").CombinedOutput()
	if err != nil {
		t.Fatalf("--js -e failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), ":arg1,arg2") {
		t.Fatalf("unexpected --js -e output: %q", string(out))
	}

	// 2. -p / --print flag
	outP, err := exec.Command(bin, "--js", "-p", "20 + 22").CombinedOutput()
	if err != nil {
		t.Fatalf("--js -p failed: %v\n%s", err, outP)
	}
	if strings.TrimSpace(string(outP)) != "42" {
		t.Fatalf("unexpected --js -p output: %q", string(outP))
	}

	// 3. Script file with -- separator and flags after script path
	scriptFile := filepath.Join(t.TempDir(), "cli_test.js")
	if err := os.WriteFile(scriptFile, []byte(`console.log(JSON.stringify(process.argv.slice(1)));`), 0o644); err != nil {
		t.Fatal(err)
	}
	outFile, err := exec.Command(bin, "--js", "--", scriptFile, "-e", "--flag").CombinedOutput()
	if err != nil {
		t.Fatalf("--js file failed: %v\n%s", err, outFile)
	}
	if !strings.Contains(string(outFile), `"-e","--flag"`) {
		t.Fatalf("unexpected --js file argv output: %q", string(outFile))
	}

	// 4. Stdin script (-) with $ template tag safe interpolation of metacharacters
	cmdStdin := exec.Command(bin, "--js", "-", "hello&world|test")
	cmdStdin.Stdin = strings.NewReader(`
		const val = process.argv[2];
		const res = await $` + "`" + `${process.execPath} --js -e "console.log(process.argv[1])" ${val}` + "`" + `.nothrow().quiet();
		console.log("argv1:" + process.argv[1] + ":interpolated:" + res.text().trim());
	`)
	outStdin, err := cmdStdin.CombinedOutput()
	if err != nil {
		t.Fatalf("--js - failed: %v\n%s", err, outStdin)
	}
	if strings.TrimSpace(string(outStdin)) != "argv1:-:interpolated:hello&world|test" {
		t.Fatalf("unexpected --js - output: %q", string(outStdin))
	}
}

func TestRegressionRunnerForegroundNotReplayed(t *testing.T) {
	root, dataDir := runnerTestRoot(t)
	proc := spawnTestRunner(t, root, dataDir, "echo inline-ok")
	if err := proc.Wait(); err != nil {
		t.Fatal(err)
	}
	rec := newTestRecord("sess1")
	if err := newDiskStore(dataDir).saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	b := newBGSupervisor(dataDir)
	b.adoptRunners()
	if n := b.notices[proc.JobID]; n != nil {
		t.Fatalf("already-returned foreground command generated a background wake-up on restart: %s", n.Text)
	}
}

func TestRegressionRunnerAssistantCancelNotReplayed(t *testing.T) {
	root, dataDir := runnerTestRoot(t)
	proc := spawnTestRunner(t, root, dataDir, "echo ready; sleep 30")
	t.Cleanup(proc.Stop)
	seedSession(t, dataDir, "sess1", proc.JobID)
	waitFor(t, 3*time.Second, func() bool { return fileHas(proc.LogPath, "ready") })
	b := newBGSupervisor(dataDir)
	reply := make(chan any, 1)
	b.onRegister(bgRegisterMsg{Kind: "bash", SessionID: "sess1", JobID: proc.JobID, PID: proc.PID, LogPath: proc.LogPath, Stop: proc.Stop, Reply: reply})
	<-reply
	if b.onCancel(proc.JobID, "assistant") != true {
		t.Fatal("cancel refused")
	}
	<-proc.Exited
	next := newBGSupervisor(dataDir)
	next.adoptRunners()
	if n := next.notices[proc.JobID]; n != nil {
		t.Fatalf("silent assistant cancellation became a wake-up on restart: %s", n.Text)
	}
}

func TestRegressionRunnerRecoveryKeepsExitStatus(t *testing.T) {
	root, dataDir := runnerTestRoot(t)
	proc := spawnTestRunner(t, root, dataDir, "echo ready; sleep 1; exit 7")
	t.Cleanup(proc.Stop)
	seedSession(t, dataDir, "sess1", proc.JobID)
	first := newBGSupervisor(dataDir)
	reply := make(chan any, 1)
	first.onRegister(bgRegisterMsg{Kind: "bash", SessionID: "sess1", JobID: proc.JobID, PID: proc.PID, LogPath: proc.LogPath, Stop: proc.Stop, Reply: reply})
	<-reply
	inbox := make(chan Envelope, 64)
	next := startBG(t, dataDir, func(string) (chan Envelope, chan any, bool) { return inbox, nil, true })
	var row map[string]any
	waitFor(t, 7*time.Second, func() bool {
		for _, j := range listJobs(next) {
			if j["id"] == proc.JobID && j["status"] != BgStatusRunning {
				row = j
				return true
			}
		}
		return false
	})
	st, err := runner.ReadState(runner.StatePath(root, proc.JobID))
	if err != nil {
		t.Fatal(err)
	}
	if st.ExitCode == nil || *st.ExitCode != 7 {
		t.Fatal("fixture did not exit 7")
	}
	if row["status"] != BgStatusError {
		t.Fatalf("durable runner exit=7, recovered registry status=%v result=%v", row["status"], row["result"])
	}
}

func TestRegressionWSResyncSurvivesAnotherFullQueue(t *testing.T) {
	a := reviewActor(t)
	ws := newWSActor()
	sup := newSessionSupervisor(a.store.dataDir, a.supCfg, nil, nil)
	sup.resident[a.id] = &residentEntry{handle: &sessionHandle{inbox: a.inbox, control: a.control, done: a.done}}
	server := newWSServer(a.store.dataDir, a.supCfg, sup, nil, nil, nil, ws)
	go a.run()
	defer func() { a.control <- shutdownMsg{}; <-a.done }()
	for i := 0; i < cap(ws.outbound); i++ {
		ws.emit(map[string]any{"type": "filler"})
	}
	ws.emit(map[string]any{"type": "tool_approval_request", "sessionId": a.id})
	server.scheduleResyncFlush()
	waitFor(t, 3*time.Second, func() bool { return ws.dropped.Load() >= 2 && !server.resyncFlush.Load() })
	if len(ws.takeResyncs()) != 1 {
		t.Fatal("resync snapshot overflowed, but its session was removed from the repair set permanently")
	}
}

func TestRegressionNoticeDoesNotAckFailedPersistence(t *testing.T) {
	a := reviewActor(t)
	a.state, a.rec.Status = stateRunning, "running"
	a.bg = newBGSupervisor(a.store.dataDir)
	path := a.store.sessionFile(a.id)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	a.onBgNotice(bgNoticeMsg{JobID: "not-durable", Text: "completed", Finished: true})
	if a.persistErr == nil {
		t.Fatal("fixture failed to inject a persistence error")
	}
	select {
	case env := <-a.bg.inbox:
		if ack, ok := env.Payload.(bgAckMsg); ok && ack.JobID == "not-durable" {
			t.Fatalf("notice acknowledged despite failed persistence: %v", a.persistErr)
		}
	default:
	}
}
