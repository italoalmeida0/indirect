package main

import (
	"encoding/json"
	"strings"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/core"
)

func TestWidgetToolPayloadsPerMode(t *testing.T) {
	for _, mode := range []string{"build", "plan", "learning", "talk"} {
		allowSrc := mode != "talk"
		modeReg := core.Registry{}
		for _, name := range modeTools[mode] {
			switch name {
			case "widget_set":
				modeReg[name] = &tools.WidgetSetTool{AllowSrcFile: allowSrc}
			case "widget_list":
				modeReg[name] = &tools.WidgetListTool{}
			case "widget_lint":
				modeReg[name] = &tools.WidgetLintTool{}
			case "widget_read":
				modeReg[name] = &tools.WidgetReadTool{}
			case "widget_edit":
				modeReg[name] = &tools.WidgetEditTool{}
			}
		}
		t.Logf("=== mode %-8s", mode)
		for _, name := range modeTools[mode] {
			tool, ok := modeReg[name]
			if !ok {
				continue
			}
			var schema map[string]any
			if err := json.Unmarshal(tool.Schema(), &schema); err != nil {
				t.Fatalf("%s/%s schema INVALID JSON: %v", mode, name, err)
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
