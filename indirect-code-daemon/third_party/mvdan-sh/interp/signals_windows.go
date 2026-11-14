//go:build windows

package interp

import "syscall"

// Signals without dedicated Windows constants. The numeric values follow
// the Linux ABI; Windows never delivers most of them, so they only matter
// for trap name handling. See signals_unix.go.
const (
	sigUSR1   = syscall.Signal(10)
	sigUSR2   = syscall.Signal(12)
	sigCHLD   = syscall.Signal(17)
	sigCONT   = syscall.Signal(18)
	sigSTOP   = syscall.Signal(19)
	sigTSTP   = syscall.Signal(20)
	sigTTIN   = syscall.Signal(21)
	sigTTOU   = syscall.Signal(22)
	sigURG    = syscall.Signal(23)
	sigXCPU   = syscall.Signal(24)
	sigXFSZ   = syscall.Signal(25)
	sigVTALRM = syscall.Signal(26)
	sigPROF   = syscall.Signal(27)
	sigWINCH  = syscall.Signal(28)
	sigIO     = syscall.Signal(29)
	sigSYS    = syscall.Signal(31)
)
