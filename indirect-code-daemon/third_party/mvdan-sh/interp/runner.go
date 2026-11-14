// Copyright (c) 2017, Daniel Martí <mvdan@mvdan.cc>
// See LICENSE for licensing information

package interp

import (
	"bytes"
	"cmp"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"iter"
	"maps"
	"math"
	"os"
	"os/signal"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"mvdan.cc/sh/v3/expand"
	"mvdan.cc/sh/v3/internal"
	"mvdan.cc/sh/v3/pattern"
	"mvdan.cc/sh/v3/syntax"
)

const (
	// shellReplyPS3Var, or PS3, is a special variable in Bash used by the select command,
	// while the shell is awaiting for input. the default value is [shellDefaultPS3]
	shellReplyPS3Var = "PS3"
	// shellDefaultPS3, or #?, is PS3's default value
	shellDefaultPS3 = "#? "
	// shellReplyVar, or REPLY, is a special variable in Bash that is used to store the result of
	// the select command or of the read command, when no variable name is specified
	shellReplyVar = "REPLY"
)

func (r *Runner) fillExpandConfig(ctx context.Context) {
	r.ectx = ctx
	r.envProxy.r = r
	r.roEnv.r = r
	r.ecfg = &r.ecfgStorage
	r.ecfg.Env = &r.envProxy
	r.ecfg.Callbacks = &r.envProxy
	r.ecfg.CmdSubst = nil
	r.ecfg.ProcSubst = nil
	r.ecfg.ReadDir = nil
	r.ecfg.ReadDir2 = nil
	r.updateExpandOpts()
}

func (e *expandEnv) ExpandCmdSubst(w io.Writer, cs *syntax.CmdSubst) error {
	r := e.r
	ctx := r.ectx
	r.reportBgStart(0) // runs arbitrary shell code
	switch len(cs.Stmts) {
	case 0: // nothing to do
		return nil
	case 1: // $(<file)
		word := catShortcutArg(cs.Stmts[0])
		if word == nil {
			break
		}
		path := r.literal(word)
		f, err := r.open(ctx, path, os.O_RDONLY, 0, true)
		if err != nil {
			return err
		}
		_, err = io.Copy(w, f)
		f.Close()
		return err
	}
	r2, oenv := r.acquireCmdSubstSubshell()
	r2.stdout = w
	r2.stmts(ctx, cs.Stmts)
	r2.finishSubshell(ctx)
	exit := r2.exit
	sharedStdout := false
	if cb, ok := w.(expand.ConcurrentBufferWriter); ok && cb.IsConcurrentStdout() {
		sharedStdout = true
	}
	releaseCmdSubstSubshell(r2, oenv, sharedStdout)
	r.lastExpandExit = exit
	if exit.fatalExit {
		return exit.err // surface fatal errors immediately
	}
	return nil
}

func (e *expandEnv) ExpandProcSubst(ps *syntax.ProcSubst) (string, error) {
	r := e.r
	ctx := r.ectx
	if ps.Op == syntax.CmdInTemp { // zsh's =(...)
		return "", fmt.Errorf("unsupported")
	}
	if len(ps.Stmts) == 0 { // nothing to do
		return os.DevNull, nil
	}

	psf, err := r.procSubstHandler(r.handlerCtx(ctx, handlerKindProcSubst, ps.OpPos), ps.Op)
	if err != nil {
		return "", err
	}
	r.procSubsts.add(psf)
	r.stmtProcSubsts = append(r.stmtProcSubsts, psf)

	r2 := r.subshell(true)
	stdout := r.origStdout
	// TODO: note that `man bash` mentions that `wait` only waits for the last
	// process substitution as long as it is $!; the logic here would mean we wait for all of them.
	bg := r.newBgProc()
	r.bgProcs = append(r.bgProcs, bg)
	go func() {
		defer func() {
			r2.resetSignals()
			r2.closeOwnedExtraFds()
			*bg.exit = r2.exit
			close(bg.done)
		}()
		defer func() {
			r.procSubsts.release(psf)
			if psf.Cleanup == nil {
				return
			}
			if err := psf.Cleanup(); err != nil {
				r.errf("cleaning up process substitution: %v\n", err)
			}
		}()
		f, err := psf.OpenSubshell(ctx)
		if err != nil {
			r.errf("cannot open process substitution: %v\n", err)
			return
		}
		defer func() {
			if err := f.Close(); err != nil {
				r.errf("closing process substitution: %v\n", err)
			}
		}()
		switch ps.Op {
		case syntax.CmdIn:
			r2.stdout = f
		case syntax.CmdOut:
			stdin, err := newStdinFile(f)
			if err != nil {
				r.errf("cannot use process substitution as stdin: %v\n", err)
				return
			}
			r2.stdin = stdin
			r2.stdout = stdout
		default:
			// Should only happen if we forgot a case above.
			panic(fmt.Sprintf("unexpected process substitution operator: %q", ps.Op))
		}
		r2.stmts(ctx, ps.Stmts)
		if !r2.exit.fatalExit {
			r2.trapCallback(ctx, r2.callbackExit, "exit")
		}
		r2.exit.exiting = false // subshells don't exit the parent shell
	}()
	return psf.Path, nil
}

func (e *expandEnv) ExpandReadDir(s string) ([]fs.DirEntry, error) {
	r := e.r
	return r.readDirHandler(r.handlerCtx(r.ectx, handlerKindReadDir, todoPos), s)
}

// catShortcutArg checks if a statement is of the form "$(<file)". The redirect
// word is returned if there's a match, and nil otherwise.
func catShortcutArg(stmt *syntax.Stmt) *syntax.Word {
	if stmt.Cmd != nil || stmt.Negated || stmt.Background || stmt.Coprocess || stmt.Disown {
		return nil
	}
	if len(stmt.Redirs) != 1 {
		return nil
	}
	redir := stmt.Redirs[0]
	if redir.Op != syntax.RdrIn {
		return nil
	}
	return redir.Word
}

func (r *Runner) updateExpandOpts() {
	r.ecfg.ReadDirEnabled = !r.opts[optNoGlob]
	r.ecfg.ReadDir2 = nil
	r.ecfg.GlobStar = r.opts[optGlobStar]
	r.ecfg.DotGlob = r.opts[optDotGlob]
	r.ecfg.NoCaseGlob = r.opts[optNoCaseGlob]
	r.ecfg.NullGlob = r.opts[optNullGlob]
	r.ecfg.NoUnset = r.opts[optNoUnset]
	r.ecfg.ExtGlob = r.opts[optExtGlob]
}

func (r *Runner) expandErr(err error) {
	if err == nil {
		return
	}
	errMsg := err.Error()
	fmt.Fprintln(r.stderr, errMsg)
	switch {
	case errors.Is(err, errReadOnly):
		// Like in bash, assigning to a read-only variable fails
		// the command at hand without exiting the shell.
		r.exit.code = 1
	default:
		// bash treats expansion errors (arithmetic errors, bad
		// substitutions, unbound parameters under set -u, …) as fatal
		// for a non-interactive shell.
		r.exit.code = 1
		r.exit.exiting = true
	}
}

func (r *Runner) arithm(expr syntax.ArithmExpr) int {
	n, err := expand.Arithm(r.ecfg, expr)
	r.expandErr(err)
	return n
}

func (r *Runner) fields(words ...*syntax.Word) []string {
	strs, err := expand.Fields(r.ecfg, words...)
	r.expandErr(err)
	return strs
}

func (r *Runner) literal(word *syntax.Word) string {
	str, err := expand.Literal(r.ecfg, word)
	r.expandErr(err)
	return str
}

func (r *Runner) document(word *syntax.Word) string {
	str, err := expand.Document(r.ecfg, word)
	r.expandErr(err)
	return str
}

func (r *Runner) pattern(word *syntax.Word) string {
	str, err := expand.Pattern(r.ecfg, word)
	r.expandErr(err)
	return str
}

// expandEnviron exposes [Runner]'s variables to the expand package.
type expandEnv struct {
	r *Runner
}

var (
	_ expand.WriteEnviron    = (*expandEnv)(nil)
	_ expand.RunnerCallbacks = (*expandEnv)(nil)
)

func (e *expandEnv) Get(name string) expand.Variable {
	return e.r.lookupVar(name)
}

func (e *expandEnv) Set(name string, vr expand.Variable) error {
	return e.r.setVarErr(name, vr)
}

func (e *expandEnv) Each(fn func(name string, vr expand.Variable) bool) {
	stopped := false
	e.r.writeEnv.Each(func(name string, vr expand.Variable) bool {
		if !fn(name, vr) {
			stopped = true
			return false
		}
		return true
	})
	if !stopped && !e.r.pipeStatusInEnv && e.r.pipeStatusDirty {
		fn("PIPESTATUS", e.r.materializePipeStatus())
	}
}

type readOnlyEnv struct {
	r *Runner
}

var _ expand.Environ = (*readOnlyEnv)(nil)

func (e *readOnlyEnv) Get(name string) expand.Variable {
	if !e.r.pipeStatusInEnv && e.r.pipeStatusDirty && isPipeStatusVar(name) {
		return e.r.materializePipeStatus()
	}
	return e.r.writeEnv.Get(name)
}

func (e *readOnlyEnv) Each(fn func(name string, vr expand.Variable) bool) {
	stopped := false
	e.r.writeEnv.Each(func(name string, vr expand.Variable) bool {
		if !fn(name, vr) {
			stopped = true
			return false
		}
		return true
	})
	if !stopped && !e.r.pipeStatusInEnv && e.r.pipeStatusDirty {
		fn("PIPESTATUS", e.r.materializePipeStatus())
	}
}

var todoPos syntax.Pos // for handlerCtx callers where we don't yet have a position

func (r *Runner) makeHandlerCtx(kind handlerKind, pos syntax.Pos) HandlerContext {
	hc := HandlerContext{
		runner:         r,
		kind:           kind,
		Env:            &r.roEnv,
		Dir:            r.Dir,
		Pos:            pos,
		Stdout:         r.stdout,
		Stderr:         r.stderr,
		LastExitStatus: int(r.lastExit.code),
	}
	if r.stdin != nil { // do not leave hc.Stdin as a typed nil
		hc.Stdin = r.stdin
	}
	return hc
}

func (r *Runner) handlerCtx(ctx context.Context, kind handlerKind, pos syntax.Pos) context.Context {
	return context.WithValue(ctx, handlerCtxKey{}, r.makeHandlerCtx(kind, pos))
}

func (r *Runner) out(s string) {
	io.WriteString(r.stdout, s)
}

func (r *Runner) outf(format string, a ...any) {
	fmt.Fprintf(r.stdout, format, a...)
}

func (r *Runner) errf(format string, a ...any) {
	fmt.Fprintf(r.stderr, format, a...)
}

func (r *Runner) stop(ctx context.Context) bool {
	if r.exit.returning || r.exit.exiting {
		return true
	}
	if err := ctx.Err(); err != nil {
		r.exit.fatal(err)
		return true
	}
	if r.opts[optNoExec] {
		return true
	}
	return false
}

func (r *Runner) stmt(ctx context.Context, st *syntax.Stmt) {
	if r.stop(ctx) {
		return
	}
	r.deliverSignals(ctx)
	r.pipeStatusCodes = nil
	r.exit = exitStatus{}
	if st.Background || st.Disown {
		r2 := r.subshell(true)
		st2 := *st
		st2.Background = false
		st2.Disown = false
		bg := r.newBgProc()
		// A plain command call may amount to starting exactly one external
		// program, in which case $! expands to its real PID like in other
		// shells, which fork background statements as child processes.
		// The default exec handler reports the pid itself; a custom handler
		// can report it too via HandlerContext.ReportBgStart, so the channel
		// is always wired for a plain call. A handler that never reports
		// sends zero, which keeps the fake id (no regression).
		if ce, ok := st.Cmd.(*syntax.CallExpr); ok && len(ce.Args) > 0 {
			bg.started = make(chan int, 1)
			r2.bgStarted = bg.started
			r2.bgTrackOnce = noteBgStartBegin()
		}
		r.bgProcs = append(r.bgProcs, bg)
		go func() {
			defer func() {
				noteBgStartDone(r2.bgTrackOnce)
				r2.resetSignals()
				r2.closeOwnedExtraFds()
				*bg.exit = r2.exit
				close(bg.done)
			}()
			r2.Run(ctx, &st2)
			r2.reportBgStart(0) // in case we didn't get to start a program
			if !r2.exit.exiting && !r2.exit.fatalExit {
				r2.trapCallback(ctx, r2.callbackExit, "exit")
			}
			r2.exit.exiting = false // subshells don't exit the parent shell
		}()
	} else {
		r.stmtSync(ctx, st)
	}
	r.deliverSignals(ctx)
	r.lastExit = r.exit
	// bash keeps PIPESTATUS in sync with the most recent pipeline or command.
	if bc, ok := st.Cmd.(*syntax.BinaryCmd); !ok ||
		(bc.Op != syntax.Pipe && bc.Op != syntax.PipeAll) {
		r.setPipeStatusSingle(int(r.exit.code))
	}
}

var (
	pendingBgStarts atomic.Int32
	bgStartNotifyMu sync.Mutex
	bgStartNotifyCh = make(chan struct{})
	pendingBgPIDs   = map[int]*sync.Once{}

	activeRunnersMu sync.Mutex
	activeRunners   []*Runner
)

func noteBgStartBegin() *sync.Once {
	pendingBgStarts.Add(1)
	return &sync.Once{}
}

func noteBgStartDone(once *sync.Once) {
	if once == nil {
		return
	}
	once.Do(func() {
		pendingBgStarts.Add(-1)
		bgStartNotifyMu.Lock()
		for pid, o := range pendingBgPIDs {
			if o == once {
				delete(pendingBgPIDs, pid)
			}
		}
		close(bgStartNotifyCh)
		bgStartNotifyCh = make(chan struct{})
		bgStartNotifyMu.Unlock()
	})
}

// NoteBgTrackedPID notifies a pending background launch (identified by its
// reported OS PID) that the process has been added to the host job table.
func NoteBgTrackedPID(pid int) {
	bgStartNotifyMu.Lock()
	once := pendingBgPIDs[pid]
	if once != nil {
		delete(pendingBgPIDs, pid)
	}
	bgStartNotifyMu.Unlock()
	noteBgStartDone(once)
}

// PendingBgStarts reports the count of background `&` subshells currently in
// flight before registering an OS process (or entering a non-exec command)
// along with a channel closed on the next transition.
func PendingBgStarts() (int32, <-chan struct{}) {
	bgStartNotifyMu.Lock()
	ch := bgStartNotifyCh
	n := pendingBgStarts.Load()
	bgStartNotifyMu.Unlock()
	return n, ch
}

func pushActiveRunner(r *Runner) {
	activeRunnersMu.Lock()
	activeRunners = append(activeRunners, r)
	activeRunnersMu.Unlock()
}

func popActiveRunner(r *Runner) {
	activeRunnersMu.Lock()
	for i := len(activeRunners) - 1; i >= 0; i-- {
		if activeRunners[i] == r {
			activeRunners = append(activeRunners[:i], activeRunners[i+1:]...)
			break
		}
	}
	activeRunnersMu.Unlock()
}

// QueueActiveSignalByName delivers a self-targeted signal to the innermost
// Runner currently inside a CallHandler, reporting whether an active Runner
// existed and whether it trapped or ignored the signal.
func QueueActiveSignalByName(name string) (handled, hasActive bool) {
	activeRunnersMu.Lock()
	var r *Runner
	if len(activeRunners) > 0 {
		r = activeRunners[len(activeRunners)-1]
	}
	activeRunnersMu.Unlock()
	if r == nil {
		return false, false
	}
	return r.QueueSignalByName(name), true
}

// setPipeStatusSingle updates PIPESTATUS for a non-pipeline command without
// map allocations when PIPESTATUS has not been explicitly bound in writeEnv.
func (r *Runner) setPipeStatusSingle(code int) {
	if !r.pipeStatusInEnv && !r.opts[optAllExport] {
		r.pipeStatusInline[0] = code
		r.pipeStatus = r.pipeStatusInline[:1]
		r.pipeStatusDirty = true
		return
	}
	r.setPipeStatusSlow(code)
}

// setPipeStatus updates the PIPESTATUS array, like bash.
func (r *Runner) setPipeStatus(codes ...int) {
	if !r.pipeStatusInEnv && !r.opts[optAllExport] {
		if len(codes) <= len(r.pipeStatusInline) {
			copy(r.pipeStatusInline[:], codes)
			r.pipeStatus = r.pipeStatusInline[:len(codes)]
		} else {
			r.pipeStatus = slices.Clone(codes)
		}
		r.pipeStatusDirty = true
		return
	}
	r.setPipeStatusSlow(codes...)
}

func (r *Runner) setPipeStatusSlow(codes ...int) {
	list := make([]string, len(codes))
	for i, code := range codes {
		list[i] = expand.FormatIntFast(code)
	}
	r.setVar("PIPESTATUS", expand.Variable{Set: true, Kind: expand.Indexed, List: list})
}

// signalByName maps a trap signal name or number to an [os.Signal].
func signalByName(name string) (os.Signal, bool) {
	if n, err := strconv.Atoi(name); err == nil && n > 0 && n < 65 {
		return syscall.Signal(n), true
	}
	switch strings.TrimPrefix(strings.ToUpper(name), "SIG") {
	case "HUP":
		return syscall.SIGHUP, true
	case "INT":
		return os.Interrupt, true
	case "QUIT":
		return syscall.SIGQUIT, true
	case "ILL":
		return syscall.SIGILL, true
	case "TRAP":
		return syscall.SIGTRAP, true
	case "ABRT", "IOT":
		return syscall.SIGABRT, true
	case "BUS":
		return syscall.SIGBUS, true
	case "FPE":
		return syscall.SIGFPE, true
	case "KILL":
		return syscall.SIGKILL, true
	case "USR1":
		return sigUSR1, true
	case "SEGV":
		return syscall.SIGSEGV, true
	case "USR2":
		return sigUSR2, true
	case "PIPE":
		return syscall.SIGPIPE, true
	case "ALRM":
		return syscall.SIGALRM, true
	case "TERM":
		return syscall.SIGTERM, true
	case "CHLD", "CLD":
		return sigCHLD, true
	case "CONT":
		return sigCONT, true
	case "STOP":
		return sigSTOP, true
	case "TSTP":
		return sigTSTP, true
	case "TTIN":
		return sigTTIN, true
	case "TTOU":
		return sigTTOU, true
	case "URG":
		return sigURG, true
	case "XCPU":
		return sigXCPU, true
	case "XFSZ":
		return sigXFSZ, true
	case "VTALRM":
		return sigVTALRM, true
	case "PROF":
		return sigPROF, true
	case "WINCH":
		return sigWINCH, true
	case "IO", "POLL":
		return sigIO, true
	case "SYS":
		return sigSYS, true
	}
	return nil, false
}

// setSigTrap registers, ignores, or resets a signal trap, keeping OS signal
// notifications synchronized with active/ignored traps.
func (r *Runner) setSigTrap(sig os.Signal, name, callback string, ignore, reset bool) {
	r.sigMu.Lock()
	defer r.sigMu.Unlock()
	if reset {
		delete(r.sigCallbacks, sig)
		delete(r.sigIgnored, sig)
		delete(r.sigNames, sig)
		if r.sigCh != nil {
			signal.Stop(r.sigCh)
			for s := range r.sigCallbacks {
				signal.Notify(r.sigCh, s)
			}
			for s := range r.sigIgnored {
				signal.Notify(r.sigCh, s)
			}
		}
		r.hasIgnoredSigs.Store(len(r.sigIgnored) > 0)
		return
	}
	newCh := false
	if r.sigCh == nil {
		r.sigCh = make(chan os.Signal, 8)
		r.hasActiveSigCh.Store(true)
		activeSigChans.Add(1)
		newCh = true
	}
	if r.sigCallbacks == nil {
		r.sigCallbacks = map[os.Signal]string{}
	}
	if r.sigIgnored == nil {
		r.sigIgnored = map[os.Signal]bool{}
	}
	if r.sigNames == nil {
		r.sigNames = map[os.Signal]string{}
	}
	wasWatched := !newCh && (r.sigCallbacks[sig] != "" || r.sigIgnored[sig])
	r.sigNames[sig] = name
	if ignore {
		delete(r.sigCallbacks, sig)
		r.sigIgnored[sig] = true
	} else {
		delete(r.sigIgnored, sig)
		r.sigCallbacks[sig] = callback
	}
	r.hasIgnoredSigs.Store(len(r.sigIgnored) > 0)
	if !wasWatched {
		signal.Notify(r.sigCh, sig)
	}
}

var activeSigChans atomic.Int32

// ActiveSignalChannels reports the number of Runner signal channels currently
// registered with os/signal (for leak verification in tests).
func ActiveSignalChannels() int {
	return int(activeSigChans.Load())
}

func (r *Runner) resetSignals() {
	if !r.hasActiveSigCh.Load() {
		return
	}
	r.sigMu.Lock()
	if r.sigCh != nil {
		signal.Stop(r.sigCh)
		r.sigCh = nil
		r.hasActiveSigCh.Store(false)
		activeSigChans.Add(-1)
	}
	r.sigMu.Unlock()
}

// TrapRegistered reports whether a trap handler or ignore disposition is installed for sig.
func (r *Runner) TrapRegistered(sig os.Signal) bool {
	r.sigMu.Lock()
	defer r.sigMu.Unlock()
	return r.sigCallbacks[sig] != "" || r.sigIgnored[sig]
}

// QueueSignalByName queues a signal given by name (TERM, INT, HUP, ...),
// so a builtin like `kill` can deliver a signal to the shell's own trap
// without knowing the platform's os.Signal values.
func (r *Runner) QueueSignalByName(name string) bool {
	if sig, ok := signalByName(name); ok {
		return r.QueueSignal(sig)
	}
	return false
}

// QueueSignal schedules sig to run its trap handler at the next statement
// boundary, the way bash defers traps. It reports whether a handler or ignore
// disposition exists.
func (r *Runner) QueueSignal(sig os.Signal) bool {
	r.sigMu.Lock()
	ignored := r.sigIgnored[sig]
	registered := r.sigCallbacks[sig] != ""
	ch := r.sigCh
	r.sigMu.Unlock()
	if ignored {
		return true
	}
	if !registered || ch == nil {
		return false
	}
	select {
	case ch <- sig:
	default:
	}
	return true
}

// deliverSignals runs pending signal traps between commands.
func (r *Runner) deliverSignals(ctx context.Context) {
	if r.handlingTrap || !r.hasActiveSigCh.Load() {
		return
	}
	r.sigMu.Lock()
	ch := r.sigCh
	r.sigMu.Unlock()
	if ch == nil {
		return
	}
	for {
		select {
		case sig := <-ch:
			r.sigMu.Lock()
			ign := r.sigIgnored[sig]
			cb := r.sigCallbacks[sig]
			name := r.sigNames[sig]
			r.sigMu.Unlock()
			if !ign && cb != "" {
				r.trapCallback(ctx, cb, name)
			}
		default:
			return
		}
	}
}

func (r *Runner) finishStmtProcSubsts(psfs []*ProcSubstFile) {
	for _, psf := range psfs {
		if psf.StmtDone != nil {
			psf.StmtDone()
		}
		r.procSubsts.release(psf)
	}
}

func (r *Runner) stillReferenced(c io.Closer) bool {
	if any(r.stdin) == any(c) || any(r.stdout) == any(c) || any(r.stderr) == any(c) {
		return true
	}
	for _, w := range r.extraFds {
		if any(w) == any(c) {
			return true
		}
	}
	for _, in := range r.extraInFds {
		if any(in) == any(c) {
			return true
		}
	}
	return false
}

// reportBgStart is called by a background subshell once we first know whether
// its statement amounts to starting exactly one external program, with its
// process ID, or with zero when that is not the case. No-op for any other
// runner, or when called again. See [Runner.bgStarted].
//
// The parent shell blocks on this report when expanding $!, and we must never
// delay it noticeably nor deadlock with it, so a zero report must happen
// before any operation which could block indefinitely or run arbitrary user
// code, as the call sites explain: expanding a command substitution, calling
// a custom handler, or opening a redirection file, given that e.g. a FIFO
// opened for writing blocks until a reader opens the other end.
func (r *Runner) reportBgStart(pid int) {
	if r.bgStarted == nil {
		return
	}
	if pid == 0 || r.execHandlerIsDefault {
		noteBgStartDone(r.bgTrackOnce)
	} else if r.bgTrackOnce != nil {
		bgStartNotifyMu.Lock()
		pendingBgPIDs[pid] = r.bgTrackOnce
		bgStartNotifyMu.Unlock()
	}
	r.bgStarted <- pid
	r.bgStarted = nil
}

func (r *Runner) stmtSync(ctx context.Context, st *syntax.Stmt) {
	savedProcSubsts := r.stmtProcSubsts
	r.stmtProcSubsts = nil
	defer func() {
		psfs := r.stmtProcSubsts
		r.stmtProcSubsts = savedProcSubsts
		r.finishStmtProcSubsts(psfs)
	}()

	oldIn, oldOut, oldErr := r.stdin, r.stdout, r.stderr
	var oldExtraFds map[int]io.Writer
	var oldExtraInFds map[int]io.Reader
	var closersBuf [4]io.Closer
	closers := closersBuf[:0]
	if len(st.Redirs) > 0 {
		r.reportBgStart(0) // opening a file may block
		if len(r.extraFds) > 0 {
			oldExtraFds = maps.Clone(r.extraFds)
		}
		if len(r.extraInFds) > 0 {
			oldExtraInFds = maps.Clone(r.extraInFds)
		}
	}
	for _, rd := range st.Redirs {
		cls, err := r.redir(ctx, rd)
		if err != nil {
			if !r.exit.fatalExit {
				// A fatal error from a handler is reported by [Runner.Run].
				r.errf("%v\n", err)
			}
			r.exit.code = 1
			break
		}
		if cls != nil {
			closers = append(closers, cls)
		}
	}
	if r.exit.ok() && st.Cmd != nil {
		r.cmd(ctx, st.Cmd)
	}
	if st.Negated {
		if r.exit.ok() {
			r.exit.code = 1
		} else {
			r.exit.clear()
		}
	} else if b, ok := st.Cmd.(*syntax.BinaryCmd); ok && (b.Op == syntax.AndStmt || b.Op == syntax.OrStmt) {
	} else if !r.exit.ok() && !r.noErrExit {
		r.trapCallback(ctx, r.callbackErr, "error")
		// If the "errexit" option is set and a command failed, exit the shell. Exceptions:
		//
		//   conditions (if <cond>, while <cond>, etc)
		//   part of && or || lists; excluded via "else" above
		//   preceded by !; excluded via "else" above
		if r.opts[optErrExit] {
			r.exit.exiting = true
		}
	}
	if r.keepRedirs {
		// The exec builtin made this statement's redirections apply to the
		// shell itself, so keep active targets open and close any replaced
		// or explicitly closed (>&- / <&-) descriptors owned by this Runner.
		r.keepRedirs = false
		closed := make(map[io.Closer]struct{})
		closeIfUnref := func(c io.Closer) {
			if c == nil || r.stillReferenced(c) {
				return
			}
			if _, dup := closed[c]; dup {
				return
			}
			closed[c] = struct{}{}
			_ = c.Close()
		}
		for _, w := range oldExtraFds {
			if c, ok := w.(io.Closer); ok {
				closeIfUnref(c)
			}
		}
		for _, in := range oldExtraInFds {
			if c, ok := in.(io.Closer); ok {
				closeIfUnref(c)
			}
		}
		for _, cls := range closers {
			closeIfUnref(cls)
		}
	} else if len(st.Redirs) > 0 {
		r.stdin, r.stdout, r.stderr = oldIn, oldOut, oldErr
		r.extraFds = oldExtraFds
		r.extraInFds = oldExtraInFds
		for _, cls := range closers {
			cls.Close()
		}
	}
}

func (r *Runner) cmd(ctx context.Context, cm syntax.Command) {
	if r.stop(ctx) {
		return
	}

	tracingEnabled := r.opts[optXTrace]
	trace := r.tracer()

	switch cm := cm.(type) {
	case *syntax.Block:
		r.stmts(ctx, cm.Stmts)
	case *syntax.Subshell:
		r2 := r.subshell(false)
		r2.stmts(ctx, cm.Stmts)
		r2.finishSubshell(ctx)
		r.exit = r2.exit
	case *syntax.CallExpr:
		// Build new slices, to not modify the caller's AST
		// nor the slices in the alias map.
		args := cm.Args
		for i := 0; i < len(args); {
			if !r.opts[optExpandAliases] {
				break
			}
			als, ok := r.alias[args[i].Lit()]
			if !ok {
				break
			}
			args = slices.Concat(args[:i], als.args, args[i+1:])
			if !als.blank {
				break
			}
			i += len(als.args)
		}
		r.lastExpandExit = exitStatus{}
		var fields []string
		usedCallArgsBuf := false
		if len(args) > 0 {
			if !r.callArgsInUse && len(args) <= len(r.callArgsBuf) {
				r.callArgsInUse = true
				usedCallArgsBuf = true
				var err error
				fields, err = expand.FieldsInto(r.callArgsBuf[:0], r.ecfg, args...)
				r.expandErr(err)
			} else {
				fields = r.fields(args...)
			}
		}
		if len(fields) == 0 {
			if usedCallArgsBuf {
				clear(r.callArgsBuf[:])
				r.callArgsInUse = false
			}
			for _, as := range cm.Assigns {
				name := as.Name.Value

				prev := r.lookupVar(name)
				// Here we have a naked "foo=bar", so if we inherited a local var from a parent
				// function we want to signal that we are modifying the parent var rather than
				// creating a new local var via "local foo=bar".
				// TODO: there is likely a better way to do this.
				prev.Local = false

				name, vr := r.assignVal(name, prev, as, "")
				r.setVarWithIndex(prev, name, as.Index, vr)

				if !tracingEnabled {
					continue
				}

				// Strangely enough, it seems like Bash prints original
				// source for arrays, but the expanded value otherwise.
				// Note that, unlike bash, we print neither the subscript
				// in `x[i]=y` nor just the appended value in `x+=y`.
				if as.Array != nil {
					trace.expr(as)
				} else if as.Value != nil {
					trace.stringf("%s=%s", name, quoteBash(vr.String()))
				}
				trace.newLineFlush()
			}
			// If interpreting the last expansion like $(foo) failed,
			// and the expansion and assignments otherwise succeeded,
			// we need to surface that last exit code.
			if r.exit.ok() {
				r.exit = r.lastExpandExit
			}
			break
		}

		type restoreVar struct {
			name string
			vr   expand.Variable
		}
		var restores []restoreVar

		for _, as := range cm.Assigns {
			name := as.Name.Value
			prev := r.lookupVar(name)
			// Resolve any nameref so we can restore the original final value later on.
			if n, v := prev.Resolve(r.writeEnv); n != "" {
				name, prev = n, v
			}

			name, vr := r.assignVal(name, prev, as, "")
			// Inline command vars are always exported.
			vr.Exported = true

			restores = append(restores, restoreVar{name, prev})

			r.setVar(name, vr)
		}

		trace.call(fields[0], fields[1:]...)
		trace.newLineFlush()

		r.call(ctx, cm.Args[0].Pos(), fields)
		if usedCallArgsBuf {
			clear(r.callArgsBuf[:])
			r.callArgsInUse = false
		}
		for _, restore := range restores {
			r.setVar(restore.name, restore.vr)
		}
	case *syntax.BinaryCmd:
		switch cm.Op {
		case syntax.AndStmt, syntax.OrStmt:
			oldNoErrExit := r.noErrExit
			r.noErrExit = true
			r.stmt(ctx, cm.X)
			r.noErrExit = oldNoErrExit
			if r.exit.ok() == (cm.Op == syntax.AndStmt) {
				r.stmt(ctx, cm.Y)
			}
		case syntax.Pipe, syntax.PipeAll:
			var (
				pr  stdinFile
				pw  io.WriteCloser
				err error
			)
			if r.stmtCanUseMemPipe(cm.Y) {
				pr, pw, err = newPipe()
			} else {
				pr, pw, err = newOSPipe()
			}
			if err != nil {
				r.exit.fatal(err) // not being able to create a pipe is rare but critical
				return
			}
			r2 := r.subshell(true)
			r2.stdout = pw
			if cm.Op == syntax.PipeAll {
				r2.stderr = pw
			} else {
				r2.stderr = r.stderr
			}
			oldIn := r.stdin
			r.stdin = pr
			var wg sync.WaitGroup
			wg.Go(func() {
				r2.stmt(ctx, cm.X)
				r2.finishSubshell(ctx)
				pw.Close()
			})
			r.stmt(ctx, cm.Y)
			pr.Close()
			wg.Wait()
			r.stdin = oldIn
			// A pipeline parses left-associatively: `a | b | c` is
			// `(a | b) | c`. The inner subshell already recorded the
			// left-hand stages in its own pipeStatusCodes, so append this
			// stage's status instead of overwriting (bash keeps them all).
			if nLeft := len(r2.pipeStatusCodes); nLeft > 0 {
				total := nLeft + 1
				var codes []int
				if total <= len(r.pipeStatusInline) {
					copy(r.pipeStatusInline[:], r2.pipeStatusCodes)
					r.pipeStatusInline[nLeft] = int(r.exit.code)
					codes = r.pipeStatusInline[:total]
				} else {
					codes = make([]int, total)
					copy(codes, r2.pipeStatusCodes)
					codes[nLeft] = int(r.exit.code)
				}
				r.pipeStatusCodes = codes
			} else {
				r.pipeStatusInline[0] = int(r2.exit.code)
				r.pipeStatusInline[1] = int(r.exit.code)
				r.pipeStatusCodes = r.pipeStatusInline[:2]
			}
			r.setPipeStatus(r.pipeStatusCodes...)
			if r.opts[optPipeFail] && !r2.exit.ok() && r.exit.ok() {
				r.exit = r2.exit
			}
			if r2.exit.fatalExit {
				r.exit.fatal(r2.exit.err) // surface fatal errors immediately
			}
		}
	case *syntax.IfClause:
		oldNoErrExit := r.noErrExit
		r.noErrExit = true
		r.stmts(ctx, cm.Cond)
		r.noErrExit = oldNoErrExit

		if r.exit.ok() {
			r.stmts(ctx, cm.Then)
			break
		}
		r.exit.clear()
		if cm.Else != nil {
			r.cmd(ctx, cm.Else)
		}
	case *syntax.WhileClause:
		for !r.stop(ctx) {
			oldNoErrExit := r.noErrExit
			r.noErrExit = true
			r.stmts(ctx, cm.Cond)
			r.noErrExit = oldNoErrExit

			stop := r.exit.ok() == cm.Until
			r.exit.clear()
			if stop || r.loopStmtsBroken(ctx, cm.Do) {
				break
			}
		}
	case *syntax.ForClause:
		switch y := cm.Loop.(type) {
		case *syntax.WordIter:
			name := y.Name.Value
			items := r.Params // for i; do ...

			inToken := y.InPos.IsValid()
			if inToken {
				items = r.fields(y.Items...) // for i in ...; do ...
			}

			if cm.Select {
				ps3 := cmp.Or(r.envGet(shellReplyPS3Var), shellDefaultPS3)

				for menu := true; ; {
					if menu {
						// display menu
						for i, word := range items {
							r.errf("%d) %v\n", i+1, word)
						}
						menu = false
					}
					r.errf("%s", ps3)

					line, err := r.readLine(ctx, true)
					if err != nil {
						r.errf("\n")
						r.exit.code = 1
						break
					}
					if len(line) == 0 {
						menu = true // no reply; show the menu again
						continue
					}

					reply := string(line)
					r.setVarString(shellReplyVar, reply)

					if c, _ := strconv.Atoi(reply); c > 0 && c <= len(items) {
						r.setVarString(name, items[c-1])
					} else {
						r.setVarString(name, "")
					}

					// execute commands until break or return is encountered
					if r.loopStmtsBroken(ctx, cm.Do) {
						break
					}
				}
				break
			}

			for _, field := range items {
				r.setVarString(name, field)
				trace.stringf("for %s in", y.Name.Value)
				if inToken {
					for _, item := range y.Items {
						trace.string(" ")
						trace.expr(item)
					}
				} else {
					trace.string(` "$@"`)
				}
				trace.newLineFlush()
				if r.loopStmtsBroken(ctx, cm.Do) {
					break
				}
			}
		case *syntax.CStyleLoop:
			if y.Init != nil {
				r.arithm(y.Init)
			}
			for y.Cond == nil || r.arithm(y.Cond) != 0 {
				if !r.exit.ok() || r.loopStmtsBroken(ctx, cm.Do) {
					break
				}
				if y.Post != nil {
					r.arithm(y.Post)
				}
			}
		}
	case *syntax.FuncDecl:
		if cm.Name == nil { // e.g. zsh's anonymous or multi-name functions
			r.errf("unsupported\n")
			r.exit.code = 1
			break
		}
		r.setFunc(cm.Name.Value, cm.Body)
	case *syntax.ArithmCmd:
		r.exit.oneIf(r.arithm(cm.X) == 0)
	case *syntax.LetClause:
		if tracingEnabled {
			trace.string("let")
			for _, expr := range cm.Exprs {
				trace.stringf(" %s", r.letArgString(trace.printer, expr))
			}
			trace.newLineFlush()
		}
		var val int
		for _, expr := range cm.Exprs {
			val = r.arithm(expr)
		}
		r.exit.oneIf(val == 0)
	case *syntax.CaseClause:
		trace.string("case ")
		trace.expr(cm.Word)
		trace.string(" in")
		trace.newLineFlush()
		str := r.literal(cm.Word)
		runNext := false // whether the previous item ended with ";&"
		for _, ci := range cm.Items {
			if !runNext && !slices.ContainsFunc(ci.Patterns, func(word *syntax.Word) bool {
				return r.match(r.pattern(word), str)
			}) {
				continue
			}
			r.stmts(ctx, ci.Stmts)
			switch ci.Op {
			case syntax.Fallthrough: // ";&" runs the next item unconditionally
				runNext = true
			case syntax.Resume, syntax.ResumeKorn: // ";;&" and ";|" resume matching
				runNext = false
			default: // ";;" or the last item stop
				return
			}
		}
	case *syntax.TestClause:
		if r.bashTest(ctx, cm.X, false) == "" && r.exit.ok() {
			// to preserve exit status code 2 for regex errors, etc
			r.exit.code = 1
		}
	case *syntax.DeclClause:
		local, global := false, false
		var modes []string
		valType := ""
		integerAttr := false
		declQuery := "" // "-f" or "-p" for query mode
		switch cm.Variant.Value {
		case "declare":
			// When used in a function, "declare" acts as "local"
			// unless the "-g" option is used.
			local = r.inFunc
		case "local":
			if !r.inFunc {
				r.errf("local: can only be used in a function\n")
				r.exit.code = 1
				return
			}
			local = true
		case "export":
			modes = append(modes, "-x")
		case "readonly":
			modes = append(modes, "-r")
		case "nameref":
			valType = "-n"
		}
	assignLoop:
		for as := range r.flattenAssigns(cm.Args) {
			fp := flagParser{remaining: []string{as.Name.Value}}
			hadFlag := false
			for fp.more() {
				hadFlag = true
				switch flag := fp.flag(); flag {
				case "-x", "-r":
					modes = append(modes, flag)
				case "-a", "-A", "-n":
					valType = flag
				case "-i":
					// integer attribute: values are evaluated as
					// arithmetic on assignment, like bash.
					integerAttr = true
				case "-g":
					global = true
				case "-f", "-p":
					declQuery = flag
				default:
					r.errf("declare: invalid option %q\n", flag)
					r.exit.code = 2
					return
				}
			}
			if hadFlag {
				continue assignLoop
			}
			name := as.Name.Value
			if !syntax.ValidName(name) {
				r.errf("declare: invalid name %q\n", name)
				r.exit.code = 1
				return
			}
			if declQuery == "-f" {
				// declare -f name: print function definition.
				// Bash silently returns exit 1 for missing functions.
				if body := r.Funcs[name]; body != nil {
					r.outf("%s()\n", name)
					printer := syntax.NewPrinter()
					var buf bytes.Buffer
					printer.Print(&buf, body)
					r.outf("%s\n", buf.String())
				} else {
					r.exit.code = 1
				}
				continue
			}
			if declQuery == "-p" {
				// declare -p name: print variable with attributes.
				vr := r.lookupVar(name)
				if !vr.Declared() {
					r.errf("declare: %s: not found\n", name)
					r.exit.code = 1
					continue
				}
				flags := vr.Flags()
				if flags == "" {
					flags = "-"
				}
				switch vr.Kind {
				case expand.Indexed:
					r.outf("declare -%s %s=(", flags, name)
					for i, v := range vr.List {
						if i > 0 {
							r.out(" ")
						}
						idx := i
						if vr.Indexes != nil {
							idx = vr.Indexes[i]
						}
						r.outf("[%d]=%q", idx, v)
					}
					r.out(")\n")
				case expand.Associative:
					r.outf("declare -%s %s=(", flags, name)
					first := true
					for k, v := range vr.Map {
						if !first {
							r.out(" ")
						}
						r.outf("[%s]=%q", k, v)
						first = false
					}
					r.out(")\n")
				default:
					r.outf("declare -%s %s=%q\n", flags, name, vr.Str)
				}
				continue
			}
			vr := r.lookupVar(name)
			if as.Naked {
				if valType == "-A" {
					vr.Kind = expand.Associative
				} else {
					vr.Kind = expand.KeepValue
				}
			} else if integerAttr {
				// declare -i: the value is an arithmetic expression.
				// Expand the word, then evaluate it as arithmetic.
				lit := r.literal(as.Value)
				n, aerr := arithmEval(r.ecfg, lit)
				if aerr != nil {
					r.errf("declare: %v\n", aerr)
					r.exit.code = 1
					continue
				}
				vr.Set = true
				vr.Kind = expand.String
				vr.Str = strconv.FormatInt(n, 10)
			} else {
				name, vr = r.assignVal(name, vr, as, valType)
			}
			if global {
				vr.Local = false
			} else if local {
				vr.Local = true
			}
			for _, mode := range modes {
				switch mode {
				case "-x":
					vr.Exported = true
				case "-r":
					vr.ReadOnly = true
				}
			}
			r.setVar(name, vr)
		}
	case *syntax.TimeClause:
		start := time.Now()
		if cm.Stmt != nil {
			r.stmt(ctx, cm.Stmt)
		}
		format := "%s\t%s\n"
		if cm.PosixFormat {
			format = "%s %s\n"
		} else {
			r.outf("\n")
		}
		real := time.Since(start)
		r.outf(format, "real", elapsedString(real, cm.PosixFormat))
		// TODO: can we do these?
		r.outf(format, "user", elapsedString(0, cm.PosixFormat))
		r.outf(format, "sys", elapsedString(0, cm.PosixFormat))
	default:
		// Should only happen if we forgot a case above.
		r.errf("unhandled command node: %T\n", cm)
		r.exit.code = 1
	}
}

func (r *Runner) trapCallback(ctx context.Context, callback, name string) {
	if callback == "" {
		return // nothing to do
	}
	if r.handlingTrap {
		return // don't recurse, as that could lead to cycles
	}
	r.handlingTrap = true
	defer func() { r.handlingTrap = false }()

	p := syntax.NewParser()
	// TODO: do this parsing when "trap" is called?
	file, err := p.Parse(strings.NewReader(callback), name+" trap")
	if err != nil {
		r.errf(name+"trap: %v\n", err)
		// ignore errors in the callback
		return
	}
	oldExit, oldLastExit := r.exit, r.lastExit
	r.lastExit = r.exit
	r.exit = exitStatus{}
	r.stmts(ctx, file.Stmts)
	if r.exit.exiting || r.exit.returning {
		oldExit = r.exit
	}
	r.exit, r.lastExit = oldExit, oldLastExit // traps on EXIT or ERR should not modify the result
}

func (r *Runner) flattenAssigns(args []*syntax.Assign) iter.Seq[*syntax.Assign] {
	return func(yield func(*syntax.Assign) bool) {
		for _, as := range args {
			// Convert "declare $x" into "declare value".
			// Don't use syntax.Parser here, as we only want the basic
			// splitting by '='.
			if as.Name != nil {
				if !yield(as) {
					return
				}
				continue
			}
			for _, field := range r.fields(as.Value) {
				as := &syntax.Assign{}
				name, val, ok := strings.Cut(field, "=")
				as.Name = &syntax.Lit{Value: name}
				if !ok {
					as.Naked = true
				} else {
					as.Value = &syntax.Word{Parts: []syntax.WordPart{
						&syntax.Lit{Value: val},
					}}
				}
				if !yield(as) {
					return
				}
			}
		}
	}
}

// letArgString reproduces one expression of a let clause as bash would print it
// when tracing, that is, as the single quoted word that bash's let receives.
func (r *Runner) letArgString(printer *syntax.Printer, expr syntax.ArithmExpr) string {
	if word, ok := expr.(*syntax.Word); ok {
		return quoteBash(r.literal(word))
	}
	// The printer only prints an arithmetic expression as part of a parent node,
	// so print a let clause holding just this expression and drop the keyword.
	// The keyword borrows the expression's position to stay on the same line.
	// TODO: drop this workaround if [syntax.Printer.Print] learns to print
	// an arithmetic expression on its own.
	var sb strings.Builder
	if err := printer.Print(&sb, &syntax.LetClause{
		Let:   expr.Pos(),
		Exprs: []syntax.ArithmExpr{expr},
	}); err != nil { // should never happen
		panic(err)
	}
	return strings.TrimPrefix(sb.String(), "let ")
}

func (r *Runner) match(pat, name string) bool {
	matcher, err := internal.ExtendedPatternMatcher(pat, pattern.EntireString|pattern.ExtendedOperators)
	if err != nil {
		// A malformed pattern simply does not match, like in bash.
		// Any other error, such as an unsupported extended pattern, is reported.
		if _, ok := errors.AsType[*pattern.SyntaxError](err); !ok {
			r.expandErr(err)
		}
		return false
	}
	return matcher(name)
}

func elapsedString(d time.Duration, posix bool) string {
	if posix {
		return fmt.Sprintf("%.2f", d.Seconds())
	}
	mins := int(d.Minutes())
	sec := math.Mod(d.Seconds(), 60.0)
	return fmt.Sprintf("%dm%.3fs", mins, sec)
}

func (r *Runner) stmts(ctx context.Context, stmts []*syntax.Stmt) {
	for _, stmt := range stmts {
		r.stmt(ctx, stmt)
	}
}

func unwrapCallTarget(args []*syntax.Word) (lit string, bypassedFuncs bool, pureInProc bool) {
	i := 0
	for i < len(args) {
		w := args[i].Lit()
		if w == "" {
			return "", bypassedFuncs, false
		}
		switch w {
		case "command":
			bypassedFuncs = true
			i++
			for i < len(args) {
				opt := args[i].Lit()
				if opt == "" {
					return "", true, false
				}
				if opt == "--" {
					i++
					break
				}
				if len(opt) > 1 && opt[0] == '-' {
					for j := 1; j < len(opt); j++ {
						if opt[j] == 'v' || opt[j] == 'V' {
							return "command", true, true
						}
						if opt[j] != 'p' {
							return "", true, false
						}
					}
					i++
					continue
				}
				break
			}
			if i >= len(args) {
				return "command", true, true
			}
			continue
		case "builtin":
			bypassedFuncs = true
			i++
			if i >= len(args) {
				return "builtin", true, true
			}
			continue
		case "exec":
			bypassedFuncs = true
			i++
			for i < len(args) {
				opt := args[i].Lit()
				if opt == "" {
					return "", true, false
				}
				if opt == "--" {
					i++
					break
				}
				if opt == "-c" || opt == "-l" {
					i++
					continue
				}
				if opt == "-a" {
					i += 2
					continue
				}
				if strings.HasPrefix(opt, "-") {
					return "", true, false
				}
				break
			}
			if i >= len(args) {
				return "exec", true, true
			}
			continue
		}
		return w, bypassedFuncs, false
	}
	return "", bypassedFuncs, false
}

func (r *Runner) stmtCanUseMemPipe(st *syntax.Stmt) bool {
	if st == nil || st.Cmd == nil {
		return true
	}
	switch c := st.Cmd.(type) {
	case *syntax.CallExpr:
		if len(c.Args) == 0 {
			return true
		}
		lit, bypassedFuncs, pureInProc := unwrapCallTarget(c.Args)
		if pureInProc {
			return true
		}
		if lit == "" {
			return false
		}
		if !bypassedFuncs {
			if body := r.Funcs[lit]; body != nil {
				return r.stmtAllInProcess(body, 0)
			}
		}
		switch lit {
		case "eval", "source", ".":
			return false
		}
		if memPipeDenied(lit) {
			return false
		}
		return true
	case *syntax.BinaryCmd:
		if c.Op == syntax.Pipe || c.Op == syntax.PipeAll {
			return r.stmtCanUseMemPipe(c.X)
		}
	}
	return r.stmtAllInProcess(st, 0)
}

func (r *Runner) stmtAllInProcess(st *syntax.Stmt, depth int) bool {
	if st == nil || st.Cmd == nil {
		return true
	}
	if depth > 8 {
		return false
	}
	switch c := st.Cmd.(type) {
	case *syntax.CallExpr:
		if len(c.Args) == 0 {
			return true
		}
		lit, bypassedFuncs, pureInProc := unwrapCallTarget(c.Args)
		if pureInProc {
			return true
		}
		if lit == "" {
			return false
		}
		if !bypassedFuncs {
			if body := r.Funcs[lit]; body != nil {
				return r.stmtAllInProcess(body, depth+1)
			}
		}
		switch lit {
		case "eval", "source", ".":
			return false
		}
		if memPipeDenied(lit) {
			return false
		}
		return IsBuiltin(lit) || (r.fastCallFilter != nil && r.fastCallFilter(lit))
	case *syntax.Block:
		return r.stmtsAllInProcess(c.Stmts, depth+1)
	case *syntax.Subshell:
		return r.stmtsAllInProcess(c.Stmts, depth+1)
	case *syntax.BinaryCmd:
		if c.Op == syntax.Pipe || c.Op == syntax.PipeAll {
			return r.stmtAllInProcess(c.X, depth+1)
		}
		return r.stmtAllInProcess(c.X, depth+1) && r.stmtAllInProcess(c.Y, depth+1)
	case *syntax.IfClause:
		if !r.stmtsAllInProcess(c.Cond, depth+1) || !r.stmtsAllInProcess(c.Then, depth+1) {
			return false
		}
		if c.Else != nil {
			return r.stmtAllInProcess(&syntax.Stmt{Cmd: c.Else}, depth+1)
		}
		return true
	case *syntax.WhileClause:
		return r.stmtsAllInProcess(c.Cond, depth+1) && r.stmtsAllInProcess(c.Do, depth+1)
	case *syntax.ForClause:
		return r.stmtsAllInProcess(c.Do, depth+1)
	case *syntax.ArithmCmd, *syntax.TestClause, *syntax.DeclClause, *syntax.LetClause, *syntax.FuncDecl:
		return true
	}
	return false
}

func (r *Runner) stmtsAllInProcess(stmts []*syntax.Stmt, depth int) bool {
	for _, s := range stmts {
		if !r.stmtAllInProcess(s, depth) {
			return false
		}
	}
	return true
}

func (r *Runner) hdocReader(rd *syntax.Redirect) (stdinFile, error) {
	pr, pw, err := newPipe()
	if err != nil {
		return nil, err
	}
	hdoc := r.hdocString(rd)
	if _, isOS := pw.(*os.File); !isOS && len(hdoc) <= 64*1024 {
		io.WriteString(pw, hdoc)
		pw.Close()
		return pr, nil
	}
	// We write to the pipe in a new goroutine,
	// as pipe writes may block once the buffer gets full.
	// We still construct and buffer the entire heredoc first,
	// as doing it concurrently would lead to different semantics and be racy.
	go func() {
		io.WriteString(pw, hdoc)
		pw.Close()
	}()
	return pr, nil
}

// hdocQuotedDelim reports whether a here-document delimiter word is quoted,
// as in "<<'EOF'" or "<<\EOF", which makes its body literal.
func hdocQuotedDelim(word *syntax.Word) bool {
	for _, wp := range word.Parts {
		switch wp := wp.(type) {
		case *syntax.Lit:
			if strings.Contains(wp.Value, "\\") {
				return true
			}
		case *syntax.SglQuoted, *syntax.DblQuoted:
			return true
		}
	}
	return false
}

// hdocWord returns a here-document body, or one of its lines, as a string.
// A quoted delimiter, as in "<<'EOF'", makes the body literal,
// in which case the parser only gives us literal parts.
// Note that a partly quoted delimiter, such as "<<'A'B",
// is not spotted by the parser either, so we still expand its body.
func (r *Runner) hdocWord(word *syntax.Word, quoted bool) string {
	if quoted {
		if lit := word.Lit(); lit != "" {
			return lit
		}
	}
	return r.document(word)
}

// hdocString returns the body of a here-document as a string.
func (r *Runner) hdocString(rd *syntax.Redirect) string {
	if rd.Hdoc == nil {
		return "" // an empty here-document
	}
	quoted := hdocQuotedDelim(rd.Word)
	if rd.Op != syntax.DashHdoc {
		return r.hdocWord(rd.Hdoc, quoted)
	}
	// Strip the leading tabs from each line.
	var buf strings.Builder
	var cur []syntax.WordPart
	flushLine := func() {
		if buf.Len() > 0 {
			buf.WriteByte('\n')
		}
		buf.WriteString(r.hdocWord(&syntax.Word{Parts: cur}, quoted))
		cur = cur[:0]
	}
	for _, wp := range rd.Hdoc.Parts {
		lit, ok := wp.(*syntax.Lit)
		if !ok {
			cur = append(cur, wp)
			continue
		}
		first := true
		for part := range strings.SplitSeq(lit.Value, "\n") {
			if !first {
				flushLine()
			}
			first = false
			part = strings.TrimLeft(part, "\t")
			cur = append(cur, &syntax.Lit{Value: part})
		}
	}
	flushLine()
	return buf.String()
}

func (r *Runner) redir(ctx context.Context, rd *syntax.Redirect) (io.Closer, error) {
	// Note that Hdoc is nil for an empty here-document.
	if rd.Op == syntax.Hdoc || rd.Op == syntax.DashHdoc {
		pr, err := r.hdocReader(rd)
		if err != nil {
			return nil, err
		}
		r.stdin = pr
		return pr, nil
	}

	orig := &r.stdout
	fdNum := -1
	if rd.N != nil {
		switch rd.N.Value {
		case "0":
			// Note that the input redirects below always use stdin (0)
			// because we don't support anything else right now.
		case "1":
			// The default for the output redirects below.
		case "2":
			orig = &r.stderr
		default:
			n, err := strconv.Atoi(rd.N.Value)
			if err != nil || n < 0 {
				return nil, fmt.Errorf("unsupported redirect fd: %v", rd.N.Value)
			}
			fdNum = n
		}
	}
	// setOut points an output redirection at its target; fds above 2 live
	// in the shell's fd table, as in `exec 3>file`.
	setOut := func(w io.Writer) {
		if fdNum > 2 {
			if r.extraFds == nil {
				r.extraFds = map[int]io.Writer{}
			}
			r.extraFds[fdNum] = w
			return
		}
		*orig = w
	}
	setIn := func(rd2 io.Reader) {
		if fdNum > 2 {
			if r.extraInFds == nil {
				r.extraInFds = map[int]io.Reader{}
			}
			r.extraInFds[fdNum] = rd2
			return
		}
		if sf, ok := rd2.(stdinFile); ok {
			r.stdin = sf
		} else if sf, err := newStdinFile(rd2); err == nil {
			r.stdin = sf
		}
	}
	arg := r.literal(rd.Word)
	switch rd.Op {
	case syntax.WordHdoc:
		pr, pw, err := newPipe()
		if err != nil {
			return nil, err
		}
		r.stdin = pr
		if _, isOS := pw.(*os.File); !isOS && len(arg)+1 <= 64*1024 {
			io.WriteString(pw, arg)
			io.WriteString(pw, "\n")
			pw.Close()
			return pr, nil
		}
		// We write to the pipe in a new goroutine,
		// as pipe writes may block once the buffer gets full.
		go func() {
			io.WriteString(pw, arg)
			io.WriteString(pw, "\n")
			pw.Close()
		}()
		return pr, nil
	case syntax.DplOut:
		switch arg {
		case "1":
			setOut(r.stdout)
		case "2":
			setOut(r.stderr)
		case "-":
			if fdNum > 2 {
				delete(r.extraFds, fdNum)
				return nil, nil
			}
			*orig = io.Discard // closing the output writer
		default:
			// Dup from a numbered fd, as in `echo >&3`.
			if n, err := strconv.Atoi(arg); err == nil && n > 2 {
				w, ok := r.extraFds[n]
				if !ok {
					return nil, fmt.Errorf("bad file descriptor: %s", arg)
				}
				setOut(w)
				return nil, nil
			}
			return nil, fmt.Errorf("unhandled %v arg: %q", rd.Op, arg)
		}
		return nil, nil
	case syntax.RdrIn, syntax.RdrOut, syntax.AppOut,
		syntax.RdrAll, syntax.AppAll:
		// done further below
	case syntax.DplIn:
		switch arg {
		case "-":
			if fdNum > 2 {
				delete(r.extraInFds, fdNum)
				return nil, nil
			}
			r.stdin = nil // closing the input file
		default:
			if n, err := strconv.Atoi(arg); err == nil && n > 2 {
				in, ok := r.extraInFds[n]
				if !ok {
					return nil, fmt.Errorf("bad file descriptor: %s", arg)
				}
				setIn(in)
				return nil, nil
			}
			return nil, fmt.Errorf("unhandled %v arg: %q", rd.Op, arg)
		}
		return nil, nil
	default:
		return nil, fmt.Errorf("unhandled redirect op: %v", rd.Op)
	}
	mode := os.O_RDONLY
	switch rd.Op {
	case syntax.AppOut, syntax.AppAll:
		mode = os.O_WRONLY | os.O_CREATE | os.O_APPEND
	case syntax.RdrOut, syntax.RdrAll:
		mode = os.O_WRONLY | os.O_CREATE | os.O_TRUNC
	}
	f, err := r.open(ctx, arg, mode, 0o644, false)
	if err != nil {
		return nil, err
	}
	switch rd.Op {
	case syntax.RdrIn:
		if fdNum > 2 {
			setIn(f)
			return f, nil
		}
		stdin, err := newStdinFile(f)
		if err != nil {
			return nil, err
		}
		r.stdin = stdin
	case syntax.RdrOut, syntax.AppOut:
		setOut(f)
	case syntax.RdrAll, syntax.AppAll:
		r.stdout = f
		r.stderr = f
	default:
		return nil, fmt.Errorf("unhandled redirect op: %v", rd.Op)
	}
	return f, nil
}

func (r *Runner) loopStmtsBroken(ctx context.Context, stmts []*syntax.Stmt) bool {
	oldInLoop := r.inLoop
	r.inLoop = true
	defer func() { r.inLoop = oldInLoop }()
	for _, stmt := range stmts {
		r.stmt(ctx, stmt)
		if r.contnEnclosing > 0 {
			r.contnEnclosing--
			return r.contnEnclosing > 0
		}
		if r.breakEnclosing > 0 {
			r.breakEnclosing--
			return true
		}
	}
	return false
}

func (r *Runner) call(ctx context.Context, pos syntax.Pos, args []string) {
	if r.stop(ctx) {
		return
	}
	if r.callHandler != nil {
		if r.fastCallHandler != nil {
			if r.fastCallFilter == nil || r.fastCallFilter(args[0]) {
				var err error
				args, err = r.fastCallHandler(ctx, r.makeHandlerCtx(handlerKindCall, pos), args)
				if err != nil {
					r.reportBgStart(0)
					r.exit.fromHandlerError(err)
					return
				}
			}
		} else {
			var err error
			pushActiveRunner(r)
			args, err = r.callHandler(r.handlerCtx(ctx, handlerKindCall, pos), args)
			popActiveRunner(r)
			if err != nil {
				r.reportBgStart(0)
				// Status errors are non-fatal, like bash builtins; custom
				// errors still halt the shell.
				r.exit.fromHandlerError(err)
				return
			}
		}
	}
	name := args[0]
	if body := r.Funcs[name]; body != nil {
		r.reportBgStart(0) // not one external program
		// stack them to support nested func calls
		oldParams := r.Params
		r.Params = args[1:]
		oldInFunc := r.inFunc
		r.inFunc = true

		// Functions run in a nested scope.
		// Note that [Runner.exec] below does something similar.
		origEnv := r.writeEnv
		r.writeEnv = &overlayEnviron{parent: r.writeEnv, funcScope: true}

		r.stmt(ctx, body)

		r.writeEnv = origEnv

		r.Params = oldParams
		r.inFunc = oldInFunc
		r.exit.returning = false
		return
	}
	if IsBuiltin(name) {
		r.reportBgStart(0) // not one external program
		r.exit = r.builtin(ctx, pos, name, args[1:])
		return
	}
	r.exec(ctx, pos, args)
}

func (r *Runner) exec(ctx context.Context, pos syntax.Pos, args []string) {
	r.exit.fromHandlerError(r.execHandler(r.handlerCtx(ctx, handlerKindExec, pos), args))
}

func isFastWriteOnlyDevNull(path string, flags int) bool {
	if flags&(os.O_RDONLY|os.O_WRONLY|os.O_RDWR) != os.O_WRONLY {
		return false
	}
	if path == "/dev/null" || path == os.DevNull {
		return true
	}
	if runtime.GOOS == "windows" && len(path) == 3 && strings.EqualFold(path, "NUL") {
		return true
	}
	return false
}

func (r *Runner) open(ctx context.Context, path string, flags int, mode os.FileMode, print bool) (io.ReadWriteCloser, error) {
	if r.fastDevNull != nil && isFastWriteOnlyDevNull(path, flags) {
		return r.fastDevNull, nil
	}
	// The path of an active process substitution is opened by its own
	// handler; for example, the named pipes created by the default handler
	// can only be opened directly via [os.OpenFile].
	if open := r.procSubsts.lookup(path); open != nil {
		return open(ctx, flags)
	}

	f, err := r.openHandler(r.handlerCtx(ctx, handlerKindOpen, todoPos), path, flags, mode)
	// TODO: support wrapped PathError returned from openHandler.
	switch err.(type) {
	case nil:
		return f, nil
	case *os.PathError:
		if print {
			r.errf("%v\n", err)
		}
	default: // handler's custom fatal error
		r.exit.fatal(err)
	}
	return nil, err
}

func (r *Runner) stat(ctx context.Context, name string) (fs.FileInfo, error) {
	path := absPath(r.Dir, name)
	return r.statHandler(r.handlerCtx(ctx, handlerKindStat, todoPos), path, true)
}

func (r *Runner) lstat(ctx context.Context, name string) (fs.FileInfo, error) {
	path := absPath(r.Dir, name)
	return r.statHandler(r.handlerCtx(ctx, handlerKindStat, todoPos), path, false)
}

func (r *Runner) access(ctx context.Context, name string, mode AccessMode) error {
	path := absPath(r.Dir, name)
	return r.accessHandler(r.handlerCtx(ctx, handlerKindAccess, todoPos), path, mode)
}

// arithmEval parses src as an arithmetic expression and evaluates it.
// Used by declare -i, whose value is an expression rather than a literal.
func arithmEval(ecfg *expand.Config, src string) (int64, error) {
	expr, err := syntax.NewParser().Arithmetic(strings.NewReader(src))
	if err != nil {
		return 0, err
	}
	n, err := expand.Arithm(ecfg, expr)
	return int64(n), err
}
