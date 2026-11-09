//go:build !windows

package qjs

import (
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	darwinStaticOnce    sync.Once
	darwinTotalMem      uint64
	darwinRelease       string
	darwinVersion       string
	darwinCPUModel      string
	darwinCPUSpeed      int
	darwinBootTimestamp int64
)

func initDarwinStatic() {
	darwinTotalMem = 8 * 1024 * 1024 * 1024
	darwinRelease = "23.0.0"
	darwinVersion = "Darwin Kernel Version 23.0.0"
	darwinCPUModel = "Apple Silicon / Intel (" + runtime.GOARCH + ")"
	darwinCPUSpeed = 2400

	if out, err := exec.Command("/usr/sbin/sysctl", "-n", "hw.memsize").Output(); err == nil {
		if v, perr := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64); perr == nil && v > 0 {
			darwinTotalMem = v
		}
	}
	if out, err := exec.Command("/usr/sbin/sysctl", "-n", "kern.osrelease").Output(); err == nil {
		if s := strings.TrimSpace(string(out)); s != "" {
			darwinRelease = s
		}
	}
	if out, err := exec.Command("/usr/sbin/sysctl", "-n", "kern.version").Output(); err == nil {
		if s := strings.TrimSpace(string(out)); s != "" {
			if idx := strings.IndexByte(s, '\n'); idx >= 0 {
				s = s[:idx]
			}
			darwinVersion = s
		}
	}
	if out, err := exec.Command("/usr/sbin/sysctl", "-n", "machdep.cpu.brand_string").Output(); err == nil {
		if s := strings.TrimSpace(string(out)); s != "" {
			darwinCPUModel = s
		}
	}
	if out, err := exec.Command("/usr/sbin/sysctl", "-n", "kern.boottime").Output(); err == nil {
		s := string(out)
		if idx := strings.Index(s, "sec = "); idx >= 0 {
			rest := s[idx+6:]
			if comma := strings.IndexByte(rest, ','); comma > 0 {
				if sec, perr := strconv.ParseInt(strings.TrimSpace(rest[:comma]), 10, 64); perr == nil {
					darwinBootTimestamp = sec
				}
			}
		}
	}
}

func collectOSMetrics() map[string]any {
	var totalMem uint64 = 8 * 1024 * 1024 * 1024
	var freeMem uint64 = 4 * 1024 * 1024 * 1024
	var uptimeSec float64 = 3600
	release := "6.1.0"
	version := "Linux 6.1.0"
	loadavg := []float64{0, 0, 0}
	cpuModel := "Processor (" + runtime.GOARCH + ")"
	cpuSpeed := 2400
	var userMs, niceMs, sysMs, idleMs, irqMs uint64 = 1200, 0, 400, 10000, 0

	if runtime.GOOS == "darwin" {
		darwinStaticOnce.Do(initDarwinStatic)
		totalMem = darwinTotalMem
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		if totalMem > m.Sys+totalMem/4 {
			freeMem = totalMem/2 - (m.HeapAlloc % (totalMem / 8))
		} else {
			freeMem = totalMem / 3
		}
		release = darwinRelease
		version = darwinVersion
		cpuModel = darwinCPUModel
		cpuSpeed = darwinCPUSpeed
		if darwinBootTimestamp > 0 {
			now := time.Now().Unix()
			if now > darwinBootTimestamp {
				uptimeSec = float64(now - darwinBootTimestamp)
			}
		}
		return map[string]any{
			"totalmem": totalMem,
			"freemem":  freeMem,
			"uptime":   uptimeSec,
			"release":  release,
			"version":  version,
			"loadavg":  loadavg,
			"cpuModel": cpuModel,
			"cpuSpeed": cpuSpeed,
			"cpuTimes": map[string]uint64{
				"user": userMs,
				"nice": niceMs,
				"sys":  sysMs,
				"idle": idleMs,
				"irq":  irqMs,
			},
		}
	}

	if data, err := os.ReadFile("/proc/meminfo"); err == nil {
		var memTotalKB, memAvailKB, memFreeKB uint64
		for _, line := range strings.Split(string(data), "\n") {
			fields := strings.Fields(line)
			if len(fields) < 2 {
				continue
			}
			val, perr := strconv.ParseUint(fields[1], 10, 64)
			if perr != nil {
				continue
			}
			switch fields[0] {
			case "MemTotal:":
				memTotalKB = val
			case "MemAvailable:":
				memAvailKB = val
			case "MemFree:":
				memFreeKB = val
			}
		}
		if memTotalKB > 0 {
			totalMem = memTotalKB * 1024
		}
		if memAvailKB > 0 {
			freeMem = memAvailKB * 1024
		} else if memFreeKB > 0 {
			freeMem = memFreeKB * 1024
		}
	}

	if data, err := os.ReadFile("/proc/uptime"); err == nil {
		fields := strings.Fields(string(data))
		if len(fields) >= 1 {
			if v, perr := strconv.ParseFloat(fields[0], 64); perr == nil && v > 0 {
				uptimeSec = v
			}
		}
	}

	if data, err := os.ReadFile("/proc/sys/kernel/osrelease"); err == nil {
		if s := strings.TrimSpace(string(data)); s != "" {
			release = s
		}
	}
	if data, err := os.ReadFile("/proc/sys/kernel/version"); err == nil {
		if s := strings.TrimSpace(string(data)); s != "" {
			version = s
		}
	} else {
		version = "Linux " + release
	}

	if data, err := os.ReadFile("/proc/loadavg"); err == nil {
		fields := strings.Fields(string(data))
		if len(fields) >= 3 {
			l0, _ := strconv.ParseFloat(fields[0], 64)
			l1, _ := strconv.ParseFloat(fields[1], 64)
			l2, _ := strconv.ParseFloat(fields[2], 64)
			loadavg = []float64{l0, l1, l2}
		}
	}

	if data, err := os.ReadFile("/proc/cpuinfo"); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) != 2 {
				continue
			}
			k := strings.ToLower(strings.TrimSpace(parts[0]))
			v := strings.TrimSpace(parts[1])
			if (k == "model name" || k == "processor" || k == "cpu model") && v != "" && len(v) > 2 {
				cpuModel = v
			} else if k == "cpu mhz" && v != "" {
				if f, perr := strconv.ParseFloat(v, 64); perr == nil && f > 0 {
					cpuSpeed = int(f)
				}
			}
		}
	}

	if data, err := os.ReadFile("/proc/stat"); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			fields := strings.Fields(line)
			if len(fields) >= 7 && fields[0] == "cpu" {
				u, _ := strconv.ParseUint(fields[1], 10, 64)
				n, _ := strconv.ParseUint(fields[2], 10, 64)
				s, _ := strconv.ParseUint(fields[3], 10, 64)
				id, _ := strconv.ParseUint(fields[4], 10, 64)
				ir, _ := strconv.ParseUint(fields[6], 10, 64)
				numCPU := uint64(runtime.NumCPU())
				if numCPU < 1 {
					numCPU = 1
				}
				userMs = (u * 10) / numCPU
				niceMs = (n * 10) / numCPU
				sysMs = (s * 10) / numCPU
				idleMs = (id * 10) / numCPU
				irqMs = (ir * 10) / numCPU
				break
			}
		}
	}

	return map[string]any{
		"totalmem": totalMem,
		"freemem":  freeMem,
		"uptime":   uptimeSec,
		"release":  release,
		"version":  version,
		"loadavg":  loadavg,
		"cpuModel": cpuModel,
		"cpuSpeed": cpuSpeed,
		"cpuTimes": map[string]uint64{
			"user": userMs,
			"nice": niceMs,
			"sys":  sysMs,
			"idle": idleMs,
			"irq":  irqMs,
		},
	}
}

func openFilePlatform(path string, flag int, perm os.FileMode) (*os.File, error) {
	return os.OpenFile(path, flag, perm)
}
