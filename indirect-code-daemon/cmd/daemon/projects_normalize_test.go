package main

import (
	"path/filepath"
	"testing"
)

func TestProjectsPathNormalization(t *testing.T) {
	dir := t.TempDir()
	p := newProjectsActor(dir)
	p.load()

	reply := make(chan any, 1)
	p.onCreate(projCreateMsg{
		Path:  "./subproject",
		Name:  "SubProject",
		Reply: reply,
	})
	res := (<-reply).(map[string]any)
	if res["type"] != "project_created" {
		t.Fatalf("expected project_created, got %v", res)
	}
	proj := res["project"].(map[string]any)
	storedPath := proj["path"].(string)

	if !filepath.IsAbs(storedPath) {
		t.Fatalf("expected absolute path, got relative: %s", storedPath)
	}

	// Verify project matching with an absolute session CWD
	sessionCWD := filepath.Join(storedPath, "nested")
	matched := projectForDirectory(sessionCWD, p.list)
	if matched == nil {
		t.Fatal("expected projectForDirectory to match session CWD")
	}
	if matched.ID != proj["id"] {
		t.Fatalf("matched wrong project ID: got %s, want %s", matched.ID, proj["id"])
	}
}
