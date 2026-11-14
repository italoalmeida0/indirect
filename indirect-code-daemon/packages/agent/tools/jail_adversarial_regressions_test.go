package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/italoalmeida0/unish/pkg/unish"
	"indirect/indirect-code-daemon/packages/qjs"
)

func createDirLinkOrJunction(t *testing.T, linkPath, targetDir string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		cmd := exec.Command("cmd", "/c", "mklink", "/J", linkPath, targetDir)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("mklink /J %q -> %q failed: %v (%s)", linkPath, targetDir, err, string(out))
		}
		return
	}
	if err := os.Symlink(targetDir, linkPath); err != nil {
		t.Fatalf("symlink %q -> %q failed: %v", linkPath, targetDir, err)
	}
}

// Regression for Defect #1: Windows NTFS directory junction (and POSIX dir symlink)
// inside workspace pointing outside workspace MUST NOT auto-allow read or write in unish.
func TestJailRegression_DirectoryJunctionEscapeBlockedInUnishAndPlan(t *testing.T) {
	ws := t.TempDir()
	tmpDir := t.TempDir()
	outside := t.TempDir()
	secretFile := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(secretFile, []byte("TOP_SECRET_JUNCTION_DATA"), 0o600); err != nil {
		t.Fatal(err)
	}

	juncPath := filepath.Join(ws, "escape_junc")
	createDirLinkOrJunction(t, juncPath, outside)

	var asks atomic.Int32
	rt, err := NewPolicyRuntime(RuntimeJailSpec{
		AccessMode: "auto",
		Workspace:  ws,
		TmpDir:     tmpDir,
	}, os.Environ(), func(ctx context.Context, req MidExecApprovalReq) (MidExecApprovalResp, error) {
		asks.Add(1)
		return MidExecApprovalResp{Decision: "deny"}, nil
	})
	if err != nil {
		t.Fatal(err)
	}

	// 1. Read via junction inside unish must prompt and fail when denied.
	var stdout, stderr bytes.Buffer
	code, _ := rt.ExecShell(context.Background(), "cat escape_junc/secret.txt", ws, os.Environ(), nil, &stdout, &stderr)
	if code == 0 || strings.Contains(stdout.String(), "TOP_SECRET_JUNCTION_DATA") {
		t.Fatalf("junction read escaped unish jail! code=%d asks=%d stdout=%q stderr=%q", code, asks.Load(), stdout.String(), stderr.String())
	}
	if asks.Load() == 0 {
		t.Fatalf("expected outside-workspace junction read to trigger approval prompt, got asks=0 (stderr=%q)", stderr.String())
	}

	// 2. Write via junction inside unish must prompt, fail when denied, and leave outside untouched.
	asks.Store(0)
	stdout.Reset()
	stderr.Reset()
	code, _ = rt.ExecShell(context.Background(), "echo pwn > escape_junc/pwn.txt", ws, os.Environ(), nil, &stdout, &stderr)
	if code == 0 {
		t.Fatalf("junction write escaped unish jail! code=%d asks=%d", code, asks.Load())
	}
	if asks.Load() == 0 {
		t.Fatalf("expected outside-workspace junction write to trigger approval prompt, got asks=0 (stderr=%q)", stderr.String())
	}
	if _, statErr := os.Stat(filepath.Join(outside, "pwn.txt")); !os.IsNotExist(statErr) {
		t.Fatalf("outside pwn.txt must not be created via junction! err=%v", statErr)
	}

	// 3. Plan mode (ProjectReadOnly) must also block writing into workspace via a junction in tmpDir.
	tmpToWsJunc := filepath.Join(tmpDir, "ws_backlink")
	createDirLinkOrJunction(t, tmpToWsJunc, ws)
	rtPlan, err := NewPolicyRuntime(RuntimeJailSpec{
		AccessMode:      "auto",
		Workspace:       ws,
		TmpDir:          tmpDir,
		ProjectReadOnly: true,
	}, os.Environ(), func(ctx context.Context, req MidExecApprovalReq) (MidExecApprovalResp, error) {
		return MidExecApprovalResp{Decision: "once"}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	stdout.Reset()
	stderr.Reset()
	planTarget := filepath.ToSlash(filepath.Join(tmpToWsJunc, "plan_escape.txt"))
	code, _ = rtPlan.ExecShell(context.Background(), fmt.Sprintf("echo nope > '%s'", planTarget), ws, os.Environ(), nil, &stdout, &stderr)
	if code == 0 {
		t.Fatalf("expected plan-mode write via tmpDir junction into workspace to fail, got code=0")
	}
	if _, statErr := os.Stat(filepath.Join(ws, "plan_escape.txt")); !os.IsNotExist(statErr) {
		t.Fatalf("plan_escape.txt must not exist in read-only workspace! err=%v", statErr)
	}
}

// Regression for Defect #2: Outside-workspace .env.example must NOT auto-allow in
// unish or qjs, and symlinked <ws>/.env.example -> <ws>/.env must NOT auto-allow.
func TestJailRegression_EnvTemplateConfinedToWorkspaceAndNotSymlinkedSecret(t *testing.T) {
	ws := t.TempDir()
	tmpDir := t.TempDir()
	outside := t.TempDir()

	outsideTemplate := filepath.Join(outside, ".env.example")
	if err := os.WriteFile(outsideTemplate, []byte("OUTSIDE_TEMPLATE_DATA=secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ws, ".env.example"), []byte("WS_SAFE_TEMPLATE=ok"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ws, ".env"), []byte("WS_REAL_SECRET=topsecret"), 0o600); err != nil {
		t.Fatal(err)
	}

	var asks atomic.Int32
	rt, err := NewPolicyRuntime(RuntimeJailSpec{
		AccessMode: "auto",
		Workspace:  ws,
		TmpDir:     tmpDir,
	}, os.Environ(), func(ctx context.Context, req MidExecApprovalReq) (MidExecApprovalResp, error) {
		asks.Add(1)
		return MidExecApprovalResp{Decision: "deny"}, nil
	})
	if err != nil {
		t.Fatal(err)
	}

	// 1. Inside-workspace genuine .env.example is allowed with 0 prompts in both unish and qjs.
	var stdout, stderr bytes.Buffer
	code, err := rt.ExecShell(context.Background(), "cat .env.example", ws, os.Environ(), nil, &stdout, &stderr)
	if err != nil || code != 0 || !strings.Contains(stdout.String(), "WS_SAFE_TEMPLATE=ok") || asks.Load() != 0 {
		t.Fatalf("workspace .env.example should succeed with 0 asks: code=%d err=%v asks=%d out=%q", code, err, asks.Load(), stdout.String())
	}
	stdout.Reset()
	stderr.Reset()
	qjsOpts := rt.QJSOptions(qjs.ScriptOptions{
		Code:   `import * as fs from "fs"; console.log(fs.readFileSync(".env.example", "utf8"));`,
		CWD:    ws,
		Stdout: &stdout,
		Stderr: &stderr,
	})
	qCode, qErr := qjs.RunScript(context.Background(), qjsOpts)
	if qErr != nil || qCode != 0 || !strings.Contains(stdout.String(), "WS_SAFE_TEMPLATE=ok") || asks.Load() != 0 {
		t.Fatalf("qjs workspace .env.example should succeed with 0 asks: code=%d err=%v asks=%d out=%q", qCode, qErr, asks.Load(), stdout.String())
	}

	// 2. Outside-workspace .env.example MUST prompt and fail when denied in unish.
	asks.Store(0)
	stdout.Reset()
	stderr.Reset()
	outSlash := filepath.ToSlash(outsideTemplate)
	code, _ = rt.ExecShell(context.Background(), fmt.Sprintf("cat '%s'", outSlash), ws, os.Environ(), nil, &stdout, &stderr)
	if code == 0 || strings.Contains(stdout.String(), "OUTSIDE_TEMPLATE_DATA") {
		t.Fatalf("outside .env.example escaped unish jail! code=%d asks=%d out=%q", code, asks.Load(), stdout.String())
	}
	if asks.Load() == 0 {
		t.Fatalf("expected outside .env.example in unish to prompt, got asks=0")
	}

	// 3. Outside-workspace .env.example MUST prompt and fail when denied in qjs.
	asks.Store(0)
	stdout.Reset()
	stderr.Reset()
	outsideJSON, _ := json.Marshal(outSlash)
	qCode, _ = qjs.RunScript(
		context.Background(),
		rt.QJSOptions(qjs.ScriptOptions{
			Code:   fmt.Sprintf(`import * as fs from "fs"; console.log(fs.readFileSync(%s, "utf8"));`, string(outsideJSON)),
			CWD:    ws,
			Stdout: &stdout,
			Stderr: &stderr,
		}),
	)
	if qCode == 0 || strings.Contains(stdout.String(), "OUTSIDE_TEMPLATE_DATA") {
		t.Fatalf("outside .env.example escaped qjs jail! code=%d asks=%d out=%q", qCode, asks.Load(), stdout.String())
	}
	if asks.Load() == 0 {
		t.Fatalf("expected outside .env.example in qjs to prompt, got asks=0")
	}

	// 4. Symlink <ws>/sub/.env.example -> <ws>/.env (when OS permits file symlinks) must also prompt and fail.
	subDir := filepath.Join(ws, "sub")
	if err := os.MkdirAll(subDir, 0o755); err != nil {
		t.Fatal(err)
	}
	symEnv := filepath.Join(subDir, ".env.example")
	if symErr := os.Symlink(filepath.Join(ws, ".env"), symEnv); symErr == nil {
		asks.Store(0)
		stdout.Reset()
		stderr.Reset()
		code, _ = rt.ExecShell(context.Background(), "cat sub/.env.example", ws, os.Environ(), nil, &stdout, &stderr)
		if code == 0 || strings.Contains(stdout.String(), "WS_REAL_SECRET") || asks.Load() == 0 {
			t.Fatalf("symlinked sub/.env.example -> .env bypassed jail! code=%d asks=%d out=%q", code, asks.Load(), stdout.String())
		}
	}
}

// Regression for Defect #3: Protected workspace subpaths (.git/config, .git/hooks/*,
// .indirect/*, sub/.env*, .npmrc, .netrc, *.pem, *.key, id_rsa) must require approval
// on BOTH read and write across EvaluateToolCall, unish, and qjs, while `ls -la` in
// workspace root and normal files succeed with 0 prompts.
func TestJailRegression_ProtectedWorkspaceSubpathsInUnishQJSAndPolicy(t *testing.T) {
	ws := t.TempDir()
	tmpDir := t.TempDir()

	files := map[string]string{
		"README.md":               "public readme",
		".git/config":             "[remote \"origin\"]\n\turl = https://token@github.com/org/repo.git\n",
		".git/hooks/pre-commit":   "#!/bin/sh\necho hook\n",
		".indirect/settings.json": `{"secret":true}`,
		"sub/.env":                "SUB_SECRET=1",
		"sub/.env.local":          "SUB_LOCAL_SECRET=2",
		".npmrc":                  "//registry.npmjs.org/:_authToken=secret_npm",
		".netrc":                  "machine api.github.com login user password secret_netrc",
		"certs/server.key":        "PRIVATE_KEY_MATERIAL",
		"certs/ca.pem":            "PEM_MATERIAL",
		"keys/id_ed25519":         "SSH_KEY_MATERIAL",
	}
	for rel, content := range files {
		full := filepath.Join(ws, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	var asks atomic.Int32
	rt, err := NewPolicyRuntime(RuntimeJailSpec{
		AccessMode: "auto",
		Workspace:  ws,
		TmpDir:     tmpDir,
	}, os.Environ(), func(ctx context.Context, req MidExecApprovalReq) (MidExecApprovalResp, error) {
		asks.Add(1)
		return MidExecApprovalResp{Decision: "deny"}, nil
	})
	if err != nil {
		t.Fatal(err)
	}

	// Normal workspace listing (`ls -la`) and normal file read (`cat README.md`) must have 0 prompts.
	var stdout, stderr bytes.Buffer
	code, execErr := rt.ExecShell(context.Background(), "ls -la && cat README.md", ws, os.Environ(), nil, &stdout, &stderr)
	if execErr != nil || code != 0 || asks.Load() != 0 || !strings.Contains(stdout.String(), "public readme") {
		t.Fatalf("normal workspace ls -la && cat README.md failed or prompted: code=%d err=%v asks=%d stderr=%q", code, execErr, asks.Load(), stderr.String())
	}

	protectedRels := []string{
		".git/config",
		".git/hooks/pre-commit",
		".indirect/settings.json",
		"sub/.env",
		"sub/.env.local",
		".npmrc",
		".netrc",
		"certs/server.key",
		"certs/ca.pem",
		"keys/id_ed25519",
	}

	broadWsGrant := PermissionRule{
		ID:      "ws-broad",
		Effect:  "allow",
		Kind:    "fs_read",
		Pattern: strings.TrimRight(filepath.ToSlash(ws), "/") + "/**",
	}

	for _, rel := range protectedRels {
		secretVal := strings.TrimSpace(files[rel])

		// 1. EvaluateToolCall("read") in auto mode -> VerdictAsk; even with broad <ws>/** in ask mode -> VerdictAsk!
		evAuto := EvaluateToolCall("read", mustJSON(t, map[string]any{"path": rel}), "auto", ws, "", false, nil)
		if evAuto.Verdict != VerdictAsk {
			t.Errorf("EvaluateToolCall read %q in auto: got %v, want VerdictAsk", rel, evAuto.Verdict)
		}
		evBroadAsk := EvaluateToolCall("read", mustJSON(t, map[string]any{"path": rel}), "ask", ws, "", false, []PermissionRule{broadWsGrant})
		if evBroadAsk.Verdict != VerdictAsk {
			t.Errorf("EvaluateToolCall read %q with broad <ws>/** grant: got %v, want VerdictAsk", rel, evBroadAsk.Verdict)
		}

		// 2. Dynamic variable read in unish (`f=...; cat "$f"`) -> prompts and fails when denied!
		asks.Store(0)
		stdout.Reset()
		stderr.Reset()
		uCode, _ := rt.ExecShell(context.Background(), fmt.Sprintf("f=%q; cat \"$f\"", rel), ws, os.Environ(), nil, &stdout, &stderr)
		if uCode == 0 || strings.Contains(stdout.String(), secretVal) {
			t.Errorf("unish read %q bypassed protected path gate! code=%d asks=%d out=%q", rel, uCode, asks.Load(), stdout.String())
		}
		if asks.Load() == 0 {
			t.Errorf("unish read %q did not prompt (asks=0, stderr=%q)", rel, stderr.String())
		}

		// 3. QuickJS `fs.readFileSync(rel, "utf8")` -> prompts and fails when denied!
		asks.Store(0)
		stdout.Reset()
		stderr.Reset()
		relJSON, _ := json.Marshal(rel)
		qCode, _ := qjs.RunScript(
			context.Background(),
			rt.QJSOptions(qjs.ScriptOptions{
				Code:   fmt.Sprintf(`import * as fs from "fs"; console.log(fs.readFileSync(%s, "utf8"));`, string(relJSON)),
				CWD:    ws,
				Stdout: &stdout,
				Stderr: &stderr,
			}),
		)
		if qCode == 0 || strings.Contains(stdout.String(), secretVal) {
			t.Errorf("qjs read %q bypassed protected path gate! code=%d asks=%d out=%q", rel, qCode, asks.Load(), stdout.String())
		}
		if asks.Load() == 0 {
			t.Errorf("qjs read %q did not prompt (asks=0, stderr=%q)", rel, stderr.String())
		}
	}
}

// Regression for Defect #4: External binaries (`curl`, `nc`, `python3`, `pwsh`, etc.)
// targeting Runner ControlPort in unish MUST be hard-denied (0 prompts, 0 TCP hits),
// and QuickJS UDP `dgram` MUST re-check resolved IP+port against ControlPort.
func TestJailRegression_ControlPortHardBlockedInUnishExecAndQJSUDP(t *testing.T) {
	ws := t.TempDir()
	tmpDir := t.TempDir()

	var tcpHits atomic.Int32
	tcpLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer tcpLn.Close()
	go func() {
		for {
			c, err := tcpLn.Accept()
			if err != nil {
				return
			}
			tcpHits.Add(1)
			_ = c.Close()
		}
	}()
	ctrlPort := tcpLn.Addr().(*net.TCPAddr).Port

	for _, mode := range []string{"auto", "full"} {
		var asks atomic.Int32
		rt, err := NewPolicyRuntime(RuntimeJailSpec{
			AccessMode:  mode,
			Workspace:   ws,
			TmpDir:      tmpDir,
			ControlPort: ctrlPort,
		}, os.Environ(), func(ctx context.Context, req MidExecApprovalReq) (MidExecApprovalResp, error) {
			asks.Add(1)
			return MidExecApprovalResp{Decision: "once"}, nil
		})
		if err != nil {
			t.Fatal(err)
		}

		// Direct OpExec capability check on curl/nc/python/pwsh variations.
		blockedArgvs := [][]string{
			{"curl", "-sS", "--max-time", "2", fmt.Sprintf("http://127.0.0.1:%d/", ctrlPort)},
			{"curl", fmt.Sprintf("http://localhost:%d/approve", ctrlPort)},
			{"curl", fmt.Sprintf("http://[::1]:%d/", ctrlPort)},
			{"nc", "127.0.0.1", fmt.Sprintf("%d", ctrlPort)},
			{"python3", "-c", fmt.Sprintf("import socket; s=socket.socket(); s.connect(('127.0.0.1', %d))", ctrlPort)},
			{"pwsh", "-Command", fmt.Sprintf("Test-NetConnection 127.0.0.1 -Port %d", ctrlPort)},
		}
		for _, argv := range blockedArgvs {
			chkErr := rt.Hook().CheckAccess(context.Background(), unish.AccessRequest{
				Op:      unish.OpExec,
				Binary:  argv[0],
				Argv:    argv,
				WorkDir: ws,
			})
			if chkErr == nil {
				t.Fatalf("mode=%s: expected OpExec %v targeting ControlPort %d to be hard-blocked!", mode, argv, ctrlPort)
			}
			if asks.Load() != 0 {
				t.Fatalf("mode=%s: ControlPort OpExec %v MUST hard-deny without prompting, got asks=%d", mode, argv, asks.Load())
			}
		}

		// Also run live `curl` inside `rt.ExecShell` if host has curl installed.
		if _, lookErr := exec.LookPath("curl"); lookErr == nil {
			var stdout, stderr bytes.Buffer
			cmd := fmt.Sprintf("curl -sS --max-time 2 http://127.0.0.1:%d/", ctrlPort)
			code, _ := rt.ExecShell(context.Background(), cmd, ws, os.Environ(), nil, &stdout, &stderr)
			if code == 0 {
				t.Fatalf("mode=%s: live curl to ControlPort succeeded!", mode)
			}
			if asks.Load() != 0 {
				t.Fatalf("mode=%s: live curl to ControlPort prompted %d times instead of hard-denying", mode, asks.Load())
			}
			if tcpHits.Load() != 0 {
				t.Fatalf("mode=%s: live curl connected to ControlPort TCP listener (%d hits)!", mode, tcpHits.Load())
			}
		}
	}

	// QuickJS UDP dgram send to "localhost" resolving to 127.0.0.1:<udpCtrlPort> MUST fail with 0 packets received.
	udpConn, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer udpConn.Close()
	udpCtrlPort := udpConn.LocalAddr().(*net.UDPAddr).Port
	var udpPackets atomic.Int32
	go func() {
		buf := make([]byte, 256)
		for {
			_ = udpConn.SetReadDeadline(time.Now().Add(2 * time.Second))
			if n, _, rerr := udpConn.ReadFrom(buf); rerr == nil && n > 0 {
				udpPackets.Add(1)
			} else if rerr != nil {
				return
			}
		}
	}()

	rtUDP, err := NewPolicyRuntime(RuntimeJailSpec{
		AccessMode:  "full",
		Workspace:   ws,
		TmpDir:      tmpDir,
		ControlPort: udpCtrlPort,
	}, os.Environ(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var outBuf, errBuf bytes.Buffer
	udpScript := fmt.Sprintf(`
import * as dgram from "dgram";
const sock = dgram.createSocket("udp4");
await new Promise((resolve, reject) => {
  sock.send("PING", %d, "localhost", (err) => {
    sock.close();
    if (err) reject(err);
    else resolve();
  });
});
`, udpCtrlPort)
	qCode, qErr := qjs.RunScript(context.Background(), rtUDP.QJSOptions(qjs.ScriptOptions{
		Code:   udpScript,
		CWD:    ws,
		Stdout: &outBuf,
		Stderr: &errBuf,
	}))
	if qCode == 0 && qErr == nil {
		t.Fatalf("expected QJS UDP send to localhost:%d (ControlPort) to fail, but succeeded!", udpCtrlPort)
	}
	time.Sleep(50 * time.Millisecond)
	if udpPackets.Load() != 0 {
		t.Fatalf("QJS UDP packet reached ControlPort listener (%d packets)!", udpPackets.Load())
	}
}

// Regression for Defect #5: fetch_url SSRF policy & runtime blocks metadata (IPv4,
// IPv4-mapped IPv6 ::ffff:169.254.169.254, fd00:ec2::254, metadata.google.internal.)
// in ALL modes (including full), blocks *.localhost and private/CGNAT/unspecified IPs
// with VerdictDeny (never VerdictAsk), and pins DialContext IPs.
func TestJailRegression_FetchURLSSRFMetadataLocalhostSubdomainAndPrivateIPs(t *testing.T) {
	ws := t.TempDir()

	// 1. Cloud metadata URLs MUST return VerdictDeny in ask, auto, AND full (even with a wildcard net allow rule!).
	allowAllNet := []PermissionRule{{ID: "n1", Effect: "allow", Kind: "net", Pattern: "*"}}
	metadataURLs := []string{
		"http://169.254.169.254/latest/meta-data/",
		"http://[::ffff:169.254.169.254]/latest/meta-data/",
		"http://[::ffff:169.254.169.254]:80/latest/meta-data/",
		"http://[fd00:ec2::254]/latest/meta-data/",
		"http://100.100.100.200/latest/meta-data/",
		"http://metadata.google.internal/computeMetadata/v1/",
		"http://metadata.google.internal./computeMetadata/v1/",
	}
	for _, u := range metadataURLs {
		for _, mode := range []string{"ask", "auto", "full"} {
			ev := EvaluateToolCall("fetch_url", mustJSON(t, map[string]any{"url": u}), mode, ws, "", false, allowAllNet)
			if ev.Verdict != VerdictDeny {
				t.Fatalf("fetch_url %q in mode=%s: got %v, want VerdictDeny", u, mode, ev.Verdict)
			}
			if ev.Meta.ProposedRule != nil || ev.Meta.CanAllowSession || ev.Meta.CanAllowAlways {
				t.Fatalf("fetch_url %q in mode=%s must never propose persistent rule: %+v", u, mode, ev.Meta)
			}
		}
	}

	// 2. Private/reserved/CGNAT/unspecified IPs and *.localhost MUST return VerdictDeny in auto & ask.
	ssrfDeniedInJailed := []string{
		"http://attacker.localhost/pwn",
		"http://sub.attacker.localhost:8080/pwn",
		"http://10.0.0.1/admin",
		"http://192.168.1.1/admin",
		"http://172.16.0.1/admin",
		"http://[::ffff:10.0.0.1]/admin",
		"http://100.64.0.1/admin",
		"http://0.0.0.0:8080/",
		"http://[::]:8080/",
		"http://[fe80::1]/",
		"http://[fd12:3456::1]/",
	}
	for _, u := range ssrfDeniedInJailed {
		for _, mode := range []string{"ask", "auto"} {
			ev := EvaluateToolCall("fetch_url", mustJSON(t, map[string]any{"url": u}), mode, ws, "", false, nil)
			if ev.Verdict != VerdictDeny {
				t.Fatalf("fetch_url %q in mode=%s: got %v, want VerdictDeny", u, mode, ev.Verdict)
			}
		}
	}

	// 3. Genuine loopback (localhost, 127.0.0.1, [::1]) stays allowed in auto mode, while attacker.localhost is NOT loopback.
	if isLoopbackHost("attacker.localhost") {
		t.Fatal("attacker.localhost must NOT be classified as loopback")
	}
	for _, lb := range []string{"http://localhost:3000/health", "http://127.0.0.1:3000/health", "http://[::1]:3000/health"} {
		ev := EvaluateToolCall("fetch_url", mustJSON(t, map[string]any{"url": lb}), "auto", ws, "", false, nil)
		if ev.Verdict != VerdictAllow {
			t.Fatalf("loopback %q in auto: got %v, want VerdictAllow", lb, ev.Verdict)
		}
	}

	// 4. Runtime FetchURLTool in "full" mode STILL blocks ::ffff:169.254.169.254, fd00:ec2::254, and ControlPort!
	sbFull := NewSandbox(ws)
	sbFull.SetInteractivePolicy("full", nil)
	ftFull := &FetchURLTool{CWD: ws, Sandbox: sbFull, ControlPort: 45123}
	for _, blockedFullURL := range append(metadataURLs, "http://127.0.0.1:45123/ipc", "http://[::ffff:127.0.0.1]:45123/ipc") {
		_, err := ftFull.Execute(context.Background(), mustJSON(t, map[string]any{"url": blockedFullURL, "timeout_sec": 2}), nil)
		if err == nil {
			t.Fatalf("FetchURLTool in full mode MUST block %q, got nil error", blockedFullURL)
		}
	}
}

// Regression for Defect #7: Stale/non-existent directories on host PATH must be
// stripped by PrepareEnv & QJSOptions in jailed modes so external binary lookup
// never triggers spurious fs_read/OpStat approval prompts, while PATH="" stays "".
func TestJailRegression_NonExistentPathEntriesStrippedZeroPrompts(t *testing.T) {
	ws := t.TempDir()
	tmpDir := t.TempDir()
	missingDirA := filepath.Join(t.TempDir(), "nonexistent-sshpass")
	missingDirB := filepath.Join(t.TempDir(), "ghost-sdk", "bin")

	baseEnv := make([]string, 0, len(os.Environ())+1)
	foundPath := false
	for _, kv := range os.Environ() {
		if strings.HasPrefix(strings.ToUpper(kv), "PATH=") {
			foundPath = true
			orig := kv[strings.IndexByte(kv, '=')+1:]
			sep := string(filepath.ListSeparator)
			baseEnv = append(baseEnv, "PATH="+missingDirA+sep+missingDirB+sep+orig)
		} else {
			baseEnv = append(baseEnv, kv)
		}
	}
	if !foundPath {
		baseEnv = append(baseEnv, "PATH="+missingDirA+string(filepath.ListSeparator)+os.Getenv("PATH"))
	}

	var asks atomic.Int32
	rt, err := NewPolicyRuntime(RuntimeJailSpec{
		AccessMode: "auto",
		Workspace:  ws,
		TmpDir:     tmpDir,
	}, baseEnv, func(ctx context.Context, req MidExecApprovalReq) (MidExecApprovalResp, error) {
		asks.Add(1)
		return MidExecApprovalResp{Decision: "deny"}, nil
	})
	if err != nil {
		t.Fatal(err)
	}

	cleaned := rt.PrepareEnv(baseEnv)
	for _, kv := range cleaned {
		if strings.HasPrefix(strings.ToUpper(kv), "PATH=") {
			val := kv[5:]
			if strings.Contains(val, "nonexistent-sshpass") || strings.Contains(val, "ghost-sdk") {
				t.Fatalf("PrepareEnv failed to strip non-existent PATH entries: %q", val)
			}
		}
	}

	// Verify PATH="" remains empty (standalone hermetic mode).
	emptyCleaned := rt.PrepareEnv([]string{"PATH="})
	for _, kv := range emptyCleaned {
		if strings.HasPrefix(strings.ToUpper(kv), "PATH=") && kv != "PATH=" {
			t.Fatalf("PrepareEnv mutated empty PATH='': got %q", kv)
		}
	}

	// Execute external binary (`go version`) with stale PATH entries: MUST succeed with 0 approval prompts!
	if _, lookErr := exec.LookPath("go"); lookErr == nil {
		var stdout, stderr bytes.Buffer
		code, execErr := rt.ExecShell(context.Background(), "go version", ws, baseEnv, nil, &stdout, &stderr)
		if execErr != nil || code != 0 {
			t.Fatalf("go version with stale PATH entries failed: code=%d err=%v stderr=%q", code, execErr, stderr.String())
		}
		if asks.Load() != 0 {
			t.Fatalf("expected 0 approval prompts when PATH contains non-existent dirs, got %d", asks.Load())
		}
	}
}
