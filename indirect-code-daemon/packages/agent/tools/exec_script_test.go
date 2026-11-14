package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"indirect/indirect-code-daemon/packages/core"
)

func TestExecScriptCodeExecution(t *testing.T) {
	dir := t.TempDir()
	tool := &ExecScriptTool{CWD: dir, Sandbox: NewSandbox(dir)}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"code": "console.log('hello ' + 'world')",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := toolResultText(t, res)
	if !strings.Contains(got, "hello world") {
		t.Fatalf("expected output, got %q", got)
	}
	if got := envAttr(res, "exit"); got != "0" {
		t.Fatalf("expected exit attr 0, got %q", got)
	}
}

func TestExecScriptStdinAndExitCode(t *testing.T) {
	dir := t.TempDir()
	tool := &ExecScriptTool{CWD: dir, Sandbox: NewSandbox(dir)}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"code":  "import fs from 'node:fs'; console.log('got:' + fs.readFileSync(0, 'utf8').trim())",
		"stdin": "ping",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := toolResultText(t, res); !strings.Contains(got, "got:ping") {
		t.Fatalf("stdin not piped, got %q", got)
	}

	res, err = tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"code": "process.exit(3)",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := envAttr(res, "exit"); got != "3" {
		t.Fatalf("expected exit attr 3, got %q", got)
	}
	if res.IsError {
		t.Fatal("non-zero exit must not be IsError (it is type=ok exit=3)")
	}
}

func TestExecScriptLocalModuleImport(t *testing.T) {
	dir := t.TempDir()
	helper := filepath.Join(dir, "helper.js")
	if err := os.WriteFile(helper, []byte("export const greet = (name) => `hi:${name}`;\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tool := &ExecScriptTool{CWD: dir, Sandbox: NewSandbox(dir)}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"code": "import { greet } from './helper.js'; console.log(greet('agent'))",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := toolResultText(t, res); !strings.Contains(got, "hi:agent") {
		t.Fatalf("expected module greeting, got %q", got)
	}
}

func TestExecScriptValidation(t *testing.T) {
	dir := t.TempDir()
	tool := &ExecScriptTool{CWD: dir, Sandbox: NewSandbox(dir)}
	for name, args := range map[string]any{
		"empty":      map[string]any{},
		"whitespace": map[string]any{"code": "   \n\t  "},
	} {
		if _, err := tool.Execute(context.Background(), mustJSON(t, args), nil); err == nil {
			t.Fatalf("%s: expected validation error", name)
		}
	}
}

func TestExecScriptSandboxJail(t *testing.T) {
	parent := t.TempDir()
	dir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(parent, "outside.txt")
	if err := os.WriteFile(secret, []byte("forbidden"), 0o644); err != nil {
		t.Fatal(err)
	}

	sb := NewSandbox(dir)
	sb.Lock()
	tool := &ExecScriptTool{CWD: dir, Sandbox: sb}
	// Workdir outside the jail must be rejected.
	if _, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"code":     "console.log(1)",
		"work_dir": "..",
	}), nil); err == nil {
		t.Fatal("expected jail rejection for work_dir ..")
	}

	// Runtime fs access and process.chdir outside jail (even when constructed dynamically to bypass static CheckCommand) must be blocked by JailRoots!
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"code": `
			import fs from "node:fs";
			import path from "node:path";
			try {
				const target = path.join(process.cwd(), "sub", "..", "..", "outside.txt");
				fs.readFileSync(target, "utf8");
				console.log("ESCAPED");
			} catch (e) {
				console.log("BLOCKED:" + e.code);
			}
		`,
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := toolResultText(t, res); !strings.Contains(got, "BLOCKED:EACCES") {
		t.Fatalf("expected EACCES jail block inside runtime, got %q", got)
	}

	// Also verify process.argv does not leak --runner and has length 2.
	resArgv, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"code": `console.log(JSON.stringify({ len: process.argv.length, arg1: process.argv[1] }))`,
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := toolResultText(t, resArgv); !strings.Contains(got, `"len":2`) || strings.Contains(got, "--runner") {
		t.Fatalf("unexpected process.argv in exec_script: %q", got)
	}
}

func TestExecScriptNoTimeout(t *testing.T) {
	dir := t.TempDir()
	tool := &ExecScriptTool{CWD: dir, Sandbox: NewSandbox(dir)}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"code": "await new Promise(r => setTimeout(r, 200)); console.log('done')",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := toolResultText(t, res); !strings.Contains(got, "done") {
		t.Fatalf("expected normal completion, got %q", got)
	}
	if got := envAttr(res, "exit"); got != "0" {
		t.Fatalf("expected exit attr 0, got %q", got)
	}
}

func toolResultText(t *testing.T, res core.ToolResult) string {
	t.Helper()
	return envBody(t, res)
}

func TestExecScriptUnicodeIO(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "workspace ação")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LANG", "C")
	t.Setenv("LC_ALL", "C")
	tool := &ExecScriptTool{CWD: dir, Sandbox: NewSandbox(dir)}
	code := `
import fs from "node:fs";
const s = fs.readFileSync(0, "utf8");
fs.writeFileSync("ação.txt", s);
console.log(fs.readFileSync("ação.txt", "utf8"));
console.error(s);
`
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"code":  code,
		"stdin": "ação 日本語 🚀",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := toolResultText(t, res)
	if strings.Count(got, "ação 日本語 🚀") != 2 || envAttr(res, "exit") != "0" {
		t.Fatalf("Unicode stdin/file/stdout/stderr roundtrip: %s", got)
	}
}

func TestExecScriptMergesStdoutStderrWithoutMarker(t *testing.T) {
	dir := t.TempDir()
	tool := &ExecScriptTool{CWD: dir, Sandbox: NewSandbox(dir)}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"code": "console.log('out'); console.error('err')",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := envBody(t, res)
	if strings.Contains(got, "[stderr]") {
		t.Fatalf("body must not carry a system marker: %q", got)
	}
	if !strings.Contains(got, "out") || !strings.Contains(got, "err") {
		t.Fatalf("both streams must reach the body: %q", got)
	}
	// Empty output is a fact (attr), never "(no output)" prose in the body.
	res, err = tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"code": "const _ = 1;",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := envBody(t, res); got != "" {
		t.Fatalf("empty output must have an empty body, got %q", got)
	}
	if got := envAttr(res, "info"); got != "no output" {
		t.Fatalf("info attr = %q", got)
	}
}

func TestExecScriptBackgroundDetailsInitialization(t *testing.T) {
	res, err := finishExecScriptCommand(nil, nil, bytes.Buffer{}, time.Now(), nil, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if res.Details != nil {
		t.Fatalf("expected nil details from finishExecScriptCommand, got %v", res.Details)
	}

	jobID := "bg_test_123"
	det, ok := res.Details.(map[string]any)
	if !ok || det == nil {
		det = make(map[string]any)
		res.Details = det
	}
	det["background_job_id"] = jobID
	det["detached"] = true

	d, ok := res.Details.(map[string]any)
	if !ok {
		t.Fatalf("expected map[string]any, got %T", res.Details)
	}
	if d["background_job_id"] != jobID {
		t.Fatalf("expected jobID %s, got %v", jobID, d["background_job_id"])
	}
	if d["detached"] != true {
		t.Fatalf("expected detached=true, got %v", d["detached"])
	}

	// Verify droppedBytes from cappedWriter marks result as truncated even when tail is short.
	var smallBuf bytes.Buffer
	smallBuf.WriteString("tail-line\n")
	resDropped, err := finishExecScriptCommand(nil, nil, smallBuf, time.Now(), nil, 1024, 5)
	if err != nil {
		t.Fatal(err)
	}
	if got := envAttr(resDropped, "truncated"); got != "true" {
		t.Fatalf("expected truncated=true when droppedBytes > 0, got %q", got)
	}
	if got := envAttr(resDropped, "dropped_bytes"); got != "1024" {
		t.Fatalf("expected dropped_bytes=1024, got %q", got)
	}
	if got := envAttr(resDropped, "page"); got != "6-6/6" {
		t.Fatalf("expected page=6-6/6 with 5 dropped lines, got %q", got)
	}

	// Verify context cancellation marks status=aborted.
	resAborted, err := finishExecScriptCommand(context.Canceled, context.Canceled, smallBuf, time.Now(), nil, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got := envAttr(resAborted, "status"); got != "aborted" {
		t.Fatalf("expected status=aborted on context cancel, got %q", got)
	}
}

func TestExecScriptReadOnlyProjectAndCheckCommand(t *testing.T) {
	parent := t.TempDir()
	ws := filepath.Join(parent, "ws")
	brain := filepath.Join(parent, "brain")
	if err := os.MkdirAll(ws, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(brain, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ws, "readme.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}

	sb := NewSandbox(ws)
	sb.AllowExtra(brain)
	sb.SetProjectReadOnly(true)
	sb.Lock()
	tool := &ExecScriptTool{CWD: ws, Sandbox: sb}

	// 1. Valid JS containing shell-like substrings, paths, or regexes is not falsely rejected pre-execution,
	// while actual out-of-jail filesystem access is blocked at runtime with EACCES.
	resLit, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"code": `
			import fs from "node:fs";
			const msg = "sudo is just a word";
			const p = "/tmp";
			const etc = "/etc/hosts";
			const re = /rm -rf \//;
			let outReadCode = "NONE";
			try {
				fs.readFileSync("../outside.txt", "utf8");
			} catch (e) {
				outReadCode = e.code;
			}
			console.log(JSON.stringify({ msg, p, etc, re: re.test("rm -rf /"), homeLog: "path: /home/user", outReadCode }));
		`,
	}), nil)
	if err != nil {
		t.Fatalf("unexpected error for valid JS literals: %v", err)
	}
	gotLit := toolResultText(t, resLit)
	if !strings.Contains(gotLit, `"outReadCode":"EACCES"`) || !strings.Contains(gotLit, `"re":true`) {
		t.Fatalf("unexpected literal/jail result: %q", gotLit)
	}

	// 2. ReadOnlyRoots allows reading project files and writing to brain extraRoot, but blocks project writes.
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"code": `
			import fs from "node:fs";
			import path from "node:path";
			const txt = fs.readFileSync("readme.txt", "utf8");
			let projWriteCode = "NONE";
			try {
				fs.writeFileSync("pwned.txt", "bad");
			} catch (e) {
				projWriteCode = e.code;
			}
			const brainFile = path.join(process.env.BRAIN_DIR, "plan.md");
			fs.writeFileSync(brainFile, "plan:" + txt);
			console.log(JSON.stringify({ txt, projWriteCode, brain: fs.readFileSync(brainFile, "utf8") }));
		`,
		"env": map[string]string{"BRAIN_DIR": brain},
	}), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := toolResultText(t, res)
	if !strings.Contains(got, `"projWriteCode":"EACCES"`) || !strings.Contains(got, `"brain":"plan:hello"`) {
		t.Fatalf("unexpected read-only project result: %q", got)
	}
}

func TestExecScriptJailedAllowsDotDotLiteralsAndInterleavesOutput(t *testing.T) {
	dir := t.TempDir()
	sb := NewSandbox(dir)
	sb.Lock()
	tool := &ExecScriptTool{CWD: dir, Sandbox: sb}

	// Harmless ".." string literals in path computation must not be rejected by bash CheckCommand heuristics.
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"code": `
			import path from "node:path";
			console.error("first-err");
			console.log(path.posix.join("a/b", "..", "c"));
			console.error("last-err");
		`,
	}), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := toolResultText(t, res)
	want := "first-err\na/c\nlast-err"
	if strings.TrimSpace(got) != want {
		t.Fatalf("expected interleaved output %q, got %q", want, got)
	}
}

func TestExecScriptRound8RouteLiteralsAndLegacyArgs(t *testing.T) {
	dir := t.TempDir()
	sb := NewSandbox(dir)
	sb.SetProjectReadOnly(true)
	sb.Lock()
	tool := &ExecScriptTool{CWD: dir, Sandbox: sb}

	// 1. URL route strings like "/v1/users" must not be rejected as host root paths in jailed exec_script.
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"code": `const route = "/v1/users"; console.log("route:" + route);`,
	}), nil)
	if err != nil {
		t.Fatalf("unexpected route literal rejection: %v", err)
	}
	if got := strings.TrimSpace(toolResultText(t, res)); got != "route:/v1/users" {
		t.Fatalf("unexpected output: %q", got)
	}

	// 2. Large script (>40KB) in direct mode must succeed via __INDIRECT_CODE_FILE on Windows/POSIX.
	largeComment := "// " + strings.Repeat("a", 40000) + "\n"
	res, err = tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"code": largeComment + `console.log("large-ok");`,
	}), nil)
	if err != nil {
		t.Fatalf("large script failed: %v", err)
	}
	if got := strings.TrimSpace(toolResultText(t, res)); got != "large-ok" {
		t.Fatalf("unexpected large script output: %q", got)
	}

	// 3. Legacy migrated Python call returns clear error message.
	_, err = tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"legacy_lang": "python",
		"script":      "train.py",
	}), nil)
	if err == nil || !strings.Contains(err.Error(), "legacy Python") {
		t.Fatalf("expected clear legacy Python error, got: %v", err)
	}

	// 4. Read-only bash CheckCommand allows quoted '=>' and 'git stash list' / 'git apply --check'.
	if err := sb.CheckCommand(`grep -rn '=>' .`); err != nil {
		t.Fatalf("expected quoted '=>' to be allowed in read-only mode, got: %v", err)
	}
	if err := sb.CheckCommand(`git stash list`); err != nil {
		t.Fatalf("expected 'git stash list' to be allowed in read-only mode, got: %v", err)
	}
	if err := sb.CheckCommand(`git apply --check patch.diff`); err != nil {
		t.Fatalf("expected 'git apply --check' to be allowed in read-only mode, got: %v", err)
	}
	if err := sb.CheckCommand(`git stash push`); err == nil {
		t.Fatal("expected 'git stash push' to be rejected in read-only mode")
	}
}

func TestExecScriptRound12PermissionsAndDirectEnv(t *testing.T) {
	root := t.TempDir()
	srcDir := filepath.Join(root, "src")
	outDir := filepath.Join(root, "out")
	secretDir := filepath.Join(root, "secret")
	for _, d := range []string{srcDir, outDir, secretDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(srcDir, "allowed.txt"), []byte("allowed-read"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(secretDir, "secret.txt"), []byte("top-secret"), 0o644); err != nil {
		t.Fatal(err)
	}

	var p PermissionSet
	p.Bash.Mode = "allowlist"
	p.Bash.Allow = []string{"exec_script"}
	p.FS.Read = []string{srcDir}
	p.FS.Write = []string{outDir}
	p.Net.Allow = []string{"allowed.example.com"}

	sb := NewSandbox(root)
	sb.SetPermissions(&p)
	sb.Lock()
	tool := &ExecScriptTool{CWD: root, Sandbox: sb, LogDir: t.TempDir()}

	t.Setenv("META_API_KEY", "super-secret-daemon-key")

	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"code": `
			import assert from "node:assert";
			import fs from "node:fs";
			import path from "node:path";

			// 1. Daemon secrets must never leak into exec_script
			assert.strictEqual(process.env.META_API_KEY, undefined);

			// 2. Scoped FS.Read allows src/allowed.txt but denies secret/secret.txt
			assert.strictEqual(fs.readFileSync(path.join("src", "allowed.txt"), "utf8"), "allowed-read");
			assert.throws(() => fs.readFileSync(path.join("secret", "secret.txt"), "utf8"), (e) => e.code === "EACCES");

			// 3. Scoped FS.Write allows out/result.txt (even though out/ is not in FS.Read) and denies src/nope.txt
			fs.writeFileSync(path.join("out", "result.txt"), "written-ok");
			assert.throws(() => fs.writeFileSync(path.join("src", "nope.txt"), "nope"), (e) => e.code === "EACCES");

			// 4. Scoped Net.Allow denies fetch to 127.0.0.1
			await assert.rejects(() => fetch("http://127.0.0.1:1/"), (e) => String(e.message || e).includes("EACCES") || String(e.cause || "").includes("EACCES"));

			console.log("SCOPED_OK");
		`,
	}), nil)
	if err != nil {
		t.Fatalf("scoped exec_script failed: %v", err)
	}
	if got := strings.TrimSpace(toolResultText(t, res)); got != "SCOPED_OK" {
		t.Fatalf("unexpected output: %q", got)
	}
}

func TestExecScriptDescriptionAndSchemaContract(t *testing.T) {
	tool := &ExecScriptTool{}
	desc := tool.Description()
	schemaStr := string(tool.Schema())

	for _, forbidden := range []string{"quickjs", "fallback", "jailed", "node:fs", "node:crypto", "node:zlib", "node:sqlite"} {
		if strings.Contains(strings.ToLower(desc), forbidden) {
			t.Fatalf("Description() must not contain %q; got: %s", forbidden, desc)
		}
		if strings.Contains(strings.ToLower(schemaStr), forbidden) {
			t.Fatalf("Schema() must not contain %q; got: %s", forbidden, schemaStr)
		}
	}

	for _, required := range []string{
		"Node.js",
		"import",
		"require",
		"await",
		"$",
		".text()",
		".json()",
		".lines()",
		".nothrow()",
		".cwd(dir)",
		".env(vars)",
		".stdin(input)",
		`$.sync("cmd")`,
		"last 2000 lines or 50KB (whichever is hit first)",
		"non-zero exit",
		"There is no timeout: if the script still runs after 10.0s it automatically moves to the background (you are notified with a job id; read the output with bg_check, wait with bg_await, stop it with bg_cancel).",
	} {
		if !strings.Contains(desc, required) {
			t.Fatalf("Description() missing %q; got:\n%s", required, desc)
		}
	}

	var parsed map[string]any
	if err := json.Unmarshal(tool.Schema(), &parsed); err != nil {
		t.Fatalf("Schema() is not valid JSON: %v", err)
	}
	if !strings.Contains(schemaStr, "Node.js") || !strings.Contains(schemaStr, "$") {
		t.Fatalf("Schema() should mention Node.js and $, got: %s", schemaStr)
	}
}

func TestExecScriptNoShellFailsDollarButAllowsDirectChildProcess(t *testing.T) {
	SetShellOverride("", "", false)
	defer ClearShellOverride()

	root := t.TempDir()
	tool := &ExecScriptTool{CWD: root, LogDir: t.TempDir()}

	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"code": `
			import assert from "node:assert/strict";
			import cp from "node:child_process";

			// $ and shell:true must fail cleanly with ENOENT and zero fallback when no shell is configured.
			await assert.rejects(
				async () => { await $` + "`echo should-not-run`" + `; },
				(e) => e && e.code === "ENOENT"
			);
			assert.throws(
				() => { $.sync("echo should-not-run"); },
				(e) => e && e.code === "ENOENT"
			);
			assert.throws(
				() => { cp.execSync("echo should-not-run"); },
				(e) => e && e.code === "ENOENT"
			);

			// Direct OS process spawning (shell: false) continues to work without a shell.
			const out = cp.execFileSync(process.execPath, ["--js-exec-direct", "console.log('DIRECT_CHILD_OK')"], { encoding: "utf8" });
			assert.equal(out.trim(), "DIRECT_CHILD_OK");
			console.log("NO_SHELL_CONTRACT_OK");
		`,
	}), nil)
	if err != nil {
		t.Fatalf("exec_script failed: %v", err)
	}
	if got := strings.TrimSpace(toolResultText(t, res)); got != "NO_SHELL_CONTRACT_OK" {
		t.Fatalf("unexpected output: %q", got)
	}
}
