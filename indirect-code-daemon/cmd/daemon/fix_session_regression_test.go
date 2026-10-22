package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"indirect/indirect-code-daemon/packages/agent/tools"
	"indirect/indirect-code-daemon/packages/provider"
	"indirect/indirect-code-daemon/packages/skills"
)

func boolPtr(b bool) *bool {
	return &b
}

// 1 & 2 & 3: Fork Session TurnSeq, State Preservation, Custom ID & Title, Ghost Turn Prevention
func TestForkStatePreservationAndTurnSeq(t *testing.T) {
	parent := &SessionRecord{
		ID:        "sess_parent",
		Title:     "Parent Session",
		TurnSeq:   4,
		Messages:  darMsgs(4), // turns 1 and 2 (messages 0,1 are turn 1; 2,3 are turn 2)
		Skills:    map[string]skills.SessionSkill{"custom-skill": {Active: true, Priority: 2, Usable: "ask"}},
		Widgets:   []tools.WidgetFile{{ID: "w1", Source: "console.log(1)"}},
		Todos:     []tools.TodoItem{{ID: "t1", Text: "task 1", Status: "in_progress"}},
		TodosOpen: boolPtr(true),
		Options:   normalizedOptions(SessionOptions{}),
	}
	a, st := darActor(t, parent)

	reply := make(chan any, 1)
	// Fork keeping message 1 (turn 1 only)
	a.onFork(forkReqMsg{
		NewID: "custom-fork-id",
		Title: "Custom Fork Title",
		Keep:  1,
		Reply: reply,
	})
	res := (<-reply).(forkResult)
	if res.Error != "" {
		t.Fatalf("onFork failed: %s", res.Error)
	}
	if res.NewID != "custom-fork-id" {
		t.Fatalf("expected fork ID 'custom-fork-id', got %q", res.NewID)
	}

	forkDisk, err := st.loadSession("custom-fork-id")
	if err != nil {
		t.Fatalf("failed to load fork: %v", err)
	}

	// Verify ID & Title
	if forkDisk.ID != "custom-fork-id" {
		t.Errorf("fork ID = %q, want 'custom-fork-id'", forkDisk.ID)
	}
	if forkDisk.Title != "Custom Fork Title" {
		t.Errorf("fork Title = %q, want 'Custom Fork Title'", forkDisk.Title)
	}

	// Verify TurnSeq is derived from kept messages (turn 1), not parent's 4
	if forkDisk.TurnSeq != 1 {
		t.Errorf("fork TurnSeq = %d, want 1 (parent had 4)", forkDisk.TurnSeq)
	}
	if len(forkDisk.Messages) != 2 {
		t.Errorf("fork Messages count = %d, want 2", len(forkDisk.Messages))
	}

	// Verify State Preservation
	if forkDisk.Skills == nil || !forkDisk.Skills["custom-skill"].Active {
		t.Errorf("fork Skills not preserved: %+v", forkDisk.Skills)
	}
	if len(forkDisk.Widgets) != 1 || forkDisk.Widgets[0].ID != "w1" {
		t.Errorf("fork Widgets not preserved: %+v", forkDisk.Widgets)
	}
	if len(forkDisk.Todos) != 1 || forkDisk.Todos[0].ID != "t1" {
		t.Errorf("fork Todos not preserved: %+v", forkDisk.Todos)
	}
	if forkDisk.TodosOpen == nil || !*forkDisk.TodosOpen {
		t.Errorf("fork TodosOpen not preserved: %+v", forkDisk.TodosOpen)
	}

	// Verify passivation does not write ghost empty turn
	// Simulate idle passivation commitWAL on the fork
	if err := st.commitWAL(forkDisk.ID, forkDisk, nil); err != nil {
		t.Fatalf("commitWAL failed: %v", err)
	}
	lines, _, err := st.readSessionFile(forkDisk.ID)
	if err != nil {
		t.Fatalf("readSessionFile failed: %v", err)
	}
	for _, l := range lines {
		if l.Turn > 1 {
			t.Errorf("ghost turn line found on disk: %+v", l)
		}
		if len(l.Messages) == 0 {
			t.Errorf("empty phantom turn line found on disk: %+v", l)
		}
	}
}

// 1. Ghost turn prevention when rec.TurnSeq > kept turn lines
func TestCommitWALPreventsGhostTurn(t *testing.T) {
	st := newDiskStore(t.TempDir())
	rec := &SessionRecord{
		ID:       "sess-ghost-test",
		TurnSeq:  5,
		Messages: darMsgs(2), // only turn 1 messages exist
		Options:  normalizedOptions(SessionOptions{}),
	}
	if err := st.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	// Call commitWAL
	if err := st.commitWAL(rec.ID, rec, nil); err != nil {
		t.Fatal(err)
	}
	lines, _, err := st.readSessionFile(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range lines {
		if l.Turn == 5 {
			t.Fatalf("phantom turn 5 line was written with messages=%d", len(l.Messages))
		}
	}
}

// 4. Double-stamped skill envelope
func TestRecordSkillUseSingleEnvelope(t *testing.T) {
	inbox := make(chan Envelope, 5)
	wb := &turnBridge{
		env: workerEnv{
			actorID: "sess-skill",
			inbox:   inbox,
		},
		snap: workerSnapshot{
			gen: 1,
			skills: map[string]skills.SessionSkill{
				"test-skill": {Usable: "ask"},
			},
		},
	}

	wb.RecordSkillUse("test-skill", true)

	select {
	case env := <-inbox:
		// Payload must be skillActivateMsg, NOT Envelope!
		act, ok := env.Payload.(skillActivateMsg)
		if !ok {
			t.Fatalf("inbox payload is %T, want skillActivateMsg (double stamping detected!)", env.Payload)
		}
		if act.name != "test-skill" || !act.once || act.usable != "ask" {
			t.Fatalf("unexpected skillActivateMsg: %+v", act)
		}
	default:
		t.Fatal("no message sent to inbox")
	}
}

// 5. isUseSkillResult with json.RawMessage and stripSkillArtifacts
func TestIsUseSkillResultWithRawMessage(t *testing.T) {
	// 1. Check with map[string]any
	resMap := provider.ToolResultBlock{
		CallID:  "c1",
		Details: map[string]any{"skill": "read-skill"},
	}
	if !isUseSkillResult(resMap) {
		t.Error("isUseSkillResult failed for map[string]any")
	}
	if !isUseSkillResultFor(resMap, "read-skill") {
		t.Error("isUseSkillResultFor failed for map[string]any")
	}

	// 2. Check with json.RawMessage (WAL hydration format)
	resRaw := provider.ToolResultBlock{
		CallID:  "c2",
		Details: json.RawMessage(`{"skill":"read-skill"}`),
	}
	if !isUseSkillResult(resRaw) {
		t.Error("isUseSkillResult failed for json.RawMessage")
	}
	if !isUseSkillResultFor(resRaw, "read-skill") {
		t.Error("isUseSkillResultFor failed for json.RawMessage")
	}
	if isUseSkillResultFor(resRaw, "other-skill") {
		t.Error("isUseSkillResultFor should return false for mismatch")
	}

	// 3. Check stripSkillArtifacts with hydrated messages
	msgs := []provider.Message{
		{
			ID:        "m1",
			Role:      provider.RoleAssistant,
			TurnIndex: 1,
			Content: []provider.Content{
				provider.ToolCallBlock{ID: "c1", Name: "use_skill"},
			},
		},
		{
			ID:        "m2",
			Role:      provider.RoleTool,
			TurnIndex: 1,
			Content: []provider.Content{
				provider.ToolResultBlock{
					CallID:  "c1",
					Details: json.RawMessage(`{"skill":"read-skill"}`),
					Content: []provider.Content{provider.TextBlock{Text: "skill body"}},
				},
			},
		},
		{
			ID:        "m3",
			Role:      provider.RoleAssistant,
			TurnIndex: 1,
			Content: []provider.Content{
				provider.TextBlock{Text: "regular reply"},
			},
		},
	}

	stripped := stripSkillArtifacts(msgs, 1)
	if len(stripped) != 1 {
		t.Fatalf("expected 1 message remaining after stripSkillArtifacts, got %d", len(stripped))
	}
	if stripped[0].ID != "m3" {
		t.Errorf("expected m3 remaining, got %s", stripped[0].ID)
	}
}

// 6. Preserve st.ByAI at Turn End
func TestPreserveByAIAtTurnEnd(t *testing.T) {
	rec := &SessionRecord{
		ID: "sess-skills",
		Skills: map[string]skills.SessionSkill{
			"s-once": {Active: true, ByAI: true, Once: true},
			"s-perm": {Active: true, ByAI: true, Once: false},
			"s-user": {Active: true, ByAI: false, Once: false},
		},
		Options: normalizedOptions(SessionOptions{}),
	}
	a, _ := darActor(t, rec)

	changed := a.endTurnSkills()
	if !changed {
		t.Fatal("expected endTurnSkills to report changed = true")
	}

	// s-once: Once reset, Active reset to false, ByAI PRESERVED
	sOnce := a.rec.Skills["s-once"]
	if sOnce.Active {
		t.Errorf("s-once: Active = %v, want false", sOnce.Active)
	}
	if sOnce.Once {
		t.Errorf("s-once: Once = %v, want false", sOnce.Once)
	}
	if !sOnce.ByAI {
		t.Errorf("s-once: ByAI = %v, want true (must be preserved)", sOnce.ByAI)
	}

	// s-perm: Active still true, ByAI PRESERVED
	sPerm := a.rec.Skills["s-perm"]
	if !sPerm.Active {
		t.Errorf("s-perm: Active = %v, want true", sPerm.Active)
	}
	if !sPerm.ByAI {
		t.Errorf("s-perm: ByAI = %v, want true (must be preserved)", sPerm.ByAI)
	}

	// s-user: unchanged
	sUser := a.rec.Skills["s-user"]
	if !sUser.Active || sUser.ByAI {
		t.Errorf("s-user: unexpected state %+v", sUser)
	}
}

// 7. Task Plan Sync (todosOpenMsg calls pingChange)
func TestTodosOpenMsgPingsChange(t *testing.T) {
	rec := &SessionRecord{ID: "sess-todos", Options: normalizedOptions(SessionOptions{})}
	a, _ := darActor(t, rec)

	pinged := false
	a.onEvent = func(collection string) {
		if collection == "sessions" {
			pinged = true
		}
	}

	a.handleData(Envelope{Payload: todosOpenMsg{Open: true}})
	if !pinged {
		t.Fatal("todosOpenMsg did not call pingChange()")
	}
	if a.rec.TodosOpen == nil || !*a.rec.TodosOpen {
		t.Fatalf("TodosOpen = %v, want true", a.rec.TodosOpen)
	}
}

// 8. Queue Send-Now Ping and Emit on Idle
func TestQueueSendNowIdlePingsAndEmits(t *testing.T) {
	rec := &SessionRecord{
		ID:      "sess-q-sendnow",
		Options: normalizedOptions(SessionOptions{}),
		Queue: []QueuedMessage{
			{ID: "q1", Text: "send this now"},
		},
	}
	a, _ := darActor(t, rec)
	a.state = stateIdle

	pinged := false
	a.onEvent = func(collection string) {
		if collection == "sessions" {
			pinged = true
		}
	}
	emitted := false
	a.wsSend = func(ev any) {
		if m, ok := ev.(map[string]any); ok && m["type"] == "session_queue" {
			emitted = true
		}
	}

	a.onQueueSendNow(queueSendNowMsg{QueueID: "q1"})

	if !pinged {
		t.Error("onQueueSendNow did not call pingChange() on idle")
	}
	if !emitted {
		t.Error("onQueueSendNow did not emit session_queue on idle")
	}
}

// 10. Always-Allow Mid-Turn Sync
func TestAlwaysAllowMidTurnSync(t *testing.T) {
	rec := &SessionRecord{
		ID:      "sess-appr",
		Options: SessionOptions{Mode: "agent", Access: "ask"},
	}
	a, _ := darActor(t, rec)
	a.state = stateAwaitAppr
	a.pending = &pendingAsk{id: "call_1", kind: "approval", tool: "exec"}

	pinged := false
	a.onEvent = func(collection string) {
		if collection == "sessions" {
			pinged = true
		}
	}
	sessionDataEmitted := false
	a.wsSend = func(ev any) {
		if m, ok := ev.(map[string]any); ok && m["type"] == "session_data" {
			sessionDataEmitted = true
		}
	}

	a.onApprovalResponse(approvalResponseMsg{
		ID:       "call_1",
		Approved: true,
		Always:   true,
	})

	if a.rec.Options.Access != "full" {
		t.Errorf("access = %q, want 'full'", a.rec.Options.Access)
	}
	if !pinged {
		t.Error("approval always-allow did not trigger pingChange()")
	}
	if !sessionDataEmitted {
		t.Error("approval always-allow did not emit session_data")
	}
}

// 11. 0-byte Text File Binary Label
func TestZeroByteTextFileAttachment(t *testing.T) {
	tmpDir := t.TempDir()
	emptyTxt := filepath.Join(tmpDir, "empty.txt")
	if err := os.WriteFile(emptyTxt, []byte{}, 0o600); err != nil {
		t.Fatal(err)
	}
	emptyBin := filepath.Join(tmpDir, "empty.bin")
	if err := os.WriteFile(emptyBin, []byte{}, 0o600); err != nil {
		t.Fatal(err)
	}

	attachments := []AttachmentRef{
		{ID: "a1", Name: "empty.txt", Mime: "text/plain", Path: emptyTxt},
		{ID: "a2", Name: "empty.bin", Mime: "application/octet-stream", Path: emptyBin},
	}

	// Test 0-byte text file
	fullText, _ := buildTurnPrompt(attachments, "Hello", []string{"a1"}, "agent")
	if !strings.Contains(fullText, "[Attached file: empty.txt]") {
		t.Errorf("0-byte text file prompt = %q, want '[Attached file: empty.txt]'", fullText)
	}
	if strings.Contains(fullText, "binary") {
		t.Errorf("0-byte text file incorrectly labelled as binary: %q", fullText)
	}

	// Test 0-byte binary file
	fullBin, _ := buildTurnPrompt(attachments, "Hello", []string{"a2"}, "agent")
	if !strings.Contains(fullBin, "[Attached binary file: empty.bin") {
		t.Errorf("0-byte binary file prompt = %q, want '[Attached binary file: empty.bin...']", fullBin)
	}
}
