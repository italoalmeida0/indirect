package tools

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/italoalmeida0/unish/pkg/unish"
	"indirect/indirect-code-daemon/packages/qjs"
)

// errEmptyArgv is the direct starter's guard against a malformed spec.
var errEmptyArgv = errors.New("tools: empty argv")

type exitCodeError struct {
	code int
}

func (e *exitCodeError) Error() string {
	return fmt.Sprintf("exit status %d", e.code)
}

func (e *exitCodeError) ExitCode() int {
	return e.code
}

// pauseableTimer implements an AutoBackgroundAfter timer that pauses and resets
// whenever execution blocks on a mid-execution interactive user approval prompt.
type pauseableTimer struct {
	mu      sync.Mutex
	dur     time.Duration
	paused  bool
	fired   bool
	stopped bool
	timer   *time.Timer
	ch      chan struct{}
}

func newPauseableTimer(d time.Duration) *pauseableTimer {
	pt := &pauseableTimer{
		dur: d,
		ch:  make(chan struct{}),
	}
	pt.mu.Lock()
	pt.timer = time.AfterFunc(d, pt.fire)
	pt.mu.Unlock()
	return pt
}

func (pt *pauseableTimer) fire() {
	pt.mu.Lock()
	defer pt.mu.Unlock()
	if pt.paused || pt.fired || pt.stopped {
		return
	}
	pt.fired = true
	close(pt.ch)
}

func (pt *pauseableTimer) SetWaiting(waiting bool) {
	pt.mu.Lock()
	defer pt.mu.Unlock()
	if pt.fired || pt.stopped {
		return
	}
	if waiting {
		if !pt.paused {
			pt.paused = true
			if pt.timer != nil {
				pt.timer.Stop()
			}
		}
		return
	}
	if pt.paused {
		pt.paused = false
		if pt.timer != nil {
			pt.timer.Stop()
		}
		pt.timer = time.AfterFunc(pt.dur, pt.fire)
	}
}

func (pt *pauseableTimer) Stop() {
	pt.mu.Lock()
	defer pt.mu.Unlock()
	if pt.stopped {
		return
	}
	pt.stopped = true
	if pt.timer != nil {
		pt.timer.Stop()
	}
}

func (pt *pauseableTimer) C() <-chan struct{} {
	return pt.ch
}

func init() {
	if len(os.Args) >= 3 && os.Args[1] == "--js-exec-direct" {
		cwd, _ := os.Getwd()
		exe, _ := os.Executable()
		shellPath := os.Getenv("__INDIRECT_SHELL_PATH")
		shellFlag := os.Getenv("__INDIRECT_SHELL_FLAG")
		codeSrc := os.Args[2]
		if codeFile := os.Getenv("__INDIRECT_CODE_FILE"); codeFile != "" {
			if raw, rerr := os.ReadFile(codeFile); rerr == nil {
				codeSrc = string(raw)
			}
			_ = os.Remove(codeFile)
		}
		var jailRoots []string
		if raw := os.Getenv("__INDIRECT_JAIL_ROOTS"); raw != "" {
			for _, p := range strings.Split(raw, string(os.PathListSeparator)) {
				if p = strings.TrimSpace(p); p != "" {
					jailRoots = append(jailRoots, p)
				}
			}
		}
		var readOnlyRoots []string
		if raw := os.Getenv("__INDIRECT_READONLY_ROOTS"); raw != "" {
			for _, p := range strings.Split(raw, string(os.PathListSeparator)) {
				if p = strings.TrimSpace(p); p != "" {
					readOnlyRoots = append(readOnlyRoots, p)
				}
			}
		}
		var fsReadRoots []string
		if raw := os.Getenv("__INDIRECT_FS_READ_ROOTS"); raw != "" {
			for _, p := range strings.Split(raw, string(os.PathListSeparator)) {
				if p = strings.TrimSpace(p); p != "" {
					fsReadRoots = append(fsReadRoots, p)
				}
			}
		}
		var fsWriteRoots []string
		if raw := os.Getenv("__INDIRECT_FS_WRITE_ROOTS"); raw != "" {
			for _, p := range strings.Split(raw, string(os.PathListSeparator)) {
				if p = strings.TrimSpace(p); p != "" {
					fsWriteRoots = append(fsWriteRoots, p)
				}
			}
		}
		var netAllow []string
		if raw := os.Getenv("__INDIRECT_NET_ALLOW"); raw != "" {
			for _, p := range strings.Split(raw, ",") {
				if p = strings.TrimSpace(p); p != "" {
					netAllow = append(netAllow, p)
				}
			}
		}
		_ = os.Unsetenv("__INDIRECT_CODE_FILE")
		_ = os.Unsetenv("__INDIRECT_SHELL_PATH")
		_ = os.Unsetenv("__INDIRECT_SHELL_FLAG")
		_ = os.Unsetenv("__INDIRECT_JAIL_ROOTS")
		_ = os.Unsetenv("__INDIRECT_READONLY_ROOTS")
		_ = os.Unsetenv("__INDIRECT_FS_READ_ROOTS")
		_ = os.Unsetenv("__INDIRECT_FS_WRITE_ROOTS")
		_ = os.Unsetenv("__INDIRECT_NET_ALLOW")
		var scriptArgs []string
		if len(os.Args) > 3 {
			scriptArgs = os.Args[3:]
		}
		code, err := qjs.RunScript(context.Background(), qjs.ScriptOptions{
			Code:          codeSrc,
			Filename:      "<exec_script>",
			CWD:           cwd,
			Args:          scriptArgs,
			Stdin:         os.Stdin,
			Stdout:        os.Stdout,
			Stderr:        os.Stderr,
			ShellPath:     shellPath,
			ShellFlag:     shellFlag,
			ExecPath:      exe,
			JailRoots:     jailRoots,
			ReadOnlyRoots: readOnlyRoots,
			FSReadRoots:   fsReadRoots,
			FSWriteRoots:  fsWriteRoots,
			NetAllow:      netAllow,
		})
		if err != nil && code == 0 {
			code = 1
		}
		os.Exit(code)
	}
}

// ExecSpec is everything needed to run one command (owner: terminal AND
// exec_script go through the same runner — it never knows what it runs).
type ExecSpec struct {
	Kind          string   // "bash" | "exec_script"
	Command       string   // original command text (labels, sandbox already checked)
	Argv          []string // binary + args (exec semantics)
	CWD           string
	Env           []string
	Stdin         string   // inline stdin
	Code          string   // inline JS code (when Kind == "exec_script")
	ShellPath     string   // shell path for $ inside exec_script
	ShellFlag     string   // shell flag for $ inside exec_script
	JailRoots     []string // sandbox root confinement for exec_script
	ReadOnlyRoots []string // read-only roots within JailRoots (e.g. plan/learning project root)
	FSReadRoots   []string // scoped filesystem read roots (PermissionSet.FS.Read)
	FSWriteRoots   []string // scoped filesystem write roots (PermissionSet.FS.Write)
	NetAllow       []string // allowed network hosts (PermissionSet.Net.Allow)
	RawScript      string
	Jail           *RuntimeJailSpec
	Approver       MidExecApprover
	OnApprovalWait func(waiting bool)
	NoDedupe       bool // true when stdin/env/work_dir make this run non-dedupable
	// SplitStderr keeps a separate stderr log;
	// the runner merges both into one out log and leaves this false.
	SplitStderr bool
	LogDir      string // direct-starter temp log directory
	JobID       string // runner identity (pre-generated by the daemon side)
	SessionID   string
	Label       string
}

// Proc is the tool-visible handle of one running command.
type Proc struct {
	PID     int
	LogPath string // live log file (tailable)
	// JobID is the runner-assigned identity ("" = let the background
	// registry generate one at registration, legacy direct path).
	JobID string
	// ErrLogPath is the separate stderr log (SplitStderr; "" = merged).
	ErrLogPath string
	// BrainLog is the final log destination (runner copies there at
	// terminal; == LogPath for the direct path).
	BrainLog string
	Exited   <-chan struct{}
	Wait     func() error                        // blocks until the process is gone
	Stop     func()                              // kill the whole tree
	Pump     func(<-chan struct{}, func([]byte)) // tails the log into consume
	PumpErr  func(<-chan struct{}, func([]byte)) // separate stderr log (nil = merged)
	Cleanup  func(removeLog bool)
	// Disposition records the execution disposition durably (V2R-001).
	// Nil on the direct path.
	Disposition Disposition
}

// Starter launches a command. Nil on the tools = the direct local
// starter (tests/standalone). The daemon injects the runner-backed
// starter (crash-only tasks: state file + runners/out/ + IPC).
type Starter func(ctx context.Context, spec ExecSpec) (*Proc, error)

// Disposition records how a task's outcome is consumed (V2R-001) so a
// restart never invents a wake-up. Nil = no-op (direct path). Publication errors must reach the caller.
type Disposition func(jobID, disp string) error

// Disposition values (mirror packages/runner).
const (
	DispBackground = "background"
	DispInline     = "inline"
	DispSuppressed = "suppressed"
	DispCancelled  = "cancelled"
)

func wrapApproverWithWait(approver MidExecApprover, onWait func(bool)) MidExecApprover {
	if approver == nil {
		return nil
	}
	if onWait == nil {
		return approver
	}
	return func(ctx context.Context, req MidExecApprovalReq) (MidExecApprovalResp, error) {
		onWait(true)
		defer onWait(false)
		return approver(ctx, req)
	}
}

func startDirectInProcess(ctx context.Context, spec ExecSpec) (*Proc, bool, error) {
	isDefaultUnish := spec.Kind == "bash" && len(spec.Argv) >= 2 && spec.Argv[1] == "--sh-c"
	isJailedJS := spec.Kind == "exec_script" && spec.Jail != nil && spec.Approver != nil
	if !isDefaultUnish && !(spec.Kind == "bash" && spec.Jail != nil && len(spec.Argv) >= 3 && spec.Argv[1] == "--sh-c") && !isJailedJS {
		return nil, false, nil
	}

	log, err := newProcessLog(spec.LogDir, "bg_"+spec.Kind+"_*.log")
	if err != nil {
		return nil, true, err
	}
	var errLog *processLog
	if spec.SplitStderr {
		if errLog, err = newProcessLog(spec.LogDir, "bg_"+spec.Kind+"_stderr_*.log"); err != nil {
			log.close(true)
			return nil, true, err
		}
	}

	execCtx, execCancel := context.WithCancel(ctx)
	env := spec.Env
	if len(env) == 0 {
		if spec.Kind == "exec_script" {
			env = execScriptEnv(nil)
		} else {
			env = os.Environ()
		}
	}
	approver := wrapApproverWithWait(spec.Approver, spec.OnApprovalWait)

	var rt *PolicyRuntime
	if spec.Jail != nil {
		var jerr error
		rt, jerr = NewPolicyRuntime(*spec.Jail, env, approver)
		if jerr != nil {
			execCancel()
			log.close(true)
			if errLog != nil {
				errLog.close(true)
			}
			return nil, true, jerr
		}
	}

	outW := io.Writer(log.file)
	errW := io.Writer(log.file)
	if errLog != nil {
		errW = errLog.file
	}

	exited := make(chan struct{})
	var waitErr error
	go func() {
		defer close(exited)
		defer execCancel()
		var exitCode int
		var runErr error
		if spec.Kind == "bash" {
			script := spec.RawScript
			if script == "" && len(spec.Argv) >= 3 {
				script = spec.Argv[2]
			}
			if rt != nil {
				exitCode, runErr = rt.ExecShell(execCtx, script, spec.CWD, env, strings.NewReader(spec.Stdin), outW, errW)
			} else {
				sess, serr := unish.NewSession(
					unish.WithWorkDir(spec.CWD),
					unish.WithInheritEnv(false),
					unish.WithEnv(env),
				)
				if serr != nil {
					waitErr = serr
					return
				}
				res, eerr := sess.ExecWith(execCtx, script, unish.ExecOptions{
					Stdin:  strings.NewReader(spec.Stdin),
					Stdout: outW,
					Stderr: errW,
				})
				_ = sess.Close()
				runErr = eerr
				if res != nil {
					exitCode = res.ExitCode
				}
			}
		} else {
			exe, _ := os.Executable()
			var extraArgs []string
			if len(spec.Argv) > 1 {
				extraArgs = spec.Argv[1:]
			}
			envMap := make(map[string]string, len(env))
			for _, kv := range env {
				if idx := strings.IndexByte(kv, '='); idx > 0 {
					envMap[kv[:idx]] = kv[idx+1:]
				}
			}
			baseOpts := qjs.ScriptOptions{
				Code:          spec.Code,
				Filename:      "<exec_script>",
				CWD:           spec.CWD,
				Args:          extraArgs,
				Env:           envMap,
				Stdin:         strings.NewReader(spec.Stdin),
				Stdout:        outW,
				Stderr:        errW,
				ShellPath:     spec.ShellPath,
				ShellFlag:     spec.ShellFlag,
				ExecPath:      exe,
				JailRoots:     spec.JailRoots,
				ReadOnlyRoots: spec.ReadOnlyRoots,
				FSReadRoots:   spec.FSReadRoots,
				FSWriteRoots:  spec.FSWriteRoots,
				NetAllow:      spec.NetAllow,
			}
			if rt != nil {
				baseOpts = rt.QJSOptions(baseOpts)
			}
			exitCode, runErr = qjs.RunScript(execCtx, baseOpts)
		}
		if exitCode != 0 {
			waitErr = &exitCodeError{code: exitCode}
		} else if runErr != nil {
			waitErr = runErr
		}
	}()

	proc := &Proc{
		PID:      os.Getpid(),
		LogPath:  log.file.Name(),
		BrainLog: log.file.Name(),
		Exited:   exited,
		Wait: func() error {
			<-exited
			return waitErr
		},
		Stop:    execCancel,
		Pump:    log.pump,
		Cleanup: log.close,
	}
	if errLog != nil {
		proc.ErrLogPath = errLog.file.Name()
		proc.PumpErr = errLog.pump
		proc.Cleanup = func(remove bool) { log.close(remove); errLog.close(remove) }
	}
	return proc, true, nil
}

// startDirect is today's behavior: a local process (or in-process embedded
// unish / jailed qjs session) whose output lands in a temp file under LogDir;
// the pump only observes the file (killing the daemon can never SIGPIPE the child).
func startDirect(ctx context.Context, spec ExecSpec) (*Proc, error) {
	if spec.Kind == "exec_script" && strings.TrimSpace(spec.Code) == "" {
		return nil, errEmptyArgv
	}
	if proc, handled, err := startDirectInProcess(ctx, spec); handled {
		return proc, err
	}
	var codeFilePath string
	if spec.Kind == "exec_script" && spec.Code != "" {
		exe, _ := os.Executable()
		var extraArgs []string
		if len(spec.Argv) > 1 {
			extraArgs = spec.Argv[1:]
		}
		if spec.LogDir != "" {
			_ = os.MkdirAll(spec.LogDir, 0o700)
		}
		f, ferr := os.CreateTemp(spec.LogDir, "bg_code_*.js")
		if ferr != nil {
			return nil, ferr
		}
		_ = f.Chmod(0o600)
		_, werr := f.WriteString(spec.Code)
		cerr := f.Close()
		if werr != nil || cerr != nil {
			_ = os.Remove(f.Name())
			if werr != nil {
				return nil, werr
			}
			return nil, cerr
		}
		codeFilePath = f.Name()
		spec.Argv = append([]string{exe, "--js-exec-direct", ""}, extraArgs...)
	}
	if len(spec.Argv) == 0 {
		if codeFilePath != "" {
			_ = os.Remove(codeFilePath)
		}
		return nil, errEmptyArgv
	}
	log, err := newProcessLog(spec.LogDir, "bg_"+spec.Kind+"_*.log")
	if err != nil {
		if codeFilePath != "" {
			_ = os.Remove(codeFilePath)
		}
		return nil, err
	}
	cmd := exec.CommandContext(ctx, spec.Argv[0], spec.Argv[1:]...)
	cmd.Dir = spec.CWD
	env := spec.Env
	if len(env) == 0 {
		if spec.Kind == "exec_script" {
			env = execScriptEnv(nil)
		} else {
			env = os.Environ()
		}
	} else {
		env = append([]string(nil), env...)
	}
	filtered := make([]string, 0, len(env)+8)
	for _, kv := range env {
		k := kv
		if eq := strings.IndexByte(kv, '='); eq >= 0 {
			k = kv[:eq]
		}
		if strings.HasPrefix(strings.ToUpper(strings.TrimSpace(k)), "__INDIRECT_") {
			continue
		}
		filtered = append(filtered, kv)
	}
	env = filtered
	if codeFilePath != "" {
		env = append(env, "__INDIRECT_CODE_FILE="+codeFilePath)
	}
	if spec.ShellPath != "" {
		env = append(env, "__INDIRECT_SHELL_PATH="+spec.ShellPath)
	}
	if spec.ShellFlag != "" {
		env = append(env, "__INDIRECT_SHELL_FLAG="+spec.ShellFlag)
	}
	if len(spec.JailRoots) > 0 {
		env = append(env, "__INDIRECT_JAIL_ROOTS="+strings.Join(spec.JailRoots, string(os.PathListSeparator)))
	}
	if len(spec.ReadOnlyRoots) > 0 {
		env = append(env, "__INDIRECT_READONLY_ROOTS="+strings.Join(spec.ReadOnlyRoots, string(os.PathListSeparator)))
	}
	if len(spec.FSReadRoots) > 0 {
		env = append(env, "__INDIRECT_FS_READ_ROOTS="+strings.Join(spec.FSReadRoots, string(os.PathListSeparator)))
	}
	if len(spec.FSWriteRoots) > 0 {
		env = append(env, "__INDIRECT_FS_WRITE_ROOTS="+strings.Join(spec.FSWriteRoots, string(os.PathListSeparator)))
	}
	if len(spec.NetAllow) > 0 {
		env = append(env, "__INDIRECT_NET_ALLOW="+strings.Join(spec.NetAllow, ","))
	}
	cmd.Env = env
	if spec.Stdin != "" {
		cmd.Stdin = strings.NewReader(spec.Stdin)
	}
	setProcessGroup(cmd)
	cmd.Stdout = log.file
	var errLog *processLog
	if spec.SplitStderr {
		if errLog, err = newProcessLog(spec.LogDir, "bg_"+spec.Kind+"_stderr_*.log"); err != nil {
			log.close(true)
			return nil, err
		}
		cmd.Stderr = errLog.file
	} else {
		cmd.Stderr = log.file
	}
	if err := cmd.Start(); err != nil {
		if codeFilePath != "" {
			_ = os.Remove(codeFilePath)
		}
		log.close(true)
		if errLog != nil {
			errLog.close(true)
		}
		return nil, err
	}
	exited := make(chan struct{})
	var waitErr error
	go func() {
		waitErr = cmd.Wait() // reaped ONCE: cmd.Wait() must never be
		if codeFilePath != "" {
			_ = os.Remove(codeFilePath)
		}
		close(exited)        // called twice ("Wait was already called")
	}()
	proc := &Proc{
		PID:      cmd.Process.Pid,
		LogPath:  log.file.Name(),
		BrainLog: log.file.Name(),
		Exited:   exited,
		Wait: func() error {
			<-exited
			return waitErr // safe: exited closes after the write
		},
		Stop:    func() { killProcessGroup(cmd) },
		Pump:    log.pump,
		Cleanup: log.close,
	}
	if errLog != nil {
		proc.ErrLogPath = errLog.file.Name()
		proc.PumpErr = errLog.pump
		proc.Cleanup = func(remove bool) { log.close(remove); errLog.close(remove) }
	}
	return proc, nil
}

// startWith launches through the injected starter or the direct one.
func startWith(ctx context.Context, st Starter, spec ExecSpec) (*Proc, error) {
	if st != nil {
		return st(ctx, spec)
	}
	return startDirect(ctx, spec)
}

// TailLog observes an EXISTING log file (the runner's out file) exactly
// like processLog.pump does for a file this process owns.
func TailLog(path string) func(<-chan struct{}, func([]byte)) {
	return func(exited <-chan struct{}, consume func([]byte)) {
		// The runner creates its out file shortly AFTER spawn (its own
		// boot): wait for the file to appear — the file is the contract,
		// so the tailer is late-arrival tolerant and bounded.
		var f *os.File
		deadline := time.Now().Add(15 * time.Second)
		for {
			var err error
			f, err = os.Open(path)
			if err == nil {
				break
			}
			if time.Now().After(deadline) {
				return
			}
			select {
			case <-exited:
				// One last attempt after exit (the file exists by then).
				if f2, err2 := os.Open(path); err2 == nil {
					f = f2
					goto opened
				}
				return
			case <-time.After(20 * time.Millisecond):
			}
		}
	opened:
		defer f.Close()
		tick := time.NewTicker(20 * time.Millisecond)
		defer tick.Stop()
		buf := make([]byte, 8192)
		var offset int64
		ending := false
		for {
			n, err := f.ReadAt(buf, offset)
			if n > 0 {
				consume(buf[:n])
				offset += int64(n)
			}
			if err != nil && err != io.EOF {
				return
			}
			if n > 0 {
				continue
			}
			if ending {
				return
			}
			select {
			case <-exited:
				ending = true
			case <-tick.C:
			}
		}
	}
}
