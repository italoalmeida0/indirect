//go:build windows

package runner

import (
	"syscall"
)

// Windows UTF-8 defaults (extracted from unish, owner-sanctioned):
// SetConsoleOutputCP(CP_UTF8) and SetConsoleCP(CP_UTF8) configure the runner's
// console so child processes render and accept UTF-8 under cp1252/cp850 hosts.

var (
	modKernel32UTF8  = syscall.NewLazyDLL("kernel32.dll")
	procSetOutputCP  = modKernel32UTF8.NewProc("SetConsoleOutputCP")
	procSetConsoleCP = modKernel32UTF8.NewProc("SetConsoleCP")
)

const cpUTF8 = 65001

func init() {
	// Best effort: never fail startup because of this.
	_, _, _ = procSetOutputCP.Call(uintptr(cpUTF8))
	_, _, _ = procSetConsoleCP.Call(uintptr(cpUTF8))
}

// utf8Env returns the child environment (console codepage is set to UTF-8 in init).
func utf8Env(env []string) []string {
	return env
}
