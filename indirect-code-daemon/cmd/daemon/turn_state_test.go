package main

import (
	"strings"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
)

func TestFormatRunningBgSection(t *testing.T) {
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.Local)
	tasks := []BgTask{
		{ID: "job-done", Label: "old build", Status: BgStatusDone, StartedAt: now.Add(-time.Hour).UnixMilli()},
		{ID: "job-long", Label: strings.Repeat("é", 150), Status: BgStatusRunning, StartedAt: now.Add(-90 * time.Second).UnixMilli()},
		{ID: "job-a", Label: "bun test", Status: BgStatusRunning, StartedAt: now.Add(-2 * time.Minute).UnixMilli()},
	}
	got := formatRunningBgSection(tasks, now)
	if strings.Contains(got, "job-done") {
		t.Fatalf("finished tasks must be omitted:\n%s", got)
	}
	// Oldest first.
	if strings.Index(got, "job-a") > strings.Index(got, "job-long") {
		t.Fatalf("expected tasks sorted by start time:\n%s", got)
	}
	if !strings.Contains(got, "started 2026-10-13 11:58:30") || !strings.Contains(got, "elapsed 1m30s") {
		t.Fatalf("expected start time and elapsed duration:\n%s", got)
	}
	if !strings.Contains(got, strings.Repeat("é", 100)+"…") || strings.Contains(got, strings.Repeat("é", 101)) {
		t.Fatalf("expected label truncated to the first 100 runes:\n%s", got)
	}
	if got := formatRunningBgSection(tasks[:1], now); got != "" {
		t.Fatalf("expected empty section with nothing running, got %q", got)
	}
}

func TestFormatActiveTodoSection(t *testing.T) {
	items := []tools.TodoItem{
		{ID: "1", Text: "done thing", Status: "completed"},
		{ID: "2", Text: "current thing", Status: "in_progress"},
		{ID: "3", Text: "later thing", Status: "pending"},
	}
	got := formatActiveTodoSection(items)
	if !strings.Contains(got, "(1/3 completed)") {
		t.Fatalf("expected completed count in header:\n%s", got)
	}
	if !strings.Contains(got, "[in_progress] current thing") || !strings.Contains(got, "[pending] later thing") {
		t.Fatalf("expected open items with statuses:\n%s", got)
	}
	if strings.Contains(got, "done thing") {
		t.Fatalf("completed item bodies belong to history, not the active list:\n%s", got)
	}
	if got := formatActiveTodoSection(items[:1]); got != "" {
		t.Fatalf("expected empty section when everything is completed, got %q", got)
	}
	if got := formatActiveTodoSection(nil); got != "" {
		t.Fatalf("expected empty section without a todo list, got %q", got)
	}
}

func TestFinishBlockedWarning(t *testing.T) {
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.Local)
	items := []tools.TodoItem{
		{ID: "1", Text: "shipped", Status: "completed"},
		{ID: "2", Text: "still open", Status: "pending"},
	}
	bg := []BgTask{{ID: "job-x", Label: "slow tests", Status: BgStatusRunning, StartedAt: now.Add(-time.Minute).UnixMilli()}}
	got := finishBlockedWarning(bg, items, now)
	if !strings.Contains(got, "Cannot finish yet") || !strings.Contains(got, "still open") {
		t.Fatalf("expected finish block naming the open items:\n%s", got)
	}
	if !strings.Contains(got, "job-x") || !strings.Contains(got, "slow tests") {
		t.Fatalf("expected running background tasks in the same warning:\n%s", got)
	}
	if got := finishBlockedWarning(bg, items[:1], now); got != "" {
		t.Fatalf("running background tasks alone must not block finishing, got %q", got)
	}
	if got := finishBlockedWarning(nil, nil, now); got != "" {
		t.Fatalf("expected no warning without open todos, got %q", got)
	}
}

// TestBuildTurnSystemDirectivesStateSections: the bg/todo state rides
// every new user turn — unlike the date directive, which fires once
// per change — and each section appears only when it has content.
func TestBuildTurnSystemDirectivesStateSections(t *testing.T) {
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.Local)
	snap := workerSnapshot{
		options:  SessionOptions{Mode: "build"},
		lastDate: now.Format("2006-01-02"), // date unchanged: no date part
		todos: []tools.TodoItem{
			{ID: "1", Text: "open item", Status: "pending"},
		},
		bgTasks: []BgTask{
			{ID: "job-1", Label: "dev server", Status: BgStatusRunning, StartedAt: now.Add(-time.Minute).UnixMilli()},
		},
	}
	got := buildTurnSystemDirectives(&snap, now)
	if !strings.HasPrefix(got, "<system-reminder>") || !strings.HasSuffix(got, "</system-reminder>") {
		t.Fatalf("expected a system-reminder envelope:\n%s", got)
	}
	if strings.Index(got, "job-1") > strings.Index(got, "open item") {
		t.Fatalf("expected background tasks above the todo list:\n%s", got)
	}
	if strings.Contains(got, "Current date") {
		t.Fatalf("unchanged date must not be re-announced:\n%s", got)
	}

	empty := workerSnapshot{options: SessionOptions{Mode: "build"}, lastDate: now.Format("2006-01-02")}
	if got := buildTurnSystemDirectives(&empty, now); got != "" {
		t.Fatalf("expected no reminder without state or date change, got %q", got)
	}
}
