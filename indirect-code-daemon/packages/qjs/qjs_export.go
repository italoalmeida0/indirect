package qjs

/*
#include <stdint.h>
*/
import "C"

import (
	"time"
	"unsafe"
)

// guQjsRequire is require() crossing into Go: resolution, caching and cycle
// detection live in the skill loader; this only carries the call and hands
// the JSON snapshot of the required module's default export back to the VM.
//
//export guQjsRequire
func guQjsRequire(handle C.uintptr_t, name *C.char, outJSON **C.char, outErr **C.char) C.int {
	en := lookup(uintptr(handle))
	if en == nil {
		*outErr = C.CString("skill sandbox is gone")
		return 1
	}
	module := C.GoString(name)
	if en.require == nil {
		*outErr = C.CString("require is not available in this module")
		return 1
	}
	if time.Now().After(en.deadline) {
		en.timedOut = true
		*outErr = C.CString(ErrTimeout.Error())
		return 1
	}
	snapshot, err := en.require(module)
	if err != nil {
		*outErr = C.CString(err.Error())
		return 1
	}
	if time.Now().After(en.deadline) {
		en.timedOut = true
		*outErr = C.CString(ErrTimeout.Error())
		return 1
	}
	*outJSON = C.CString(snapshot)
	return 0
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
		en.timedOut = true
		return 1
	}
	return 0
}

// ensure unsafe is linked in this file for the //export machinery.
var _ = unsafe.Pointer(nil)
