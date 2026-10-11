package main

import (
	"errors"
	"os"
	"testing"
)

// REGRESSION (audit bug 77): a purged session's files must never be
// re-created by a late writer (racing finalizer / admin fork path). The
// probe that confirmed the bug drove a real resident actor through
// supervisor.purge and then committed: sessions/<id>.jsonl reappeared.
// Here the same postcondition is asserted at the store boundary.

func TestRegressionPurgeTombstoneBlocksLateWriters(t *testing.T) {
	dir := t.TempDir()
	st := newDiskStore(dir)
	id := "tomb1"
	rec := &SessionRecord{ID: id, CWD: "/tmp", Status: "idle", TurnSeq: 1}
	if err := st.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(st.sessionFile(id)); err != nil {
		t.Fatalf("setup: session file missing: %v", err)
	}

	// Purge (files removed + tombstone), mirroring supervisor.purge's tail.
	if err := os.Remove(st.sessionFile(id)); err != nil {
		t.Fatal(err)
	}
	markSessionPurged(dir, id)

	// A late writer (the confirmed probe: commitWAL/saveSessionSync after
	// purge) must be refused, and the file must stay gone.
	err := st.saveSessionSync(rec)
	if !errors.Is(err, errSessionPurged) {
		t.Fatalf("late saveSessionSync: got %v, want errSessionPurged", err)
	}
	if err := st.appendTurnLine(id, turnLine{V: storeVersion, Kind: "turn", Turn: 2}, recordMeta(rec)); !errors.Is(err, errSessionPurged) {
		t.Fatalf("late appendTurnLine: got %v, want errSessionPurged", err)
	}
	if _, err := st.openWAL(id, &walHeader{TurnIndex: 2}); !errors.Is(err, errSessionPurged) {
		t.Fatalf("late openWAL: got %v, want errSessionPurged", err)
	}
	if _, err := os.Stat(st.sessionFile(id)); err == nil {
		t.Fatal("BUG 77: a late writer re-created sessions/<id>.jsonl after purge")
	}

	// Tombstones are scoped per dataDir: the same id in another store dir
	// (isolated test tempdir) must work normally.
	other := newDiskStore(t.TempDir())
	if err := other.saveSessionSync(&SessionRecord{ID: id, CWD: "/tmp", Status: "idle", TurnSeq: 1}); err != nil {
		t.Fatalf("same id in another dataDir must not be blocked: %v", err)
	}
}
