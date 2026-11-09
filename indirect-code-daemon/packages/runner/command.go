package runner

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

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
	type launch struct {
		spec     Spec
		released bool
		err      error
	}
	ready := make(chan launch, 1)
	go func() {
		var l launch
		d := json.NewDecoder(os.Stdin)
		if l.err = d.Decode(&l.spec); l.err == nil {
			l.err = d.Decode(&l.released)
		}
		ready <- l
	}()
	var l launch
	select {
	case l = <-ready:
	case <-time.After(30 * time.Second):
		_, _ = os.Stderr.WriteString("runner: launch handshake timed out\n")
		return 75
	}
	if l.err != nil || !l.released || l.spec.Validate() != nil {
		_, _ = os.Stderr.WriteString("runner: invalid launch specification\n")
		return 75
	}
	_ = os.Stdin.Close() // the payload never inherits the launch channel

	if l.spec.Kind == "exec_script" {
		if strings.TrimSpace(l.spec.Code) == "" {
			_, _ = os.Stderr.WriteString("runner: empty exec_script code\n")
			return 75
		}
		return runExecScriptSpec(l.spec, sigc)
	}

	cmd := exec.Command(l.spec.Path, l.spec.Args...)
	cmd.Dir, cmd.Env = l.spec.CWD, utf8Env(l.spec.Env)
	cmd.Stdin = strings.NewReader(l.spec.Stdin)
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

func runExecScriptSpec(spec Spec, sigc <-chan os.Signal) int {
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
	if cwd != "" {
		if abs, err := filepath.Abs(cwd); err == nil {
			cwd = abs
		}
		if err := os.Chdir(cwd); err != nil {
			_, _ = fmt.Fprintf(os.Stderr, "chdir %s: %v\n", spec.CWD, err)
			return 127
		}
	}
	envMap := make(map[string]string, len(spec.Env))
	for _, kv := range utf8Env(spec.Env) {
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
