package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"indirect/indirect-code-daemon/packages/core"
	"indirect/indirect-code-daemon/packages/filetrack"
	"indirect/indirect-code-daemon/packages/provider"
)

// attachmentUploadKey is a stable identity for one upload request. A name
// and MIME type identify a UI label, not the bytes behind it; including the
// effective name/MIME, content and extracted text prevents a changed file
// from being mistaken for an idempotent retry.
func attachmentUploadKey(name, mime string, data []byte, text string) string {
	h := sha256.New()
	for _, part := range [][]byte{[]byte(name), []byte(mime), data, []byte(text)} {
		var n [8]byte
		binary.BigEndian.PutUint64(n[:], uint64(len(part)))
		_, _ = h.Write(n[:])
		_, _ = h.Write(part)
	}
	return "sha256:" + fmt.Sprintf("%x", h.Sum(nil))
}

// Attachments: upload/get/validate/prune. v2: actor-local (no locks).
// Uploads apply to the live record; running turns persist via WAL attach
// event, idle turns save directly (v1 semantics).

const (
	maxAttachmentBytes       = 4 << 20
	maxImageAttachmentBytes  = 20 << 20
	maxAttachmentTextRunes   = 512 * 1024
	maxAttachmentsPerMessage = 30
)

func attachmentSizeLimit(mime string) int {
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(mime)), "image/") {
		return maxImageAttachmentBytes
	}
	return maxAttachmentBytes
}

func validateAttachmentIDs(rec *SessionRecord, ids []string) error {
	if len(ids) > maxAttachmentsPerMessage {
		return fmt.Errorf("Max %d attachments per message", maxAttachmentsPerMessage)
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			return fmt.Errorf("Duplicate attachment")
		}
		seen[id] = true
		found := false
		for _, a := range rec.Attachments {
			if a.ID != id {
				continue
			}
			found = true
			f, err := os.Open(a.Path)
			if err != nil {
				return fmt.Errorf("Attachment '%s' is unavailable; attach it again", a.Name)
			}
			info, err := f.Stat()
			f.Close()
			if err != nil || !info.Mode().IsRegular() || info.Size() > int64(attachmentSizeLimit(a.Mime)) {
				return fmt.Errorf("Attachment '%s' is unavailable", a.Name)
			}
			break
		}
		if !found {
			return fmt.Errorf("Attachment does not belong to this conversation")
		}
	}
	return nil
}

// pruneOrphanAttachments drops refs (and files) no longer referenced by the
// transcript, queued messages or keepExtra.
func pruneOrphanAttachments(rec *SessionRecord, keepExtra []string) {
	keep := map[string]bool{}
	for _, id := range keepExtra {
		keep[id] = true
	}
	for _, m := range rec.Messages {
		for _, id := range messageAttachmentIDs(m, rec.Attachments) {
			keep[id] = true
		}
	}
	// Queued messages are not part of the transcript yet, but their uploads
	// are referenced by the item that will start the next turn.
	for _, q := range rec.Queue {
		for _, id := range q.AttachmentIDs {
			keep[id] = true
		}
	}
	live := rec.Attachments[:0]
	for _, a := range rec.Attachments {
		if !keep[a.ID] {
			os.Remove(a.Path)
			if a.TextPath != "" {
				os.Remove(a.TextPath)
			}
			continue
		}
		live = append(live, a)
	}
	if len(live) == 0 {
		rec.Attachments = nil
	} else {
		rec.Attachments = live
	}
}

func (a *sessionActor) onAttachUpload(m attachUploadMsg) attachUploadResult {
	fail := func(msg string) attachUploadResult { return attachUploadResult{Error: msg} }
	if strings.TrimSpace(m.Name) == "" {
		return fail("Attachment needs a session, name and data")
	}
	if len(m.Data) > base64.StdEncoding.EncodedLen(maxImageAttachmentBytes) {
		return fail("Attachment too large (max 20MB for images, 4MB for files)")
	}
	data, err := base64.StdEncoding.DecodeString(m.Data)
	if err != nil {
		return fail("Attachment data is not valid base64")
	}
	mime := strings.ToLower(strings.TrimSpace(m.Mime))
	detected := http.DetectContentType(data)
	if strings.HasPrefix(detected, "image/") {
		mime = detected
	}
	if strings.HasPrefix(mime, "image/") {
		switch mime {
		case "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp":
		default:
			return fail("Unsupported image. Use PNG, JPEG, GIF, WebP or BMP.")
		}
		if detected != mime && mime != "image/bmp" {
			return fail("Image data does not match its format")
		}
		if len(data) > maxImageAttachmentBytes {
			return fail("Image too large (max 20MB)")
		}
	} else if len(data) > maxAttachmentBytes {
		return fail("Attachment too large (max 4MB)")
	}
	if mime == "" {
		mime = detected
	}
	name := filepath.Base(strings.ReplaceAll(strings.TrimSpace(m.Name), "\\", "/"))
	text := []rune(m.Text)
	if len(text) > maxAttachmentTextRunes {
		text = text[:maxAttachmentTextRunes]
	}
	textValue := string(text)
	uploadKey := attachmentUploadKey(name, mime, data, textValue)
	// Idempotent retry: same upload twice returns the first ref.
	for _, at := range a.rec.Attachments {
		if at.UploadKey == uploadKey {
			return attachUploadResult{Attachment: messageAttachment{at.ID, at.Name, at.Mime, at.Size}}
		}
	}
	dir := filepath.Join(a.store.sessionsDir(), a.id, "attachments")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fail("Could not store attachment")
	}
	file, err := os.CreateTemp(dir, "att-*")
	if err != nil {
		return fail("Could not store attachment")
	}
	path := file.Name()
	committed := false
	textPath := ""
	defer func() {
		if !committed {
			os.Remove(path)
			if textPath != "" {
				os.Remove(textPath)
			}
		}
	}()
	if _, err := file.Write(data); err != nil {
		file.Close()
		return fail("Could not store attachment")
	}
	if err := file.Close(); err != nil {
		return fail("Could not store attachment")
	}
	ref := AttachmentRef{ID: filepath.Base(path), UploadKey: uploadKey, Name: name, Mime: mime, Size: int64(len(data)), Path: path}
	if textValue != "" {
		textPath = path + "_extracted.md"
		if err := os.WriteFile(textPath, []byte(textValue), 0o600); err != nil {
			return fail("Could not store extracted text")
		}
		ref.TextPath, ref.TextChars = textPath, len([]rune(textValue))
	}
	previous := a.rec.Attachments
	a.rec.Attachments = append(append([]AttachmentRef{}, previous...), ref)
	a.rec.UpdatedAt = time.Now().UnixMilli()
	a.touch()
	if a.wal != nil {
		appendWALEvent(a.wal, walEvent{Type: walTypeAttach, Attachments: append([]AttachmentRef{}, a.rec.Attachments...)})
	} else if err := a.store.saveSessionSync(a.rec); err != nil {
		a.rec.Attachments = previous
		return fail("Could not save attachment")
	}
	committed = true
	a.pingChange()
	return attachUploadResult{Attachment: messageAttachment{ref.ID, ref.Name, ref.Mime, ref.Size}}
}

// onQueueSendNow pops and launches the item when idle (or orphaned); while a
// turn is active, it stages the item as Delivery="steer" for live injection on
// the next BeforeRequest (or normal promotion if the turn finishes first).
func (a *sessionActor) onQueueSendNow(m queueSendNowMsg) {
	a.touch()
	idx := -1
	for i, q := range a.rec.Queue {
		if q.ID == m.QueueID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return
	}
	if a.state == stateOrphaned {
		a.rec.Status = "idle"
		a.setState(stateIdle)
		a.pingChange()
	}
	if a.state == stateIdle {
		item := a.rec.Queue[idx]
		rest := append([]QueuedMessage(nil), a.rec.Queue[:idx]...)
		rest = append(rest, a.rec.Queue[idx+1:]...)
		a.rec.Queue = rest
		if err := a.startTurn(item.Text, item.AttachmentIDs, item.Model, item.YOLO, item.Options); err != nil {
			item.Delivery = deliverySteer
			a.rec.Queue = append(a.rec.Queue, item)
			sortQueueByDelivery(a.rec.Queue)
			_ = a.saveOrAppend(walEvent{Type: walTypeQueue, Queue: a.rec.Queue})
		}
		a.pingChange()
		a.emit(map[string]any{"type": "session_queue", "hostId": a.hostID(), "sessionId": a.id, "queue": queuePayload(a.rec.Queue)})
		return
	}
	previous := cloneQueueSlice(a.rec.Queue)
	a.rec.Queue[idx].Delivery = deliverySteer
	sortQueueByDelivery(a.rec.Queue)
	if err := a.saveOrAppend(walEvent{Type: walTypeQueue, Queue: a.rec.Queue}); err != nil {
		a.rec.Queue = previous
		return
	}
	a.pingChange()
	a.emit(map[string]any{"type": "session_queue", "hostId": a.hostID(), "sessionId": a.id, "queue": queuePayload(a.rec.Queue)})
}

// onQueueCancelSend unstages a Delivery="steer" or Delivery="interrupt" item
// back to passive "queue", restoring its original relative slot via Seq. If an
// interrupt already placed the active turn into stateCancel, the turn finishes
// stopping into idle without promoting the unstaged item. If the item was
// already consumed by BeforeRequest or is already passive, it emits
// session_queue so the client UI reconciles without error.
func (a *sessionActor) onQueueCancelSend(m queueCancelSendMsg) {
	a.touch()
	idx := -1
	for i, q := range a.rec.Queue {
		if q.ID == m.QueueID {
			idx = i
			break
		}
	}
	if idx >= 0 {
		d := normalizeDelivery(a.rec.Queue[idx].Delivery)
		if d == deliverySteer || d == deliveryInterrupt {
			previous := cloneQueueSlice(a.rec.Queue)
			a.rec.Queue[idx].Delivery = deliveryQueue
			sortQueueByDelivery(a.rec.Queue)
			if err := a.saveOrAppend(walEvent{Type: walTypeQueue, Queue: a.rec.Queue}); err != nil {
				a.rec.Queue = previous
				return
			}
			a.pingChange()
		}
	}
	a.emit(map[string]any{"type": "session_queue", "hostId": a.hostID(), "sessionId": a.id, "queue": queuePayload(a.rec.Queue)})
}

// onQueueInterruptNow promotes a queued item to Delivery="interrupt": if idle,
// it pops and starts the turn immediately; if running/awaiting, it aborts the
// current turn ("interrupt_and_send") so finishTurn promotes it immediately.
func (a *sessionActor) onQueueInterruptNow(m queueInterruptNowMsg) {
	a.touch()
	idx := -1
	for i, q := range a.rec.Queue {
		if q.ID == m.QueueID {
			idx = i
			break
		}
	}
	if idx < 0 {
		a.emit(map[string]any{"type": "session_queue", "hostId": a.hostID(), "sessionId": a.id, "queue": queuePayload(a.rec.Queue)})
		return
	}
	if a.state == stateOrphaned {
		a.rec.Status = "idle"
		a.setState(stateIdle)
		a.pingChange()
	}
	if a.state == stateIdle {
		item := a.rec.Queue[idx]
		rest := append([]QueuedMessage(nil), a.rec.Queue[:idx]...)
		rest = append(rest, a.rec.Queue[idx+1:]...)
		a.rec.Queue = rest
		if err := a.startTurn(item.Text, item.AttachmentIDs, item.Model, item.YOLO, item.Options); err != nil {
			item.Delivery = deliveryQueue
			a.rec.Queue = append(a.rec.Queue, item)
			demoteStagedQueueItems(a.rec.Queue)
			sortQueueByDelivery(a.rec.Queue)
			_ = a.saveOrAppend(walEvent{Type: walTypeQueue, Queue: a.rec.Queue})
		}
		a.pingChange()
		a.emit(map[string]any{"type": "session_queue", "hostId": a.hostID(), "sessionId": a.id, "queue": queuePayload(a.rec.Queue)})
		return
	}
	if a.state == stateRunning || a.state == stateAwaitAppr || a.state == stateAwaitQ || a.state == stateCancel {
		previous := cloneQueueSlice(a.rec.Queue)
		demoteInterruptToSteer(a.rec.Queue)
		a.rec.Queue[idx].Delivery = deliveryInterrupt
		sortQueueByDelivery(a.rec.Queue)
		if err := a.saveOrAppend(walEvent{Type: walTypeQueue, Queue: a.rec.Queue}); err != nil {
			a.rec.Queue = previous
			return
		}
		a.pingChange()
		a.emit(map[string]any{"type": "session_queue", "hostId": a.hostID(), "sessionId": a.id, "queue": queuePayload(a.rec.Queue)})
		if a.state == stateRunning || a.state == stateAwaitAppr || a.state == stateAwaitQ {
			a.doCancel("interrupt_and_send")
		}
	}
}

// onEditApply applies a saved (non-regen) edit. Runs on the actor; caller
// guarantees idle (ws_server checks state first).
func (a *sessionActor) onEditApply(m editApplyMsg) editApplyResult {
	if a.state != stateIdle || a.persistErr != nil {
		return editApplyResult{Error: "Stop the current turn before editing"}
	}
	previous := cloneRecord(a.rec)
	if m.Index < 0 || m.Index >= len(a.rec.Messages) {
		return editApplyResult{Error: "bad index"}
	}
	msg := a.rec.Messages[m.Index]
	if msg.Role != provider.RoleUser {
		return editApplyResult{Error: "only user messages can be edited"}
	}
	text := core.SanitizeUserText(m.Text)
	ids := m.AttachmentIDs
	if ids == nil {
		ids = messageAttachmentIDs(msg, a.rec.Attachments)
	}
	if err := validateAttachmentIDs(a.rec, ids); err != nil {
		return editApplyResult{Error: err.Error()}
	}
	if strings.TrimSpace(text) == "" && len(ids) == 0 {
		return editApplyResult{Error: "Message cannot be empty"}
	}
	fullText, images := buildTurnPrompt(a.rec.Attachments, text, ids, normalizedOptions(a.rec.Options).Mode)
	msg.Content = []provider.Content{provider.TextBlock{Text: fullText}}
	for _, img := range images {
		msg.Content = append(msg.Content, img)
	}
	msg.Meta = attachmentMessageMeta(text, ids, a.rec.Attachments)
	before := len(a.rec.Messages)
	a.rec.Messages[m.Index] = msg
	a.rec.Messages = append([]provider.Message(nil), a.rec.Messages[:m.Index+1]...)
	a.rec.FileBalloons = dropBalloonsAbove(a.rec.FileBalloons, m.Index+1)
	a.rec.Messages = provider.RepairOrphanedToolResults(a.rec.Messages)
	a.rec.Compaction = truncateSessionCompaction(a.rec.Compaction, min(m.Index, len(a.rec.Messages)))
	pruneOrphanAttachments(a.rec, nil)
	a.rec.UpdatedAt = time.Now().UnixMilli()
	removed := before - len(a.rec.Messages)
	if removed < 0 {
		removed = 0
	}
	// Turn-granular persist (v1 edit_message semantics).
	firstDirty := 0
	for _, mm := range a.rec.Messages[m.Index:] {
		if mm.TurnIndex > 0 {
			firstDirty = mm.TurnIndex
			break
		}
	}
	st := a.store
	var persistErr error
	if firstDirty <= 0 {
		lines, _ := splitRecord(a.rec)
		persistErr = st.writeSessionFile(a.rec.ID, lines, recordMeta(a.rec))
	} else {
		start := len(a.rec.Messages)
		for i, mm := range a.rec.Messages {
			if mm.TurnIndex >= firstDirty {
				start = i
				break
			}
		}
		for start > 0 && a.rec.Messages[start-1].TurnIndex <= 0 {
			start--
		}
		var sbal []filetrack.TurnChanges
		for _, b := range a.rec.FileBalloons {
			if b.TurnIndex >= firstDirty {
				sbal = append(sbal, b)
			}
		}
		persistErr = st.persistEdited(a.rec.ID, firstDirty, append([]provider.Message{}, a.rec.Messages[start:]...), sbal, recordMeta(a.rec))
	}
	if persistErr != nil {
		a.rec = previous
		return editApplyResult{Error: persistErr.Error()}
	}
	a.emit(map[string]any{"type": "session_truncated", "sessionId": a.id, "keepIndex": m.Index})
	a.emit(tailContentEvent("", a.id, "session_content", a.rec, 0, nil))
	a.pingChange()
	return editApplyResult{}
}

// onCompactNow starts a compaction-only turn when idle.
func (a *sessionActor) onCompactNow() {
	if a.state != stateIdle {
		return
	}
	a.touch()
	if len(a.rec.Messages) < 4 {
		a.emit(map[string]any{"type": "notice", "sessionId": a.id, "message": "Not enough history to compact", "level": "warn"})
		return
	}
	_ = a.startTurnWithMeta("", nil, "", map[string]string{"operation": "compact"})
}

// onSlashReply appends a deterministic user/assistant pair (a slash command
// and its canned reply) with no model call — v1 /help parity. The record
// stays single-writer: only the actor touches a.rec.
func (a *sessionActor) onSlashReply(m slashReplyMsg) {
	a.touch()
	a.rec.TurnSeq++
	turn := a.rec.TurnSeq
	userMsg := provider.Message{ID: provider.NewMessageID(), Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: m.Command}}, TurnIndex: turn}
	asstMsg := provider.Message{ID: provider.NewMessageID(), Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: m.Reply}}, TurnIndex: turn}
	a.rec.Messages = append(a.rec.Messages, userMsg, asstMsg)
	a.rec.UpdatedAt = time.Now().UnixMilli()
	// Mirror saveOrAppend's rule (plus stateCancel, where the worker is
	// exiting but the WAL is still open): while a WAL is open the messages
	// must be journaled, never written to disk directly — a direct save
	// would race the pending commitWAL and duplicate the turn.
	if a.wal != nil {
		appendWALEvent(a.wal, walMsgEvent(userMsg))
		appendWALEvent(a.wal, walMsgEvent(asstMsg))
	} else {
		_ = a.store.saveSessionSync(a.rec)
	}
	a.pingChange()
	a.emit(tailContentEvent("", a.id, "session_content", a.rec, 0, nil))
	if m.Ack != nil {
		select {
		case m.Ack <- struct{}{}:
		default:
		}
	}
}

func jailNotice(jailed bool) string {
	if jailed {
		return "Sandbox locked for future turns."
	}
	return "Sandbox unlocked for future turns."
}
