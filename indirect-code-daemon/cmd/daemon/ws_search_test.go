package main

import (
	"testing"

	"indirect/indirect-code-daemon/packages/provider"
)

func TestWSSearch(t *testing.T) {
	dir := t.TempDir()
	st := newDiskStore(dir)

	// Create session 1 with matching title
	rec1 := &SessionRecord{
		ID:        "sess_test_1",
		Title:     "Refactor database queries",
		CWD:       dir,
		UpdatedAt: 1000,
		Messages:  []provider.Message{},
	}
	if err := st.saveSessionSync(rec1); err != nil {
		t.Fatal(err)
	}

	// Create session 2 with matching message text
	rec2 := &SessionRecord{
		ID:        "sess_test_2",
		Title:     "General discussion",
		CWD:       dir,
		UpdatedAt: 2000,
		Messages: []provider.Message{
			{
				Role: provider.RoleUser,
				Content: []provider.Content{
					provider.TextBlock{Text: "We need to fix the postgres database connection timeout error"},
				},
			},
		},
	}
	if err := st.saveSessionSync(rec2); err != nil {
		t.Fatal(err)
	}

	ws := newWSActor()
	server := &wsServer{
		dataDir: dir,
		ws:      ws,
	}

	server.onSearch("database", 10)

	var emitted []map[string]any
	for len(ws.outbound) > 0 {
		ev := <-ws.outbound
		if m, ok := ev.(map[string]any); ok {
			emitted = append(emitted, m)
		}
	}

	if len(emitted) == 0 {
		t.Fatal("expected search_results event emitted")
	}
	last := emitted[len(emitted)-1]
	if last["type"] != "search_results" {
		t.Fatalf("expected type search_results, got %v", last["type"])
	}
	results, ok := last["results"].([]any)
	if !ok || len(results) != 2 {
		t.Fatalf("expected 2 search results, got %v", results)
	}

	foundSess1 := false
	foundSess2 := false
	for _, r := range results {
		rm := r.(map[string]any)
		if rm["sessionId"] == "sess_test_1" {
			foundSess1 = true
			if rm["matchCount"].(int) < 1 {
				t.Fatalf("sess_test_1 expected matchCount >= 1, got %v", rm["matchCount"])
			}
		}
		if rm["sessionId"] == "sess_test_2" {
			foundSess2 = true
			snip := rm["snippet"].(string)
			if snip == "" {
				t.Fatal("sess_test_2 expected non-empty snippet")
			}
		}
	}
	if !foundSess1 || !foundSess2 {
		t.Fatalf("expected to find both sessions: foundSess1=%v, foundSess2=%v", foundSess1, foundSess2)
	}
}
