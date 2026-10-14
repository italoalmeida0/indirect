package tools

import (
	"encoding/json"
	"testing"
)

// Schema audit: every tool's json.RawMessage schema must be valid JSON, be
// an object schema, and have `required` keys that actually exist in
// `properties`. This pins the class of bug where a raw-string literal
// silently goes invalid (a Go raw string cannot contain backticks, and a
// broken schema only surfaces at the provider API). Schema() never touches
// the sandbox/hosts, so nil is fine for the tools that carry one.
func TestToolSchemasAreValidJSON(t *testing.T) {
	tools := []interface{ Schema() json.RawMessage }{
		&BashTool{},
		&ReadTool{},
		&WriteTool{},
		&EditTool{},
		&GlobTool{},
		&SearchTool{},
		&InspectTool{},
		&SearchWebTool{},
		&FetchURLTool{},
		&PythonTool{},
		&FinishEntireRequestTool{},
		&SummaryTool{},
		&TodoTool{},
		&QuestionTool{},
		&BgCancelTool{},
		&BgAwaitTool{},
		&BgCheckTool{},
		&WidgetSetTool{},
		&WidgetListTool{},
		&WidgetLintTool{},
		&WidgetReadTool{},
		&WidgetEditTool{},
	}
	for _, tool := range tools {
		raw := tool.Schema()
		if !json.Valid(raw) {
			t.Fatalf("%T schema is not valid JSON: %s", tool, raw)
		}
		var shape struct {
			Type       string                     `json:"type"`
			Properties map[string]json.RawMessage `json:"properties"`
			Required   []string                   `json:"required"`
		}
		if err := json.Unmarshal(raw, &shape); err != nil {
			t.Fatalf("%T schema does not unmarshal: %v", tool, err)
		}
		if shape.Type != "" && shape.Type != "object" {
			t.Fatalf("%T schema type %q: tools take one JSON object", tool, shape.Type)
		}
		for _, req := range shape.Required {
			if _, ok := shape.Properties[req]; !ok {
				t.Fatalf("%T schema requires %q but does not declare it in properties", tool, req)
			}
		}
		for name := range shape.Properties {
			if name == "" {
				t.Fatalf("%T schema has an empty property name", tool)
			}
		}
	}
}

// The widget_set schema has two variants (talk omits src_file); both must
// declare the shared keys and stay valid — a raw-string edit can break one
// branch without touching the other.
func TestWidgetSetSchemaVariants(t *testing.T) {
	for _, allow := range []bool{true, false} {
		raw := (&WidgetSetTool{AllowSrcFile: allow}).Schema()
		if !json.Valid(raw) {
			t.Fatalf("AllowSrcFile=%v schema invalid: %s", allow, raw)
		}
		var shape struct {
			Properties map[string]json.RawMessage `json:"properties"`
			Required   []string                   `json:"required"`
		}
		if err := json.Unmarshal(raw, &shape); err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{"id", "content", "state", "delete"} {
			if _, ok := shape.Properties[key]; !ok {
				t.Fatalf("AllowSrcFile=%v schema missing %q", allow, key)
			}
		}
		if _, ok := shape.Properties["src_file"]; ok != allow {
			t.Fatalf("AllowSrcFile=%v schema src_file presence = %v", allow, ok)
		}
		for _, req := range shape.Required {
			if _, ok := shape.Properties[req]; !ok {
				t.Fatalf("AllowSrcFile=%v requires undeclared %q", allow, req)
			}
		}
	}
}
