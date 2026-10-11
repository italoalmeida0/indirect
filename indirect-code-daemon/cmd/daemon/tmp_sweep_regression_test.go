package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// REGRESSION (audit bug 72): the tmp sweep must cover ALL writer tmp
// prefixes (config/durable/update/fetch/handoff/runner) and the migration
// suffixes, recursively (the writers scatter tmp across sessions/, bin/,
// runners/ and <sid>/attachments/) — and must NEVER remove real data
// (logs in runners/out, committed att-* attachments, jsonl sessions).
func TestRegressionTmpSweepCoversAllWriters(t *testing.T) {
	dir := t.TempDir()
	old := time.Now().Add(-2 * time.Hour)

	// Debris from every writer (old enough to sweep).
	debris := []string{
		".session-abc", ".migrate-abc", ".storage-version-abc", ".daemon-abc",
		".launcher-abc", ".dl-abc", ".config-abc", ".publish-abc", ".upd-abc",
		".stage-abc", ".app-abc", ".stage-runner-abc",
		"s1.jsonl.v3tmp", "s1.jsonl.v4tmp",
	}
	// Files that must SURVIVE (real data).
	keep := []string{
		"sess_live.jsonl", "sess_live.json", "config.json",
		"att-12345",                      // committed attachment (kept name!)
		"out.log",                        // GC-exempt runner log
		"indirect-code-runner-v1",        // published runner binary
	}
	// Scatter the debris in subdirectories (the real layout).
	places := []string{dir, filepath.Join(dir, "sessions"), filepath.Join(dir, "sessions", "s1", "attachments"),
		filepath.Join(dir, "bin"), filepath.Join(dir, "runners"), filepath.Join(dir, "runners", "out")}
	for _, place := range places {
		if err := os.MkdirAll(place, 0o700); err != nil {
			t.Fatal(err)
		}
		for _, name := range debris {
			p := filepath.Join(place, name)
			if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.Chtimes(p, old, old); err != nil {
				t.Fatal(err)
			}
		}
		for _, name := range keep {
			p := filepath.Join(place, name)
			if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.Chtimes(p, old, old); err != nil {
				t.Fatal(err)
			}
		}
	}

	n := sweepTmpOrphans(dir, time.Hour)

	if want := len(debris) * len(places); n != want {
		t.Errorf("swept %d tmp files, want %d (every writer prefix, every dir)", n, want)
	}
	for _, place := range places {
		for _, name := range debris {
			if _, err := os.Stat(filepath.Join(place, name)); err == nil {
				t.Errorf("BUG 72: tmp debris %q in %s survived the sweep", name, place)
			}
		}
		for _, name := range keep {
			if _, err := os.Stat(filepath.Join(place, name)); err != nil {
				t.Errorf("sweep removed real data %q in %s", name, place)
			}
		}
	}
}
