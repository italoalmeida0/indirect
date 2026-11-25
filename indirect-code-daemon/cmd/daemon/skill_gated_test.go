package main

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"indirect/indirect-code-daemon/packages/agent/tools"
	"indirect/indirect-code-daemon/packages/core"
	"indirect/indirect-code-daemon/packages/provider"
	"indirect/indirect-code-daemon/packages/skills"
)

func installGatedGenUITestStore(t *testing.T) {
	t.Helper()
	prev := skillRegistry()
	ask := skills.PermSpec{Policy: skills.PolicyAsk}
	yolo := skills.PermSpec{Policy: skills.PolicyYolo}
	deny := skills.PermSpec{Policy: skills.PolicyDeny}
	swapSkillRegistry(&skillStore{list: map[string]skills.Skill{
		"talk": {
			Name:        "talk",
			Description: "Talk mode",
			Mode:        "talk",
			Usable:      "deny",
			Provides:    []string{"generative_ui", "generative_ui_talk"},
			Permissions: map[string]skills.PermSpec{
				"widget_set":  {Policy: skills.PolicyYolo, Args: map[string]skills.Policy{"src_file": skills.PolicyDeny}},
				"widget_list": yolo,
				"widget_lint": yolo,
				"widget_read": yolo,
				"widget_edit": yolo,
			},
			Body: "TALK BODY",
		},
		"build": {
			Name:        "build",
			Description: "Build mode",
			Mode:        "agentic",
			Usable:      "deny",
			Permissions: map[string]skills.PermSpec{
				"read": ask, "write": ask, "edit": ask, "bash": ask,
				"question": yolo, "todo": yolo, "session_history": yolo,
			},
			Body: "BUILD BODY",
		},
		"generative_ui_agentic": {
			Name:        "generative_ui_agentic",
			Description: "Interactive widgets for agentic sessions",
			Mode:        "agentic",
			Usable:      "yolo",
			Provides:    []string{"generative_ui", "generative_ui_agentic"},
			Permissions: map[string]skills.PermSpec{
				"widget_set":  yolo,
				"widget_list": yolo,
				"widget_lint": yolo,
				"widget_read": deny,
				"widget_edit": deny,
			},
			Body: "GENUI AGENTIC BODY",
		},
		"genui_games": {
			Name:        "genui_games",
			Description: "2D and 3D games craft",
			Mode:        "talk",
			Usable:      "yolo",
			Requires:    []string{"generative_ui_talk"},
			Body:        "GENUI GAMES BODY",
		},
		"genui_visualizers": {
			Name:        "genui_visualizers",
			Description: "Technical and scientific visualizers",
			Usable:      "yolo",
			RequiresAny: []string{"generative_ui_talk", "generative_ui_agentic"},
			Body:        "GENUI VIZ BODY",
		},
		"genui_engineering": {
			Name:        "genui_engineering",
			Description: "Software architecture and protocol visualizers",
			Mode:        "agentic",
			Usable:      "yolo",
			Requires:    []string{"generative_ui_agentic"},
			Body:        "GENUI ENG BODY",
		},
		"genui_ask_sub": {
			Name:        "genui_ask_sub",
			Description: "Approval-gated subskill",
			Mode:        "agentic",
			Usable:      "ask",
			Requires:    []string{"generative_ui_agentic"},
			Body:        "ASK SUB BODY",
		},
		"genui_hidden": {
			Name:        "genui_hidden",
			Description: "User-only gated subskill",
			Mode:        "agentic",
			Usable:      "deny",
			Requires:    []string{"generative_ui_agentic"},
			Body:        "HIDDEN SUB BODY",
		},
	}})
	t.Cleanup(func() { swapSkillRegistry(prev) })
}

func TestGatedSubskillHiddenAndRefusedBeforeParentActive(t *testing.T) {
	installGatedGenUITestStore(t)
	args := func(name string) json.RawMessage { return json.RawMessage(`{"name":"` + name + `"}`) }

	// 1. Agentic session with only build active: generative_ui_agentic is listed & approved;
	// every gated subskill is hidden from listing and refused by the gate.
	agenticBefore := map[string]skills.SessionSkill{"build": {Priority: 1, Active: true}}
	descBefore := skillRegistry().skillsDescription("agentic", agenticBefore)
	if !strings.Contains(descBefore, "- generative_ui_agentic:") {
		t.Fatalf("generative_ui_agentic must be discoverable in agentic listing:\n%s", descBefore)
	}
	for _, hidden := range []string{"genui_engineering", "genui_visualizers", "genui_games", "genui_ask_sub", "genui_hidden"} {
		if strings.Contains(descBefore, hidden) {
			t.Fatalf("%q must stay hidden before parent is active:\n%s", hidden, descBefore)
		}
	}
	if v, _ := useSkillUsableGate(agenticBefore, "agentic", args("generative_ui_agentic")); v != "approve" {
		t.Fatalf("generative_ui_agentic gate = %q, want approve", v)
	}
	for _, refused := range []string{"genui_engineering", "genui_visualizers", "genui_games", "genui_ask_sub", "genui_hidden"} {
		if v, _ := useSkillUsableGate(agenticBefore, "agentic", args(refused)); v != "refuse" {
			t.Fatalf("%q gate before parent active = %q, want refuse", refused, v)
		}
	}

	// 2. Agentic session once generative_ui_agentic is active: agentic + shared subskills unlock;
	// talk-only and usable:deny remain hidden/refused; usable:ask transitions from refuse -> ask.
	agenticAfter := map[string]skills.SessionSkill{
		"build":                 {Priority: 1, Active: true},
		"generative_ui_agentic": {Priority: 2, Active: true},
	}
	descAfter := skillRegistry().skillsDescription("agentic", agenticAfter)
	for _, want := range []string{"- generative_ui_agentic:", "- genui_engineering:", "- genui_visualizers:", "- genui_ask_sub:"} {
		if !strings.Contains(descAfter, want) {
			t.Fatalf("%q must appear after parent activates:\n%s", want, descAfter)
		}
	}
	if strings.Contains(descAfter, "genui_games") || strings.Contains(descAfter, "genui_hidden") {
		t.Fatalf("talk-only / deny subskills must stay hidden:\n%s", descAfter)
	}
	if v, _ := useSkillUsableGate(agenticAfter, "agentic", args("genui_engineering")); v != "approve" {
		t.Fatalf("genui_engineering gate after parent active = %q, want approve", v)
	}
	if v, _ := useSkillUsableGate(agenticAfter, "agentic", args("genui_visualizers")); v != "approve" {
		t.Fatalf("genui_visualizers gate after parent active = %q, want approve", v)
	}
	if v, _ := useSkillUsableGate(agenticAfter, "agentic", args("genui_ask_sub")); v != "ask" {
		t.Fatalf("genui_ask_sub gate after parent active = %q, want ask", v)
	}
	if v, _ := useSkillUsableGate(agenticAfter, "agentic", args("genui_hidden")); v != "refuse" {
		t.Fatalf("usable:deny subskill must remain refused even with parent active, got %q", v)
	}

	// 3. Talk session: talk carries provides:["generative_ui","generative_ui_talk"], unlocking talk + shared subskills.
	talkActive := map[string]skills.SessionSkill{"talk": {Priority: 1, Active: true}}
	descTalk := skillRegistry().skillsDescription("talk", talkActive)
	if !strings.Contains(descTalk, "- genui_games:") || !strings.Contains(descTalk, "- genui_visualizers:") {
		t.Fatalf("talk must unlock genui_games and genui_visualizers immediately:\n%s", descTalk)
	}
	if strings.Contains(descTalk, "generative_ui_agentic") || strings.Contains(descTalk, "genui_engineering") {
		t.Fatalf("agentic skills must stay hidden in talk:\n%s", descTalk)
	}
	if v, _ := useSkillUsableGate(talkActive, "talk", args("genui_games")); v != "approve" {
		t.Fatalf("genui_games gate in talk = %q, want approve", v)
	}

	// 4. Config listing carries requires/requiresAny/provides metadata so the frontend picker hides gated subskills.
	listing := skillsListing()
	engEntry, ok := listing["genui_engineering"].(map[string]any)
	if !ok {
		t.Fatalf("genui_engineering missing from skillsListing: %+v", listing)
	}
	if reqs, _ := engEntry["requires"].([]string); len(reqs) != 1 || reqs[0] != "generative_ui_agentic" {
		t.Fatalf("genui_engineering listing missing requires metadata: %+v", engEntry)
	}
	vizEntry, _ := listing["genui_visualizers"].(map[string]any)
	if reqAny, _ := vizEntry["requiresAny"].([]string); len(reqAny) != 2 {
		t.Fatalf("genui_visualizers listing missing requiresAny metadata: %+v", vizEntry)
	}
	talkEntry, _ := listing["talk"].(map[string]any)
	if prov, _ := talkEntry["provides"].([]string); len(prov) != 2 {
		t.Fatalf("talk listing missing provides metadata: %+v", talkEntry)
	}
}

func TestSameStepParentThenSubskillLoad(t *testing.T) {
	installGatedGenUITestStore(t)
	inbox := make(chan Envelope, 8)
	w := &turnBridge{}
	w.env.inbox = inbox
	w.snap.options.Mode = "agentic"
	w.snap.skills = map[string]skills.SessionSkill{"build": {Priority: 1, Active: true}}
	if err := w.resolveSkillPolicy(); err != nil {
		t.Fatal(err)
	}

	// Before parent is loaded, gated subskill fails in LoadSkill.
	if _, err := w.LoadSkill("genui_engineering"); err == nil {
		t.Fatal("LoadSkill must refuse gated subskill before parent is active")
	}

	// Loading parent returns its body plus the newly unlocked skills hint.
	body, err := w.LoadSkill("generative_ui_agentic")
	if err != nil {
		t.Fatalf("LoadSkill(generative_ui_agentic): %v", err)
	}
	if !strings.Contains(body, "GENUI AGENTIC BODY") {
		t.Fatalf("parent body missing: %q", body)
	}
	if !strings.Contains(body, "Newly unlocked skills now available via use_skill:") ||
		!strings.Contains(body, "- genui_engineering:") ||
		!strings.Contains(body, "- genui_visualizers:") {
		t.Fatalf("parent LoadSkill must announce newly unlocked subskills:\n%s", body)
	}
	if strings.Contains(body, "genui_games") || strings.Contains(body, "genui_hidden") {
		t.Fatalf("unlocked hint must exclude other-mode / deny skills:\n%s", body)
	}
	w.RecordSkillUse("generative_ui_agentic", false)

	// Immediately after RecordSkillUse (even before actor refresh), the worker's
	// local snapshot reflects the active parent, so consecutive use_skill succeeds.
	subBody, err := w.LoadSkill("genui_engineering")
	if err != nil {
		t.Fatalf("consecutive LoadSkill(genui_engineering) failed: %v", err)
	}
	if subBody != "GENUI ENG BODY" {
		t.Fatalf("subskill body = %q, want GENUI ENG BODY", subBody)
	}
}

func TestParentDeactivationPrunesDependentGatedSubskills(t *testing.T) {
	installGatedGenUITestStore(t)

	// Case A: User unchecks parent via update_skills while a turn is running ->
	// AI-activated dependent subskill deactivates too and queues a notice.
	rec := newTestRecord("skill_prune_update")
	rec.Options.Mode = "agentic"
	rec.Skills = map[string]skills.SessionSkill{
		"build":                 {Priority: 1, Active: true},
		"generative_ui_agentic": {Priority: 2, Active: true, ByAI: true},
		"genui_engineering":     {Priority: 3, Active: true, ByAI: true},
	}
	unblock := make(chan struct{})
	worker := func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		select {
		case <-unblock:
		case <-ctx.Done():
		}
		env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen}, Epoch: snap.epoch}
	}
	act, _, wsCh, stop := newTestActor(t, rec, worker)
	defer stop()

	reply := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "go", Reply: reply}}
	if res := (<-reply).(promptResult); !res.Accepted {
		t.Fatalf("prompt rejected: %+v", res)
	}

	act.inbox <- Envelope{Payload: skillsUpdateMsg{
		Set: map[string]skills.SessionSkill{"generative_ui_agentic": {Active: false}},
	}}

	deadline := time.Now().Add(5 * time.Second)
	var snap map[string]any
	for snap == nil && time.Now().Before(deadline) {
		select {
		case ev := <-wsCh:
			if m, ok := ev.(map[string]any); ok && m["type"] == "session_data" {
				snap, _ = m["session"].(map[string]any)
			}
		case <-time.After(20 * time.Millisecond):
		}
	}
	if snap == nil {
		t.Fatal("no session_data after parent deactivation")
	}
	skillsOut, _ := snap["skills"].(map[string]any)
	if eng, _ := skillsOut["genui_engineering"].(map[string]any); eng["active"] != false {
		t.Fatalf("dependent subskill must deactivate when parent is deactivated: %+v", skillsOut)
	}
	close(unblock)
	waitActorIdle(t, act)

	// Case B: Parent activated with once=true while subskill was once=false ->
	// at turn end when parent expires, subskill also deactivates cleanly.
	rec2 := newTestRecord("skill_prune_once")
	rec2.Options.Mode = "agentic"
	rec2.Skills = map[string]skills.SessionSkill{"build": {Priority: 1, Active: true}}
	got := runSkillTurn(t, rec2,
		skillActivateMsg{name: "generative_ui_agentic", once: true, delivered: true},
		skillActivateMsg{name: "genui_engineering", once: false, delivered: true},
	)
	if got["generative_ui_agentic"].Active {
		t.Fatalf("once parent must deactivate at turn end: %+v", got["generative_ui_agentic"])
	}
	if got["genui_engineering"].Active {
		t.Fatalf("subskill whose once parent expired must also deactivate at turn end: %+v", got["genui_engineering"])
	}
}

type scriptedSkillClient struct {
	mu    sync.Mutex
	reqs  []provider.Request
	steps []provider.Message
}

func (c *scriptedSkillClient) Name() string { return "anthropic" }

func (c *scriptedSkillClient) Stream(_ context.Context, req provider.Request) (<-chan provider.Event, error) {
	c.mu.Lock()
	idx := len(c.reqs)
	c.reqs = append(c.reqs, req)
	var msg provider.Message
	if idx < len(c.steps) {
		msg = c.steps[idx]
	} else {
		msg = provider.Message{
			Role: provider.RoleAssistant,
			Content: []provider.Content{
				provider.ToolCallBlock{
					ID:        "fin-fallback",
					Name:      completionToolName,
					Arguments: json.RawMessage(`{"final_message_to_user":"done"}`),
				},
			},
		}
	}
	c.mu.Unlock()
	ch := make(chan provider.Event, 2)
	ch <- provider.EventDone{Stop: provider.StopToolUse, Message: msg}
	close(ch)
	return ch, nil
}

// End-to-end mid-turn dynamic unlock: an agentic session starts with only
// `build` active (no widget tools, no gated Gen-UI subskills). On step 1 the
// model calls use_skill("generative_ui_agentic"). On step 2 of the SAME turn:
//   - widget_set / widget_list / widget_lint immediately appear in req.Tools
//   - use_skill's tool description immediately lists unlocked subskills
//   - the step-1 use_skill tool_result announced the newly unlocked subskills
//   - calling use_skill("genui_engineering") succeeds in that same turn.
func TestMidTurnDynamicUnlockInSameTurn(t *testing.T) {
	installGatedGenUITestStore(t)

	client := &scriptedSkillClient{
		steps: []provider.Message{
			{
				Role: provider.RoleAssistant,
				Content: []provider.Content{
					provider.ToolCallBlock{
						ID:        "c1",
						Name:      "use_skill",
						Arguments: json.RawMessage(`{"name":"generative_ui_agentic"}`),
					},
				},
			},
			{
				Role: provider.RoleAssistant,
				Content: []provider.Content{
					provider.ToolCallBlock{
						ID:        "c2",
						Name:      "use_skill",
						Arguments: json.RawMessage(`{"name":"genui_engineering"}`),
					},
				},
			},
			{
				Role: provider.RoleAssistant,
				Content: []provider.Content{
					provider.ToolCallBlock{
						ID:        "c3",
						Name:      completionToolName,
						Arguments: json.RawMessage(`{"final_message_to_user":"widget ready"}`),
					},
				},
			},
		},
	}

	rec := newTestRecord("skill_midturn_unlock")
	rec.Options.Mode = "agentic"
	rec.Options.Access = "auto"
	rec.Skills = map[string]skills.SessionSkill{"build": {Priority: 1, Active: true}}

	workerErr := make(chan error, 1)
	worker := func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		w := &turnBridge{
			env:       env,
			snap:      snap,
			ctx:       ctx,
			client:    client,
			modelInfo: provider.Model{ID: "test-model", ContextWindow: 128000},
		}
		if err := w.resolveSkillPolicy(); err != nil {
			workerErr <- err
			env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen, err: err.Error()}, Epoch: snap.epoch}
			return
		}
		wStore := &widgetStoreBridge{w: w}
		w.reg = core.NewRegistry(
			&tools.WidgetSetTool{Store: wStore},
			&tools.WidgetListTool{Store: wStore},
			&tools.WidgetLintTool{Store: wStore},
			&tools.WidgetReadTool{Store: wStore},
			&tools.WidgetEditTool{Store: wStore},
			&tools.FinishEntireRequestTool{OnFinish: func() error { return nil }},
			&tools.SummaryTool{},
			&tools.UseSkillTool{Host: w},
		)
		w.agent = core.NewAgent(client, "test-model", "sys", w.effectiveRegistry())
		w.agent.SessionID = env.actorID
		w.agent.TurnIndex = snap.turnIndex
		w.agent.PersistentTurns = true
		w.agent.CompletionTool = completionToolName
		w.agent.BeforeRequest = w.beforeRequest
		w.agent.BeforeToolExecute = w.approveTool
		w.agent.RequestMessages = func(msgs []provider.Message) []provider.Message {
			return injectSkillsPrefix(msgs, buildSkillPrefix(w.skillEff))
		}
		w.agent.OnMessageAppended = w.onMessageAppended
		err := w.agent.PromptWithMeta(ctx, snap.prompt, nil, snap.promptMeta, func(core.AgentEvent) {})
		workerErr <- err
		errStr := ""
		if err != nil {
			errStr = err.Error()
		}
		env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen, err: errStr}, Epoch: snap.epoch}
	}

	act, _, _, stop := newTestActor(t, rec, worker)
	defer stop()

	reply := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "Visualize our Raft state machine", Reply: reply}}
	if res := (<-reply).(promptResult); !res.Accepted {
		t.Fatalf("prompt rejected: %+v", res)
	}
	if err := <-workerErr; err != nil {
		t.Fatalf("worker failed: %v", err)
	}
	waitActorIdle(t, act)

	client.mu.Lock()
	reqs := append([]provider.Request(nil), client.reqs...)
	client.mu.Unlock()
	if len(reqs) != 3 {
		t.Fatalf("expected 3 model steps in turn, got %d", len(reqs))
	}

	toolMap := func(specs []provider.Tool) map[string]provider.Tool {
		m := make(map[string]provider.Tool, len(specs))
		for _, s := range specs {
			m[s.Name] = s
		}
		return m
	}

	// Step 1: no widget tools yet; use_skill lists generative_ui_agentic only (no gated subskills).
	step1Tools := toolMap(reqs[0].Tools)
	for _, absent := range []string{"widget_set", "widget_list", "widget_lint", "widget_read", "widget_edit"} {
		if _, ok := step1Tools[absent]; ok {
			t.Fatalf("step 1 must not expose %q before generative_ui_agentic is active", absent)
		}
	}
	us1, ok := step1Tools["use_skill"]
	if !ok {
		t.Fatal("step 1 missing use_skill tool")
	}
	if !strings.Contains(us1.Description, "- generative_ui_agentic:") {
		t.Fatalf("step 1 use_skill description missing generative_ui_agentic:\n%s", us1.Description)
	}
	if strings.Contains(us1.Description, "genui_engineering") || strings.Contains(us1.Description, "genui_visualizers") {
		t.Fatalf("step 1 use_skill description leaked locked subskills:\n%s", us1.Description)
	}

	// Step 2 (VERY NEXT step of same turn): widget tools + unlocked subskills IMMEDIATELY available!
	step2Tools := toolMap(reqs[1].Tools)
	for _, present := range []string{"widget_set", "widget_list", "widget_lint"} {
		if _, ok := step2Tools[present]; !ok {
			t.Fatalf("step 2 must expose %q immediately after use_skill(generative_ui_agentic)", present)
		}
	}
	for _, denied := range []string{"widget_read", "widget_edit"} {
		if _, ok := step2Tools[denied]; ok {
			t.Fatalf("step 2 must keep talk-only %q denied in agentic mode", denied)
		}
	}
	us2 := step2Tools["use_skill"]
	if !strings.Contains(us2.Description, "- genui_engineering:") || !strings.Contains(us2.Description, "- genui_visualizers:") {
		t.Fatalf("step 2 use_skill description did not dynamically unlock subskills:\n%s", us2.Description)
	}
	if strings.Contains(us2.Description, "genui_games") {
		t.Fatalf("step 2 use_skill description must not unlock talk-only genui_games:\n%s", us2.Description)
	}

	// Verify step-1 tool_result carried the parent body + newly unlocked subskills hint,
	// and step-2 tool_result delivered genui_engineering's body without error.
	findToolResult := func(msgs []provider.Message, callID string) (string, bool, bool) {
		for _, m := range msgs {
			for _, c := range m.Content {
				if tr, ok := c.(provider.ToolResultBlock); ok && tr.CallID == callID {
					var text strings.Builder
					for _, rc := range tr.Content {
						if tb, ok := rc.(provider.TextBlock); ok {
							text.WriteString(tb.Text)
						}
					}
					return text.String(), tr.IsError, true
				}
			}
		}
		return "", false, false
	}
	c1Text, c1Err, c1Found := findToolResult(reqs[1].Messages, "c1")
	if !c1Found || c1Err || !strings.Contains(c1Text, "GENUI AGENTIC BODY") || !strings.Contains(c1Text, "genui_engineering") {
		t.Fatalf("step 2 missing unlocked parent tool_result: found=%v err=%v text=%q", c1Found, c1Err, c1Text)
	}
	c2Text, c2Err, c2Found := findToolResult(reqs[2].Messages, "c2")
	if !c2Found || c2Err || !strings.Contains(c2Text, "GENUI ENG BODY") {
		t.Fatalf("step 3 missing unlocked subskill tool_result: found=%v err=%v text=%q", c2Found, c2Err, c2Text)
	}

	// After turn commit: both parent and subskill remain persisted active; use_skill calls stripped.
	if !act.rec.Skills["generative_ui_agentic"].Active || !act.rec.Skills["genui_engineering"].Active {
		t.Fatalf("expected both parent and subskill persisted active: %+v", act.rec.Skills)
	}
	for _, m := range act.rec.Messages {
		for _, c := range m.Content {
			if tc, ok := c.(provider.ToolCallBlock); ok && tc.Name == "use_skill" {
				t.Fatalf("committed transcript kept a use_skill call: %+v", m)
			}
		}
	}
}

// Regression: rememberableSkills (used by saveLastSelection on create/configure)
// must drop conditional gated subskills so AI-loaded subskills never leak into
// LastSelection.Skills and pre-activate in future fresh drafts.
func TestRememberableSkillsDropsGatedSubskills(t *testing.T) {
	installGatedGenUITestStore(t)
	got := rememberableSkills([]SkillChoice{
		{Name: "build"},
		{Name: "generative_ui_agentic"},
		{Name: "genui_engineering"},
		{Name: "genui_visualizers"},
		{Name: "genui_games"},
		{Name: "unknown_skill"},
	})
	var names []string
	for _, c := range got {
		names = append(names, c.Name)
	}
	if strings.Join(names, ",") != "build,generative_ui_agentic" {
		t.Fatalf("rememberableSkills = %v, want [build generative_ui_agentic] (gated subskills must drop)", names)
	}
}

// Regression: normalizeSessionSkills (used by createSession) must never persist
// unsatisfied gated subskills as Active:true; otherwise activating the parent
// later would silently make the dormant subskill effective without use_skill or
// approval.
func TestNormalizeSessionSkillsPrunesUnsatisfiedGatedSubskills(t *testing.T) {
	installGatedGenUITestStore(t)

	// 1. Unsatisfied gated subskill without usable override is dropped; one with
	// an explicit usable override preserves the override with Active:false.
	got := skillRegistry().normalizeSessionSkills(map[string]skills.SessionSkill{
		"build":             {Priority: 1, Active: true},
		"genui_engineering": {Priority: 2, Active: true},
		"genui_ask_sub":     {Priority: 3, Active: true, Usable: "deny"},
	})
	if !got["build"].Active {
		t.Fatalf("build must stay active: %+v", got)
	}
	if _, exists := got["genui_engineering"]; exists {
		t.Fatalf("unsatisfied gated subskill without usable override must be removed: %+v", got)
	}
	askSub, ok := got["genui_ask_sub"]
	if !ok || askSub.Active || askSub.Usable != "deny" {
		t.Fatalf("unsatisfied gated subskill with usable override must keep override with Active=false: %+v", got)
	}

	// Activating the parent later must NOT resurrect the pruned subskills.
	got["generative_ui_agentic"] = skills.SessionSkill{Priority: 4, Active: true}
	eff, err := skillRegistry().resolveSession(got, "agentic")
	if err != nil {
		t.Fatalf("resolveSession: %v", err)
	}
	if _, leaked := eff.Bodies["genui_engineering"]; leaked {
		t.Fatalf("pruned subskill silently resurrected after parent activated: %+v", eff.Order)
	}
	if _, leaked := eff.Bodies["genui_ask_sub"]; leaked {
		t.Fatalf("deactivated subskill silently resurrected after parent activated: %+v", eff.Order)
	}

	// 2. When the parent IS active in the create payload, satisfied gated subskills remain active.
	withParent := skillRegistry().normalizeSessionSkills(map[string]skills.SessionSkill{
		"build":                 {Priority: 1, Active: true},
		"generative_ui_agentic": {Priority: 2, Active: true},
		"genui_engineering":     {Priority: 3, Active: true},
	})
	if !withParent["genui_engineering"].Active {
		t.Fatalf("satisfied gated subskill must remain active: %+v", withParent)
	}
}
