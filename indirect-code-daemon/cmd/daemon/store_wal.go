package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"

	"indirect/indirect-code-daemon/packages/agent/tools"
	"indirect/indirect-code-daemon/packages/core"
	"indirect/indirect-code-daemon/packages/filetrack"
	"indirect/indirect-code-daemon/packages/provider"
	"indirect/indirect-code-daemon/packages/sessionstore"
	"indirect/indirect-code-daemon/packages/skills"
)

// Session WAL (write-ahead log): during a turn the session JSON stays
// FROZEN on disk and every small mutation is appended as one JSON line to
// <id>.wal.jsonl. When the turn truly ends, the in-memory record is saved
// once (single full rewrite) and the WAL is deleted.
//
// On-disk rule: with Status=running, the truth is frozen-JSON + WAL.
// With Status=idle, the truth is the JSON alone (no WAL file exists).
//
// Durability: appends are buffered (one open file handle per running
// session) with flush on every turn-index boundary and fsync on commit.
// A daemon crash loses at most the unflushed tail; the frozen JSON plus
// the flushed prefix always replay to a consistent record.

const walVersion = 1

// errWALExists is returned by openWAL when a healthy WAL is already on
// disk: a turn is (or was) in flight and must be resumed or discarded
// first. Same condition as the O_EXCL "file exists" it replaces.
var errWALExists = errors.New("wal already exists")

// walAppendFault is a test seam for the WAL creation/append fsync failure
// path (nil in production).
var walAppendFault func() error

// WAL event types. Small, append-only, replayed in order.
const (
	walTypeHeader     = "header"      // first line: turn identity + recovery prompt
	walTypeMsg        = "msg"         // one appended transcript message
	walTypeUsage      = "usage"       // usage + context snapshot
	walTypeCompaction = "compaction"  // compaction chain head
	walTypeTodos      = "todos"       // todo list replace
	walTypeIncoming   = "incoming"    // file-tracker snapshot
	walTypeQueue      = "queue"       // queue replace (add/update/remove/shift)
	walTypeTitle      = "title"       // title + source
	walTypeModel      = "model"       // model switch
	walTypeOptions    = "options"     // options replace
	walTypeTurnState  = "turn_state"  // turn activity status flip
	walTypeMeta       = "meta"        // updatedAt / lastDate / lastMode / turn_ms stamps
	walTypeAttach     = "attachments" // attachment list replace (upload)
	walTypeBgTask     = "bg_task"     // bg task register/upsert (id, kind, label, status)
	walTypeBgChunk    = "bg_chunk"    // bg task output chunk append (content tail)
	walTypeBgFinish   = "bg_finish"   // bg task terminal transition (status, trim)
	walTypeWidgets    = "widgets"     // generative-ui widget sources replace
	walTypeSkills     = "skills"      // session skill selection replace
)

// walHeader is always line 1: the turn's recovery record (prompt,
// tracker seed) plus the turn identity needed to detect a
// commit-window crash.
type walHeader struct {
	ExecutionScope string                  `json:"executionScope,omitempty"`
	TurnIndex      int                     `json:"turnIndex"`
	StartedAt      int64                   `json:"startedAt"`
	Model          string                  `json:"model,omitempty"`
	PromptMeta     map[string]string       `json:"promptMeta,omitempty"`
	Prompt         string                  `json:"prompt,omitempty"`
	AttachmentIDs  []string                `json:"attachmentIds,omitempty"`
	Incoming       []filetrack.TrackedFile `json:"incoming,omitempty"`
}

// BgChunk carries one output append for a session-global bg task.
type BgChunk struct {
	JobID string `json:"jobId"`
	Text  string `json:"text"`
}

// BgFinish carries a bg task terminal transition.
type BgFinish struct {
	JobID    string `json:"jobId"`
	Status   string `json:"status"`
	ExitCode int    `json:"exitCode,omitempty"`
	EndedAt  int64  `json:"endedAt,omitempty"`
}

// walEvent is one JSONL line. Only the fields for its Type are set.
//
// Msg is raw JSON (not provider.Message): message Content blocks are an
// interface and only rehydrate through core.HydrateMessageObject, the
// same path disk loads use. Replay hydrates it back.
type walEvent struct {
	V           int                            `json:"v"`
	Type        string                         `json:"type"`
	Header      *walHeader                     `json:"header,omitempty"`
	Msg         json.RawMessage                `json:"msg,omitempty"`
	Usage       *provider.Usage                `json:"usage,omitempty"`
	Context     *SessionContext                `json:"context,omitempty"`
	Compaction  *core.CompactionState          `json:"compaction,omitempty"`
	Todos       []tools.TodoItem               `json:"todos,omitempty"`
	Incoming    []filetrack.TrackedFile        `json:"incoming,omitempty"`
	Queue       []QueuedMessage                `json:"queue,omitempty"`
	Title       string                         `json:"title,omitempty"`
	TitleSource string                         `json:"titleSource,omitempty"`
	Model       string                         `json:"model,omitempty"`
	Options     *SessionOptions                `json:"options,omitempty"`
	TurnStatus  string                         `json:"turnStatus,omitempty"`
	Attachments []AttachmentRef                `json:"attachments,omitempty"`
	Widgets     []tools.WidgetFile             `json:"widgets,omitempty"`
	Skills      map[string]skills.SessionSkill `json:"skills,omitempty"`
	BgTask      *BgTask                        `json:"bgTask,omitempty"`
	BgChunk     *BgChunk                       `json:"bgChunk,omitempty"`
	BgFinish    *BgFinish                      `json:"bgFinish,omitempty"`
	UpdatedAt   int64                          `json:"updatedAt,omitempty"`
	// ApprovalDeadlineUnix persists the 15-min decision deadline inside the
	// WAL: a respawn recomputes the remainder instead of
	// restarting the timer.
	ApprovalDeadlineUnix  int64  `json:"approvalDeadlineUnix,omitempty"`
	ClearApprovalDeadline bool   `json:"clearApprovalDeadline,omitempty"`
	Pinned                *bool   `json:"pinned,omitempty"`
	Jailed                *bool   `json:"jailed,omitempty"`
	TodosOpen             *bool   `json:"todosOpen,omitempty"`
	LastDate              string  `json:"lastDate,omitempty"`
	LastMode              string  `json:"lastMode,omitempty"`
	AttentionSeq          *int64  `json:"attentionSeq,omitempty"`
	SeenSeq               *int64  `json:"seenSeq,omitempty"`
	AttentionKind         *string `json:"attentionKind,omitempty"`
	noTouchUpdatedAt      bool
}

// walWriter is the buffered append handle for one running turn.
type walWriter struct {
	mu       sync.Mutex
	file     *os.File
	w        *bufio.Writer
	path     string
	closed   bool
	closeErr error
}

// ensureBrainDir creates the scratch space (0700, like the data dir).
// Returns "" when the session id is unusable.

// walPath resolves <id>.wal.jsonl, refusing traversal.

// openWAL creates (or truncates) the WAL and writes the header line.

// openWALAppend reopens an existing WAL for append (resume path): the
// valid prefix stays intact; a damaged final event is removed before new
// events are appended. Interior corruption fails without changing the file.

// ensureBrainDir creates the scratch space (0700, like the data dir).
// Returns "" when the session id is unusable.
func (s *diskStore) ensureBrainDir(sessionID string) string {
	dir := s.brainDir(sessionID)
	if dir == "" {
		return ""
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return ""
	}
	return dir
}

// openWAL creates (or truncates) the WAL and writes the header line.
// Every failure path cleans up the half-created file (close + remove):
// a leftover WAL would look like a crashed turn and be resumed as one.
func (s *diskStore) openWAL(sessionID string, h *walHeader) (*walWriter, error) {
	if h.ExecutionScope == "" {
		h.ExecutionScope = randomID8() + randomID8()
	}
	p := s.walPath(sessionID)
	if p == "" {
		return nil, fmt.Errorf("invalid session id")
	}
	// Purge tombstone (audit bug 77): a late turn start must not leave a
	// recovery artifact for a deleted session.
	if sessionPurged(s.dataDir, sessionID) {
		return nil, errSessionPurged
	}
	if err := os.MkdirAll(s.sessionsDir(), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if os.IsExist(err) {
			return nil, fmt.Errorf("openWAL %s: %w", sessionID, errWALExists)
		}
		return nil, err
	}
	cleanup := func(err error) (*walWriter, error) {
		f.Close()
		_ = os.Remove(p) // every error path shares the cleanup
		return nil, err
	}
	ww := &walWriter{file: f, w: bufio.NewWriterSize(f, 64*1024), path: p}
	if err := ww.append(walEvent{V: walVersion, Type: walTypeHeader, Header: h}); err != nil {
		return cleanup(err)
	}
	if err := ww.flush(); err != nil {
		return cleanup(err)
	}
	if err := f.Sync(); err != nil {
		return cleanup(err)
	}
	if walAppendFault != nil {
		if err := walAppendFault(); err != nil {
			return cleanup(err)
		}
	}
	return ww, nil
}

// openWALAppend reopens an existing WAL for append (resume path): the
// valid prefix stays intact; a damaged final event is removed before new
// events are appended. Interior corruption fails without changing the file.
func (s *diskStore) openWALAppend(sessionID string) (*walWriter, error) {
	p := s.walPath(sessionID)
	if p == "" {
		return nil, fmt.Errorf("invalid session id")
	}
	// Windows append handles omit FILE_WRITE_DATA and cannot truncate. The
	// session actor owns this writer exclusively, so seek after tail repair.
	f, err := os.OpenFile(p, os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	data, err := io.ReadAll(f)
	if err != nil {
		f.Close()
		return nil, err
	}
	_, _, validEnd, err := replayWALPrefix(&SessionRecord{ID: sessionID}, data)
	if err != nil {
		f.Close()
		return nil, err
	}
	if validEnd < len(data) {
		if err := f.Truncate(int64(validEnd)); err != nil {
			f.Close()
			return nil, err
		}
	}
	if _, err := f.Seek(int64(validEnd), io.SeekStart); err != nil {
		f.Close()
		return nil, err
	}
	needsNewline := validEnd > 0 && data[validEnd-1] != '\n'
	if needsNewline {
		if _, err := f.WriteString("\n"); err != nil {
			f.Close()
			return nil, err
		}
	}
	if validEnd < len(data) || needsNewline {
		if err := f.Sync(); err != nil {
			f.Close()
			return nil, err
		}
	}
	return &walWriter{file: f, w: bufio.NewWriterSize(f, 64*1024), path: p}, nil
}

// readWALHeader returns the header (line 1) without replaying the body.
// Nil when no WAL exists.
func (s *diskStore) readWALHeader(sessionID string) (*walHeader, error) {
	p := s.walPath(sessionID)
	if p == "" {
		return nil, nil
	}
	f, err := os.Open(p)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 16*1024*1024)
	if !sc.Scan() {
		return nil, nil
	}
	var ev walEvent
	if err := json.Unmarshal(sc.Bytes(), &ev); err != nil {
		return nil, err
	}
	if ev.Type != walTypeHeader || ev.Header == nil {
		return nil, fmt.Errorf("wal %s: missing header", sessionID)
	}
	return ev.Header, nil
}

func (ww *walWriter) append(ev walEvent) error {
	if ww == nil {
		return fmt.Errorf("nil wal writer")
	}
	ev.V = walVersion
	data, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	ww.mu.Lock()
	defer ww.mu.Unlock()
	if _, err := ww.w.Write(data); err != nil {
		return err
	}
	if err := ww.w.WriteByte('\n'); err != nil {
		return err
	}
	return nil
}

func (ww *walWriter) flush() error {
	if ww == nil {
		return nil
	}
	ww.mu.Lock()
	defer ww.mu.Unlock()
	return ww.w.Flush()
}

// close flushes, fsyncs and closes the handle. The file itself stays on
// disk until commitWAL removes it.
func (ww *walWriter) close() error {
	if ww == nil {
		return nil
	}
	ww.mu.Lock()
	defer ww.mu.Unlock()
	if ww.closed {
		return ww.closeErr
	}
	ww.closed = true
	err := ww.w.Flush()
	if syncErr := ww.file.Sync(); err == nil {
		err = syncErr
	}
	if closeErr := ww.file.Close(); err == nil {
		err = closeErr
	}
	ww.closeErr = err
	return err
}

// closeNoSync flushes buffered bytes to the OS cache and closes the handle
// without an extra hardware fsync when commitWAL is immediately syncing the
// superseding v2 turn segment + meta.json before removing the WAL file.
func (ww *walWriter) closeNoSync() error {
	if ww == nil {
		return nil
	}
	ww.mu.Lock()
	defer ww.mu.Unlock()
	if ww.closed {
		return ww.closeErr
	}
	ww.closed = true
	err := ww.w.Flush()
	if closeErr := ww.file.Close(); err == nil {
		err = closeErr
	}
	ww.closeErr = err
	return err
}

// readWALHeader returns the header (line 1) without replaying the body.
// Nil when no WAL exists.

// replayWAL applies every event after the header onto base (which must be
// the frozen JSON record) and returns the fused record. A truncated final
// line (crash mid-write) is ignored; a corrupt middle line aborts the
// replay with an error (fail-closed: never half-apply).
func replayWAL(base *SessionRecord, data []byte) (*SessionRecord, *walHeader, error) {
	rec, header, _, err := replayWALPrefix(base, data)
	return rec, header, err
}

// validEnd is the byte boundary shared by read recovery and append repair.
// Never skip corrupt interior events or discard a valid prefix for a bad tail.
func replayWALPrefix(base *SessionRecord, data []byte) (*SessionRecord, *walHeader, int, error) {
	rec := base
	seen := newMsgDedup(base) // identities of the frozen JSON, for replay dedup
	var header *walHeader
	lines := bytes.Split(data, []byte{'\n'})
	last := len(lines) - 1
	for last >= 0 && len(bytes.TrimSpace(lines[last])) == 0 {
		last--
	}
	offset, validEnd := 0, 0
	for i, line := range lines {
		offset = min(offset+len(line)+1, len(data))
		line = bytes.TrimRight(line, "\r")
		if len(bytes.TrimSpace(line)) == 0 {
			validEnd = offset
			continue
		}
		var ev walEvent
		if err := json.Unmarshal(line, &ev); err != nil {
			// Tolerate only a torn tail write: the last non-empty line
			// may be a partial append from a killed process.
			if i == last && header != nil {
				break
			}
			return nil, nil, 0, fmt.Errorf("wal line %d: %w", i+1, err)
		}
		if i == 0 {
			if ev.Type != walTypeHeader || ev.Header == nil {
				return nil, nil, 0, fmt.Errorf("wal: missing header")
			}
			header = ev.Header
			if header.TurnIndex > rec.TurnSeq {
				rec.TurnSeq = header.TurnIndex
				rec.Status = "running"
				rec.Turn = &TurnActivity{StartedAt: header.StartedAt, Status: "running"}
			}
			validEnd = offset
			continue
		}
		if err := applyWALEvent(rec, &ev, seen); err != nil {
			if i == last {
				break
			}
			return nil, nil, 0, fmt.Errorf("wal line %d: %w", i+1, err)
		}
		validEnd = offset
	}
	if header == nil {
		return nil, nil, 0, fmt.Errorf("wal: empty")
	}
	return rec, header, validEnd, nil
}

func applyWALEvent(rec *SessionRecord, ev *walEvent, seen *msgDedup) error {
	switch ev.Type {
	case walTypeHeader:
		return nil // identity only, already consumed
	case walTypeMsg:
		if len(ev.Msg) == 0 {
			return fmt.Errorf("msg event without message")
		}
		m, err := core.HydrateMessageObject(ev.Msg)
		if err != nil {
			return err
		}
		// Commit-window crash duplicate: the turn line may already hold this
		// message while the WAL was never removed. Replay must dedup by
		// message identity (same rule as assembleRecord), never append blind.
		if seen == nil {
			rec.Messages = append(rec.Messages, m)
		} else if at, known := seen.fold(m, len(rec.Messages)); known {
			rec.Messages[at] = m // newest copy wins, original position
		} else {
			rec.Messages = append(rec.Messages, m)
		}
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
	case walTypeUsage:
		if ev.Usage != nil {
			rec.Usage = *ev.Usage
		}
		if ev.Context != nil {
			rec.Context = ev.Context
		}
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
	case walTypeCompaction:
		if ev.Compaction != nil {
			rec.Compaction = ev.Compaction
		}
		if ev.Usage != nil {
			rec.Usage = *ev.Usage
		}
		if ev.Context != nil {
			rec.Context = ev.Context
		}
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
	case walTypeTodos:
		rec.Todos = append([]tools.TodoItem{}, ev.Todos...)
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
	case walTypeIncoming:
		// Incoming tracker snapshots are replayed by the caller into the
		// live turnFileChanges; the record itself carries no incoming.
		return nil
	case walTypeQueue:
		rec.Queue = cloneQueueSlice(ev.Queue)
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
	case walTypeTitle:
		rec.Title = ev.Title
		rec.TitleSource = ev.TitleSource
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
	case walTypeModel:
		rec.Model = ev.Model
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
	case walTypeOptions:
		if ev.Options != nil {
			rec.Options = *ev.Options
		}
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
	case walTypeTurnState:
		if rec.Turn != nil {
			rec.Turn.Status = ev.TurnStatus
		} else if ev.TurnStatus != "" {
			rec.Turn = &TurnActivity{Status: ev.TurnStatus}
		} else {
			// A turn-state flip without an active turn means the matching
			// turn_start never made it into the WAL (torn tail / crash).
			// Record the drop instead of losing it silently.
			trace("wal.turn_state.orphan", map[string]any{"status": ev.TurnStatus})
		}
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
	case walTypeAttach:
		rec.Attachments = append([]AttachmentRef{}, ev.Attachments...)
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
	case walTypeWidgets:
		rec.Widgets = append([]tools.WidgetFile{}, ev.Widgets...)
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
	case walTypeSkills:
		rec.Skills = cloneSkillsMap(ev.Skills)
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
	case walTypeBgTask:
		if ev.BgTask != nil {
			upsertBgTask(rec, ev.BgTask)
		}
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
	case walTypeBgChunk:
		if ev.BgChunk != nil {
			applyBgChunk(rec, ev.BgChunk.JobID, ev.BgChunk.Text, bgLiveCap)
		}
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
	case walTypeBgFinish:
		if ev.BgFinish != nil {
			applyBgFinish(rec, ev.BgFinish)
		}
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
	case walTypeMeta:
		if ev.Pinned != nil {
			rec.Pinned = *ev.Pinned
		}
		if ev.Jailed != nil {
			rec.Jailed = *ev.Jailed
		}
		if ev.TodosOpen != nil {
			v := *ev.TodosOpen
			rec.TodosOpen = &v
		}
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
		if ev.ClearApprovalDeadline {
			rec.ApprovalDeadlineUnix = 0
		}
		if ev.ApprovalDeadlineUnix > 0 {
			rec.ApprovalDeadlineUnix = ev.ApprovalDeadlineUnix
		}
		if ev.LastDate != "" {
			rec.LastDate = ev.LastDate
		}
		if ev.LastMode != "" {
			rec.LastMode = ev.LastMode
		}
		if ev.AttentionSeq != nil {
			rec.AttentionSeq = *ev.AttentionSeq
		}
		if ev.SeenSeq != nil {
			rec.SeenSeq = *ev.SeenSeq
		}
		if ev.AttentionKind != nil {
			rec.AttentionKind = *ev.AttentionKind
		}
	default:
		return fmt.Errorf("unknown wal event %q", ev.Type)
	}
	return nil
}

// loadSessionFused loads the frozen JSON and, when a WAL exists, replays
// it on top. This is the read path mirrors and history pulls use during
// a running turn: always current, never a mid-turn rewrite.

// commitWAL externalizes any inline images to CAS, scrubs bloated Details,
// appends only newly finished turn(s) to v2 Warm segments in O(turn_size),
// updates meta.json in O(1), and removes .wal.jsonl.
func (s *diskStore) commitWAL(id string, rec *SessionRecord, wal *walWriter) error {
	if rec == nil {
		return fmt.Errorf("nil session")
	}
	var walErr error
	if wal != nil {
		walErr = wal.closeNoSync()
	}
	if !validSessionID(id) {
		return fmt.Errorf("invalid session id")
	}
	if sessionPurged(s.dataDir, id) {
		if p := s.walPath(id); p != "" {
			_ = os.Remove(p)
		}
		return errSessionPurged
	}
	rec.UpdatedAt = time.Now().UnixMilli()

	// Ensure resident messages hold CAS references only (ImageBlock.Data == nil)
	// and scrubbed Details.
	if err := s.externalizeRecordMessages(rec); err != nil {
		return err
	}
	if err := s.ensureV2(id); err != nil {
		return err
	}
	if walErr != nil {
		if err := s.checkpointRecordV2(rec); err != nil {
			return err
		}
		if err := os.Remove(s.walPath(id)); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}

	lastEntry, _, hasLast, rerr := s.v2.LastTurnEntry(id)
	if rerr != nil && !os.IsNotExist(rerr) {
		return rerr
	}
	lastDiskTurn := 0
	if hasLast {
		lastDiskTurn = lastEntry.TurnSeq
	}

	turnIdx := rec.TurnSeq
	minWriteTurn := lastDiskTurn
	if turnIdx > 0 && turnIdx <= lastDiskTurn {
		entries, ierr := s.v2.ReadTurnIndex(id)
		if ierr != nil && !os.IsNotExist(ierr) {
			return ierr
		}
		// Check whether turnIdx on disk already matches rec's messages (idempotent
		// commit-window retry) or needs replacement.
		existingIdx := -1
		for i := len(entries) - 1; i >= 0; i-- {
			if entries[i].TurnSeq == turnIdx {
				existingIdx = i
				break
			}
		}
		turnMsgs := sliceTurnMessages(rec.Messages, turnIdx)
		if existingIdx >= 0 {
			diskMsgs, _, derr := s.v2.ReadTurnRange(id, turnIdx, turnIdx)
			if derr != nil {
				return derr
			}
			if !messagesEqualJSON(diskMsgs, turnMsgs) {
				if err := s.v2.TruncateAfterMsg(id, entries[existingIdx].FirstMsgIdx); err != nil {
					return err
				}
				minWriteTurn = turnIdx - 1
			}
		} else if len(turnMsgs) > 0 {
			// Turn number sits below lastDiskTurn with no matching entry:
			// find insertion point and rewrite tail from there.
			cutMsg := 0
			for _, e := range entries {
				if e.TurnSeq < turnIdx {
					cutMsg = e.LastMsgIdx + 1
				}
			}
			if err := s.v2.TruncateAfterMsg(id, cutMsg); err != nil {
				return err
			}
			minWriteTurn = turnIdx - 1
		}
	}

	writes := buildTurnWritesFromRecord(rec, minWriteTurn)
	meta := recordMeta(rec)
	meta.V, meta.Kind = storeVersion, "meta"
	metaRaw, merr := json.Marshal(&meta)
	if merr != nil {
		return merr
	}
	_, totalTurns, totalMsgs, err := s.v2.AppendTurnsAndMeta(id, writes, metaRaw)
	if err != nil {
		return err
	}
	rec.TotalTurns = totalTurns
	if totalMsgs > 0 {
		rec.TotalMsgs = totalMsgs
	} else {
		rec.TotalMsgs = len(rec.Messages)
	}
	if p := s.walPath(id); p != "" {
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func (s *diskStore) externalizeRecordMessages(rec *SessionRecord) error {
	if rec == nil || len(rec.Messages) == 0 {
		return nil
	}
	for i := range rec.Messages {
		if !messageNeedsCASOrScrub(rec.Messages[i]) {
			continue
		}
		ext, err := s.cas.ExternalizeMessageImages(rec.Messages[i : i+1])
		if err != nil {
			return err
		}
		rec.Messages[i] = sessionstore.ScrubMessageDetails(ext[0])
	}
	return nil
}

func messageNeedsCASOrScrub(m provider.Message) bool {
	for _, blk := range m.Content {
		switch v := blk.(type) {
		case provider.ImageBlock:
			if len(v.Data) > 0 || (v.MimeType == "" && v.MediaType != "") || (v.MediaType == "" && v.MimeType != "" && v.BlobSHA256 != "") {
				return true
			}
		case provider.ToolResultBlock:
			if v.Details != nil {
				return true
			}
			for _, inner := range v.Content {
				if ib, ok := inner.(provider.ImageBlock); ok && len(ib.Data) > 0 {
					return true
				}
			}
		}
	}
	return false
}

func messagesEqualJSON(a, b []provider.Message) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		aj, err1 := json.Marshal(stripTransientMessageDetails(a[i]))
		bj, err2 := json.Marshal(stripTransientMessageDetails(b[i]))
		if err1 != nil || err2 != nil || !bytes.Equal(aj, bj) {
			return false
		}
	}
	return true
}

// msgFingerprint hashes the message content with the ID blanked, so the
// same artifact persisted twice (even once with a synthetic legacy ID)
// fingerprints identically.
func msgFingerprint(m provider.Message) string {
	cp := m
	cp.ID = ""
	data, err := json.Marshal(cp)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// msgDedup carries the identities already persisted (the frozen JSON) so
// WAL replay can tell a duplicate (message already committed to a turn
// line) from a fresh append of the turn in flight.
type msgDedup struct {
	baseIDs map[string]int // ID -> position in the frozen JSON
	baseFPs map[string]int // content fingerprint -> position in the frozen JSON
	walIDs  map[string]int // ID -> position of an earlier event of this replay
}

// newMsgDedup snapshots the base record's identities at replay start. The
// frozen-JSON/WAL boundary is the assembleRecord "across lines" rule: a
// message already on disk is a duplicate; identical ID-less messages
// INSIDE the replay stream stay (they are one line's content).
func newMsgDedup(base *SessionRecord) *msgDedup {
	d := &msgDedup{
		baseIDs: make(map[string]int, len(base.Messages)),
		baseFPs: make(map[string]int, len(base.Messages)),
		walIDs:  make(map[string]int),
	}
	for i := range base.Messages {
		m := base.Messages[i]
		if m.ID != "" {
			d.baseIDs[m.ID] = i
		}
		if fp := msgFingerprint(m); fp != "" {
			d.baseFPs[fp] = i
		}
	}
	return d
}

// fold reports the position of an already-persisted copy of m — the same
// identity rule as assembleRecord: by ID (newest copy wins, ORIGINAL
// position kept), and for ID-less messages by content fingerprint against
// the frozen JSON only (the cross-line legacy-duplicate rule; identical
// ID-less messages inside one replay stream stay). ok is false for a fresh
// message: it lands at pos and is remembered for the following events.
func (d *msgDedup) fold(m provider.Message, pos int) (at int, ok bool) {
	if m.ID != "" {
		if p, seen := d.baseIDs[m.ID]; seen {
			return p, true
		}
		if p, seen := d.walIDs[m.ID]; seen {
			return p, true
		}
		d.walIDs[m.ID] = pos
		return pos, false
	}
	fp := msgFingerprint(m)
	if fp == "" {
		return pos, false
	}
	if p, seen := d.baseFPs[fp]; seen {
		return p, true
	}
	return pos, false
}

// turnLineMatches reports whether the turn line already on disk holds
// exactly the given messages (same count AND same serialized content).
// Comparing content, not just the count, keeps the commit fast path from
// skipping a rewrite when a re-run of the same turn number produced the
// same number of messages with different content (regenerate/edit).
func turnLineMatches(tl turnLine, msgs []provider.Message) bool {
	if len(tl.Messages) != len(msgs) {
		return false
	}
	for i, m := range msgs {
		data, err := json.Marshal(m)
		if err != nil {
			return false
		}
		if !bytes.Equal(tl.Messages[i], data) {
			return false
		}
	}
	return true
}

// sliceTurnMessages extracts one turn's messages with the shared
// turnGroups zero-index attachment rules (splitRecord's own grouping):
// zero-index messages attach to the FOLLOWING turn, trailing zeros to the
// last turn. Every message belongs to exactly one turn line, so a
// zero-index notice between turns is never written into two lines.
// Non-adjacent runs of the same turn index (T1,T2,T1) belong to one turn
// line: accumulate EVERY matching group, not just the first.
func sliceTurnMessages(msgs []provider.Message, turnIdx int) []provider.Message {
	var out []provider.Message
	for _, g := range turnGroups(msgs) {
		if g.turn != turnIdx {
			continue
		}
		for _, i := range g.idx {
			out = append(out, msgs[i])
		}
	}
	return out
}

// recordMeta projects a record onto its meta line.
func recordMeta(rec *SessionRecord) metaLine {
	return metaLine{
		V: storeVersion, Kind: "meta",
		Turn: rec.Turn, Todos: rec.Todos, TodosOpen: rec.TodosOpen,
		Options: rec.Options, ID: rec.ID, CWD: rec.CWD,
		Title: rec.Title, TitleSource: rec.TitleSource,
		Usage: rec.Usage, Context: rec.Context, Model: rec.Model,
		Status: rec.Status, Pinned: rec.Pinned, Jailed: rec.Jailed,
		CreatedAt: rec.CreatedAt, UpdatedAt: rec.UpdatedAt,
		Attachments: rec.Attachments, LastDate: rec.LastDate, LastMode: rec.LastMode,
		Compaction: rec.Compaction, TurnSeq: rec.TurnSeq, Queue: rec.Queue, ApprovalDeadlineUnix: rec.ApprovalDeadlineUnix,
		// BgTasks must survive EVERY meta rewrite (commitWAL, rewriteMetaOnly,
		// persistEdited, truncateTail): a chunk is the only copy of that
		// output, so dropping it here loses the log itself. Mirrors
		// splitRecord's meta projection.
		BgTasks: rec.BgTasks,
		// Widgets ditto: the meta line is their only durable copy after the
		// WAL commits — dropping them here is the "Widget not found" bug.
		Widgets: rec.Widgets,
		// Skills selection survives every meta rewrite like Widgets: the
		// meta line is the durable copy once the WAL commits.
		Skills:        rec.Skills,
		AttentionSeq:  rec.AttentionSeq,
		SeenSeq:       rec.SeenSeq,
		AttentionKind: rec.AttentionKind,
	}
}

// discardWAL closes and removes the WAL without committing (purge path).
func closeWAL(wal **walWriter) {
	if wal != nil && *wal != nil {
		_ = (*wal).close()
		*wal = nil
	}
}

// removeStaleWAL deletes the session's WAL when it cannot hold a turn worth
// resuming (no header, zero/older turn index, or interior corruption that
// openWALAppend cannot repair) and reports whether a file was actually
// removed. A healthy WAL for the current turn — including one with only a
// torn tail write (repairable) — is kept (probe handle closed). Restore-time
// cleanup for the turnResumeCandidate nil-return branches: a WAL may never
// survive idle ("idle = the JSON alone"), and a dead one would otherwise be
// replayed into every read and block the next openWAL (file exists).
func (s *diskStore) removeStaleWAL(id string, rec *SessionRecord) bool {
	p := s.walPath(id)
	if p == "" {
		return false
	}
	if _, err := os.Stat(p); err != nil {
		return false // no WAL: nothing to remove
	}
	dead := false
	header, err := s.readWALHeader(id)
	switch {
	case err != nil || header == nil:
		dead = true // unreadable or no header line
	case header.TurnIndex <= 0:
		dead = true
	case rec != nil && header.TurnIndex < rec.TurnSeq:
		dead = true // turn already committed: dead events
	}
	if !dead {
		w, werr := s.openWALAppend(id)
		if werr != nil {
			dead = true // interior corruption: fail-closed, never resumable
		} else {
			_ = w.close()
		}
	}
	if !dead {
		return false
	}
	if err := os.Remove(p); err != nil {
		return false
	}
	return true
}

// saveSessionSync writes the record atomically (tmp + rename + fsync)
// without emitting a change ping. The WAL commit path batches its own
// single ping after the write.

// scanWALs lists session IDs with a WAL file on disk.

// walMsgEvent builds a msg event from a live message, serializing it in
// the same raw shape disk loads hydrate back.
func walMsgEvent(m provider.Message) walEvent {
	data, err := json.Marshal(stripTransientMessageDetails(m))
	if err != nil {
		return walEvent{Type: walTypeMsg}
	}
	return walEvent{Type: walTypeMsg, Msg: data}
}

// appendWALEvent appends one event to the session's open WAL handle and
// flushes it to the OS (write syscall, no fsync). A SIGKILL loses
// nothing; only an OS/power crash loses the tail. The fsync happens
// once at commit. A nil handle means no turn is in WAL mode and the event
// is dropped (callers fall back to a direct save in that case).
func appendWALEvent(wal *walWriter, ev walEvent) error {
	if wal == nil {
		return nil
	}
	if ev.UpdatedAt == 0 && !ev.noTouchUpdatedAt {
		switch ev.Type {
		case walTypeMsg, walTypeUsage, walTypeCompaction, walTypeTodos,
			walTypeQueue, walTypeTitle, walTypeModel, walTypeOptions,
			walTypeTurnState, walTypeMeta, walTypeAttach, walTypeWidgets,
			walTypeSkills, walTypeBgTask, walTypeBgChunk, walTypeBgFinish:
			ev.UpdatedAt = time.Now().UnixMilli()
		}
	}
	if err := wal.append(ev); err != nil {
		return err
	}
	return wal.flush()
}

// cloneWALHeader deep-copies a header so resume can overlay the latest
// body snapshots without mutating the caller's copy.
func cloneWALHeader(h *walHeader) *walHeader {
	if h == nil {
		return nil
	}
	cp := *h
	cp.AttachmentIDs = append([]string{}, h.AttachmentIDs...)
	cp.Incoming = append([]filetrack.TrackedFile{}, h.Incoming...)
	return &cp
}
