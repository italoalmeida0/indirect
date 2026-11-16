package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"indirect/indirect-code-daemon/packages/core"
	"indirect/indirect-code-daemon/packages/provider"
)

func extractResText(res core.ToolResult) string {
	var sb strings.Builder
	for _, b := range res.Content {
		if tb, ok := b.(provider.TextBlock); ok {
			sb.WriteString(tb.Text)
		}
	}
	return sb.String()
}

func TestSearchParallelTreeAndSandboxFastPath(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	outsideSecret := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(outsideSecret, []byte("ANCHOR_SECRET_END\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	const totalFiles = 1200
	var wantFiles []string
	for i := 0; i < totalFiles; i++ {
		sub := filepath.Join(root, fmt.Sprintf("pkg_%02d", i%20))
		if err := os.MkdirAll(sub, 0o755); err != nil {
			t.Fatal(err)
		}
		fp := filepath.Join(sub, fmt.Sprintf("file_%04d.java", i))
		content := "package com.example;\npublic class Item {}\n"
		if i%100 == 7 {
			content = "package com.example;\nANCHOR_MATCH_" + fmt.Sprintf("%04d", i) + "_END\n"
			rel, _ := filepath.Rel(root, fp)
			wantFiles = append(wantFiles, filepath.ToSlash(rel))
		}
		if err := os.WriteFile(fp, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// Symlink pointing outside workspace must still be blocked when jailed.
	_ = os.Symlink(outsideSecret, filepath.Join(root, "escape_link.java"))

	for _, mode := range []string{"full", "auto"} {
		t.Run(mode, func(t *testing.T) {
			sb := NewSandbox(root)
			sb.SetInteractivePolicy(mode, nil)
			if mode == "full" {
				sb.Unlock()
			} else {
				sb.Lock()
			}

			st := &SearchTool{CWD: root, Sandbox: sb}
			raw, _ := json.Marshal(SearchArgs{
				Pattern:      `^ANCHOR_MATCH_\d+_END$`,
				MaxResults:   50,
				ContextLines: 1,
			})
			res, err := st.Execute(context.Background(), raw, nil)
			if err != nil {
				t.Fatalf("SearchTool.Execute(%s) error = %v", mode, err)
			}
			body := extractResText(res)
			if mode == "auto" && strings.Contains(body, "ANCHOR_SECRET_END") {
				t.Fatalf("jailed search leaked symlink outside workspace: %s", body)
			}
			for _, wf := range wantFiles {
				if !strings.Contains(body, wf+":2:1:") {
					t.Fatalf("mode=%s missing expected match for %s in:\n%s", mode, wf, body)
				}
			}
		})
	}
}

func TestSearchSoftTimeoutNeverCancelsTurn(t *testing.T) {
	prev := searchSoftTimeout
	searchSoftTimeout = 1 * time.Nanosecond
	defer func() { searchSoftTimeout = prev }()

	root := t.TempDir()
	for i := 0; i < 10; i++ {
		_ = os.WriteFile(filepath.Join(root, fmt.Sprintf("f%d.txt", i)), []byte("needle\n"), 0o644)
	}
	sb := NewSandbox(root)
	sb.SetInteractivePolicy("auto", nil)
	st := &SearchTool{CWD: root, Sandbox: sb}

	var pings atomic.Int32
	raw, _ := json.Marshal(SearchArgs{Pattern: "needle"})
	ctx := context.Background()
	res, err := st.Execute(ctx, raw, func(string) { pings.Add(1) })
	if err != nil {
		t.Fatalf("soft timeout must NOT return error (got %v); turn must stay alive", err)
	}
	if res.IsError {
		t.Fatalf("soft timeout must return graceful truncated result, got IsError=true")
	}
	foundTimedOut := false
	foundTruncated := false
	for _, a := range res.Attrs {
		if a.Key == "timed_out" && a.Value == "true" {
			foundTimedOut = true
		}
		if a.Key == "truncated" && a.Value == "true" {
			foundTruncated = true
		}
	}
	if !foundTimedOut || !foundTruncated {
		t.Fatalf("expected timed_out=true and truncated=true attrs, got %+v", res.Attrs)
	}
	body := extractResText(res)
	if !strings.Contains(body, "time budget") {
		t.Fatalf("expected actionable time-budget notice in result body, got %q", body)
	}
}
