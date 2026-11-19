package sessionstore

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRunDiskGCSkipsSymlinksInLogsAndBrain(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()

	// Create old regular files outside root that symlinks will point to.
	oldTime := time.Now().Add(-45 * 24 * time.Hour)
	outsideCompTarget := filepath.Join(outside, "compress-target.log")
	outsideDelTarget := filepath.Join(outside, "delete-target.log")
	outsideDirTarget := filepath.Join(outside, "linked-session")
	outsideSubFile := filepath.Join(outsideDirTarget, "victim.log")
	if err := os.MkdirAll(outsideDirTarget, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{outsideCompTarget, outsideDelTarget, outsideSubFile} {
		if err := os.WriteFile(f, []byte("precious-external-data\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(f, oldTime, oldTime); err != nil {
			t.Fatal(err)
		}
	}

	brainSess := filepath.Join(root, "brain", "sess_symlink")
	runnersOut := filepath.Join(root, "runners", "out")
	if err := os.MkdirAll(brainSess, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(runnersOut, 0o700); err != nil {
		t.Fatal(err)
	}

	linkCompress := filepath.Join(brainSess, "job1.log")
	linkDelete := filepath.Join(runnersOut, "sess_symlink__job2__1.log")
	linkDir := filepath.Join(root, "brain", "sess_linked_dir")
	if err := os.Symlink(outsideCompTarget, linkCompress); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := os.Symlink(outsideDelTarget, linkDelete); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsideDirTarget, linkDir); err != nil {
		t.Fatal(err)
	}

	// Run GC with a future Now so even newly-created symlinks exceed both thresholds.
	stats, err := RunDiskGC(context.Background(), root, "", GCPolicy{
		CompressLogsAfter: time.Hour,
		DeleteLogsAfter:   2 * time.Hour,
		Now:               time.Now().Add(48 * time.Hour),
	})
	if err != nil {
		t.Fatalf("RunDiskGC: %v", err)
	}
	if stats.CompressedLogs != 0 || stats.DeletedLogs != 0 {
		t.Fatalf("RunDiskGC must skip symlinks, got stats=%+v", stats)
	}
	// Symlinks themselves and external targets must be untouched, and no .zst created.
	for _, p := range []string{linkCompress, linkDelete, outsideCompTarget, outsideDelTarget, outsideSubFile} {
		if _, err := os.Lstat(p); err != nil {
			t.Fatalf("expected %s to remain untouched: %v", p, err)
		}
	}
	if _, err := os.Stat(linkCompress + ".zst"); !os.IsNotExist(err) {
		t.Fatalf("RunDiskGC compressed symlinked log into .zst")
	}
}
