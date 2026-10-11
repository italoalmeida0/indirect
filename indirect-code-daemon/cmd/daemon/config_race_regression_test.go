package main

// REGRESSION (audit §5, persistence scout item 3) — KNOWN FAILING until the
// config-write fix lands.
//
// Bugs pinned here:
//  1. Lost update: onUpdateConfig + rememberSelection do unsynchronized
//     load -> save -> store on the shared config; the later store wins and
//     silently drops the other writer's field (empirically reproduced).
//  2. setAutoUpdate publishes RAM before disk and ignores the write error
//     (update_host.go:101-110), so a failed save leaves RAM/disk diverged.
//
// FIX PASS: delete the t.Skip lines and run
// `go test ./cmd/daemon/ -run TestRegressionConfig -v`. Suggested fix: one
// mutex around the config read-modify-write-save-store sequence in all three
// writers (and save BEFORE store in setAutoUpdate).

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// TestRegressionConfigWritersNoLostUpdate drives the real wsServer writers
// concurrently; both the settings update and the model selection must land.
func TestRegressionConfigWritersNoLostUpdate(t *testing.T) {
	t.Skip("BUG audit §5-3: concurrent config writers lose updates; unskip when fixing")
	for attempt := range 25 {
		dir := t.TempDir()
		cell := &configCell{}
		cell.store(&DaemonConfig{HostID: "h1"})
		s := &wsServer{
			dataDir: dir, configDir: dir, cfg: cell,
			debounce: map[string]*time.Timer{},
			lanes:    map[string]*dispatchLane{},
			hostLane: &dispatchLane{},
			ws:       newWSActor(),
		}
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			s.onUpdateConfig([]byte(`{"requestId":"r1","settings":{"temperature":0.7}}`))
		}()
		go func() {
			defer wg.Done()
			<-start
			if err := s.rememberSelection("model-b", SessionOptions{Access: "full"}); err != nil {
				t.Errorf("rememberSelection: %v", err)
			}
		}()
		close(start)
		wg.Wait()

		onDisk, err := loadDaemonConfig(dir)
		if err != nil {
			t.Fatalf("load config: %v", err)
		}
		if onDisk.Settings.Temperature != 0.7 {
			t.Fatalf("attempt %d: settings update lost (temperature=%v)", attempt, onDisk.Settings.Temperature)
		}
		if onDisk.LastSelection == nil || onDisk.LastSelection.Model != "model-b" {
			t.Fatalf("attempt %d: selection update lost (lastSelection=%v)", attempt, onDisk.LastSelection)
		}
	}
}

// TestRegressionSetAutoUpdateNoRAMAheadOfDisk: when the config write fails,
// setAutoUpdate must not publish the new value to RAM (or must surface the
// error). The fault seam is a read-only config dir.
func TestRegressionSetAutoUpdateNoRAMAheadOfDisk(t *testing.T) {
	t.Skip("BUG audit §5-3: setAutoUpdate publishes RAM before disk, ignores write error; unskip when fixing")
	dir := t.TempDir()
	yes := true
	if err := saveDaemonConfig(dir, &DaemonConfig{HostID: "h1", AutoUpdate: &yes}); err != nil {
		t.Fatal(err)
	}
	r := &root{dataDir: dir}
	r.cfg.store(&DaemonConfig{HostID: "h1", AutoUpdate: &yes})
	d := attachUpdateHost(r)

	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })

	d.setAutoUpdate(false)

	onDisk, err := loadDaemonConfig(filepath.Clean(dir))
	if err != nil {
		t.Fatalf("disk config unreadable: %v", err)
	}
	inRAM := d.configNow()
	// Contract: a failed save leaves RAM on the old value (disk is the
	// durable source of truth, per the comment in ws_server.go onUpdateConfig).
	if onDisk.AutoUpdate != nil && *onDisk.AutoUpdate == true &&
		inRAM.AutoUpdate != nil && *inRAM.AutoUpdate == false {
		t.Fatalf("RAM auto_update=false while disk still true (write failed but RAM was published)")
	}
}
