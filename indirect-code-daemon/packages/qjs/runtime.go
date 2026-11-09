package qjs

/*
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include "shim.h"
*/
import "C"

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"
)

//go:embed runtime_prelude.js
var runtimePreludeSource string

// ScriptOptions configures one script execution in the full QuickJS runtime
// (used by the exec_script tool, runner fast-path, and --js CLI mode).
type ScriptOptions struct {
	Code          string
	Filename      string
	Args          []string
	OmitArgv1     bool
	CWD           string
	Env           map[string]string
	Stdin         io.Reader
	Stdout        io.Writer
	Stderr        io.Writer
	ExecPath      string
	ShellPath     string
	ShellFlag     string
	MemoryLimit   int
	JailRoots     []string
	ReadOnlyRoots []string
	FSReadRoots   []string
	FSWriteRoots  []string
	NetAllow      []string
}

const (
	rtEventTimer         = 1
	rtEventFetch         = 2
	rtEventChildStdout   = 3
	rtEventChildStderr   = 4
	rtEventChildExit     = 5
	rtEventHTTPRequest   = 6
	rtEventNetConnect    = 7
	rtEventNetData       = 8
	rtEventNetClose      = 9
	rtEventWorkerMessage = 10
	rtEventStdinData     = 11
	rtEventStdinEnd      = 12
	rtEventChildDrain    = 13
	rtEventNetDrain      = 14
	rtEventDgramMessage  = 15
	rtEventAsyncOp       = 16
)

type rtAsyncEvent struct {
	id   int32
	kind int32
	json string
	bin  []byte
}

type rtChildProc struct {
	mu           sync.Mutex
	cmd          *exec.Cmd
	stdin        *asyncByteWriter
	stdoutPipe   io.Closer
	stderrPipe   io.Closer
	outCredits   chan struct{}
	errCredits   chan struct{}
	cancel       context.CancelFunc
	killedSignal string
	detached     bool
	unrefed      bool
	syncWaiting  bool
	reaped       bool
	done         chan struct{}
	outBytes     []byte
	errBytes     []byte
	finalCode    *int
	finalSignal  *string
}

type rtHTTPPendingReq struct {
	mu          sync.Mutex
	notify      chan struct{}
	flushed     chan struct{}
	readCredits chan struct{}
	queue       []rtHTTPResponse
	queuedBytes int
	needDrain   bool
	closed      bool
}

type rtHTTPServer struct {
	ln      net.Listener
	srv     *http.Server
	reqsMu  sync.Mutex
	reqs    map[int32]*rtHTTPPendingReq
	connsMu sync.Mutex
	conns   map[net.Conn]http.ConnState
}

type rtHTTPResponse struct {
	Status        int               `json:"status"`
	StatusMessage string            `json:"statusMessage"`
	Headers       map[string]any    `json:"headers"`
	Trailers      map[string]string `json:"trailers"`
	Body          []byte            `json:"-"`
	Done          bool              `json:"done"`
	Destroy       bool              `json:"destroy"`
	WriteContinue bool              `json:"writeContinue"`
	FlushHeaders  bool              `json:"flushHeaders"`
}

type rtEntry struct {
	parentCtx context.Context
	ctx       context.Context
	cancel    context.CancelFunc
	startTime time.Time

	mu        sync.Mutex
	cwd       string
	env       map[string]string
	argv      []string
	execPath    string
	entryFile   string
	entryDir    string
	isEvalEntry bool
	shellPath     string
	shellFlag     string
	jailRoots     []string
	readOnlyRoots []string
	fsReadRoots   []string
	fsWriteRoots  []string
	netAllow      []string

	stdinMu             sync.Mutex
	stdin               io.Reader
	stdinEOF            bool
	stdinOverflow       bool
	stdinData           []byte
	stdinOff            int
	workerReaderStarted bool
	stdinAsyncStarted   bool
	stdinSyncWait       bool
	stdinBgStarted      bool
	stdinNotify         chan struct{}
	stdinCredits        chan struct{}

	writeMu sync.Mutex
	stdout  io.Writer
	stderr  io.Writer

	exited         atomic.Bool
	exitCode       atomic.Int32
	vmDeadlineNano atomic.Int64

	eventsMu    sync.Mutex
	eventsQueue []rtAsyncEvent
	eventsBytes int64
	eventsWake  chan struct{}
	eventsSpace chan struct{}

	fdsMu  sync.Mutex
	fds    map[int]*os.File
	nextFD int

	timersMu sync.Mutex
	timers   map[int32]*time.Timer

	fetchMu      sync.Mutex
	fetches      map[int32]context.CancelFunc
	fetchCredits map[int32]chan struct{}
	fetchBodies  map[int32]*asyncByteWriter

	childMu          sync.Mutex
	children         map[int32]*rtChildProc
	finishedChildren map[int32]*rtChildProc

	srvMu   sync.Mutex
	servers map[int32]*rtHTTPServer
	nextReq atomic.Int32

	netMu          sync.Mutex
	netListeners   map[int32]net.Listener
	netConns       map[int32]net.Conn
	netWriters     map[int32]*asyncByteWriter
	netReadCredits map[int32]chan struct{}
	netDialCancel  map[int32]context.CancelFunc
	netHalfClosed  map[int32]bool
	netRemoteEOF   map[int32]bool
	nextNetConn    atomic.Int32

	dgramMu    sync.Mutex
	dgramSocks map[int32]*net.UDPConn

	workerChansMu sync.Mutex
	workerChans   map[int32]*rtWorkerChannel

	zlibMu      sync.Mutex
	zlibStreams map[int]*zlibStreamState
}

var (
	rtEntriesMu sync.Mutex
	rtEntries   = map[uintptr]*rtEntry{}
	rtNextID    uint64
)

func rtRegister(en *rtEntry) uintptr {
	rtEntriesMu.Lock()
	defer rtEntriesMu.Unlock()
	rtNextID++
	h := uintptr(rtNextID)
	rtEntries[h] = en
	return h
}

func rtUnregister(h uintptr) {
	rtEntriesMu.Lock()
	delete(rtEntries, h)
	rtEntriesMu.Unlock()
}

func rtLookup(h uintptr) *rtEntry {
	rtEntriesMu.Lock()
	defer rtEntriesMu.Unlock()
	return rtEntries[h]
}

func (en *rtEntry) wakeEvents() {
	select {
	case en.eventsWake <- struct{}{}:
	default:
	}
}

const maxEventQueueBytes = 16 << 20

func (en *rtEntry) pushEvent(ev rtAsyncEvent) {
	if en.exited.Load() || en.ctx.Err() != nil {
		return
	}
	isDataEvent := ev.kind == rtEventChildStdout || ev.kind == rtEventChildStderr || ev.kind == rtEventNetData || (ev.kind == rtEventWorkerMessage && len(ev.bin) > 0)
	if isDataEvent {
		for {
			if en.exited.Load() || en.ctx.Err() != nil {
				return
			}
			en.eventsMu.Lock()
			if en.eventsBytes < maxEventQueueBytes || len(en.eventsQueue) == 0 {
				break
			}
			en.eventsMu.Unlock()
			select {
			case <-en.eventsSpace:
			case <-en.ctx.Done():
				return
			}
		}
	} else {
		en.eventsMu.Lock()
	}
	en.eventsBytes += int64(len(ev.bin) + len(ev.json) + 32)
	n := len(en.eventsQueue)
	if n > 0 && (ev.kind == rtEventChildStdout || ev.kind == rtEventChildStderr || ev.kind == rtEventNetData) {
		last := &en.eventsQueue[n-1]
		if last.id == ev.id && last.kind == ev.kind && last.json == "" && ev.json == "" && len(last.bin)+len(ev.bin) <= 4<<20 {
			last.bin = append(last.bin, ev.bin...)
			en.eventsMu.Unlock()
			en.wakeEvents()
			return
		}
	}
	en.eventsQueue = append(en.eventsQueue, ev)
	en.eventsMu.Unlock()
	en.wakeEvents()
}

func (en *rtEntry) discardChildStreamEvents(childID int32) {
	en.eventsMu.Lock()
	if len(en.eventsQueue) == 0 {
		en.eventsMu.Unlock()
		return
	}
	kept := en.eventsQueue[:0]
	var newBytes int64
	removed := false
	for _, ev := range en.eventsQueue {
		if ev.id == childID && (ev.kind == rtEventChildStdout || ev.kind == rtEventChildStderr) {
			removed = true
			continue
		}
		kept = append(kept, ev)
		newBytes += int64(len(ev.bin) + len(ev.json) + 32)
	}
	en.eventsQueue = kept
	en.eventsBytes = newBytes
	en.eventsMu.Unlock()
	if removed {
		select {
		case en.eventsSpace <- struct{}{}:
		default:
		}
	}
}

func (en *rtEntry) popEvents() []rtAsyncEvent {
	en.eventsMu.Lock()
	if len(en.eventsQueue) == 0 {
		en.eventsMu.Unlock()
		return nil
	}
	batch := en.eventsQueue
	en.eventsQueue = nil
	en.eventsBytes = 0
	en.eventsMu.Unlock()
	select {
	case en.eventsSpace <- struct{}{}:
	default:
	}
	for _, ev := range batch {
		if ev.kind == rtEventWorkerMessage && len(ev.bin) > 0 {
			en.workerChansMu.Lock()
			wc := en.workerChans[ev.id]
			en.workerChansMu.Unlock()
			if wc != nil && wc.credits != nil {
				select {
				case wc.credits <- struct{}{}:
				default:
				}
			}
		}
	}
	return batch
}

func (en *rtEntry) hasQueuedEvents() bool {
	en.eventsMu.Lock()
	n := len(en.eventsQueue)
	en.eventsMu.Unlock()
	return n > 0
}

func (en *rtEntry) abortBlockingIO() {
	var cancels []context.CancelFunc
	var writers []*asyncByteWriter
	var listeners []net.Listener
	var conns []net.Conn

	en.netMu.Lock()
	for id, cancel := range en.netDialCancel {
		cancels = append(cancels, cancel)
		delete(en.netDialCancel, id)
	}
	for id, w := range en.netWriters {
		writers = append(writers, w)
		delete(en.netWriters, id)
	}
	for _, ln := range en.netListeners {
		listeners = append(listeners, ln)
	}
	for _, c := range en.netConns {
		conns = append(conns, c)
	}
	en.netMu.Unlock()

	for _, cancel := range cancels {
		cancel()
	}
	for _, w := range writers {
		w.Abort()
	}
	for _, ln := range listeners {
		_ = ln.Close()
	}
	for _, c := range conns {
		_ = c.Close()
	}
}

func (en *rtEntry) cleanup() {
	en.cancel()

	en.timersMu.Lock()
	for id, t := range en.timers {
		t.Stop()
		delete(en.timers, id)
	}
	en.timersMu.Unlock()

	en.fetchMu.Lock()
	for id, bw := range en.fetchBodies {
		bw.Abort()
		delete(en.fetchBodies, id)
	}
	for id, cancel := range en.fetches {
		cancel()
		delete(en.fetches, id)
	}
	en.fetchMu.Unlock()

	var children []*rtChildProc
	en.childMu.Lock()
	for id, ch := range en.children {
		children = append(children, ch)
		delete(en.children, id)
	}
	en.finishedChildren = nil
	en.childMu.Unlock()
	normalExit := en.parentCtx != nil && en.parentCtx.Err() == nil
	for _, ch := range children {
		if ch.stdin != nil {
			ch.stdin.Abort()
		}
		ch.mu.Lock()
		keepAlive := ch.detached || ch.unrefed
		outPipe := ch.stdoutPipe
		errPipe := ch.stderrPipe
		ch.stdoutPipe = nil
		ch.stderrPipe = nil
		reaped := ch.reaped
		ch.mu.Unlock()
		if outPipe != nil {
			_ = outPipe.Close()
		}
		if errPipe != nil {
			_ = errPipe.Close()
		}
		if keepAlive && normalExit {
			continue
		}
		if ch.cancel != nil {
			ch.cancel()
		}
		if !reaped && ch.cmd != nil && ch.cmd.Process != nil {
			killProcessTree(ch.cmd.Process.Pid)
		}
	}

	var dgramConns []*net.UDPConn
	en.dgramMu.Lock()
	for id, u := range en.dgramSocks {
		dgramConns = append(dgramConns, u)
		delete(en.dgramSocks, id)
	}
	en.dgramMu.Unlock()
	for _, u := range dgramConns {
		_ = u.Close()
	}

	var servers []*rtHTTPServer
	en.srvMu.Lock()
	for id, s := range en.servers {
		servers = append(servers, s)
		delete(en.servers, id)
	}
	en.srvMu.Unlock()
	for _, s := range servers {
		_ = s.ln.Close()
		_ = s.srv.Close()
		s.connsMu.Lock()
		for c := range s.conns {
			_ = c.Close()
			delete(s.conns, c)
		}
		s.connsMu.Unlock()
		s.reqsMu.Lock()
		for reqID, pReq := range s.reqs {
			pReq.mu.Lock()
			pReq.closed = true
			select {
			case pReq.notify <- struct{}{}:
			default:
			}
			pReq.mu.Unlock()
			delete(s.reqs, reqID)
		}
		s.reqsMu.Unlock()
	}

	var netCancels []context.CancelFunc
	var netWriters []*asyncByteWriter
	var netListeners []net.Listener
	var netConns []net.Conn
	en.netMu.Lock()
	for id, cancel := range en.netDialCancel {
		netCancels = append(netCancels, cancel)
		delete(en.netDialCancel, id)
	}
	for id, w := range en.netWriters {
		netWriters = append(netWriters, w)
		delete(en.netWriters, id)
	}
	for id, ln := range en.netListeners {
		netListeners = append(netListeners, ln)
		delete(en.netListeners, id)
	}
	for id, c := range en.netConns {
		netConns = append(netConns, c)
		delete(en.netConns, id)
	}
	en.netMu.Unlock()
	for _, cancel := range netCancels {
		cancel()
	}
	for _, w := range netWriters {
		w.Abort()
	}
	for _, ln := range netListeners {
		_ = ln.Close()
	}
	for _, c := range netConns {
		_ = c.Close()
	}

	var fds []*os.File
	en.fdsMu.Lock()
	for fd, f := range en.fds {
		fds = append(fds, f)
		delete(en.fds, fd)
	}
	en.fdsMu.Unlock()
	for _, f := range fds {
		_ = f.Close()
	}

	var wchans []*rtWorkerChannel
	en.workerChansMu.Lock()
	for id, wc := range en.workerChans {
		wchans = append(wchans, wc)
		delete(en.workerChans, id)
	}
	en.workerChansMu.Unlock()
	for _, wc := range wchans {
		if normalExit {
			wc.mu.Lock()
			wc.stopping = true
			if wc.notify != nil {
				select {
				case wc.notify <- struct{}{}:
				default:
				}
			}
			wc.mu.Unlock()
			if wc.writeDone != nil {
				select {
				case <-wc.writeDone:
				case <-time.After(200 * time.Millisecond):
				}
			}
		}
		wc.mu.Lock()
		wc.closed = true
		if wc.notify != nil {
			select {
			case wc.notify <- struct{}{}:
			default:
			}
		}
		if wc.ln != nil {
			_ = wc.ln.Close()
		}
		if wc.conn != nil {
			_ = wc.conn.Close()
		}
		wc.mu.Unlock()
	}

	en.stdinMu.Lock()
	en.stdinEOF = true
	if en.stdinNotify != nil {
		close(en.stdinNotify)
		en.stdinNotify = nil
	}
	stdinReader := en.stdin
	en.stdinMu.Unlock()
	if stdinReader != nil && stdinReader != os.Stdin {
		if d, ok := stdinReader.(interface{ SetReadDeadline(time.Time) error }); ok {
			_ = d.SetReadDeadline(time.Now())
		}
		if c, ok := stdinReader.(io.Closer); ok {
			_ = c.Close()
		}
	}
}

// RunScript executes a JavaScript program with the full Node.js/Web/Shell
// runtime in a fresh QuickJS VM, pumping its event loop until completion,
// process.exit(code), or ctx cancellation.
func RunScript(ctx context.Context, opts ScriptOptions) (int, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	cwd := opts.CWD
	if cwd == "" {
		var err error
		cwd, err = os.Getwd()
		if err != nil {
			cwd = "."
		}
	}
	if absCWD, err := filepath.Abs(cwd); err == nil {
		cwd = absCWD
	}

	execPath := opts.ExecPath
	if execPath == "" {
		if ep, err := os.Executable(); err == nil {
			execPath = ep
		} else {
			execPath = "indirect-code"
		}
	}

	filename := opts.Filename
	entryFile := filename
	isEvalEntry := false
	if filename == "" {
		filename = filepath.Join(cwd, "[eval].js")
		entryFile = filename
		isEvalEntry = true
	} else if filename == "-" {
		entryFile = filepath.Join(cwd, "[stdin].js")
		isEvalEntry = true
	} else if strings.HasPrefix(filename, "<") {
		entryFile = filepath.Join(cwd, "[exec_script].js")
		isEvalEntry = true
	} else if !filepath.IsAbs(filename) {
		filename = filepath.Join(cwd, filename)
		entryFile = filename
	}
	entryDir := filepath.Dir(entryFile)

	rawEnv := make(map[string]string)
	if opts.Env != nil {
		for k, v := range opts.Env {
			rawEnv[k] = v
		}
	} else {
		for _, kv := range os.Environ() {
			if idx := strings.IndexByte(kv, '='); idx > 0 {
				rawEnv[kv[:idx]] = kv[idx+1:]
			}
		}
	}

	jailRoots := opts.JailRoots
	if len(jailRoots) == 0 {
		if jr := rawEnv["__INDIRECT_JAIL_ROOTS"]; jr != "" {
			for _, part := range strings.Split(jr, string(os.PathListSeparator)) {
				if p := strings.TrimSpace(part); p != "" {
					jailRoots = append(jailRoots, p)
				}
			}
		}
	}

	readOnlyRoots := opts.ReadOnlyRoots
	if len(readOnlyRoots) == 0 {
		if ror := rawEnv["__INDIRECT_READONLY_ROOTS"]; ror != "" {
			for _, part := range strings.Split(ror, string(os.PathListSeparator)) {
				if p := strings.TrimSpace(part); p != "" {
					readOnlyRoots = append(readOnlyRoots, p)
				}
			}
		}
	}

	fsReadRoots := opts.FSReadRoots
	if len(fsReadRoots) == 0 {
		if fsr := rawEnv["__INDIRECT_FS_READ_ROOTS"]; fsr != "" {
			for _, part := range strings.Split(fsr, string(os.PathListSeparator)) {
				if p := strings.TrimSpace(part); p != "" {
					fsReadRoots = append(fsReadRoots, p)
				}
			}
		}
	}

	fsWriteRoots := opts.FSWriteRoots
	if len(fsWriteRoots) == 0 {
		if fsw := rawEnv["__INDIRECT_FS_WRITE_ROOTS"]; fsw != "" {
			for _, part := range strings.Split(fsw, string(os.PathListSeparator)) {
				if p := strings.TrimSpace(part); p != "" {
					fsWriteRoots = append(fsWriteRoots, p)
				}
			}
		}
	}

	netAllow := opts.NetAllow
	if len(netAllow) == 0 {
		if na := rawEnv["__INDIRECT_NET_ALLOW"]; na != "" {
			for _, part := range strings.Split(na, ",") {
				if p := strings.TrimSpace(part); p != "" {
					netAllow = append(netAllow, p)
				}
			}
		}
	}

	hasSandbox := len(jailRoots) > 0 || len(readOnlyRoots) > 0 || len(fsReadRoots) > 0 || len(fsWriteRoots) > 0 || len(netAllow) > 0
	envMap := make(map[string]string, len(rawEnv))
	for k, v := range rawEnv {
		if hasSandbox {
			if isBlockedJailedEnvKey(k) {
				continue
			}
			upper := strings.ToUpper(k)
			if upper == "HTTP_PROXY" || upper == "HTTPS_PROXY" || upper == "ALL_PROXY" {
				if u, perr := url.Parse(v); perr == nil && u.User != nil {
					u.User = nil
					v = u.String()
				}
			}
		}
		envMap[k] = v
	}

	argv := make([]string, 0, 2+len(opts.Args))
	if opts.OmitArgv1 {
		argv = append(argv, execPath)
	} else {
		argv = append(argv, execPath, filename)
	}
	argv = append(argv, opts.Args...)

	stdout := opts.Stdout
	if stdout == nil {
		stdout = io.Discard
	}
	stderr := opts.Stderr
	if stderr == nil {
		stderr = io.Discard
	}

	stdinCredits := make(chan struct{}, 16)
	for range 16 {
		stdinCredits <- struct{}{}
	}

	en := &rtEntry{
		parentCtx:        ctx,
		ctx:              runCtx,
		cancel:           cancel,
		startTime:        time.Now(),
		cwd:              cwd,
		env:              envMap,
		argv:             argv,
		execPath:         execPath,
		entryFile:        entryFile,
		entryDir:         entryDir,
		isEvalEntry:      isEvalEntry,
		shellPath:        opts.ShellPath,
		shellFlag:        opts.ShellFlag,
		jailRoots:        jailRoots,
		readOnlyRoots:    readOnlyRoots,
		fsReadRoots:      fsReadRoots,
		fsWriteRoots:     fsWriteRoots,
		netAllow:         netAllow,
		stdin:            opts.Stdin,
		stdinCredits:     stdinCredits,
		stdout:           stdout,
		stderr:           stderr,
		eventsWake:       make(chan struct{}, 1),
		eventsSpace:      make(chan struct{}, 1),
		fds:              make(map[int]*os.File),
		nextFD:           10,
		timers:           make(map[int32]*time.Timer),
		fetches:          make(map[int32]context.CancelFunc),
		fetchCredits:     make(map[int32]chan struct{}),
		fetchBodies:      make(map[int32]*asyncByteWriter),
		children:         make(map[int32]*rtChildProc),
		finishedChildren: make(map[int32]*rtChildProc),
		servers:          make(map[int32]*rtHTTPServer),
		netListeners:     make(map[int32]net.Listener),
		netConns:         make(map[int32]net.Conn),
		netWriters:       make(map[int32]*asyncByteWriter),
		netReadCredits:   make(map[int32]chan struct{}),
		netDialCancel:    make(map[int32]context.CancelFunc),
		netHalfClosed:    make(map[int32]bool),
		netRemoteEOF:     make(map[int32]bool),
		dgramSocks:       make(map[int32]*net.UDPConn),
		workerChans:      make(map[int32]*rtWorkerChannel),
	}
	stopCancel := context.AfterFunc(ctx, func() {
		en.abortBlockingIO()
	})
	defer stopCancel()

	handle := rtRegister(en)
	var rt *C.QjsRuntime
	defer func() {
		en.cleanup()
		rtUnregister(handle)
		if rt != nil {
			C.qjs_rt_free(rt)
		}
	}()

	cprelude := C.CString(runtimePreludeSource)
	defer C.free(unsafe.Pointer(cprelude))

	var cerr *C.char
	defer func() { _ = takeCString(&cerr, "") }()
	rt = C.qjs_rt_new(C.uintptr_t(handle), C.size_t(opts.MemoryLimit), cprelude, C.size_t(len(runtimePreludeSource)), &cerr)
	if rt == nil {
		msg := takeCString(&cerr, "could not initialize QuickJS runtime")
		return 1, errors.New(msg)
	}

	cfile := C.CString(filename)
	defer C.free(unsafe.Pointer(cfile))
	csrc := C.CString(opts.Code)
	defer C.free(unsafe.Pointer(csrc))

	isESM := -1
	lowerFile := strings.ToLower(filename)
	if strings.HasSuffix(lowerFile, ".mjs") {
		isESM = 1
	} else if strings.HasSuffix(lowerFile, ".cjs") {
		isESM = 0
	} else if opts.Filename != "" && opts.Filename != "-" && !strings.HasPrefix(opts.Filename, "[") && !strings.HasPrefix(opts.Filename, "<") {
		if en.nearestPackageType(entryDir) == "module" {
			isESM = 1
		}
	}

	rc := C.qjs_rt_eval(rt, cfile, csrc, C.size_t(len(opts.Code)), C.int(isESM), &cerr)
	if rc != 0 {
		if en.exited.Load() {
			_ = takeCString(&cerr, "")
			return int(en.exitCode.Load()), nil
		}
		if ctx.Err() != nil {
			_ = takeCString(&cerr, "")
			return 130, ctx.Err()
		}
		msg := takeCString(&cerr, "script evaluation failed")
		emitCrashExit(rt, en)
		_, _ = fmt.Fprintln(stderr, msg)
		return 1, errors.New(msg)
	}

	// Event loop: pump timers, async I/O, beforeExit, and exit handlers.
	for !en.exited.Load() {
		if ctx.Err() != nil {
			return 130, ctx.Err()
		}
		var hasActive C.int32_t
		if C.qjs_rt_check_loop(rt, 0, &hasActive, &cerr) != 0 {
			if en.exited.Load() {
				_ = takeCString(&cerr, "")
				return int(en.exitCode.Load()), nil
			}
			if ctx.Err() != nil {
				_ = takeCString(&cerr, "")
				return 130, ctx.Err()
			}
			msg := takeCString(&cerr, "event loop error")
			emitCrashExit(rt, en)
			_, _ = fmt.Fprintln(stderr, msg)
			return 1, errors.New(msg)
		}

		// Drain any already-queued events before blocking or checking beforeExit.
		drained := false
		for !en.exited.Load() {
			batch := en.popEvents()
			if len(batch) == 0 {
				break
			}
			drained = true
			for _, ev := range batch {
				if en.exited.Load() {
					break
				}
				if err := dispatchEvent(rt, en, ev, stderr); err != nil {
					if en.exited.Load() {
						return int(en.exitCode.Load()), nil
					}
					if ctx.Err() != nil {
						return 130, ctx.Err()
					}
					return 1, err
				}
			}
		}
		if en.exited.Load() {
			return int(en.exitCode.Load()), nil
		}
		if drained {
			continue
		}

		if hasActive == 0 {
			// Emit 'beforeExit' and see if new work was scheduled.
			var moreWork C.int32_t
			if C.qjs_rt_check_loop(rt, 1, &moreWork, &cerr) != 0 {
				if en.exited.Load() {
					_ = takeCString(&cerr, "")
					return int(en.exitCode.Load()), nil
				}
				if ctx.Err() != nil {
					_ = takeCString(&cerr, "")
					return 130, ctx.Err()
				}
				msg := takeCString(&cerr, "beforeExit error")
				emitCrashExit(rt, en)
				_, _ = fmt.Fprintln(stderr, msg)
				return 1, errors.New(msg)
			}
			if en.exited.Load() {
				return int(en.exitCode.Load()), nil
			}
			if moreWork > 0 || en.hasQueuedEvents() {
				continue
			}
			// Emit 'exit' and read final process.exitCode.
			var finalCode C.int32_t
			if C.qjs_rt_check_loop(rt, 2, &finalCode, &cerr) != 0 {
				if en.exited.Load() {
					_ = takeCString(&cerr, "")
					return int(en.exitCode.Load()), nil
				}
				if ctx.Err() != nil {
					_ = takeCString(&cerr, "")
					return 130, ctx.Err()
				}
				msg := takeCString(&cerr, "exit handler error")
				_, _ = fmt.Fprintln(stderr, msg)
				return 1, errors.New(msg)
			}
			if en.exited.Load() {
				return int(en.exitCode.Load()), nil
			}
			return int(finalCode), nil
		}

		// Wait for next async event or cancellation.
		if !en.hasQueuedEvents() {
			select {
			case <-en.eventsWake:
			case <-ctx.Done():
				return 130, ctx.Err()
			}
		}
	}

	return int(en.exitCode.Load()), nil
}

func emitCrashExit(rt *C.QjsRuntime, en *rtEntry) {
	if en.exited.Load() || en.ctx.Err() != nil {
		return
	}
	en.exitCode.Store(1)
	var finalCode C.int32_t
	var cerr *C.char
	_ = C.qjs_rt_check_loop(rt, 2, &finalCode, &cerr)
	_ = takeCString(&cerr, "")
}

func dispatchEvent(rt *C.QjsRuntime, en *rtEntry, ev rtAsyncEvent, stderr io.Writer) error {
	var cjson *C.char
	if ev.json != "" {
		cjson = C.CString(ev.json)
		defer C.free(unsafe.Pointer(cjson))
	}
	var cbin *C.uint8_t
	if len(ev.bin) > 0 {
		cbin = (*C.uint8_t)(unsafe.Pointer(&ev.bin[0]))
	}
	var cerr *C.char
	defer func() { _ = takeCString(&cerr, "") }()
	rc := C.qjs_rt_dispatch(rt, C.int32_t(ev.id), C.int32_t(ev.kind), cjson, C.size_t(len(ev.json)), cbin, C.size_t(len(ev.bin)), &cerr)
	if rc != 0 {
		if en.exited.Load() {
			_ = takeCString(&cerr, "")
			return nil
		}
		if en.ctx.Err() != nil {
			_ = takeCString(&cerr, "")
			return en.ctx.Err()
		}
		msg := takeCString(&cerr, "async callback failed")
		emitCrashExit(rt, en)
		_, _ = fmt.Fprintln(stderr, msg)
		return errors.New(msg)
	}
	return nil
}

//export guQjsRtInterrupt
func guQjsRtInterrupt(handle C.uintptr_t) C.int {
	en := rtLookup(uintptr(handle))
	if en == nil {
		return 0
	}
	if en.exited.Load() || en.ctx.Err() != nil {
		return 1
	}
	if dl := en.vmDeadlineNano.Load(); dl > 0 && time.Now().UnixNano() >= dl {
		en.vmDeadlineNano.Store(0)
		return 1
	}
	return 0
}

//export guQjsRtExit
func guQjsRtExit(handle C.uintptr_t, code C.int) {
	en := rtLookup(uintptr(handle))
	if en == nil {
		return
	}
	en.exitCode.Store(int32(code))
	en.exited.Store(true)
	en.wakeEvents()
}

//export guQjsRtWrite
func guQjsRtWrite(handle C.uintptr_t, fd C.int, buf *C.uint8_t, length C.size_t) C.int {
	en := rtLookup(uintptr(handle))
	if en == nil || length == 0 || buf == nil {
		return 0
	}
	data := C.GoBytes(unsafe.Pointer(buf), C.int(length))
	en.writeMu.Lock()
	defer en.writeMu.Unlock()
	if fd == 2 {
		_, _ = en.stderr.Write(data)
	} else {
		_, _ = en.stdout.Write(data)
	}
	return C.int(length)
}

//export guQjsRtHostCall
func guQjsRtHostCall(
	handle C.uintptr_t,
	op *C.char,
	argsJSON *C.char,
	argsLen C.size_t,
	inBin *C.uint8_t,
	inBinLen C.size_t,
	outJSON **C.char,
	outJSONLen *C.size_t,
	outBin **C.uint8_t,
	outBinLen *C.size_t,
	hasBin *C.int,
	outErr **C.char,
) C.int {
	en := rtLookup(uintptr(handle))
	if en == nil {
		*outErr = C.CString("runtime is closed")
		return 1
	}
	opName := C.GoString(op)
	var argsStr string
	if argsJSON != nil && argsLen > 0 {
		argsStr = C.GoStringN(argsJSON, C.int(argsLen))
	}
	var binSlice []byte
	if inBin != nil && inBinLen > 0 {
		binSlice = C.GoBytes(unsafe.Pointer(inBin), C.int(inBinLen))
	}

	resJSON, resBin, returnBin, errCode, err := en.handleHostCall(opName, argsStr, binSlice)
	if err != nil {
		*outErr = C.CString(err.Error())
		if errCode != "" {
			*outJSON = C.CString(errCode)
			*outJSONLen = C.size_t(len(errCode))
		}
		return 1
	}
	if resJSON != "" {
		*outJSON = C.CString(resJSON)
		*outJSONLen = C.size_t(len(resJSON))
	}
	if returnBin {
		if len(resBin) > 0 {
			ptr := C.malloc(C.size_t(len(resBin)))
			if ptr == nil {
				if *outJSON != nil {
					C.free(unsafe.Pointer(*outJSON))
					*outJSON = nil
					*outJSONLen = 0
				}
				*outErr = C.CString("RangeError: out of memory")
				return 1
			}
			C.memcpy(ptr, unsafe.Pointer(&resBin[0]), C.size_t(len(resBin)))
			*outBin = (*C.uint8_t)(ptr)
			*outBinLen = C.size_t(len(resBin))
		}
		*hasBin = 1
	}
	return 0
}

//export guQjsRtModuleNormalize
func guQjsRtModuleNormalize(handle C.uintptr_t, baseName *C.char, moduleName *C.char, outResolved **C.char, outErr **C.char) C.int {
	en := rtLookup(uintptr(handle))
	if en == nil {
		*outErr = C.CString("runtime is closed")
		return 1
	}
	base := C.GoString(baseName)
	spec := C.GoString(moduleName)
	resolved, err := en.normalizeModule(base, spec)
	if err != nil {
		*outErr = C.CString(err.Error())
		return 1
	}
	*outResolved = C.CString(resolved)
	return 0
}

//export guQjsRtModuleLoad
func guQjsRtModuleLoad(
	handle C.uintptr_t,
	moduleName *C.char,
	outSrc **C.char,
	outSrcLen *C.size_t,
	outFileURL **C.char,
	outFilename **C.char,
	outDirname **C.char,
	outErr **C.char,
) C.int {
	en := rtLookup(uintptr(handle))
	if en == nil {
		*outErr = C.CString("runtime is closed")
		return 1
	}
	spec := C.GoString(moduleName)
	if spec == "__main_meta__" {
		u := pathToFileURLString(en.entryFile)
		*outFileURL = C.CString(u)
		*outFilename = C.CString(en.entryFile)
		*outDirname = C.CString(en.entryDir)
		return 0
	}
	src, fileURL, filename, dirname, err := en.loadModule(spec)
	if err != nil {
		*outErr = C.CString(err.Error())
		return 1
	}
	*outSrc = C.CString(src)
	if outSrcLen != nil {
		*outSrcLen = C.size_t(len(src))
	}
	if fileURL != "" {
		*outFileURL = C.CString(fileURL)
	}
	if filename != "" {
		*outFilename = C.CString(filename)
	}
	if dirname != "" {
		*outDirname = C.CString(dirname)
	}
	return 0
}

// Built-in module export manifests for ES module re-exports.
var builtinModuleExports = map[string][]string{
	"fs": {
		"F_OK", "R_OK", "W_OK", "X_OK", "ReadStream", "WriteStream",
		"access", "accessSync", "appendFile", "appendFileSync", "chmod", "chmodSync",
		"chown", "chownSync", "close", "closeSync", "constants", "copyFile", "copyFileSync",
		"cp", "cpSync", "createReadStream", "createWriteStream", "Dir", "Dirent", "exists", "existsSync",
		"fchmod", "fchmodSync", "fchown", "fchownSync", "fdatasync", "fdatasyncSync",
		"fstat", "fstatSync", "fsync", "fsyncSync", "ftruncate", "ftruncateSync",
		"futimes", "futimesSync", "glob", "globSync", "lchmod", "lchmodSync", "lchown", "lchownSync",
		"link", "linkSync", "lstat", "lstatSync", "lutimes", "lutimesSync", "mkdir", "mkdirSync",
		"mkdtemp", "mkdtempSync", "open", "openAsBlob", "openSync", "opendir", "opendirSync",
		"promises", "read", "readSync", "readv", "readvSync",
		"readdir", "readdirSync", "readFile", "readFileSync", "readlink", "readlinkSync",
		"realpath", "realpathSync", "rename", "renameSync", "rm", "rmSync", "rmdir", "rmdirSync",
		"stat", "statSync", "statfs", "statfsSync", "Stats", "symlink", "symlinkSync",
		"truncate", "truncateSync", "unlink", "unlinkSync", "utimes", "utimesSync",
		"watch", "watchFile", "unwatchFile", "write", "writeSync", "writeFile", "writeFileSync",
		"writev", "writevSync",
	},
	"fs/promises": {
		"access", "appendFile", "chmod", "chown", "constants", "copyFile", "cp",
		"glob", "lchmod", "lchown", "link", "lstat", "lutimes", "mkdir", "mkdtemp", "open", "opendir",
		"readdir", "readFile", "readlink", "realpath", "rename", "rm", "rmdir", "stat", "statfs",
		"symlink", "truncate", "unlink", "utimes", "watch", "writeFile",
	},
	"path": {
		"basename", "delimiter", "dirname", "extname", "format", "isAbsolute",
		"join", "matchesGlob", "normalize", "parse", "posix", "relative", "resolve", "sep",
		"toNamespacedPath", "win32",
	},
	"path/posix": {
		"basename", "delimiter", "dirname", "extname", "format", "isAbsolute",
		"join", "matchesGlob", "normalize", "parse", "posix", "relative", "resolve", "sep",
		"toNamespacedPath", "win32",
	},
	"path/win32": {
		"basename", "delimiter", "dirname", "extname", "format", "isAbsolute",
		"join", "matchesGlob", "normalize", "parse", "posix", "relative", "resolve", "sep",
		"toNamespacedPath", "win32",
	},
	"os": {
		"EOL", "arch", "availableParallelism", "constants", "cpus", "devNull",
		"endianness", "freemem", "getPriority", "homedir", "hostname", "loadavg",
		"machine", "networkInterfaces", "platform", "release", "setPriority",
		"tmpdir", "totalmem", "type", "uptime", "userInfo", "version",
	},
	"child_process": {
		"ChildProcess", "exec", "execFile", "execFileSync", "execSync",
		"fork", "spawn", "spawnSync",
	},
	"crypto": {
		"Certificate", "Cipher", "Cipheriv", "CryptoKey", "Decipher", "Decipheriv",
		"DiffieHellman", "DiffieHellmanGroup", "ECDH", "Hash", "Hmac",
		"KeyObject", "Sign", "Verify", "X509Certificate",
		"checkPrime", "checkPrimeSync", "constants", "createCipheriv", "createDecipheriv",
		"createDiffieHellman", "createDiffieHellmanGroup", "createECDH", "createHash", "createHmac",
		"createPrivateKey", "createPublicKey", "createSecretKey",
		"createSign", "createVerify", "diffieHellman", "generateKey", "generateKeyPair",
		"generateKeyPairSync", "generateKeySync", "generatePrime", "generatePrimeSync",
		"getCipherInfo", "getCiphers", "getCurves", "getDiffieHellman", "getFips", "getHashes", "getRandomValues",
		"hash", "hkdf", "hkdfSync", "pbkdf2", "pbkdf2Sync", "privateDecrypt", "privateEncrypt",
		"publicDecrypt", "publicEncrypt", "randomBytes", "randomFill", "randomFillSync",
		"randomInt", "randomUUID", "scrypt", "scryptSync", "secureHeapUsed", "setEngine", "setFips",
		"sign", "subtle", "timingSafeEqual", "verify", "webcrypto",
	},
	"zlib": {
		"BrotliCompress", "BrotliDecompress", "Deflate", "DeflateRaw", "Gunzip", "Gzip",
		"Inflate", "InflateRaw", "Unzip", "ZstdCompress", "ZstdDecompress",
		"brotliCompress", "brotliCompressSync", "brotliDecompress", "brotliDecompressSync",
		"constants", "crc32", "createBrotliCompress", "createBrotliDecompress",
		"createDeflate", "createDeflateRaw", "createGunzip", "createGzip",
		"createInflate", "createInflateRaw", "createUnzip", "createZstdCompress", "createZstdDecompress",
		"deflate", "deflateRaw", "deflateRawSync", "deflateSync", "gunzip", "gunzipSync", "gzip", "gzipSync",
		"inflate", "inflateRaw", "inflateRawSync", "inflateSync", "unzip", "unzipSync",
		"zstdCompress", "zstdCompressSync", "zstdDecompress", "zstdDecompressSync",
	},
	"http": {
		"Agent", "ClientRequest", "IncomingMessage", "METHODS", "OutgoingMessage", "STATUS_CODES",
		"Server", "ServerResponse", "createServer", "get", "globalAgent", "maxHeaderSize",
		"request", "validateHeaderName", "validateHeaderValue",
	},
	"https": {
		"Agent", "ClientRequest", "Server", "createServer", "get", "globalAgent", "request",
	},
	"net": {
		"BlockList", "Server", "Socket", "SocketAddress", "connect", "createConnection", "createServer",
		"isIP", "isIPv4", "isIPv6",
	},
	"dns": {
		"ADDRCONFIG", "ALL", "NODATA", "NONAME", "NOTFOUND", "REFUSED", "SERVFAIL", "V4MAPPED",
		"Resolver", "getDefaultResultOrder", "getServers", "lookup", "lookupService", "promises",
		"resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname",
		"resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt",
		"reverse", "setDefaultResultOrder", "setServers",
	},
	"dns/promises": {
		"Resolver", "getDefaultResultOrder", "getServers", "lookup", "lookupService",
		"resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname",
		"resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt",
		"reverse", "setDefaultResultOrder", "setServers",
	},
	"util": {
		"MIMEParams", "MIMEType", "TextDecoder", "TextEncoder", "callbackify", "debuglog", "deprecate",
		"format", "formatWithOptions", "getCallSites", "getSystemErrorMap", "getSystemErrorMessage", "getSystemErrorName",
		"inherits", "inspect", "isArray", "isBoolean", "isBuffer", "isDate", "isDeepStrictEqual",
		"isError", "isFunction", "isNull", "isNullOrUndefined", "isNumber", "isObject", "isPrimitive",
		"isRegExp", "isString", "isSymbol", "isUndefined", "log",
		"parseArgs", "parseEnv", "promisify", "stripVTControlCharacters", "styleText",
		"toUSVString", "transferableAbortController", "transferableAbortSignal", "types",
	},
	"sys": {
		"MIMEParams", "MIMEType", "TextDecoder", "TextEncoder", "callbackify", "debuglog", "deprecate",
		"format", "formatWithOptions", "getCallSites", "getSystemErrorMap", "getSystemErrorMessage", "getSystemErrorName",
		"inherits", "inspect", "isArray", "isBoolean", "isBuffer", "isDate", "isDeepStrictEqual",
		"isError", "isFunction", "isNull", "isNullOrUndefined", "isNumber", "isObject", "isPrimitive",
		"isRegExp", "isString", "isSymbol", "isUndefined", "log",
		"parseArgs", "parseEnv", "promisify", "stripVTControlCharacters", "styleText",
		"toUSVString", "transferableAbortController", "transferableAbortSignal", "types",
	},
	"util/types": {
		"isAnyArrayBuffer", "isArrayBuffer", "isAsyncFunction", "isBigIntObject", "isBoxedPrimitive",
		"isDataView", "isDate", "isGeneratorFunction", "isMap", "isNativeError",
		"isPromise", "isProxy", "isRegExp", "isSet", "isTypedArray", "isUint8Array",
		"isWeakMap", "isWeakSet",
	},
	"events": {
		"CustomEvent", "Event", "EventEmitter", "EventTarget", "addAbortListener",
		"captureRejectionSymbol", "captureRejections", "defaultMaxListeners", "errorMonitor",
		"getEventListeners", "getMaxListeners", "listenerCount", "on", "once", "setMaxListeners",
	},
	"assert": {
		"AssertionError", "deepEqual", "deepStrictEqual", "doesNotMatch",
		"doesNotReject", "doesNotThrow", "equal", "fail", "ifError", "match",
		"notDeepEqual", "notDeepStrictEqual", "notEqual", "notStrictEqual",
		"ok", "partialDeepStrictEqual", "rejects", "strict", "strictEqual", "throws",
	},
	"assert/strict": {
		"AssertionError", "deepEqual", "deepStrictEqual", "doesNotMatch",
		"doesNotReject", "doesNotThrow", "equal", "fail", "ifError", "match",
		"notDeepEqual", "notDeepStrictEqual", "notEqual", "notStrictEqual",
		"ok", "partialDeepStrictEqual", "rejects", "strict", "strictEqual", "throws",
	},
	"url": {
		"URL", "URLSearchParams", "domainToASCII", "domainToUnicode",
		"fileURLToPath", "format", "parse", "pathToFileURL", "resolve",
	},
	"querystring": {
		"decode", "encode", "escape", "parse", "stringify", "unescape", "unescapeBuffer",
	},
	"buffer": {
		"Blob", "Buffer", "File", "SlowBuffer", "atob", "btoa", "constants",
		"isAscii", "isUtf8", "kMaxLength", "transcode",
	},
	"string_decoder": {
		"StringDecoder",
	},
	"stream": {
		"Duplex", "PassThrough", "Readable", "Stream", "Transform", "Writable",
		"addAbortSignal", "compose", "duplexPair", "finished", "getDefaultHighWaterMark",
		"isDisturbed", "isErrored", "isReadable", "isWritable", "pipeline", "promises",
		"setDefaultHighWaterMark", "web",
	},
	"stream/promises": {
		"finished", "pipeline",
	},
	"stream/consumers": {
		"arrayBuffer", "blob", "buffer", "json", "text",
	},
	"stream/web": {
		"ByteLengthQueuingStrategy", "CompressionStream", "CountQueuingStrategy",
		"DecompressionStream", "ReadableByteStreamController", "ReadableStream",
		"ReadableStreamBYOBReader", "ReadableStreamBYOBRequest",
		"ReadableStreamDefaultController", "ReadableStreamDefaultReader",
		"TextDecoderStream", "TextEncoderStream", "TransformStream",
		"TransformStreamDefaultController", "WritableStream",
		"WritableStreamDefaultController", "WritableStreamDefaultWriter",
	},
	"timers": {
		"clearImmediate", "clearInterval", "clearTimeout", "promises",
		"setImmediate", "setInterval", "setTimeout",
	},
	"timers/promises": {
		"scheduler", "setImmediate", "setInterval", "setTimeout",
	},
	"perf_hooks": {
		"Performance", "PerformanceEntry", "PerformanceMark", "PerformanceMeasure",
		"PerformanceObserver", "constants", "performance",
	},
	"module": {
		"Module", "_resolveFilename", "builtinModules", "createRequire", "isBuiltin",
	},
	"process": {
		"abort", "allowedNodeEnvironmentFlags", "arch", "argv", "argv0", "chdir",
		"cpuUsage", "cwd", "debugPort", "emit", "emitWarning",
		"env", "execArgv", "execPath", "exit", "exitCode", "features", "getActiveResourcesInfo",
		"getBuiltinModule", "hasUncaughtExceptionCaptureCallback", "hrtime", "kill",
		"listenerCount", "listeners", "loadEnvFile", "memoryUsage", "nextTick", "off", "on", "once",
		"pid", "platform", "ppid", "reallyExit", "ref", "release", "removeAllListeners", "removeListener",
		"report", "resourceUsage", "setSourceMapsEnabled", "setUncaughtExceptionCaptureCallback",
		"stderr", "stdin", "stdout", "title", "umask", "unref", "uptime", "version", "versions",
	},
	"console": {
		"Console", "assert", "clear", "count", "countReset", "debug", "dir",
		"error", "group", "groupCollapsed", "groupEnd", "info", "log", "table",
		"time", "timeEnd", "timeLog", "trace", "warn",
	},
	"tty": {
		"ReadStream", "WriteStream", "isatty",
	},
	"constants": {
		"COPYFILE_EXCL", "F_OK", "O_APPEND", "O_CREAT", "O_EXCL", "O_RDONLY",
		"O_RDWR", "O_TRUNC", "O_WRONLY", "R_OK", "W_OK", "X_OK",
	},
	"async_hooks": {
		"AsyncLocalStorage", "AsyncResource", "createHook", "executionAsyncId", "triggerAsyncId",
	},
	"worker_threads": {
		"BroadcastChannel", "MessageChannel", "MessagePort", "SHARE_ENV", "Worker",
		"getEnvironmentData", "isMainThread", "markAsUncloneable", "markAsUntransferable",
		"moveMessagePortToContext", "parentPort", "postMessageToThread", "receiveMessageOnPort",
		"resourceLimits", "setEnvironmentData", "threadId", "workerData",
	},
	"v8": {
		"deserialize", "getHeapSpaceStatistics", "getHeapStatistics", "serialize",
	},
	"vm": {
		"Script", "compileFunction", "constants", "createContext", "isContext",
		"measureMemory", "runInContext", "runInNewContext", "runInThisContext",
	},
	"test": {
		"after", "afterEach", "before", "beforeEach", "describe", "it",
		"mock", "skip", "suite", "test", "todo",
	},
	"inspector": {
		"Session", "close", "open", "url", "waitForDebugger",
	},
	"readline": {
		"Interface", "clearLine", "clearScreenDown", "createInterface",
		"cursorTo", "emitKeypressEvents", "moveCursor", "promises",
	},
	"readline/promises": {
		"Interface", "Readline", "createInterface",
	},
	"tls": {
		"CLIENT_RENEG_LIMIT", "CLIENT_RENEG_WINDOW", "DEFAULT_CIPHERS",
		"DEFAULT_ECDH_CURVE", "DEFAULT_MAX_VERSION", "DEFAULT_MIN_VERSION",
		"Server", "TLSSocket", "checkServerIdentity", "connect",
		"createSecureContext", "createSecurePair", "createServer",
		"getCiphers", "rootCertificates",
	},
	"http2": {
		"Http2ServerRequest", "Http2ServerResponse", "connect", "constants",
		"createSecureServer", "createServer", "getDefaultSettings",
		"getPackedSettings", "getUnpackedSettings", "performServerHandshake",
		"sensitiveHeaders",
	},
	"cluster": {
		"SCHED_NONE", "SCHED_RR", "Worker", "disconnect", "fork",
		"isMaster", "isPrimary", "isWorker", "schedulingPolicy",
		"settings", "setupMaster", "setupPrimary", "worker", "workers",
	},
	"dgram": {
		"Socket", "createSocket",
	},
	"diagnostics_channel": {
		"Channel", "channel", "hasSubscribers", "subscribe", "tracingChannel", "unsubscribe",
	},
	"punycode": {
		"decode", "encode", "toASCII", "toUnicode", "ucs2", "version",
	},
	"sh": {
		"$", "ShellError", "ShellOutput", "ShellPromise", "quote",
	},
}

func canonicalBuiltinName(spec string) (string, bool) {
	if spec == "indirect:sh" {
		return "sh", true
	}
	trimmed := strings.TrimPrefix(spec, "node:")
	if _, ok := builtinModuleExports[trimmed]; ok {
		return trimmed, true
	}
	return "", false
}

func (en *rtEntry) normalizeModule(baseName, moduleName string) (string, error) {
	if canon, ok := canonicalBuiltinName(moduleName); ok {
		return "node:" + canon, nil
	}
	if strings.HasPrefix(moduleName, "node:") {
		return "", fmt.Errorf("ERR_UNKNOWN_BUILTIN_MODULE: unknown built-in module %q", moduleName)
	}
	baseDir := en.getCWD()
	baseFile := filepath.Base(baseName)
	if baseName != "" && baseName != "-" && !strings.HasPrefix(baseName, "node:") && !strings.HasPrefix(baseName, "<") && !strings.HasPrefix(baseFile, "[") && !strings.HasPrefix(baseFile, "<") {
		baseDir = filepath.Dir(baseName)
	}
	return en.resolveModulePath(baseDir, moduleName)
}

const maxModuleSourceBytes = 16 << 20

func stripUTF8BOM(b []byte) []byte {
	if len(b) >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF {
		return b[3:]
	}
	return b
}

func (en *rtEntry) loadModule(spec string) (src, fileURL, filename, dirname string, err error) {
	if strings.HasPrefix(spec, "node:") {
		canon := strings.TrimPrefix(spec, "node:")
		exports, ok := builtinModuleExports[canon]
		if !ok {
			return "", "", "", "", fmt.Errorf("ERR_UNKNOWN_BUILTIN_MODULE: unknown built-in module %q", spec)
		}
		var sb strings.Builder
		fmt.Fprintf(&sb, "const __qjs_mod__ = import.meta.__require(%q);\nexport default __qjs_mod__;\n", "node:"+canon)
		for idx, k := range exports {
			name := strings.TrimSpace(k)
			if name == "" || name == "default" {
				continue
			}
			fmt.Fprintf(&sb, "const __qjs_e%d__ = __qjs_mod__[%q];\nexport { __qjs_e%d__ as %s };\n", idx, name, idx, name)
		}
		return sb.String(), spec, spec, "", nil
	}

	if jerr := en.checkPath(spec); jerr != nil {
		return "", "", "", "", jerr
	}

	raw, err := readFileBounded(spec, maxModuleSourceBytes)
	if err != nil {
		return "", "", "", "", err
	}
	raw = stripUTF8BOM(raw)
	fileURL = pathToFileURLString(spec)
	filename = spec
	dirname = filepath.Dir(spec)

	if strings.HasSuffix(strings.ToLower(spec), ".json") {
		content := strings.TrimSpace(string(raw))
		if content == "" {
			content = "null"
		}
		quoted, _ := json.Marshal(content)
		return "export default JSON.parse(" + string(quoted) + ");\n", fileURL, filename, dirname, nil
	}

	code := string(raw)
	lowerSpec := strings.ToLower(spec)
	if strings.HasSuffix(lowerSpec, ".cjs") || (!strings.HasSuffix(lowerSpec, ".mjs") && en.looksLikeCJS(spec, code)) {
		return en.synthesizeCJSWrapper(spec, code), fileURL, filename, dirname, nil
	}

	return code, fileURL, filename, dirname, nil
}

var (
	reESMKeyword      = regexp.MustCompile(`(?m)(?:^|[;{}])[\t ]*(?:import(?:[\t ]+[\w\*\{\"']|[\t ]*[\(\{\"'])|export(?:[\t ]+(?:default|const|let|var|function|class|async)\b|[\t ]*[\{\*]))`)
	reCJSAssign       = regexp.MustCompile(`\b(?:module\.exports|exports\.[a-zA-Z_$][\w$]*)\s*=`)
	reCJSExportsProp  = regexp.MustCompile(`(?:module\.exports|exports)\.([a-zA-Z_$][a-zA-Z0-9_$]*)`)
	reCJSBracketProp  = regexp.MustCompile(`(?:module\.exports|exports)\[\s*['"]([a-zA-Z_$][a-zA-Z0-9_$]*)['"]\s*\]`)
	reCJSDefineProp   = regexp.MustCompile(`Object\.defineProperty\(\s*(?:module\.exports|exports)\s*,\s*['"]([a-zA-Z_$][a-zA-Z0-9_$]*)['"]`)
	reCJSReexport     = regexp.MustCompile(`(?:module\.exports\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)|Object\.assign\(\s*(?:module\.)?exports\s*,\s*require\(\s*['"]([^'"]+)['"]\s*\))`)
	reCJSObjStart     = regexp.MustCompile(`module\.exports\s*=\s*\{`)
	reObjKey          = regexp.MustCompile(`(?m)(?:^|[,{])\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?::|,|\(|\}|$)`)
	reIdent           = regexp.MustCompile(`^[a-zA-Z_$][a-zA-Z0-9_$]*$`)
)

func stripJSCommentsAndLiterals(src string) string {
	b := []byte(src)
	n := len(b)
	i := 0
	for i < n {
		c := b[i]
		if c == '/' && i+1 < n && b[i+1] == '/' {
			b[i] = ' '
			b[i+1] = ' '
			i += 2
			for i < n && b[i] != '\n' {
				if b[i] != '\r' {
					b[i] = ' '
				}
				i++
			}
			continue
		}
		if c == '/' && i+1 < n && b[i+1] == '*' {
			b[i] = ' '
			b[i+1] = ' '
			i += 2
			for i < n {
				if b[i] == '*' && i+1 < n && b[i+1] == '/' {
					b[i] = ' '
					b[i+1] = ' '
					i += 2
					break
				}
				if b[i] != '\n' && b[i] != '\r' {
					b[i] = ' '
				}
				i++
			}
			continue
		}
		if c == '\'' || c == '"' || c == '`' {
			quote := c
			b[i] = ' '
			i++
			for i < n {
				if b[i] == '\\' && i+1 < n {
					if b[i] != '\n' && b[i] != '\r' {
						b[i] = ' '
					}
					if b[i+1] != '\n' && b[i+1] != '\r' {
						b[i+1] = ' '
					}
					i += 2
					continue
				}
				if b[i] == quote {
					b[i] = ' '
					i++
					break
				}
				if b[i] != '\n' && b[i] != '\r' {
					b[i] = ' '
				}
				i++
			}
			continue
		}
		i++
	}
	return string(b)
}

func (en *rtEntry) nearestPackageType(dir string) string {
	cur := dir
	cwdClean := filepath.Clean(en.cwd)
	for {
		if en.checkPath(cur) != nil {
			break
		}
		pkgPath := filepath.Join(cur, "package.json")
		if en.checkPath(pkgPath) == nil {
			if raw, err := readFileBounded(pkgPath, 4<<20); err == nil {
				raw = stripUTF8BOM(raw)
				var pkg struct {
					Type string `json:"type"`
				}
				if json.Unmarshal(raw, &pkg) == nil && pkg.Type != "" {
					return pkg.Type
				}
				return "untyped"
			}
		}
		if filepath.Clean(cur) == cwdClean {
			break
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			break
		}
		cur = parent
	}
	return ""
}

func (en *rtEntry) looksLikeCJS(spec, code string) bool {
	stripped := stripJSCommentsAndLiterals(code)
	if reCJSAssign.MatchString(stripped) {
		return true
	}
	if reESMKeyword.MatchString(stripped) || strings.Contains(stripped, "import.meta") {
		return false
	}
	if strings.HasSuffix(strings.ToLower(spec), ".js") && en.nearestPackageType(filepath.Dir(spec)) == "module" {
		return false
	}
	return true
}

func extractCJSObjectKeys(code string) []string {
	stripped := stripJSCommentsAndLiterals(code)
	var keys []string
	locs := reCJSObjStart.FindAllStringIndex(stripped, -1)
	for _, loc := range locs {
		braceStart := loc[1] - 1
		depth := 0
		end := -1
		for i := braceStart; i < len(stripped); i++ {
			switch stripped[i] {
			case '{':
				depth++
			case '}':
				depth--
				if depth == 0 {
					end = i
					break
				}
			}
			if end != -1 {
				break
			}
		}
		if end > braceStart && end < len(code) {
			body := stripped[braceStart : end+1]
			for _, m := range reObjKey.FindAllStringSubmatch(body, -1) {
				if m[1] != "" {
					keys = append(keys, m[1])
				}
			}
		}
	}
	return keys
}

func (en *rtEntry) collectCJSExportNames(filename, code string, names map[string]bool, depth int) {
	if depth > 8 {
		return
	}
	for _, m := range reCJSExportsProp.FindAllStringSubmatch(code, -1) {
		if m[1] != "" && m[1] != "default" && reIdent.MatchString(m[1]) {
			names[m[1]] = true
		}
	}
	for _, m := range reCJSBracketProp.FindAllStringSubmatch(code, -1) {
		if m[1] != "" && m[1] != "default" && reIdent.MatchString(m[1]) {
			names[m[1]] = true
		}
	}
	for _, m := range reCJSDefineProp.FindAllStringSubmatch(code, -1) {
		if m[1] != "" && m[1] != "default" && reIdent.MatchString(m[1]) {
			names[m[1]] = true
		}
	}
	for _, k := range extractCJSObjectKeys(code) {
		if k != "" && k != "default" && reIdent.MatchString(k) {
			names[k] = true
		}
	}
	if en != nil {
		baseDir := filepath.Dir(filename)
		for _, m := range reCJSReexport.FindAllStringSubmatch(code, -1) {
			reqSpec := m[1]
			if reqSpec == "" {
				reqSpec = m[2]
			}
			if reqSpec == "" {
				continue
			}
			if canon, ok := canonicalBuiltinName(reqSpec); ok {
				for _, exp := range builtinModuleExports[canon] {
					if exp != "" && exp != "default" && reIdent.MatchString(exp) {
						names[exp] = true
					}
				}
				continue
			}
			targetPath, err := en.resolveModulePathEx(baseDir, reqSpec, true)
			if err != nil || en.checkPath(targetPath) != nil {
				continue
			}
			subRaw, rerr := readFileBounded(targetPath, maxModuleSourceBytes)
			if rerr != nil {
				continue
			}
			en.collectCJSExportNames(targetPath, string(stripUTF8BOM(subRaw)), names, depth+1)
		}
	}
}

func (en *rtEntry) synthesizeCJSWrapper(filename, code string) string {
	names := map[string]bool{}
	en.collectCJSExportNames(filename, code, names, 0)
	sorted := make([]string, 0, len(names))
	for k := range names {
		sorted = append(sorted, k)
	}
	sort.Strings(sorted)

	qPath, _ := json.Marshal(filename)
	var sb strings.Builder
	fmt.Fprintf(&sb, "const __qjs_cjs_mod__ = import.meta.__require(%s, %s);\nexport default __qjs_cjs_mod__;\n", string(qPath), string(qPath))
	for idx, k := range sorted {
		if !isJSReservedWord(k) && k != "eval" && k != "arguments" {
			fmt.Fprintf(&sb, "const __qjs_e%d__ = __qjs_cjs_mod__ && __qjs_cjs_mod__[%q];\nexport { __qjs_e%d__ as %s };\n", idx, k, idx, k)
		}
	}
	return sb.String()
}

func isJSReservedWord(w string) bool {
	switch w {
	case "break", "case", "catch", "class", "const", "continue", "debugger", "default",
		"delete", "do", "else", "enum", "export", "extends", "false", "finally", "for",
		"function", "if", "import", "in", "instanceof", "new", "null", "return", "super",
		"switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with",
		"yield", "let", "static", "implements", "interface", "package", "private",
		"protected", "public", "await":
		return true
	}
	return false
}

func (en *rtEntry) resolveModulePath(baseDir, spec string) (string, error) {
	return en.resolveModulePathEx(baseDir, spec, false)
}

func (en *rtEntry) resolveModulePathEx(baseDir, spec string, isCJS bool) (string, error) {
	if strings.HasPrefix(spec, "file://") {
		if u, err := url.Parse(spec); err == nil {
			p := filepath.FromSlash(u.Path)
			if u.Host != "" && !strings.EqualFold(u.Host, "localhost") {
				if runtime.GOOS == "windows" {
					p = `\\` + u.Host + p
				} else {
					return "", fmt.Errorf("ERR_INVALID_FILE_URL_HOST: File URL host must be \"localhost\" or empty on %s", runtime.GOOS)
				}
			} else if runtime.GOOS == "windows" && len(p) >= 3 && p[0] == '\\' && p[2] == ':' {
				p = p[1:]
			}
			spec = p
		}
	}

	if strings.HasPrefix(spec, "#") {
		if spec == "#" || strings.HasPrefix(spec, "#/") {
			return "", fmt.Errorf("ERR_INVALID_MODULE_SPECIFIER: Invalid module %q is not a valid package imports specifier", spec)
		}
		cur := baseDir
		for {
			if en.checkPath(cur) != nil {
				break
			}
			pkgPath := filepath.Join(cur, "package.json")
			if en.checkPath(pkgPath) == nil {
				if raw, err := readFileBounded(pkgPath, 4<<20); err == nil {
					raw = stripUTF8BOM(raw)
					var pkg struct {
						Name    string          `json:"name"`
						Type    string          `json:"type"`
						Main    string          `json:"main"`
						Exports json.RawMessage `json:"exports"`
						Imports json.RawMessage `json:"imports"`
					}
					if json.Unmarshal(raw, &pkg) == nil {
						if len(pkg.Imports) > 0 && string(pkg.Imports) != "null" {
							impVal, _ := parseOrderedJSONBytes(pkg.Imports)
							for _, impStr := range extractExportsSubpath(impVal, spec, isCJS) {
								if strings.HasPrefix(impStr, "./") || strings.HasPrefix(impStr, "../") {
									target := filepath.Join(cur, filepath.FromSlash(impStr))
									rel, relErr := filepath.Rel(cur, target)
									if relErr != nil || strings.HasPrefix(rel, "..") {
										return "", fmt.Errorf("ERR_INVALID_PACKAGE_TARGET: Invalid \"imports\" target %q defined for %q in %s", impStr, spec, pkgPath)
									}
									if r, ok := en.tryResolveFileOrDirEx(target, isCJS, 0); ok {
										return r, nil
									}
								} else if resolved, err := en.resolveModulePathEx(cur, impStr, isCJS); err == nil {
									return resolved, nil
								}
							}
						}
						return "", fmt.Errorf("ERR_PACKAGE_IMPORT_NOT_DEFINED: Package import specifier %q is not defined in package %s", spec, pkgPath)
					}
				}
			}
			parent := filepath.Dir(cur)
			if parent == cur {
				break
			}
			cur = parent
		}
		return "", fmt.Errorf("ERR_PACKAGE_IMPORT_NOT_DEFINED: Package import specifier %q is not defined", spec)
	}

	if strings.HasPrefix(spec, "./") || strings.HasPrefix(spec, "../") || spec == "." || spec == ".." || filepath.IsAbs(spec) {
		cand := spec
		if !filepath.IsAbs(cand) {
			cand = filepath.Join(baseDir, cand)
		}
		if jerr := en.checkPath(cand); jerr != nil {
			return "", jerr
		}
		if resolved, ok := en.tryResolveFileOrDirEx(cand, isCJS, 0); ok {
			return resolved, nil
		}
		return "", fmt.Errorf("Cannot find module '%s' imported from '%s'", spec, baseDir)
	}

	// Walk up node_modules from baseDir, then fallback to CWD node_modules.
	pkgName, subpath := splitPackageSpecifier(spec)
	cur := baseDir
	for {
		if en.checkPath(cur) != nil {
			break
		}
		pkgRoot := filepath.Join(cur, "node_modules", filepath.FromSlash(pkgName))
		resolved, ok, pkgErr := en.tryResolvePackage(pkgRoot, subpath, isCJS, 0)
		if pkgErr != nil {
			return "", pkgErr
		}
		if ok {
			return resolved, nil
		}
		nmCandidate := filepath.Join(cur, "node_modules", filepath.FromSlash(spec))
		if resolved, ok := en.tryResolveFileOrDirEx(nmCandidate, isCJS, 0); ok {
			return resolved, nil
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			break
		}
		cur = parent
	}
	cwd := en.getCWD()
	if cwd != baseDir && en.checkPath(cwd) == nil {
		pkgRoot := filepath.Join(cwd, "node_modules", filepath.FromSlash(pkgName))
		resolved, ok, pkgErr := en.tryResolvePackage(pkgRoot, subpath, isCJS, 0)
		if pkgErr != nil {
			return "", pkgErr
		}
		if ok {
			return resolved, nil
		}
		nmCandidate := filepath.Join(cwd, "node_modules", filepath.FromSlash(spec))
		if resolved, ok := en.tryResolveFileOrDirEx(nmCandidate, isCJS, 0); ok {
			return resolved, nil
		}
	}

	return "", fmt.Errorf("ERR_MODULE_NOT_FOUND: Cannot find module '%s' imported from '%s'", spec, baseDir)
}

func splitPackageSpecifier(spec string) (pkgName, subpath string) {
	slash := filepath.ToSlash(spec)
	if strings.HasPrefix(slash, "@") {
		parts := strings.SplitN(slash, "/", 3)
		if len(parts) >= 2 {
			pkgName = parts[0] + "/" + parts[1]
			if len(parts) == 3 && parts[2] != "" {
				return pkgName, "./" + parts[2]
			}
			return pkgName, "."
		}
	}
	if idx := strings.IndexByte(slash, '/'); idx > 0 {
		return slash[:idx], "./" + slash[idx+1:]
	}
	return slash, "."
}

func (en *rtEntry) tryResolvePackage(pkgRoot, subpath string, isCJS bool, depth int) (string, bool, error) {
	if depth > 16 || en.checkPath(pkgRoot) != nil {
		return "", false, nil
	}
	info, err := os.Stat(pkgRoot)
	if err != nil || !info.IsDir() {
		return "", false, nil
	}
	cleanRoot := filepath.Clean(pkgRoot)
	pkgPath := filepath.Join(pkgRoot, "package.json")
	if en.checkPath(pkgPath) == nil {
		if raw, err := readFileBounded(pkgPath, 4<<20); err == nil {
		raw = stripUTF8BOM(raw)
		var pkg struct {
			Main    string          `json:"main"`
			Module  string          `json:"module"`
			Exports json.RawMessage `json:"exports"`
		}
		if json.Unmarshal(raw, &pkg) == nil {
			if len(pkg.Exports) > 0 && string(pkg.Exports) != "null" {
				expVal, _ := parseOrderedJSONBytes(pkg.Exports)
				for _, expStr := range extractExportsSubpath(expVal, subpath, isCJS) {
					target := filepath.Join(pkgRoot, filepath.FromSlash(expStr))
					if filepath.Clean(target) == cleanRoot {
						if r, ok := en.tryResolveDirIndex(pkgRoot); ok {
							return r, true, nil
						}
						continue
					}
					if r, ok := en.tryResolveFileOrDirEx(target, isCJS, depth+1); ok {
						return r, true, nil
					}
				}
				return "", false, fmt.Errorf("ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath '%s' is not defined by \"exports\" in %s", subpath, pkgPath)
			}
			if subpath == "." {
				if !isCJS && pkg.Module != "" {
					target := filepath.Join(pkgRoot, filepath.FromSlash(pkg.Module))
					if filepath.Clean(target) == cleanRoot {
						if r, ok := en.tryResolveDirIndex(pkgRoot); ok {
							return r, true, nil
						}
					} else if r, ok := en.tryResolveFileOrDirEx(target, isCJS, depth+1); ok {
						return r, true, nil
					}
				}
				if pkg.Main != "" {
					target := filepath.Join(pkgRoot, filepath.FromSlash(pkg.Main))
					if filepath.Clean(target) == cleanRoot {
						if r, ok := en.tryResolveDirIndex(pkgRoot); ok {
							return r, true, nil
						}
					} else if r, ok := en.tryResolveFileOrDirEx(target, isCJS, depth+1); ok {
						return r, true, nil
					}
				}
				if isCJS && pkg.Module != "" {
					target := filepath.Join(pkgRoot, filepath.FromSlash(pkg.Module))
					if filepath.Clean(target) == cleanRoot {
						if r, ok := en.tryResolveDirIndex(pkgRoot); ok {
							return r, true, nil
						}
					} else if r, ok := en.tryResolveFileOrDirEx(target, isCJS, depth+1); ok {
						return r, true, nil
					}
				}
			}
		}
		}
	}
	if subpath == "." {
		r, ok := en.tryResolveDirIndex(pkgRoot)
		return r, ok, nil
	}
	r, ok := en.tryResolveFileOrDirEx(filepath.Join(pkgRoot, filepath.FromSlash(subpath)), isCJS, depth+1)
	return r, ok, nil
}

func (en *rtEntry) tryResolveDirIndex(dir string) (string, bool) {
	if en.checkPath(dir) != nil {
		return "", false
	}
	for _, idx := range []string{"index.js", "index.mjs", "index.cjs", "index.json"} {
		p := filepath.Join(dir, idx)
		if en.checkPath(p) != nil {
			continue
		}
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			if abs, err := filepath.Abs(p); err == nil {
				return abs, true
			}
			return p, true
		}
	}
	return "", false
}

func (en *rtEntry) tryResolveFileOrDir(cand string, depth int) (string, bool) {
	return en.tryResolveFileOrDirEx(cand, false, depth)
}

func (en *rtEntry) tryResolveFileOrDirEx(cand string, isCJS bool, depth int) (string, bool) {
	if depth > 16 || en.checkPath(cand) != nil {
		return "", false
	}
	exts := []string{"", ".js", ".mjs", ".cjs", ".json"}
	for _, ext := range exts {
		p := cand + ext
		if en.checkPath(p) != nil {
			continue
		}
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			if abs, err := filepath.Abs(p); err == nil {
				return abs, true
			}
			return p, true
		}
	}
	if info, err := os.Stat(cand); err == nil && info.IsDir() {
		cleanCand := filepath.Clean(cand)
		pkgPath := filepath.Join(cand, "package.json")
		if raw, err := readFileBounded(pkgPath, 4<<20); err == nil {
			var pkg struct {
				Main    string          `json:"main"`
				Module  string          `json:"module"`
				Exports json.RawMessage `json:"exports"`
			}
			if json.Unmarshal(raw, &pkg) == nil {
				hasExports := len(pkg.Exports) > 0 && string(pkg.Exports) != "null"
				var expVal any
				if hasExports {
					expVal, _ = parseOrderedJSONBytes(pkg.Exports)
				}
				for _, expStr := range extractExportsSubpath(expVal, ".", isCJS) {
					target := filepath.Join(cand, filepath.FromSlash(expStr))
					if filepath.Clean(target) == cleanCand {
						if r, ok := en.tryResolveDirIndex(cand); ok {
							return r, true
						}
						continue
					}
					if r, ok := en.tryResolveFileOrDirEx(target, isCJS, depth+1); ok {
						return r, true
					}
				}
				if hasExports {
					return "", false
				}
				if pkg.Main != "" {
					target := filepath.Join(cand, filepath.FromSlash(pkg.Main))
					if filepath.Clean(target) == cleanCand {
						if r, ok := en.tryResolveDirIndex(cand); ok {
							return r, true
						}
					} else if r, ok := en.tryResolveFileOrDirEx(target, isCJS, depth+1); ok {
						return r, true
					}
				}
				if pkg.Module != "" {
					target := filepath.Join(cand, filepath.FromSlash(pkg.Module))
					if filepath.Clean(target) == cleanCand {
						if r, ok := en.tryResolveDirIndex(cand); ok {
							return r, true
						}
					} else if r, ok := en.tryResolveFileOrDirEx(target, isCJS, depth+1); ok {
						return r, true
					}
				}
			}
		}
		return en.tryResolveDirIndex(cand)
	}
	return "", false
}

type orderedKV struct {
	key string
	val any
}

type orderedMap []orderedKV

func parseOrderedJSONBytes(raw []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	return parseOrderedJSONValue(dec)
}

func parseOrderedJSONValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	return parseOrderedJSONToken(dec, tok)
}

func parseOrderedJSONToken(dec *json.Decoder, tok json.Token) (any, error) {
	if delim, ok := tok.(json.Delim); ok {
		switch delim {
		case '{':
			var m orderedMap
			for dec.More() {
				ktok, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, _ := ktok.(string)
				val, err := parseOrderedJSONValue(dec)
				if err != nil {
					return nil, err
				}
				m = append(m, orderedKV{key: key, val: val})
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return m, nil
		case '[':
			var arr []any
			for dec.More() {
				val, err := parseOrderedJSONValue(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, val)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return arr, nil
		}
	}
	return tok, nil
}

func extractExportsSubpath(exp any, subpath string, isCJS bool) []string {
	if subpath == "" {
		subpath = "."
	}
	switch v := exp.(type) {
	case string:
		if subpath == "." && v != "" {
			return []string{v}
		}
	case []any:
		var out []string
		for _, item := range v {
			out = append(out, extractExportsSubpath(item, subpath, isCJS)...)
		}
		return out
	case orderedMap:
		hasSubpathKeys := false
		for _, kv := range v {
			if strings.HasPrefix(kv.key, ".") || strings.HasPrefix(kv.key, "#") {
				hasSubpathKeys = true
				break
			}
		}
		if hasSubpathKeys {
			for _, kv := range v {
				if kv.key == subpath {
					return extractExportsTargets(kv.val, isCJS)
				}
			}
			var out []string
			for _, kv := range v {
				if idx := strings.IndexByte(kv.key, '*'); idx >= 0 {
					prefix := kv.key[:idx]
					suffix := kv.key[idx+1:]
					if strings.HasPrefix(subpath, prefix) && strings.HasSuffix(subpath, suffix) && len(subpath) >= len(prefix)+len(suffix) {
						matched := subpath[len(prefix) : len(subpath)-len(suffix)]
						for _, t := range extractExportsTargets(kv.val, isCJS) {
							out = append(out, strings.ReplaceAll(t, "*", matched))
						}
					}
				}
			}
			return out
		}
		if subpath == "." {
			return extractExportsTargets(v, isCJS)
		}
	case map[string]any:
		hasSubpathKeys := false
		for k := range v {
			if strings.HasPrefix(k, ".") || strings.HasPrefix(k, "#") {
				hasSubpathKeys = true
				break
			}
		}
		if hasSubpathKeys {
			if target, ok := v[subpath]; ok {
				return extractExportsTargets(target, isCJS)
			}
			// Check wildcard pattern exports like "./*"
			var out []string
			for k, target := range v {
				if idx := strings.IndexByte(k, '*'); idx >= 0 {
					prefix := k[:idx]
					suffix := k[idx+1:]
					if strings.HasPrefix(subpath, prefix) && strings.HasSuffix(subpath, suffix) && len(subpath) >= len(prefix)+len(suffix) {
						matched := subpath[len(prefix) : len(subpath)-len(suffix)]
						for _, t := range extractExportsTargets(target, isCJS) {
							out = append(out, strings.ReplaceAll(t, "*", matched))
						}
					}
				}
			}
			return out
		}
		if subpath == "." {
			return extractExportsTargets(v, isCJS)
		}
	}
	return nil
}

func extractExportsTargets(exp any, isCJS bool) []string {
	switch v := exp.(type) {
	case string:
		if v != "" {
			return []string{v}
		}
	case []any:
		var out []string
		for _, item := range v {
			out = append(out, extractExportsTargets(item, isCJS)...)
		}
		return out
	case orderedMap:
		var out []string
		for _, kv := range v {
			switch kv.key {
			case ".", "node", "default":
				out = append(out, extractExportsTargets(kv.val, isCJS)...)
			case "require":
				if isCJS {
					out = append(out, extractExportsTargets(kv.val, isCJS)...)
				}
			case "import":
				if !isCJS {
					out = append(out, extractExportsTargets(kv.val, isCJS)...)
				}
			}
		}
		return out
	case map[string]any:
		var out []string
		if dot, ok := v["."]; ok {
			out = append(out, extractExportsTargets(dot, isCJS)...)
		}
		var condOrder []string
		if isCJS {
			condOrder = []string{"require", "node", "default"}
		} else {
			condOrder = []string{"import", "node", "default"}
		}
		for _, key := range condOrder {
			if sub, ok := v[key]; ok {
				out = append(out, extractExportsTargets(sub, isCJS)...)
			}
		}
		return out
	}
	return nil
}

func pathToFileURLString(p string) string {
	abs := p
	if a, err := filepath.Abs(p); err == nil {
		abs = a
	}
	if runtime.GOOS == "windows" && strings.HasPrefix(abs, `\\`) {
		rest := strings.TrimPrefix(abs, `\\`)
		if idx := strings.IndexByte(rest, '\\'); idx > 0 {
			host := rest[:idx]
			pathPart := filepath.ToSlash(rest[idx:])
			u := &url.URL{Scheme: "file", Host: host, Path: pathPart}
			return u.String()
		}
	}
	slash := filepath.ToSlash(abs)
	if !strings.HasPrefix(slash, "/") {
		slash = "/" + slash
	}
	u := &url.URL{Scheme: "file", Path: slash}
	return u.String()
}
