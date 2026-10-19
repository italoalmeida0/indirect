// Package qjs embeds QuickJS as the skill module engine: one fresh runtime
// and context per module evaluation, a restricted sandbox (no eval, no
// Function, no host, file, process, network or timing API) and a Go-side
// module loader reached synchronously from require().
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
	// DefaultTimeout bounds one module evaluation, including every require
	// it triggers. A module that loops forever is interrupted and the skill
	// is reported as broken instead of stalling the daemon.
	DefaultTimeout = 2 * time.Second
)

// ErrTimeout reports a module interrupted because it ran past its deadline.
var ErrTimeout = errors.New("module exceeded the evaluation timeout")

// Require resolves one module name to the JSON snapshot of that module's
// default export. The skill loader owns resolution, caching and cycle
// detection; this package only carries the call across the VM boundary.
type Require func(name string) (snapshot string, err error)

// entry is the state of one in-flight module evaluation, reached from C
// through its handle.
type entry struct {
	name     string
	require  Require
	deadline time.Time
	timedOut bool
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

// EvalModule evaluates one skill module in a fresh VM and returns the JSON
// snapshot of its default export. req.Require may be nil for a module that
// cannot import others; require() then fails with a clear message.
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
	en := &entry{name: req.Name, require: req.Require, deadline: time.Now().Add(timeout)}
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

// Module is one module evaluation request.
type Module struct {
	// Name is the module identity used in errors and stack traces.
	Name string
	// Source is the ES module body.
	Source []byte
	// Timeout overrides DefaultTimeout when positive.
	Timeout time.Duration
	// Require resolves other skill modules, or nil when imports are not
	// available for this module.
	Require Require
}

// exported callbacks for shim.c; see qjs_export.go for the //export half.
