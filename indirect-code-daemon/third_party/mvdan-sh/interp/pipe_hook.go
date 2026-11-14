package interp

import (
	"io"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"
)

// StdinPipe is an in-memory or OS pipe read end usable as a Runner's stdin.
type StdinPipe interface {
	io.ReadCloser
	SetReadDeadline(t time.Time) error
}

// PipeFactoryFunc creates a paired (reader, writer) pipe for shell pipelines
// and here-documents.
type PipeFactoryFunc func() (StdinPipe, io.WriteCloser, error)

var (
	customPipeFactory atomic.Pointer[PipeFactoryFunc]
	memPipeDenyFilter atomic.Pointer[func(string) bool]
)

// SetPipeFactory installs a custom in-memory pipe constructor used by shell
// pipelines instead of allocating OS pipe file descriptors on every stage.
func SetPipeFactory(fn PipeFactoryFunc) {
	if fn == nil {
		customPipeFactory.Store(nil)
		return
	}
	customPipeFactory.Store(&fn)
}

// SetMemPipeDenyFilter registers a predicate identifying command names (e.g.
// external-process wrappers like env, nice, nohup, timeout, find, xargs) that
// pass stdin directly to os/exec without PrepareExecStdio and therefore must
// receive an OS pipe when placed downstream of a shell pipeline.
func SetMemPipeDenyFilter(fn func(name string) bool) {
	if fn == nil {
		memPipeDenyFilter.Store(nil)
		return
	}
	memPipeDenyFilter.Store(&fn)
}

func memPipeDenied(name string) bool {
	if fn := memPipeDenyFilter.Load(); fn != nil {
		return (*fn)(name)
	}
	return false
}

// VirtualDevNull is implemented by stateless in-memory /dev/null writers so
// external subprocesses can map them directly to the OS null device.
type VirtualDevNull interface {
	IsVirtualDevNull() bool
}

// IsVirtualDevNull reports whether w is a stateless virtual /dev/null handle.
func IsVirtualDevNull(w any) bool {
	if w == nil {
		return false
	}
	v, ok := w.(VirtualDevNull)
	return ok && v.IsVirtualDevNull()
}

// PrepareExecStdio adapts virtual /dev/null writers and non-*os.File pipe
// readers for an external [exec.Cmd] so child processes inherit native OS file
// descriptors without hanging cmd.Wait() when a child exits early without
// draining stdin.
func PrepareExecStdio(cmd *exec.Cmd) (afterStart func(), afterWait func()) {
	if IsVirtualDevNull(cmd.Stdout) {
		cmd.Stdout = nil
	}
	if IsVirtualDevNull(cmd.Stderr) {
		cmd.Stderr = nil
	}
	if cmd.Stdin == nil {
		return func() {}, func() {}
	}
	if _, ok := cmd.Stdin.(*os.File); ok {
		return func() {}, func() {}
	}
	sp, ok := cmd.Stdin.(StdinPipe)
	if !ok {
		return func() {}, func() {}
	}
	osR, osW, err := os.Pipe()
	if err != nil {
		return func() {}, func() {}
	}
	cmd.Stdin = osR
	var copyDone chan struct{}
	var closeOnce sync.Once
	closeW := func() {
		closeOnce.Do(func() {
			_ = osW.Close()
		})
	}
	started := false
	afterStart = func() {
		started = true
		_ = osR.Close()
		copyDone = make(chan struct{})
		go func() {
			defer close(copyDone)
			bufPtr := execCopyBufPool.Get().(*[32 * 1024]byte)
			_, _ = io.CopyBuffer(osW, sp, bufPtr[:])
			execCopyBufPool.Put(bufPtr)
			closeW()
		}()
	}
	afterWait = func() {
		if !started {
			_ = osR.Close()
			closeW()
			return
		}
		closeW()
		_ = sp.SetReadDeadline(time.Now())
		<-copyDone
		_ = sp.SetReadDeadline(time.Time{})
	}
	return afterStart, afterWait
}

var execCopyBufPool = sync.Pool{
	New: func() any {
		return new([32 * 1024]byte)
	},
}

// BridgeStdinPipeToOS bridges a non-*os.File [StdinPipe] into a temporary OS
// pipe with SetReadDeadline teardown so wrapper commands invoking os/exec
// directly never hang waiting on an undrained in-memory pipe. Returns (nil, nil)
// when r is already an *os.File or not a StdinPipe.
func BridgeStdinPipeToOS(r io.Reader) (*os.File, func()) {
	if r == nil {
		return nil, nil
	}
	if _, ok := r.(*os.File); ok {
		return nil, nil
	}
	sp, ok := r.(StdinPipe)
	if !ok {
		return nil, nil
	}
	osR, osW, err := os.Pipe()
	if err != nil {
		return nil, nil
	}
	copyDone := make(chan struct{})
	var closeOnce sync.Once
	closeW := func() {
		closeOnce.Do(func() {
			_ = osW.Close()
		})
	}
	go func() {
		defer close(copyDone)
		bufPtr := execCopyBufPool.Get().(*[32 * 1024]byte)
		_, _ = io.CopyBuffer(osW, sp, bufPtr[:])
		execCopyBufPool.Put(bufPtr)
		closeW()
	}()
	cleanup := func() {
		_ = osR.Close()
		closeW()
		_ = sp.SetReadDeadline(time.Now())
		<-copyDone
		_ = sp.SetReadDeadline(time.Time{})
	}
	return osR, cleanup
}
