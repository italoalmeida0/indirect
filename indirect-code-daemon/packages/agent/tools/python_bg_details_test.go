package tools

import (
	"bytes"
	"testing"
	"time"
)

func TestPythonBackgroundDetailsInitialization(t *testing.T) {
	// finishPythonCommand does not populate Details (Details is nil).
	res, err := finishPythonCommand(nil, bytes.Buffer{}, bytes.Buffer{}, time.Now(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Details != nil {
		t.Fatalf("expected nil details from finishPythonCommand, got %v", res.Details)
	}

	// Stamping logic with nil guard
	jobID := "bg_test_123"
	det, ok := res.Details.(map[string]any)
	if !ok || det == nil {
		det = make(map[string]any)
		res.Details = det
	}
	det["background_job_id"] = jobID
	det["detached"] = true

	d, ok := res.Details.(map[string]any)
	if !ok {
		t.Fatalf("expected map[string]any, got %T", res.Details)
	}
	if d["background_job_id"] != jobID {
		t.Fatalf("expected jobID %s, got %v", jobID, d["background_job_id"])
	}
	if d["detached"] != true {
		t.Fatalf("expected detached=true, got %v", d["detached"])
	}
}
