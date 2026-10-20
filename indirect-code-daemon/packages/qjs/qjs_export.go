package qjs

/*
#include <stdint.h>
*/
import "C"

import (
	"fmt"
	"strings"
	"time"
	"unsafe"
)

// guQjsModuleEdge records one import edge while QuickJS links a graph and
// refuses the edge that would close a cycle. Normalization runs for every
// import statement, so this is where the path is still known: QuickJS's own
// linker would only report the later "not initialized" binding error.
//
//export guQjsModuleEdge
func guQjsModuleEdge(handle C.uintptr_t, base *C.char, name *C.char, outErr **C.char) C.int {
	en := lookup(uintptr(handle))
	if en == nil {
		return 0
	}
	from, to := C.GoString(base), C.GoString(name)
	path, cycle := en.addEdge(from, to)
	if !cycle {
		return 0
	}
	*outErr = C.CString(fmt.Sprintf("import cycle: %s", path))
	return 1
}

// guQjsModuleSource is the ES module loader crossing into Go: QuickJS asks
// for one imported module's source while linking, the skill loader resolves
// the specifier, and the bytes go back for compilation into the SAME
// context. Cycle detection and the module budget live here because QuickJS
// only memoizes a module after it has finished linking.
//
//export guQjsModuleSource
func guQjsModuleSource(handle C.uintptr_t, name *C.char, outSrc **C.char, outErr **C.char) C.int {
	en := lookup(uintptr(handle))
	if en == nil {
		*outErr = C.CString("skill sandbox is gone")
		return 1
	}
	specifier := C.GoString(name)
	if time.Now().After(en.deadline) {
		en.markTimeout()
		*outErr = C.CString(ErrTimeout.Error())
		return 1
	}
	if en.resolve == nil {
		*outErr = C.CString(fmt.Sprintf("cannot import %q: this module imports nothing", specifier))
		return 1
	}
	if err := checkSpecifier(specifier); err != nil {
		*outErr = C.CString(err.Error())
		return 1
	}
	// Every loader call is charged, not every unique name: QuickJS asks again
	// while a cycle is still linking, so a unique-name budget would let A->B->A
	// recurse until the deadline. A real graph stays close to its module count.
	en.calls++
	if en.calls > MaxGraphModules*4 {
		*outErr = C.CString(fmt.Sprintf(
			"import graph is too large or cyclic (%d module loads, limit %d)", en.calls-1, MaxGraphModules*4))
		return 1
	}

	source, err := en.resolve(specifier)
	if err != nil {
		*outErr = C.CString(err.Error())
		return 1
	}
	en.loaded[specifier] = true
	if time.Now().After(en.deadline) {
		en.markTimeout()
		*outErr = C.CString(ErrTimeout.Error())
		return 1
	}
	if len(source) == 0 {
		*outErr = C.CString(fmt.Sprintf("%s: module source is empty", specifier))
		return 1
	}
	if len(source) > MaxSourceBytes {
		*outErr = C.CString(fmt.Sprintf("%s: source too large (%d bytes, max %d)", specifier, len(source), MaxSourceBytes))
		return 1
	}
	*outSrc = C.CString(string(source))
	return 0
}

// checkSpecifier rejects anything that is not `skill:<name>`: there is no
// filesystem in the sandbox and no host module to reach, so a relative path,
// a bare package name or a `node:` URL fails at link time with the reason.
func checkSpecifier(specifier string) error {
	if !strings.HasPrefix(specifier, ModuleSpecifierPrefix) {
		return fmt.Errorf("cannot import %q: skills import other skills as %q", specifier, ModuleSpecifierPrefix+"name")
	}
	module := specifier[len(ModuleSpecifierPrefix):]
	if module == "" {
		return fmt.Errorf("cannot import %q: no module name", specifier)
	}
	if strings.ContainsAny(module, "/\\.") || strings.Contains(module, "..") {
		return fmt.Errorf("cannot import %q: %q must be a module name, not a path", specifier, module)
	}
	return nil
}

// guQjsInterrupt answers non-zero once this module's deadline has passed,
// which makes QuickJS abort the running script with an interrupt error.
//
//export guQjsInterrupt
func guQjsInterrupt(handle C.uintptr_t) C.int {
	en := lookup(uintptr(handle))
	if en == nil {
		return 0
	}
	if time.Now().After(en.deadline) {
		en.markTimeout()
		return 1
	}
	return 0
}

// ensure unsafe is linked in this file for the //export machinery.
var _ = unsafe.Pointer(nil)
