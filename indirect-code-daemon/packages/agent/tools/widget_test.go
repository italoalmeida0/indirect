package tools

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// fakeWidgetStore is the WidgetStore the widget tools talk to (the daemon
// wires the session actor behind this interface).
type fakeWidgetStore struct {
	files map[string]WidgetFile
}

func newFakeWidgetStore() *fakeWidgetStore {
	return &fakeWidgetStore{files: map[string]WidgetFile{}}
}

func (s *fakeWidgetStore) ListWidgets() []WidgetFile {
	out := make([]WidgetFile, 0, len(s.files))
	for _, f := range s.files {
		out = append(out, f)
	}
	return out
}

func (s *fakeWidgetStore) GetWidget(id string) (WidgetFile, bool) {
	f, ok := s.files[id]
	return f, ok
}

func (s *fakeWidgetStore) SetWidget(f WidgetFile) error {
	s.files[f.ID] = f
	return nil
}

func (s *fakeWidgetStore) DeleteWidget(id string) error {
	delete(s.files, id)
	return nil
}

func lintOK(context.Context, string, string, string, string) (WidgetLintResult, error) {
	return WidgetLintResult{OK: true, DurationMs: 1}, nil
}

func lintFail(context.Context, string, string, string, string) (WidgetLintResult, error) {
	return WidgetLintResult{Errors: []WidgetLintError{{Phase: "render", Message: "boom"}}}, nil
}

func runSet(t *testing.T, tool *WidgetSetTool, args map[string]any) core.ToolResult {
	t.Helper()
	raw, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	res, err := tool.Execute(context.Background(), raw, nil)
	if err != nil {
		t.Fatalf("widget_set(%v): %v", args, err)
	}
	return res
}

func TestWidgetSetStoresSourceAndLints(t *testing.T) {
	store := newFakeWidgetStore()
	tool := &WidgetSetTool{Store: store, Lint: lintOK, AllowSrcFile: true}
	res := runSet(t, tool, map[string]any{
		"id":      "savings",
		"content": "export default function App() { return null; }\n",
	})
	// The model gets the lint verdict; the numbered source goes to the
	// frontend body via Details.display (same split as write).
	if !strings.Contains(widgetText(res), "LINT OK") {
		t.Fatalf("expected lint verdict in content, got %q", widgetText(res))
	}
	if !strings.Contains(detailsMap(res)["display"].(string), "1:") {
		t.Fatalf("expected numbered display, got %q", detailsMap(res)["display"])
	}
	f, ok := store.GetWidget("savings")
	if !ok || f.Source == "" {
		t.Fatal("widget not stored")
	}
	if f.Size != len(f.Source) {
		t.Fatalf("size %d != %d", f.Size, len(f.Source))
	}
	if detailsMap(res)["lint_ok"] != true {
		t.Fatalf("lint_ok = %v", detailsMap(res)["lint_ok"])
	}
}

func TestWidgetSetRejectsBadID(t *testing.T) {
	tool := &WidgetSetTool{Store: newFakeWidgetStore(), Lint: lintOK}
	for _, id := range []string{"", "with space", "slash/evil", strings.Repeat("x", 65)} {
		if _, err := tool.Execute(context.Background(), json.RawMessage(`{"id":"`+id+`","content":"x"}`), nil); err == nil {
			t.Fatalf("id %q should be rejected", id)
		}
	}
}

func TestWidgetSetRequiresContentXorSrcFile(t *testing.T) {
	tool := &WidgetSetTool{Store: newFakeWidgetStore(), Lint: lintOK, AllowSrcFile: true, Sandbox: &Sandbox{}, CWD: t.TempDir()}
	if _, err := tool.Execute(context.Background(), json.RawMessage(`{"id":"w"}`), nil); err == nil {
		t.Fatal("empty content should fail")
	}
	if _, err := tool.Execute(context.Background(), json.RawMessage(`{"id":"w","content":"a","src_file":"b.tsx"}`), nil); err == nil {
		t.Fatal("content+src_file should fail")
	}
}

func TestWidgetSetSrcFileRejectedInTalk(t *testing.T) {
	tool := &WidgetSetTool{Store: newFakeWidgetStore(), Lint: lintOK, AllowSrcFile: false, Sandbox: &Sandbox{}, CWD: t.TempDir()}
	_, err := tool.Execute(context.Background(), json.RawMessage(`{"id":"w","src_file":"a.tsx"}`), nil)
	if err == nil || !strings.Contains(err.Error(), "src_file") {
		t.Fatalf("expected src_file rejection, got %v", err)
	}
}

func TestWidgetSetStripsPastedFence(t *testing.T) {
	store := newFakeWidgetStore()
	tool := &WidgetSetTool{Store: store, Lint: lintOK}
	runSet(t, tool, map[string]any{
		"id": "w",
		"content": "```generative_ui\nplaceholder: Hi\nstate: {}\n@jsx\nexport default function App() { return null; }\n```",
	})
	f, _ := store.GetWidget("w")
	if strings.Contains(f.Source, "```") || strings.Contains(f.Source, "@jsx") || strings.Contains(f.Source, "placeholder:") {
		t.Fatalf("fence noise not stripped: %q", f.Source)
	}
	if !strings.Contains(f.Source, "export default function App") {
		t.Fatalf("source lost: %q", f.Source)
	}
}

func TestWidgetSetLintsBeforeStoring(t *testing.T) {
	store := newFakeWidgetStore()
	tool := &WidgetSetTool{Store: store, Lint: lintFail}
	res := runSet(t, tool, map[string]any{"id": "w", "content": "export default function App() { return null; }"})
	if detailsMap(res)["lint_ok"] != false {
		t.Fatal("expected lint_ok false")
	}
	if _, ok := store.GetWidget("w"); !ok {
		t.Fatal("widget must still be stored (with the lint warning)")
	}
	foundWarning := false
	for _, a := range res.Attrs {
		if a.Key == "warning" {
			foundWarning = true
		}
	}
	if !foundWarning {
		t.Fatal("expected warning attr on lint failure")
	}
}

func TestWidgetSetDelete(t *testing.T) {
	store := newFakeWidgetStore()
	tool := &WidgetSetTool{Store: store, Lint: lintOK}
	runSet(t, tool, map[string]any{"id": "w", "content": "x"})
	runSet(t, tool, map[string]any{"id": "w", "delete": true})
	if _, ok := store.GetWidget("w"); ok {
		t.Fatal("widget should be deleted")
	}
	if _, err := tool.Execute(context.Background(), json.RawMessage(`{"id":"w","delete":true}`), nil); err == nil {
		t.Fatal("deleting a missing widget should fail")
	}
}

func TestWidgetListRendersTree(t *testing.T) {
	store := newFakeWidgetStore()
	set := &WidgetSetTool{Store: store, Lint: lintOK}
	runSet(t, set, map[string]any{"id": "beta", "content": "export default function App() { return null; }"})
	runSet(t, set, map[string]any{"id": "alpha", "content": "line1\nline2\n"})
	res, err := (&WidgetListTool{Store: store}).Execute(context.Background(), json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	text := widgetText(res)
	if !strings.HasPrefix(text, "widgets (2 entries)") {
		t.Fatalf("inspect-style header missing: %q", text)
	}
	if strings.Index(text, "alpha") > strings.Index(text, "beta") {
		t.Fatal("entries must be sorted by id")
	}
}

func TestWidgetReadPagination(t *testing.T) {
	store := newFakeWidgetStore()
	var sb strings.Builder
	for i := 1; i <= 5; i++ {
		sb.WriteString("line\n")
	}
	store.SetWidget(WidgetFile{ID: "w", Source: sb.String()})
	tool := &WidgetReadTool{Store: store}

	res, err := tool.Execute(context.Background(), json.RawMessage(`{"id":"w","offset":2,"limit":2}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	// Content is the raw page for the model (read contract); the numbered
	// render is the frontend body (Details.display).
	if widgetText(res) != "line\nline" {
		t.Fatalf("page body wrong: %q", widgetText(res))
	}
	// The numbered body keeps REAL line numbers (2: 3: for an offset-2 page).
	if !strings.Contains(detailsMap(res)["display"].(string), "2:line\n3:line\n") {
		t.Fatalf("numbered display missing: %q", detailsMap(res)["display"])
	}
	attrs := attrMap(res)
	if attrs["page"] != "2-3/5" {
		t.Fatalf("page attr = %q", attrs["page"])
	}
	if attrs["next"] != "4" {
		t.Fatalf("next attr = %q", attrs["next"])
	}

	if _, err := tool.Execute(context.Background(), json.RawMessage(`{"id":"w","offset":9}`), nil); err == nil {
		t.Fatal("offset beyond EOF must fail")
	}
	if _, err := tool.Execute(context.Background(), json.RawMessage(`{"id":"missing"}`), nil); err == nil {
		t.Fatal("missing widget must fail")
	}
}

func TestWidgetEditReplacesAndReportsDiff(t *testing.T) {
	store := newFakeWidgetStore()
	store.SetWidget(WidgetFile{ID: "w", Source: "const a = 1;\nconst b = 2;\n"})
	tool := &WidgetEditTool{Store: store}
	raw := json.RawMessage(`{"id":"w","edits":[{"old_text":"const a = 1;","new_text":"const a = 42;"}]}`)
	res, err := tool.Execute(context.Background(), raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	f, _ := store.GetWidget("w")
	if !strings.Contains(f.Source, "const a = 42;") {
		t.Fatalf("edit not applied: %q", f.Source)
	}
	details := detailsMap(res)
	if details["path"] != "w" || details["id"] != "w" {
		t.Fatalf("details = %v", details)
	}
	diff, _ := details["diff"].(string)
	if !strings.Contains(diff, "-const a = 1;") || !strings.Contains(diff, "+const a = 42;") {
		t.Fatalf("diff = %q", diff)
	}
}

func TestWidgetLintToolUsesStore(t *testing.T) {
	store := newFakeWidgetStore()
	store.SetWidget(WidgetFile{ID: "w", Source: "export default function App() { return null; }"})
	ok, err := (&WidgetLintTool{Store: store, Lint: lintOK}).Execute(context.Background(), json.RawMessage(`{"id":"w","test":"import \"widget\";"}`), nil)
	if err != nil || detailsMap(ok)["lint_ok"] != true {
		t.Fatalf("lint ok expected: %v %v", ok, err)
	}
	bad, err := (&WidgetLintTool{Store: store, Lint: lintFail}).Execute(context.Background(), json.RawMessage(`{"id":"w"}`), nil)
	if err != nil || detailsMap(bad)["lint_ok"] != false {
		t.Fatalf("lint fail expected: %v %v", bad, err)
	}
	if !strings.Contains(widgetText(bad), "LINT FAILED") {
		t.Fatalf("text = %q", widgetText(bad))
	}
}

func TestWidgetLintSkippedWithoutGateway(t *testing.T) {
	store := newFakeWidgetStore()
	store.SetWidget(WidgetFile{ID: "w", Source: "x"})
	res, err := (&WidgetLintTool{Store: store}).Execute(context.Background(), json.RawMessage(`{"id":"w"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(widgetText(res), "lint skipped") {
		t.Fatalf("text = %q", widgetText(res))
	}
}

// widgetText pulls the plain text of a tool result body.
func widgetText(res core.ToolResult) string {
	var sb strings.Builder
	for _, c := range res.Content {
		if tb, ok := c.(provider.TextBlock); ok {
			sb.WriteString(tb.Text)
		}
	}
	return sb.String()
}

// detailsMap pulls the frontend Details map off a tool result.
func detailsMap(res core.ToolResult) map[string]any {
	m, _ := res.Details.(map[string]any)
	return m
}

func attrMap(res core.ToolResult) map[string]string {
	out := map[string]string{}
	for _, a := range res.Attrs {
		out[a.Key] = a.Value
	}
	return out
}
