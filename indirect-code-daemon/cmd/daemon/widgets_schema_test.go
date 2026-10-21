package main

import (
	"encoding/json"
	"strings"
	"testing"

	"indirect/indirect-code-daemon/packages/agent/tools"
	"indirect/indirect-code-daemon/packages/core"
	"indirect/indirect-code-daemon/packages/skills"
)

func TestWidgetToolPayloadsPerMode(t *testing.T) {
	// Which widget tools belong to which delivery context is decided by
	// the BUILTIN SKILL FILES (their permissions entries grant the tools),
	// not by hardcoded lists in Go: load the embedded JS set and validate
	// the schemas of exactly the tools each skill grants.
	builtins, errs := builtinSkills()
	if len(errs) > 0 {
		t.Fatalf("builtin parse errors: %v", errs)
	}
	for _, skillFile := range []string{"generative_ui_agentic", "generative_ui_talk"} {
		sk, ok := builtins[skillFile]
		if !ok {
			t.Fatalf("builtin %q missing", skillFile)
		}
		modeReg := core.Registry{}
		for name, spec := range sk.Permissions {
			if spec.Policy == skills.PolicyDeny {
				continue
			}
			switch name {
			case "widget_set":
				// Only the agentic delivery touches workspace files.
				modeReg[name] = &tools.WidgetSetTool{AllowSrcFile: sk.Mode != "talk"}
			case "widget_list":
				modeReg[name] = &tools.WidgetListTool{}
			case "widget_lint":
				modeReg[name] = &tools.WidgetLintTool{}
			case "widget_read":
				modeReg[name] = &tools.WidgetReadTool{}
			case "widget_edit":
				modeReg[name] = &tools.WidgetEditTool{}
			default:
				t.Errorf("%s grants non-widget tool %q", skillFile, name)
			}
		}
		t.Logf("=== %s (%s)", skillFile, sk.Mode)
		for name := range modeReg {
			tool, ok := modeReg[name]
			if !ok {
				continue
			}
			var schema map[string]any
			if err := json.Unmarshal(tool.Schema(), &schema); err != nil {
				t.Fatalf("%s/%s schema INVALID JSON: %v", skillFile, name, err)
			}
			props, _ := schema["properties"].(map[string]any)
			req, _ := schema["required"].([]any)
			keys := []string{}
			for k := range props {
				keys = append(keys, k)
			}
			t.Logf("  %-13s props=%v required=%v", name, keys, req)
		}
	}
	// Regression guards (the exact confusion the AI hit):
	lint := &tools.WidgetLintTool{}
	var lintSchema map[string]any
	_ = json.Unmarshal(lint.Schema(), &lintSchema)
	props := lintSchema["properties"].(map[string]any)
	if _, ok := props["id"]; !ok {
		t.Fatal("widget_lint schema must expose id")
	}
	if _, ok := props["test"]; !ok {
		t.Fatal("widget_lint schema must expose test")
	}
	req := lintSchema["required"].([]any)
	if len(req) != 1 || req[0] != "id" {
		t.Fatalf("widget_lint required = %v", req)
	}
	list := &tools.WidgetListTool{}
	var listSchema map[string]any
	_ = json.Unmarshal(list.Schema(), &listSchema)
	lp, _ := listSchema["properties"].(map[string]any)
	if len(lp) != 0 {
		t.Fatalf("widget_list must take NO properties, got %v", lp)
	}
	talk := &tools.WidgetSetTool{AllowSrcFile: false}
	build := &tools.WidgetSetTool{AllowSrcFile: true}
	if strings.Contains(string(talk.Schema()), "src_file") {
		t.Fatal("talk widget_set must not expose src_file")
	}
	if !strings.Contains(string(build.Schema()), "src_file") {
		t.Fatal("build widget_set must expose src_file")
	}
}
