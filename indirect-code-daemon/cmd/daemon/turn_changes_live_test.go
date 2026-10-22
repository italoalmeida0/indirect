package main

// Regression test for the file-changes balloon vanishing on Refresh:
// get_turn_changes must serve the LIVE preview of the running turn (rebuilt
// from the worker's tracker snapshots) alongside the committed balloons —
// replacing the floating live balloon with an empty committed list made it
// disappear until the next tool event repainted it.

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"indirect/indirect-code-daemon/packages/agent/tools"
	"indirect/indirect-code-daemon/packages/filetrack"
)

func TestTurnChangesServesLiveBalloonMidTurn(t *testing.T) {
	a, _ := darActor(t, &SessionRecord{ID: "sess-live", CWD: t.TempDir(), TurnSeq: 3})
	// A running turn with one tracked file that differs on disk.
	changed := filepath.Join(a.rec.CWD, "main.go")
	if err := os.WriteFile(changed, []byte("package main // edited\n"), 0600); err != nil {
		t.Fatal(err)
	}
	a.state = stateRunning
	a.handleData(Envelope{Payload: walAppendMsg{ev: walEvent{
		Type:     walTypeIncoming,
		Incoming: []filetrack.TrackedFile{{Path: changed, Before: "package main\n", HasBefore: true}},
	}}})

	reply := make(chan any, 1)
	a.onRead(readReqMsg{What: "turnChanges", Reply: reply})
	res := (<-reply).(readResult)
	if res.Error != "" {
		t.Fatal(res.Error)
	}
	out, ok := res.Payload.(map[string]any)
	if !ok {
		t.Fatalf("unexpected payload %T", res.Payload)
	}
	live, ok := out["live"].(map[string]any)
	if !ok {
		t.Fatal("BUG REGRESSED: mid-turn get_turn_changes has no live balloon (Refresh makes it vanish)")
	}
	if live["turnIndex"] != 3 {
		t.Fatalf("live balloon turnIndex = %v, want 3", live["turnIndex"])
	}
	files, _ := live["files"].([]filetrack.ChangedFile)
	if len(files) != 1 || files[0].Path != changed {
		t.Fatalf("live balloon files = %+v", files)
	}

	// After the turn ends the live half is gone (the committed balloon
	// takes over).
	a.state = stateIdle
	a.liveIncoming = nil
	reply2 := make(chan any, 1)
	a.onRead(readReqMsg{What: "turnChanges", Reply: reply2})
	res2 := (<-reply2).(readResult)
	out2 := res2.Payload.(map[string]any)
	if _, has := out2["live"]; has {
		t.Fatal("live balloon must disappear once the turn is idle")
	}
	if _, has := out2["balloons"]; !has {
		t.Fatal("committed balloons must always be served")
	}
}

// A refresh with no tracked files never fabricates a live balloon.
func TestTurnChangesNoLiveWithoutTracking(t *testing.T) {
	a, _ := darActor(t, &SessionRecord{ID: "sess-nolive", CWD: t.TempDir(), TurnSeq: 1})
	a.state = stateRunning
	reply := make(chan any, 1)
	a.onRead(readReqMsg{What: "turnChanges", Reply: reply})
	out := (<-reply).(readResult).Payload.(map[string]any)
	if _, has := out["live"]; has {
		t.Fatal("empty tracker must not produce a live balloon")
	}
}

func TestBinaryFileUndoRestoresContentAndNeverRemoves(t *testing.T) {
	dir := t.TempDir()
	binPath := filepath.Join(dir, "image.png")
	origBytes := []byte{0x89, 'P', 'N', 'G', 0x00, 0x01, 0x02}
	if err := os.WriteFile(binPath, origBytes, 0644); err != nil {
		t.Fatal(err)
	}

	tracker := filetrack.NewTurnTracker()
	tool := &tools.WriteTool{CWD: dir, Changes: tracker}
	rawArgs, _ := json.Marshal(map[string]any{"path": binPath, "content": "plain text overwrite"})
	if _, err := tool.Execute(context.Background(), rawArgs, nil); err != nil {
		t.Fatal(err)
	}

	changed := filetrack.BuildChanged(tracker.Snapshot(), dir)
	if len(changed) != 1 {
		t.Fatalf("expected 1 changed file, got %d", len(changed))
	}
	if changed[0].Status != "binary" {
		t.Fatalf("expected status binary, got %s", changed[0].Status)
	}
	if changed[0].Before != string(origBytes) {
		t.Fatalf("expected Before to hold original binary bytes")
	}

	res := undoOneFile(dir, &changed[0])
	if !res.OK {
		t.Fatalf("undoOneFile failed: %s", res.Message)
	}

	restored, err := os.ReadFile(binPath)
	if err != nil {
		t.Fatalf("file should exist after undo: %v", err)
	}
	if !bytes.Equal(restored, origBytes) {
		t.Fatalf("restored bytes %v != orig bytes %v", restored, origBytes)
	}
}
