package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"indirect/indirect-code-daemon/packages/core"
	"indirect/indirect-code-daemon/packages/provider"
)

const (
	// ExploreDefaultMaxTurns caps the in-process explore subagent loop.
	ExploreDefaultMaxTurns = 12
	// ExploreMaxOutputBytes strictly bounds the synthesis returned to the caller.
	ExploreMaxOutputBytes = 12 * 1024
)

const exploreSystemPrompt = `You are an isolated, read-only codebase and session-history research subagent.
Your job is to investigate the assigned task thoroughly using ONLY the provided read-only tools and return a concise, high-signal technical synthesis.

Rules:
- You are strictly read-only: never attempt to modify files or run commands.
- Prefer targeted search/glob/inspect first, then read specific line ranges rather than dumping entire large files.
- Cite exact file paths, line numbers, symbol names, and key invariants discovered.
- Keep your final synthesis concise, structured, and directly actionable (under 12KB) so the caller gets exact facts without raw search noise.`

// ExploreArgs holds the input arguments for the explore tool.
type ExploreArgs struct {
	Task       string   `json:"task"`
	FocusPaths []string `json:"focus_paths,omitempty"`
}

// ExploreTool runs a bounded, isolated read-only core.Agent in-process so broad
// multi-file codebase or session-history exploration stays out of the caller's
// main context window while accurately forwarding token usage.
type ExploreTool struct {
	Client    provider.Client
	Model     string
	CWD       string
	Sandbox   *Sandbox
	BrainDir  string
	Reasoning string
	MaxTokens int
	MaxTurns  int
	SessionID string

	// SessionHistory or HistorySource optionally enables session_history inside
	// the explore subagent alongside read, glob, search, and inspect.
	SessionHistory *SessionHistoryTool
	HistorySource  SessionHistorySource

	// OnUsage receives incremental provider.Usage deltas from each subagent
	// model turn so session/billing usage accounting remains exact.
	OnUsage func(provider.Usage)
}

const exploreSchema = `{"type":"object","required":["task"],"properties":{"task":{"type":"string","description":"Concrete codebase or session-history research question to investigate."},"focus_paths":{"type":"array","items":{"type":"string"},"description":"Optional file or directory paths to prioritize first."}}}`

func (t *ExploreTool) Name() string { return "explore" }

func (t *ExploreTool) Description() string {
	return "Delegate broad multi-file codebase or session-history research to an isolated read-only subagent so raw search/read noise stays out of the main context. Params: `task` (required), `focus_paths` (optional array of paths). Runs a bounded read-only subagent (`read`, `glob`, `search`, `inspect`, `session_history`) and returns a concise synthesis (<= 12KB)."
}

func (t *ExploreTool) Schema() json.RawMessage {
	return json.RawMessage(exploreSchema)
}

func (t *ExploreTool) Execute(ctx context.Context, raw json.RawMessage, progress func(string)) (core.ToolResult, error) {
	if err := ctx.Err(); err != nil {
		return core.ToolResult{}, err
	}
	var a ExploreArgs
	if err := unmarshalArgs(raw, &a); err != nil {
		return core.ToolResult{}, fmt.Errorf("invalid args: %w", err)
	}
	task := strings.TrimSpace(a.Task)
	if task == "" {
		return core.ToolResult{}, fmt.Errorf("explore: `task` is required")
	}
	if t.Client == nil {
		return core.ToolResult{}, fmt.Errorf("explore: model client unavailable")
	}
	if strings.TrimSpace(t.Model) == "" {
		return core.ToolResult{}, fmt.Errorf("explore: model name unavailable")
	}

	maxTurns := t.MaxTurns
	if maxTurns <= 0 {
		maxTurns = ExploreDefaultMaxTurns
	}

	roSandbox := cloneReadOnlySandbox(t.Sandbox, t.CWD, t.BrainDir)
	reg := t.buildReadOnlyRegistry(roSandbox)

	sub := core.NewAgent(t.Client, t.Model, exploreSystemPrompt, reg)
	sub.Reasoning = t.Reasoning
	sub.MaxTokens = t.MaxTokens
	sub.SessionID = t.SessionID
	sub.CompletionTool = "" // Conversational synthesis; never require finish_entire_request.

	currentStep := 0
	turnsUsed := 0
	toolCallsRun := 0
	stoppedByCap := false

	sub.BeforeTurn = func(step int) (bool, string) {
		currentStep = step
		if step > maxTurns {
			stoppedByCap = true
			return false, fmt.Sprintf("explore turn cap (%d) reached", maxTurns)
		}
		turnsUsed = step
		return true, ""
	}

	sub.BeforeToolExecute = func(call provider.ToolCallBlock) (bool, string, json.RawMessage) {
		if !isAllowedExploreTool(call.Name) {
			return false, fmt.Sprintf("tool %q is not permitted in read-only explore subagent", call.Name), nil
		}
		return true, "", nil
	}

	sub.RequestMessages = func(msgs []provider.Message) []provider.Message {
		if maxTurns > 1 && currentStep == maxTurns {
			out := make([]provider.Message, len(msgs)+1)
			copy(out, msgs)
			out[len(msgs)] = provider.Message{
				Role: provider.RoleUser,
				Content: []provider.Content{
					provider.TextBlock{
						Text: "<system-reminder>Final explore turn reached: do not call any more tools. Synthesize all findings gathered so far concisely with exact file paths and line numbers.</system-reminder>",
					},
				},
			}
			return out
		}
		return msgs
	}

	prompt := buildExplorePrompt(task, a.FocusPaths)
	var totalUsage provider.Usage

	err := sub.Prompt(ctx, prompt, nil, func(ev core.AgentEvent) {
		switch e := ev.(type) {
		case core.EvUsage:
			totalUsage = totalUsage.Add(e.Usage)
			if t.OnUsage != nil {
				t.OnUsage(e.Usage)
			}
		case core.EvToolExecutionStart:
			toolCallsRun++
			if progress != nil {
				progress(fmt.Sprintf("explore: %s", e.Name))
			}
		}
	})
	if err != nil {
		return core.ToolResult{}, err
	}

	synthesis := extractExploreSynthesis(sub.History(), turnsUsed, toolCallsRun, stoppedByCap)
	synthesis = capExploreOutput(synthesis, ExploreMaxOutputBytes)

	attrs := []core.Attr{
		{Key: "turns", Value: strconv.Itoa(turnsUsed)},
		{Key: "tool_calls", Value: strconv.Itoa(toolCallsRun)},
	}
	if stoppedByCap {
		attrs = append(attrs, core.Attr{Key: "turn_cap_reached", Value: "true"})
	}

	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: synthesis}},
		Attrs:   attrs,
		Details: map[string]any{
			"turns":        turnsUsed,
			"tool_calls":   toolCallsRun,
			"focus_paths":  a.FocusPaths,
			"input_tokens": totalUsage.InputTokens,
			"output_tokens": totalUsage.OutputTokens,
		},
	}, nil
}

func (t *ExploreTool) buildReadOnlyRegistry(roSandbox *Sandbox) core.Registry {
	reg := core.Registry{
		"read":    &ReadTool{CWD: t.CWD, Sandbox: roSandbox, BrainDir: t.BrainDir},
		"glob":    &GlobTool{CWD: t.CWD, Sandbox: roSandbox},
		"search":  &SearchTool{CWD: t.CWD, Sandbox: roSandbox},
		"inspect": &InspectTool{CWD: t.CWD, Sandbox: roSandbox},
	}
	histSrc := t.HistorySource
	if histSrc == nil && t.SessionHistory != nil {
		histSrc = t.SessionHistory.Source
	}
	if histSrc != nil {
		reg["session_history"] = &SessionHistoryTool{Source: histSrc}
	}
	return reg
}

func isAllowedExploreTool(name string) bool {
	switch name {
	case "read", "glob", "search", "inspect", "session_history":
		return true
	default:
		return false
	}
}

// cloneReadOnlySandbox clones parent without mutating the caller's Sandbox
// instance and enforces ProjectReadOnly=true on the clone.
func cloneReadOnlySandbox(parent *Sandbox, cwd, brainDir string) *Sandbox {
	root := cwd
	if parent != nil && parent.Root != "" {
		root = parent.Root
	}
	sb := NewSandbox(root)
	if parent != nil {
		sb.Permissions = parent.Permissions
		for _, extra := range parent.extraRoots {
			sb.AllowExtra(extra)
		}
		if parent.Locked() {
			sb.Lock()
		}
	}
	if strings.TrimSpace(brainDir) != "" {
		sb.AllowExtra(brainDir)
	}
	sb.SetProjectReadOnly(true)
	return sb
}

func buildExplorePrompt(task string, focusPaths []string) string {
	var cleanFocus []string
	for _, p := range focusPaths {
		if trimmed := strings.TrimSpace(p); trimmed != "" {
			cleanFocus = append(cleanFocus, trimmed)
		}
	}
	if len(cleanFocus) == 0 {
		return task
	}
	var sb strings.Builder
	sb.WriteString(task)
	sb.WriteString("\n\nFocus paths to prioritize:\n")
	for _, p := range cleanFocus {
		fmt.Fprintf(&sb, "- %s\n", p)
	}
	return strings.TrimRight(sb.String(), "\n")
}

func extractExploreSynthesis(history []provider.Message, turnsUsed, toolCallsRun int, stoppedByCap bool) string {
	for i := len(history) - 1; i >= 0; i-- {
		m := history[i]
		if m.Role != provider.RoleAssistant {
			continue
		}
		var parts []string
		for _, c := range m.Content {
			if tb, ok := c.(provider.TextBlock); ok && strings.TrimSpace(tb.Text) != "" {
				parts = append(parts, strings.TrimSpace(tb.Text))
			}
		}
		if len(parts) > 0 {
			text := strings.Join(parts, "\n\n")
			if stoppedByCap {
				text += fmt.Sprintf("\n\n[Note: explore reached its %d-turn cap after %d tool call(s).]", turnsUsed, toolCallsRun)
			}
			return text
		}
	}

	// Fallback if the model exhausted its turn budget calling tools without emitting prose.
	var sb strings.Builder
	fmt.Fprintf(&sb, "Explore subagent stopped after %d turn(s) and %d read-only tool call(s) without a final prose synthesis.", turnsUsed, toolCallsRun)
	var snippets []string
	for i := len(history) - 1; i >= 0 && len(snippets) < 3; i-- {
		m := history[i]
		if m.Role != provider.RoleTool {
			continue
		}
		for _, c := range m.Content {
			tr, ok := c.(provider.ToolResultBlock)
			if !ok || tr.IsError {
				continue
			}
			body := extractToolResultBodyAndAttrs(tr)
			body = strings.TrimSpace(body)
			if body != "" {
				snippets = append(snippets, snapUTF8Prefix(body, 1200))
				if len(snippets) >= 3 {
					break
				}
			}
		}
	}
	if len(snippets) > 0 {
		sb.WriteString("\n\nMost recent gathered evidence:\n")
		for idx := len(snippets) - 1; idx >= 0; idx-- {
			sb.WriteString("\n---\n")
			sb.WriteString(snippets[idx])
		}
	}
	return sb.String()
}

func capExploreOutput(s string, maxBytes int) string {
	s = strings.TrimSpace(s)
	if len(s) <= maxBytes {
		return s
	}
	const suffix = "\n\n[... explore synthesis truncated to 12KB]"
	budget := maxBytes - len(suffix)
	if budget <= 0 {
		return snapUTF8Prefix(s, maxBytes)
	}
	return strings.TrimRight(snapUTF8Prefix(s, budget), " \t\r\n") + suffix
}
