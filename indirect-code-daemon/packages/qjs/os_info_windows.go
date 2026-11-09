//go:build windows

package qjs

import (
	"fmt"
	"os"
	"runtime"
	"syscall"
	"unsafe"
)

var (
	modKernel32              = syscall.NewLazyDLL("kernel32.dll")
	procGlobalMemoryStatusEx = modKernel32.NewProc("GlobalMemoryStatusEx")
	procGetTickCount64       = modKernel32.NewProc("GetTickCount64")
	procGetSystemTimes       = modKernel32.NewProc("GetSystemTimes")

	modNtdll          = syscall.NewLazyDLL("ntdll.dll")
	procRtlGetVersion = modNtdll.NewProc("RtlGetVersion")
)

type winMemoryStatusEx struct {
	dwLength                uint32
	dwMemoryLoad            uint32
	ullTotalPhys            uint64
	ullAvailPhys            uint64
	ullTotalPageFile        uint64
	ullAvailPageFile        uint64
	ullTotalVirtual         uint64
	ullAvailVirtual         uint64
	ullAvailExtendedVirtual uint64
}

type winOSVersionInfoW struct {
	dwOSVersionInfoSize uint32
	dwMajorVersion      uint32
	dwMinorVersion      uint32
	dwBuildNumber       uint32
	dwPlatformId        uint32
	szCSDVersion        [128]uint16
}

func collectOSMetrics() map[string]any {
	var totalMem uint64 = 8 * 1024 * 1024 * 1024
	var freeMem uint64 = 4 * 1024 * 1024 * 1024

	var ms winMemoryStatusEx
	ms.dwLength = uint32(unsafe.Sizeof(ms))
	if r1, _, _ := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&ms))); r1 != 0 {
		if ms.ullTotalPhys > 0 {
			totalMem = ms.ullTotalPhys
		}
		if ms.ullAvailPhys > 0 {
			freeMem = ms.ullAvailPhys
		}
	}

	var uptimeSec float64 = 3600
	if r1, _, _ := procGetTickCount64.Call(); r1 > 0 {
		uptimeSec = float64(uint64(r1)) / 1000.0
	}

	release := "10.0.19045"
	var ver winOSVersionInfoW
	ver.dwOSVersionInfoSize = uint32(unsafe.Sizeof(ver))
	if r1, _, _ := procRtlGetVersion.Call(uintptr(unsafe.Pointer(&ver))); r1 == 0 && ver.dwMajorVersion > 0 {
		release = fmt.Sprintf("%d.%d.%d", ver.dwMajorVersion, ver.dwMinorVersion, ver.dwBuildNumber)
	}

	var idleFT, kernelFT, userFT uint64
	var userMs, sysMs, idleMs uint64 = 1200, 400, 10000
	if r1, _, _ := procGetSystemTimes.Call(
		uintptr(unsafe.Pointer(&idleFT)),
		uintptr(unsafe.Pointer(&kernelFT)),
		uintptr(unsafe.Pointer(&userFT)),
	); r1 != 0 {
		numCPU := uint64(runtime.NumCPU())
		if numCPU < 1 {
			numCPU = 1
		}
		idleMs = (idleFT / 10000) / numCPU
		if kernelFT >= idleFT {
			sysMs = ((kernelFT - idleFT) / 10000) / numCPU
		}
		userMs = (userFT / 10000) / numCPU
	}

	cpuModel := os.Getenv("PROCESSOR_IDENTIFIER")
	if cpuModel == "" {
		cpuModel = "Windows Processor (" + runtime.GOARCH + ")"
	}

	return map[string]any{
		"totalmem": totalMem,
		"freemem":  freeMem,
		"uptime":   uptimeSec,
		"release":  release,
		"version":  "Windows NT " + release,
		"loadavg":  []float64{0, 0, 0},
		"cpuModel": cpuModel,
		"cpuSpeed": 2400,
		"cpuTimes": map[string]uint64{
			"user": userMs,
			"nice": 0,
			"sys":  sysMs,
			"idle": idleMs,
			"irq":  0,
		},
	}
}

func openFilePlatform(path string, flag int, perm os.FileMode) (*os.File, error) {
	if len(path) == 0 {
		return os.OpenFile(path, flag, perm)
	}
	pathp, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return os.OpenFile(path, flag, perm)
	}
	var access uint32
	switch flag & (os.O_RDONLY | os.O_WRONLY | os.O_RDWR) {
	case os.O_RDONLY:
		access = syscall.GENERIC_READ
	case os.O_WRONLY:
		access = syscall.GENERIC_WRITE
	case os.O_RDWR:
		access = syscall.GENERIC_READ | syscall.GENERIC_WRITE
	}
	if flag&os.O_CREATE != 0 {
		access |= syscall.GENERIC_WRITE
	}
	if flag&os.O_APPEND != 0 {
		if flag&os.O_TRUNC == 0 {
			access &^= syscall.GENERIC_WRITE
			access |= syscall.FILE_APPEND_DATA | syscall.FILE_WRITE_ATTRIBUTES | 0x00020000 | syscall.SYNCHRONIZE
		} else {
			return os.OpenFile(path, flag, perm)
		}
	}
	sharemode := uint32(syscall.FILE_SHARE_READ | syscall.FILE_SHARE_WRITE | syscall.FILE_SHARE_DELETE)
	var createmode uint32
	switch {
	case flag&(os.O_CREATE|os.O_EXCL) == (os.O_CREATE | os.O_EXCL):
		createmode = syscall.CREATE_NEW
	case flag&(os.O_CREATE|os.O_TRUNC) == (os.O_CREATE | os.O_TRUNC):
		createmode = syscall.CREATE_ALWAYS
	case flag&os.O_CREATE == os.O_CREATE:
		createmode = syscall.OPEN_ALWAYS
	case flag&os.O_TRUNC == os.O_TRUNC:
		createmode = syscall.TRUNCATE_EXISTING
	default:
		createmode = syscall.OPEN_EXISTING
	}
	var attrs uint32 = syscall.FILE_ATTRIBUTE_NORMAL
	if perm&0o200 == 0 {
		attrs = syscall.FILE_ATTRIBUTE_READONLY
	}
	h, err := syscall.CreateFile(pathp, access, sharemode, nil, createmode, attrs, 0)
	if err != nil {
		return os.OpenFile(path, flag, perm)
	}
	return os.NewFile(uintptr(h), path), nil
}
