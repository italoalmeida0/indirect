// Package runner implements the crash-only background task runner
// (runner design decisions D1–D8).
//
// The runner is a role of the multi-call binary. It OWNS one command:
// it starts it immediately (never waiting for a parent), writes live
// output to runners/out/ (GC-exempt), serves the tiny IPC protocol for
// live streaming, and on any terminal transition (finished / killed /
// cleaned) writes the outcome to its state file and COPIES (never moves)
// the log to the session's brain location.
//
// The FILE is the contract: output, liveness, kill and completion are
// all recoverable from state + log alone. The socket is an optimization.
package runner

import (
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
)

// ProtoVersion is the IPC protocol this build speaks.
const ProtoVersion = 1

// Status values (state file).
const (
	StatusRunning = "running"
	StatusDone    = "done"
	StatusKilled  = "killed"
)

// Spec is everything needed to run one command — the runner is generic
// (terminal AND python go through it; it never knows what it runs).
type Spec struct {
	JobID     string   `json:"jobId"`
	SessionID string   `json:"sessionId"`
	Kind      string   `json:"kind"`  // "bash" | "python" | …
	Label     string   `json:"label"` // human label for the UI row
	Path      string   `json:"path"`  // binary
	Args      []string `json:"args"`  // argv after the binary (exec semantics)
	Env       []string `json:"env"`   // full environment
	CWD       string   `json:"cwd"`
	// Stdin is the inline payload fed to the command (python's -c input).
	// Kept OUT of the durable state/log: it is launch data, not metadata.
	Stdin string `json:"stdin,omitempty"`

	Root          string `json:"root"`          // <root> holding runners/ + brain/
	RunnerVersion string `json:"runnerVersion"` // the runner binary's version (GC key)

	// OutPath is the live log (runners/out/<name>); BrainPath is where
	// the terminal COPY lands (the session's brain). Both are computed
	// by the parent from the identity naming so nothing has to guess.
	OutPath   string `json:"outPath"`
	BrainPath string `json:"brainPath"`
}

// Validate rejects a spec that cannot possibly run.
func (s *Spec) Validate() error {
	if s.JobID == "" || s.SessionID == "" {
		return fmt.Errorf("runner: jobId and sessionId are required")
	}
	if s.Path == "" {
		return fmt.Errorf("runner: path is required")
	}
	if s.OutPath == "" || s.BrainPath == "" {
		return fmt.Errorf("runner: outPath and brainPath are required")
	}
	if s.Root == "" {
		return fmt.Errorf("runner: root is required")
	}
	return nil
}

// OutName is the identity filename (decided D8): parseable and
// attributable even after the state file and the job are gone.
// Format: <sessionId>__<jobId>__<startedAtMs>.log
func OutName(sessionID, jobID string, startedAtMs int64) string {
	return fmt.Sprintf("%s__%s__%d.log", sanitize(sessionID), sanitize(jobID), startedAtMs)
}

// ParseOutName recovers (sessionId, jobId, startedAtMs) from an out
// filename — the fallback identity when state is gone. The separators are
// resolved from the ENDS (the timestamp follows the last "__", the session
// id ends at the first "__"), so ids containing "__" still round-trip
// through OutName. (When both ids contain "__" the split is ambiguous and
// resolves at the first separator: the job id keeps the remainder.)
func ParseOutName(name string) (sessionID, jobID string, startedAtMs int64, ok bool) {
	base := strings.TrimSuffix(filepath.Base(name), ".log")
	sep := strings.LastIndex(base, "__")
	if sep < 0 {
		return "", "", 0, false
	}
	ms, err := strconv.ParseInt(base[sep+2:], 10, 64)
	if err != nil {
		return "", "", 0, false
	}
	rest := base[:sep]
	// The session id ends at the first "__"; the job id takes the rest,
	// separators included.
	split := strings.Index(rest, "__")
	if split < 0 {
		return "", "", 0, false
	}
	return rest[:split], rest[split+2:], ms, true
}

// sanitize keeps ids filename-safe without hiding their identity.
func sanitize(s string) string {
	s = strings.ReplaceAll(s, "/", "_")
	s = strings.ReplaceAll(s, "\\", "_")
	s = strings.ReplaceAll(s, string(filepath.Separator), "_")
	return s
}
