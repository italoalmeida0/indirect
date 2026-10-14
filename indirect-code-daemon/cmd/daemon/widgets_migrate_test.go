package main

import (
	"strings"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Legacy generative_ui fences are converted at load time (no legacy
// runtime): `@jsx` bodies become plain ```jsx code fences, the oldest
// headerless shape is dropped, current `widget_id:` fences are untouched,
// and a first-cut `id:` header is renamed to `widget_id:`.
func TestMigrateLegacyWidgets(t *testing.T) {
	rec := &SessionRecord{
		ID: "s",
		Messages: []provider.Message{
			{Role: provider.RoleAssistant, Content: []provider.Content{
				provider.TextBlock{Text: `before

` + "```" + `generative_ui
placeholder: Old widget
state: {"a": 1}
@jsx
export default function App() { return null; }
` + "```" + `

middle

` + "```" + `generative_ui
placeholder: Very old
` + "```" + `

after

` + "````" + `generative_ui
placeholder: Current
state: {"b": 2}
widget_id: live
` + "````" + `

end`},
			}},
		},
	}
	if !migrateLegacyWidgets(rec) {
		t.Fatal("expected migration to change the transcript")
	}
	tb := rec.Messages[0].Content[0].(provider.TextBlock).Text

	// Legacy @jsx fence → plain ```jsx code fence (headers dropped).
	if strings.Contains(tb, "@jsx") {
		t.Fatal("@jsx marker must be gone")
	}
	if !strings.Contains(tb, "```jsx\nexport default function App() { return null; }\n```") {
		t.Fatalf("legacy fence not converted to jsx fence:\n%s", tb)
	}
	if strings.Contains(tb, "placeholder: Old widget") {
		t.Fatal("legacy fence headers must be dropped with the fence")
	}

	// Oldest headerless fence → dropped entirely.
	if strings.Contains(tb, "Very old") {
		t.Fatalf("headerless fence must be dropped:\n%s", tb)
	}

	// Current widget_id fence → untouched.
	if !strings.Contains(tb, "````generative_ui\nplaceholder: Current\nstate: {\"b\": 2}\nwidget_id: live\n````") {
		t.Fatalf("current fence must be untouched:\n%s", tb)
	}
}

// A first-cut fence using the `id:` header is renamed to `widget_id:` so
// every fence names the store link the same way.
func TestMigrateLegacyWidgetsRenamesBareIDHeader(t *testing.T) {
	rec := &SessionRecord{ID: "s", Messages: []provider.Message{
		{Role: provider.RoleAssistant, Content: []provider.Content{
			provider.TextBlock{Text: "````generative_ui\nplaceholder: P\nid: savings\n````"},
		}},
	}}
	if !migrateLegacyWidgets(rec) {
		t.Fatal("expected rename")
	}
	tb := rec.Messages[0].Content[0].(provider.TextBlock).Text
	if !strings.Contains(tb, "widget_id: savings") || strings.Contains(tb, "\nid:") {
		t.Fatalf("id: header must be renamed to widget_id:: %q", tb)
	}
}

func TestMigrateLegacyWidgetsNoopOnCleanTranscript(t *testing.T) {
	rec := &SessionRecord{ID: "s", Messages: []provider.Message{
		{Role: provider.RoleAssistant, Content: []provider.Content{
			provider.TextBlock{Text: "just text\n```go\nfmt.Println()\n```"},
		}},
	}}
	if migrateLegacyWidgets(rec) {
		t.Fatal("clean transcript must not change")
	}
}

func TestMigrateLegacyWidgetsUnclosedFence(t *testing.T) {
	rec := &SessionRecord{ID: "s", Messages: []provider.Message{
		{Role: provider.RoleAssistant, Content: []provider.Content{
			provider.TextBlock{Text: "text\n```generative_ui\n@jsx\nexport default function App() { return null; }"},
		}},
	}}
	if !migrateLegacyWidgets(rec) {
		t.Fatal("expected change")
	}
	tb := rec.Messages[0].Content[0].(provider.TextBlock).Text
	if strings.Contains(tb, "@jsx") {
		t.Fatal("@jsx must be gone even when unclosed")
	}
	if !strings.Contains(tb, "```jsx\nexport default function App() { return null; }") {
		t.Fatalf("body must survive: %q", tb)
	}
}
