package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
)

// widgetStoreBridge exposes the session's widget store to the widget
// tools. Every operation is a mailbox round-trip to the session actor
// (which owns rec.Widgets), mirroring listRunningBgTasks: bounded, with a
// reply timeout so a wedged actor never hangs the worker forever.
type widgetStoreBridge struct {
	w *turnBridge
}

func (b *widgetStoreBridge) call(m widgetStoreMsg) (widgetStoreResult, error) {
	if b == nil || b.w == nil || b.w.env.inbox == nil {
		return widgetStoreResult{}, fmt.Errorf("widget store unavailable")
	}
	m.Reply = make(chan widgetStoreResult, 1)
	select {
	case b.w.env.inbox <- b.w.stamp(m):
	case <-b.w.ctx.Done():
		return widgetStoreResult{}, b.w.ctx.Err()
	case <-time.After(replyTimeout):
		return widgetStoreResult{}, fmt.Errorf("widget store busy (actor mailbox full)")
	}
	select {
	case r := <-m.Reply:
		return r, r.err
	case <-b.w.ctx.Done():
		return widgetStoreResult{}, b.w.ctx.Err()
	case <-time.After(replyTimeout):
		return widgetStoreResult{}, fmt.Errorf("widget store timeout")
	}
}

func (b *widgetStoreBridge) ListWidgets() []tools.WidgetFile {
	res, err := b.call(widgetStoreMsg{op: "list"})
	if err != nil {
		return nil
	}
	return res.files
}

func (b *widgetStoreBridge) GetWidget(id string) (tools.WidgetFile, bool) {
	res, err := b.call(widgetStoreMsg{op: "get", id: id})
	if err != nil {
		return tools.WidgetFile{}, false
	}
	return res.file, res.found
}

func (b *widgetStoreBridge) SetWidget(f tools.WidgetFile) error {
	_, err := b.call(widgetStoreMsg{op: "set", id: f.ID, file: f})
	return err
}

func (b *widgetStoreBridge) DeleteWidget(id string) error {
	res, err := b.call(widgetStoreMsg{op: "delete", id: id})
	if err != nil {
		return err
	}
	if !res.found {
		return fmt.Errorf("widget %q not found", id)
	}
	return nil
}

// widgetLint validates one widget source at the gateway (compile + import
// audit + smoke render + optional test code). Wired as tools.WidgetLintFunc
// into the widget tools; the gateway call degrades to a lint error (never a
// silent ok) when unreachable.
func (w *turnBridge) widgetLint(ctx context.Context, id, source, test, state string) (tools.WidgetLintResult, error) {
	cfg := w.cfg
	base := strings.TrimRight(cfg.GatewayURL, "/")
	if base == "" || cfg.DaemonToken == "" {
		return tools.WidgetLintResult{}, fmt.Errorf("no gateway configured for widget lint")
	}
	body, err := json.Marshal(map[string]any{
		"id":     id,
		"source": source,
		"test":   test,
		"state":  state,
	})
	if err != nil {
		return tools.WidgetLintResult{}, err
	}
	// The lint runs a full compile + render + test cycle at the gateway:
	// give it a roomy deadline, bounded by the caller's context.
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/indirect-code/gen-ui/lint", bytes.NewReader(body))
	if err != nil {
		return tools.WidgetLintResult{}, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.DaemonToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return tools.WidgetLintResult{}, fmt.Errorf("gateway lint unreachable: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return tools.WidgetLintResult{}, fmt.Errorf("lint response unreadable (status %d): %w", resp.StatusCode, err)
	}
	var res tools.WidgetLintResult
	if err := json.Unmarshal(raw, &res); err != nil {
		snippet := strings.TrimSpace(string(raw))
		if len(snippet) > 300 {
			snippet = snippet[:300] + "..."
		}
		return tools.WidgetLintResult{}, fmt.Errorf("bad lint response (status %d): %v; body: %s", resp.StatusCode, err, snippet)
	}
	if resp.StatusCode != http.StatusOK {
		if len(res.Errors) == 0 {
			snippet := strings.TrimSpace(string(raw))
			if len(snippet) > 300 {
				snippet = snippet[:300] + "..."
			}
			return tools.WidgetLintResult{}, fmt.Errorf("lint failed (status %d): %s", resp.StatusCode, snippet)
		}
		res.OK = false
	}
	return res, nil
}
