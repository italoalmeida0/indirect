package main

import (
	"encoding/json"
	"sync"

	"indirect/indirect-code-daemon/packages/agent/tools"
	"indirect/indirect-code-daemon/packages/core"
	"indirect/indirect-code-daemon/packages/provider"
)

// SessionDebugPayload is the captured LLM request for inspection.
type SessionDebugPayload struct {
	TurnIndex  int                `json:"turnIndex"`
	Step       int                `json:"step"`
	Endpoint   string             `json:"endpoint"`
	Model      string             `json:"model"`
	System     string             `json:"system"`
	Reasoning  string             `json:"reasoning"`
	MaxTokens  int                `json:"maxTokens"`
	SessionID  string             `json:"sessionId"`
	Tools      []provider.Tool    `json:"tools"`
	Messages   []provider.Message `json:"messages"`
	RawPayload json.RawMessage    `json:"rawPayload"`
	Timestamp  int64              `json:"timestamp"`
}

// DebugToolInfo describes a native tool and its schema for the dev inspection page.
type DebugToolInfo struct {
	Name         string          `json:"name"`
	Description  string          `json:"description"`
	Schema       json.RawMessage `json:"schema"`
	AllowedModes []string        `json:"allowedModes"`
	IsAuto       bool            `json:"isAuto"`
	Deferred     bool            `json:"deferred"`
}

var (
	sessionDebugMu      sync.RWMutex
	sessionDebugRecords = make(map[string][]SessionDebugPayload)
)

const maxSessionDebugRecords = 30

func recordSessionDebugPayload(sessionID string, p SessionDebugPayload) {
	if sessionID == "" {
		return
	}
	sessionDebugMu.Lock()
	defer sessionDebugMu.Unlock()

	records := sessionDebugRecords[sessionID]
	records = append(records, p)
	if len(records) > maxSessionDebugRecords {
		records = records[len(records)-maxSessionDebugRecords:]
	}
	sessionDebugRecords[sessionID] = records
}

func getSessionDebugPayloads(sessionID string) []SessionDebugPayload {
	sessionDebugMu.RLock()
	defer sessionDebugMu.RUnlock()

	records, ok := sessionDebugRecords[sessionID]
	if !ok || len(records) == 0 {
		return []SessionDebugPayload{}
	}
	out := make([]SessionDebugPayload, len(records))
	copy(out, records)
	return out
}

func buildNativeToolsList(cwd string, mode string) []DebugToolInfo {
	sb := tools.NewSandbox(cwd)
	baseTools := []core.Tool{
		&tools.ReadTool{CWD: cwd, Sandbox: sb},
		&tools.WriteTool{CWD: cwd, Sandbox: sb},
		&tools.EditTool{CWD: cwd, Sandbox: sb},
		&tools.BashTool{CWD: cwd, Sandbox: sb},
		&tools.GlobTool{CWD: cwd, Sandbox: sb},
		&tools.SearchTool{CWD: cwd, Sandbox: sb},
		&tools.InspectTool{CWD: cwd, Sandbox: sb},
		&tools.SearchWebTool{CWD: cwd, Sandbox: sb},
		&tools.FetchURLTool{CWD: cwd, Sandbox: sb},
		&tools.PythonTool{CWD: cwd, Sandbox: sb},
		&tools.BgCancelTool{},
		&tools.BgCheckTool{},
		&tools.BgAwaitTool{},
		&tools.QuestionTool{},
		&tools.TodoTool{},
		&tools.WidgetSetTool{CWD: cwd, Sandbox: sb},
		&tools.WidgetListTool{},
		&tools.WidgetLintTool{},
		&tools.WidgetReadTool{},
		&tools.WidgetEditTool{},
		&tools.FinishEntireRequestTool{Mode: mode},
		&tools.SummaryTool{},
		&tools.UseSkillTool{},
	}

	normMode := canonicalSessionMode(mode)
	autoTools := map[string]bool{}
	for _, a := range modeAutoTools(normMode) {
		autoTools[a] = true
	}

	out := make([]DebugToolInfo, 0, len(baseTools))
	for _, t := range baseTools {
		name := t.Name()
		var allowed []string
		for m := range modeExclusive {
			if modeAllows(m, name) {
				allowed = append(allowed, m)
			}
		}
		deferred := false
		if d, ok := t.(interface{ Deferred() bool }); ok {
			deferred = d.Deferred()
		}
		out = append(out, DebugToolInfo{
			Name:         name,
			Description:  t.Description(),
			Schema:       t.Schema(),
			AllowedModes: allowed,
			IsAuto:       autoTools[name],
			Deferred:     deferred,
		})
	}
	return out
}
