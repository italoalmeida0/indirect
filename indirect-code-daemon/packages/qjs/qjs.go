// Package qjs embeds QuickJS as the skill module engine: one fresh runtime
// and context per module graph, a restricted sandbox (no eval, no Function,
// no host, file, process, network or timing API) and a Go-side module
// resolver reached synchronously from QuickJS's module loader.
//
// Imports are real ES module imports. `import base from "skill:agentic_base"`
// asks the Go resolver for that module's source; QuickJS compiles it into the
// same context, so the whole graph shares one VM, one deadline and one memory
// limit. Composition is plain JavaScript (spread, concatenation) — this
// package never merges skill objects.
//
// QuickJS itself is not compiled here: the per-platform static libraries
// under lib/ are prebuilt for the six shipped targets and linked through
// the link_<os>_<arch>.go files, so the daemon keeps cross-compiling with
// cgo enabled and no C toolchain beyond the linker driver.
package qjs

import (
	_ "embed"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unsafe"
)

/*
#cgo CFLAGS: -I${SRCDIR}/lib

#include <stdlib.h>
#include <stdint.h>
#include "shim.h"
*/
import "C"

//go:embed prelude.js
var preludeSource string

const (
	// MaxSourceBytes caps one skill module's source. Skills are prompt and
	// policy modules; the largest builtin is ~18 KiB.
	MaxSourceBytes = 1 << 20
	// DefaultTimeout bounds one module graph evaluation, including every
	// import it links. A module that loops forever is interrupted and the
	// skill is reported as broken instead of stalling the daemon.
	DefaultTimeout = 2 * time.Second
	// MaxGraphModules caps how many modules one graph may link, so a
	// pathological import chain cannot exhaust memory before the timeout.
	MaxGraphModules = 128
)

// ErrTimeout reports a module interrupted because it ran past its deadline.
var ErrTimeout = errors.New("module exceeded the evaluation timeout")

// ModuleSpecifierPrefix is the only import scheme a skill may use. A
// specifier is `skill:<name>`, where <name> is a module file stem
// (`skill:agentic_base` imports agentic_base.js).
const ModuleSpecifierPrefix = "skill:"

// ResolveModule resolves one import specifier to that module's source. The
// skill loader owns naming, precedence and error text; this package only
// carries the call across the VM boundary.
type ResolveModule func(specifier string) (source []byte, err error)

// entry is the state of one in-flight module graph evaluation, reached from
// C through its handle. The resolver runs on the loader's goroutine, so the
// graph bookkeeping needs no lock beyond the handle table.
type entry struct {
	name     string
	resolve  ResolveModule
	deadline time.Time
	timedOut bool
	// edges is the import graph as recorded at normalization time, loaded
	// names the modules already linked, and calls counts every loader call so
	// a pathological graph is bounded by work rather than by names.
	edges  map[string][]string
	loaded map[string]bool
	calls  int
}

func (e *entry) markTimeout() {
	e.timedOut = true
}

// addEdge records one import edge (importer -> imported) and reports the
// cycle it would close, as a readable path (`a -> b -> a`). The new edge
// closes a cycle exactly when it can be walked back to its importer.
func (e *entry) addEdge(from, to string) (string, bool) {
	e.edges[from] = append(e.edges[from], to)
	path, found := findPath(e.edges, to, from)
	if !found {
		return "", false
	}
	return from + " -> " + path, true
}

// findPath returns a short path from start to target (breadth first, bounded
// so a hostile graph cannot stall it) as `start -> ... -> target`.
func findPath(edges map[string][]string, start, target string) (string, bool) {
	if start == target {
		return start, true
	}
	parent := map[string]string{}
	queue := []string{start}
	visited := map[string]bool{start: true}
	for len(queue) > 0 && len(visited) <= MaxGraphModules*4 {
		node := queue[0]
		queue = queue[1:]
		for _, next := range edges[node] {
			if visited[next] {
				continue
			}
			visited[next] = true
			parent[next] = node
			if next == target {
				path := []string{target}
				for cur := node; cur != ""; cur = parent[cur] {
					path = append([]string{cur}, path...)
				}
				path = append([]string{start}, path...)
				// The first element repeats `start`; drop the duplicate.
				return strings.Join(path[1:], " -> "), true
			}
			queue = append(queue, next)
		}
	}
	return "", false
}

var (
	entriesMu sync.Mutex
	entries   = map[uintptr]*entry{}
	nextID    uint64
)

func register(en *entry) uintptr {
	entriesMu.Lock()
	defer entriesMu.Unlock()
	nextID++
	handle := uintptr(nextID)
	entries[handle] = en
	return handle
}

func unregister(handle uintptr) {
	entriesMu.Lock()
	delete(entries, handle)
	entriesMu.Unlock()
}

func lookup(handle uintptr) *entry {
	entriesMu.Lock()
	defer entriesMu.Unlock()
	return entries[handle]
}

// EvalModule evaluates one skill module graph in a fresh VM and returns the
// JSON snapshot of the root module's default export. req.Resolve may be nil
// for a module that imports nothing; an import then fails with a clear
// message.
func EvalModule(req Module) (snapshot string, err error) {
	if len(req.Source) == 0 {
		return "", fmt.Errorf("%s: module source is empty", req.Name)
	}
	if len(req.Source) > MaxSourceBytes {
		return "", fmt.Errorf("%s: source too large (%d bytes, max %d)", req.Name, len(req.Source), MaxSourceBytes)
	}
	timeout := req.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	en := &entry{
		name:     req.Name,
		resolve:  req.Resolve,
		deadline: time.Now().Add(timeout),
		edges:    map[string][]string{},
		loaded:   map[string]bool{},
	}
	handle := register(en)
	defer unregister(handle)

	cname := C.CString(req.Name)
	defer C.free(unsafe.Pointer(cname))
	csrc := C.CString(string(req.Source))
	defer C.free(unsafe.Pointer(csrc))
	cprelude := C.CString(preludeSource)
	defer C.free(unsafe.Pointer(cprelude))

	var cerr *C.char
	run := C.qjs_new(C.uintptr_t(handle), cprelude, &cerr)
	if run == nil {
		return "", fmt.Errorf("%s: %s", req.Name, takeCString(&cerr, "could not create the skill sandbox"))
	}
	defer C.qjs_free_run(run)

	var cout *C.char
	code := C.qjs_eval_module(run, cname, csrc, C.size_t(len(req.Source)), &cout, &cerr)
	if code != 0 {
		msg := takeCString(&cerr, "module evaluation failed")
		if en.timedOut {
			return "", fmt.Errorf("%s: %w (%s)", req.Name, ErrTimeout, timeout)
		}
		return "", fmt.Errorf("%s: %s", req.Name, msg)
	}
	out := C.GoString(cout)
	C.qjs_free_str(cout)
	return out, nil
}

// takeCString copies a C string produced by shim.c and frees it.
func takeCString(p **C.char, fallback string) string {
	if p == nil || *p == nil {
		return fallback
	}
	s := C.GoString(*p)
	C.qjs_free_str(*p)
	*p = nil
	return s
}

// Module is one module graph evaluation request.
type Module struct {
	// Name is the root module identity used in errors and stack traces.
	Name string
	// Source is the root ES module body.
	Source []byte
	// Timeout overrides DefaultTimeout when positive.
	Timeout time.Duration
	// Resolve maps an import specifier to the imported module's source, or
	// nil when this module imports nothing.
	Resolve ResolveModule
}
