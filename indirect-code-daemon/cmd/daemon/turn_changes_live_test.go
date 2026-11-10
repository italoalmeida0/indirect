package main

// Regression test for the file-changes balloon vanishing on Refresh:
// get_turn_changes must serve the LIVE preview of the running turn (rebuilt
// from the worker's tracker snapshots) alongside the committed balloons —
// replacing the floating live balloon with an empty committed list made it
// disappear until the next tool event repainted it.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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

func TestBinaryFileTrackedWithoutSnapshotPayload(t *testing.T) {
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

	snap := tracker.Snapshot()
	if len(snap) != 1 || snap[0].Before != "" {
		t.Fatalf("expected binary snapshot without retained bytes, got %+v", snap)
	}

	changed := filetrack.BuildChanged(snap, dir)
	if len(changed) != 1 {
		t.Fatalf("expected 1 changed file, got %d", len(changed))
	}
	if changed[0].Status != "binary" {
		t.Fatalf("expected status binary, got %s", changed[0].Status)
	}
}

func TestLegacyUndoneSessionLoadsCleanly(t *testing.T) {
	dir := t.TempDir()
	st := newDiskStore(dir)
	sessID := "sess-legacy-undone"
	p := st.sessionFile(sessID)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	jsonl := strings.Join([]string{
		`{"v":1,"kind":"turn","turn":1,"messages":[{"role":"user","turn_index":1,"content":[{"type":"text","text":"edit"}]},{"role":"assistant","turn_index":1,"content":[{"type":"text","text":"done"}]}],"balloon":{"turn_index":1,"at":10,"message_index":2,"files":[{"path":"/w/app.ts","rel":"app.ts","status":"modified","diff":"@@ -1 +1 @@\n-old\n+new\n","additions":1,"deletions":1,"before":"old\n","after":"new\n","reverse_patch":"@@ -1 +1 @@\n","undone":true}]},"usage":{}}`,
		`{"v":1,"kind":"meta","id":"sess-legacy-undone","cwd":"/w","title":"Legacy","status":"idle","turnSeq":1}`,
	}, "\n") + "\n"
	if err := os.WriteFile(p, []byte(jsonl), 0o600); err != nil {
		t.Fatal(err)
	}
	rec, _, err := st.loadSessionFused(sessID)
	if err != nil {
		t.Fatalf("loadSessionFused failed on legacy undone session: %v", err)
	}
	if len(rec.FileBalloons) != 1 || len(rec.FileBalloons[0].Files) != 1 {
		t.Fatalf("expected 1 balloon with 1 file, got %+v", rec.FileBalloons)
	}
	f := rec.FileBalloons[0].Files[0]
	if f.Rel != "app.ts" || f.Status != "modified" || f.Additions != 1 || f.Deletions != 1 || !strings.Contains(f.Diff, "+new") {
		t.Fatalf("unexpected file metadata: %+v", f)
	}
}
