package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

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

const (
	maxSessionDebugRecords  = 30
	maxSessionDebugSessions = 64
)

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

	for len(sessionDebugRecords) > maxSessionDebugSessions {
		var oldestSID string
		var oldestTS int64
		for sid, recs := range sessionDebugRecords {
			if sid == sessionID {
				continue
			}
			var ts int64
			if len(recs) > 0 {
				ts = recs[len(recs)-1].Timestamp
			}
			if oldestSID == "" || ts < oldestTS {
				oldestSID = sid
				oldestTS = ts
			}
		}
		if oldestSID == "" {
			break
		}
		delete(sessionDebugRecords, oldestSID)
	}
}

func purgeSessionDebugPayloads(sessionID string) {
	if sessionID == "" {
		return
	}
	sessionDebugMu.Lock()
	delete(sessionDebugRecords, sessionID)
	sessionDebugMu.Unlock()
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
		&tools.ExecScriptTool{CWD: cwd, Sandbox: sb},
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
		&tools.SessionHistoryTool{},
		&tools.ExploreTool{CWD: cwd, Sandbox: sb},
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

func simulateSessionPrompt(dcfg DaemonConfig, rec *SessionRecord, promptText string, brainDir string) (*SessionDebugPayload, error) {
	ctx := context.Background()
	modelName := rec.Model
	if modelName == "" {
		modelName = "default"
	}
	modelInfo := gatewayModel(ctx, dcfg.GatewayURL, dcfg.DaemonToken, modelName)
	if effort := canonicalReasoning(rec.Options.Effort); effort != "" && effort != "none" {
		modelInfo.Reasoning = true
	}
	apiBase := strings.TrimRight(dcfg.GatewayURL, "/") + "/anthropic/v1"
	client := provider.NewGatewayAnthropic(dcfg.APIKey, apiBase, modelInfo)

	opt := rec.Options
	if opt.Mode == "" {
		opt.Mode = "agentic"
	}
	system := systemPromptWithBrain(dcfg, rec.CWD, opt, brainDir)

	sb := tools.NewSandbox(rec.CWD)
	baseTools := []core.Tool{
		&tools.ReadTool{CWD: rec.CWD, Sandbox: sb},
		&tools.WriteTool{CWD: rec.CWD, Sandbox: sb},
		&tools.EditTool{CWD: rec.CWD, Sandbox: sb},
		&tools.BashTool{CWD: rec.CWD, Sandbox: sb, LogDir: brainDir},
		&tools.GlobTool{CWD: rec.CWD, Sandbox: sb},
		&tools.SearchTool{CWD: rec.CWD, Sandbox: sb},
		&tools.InspectTool{CWD: rec.CWD, Sandbox: sb},
		&tools.SearchWebTool{CWD: rec.CWD, Sandbox: sb},
		&tools.FetchURLTool{CWD: rec.CWD, Sandbox: sb},
		&tools.ExecScriptTool{CWD: rec.CWD, Sandbox: sb, LogDir: brainDir},
		&tools.BgCancelTool{},
		&tools.BgCheckTool{},
		&tools.BgAwaitTool{},
		&tools.QuestionTool{},
		&tools.TodoTool{},
		&tools.WidgetSetTool{CWD: rec.CWD, Sandbox: sb},
		&tools.WidgetListTool{},
		&tools.WidgetLintTool{},
		&tools.WidgetReadTool{},
		&tools.WidgetEditTool{},
		&tools.FinishEntireRequestTool{Mode: opt.Mode},
		&tools.SummaryTool{},
		&tools.UseSkillTool{},
		&tools.SessionHistoryTool{},
		&tools.ExploreTool{CWD: rec.CWD, Sandbox: sb},
	}
	masterReg := core.NewRegistry(baseTools...)
	eff, _ := skillRegistry().resolveSession(rec.Skills, opt.Mode)
	effReg := skillsRegistry(masterReg, eff)
	if t, ok := effReg["use_skill"].(*tools.UseSkillTool); ok {
		t.Listing = skillRegistry().skillsDescription(eff.Mode, rec.Skills)
	}
	toolSpecs := effReg.Specs()

	msgs := cloneMessages(rec.Messages)
	if promptText != "" {
		meta := map[string]string{}
		markTurnPrompt(meta)
		userMsg := provider.Message{
			Role:    provider.RoleUser,
			Content: []provider.Content{provider.TextBlock{Text: promptText}},
			Time:    time.Now(),
			Meta:    meta,
		}
		msgs = append(msgs, userMsg)
	}
	msgs = injectSkillsPrefix(msgs, buildSkillPrefix(eff))

	req := provider.Request{
		Model:     modelName,
		System:    system,
		Messages:  msgs,
		Tools:     toolSpecs,
		Reasoning: rec.Options.Effort,
		MaxTokens: maxOutputTokens(modelInfo),
		SessionID: rec.ID,
	}

	_, rawBody, err := provider.BuildWireRequest(client, req)
	if err != nil {
		return nil, fmt.Errorf("failed to build wire request: %w", err)
	}

	const debugBase64OmitThreshold = 4096

	endpoint := strings.TrimRight(apiBase, "/") + "/messages"
	return &SessionDebugPayload{
		TurnIndex:  rec.TurnSeq + 1,
		Step:       0,
		Endpoint:   endpoint,
		Model:      modelName,
		System:     system,
		Reasoning:  rec.Options.Effort,
		MaxTokens:  maxOutputTokens(modelInfo),
		SessionID:  rec.ID,
		Tools:      toolSpecs,
		Messages:   scrubDebugMessages(msgs, debugBase64OmitThreshold),
		RawPayload: scrubDebugJSONBase64(rawBody, debugBase64OmitThreshold),
		Timestamp:  time.Now().UnixMilli(),
	}, nil
}

const defaultDebugBase64Threshold = 4096

// scrubDebugJSONBase64 returns a cloned JSON payload with any `"data":"..."` string
// value exceeding maxChars replaced by `"[base64 omitted: <N> chars]"`.
// Preserves exact JSON structure, key order, and whitespace without mutating raw.
func scrubDebugJSONBase64(raw []byte, maxChars int) json.RawMessage {
	if maxChars <= 0 {
		maxChars = defaultDebugBase64Threshold
	}
	if len(raw) <= maxChars || !bytes.Contains(raw, []byte(`"data"`)) {
		return json.RawMessage(bytes.Clone(raw))
	}

	var out bytes.Buffer
	out.Grow(min(len(raw), 64*1024))

	for i := 0; i < len(raw); {
		if raw[i] != '"' {
			out.WriteByte(raw[i])
			i++
			continue
		}
		keyEnd, _ := scanJSONStringEnd(raw, i)
		if keyEnd < 0 {
			out.Write(raw[i:])
			break
		}
		isDataKey := bytes.Equal(raw[i+1:keyEnd], []byte("data"))
		if !isDataKey {
			out.Write(raw[i : keyEnd+1])
			i = keyEnd + 1
			continue
		}

		colon := skipJSONSpace(raw, keyEnd+1)
		if colon >= len(raw) || raw[colon] != ':' {
			out.Write(raw[i : keyEnd+1])
			i = keyEnd + 1
			continue
		}

		valStart := skipJSONSpace(raw, colon+1)
		if valStart >= len(raw) || raw[valStart] != '"' {
			out.Write(raw[i : colon+1])
			i = colon + 1
			continue
		}

		valEnd, charCount := scanJSONStringEnd(raw, valStart)
		if valEnd < 0 {
			out.Write(raw[i:])
			break
		}
		if charCount > maxChars {
			out.Write(raw[i:valStart])
			fmt.Fprintf(&out, `"[base64 omitted: %d chars]"`, charCount)
		} else {
			out.Write(raw[i : valEnd+1])
		}
		i = valEnd + 1
	}

	return json.RawMessage(out.Bytes())
}

func skipJSONSpace(b []byte, idx int) int {
	for idx < len(b) {
		switch b[idx] {
		case ' ', '\t', '\r', '\n':
			idx++
		default:
			return idx
		}
	}
	return idx
}

func scanJSONStringEnd(b []byte, openQuote int) (int, int) {
	chars := 0
	for i := openQuote + 1; i < len(b); {
		if b[i] == '\\' {
			if i+1 >= len(b) {
				return -1, chars
			}
			if b[i+1] == 'u' && i+5 < len(b) {
				i += 6
			} else {
				i += 2
			}
			chars++
			continue
		}
		if b[i] == '"' {
			return i, chars
		}
		i++
		chars++
	}
	return -1, chars
}

// scrubDebugMessages deep-copies messages that contain large inline ImageBlocks,
// dropping raw pixel bytes above maxChars base64 while retaining metadata so
// debug records and WS debug broadcasts do not duplicate multi-MB image buffers.
func scrubDebugMessages(msgs []provider.Message, maxChars int) []provider.Message {
	if maxChars <= 0 {
		maxChars = defaultDebugBase64Threshold
	}
	if len(msgs) == 0 {
		return nil
	}
	out := make([]provider.Message, len(msgs))
	for i, m := range msgs {
		if !messageHasLargeDebugImage(m, maxChars) {
			out[i] = m
			continue
		}
		cp := m
		cp.Content = make([]provider.Content, len(m.Content))
		for j, c := range m.Content {
			switch v := c.(type) {
			case provider.ImageBlock:
				if base64.StdEncoding.EncodedLen(len(v.Data)) > maxChars {
					v.Data = nil
				}
				cp.Content[j] = v
			case provider.ToolResultBlock:
				inner := make([]provider.Content, len(v.Content))
				for k, ic := range v.Content {
					if ib, ok := ic.(provider.ImageBlock); ok && base64.StdEncoding.EncodedLen(len(ib.Data)) > maxChars {
						ib.Data = nil
						inner[k] = ib
					} else {
						inner[k] = ic
					}
				}
				v.Content = inner
				cp.Content[j] = v
			default:
				cp.Content[j] = c
			}
		}
		out[i] = cp
	}
	return out
}

func messageHasLargeDebugImage(m provider.Message, maxChars int) bool {
	for _, c := range m.Content {
		switch v := c.(type) {
		case provider.ImageBlock:
			if base64.StdEncoding.EncodedLen(len(v.Data)) > maxChars {
				return true
			}
		case provider.ToolResultBlock:
			for _, ic := range v.Content {
				if ib, ok := ic.(provider.ImageBlock); ok && base64.StdEncoding.EncodedLen(len(ib.Data)) > maxChars {
					return true
				}
			}
		}
	}
	return false
}
