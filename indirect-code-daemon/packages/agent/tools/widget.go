package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"indirect/indirect-code-daemon/packages/core"
	"indirect/indirect-code-daemon/packages/provider"
)

// WidgetFile is one generative-ui widget source stored inside the session
// record (session-owned, like todos — NOT a workspace file). A transcript
// fence only carries `id:`; this record is the source of truth for that id.
type WidgetFile struct {
	ID          string `json:"id"`
	Source      string `json:"source"`
	Placeholder string `json:"placeholder,omitempty"`
	Size        int    `json:"size,omitempty"`
	UpdatedAt   int64  `json:"updatedAt,omitempty"`
}

// WidgetLintError is one lint finding. Phase is "compile", "audit",
// "render" or "test".
type WidgetLintError struct {
	Phase   string `json:"phase"`
	Message string `json:"message"`
	Line    int    `json:"line,omitempty"`
}

// WidgetLintResult is the gateway lint outcome for one widget source.
type WidgetLintResult struct {
	OK         bool              `json:"ok"`
	Errors     []WidgetLintError `json:"errors,omitempty"`
	Output     string            `json:"output,omitempty"`
	DurationMs int64             `json:"durationMs,omitempty"`
	// Notes carries non-fatal observations from the lint (how much of the
	// 3D/WebGL path the smoke render exercised, polyfill notes).
	Notes []string `json:"notes,omitempty"`
	// Skipped is set when no linter is wired (gateway unreachable or not
	// configured): the widget is stored but was NOT validated.
	Skipped bool `json:"skipped,omitempty"`
}

// WidgetLintFunc validates one widget source at the gateway (compile +
// import audit + smoke render in a sandboxed worker + optional test code).
// state is the widget's default state header (JSON) used for the smoke
// render; test is optional extra test code (TSX) run against the module.
type WidgetLintFunc func(ctx context.Context, id, source, test, state string) (WidgetLintResult, error)

// WidgetStore is the session's widget store (session record, WAL-backed).
// Implemented by the daemon session actor bridge; faked in tests.
type WidgetStore interface {
	ListWidgets() []WidgetFile
	GetWidget(id string) (WidgetFile, bool)
	SetWidget(WidgetFile) error
	DeleteWidget(id string) error
}

const widgetIDMaxLen = 64

// checkWidgetID validates the fence `id:` link token.
func checkWidgetID(id string) error {
	if id == "" {
		return fmt.Errorf("id is required")
	}
	if len(id) > widgetIDMaxLen {
		return fmt.Errorf("id too long (max %d chars)", widgetIDMaxLen)
	}
	for _, r := range id {
		ok := r == '-' || r == '_' || r == ':' || r == '.' ||
			(r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
		if !ok {
			return fmt.Errorf("invalid id %q: use letters, digits, '-', '_', ':' or '.'", id)
		}
	}
	return nil
}

// widgetPlaceholder extracts the `placeholder:` header value from a widget
// source (its fence header block), for the widget_list listing.
func widgetPlaceholder(source string) string {
	for _, line := range strings.Split(source, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if !strings.HasPrefix(trimmed, "placeholder:") {
			if strings.HasPrefix(trimmed, "@jsx") {
				break
			}
			continue
		}
		return strings.TrimSpace(strings.TrimPrefix(trimmed, "placeholder:"))
	}
	return ""
}

// widgetStateHeader extracts the `state:` header JSON (if any) from a
// widget source; used as the smoke-render default state.
func widgetStateHeader(source string) string {
	for _, line := range strings.Split(source, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if !strings.HasPrefix(trimmed, "state:") {
			if strings.HasPrefix(trimmed, "@jsx") {
				break
			}
			continue
		}
		return strings.TrimSpace(strings.TrimPrefix(trimmed, "state:"))
	}
	return ""
}

// runWidgetLint validates one source through the gateway linter. A missing
// linter degrades to Skipped (store without validation), never to a fake ok.
func runWidgetLint(ctx context.Context, lint WidgetLintFunc, id, source, test, state string) WidgetLintResult {
	if lint == nil {
		return WidgetLintResult{Skipped: true}
	}
	if state == "" {
		state = widgetStateHeader(source)
	}
	res, err := lint(ctx, id, source, test, state)
	if err != nil {
		return WidgetLintResult{OK: false, Errors: []WidgetLintError{{Phase: "lint", Message: err.Error()}}}
	}
	return res
}

// renderWidgetLintText is the lint tool's plain-text body: one line per
// finding plus the trailing verdict. The frontend paints it red when the
// result is not ok.
func renderWidgetLintText(res WidgetLintResult, id string) string {
	var b strings.Builder
	if res.Skipped {
		fmt.Fprintf(&b, "lint skipped (no gateway linter): %s\n", id)
		fmt.Fprintf(&b, "widget saved but NOT validated\n")
		return b.String()
	}
	for _, e := range res.Errors {
		if e.Line > 0 {
			fmt.Fprintf(&b, "[%s] line %d: %s\n", e.Phase, e.Line, e.Message)
		} else {
			fmt.Fprintf(&b, "[%s] %s\n", e.Phase, e.Message)
		}
	}
	for _, n := range res.Notes {
		fmt.Fprintf(&b, "[note] %s\n", n)
	}
	if strings.TrimSpace(res.Output) != "" {
		out := strings.TrimRight(res.Output, "\n")
		if len(out) > 4000 {
			out = out[:4000] + "\n... [truncated]"
		}
		fmt.Fprintf(&b, "%s\n", out)
	}
	if res.OK {
		fmt.Fprintf(&b, "LINT OK: %s (%dms)\n", id, res.DurationMs)
	} else {
		fmt.Fprintf(&b, "LINT FAILED: %s (%d error(s))\n", id, len(res.Errors))
	}
	return b.String()
}

/* ---------------- widget_set ---------------- */

// WidgetSetTool creates, replaces or deletes a session widget source. The
// transcript fence only links widgets by `widget_id:`, so this tool is how a
// widget's code gets into the session.
type WidgetSetTool struct {
	Store WidgetStore
	Lint  WidgetLintFunc
	// AllowSrcFile is false in talk mode: the talk agent has no real
	// terminal, so it passes `content` directly and src_file is rejected.
	AllowSrcFile bool
	Sandbox      *Sandbox
	CWD          string
}

type widgetSetArgs struct {
	ID      string `json:"id"`
	Content string `json:"content"`
	SrcFile string `json:"src_file"`
	// State is the fence `state:` JSON the widget will render with — the
	// lint uses it as props so the smoke render matches what users see.
	State  string `json:"state"`
	Delete bool   `json:"delete"`
}

func (t *WidgetSetTool) Name() string { return "widget_set" }
func (t *WidgetSetTool) Description() string {
	if t.AllowSrcFile {
		return "Create, replace or delete an interactive widget in this session. The transcript fence only carries headers (`widget_id:`, `placeholder:`, `state:`) and links the widget by id — this tool stores the widget's TSX source under that id. The source is a raw TSX module (no fence markers): a React 18 function component (`export default function App`) as a single JSX/TSX file, TypeScript allowed. Pass the source directly with `content`, or import an existing workspace file with `src_file` (write the file first with write/edit/bash). The source is linted at the gateway on every save (compile, import audit, smoke render) — fix any reported error before referencing the widget. To CHANGE an existing widget, prefer widget_edit (targeted replacements) over re-sending the whole source here — only rewrite from scratch with this tool when the edits are too tangled to express. Pass `delete: true` to remove the widget."
	}
	return "Create, replace or delete an interactive widget in this session. The transcript fence only carries headers (`widget_id:`, `placeholder:`, `state:`) and links the widget by id — this tool stores the widget's TSX source under that id. The source is a raw TSX module (no fence markers): a React 18 function component (`export default function App`) as a single JSX/TSX file, TypeScript allowed — pass it with `content`. The source is linted at the gateway on every save (compile, import audit, smoke render) — fix any reported error before referencing the widget. To CHANGE an existing widget, prefer widget_edit (targeted replacements) over re-sending the whole source here — only rewrite from scratch with this tool when the edits are too tangled to express. Pass `delete: true` to remove the widget."
}
func (t *WidgetSetTool) Schema() json.RawMessage {
	if t.AllowSrcFile {
		return json.RawMessage(`{"type":"object","properties":{"id":{"type":"string","description":"Widget id — the same id the generative_ui fence links with its widget_id: header"},"content":{"type":"string","description":"The widget TSX source (raw module, no fence markers). Mutually exclusive with src_file."},"src_file":{"type":"string","description":"Workspace file to import as the widget source (created with write/edit/bash first). Mutually exclusive with content."},"state":{"type":"string","description":"The fence state JSON the widget renders with (its props). The lint smoke-renders with exactly this state."},"delete":{"type":"boolean","description":"Delete the widget with this id instead of storing it"}},"required":["id"]}`)
	}
	return json.RawMessage(`{"type":"object","properties":{"id":{"type":"string","description":"Widget id — the same id the generative_ui fence links with its widget_id: header"},"content":{"type":"string","description":"The widget TSX source (raw module, no fence markers)"},"state":{"type":"string","description":"The fence state JSON the widget renders with (its props). The lint smoke-renders with exactly this state."},"delete":{"type":"boolean","description":"Delete the widget with this id instead of storing it"}},"required":["id"]}`)
}

func (t *WidgetSetTool) Execute(ctx context.Context, raw json.RawMessage, progress func(string)) (core.ToolResult, error) {
	var a widgetSetArgs
	if err := unmarshalArgs(raw, &a); err != nil {
		return core.ToolResult{}, fmt.Errorf("invalid args: %w", err)
	}
	if err := checkWidgetID(a.ID); err != nil {
		return core.ToolResult{}, err
	}
	if t.Store == nil {
		return core.ToolResult{}, fmt.Errorf("widget store unavailable")
	}

	if a.Delete {
		if a.Content != "" || a.SrcFile != "" {
			return core.ToolResult{}, fmt.Errorf("delete is mutually exclusive with content/src_file")
		}
		if _, ok := t.Store.GetWidget(a.ID); !ok {
			return core.ToolResult{}, fmt.Errorf("widget %q not found", a.ID)
		}
		if err := t.Store.DeleteWidget(a.ID); err != nil {
			return core.ToolResult{}, err
		}
		return core.ToolResult{
			Attrs: []core.Attr{
				{Key: "info", Value: fmt.Sprintf("Deleted widget %s", a.ID)},
				{Key: "path", Value: a.ID},
			},
			Details: map[string]any{"display": fmt.Sprintf("%s\nDeleted widget %s\n", LinePrefixNotice, a.ID), "id": a.ID, "deleted": true},
		}, nil
	}

	if a.Content != "" && a.SrcFile != "" {
		return core.ToolResult{}, fmt.Errorf("pass either content or src_file, not both")
	}
	source := a.Content
	if a.SrcFile != "" {
		if !t.AllowSrcFile {
			return core.ToolResult{}, fmt.Errorf("src_file is not available in this mode; pass content directly")
		}
		if t.Sandbox == nil {
			return core.ToolResult{}, fmt.Errorf("sandbox unavailable")
		}
		path := resolvePath(t.CWD, a.SrcFile)
		if err := t.Sandbox.CheckReadPath(path); err != nil {
			return core.ToolResult{}, err
		}
		data, err := readWholeFile(path)
		if err != nil {
			return core.ToolResult{}, fmt.Errorf("could not read src_file: %s. %s.", a.SrcFile, err)
		}
		if looksBinary(data) {
			return core.ToolResult{}, fmt.Errorf("src_file %s looks binary; refusing to import", a.SrcFile)
		}
		source = strings.TrimPrefix(string(data), "\uFEFF")
	}
	if strings.TrimSpace(source) == "" {
		return core.ToolResult{}, fmt.Errorf("content is required (or src_file where available)")
	}
	// Accept a full fenced block pasted by mistake: strip the fence and
	// any legacy `@jsx` marker so the stored source is always a raw module.
	source = stripWidgetFence(source)

	res := runWidgetLint(ctx, t.Lint, a.ID, source, "", a.State)
	file := WidgetFile{
		ID:          a.ID,
		Source:      source,
		Placeholder: widgetPlaceholder(source),
		Size:        len(source),
		UpdatedAt:   time.Now().UnixMilli(),
	}
	if err := t.Store.SetWidget(file); err != nil {
		return core.ToolResult{}, err
	}

	totalLines := strings.Count(source, "\n")
	if source != "" && !strings.HasSuffix(source, "\n") {
		totalLines++
	}
	lines := strings.Split(strings.TrimSuffix(source, "\n"), "\n")
	var sb strings.Builder
	sb.WriteString(LinePrefixNotice)
	for i, line := range lines {
		fmt.Fprintf(&sb, "%d:%s\n", i+1, line)
	}
	display := sb.String()
	if progress != nil {
		progress(display)
	}

	verdict := "lint ok"
	if res.Skipped {
		verdict = "lint skipped"
	} else if !res.OK {
		verdict = fmt.Sprintf("LINT FAILED (%d error(s))", len(res.Errors))
	}
	lintText := renderWidgetLintText(res, a.ID)
	attrs := []core.Attr{
		{Key: "info", Value: fmt.Sprintf("Successfully stored widget %s (%s)", a.ID, verdict)},
		{Key: "path", Value: a.ID},
		{Key: "lines", Value: fmt.Sprintf("%d", totalLines)},
	}
	if !res.OK && !res.Skipped {
		attrs = append(attrs, core.Attr{Key: "warning", Value: "widget stored but lint failed; fix before referencing it"})
	}
	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: lintText}},
		Attrs:   attrs,
		Details: map[string]any{
			"display":     display,
			"path":        a.ID,
			"id":          a.ID,
			"bytes":       len(source),
			"total_lines": totalLines,
			"start_line":  1,
			"lint_ok":     res.OK || res.Skipped,
			"lint":        res,
		},
	}, nil
}

// stripWidgetFence reduces a pasted ```generative_ui / ```jsx block (with
// headers and a possible legacy `@jsx` marker) to the raw module source.
func stripWidgetFence(source string) string {
	lines := strings.Split(source, "\n")
	out := make([]string, 0, len(lines))
	inBody := false
	sawMarker := false
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if i == 0 && strings.HasPrefix(trimmed, "```") {
			inBody = true
			continue
		}
		if !inBody {
			out = append(out, line)
			continue
		}
		if !sawMarker {
			if strings.HasPrefix(trimmed, "@jsx") {
				sawMarker = true
				continue
			}
			// Header lines inside a pasted fence block: drop them.
			low := strings.ToLower(trimmed)
			if strings.HasPrefix(low, "placeholder:") || strings.HasPrefix(low, "state:") || strings.HasPrefix(low, "id:") {
				continue
			}
			if trimmed == "" {
				continue
			}
			sawMarker = true
			out = append(out, line)
			continue
		}
		if strings.HasPrefix(trimmed, "```") {
			inBody = false
			continue
		}
		out = append(out, line)
	}
	return strings.TrimSpace(strings.Join(out, "\n")) + "\n"
}

/* ---------------- widget_list ---------------- */

// WidgetListTool lists the session's widgets (like inspect lists files).
type WidgetListTool struct {
	Store WidgetStore
}

func (t *WidgetListTool) Name() string { return "widget_list" }
func (t *WidgetListTool) Description() string {
	return "List the interactive widgets stored in this session. Each generative_ui fence links one of these by `widget_id:`. Shows id, size, line count, placeholder and last update."
}
func (t *WidgetListTool) Schema() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{}}`)
}

func (t *WidgetListTool) Execute(ctx context.Context, raw json.RawMessage, progress func(string)) (core.ToolResult, error) {
	if t.Store == nil {
		return core.ToolResult{}, fmt.Errorf("widget store unavailable")
	}
	files := append([]WidgetFile(nil), t.Store.ListWidgets()...)
	sort.Slice(files, func(i, j int) bool { return files[i].ID < files[j].ID })

	var b strings.Builder
	fmt.Fprintf(&b, "widgets (%d entr%s)\n", len(files), map[bool]string{true: "y", false: "ies"}[len(files) == 1])
	if len(files) == 0 {
		b.WriteString("  (none — create one with widget_set)\n")
	}
	for _, f := range files {
		lines := strings.Count(f.Source, "\n")
		if f.Source != "" && !strings.HasSuffix(f.Source, "\n") {
			lines++
		}
		mtime := ""
		if f.UpdatedAt > 0 {
			mtime = ", " + time.UnixMilli(f.UpdatedAt).Format("2006-01-02 15:04")
		}
		ph := ""
		if f.Placeholder != "" {
			ph = fmt.Sprintf(", %q", f.Placeholder)
		}
		fmt.Fprintf(&b, "  %s (%s, %d lines%s%s)\n", f.ID, humanBytes(int64(len(f.Source))), lines, ph, mtime)
	}
	attrs := []core.Attr{{Key: "total", Value: fmt.Sprintf("%d", len(files))}}
	if len(files) == 0 {
		attrs = append(attrs, core.Attr{Key: "info", Value: "no widgets"})
	}
	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: b.String()}},
		Attrs:   attrs,
		Details: map[string]any{"display": b.String(), "total": len(files)},
	}, nil
}

/* ---------------- widget_lint ---------------- */

// WidgetLintTool re-runs the gateway lint for a stored widget (optionally
// with extra test code) without re-storing it.
type WidgetLintTool struct {
	Store WidgetStore
	Lint  WidgetLintFunc
}

type widgetLintArgs struct {
	ID    string `json:"id"`
	Test  string `json:"test"`
	State string `json:"state"`
}

func (t *WidgetLintTool) Name() string { return "widget_lint" }
func (t *WidgetLintTool) Description() string {
	return "Lint a stored widget without re-storing it: compile, import audit, smoke render at the gateway. Pass optional `test` code (TSX) that imports the widget module with `import { … } from \"widget\"` and asserts on its exported logic — export the functions/components under test from the widget source (the module may have named exports besides the default `App`). Throwing an error fails the lint; a pass proves the logic works before the widget is shown. Use this after widget_set to verify the widget is safe to show."
}
func (t *WidgetLintTool) Schema() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"id":{"type":"string","description":"Widget id to lint"},"test":{"type":"string","description":"Optional test code (TSX). It runs in the same sandbox and imports the widget module as \\\"widget\\\" — the widget must export the functions/components under test (named exports besides the default App). Throwing an error fails the lint."},"state":{"type":"string","description":"Optional state JSON to render with (defaults to the state the source or the fence carries)"}},"required":["id"]}`)
}

func (t *WidgetLintTool) Execute(ctx context.Context, raw json.RawMessage, progress func(string)) (core.ToolResult, error) {
	var a widgetLintArgs
	if err := unmarshalArgs(raw, &a); err != nil {
		return core.ToolResult{}, fmt.Errorf("invalid args: %w", err)
	}
	if err := checkWidgetID(a.ID); err != nil {
		return core.ToolResult{}, err
	}
	if t.Store == nil {
		return core.ToolResult{}, fmt.Errorf("widget store unavailable")
	}
	file, ok := t.Store.GetWidget(a.ID)
	if !ok {
		return core.ToolResult{}, fmt.Errorf("widget %q not found", a.ID)
	}
	res := runWidgetLint(ctx, t.Lint, a.ID, file.Source, a.Test, a.State)
	text := renderWidgetLintText(res, a.ID)
	if progress != nil {
		progress(text)
	}
	attrs := []core.Attr{
		{Key: "path", Value: a.ID},
		{Key: "ok", Value: fmt.Sprintf("%t", res.OK || res.Skipped)},
	}
	if !res.OK && !res.Skipped {
		attrs = append(attrs, core.Attr{Key: "warning", Value: fmt.Sprintf("lint failed (%d error(s))", len(res.Errors))})
	}
	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: text}},
		Attrs:   attrs,
		Details: map[string]any{"display": text, "id": a.ID, "lint_ok": res.OK || res.Skipped, "lint": res},
	}, nil
}

/* ---------------- widget_read (talk mode) ---------------- */

// WidgetReadTool reads a stored widget's source with the exact read-tool
// pagination contract (offset/limit, 2000-line / 50KB window). It resolves
// the source by widget id from the session store — no workspace path, no
// change-tracking balloons.
type WidgetReadTool struct {
	Store WidgetStore
}

type widgetReadArgs struct {
	ID     string `json:"id"`
	Offset int    `json:"offset,omitempty"`
	Limit  int    `json:"limit,omitempty"`
}

func (t *WidgetReadTool) Name() string { return "widget_read" }
func (t *WidgetReadTool) Description() string {
	return "Read the TSX source of a stored widget by id (same pagination as read: output truncated to 2000 lines or 50KB, use offset/limit for large sources). The source is the module stored with widget_set — the transcript fence only links the widget by `widget_id:`."
}
func (t *WidgetReadTool) Schema() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"id":{"type":"string","description":"Widget id to read"},"offset":{"type":"integer","description":"Line number to start reading from (1-indexed)"},"limit":{"type":"integer","description":"Maximum number of lines to read"}},"required":["id"]}`)
}

func (t *WidgetReadTool) Execute(ctx context.Context, raw json.RawMessage, progress func(string)) (core.ToolResult, error) {
	var a widgetReadArgs
	if err := unmarshalArgs(raw, &a); err != nil {
		return core.ToolResult{}, fmt.Errorf("invalid args: %w", err)
	}
	if err := checkWidgetID(a.ID); err != nil {
		return core.ToolResult{}, err
	}
	if t.Store == nil {
		return core.ToolResult{}, fmt.Errorf("widget store unavailable")
	}
	file, ok := t.Store.GetWidget(a.ID)
	if !ok {
		return core.ToolResult{}, fmt.Errorf("widget %q not found", a.ID)
	}

	textContent := file.Source
	allLines := splitLinesForCounting(textContent)
	totalFileLines := len(allLines)

	if a.Limit < 0 {
		return core.ToolResult{}, fmt.Errorf("limit must be a positive number of lines")
	}
	startLine := 0
	if a.Offset > 0 {
		startLine = a.Offset - 1
	}
	startLineDisplay := startLine + 1
	if totalFileLines == 0 {
		if a.Offset > 1 {
			return core.ToolResult{}, fmt.Errorf("Offset %d is beyond end of widget (0 lines total)", a.Offset)
		}
	} else if startLine >= totalFileLines {
		return core.ToolResult{}, fmt.Errorf("Offset %d is beyond end of widget (%d lines total)", a.Offset, totalFileLines)
	}

	var selectedContent string
	userLimitedLines := 0
	userLimited := false
	reachedEOF := true
	if a.Limit != 0 {
		endLine := startLine + a.Limit
		if endLine > totalFileLines {
			endLine = totalFileLines
		}
		if endLine < startLine {
			endLine = startLine
		}
		selectedContent = strings.Join(allLines[startLine:endLine], "\n")
		userLimitedLines = endLine - startLine
		userLimited = true
		reachedEOF = endLine == totalFileLines
	} else {
		selectedContent = strings.Join(allLines[startLine:], "\n")
	}
	if reachedEOF && strings.HasSuffix(textContent, "\n") {
		selectedContent += "\n"
	}

	truncation := truncateHead(selectedContent, defaultMaxLines, defaultMaxBytes)
	var outputText string
	var attrs []core.Attr
	switch {
	case truncation.firstLineExceeds:
		head := truncateStringToBytesFromStart(allLines[startLine], defaultMaxBytes)
		outputText = head
		attrs = append(attrs,
			core.Attr{Key: "line", Value: fmt.Sprintf("%d", startLineDisplay)},
			core.Attr{Key: "line_size", Value: formatSize(len(allLines[startLine]))},
			core.Attr{Key: "shown", Value: formatSize(len(head))},
			core.Attr{Key: "next_byte", Value: fmt.Sprintf("%d", len(head)+1)},
			core.Attr{Key: "truncated", Value: "true"},
		)
	case truncation.truncated:
		endLineDisplay := startLineDisplay + truncation.outputLines - 1
		nextOffset := endLineDisplay + 1
		outputText = truncation.content
		attrs = append(attrs,
			core.Attr{Key: "page", Value: fmt.Sprintf("%d-%d/%d", startLineDisplay, endLineDisplay, totalFileLines)},
			core.Attr{Key: "next", Value: fmt.Sprintf("%d", nextOffset)},
			core.Attr{Key: "truncated", Value: "true"},
		)
	case userLimited && startLine+userLimitedLines < totalFileLines:
		nextOffset := startLine + userLimitedLines + 1
		outputText = truncation.content
		attrs = append(attrs,
			core.Attr{Key: "page", Value: fmt.Sprintf("%d-%d/%d", startLineDisplay, startLine+userLimitedLines, totalFileLines)},
			core.Attr{Key: "next", Value: fmt.Sprintf("%d", nextOffset)},
		)
	default:
		outputText = truncation.content
		if totalFileLines > 0 {
			attrs = append(attrs, core.Attr{Key: "page", Value: fmt.Sprintf("%d-%d/%d", startLineDisplay, totalFileLines, totalFileLines)})
		}
	}

	display := (&ReadTool{}).renderDisplay(allLines, startLine, &truncation, userLimited, userLimitedLines)
	if progress != nil {
		progress(display)
	}
	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: outputText}},
		Attrs:   attrs,
		Details: map[string]any{
			"display":         display,
			"path":            a.ID,
			"id":              a.ID,
			"start_line":      startLine + 1,
			"lines_truncated": truncation.truncated && truncation.truncatedBy == "lines",
			"bytes_truncated": truncation.truncated && truncation.truncatedBy == "bytes",
			"total_lines":     totalFileLines,
		},
	}, nil
}

/* ---------------- widget_edit (talk mode) ---------------- */

// WidgetEditTool edits a stored widget's source with the exact edit-tool
// contract (exact old_text/new_text replacements, fuzzy fallback, unified
// diff display) — but against the session widget store, not a file.
type WidgetEditTool struct {
	Store WidgetStore
}

type widgetEditArgs struct {
	ID    string     `json:"id"`
	Edits []textEdit `json:"edits"`
}

func (t *WidgetEditTool) Name() string { return "widget_edit" }
func (t *WidgetEditTool) Description() string {
	return "Edit a stored widget's TSX source by id using exact text replacement (same contract as edit: every old_text must match a unique, non-overlapping region; merge nearby changes into one edit). This is the PREFERRED way to change an existing widget — much cheaper than re-sending the whole source with widget_set. The diff is shown on the tool body only — widget edits never produce change balloons."
}
func (t *WidgetEditTool) Schema() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"id":{"type":"string","description":"Widget id to edit"},"edits":{"type":"array","description":"One or more targeted replacements. Each edit is matched against the current source, not incrementally. Do not include overlapping or nested edits.","items":{"type":"object","properties":{"old_text":{"type":"string","description":"Exact text for one targeted replacement. It must be unique in the current source and must not overlap with any other edits[].old_text in the same call."},"new_text":{"type":"string","description":"Replacement text for this targeted edit."}},"required":["old_text","new_text"]}}},"required":["id","edits"]}`)
}

func (t *WidgetEditTool) Execute(ctx context.Context, raw json.RawMessage, progress func(string)) (core.ToolResult, error) {
	var a widgetEditArgs
	if err := unmarshalArgs(raw, &a); err != nil {
		return core.ToolResult{}, fmt.Errorf("invalid args: %w", err)
	}
	if err := checkWidgetID(a.ID); err != nil {
		return core.ToolResult{}, err
	}
	if len(a.Edits) == 0 {
		return core.ToolResult{}, fmt.Errorf("Edit tool input is invalid. edits must contain at least one replacement.")
	}
	if t.Store == nil {
		return core.ToolResult{}, fmt.Errorf("widget store unavailable")
	}
	file, ok := t.Store.GetWidget(a.ID)
	if !ok {
		return core.ToolResult{}, fmt.Errorf("widget %q not found", a.ID)
	}

	content := file.Source
	if strings.HasPrefix(content, "\uFEFF") {
		content = content[len("\uFEFF"):]
	}
	baseContent, newContent, err := applyEditsToNormalizedContent(content, a.Edits, a.ID)
	if err != nil {
		return core.ToolResult{}, err
	}

	finalContent := newContent
	if err := t.Store.SetWidget(WidgetFile{
		ID:          a.ID,
		Source:      finalContent,
		Placeholder: widgetPlaceholder(finalContent),
		Size:        len(finalContent),
		UpdatedAt:   time.Now().UnixMilli(),
	}); err != nil {
		return core.ToolResult{}, err
	}

	display := (&EditTool{}).renderDisplay(a.ID, baseContent, newContent, len(a.Edits))
	if progress != nil {
		progress(display)
	}
	return core.ToolResult{
		Attrs: []core.Attr{
			{Key: "info", Value: fmt.Sprintf("Successfully replaced %d block(s) in %s.", len(a.Edits), a.ID)},
			{Key: "path", Value: a.ID},
			{Key: "edits", Value: fmt.Sprintf("%d", len(a.Edits))},
		},
		Details: map[string]any{
			"display": display,
			"diff":    DiffText(baseContent, newContent),
			"path":    a.ID,
			"id":      a.ID,
			"files":   []string{a.ID},
			"edits":   len(a.Edits),
			"dry_run": false,
		},
	}, nil
}
