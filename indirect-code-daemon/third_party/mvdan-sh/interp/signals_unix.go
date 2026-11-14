//go:build !windows

package interp

import "syscall"

// Signals without dedicated Windows constants; see signals_windows.go.
const (
	sigUSR1   = syscall.SIGUSR1
	sigUSR2   = syscall.SIGUSR2
	sigCHLD   = syscall.SIGCHLD
	sigCONT   = syscall.SIGCONT
	sigSTOP   = syscall.SIGSTOP
	sigTSTP   = syscall.SIGTSTP
	sigTTIN   = syscall.SIGTTIN
	sigTTOU   = syscall.SIGTTOU
	sigURG    = syscall.SIGURG
	sigXCPU   = syscall.SIGXCPU
	sigXFSZ   = syscall.SIGXFSZ
	sigVTALRM = syscall.SIGVTALRM
	sigPROF   = syscall.SIGPROF
	sigWINCH  = syscall.SIGWINCH
	sigIO     = syscall.SIGIO
	sigSYS    = syscall.SIGSYS
)
