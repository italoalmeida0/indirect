package main

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
)

// Live session-state sections folded into model-facing reminders:
// the new-turn system reminder, every second summary notice, and the
// finish-blocked warning. One formatter serves all three so the
// model always reads the same shape. Each section renders only when
// it has content.

// runningBgTasks returns the running background tasks oldest first,
// copied without their retained output (state snapshots stay light).
func runningBgTasks(tasks []BgTask) []BgTask {
	var out []BgTask
	for _, t := range tasks {
		if t.Status != BgStatusRunning {
			continue
		}
		cp := t
		cp.Content = ""
		out = append(out, cp)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].StartedAt < out[j].StartedAt })
	return out
}

// truncateLabelRunes caps a background-task label at max runes.
func truncateLabelRunes(label string, max int) string {
	runes := []rune(label)
	if len(runes) <= max {
		return label
	}
	return string(runes[:max]) + "…"
}

// formatRunningBgSection renders the running background tasks, oldest
// first: id, label (first 100 runes), start time and elapsed time.
// Empty when nothing is running.
func formatRunningBgSection(tasks []BgTask, now time.Time) string {
	running := runningBgTasks(tasks)
	if len(running) == 0 {
		return ""
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Background tasks running (%d):", len(running))
	for _, t := range running {
		label := strings.TrimSpace(t.Label)
		if label == "" {
			label = t.Kind
		}
		started := time.UnixMilli(t.StartedAt)
		elapsed := now.Sub(started).Round(time.Second)
		if elapsed < 0 {
			elapsed = 0
		}
		fmt.Fprintf(&b, "\n- %s · %s · started %s · elapsed %s",
			t.ID, truncateLabelRunes(label, 100), started.Format("2006-01-02 15:04:05"), elapsed)
	}
	return b.String()
}

// openTodos splits the todo list into unfinished items (pending and
// in_progress, in list order) and the completed count.
func openTodos(items []tools.TodoItem) (open []tools.TodoItem, done int) {
	for _, it := range items {
		if it.Status == "completed" {
			done++
			continue
		}
		open = append(open, it)
	}
	return open, done
}

// formatActiveTodoSection renders the unfinished todo items under a
// done/total header. Completed item bodies stay in history; the
// section is empty when nothing is open.
func formatActiveTodoSection(items []tools.TodoItem) string {
	open, done := openTodos(items)
	if len(open) == 0 {
		return ""
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Todo list (%d/%d completed):", done, len(items))
	for _, it := range open {
		fmt.Fprintf(&b, "\n- [%s] %s", it.Status, it.Text)
	}
	return b.String()
}

// turnStateSections returns the non-empty live-state sections for a
// reminder: running background tasks first, the active todo list
// below. Either section is omitted when it has nothing to say.
func turnStateSections(bg []BgTask, todos []tools.TodoItem, now time.Time) []string {
	var sections []string
	if s := formatRunningBgSection(bg, now); s != "" {
		sections = append(sections, s)
	}
	if s := formatActiveTodoSection(todos); s != "" {
		sections = append(sections, s)
	}
	return sections
}

// finishBlockedWarning returns the tool error that blocks
// finish_entire_request while todo items are still open, listing
// the open items and — when any exist — the background tasks still
// running. Empty (finish allowed) when no todo item is open:
// background tasks alone never block finishing.
func finishBlockedWarning(bg []BgTask, todos []tools.TodoItem, now time.Time) string {
	open, _ := openTodos(todos)
	if len(open) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("Cannot finish yet: the todo list still has incomplete items. Complete them — or update the list with the todo tool if the plan changed — then call finish_entire_request again.")
	b.WriteString("\n")
	b.WriteString(formatActiveTodoSection(todos))
	if s := formatRunningBgSection(bg, now); s != "" {
		b.WriteString("\n")
		b.WriteString(s)
	}
	return b.String()
}
