package qjs

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "--js" {
		args := os.Args[2:]
		var code, filename string
		var scriptArgs []string
		var omitArgv1 bool
		if len(args) >= 2 && (args[0] == "-e" || args[0] == "--eval" || args[0] == "-p" || args[0] == "--print") {
			code = args[1]
			if args[0] == "-p" || args[0] == "--print" {
				code = "console.log(await (\n" + code + "\n));"
			}
			filename = "[eval]"
			scriptArgs = args[2:]
			omitArgv1 = true
		} else if len(args) >= 1 {
			filename = args[0]
			raw, err := os.ReadFile(filename)
			if err != nil {
				os.Exit(1)
			}
			code = string(raw)
			scriptArgs = args[1:]
		}
		exe, _ := os.Executable()
		exitCode, err := RunScript(context.Background(), ScriptOptions{
			Code:      code,
			Filename:  filename,
			Args:      scriptArgs,
			OmitArgv1: omitArgv1,
			ExecPath:  exe,
			Stdin:     os.Stdin,
			Stdout:    os.Stdout,
			Stderr:    os.Stderr,
		})
		if err != nil && exitCode == 0 {
			exitCode = 1
		}
		os.Exit(exitCode)
	}
	os.Exit(m.Run())
}

func runJS(t *testing.T, code string, modify ...func(*ScriptOptions)) (int, string, string, error) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	opts := ScriptOptions{
		Code:   code,
		CWD:    t.TempDir(),
		Stdout: &stdout,
		Stderr: &stderr,
	}
	for _, fn := range modify {
		fn(&opts)
	}
	exitCode, err := RunScript(context.Background(), opts)
	return exitCode, stdout.String(), stderr.String(), err
}

func TestRunScript_BasicAndESMAndCJS(t *testing.T) {
	// 1. Sloppy one-liner + top-level await
	code, out, errOut, err := runJS(t, `
		x = await Promise.resolve(21 * 2);
		console.log("answer =", x);
	`)
	if err != nil || code != 0 {
		t.Fatalf("unexpected error (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if strings.TrimSpace(out) != "answer = 42" {
		t.Fatalf("got %q, want 'answer = 42'", out)
	}

	// 2. ES Module imports (both node: prefix and bare) + local ESM + local CJS + JSON
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "math_esm.js"), []byte(`export const add = (a, b) => a + b;`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "legacy_cjs.cjs"), []byte(`module.exports = { mul: (a, b) => a * b };`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{"label":"sum"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	code, out, errOut, err = runJS(t, `
		import fs from "node:fs";
		import path from "path";
		import { createRequire } from "node:module";
		import { add } from "./math_esm.js";
		import cjs, { mul } from "./legacy_cjs.cjs";
		import cfg from "./config.json";

		const require = createRequire(import.meta.url);
		const reqCjs = require("./legacy_cjs.cjs");
		console.log(cfg.label, add(3, 4), mul(5, 6), reqCjs.mul(2, 3), typeof fs.readFileSync, typeof path.join);
	`, func(o *ScriptOptions) {
		o.CWD = dir
		o.Filename = filepath.Join(dir, "main.js")
	})
	if err != nil || code != 0 {
		t.Fatalf("ESM/CJS test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if strings.TrimSpace(out) != "sum 7 30 6 function function" {
		t.Fatalf("unexpected output: %q", out)
	}
}

func TestRunScript_FSAndBufferAndCryptoAndZlib(t *testing.T) {
	code, out, errOut, err := runJS(t, `
		import fs from "node:fs";
		import fsp from "node:fs/promises";
		import crypto from "node:crypto";
		import zlib from "node:zlib";
		import assert from "node:assert/strict";

		fs.mkdirSync("sub/nested", { recursive: true });
		fs.writeFileSync("sub/nested/hello.txt", "olá mundo 🚀");
		const txt = await fsp.readFile("sub/nested/hello.txt", "utf8");
		assert.equal(txt, "olá mundo 🚀");

		const files = fs.globSync("**/*.txt");
		assert.equal(files.length, 1);

		const b = Buffer.from("indirect-code", "utf8");
		assert.equal(Buffer.from(b.toString("base64"), "base64").toString("utf8"), "indirect-code");
		assert.equal(Buffer.from(b.toString("hex"), "hex").toString("utf8"), "indirect-code");

		const sha = crypto.createHash("sha256").update("abc").digest("hex");
		assert.equal(sha, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

		const gz = zlib.gzipSync(Buffer.from("compress-me-please"));
		const un = zlib.gunzipSync(gz).toString("utf8");
		assert.equal(un, "compress-me-please");

		const uuid = crypto.randomUUID();
		assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

		console.log("ALL_OK");
	`)
	if err != nil || code != 0 {
		t.Fatalf("FS/Buffer/Crypto/Zlib failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if strings.TrimSpace(out) != "ALL_OK" {
		t.Fatalf("unexpected output: %q", out)
	}
}

func TestRunScript_FetchAndHTTPServerAndTimers(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"hello":"from-go-test"}`))
	}))
	defer srv.Close()

	code, out, errOut, err := runJS(t, `
		import http from "node:http";

		const r1 = await fetch(process.env.TEST_URL);
		const j1 = await r1.json();

		// Also spin up an in-script http.createServer and fetch from it!
		const server = http.createServer((req, res) => {
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("pong:" + req.url);
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = server.address().port;
		const r2 = await fetch("http://127.0.0.1:" + port + "/check");
		const t2 = await r2.text();
		server.close();

		await new Promise((r) => setTimeout(r, 15));
		console.log(j1.hello, t2);
	`, func(o *ScriptOptions) {
		o.Env = map[string]string{"TEST_URL": srv.URL}
	})
	if err != nil || code != 0 {
		t.Fatalf("Fetch/HTTP/Timers failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if strings.TrimSpace(out) != "from-go-test pong:/check" {
		t.Fatalf("unexpected output: %q", out)
	}
}

func TestRunScript_ProcessExitAndStdinAndEnv(t *testing.T) {
	code, out, errOut, err := runJS(t, `
		const input = process.stdin.read().toString("utf8").trim();
		console.log("stdin:", input, "arg:", process.argv[2]);
		process.exit(7);
		console.log("never-reached");
	`, func(o *ScriptOptions) {
		o.Stdin = strings.NewReader("hello-stdin\n")
		o.Args = []string{"--flag1"}
	})
	if err != nil {
		t.Fatalf("process.exit should not return a runtime error: %v (stderr=%s)", err, errOut)
	}
	if code != 7 {
		t.Fatalf("got exit code %d, want 7", code)
	}
	if strings.TrimSpace(out) != "stdin: hello-stdin arg: --flag1" {
		t.Fatalf("unexpected stdout: %q", out)
	}
}

func TestRunScript_CancellationInterruptsInfiniteLoop(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()

	code, err := RunScript(ctx, ScriptOptions{
		Code: `while (true) {}`,
		CWD:  t.TempDir(),
	})
	if err == nil {
		t.Fatalf("expected cancellation error, got code=%d nil err", code)
	}
}

func TestRunScript_StreamDrainOrderAndHTTPBody(t *testing.T) {
	code, out, errOut, err := runJS(t, `
		import fs from "node:fs";
		import http from "node:http";
		import { pipeline } from "node:stream/promises";
		import { Writable } from "node:stream";
		import assert from "node:assert/strict";

		fs.writeFileSync("sample.txt", "0123456789abcdef");

		// 1. fs.createReadStream data must arrive before 'end', including {start, end} inclusive slice
		const events = [];
		await new Promise((resolve, reject) => {
			const rs = fs.createReadStream("sample.txt", { start: 2, end: 5, encoding: "utf8" });
			rs.on("data", (chunk) => events.push("data:" + chunk));
			rs.on("end", () => { events.push("end"); resolve(); });
			rs.on("error", reject);
		});
		assert.deepEqual(events, ["data:2345", "end"]);

		// 2. stream/promises pipeline must collect all chunks before resolving
		let piped = "";
		await pipeline(
			fs.createReadStream("sample.txt", { encoding: "utf8" }),
			new Writable({
				write(chunk, _enc, cb) {
					piped += chunk.toString();
					cb();
				}
			})
		);
		assert.equal(piped, "0123456789abcdef");

		// 3. http.createServer IncomingMessage must deliver body chunks before 'end'
		const srv = http.createServer((req, res) => {
			let body = "";
			req.on("data", (c) => { body += c; });
			req.on("end", () => { res.end("len=" + body.length + ":" + body); });
		});
		await new Promise((r) => srv.listen(0, "127.0.0.1", r));
		const port = srv.address().port;
		const resp = await fetch("http://127.0.0.1:" + port, { method: "POST", body: "hello-post" });
		const text = await resp.text();
		srv.close();
		assert.equal(text, "len=10:hello-post");

		console.log("STREAM_OK");
	`)
	if err != nil || code != 0 {
		t.Fatalf("stream drain test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if strings.TrimSpace(out) != "STREAM_OK" {
		t.Fatalf("unexpected output: %q", out)
	}
}

func TestRunScript_InternalGlobalsHiddenAndCJSIsolation(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "mod.cjs"), []byte(`module.exports = { ok: 99, val: "cjs" };`), 0o644); err != nil {
		t.Fatal(err)
	}
	code, out, errOut, err := runJS(t, `
		import assert from "node:assert/strict";

		// No internal __qjs_* symbols may leak onto globalThis
		const leaked = Object.getOwnPropertyNames(globalThis).filter((k) => k.startsWith("__qjs_"));
		assert.deepEqual(leaked, []);

		// Deleting or overwriting globalThis.require must not break ESM import of CJS modules
		delete globalThis.require;
		const m = await import("./mod.cjs");
		assert.equal(m.default.ok, 99);
		assert.equal(m.val, "cjs");
		console.log("ISOLATION_OK");
	`, func(o *ScriptOptions) {
		o.CWD = dir
		o.Filename = filepath.Join(dir, "entry.js")
	})
	if err != nil || code != 0 {
		t.Fatalf("isolation test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if strings.TrimSpace(out) != "ISOLATION_OK" {
		t.Fatalf("unexpected output: %q", out)
	}
}

func TestRunScript_UnhandledPromiseRejectionAndExitCode(t *testing.T) {
	// 1. Unhandled rejection must fail with exit code 1
	code, _, _, err := runJS(t, `
		Promise.reject(new Error("unhandled-boom"));
	`)
	if err == nil || code != 1 {
		t.Fatalf("expected unhandled rejection to fail with code 1, got code=%d err=%v", code, err)
	}

	// 2. Handled via process.on('unhandledRejection') must succeed
	code, out, errOut, err := runJS(t, `
		process.on("unhandledRejection", (reason) => {
			console.log("caught:", reason.message);
		});
		Promise.reject(new Error("caught-boom"));
	`)
	if err != nil || code != 0 {
		t.Fatalf("handled rejection failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if strings.TrimSpace(out) != "caught: caught-boom" {
		t.Fatalf("unexpected output: %q", out)
	}
}

func TestRunScript_StdFdsAndProcessStdinChunks(t *testing.T) {
	code, out, errOut, err := runJS(t, `
		import fs from "node:fs";
		import assert from "node:assert/strict";

		// Partial stdin reads via process.stdin.read(size)
		const c1 = process.stdin.read(3).toString("utf8");
		// Partial stdin read via fs.readSync(0, ...)
		const buf = Buffer.alloc(4);
		const n = fs.readSync(0, buf, 0, 4, null);
		const c2 = buf.subarray(0, n).toString("utf8");
		const rest = fs.readFileSync(0, "utf8");
		assert.equal(c1, "abc");
		assert.equal(c2, "defg");
		assert.equal(rest, "hijk");

		// Stdout/stderr via fd 1 & 2
		fs.writeSync(1, "out1:");
		fs.writeFileSync(1, "out2\n");
		fs.writeSync(2, "err1:");
		fs.appendFileSync(2, "err2\n");
		const st = fs.fstatSync(1);
		assert.equal(typeof st.mode, "number");
		fs.fsyncSync(1);
		fs.closeSync(1);
	`, func(o *ScriptOptions) {
		o.Stdin = strings.NewReader("abcdefghijk")
	})
	if err != nil || code != 0 {
		t.Fatalf("std fds test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if strings.TrimSpace(out) != "out1:out2" {
		t.Fatalf("unexpected stdout: %q", out)
	}
	if strings.TrimSpace(errOut) != "err1:err2" {
		t.Fatalf("unexpected stderr: %q", errOut)
	}
}

func TestRunScript_CryptoScryptRFC7914AndCiphersAndSubtle(t *testing.T) {
	code, out, errOut, err := runJS(t, `
		import crypto from "node:crypto";
		import assert from "node:assert/strict";

		// RFC 7914 test vector: P="password", S="NaCl", N=1024, r=8, p=16, dkLen=64
		const dk = crypto.scryptSync("password", "NaCl", 64, { N: 1024, r: 8, p: 16 });
		assert.equal(
			dk.toString("hex"),
			"fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640"
		);

		// Async pbkdf2 5-arg (default sha1) and 6-arg
		const pb5 = await new Promise((res, rej) =>
			crypto.pbkdf2("pass", "salt", 1000, 16, (err, k) => err ? rej(err) : res(k))
		);
		assert.equal(pb5.length, 16);

		// AES-256-GCM round-trip
		const key = crypto.randomBytes(32);
		const iv = crypto.randomBytes(12);
		const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
		cipher.setAAD(Buffer.from("header"));
		const enc = Buffer.concat([cipher.update("secret message", "utf8"), cipher.final()]);
		const tag = cipher.getAuthTag();

		const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
		decipher.setAAD(Buffer.from("header"));
		decipher.setAuthTag(tag);
		const dec = Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
		assert.equal(dec, "secret message");

		// WebCrypto subtle digest + HMAC sign/verify
		const subtleHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("abc"));
		assert.equal(Buffer.from(subtleHash).toString("hex"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

		const hmacKey = await crypto.subtle.importKey("raw", new TextEncoder().encode("secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
		const sig = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode("payload"));
		const valid = await crypto.subtle.verify("HMAC", hmacKey, sig, new TextEncoder().encode("payload"));
		assert.equal(valid, true);

		console.log("CRYPTO_OK");
	`)
	if err != nil || code != 0 {
		t.Fatalf("crypto test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if strings.TrimSpace(out) != "CRYPTO_OK" {
		t.Fatalf("unexpected output: %q", out)
	}
}

func TestRunScript_NetServerAndSocketEcho(t *testing.T) {
	code, out, errOut, err := runJS(t, `
		import net from "node:net";
		import assert from "node:assert/strict";

		const server = net.createServer((sock) => {
			sock.on("data", (chunk) => {
				sock.write("echo:" + chunk.toString("utf8"));
				sock.end();
			});
		});
		await new Promise((r) => server.listen(0, "127.0.0.1", r));
		const port = server.address().port;

		const reply = await new Promise((resolve, reject) => {
			const client = net.connect(port, "127.0.0.1", () => {
				client.write("ping-tcp");
			});
			let buf = "";
			client.on("data", (c) => { buf += c.toString("utf8"); });
			client.on("end", () => resolve(buf));
			client.on("error", reject);
		});
		server.close();
		assert.equal(reply, "echo:ping-tcp");
		console.log("NET_OK");
	`)
	if err != nil || code != 0 {
		t.Fatalf("net test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if strings.TrimSpace(out) != "NET_OK" {
		t.Fatalf("unexpected output: %q", out)
	}
}

func TestRunScript_ProcessKillZeroAndJailConfinement(t *testing.T) {
	parentDir := t.TempDir()
	jailDir := filepath.Join(parentDir, "workspace")
	if err := os.MkdirAll(jailDir, 0o755); err != nil {
		t.Fatal(err)
	}
	outsideFile := filepath.Join(parentDir, "secret.txt")
	if err := os.WriteFile(outsideFile, []byte("top-secret"), 0o644); err != nil {
		t.Fatal(err)
	}

	code, out, errOut, err := runJS(t, `
		import fs from "node:fs";
		import assert from "node:assert/strict";

		// process.kill(process.pid, 0) must check liveness without killing this process
		assert.equal(process.kill(process.pid, 0), true);

		// Reading inside jail succeeds
		fs.writeFileSync("inside.txt", "allowed");
		assert.equal(fs.readFileSync("inside.txt", "utf8"), "allowed");

		// Escaping jail via ../secret.txt or process.chdir("..") must throw EACCES
		assert.throws(() => fs.readFileSync("../secret.txt", "utf8"), /EACCES/);
		assert.throws(() => process.chdir(".."), /EACCES/);

		console.log("JAIL_AND_KILL0_OK");
	`, func(o *ScriptOptions) {
		o.CWD = jailDir
		o.JailRoots = []string{jailDir}
	})
	if err != nil || code != 0 {
		t.Fatalf("jail/kill0 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if strings.TrimSpace(out) != "JAIL_AND_KILL0_OK" {
		t.Fatalf("unexpected output: %q", out)
	}
}

func TestRunScript_NextTickBeforePromiseMicrotasks(t *testing.T) {
	code, out, errOut, err := runJS(t, `
		const order = [];
		Promise.resolve().then(() => order.push("promise1"));
		process.nextTick(() => {
			order.push("nextTick1");
			process.nextTick(() => order.push("nextTick2"));
		});
		setTimeout(() => {
			console.log(order.join(","));
		}, 5);
	`)
	if err != nil || code != 0 {
		t.Fatalf("nextTick order failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if strings.TrimSpace(out) != "nextTick1,nextTick2,promise1" {
		t.Fatalf("expected nextTick before promise microtasks, got %q", out)
	}
}

func TestRunScript_ProcessExitReentrancyAndSelfKillAndUncaughtException(t *testing.T) {
	// 1. Calling process.exit() inside process.on('exit') must not recurse infinitely
	code, out, errOut, err := runJS(t, `
		process.on("exit", (c) => {
			console.log("on_exit:" + c);
			process.exit(99);
		});
		process.exit(7);
	`)
	if err != nil || code != 99 {
		t.Fatalf("expected exit code 99 without recursion error, got code=%d err=%v stderr=%s", code, err, errOut)
	}
	if strings.TrimSpace(out) != "on_exit:7" {
		t.Fatalf("unexpected on_exit output: %q", out)
	}

	// 2. process.on('uncaughtException') intercepts thrown errors
	code2, out2, errOut2, err2 := runJS(t, `
		process.on("uncaughtException", (e) => {
			console.log("caught_uncaught:" + e.message);
		});
		setTimeout(() => {
			throw new Error("boom_async");
		}, 5);
	`)
	if err2 != nil || code2 != 0 {
		t.Fatalf("uncaughtException test failed (code=%d, stderr=%s): %v", code2, errOut2, err2)
	}
	if strings.TrimSpace(out2) != "caught_uncaught:boom_async" {
		t.Fatalf("unexpected uncaughtException output: %q", out2)
	}

	// 3. process.kill(process.pid, 'SIGTERM') terminates the JS runtime without killing the Go host
	code3, _, _, err3 := runJS(t, `
		process.kill(process.pid, "SIGTERM");
	`)
	if err3 != nil || code3 != 143 {
		t.Fatalf("expected self-kill SIGTERM exit code 143, got code=%d err=%v", code3, err3)
	}
}

func TestRunScript_CryptoHKDFAndAutoPadding(t *testing.T) {
	code, out, errOut, err := runJS(t, `
		import crypto from "node:crypto";
		import assert from "node:assert/strict";

		// HKDF with empty string, undefined, and null salt/info
		const k1 = crypto.hkdfSync("sha256", "secret-ikm", "", "", 32);
		const k2 = crypto.hkdfSync("sha256", "secret-ikm", undefined, null, 32);
		assert.equal(Buffer.from(k1).toString("hex"), Buffer.from(k2).toString("hex"));
		assert.equal(k1.byteLength, 32);

		const kAsync = await new Promise((res, rej) =>
			crypto.hkdf("sha256", "secret-ikm", "", "", 32, (err, derived) => err ? rej(err) : res(derived))
		);
		assert.equal(Buffer.from(kAsync).toString("hex"), Buffer.from(k1).toString("hex"));

		// AES-128-CBC with setAutoPadding(false) on exact 16-byte block
		const key = Buffer.alloc(16, 0x42);
		const iv = Buffer.alloc(16, 0x24);
		const plain = Buffer.from("0123456789abcdef", "utf8");
		const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
		cipher.setAutoPadding(false);
		const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
		assert.equal(enc.length, 16); // No 16-byte PKCS#7 padding block appended

		const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
		decipher.setAutoPadding(false);
		const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
		assert.equal(dec.toString("utf8"), "0123456789abcdef");

		console.log("HKDF_AUTOPAD_OK");
	`)
	if err != nil || code != 0 {
		t.Fatalf("hkdf/autopad test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if strings.TrimSpace(out) != "HKDF_AUTOPAD_OK" {
		t.Fatalf("unexpected output: %q", out)
	}
}

func TestRunScript_PackageExportsSubpathAndCJSMultiline(t *testing.T) {
	dir := t.TempDir()
	pkgDir := filepath.Join(dir, "node_modules", "my-pkg")
	if err := os.MkdirAll(filepath.Join(pkgDir, "lib"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pkgDir, "package.json"), []byte(`{
		"name": "my-pkg",
		"exports": {
			".": "./index.js",
			"./feature": ["./missing.js", "./lib/feature.js"],
			"./*": "./lib/*.js"
		}
	}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pkgDir, "index.js"), []byte(`export const root = "root-ok";`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pkgDir, "lib", "feature.js"), []byte(`export const feat = "feat-ok";`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pkgDir, "lib", "wild.js"), []byte(`export const wild = "wild-ok";`), 0o644); err != nil {
		t.Fatal(err)
	}

	subDir := filepath.Join(dir, "sub")
	if err := os.MkdirAll(subDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(subDir, "helper.cjs"), []byte(`module.exports = { val: 40 };`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(subDir, "multi.cjs"), []byte(`
		const _m = 2;
		const h = require("./helper.cjs");
		const sum = h.val + _m;
		module.exports = {
			sum,
			label: "multiline-ok"
		};
	`), 0o644); err != nil {
		t.Fatal(err)
	}

	code, out, errOut, err := runJS(t, `
		import { root } from "my-pkg";
		import { feat } from "my-pkg/feature";
		import { wild } from "my-pkg/wild";
		import { sum, label } from "./sub/multi.cjs";
		import assert from "node:assert/strict";

		assert.equal(root, "root-ok");
		assert.equal(feat, "feat-ok");
		assert.equal(wild, "wild-ok");
		assert.equal(sum, 42);
		assert.equal(label, "multiline-ok");
		console.log("EXPORTS_CJS_OK");
	`, func(o *ScriptOptions) {
		o.CWD = dir
		o.Filename = filepath.Join(dir, "main.mjs")
	})
	if err != nil || code != 0 {
		t.Fatalf("exports/cjs test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if strings.TrimSpace(out) != "EXPORTS_CJS_OK" {
		t.Fatalf("unexpected output: %q", out)
	}
}

func TestRunScript_PathURLDataViewVMAndFSFixes(t *testing.T) {
	dir := t.TempDir()
	code, out, errOut, err := runJS(t, `
		import path from "node:path";
		import url from "node:url";
		import fs from "node:fs";
		import vm from "node:vm";
		import assert from "node:assert/strict";

		// 1. import.meta works even when tested alongside other features
		assert.ok(import.meta.url.startsWith("file://"));

		// 2. posix.dirname edge cases
		assert.equal(path.posix.dirname(""), ".");
		assert.equal(path.posix.dirname("///"), "/");

		// 3. IPv6 URL parsing
		const ipv6Url = new URL("http://[::1]:8080/hello?x=1");
		assert.equal(ipv6Url.hostname, "[::1]");
		assert.equal(ipv6Url.port, "8080");
		assert.equal(ipv6Url.host, "[::1]:8080");

		// 4. pathToFileURL / fileURLToPath with # and ?
		const specialPath = path.join(process.cwd(), "file#1?2.txt");
		const fileUrl = url.pathToFileURL(specialPath);
		assert.ok(fileUrl.pathname.includes("%23"));
		assert.ok(fileUrl.pathname.includes("%3F"));
		assert.equal(url.fileURLToPath(fileUrl), specialPath);

		// 5. DataView slice in fs.writeFileSync
		const ab = new Uint8Array([10, 65, 66, 67, 20]).buffer;
		const dv = new DataView(ab, 1, 3);
		fs.writeFileSync("dv.txt", dv);
		assert.equal(fs.readFileSync("dv.txt", "utf8"), "ABC");

		// 6. Dirent.parentPath and absolute fs.globSync
		const entries = fs.readdirSync(process.cwd(), { withFileTypes: true });
		const dvEntry = entries.find((e) => e.name === "dv.txt");
		assert.ok(dvEntry);
		assert.equal(dvEntry.parentPath, process.cwd());

		const absMatches = fs.globSync(path.join(process.cwd(), "*.txt"));
		assert.ok(absMatches.some((m) => m.endsWith("dv.txt")));

		// 7. vm.runInNewContext isolation
		const res = vm.runInNewContext("globalThis.leakedVar = 999; a * b", { a: 6, b: 7 });
		assert.equal(res, 42);
		assert.equal(globalThis.leakedVar, undefined);

		console.log("FIXES_OK");
	`, func(o *ScriptOptions) {
		o.CWD = dir
		o.Filename = filepath.Join(dir, "index.js")
	})
	if err != nil || code != 0 {
		t.Fatalf("fixes test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if strings.TrimSpace(out) != "FIXES_OK" {
		t.Fatalf("unexpected output: %q", out)
	}
}

func TestRunScript_Round3AdversarialFixes(t *testing.T) {
	dir := t.TempDir()
	// Create a self-referential package.json ("main": ".") in node_modules to verify resolver does not recurse infinitely.
	badPkgDir := filepath.Join(dir, "node_modules", "self-ref-pkg")
	if err := os.MkdirAll(badPkgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(badPkgDir, "package.json"), []byte(`{"name":"self-ref-pkg","main":".","exports":"."}`), 0o644); err != nil {
		t.Fatal(err)
	}

	code, out, errOut, err := runJS(t, `
		import fs from "node:fs";
		import path from "node:path";
		import crypto from "node:crypto";
		import zlib from "node:zlib";
		import assert from "node:assert";
		import net from "node:net";
		import http from "node:http";
		import vm from "node:vm";
		import bufferMod from "node:buffer";
		import { spawnSync, exec } from "node:child_process";

		// 1. fs.cpSync(src, src) and fs.cpSync(dir, dir/sub) must throw ERR_FS_CP_EINVAL and preserve data
		fs.writeFileSync("self.txt", "keep-me");
		assert.throws(() => fs.cpSync("self.txt", "self.txt"), { code: "ERR_FS_CP_EINVAL" });
		assert.strictEqual(fs.readFileSync("self.txt", "utf8"), "keep-me");

		fs.mkdirSync("cpdir");
		fs.writeFileSync("cpdir/a.txt", "inside");
		assert.throws(() => fs.cpSync("cpdir", "cpdir/sub", { recursive: true }), { code: "ERR_FS_CP_EINVAL" });

		// 2. fs.rmSync("", {recursive:true, force:true}) must NOT wipe cwd, and rmSync("missing") must throw ENOENT
		assert.doesNotThrow(() => fs.rmSync("", { recursive: true, force: true }));
		assert.strictEqual(fs.readFileSync("self.txt", "utf8"), "keep-me");
		assert.throws(() => fs.rmSync("nonexistent_rm_target"), { code: "ENOENT" });
		assert.throws(() => fs.rmSync("cpdir"), { code: "ERR_FS_EISDIR" });

		// 3. String mode in mkdirSync / writeFileSync and numeric flags in openSync
		fs.mkdirSync("modedir", { mode: "0755" });
		assert.ok(fs.statSync("modedir").isDirectory());
		fs.writeFileSync("modefile.txt", "hello", { mode: "0644" });
		assert.strictEqual(fs.readFileSync("modefile.txt", "utf8"), "hello");

		const fd = fs.openSync("numflags.txt", fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o644);
		fs.writeSync(fd, Buffer.from("flag-ok"));
		fs.closeSync(fd);
		assert.strictEqual(fs.readFileSync("numflags.txt", "utf8"), "flag-ok");

		// 4. fs.statSync non-zero ino/blocks and FileHandle.readFile from current position
		const st = fs.statSync("numflags.txt");
		assert.ok(st.ino > 0);
		assert.ok(st.blksize > 0);
		const fh = await fs.promises.open("numflags.txt", "r");
		const partialBuf = Buffer.alloc(5);
		await fh.read(partialBuf, 0, 5, null);
		assert.strictEqual(partialBuf.toString("utf8"), "flag-");
		const rest = await fh.readFile("utf8");
		assert.strictEqual(rest, "ok");
		await fh.close();

		// 5. fs.globSync withFileTypes and eager createWriteStream / createReadStream error
		const globDirents = fs.globSync("*.txt", { withFileTypes: true });
		assert.ok(globDirents.length > 0 && typeof globDirents[0].isFile === "function" && globDirents[0].isFile());

		const ws = fs.createWriteStream("eager_ws.txt");
		ws.end();
		await new Promise((r) => ws.on("close", r));
		assert.ok(fs.existsSync("eager_ws.txt"));

		const rsErr = await new Promise((resolve) => {
			const rs = fs.createReadStream("does_not_exist_stream.txt");
			rs.on("error", (e) => resolve(e.code));
		});
		assert.strictEqual(rsErr, "ENOENT");

		// 6. crypto.scrypt memory limit guard
		assert.throws(() => {
			crypto.scryptSync("pass", "salt", 32, { N: 2 ** 20, r: 8, p: 1, maxmem: 2 ** 30 });
		}, { code: "ERR_CRYPTO_INVALID_SCRYPT_PARAMS" });

		// 7. Cipheriv / Decipheriv streaming update() and GCM authTagLength
		const key = crypto.randomBytes(32);
		const iv = crypto.randomBytes(12);
		const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: 12 });
		const encPart1 = cipher.update("hello ", "utf8");
		const encPart2 = cipher.update("world", "utf8");
		const encFinal = cipher.final();
		assert.ok(encPart1.length > 0 && encPart2.length > 0);
		const tag = cipher.getAuthTag();
		assert.strictEqual(tag.length, 12);

		const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 12 });
		const decPart1 = decipher.update(encPart1, undefined, "utf8");
		const decPart2 = decipher.update(encPart2, undefined, "utf8");
		decipher.setAuthTag(tag);
		const decFinal = decipher.final("utf8");
		assert.strictEqual(decPart1 + decPart2 + decFinal, "hello world");

		// 8. Stream / zlib error emission on corrupt gzip
		const gunzipErr = await new Promise((resolve) => {
			const gz = zlib.createGunzip();
			gz.on("error", (e) => resolve(e));
			gz.end(Buffer.from("not-valid-gzip-bytes"));
		});
		assert.ok(gunzipErr instanceof Error);

		// 9. Buffer malformed UTF-8 replacement, isUtf8, and transcode
		assert.strictEqual(Buffer.from([0xc0, 0xaf]).toString("utf8"), "\ufffd\ufffd");
		assert.strictEqual(bufferMod.isUtf8(Buffer.from([0xff])), false);
		assert.strictEqual(bufferMod.isUtf8(Buffer.from("valid utf8")), true);
		const latin1Out = bufferMod.transcode(Buffer.from("é", "utf8"), "utf8", "latin1");
		assert.strictEqual(latin1Out.length, 1);
		assert.strictEqual(latin1Out[0], 0xe9);

		// 10. assert loose vs strict equality
		assert.throws(() => assert.equal(NaN, 5));
		assert.doesNotThrow(() => assert.equal(NaN, NaN));
		assert.doesNotThrow(() => assert.equal("1", 1));
		assert.doesNotThrow(() => assert.deepEqual({ a: "1" }, { a: 1 }));
		assert.throws(() => assert.deepStrictEqual({ a: "1" }, { a: 1 }));

		// 11. path.extname(".."), URL, and URLSearchParams(new Map(...))
		assert.strictEqual(path.extname(".."), "");
		assert.strictEqual(path.extname("."), "");
		assert.strictEqual(new URL("", "http://example.com/dir/page").href, "http://example.com/dir/page");
		assert.strictEqual(new URL("http://example.com:80/a b").href, "http://example.com/a%20b");
		const usp = new URLSearchParams(new Map([["k", "v"]]));
		assert.strictEqual(usp.get("k"), "v");

		// 12. net.isIP strict IPv6 validation & NetSocket half-close + ID non-collision
		assert.strictEqual(net.isIP("hello:world"), 0);
		assert.strictEqual(net.isIP("::1"), 6);
		assert.strictEqual(net.isIP("127.0.0.1"), 4);

		const echoOut = await new Promise((resolve, reject) => {
			const srv = net.createServer((sock) => {
				const chunks = [];
				sock.on("data", (c) => chunks.push(c));
				sock.on("end", () => {
					sock.end(Buffer.concat(chunks));
				});
			});
			srv.listen(0, "127.0.0.1", () => {
				const client = net.connect(srv.address().port, "127.0.0.1", () => {
					client.end("ping-half-close");
				});
				const rx = [];
				client.on("data", (c) => rx.push(c));
				client.on("end", () => {
					srv.close(() => resolve(Buffer.concat(rx).toString("utf8")));
				});
				client.on("error", reject);
			});
		});
		assert.strictEqual(echoOut, "ping-half-close");

		// 13. HTTP Host header, multiple Set-Cookie headers, and fetch invalid signal rejection
		await assert.rejects(() => fetch("http://127.0.0.1:1", { signal: {} }), { name: "TypeError" });

		const httpCheck = await new Promise((resolve, reject) => {
			const srv = http.createServer((req, res) => {
				res.setHeader("Set-Cookie", ["a=1", "b=2"]);
				res.end(JSON.stringify({ host: req.headers.host }));
			});
			srv.listen(0, "127.0.0.1", async () => {
				try {
					const port = srv.address().port;
					const resp = await fetch("http://127.0.0.1:" + port + "/test");
					const cookies = resp.headers.getSetCookie();
					const body = await resp.json();
					srv.close(() => resolve({ cookies, host: body.host, redirected: resp.redirected }));
				} catch (e) {
					srv.close(() => reject(e));
				}
			});
		});
		assert.deepStrictEqual(httpCheck.cookies, ["a=1", "b=2"]);
		assert.ok(httpCheck.host && httpCheck.host.startsWith("127.0.0.1:"));
		assert.strictEqual(httpCheck.redirected, false);

		// 14. Self-referential package.json does not hang or overflow
		const { createRequire: createReq14 } = await import("node:module");
		const req14 = createReq14(import.meta.url);
		assert.throws(() => {
			req14("self-ref-pkg");
		});

		// 15. $ raw injection protection: plain {raw: ...} is quoted, $.raw(...) is unquoted
		const untrusted = JSON.parse('{"raw":"; echo INJECTED"}');
		assert.ok($.quote(untrusted).startsWith("'"));
		assert.strictEqual($.quote($.raw("echo ok")), "echo ok");

		// 16. vm dynamic import isolation
		await assert.rejects(async () => {
			await vm.runInNewContext('import("node:fs")', {});
		});

		// 17. spawnSync ENOENT error.code and stdio: "ignore"
		const miss = spawnSync("nonexistent_binary_xyz_999");
		assert.ok(miss.error && miss.error.code === "ENOENT");

		console.log("ROUND3_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = dir
		o.Filename = "<exec_script>"
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 3 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if strings.TrimSpace(out) != "ROUND3_ALL_OK" {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round4AdversarialFixes(t *testing.T) {
	dir := t.TempDir()
	outsideDir := t.TempDir()
	outsideFile := filepath.Join(outsideDir, "secret.txt")
	if err := os.WriteFile(outsideFile, []byte("SECRET_DATA"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Setup package with strict exports + conditional require/import + unexported file on disk
	pkgDir := filepath.Join(dir, "node_modules", "strict-pkg")
	if err := os.MkdirAll(pkgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pkgDir, "package.json"), []byte(`{
		"name": "strict-pkg",
		"exports": {
			".": {
				"import": "./esm.mjs",
				"require": "./cjs.cjs"
			}
		}
	}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pkgDir, "esm.mjs"), []byte(`export const mode = "esm";`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pkgDir, "cjs.cjs"), []byte(`module.exports = { mode: "cjs" };`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pkgDir, "internal.js"), []byte(`module.exports = "secret";`), 0o644); err != nil {
		t.Fatal(err)
	}

	// Setup proto.json with "__proto__" key
	if err := os.WriteFile(filepath.Join(dir, "proto.json"), []byte(`{"__proto__": {"polluted": "yes"}, "normal": 123}`), 0o644); err != nil {
		t.Fatal(err)
	}

	code, out, errOut, err := runJS(t, `
		import assert from "node:assert/strict";
		import fs from "node:fs";
		import fsp from "node:fs/promises";
		import path from "node:path";
		import { Writable, Transform } from "node:stream";
		import { AsyncLocalStorage } from "node:async_hooks";
		import v8 from "node:v8";
		import vm from "node:vm";
		import http from "node:http";
		import { spawnSync } from "node:child_process";
		import protoData from "./proto.json";
		import { mode as esmMode } from "strict-pkg";

		// 1. JSON module import with __proto__ does not pollute prototype
		assert.strictEqual(({}).polluted, undefined);
		assert.strictEqual(protoData.normal, 123);

		// 2. Package exports condition matching (ESM vs CJS) & strict encapsulation
		const { createRequire: createReq2 } = await import("node:module");
		const req2 = createReq2(import.meta.url);
		assert.strictEqual(esmMode, "esm");
		const cjsPkg = req2("strict-pkg");
		assert.strictEqual(cjsPkg.mode, "cjs");
		assert.throws(() => {
			req2("strict-pkg/internal.js");
		}, (e) => e.code === "ERR_PACKAGE_PATH_NOT_EXPORTED");

		// 3. TextEncoder.encodeInto partial multi-byte UTF-8 handling
		const enc = new TextEncoder();
		const dest = new Uint8Array(5);
		// "a" (1 byte) + "€" (3 bytes) + "😀" (4 bytes, 2 UTF-16 code units)
		const resInto = enc.encodeInto("a€😀", dest);
		assert.strictEqual(resInto.read, 2); // "a" + "€"
		assert.strictEqual(resInto.written, 4); // 1 + 3 bytes; "😀" (4 bytes) does not fit in remaining 1 byte

		// 4. FileHandle.write(string), FileHandle.writeFile, and fs.write(fd, string, cb) sequential offsets
		const fhPath = path.join(process.cwd(), "fh_seq.txt");
		const fh = await fsp.open(fhPath, "w+");
		await fh.write("Hello");
		await fh.write(", ");
		await fh.writeFile("World");
		await fh.close();
		assert.strictEqual(fs.readFileSync(fhPath, "utf8"), "Hello, World");

		const cbPath = path.join(process.cwd(), "cb_seq.txt");
		const fd = fs.openSync(cbPath, "w+");
		await new Promise((res, rej) => fs.write(fd, "Part1-", (e) => e ? rej(e) : res()));
		await new Promise((res, rej) => fs.write(fd, "Part2", (e) => e ? rej(e) : res()));
		fs.closeSync(fd);
		assert.strictEqual(fs.readFileSync(cbPath, "utf8"), "Part1-Part2");

		// 5. Async Writable & Transform serialization and awaiting before finish
		const order = [];
		const w = new Writable({
			write(chunk, _enc, cb) {
				const s = chunk.toString();
				setTimeout(() => {
					order.push("w:" + s);
					cb();
				}, s === "first" ? 30 : 5);
			}
		});
		w.write("first");
		w.write("second");
		await new Promise((res) => w.end(() => {
			order.push("finish");
			res();
		}));
		assert.deepStrictEqual(order, ["w:first", "w:second", "finish"]);

		const tChunks = [];
		const tr = new Transform({
			transform(chunk, _enc, cb) {
				setTimeout(() => cb(null, chunk.toString().toUpperCase()), 15);
			},
			flush(cb) {
				setTimeout(() => cb(null, "!"), 10);
			}
		});
		tr.on("data", (c) => tChunks.push(c.toString()));
		tr.write("ab");
		tr.write("cd");
		await new Promise((res) => tr.end(res));
		assert.strictEqual(tChunks.join(""), "ABCD!");

		// 6. vm.runInNewContext >64 calls isolation & unhandled rejection tracking
		for (let i = 0; i < 80; i++) {
			vm.runInNewContext("globalThis.leakedVar = " + i, {});
		}
		assert.strictEqual(vm.runInNewContext("typeof leakedVar", {}), "undefined");

		let vmRejReason = null;
		const onRej = (r) => { vmRejReason = r; };
		process.on("unhandledRejection", onRej);
		vm.runInNewContext("Promise.reject('vm_boom')", {});
		await new Promise((r) => setTimeout(r, 20));
		process.off("unhandledRejection", onRej);
		assert.strictEqual(vmRejReason, "vm_boom");

		// 7. AsyncLocalStorage propagation across await & timers
		const als = new AsyncLocalStorage();
		const alsResult = await als.run({ reqId: "req-99" }, async () => {
			await new Promise((r) => setTimeout(r, 10));
			return als.getStore().reqId;
		});
		assert.strictEqual(alsResult, "req-99");
		assert.strictEqual(als.getStore(), undefined);

		// 8. v8.serialize / v8.deserialize rich types & binary header
		const rich = {
			bi: 9007199254740993n,
			dt: new Date(1700000000000),
			re: /abc/gi,
			mp: new Map([["k", 42]]),
			st: new Set(["x", "y"]),
			undef: undefined,
			nan: NaN,
		};
		const ser = v8.serialize(rich);
		assert.strictEqual(ser[0], 0xff);
		const des = v8.deserialize(ser);
		assert.strictEqual(des.bi, 9007199254740993n);
		assert.strictEqual(des.dt.getTime(), 1700000000000);
		assert.strictEqual(des.re.source, "abc");
		assert.strictEqual(des.mp.get("k"), 42);
		assert.ok(des.st.has("y"));
		assert.ok(Number.isNaN(des.nan));

		// 9. HTTP ServerResponse streaming chunks before end()
		const streamed = await new Promise((resolve, reject) => {
			const srv = http.createServer((_req, res) => {
				res.writeHead(200, { "Content-Type": "text/plain" });
				res.write("chunkA-");
				setTimeout(() => {
					res.end("chunkB");
				}, 15);
			});
			srv.listen(0, "127.0.0.1", async () => {
				try {
					const port = srv.address().port;
					const resp = await fetch("http://127.0.0.1:" + port);
					const text = await resp.text();
					srv.close(() => resolve(text));
				} catch (e) {
					srv.close(() => reject(e));
				}
			});
		});
		assert.strictEqual(streamed, "chunkA-chunkB");

		// 10. JailRoots blocks env-expanded and nested subcommand paths outside jail
		const outPath = process.env.OUTSIDE_SECRET_PATH;
		assert.throws(() => {
			spawnSync("sh", ["-c", "cat " + outPath]);
		}, (e) => e.code === "EACCES");
		await assert.rejects(async () => {
			await $.env({ SECRET_P: outPath })` + "`cat $SECRET_P`" + `;
		}, (e) => e.code === "EACCES");
		await assert.rejects(async () => {
			await $` + "`cat ~/secret`" + `;
		}, (e) => e.code === "EACCES");

		console.log("ROUND4_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = dir
		o.Filename = filepath.Join(dir, "main.mjs")
		o.JailRoots = []string{dir}
		o.Env = map[string]string{
			"OUTSIDE_SECRET_PATH": outsideFile,
		}
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 4 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if strings.TrimSpace(out) != "ROUND4_ALL_OK" {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}

	// 11. Unsettled top-level await exits with code 13 and warning
	tlaCode, _, tlaErrOut, _ := runJS(t, `
		await new Promise(() => {});
	`)
	if tlaCode != 13 {
		t.Fatalf("expected unsettled top-level await exit code 13, got %d (stderr=%s)", tlaCode, tlaErrOut)
	}
	if !strings.Contains(tlaErrOut, "Detected unsettled top-level await") {
		t.Fatalf("expected unsettled TLA warning on stderr, got %q", tlaErrOut)
	}
}

func TestRunScript_Round5AdversarialFixes(t *testing.T) {
	dir := t.TempDir()
	outsideDir := t.TempDir()
	outsideFile := filepath.Join(outsideDir, "secret.txt")
	if err := os.WriteFile(outsideFile, []byte("top-secret"), 0o644); err != nil {
		t.Fatal(err)
	}

	code, out, errOut, err := runJS(t, `
		import assert from "node:assert";
		import http from "node:http";
		import net from "node:net";
		import fs from "node:fs";
		import path from "node:path";
		import crypto from "node:crypto";
		import vm from "node:vm";
		import { exec, spawnSync } from "node:child_process";
		import { promisify } from "node:util";

		// 1. High #1: HTTP ServerResponse must not drop chunks under rapid res.write()
		const streamedLen = await new Promise((resolve, reject) => {
			const srv = http.createServer((_req, res) => {
				for (let i = 0; i < 5000; i++) res.write("xxxx");
				res.end();
			});
			srv.listen(0, "127.0.0.1", async () => {
				try {
					const port = srv.address().port;
					const r = await fetch("http://127.0.0.1:" + port);
					const txt = await r.text();
					srv.close(() => resolve(txt.length));
				} catch (e) {
					srv.close(() => reject(e));
				}
			});
		});
		assert.strictEqual(streamedLen, 20000);

		// 2. High #2: net.Socket pre-connect write() + end() must queue until connected
		const earlyRecv = await new Promise((resolve, reject) => {
			let got = "";
			const srv = net.createServer((s) => {
				s.on("data", (d) => { got += d.toString(); });
				s.on("end", () => {
					srv.close(() => resolve(got));
				});
			});
			srv.listen(0, "127.0.0.1", () => {
				const c = net.connect(srv.address().port, "127.0.0.1");
				c.on("error", reject);
				c.write("early-");
				c.write("payload");
				c.end();
			});
		});
		assert.strictEqual(earlyRecv, "early-payload");

		// 3. High #3: fs.createReadStream highWaterMark backpressure when paused / no consumer
		const bigFile = path.join(process.cwd(), "big.bin");
		fs.writeFileSync(bigFile, Buffer.alloc(256 * 1024, 0x61));
		const rs = fs.createReadStream(bigFile, { highWaterMark: 1024 });
		await new Promise((r) => setTimeout(r, 20));
		assert.strictEqual(rs.readableEnded, false);
		assert.ok(rs.readableLength <= 1024, "expected readableLength <= 1024, got " + rs.readableLength);
		let totalRead = 0;
		for await (const chunk of rs) {
			totalRead += chunk.length;
		}
		assert.strictEqual(totalRead, 256 * 1024);

		// 4. Medium #7: AES-GCM non-12-byte IV with custom authTagLength round-trip
		const gcmKey = Buffer.alloc(32, 1);
		const gcmIv = Buffer.alloc(16, 2);
		const cipher = crypto.createCipheriv("aes-256-gcm", gcmKey, gcmIv, { authTagLength: 12 });
		cipher.setAAD(Buffer.from("header-aad"));
		const enc = Buffer.concat([cipher.update("hello-gcm-non12"), cipher.final()]);
		const tag = cipher.getAuthTag();
		assert.strictEqual(tag.length, 12);
		const decipher = crypto.createDecipheriv("aes-256-gcm", gcmKey, gcmIv, { authTagLength: 12 });
		decipher.setAAD(Buffer.from("header-aad"));
		decipher.setAuthTag(tag);
		const dec = Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
		assert.strictEqual(dec, "hello-gcm-non12");

		// Tampered tag must fail authentication
		const badTag = Buffer.from(tag);
		badTag[0] ^= 0xff;
		const badDecipher = crypto.createDecipheriv("aes-256-gcm", gcmKey, gcmIv, { authTagLength: 12 });
		badDecipher.setAAD(Buffer.from("header-aad"));
		badDecipher.setAuthTag(badTag);
		assert.throws(() => {
			badDecipher.update(enc);
			badDecipher.final();
		}, (e) => e.code === "ERR_CRYPTO_INVALID_STATE");

		// 5. Medium #8: >64 vm contexts must not alias and >200 ephemeral contexts must not leak
		const ctxs = Array.from({ length: 70 }, (_, i) => vm.createContext({ v: i }));
		for (let i = 0; i < 70; i++) {
			vm.runInContext("globalThis.tag = v * 10", ctxs[i]);
		}
		assert.strictEqual(vm.runInContext("tag", ctxs[0]), 0);
		assert.strictEqual(vm.runInContext("tag", ctxs[64]), 640);
		for (let i = 0; i < 200; i++) {
			assert.strictEqual(vm.runInNewContext("a + 1", { a: i }), i + 1);
		}

		// 6. Medium #10 & High #5 & Low #13: JailRoots enforcement on glob, chown, and shell modifiers
		const outDir = process.env.OUTSIDE_DIR;
		const outSecret = process.env.OUTSIDE_SECRET;
		assert.throws(() => {
			fs.globSync("*", { cwd: outDir });
		}, (e) => e.code === "EACCES");
		assert.throws(() => {
			fs.chownSync(outSecret, 1000, 1000);
		}, (e) => e.code === "EACCES");
		assert.throws(() => {
			spawnSync("cmd.exe", ["/c", "type %OUTSIDE_SECRET:~0,200%"]);
		}, (e) => e.code === "EACCES");

		// 7. Medium #11: exec with stdio: "ignore" forces stdout/stderr pipes in Node.js and captures output
		const execAsync = promisify(exec);
		const ignoredRes = await execAsync("echo hello", { stdio: "ignore" });
		assert.strictEqual(ignoredRes.stdout.trim(), "hello");
		assert.strictEqual(ignoredRes.stderr, "");

		// 8. High #4: worker_threads parentPort.postMessage + parentPort.on("message") under JailRoots
		const { Worker } = await import("node:worker_threads");
		const workerReply = await new Promise((resolve, reject) => {
			const w = new Worker(
				'const { parentPort, workerData } = require("node:worker_threads"); const fs = require("node:fs"); let jailBlocked = false; try { fs.readFileSync(process.env.OUTSIDE_SECRET); } catch (e) { jailBlocked = e.code === "EACCES"; } parentPort.on("message", (m) => { parentPort.postMessage({ sum: m + workerData.base, jailBlocked }); parentPort.close(); });',
				{ eval: true, workerData: { base: 10 } }
			);
			w.stderr.on("data", (d) => console.error("WORKER STDERR:", d.toString()));
			w.on("error", reject);
			w.on("message", resolve);
			w.on("exit", (code) => {
				if (code !== 0) reject(new Error("worker exited with code " + code));
			});
			w.postMessage(32);
		});
		assert.strictEqual(workerReply.sum, 42);
		assert.strictEqual(workerReply.jailBlocked, true);

		console.log("ROUND5_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = dir
		o.Filename = filepath.Join(dir, "main.mjs")
		o.JailRoots = []string{dir}
		env := make(map[string]string)
		for _, kv := range os.Environ() {
			if idx := strings.IndexByte(kv, '='); idx > 0 {
				env[kv[:idx]] = kv[idx+1:]
			}
		}
		env["OUTSIDE_DIR"] = outsideDir
		env["OUTSIDE_SECRET"] = outsideFile
		o.Env = env
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 5 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if strings.TrimSpace(out) != "ROUND5_ALL_OK" {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round6AdversarialFixes(t *testing.T) {
	parentDir := t.TempDir()
	wsDir := filepath.Join(parentDir, "ws")
	brainDir := filepath.Join(parentDir, "brain")
	outsideDir := filepath.Join(parentDir, "outside")
	if err := os.MkdirAll(wsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(brainDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outsideDir, 0o755); err != nil {
		t.Fatal(err)
	}
	outsideFile := filepath.Join(outsideDir, "secret.txt")
	if err := os.WriteFile(outsideFile, []byte("TOP_SECRET_R6"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(wsDir, "hello.txt"), []byte("alpha\nbeta\ngamma\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	escapeScript := filepath.Join(wsDir, "escape.sh")
	if err := os.WriteFile(escapeScript, []byte("cat "+strings.ReplaceAll(outsideFile, `\`, `/`)+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	nonEmptyDir := filepath.Join(brainDir, "nonempty")
	if err := os.MkdirAll(nonEmptyDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nonEmptyDir, "child.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	code, out, errOut, err := runJS(t, `
		import assert from "node:assert";
		import fs from "node:fs";
		import path from "node:path";
		import { execFileSync, spawnSync, spawn } from "node:child_process";

		// 1. Critical #1: jailed sh -s with stdin and sh <script> must be blocked
		assert.throws(() => {
			execFileSync("sh", ["-s"], { input: "cat " + process.env.OUTSIDE_SECRET + "\n" });
		}, (e) => e.code === "EACCES");
		assert.throws(() => {
			execFileSync("sh", [path.join(process.cwd(), "escape.sh")]);
		}, (e) => e.code === "EACCES");

		// Async spawn("sh", ["-s"]) with piped stdin attempting to read outside jail must fail
		const asyncStdinRes = await new Promise((resolve) => {
			const child = spawn("sh", ["-s"]);
			let out = "", err = "";
			child.stdout.on("data", (d) => out += d.toString());
			child.stderr.on("data", (d) => err += d.toString());
			child.on("close", (code) => resolve({ code, out, err }));
			child.stdin.write("cat " + process.env.OUTSIDE_SECRET + "\n");
			child.stdin.end();
		});
		assert.notStrictEqual(asyncStdinRes.code, 0);
		assert.ok(!asyncStdinRes.out.includes("TOP_SECRET_R6"));

		// 2. High #2: ReadOnlyRoots blocks writes to wsDir (fs & $) while allowing reads from wsDir and writes to brainDir
		assert.strictEqual(fs.readFileSync("hello.txt", "utf8").trim().split("\n")[0], "alpha");
		assert.throws(() => {
			fs.writeFileSync("forbidden.txt", "nope");
		}, (e) => e.code === "EACCES");
		await assert.rejects(async () => {
			await $`+"`echo hacked > forbidden2.txt`"+`;
		}, (e) => e.code === "EACCES");
		await assert.rejects(async () => {
			await $`+"`rm hello.txt`"+`;
		}, (e) => e.code === "EACCES");
		const brainOut = path.join(process.env.BRAIN_DIR, "allowed.txt");
		fs.writeFileSync(brainOut, "brain_ok");
		assert.strictEqual(fs.readFileSync(brainOut, "utf8"), "brain_ok");

		// 3. Medium #5: maxBuffer enforced in jailed shell evaluator
		const maxBufRes = spawnSync("cat", ["hello.txt"], { maxBuffer: 4 });
		assert.ok(maxBufRes.error && maxBufRes.error.code === "ENOBUFS");
		assert.throws(() => {
			execFileSync("cat", ["hello.txt"], { maxBuffer: 4 });
		}, (e) => e.code === "ENOBUFS");

		// 4. Medium #6: POSIX builtins & git work inside jail, while dangerous git flags are blocked
		const grepText = await $`+"`grep beta hello.txt`"+`.text();
		assert.strictEqual(grepText.trim(), "beta");
		const wcText = await $`+"`wc -l hello.txt`"+`.text();
		assert.ok(wcText.trim().startsWith("3"));
		const gitVer = await $`+"`git --version`"+`.quiet().nothrow();
		if (gitVer.exitCode === 0) {
			assert.ok(gitVer.text().toLowerCase().includes("git version"));
		}
		assert.throws(() => {
			execFileSync("git", ["-c", "core.sshCommand=evil", "status"]);
		}, (e) => e.code === "EACCES");

		// 5. Medium #8: WebCrypto ECDSA, Ed25519, RSA-OAEP, AES-CBC, and NotSupportedError
		const ecPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
		const msgBytes = new TextEncoder().encode("round6-webcrypto");
		const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ecPair.privateKey, msgBytes);
		const verified = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, ecPair.publicKey, sig, msgBytes);
		assert.strictEqual(verified, true);
		const verifiedBad = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, ecPair.publicKey, sig, new TextEncoder().encode("tampered"));
		assert.strictEqual(verifiedBad, false);

		const edPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
		const edSig = await crypto.subtle.sign({ name: "Ed25519" }, edPair.privateKey, msgBytes);
		assert.strictEqual(await crypto.subtle.verify({ name: "Ed25519" }, edPair.publicKey, edSig, msgBytes), true);

		await assert.rejects(async () => {
			await crypto.subtle.generateKey({ name: "UNSUPPORTED-ALGO-XYZ" }, true, ["sign"]);
		}, (e) => e.name === "NotSupportedError");

		// 6. Low #10: rmdirSync on non-empty directory returns ENOTEMPTY
		assert.throws(() => {
			fs.rmdirSync(process.env.NONEMPTY_DIR);
		}, (e) => e.code === "ENOTEMPTY");

		console.log("ROUND6_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "main.mjs")
		o.JailRoots = []string{wsDir, brainDir}
		o.ReadOnlyRoots = []string{wsDir}
		env := make(map[string]string)
		for _, kv := range os.Environ() {
			if idx := strings.IndexByte(kv, '='); idx > 0 {
				env[kv[:idx]] = kv[idx+1:]
			}
		}
		env["OUTSIDE_SECRET"] = outsideFile
		env["BRAIN_DIR"] = brainDir
		env["NONEMPTY_DIR"] = nonEmptyDir
		o.Env = env
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 6 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if strings.TrimSpace(out) != "ROUND6_ALL_OK" {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round7AdversarialFixes(t *testing.T) {
	wsDir := t.TempDir()
	brainDir := t.TempDir()
	roFile := filepath.Join(wsDir, "readonly.txt")
	if err := os.WriteFile(roFile, []byte("IMMUTABLE_DATA"), 0o644); err != nil {
		t.Fatal(err)
	}

	code, out, errOut, err := runJS(t, `
		import assert from "node:assert";
		import fs from "node:fs";
		import path from "node:path";
		import http from "node:http";
		import net from "node:net";
		import vm from "node:vm";
		import { execFileSync, spawnSync } from "node:child_process";
		import { Worker } from "node:worker_threads";

		// 1. Critical #1: GIT_CONFIG_COUNT / LD_PRELOAD / git --output / git --ext-diff / git alias blocked in jail
		assert.throws(() => {
			execFileSync("git", ["status"], { env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.pager", GIT_CONFIG_VALUE_0: "evil" } });
		}, (e) => e.code === "EACCES");
		assert.throws(() => {
			execFileSync("git", ["status"], { env: { ...process.env, LD_PRELOAD: "/tmp/evil.so" } });
		}, (e) => e.code === "EACCES");
		assert.throws(() => {
			execFileSync("git", ["diff", "--output=" + path.join(process.env.BRAIN_DIR, "leak.diff")]);
		}, (e) => e.code === "EACCES");
		assert.throws(() => {
			execFileSync("git", ["diff", "--ext-diff"]);
		}, (e) => e.code === "EACCES");
		assert.throws(() => {
			execFileSync("git", ["my-custom-alias"]);
		}, (e) => e.code === "EACCES");
		await assert.rejects(async () => {
			await $`+"`GIT_CONFIG_COUNT=1 git status`"+`.quiet();
		}, (e) => e.code === "EACCES");

		// 2. Critical #2: fs.linkSync cannot hard-link a read-only file into a writable root
		const linkDest = path.join(process.env.BRAIN_DIR, "linked.txt");
		assert.throws(() => {
			fs.linkSync("readonly.txt", linkDest);
		}, (e) => e.code === "EACCES");
		assert.strictEqual(fs.readFileSync("readonly.txt", "utf8"), "IMMUTABLE_DATA");

		// 3. High #3 & #4 & Low #2 & Low #3: http.Server.close drains in-flight requests, statusMessage, ERR_SERVER_ALREADY_LISTEN
		let closeEvents = [];
		let notifyReqArrived;
		const reqArrived = new Promise((r) => { notifyReqArrived = r; });
		const srv = http.createServer((req, res) => {
			notifyReqArrived();
			setTimeout(() => {
				closeEvents.push("response_end");
				res.statusCode = 201;
				res.statusMessage = "CustomCreated";
				res.end("drained-ok");
			}, 40);
		});
		await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
		assert.throws(() => {
			srv.listen(0, "127.0.0.1");
		}, (e) => e.code === "ERR_SERVER_ALREADY_LISTEN");
		const port = srv.address().port;
		const respPromise = fetch("http://127.0.0.1:" + port + "/drain");
		await reqArrived;
		const closePromise = new Promise((resolve) => srv.close(() => {
			closeEvents.push("server_closed");
			resolve();
		}));
		const resp = await respPromise;
		assert.strictEqual(resp.status, 201);
		assert.strictEqual(resp.statusText, "CustomCreated");
		assert.strictEqual(await resp.text(), "drained-ok");
		await closePromise;
		assert.deepStrictEqual(closeEvents, ["response_end", "server_closed"]);

		// 4. Low #1: net.Server.close waits for active connections
		let netEvents = [];
		let notifyNetData;
		const netDataArrived = new Promise((r) => { notifyNetData = r; });
		const netSrv = net.createServer((sock) => {
			sock.on("data", (d) => {
				notifyNetData();
				setTimeout(() => {
					netEvents.push("sock_end");
					sock.end(d);
				}, 30);
			});
		});
		await new Promise((resolve) => netSrv.listen(0, "127.0.0.1", resolve));
		const netPort = netSrv.address().port;
		const client = net.connect(netPort, "127.0.0.1", () => {
			client.write("ping");
		});
		await netDataArrived;
		const netClosePromise = new Promise((resolve) => netSrv.close(() => {
			netEvents.push("net_closed");
			resolve();
		}));
		const netData = await new Promise((resolve) => {
			let buf = "";
			client.on("data", (c) => buf += c.toString());
			client.on("end", () => resolve(buf));
		});
		assert.strictEqual(netData, "ping");
		await netClosePromise;
		assert.deepStrictEqual(netEvents, ["sock_end", "net_closed"]);

		// 5. High #9: stdio: "inherit" inherits parent stdin
		const inh = spawnSync("cat", [], { stdio: ["inherit", "pipe", "pipe"] });
		assert.strictEqual(inh.stdout.toString().trim(), "PARENT_STDIN_PAYLOAD");

		// 6. Low #4: Worker.terminate resolves after exit
		if (process.execPath) {
			const wEvents = [];
			const w = new Worker("setInterval(() => {}, 1000);", { eval: true });
			w.on("exit", () => wEvents.push("exit"));
			await new Promise((r) => setTimeout(r, 20));
			const termCode = await w.terminate();
			wEvents.push("terminated:" + typeof termCode);
			assert.deepStrictEqual(wEvents, ["exit", "terminated:number"]);
		}

		// 7. Low #5: process.kill in jail blocks outside PIDs with EPERM
		assert.throws(() => {
			process.kill(1, 0);
		}, (e) => e.code === "EPERM");

		// 8. Low #6: vm context persists across primitive return values
		const ctx = vm.createContext({ x: 0 });
		assert.strictEqual(vm.runInContext("x = 1; var y = 41; x", ctx), 1);
		assert.strictEqual(vm.runInContext("x + y", ctx), 42);

		console.log("ROUND7_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "main.mjs")
		o.JailRoots = []string{wsDir, brainDir}
		o.ReadOnlyRoots = []string{wsDir}
		o.Stdin = strings.NewReader("PARENT_STDIN_PAYLOAD\n")
		if exe, err := os.Executable(); err == nil {
			o.ExecPath = exe
		}
		env := make(map[string]string)
		for _, kv := range os.Environ() {
			if idx := strings.IndexByte(kv, '='); idx > 0 {
				env[kv[:idx]] = kv[idx+1:]
			}
		}
		env["BRAIN_DIR"] = brainDir
		o.Env = env
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 7 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if strings.TrimSpace(out) != "ROUND7_ALL_OK" {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round8AdversarialFixes(t *testing.T) {
	parentDir := t.TempDir()
	wsDir := filepath.Join(parentDir, "ws")
	brainDir := filepath.Join(parentDir, "brain")
	outsideDir := filepath.Join(parentDir, "outside")
	if err := os.MkdirAll(wsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(brainDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outsideDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outsideDir, "secret.txt"), []byte("OUTSIDE_SECRET"), 0o644); err != nil {
		t.Fatal(err)
	}
	juncPath := filepath.Join(wsDir, "out_junc")
	if runtime.GOOS == "windows" {
		_ = exec.Command("cmd.exe", "/c", "mklink", "/J", juncPath, outsideDir).Run()
	} else {
		_ = os.Symlink(outsideDir, juncPath)
	}

	code, out, errOut, err := runJS(t, `
		import assert from "node:assert";
		import fs from "node:fs";
		import path from "node:path";
		import http from "node:http";
		import net from "node:net";
		import vm from "node:vm";
		import { execSync, spawnSync } from "node:child_process";

		// 1. Critical #1: Directory junction / symlink escape blocked on existing and non-existent child paths
		const junc = path.join(process.cwd(), "out_junc");
		if (fs.existsSync(junc) || (() => { try { fs.lstatSync(junc); return true; } catch { return false; } })()) {
			assert.throws(() => {
				fs.readFileSync(path.join(junc, "secret.txt"), "utf8");
			}, (e) => e.code === "EACCES");
			assert.throws(() => {
				fs.writeFileSync(path.join(junc, "pwn.txt"), "x");
			}, (e) => e.code === "EACCES");
			assert.throws(() => {
				fs.realpathSync(junc);
			}, (e) => e.code === "EACCES");
		}

		// 2. Critical #2 & High #3: Jailed git works on Windows (no NUL config error) and blocks unsafe .git/config & flags
		const repoDir = path.join(process.env.BRAIN_DIR, "repo");
		fs.mkdirSync(repoDir, { recursive: true });
		const gitVer = spawnSync("git", ["--version"]);
		if (gitVer.status === 0) {
			const initRes = spawnSync("git", ["init"], { cwd: repoDir });
			assert.strictEqual(initRes.status, 0, "git init failed: " + initRes.stderr);
			const stRes = spawnSync("git", ["status"], { cwd: repoDir });
			assert.strictEqual(stRes.status, 0, "git status failed: " + stRes.stderr);

			// Unsafe flags blocked
			assert.throws(() => {
				spawnSync("git", ["diff", "--textconv"], { cwd: repoDir });
			}, (e) => e.code === "EACCES");
			assert.throws(() => {
				spawnSync("git", ["bisect", "run", "sh"], { cwd: repoDir });
			}, (e) => e.code === "EACCES");

			// Malicious .git/config directive blocked
			const cfgPath = path.join(repoDir, ".git", "config");
			const origCfg = fs.readFileSync(cfgPath, "utf8");
			fs.writeFileSync(cfgPath, origCfg + "\n[core]\n\tfsmonitor = evil\n");
			assert.throws(() => {
				spawnSync("git", ["status"], { cwd: repoDir });
			}, (e) => e.code === "EACCES");
			fs.writeFileSync(cfgPath, origCfg);

			// Malicious .gitattributes filter directive blocked
			const attrPath = path.join(repoDir, ".gitattributes");
			fs.writeFileSync(attrPath, "* filter=lfs\n");
			assert.throws(() => {
				spawnSync("git", ["status"], { cwd: repoDir });
			}, (e) => e.code === "EACCES");
			fs.unlinkSync(attrPath);
		}

		// 3. Self-JS exec via process.execPath --js in shell command line under jail
		if (process.execPath) {
			const selfOut = execSync('"' + process.execPath + '" --js -e "console.log(20 + 22)"').toString().trim();
			assert.strictEqual(selfOut, "42");
		}

		// 4. High #4: vm.runInNewContext does not copy global performance into sandbox or leak contexts
		for (let i = 0; i < 500; i++) {
			const sb = { n: i };
			const r = vm.runInNewContext("n + 1", sb);
			assert.strictEqual(r, i + 1);
			assert.strictEqual("performance" in sb, false);
		}

		// 5. High #5: HTTP client disconnect releases ServerResponse so server.close() does not hang
		await new Promise((resolve, reject) => {
			let reqSeen = false;
			const srv = http.createServer((req, res) => {
				reqSeen = true;
				req.on("close", () => {
					srv.close((err) => err ? reject(err) : resolve());
				});
			});
			srv.listen(0, "127.0.0.1", () => {
				const port = srv.address().port;
				const sock = net.connect(port, "127.0.0.1", () => {
					sock.write("GET /hang HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
					setTimeout(() => sock.destroy(), 30);
				});
			});
		});

		// 6. Medium #12: net.connect destroyed immediately during dial does not leak
		const earlyDestroySock = net.connect(65431, "127.0.0.1");
		earlyDestroySock.on("error", () => {});
		earlyDestroySock.destroy();

		console.log("ROUND8_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "main.mjs")
		o.JailRoots = []string{wsDir, brainDir}
		o.ReadOnlyRoots = []string{wsDir}
		if exe, err := os.Executable(); err == nil {
			o.ExecPath = exe
		}
		env := make(map[string]string)
		for _, kv := range os.Environ() {
			if idx := strings.IndexByte(kv, '='); idx > 0 {
				env[kv[:idx]] = kv[idx+1:]
			}
		}
		env["BRAIN_DIR"] = brainDir
		o.Env = env
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 8 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if strings.TrimSpace(out) != "ROUND8_ALL_OK" {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round9AdversarialFixes(t *testing.T) {
	wsDir := t.TempDir()
	outsideDir := t.TempDir()
	outsideFile := filepath.Join(outsideDir, "secret.txt")
	if err := os.WriteFile(outsideFile, []byte("SECRET"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Create a symlink inside wsDir pointing to outsideFile (if OS supports symlinks)
	linkInJail := filepath.Join(wsDir, "escape_link")
	hasSymlink := os.Symlink(outsideFile, linkInJail) == nil

	pr, pw := io.Pipe()
	defer pr.Close()
	defer pw.Close()

	code, out, errOut, err := runJS(t, `
		import assert from "node:assert/strict";
		import fs from "node:fs";
		import path from "node:path";
		import http from "node:http";
		import net from "node:net";
		import querystring from "node:querystring";
		import { Readable, Writable } from "node:stream";
		import { StringDecoder } from "node:string_decoder";
		import { spawn } from "node:child_process";

		// 1. C1: spawn with stdio: ["ignore", "pipe", "pipe"] must not panic on typed-nil stdin
		// and $ without .stdin() on a stdin-reading filter must not hang or panic.
		if (process.execPath) {
			const cpIgn = spawn(process.execPath, ["--js", "-e", "process.exit(0)"], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			const exitIgn = await new Promise((r) => cpIgn.on("close", (c) => r(c)));
			assert.strictEqual(exitIgn, 0);
		}
		const grepRes = await $`+"`grep nomatch`"+`.nothrow().quiet();
		assert.notStrictEqual(grepRes.exitCode, 0);
		const grepHit = await $`+"`grep hello`"+`.stdin("hello world\ngoodbye\n").quiet().text();
		assert.strictEqual(grepHit.trim(), "hello world");

		// 2. M2: Multi-byte UTF-8 split across chunks in Readable(encoding: "utf8") & StringDecoder
		// and mid-stream BOM preservation in TextDecoder
		const euroSmile = Buffer.from("a€😀z", "utf8");
		const splitReadable = new Readable({ encoding: "utf8", read() {} });
		for (let i = 0; i < euroSmile.length; i++) {
			splitReadable.push(euroSmile.subarray(i, i + 1));
		}
		splitReadable.push(null);
		let collected = "";
		for await (const part of splitReadable) {
			collected += part;
		}
		assert.strictEqual(collected, "a€😀z");

		const td = new TextDecoder("utf-8");
		const bomAndMid = Buffer.from("\uFEFFhello\uFEFFworld", "utf8");
		const d1 = td.decode(bomAndMid.subarray(0, 5), { stream: true });
		const d2 = td.decode(bomAndMid.subarray(5));
		assert.strictEqual(d1 + d2, "hello\uFEFFworld");

		// 3. M3 & M15: fs.writeSync and Buffer.alloc bounds validation
		const tmpFile = path.join(process.cwd(), "bounds.txt");
		const fd = fs.openSync(tmpFile, "w+");
		const smallBuf = Buffer.from("abcd");
		assert.throws(() => fs.writeSync(fd, smallBuf, -1, 2), (e) => e.code === "ERR_OUT_OF_RANGE");
		assert.throws(() => fs.writeSync(fd, smallBuf, 2, 10), (e) => e.code === "ERR_OUT_OF_RANGE");
		assert.throws(() => fs.writeSync(fd, smallBuf, 10, 1), (e) => e.code === "ERR_OUT_OF_RANGE");
		fs.closeSync(fd);
		assert.throws(() => Buffer.alloc(-1), (e) => e.code === "ERR_OUT_OF_RANGE");
		assert.throws(() => Buffer.alloc(NaN), (e) => e.code === "ERR_OUT_OF_RANGE");

		// 4. M5: Invalid HTTP status code throws ERR_HTTP_INVALID_STATUS_CODE instead of panicking
		await new Promise((resolve, reject) => {
			const srv = http.createServer((_req, res) => {
				assert.throws(() => res.writeHead(1000), (e) => e.code === "ERR_HTTP_INVALID_STATUS_CODE");
				assert.throws(() => res.writeHead(99), (e) => e.code === "ERR_HTTP_INVALID_STATUS_CODE");
				res.writeHead(200);
				res.end("ok");
			});
			srv.listen(0, "127.0.0.1", async () => {
				try {
					const r = await fetch("http://127.0.0.1:" + srv.address().port);
					assert.strictEqual(await r.text(), "ok");
					srv.close(() => resolve());
				} catch (e) {
					srv.close(() => reject(e));
				}
			});
		});

		// 5. M6 & R12-F11: No-follow symlink operations inside jail (lstat, unlink; readlink allowed inside jail, blocked outside jail)
		if (process.env.HAS_SYMLINK === "1") {
			const internalLink = path.join(process.cwd(), "internal_link");
			fs.symlinkSync(tmpFile, internalLink);
			assert.ok(fs.readlinkSync(internalLink).length > 0);
			fs.unlinkSync(internalLink);

			const linkPath = path.join(process.cwd(), "escape_link");
			const lst = fs.lstatSync(linkPath);
			assert.strictEqual(lst.isSymbolicLink(), true);
			assert.throws(() => fs.readlinkSync(linkPath), (e) => e.code === "EACCES");
			assert.throws(() => fs.statSync(linkPath), (e) => e.code === "EACCES");
			assert.throws(() => fs.readFileSync(linkPath), (e) => e.code === "EACCES");
			fs.unlinkSync(linkPath);
			assert.strictEqual(fs.existsSync(linkPath), false);
		}

		// 6. M7: Single-quoted $VAR inside $ is not expanded by expandShellVars
		const sqOut = await $.env({ OUTSIDE_VAR: process.env.OUTSIDE_PATH })`+"`echo '$OUTSIDE_VAR'`"+`.quiet().text();
		assert.strictEqual(sqOut.trim(), "$OUTSIDE_VAR");

		// 7. M8: process.stdin.on("data") on an open pipe does not block the event loop
		let stdinTimerFired = false;
		process.stdin.on("data", () => {});
		await new Promise((r) => setTimeout(() => { stdinTimerFired = true; r(); }, 25));
		assert.strictEqual(stdinTimerFired, true);
		process.stdin.pause();
		process.stdin.unref();

		// 8. M9: Stream destroy(err) and queueMicrotask throw route to uncaughtException, not unhandledRejection
		let unhandledRej = false;
		const caughtExceptions = [];
		const onRej = () => { unhandledRej = true; };
		const onEx = (e) => { caughtExceptions.push(e.message); };
		process.on("unhandledRejection", onRej);
		process.on("uncaughtException", onEx);
		const errStream = new Readable({ read() {} });
		errStream.destroy(new Error("stream_boom"));
		queueMicrotask(() => { throw new Error("micro_boom"); });
		await new Promise((r) => setTimeout(r, 25));
		process.off("unhandledRejection", onRej);
		process.off("uncaughtException", onEx);
		assert.strictEqual(unhandledRej, false);
		assert.deepStrictEqual(caughtExceptions.sort(), ["micro_boom", "stream_boom"]);

		// 9. M12 & M17 & P3: Streaming fetch resolves on headers, streams chunks incrementally, sets default Content-Type, enforces bodyUsed
		await new Promise((resolve, reject) => {
			let finishServerResponse = null;
			let receivedContentType = "";
			const srv = http.createServer((req, res) => {
				receivedContentType = req.headers["content-type"] || "";
				res.writeHead(200, { "Content-Type": "text/plain" });
				res.write("first_chunk");
				finishServerResponse = () => res.end("_second_chunk");
			});
			srv.listen(0, "127.0.0.1", async () => {
				try {
					const resp = await fetch("http://127.0.0.1:" + srv.address().port, {
						method: "POST",
						body: "hello string body",
					});
					assert.strictEqual(receivedContentType, "text/plain;charset=UTF-8");
					const reader = resp.body.getReader();
					const first = await reader.read();
					assert.strictEqual(Buffer.from(first.value).toString("utf8"), "first_chunk");
					finishServerResponse();
					const rest = [];
					while (true) {
						const { value, done } = await reader.read();
						if (done) break;
						rest.push(Buffer.from(value).toString("utf8"));
					}
					assert.strictEqual(rest.join(""), "_second_chunk");
					srv.close(() => resolve());
				} catch (e) {
					srv.close(() => reject(e));
				}
			});
		});
		const staticRes = new Response("abc");
		assert.strictEqual(staticRes.statusText, "");
		assert.strictEqual(await staticRes.text(), "abc");
		await assert.rejects(() => staticRes.text(), TypeError);

		// 10. M16: URL, URLSearchParams, and querystring.parse tolerate bare %
		const u = new URL("http://example.com/path?pct=100%&ok=%20");
		assert.strictEqual(u.searchParams.get("pct"), "100%");
		assert.strictEqual(u.searchParams.get("ok"), " ");
		assert.strictEqual(querystring.parse("pct=100%&b=2").pct, "100%");

		// 11. M14: server.unref() called BEFORE server.listen(0) allows clean exit without close()
		const unrefSrv = net.createServer();
		unrefSrv.unref();
		await new Promise((r) => unrefSrv.listen(0, "127.0.0.1", r));

		console.log("ROUND9_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "main.mjs")
		o.JailRoots = []string{wsDir}
		o.Stdin = pr
		if exe, err := os.Executable(); err == nil {
			o.ExecPath = exe
		}
		hasSym := "0"
		if hasSymlink {
			hasSym = "1"
		}
		o.Env = map[string]string{
			"HAS_SYMLINK":  hasSym,
			"OUTSIDE_PATH": outsideFile,
		}
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 9 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if strings.TrimSpace(out) != "ROUND9_ALL_OK" {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round10AdversarialFixes(t *testing.T) {
	wsDir := t.TempDir()
	code, out, errOut, err := runJS(t, `
		import assert from "node:assert";
		import fs from "node:fs";
		import os from "node:os";
		import vm from "node:vm";
		import Module from "node:module";
		import { log as importedLog } from "node:console";
		import { Readable, Writable, PassThrough, pipeline, finished } from "node:stream";
		import { execSync, execFileSync, spawn, spawnSync } from "node:child_process";
		import { MessageChannel, BroadcastChannel, Worker } from "node:worker_threads";

		// 1. Jailed git blocks -O / --open-files-in-pager, help, --show-signature, tag -v
		for (const badGit of [
			["grep", "-Ovi", "foo"],
			["grep", "--open-files-in-pager=vi", "foo"],
			["help", "status"],
			["log", "--show-signature"],
			["log", "--format=%G?"],
			["tag", "-v", "v1"],
		]) {
			assert.throws(() => spawnSync("git", badGit), /EACCES/);
		}

		// 2. process.stdin.pipe and pipeline(..., process.stdout) + finished(process.stdout)
		assert.strictEqual(typeof process.stdin.pipe, "function");
		assert.strictEqual(typeof process.stdin.unpipe, "function");
		const sink = new PassThrough();
		process.stdin.pipe(sink);
		process.stdin.unpipe(sink);
		await new Promise((resolve, reject) => {
			pipeline(Readable.from(["", ""]), process.stdout, (err) => (err ? reject(err) : resolve()));
		});
		await new Promise((resolve, reject) => {
			finished(process.stdout, (err) => (err ? reject(err) : resolve()));
		});

		// 3. Stream pipe backpressure & Readable.push return value
		const slowW = new Writable({
			highWaterMark: 1,
			write(c, enc, cb) { setTimeout(cb, 15); },
		});
		const backR = new Readable({ read() {} });
		backR.pipe(slowW);
		assert.strictEqual(backR.push("aaaa"), false);
		assert.strictEqual(slowW.write("bbbb"), false);

		// 4. vm.runInNewContext loop (2000 iterations of object return) without OOM, and vm timeout
		for (let i = 0; i < 2000; i++) {
			const o = vm.runInNewContext("({ idx: " + i + " })");
			if (i === 1999) assert.strictEqual(o.idx, 1999);
		}
		assert.throws(() => vm.runInNewContext("while(true){}", {}, { timeout: 25 }), /timed out/);

		// 5. /dev/null and os.devNull in jailed mode (fs + $ redirection)
		fs.writeFileSync("/dev/null", "discarded");
		fs.writeFileSync(os.devNull, "discarded");
		assert.strictEqual(fs.readFileSync("/dev/null", "utf8"), "");
		const redirRes = await $(["echo hidden > /dev/null && cat < /dev/null"]).quiet();
		assert.strictEqual(redirRes.text(), "");

		// 6. Jailed shell stdin with -c / shell:true is treated as data, not shell script
		const catRes = spawnSync("cat", [], {
			shell: true,
			input: "C:\\Windows\\System32\\drivers\\etc\\hosts\n/etc/passwd\n",
			encoding: "utf8",
		});
		assert.strictEqual(catRes.status, 0);
		assert.ok(catRes.stdout.includes("/etc/passwd"));
		// Bare sh without -c still scans stdin as script in jail:
		assert.throws(() => spawnSync("sh", [], { input: "cat /etc/passwd\n" }), /EACCES/);

		// 7. execSync / execFileSync default to Buffer unless encoding is specified
		const echoBufDefault = execSync("echo hi");
		assert.ok(Buffer.isBuffer(echoBufDefault));
		assert.strictEqual(echoBufDefault.toString("utf8").trim(), "hi");
		const echoStr = execSync("echo hi", { encoding: "utf8" });
		assert.strictEqual(typeof echoStr, "string");
		assert.strictEqual(echoStr.trim(), "hi");

		// 8. Bound console methods & Module.builtinModules completeness
		const { log: destructuredLog } = console;
		assert.strictEqual(typeof destructuredLog, "function");
		assert.strictEqual(typeof importedLog, "function");
		for (const modName of ["module", "tty", "async_hooks", "worker_threads", "v8", "vm", "inspector"]) {
			assert.ok(Module.builtinModules.includes(modName), "missing builtin: " + modName);
		}

		// 9. MessageChannel early messages & BroadcastChannel
		const { port1, port2 } = new MessageChannel();
		port1.postMessage("early-1");
		port1.postMessage("early-2");
		const gotMsgs = await new Promise((resolve) => {
			const arr = [];
			setTimeout(() => {
				port2.on("message", (m) => {
					arr.push(m);
					if (arr.length === 2) resolve(arr);
				});
			}, 15);
		});
		assert.deepStrictEqual(gotMsgs, ["early-1", "early-2"]);

		const bc1 = new BroadcastChannel("ch1");
		const bc2 = new BroadcastChannel("ch1");
		assert.strictEqual(bc1.name, "ch1");
		const bcMsg = await new Promise((resolve) => {
			bc2.onmessage = (ev) => resolve(ev.data);
			bc1.postMessage({ ok: 42 });
		});
		assert.deepStrictEqual(bcMsg, { ok: 42 });
		bc1.close();
		bc2.close();

		// 10. Blob.stream(), ReadableStream.tee(), Response.clone() on streaming response
		const blob = new Blob(["hello", "-stream"]);
		const [t1, t2] = blob.stream().tee();
		assert.strictEqual(await new Response(t1).text(), "hello-stream");
		assert.strictEqual(await new Response(t2).text(), "hello-stream");

		// 11. process.kill(0, 0) & spawn error emits close
		assert.strictEqual(process.kill(0, 0), true);

		console.log("ROUND10_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "main.mjs")
		o.JailRoots = []string{wsDir}
		o.Stdin = strings.NewReader("")
		if exe, err := os.Executable(); err == nil {
			o.ExecPath = exe
		}
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 10 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "ROUND10_ALL_OK") {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round11AdversarialFixes(t *testing.T) {
	parentDir := t.TempDir()
	wsDir := filepath.Join(parentDir, "ws")
	outsideDir := filepath.Join(parentDir, "outside")
	if err := os.MkdirAll(wsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outsideDir, 0o755); err != nil {
		t.Fatal(err)
	}
	outsideSecret := filepath.Join(outsideDir, "secret.txt")
	if err := os.WriteFile(outsideSecret, []byte("OUTSIDE_SECRET"), 0o644); err != nil {
		t.Fatal(err)
	}

	pr, pw := io.Pipe()
	defer pr.Close()
	defer pw.Close()

	t.Setenv("MANPAGER", "cat")
	t.Setenv("BROWSER", "echo")

	code, out, errOut, err := runJS(t, `
		import assert from "node:assert/strict";
		import fs from "node:fs";
		import path from "node:path";
		import http from "node:http";
		import net from "node:net";
		import { Duplex } from "node:stream";
		import { exec, execSync, spawnSync } from "node:child_process";

		// 1. Finding 1: spawn/spawnSync with process.execPath --js and shell:true cannot chain commands to escape jail
		if (process.execPath) {
			assert.throws(() => {
				spawnSync(process.execPath, ["--js", "-e", "1", "&&", "cat", process.env.OUTSIDE_SECRET], { shell: true });
			}, /EACCES/);
			assert.throws(() => {
				spawnSync(process.execPath, ["--js", "-e", "1", process.env.OUTSIDE_SECRET]);
			}, /EACCES/);
			assert.throws(() => {
				spawnSync("echo", ["hi"], { shell: "/usr/bin/python3" });
			}, /EACCES/);
		}

		// 2. Finding 5: Host MANPAGER/BROWSER env vars are stripped in jail and do not break benign execSync
		assert.strictEqual(process.env.MANPAGER, undefined);
		assert.strictEqual(process.env.BROWSER, undefined);
		assert.strictEqual(execSync("echo env_clean", { encoding: "utf8" }).trim(), "env_clean");

		// 3. Finding 4: Jailed git blocks alternates, interactive.diffFilter, and git add -p
		const repoDir = path.join(process.cwd(), "repo11");
		fs.mkdirSync(repoDir, { recursive: true });
		const gitVer = spawnSync("git", ["--version"]);
		if (gitVer.status === 0) {
			spawnSync("git", ["init"], { cwd: repoDir });
			assert.throws(() => {
				spawnSync("git", ["add", "-p"], { cwd: repoDir });
			}, /EACCES/);

			const altFile = path.join(repoDir, ".git", "objects", "info", "alternates");
			fs.mkdirSync(path.dirname(altFile), { recursive: true });
			fs.writeFileSync(altFile, "/tmp\n");
			assert.throws(() => {
				spawnSync("git", ["status"], { cwd: repoDir });
			}, /EACCES/);
			fs.unlinkSync(altFile);

			const cfgFile = path.join(repoDir, ".git", "config");
			const origCfg = fs.readFileSync(cfgFile, "utf8");
			fs.writeFileSync(cfgFile, origCfg + "\n[interactive]\n\tdiffFilter = evil\n");
			assert.throws(() => {
				spawnSync("git", ["status"], { cwd: repoDir });
			}, /EACCES/);
			fs.writeFileSync(cfgFile, origCfg);
		}

		// 4. Finding 3: NetSocket half-close (client.end("hello")) receives full echoed response from server
		const echoed = await new Promise((resolve, reject) => {
			const srv = net.createServer((sock) => {
				const chunks = [];
				sock.on("data", (c) => chunks.push(c));
				sock.on("end", () => {
					sock.end(Buffer.concat(chunks));
				});
			});
			srv.listen(0, "127.0.0.1", () => {
				const client = net.connect(srv.address().port, "127.0.0.1", () => {
					client.end("half-close-payload");
				});
				let out = "";
				client.on("data", (d) => { out += d.toString("utf8"); });
				client.on("end", () => {
					srv.close((cerr) => cerr ? reject(cerr) : resolve(out));
				});
				client.on("error", reject);
			});
		});
		assert.strictEqual(echoed, "half-close-payload");

		// 5. Finding 6: Duplex.writableLength tracks queued bytes without throwing TypeError
		const dup = new Duplex({
			read() {},
			write(chunk, enc, cb) { setTimeout(cb, 20); },
		});
		dup.write("abcd");
		dup.write("ef");
		assert.strictEqual(dup.writableLength, 6);

		// 6. Finding 7: http.get does not follow redirects by default, supports auth, and preserves Set-Cookie[]
		await new Promise((resolve, reject) => {
			let seenAuth = "";
			const srv = http.createServer((req, res) => {
				seenAuth = req.headers["authorization"] || "";
				res.writeHead(302, {
					"Location": "/redirected",
					"Set-Cookie": ["a=1; Path=/", "b=2; Path=/"],
				});
				res.end("redirect-body");
			});
			srv.listen(0, "127.0.0.1", () => {
				http.get({
					hostname: "127.0.0.1",
					port: srv.address().port,
					path: "/start",
					auth: "alice:secret",
				}, (res) => {
					try {
						assert.strictEqual(res.statusCode, 302);
						assert.strictEqual(res.headers.location, "/redirected");
						assert.deepStrictEqual(res.headers["set-cookie"], ["a=1; Path=/", "b=2; Path=/"]);
						assert.strictEqual(seenAuth, "Basic " + Buffer.from("alice:secret").toString("base64"));
						res.resume();
						res.on("end", () => srv.close(() => resolve()));
					} catch (e) {
						srv.close(() => reject(e));
					}
				}).on("error", reject);
			});
		});

		// 7. Finding 8: exec("cat", { input: "" }) closes stdin immediately and resolves
		const emptyCat = await new Promise((resolve, reject) => {
			exec("cat", { input: "", timeout: 1000 }, (err, stdout) => {
				if (err) return reject(err);
				resolve(stdout);
			});
		});
		assert.strictEqual(emptyCat, "");

		// 8. Finding 9: Buffer integer read/write range and bounds validation
		const b4 = Buffer.alloc(4);
		assert.throws(() => b4.readUInt32LE(1), (e) => e.code === "ERR_OUT_OF_RANGE");
		assert.throws(() => b4.readUIntLE(0, 7), (e) => e.code === "ERR_OUT_OF_RANGE");
		assert.throws(() => b4.writeUInt8(300, 0), (e) => e.code === "ERR_OUT_OF_RANGE");
		assert.throws(() => b4.writeInt8(-200, 0), (e) => e.code === "ERR_OUT_OF_RANGE");
		assert.throws(() => b4.writeUInt16LE(-1, 0), (e) => e.code === "ERR_OUT_OF_RANGE");

		// 9. Finding 10: fs.createReadStream with { end: 2 } and omitted start stops at index 2 (3 bytes)
		const rangeFile = path.join(process.cwd(), "range.txt");
		fs.writeFileSync(rangeFile, "0123456789");
		let rangeStr = "";
		for await (const chunk of fs.createReadStream(rangeFile, { end: 2, encoding: "utf8" })) {
			rangeStr += chunk;
		}
		assert.strictEqual(rangeStr, "012");

		// 10. Finding 12: process.stdin.read(4) on an empty live pipe returns null without blocking
		assert.strictEqual(process.stdin.read(4), null);

		console.log("ROUND11_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "main.mjs")
		o.JailRoots = []string{wsDir}
		o.Stdin = pr
		if exe, err := os.Executable(); err == nil {
			o.ExecPath = exe
		}
		o.Env = map[string]string{
			"OUTSIDE_SECRET": outsideSecret,
			"MANPAGER":       "cat",
			"BROWSER":        "echo",
		}
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 11 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "ROUND11_ALL_OK") {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round12AdversarialFixes(t *testing.T) {
	wsDir := t.TempDir()
	roSubDir := filepath.Join(wsDir, "readonly_sub")
	if err := os.MkdirAll(roSubDir, 0o755); err != nil {
		t.Fatal(err)
	}
	outsideDir := t.TempDir()
	outsideFile := filepath.Join(outsideDir, "escaped.txt")

	code, out, errOut, err := runJS(t, `
		import assert from "node:assert";
		import fs from "node:fs";
		import path from "node:path";
		import vm from "node:vm";

		const outsideFile = process.env.OUTSIDE_FILE;
		const roSubDir = process.env.RO_SUB_DIR;
		const childPath = path.join(process.cwd(), "child.js");
		fs.writeFileSync(childPath, [
			'const fs = require("node:fs");',
			'if (process.argv[2] === "outside") {',
			'  fs.writeFileSync(process.env.OUTSIDE_FILE, "PWN");',
			'} else if (process.argv[2] === "ro") {',
			'  fs.writeFileSync(require("node:path").join(process.env.RO_SUB_DIR, "inside.txt"), "PWN");',
			'}',
		].join("\n"));

		// 1. Finding 1: $.sync("__INDIRECT_JAIL_ROOTS= node child.js") & export must be rejected and cannot escape jail
		assert.throws(
			() => $.sync("__INDIRECT_JAIL_ROOTS= node child.js outside"),
			(e) => e.code === "EACCES" || (e.stderr && e.stderr.toString().includes("EACCES"))
		);
		assert.throws(
			() => $.sync("export __INDIRECT_JAIL_ROOTS=; node child.js outside"),
			(e) => e.code === "EACCES" || (e.stderr && e.stderr.toString().includes("EACCES"))
		);
		assert.strictEqual(fs.existsSync(outsideFile), false, "outside file must not be created");

		// 2. Finding 2: $.sync("__INDIRECT_READONLY_ROOTS= node child.js") & export must be rejected and cannot bypass read-only
		assert.throws(
			() => $.sync("__INDIRECT_READONLY_ROOTS= node child.js ro"),
			(e) => e.code === "EACCES" || (e.stderr && e.stderr.toString().includes("EACCES"))
		);
		assert.throws(
			() => $.sync("export __INDIRECT_READONLY_ROOTS=; node child.js ro"),
			(e) => e.code === "EACCES" || (e.stderr && e.stderr.toString().includes("EACCES"))
		);
		assert.strictEqual(fs.existsSync(path.join(roSubDir, "inside.txt")), false, "read-only file must not be created");

		// 3. Finding 3: process.env mutations on reserved/blocked keys throw EACCES
		assert.throws(() => { process.env.__INDIRECT_JAIL_ROOTS = ""; }, (e) => e.code === "EACCES");
		assert.throws(() => { process.env.__INDIRECT_READONLY_ROOTS = ""; }, (e) => e.code === "EACCES");
		assert.throws(() => { process.env.LD_PRELOAD = "evil.so"; }, (e) => e.code === "EACCES");
		assert.throws(() => { delete process.env.__INDIRECT_JAIL_ROOTS; }, (e) => e.code === "EACCES");
		assert.throws(() => { Object.defineProperty(process.env, "__INDIRECT_JAIL_ROOTS", { value: "" }); }, (e) => e.code === "EACCES");
		assert.strictEqual(Object.prototype.hasOwnProperty.call(process.env, "__INDIRECT_JAIL_ROOTS"), false);
		assert.strictEqual(Object.prototype.hasOwnProperty.call(process.env, "__INDIRECT_READONLY_ROOTS"), false);

		// 4. Finding 10: createReadStream / createWriteStream with autoClose: false expose stream.fd so caller can close it
		const acFile = path.join(process.cwd(), "autoclose.txt");
		const ws = fs.createWriteStream(acFile, { autoClose: false });
		await new Promise((resolve, reject) => {
			ws.on("error", reject);
			ws.end("hello-autoclose", () => resolve());
		});
		assert.strictEqual(typeof ws.fd, "number");
		fs.closeSync(ws.fd);

		const rs = fs.createReadStream(acFile, { autoClose: false, encoding: "utf8" });
		let readContent = "";
		for await (const chunk of rs) {
			readContent += chunk;
		}
		assert.strictEqual(readContent, "hello-autoclose");
		assert.strictEqual(typeof rs.fd, "number");
		fs.closeSync(rs.fd);

		// 5. Finding 12 & 13: 80 named VM contexts returning objects retained in main context without UAF or eviction crash
		const retained = [];
		for (let i = 0; i < 80; i++) {
			const ctx = vm.createContext({ idx: i });
			const obj = vm.runInContext("({ tag: 'ctx_' + idx, arr: [idx, idx + 1] })", ctx);
			retained.push({ ctx, obj });
		}
		for (let i = 0; i < 80; i++) {
			assert.strictEqual(retained[i].obj.tag, "ctx_" + i);
			assert.strictEqual(retained[i].obj.arr[1], i + 1);
		}

		// 6. Finding 14: Nested VM timeouts cannot clear or extend outer VM timeout
		assert.throws(() => {
			const outerCtx = vm.createContext({
				runInner: () => {
					vm.runInNewContext("1 + 1", {}, { timeout: 5000 });
				},
			});
			vm.runInContext("runInner(); while (true) {}", outerCtx, { timeout: 40 });
		}, (e) => e.code === "ERR_SCRIPT_EXECUTION_TIMEOUT");

		console.log("ROUND12_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "main.mjs")
		o.JailRoots = []string{wsDir}
		o.ReadOnlyRoots = []string{roSubDir}
		if exe, err := os.Executable(); err == nil {
			o.ExecPath = exe
		}
		o.Env = map[string]string{
			"OUTSIDE_FILE": outsideFile,
			"RO_SUB_DIR":   roSubDir,
		}
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 12 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "ROUND12_ALL_OK") {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round13AdversarialFixes(t *testing.T) {
	wsDir := t.TempDir()

	code, out, errOut, err := runJS(t, `
		import assert from "node:assert";
		import fs from "node:fs";
		import path from "node:path";
		import url from "node:url";
		import crypto from "node:crypto";
		import v8 from "node:v8";

		// 1. Finding 1: $ template literal interpolation of %VAR% must NOT expand env vars
		process.env.SECRET_PCT_VAR = "LEAKED_VALUE";
		const interp = "%SECRET_PCT_VAR%";
		const shOut = (await $`+"`echo ${interp}`"+`.quiet()).text().trim();
		assert.strictEqual(shOut, "%SECRET_PCT_VAR%");

		// 2. Finding 2: process.stdin.destroy() unrefs the event loop cleanly
		process.stdin.on("data", () => {});
		process.stdin.destroy();
		assert.strictEqual(process.stdin.destroyed, true);

		// 3. Finding 3: ReadableStream highWaterMark / desiredSize / locked
		let pullCalls = 0;
		const rs = new ReadableStream(
			{
				pull(ctrl) {
					pullCalls++;
					ctrl.enqueue(new Uint8Array([pullCalls]));
				},
			},
			{ highWaterMark: 2, size: () => 1 }
		);
		assert.strictEqual(rs.locked, false);
		const reader = rs.getReader();
		assert.strictEqual(rs.locked, true);
		const r1 = await reader.read();
		assert.deepStrictEqual(Array.from(r1.value), [1]);
		reader.releaseLock();
		assert.strictEqual(rs.locked, false);

		// 4. Finding 4: fs.createWriteStream rejects write after end()
		const wsFile = path.join(process.cwd(), "ws_after_end.txt");
		const ws = fs.createWriteStream(wsFile);
		let writeAfterEndErr = null;
		ws.on("error", (err) => {
			writeAfterEndErr = err;
		});
		ws.write("first");
		ws.end();
		const writeRet = ws.write("second", (err) => {
			if (err) writeAfterEndErr = err;
		});
		assert.strictEqual(writeRet, false);
		await new Promise((resolve) => ws.on("finish", resolve));
		assert.ok(writeAfterEndErr && writeAfterEndErr.code === "ERR_STREAM_WRITE_AFTER_END");
		assert.strictEqual(fs.readFileSync(wsFile, "utf8"), "first");

		// 5. Finding 5: fs.cpSync top-level symlink with dereference: false preserves symlink
		const symTarget = path.join(process.cwd(), "sym_target.txt");
		const symSrc = path.join(process.cwd(), "sym_src.txt");
		const symDst = path.join(process.cwd(), "sym_dst.txt");
		fs.writeFileSync(symTarget, "symlink-body");
		let symlinkSupported = true;
		try {
			fs.symlinkSync(symTarget, symSrc);
		} catch (_) {
			symlinkSupported = false;
		}
		if (symlinkSupported) {
			fs.cpSync(symSrc, symDst, { dereference: false });
			assert.strictEqual(fs.lstatSync(symDst).isSymbolicLink(), true);
		}

		// 6. Finding 6: fs.readSync / fstatSync validate fd type and range
		assert.throws(() => fs.readSync(undefined, Buffer.alloc(4), 0, 4, 0), (e) => e.code === "ERR_INVALID_ARG_TYPE");
		assert.throws(() => fs.readSync(null, Buffer.alloc(4), 0, 4, 0), (e) => e.code === "ERR_INVALID_ARG_TYPE");
		assert.throws(() => fs.readSync(-1, Buffer.alloc(4), 0, 4, 0), (e) => e.code === "ERR_OUT_OF_RANGE");
		assert.throws(() => fs.fstatSync("0"), (e) => e.code === "ERR_INVALID_ARG_TYPE");

		// 7. Finding 7: fs.watch with pre-aborted signal returns closed watcher and emits "close" on nextTick
		const ac = new AbortController();
		ac.abort();
		let watchClosed = false;
		const w = fs.watch(process.cwd(), { signal: ac.signal });
		w.on("close", () => { watchClosed = true; });
		await new Promise((r) => process.nextTick(r));
		assert.strictEqual(watchClosed, true);

		// 8. Finding 8: path.format normalizes dotless ext
		assert.strictEqual(path.posix.format({ name: "file", ext: "txt" }), "file.txt");
		assert.strictEqual(path.posix.format({ name: "file", ext: ".txt" }), "file.txt");

		// 9. Finding 9: path.win32.dirname and parse preserve Windows drive & UNC roots
		assert.strictEqual(path.win32.dirname("C:\\"), "C:\\");
		assert.strictEqual(path.win32.dirname("C:\\foo"), "C:\\");
		assert.strictEqual(path.win32.dirname("\\\\server\\share"), "\\\\server\\share");
		assert.strictEqual(path.win32.dirname("\\\\server\\share\\dir"), "\\\\server\\share\\");
		const parsedWin = path.win32.parse("C:\\foo\\bar.txt");
		assert.strictEqual(parsedWin.root, "C:\\");
		assert.strictEqual(parsedWin.dir, "C:\\foo");
		const parsedUnc = path.win32.parse("\\\\server\\share\\file.txt");
		assert.strictEqual(parsedUnc.root, "\\\\server\\share\\");

		// 10. Finding 10: url.resolve with relative base & URL dot-segment / host / % validation
		assert.strictEqual(url.resolve("/a/b/c", "../d"), "/a/d");
		assert.strictEqual(new URL("http://example.com/a/b/../c/./d").pathname, "/a/c/d");
		assert.throws(() => new URL("http://exa mple.com/"), (e) => e.code === "ERR_INVALID_URL");
		assert.strictEqual(new URL("http://example.com/%zz").pathname, "/%zz");

		// 11. Finding 11: url.parse(undefined) throws ERR_INVALID_ARG_TYPE
		assert.throws(() => url.parse(undefined), (e) => e.code === "ERR_INVALID_ARG_TYPE");
		assert.throws(() => url.parse(123), (e) => e.code === "ERR_INVALID_ARG_TYPE");

		// 12. Finding 12: TextDecoder encoding labels, UTF-16LE/BE, BOM, and streaming flush
		assert.throws(() => new TextDecoder("not-a-real-encoding"), (e) => e.code === "ERR_ENCODING_NOT_SUPPORTED");
		const td16 = new TextDecoder("utf-16");
		assert.strictEqual(td16.encoding, "utf-16le");
		assert.strictEqual(td16.decode(new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00])), "Hi");
		const td16be = new TextDecoder("utf-16be");
		assert.strictEqual(td16be.decode(new Uint8Array([0xfe, 0xff, 0x00, 0x48, 0x00, 0x69])), "Hi");
		const tdStream = new TextDecoder("utf-8");
		assert.strictEqual(tdStream.decode(new Uint8Array([0xe2]), { stream: true }), "");
		assert.strictEqual(tdStream.decode(), "\ufffd");

		// 13. Finding 13: crypto parameter validation
		assert.throws(() => crypto.createCipheriv("aes-999-cbc", Buffer.alloc(16), Buffer.alloc(16)), (e) => e.code === "ERR_CRYPTO_UNKNOWN_CIPHER");
		assert.throws(() => crypto.createCipheriv("aes-256-cbc", Buffer.alloc(16), Buffer.alloc(16)), (e) => e.code === "ERR_CRYPTO_INVALID_KEYLEN");
		assert.throws(() => crypto.createCipheriv("aes-256-cbc", Buffer.alloc(32), Buffer.alloc(12)), (e) => e.code === "ERR_CRYPTO_INVALID_IV");
		assert.throws(() => crypto.hkdfSync("sha256", "key", "salt", "info", Infinity), (e) => e.code === "ERR_OUT_OF_RANGE");
		assert.throws(() => crypto.pbkdf2Sync("pass", "salt", NaN, 32, "sha256"), (e) => e.code === "ERR_OUT_OF_RANGE");
		assert.throws(() => crypto.scryptSync("pass", "salt", -1), (e) => e.code === "ERR_OUT_OF_RANGE");

		// 14. Finding 14: v8.serialize / deserialize preserves Uint8Array, cyclic graphs, and __v8t user keys
		const u8 = new Uint8Array([10, 20, 30]);
		const desU8 = v8.deserialize(v8.serialize(u8));
		assert.strictEqual(desU8 instanceof Uint8Array, true);
		assert.strictEqual(Buffer.isBuffer(desU8), false);
		assert.deepStrictEqual(Array.from(desU8), [10, 20, 30]);

		const cyc = { name: "root", fake: { __v8t: "undef" } };
		cyc.self = cyc;
		const desCyc = v8.deserialize(v8.serialize(cyc));
		assert.strictEqual(desCyc.self, desCyc);
		assert.deepStrictEqual(desCyc.fake, { __v8t: "undef" });

		// 15. Finding 15: structuredClone clones Error and throws DataCloneError on functions/symbols
		const srcErr = new TypeError("bad type");
		srcErr.code = "E_CUSTOM";
		const clonedErr = structuredClone(srcErr);
		assert.strictEqual(clonedErr instanceof TypeError, true);
		assert.strictEqual(clonedErr.message, "bad type");
		assert.strictEqual(clonedErr.code, "E_CUSTOM");
		assert.throws(() => structuredClone(() => {}), (e) => e.name === "DataCloneError");
		assert.throws(() => structuredClone(Symbol("x")), (e) => e.name === "DataCloneError");

		// 16. Finding 16: new Request().signal is always an AbortSignal instance
		const req = new Request("https://example.com");
		assert.ok(req.signal && typeof req.signal.aborted === "boolean" && typeof req.signal.addEventListener === "function");

		console.log("ROUND13_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "main.mjs")
		o.JailRoots = []string{wsDir}
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 13 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "ROUND13_ALL_OK") {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round15AdversarialFixes(t *testing.T) {
	wsDir := t.TempDir()

	// Write BOM-prefixed JSON and ESM files for Finding 15
	bomJSON := append([]byte{0xEF, 0xBB, 0xBF}, []byte(`{"bomKey":"bomVal"}`)...)
	if err := os.WriteFile(filepath.Join(wsDir, "bom.json"), bomJSON, 0o644); err != nil {
		t.Fatal(err)
	}
	bomESM := append([]byte{0xEF, 0xBB, 0xBF}, []byte(`export const bomExport = 123;`)...)
	if err := os.WriteFile(filepath.Join(wsDir, "bom_mod.mjs"), bomESM, 0o644); err != nil {
		t.Fatal(err)
	}

	// Start a local self-signed HTTPS server for Finding 9 & 17
	tlsSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("echo:" + string(body)))
	}))
	defer tlsSrv.Close()

	// 1. Main Round 15 suite
	code, out, errOut, err := runJS(t, `
		import assert from "node:assert";
		import strictAssert from "node:assert/strict";
		import fs from "node:fs";
		import path from "node:path";
		import url, { fileURLToPath } from "node:url";
		import { createRequire } from "node:module";
		import { Readable, Writable } from "node:stream";
		import https from "node:https";
		import http from "node:http";
		import zlib from "node:zlib";
		import vm from "node:vm";
		import { bomExport } from "./bom_mod.mjs";

		// Finding 1: Unreferenced TypedArray view over ArrayBuffer in host call
		for (let i = 0; i < 20; i++) {
			fs.writeFileSync(
				path.join(process.cwd(), "ab_view.bin"),
				new Uint8Array(new ArrayBuffer(4096)).subarray(100, 200)
			);
		}
		assert.strictEqual(fs.statSync(path.join(process.cwd(), "ab_view.bin")).size, 100);

		// Finding 6, 13, 14, 21: Stream Writable backpressure, end callback on error, Readable.read(n), deferred error
		const written = [];
		const w = new Writable({
			highWaterMark: 4,
			write(chunk, enc, cb) {
				written.push(chunk.toString());
				setTimeout(cb, 5);
			}
		});
		assert.strictEqual(w.write("abcd"), false);
		await new Promise((resolve) => w.once("drain", resolve));
		assert.deepStrictEqual(written, ["abcd"]);

		// Writable.end callback invoked even when _write errors
		const errW = new Writable({
			write(chunk, enc, cb) {
				cb(new Error("write_boom"));
			}
		});
		errW.on("error", () => {});
		const endErr = await new Promise((resolve) => {
			errW.end("bad", (e) => resolve(e));
		});
		assert.ok(endErr && endErr.message === "write_boom");

		// Readable.read(size) returns null when buffered < size and not ended
		const r = new Readable({ read() {} });
		r.push("ab");
		assert.strictEqual(r.read(5), null);
		r.push("cde");
		assert.strictEqual(r.read(5).toString(), "abcde");

		// Stream destroy(err) defers error to nextTick so chained .on("error") catches it
		let caughtDestroy = null;
		const dStream = new Readable({ read() {} });
		dStream.destroy(new Error("deferred_boom")).on("error", (e) => { caughtDestroy = e; });
		await new Promise((resolve) => process.nextTick(resolve));
		assert.ok(caughtDestroy && caughtDestroy.message === "deferred_boom");

		// Finding 7 & 15: createRequire(import.meta.url) + BOM-prefixed JSON & ESM
		const req = createRequire(import.meta.url);
		const bomData = req("./bom.json");
		assert.strictEqual(bomData.bomKey, "bomVal");
		assert.strictEqual(bomExport, 123);

		// Finding 9 & 17: https rejectUnauthorized: false + fetch with ReadableStream body
		const tlsUrl = process.env.TLS_URL;
		const httpsBody = await new Promise((resolve, reject) => {
			const hreq = https.request(tlsUrl, { method: "POST", rejectUnauthorized: false }, (res) => {
				let d = "";
				res.on("data", (c) => { d += c; });
				res.on("end", () => resolve(d));
			});
			hreq.on("error", reject);
			hreq.end("hello-tls");
		});
		assert.strictEqual(httpsBody, "echo:hello-tls");

		const streamBody = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("stream-"));
				controller.enqueue(new TextEncoder().encode("payload"));
				controller.close();
			}
		});
		const fetchRes = await fetch(tlsUrl, {
			method: "POST",
			body: streamBody,
			duplex: "half",
			rejectUnauthorized: false,
		});
		assert.strictEqual(await fetchRes.text(), "echo:stream-payload");

		// Finding 10: URL relative auth preservation, raw search, Punycode domainToASCII/Unicode
		const relUrl = new URL("?raw=1&b=two%20words", "http://alice:secret@example.com/dir/index.html");
		assert.strictEqual(relUrl.username, "alice");
		assert.strictEqual(relUrl.password, "secret");
		assert.strictEqual(relUrl.search, "?raw=1&b=two%20words");
		assert.strictEqual(url.domainToASCII("münchen.de"), "xn--mnchen-3ya.de");
		assert.strictEqual(url.domainToUnicode("xn--mnchen-3ya.de"), "münchen.de");

		// Finding 11 & 12: assert/strict vs assert, and Map/Set/vm deepStrictEqual
		assert.equal(1, "1");
		assert.throws(() => strictAssert.equal(1, "1"));
		assert.deepStrictEqual(new Map([[{ k: 1 }, "v"]]), new Map([[{ k: 1 }, "v"]]));
		assert.deepStrictEqual(new Set([{ s: 1 }]), new Set([{ s: 1 }]));
		const vmMap = vm.runInNewContext("new Map([['a', 1]])");
		assert.deepStrictEqual(vmMap, new Map([["a", 1]]));
		assert.strictEqual(vm.runInNewContext("typeof console.log"), "function");

		// Finding 16: fs.readdirSync ENOTDIR on file, fs.globSync("dir/**"), invalid encoding
		const regFile = path.join(process.cwd(), "regular.txt");
		fs.writeFileSync(regFile, "hi");
		assert.throws(() => fs.readdirSync(regFile), (e) => e.code === "ENOTDIR");
		assert.throws(() => fs.readFileSync(regFile, "invalid-enc-xyz"), (e) => e.code === "ERR_INVALID_ARG_VALUE");

		const globSub = path.join(process.cwd(), "globdir", "nested");
		fs.mkdirSync(globSub, { recursive: true });
		fs.writeFileSync(path.join(globSub, "f.txt"), "1");
		const globMatches = fs.globSync("globdir/**").map((p) => p.replace(/\\/g, "/"));
		assert.ok(globMatches.includes("globdir"));
		assert.ok(globMatches.some((p) => p.endsWith("nested/f.txt")));

		// Finding 18: Buffer.from hex validation and array-like object
		assert.strictEqual(Buffer.from("zzzz", "hex").length, 0);
		assert.strictEqual(Buffer.from("4142zz", "hex").toString(), "AB");
		assert.strictEqual(Buffer.from({ length: 3, 0: 65, 1: 66, 2: 67 }).toString(), "ABC");

		// Finding 20: path.win32.toNamespacedPath and Windows UNC fileURLToPath
		assert.strictEqual(path.win32.toNamespacedPath("C:\\foo\\bar"), "\\\\?\\C:\\foo\\bar");
		if (process.platform === "win32") {
			assert.strictEqual(fileURLToPath("file://server/share/dir/file.txt"), "\\\\server\\share\\dir\\file.txt");
			process.env.ROUND15_CASE_TEST = "ok123";
			assert.strictEqual(process.env.round15_case_test, "ok123");
		}

		// Low nits: zlib brotli & maxOutputLength, http.Server.listening
		const br = zlib.brotliCompressSync(Buffer.from("hello brotlihello brotli"));
		assert.strictEqual(zlib.brotliDecompressSync(br).toString(), "hello brotlihello brotli");
		assert.throws(
			() => zlib.gunzipSync(zlib.gzipSync(Buffer.alloc(1024, "a")), { maxOutputLength: 100 }),
			(e) => e.code === "ERR_BUFFER_TOO_LARGE"
		);

		const hSrv = http.createServer((_req, res) => res.end("ok"));
		assert.strictEqual(hSrv.listening, false);
		await new Promise((resolve) => hSrv.listen(0, "127.0.0.1", resolve));
		assert.strictEqual(hSrv.listening, true);
		await new Promise((resolve) => hSrv.close(resolve));
		assert.strictEqual(hSrv.listening, false);

		console.log("ROUND15_MAIN_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "round15.mjs")
		o.Env = map[string]string{"TLS_URL": tlsSrv.URL}
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 15 main test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "ROUND15_MAIN_OK") {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}

	// 2. Finding 3 & 8: beforeExit async scheduling + process.exit(0) with active net server & socket (no deadlock)
	code2, out2, errOut2, err2 := runJS(t, `
		import net from "node:net";
		let beforeExitRan = false;
		process.on("beforeExit", () => {
			if (!beforeExitRan) {
				beforeExitRan = true;
				Promise.resolve().then(() => {
					const srv = net.createServer((sock) => {
						sock.write("hi");
					});
					srv.listen(0, "127.0.0.1", () => {
						const c = net.connect(srv.address().port, "127.0.0.1", () => {
							console.log("EXITING_WITH_ACTIVE_NET");
							process.exit(0);
						});
					});
				});
			}
		});
	`)
	if err2 != nil || code2 != 0 || !strings.Contains(out2, "EXITING_WITH_ACTIVE_NET") {
		t.Fatalf("Finding 3/8 test failed (code=%d, out=%q, stderr=%s): %v", code2, out2, errOut2, err2)
	}

	// 3. Finding 5: Delayed stdin pipe for fs.readFileSync(0, "utf8")
	pr, pw, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		time.Sleep(80 * time.Millisecond)
		_, _ = pw.Write([]byte("delayed-stdin-content"))
		_ = pw.Close()
	}()
	code3, out3, errOut3, err3 := runJS(t, `
		import fs from "node:fs";
		console.log("STDIN:" + fs.readFileSync(0, "utf8"));
	`, func(o *ScriptOptions) {
		o.Stdin = pr
	})
	_ = pr.Close()
	if err3 != nil || code3 != 0 || strings.TrimSpace(out3) != "STDIN:delayed-stdin-content" {
		t.Fatalf("Finding 5 delayed stdin failed (code=%d, out=%q, stderr=%s): %v", code3, out3, errOut3, err3)
	}

	// 4. Finding 2: ReadOnly sandbox blocks git -C commit and nested sh -c in child_process even without JailRoots
	code4, out4, errOut4, err4 := runJS(t, `
		import assert from "node:assert";
		import { spawnSync } from "node:child_process";
		assert.throws(() => spawnSync("git", ["-C", ".", "commit", "-m", "nope"]), (e) => e.code === "EACCES");
		assert.throws(() => spawnSync("sh", ["-c", "rm -rf /"]), (e) => e.code === "EACCES");
		console.log("READONLY_SPAWN_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.ReadOnlyRoots = []string{wsDir}
	})
	if err4 != nil || code4 != 0 || strings.TrimSpace(out4) != "READONLY_SPAWN_OK" {
		t.Fatalf("Finding 2 ReadOnly spawn test failed (code=%d, out=%q, stderr=%s): %v", code4, out4, errOut4, err4)
	}
}

func TestRunScript_Round16AdversarialFixes(t *testing.T) {
	wsDir := t.TempDir()
	roNested := filepath.Join(wsDir, "parent", "ro_child")
	if err := os.MkdirAll(roNested, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(roNested, "protected.txt"), []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}

	code, out, errOut, err := runJS(t, `
		import assert from "node:assert/strict";
		import fs from "node:fs";
		import path from "node:path";
		import os from "node:os";
		import zlib from "node:zlib";
		import vm from "node:vm";

		// H1: RFC 7932 Brotli wire format compatibility
		const brHello = zlib.brotliCompressSync("hello");
		assert.strictEqual(brHello.toString("hex"), "0b028068656c6c6f03");
		assert.strictEqual(
			zlib.brotliDecompressSync(Buffer.from("0b028068656c6c6f03", "hex")).toString(),
			"hello"
		);
		const bigText = "Brotli RFC 7932 payload ".repeat(500);
		assert.strictEqual(zlib.brotliDecompressSync(zlib.brotliCompressSync(bigText)).toString(), bigText);

		// H2: UTF-16LE/BE TextDecoder isolated surrogates & streaming surrogate pairs
		assert.strictEqual(new TextDecoder("utf-16le").decode(new Uint8Array([0x3d, 0xd8])), "\uFFFD");
		assert.throws(
			() => new TextDecoder("utf-16le", { fatal: true }).decode(new Uint8Array([0x3d, 0xd8])),
			(e) => e.code === "ERR_ENCODING_INVALID_ENCODED_DATA"
		);
		const td16Stream = new TextDecoder("utf-16le");
		assert.strictEqual(td16Stream.decode(new Uint8Array([0x3d, 0xd8]), { stream: true }), "");
		assert.strictEqual(td16Stream.decode(new Uint8Array([0x00, 0xde])), "\uD83D\uDE00");

		// H3: Buffer.prototype.write range & type validation + multi-byte UTF-8 boundary
		assert.throws(() => Buffer.alloc(2).write("x", 100, 1), (e) => e.code === "ERR_OUT_OF_RANGE");
		assert.throws(() => Buffer.alloc(2).write("x", 1.5, 1), (e) => e.code === "ERR_OUT_OF_RANGE");
		assert.throws(() => Buffer.alloc(2).write("x", 0, 100), (e) => e.code === "ERR_OUT_OF_RANGE");
		assert.strictEqual(Buffer.alloc(2).write("€", 0, 2, "utf8"), 0);

		// M1: WHATWG URL percent-encoding, setters, and URLSearchParams.toString()
		const u = new URL("https://x/é");
		assert.strictEqual(u.pathname, "/%C3%A9");
		u.pathname = "/a b";
		u.hash = "a b";
		assert.strictEqual(u.href, "https://x/a%20b#a%20b");
		assert.strictEqual(new URLSearchParams({ q: "!*'()~-. _" }).toString(), "q=%21*%27%28%29%7E-.+_");

		// M2: Fetch Request/Response .body and GET/HEAD body rejection
		assert.strictEqual(new Response(null).body, null);
		assert.strictEqual(new Response().body, null);
		assert.strictEqual(new Request("https://x", { method: "POST", body: "a" }).body instanceof ReadableStream, true);
		assert.strictEqual(new Request("https://x").body, null);
		assert.throws(() => new Request("https://x", { method: "GET", body: "a" }), TypeError);
		assert.throws(() => new Request("https://x", { method: "HEAD", body: "a" }), TypeError);

		// M4: Ancestor rmSync/renameSync cannot delete or move a nested ReadOnlyRoot
		const parentDir = path.join(process.cwd(), "parent");
		assert.throws(() => fs.rmSync(parentDir, { recursive: true, force: true }), (e) => e.code === "EACCES");
		assert.throws(() => fs.renameSync(parentDir, path.join(process.cwd(), "parent_moved")), (e) => e.code === "EACCES");
		assert.strictEqual(fs.readFileSync(path.join(parentDir, "ro_child", "protected.txt"), "utf8"), "keep");

		// M5: 5000 vm.runInNewContext calls returning objects do not hit the 4096 VM context limit
		for (let i = 0; i < 5000; i++) {
			const res = vm.runInNewContext("({ a: 1 })");
			if (i === 4999) assert.strictEqual(res.a, 1);
		}
		const ctxBox = {};
		vm.runInNewContext("globalThis.val = 99", ctxBox);
		assert.strictEqual(vm.isContext(ctxBox), true);
		assert.strictEqual(ctxBox.val, 99);

		// L1, L2, L5, L6: readFileSync flag, statSync bigint, os.cpus, path.win32.parse
		const sampleFile = path.join(process.cwd(), "sample.txt");
		fs.writeFileSync(sampleFile, "hello");
		assert.throws(() => fs.readFileSync(sampleFile, { flag: "wx" }), (e) => e.code === "EEXIST");
		assert.throws(
			() => fs.readFileSync(path.join(parentDir, "ro_child", "protected.txt"), { flag: "w+" }),
			(e) => e.code === "EACCES"
		);
		const biStat = fs.statSync(sampleFile, { bigint: true });
		assert.strictEqual(typeof biStat.size, "bigint");
		assert.strictEqual(biStat.size, 5n);
		assert.strictEqual(typeof biStat.mtimeNs, "bigint");
		assert.ok(os.cpus()[0].times.idle > 0);
		assert.strictEqual(path.win32.parse("C:/foo/bar.txt").root, "C:/");
		assert.strictEqual(path.win32.dirname("C:/foo"), "C:/");

		console.log("ROUND16_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "round16.mjs")
		o.JailRoots = []string{wsDir}
		o.ReadOnlyRoots = []string{roNested}
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 16 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "ROUND16_ALL_OK") {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round17AdversarialFixes(t *testing.T) {
	wsDir := t.TempDir()

	code, out, errOut, err := runJS(t, `
		import assert from "node:assert/strict";
		import vm from "node:vm";
		import { spawn, spawnSync } from "node:child_process";

		// 1. 5000 vm.runInNewContext calls that throw or schedule microtasks must not leak contexts or hit the 4096 limit
		for (let i = 0; i < 5000; i++) {
			try {
				vm.runInNewContext("throw new Error('boom_" + i + "')");
			} catch (_) {}
		}
		for (let i = 0; i < 200; i++) {
			vm.runInNewContext("Promise.resolve().then(() => {}); ({ x: 1 })");
		}
		await new Promise((r) => setTimeout(r, 10));
		for (let i = 0; i < 4200; i++) {
			vm.runInNewContext("({ ok: true })");
		}

		// 2. vm.runInThisContext evaluates in the current global realm with timeout support
		globalThis.__round17_global = 41;
		assert.strictEqual(vm.runInThisContext("__round17_global + 1"), 42);
		assert.throws(
			() => vm.runInThisContext("while (true) {}", { timeout: 25 }),
			(e) => e.code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
		);

		// 3. Bare native tools on PATH (e.g. go version) work inside $ and child_process
		const whichGo = await $`+"`which go`"+`.nothrow().quiet();
		if (whichGo.exitCode === 0) {
			const goVer = await $`+"`go version`"+`.quiet().text();
			assert.ok(goVer.includes("go version"));
			const cpGo = spawnSync("go", ["version"], { encoding: "utf8" });
			assert.strictEqual(cpGo.status, 0);
			assert.ok(cpGo.stdout.includes("go version"));
		}

		// 4. Streaming >64 MiB (70 MiB) to child.stdin completes without data loss or ENOBUFS
		if (process.execPath) {
			const child = spawn(process.execPath, [
				"--js",
				"-e",
				"let total = 0; process.stdin.on('data', (c) => { total += c.length; }); process.stdin.on('end', () => { console.log(String(total)); });",
			]);
			let childOut = "";
			child.stdout.on("data", (d) => { childOut += d.toString("utf8"); });
			const chunk = Buffer.alloc(5 * 1024 * 1024, 0x61);
			for (let i = 0; i < 14; i++) {
				child.stdin.write(chunk);
			}
			child.stdin.end();
			const exitCode = await new Promise((resolve, reject) => {
				child.on("error", reject);
				child.on("close", (c) => resolve(c));
			});
			assert.strictEqual(exitCode, 0);
			assert.strictEqual(Number(childOut.trim()), 70 * 1024 * 1024);
		}

		console.log("ROUND17_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "round17.mjs")
		o.JailRoots = []string{wsDir}
		if exe, err := os.Executable(); err == nil {
			o.ExecPath = exe
		}
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 17 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "ROUND17_ALL_OK") {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round18AdversarialFixes(t *testing.T) {
	wsDir := t.TempDir()
	code, out, errOut, err := runJS(t, `
		import assert from "node:assert";
		import { EventEmitter, once, on } from "node:events";
		import { Readable, Writable, PassThrough, pipeline, finished } from "node:stream";
		import fs from "node:fs";
		import fsp from "node:fs/promises";
		import crypto from "node:crypto";
		import zlib from "node:zlib";
		import util from "node:util";
		import http from "node:http";
		import readline from "node:readline";
		import rlp from "node:readline/promises";
		import tls from "node:tls";
		import http2 from "node:http2";
		import cluster from "node:cluster";

		// 1. Intl APIs + toLocaleString / localeCompare
		assert.strictEqual(typeof Intl, "object");
		assert.strictEqual(new Intl.NumberFormat("en-US").format(1234567.89), "1,234,567.89");
		assert.ok(new Intl.DateTimeFormat("en-US", { year: "numeric" }).format(new Date("2026-05-15T12:00:00Z")).includes("2026"));
		assert.strictEqual(new Intl.Collator("en").compare("a", "b"), -1);
		assert.strictEqual(new Intl.PluralRules("en").select(1), "one");
		assert.strictEqual(new Intl.PluralRules("en").select(2), "other");
		assert.strictEqual(Array.from(new Intl.Segmenter("en", { granularity: "word" }).segment("hi there")).length, 3);
		assert.strictEqual(new Intl.ListFormat("en").format(["a", "b", "c"]), "a, b, and c");
		assert.strictEqual(new Intl.RelativeTimeFormat("en").format(-1, "day"), "1 day ago");
		assert.deepStrictEqual(Intl.getCanonicalLocales("EN_us"), ["en-US"]);
		assert.strictEqual((12345).toLocaleString("en-US"), "12,345");
		assert.strictEqual("a".localeCompare("b", "en"), -1);

		// 2. EventEmitter.once / on with signal, EventTarget signal, AbortSignal.any
		{
			const ee = new EventEmitter();
			const ac = new AbortController();
			const p = once(ee, "ping", { signal: ac.signal });
			ac.abort();
			await assert.rejects(p, (e) => e.name === "AbortError");
		}
		{
			const et = new EventTarget();
			const ac = new AbortController();
			let count = 0;
			et.addEventListener("x", () => { count++; }, { signal: ac.signal });
			ac.abort();
			et.dispatchEvent(new Event("x"));
			assert.strictEqual(count, 0);
		}
		{
			const ac1 = new AbortController();
			const ac2 = new AbortController();
			const combined = AbortSignal.any([ac1.signal, ac2.signal]);
			assert.strictEqual(combined.aborted, false);
			ac2.abort("stop-now");
			assert.strictEqual(combined.aborted, true);
			assert.strictEqual(combined.reason, "stop-now");
		}

		// 3. process.umask, navigator, util.inspect({ depth: null })
		assert.strictEqual(typeof process.umask(), "number");
		assert.strictEqual(typeof navigator, "object");
		assert.ok(navigator.userAgent.includes("Node.js"));
		{
			const deep = { a: { b: { c: { d: { e: 42 } } } } };
			assert.ok(util.inspect(deep, { depth: null }).includes("42"));
		}

		// 4. Node Streams: Readable.from objectMode & cleanup, empty createReadStream, pipe, pipeline
		{
			let cleanedUp = false;
			function* gen() {
				try {
					yield { id: 1 };
					yield { id: 2 };
					yield { id: 3 };
				} finally {
					cleanedUp = true;
				}
			}
			const r = Readable.from(gen());
			assert.strictEqual(r.readableObjectMode, true);
			for await (const item of r) {
				assert.strictEqual(item.id, 1);
				break;
			}
			assert.strictEqual(cleanedUp, true);
		}
		{
			fs.writeFileSync("empty.txt", "");
			const rs = fs.createReadStream("empty.txt");
			let ended = false;
			rs.on("data", () => {});
			await new Promise((resolve, reject) => {
				rs.on("end", () => { ended = true; resolve(); });
				rs.on("error", reject);
			});
			assert.strictEqual(ended, true);
		}
		{
			const chunks = [];
			const dest = new Writable({
				objectMode: true,
				write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
			});
			await new Promise((resolve, reject) => {
				pipeline([Readable.from(["x", "y"]), new PassThrough({ objectMode: true }), dest], (err) => {
					if (err) reject(err); else resolve();
				});
			});
			assert.deepStrictEqual(chunks, ["x", "y"]);
		}

		// 5. Web Streams: TextEncoderStream, TextDecoderStream, CompressionStream, DecompressionStream, ReadableStream.from
		{
			const rs = ReadableStream.from(["hello ", "world"]);
			const compressed = rs.pipeThrough(new TextEncoderStream()).pipeThrough(new CompressionStream("gzip"));
			const decompressed = compressed.pipeThrough(new DecompressionStream("gzip")).pipeThrough(new TextDecoderStream());
			let text = "";
			for await (const chunk of decompressed) {
				text += chunk;
			}
			assert.strictEqual(text, "hello world");
			assert.strictEqual(new ByteLengthQueuingStrategy({ highWaterMark: 16 }).size(new Uint8Array(5)), 5);
			assert.strictEqual(new CountQueuingStrategy({ highWaterMark: 4 }).size("anything"), 1);
		}

		// 6. fs.opendirSync / fs.promises.opendir & AbortSignal & chmodSync validation
		{
			const dir = fs.opendirSync(".");
			const entry = dir.readSync();
			assert.ok(entry !== null);
			dir.closeSync();

			const fspDir = await fsp.opendir(".");
			const entries = [];
			for await (const d of fspDir) {
				entries.push(d.name);
			}
			assert.ok(entries.includes("empty.txt"));

			const ac = new AbortController();
			ac.abort();
			await assert.rejects(fsp.readFile("empty.txt", { signal: ac.signal }), (e) => e.name === "AbortError");
			assert.throws(() => fs.chmodSync("empty.txt", "invalid-mode"), (e) => e.code === "ERR_INVALID_ARG_VALUE");
		}

		// 7. crypto.timingSafeEqual & zlib.crc32
		assert.throws(
			() => crypto.timingSafeEqual(Buffer.from("abc"), Buffer.from("ab")),
			(e) => e instanceof RangeError && e.code === "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH"
		);
		assert.throws(
			() => crypto.timingSafeEqual("abc", "abc"),
			(e) => e instanceof TypeError && e.code === "ERR_INVALID_ARG_TYPE"
		);
		assert.strictEqual(zlib.crc32("hello"), 0x3610a686);

		// 8. HTTP server + fetch (unconsumed body, BOM stripping, writeHead tuple headers & ERR_HTTP_HEADERS_SENT)
		{
			const bomRes = new Response(new Uint8Array([0xef, 0xbb, 0xbf, 0x6f, 0x6b]));
			assert.strictEqual(await bomRes.text(), "ok");

			const srv = http.createServer(async (req, res) => {
				await new Promise((r) => setTimeout(r, 5));
				let body = "";
				req.on("data", (c) => { body += c.toString(); });
				await new Promise((r) => req.on("end", r));
				res.writeHead(200, [["X-Custom", "tuple-ok"], ["Content-Type", "text/plain"]]);
				assert.throws(() => res.writeHead(200), (e) => e.code === "ERR_HTTP_HEADERS_SENT");
				res.end("echo:" + body + ":" + "x".repeat(128 * 1024));
			});
			await new Promise((r) => srv.listen(0, "127.0.0.1", r));
			const port = srv.address().port;
			const resp = await fetch("http://127.0.0.1:" + port, { method: "POST", body: "hi" });
			assert.strictEqual(resp.headers.get("x-custom"), "tuple-ok");
			// Intentionally do NOT consume resp.body to ensure releaseHeaderRef allows clean close
			await new Promise((r) => srv.close(r));
		}

		// 9. readline, readline/promises, tls, http2, cluster
		{
			const rl = rlp.createInterface({ input: Readable.from(["line1\nline2\n"]) });
			const lines = [];
			for await (const l of rl) {
				lines.push(l);
			}
			assert.deepStrictEqual(lines, ["line1", "line2"]);
			assert.strictEqual(typeof readline.createInterface, "function");
			assert.strictEqual(typeof tls.connect, "function");
			assert.strictEqual(typeof http2.constants.HTTP2_HEADER_PATH, "string");
			assert.strictEqual(cluster.isPrimary, true);
		}

		// 10. Shell $ expansions, control flow, redirections, and builtins
		{
			const arith = await $` + "`echo $(( (2 + 3) * 4 ))`" + `.text();
			assert.strictEqual(arith.trim(), "20");

			const subst = await $` + "`X=hello_world; echo \\${#X} \\${X#hello_} \\${X%_world} \\${X/world/js}`" + `.text();
			assert.strictEqual(subst.trim(), "11 world hello hello_js");

			const cmdSub = await $` + "`echo $(echo nested)-$(echo ok)`" + `.text();
			assert.strictEqual(cmdSub.trim(), "nested-ok");

			const braces = await $` + "`echo {a,b}{1..2}`" + `.text();
			assert.strictEqual(braces.trim(), "a1 a2 b1 b2");

			const ctrl = await $` + "`" + `
				out=""
				for i in 1 2 3; do
					if [ "$i" -eq 2 ]; then
						out="\${out}two,"
					else
						case "$i" in
							1) out="\${out}one," ;;
							*) out="\${out}other" ;;
						esac
					fi
				done
				echo "$out"
			` + "`" + `.text();
			assert.strictEqual(ctrl.trim(), "one,two,other");

			const subshellRes = await $` + "`X=outer; (X=inner; echo -n $X); echo :$X`" + `.text();
			assert.strictEqual(subshellRes.trim(), "inner:outer");

			const hereRes = await $` + "`cat <<< 'herestring-ok'`" + `.text();
			assert.strictEqual(hereRes.trim(), "herestring-ok");

			const redirRes = await $` + "`echo err-msg 1>&2`" + `.nothrow().quiet();
			assert.strictEqual(redirRes.stderr.toString().trim(), "err-msg");

			const echoE = await $` + "`echo -e 'a\\tb'`" + `.text();
			assert.strictEqual(echoE.trim(), "a\tb");

			const dateY = await $` + "`date +%Y`" + `.text();
			assert.strictEqual(dateY.trim().length, 4);

			fs.writeFileSync("sample.txt", "alpha\nbeta\ngamma\n");
			const headC = await $` + "`head -c 5 sample.txt`" + `.text();
			assert.strictEqual(headC, "alpha");
			const tailC = await $` + "`tail -c 6 sample.txt`" + `.text();
			assert.strictEqual(tailC, "gamma\n");
			const wcOut = await $` + "`wc -l sample.txt`" + `.text();
			assert.ok(wcOut.trim().endsWith("sample.txt") && wcOut.trim().startsWith("3 "));
			const grepL = await $` + "`grep -l -e beta sample.txt`" + `.text();
			assert.strictEqual(grepL.trim(), "sample.txt");
		}

		console.log("ROUND18_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "round18.mjs")
		o.JailRoots = []string{wsDir}
		if exe, err := os.Executable(); err == nil {
			o.ExecPath = exe
		}
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 18 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "ROUND18_ALL_OK") {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round19AdversarialFixes(t *testing.T) {
	wsDir := t.TempDir()

	// Write an ESM module to test require(esm)
	esmModPath := filepath.Join(wsDir, "sync_esm.mjs")
	if err := os.WriteFile(esmModPath, []byte(`export const answer = 42; export default "esm-default";`), 0o644); err != nil {
		t.Fatal(err)
	}

	code, out, errOut, err := runJS(t, `
		import assert from "node:assert/strict";
		import fs from "node:fs";
		import path from "node:path";
		import crypto from "node:crypto";
		import zlib from "node:zlib";
		import util from "node:util";
		import vm from "node:vm";
		import { AsyncLocalStorage } from "node:async_hooks";
		import { createRequire } from "node:module";
		import { Worker } from "node:worker_threads";

		// 1. ESM globals isolation: require, module, exports, __dirname, __filename are undefined in ESM
		assert.strictEqual(typeof require, "undefined");
		assert.strictEqual(typeof module, "undefined");
		assert.strictEqual(typeof exports, "undefined");
		assert.strictEqual(typeof __dirname, "undefined");
		assert.strictEqual(typeof __filename, "undefined");

		// 2. require(esm) synchronous loading via createRequire
		const req = createRequire(import.meta.url);
		const esmNs = req("./sync_esm.mjs");
		assert.strictEqual(esmNs.answer, 42);
		assert.strictEqual(esmNs.default, "esm-default");
		assert.strictEqual(req("node:sys"), util);

		// 3. Error.prototype.stack includes header "ErrorName: message"
		const boom = new Error("boom-msg-19");
		assert.ok(boom.stack.includes("Error: boom-msg-19"), "stack was: " + boom.stack);

		// 4. vm timeout does not misclassify user Error("interrupted")
		assert.throws(
			() => vm.runInNewContext('throw new Error("interrupted")', {}, { timeout: 500 }),
			(e) => e.message === "interrupted" && e.code !== "ERR_SCRIPT_EXECUTION_TIMEOUT"
		);

		// 5. AsyncLocalStorage across multiple native async/await boundaries & concurrent tasks
		{
			const als = new AsyncLocalStorage();
			const results = await Promise.all([
				als.run("ctx-A", async () => {
					const s1 = als.getStore();
					await new Promise((r) => setTimeout(r, 10));
					const s2 = als.getStore();
					await Promise.resolve();
					const s3 = als.getStore();
					return [s1, s2, s3];
				}),
				als.run("ctx-B", async () => {
					const s1 = als.getStore();
					await new Promise((r) => setTimeout(r, 5));
					const s2 = als.getStore();
					await Promise.resolve();
					const s3 = als.getStore();
					return [s1, s2, s3];
				}),
			]);
			assert.deepStrictEqual(results[0], ["ctx-A", "ctx-A", "ctx-A"]);
			assert.deepStrictEqual(results[1], ["ctx-B", "ctx-B", "ctx-B"]);
			assert.strictEqual(als.getStore(), undefined);
		}

		// 6. Microtask vs nextTick ordering & timer refresh() after expiry + FIFO ordering
		{
			const order = [];
			process.nextTick(() => {
				order.push("nt1");
				Promise.resolve().then(() => order.push("p_in_nt1"));
			});
			process.nextTick(() => order.push("nt2"));
			await new Promise((r) => setTimeout(r, 20));
			assert.deepStrictEqual(order, ["nt1", "nt2", "p_in_nt1"]);

			let timerCount = 0;
			const tm = setTimeout(() => { timerCount++; }, 10);
			await new Promise((r) => setTimeout(r, 25));
			assert.strictEqual(timerCount, 1);
			tm.refresh();
			await new Promise((r) => setTimeout(r, 25));
			assert.strictEqual(timerCount, 2);
		}

		// 7. TextDecoder windows-1252, URL %zz, Buffer.byteLength validation, util.inspect getters, SharedArrayBuffer clone, Intl de-DE
		assert.strictEqual(new TextDecoder("latin1").decode(new Uint8Array([0x80, 0xe9])), "€é");
		assert.strictEqual(new URL("http://example.com/%zz/a").pathname, "/%zz/a");
		assert.throws(() => Buffer.byteLength(123), (e) => e.code === "ERR_INVALID_ARG_TYPE");
		{
			let getterCalled = false;
			const objWithGetter = { get secret() { getterCalled = true; return 1; } };
			const inspected = util.inspect(objWithGetter);
			assert.strictEqual(getterCalled, false);
			assert.ok(inspected.includes("[Getter]"));
		}
		if (typeof SharedArrayBuffer !== "undefined") {
			const sab = new SharedArrayBuffer(4);
			new Uint8Array(sab).set([1, 2, 3, 4]);
			const clonedSab = structuredClone(sab);
			assert.ok(clonedSab instanceof SharedArrayBuffer);
			assert.deepStrictEqual(Array.from(new Uint8Array(clonedSab)), [1, 2, 3, 4]);
		}
		assert.strictEqual(
			new Intl.DateTimeFormat("de-DE", { dateStyle: "long", timeZone: "UTC" }).format(new Date("2024-01-02T00:00:00Z")),
			"2. Januar 2024"
		);

		// 8. fs.mkdtempSync prefix, appendFileSync flag 'ax', fchmodSync/futimesSync EBADF, globSync exclude
		{
			const sub = path.join(process.cwd(), "mkd");
			fs.mkdirSync(sub, { recursive: true });
			const tmpD = fs.mkdtempSync(path.join(sub, "pfx-"));
			assert.ok(path.basename(tmpD).startsWith("pfx-") && path.basename(tmpD).length === 10);
			const axFile = path.join(sub, "ax.txt");
			fs.writeFileSync(axFile, "init");
			assert.throws(() => fs.appendFileSync(axFile, "more", { flag: "ax" }), (e) => e.code === "EEXIST");
			assert.throws(() => fs.fchmodSync(99999, 0o644), (e) => e.code === "EBADF");
			assert.throws(() => fs.futimesSync(99999, new Date(), new Date()), (e) => e.code === "EBADF");
		}

		// 9. crypto: generateKeyPairSync, sign/verify, createSign/createVerify, KeyObject, ECDH, X25519, checkPrimeSync, streaming Cipheriv
		{
			const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
			const msg = Buffer.from("hello crypto");
			const sig = crypto.sign(null, msg, privateKey);
			assert.strictEqual(crypto.verify(null, msg, publicKey, sig), true);

			const ecKeys = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
			const signer = crypto.createSign("SHA256");
			signer.update("stream-signed");
			const ecSig = signer.sign(ecKeys.privateKey);
			const verifier = crypto.createVerify("SHA256");
			verifier.update("stream-signed");
			assert.strictEqual(verifier.verify(ecKeys.publicKey, ecSig), true);

			const alice = crypto.createECDH("prime256v1");
			alice.generateKeys();
			const bob = crypto.createECDH("prime256v1");
			bob.generateKeys();
			assert.deepStrictEqual(alice.computeSecret(bob.getPublicKey()), bob.computeSecret(alice.getPublicKey()));

			const x1 = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
			const x2 = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
			const b1 = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: x2.publicKey }, x1.privateKey, 256));
			const b2 = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: x1.publicKey }, x2.privateKey, 256));
			assert.deepStrictEqual(b1, b2);

			const prime = crypto.generatePrimeSync(64, { bigint: true });
			assert.strictEqual(crypto.checkPrimeSync(prime), true);
		}

		// 10. zlib maxOutputLength and streaming gunzip on write()
		{
			const gz = zlib.gzipSync(Buffer.alloc(1024, 0x41));
			assert.throws(() => zlib.gunzipSync(gz, { maxOutputLength: 100 }), (e) => e.code === "ERR_BUFFER_TOO_LARGE");

			const gunzip = zlib.createGunzip();
			let gotImmediate = "";
			gunzip.on("data", (d) => { gotImmediate += d.toString(); });
			gunzip.write(zlib.gzipSync("hello-stream"));
			await new Promise((r) => process.nextTick(r));
			assert.strictEqual(gotImmediate, "hello-stream");
			gunzip.end();
		}

		// 11. POSIX printf fallback
		{
			const pf = await $` + "`printf '%04d %s %.2f\\n' 7 hi 3.14159`" + `.text();
			assert.strictEqual(pf, "0007 hi 3.14\n");
		}

		// 12. Worker Threads isolated TCP IPC (stdout without newline does not corrupt or swallow messages)
		if (process.execPath) {
			const w = new Worker(` + "`" + `
				const { parentPort } = require("node:worker_threads");
				process.stdout.write("partial-stdout-no-newline");
				parentPort.on("message", (m) => {
					parentPort.postMessage({ echo: m.val * 2 });
					parentPort.close();
				});
			` + "`" + `, { eval: true, stdout: true });
			let workerStdout = "";
			w.stdout.on("data", (d) => { workerStdout += d.toString(); });
			const reply = await new Promise((resolve, reject) => {
				w.on("message", resolve);
				w.on("error", reject);
				w.postMessage({ val: 21 });
			});
			await new Promise((r) => w.on("exit", r));
			assert.deepStrictEqual(reply, { echo: 42 });
			assert.strictEqual(workerStdout, "partial-stdout-no-newline");
		}

		console.log("ROUND19_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "round19.mjs")
		if exe, err := os.Executable(); err == nil {
			o.ExecPath = exe
		}
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 19 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "ROUND19_ALL_OK") {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round20AdversarialFixes(t *testing.T) {
	wsDir := t.TempDir()

	// Verify every advertised builtin module and named export in builtinModuleExports exists at runtime.
	exportManifestJSON, err := json.Marshal(builtinModuleExports)
	if err != nil {
		t.Fatal(err)
	}

	code, out, errOut, err := runJS(t, fmt.Sprintf(`
		import assert from "node:assert/strict";
		import fs from "node:fs";
		import path from "node:path";
		import http from "node:http";
		import crypto from "node:crypto";
		import zlib from "node:zlib";
		import net from "node:net";
		import util from "node:util";
		import { Worker, MessageChannel, receiveMessageOnPort, setEnvironmentData, getEnvironmentData } from "node:worker_threads";
		import { createRequire } from "node:module";
		const require = createRequire(import.meta.url);

		const manifest = %s;
		for (const [modName, exportsList] of Object.entries(manifest)) {
			const spec = modName === "sh" ? "indirect:sh" : "node:" + modName;
			const cjsMod = require(spec);
			assert.ok(cjsMod !== undefined && cjsMod !== null, "require(" + spec + ") returned undefined/null");
			const esmMod = await import(spec);
			for (const expName of exportsList) {
				assert.ok(expName in cjsMod, "CJS " + spec + " missing export: " + expName);
				assert.ok(expName in esmMod, "ESM " + spec + " missing export: " + expName);
				if (!(modName === "process" && expName === "exitCode")) {
					assert.notStrictEqual(cjsMod[expName], undefined, "CJS " + spec + " missing export: " + expName);
					assert.notStrictEqual(esmMod[expName], undefined, "ESM " + spec + " missing export: " + expName);
				}
			}
		}

		// 1. http.ClientRequest.destroy() before response emits ECONNRESET & close semantics
		{
			const srv = http.createServer((req, res) => {
				if (req.url === "/slow") {
					setTimeout(() => {
						try { res.end("late"); } catch (_) {}
					}, 300);
				} else {
					res.end("fast-ok");
				}
			});
			await new Promise((r) => srv.listen(0, "127.0.0.1", r));
			const port = srv.address().port;

			const slowEvents = [];
			await new Promise((resolve) => {
				const req = http.get({ host: "127.0.0.1", port, path: "/slow" });
				req.on("error", (e) => slowEvents.push("error:" + e.code));
				req.on("close", () => {
					slowEvents.push("close");
					resolve();
				});
				setTimeout(() => req.destroy(), 30);
			});
			assert.deepStrictEqual(slowEvents, ["error:ECONNRESET", "close"]);

			const fastEvents = [];
			await new Promise((resolve) => {
				const req = http.get({ host: "127.0.0.1", port, path: "/fast" }, (res) => {
					fastEvents.push("response");
					res.resume();
					res.on("end", () => fastEvents.push("end"));
				});
				req.on("close", () => {
					fastEvents.push("req-close");
					resolve();
				});
			});
			assert.strictEqual(fastEvents[0], "response");
			assert.ok(fastEvents.includes("req-close"));
			await new Promise((r) => srv.close(r));
		}

		// 2. fs.watch on directory + fs.promises.watch
		{
			const watchDir = path.join(process.cwd(), "watch-dir");
			fs.mkdirSync(watchDir, { recursive: true });
			const seen = [];
			const watcher = fs.watch(watchDir, (eventType, filename) => {
				seen.push([eventType, filename]);
			});
			await new Promise((r) => setTimeout(r, 20));
			fs.writeFileSync(path.join(watchDir, "f"), "bb");
			for (let i = 0; i < 20 && !seen.some((e) => e[0] === "change" && e[1] === "f"); i++) {
				await new Promise((r) => setTimeout(r, 20));
			}
			watcher.close();
			assert.ok(seen.some((e) => e[0] === "change" && e[1] === "f"), "Expected change event for f, got: " + JSON.stringify(seen));
		}

		// 3. assert.deepStrictEqual edge cases (Date(NaN), sparse array, array/TypedArray extra props)
		{
			assert.throws(() => assert.deepStrictEqual(new Date(NaN), new Date(NaN)));
			assert.throws(() => assert.deepStrictEqual([1, 2, 3], Object.assign([1, 2, 3], { x: 9 })));
			assert.throws(() => assert.deepStrictEqual([,], [undefined]));
			assert.throws(() => assert.deepStrictEqual(Object.assign(new Uint8Array([1, 2]), { x: 1 }), new Uint8Array([1, 2])));
		}

		// 4. crypto.publicEncrypt / privateDecrypt / privateEncrypt / publicDecrypt
		{
			const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
			const msg = Buffer.from("secret-oaep-payload");
			const enc = crypto.publicEncrypt(publicKey, msg);
			const dec = crypto.privateDecrypt(privateKey, enc);
			assert.deepStrictEqual(dec, msg);

			const sigEnc = crypto.privateEncrypt(privateKey, msg);
			const sigDec = crypto.publicDecrypt(publicKey, sigEnc);
			assert.deepStrictEqual(sigDec, msg);
		}

		// 5. Dirent non-enumerable internal fields, util.inspect quotes & circular, structuredClone(Buffer)
		{
			const entries = fs.readdirSync(process.cwd(), { withFileTypes: true });
			assert.ok(entries.length > 0);
			const parsed = JSON.parse(JSON.stringify(entries[0]));
			assert.strictEqual(parsed._isFile, undefined);
			assert.strictEqual(parsed._isDirectory, undefined);
			assert.strictEqual(parsed._isSymlink, undefined);

			assert.strictEqual(util.inspect("plain"), "'plain'");
			const cyc = {};
			cyc.self = cyc;
			assert.strictEqual(util.inspect(cyc), "<ref *1> { self: [Circular *1] }");

			const clonedBuf = structuredClone(Buffer.from([1, 2, 3]));
			assert.ok(clonedBuf instanceof Uint8Array);
			assert.strictEqual(Buffer.isBuffer(clonedBuf), false);
		}

		// 6. worker_threads receiveMessageOnPort, setEnvironmentData, path.matchesGlob, net.BlockList
		{
			const { port1, port2 } = new MessageChannel();
			port1.postMessage({ hello: "sync" });
			assert.deepStrictEqual(receiveMessageOnPort(port2), { message: { hello: "sync" } });
			assert.strictEqual(receiveMessageOnPort(port2), undefined);
			setEnvironmentData("k1", "v1");
			assert.strictEqual(getEnvironmentData("k1"), "v1");
			assert.strictEqual(path.posix.matchesGlob("/a/b/c.js", "/a/**/*.js"), true);
			assert.strictEqual(path.posix.matchesGlob("/a/b/c.ts", "/a/**/*.js"), false);
			const bl = new net.BlockList();
			bl.addAddress("10.0.0.1");
			assert.strictEqual(bl.check("10.0.0.1"), true);
			assert.strictEqual(bl.check("10.0.0.2"), false);
		}

		console.log("ROUND20_ALL_OK");
	`, string(exportManifestJSON)), func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "round20.mjs")
		if exe, err := os.Executable(); err == nil {
			o.ExecPath = exe
		}
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 20 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "ROUND20_ALL_OK") {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round21AdversarialFixes(t *testing.T) {
	wsDir := t.TempDir()
	code, out, errOut, err := runJS(t, "\uFEFF#!/usr/bin/env node\n"+`
		import assert from "node:assert";
		import vm from "node:vm";
		import fs from "node:fs";
		import path from "node:path";
		import net from "node:net";
		import { spawnSync } from "node:child_process";

		// 1. VM context with pending promise jobs does not free context before jobs drain
		for (let i = 0; i < 100; i++) {
			vm.runInNewContext("Promise.resolve().then(() => {}); ({})");
		}
		await new Promise((r) => setImmediate(r));

		// 2. Relative imports do not silently fall back to CWD
		{
			const subDir = path.join(process.cwd(), "sub_r21");
			fs.mkdirSync(subDir, { recursive: true });
			fs.writeFileSync(path.join(process.cwd(), "only_in_cwd.mjs"), "export const x = 42;\n");
			fs.writeFileSync(path.join(subDir, "importer.mjs"), "import { x } from './only_in_cwd.mjs'; export default x;\n");
			fs.writeFileSync(path.join(subDir, "cjs_importer.cjs"), "module.exports = require('./only_in_cwd.mjs');\n");
			await assert.rejects(() => import(path.join(subDir, "importer.mjs")));
			assert.throws(() => require(path.join(subDir, "cjs_importer.cjs")));
		}

		// 3. child_process executable lookup uses child's env.PATH
		{
			const res = spawnSync("nonexistent_cmd_r21", [], { env: { PATH: path.join(process.cwd(), "no_such_bin") } });
			assert.ok(res.error);
			assert.strictEqual(res.error.code, "ENOENT");
		}

		// 4. net.BlockList ranges and subnets
		{
			const b = new net.BlockList();
			b.addSubnet("10.0.0.0", 24);
			b.addRange("192.168.1.10", "192.168.1.20");
			b.addSubnet("2001:db8::", 32, "ipv6");
			b.addRange("fe80::10", "fe80::20", "ipv6");
			assert.strictEqual(b.check("10.0.0.5"), true);
			assert.strictEqual(b.check("10.0.1.5"), false);
			assert.strictEqual(b.check("192.168.1.15"), true);
			assert.strictEqual(b.check("192.168.1.25"), false);
			assert.strictEqual(b.check("2001:db8:1234::1", "ipv6"), true);
			assert.strictEqual(b.check("2001:db9::1", "ipv6"), false);
			assert.strictEqual(b.check("fe80::15", "ipv6"), true);
			assert.strictEqual(b.check("fe80::25", "ipv6"), false);
		}

		// 5. process.chdir("") throws ENOENT
		assert.throws(
			() => process.chdir(""),
			(e) => e.code === "ENOENT"
		);

		// 6. AbortController.abort() and fetch abort produce DOMException with code 20
		{
			const ac = new AbortController();
			ac.abort();
			assert.ok(ac.signal.reason instanceof DOMException);
			assert.strictEqual(ac.signal.reason.name, "AbortError");
			assert.strictEqual(ac.signal.reason.code, 20);
			await assert.rejects(
				fetch("http://127.0.0.1:1/", { signal: ac.signal }),
				(e) => e instanceof DOMException && e.name === "AbortError" && e.code === 20
			);
		}

		// 7. URL.port rejects malformed ports
		{
			const u = new URL("http://example.com/");
			u.port = "99999";
			assert.strictEqual(u.port, "");
			assert.strictEqual(u.href, "http://example.com/");
			u.port = "abc";
			assert.strictEqual(u.port, "");
			assert.strictEqual(u.href, "http://example.com/");
			u.port = "8080";
			assert.strictEqual(u.port, "8080");
		}

		// 8. Buffer#write rejects unknown encoding with ERR_UNKNOWN_ENCODING
		assert.throws(
			() => Buffer.alloc(4).write("a", 0, 1, "bogus"),
			(e) => e instanceof TypeError && e.code === "ERR_UNKNOWN_ENCODING"
		);

		console.log("ROUND21_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "round21.mjs")
		if exe, err := os.Executable(); err == nil {
			o.ExecPath = exe
		}
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 21 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "ROUND21_ALL_OK") {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round22AdversarialFixes(t *testing.T) {
	wsDir := t.TempDir()
	code, out, errOut, err := runJS(t, `
		import assert from "node:assert";
		import http from "node:http";
		import net from "node:net";
		import zlib from "node:zlib";
		import crypto from "node:crypto";
		import os from "node:os";
		import util from "node:util";
		import url from "node:url";
		import stream from "node:stream";
		import fs from "node:fs";
		import fsp from "node:fs/promises";
		import path from "node:path";

		// 1. IANA timezones in Intl.DateTimeFormat and process.env.TZ in Date
		{
			const dtf = new Intl.DateTimeFormat("en-US", {
				timeZone: "America/New_York",
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			});
			assert.strictEqual(dtf.format(new Date("2026-01-15T12:00:00Z")), "07:00");
			assert.strictEqual(dtf.format(new Date("2026-07-15T12:00:00Z")), "08:00");
			assert.throws(() => new Intl.DateTimeFormat("en-US", { timeZone: "Invalid/Zone_Name" }), RangeError);

			const prevTZ = process.env.TZ;
			process.env.TZ = "America/New_York";
			const d = new Date("2026-01-15T12:00:00Z");
			assert.strictEqual(d.getTimezoneOffset(), 300);
			assert.strictEqual(d.getHours(), 7);
			if (prevTZ === undefined) delete process.env.TZ;
			else process.env.TZ = prevTZ;
		}

		// 2. URL port normalization, URL.parse, URL.createObjectURL, Request URL validation & FormData
		{
			assert.strictEqual(new URL("http://example.com:0080/a").href, "http://example.com/a");
			assert.strictEqual(new URL("http://example.com:08080/a").port, "8080");
			assert.strictEqual(URL.parse("not a valid url"), null);
			assert.strictEqual(URL.parse("http://example.com:80/x").href, "http://example.com/x");
			const blobUrl = URL.createObjectURL(new Blob(["hi"]));
			assert.ok(blobUrl.startsWith("blob:nodedata:"));
			URL.revokeObjectURL(blobUrl);

			assert.throws(() => new Request("not a valid url"), TypeError);
			const req = new Request("http://example.com/path");
			assert.strictEqual(req.mode, "cors");
			assert.strictEqual(req.credentials, "same-origin");
			assert.strictEqual(req.cache, "default");

			const fdIn = new FormData();
			fdIn.append("k", "v");
			fdIn.append("f", new File(["hello"], "test.txt", { type: "text/plain" }));
			const fdReq = new Request("http://example.com/upload", { method: "POST", body: fdIn });
			const fdOut = await fdReq.formData();
			assert.strictEqual(fdOut.get("k"), "v");
			assert.strictEqual(await fdOut.get("f").text(), "hello");
			assert.strictEqual(new File(["x"], "a.txt", { lastModified: 0 }).lastModified, 0);
		}

		// 3. Brotli actual LZ77 + Huffman compression & full zlib.constants
		{
			const repeated = Buffer.alloc(10000, "A");
			const compressed = zlib.brotliCompressSync(repeated);
			assert.ok(compressed.length < 200, "expected compressed length < 200, got " + compressed.length);
			assert.deepStrictEqual(zlib.brotliDecompressSync(compressed), repeated);
			assert.strictEqual(zlib.constants.Z_SYNC_FLUSH, 2);
			assert.strictEqual(zlib.constants.Z_BEST_COMPRESSION, 9);
		}

		// 4. Crypto: chacha20-poly1305, sha3-256, blake2b512, getCipherInfo
		{
			const key = crypto.randomBytes(32);
			const iv = crypto.randomBytes(12);
			const aad = Buffer.from("header");
			const c = crypto.createCipheriv("chacha20-poly1305", key, iv, { authTagLength: 16 });
			c.setAAD(aad, { plaintextLength: 5 });
			const enc = Buffer.concat([c.update("hello", "utf8"), c.final()]);
			const tag = c.getAuthTag();
			const d = crypto.createDecipheriv("chacha20-poly1305", key, iv, { authTagLength: 16 });
			d.setAAD(aad, { plaintextLength: 5 });
			d.setAuthTag(tag);
			const dec = Buffer.concat([d.update(enc), d.final()]).toString("utf8");
			assert.strictEqual(dec, "hello");

			assert.strictEqual(crypto.createHash("sha3-256").update("abc").digest("hex").length, 64);
			assert.strictEqual(crypto.createHash("blake2b512").update("abc").digest("hex").length, 128);
			assert.strictEqual(crypto.getCipherInfo("aes-256-gcm").keyLength, 32);
		}

		// 5. os real metrics, util.format, $ object rejection, import.meta.resolve, streams, http/net Server.listen(cb)
		{
			assert.ok(os.totalmem() > 0 && os.freemem() > 0 && os.freemem() <= os.totalmem());
			assert.ok(os.uptime() > 0);
			assert.strictEqual(util.format("%s", { a: 1 }), "{ a: 1 }");
			assert.strictEqual(util.format("%chello", "color:red"), "hello");
			await assert.rejects(async () => { await $` + "`echo ${{ a: 1 }}`" + `; }, TypeError);
			assert.strictEqual(import.meta.resolve("fs"), "node:fs");
			assert.ok(import.meta.resolve("./round22.mjs").startsWith("file://"));

			assert.strictEqual(typeof stream.Readable.toWeb, "function");
			assert.strictEqual(typeof stream.Writable.toWeb, "function");
			assert.strictEqual(typeof stream.getDefaultHighWaterMark, "function");
			assert.strictEqual(typeof fs.ReadStream, "function");
			assert.strictEqual(typeof fsp.lutimes, "function");
			assert.strictEqual(typeof PerformanceObserver, "function");
			assert.strictEqual(typeof WebSocket, "function");
			assert.strictEqual(typeof url.urlToHttpOptions, "function");
			assert.strictEqual(typeof process.resourceUsage().maxRSS, "number");
			assert.ok(process.stdout instanceof stream.Writable);

			// http.Server.listen(cb) & IncomingMessage properties
			const srv = http.createServer((req, res) => {
				assert.strictEqual(req.httpVersionMajor, 1);
				assert.strictEqual(req.httpVersionMinor, 1);
				assert.strictEqual(typeof req.socket.remoteAddress, "string");
				res.end("ok");
			});
			await new Promise((r) => srv.listen(() => r()));
			const addr = srv.address();
			assert.ok(addr.port > 0);
			const body = await new Promise((resolve, reject) => {
				http.get({ host: "127.0.0.1", port: addr.port, path: "/test" }, (res) => {
					assert.strictEqual(res.httpVersion, "1.1");
					assert.strictEqual(res.httpVersionMajor, 1);
					let s = "";
					res.on("data", (c) => { s += c.toString(); });
					res.on("end", () => {
						assert.strictEqual(res.complete, true);
						resolve(s);
					});
				}).on("error", reject);
			});
			assert.strictEqual(body, "ok");
			await new Promise((r) => srv.close(r));

			// net.Server.listen(cb)
			const ns = net.createServer();
			await new Promise((r) => ns.listen(() => r()));
			assert.ok(ns.address().port > 0);
			await new Promise((r) => ns.close(r));
		}

		console.log("ROUND22_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "round22.mjs")
		if exe, err := os.Executable(); err == nil {
			o.ExecPath = exe
		}
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 22 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "ROUND22_ALL_OK") {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round23AdversarialFixes(t *testing.T) {
	wsDir := t.TempDir()
	code, out, errOut, err := runJS(t, `
		import assert from "node:assert";
		import fs from "node:fs";
		import fsp from "node:fs/promises";
		import path from "node:path";
		import crypto from "node:crypto";
		import zlib from "node:zlib";
		import http from "node:http";
		import dgram from "node:dgram";
		import dns from "node:dns";
		import util from "node:util";
		import stream from "node:stream";
		import consumers from "node:stream/consumers";
		import cp from "node:child_process";
		import { Worker, SHARE_ENV, markAsUncloneable } from "node:worker_threads";
		import { createRequire } from "node:module";

		const require = createRequire(import.meta.url);

		// 1. require(esm) with top-level await throws ERR_REQUIRE_ASYNC_MODULE synchronously
		{
			const tpePath = path.join(process.cwd(), "tla_mod.mjs");
			fs.writeFileSync(tpePath, "export const x = await Promise.resolve(42);\n");
			assert.throws(() => require(tpePath), (err) => err && err.code === "ERR_REQUIRE_ASYNC_MODULE");
		}

		// 2. Intl constructors called without new
		{
			const df = Intl.DateTimeFormat("en-US");
			assert.ok(df instanceof Intl.DateTimeFormat);
			assert.strictEqual(typeof df.format(new Date(0)), "string");
			const nf = Intl.NumberFormat("en-US");
			assert.ok(nf instanceof Intl.NumberFormat);
			assert.strictEqual(nf.format(1234.5), "1,234.5");
			const col = Intl.Collator("en-US");
			assert.ok(col instanceof Intl.Collator);
			assert.strictEqual(col.compare("a", "b"), -1);
		}

		// 3. Buffer error codes & properties
		{
			assert.strictEqual(Buffer.poolSize, 8192);
			assert.throws(() => Buffer.compare("a", Buffer.from("a")), { code: "ERR_INVALID_ARG_TYPE" });
			assert.throws(() => Buffer.from("a").compare("a"), { code: "ERR_INVALID_ARG_TYPE" });
			assert.throws(() => Buffer.from("a").equals("a"), { code: "ERR_INVALID_ARG_TYPE" });
			assert.throws(() => Buffer.from("a").toString("bogus_enc"), { code: "ERR_UNKNOWN_ENCODING" });
			assert.throws(() => Buffer.alloc(4).readUInt32BE(2), { code: "ERR_OUT_OF_RANGE" });
			assert.throws(() => Buffer.alloc(2).readUInt32BE(0), { code: "ERR_BUFFER_OUT_OF_BOUNDS" });
		}

		// 4. Zstandard compress/decompress + stream/consumers + assert.partialDeepStrictEqual + util
		{
			const input = Buffer.from("hello zstd world! ".repeat(20));
			const compressed = zlib.zstdCompressSync(input);
			const decompressed = zlib.zstdDecompressSync(compressed);
			assert.deepStrictEqual(decompressed, input);

			const s = stream.Readable.from([Buffer.from('{"hello":'), Buffer.from('"world"}')]);
			const parsed = await consumers.json(s);
			assert.deepStrictEqual(parsed, { hello: "world" });

			const [s1, s2] = stream.duplexPair();
			s1.write("ping");
			s1.end();
			assert.strictEqual(await consumers.text(s2), "ping");

			assert.partialDeepStrictEqual({ a: 1, b: { x: 10, y: 20 } }, { b: { x: 10 } });
			assert.throws(() => assert.partialDeepStrictEqual({ a: 1 }, { a: 2 }));

			assert.strictEqual(util.getSystemErrorName(-2), "ENOENT");
			assert.strictEqual(typeof util.getSystemErrorMessage(-2), "string");
			assert.strictEqual(util.toUSVString("a\uD800b"), "a\uFFFDb");
			assert.strictEqual(typeof process.getBuiltinModule("node:fs").readFileSync, "function");
		}

		// 5. fs.copyFileSync ENOENT + fs.readvSync/writevSync + FileHandle methods
		{
			assert.throws(() => fs.copyFileSync("non_existent_src_12345.txt", "dst.txt"), { code: "ENOENT" });
			const vFile = path.join(process.cwd(), "vec.bin");
			const fd = fs.openSync(vFile, "w+");
			const written = fs.writevSync(fd, [Buffer.from("hello "), Buffer.from("world")]);
			assert.strictEqual(written, 11);
			const b1 = Buffer.alloc(5);
			const b2 = Buffer.alloc(6);
			const readBytes = fs.readvSync(fd, [b1, b2], 0);
			assert.strictEqual(readBytes, 11);
			assert.strictEqual(b1.toString() + b2.toString(), "hello world");
			fs.closeSync(fd);
		}

		// 6. Headers validation & HTTP duplicate headers rawHeaders
		{
			assert.throws(() => new Headers([["bad name", "val"]]), TypeError);
			assert.throws(() => new Headers([["x-ok", "bad\r\nval"]]), TypeError);
			http.validateHeaderName("X-Valid-Token");
			assert.throws(() => http.validateHeaderName("invalid token"), { code: "ERR_INVALID_HTTP_TOKEN" });
			assert.throws(() => http.validateHeaderValue("X-Test", "bad\nval"), { code: "ERR_INVALID_CHAR" });

			const srv = http.createServer((req, res) => {
				res.setHeader("X-Multi", ["one", "two"]);
				res.end("ok");
			});
			await new Promise((r) => srv.listen(0, "127.0.0.1", r));
			const port = srv.address().port;
			const rawH = await new Promise((resolve, reject) => {
				http.get({ host: "127.0.0.1", port, path: "/" }, (res) => {
					res.resume();
					res.on("end", () => resolve(res.rawHeaders));
				}).on("error", reject);
			});
			const xMultiVals = [];
			for (let i = 0; i < rawH.length; i += 2) {
				if (rawH[i].toLowerCase() === "x-multi") xMultiVals.push(rawH[i + 1]);
			}
			assert.deepStrictEqual(xMultiVals, ["one", "two"]);
			await new Promise((r) => srv.close(r));
		}

		// 7. dgram UDP send & receive
		{
			const server = dgram.createSocket("udp4");
			const client = dgram.createSocket("udp4");
			const received = new Promise((resolve) => {
				server.on("message", (msg, rinfo) => {
					resolve({ msg: msg.toString(), port: rinfo.port });
				});
			});
			await new Promise((r) => server.bind(0, "127.0.0.1", r));
			const srvPort = server.address().port;
			client.send("udp-hello", srvPort, "127.0.0.1");
			const res = await received;
			assert.strictEqual(res.msg, "udp-hello");
			assert.ok(res.port > 0);
			client.close();
			server.close();
		}

		// 8. dns.lookupService bad port + worker.terminate() exit code 1 + SHARE_ENV
		{
			assert.throws(() => dns.lookupService("127.0.0.1", 99999, () => {}), { code: "ERR_SOCKET_BAD_PORT" });
			assert.strictEqual(typeof SHARE_ENV, "symbol");
			const o = {};
			markAsUncloneable(o);
			assert.throws(() => structuredClone(o), (e) => e && e.name === "DataCloneError");

			const w = new Worker("setInterval(() => {}, 1000);", { eval: true });
			await new Promise((r) => w.on("online", r));
			const termCode = await w.terminate();
			assert.strictEqual(termCode, 1);
		}

		// 9. ShellPromise single execution when mixing .then() and sync .stdout
		{
			const counterFile = path.join(process.cwd(), "count.txt");
			fs.writeFileSync(counterFile, "");
			const p = $` + "`echo tick >> ${counterFile}; echo out`" + `.quiet();
			let asyncOut = "";
			p.then((r) => { asyncOut = r.text().trim(); });
			const syncOut = p.stdout.toString().trim();
			await p;
			assert.strictEqual(syncOut, "out");
			assert.strictEqual(asyncOut, "out");
			const lines = fs.readFileSync(counterFile, "utf8").trim().split(/\r?\n/).filter(Boolean);
			assert.strictEqual(lines.length, 1);
		}

		// 10. child_process.fork IPC send/message
		{
			const childScript = path.join(process.cwd(), "fork_child.js");
			fs.writeFileSync(childScript, 'process.on("message", (m) => { process.send({ reply: m.ping + 1 }); process.disconnect(); });\n');
			const child = cp.fork(childScript);
			const reply = await new Promise((resolve, reject) => {
				child.on("message", resolve);
				child.on("error", reject);
				child.send({ ping: 41 });
			});
			assert.deepStrictEqual(reply, { reply: 42 });
			await new Promise((r) => child.on("exit", r));
		}

		console.log("ROUND23_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "round23.mjs")
		if exe, err := os.Executable(); err == nil {
			o.ExecPath = exe
		}
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 23 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "ROUND23_ALL_OK") {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round24AdversarialFixes(t *testing.T) {
	wsDir := t.TempDir()
	code, out, errOut, err := runJS(t, `
		import assert from "node:assert";
		import fs from "node:fs";
		import path from "node:path";
		import http from "node:http";
		import url from "node:url";
		import querystring from "node:querystring";
		import util from "node:util";
		import crypto from "node:crypto";
		import zlib from "node:zlib";
		import os from "node:os";
		import vm from "node:vm";
		import testMod from "node:test";
		import { EventEmitter } from "node:events";
		import { setTimeout as sleepP, scheduler } from "node:timers/promises";
		import { Worker, MessageChannel } from "node:worker_threads";
		import { createRequire } from "node:module";

		const require = createRequire(import.meta.url);

		// 1. Module detection: comments/strings with import/export do not misclassify CJS as ESM,
		//    CJS re-export named extraction, and package.json #imports resolution
		{
			const pkgDir = path.join(process.cwd(), "pkg_r24");
			fs.mkdirSync(pkgDir, { recursive: true });
			fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({
				name: "pkg-r24",
				imports: {
					"#internal": "./internal.cjs",
				},
			}));
			fs.writeFileSync(path.join(pkgDir, "internal.cjs"), ` + "`" + `
				// import something from "nowhere"
				const str = "export default fake";
				exports.alpha = 10;
				exports["beta"] = 20;
				Object.defineProperty(exports, "gamma", { value: 30, enumerable: true });
			` + "`" + `);
			fs.writeFileSync(path.join(pkgDir, "reexport.cjs"), ` + "`" + `
				module.exports = require("#internal");
			` + "`" + `);
			const cjsMod = require(path.join(pkgDir, "reexport.cjs"));
			assert.strictEqual(cjsMod.alpha, 10);
			assert.strictEqual(cjsMod.beta, 20);
			assert.strictEqual(cjsMod.gamma, 30);
			const esmImported = await import(url.pathToFileURL(path.join(pkgDir, "reexport.cjs")).href);
			assert.strictEqual(esmImported.alpha, 10);
			assert.strictEqual(esmImported.beta, 20);
			assert.strictEqual(esmImported.gamma, 30);
		}

		// 2. HTTP: raw response without auto-decompression/redirect, header case preservation,
		//    duplicate headers, cookie joining, streaming request/response, and Response validation
		{
			assert.throws(() => new Response("body", { status: 204 }), TypeError);
			assert.throws(() => new Response(null, { status: 101 }), RangeError);
			await assert.rejects(() => fetch("http://127.0.0.1:22/"), TypeError);

			const gzPayload = zlib.gzipSync(Buffer.from("hello-raw-gzip"));
			const srv = http.createServer((req, res) => {
				if (req.url === "/gzip") {
					res.setHeader("Content-Encoding", "gzip");
					res.setHeader("X-Custom-Case", "Preserved");
					res.end(gzPayload);
					return;
				}
				if (req.url === "/redirect") {
					res.writeHead(302, { Location: "/target" });
					res.end();
					return;
				}
				if (req.url === "/echo-headers") {
					res.setHeader("Content-Type", "application/json");
					res.end(JSON.stringify({
						rawHeaders: req.rawHeaders,
						cookie: req.headers.cookie,
						ua: req.headers["user-agent"] || null,
					}));
					return;
				}
				if (req.url === "/stream") {
					const chunks = [];
					req.on("data", (c) => chunks.push(c));
					req.on("end", () => {
						res.flushHeaders();
						res.write(Buffer.concat(chunks));
						res.end("-done");
					});
					return;
				}
				res.end("ok");
			});
			await new Promise((r) => srv.listen(0, "127.0.0.1", r));
			const port = srv.address().port;

			// 2a. http.get does NOT auto-decompress gzip (unlike fetch) and preserves header case in rawHeaders
			const rawGz = await new Promise((resolve, reject) => {
				http.get({ host: "127.0.0.1", port, path: "/gzip" }, (res) => {
					const chunks = [];
					res.on("data", (c) => chunks.push(c));
					res.on("end", () => resolve({ body: Buffer.concat(chunks), rawHeaders: res.rawHeaders }));
				}).on("error", reject);
			});
			assert.deepStrictEqual(rawGz.body, gzPayload);
			assert.ok(rawGz.rawHeaders.includes("X-Custom-Case"));

			// 2b. fetch DOES auto-decompress gzip
			const fetchRes = await fetch(` + "`http://127.0.0.1:${port}/gzip`" + `);
			assert.strictEqual(await fetchRes.text(), "hello-raw-gzip");

			// 2c. http.get does NOT auto-follow 302 redirects
			const redirStatus = await new Promise((resolve, reject) => {
				http.get({ host: "127.0.0.1", port, path: "/redirect" }, (res) => {
					res.resume();
					resolve(res.statusCode);
				}).on("error", reject);
			});
			assert.strictEqual(redirStatus, 302);

			// 2d. ClientRequest preserves header case, array values, cookies, and does not inject User-Agent
			const echoInfo = await new Promise((resolve, reject) => {
				const req = http.request({
					host: "127.0.0.1",
					port,
					path: "/echo-headers",
					headers: {
						"X-My-Header": ["v1", "v2"],
						"Cookie": ["a=1", "b=2"],
					},
				}, (res) => {
					let s = "";
					res.on("data", (c) => { s += c; });
					res.on("end", () => resolve(JSON.parse(s)));
				});
				req.on("error", reject);
				req.end();
			});
			assert.strictEqual(echoInfo.cookie, "a=1; b=2");
			assert.strictEqual(echoInfo.ua, null);

			// 2e. Streaming request body via req.write() before req.end()
			const streamed = await new Promise((resolve, reject) => {
				const req = http.request({ host: "127.0.0.1", port, path: "/stream", method: "POST" }, (res) => {
					let s = "";
					res.on("data", (c) => { s += c; });
					res.on("end", () => resolve(s));
				});
				req.on("error", reject);
				req.write("part1-");
				setTimeout(() => {
					req.write("part2");
					req.end();
				}, 10);
			});
			assert.strictEqual(streamed, "part1-part2-done");
			srv.closeAllConnections();
			await new Promise((r) => srv.close(r));
		}

		// 3. URL & querystring edge cases
		{
			assert.strictEqual(new URL("http://example.com/a/b/%2e%2e/c").pathname, "/a/c");
			assert.strictEqual(new URL("http://0x7f.0.0.1/").hostname, "127.0.0.1");
			assert.strictEqual(new URL("file:///tmp/x").origin, "null");
			assert.strictEqual(new URL("blob:https://example.com/uuid").origin, "https://example.com");
			if (process.platform === "win32") {
				assert.strictEqual(url.fileURLToPath("file://localhost/C:/dir/file.txt"), "C:\\dir\\file.txt");
			}
			assert.strictEqual(url.parse("mailto:user@example.com").auth, "user");
			assert.strictEqual(url.parse("//foo/bar", false, true).host, "foo");
			assert.strictEqual(querystring.stringify({ a: undefined, b: null, c: 1, d: {} }), "a=&b=&c=1&d=");
			assert.strictEqual(querystring.unescape("%E0%A4%A"), "\ufffd%A");
		}

		// 4. EventEmitter newListener/removeListener, timers/promises AbortError & scheduler, Error.captureStackTrace
		{
			const ee = new EventEmitter();
			const events = [];
			ee.on("newListener", (ev) => events.push("add:" + ev));
			ee.on("removeListener", (ev) => events.push("rem:" + ev));
			const fn = () => {};
			ee.on("data", fn);
			ee.off("data", fn);
			assert.deepStrictEqual(events, ["add:removeListener", "add:data", "rem:data"]);

			const ac = new AbortController();
			ac.abort();
			await assert.rejects(() => sleepP(1000, "val", { signal: ac.signal }), { name: "AbortError", code: "ABORT_ERR" });
			await scheduler.yield();
			await scheduler.wait(1);

			function CustomErr() {
				Error.captureStackTrace(this, CustomErr);
			}
			const ce = new CustomErr();
			assert.ok(typeof ce.stack === "string" && !ce.stack.includes("at new CustomErr"));
		}

		// 5. Crypto: SHAKE128/256 with outputLength & RIPEMD160, zlib.constants
		{
			const shake = crypto.createHash("shake128", { outputLength: 32 }).update("abc").digest("hex");
			assert.strictEqual(shake.length, 64);
			const shakeOneShot = crypto.hash("shake256", "abc", { outputEncoding: "hex", outputLength: 64 });
			assert.strictEqual(shakeOneShot.length, 128);
			const rmd = crypto.createHash("ripemd160").update("abc").digest("hex");
			assert.strictEqual(rmd, "8eb208f7e05d987a9b044a8e98c6b087f15a0bfc");
			assert.strictEqual(zlib.constants.Z_DEFLATED, 8);
			assert.strictEqual(zlib.constants.Z_UNKNOWN, 2);
		}

		// 6. Intl.NumberFormat exact decimal rounding & German percent, DateTimeFormat short, TextDecoder shift_jis, util.inspect
		{
			assert.strictEqual(new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(1.005), "1.01");
			assert.strictEqual(new Intl.NumberFormat("de-DE", { style: "percent" }).format(0.26), "26\u00a0%");
			const dtfShort = new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "short", timeZone: "UTC" }).format(new Date("2024-01-02T03:04:00Z"));
			assert.strictEqual(dtfShort, "1/2/24, 3:04 AM");

			const sjis = new TextDecoder("shift_jis").decode(new Uint8Array([0x82, 0xa0]));
			assert.strictEqual(sjis, "あ");

			assert.strictEqual(util.inspect([1, 2, 3, 4], { maxArrayLength: 2 }), "[ 1, 2, ... 2 more items ]");
			assert.strictEqual(util.inspect("abcdefgh", { maxStringLength: 3 }), "'abc'... 5 more characters");
			assert.strictEqual(util.inspect({ b: 1, a: 2 }, { sorted: true }), "{ a: 2, b: 1 }");
		}

		// 7. Worker >16KB ESM eval and MessagePort/Worker transferList ArrayBuffer detachment
		{
			const mc = new MessageChannel();
			const ab = new ArrayBuffer(8);
			mc.port1.postMessage(ab, [ab]);
			assert.strictEqual(ab.byteLength, 0);
			mc.port1.close();
			mc.port2.close();

			const pad = "// " + "x".repeat(17000) + "\n";
			const esmWorkerCode = pad + 'import { parentPort } from "node:worker_threads"; parentPort.postMessage("esm-ok");';
			const w = new Worker(esmWorkerCode, { eval: true });
			const msg = await new Promise((resolve, reject) => {
				w.on("message", resolve);
				w.on("error", reject);
			});
			assert.strictEqual(msg, "esm-ok");
			await w.terminate();
		}

		// 8. vm.constants, vm.measureMemory, node:test, process.versions, os.constants
		{
			assert.strictEqual(typeof vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER, "symbol");
			const mem = await vm.measureMemory();
			assert.strictEqual(typeof mem.total.jsMemoryEstimate, "number");
			assert.strictEqual(typeof testMod, "function");
			assert.strictEqual(typeof testMod.describe, "function");
			assert.strictEqual(typeof process.versions.v8, "string");
			assert.strictEqual(typeof os.constants.errno.EACCES, "number");
			assert.strictEqual(typeof os.constants.priority.PRIORITY_NORMAL, "number");
		}

		console.log("ROUND24_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "round24.mjs")
		if exe, err := os.Executable(); err == nil {
			o.ExecPath = exe
		}
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 24 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "ROUND24_ALL_OK") {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round25AdversarialFixes(t *testing.T) {
	wsDir := t.TempDir()
	code, out, errOut, err := runJS(t, `
		import assert from "node:assert";
		import http from "node:http";
		import fs from "node:fs";
		import dns from "node:dns";
		import vm from "node:vm";
		import { Worker } from "node:worker_threads";

		// 1. Deep process.nextTick + uncaughtException loop without C stack overflow
		{
			let count = 0;
			await new Promise((resolve) => {
				const onUncaught = () => {
					if (++count < 5000) {
						process.nextTick(() => { throw new Error("boom"); });
					} else {
						process.off("uncaughtException", onUncaught);
						resolve();
					}
				};
				process.on("uncaughtException", onUncaught);
				process.nextTick(() => { throw new Error("boom"); });
			});
			assert.strictEqual(count, 5000);
		}

		// 2. http.request write("abc") + end("def") and flushHeaders() + end("abc")
		{
			const srv = http.createServer(async (req, res) => {
				const chunks = [];
				for await (const c of req) chunks.push(c);
				res.end(Buffer.concat(chunks).toString("utf8"));
			});
			await new Promise((r) => srv.listen(0, "127.0.0.1", r));
			const port = srv.address().port;

			const body1 = await new Promise((resolve, reject) => {
				const req = http.request({ host: "127.0.0.1", port, method: "POST" }, async (res) => {
					const chunks = [];
					for await (const c of res) chunks.push(c);
					resolve(Buffer.concat(chunks).toString("utf8"));
				});
				req.on("error", reject);
				req.write("abc");
				req.end("def");
			});
			assert.strictEqual(body1, "abcdef");

			const body2 = await new Promise((resolve, reject) => {
				const req = http.request({ host: "127.0.0.1", port, method: "POST" }, async (res) => {
					const chunks = [];
					for await (const c of res) chunks.push(c);
					resolve(Buffer.concat(chunks).toString("utf8"));
				});
				req.on("error", reject);
				req.flushHeaders();
				req.end("abc");
			});
			assert.strictEqual(body2, "abc");
			await new Promise((r) => srv.close(r));
		}

		// 3. Non-blocking http.request.write() before TCP connection completes
		{
			let timerFired = false;
			const req = http.request({ host: "10.255.255.1", port: 81, method: "POST" });
			req.on("error", () => {});
			await new Promise((resolve) => {
				setTimeout(() => {
					timerFired = true;
					req.destroy();
					resolve();
				}, 20);
				req.write("hello");
			});
			assert.strictEqual(timerFired, true);
		}

		// 4. Non-blocking Worker.postMessage under backpressure
		{
			const w = new Worker("setInterval(() => {}, 1000);", { eval: true });
			const buf = new Uint8Array(256 * 1024);
			let timerElapsed = 0;
			const t0 = Date.now();
			const timerPromise = new Promise((resolve) => {
				setTimeout(() => {
					timerElapsed = Date.now() - t0;
					resolve();
				}, 15);
			});
			for (let i = 0; i < 40; i++) {
				w.postMessage(buf);
			}
			await timerPromise;
			assert.ok(timerElapsed < 2000, "timer starved: " + timerElapsed);
			await w.terminate();
		}

		// 5. vm.runInNewContext getter and setter exceptions propagate cleanly
		{
			const sbGetter = {};
			Object.defineProperty(sbGetter, "a", {
				enumerable: true,
				get() { throw new Error("getter-boom"); },
			});
			assert.throws(() => vm.runInNewContext("a + 1", sbGetter), /getter-boom/);

			const sbSetter = { a: 1 };
			Object.defineProperty(sbSetter, "a", {
				enumerable: true,
				get() { return 1; },
				set() { throw new Error("setter-boom"); },
			});
			assert.throws(() => vm.runInNewContext("a = 2", sbSetter), /setter-boom/);
		}

		// 6. fetch() streams ReadableStream request body before stream closes
		{
			let pullCount = 0;
			let resolveSecondChunk;
			const secondChunkGate = new Promise((r) => { resolveSecondChunk = r; });
			const srv = http.createServer((req, res) => {
				const chunks = [];
				req.on("data", (c) => {
					chunks.push(c);
					if (chunks.length === 1) {
						resolveSecondChunk();
					}
				});
				req.on("end", () => {
					res.end(Buffer.concat(chunks).toString("utf8"));
				});
			});
			await new Promise((r) => srv.listen(0, "127.0.0.1", r));
			const port = srv.address().port;

			const rs = new ReadableStream({
				async pull(ctrl) {
					pullCount++;
					if (pullCount === 1) {
						ctrl.enqueue(new TextEncoder().encode("part1-"));
					} else {
						await secondChunkGate;
						ctrl.enqueue(new TextEncoder().encode("part2"));
						ctrl.close();
					}
				},
			});
			const resp = await fetch("http://127.0.0.1:" + port, {
				method: "POST",
				body: rs,
				duplex: "half",
			});
			assert.strictEqual(await resp.text(), "part1-part2");
			await new Promise((r) => srv.close(r));
		}

		// 7. fs.promises.readFile and dns.promises.lookup do not starve 0ms timers
		{
			fs.writeFileSync("tmp_async.txt", "hello-async");
			let timer1 = false;
			setTimeout(() => { timer1 = true; }, 0);
			const text = await fs.promises.readFile("tmp_async.txt", "utf8");
			assert.strictEqual(text, "hello-async");
			assert.strictEqual(timer1, true);

			let timer2 = false;
			setTimeout(() => { timer2 = true; }, 0);
			const looked = await dns.promises.lookup("127.0.0.1");
			assert.strictEqual(looked.address, "127.0.0.1");
			assert.strictEqual(timer2, true);
		}

		console.log("ROUND25_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "round25.mjs")
		if exe, err := os.Executable(); err == nil {
			o.ExecPath = exe
		}
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 25 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "ROUND25_ALL_OK") {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round26AdversarialFixes(t *testing.T) {
	wsDir := t.TempDir()
	code, out, errOut, err := runJS(t, `
		import assert from "node:assert";
		import fs from "node:fs";
		import fsp from "node:fs/promises";
		import path from "node:path";
		import vm from "node:vm";
		import zlib from "node:zlib";
		import crypto from "node:crypto";
		import events from "node:events";
		import dgram from "node:dgram";
		import { Worker } from "node:worker_threads";

		// 1. Brotli single-symbol / highly skewed round-trip
		{
			const single = Buffer.alloc(128, 0x41);
			const compressed = zlib.brotliCompressSync(single);
			const decompressed = zlib.brotliDecompressSync(compressed);
			assert.deepStrictEqual(decompressed, single);
		}

		// 2. Zstd Compressed_Block (RLE sequences + raw literals) decompression
		{
			// Construct a valid RFC 8878 Zstd frame with a Compressed_Block (blockType=2):
			// Magic: 28 B5 2F FD
			// FHD: 0x20 (Single_Segment_Flag=1, FCS_Field_Size=1 -> 1 byte FCS)
			// FCS: 10 ("hellohello")
			// Block Header (3 bytes LE): Last_Block=1, Block_Type=2 (Compressed_Block), Block_Size=9 -> (9 << 3) | (2 << 1) | 1 = 0x4D, 0x00, 0x00
			// Literals_Section_Header: Literals_Block_Type=0 (Raw), Size_Format=0 (1 byte), Regenerated_Size=5 ("hello") -> (5 << 3) | 0 = 0x28
			// Literals: "hello" (68 65 6C 6C 6F)
			// Sequences_Section_Header: Number_of_Sequences=1, Symbol_Compression_Modes=0x54 (LL=RLE(1), Off=RLE(1), ML=RLE(1))
			// RLE bytes: LL_code=5 (literal length 5), Off_code=0 (repeat offset 1 -> offset=5? No, Off_code=3 -> offset = (1<<3) + 0 - 3 = 5, wait: RLE mode has 0 extra bits so Off_code=0 uses Repeat_Offset_1=1; if literal is "A" and ML=9, offset=1 repeats "A" 9 times!)
			// Let's test "AAAAAAAAAA" (10 'A's): Regenerated_Size=1 ("A"), LL=1, Off_code=0 (offset=1), ML_code=6 (matchLength = 6 + 3 = 9), bitstream=0x80 (single sentinel bit)
			const zstdCompressedFrame = Buffer.from([
				0x28, 0xb5, 0x2f, 0xfd, // magic
				0x20, 0x0a,             // FHD + FCS (10 bytes)
				0x45, 0x00, 0x00,       // Block Header: last=1, type=2 (Compressed_Block), size=8 ((8<<3)|5 = 0x45)
				0x08, 0x41,             // Raw literals header (size=1) + 'A'
				0x01, 0x54,             // 1 sequence, modes: LL=RLE, Off=RLE, ML=RLE
				0x01, 0x00, 0x06,       // LL=1, Off=0 (rep1=1), ML=6 (length=9)
				0x01                    // bitstream sentinel bit (0 data bits below bit 0)
			]);
			const zstdOut = zlib.zstdDecompressSync(zstdCompressedFrame);
			assert.strictEqual(zstdOut.toString("utf8"), "AAAAAAAAAA");
		}

		// 3. vm.runInNewContext frozen sandbox & non-enumerable properties
		{
			const frozenSb = Object.freeze({ x: 21 });
			assert.strictEqual(vm.runInNewContext("x * 2", frozenSb), 42);

			const nonEnumSb = {};
			Object.defineProperty(nonEnumSb, "secret", { value: 99, enumerable: false, writable: true, configurable: true });
			assert.strictEqual(vm.runInNewContext("secret + 1", nonEnumSb), 100);
		}

		// 4. Microtask / nextTick draining between consecutive timers
		{
			const order = [];
			await new Promise((resolve) => {
				setTimeout(() => {
					order.push("t1");
					process.nextTick(() => order.push("nt1"));
					Promise.resolve().then(() => order.push("p1"));
				}, 0);
				setTimeout(() => {
					order.push("t2");
					resolve();
				}, 0);
			});
			assert.deepStrictEqual(order, ["t1", "nt1", "p1", "t2"]);
		}

		// 5. Buffer.from(Uint16Array), Buffer.isEncoding, atob validation
		{
			const u16 = new Uint16Array([256, 257]);
			assert.deepStrictEqual([...Buffer.from(u16)], [0, 1]);
			assert.strictEqual(Buffer.isEncoding(null), false);
			assert.strictEqual(Buffer.isEncoding(""), false);
			assert.throws(() => atob("a"), (e) => e.name === "InvalidCharacterError");
		}

		// 6. EventEmitter errorMonitor, assert.deepStrictEqual non-enumerable, URL special schemes & host setter
		{
			const ee = new events.EventEmitter();
			let monitored = null;
			ee.on(events.errorMonitor, (e) => { monitored = e.message; });
			assert.throws(() => ee.emit("error", new Error("mon-err")), /mon-err/);
			assert.strictEqual(monitored, "mon-err");

			const o1 = { a: 1 };
			const o2 = { a: 1 };
			Object.defineProperty(o1, "hidden", { value: 123, enumerable: false });
			assert.doesNotThrow(() => assert.deepStrictEqual(o1, o2));
			assert.throws(() => assert.throws("not-a-fn"), (e) => e.code === "ERR_INVALID_ARG_TYPE");

			assert.strictEqual(new URL("http:example.com/p").href, "http://example.com/p");
			const u = new URL("http://example.com:8080/p");
			u.host = "other.com";
			assert.strictEqual(u.port, "8080");
		}

		// 7. fs.globSync dotfiles & withFileTypes exclude Dirent, FileHandle in fs.promises.readFile, fs.read 3-arg
		{
			const gdir = path.join(process.cwd(), "glob_test");
			fs.mkdirSync(path.join(gdir, ".hidden"), { recursive: true });
			fs.writeFileSync(path.join(gdir, ".hidden", "sec.txt"), "x");
			fs.writeFileSync(path.join(gdir, ".dotfile"), "x");
			fs.writeFileSync(path.join(gdir, "vis.txt"), "hello-fh");

			const matches = fs.globSync("**/*", { cwd: gdir });
			assert.deepStrictEqual(matches, ["vis.txt"]);

			let sawDirent = false;
			const dMatches = fs.globSync("*", {
				cwd: gdir,
				withFileTypes: true,
				exclude: (d) => {
					if (typeof d.isFile === "function") sawDirent = true;
					return false;
				},
			});
			assert.strictEqual(sawDirent, true);
			assert.strictEqual(dMatches.length, 1);

			const fh = await fsp.open(path.join(gdir, "vis.txt"), "r");
			assert.strictEqual(await fsp.readFile(fh, "utf8"), "hello-fh");
			await fh.close();

			const fd = fs.openSync(path.join(gdir, "vis.txt"), "r");
			const r3 = await new Promise((resolve, reject) => {
				fs.read(fd, { buffer: Buffer.alloc(8), length: 5 }, (err, bytesRead, buf) => {
					if (err) reject(err);
					else resolve(buf.subarray(0, bytesRead).toString("utf8"));
				});
			});
			fs.closeSync(fd);
			assert.strictEqual(r3, "hello");
		}

		// 8. AES-GCM 12-byte IV with 12-byte tag + multiple setAAD, and subtle.deriveBits non-byte-aligned length
		{
			const key = crypto.randomBytes(16);
			const iv = crypto.randomBytes(12);
			const c = crypto.createCipheriv("aes-128-gcm", key, iv, { authTagLength: 12 });
			c.setAAD(Buffer.from("part1-"));
			c.setAAD(Buffer.from("part2"));
			const enc = Buffer.concat([c.update("secret"), c.final()]);
			const tag = c.getAuthTag();
			assert.strictEqual(tag.length, 12);

			const d = crypto.createDecipheriv("aes-128-gcm", key, iv, { authTagLength: 12 });
			d.setAAD(Buffer.from("part1-part2"));
			d.setAuthTag(tag);
			const dec = Buffer.concat([d.update(enc), d.final()]);
			assert.strictEqual(dec.toString("utf8"), "secret");

			const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
			const bits13 = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: kp.publicKey }, kp.privateKey, 13));
			assert.strictEqual(bits13.byteLength, 2);
			assert.strictEqual(bits13[1] & 0x07, 0);
		}

		// 9. Worker process.exit(2) does not emit 'error', and dgram closed socket throws synchronously
		{
			const w = new Worker("process.exit(2);", { eval: true });
			let errored = false;
			w.on("error", () => { errored = true; });
			const exitCode = await new Promise((resolve) => w.on("exit", resolve));
			assert.strictEqual(exitCode, 2);
			assert.strictEqual(errored, false);

			const sock = dgram.createSocket("udp4");
			await new Promise((r) => sock.close(r));
			assert.throws(() => sock.send("hi", 12345, "127.0.0.1"), (e) => e.code === "ERR_SOCKET_DGRAM_NOT_RUNNING");
		}

		// 10. Shell ${X:-a b}, case (x), and cat -n
		{
			const sh1 = await $` + "`echo \\${UNSET_VAR:-hello world}`" + `.text();
			assert.strictEqual(sh1.trim(), "hello world");

			const sh2 = await $` + "`case foo in (foo) echo matched ;; esac`" + `.text();
			assert.strictEqual(sh2.trim(), "matched");

			const sh3 = await $` + "`printf 'line1\\nline2\\n' | cat -n`" + `.text();
			assert.ok(sh3.includes("1\tline1") && sh3.includes("2\tline2"), "unexpected cat -n: " + sh3);
		}

		console.log("ROUND26_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "round26.mjs")
		if exe, err := os.Executable(); err == nil {
			o.ExecPath = exe
		}
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 26 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "ROUND26_ALL_OK") {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round27AdversarialFixes(t *testing.T) {
	if w, err := brotliLookupStaticDict(4, 0); err != nil || string(w) != "time" {
		t.Fatalf("brotliLookupStaticDict(4, 0) = %q, %v; want %q", string(w), err, "time")
	}
	if w, err := brotliLookupStaticDict(4, 5<<10); err != nil || string(w) != "time the " {
		t.Fatalf("brotliLookupStaticDict(4, 5<<10) = %q, %v; want %q", string(w), err, "time the ")
	}
	wsDir := t.TempDir()
	code, out, errOut, err := runJS(t, `
		import assert from "node:assert";
		import zlib from "node:zlib";
		import crypto from "node:crypto";
		import { Readable } from "node:stream";
		import fs from "node:fs";
		import path from "node:path";
		import os from "node:os";
		import { createRequire } from "node:module";
		import { pathToFileURL } from "node:url";

		// 1. Zstd Predefined_Mode sequences (no panic on OF table)
		{
			const zstdPredefined = Buffer.from([
				0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x48,
				0x4d, 0x00, 0x00,
				0x18, 0x61, 0x62, 0x63,
				0x01, 0x00, 0x00, 0x18, 0x02,
			]);
			const dec = zlib.zstdDecompressSync(zstdPredefined);
			assert.strictEqual(dec.toString("utf8"), "abcccc");
		}

		// 2. Brotli static dictionary decompression ("hello" via RFC 7932 static dict)
		{
			const brDictHello = Buffer.from("0b028068656c6c6f03", "hex");
			assert.strictEqual(zlib.brotliDecompressSync(brDictHello).toString("utf8"), "hello");
			// Word reference from RFC 7932 static dictionary (" the ")
			const wordFromDict = brotliCheck();
			function brotliCheck() {
				const src = Buffer.from("the quick brown fox jumps over the lazy dog");
				const comp = zlib.brotliCompressSync(src);
				return zlib.brotliDecompressSync(comp).toString("utf8");
			}
			assert.strictEqual(wordFromDict, "the quick brown fox jumps over the lazy dog");
		}

		// 3. DiffieHellman key exchange + RFC 3526 modp14..modp18 byte lengths
		{
			const a = crypto.createDiffieHellman(512);
			a.generateKeys();
			const b = crypto.createDiffieHellman(a.getPrime(), a.getGenerator());
			b.generateKeys();
			assert.strictEqual(a.computeSecret(b.getPublicKey()).toString("hex"), b.computeSecret(a.getPublicKey()).toString("hex"));

			assert.strictEqual(crypto.getDiffieHellman("modp14").getPrime().length, 256);
			assert.strictEqual(crypto.getDiffieHellman("modp15").getPrime().length, 384);
			assert.strictEqual(crypto.getDiffieHellman("modp16").getPrime().length, 512);
			assert.strictEqual(crypto.getDiffieHellman("modp17").getPrime().length, 768);
			assert.strictEqual(crypto.getDiffieHellman("modp18").getPrime().length, 1024);
		}

		// 4. Readable 'readable' event + read() pattern
		{
			const r = Readable.from(["chunk1", "chunk2"]);
			const out = [];
			await new Promise((resolve) => {
				r.on("readable", () => {
					let c;
					while ((c = r.read()) !== null) {
						out.push(String(c));
					}
				});
				r.on("end", resolve);
			});
			assert.deepStrictEqual(out, ["chunk1", "chunk2"]);
		}

		// 5. Zlib createGzip + createGunzip multi-write single member
		{
			const gz = zlib.createGzip();
			const chunks = [];
			gz.on("data", (c) => chunks.push(c));
			const done = new Promise((resolve) => gz.on("end", resolve));
			gz.write("hello ");
			gz.write("world");
			gz.end();
			await done;
			const compressed = Buffer.concat(chunks);
			assert.strictEqual(zlib.gunzipSync(compressed).toString("utf8"), "hello world");
		}

		// 6. os.totalmem() / os.freemem() / os.loadavg()
		{
			assert.ok(os.totalmem() > 0);
			assert.ok(os.freemem() > 0);
			assert.strictEqual(os.loadavg().length, 3);
		}

		// 7. URL.searchParams live view after url.search = ... and url.href = ...
		{
			const u = new URL("https://example.com/?a=1");
			const sp = u.searchParams;
			u.search = "?b=2";
			assert.strictEqual(sp.get("b"), "2");
			assert.strictEqual(sp.get("a"), null);
			u.href = "https://example.com/?c=3";
			assert.strictEqual(sp.get("c"), "3");
		}

		// 8. TextDecoder rejects unsupported legacy encodings
		{
			assert.throws(() => new TextDecoder("gbk"), (e) => e.code === "ERR_ENCODING_NOT_SUPPORTED");
			assert.throws(() => new TextDecoder("big5"), (e) => e.code === "ERR_ENCODING_NOT_SUPPORTED");
		}

		// 9. Module.createRequire with trailing-slash directory URL
		{
			const dir = path.join(process.cwd(), "req_dir");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "mod.cjs"), "module.exports = 42;");
			const req = createRequire(pathToFileURL(dir + path.sep));
			assert.strictEqual(req("./mod.cjs"), 42);
		}

		// 10. EventTarget.dispatchEvent continues invoking remaining listeners when one throws
		{
			const et = new EventTarget();
			const seen = [];
			let caughtErr = null;
			const onUncaught = (e) => { caughtErr = e; };
			process.once("uncaughtException", onUncaught);
			et.addEventListener("ping", () => { seen.push(1); throw new Error("boom"); });
			et.addEventListener("ping", () => { seen.push(2); });
			et.dispatchEvent(new Event("ping"));
			assert.deepStrictEqual(seen, [1, 2]);
			await new Promise((r) => process.nextTick(r));
			assert.ok(caughtErr && caughtErr.message === "boom");
		}

		// 11. clearTimeout(t); t.refresh() does not fire, and setImmediate runs before setTimeout(0)
		{
			let firedCleared = false;
			const t = setTimeout(() => { firedCleared = true; }, 5);
			clearTimeout(t);
			t.refresh();
			const order = [];
			setTimeout(() => order.push("timeout"), 0);
			setImmediate(() => order.push("immediate"));
			await new Promise((r) => setTimeout(r, 25));
			assert.strictEqual(firedCleared, false);
			assert.strictEqual(order[0], "immediate");
		}

		// 12. Promise microtask vs nextTick ordering (t1 p1 p2 tn) from a fresh turn
		{
			const seq = await new Promise((resolve) => {
				setTimeout(() => {
					const s = [];
					Promise.resolve().then(() => {
						s.push("p1");
						process.nextTick(() => s.push("tn"));
					}).then(() => {
						s.push("p2");
					});
					process.nextTick(() => s.push("t1"));
					setTimeout(() => resolve(s), 10);
				}, 0);
			});
			assert.deepStrictEqual(seq, ["t1", "p1", "p2", "tn"]);
		}

		// 13. Hash and Hmac finalization state
		{
			const h = crypto.createHash("sha256").update("abc");
			h.digest("hex");
			assert.throws(() => h.digest("hex"), (e) => e.code === "ERR_CRYPTO_HASH_FINALIZED");
			assert.throws(() => h.update("def"), (e) => e.code === "ERR_CRYPTO_HASH_FINALIZED");

			const hm = crypto.createHmac("sha256", "k").update("abc");
			assert.strictEqual(hm.digest("hex").length, 64);
			assert.strictEqual(hm.digest("hex"), "");
			assert.strictEqual(hm.digest().length, 0);
			assert.throws(() => hm.update("def"), (e) => e.code === "ERR_CRYPTO_HASH_FINALIZED");
		}

		// 14. Buffer.alloc fill coercion, lastIndexOf(""), and OOM RangeError
		{
			assert.deepStrictEqual([...Buffer.alloc(3, false)], [0, 0, 0]);
			assert.deepStrictEqual([...Buffer.alloc(3, true)], [1, 1, 1]);
			assert.strictEqual(Buffer.from("abc").lastIndexOf(""), 3);
			assert.throws(() => Buffer.alloc(1500 * 1024 * 1024), RangeError);
		}

		console.log("ROUND27_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "round27.mjs")
		if exe, err := os.Executable(); err == nil {
			o.ExecPath = exe
		}
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 27 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "ROUND27_ALL_OK") {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round28AdversarialFixes(t *testing.T) {
	wsDir := t.TempDir()
	code, out, errOut, err := runJS(t, `
		import assert from "node:assert";
		import fs from "node:fs";
		import os from "node:os";
		import path from "node:path";
		import http from "node:http";
		import net from "node:net";
		import url, { fileURLToPath } from "node:url";
		import querystring from "node:querystring";
		import util from "node:util";
		import vm from "node:vm";
		import zlib from "node:zlib";
		import { Readable } from "node:stream";
		import { MessageChannel } from "node:worker_threads";
		import { createRequire } from "node:module";

		// 1. vm.runInContext Proxy sandbox + timeout validation
		{
			const proxy = new Proxy({ x: 10 }, {
				has(t, k) { return k === "magic" || k in t; },
				get(t, k, r) { return k === "magic" ? 42 : Reflect.get(t, k, r); }
			});
			const ctx = vm.createContext(proxy);
			assert.strictEqual(vm.runInContext("magic + x", ctx), 52);

			assert.throws(() => vm.runInNewContext("1", {}, { timeout: -1 }), (e) => e.code === "ERR_OUT_OF_RANGE");
			assert.throws(() => vm.runInNewContext("1", {}, { timeout: 0 }), (e) => e.code === "ERR_OUT_OF_RANGE");
			assert.throws(() => vm.runInNewContext("1", {}, { timeout: "100" }), (e) => e.code === "ERR_INVALID_ARG_TYPE");
		}

		// 2. HTTP trailers, closeAllConnections, closeIdleConnections, listen({signal}), ERR_UNESCAPED_CHARACTERS, fetch null-body
		{
			const srv = http.createServer((req, res) => {
				if (req.url === "/204") {
					res.writeHead(204);
					res.end();
					return;
				}
				if (req.url === "/trailer") {
					res.writeHead(200, { "Transfer-Encoding": "chunked", "Trailer": "X-Custom-Trailer" });
					res.write("chunk1");
					res.addTrailers({ "X-Custom-Trailer": "trailer-ok" });
					res.end();
					return;
				}
				res.end("ok");
			});
			await new Promise((r) => srv.listen(0, "127.0.0.1", r));
			const port = srv.address().port;

			const r204 = await fetch("http://127.0.0.1:" + port + "/204");
			assert.strictEqual(r204.status, 204);
			assert.strictEqual(r204.body, null);

			const rHead = await fetch("http://127.0.0.1:" + port + "/ok", { method: "HEAD" });
			assert.strictEqual(rHead.body, null);

			const trailerVal = await new Promise((resolve, reject) => {
				http.get("http://127.0.0.1:" + port + "/trailer", (res) => {
					res.resume();
					res.on("end", () => resolve(res.trailers["x-custom-trailer"]));
				}).on("error", reject);
			});
			assert.strictEqual(trailerVal, "trailer-ok");

			assert.throws(() => http.request({ host: "127.0.0.1", port, path: "/foo bar" }), (e) => e.code === "ERR_UNESCAPED_CHARACTERS");

			srv.closeIdleConnections();
			srv.closeAllConnections();
			await new Promise((r) => srv.close(r));

			const ac = new AbortController();
			const srvSig = http.createServer((_req, res) => res.end());
			await new Promise((r) => srvSig.listen({ port: 0, host: "127.0.0.1", signal: ac.signal }, r));
			const closePromise = new Promise((r) => srvSig.once("close", r));
			ac.abort();
			await closePromise;
		}

		// 3. Buffer.byteLength base64 & negative offsets, structuredClone uncloneables, util.parseArgs, util.types.isBigIntObject
		{
			assert.strictEqual(Buffer.byteLength("aGVsbG8=", "base64"), 5);
			assert.strictEqual(Buffer.byteLength("aGVsbG8", "base64url"), 5);
			assert.throws(() => Buffer.alloc(4).copy(Buffer.alloc(4), -1), (e) => e.code === "ERR_OUT_OF_RANGE");
			assert.throws(() => Buffer.alloc(4).fill("a", -1), (e) => e.code === "ERR_OUT_OF_RANGE");
			assert.throws(() => structuredClone(new WeakMap()), (e) => e.name === "DataCloneError");
			assert.throws(() => structuredClone(Promise.resolve(1)), (e) => e.name === "DataCloneError");

			assert.throws(() => util.parseArgs({ args: ["pos"], options: { a: { type: "boolean" } } }), (e) => e.code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL");
			assert.strictEqual(util.types.isBigIntObject(Object(1n)), true);
			assert.strictEqual(util.types.isBigIntObject(1n), false);
			assert.strictEqual(typeof util.log, "function");
		}

		// 4. path, url, querystring, Readable.push, MessagePort.close
		{
			assert.strictEqual(path.win32.normalize("//server/share"), "\\\\server\\share\\");
			assert.strictEqual(path.matchesGlob("./src/a.js", "src/*.js"), false);
			assert.throws(() => fileURLToPath("file:///a%ZZb"), URIError);
			assert.strictEqual(url.parse("http://[::1]:8080/p").hostname, "::1");
			assert.strictEqual(querystring.unescape("%E0%A4%A"), "\ufffd%A");

			const r = new Readable({ highWaterMark: 4, read() {} });
			assert.strictEqual(r.push("abcd"), false);

			const { port1, port2 } = new MessageChannel();
			const p2Close = new Promise((res) => port2.once("close", res));
			port1.close();
			await p2Close;
		}

		// 5. fs.utimesSync seconds, fs.createWriteStream autoClose:false fd, fs.watch ENOENT, require.resolve("fs"), package.json exports order
		{
			const req = createRequire(import.meta.url);
			assert.strictEqual(req.resolve("fs"), "fs");
			assert.strictEqual(req.resolve("node:fs"), "node:fs");

			fs.writeFileSync("utime_test.txt", "hi");
			fs.utimesSync("utime_test.txt", 1700000000, 1700000000);
			assert.strictEqual(Math.floor(fs.statSync("utime_test.txt").mtimeMs), 1700000000000);
			assert.throws(() => fs.utimesSync("utime_test.txt", "invalid", "invalid"), (e) => e.code === "ERR_INVALID_ARG_TYPE");

			const fd = fs.openSync("ws_autoclose.txt", "w");
			const ws = fs.createWriteStream(null, { fd, autoClose: false });
			await new Promise((res) => ws.end("keep-open", res));
			assert.strictEqual(fs.fstatSync(fd).size, 9);
			fs.closeSync(fd);

			assert.throws(() => fs.watch("nonexistent_watch_target_xyz"), (e) => e.code === "ENOENT");

			// Package exports condition key order
			const pkgDir = path.join("node_modules", "order-pkg");
			fs.mkdirSync(pkgDir, { recursive: true });
			fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({
				name: "order-pkg",
				exports: {
					".": {
						default: "./def.cjs",
						require: "./req.cjs"
					}
				}
			}));
			fs.writeFileSync(path.join(pkgDir, "def.cjs"), "module.exports = 'from-default';");
			fs.writeFileSync(path.join(pkgDir, "req.cjs"), "module.exports = 'from-require';");
			assert.strictEqual(req("order-pkg"), "from-default");
		}

		console.log("ROUND28_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "round28.mjs")
		if exe, err := os.Executable(); err == nil {
			o.ExecPath = exe
		}
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 28 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "ROUND28_ALL_OK") {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round29AdversarialFixes(t *testing.T) {
	wsDir := t.TempDir()
	code, out, errOut, err := runJS(t, `
		import assert from "node:assert";
		import http from "node:http";
		import util from "node:util";
		import { Worker, BroadcastChannel } from "node:worker_threads";

		// 1. ClientRequest mid-stream abort/destroy settles IncomingMessage async iterator and events
		{
			const srv = http.createServer((req, res) => {
				res.writeHead(200, { "Transfer-Encoding": "chunked" });
				res.write("chunk1");
			});
			await new Promise((r) => srv.listen(0, "127.0.0.1", r));
			const port = srv.address().port;

			// 1a. req.abort() during response body iteration
			const seen = [];
			await new Promise((resolve, reject) => {
				const req = http.get("http://127.0.0.1:" + port, async (res) => {
					let closeFired = false;
					res.on("close", () => { closeFired = true; });
					try {
						for await (const c of res) {
							seen.push(c.toString("utf8"));
							req.abort();
						}
					} catch (_) {}
					assert.strictEqual(res.aborted, true);
					await new Promise((r) => setTimeout(r, 10));
					assert.strictEqual(closeFired, true);
					resolve();
				});
				req.on("error", () => {});
			});
			assert.deepStrictEqual(seen, ["chunk1"]);

			// 1b. req.destroy(err) during response body iteration rejects for-await
			let caughtErr = null;
			await new Promise((resolve) => {
				const req = http.get("http://127.0.0.1:" + port, async (res) => {
					try {
						for await (const _ of res) {
							req.destroy(new Error("boom-destroy"));
						}
					} catch (e) {
						caughtErr = e;
					}
					resolve();
				});
				req.on("error", () => {});
			});
			assert.ok(caughtErr && caughtErr.message === "boom-destroy");
			srv.closeAllConnections();
			await new Promise((r) => srv.close(r));
		}

		// 2. POSIX shell evaluator: functions, local, set -e/-u/-o pipefail, trap EXIT, read, IFS splitting, command -v, !, { ... }, cd -, non-existent .cwd()
		{
			const fnOut = await $` + "`greet() { local x=inner; echo \"fn:$1:$x:$#\"; return 0; }; x=outer; greet world extra; echo \"after:$x\"`" + `.text();
			assert.strictEqual(fnOut.trim(), "fn:world:inner:2\nafter:outer");

			const setE = await $` + "`set -e; false; echo unreachable`" + `.nothrow();
			assert.strictEqual(setE.exitCode, 1);
			assert.strictEqual(setE.text().trim(), "");

			const setECond = await $` + "`set -e; if false; then echo no; else echo survived; fi`" + `.text();
			assert.strictEqual(setECond.trim(), "survived");

			const pipeFail = await $` + "`set -o pipefail; false | true`" + `.nothrow();
			assert.strictEqual(pipeFail.exitCode, 1);

			const setU = await $` + "`set -u; echo $DEFINITELY_UNSET_VAR_99`" + `.nothrow();
			assert.notStrictEqual(setU.exitCode, 0);

			const trapOut = await $` + "`trap 'echo trapped:$?' EXIT; echo body; (exit 3); echo after_sub`" + `.text();
			assert.strictEqual(trapOut.trim(), "body\nafter_sub\ntrapped:0");

			const readOut = await $` + "`printf 'alpha beta gamma\\n' | { read a b; echo \"[$a][$b]\"; }`" + `.text();
			assert.strictEqual(readOut.trim(), "[alpha][beta gamma]");

			const ifsOut = await $` + "`X='a:b:c'; IFS=:; for i in $X; do echo \"=$i\"; done`" + `.text();
			assert.strictEqual(ifsOut.trim(), "=a\n=b\n=c");

			const negOut = await $` + "`! true`" + `.nothrow();
			assert.strictEqual(negOut.exitCode, 1);

			const cmdV = await $` + "`command -v echo`" + `.text();
			assert.strictEqual(cmdV.trim(), "echo");

			const ansiC = await $` + "`printf '%s' $'a\\tb'`" + `.text();
			assert.strictEqual(ansiC, "a\tb");

			let cwdErr = null;
			try {
				await $` + "`echo hi`" + `.cwd("/definitely_nonexistent_dir_xyz_987654");
			} catch (e) {
				cwdErr = e;
			}
			assert.ok(cwdErr, "expected .cwd() on missing dir to throw");
			assert.strictEqual(cwdErr.code, "ENOENT");
		}

		// 3. process.on("rejectionHandled") + process.exitCode getter/setter validation + util.types.isProxy
		{
			let unhandledSeen = false;
			let handledSeen = false;
			const onUnhandled = () => { unhandledSeen = true; };
			const onHandled = () => { handledSeen = true; };
			process.on("unhandledRejection", onUnhandled);
			process.on("rejectionHandled", onHandled);

			const p = Promise.reject(new Error("late-handled"));
			await new Promise((r) => setTimeout(r, 20));
			assert.strictEqual(unhandledSeen, true);
			p.catch(() => {});
			await new Promise((r) => setTimeout(r, 20));
			assert.strictEqual(handledSeen, true);
			process.off("unhandledRejection", onUnhandled);
			process.off("rejectionHandled", onHandled);

			assert.strictEqual(process.exitCode, undefined);
			process.exitCode = "3";
			assert.strictEqual(process.exitCode, 3);
			assert.throws(() => { process.exitCode = "abc"; }, (e) => e.code === "ERR_INVALID_ARG_TYPE");
			assert.throws(() => { process.exitCode = 1.5; }, (e) => e.code === "ERR_OUT_OF_RANGE");
			process.exitCode = 0;

			const prox = new Proxy({}, {});
			assert.strictEqual(util.types.isProxy(prox), true);
			assert.strictEqual(util.types.isProxy({}), false);
		}

		// 4. BroadcastChannel cross-worker delivery and ref/unref/close lifecycle
		{
			const bc = new BroadcastChannel("r29-chan");
			const msgPromise = new Promise((resolve) => {
				bc.onmessage = (ev) => resolve(ev.data);
			});
			const w = new Worker(` + "`" + `
				const { BroadcastChannel } = require("node:worker_threads");
				const c = new BroadcastChannel("r29-chan");
				c.postMessage({ from: "worker", n: 42 });
				c.close();
			` + "`" + `, { eval: true });
			const got = await msgPromise;
			assert.deepStrictEqual(got, { from: "worker", n: 42 });
			await new Promise((r) => w.once("exit", r));
			bc.unref();
			bc.close();
		}

		console.log("ROUND29_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "round29.mjs")
		if exe, err := os.Executable(); err == nil {
			o.ExecPath = exe
		}
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 29 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "ROUND29_ALL_OK") {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round30AdversarialFixes(t *testing.T) {
	wsDir := t.TempDir()
	code, out, errOut, err := runJS(t, `
		import assert from "node:assert";
		import fs from "node:fs";
		import fsp from "node:fs/promises";
		import path from "node:path";
		import cp from "node:child_process";
		import http from "node:http";
		import net from "node:net";
		import dgram from "node:dgram";
		import crypto from "node:crypto";

		// 1. Long error message (>255 chars) from hostCall is not truncated
		{
			const longDir = path.join(process.cwd(), "a".repeat(300));
			let caught = null;
			try {
				fs.readFileSync(path.join(longDir, "missing.txt"));
			} catch (e) {
				caught = e;
			}
			assert.ok(caught && caught.message.length > 260, "expected full untruncated error message, got len=" + (caught && caught.message.length));
		}

		// 2. Shell ($) fixes: double-quoted "$?", "$@", "$*", heredocs <<EOF, <<'EOF', <<-EOF, EXIT trap in $(...), cp -r, uniq -c/-d/-u, syntax error on stray ;;
		{
			const q1 = await $`+"`false; echo \"status:$?\"`"+`.text();
			assert.strictEqual(q1.trim(), "status:1");

			const q2 = await $`+"`A='hello world'; B='foo'; echo \"pair:$A:$B\"`"+`.text();
			assert.strictEqual(q2.trim(), "pair:hello world:foo");

			const q3 = await $`+"`f() { for x in \"$@\"; do echo \"[$x]\"; done; }; f \"a b\" \"\" \"c\"`"+`.text();
			assert.strictEqual(q3.trim(), "[a b]\n[]\n[c]");

			const q4 = await $`+"`f() { for x in \"$@\"; do echo \"[$x]\"; done; }; f`"+`.text();
			assert.strictEqual(q4.trim(), "");

			const q5 = await $`+"`f() { IFS=:; echo \"$*\"; }; f a b c`"+`.text();
			assert.strictEqual(q5.trim(), "a:b:c");

			const hd1 = await $`+"`X=42; cat <<EOF\nval=$X\nEOF\n`"+`.text();
			assert.strictEqual(hd1.trim(), "val=42");

			const hd2 = await $`+"`X=42; cat <<'EOF'\nval=$X\nEOF\n`"+`.text();
			assert.strictEqual(hd2.trim(), "val=$X");

			const hd3 = await $`+"`cat <<-EOF\n\t\thello\n\tEOF\n`"+`.text();
			assert.strictEqual(hd3.trim(), "hello");

			const trapSub = await $`+"`trap 'echo parent_trap' EXIT; x=$(echo sub_ok); echo \"x=$x\"`"+`.text();
			assert.strictEqual(trapSub.trim(), "x=sub_ok\nparent_trap");

			const uniqOut = await $`+"`printf 'a\\na\\nb\\nc\\nc\\n' | uniq -d`"+`.text();
			assert.strictEqual(uniqOut.trim(), "a\nc");

			const uniqU = await $`+"`printf 'a\\na\\nb\\nc\\nc\\n' | uniq -u`"+`.text();
			assert.strictEqual(uniqU.trim(), "b");

			await $`+"`mkdir -p src_dir/sub && printf 'hi' > src_dir/sub/f.txt && cp -r src_dir dst_dir`"+`;
			assert.strictEqual(fs.readFileSync("dst_dir/sub/f.txt", "utf8"), "hi");

			const badSyn = await $`+"`;;`"+`.nothrow();
			assert.strictEqual(badSyn.exitCode, 2);

			const linesArr = await $`+"`printf 'l1\\nl2\\n'`"+`.lines();
			assert.deepStrictEqual(linesArr, ["l1", "l2"]);

			const iterLines = [];
			for await (const l of $`+"`printf 'm1\\nm2\\n'`"+`.lines()) {
				iterLines.push(l);
			}
			assert.deepStrictEqual(iterLines, ["m1", "m2"]);

			const ab = await $`+"`printf 'abc'`"+`.arrayBuffer();
			assert.strictEqual(ab.byteLength, 3);
		}

		// 3. FileHandle improvements: EventEmitter, 0-arg read(), options-object read({buffer}), EBADF after close
		{
			fs.writeFileSync("fh_test.txt", "0123456789");
			const fh = await fsp.open("fh_test.txt", "r");
			let closeFired = false;
			fh.on("close", () => { closeFired = true; });
			const r1 = await fh.read();
			assert.strictEqual(r1.bytesRead, 10);
			assert.strictEqual(r1.buffer.subarray(0, 10).toString("utf8"), "0123456789");

			const customBuf = Buffer.alloc(4);
			const r2 = await fh.read({ buffer: customBuf, offset: 0, length: 4, position: 3 });
			assert.strictEqual(r2.bytesRead, 4);
			assert.strictEqual(customBuf.toString("utf8"), "3456");

			await fh.close();
			assert.strictEqual(closeFired, true);
			await assert.rejects(() => fh.read(), (e) => e.code === "EBADF");
		}

		// 4. child_process: killSignal validation, ENOENT stdout iteration terminates, exec invalid encoding passes error to callback
		{
			assert.throws(() => {
				cp.spawnSync(process.execPath, ["-e", ""], { killSignal: "INVALID_SIG" });
			}, (e) => e.code === "ERR_UNKNOWN_SIGNAL");

			const badChild = cp.spawn("nonexistent_binary_xyz_987654", []);
			badChild.on("error", () => {});
			const chunks = [];
			for await (const c of badChild.stdout) {
				chunks.push(c);
			}
			assert.strictEqual(chunks.length, 0);
		}

		// 5. crypto.generatePrimeSync({ safe: true, bigint: true }) & checkPrimeSync
		{
			const p = crypto.generatePrimeSync(32, { safe: true, bigint: true });
			assert.strictEqual(typeof p, "bigint");
			assert.strictEqual(crypto.checkPrimeSync(p), true);
			assert.strictEqual(crypto.checkPrimeSync((p - 1n) / 2n), true);
		}

		// 6. HTTP Server + fetch HEAD & single-shot Content-Length & no forced Content-Type
		{
			const srv = http.createServer((req, res) => {
				if (req.url === "/nocontent") {
					res.statusCode = 204;
					res.end();
					return;
				}
				res.end("hello-world");
			});
			await new Promise((r) => srv.listen(0, "127.0.0.1", r));
			const port = srv.address().port;

			const headRes = await fetch("http://127.0.0.1:" + port + "/hello", { method: "HEAD" });
			assert.strictEqual(headRes.status, 200);
			assert.strictEqual(headRes.headers.get("content-length"), "11");
			assert.strictEqual(headRes.headers.get("content-type"), null);
			assert.strictEqual(await headRes.text(), "");

			const res204 = await fetch("http://127.0.0.1:" + port + "/nocontent");
			assert.strictEqual(res204.status, 204);
			assert.strictEqual(await res204.text(), "");

			await new Promise((r) => srv.close(r));
		}

		// 7. net.Socket bytesRead, bytesWritten, localAddress, localPort, readyState & dgram double-bind error
		{
			const netSrv = net.createServer((sock) => {
				sock.on("data", (d) => sock.end(d));
			});
			await new Promise((r) => netSrv.listen(0, "127.0.0.1", r));
			const nPort = netSrv.address().port;

			const client = net.connect(nPort, "127.0.0.1");
			assert.strictEqual(client.readyState, "opening");
			await new Promise((r) => client.once("connect", r));
			assert.strictEqual(client.readyState, "open");
			assert.strictEqual(client.localAddress, "127.0.0.1");
			assert.ok(client.localPort > 0);
			client.write("ping");
			const reply = await new Promise((r) => client.once("data", r));
			assert.strictEqual(reply.toString("utf8"), "ping");
			assert.strictEqual(client.bytesWritten, 4);
			assert.strictEqual(client.bytesRead, 4);
			client.end();
			await new Promise((r) => client.once("close", r));
			assert.strictEqual(client.readyState, "closed");
			await new Promise((r) => netSrv.close(r));

			const udp = dgram.createSocket("udp4");
			await new Promise((r) => udp.bind(0, "127.0.0.1", r));
			const bindErr = await new Promise((r) => {
				udp.once("error", r);
				udp.bind(0, "127.0.0.1");
			});
			assert.strictEqual(bindErr.code, "ERR_SOCKET_ALREADY_BOUND");
			await new Promise((r) => udp.close(r));
		}

		console.log("ROUND30_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "round30.mjs")
		if exe, err := os.Executable(); err == nil {
			o.ExecPath = exe
		}
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 30 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "ROUND30_ALL_OK") {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round31AdversarialFixes(t *testing.T) {
	wsDir := t.TempDir()

	code, out, errOut, err := runJS(t, `
		import assert from "node:assert";
		import http from "node:http";
		import net from "node:net";
		import util from "node:util";
		import cp from "node:child_process";

		// 1. Date local-time constructor, Date.parse, and local setters with TZ
		{
			const oldTZ = process.env.TZ;
			process.env.TZ = "America/New_York";
			try {
				const d1 = new Date(2020, 0, 1, 12, 30, 0);
				assert.strictEqual(d1.getHours(), 12);
				assert.strictEqual(d1.getMinutes(), 30);
				assert.strictEqual(d1.getUTCHours(), 17);
				assert.strictEqual(d1.getTimezoneOffset(), 300);

				const d2 = new Date("2020-01-01T12:30:00");
				assert.strictEqual(d2.getHours(), 12);
				assert.strictEqual(d2.getUTCHours(), 17);
				assert.strictEqual(Date.parse("2020-01-01T12:30:00"), d1.getTime());

				d1.setHours(9, 15, 0, 0);
				assert.strictEqual(d1.getHours(), 9);
				assert.strictEqual(d1.getMinutes(), 15);
				assert.strictEqual(d1.getUTCHours(), 14);

				d1.setFullYear(2020, 6, 15); // July (EDT = UTC-4)
				assert.strictEqual(d1.getFullYear(), 2020);
				assert.strictEqual(d1.getMonth(), 6);
				assert.strictEqual(d1.getDate(), 15);
				assert.strictEqual(d1.getHours(), 9);
				assert.strictEqual(d1.getTimezoneOffset(), 240);
				assert.strictEqual(d1.getUTCHours(), 13);

				assert.strictEqual(util.types.isDate(d1), true);
				assert.strictEqual(util.types.isProxy(Date), false);
			} finally {
				if (oldTZ === undefined) delete process.env.TZ;
				else process.env.TZ = oldTZ;
			}
			const resolvedTZ = new Intl.DateTimeFormat().resolvedOptions().timeZone;
			assert.strictEqual(typeof resolvedTZ, "string");
			assert.ok(resolvedTZ.length > 0);
		}

		// 2. HTTP response streaming backpressure (res.pause()), res.destroy() aborts server stream, and HTTP socket instances
		{
			let serverResClosed = false;
			let srvReqSocket = null;
			let srvResSocket = null;
			const srv = http.createServer((req, res) => {
				srvReqSocket = req.socket;
				srvResSocket = res.socket;
				res.on("close", () => { serverResClosed = true; });
				res.writeHead(200);
				const chunk = Buffer.alloc(65536, 0x41);
				function pump() {
					while (!res.destroyed) {
						if (!res.write(chunk)) {
							res.once("drain", pump);
							return;
						}
					}
				}
				pump();
			});
			await new Promise((r) => srv.listen(0, "127.0.0.1", r));
			const port = srv.address().port;

			let clientSocketEvent = null;
			await new Promise((resolve, reject) => {
				const clientReq = http.get("http://127.0.0.1:" + port, (res) => {
					res.pause();
					setTimeout(() => {
						try {
							assert.ok(res.readableLength <= res.readableHighWaterMark * 2, "res.readableLength bounded while paused: " + res.readableLength);
							assert.ok(res.socket instanceof net.Socket, "res.socket instanceof net.Socket");
							assert.strictEqual(res.socket.remoteAddress, "127.0.0.1");
							assert.strictEqual(res.socket.remotePort, port);
							assert.strictEqual(typeof res.socket.on, "function");
							res.destroy();
							resolve();
						} catch (e) {
							reject(e);
						}
					}, 80);
				});
				clientReq.on("socket", (s) => { clientSocketEvent = s; });
				clientReq.on("error", () => {});
			});

			// Wait briefly for server to observe client disconnect after res.destroy()
			for (let i = 0; i < 200 && !serverResClosed; i++) {
				await new Promise((r) => setTimeout(r, 10));
			}
			assert.strictEqual(serverResClosed, true, "res.destroy() must abort client fetch and close server response");
			assert.ok(clientSocketEvent instanceof net.Socket, "clientReq emitted socket event with net.Socket");
			assert.ok(srvReqSocket instanceof net.Socket, "server req.socket instanceof net.Socket");
			assert.strictEqual(srvResSocket, srvReqSocket, "server res.socket === req.socket");
			await new Promise((r) => srv.close(r));

			// 2b. Rapid stress for drain + abort/close event-batch races on ServerResponse and ClientRequest
			{
				const chunk = Buffer.alloc(65536, 0x43);
				let activeRes = null;
				let activeResClosed = false;
				const stressSrv = http.createServer((_req, res) => {
					activeRes = res;
					activeResClosed = false;
					res.on("close", () => { activeResClosed = true; });
					res.writeHead(200);
					function pump() {
						while (!res.destroyed) {
							if (!res.write(chunk)) {
								res.once("drain", pump);
								return;
							}
						}
					}
					pump();
				});
				await new Promise((r) => stressSrv.listen(0, "127.0.0.1", r));
				const stressPort = stressSrv.address().port;
				const delays = [0, 1, 5];
				for (let iter = 0; iter < 15; iter++) {
					const delay = delays[iter % delays.length];
					await new Promise((resolve) => {
						const creq = http.get("http://127.0.0.1:" + stressPort + "/?i=" + iter, (res) => {
							if (delay === 0 && iter % 6 === 0) {
								res.once("data", () => {
									res.destroy();
									resolve();
								});
								return;
							}
							res.pause();
							if (delay === 0) {
								res.destroy();
								resolve();
							} else {
								setTimeout(() => {
									res.destroy();
									resolve();
								}, delay);
							}
						});
						creq.on("error", () => {});
					});
					for (let i = 0; i < 200 && !activeResClosed; i++) {
						await new Promise((r) => setTimeout(r, 10));
					}
					assert.strictEqual(activeResClosed, true, "ServerResponse closed on stress iter " + iter);
					assert.strictEqual(activeRes.destroyed, true, "ServerResponse destroyed on stress iter " + iter);
				}
				await new Promise((r) => stressSrv.close(r));

				const dropSrv = http.createServer((req, _res) => {
					const idx = Number(new URL(req.url, "http://127.0.0.1").searchParams.get("i") || "0");
					if (idx % 2 === 0) {
						req.socket.destroy();
					} else {
						req.once("data", () => {
							req.socket.destroy();
						});
					}
				});
				await new Promise((r) => dropSrv.listen(0, "127.0.0.1", r));
				const dropPort = dropSrv.address().port;
				for (let iter = 0; iter < 10; iter++) {
					let clientReqRef = null;
					await new Promise((resolve) => {
						const req = http.request({
							hostname: "127.0.0.1",
							port: dropPort,
							path: "/upload?i=" + iter,
							method: "POST",
						});
						clientReqRef = req;
						let done = false;
						const finish = () => {
							if (!done) {
								done = true;
								resolve();
							}
						};
						req.on("error", () => {});
						req.on("close", finish);
						function pumpReq() {
							while (!req.destroyed) {
								if (!req.write(chunk)) {
									req.once("drain", pumpReq);
									return;
								}
							}
						}
						pumpReq();
					});
					assert.strictEqual(clientReqRef.destroyed, true, "ClientRequest destroyed on stress iter " + iter);
				}
				await new Promise((r) => dropSrv.close(r));
			}
		}

		// 3. Server request body backpressure (req.pause()) and ClientRequest write backpressure
		{
			let pausedReqLen = -1;
			let pausedReqHWM = -1;
			const srv = http.createServer((req, res) => {
				req.pause();
				setTimeout(() => {
					pausedReqLen = req.readableLength;
					pausedReqHWM = req.readableHighWaterMark;
					let total = 0;
					req.on("data", (c) => { total += c.length; });
					req.on("end", () => {
						res.end(String(total));
					});
					req.resume();
				}, 80);
			});
			await new Promise((r) => srv.listen(0, "127.0.0.1", r));
			const port = srv.address().port;

			const chunk = Buffer.alloc(65536, 0x42);
			let sawFalse = false;
			let maxWritableLen = 0;
			const bodyTotal = await new Promise((resolve, reject) => {
				const req = http.request({ hostname: "127.0.0.1", port, method: "POST" }, (res) => {
					let out = "";
					res.on("data", (c) => { out += c.toString(); });
					res.on("end", () => resolve(Number(out)));
				});
				req.on("error", reject);
				for (let i = 0; i < 32; i++) {
					const ok = req.write(chunk);
					if (!ok) sawFalse = true;
					if (req.writableLength > maxWritableLen) maxWritableLen = req.writableLength;
				}
				req.end();
			});
			assert.strictEqual(sawFalse, true, "ClientRequest.write must apply backpressure");
			assert.ok(maxWritableLen > 0, "ClientRequest.writableLength must reflect queued bytes");
			assert.ok(pausedReqLen <= pausedReqHWM * 2, "Server req.readableLength bounded while paused: " + pausedReqLen);
			assert.strictEqual(bodyTotal, 32 * 65536);
			await new Promise((r) => srv.close(r));
		}

		// 4. http.request pre-aborted signal produces err.code === "ABORT_ERR"
		{
			const ac = new AbortController();
			ac.abort();
			const abortErr = await new Promise((resolve) => {
				const req = http.request("http://127.0.0.1:9", { signal: ac.signal });
				req.on("error", resolve);
			});
			assert.strictEqual(abortErr.name, "AbortError");
			assert.strictEqual(abortErr.code, "ABORT_ERR");
		}

		// 5. execSync / exec respect shell: false (do not invoke shell when shell: false)
		{
			assert.throws(() => {
				cp.execSync("nonexistent_cmd_xyz_123 || echo bypassed", { shell: false });
			}, (e) => e.code === "ENOENT");
		}

		console.log("ROUND31_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "round31.mjs")
		if exe, err := os.Executable(); err == nil {
			o.ExecPath = exe
		}
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 31 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "ROUND31_ALL_OK") {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round32AdversarialFixes(t *testing.T) {
	wsDir := t.TempDir()
	code, out, errOut, err := runJS(t, `
		import assert from "node:assert";
		import EventsDefault, { EventEmitter, on } from "node:events";
		import { createRequire } from "node:module";
		import fs from "node:fs";
		import path from "node:path";
		import crypto from "node:crypto";
		import zlib from "node:zlib";
		import dns from "node:dns";
		import http from "node:http";
		import net from "node:net";
		import util from "node:util";

		const require = createRequire(import.meta.url);

		// 1. require('events') and import EventsDefault from 'node:events' is EventEmitter constructor
		assert.strictEqual(EventsDefault, EventEmitter);
		assert.strictEqual(require("events"), EventEmitter);
		assert.strictEqual(require("events").EventEmitter, EventEmitter);
		class SubEE extends require("events") {}
		const sub = new SubEE();
		assert.ok(sub instanceof EventEmitter);

		// 2. events.on synchronous listener registration before first .next()
		{
			const ee = new EventEmitter();
			const it = on(ee, "tick");
			ee.emit("tick", 42);
			const step = await it.next();
			assert.deepStrictEqual(step, { value: [42], done: false });
			await it.return();
			assert.strictEqual(ee.listenerCount("tick"), 0);
		}

		// 3. TransformStream writable error/abort propagates to readable
		{
			const ts = new TransformStream({
				transform() {
					throw new Error("boom-tx");
				},
			});
			const writer = ts.writable.getWriter();
			const reader = ts.readable.getReader();
			await assert.rejects(writer.write("x"), /boom-tx/);
			await assert.rejects(reader.read(), /boom-tx/);
		}
		{
			const ts = new TransformStream();
			const writer = ts.writable.getWriter();
			const reader = ts.readable.getReader();
			await writer.abort(new Error("aborted-tx"));
			await assert.rejects(reader.read(), /aborted-tx/);
		}

		// 4. fs.createReadStream.close(cb) & WriteStream.close(cb) when already closed, plus mkdtempSync('')
		{
			const f = path.join(process.cwd(), "r32.txt");
			fs.writeFileSync(f, "hello");
			const rs = fs.createReadStream(f);
			await new Promise((r) => rs.close(r));
			await new Promise((r) => rs.close(r));
			const ws = fs.createWriteStream(path.join(process.cwd(), "r32-w.txt"));
			await new Promise((r) => ws.close(r));
			await new Promise((r) => ws.close(r));
			assert.throws(() => fs.mkdtempSync(""), (e) => e.code === "EINVAL");
		}

		// 5. globSync './' prefix and trailing '/' directory pattern
		{
			fs.mkdirSync(path.join(process.cwd(), "gdir"), { recursive: true });
			fs.writeFileSync(path.join(process.cwd(), "gdir", "a.txt"), "1");
			const relMatches = fs.globSync("./gdir/*.txt");
			assert.strictEqual(relMatches.length, 1);
			const dirMatches = fs.globSync("*/");
			assert.ok(dirMatches.some((m) => m.replace(/\\/g, "/").replace(/\/$/, "") === "gdir"));
		}

		// 6. Hmac.update() after digest() throws ERR_CRYPTO_HASH_FINALIZED; KeyObject.equals unequal lengths returns false
		{
			const h = crypto.createHmac("sha256", "k").update("abc");
			h.digest("hex");
			assert.strictEqual(h.digest("hex"), "");
			assert.throws(() => h.update("more"), (e) => e.code === "ERR_CRYPTO_HASH_FINALIZED");
			const k1 = crypto.createSecretKey(Buffer.alloc(16, 1));
			const k2 = crypto.createSecretKey(Buffer.alloc(32, 1));
			assert.strictEqual(k1.equals(k2), false);
		}

		// 7. WebCrypto X25519 generateKey + exportKey + importKey + deriveBits
		{
			const kp = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
			const rawPub = await crypto.subtle.exportKey("raw", kp.publicKey);
			const pkcs8Priv = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
			const jwkPriv = await crypto.subtle.exportKey("jwk", kp.privateKey);
			const impPub = await crypto.subtle.importKey("raw", rawPub, { name: "X25519" }, true, []);
			const impPriv = await crypto.subtle.importKey("pkcs8", pkcs8Priv, { name: "X25519" }, true, ["deriveBits"]);
			const impJwk = await crypto.subtle.importKey("jwk", jwkPriv, { name: "X25519" }, true, ["deriveBits"]);
			const bits1 = await crypto.subtle.deriveBits({ name: "X25519", public: impPub }, impPriv, 256);
			const bits2 = await crypto.subtle.deriveBits({ name: "X25519", public: kp.publicKey }, impJwk, 256);
			assert.deepStrictEqual(Buffer.from(bits1), Buffer.from(bits2));
		}

		// 8. zlib maxOutputLength: 0 throws ERR_OUT_OF_RANGE
		{
			const gz = zlib.gzipSync("hello");
			assert.throws(() => zlib.gunzipSync(gz, { maxOutputLength: 0 }), (e) => e.code === "ERR_OUT_OF_RANGE");
		}

		// 9. dns.promises.Resolver returns promises while dns.Resolver uses callbacks
		{
			const pr = new dns.promises.Resolver();
			assert.ok(pr instanceof dns.promises.Resolver);
			assert.notStrictEqual(dns.promises.Resolver, dns.Resolver);
		}

		// 10. require.resolve(id, { paths }) searches all paths in array
		{
			const d1 = path.join(process.cwd(), "p1");
			const d2 = path.join(process.cwd(), "p2");
			fs.mkdirSync(path.join(d1, "node_modules"), { recursive: true });
			fs.mkdirSync(path.join(d2, "node_modules", "foundpkg"), { recursive: true });
			fs.writeFileSync(path.join(d2, "node_modules", "foundpkg", "index.js"), "module.exports = 1;");
			const resolved = require.resolve("foundpkg", { paths: [d1, d2] });
			assert.ok(resolved.includes("foundpkg"));
		}

		// 11. HTTP: for-await on bodyless GET req does not destroy res; large headers preserve custom statusMessage
		{
			const srv = http.createServer(async (req, res) => {
				const chunks = [];
				for await (const c of req) chunks.push(c);
				res.statusCode = 200;
				res.statusMessage = "Custom Long Header OK";
				for (let i = 0; i < 120; i++) {
					res.setHeader("X-Pad-" + i, "v".repeat(40));
				}
				res.end("ok:" + chunks.length);
			});
			await new Promise((r) => srv.listen(0, "127.0.0.1", r));
			const port = srv.address().port;
			const result = await new Promise((resolve, reject) => {
				http.get({ hostname: "127.0.0.1", port }, (res) => {
					let body = "";
					res.on("data", (c) => { body += c.toString(); });
					res.on("end", () => resolve({ statusMessage: res.statusMessage, body }));
				}).on("error", reject);
			});
			assert.strictEqual(result.statusMessage, "Custom Long Header OK");
			assert.strictEqual(result.body, "ok:0");
			await new Promise((r) => srv.close(r));
		}

		// 12. net.Socket client remoteFamily and performance.timeOrigin + performance.now()
		{
			const srv = net.createServer((s) => { s.on("error", () => {}); s.end("hi"); });
			await new Promise((r) => srv.listen(0, "127.0.0.1", r));
			const port = srv.address().port;
			const family = await new Promise((resolve, reject) => {
				const c = net.connect(port, "127.0.0.1", () => {
					resolve(c.remoteFamily);
					c.destroy();
				});
				c.on("error", reject);
			});
			assert.strictEqual(family, "IPv4");
			await new Promise((r) => srv.close(r));
			assert.ok(Math.abs((performance.timeOrigin + performance.now()) - Date.now()) < 2000);
		}

		// 13. $ internal shell: backslash-newline, quoted ${VAR:-"a b"}, undefined %VAR%, type builtin, pipeline empty stdin, subshell read
		{
			const r1 = await $` + "`" + `echo hel\
lo` + "`" + `.quiet();
			assert.strictEqual(r1.text().trim(), "hello");

			const r2 = await $` + "`" + `printf "<%s>" \${UNSET_R32:-"a b"}` + "`" + `.quiet();
			assert.strictEqual(r2.text(), "<a b>");

			const r3 = await $` + "`" + `echo %UNSET_WIN_VAR_R32%` + "`" + `.quiet();
			assert.strictEqual(r3.text().trim(), "%UNSET_WIN_VAR_R32%");

			fs.writeFileSync(path.join(process.cwd(), "echo"), "not-cat");
			const r4 = await $` + "`" + `type echo` + "`" + `.quiet();
			assert.ok(r4.text().includes("builtin"));

			const r5 = await $` + "`" + `echo hi | { true | cat; }` + "`" + `.quiet();
			assert.strictEqual(r5.text(), "");

			const r6 = await $` + "`" + `printf "line1\nline2\n" | { (read x; echo "sub:\$x"); read y; echo "parent:\$y"; }` + "`" + `.quiet();
			assert.strictEqual(r6.text().replace(/\r\n/g, "\n").trim(), "sub:line1\nparent:line2");
		}

		// 14. util.inspect default maxArrayLength is 100
		{
			const bigArr = Array.from({ length: 105 }, (_, i) => i);
			assert.ok(util.inspect(bigArr).includes("... 5 more items"));
		}

		console.log("ROUND32_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "round32.mjs")
		if exe, err := os.Executable(); err == nil {
			o.ExecPath = exe
		}
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 32 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "ROUND32_ALL_OK") {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round33AdversarialFixes(t *testing.T) {
	wsDir := t.TempDir()
	code, out, errOut, err := runJS(t, `
		import assert from "node:assert";
		import crypto from "node:crypto";
		import zlib from "node:zlib";
		import fs from "node:fs";
		import path from "node:path";
		import net from "node:net";
		import http from "node:http";
		import dgram from "node:dgram";
		import { spawn } from "node:child_process";
		import { StringDecoder } from "node:string_decoder";
		import { Readable } from "node:stream";

		// 1. Buffer.write encoding as 4th arg when length is undefined + clamped length
		{
			const b1 = Buffer.alloc(10);
			assert.strictEqual(b1.write("4142", 0, undefined, "hex"), 2);
			assert.strictEqual(b1.subarray(0, 2).toString(), "AB");
			const b2 = Buffer.alloc(4);
			assert.strictEqual(b2.write("abcd", 2, 4), 2);
			assert.strictEqual(b2.subarray(2, 4).toString(), "ab");
		}

		// 2. StringDecoder base64 buffer mutation safety + Blob.text() BOM stripping
		{
			const sd = new StringDecoder("base64");
			const u = Buffer.from([0x61, 0x62]);
			assert.strictEqual(sd.write(u), "");
			u[0] = 0x7a;
			assert.strictEqual(sd.end(Buffer.from([0x63])), "YWJj");
			const blob = new Blob([new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])]);
			assert.strictEqual(await blob.text(), "hi");
		}

		// 3. Crypto: Hash/Hmac/Sign mutation safety, Hmac double digest throws, RSA-PSS SHA-384 + saltLength: 0, EC sec1 export, ChaCha20-Poly1305
		{
			const mut = Buffer.from("hello");
			const h = crypto.createHash("sha256");
			h.update(mut);
			mut[0] = 0x58;
			assert.strictEqual(h.digest("hex"), crypto.createHash("sha256").update("hello").digest("hex"));

			const hm = crypto.createHmac("sha256", "secret");
			hm.update("msg");
			hm.digest();
			assert.strictEqual(hm.digest("hex"), "");
			assert.strictEqual(hm.digest().length, 0);
			assert.throws(() => hm.update("more"), { code: "ERR_CRYPTO_HASH_FINALIZED" });

			const { publicKey: pssPub, privateKey: pssPriv } = crypto.generateKeyPairSync("rsa-pss", { modulusLength: 2048 });
			assert.strictEqual(pssPriv.asymmetricKeyType, "rsa-pss");
			const pssSig = crypto.sign("sha256", Buffer.from("pss-msg"), { key: pssPriv, saltLength: 0 });
			assert.strictEqual(crypto.verify("sha256", Buffer.from("pss-msg"), { key: pssPub, saltLength: 0 }, pssSig), true);

			const { publicKey: rsaPub, privateKey: rsaPriv } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
			const sig224 = crypto.sign("sha224", Buffer.from("msg224"), rsaPriv);
			assert.strictEqual(crypto.verify("sha224", Buffer.from("msg224"), rsaPub, sig224), true);
			assert.strictEqual(crypto.verify("sha256", Buffer.from("msg224"), rsaPub, sig224), false);

			const { privateKey: ecPrivPem } = crypto.generateKeyPairSync("ec", {
				namedCurve: "prime256v1",
				privateKeyEncoding: { type: "sec1", format: "pem" },
				publicKeyEncoding: { type: "spki", format: "pem" },
			});
			assert.ok(ecPrivPem.includes("BEGIN EC PRIVATE KEY"));

			const key32 = Buffer.alloc(32, 7);
			const iv12 = Buffer.alloc(12, 3);
			const cip = crypto.createCipheriv("chacha20-poly1305", key32, iv12, { authTagLength: 16 });
			const enc = Buffer.concat([cip.update(Buffer.from("plain-text")), cip.final()]);
			const tag = cip.getAuthTag();
			const dec = crypto.createDecipheriv("chacha20-poly1305", key32, iv12, { authTagLength: 16 });
			dec.setAuthTag(tag);
			assert.strictEqual(Buffer.concat([dec.update(enc), dec.final()]).toString(), "plain-text");
		}

		// 4. WebCrypto RSA-PSS SHA-384 + saltLength: 0
		{
			const kp = await crypto.subtle.generateKey(
				{ name: "RSA-PSS", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-384" },
				true,
				["sign", "verify"]
			);
			const data = new TextEncoder().encode("webcrypto-pss");
			const sig = await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 0 }, kp.privateKey, data);
			const ok = await crypto.subtle.verify({ name: "RSA-PSS", saltLength: 0 }, kp.publicKey, sig, data);
			assert.strictEqual(ok, true);
		}

		// 5. Zlib: option validation + createDeflate mid-stream flush() produces single valid zlib stream
		{
			assert.throws(() => zlib.gzipSync("x", { level: 99 }), { code: "ERR_OUT_OF_RANGE" });
			assert.throws(() => zlib.gzipSync("x", { maxOutputLength: Infinity }), { code: "ERR_OUT_OF_RANGE" });
			const def = zlib.createDeflate();
			const outChunks = [];
			def.on("data", (c) => outChunks.push(c));
			const defDone = new Promise((r) => def.on("end", r));
			def.write("hello ");
			await new Promise((r) => def.flush(r));
			def.write("world");
			def.end();
			await defDone;
			assert.strictEqual(zlib.inflateSync(Buffer.concat(outChunks)).toString(), "hello world");
		}

		// 6. Web Headers iterable, FormData stringification & in-place set, Response type & Readable body
		{
			const h = new Headers(new Set([["x-a", "1"], ["x-b", "2"]]));
			assert.strictEqual(h.get("x-a"), "1");
			const fd = new FormData();
			fd.append("a", 123);
			fd.append("b", "two");
			fd.append("a", 456);
			assert.strictEqual(fd.get("a"), "123");
			fd.set("a", 999);
			assert.deepStrictEqual(Array.from(fd.keys()), ["a", "b"]);
			assert.strictEqual(fd.get("a"), "999");

			const resp = new Response(Readable.from(["part1-", "part2"]));
			assert.strictEqual(resp.type, "default");
			assert.strictEqual(await resp.text(), "part1-part2");
		}

		// 7. HTTP server responds without reading request body (no deadlock) + net server write-only socket close
		{
			const srv = http.createServer((req, res) => {
				res.writeHead(200, { "Content-Type": "text/plain" });
				res.end("ok-unread");
			});
			await new Promise((r) => srv.listen(0, "127.0.0.1", r));
			const port = srv.address().port;
			const resp = await fetch("http://127.0.0.1:" + port + "/upload", {
				method: "POST",
				body: "x".repeat(64 * 1024),
			});
			assert.strictEqual(resp.status, 200);
			assert.strictEqual(await resp.text(), "ok-unread");
			await new Promise((r) => srv.close(r));

			const netSrv = net.createServer((sock) => {
				sock.end("hello-net");
			});
			await new Promise((r) => netSrv.listen(0, "127.0.0.1", r));
			const nPort = netSrv.address().port;
			const got = await new Promise((resolve, reject) => {
				const c = net.connect({ port: nPort, host: "127.0.0.1", timeout: 5000 });
				const bufs = [];
				c.on("data", (d) => bufs.push(d));
				c.on("end", () => {
					c.end();
					resolve(Buffer.concat(bufs).toString());
				});
				c.on("error", reject);
			});
			assert.strictEqual(got, "hello-net");
			await new Promise((r) => netSrv.close(r));
		}

		// 8. ChildProcess.ref() after close does not leak event-loop ref + dgram.bind after close throws
		{
			const keep = setInterval(() => {}, 1000);
			const cp = spawn(process.execPath, ["--eval", "process.exit(0)"]);
			cp.unref();
			cp.on("exit", () => cp.ref());
			await new Promise((r) => cp.on("close", r));
			clearInterval(keep);
			cp.ref(); // must be a no-op after close

			const dg = dgram.createSocket("udp4");
			dg.close();
			assert.throws(() => dg.bind(0), { code: "ERR_SOCKET_DGRAM_NOT_RUNNING" });
		}

		console.log("ROUND33_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "round33.mjs")
		if exe, err := os.Executable(); err == nil {
			o.ExecPath = exe
		}
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 33 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "ROUND33_ALL_OK") {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}

func TestRunScript_Round34AdversarialFixes(t *testing.T) {
	wsDir := t.TempDir()
	code, out, errOut, err := runJS(t, `
		import assert from "node:assert";
		import fs from "node:fs";
		import path from "node:path";
		import crypto from "node:crypto";
		import { spawn } from "node:child_process";
		import { createRequire } from "node:module";

		const require = createRequire(import.meta.url);

		// 1. child_process.spawn does not deadlock when stdout/stderr is unconsumed and child emits >16 writes
		{
			const code1 = await new Promise((resolve, reject) => {
				const cp = spawn(process.execPath, [
					"--js",
					"-e",
					'for (let i = 0; i < 40; i++) console.error("err-line-" + i);',
				]);
				cp.on("error", reject);
				cp.on("close", (c) => resolve(c));
			});
			assert.strictEqual(code1, 0);

			const code2 = await new Promise((resolve, reject) => {
				const cp = spawn(process.execPath, [
					"-e",
					'for (let i = 0; i < 40; i++) console.log("out-line-" + i);',
				]);
				cp.on("error", reject);
				cp.on("close", (c) => resolve(c));
			});
			assert.strictEqual(code2, 0);
		}

		// 2. require("./mod.mjs") with regex literals containing /await/ or quotes does not misclassify as TLA
		{
			const mjsPath = path.join(process.cwd(), "regex_tla.mjs");
			fs.writeFileSync(mjsPath, 'const q = /foo"bar/;\nexport default /await/;\nexport const ok = q.test(\'foo"bar\');\n');
			const mod = require("./regex_tla.mjs");
			assert.strictEqual(mod.default.test("await"), true);
			assert.strictEqual(mod.ok, true);
		}

		// 3. fs.globSync normalizes . and .. segments in pattern (including **/..)
		{
			const gDir = path.join(process.cwd(), "glob_dotdot");
			fs.mkdirSync(path.join(gDir, "src", "sub"), { recursive: true });
			fs.writeFileSync(path.join(gDir, "top.js"), "1");
			fs.writeFileSync(path.join(gDir, "src", "a.js"), "2");
			fs.writeFileSync(path.join(gDir, "src", "sub", "b.js"), "3");

			const got = fs.globSync("src/**/../*.js", { cwd: gDir }).map((p) => p.replace(/\\/g, "/")).sort();
			assert.deepStrictEqual(got, ["src/a.js", "top.js"]);

			const gotDot = fs.globSync("src/./*.js", { cwd: gDir }).map((p) => p.replace(/\\/g, "/"));
			assert.deepStrictEqual(gotDot, ["src/a.js"]);
		}

		// 4. Promise rejection compaction when middle entries are handled
		{
			const first = Promise.reject(new Error("first"));
			for (let i = 0; i < 150; i++) {
				const p = Promise.reject(new Error("mid-" + i));
				p.catch(() => {});
			}
			first.catch(() => {});
			await new Promise((r) => setTimeout(r, 10));
		}

		// 5. Hmac vs Hash second digest() behavior
		{
			const h = crypto.createHash("sha256").update("abc");
			h.digest("hex");
			assert.throws(() => h.digest("hex"), { code: "ERR_CRYPTO_HASH_FINALIZED" });

			const hm = crypto.createHmac("sha256", "k").update("abc");
			assert.strictEqual(hm.digest("hex").length, 64);
			assert.strictEqual(hm.digest("hex"), "");
			assert.strictEqual(hm.digest().byteLength, 0);
		}

		console.log("ROUND34_ALL_OK");
	`, func(o *ScriptOptions) {
		o.CWD = wsDir
		o.Filename = filepath.Join(wsDir, "round34.mjs")
		if exe, err := os.Executable(); err == nil {
			o.ExecPath = exe
		}
	})
	if err != nil || code != 0 {
		t.Fatalf("Round 34 test failed (code=%d, stderr=%s): %v", code, errOut, err)
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "ROUND34_ALL_OK") {
		t.Fatalf("unexpected output: %q (stderr=%s)", out, errOut)
	}
}
