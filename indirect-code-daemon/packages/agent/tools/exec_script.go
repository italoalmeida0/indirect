package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"indirect/indirect-code-daemon/packages/core"
	"indirect/indirect-code-daemon/packages/provider"
	"net/url"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"
)

type ExecScriptArgs struct {
	// Code is the JavaScript snippet to execute in the built-in QuickJS-NG Node/Web/Shell runtime.
	Code string `json:"code"`
	// Stdin feeds text into the process standard input.
	Stdin string `json:"stdin,omitempty"`
	// Env adds extra environment variables (SANDBOX-safe keys only).
	Env map[string]string `json:"env,omitempty"`
	// Workdir overrides the run directory (jailed to CWD when sandboxed).
	Workdir string `json:"work_dir,omitempty"`
	// Legacy fields from migrated v4 Python tool calls (accepted so unmarshal does not fail with unknown field).
	LegacyLang string   `json:"legacy_lang,omitempty"`
	Script     string   `json:"script,omitempty"`
	Args       []string `json:"args,omitempty"`
}

// ExecScriptTool executes JavaScript code in the daemon's built-in QuickJS-NG
// Node.js / WinterCG Web / Shell ($) runtime. Like BashTool it is a
// command-execution tool: the frontend renders it as a terminal card, it
// participates in approval review, and the sandbox permission prompt covers
// it. There is deliberately NO timeout parameter: like bash, a run still going
// after AutoBackgroundAfter detaches into a background job.
type ExecScriptTool struct {
	// Starter launches the script. Nil = direct local execution; the
	// daemon injects the runner-backed starter (crash-only tasks).
	Starter Starter
	CWD     string
	Sandbox *Sandbox
	// Slow detaches long-running executions into a background job. Nil =
	// legacy behavior (block until the script ends).
	Slow   SlowHook
	LogDir string
	// BrainDir is the optional per-session scratch directory. When set,
	// foreground synchronous outputs exceeding 20KB spill losslessly to
	// <BrainDir>/tool-<callID>.log while returning a compact inline preview.
	BrainDir string
}

func (t *ExecScriptTool) Name() string { return "exec_script" }

func (t *ExecScriptTool) Description() string {
	return fmt.Sprintf("Execute JavaScript (`code`) in the built-in Node.js / Web / Shell runtime (powered by QuickJS-NG), with optional `stdin`, `env` and `work_dir`. "+
		"Supports ES2023+, top-level await, ES modules (`import`) and CommonJS (`require`), local file & node_modules resolution, "+
		"Node.js built-ins (`fs`, `fs/promises`, `path`, `os`, `child_process`, `crypto`, `zlib`, `http`, `https`, `net`, `dns`, `util`, `events`, `assert`, `url`, `buffer`, `stream`, `timers`, `process`), "+
		"Web globals (`fetch`, `Request`, `Response`, `Headers`, `FormData`, `Blob`, `File`, `URL`, `TextEncoder`, `TextDecoder`, `AbortController`, `crypto.subtle`), "+
		"and the shell helper `$` (e.g. `await $`git status`.text()`, `$.sync('ls -la')`). "+
		"Use for data analysis, structured file transforms, HTTP requests, hashing, or multi-step scripts. "+
		"Stdout/stderr are captured (truncated to last 2000 lines or 50KB, whichever is hit first); a non-zero exit is reported with the exit code. "+
		"There is no timeout: if the execution still runs after %s it automatically moves to the background (you are notified with a job id; read the output with bg_check, wait with bg_await, stop it with bg_cancel).", humanDuration(AutoBackgroundAfter))
}

const execScriptSchema = `{"type":"object","properties":{"code":{"type":"string","description":"JavaScript code to execute (supports top-level await, ES import, CommonJS require, Node built-ins, Web fetch/crypto, and $ shell helper)."},"stdin":{"type":"string","description":"Text piped to process.stdin."},"env":{"type":"object","additionalProperties":{"type":"string"},"description":"Extra environment variables."},"work_dir":{"type":"string","description":"Run directory (defaults to session CWD; jailed when sandboxed)."}},"required":["code"]}`

func (t *ExecScriptTool) Schema() json.RawMessage { return json.RawMessage(execScriptSchema) }

func (t *ExecScriptTool) Execute(ctx context.Context, raw json.RawMessage, progress func(string)) (core.ToolResult, error) {
	var a ExecScriptArgs
	if err := unmarshalArgs(raw, &a); err != nil {
		return core.ToolResult{}, err
	}
	if leg := strings.ToLower(strings.TrimSpace(a.LegacyLang)); leg == "python" || leg == "python3" {
		return core.ToolResult{}, fmt.Errorf("exec_script: legacy Python tool call cannot be re-executed; rewrite the snippet as JavaScript in `code`")
	}
	code := strings.TrimSpace(a.Code)
	if code == "" {
		if strings.TrimSpace(a.Script) != "" {
			return core.ToolResult{}, fmt.Errorf("exec_script: `code` is required (legacy `script` parameter %q is not supported; pass JavaScript in `code`)", a.Script)
		}
		return core.ToolResult{}, fmt.Errorf("exec_script: `code` is required")
	}

	// Resolve the working directory: session CWD by default, jailed when locked.
	dir := t.CWD
	if w := strings.TrimSpace(a.Workdir); w != "" {
		dir = resolvePath(t.CWD, w)
		if t.Sandbox != nil {
			if err := t.Sandbox.CheckPath(dir); err != nil {
				return core.ToolResult{}, fmt.Errorf("exec_script: invalid work_dir: %v", err)
			}
			if err := t.Sandbox.CheckReadPath(dir); err != nil {
				return core.ToolResult{}, fmt.Errorf("exec_script: invalid work_dir: %v", err)
			}
		}
	}

	if t.Sandbox != nil {
		if err := t.Sandbox.CheckExecScript(code); err != nil {
			return core.ToolResult{}, err
		}
		if err := t.Sandbox.CheckExecScriptPermission(); err != nil {
			return core.ToolResult{}, err
		}
	}

	// The background job label is clipped to 300 chars (+ …) so state.json
	// and UI rows stay compact regardless of script length.
	label := ClipLabel(code)
	exePath, _ := os.Executable()
	if exePath == "" {
		exePath = "indirect-code"
	}
	sh := currentShell()

	var jailRoots []string
	var readOnlyRoots []string
	var fsReadRoots []string
	var fsWriteRoots []string
	var netAllow []string
	if t.Sandbox != nil {
		jailRoots = t.Sandbox.JailRoots()
		readOnlyRoots = t.Sandbox.ReadOnlyRoots()
		fsReadRoots = t.Sandbox.FSReadScopes()
		fsWriteRoots = t.Sandbox.FSWriteScopes()
		netAllow = t.Sandbox.NetAllowScopes()
	}

	// Detach the process lifetime from the turn: once the execution
	// outlives AutoBackgroundAfter it becomes a background job and the
	// turn ending must not kill it — only an explicit stop does.
	noDedupe := a.Stdin != "" || strings.TrimSpace(a.Workdir) != "" || len(a.Env) > 0 || len(a.Args) > 0
	bgCtx, bgCancel := context.WithCancel(context.WithoutCancel(ctx))
	start := time.Now()
	argv := append([]string{exePath}, a.Args...)
	proc, err := startWith(bgCtx, t.Starter, ExecSpec{
		JobID:         core.ExecutionID(ctx),
		Kind:          "exec_script",
		Command:       label,
		Argv:          argv,
		CWD:           dir,
		Env:           execScriptEnv(a.Env),
		Stdin:         a.Stdin,
		Code:          a.Code,
		ShellPath:     sh.path,
		ShellFlag:     sh.flag,
		JailRoots:     jailRoots,
		ReadOnlyRoots: readOnlyRoots,
		FSReadRoots:   fsReadRoots,
		FSWriteRoots:  fsWriteRoots,
		NetAllow:      netAllow,
		NoDedupe:      noDedupe,
		LogDir:        t.LogDir,
		SplitStderr:   false,
	})
	if err != nil {
		bgCancel()
		return core.ToolResult{}, err
	}
	exited := proc.Exited
	var stdout bytes.Buffer
	var droppedBytes int64
	var droppedLines int
	var bufMu sync.Mutex
	var streamMu sync.Mutex
	var stream func(string)
	var detaching bool
	var preBuf []byte
	const preBufCap = 4 << 20
	var pumpWG sync.WaitGroup
	pump := func(pumpFn func(<-chan struct{}, func([]byte)), target *bytes.Buffer) {
		if pumpFn == nil {
			return // merged log (runner / direct): one pump feeds everything
		}
		pumpWG.Add(1)
		go func() {
			defer pumpWG.Done()
			w := &cappedWriter{W: target, Mu: &bufMu, Max: 256 * 1024, Dropped: &droppedBytes, DroppedLines: &droppedLines}
			pumpFn(exited, func(chunk []byte) {
				_, _ = w.Write(chunk)
				streamMu.Lock()
				sink := stream
				isDetaching := detaching
				if sink == nil && t.Slow != nil {
					preBuf = append(preBuf, chunk...)
					if len(preBuf) > preBufCap {
						preBuf = preBuf[len(preBuf)-preBufCap:]
					}
				}
				streamMu.Unlock()
				if sink != nil {
					sink(string(chunk))
				} else if !isDetaching && progress != nil {
					progress(string(chunk))
				}
			})
		}()
	}
	pump(proc.Pump, &stdout)
	pump(proc.PumpErr, &stdout)
	type jsOutcome struct{ runErr error }
	doneCh := make(chan jsOutcome, 1)
	go func() {
		err := proc.Wait()
		pumpWG.Wait()
		doneCh <- jsOutcome{runErr: err}
	}()
	stop := func() { bgCancel(); proc.Stop() }
	cleanup := func(remove bool) { proc.Cleanup(remove); bgCancel() }
	markInline := func() error {
		if proc.Disposition != nil && proc.JobID != "" {
			return proc.Disposition(proc.JobID, DispInline)
		}
		return nil
	}
	finishSync := func(runErr, ctxErr error) (core.ToolResult, error) {
		var fullText string
		var hasFull bool
		if strings.TrimSpace(t.BrainDir) != "" {
			bufMu.Lock()
			inMem := stdout.String()
			dropped := droppedBytes
			bufMu.Unlock()
			if dropped > 0 && proc.LogPath != "" {
				if rawBytes, readErr := os.ReadFile(proc.LogPath); readErr == nil {
					fullText = strings.TrimSuffix(string(rawBytes), "\n")
					hasFull = len(fullText) > ArrivalSpillThresholdBytes
				}
			}
			if !hasFull {
				fullText = strings.TrimSuffix(inMem, "\n")
				hasFull = len(fullText) > ArrivalSpillThresholdBytes
			}
		}
		inlineErr := markInline()
		cleanup(true)
		if inlineErr != nil {
			return core.ToolResult{}, fmt.Errorf("could not persist inline outcome: %w", inlineErr)
		}
		res, err := finishExecScriptCommand(runErr, ctxErr, stdout, start, progress, droppedBytes, droppedLines)
		if err != nil || !hasFull {
			return res, err
		}
		if spillRes, ok := maybeSpillOutput(ctx, t.BrainDir, fullText); ok {
			res.Content = []provider.Content{provider.TextBlock{Text: spillRes.Preview}}
			res.Attrs = applySpillAttrs(res.Attrs, spillRes)
			det, ok := res.Details.(map[string]any)
			if !ok || det == nil {
				det = make(map[string]any)
			}
			det["output"] = fullText
			det["full_output_path"] = spillRes.Path
			det["truncated"] = true
			res.Details = det
		}
		return res, nil
	}
	select {
	case out := <-doneCh:
		return finishSync(out.runErr, nil)
	case <-ctx.Done():
		stop()
		out := <-doneCh
		return finishSync(out.runErr, ctx.Err())
	case <-time.After(AutoBackgroundAfter):
		select {
		case out := <-doneCh:
			return finishSync(out.runErr, ctx.Err())
		case <-exited:
			out := <-doneCh
			return finishSync(out.runErr, ctx.Err())
		case <-ctx.Done():
			stop()
			out := <-doneCh
			return finishSync(out.runErr, ctx.Err())
		default:
		}
	}
	if t.Slow == nil {
		select {
		case out := <-doneCh:
			return finishSync(out.runErr, nil)
		case <-ctx.Done():
			stop()
			out := <-doneCh
			return finishSync(out.runErr, ctx.Err())
		}
	}
	streamMu.Lock()
	detaching = true
	streamMu.Unlock()
	if proc.Disposition != nil && proc.JobID != "" {
		if err := proc.Disposition(proc.JobID, DispBackground); err != nil {
			stop()
			<-doneCh
			cleanup(false)
			return core.ToolResult{}, fmt.Errorf("could not persist background disposition; process stopped, inspect it with bg_check (job_id %q): %w", proc.JobID, err)
		}
	}
	jobID, fullLog, sink, deliver := t.Slow("exec_script", code, BackgroundProcess{
		JobID:      proc.JobID,
		PID:        proc.PID,
		LogPath:    proc.LogPath,
		BrainLog:   proc.BrainLog,
		StderrPath: proc.ErrLogPath,
		NoDedupe:   noDedupe,
		StartedAt:  start.UnixMilli(),
		Stop:       stop,
	})
	if jobID == "" {
		stop()
		<-doneCh
		_ = markInline()
		cleanup(true)
		return core.ToolResult{}, fmt.Errorf("could not register background job; process stopped (job_id %q)", proc.JobID)
	}
	streamMu.Lock()
	if len(preBuf) > 0 && sink != nil {
		sink(string(preBuf))
	}
	preBuf = nil
	stream = sink
	streamMu.Unlock()
	go func() {
		out := <-doneCh
		cleanup(false)
		res, _ := finishExecScriptCommand(out.runErr, nil, stdout, start, nil, droppedBytes, droppedLines)
		text := ""
		for _, c := range res.Content {
			if tb, ok := c.(provider.TextBlock); ok {
				text = tb.Text
			}
		}
		det, ok := res.Details.(map[string]any)
		if !ok || det == nil {
			det = make(map[string]any)
			res.Details = det
		}
		det["background_job_id"] = jobID
		det["detached"] = true
		deliver(text, commandFailed(res.Attrs), commandExitCode(res.Attrs))
	}()
	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: execScriptBackgroundNotice(jobID, label, fullLog)}},
		Attrs: []core.Attr{
			{Key: "status", Value: "background"},
			{Key: "job_id", Value: jobID},
		},
		Details: map[string]any{"background_job_id": jobID},
	}, nil
}

func execScriptBackgroundNotice(jobID, label string, fullLog ...string) string {
	var b strings.Builder
	b.WriteString("Command moved to background (still running).\n")
	if len(fullLog) > 0 && fullLog[0] != "" {
		fmt.Fprintf(&b, "The complete output is saved to %s when the command finishes.\n", fullLog[0])
	}
	fmt.Fprintf(&b, "To read the output, call bg_check with job_id %q (paged log: tail by default, offset/limit for more).\n", jobID)
	fmt.Fprintf(&b, "To force-stop it early, call bg_cancel with job_id %q.\n", jobID)
	b.WriteString("You are woken automatically when the task finishes — its completion notice is delivered to you then.\n")
	b.WriteString("While waiting, call bg_await with waiting_for=<job_id> and a reason - it ends early the moment this task finishes. Do not use a shell sleep command to wait: inside a command it would detach into yet another background task and only add noise.")
	return b.String()
}

func finishExecScriptCommand(runErr error, ctxErr error, stdout bytes.Buffer, start time.Time, progress func(string), droppedBytes int64, droppedLines int) (core.ToolResult, error) {
	_ = progress
	duration := time.Since(start)
	dropped := droppedBytes

	// stdout and stderr are merged at the stream level, exactly like bash:
	// the body is ONLY the program's own bytes. No "[stderr]" marker — a
	// script that prints that literal string would be indistinguishable from
	// a system label.
	text := strings.TrimSuffix(stdout.String(), "\n")
	truncation := truncateTail(text, defaultMaxLines, defaultMaxBytes)
	outputText := truncation.content
	wasTruncated := truncation.truncated || dropped > 0
	totalLines := truncation.totalLines + droppedLines
	if wasTruncated && totalLines < 1 {
		totalLines = 1
	}
	var attrs []core.Attr
	if outputText == "" {
		attrs = append(attrs, core.Attr{Key: "info", Value: "no output"})
	}
	if wasTruncated {
		attrs = append(attrs, core.Attr{Key: "truncated", Value: "true"})
		startLine := totalLines - truncation.outputLines + 1
		if startLine < 1 {
			startLine = 1
		}
		if startLine > totalLines {
			startLine = totalLines
		}
		endLine := totalLines
		attrs = append(attrs, core.Attr{Key: "page", Value: fmt.Sprintf("%d-%d/%d", startLine, endLine, totalLines)})
		if dropped > 0 {
			attrs = append(attrs, core.Attr{Key: "dropped_bytes", Value: fmt.Sprintf("%d", dropped)})
		}
	}
	// Command outcome is a FACT (attr), not an error: a non-zero exit is
	// type="ok" exit="N". Only tool misuse is type="error".
	type exitCodeCarrier interface {
		ExitCode() int
	}
	if ctxErr != nil {
		attrs = append(attrs, core.Attr{Key: "status", Value: "aborted"})
	} else if runErr != nil {
		var ec exitCodeCarrier
		if errors.As(runErr, &ec) {
			attrs = append(attrs, core.Attr{Key: "exit", Value: fmt.Sprintf("%d", ec.ExitCode())})
		} else {
			attrs = append(attrs, core.Attr{Key: "status", Value: "failed"})
			attrs = append(attrs, core.Attr{Key: "error", Value: runErr.Error()})
		}
	} else {
		attrs = append(attrs, core.Attr{Key: "exit", Value: "0"})
	}
	attrs = append(attrs, core.Attr{Key: "duration", Value: humanDuration(duration)})

	var details any
	if wasTruncated {
		startLine := totalLines - truncation.outputLines + 1
		if startLine < 1 {
			startLine = 1
		}
		if startLine > totalLines {
			startLine = totalLines
		}
		det := map[string]any{
			"truncated": true,
			"page":      fmt.Sprintf("%d-%d/%d", startLine, totalLines, totalLines),
		}
		if dropped > 0 {
			det["dropped_bytes"] = dropped
		}
		details = det
	}

	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: outputText}},
		Attrs:   attrs,
		Details: details,
	}, nil
}

func execScriptEnv(extra map[string]string) []string {
	rawEnviron := os.Environ()
	env := make([]string, 0, len(rawEnviron)+len(extra))
	idxByKey := make(map[string]int, len(rawEnviron)+len(extra))
	normEnvKey := func(k string) string {
		if runtime.GOOS == "windows" {
			return strings.ToUpper(k)
		}
		return k
	}
	for _, kv := range rawEnviron {
		idx := strings.IndexByte(kv, '=')
		if idx <= 0 {
			continue
		}
		k := kv[:idx]
		v := kv[idx+1:]
		if !validEnvKey(k) || isBlockedExecScriptEnvKey(k) || isDaemonSecretEnvKey(k) {
			continue
		}
		nk := normEnvKey(k)
		if _, ok := idxByKey[nk]; ok {
			continue
		}
		v = sanitizeProxyEnvVal(k, v)
		idxByKey[nk] = len(env)
		env = append(env, k+"="+v)
	}
	for k, v := range extra {
		if !validEnvKey(k) || isBlockedExecScriptEnvKey(k) {
			continue
		}
		v = sanitizeProxyEnvVal(k, v)
		nk := normEnvKey(k)
		if idx, ok := idxByKey[nk]; ok {
			env[idx] = k + "=" + v
		} else {
			idxByKey[nk] = len(env)
			env = append(env, k+"="+v)
		}
	}
	return env
}

func isDaemonSecretEnvKey(k string) bool {
	u := strings.ToUpper(strings.TrimSpace(k))
	if u == "META_API_KEY" || u == "GATEWAY_SECRET" || strings.HasPrefix(u, "INDIRECT_") {
		return true
	}
	if strings.HasSuffix(u, "_API_KEY") || strings.HasSuffix(u, "_SECRET") || strings.HasSuffix(u, "_PASSWORD") || strings.HasSuffix(u, "_PRIVATE_KEY") {
		return true
	}
	return false
}

func sanitizeProxyEnvVal(k, v string) string {
	switch strings.ToUpper(strings.TrimSpace(k)) {
	case "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY":
		if u, err := url.Parse(v); err == nil && u.User != nil {
			u.User = nil
			return u.String()
		}
		if idx := strings.Index(v, "://"); idx >= 0 {
			rest := v[idx+3:]
			if at := strings.IndexByte(rest, '@'); at >= 0 {
				slash := strings.IndexByte(rest, '/')
				if slash < 0 || at < slash {
					return v[:idx+3] + rest[at+1:]
				}
			}
		}
	}
	return v
}

func isBlockedExecScriptEnvKey(k string) bool {
	u := strings.ToUpper(strings.TrimSpace(k))
	if strings.HasPrefix(u, "__INDIRECT_") ||
		strings.HasPrefix(u, "LD_") ||
		strings.HasPrefix(u, "_LD_") ||
		strings.HasPrefix(u, "DYLD_") ||
		strings.HasPrefix(u, "GIT_CONFIG_KEY_") ||
		strings.HasPrefix(u, "GIT_CONFIG_VALUE_") {
		return true
	}
	switch u {
	case "NODE_OPTIONS", "BASH_ENV", "ENV", "PROMPT_COMMAND",
		"GCONV_PATH", "LOCPATH", "NLSPATH", "HOSTALIASES",
		"BROWSER", "MANPAGER", "MANPATH", "MANOPT",
		"GNUPGHOME", "GPG_TTY", "GPG_AGENT_INFO",
		"GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS", "GIT_EXEC_PATH",
		"GIT_TEMPLATE_DIR", "GIT_EXTERNAL_DIFF", "GIT_PAGER", "GIT_EDITOR",
		"GIT_SEQUENCE_EDITOR", "GIT_PROXY_COMMAND", "GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM",
		"GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_DIR", "GIT_GRAFT_FILE",
		"GIT_REPLACE_REF_BASE", "GIT_CONFIG", "GIT_CONFIG_GLOBAL",
		"GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_COUNT",
		"GIT_CONFIG_PARAMETERS":
		return true
	}
	return false
}

func validEnvKey(k string) bool {
	if k == "" || len(k) > 128 {
		return false
	}
	for i, r := range k {
		if i == 0 && r >= '0' && r <= '9' {
			return false
		}
		if (r < 'A' || r > 'Z') && (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '_' && r != '(' && r != ')' {
			return false
		}
	}
	return true
}

// cappedWriter bounds captured output with a rolling tail window so a runaway
// print loop cannot blow up memory while still preserving the tail of the output.
// Compaction is amortized (triggers at 2*Max) so appends remain O(1) amortized.
type cappedWriter struct {
	W            *bytes.Buffer
	Mu           *sync.Mutex
	Max          int
	Dropped      *int64
	DroppedLines *int
}

func (c *cappedWriter) Write(p []byte) (int, error) {
	if c.Mu != nil {
		c.Mu.Lock()
		defer c.Mu.Unlock()
	}
	origLen := len(p)
	if c.Max <= 0 {
		return c.W.Write(p)
	}
	if len(p) >= c.Max {
		cur := c.W.Bytes()
		evictedFromP := p[:len(p)-c.Max]
		if c.Dropped != nil {
			*c.Dropped += int64(len(cur) + len(evictedFromP))
		}
		if c.DroppedLines != nil {
			*c.DroppedLines += bytes.Count(cur, []byte{'\n'}) + bytes.Count(evictedFromP, []byte{'\n'})
		}
		c.W.Reset()
		_, err := c.W.Write(p[len(p)-c.Max:])
		return origLen, err
	}
	_, err := c.W.Write(p)
	if c.W.Len() >= 2*c.Max {
		cur := c.W.Bytes()
		dropLen := len(cur) - c.Max
		evicted := cur[:dropLen]
		if c.Dropped != nil {
			*c.Dropped += int64(dropLen)
		}
		if c.DroppedLines != nil {
			*c.DroppedLines += bytes.Count(evicted, []byte{'\n'})
		}
		tail := make([]byte, c.Max)
		copy(tail, cur[dropLen:])
		c.W.Reset()
		_, _ = c.W.Write(tail)
	}
	return origLen, err
}
