package runner

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/italoalmeida0/unish/pkg/unish"

	"indirect/indirect-code-daemon/packages/agent/tools"
	"indirect/indirect-code-daemon/packages/qjs"
)

// CommandMain is an internal role of the same binary. No user code runs until
// the runner has published ownership and released the private stdin gate.
// EOF before release is a cancelled launch, including a hard-killed runner.
func CommandMain() int {
	// Keep the group leader alive while its children handle TERM. The
	// runner's escalation kills the group if a child refuses to exit.
	sigc := make(chan os.Signal, 2)
	signal.Notify(sigc, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(sigc)
	type handshake struct {
		payload  commandLaunch
		released bool
		err      error
	}
	ready := make(chan handshake, 1)
	go func() {
		var h handshake
		d := json.NewDecoder(os.Stdin)
		if h.err = d.Decode(&h.payload); h.err == nil {
			h.err = d.Decode(&h.released)
		}
		ready <- h
	}()
	var h handshake
	select {
	case h = <-ready:
	case <-time.After(30 * time.Second):
		_, _ = os.Stderr.WriteString("runner: launch handshake timed out\n")
		return 75
	}
	spec := h.payload.Spec
	if h.err != nil || !h.released || spec.Validate() != nil {
		_, _ = os.Stderr.WriteString("runner: invalid launch specification\n")
		return 75
	}
	_ = os.Stdin.Close() // the payload never inherits the launch channel

	approver, closeApprover := newCommandIPCApprover(h.payload.ControlAddr, h.payload.ControlToken, spec.JobID)
	defer closeApprover()

	if spec.Kind == "exec_script" {
		if strings.TrimSpace(spec.Code) == "" {
			_, _ = os.Stderr.WriteString("runner: empty exec_script code\n")
			return 75
		}
		return runExecScriptSpec(spec, approver, sigc)
	}

	script, useEmbeddedUnish := extractEmbeddedShellScript(spec)
	if useEmbeddedUnish {
		return runEmbeddedShellSpec(spec, script, approver, sigc)
	}

	cmd := exec.Command(spec.Path, spec.Args...)
	cmd.Dir, cmd.Env = spec.CWD, utf8Env(spec.Env)
	cmd.Stdin = strings.NewReader(spec.Stdin)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	// Inherit the bootstrap's group/job: ownership was committed before GO.
	if err := cmd.Start(); err != nil {
		_, _ = os.Stderr.WriteString("runner: failed to start command: " + err.Error() + "\n")
		return 127
	}
	done := make(chan struct{})
	defer close(done)
	go func() {
		for {
			select {
			case s := <-sigc:
				if cmd.Process != nil {
					if err := cmd.Process.Signal(s); err != nil {
						_ = cmd.Process.Kill()
					}
				}
			case <-done:
				return
			}
		}
	}()
	return exitCodeOf(cmd.Wait())
}

func extractEmbeddedShellScript(spec Spec) (string, bool) {
	if spec.RawScript != "" {
		return spec.RawScript, true
	}
	if len(spec.Args) >= 2 && spec.Args[0] == "--sh-c" {
		return spec.Args[1], true
	}
	if spec.Jail != nil && spec.Kind == "bash" {
		if len(spec.Args) >= 2 && (spec.Args[0] == "-c" || spec.Args[0] == "-lc") {
			return spec.Args[1], true
		}
		if len(spec.Args) == 1 {
			return spec.Args[0], true
		}
		return "", true
	}
	return "", false
}

func runEmbeddedShellSpec(spec Spec, script string, approver tools.MidExecApprover, sigc <-chan os.Signal) int {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var sigCode atomic.Int32
	go func() {
		select {
		case s := <-sigc:
			if s == syscall.SIGINT {
				sigCode.Store(130)
			} else {
				sigCode.Store(143)
			}
			cancel()
		case <-ctx.Done():
		}
	}()

	cwd := spec.CWD
	if cwd == "" && spec.Jail != nil {
		cwd = spec.Jail.Workspace
	}
	if cwd != "" {
		if abs, err := filepath.Abs(cwd); err == nil {
			cwd = abs
		}
	}
	envSlice := utf8Env(spec.Env)
	var stdin io.Reader = strings.NewReader(spec.Stdin)

	if spec.Jail != nil {
		rt, err := tools.NewPolicyRuntime(*spec.Jail, envSlice, approver)
		if err != nil {
			_, _ = fmt.Fprintf(os.Stderr, "runner: policy runtime error: %v\n", err)
			return 75
		}
		code, execErr := rt.ExecShell(ctx, script, cwd, envSlice, stdin, os.Stdout, os.Stderr)
		if sc := int(sigCode.Load()); sc != 0 {
			return sc
		}
		if ctx.Err() != nil {
			return 143
		}
		if execErr != nil && code == 0 {
			_, _ = fmt.Fprintf(os.Stderr, "unish: %v\n", execErr)
			return 1
		}
		return code
	}

	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	sess, err := unish.NewSession(
		unish.WithWorkDir(cwd),
		unish.WithInheritEnv(false),
		unish.WithEnv(envSlice),
	)
	if err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "unish: %v\n", err)
		return 127
	}
	defer func() { _ = sess.Close() }()

	res, execErr := sess.ExecWith(ctx, script, unish.ExecOptions{
		Stdin:  stdin,
		Stdout: os.Stdout,
		Stderr: os.Stderr,
	})
	if sc := int(sigCode.Load()); sc != 0 {
		return sc
	}
	if ctx.Err() != nil {
		return 143
	}
	if execErr != nil && res.ExitCode == 0 {
		_, _ = fmt.Fprintf(os.Stderr, "unish: %v\n", execErr)
		return 1
	}
	return res.ExitCode
}

func runExecScriptSpec(spec Spec, approver tools.MidExecApprover, sigc <-chan os.Signal) int {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var sigCode atomic.Int32
	go func() {
		select {
		case s := <-sigc:
			if s == syscall.SIGINT {
				sigCode.Store(130)
			} else {
				sigCode.Store(143)
			}
			cancel()
		case <-ctx.Done():
		}
	}()

	cwd := spec.CWD
	if cwd == "" && spec.Jail != nil {
		cwd = spec.Jail.Workspace
	}
	if cwd != "" {
		if abs, err := filepath.Abs(cwd); err == nil {
			cwd = abs
		}
		if err := os.Chdir(cwd); err != nil {
			_, _ = fmt.Fprintf(os.Stderr, "chdir %s: %v\n", spec.CWD, err)
			return 127
		}
	}

	var rt *tools.PolicyRuntime
	envSlice := utf8Env(spec.Env)
	if spec.Jail != nil {
		var err error
		rt, err = tools.NewPolicyRuntime(*spec.Jail, envSlice, approver)
		if err != nil {
			_, _ = fmt.Fprintf(os.Stderr, "runner: policy runtime error: %v\n", err)
			return 75
		}
		envSlice = rt.PrepareEnv(envSlice)
	}

	envMap := make(map[string]string, len(envSlice))
	for _, kv := range envSlice {
		if idx := strings.IndexByte(kv, '='); idx > 0 {
			envMap[kv[:idx]] = kv[idx+1:]
		}
	}
	var stdinReader *strings.Reader
	if spec.Stdin != "" {
		stdinReader = strings.NewReader(spec.Stdin)
	}
	opts := qjs.ScriptOptions{
		Code:          spec.Code,
		Filename:      "<exec_script>",
		Args:          spec.Args,
		CWD:           cwd,
		Env:           envMap,
		Stdout:        os.Stdout,
		Stderr:        os.Stderr,
		ExecPath:      spec.Path,
		ShellPath:     spec.ShellPath,
		ShellFlag:     spec.ShellFlag,
		JailRoots:     spec.JailRoots,
		ReadOnlyRoots: spec.ReadOnlyRoots,
		FSReadRoots:   spec.FSReadRoots,
		FSWriteRoots:  spec.FSWriteRoots,
		NetAllow:      spec.NetAllow,
	}
	if stdinReader != nil {
		opts.Stdin = stdinReader
	}
	if rt != nil {
		opts = rt.QJSOptions(opts)
	}
	code, err := qjs.RunScript(ctx, opts)
	if sc := int(sigCode.Load()); sc != 0 {
		return sc
	}
	if ctx.Err() != nil {
		return 143
	}
	if err != nil && code == 0 {
		return 1
	}
	return code
}

type commandIPCClient struct {
	addr    string
	token   string
	jobID   string
	mu      sync.Mutex
	raw     net.Conn
	conn    *Conn
	closed  chan struct{}
	waiters map[string]chan tools.MidExecApprovalResp
	seq     atomic.Uint64
	stopped bool
}

func newCommandIPCApprover(addr, token, jobID string) (tools.MidExecApprover, func()) {
	if addr == "" || token == "" {
		return func(ctx context.Context, req tools.MidExecApprovalReq) (tools.MidExecApprovalResp, error) {
			return tools.MidExecApprovalResp{Decision: "deny"}, nil
		}, func() {}
	}
	cli := &commandIPCClient{
		addr:    addr,
		token:   token,
		jobID:   jobID,
		waiters: make(map[string]chan tools.MidExecApprovalResp),
	}
	return cli.ask, cli.close
}

func (c *commandIPCClient) ensureConnectedLocked() (*Conn, chan struct{}, error) {
	if c.stopped {
		return nil, nil, io.EOF
	}
	if c.conn != nil {
		return c.conn, c.closed, nil
	}
	raw, err := net.DialTimeout("tcp", c.addr, 3*time.Second)
	if err != nil {
		return nil, nil, err
	}
	_ = raw.SetDeadline(time.Now().Add(5 * time.Second))
	conn := NewConn(raw)
	if err := conn.Send(Hello{
		Type:  VerbHello,
		Proto: ProtoVersion,
		Role:  "command",
		JobID: c.jobID,
		PID:   os.Getpid(),
		Token: c.token,
	}); err != nil {
		_ = raw.Close()
		return nil, nil, err
	}
	msg, err := conn.Recv()
	if err != nil {
		_ = raw.Close()
		return nil, nil, err
	}
	if _, ok := msg.(*Hello); !ok {
		_ = raw.Close()
		return nil, nil, fmt.Errorf("unexpected handshake reply")
	}
	_ = raw.SetDeadline(time.Time{})

	closed := make(chan struct{})
	c.raw = raw
	c.conn = conn
	c.closed = closed
	go c.readLoop(raw, conn, closed)
	return conn, closed, nil
}

func (c *commandIPCClient) readLoop(raw net.Conn, conn *Conn, closed chan struct{}) {
	defer func() {
		_ = raw.Close()
		c.mu.Lock()
		if c.conn == conn {
			c.conn = nil
			c.raw = nil
		}
		for k, ch := range c.waiters {
			delete(c.waiters, k)
			select {
			case ch <- tools.MidExecApprovalResp{Decision: "deny"}:
			default:
			}
		}
		c.mu.Unlock()
		close(closed)
	}()

	for {
		msg, err := conn.Recv()
		if err != nil {
			return
		}
		if reply, ok := msg.(*ApprovalReply); ok && reply.ReqID != "" {
			c.mu.Lock()
			ch := c.waiters[reply.ReqID]
			delete(c.waiters, reply.ReqID)
			c.mu.Unlock()
			if ch != nil {
				select {
				case ch <- reply.Resp:
				default:
				}
			}
		}
	}
}

func (c *commandIPCClient) ask(ctx context.Context, req tools.MidExecApprovalReq) (tools.MidExecApprovalResp, error) {
	if ctx != nil && ctx.Err() != nil {
		return tools.MidExecApprovalResp{Decision: "deny"}, ctx.Err()
	}
	reqID := fmt.Sprintf("req_%d", c.seq.Add(1))
	ch := make(chan tools.MidExecApprovalResp, 1)

	c.mu.Lock()
	conn, closed, err := c.ensureConnectedLocked()
	if err != nil {
		c.mu.Unlock()
		return tools.MidExecApprovalResp{Decision: "deny"}, nil
	}
	c.waiters[reqID] = ch
	c.mu.Unlock()

	if err := conn.Send(AskApproval{
		Type:  VerbAskApproval,
		ReqID: reqID,
		Req:   req,
	}); err != nil {
		c.mu.Lock()
		delete(c.waiters, reqID)
		c.mu.Unlock()
		return tools.MidExecApprovalResp{Decision: "deny"}, nil
	}

	var ctxDone <-chan struct{}
	if ctx != nil {
		ctxDone = ctx.Done()
	}
	select {
	case resp := <-ch:
		if resp.Decision == "" {
			resp.Decision = "deny"
		}
		return resp, nil
	case <-closed:
		return tools.MidExecApprovalResp{Decision: "deny"}, nil
	case <-ctxDone:
		c.mu.Lock()
		delete(c.waiters, reqID)
		c.mu.Unlock()
		return tools.MidExecApprovalResp{Decision: "deny"}, ctx.Err()
	}
}

func (c *commandIPCClient) close() {
	c.mu.Lock()
	c.stopped = true
	raw := c.raw
	c.raw = nil
	c.conn = nil
	c.mu.Unlock()
	if raw != nil {
		_ = raw.Close()
	}
}
