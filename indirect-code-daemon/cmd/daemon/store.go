package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"indirect/indirect-code-daemon/packages/core"
	"indirect/indirect-code-daemon/packages/sessionstore"
)

// Purge tombstones (audit bug 77): a purged session's files are deleted, but a
// late writer (racing incarnation's finalizer, admin fork path) could re-create
// sessions/<id>.jsonl afterwards — resurrecting a deleted session. The
// tombstone blocks every store write for that (dataDir, id) pair after a
// successful purge. Keyed by dataDir too: tests reuse ids across isolated
// tempdirs. In-process only: a restart loses both the tombstone AND the zombie
// writers (the cold load fails on the missing file, never re-creating it).
var (
	purgedMu      sync.Mutex
	purgedSession = map[string]struct{}{}

	v2StoresMu sync.Mutex
	v2Stores   = map[string]*sessionstore.Store{}
)

func sharedV2Store(dataDir string) *sessionstore.Store {
	key := filepath.Clean(dataDir)
	v2StoresMu.Lock()
	defer v2StoresMu.Unlock()
	if st, ok := v2Stores[key]; ok {
		return st
	}
	st := sessionstore.New(key)
	v2Stores[key] = st
	return st
}

func defaultSessionAgePolicy() sessionstore.AgePolicy {
	return sessionstore.AgePolicy{
		HotKeepTurns: 100,
		WarmMaxAge:   7 * 24 * time.Hour,
	}
}

func purgeKey(dataDir, id string) string { return filepath.Clean(dataDir) + "\x00" + id }

// markSessionPurged records that id was deleted from dataDir and fences the
// shared v2 sessionstore against concurrent or late writers/migrators/agers.
func markSessionPurged(dataDir, id string) {
	purgedMu.Lock()
	purgedSession[purgeKey(dataDir, id)] = struct{}{}
	purgedMu.Unlock()
	if dataDir != "" && validSessionID(id) {
		sharedV2Store(dataDir).MarkPurged(id)
	}
}

// sessionPurged reports whether id was deleted from dataDir.
func sessionPurged(dataDir, id string) bool {
	purgedMu.Lock()
	_, ok := purgedSession[purgeKey(dataDir, id)]
	purgedMu.Unlock()
	return ok
}

// errSessionPurged is returned by every store write for a purged session.
var errSessionPurged = sessionstore.ErrSessionPurged

// diskStore is the v2 segmented session/WAL/CAS disk layer.
type diskStore struct {
	dataDir string
	v2      *sessionstore.Store
	cas     *sessionstore.CASStore
}

func newDiskStore(dataDir string) *diskStore {
	v2 := sharedV2Store(dataDir)
	return &diskStore{
		dataDir: dataDir,
		v2:      v2,
		cas:     v2.CAS(),
	}
}

// sessionsDir: the daemon ALWAYS runs with dataDir = the slot dir
// (<root>/slots/slot-a|b), so sessions live at <slot>/sessions.
func (s *diskStore) sessionsDir() string {
	return filepath.Join(s.dataDir, "sessions")
}

func (s *diskStore) sessionFile(id string) string {
	return filepath.Join(s.sessionsDir(), id+".jsonl")
}

// rootDir resolves <root> from the slot dataDir (<root>/slots/slot-x).
func (s *diskStore) rootDir() string {
	if filepath.Base(filepath.Dir(s.dataDir)) == "slots" {
		return filepath.Dir(filepath.Dir(s.dataDir))
	}
	return s.dataDir
}

// brainDir resolves the per-session private scratch space
// (<root>/brain/<sessionID>), refusing traversal.
func (s *diskStore) brainDir(sessionID string) string {
	if sessionID == "" || filepath.Base(sessionID) != sessionID {
		return ""
	}
	return filepath.Join(s.rootDir(), "brain", sessionID)
}

// walPath resolves <id>.wal.jsonl, refusing traversal.
func (s *diskStore) walPath(sessionID string) string {
	if sessionID == "" || filepath.Base(sessionID) != sessionID {
		return ""
	}
	return filepath.Join(s.sessionsDir(), sessionID+".wal.jsonl")
}

// listSessionIDs returns all unique valid session IDs present on disk across
// both v2 segmented directories and legacy .jsonl files.
func (s *diskStore) listSessionIDs() []string {
	entries, err := os.ReadDir(s.sessionsDir())
	if err != nil {
		return nil
	}
	seen := make(map[string]struct{}, len(entries))
	var ids []string
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() {
			if validSessionID(name) && !sessionPurged(s.dataDir, name) && s.v2.HasV2Session(name) {
				if _, ok := seen[name]; !ok {
					seen[name] = struct{}{}
					ids = append(ids, name)
				}
			}
			continue
		}
		if !strings.HasSuffix(name, ".jsonl") || strings.HasSuffix(name, ".wal.jsonl") {
			continue
		}
		id := strings.TrimSuffix(name, ".jsonl")
		if validSessionID(id) && !sessionPurged(s.dataDir, id) {
			if _, ok := seen[id]; !ok {
				seen[id] = struct{}{}
				ids = append(ids, id)
			}
		}
	}
	return ids
}

// ensureV2 migrates a legacy <id>.jsonl file into v2 segmented format if needed.
func (s *diskStore) ensureV2(id string) error {
	if !validSessionID(id) {
		return fmt.Errorf("invalid session id")
	}
	if s.v2.HasV2Session(id) {
		return nil
	}
	if s.v2.HasLegacySession(id) {
		return s.v2.MigrateLegacyFile(context.Background(), s.sessionFile(id), defaultSessionAgePolicy())
	}
	return nil
}

// readMeta reads ONLY session metadata in O(1) (v2 meta.json or legacy .jsonl tail).
func (s *diskStore) readMeta(id string) (metaLine, error) {
	var meta metaLine
	if !validSessionID(id) {
		return meta, fmt.Errorf("invalid session id")
	}
	if s.v2.HasV2Session(id) {
		raw, err := s.v2.ReadMeta(id)
		if err != nil {
			return meta, err
		}
		if err := json.Unmarshal(raw, &meta); err != nil {
			return meta, err
		}
		return meta, nil
	}
	return s.readMetaTail(id)
}

// writeMetaV2 writes ONLY session metadata to v2 meta.json in O(1).
func (s *diskStore) writeMetaV2(id string, meta metaLine) error {
	if !validSessionID(id) {
		return fmt.Errorf("invalid session id")
	}
	if sessionPurged(s.dataDir, id) {
		return errSessionPurged
	}
	meta.V, meta.Kind = storeVersion, "meta"
	raw, err := json.Marshal(&meta)
	if err != nil {
		return err
	}
	return s.v2.WriteMeta(id, raw)
}

func recordFromMeta(meta metaLine) *SessionRecord {
	return &SessionRecord{
		Turn: meta.Turn, Todos: meta.Todos, TodosOpen: meta.TodosOpen,
		Options: meta.Options, ID: meta.ID, CWD: meta.CWD,
		Title: meta.Title, TitleSource: meta.TitleSource,
		LastDate: meta.LastDate, LastMode: meta.LastMode,
		Usage: meta.Usage, Context: meta.Context, Model: meta.Model,
		Status: meta.Status, Pinned: meta.Pinned, Jailed: meta.Jailed,
		CreatedAt: meta.CreatedAt, UpdatedAt: meta.UpdatedAt,
		Attachments: meta.Attachments, Compaction: meta.Compaction,
		Skills:               meta.Skills,
		TurnSeq:              meta.TurnSeq,
		Queue:                meta.Queue,
		ApprovalDeadlineUnix: meta.ApprovalDeadlineUnix,
		BgTasks:              meta.BgTasks,
		Widgets:              meta.Widgets,
		AttentionSeq:         meta.AttentionSeq,
		SeenSeq:              meta.SeenSeq,
		AttentionKind:        meta.AttentionKind,
	}
}

// computeHotWindowStartEntry selects the earliest turn index entry [0..n) that
// must remain resident in RAM: min(compactionCoverageTurn, tailDisplayFirstTurn).
func computeHotWindowStartEntry(entries []sessionstore.TurnEntry, comp *core.CompactionState) int {
	n := len(entries)
	if n == 0 {
		return 0
	}
	// 1. Display tail floor (128K tok / 200 msgs, always >= 1 turn).
	tailLo := n - 1
	tok := max(1, entries[tailLo].TokenEst)
	msgs := entries[tailLo].MsgCount()
	for tailLo > 0 {
		prev := entries[tailLo-1]
		if tok >= historyBlockTokens || msgs >= historyBlockMaxMessages {
			break
		}
		tailLo--
		tok += max(1, prev.TokenEst)
		msgs += prev.MsgCount()
	}

	// 2. Active post-compaction era floor (>= comp.CoverageEnd()).
	covEnd := 0
	if comp != nil {
		covEnd = comp.CoverageEnd()
	}
	covLo := 0
	if covEnd > 0 {
		covLo = sort.Search(n, func(i int) bool {
			return entries[i].LastMsgIdx >= covEnd
		})
	}

	return min(covLo, tailLo)
}

// loadSession loads a full session record (hydrating CAS images for callers/tests
// that inspect full frozen transcripts).
func (s *diskStore) loadSession(id string) (*SessionRecord, error) {
	if !validSessionID(id) {
		return nil, fmt.Errorf("invalid session id")
	}
	if s.v2.HasV2Session(id) {
		meta, err := s.readMeta(id)
		if err != nil {
			return nil, err
		}
		rec := recordFromMeta(meta)
		if rec.ID != id || rec.ID == "" {
			return nil, fmt.Errorf("session id mismatch")
		}
		entries, err := s.v2.ReadTurnIndex(id)
		if err != nil && !os.IsNotExist(err) {
			return nil, err
		}
		if len(entries) > 0 {
			msgs, bals, rerr := s.v2.ReadTurnRange(id, 0, 0)
			if rerr != nil {
				return nil, rerr
			}
			hyd, herr := s.cas.HydrateMessageImages(msgs)
			if herr == nil && hyd != nil {
				msgs = hyd
			}
			rec.Messages = msgs
			rec.FileBalloons = bals
			rec.TotalTurns = len(entries)
			rec.TotalMsgs = len(msgs)
			hasIndexed := false
			for _, m := range rec.Messages {
				if m.TurnIndex > 0 {
					hasIndexed = true
					break
				}
			}
			lastTurn := entries[len(entries)-1].TurnSeq
			if hasIndexed && rec.TurnSeq < lastTurn {
				rec.TurnSeq = lastTurn
			}
		}
		ensureTranscriptIDs(rec)
		if migrateLegacyWidgets(rec) {
			if err := s.saveSessionSync(rec); err != nil {
				return nil, fmt.Errorf("widget migration: %w", err)
			}
		}
		return rec, nil
	}

	lines, meta, err := s.readSessionFile(id)
	if err != nil {
		return nil, err
	}
	rec := assembleRecord(lines, meta)
	if rec.ID != id || rec.ID == "" {
		return nil, fmt.Errorf("session id mismatch")
	}
	if len(rec.Messages) > 0 {
		if hyd, herr := s.cas.HydrateMessageImages(rec.Messages); herr == nil && hyd != nil {
			rec.Messages = hyd
		}
	}
	rec.TotalTurns = len(lines)
	rec.TotalMsgs = len(rec.Messages)
	if migrateLegacyWidgets(rec) {
		if err := s.saveSessionSync(rec); err != nil {
			return nil, fmt.Errorf("widget migration: %w", err)
		}
	}
	return rec, nil
}

// loadSessionHotFused loads ONLY the bounded Hot Resident Window (with CAS blob
// references and ImageBlock.Data == nil) plus any uncommitted WAL on top.
// When migrateColdLegacy is true and no WAL exists on disk, a legacy <id>.jsonl
// session is stream-migrated into v2 first.
func (s *diskStore) loadSessionHotFused(id string, migrateColdLegacy bool) (*SessionRecord, *walHeader, error) {
	if !validSessionID(id) {
		return nil, nil, fmt.Errorf("invalid session id")
	}
	p := s.walPath(id)
	var walData []byte
	hasWAL := false
	if p != "" {
		data, err := os.ReadFile(p)
		if err == nil {
			walData = data
			hasWAL = true
		} else if !os.IsNotExist(err) {
			return nil, nil, err
		}
	}

	if migrateColdLegacy && !hasWAL && !s.v2.HasV2Session(id) && s.v2.HasLegacySession(id) {
		if err := s.v2.MigrateLegacyFile(context.Background(), s.sessionFile(id), defaultSessionAgePolicy()); err != nil {
			return nil, nil, err
		}
	}

	var rec *SessionRecord
	if s.v2.HasV2Session(id) {
		meta, err := s.readMeta(id)
		if err != nil {
			return nil, nil, err
		}
		rec = recordFromMeta(meta)
		if rec.ID != id || rec.ID == "" {
			return nil, nil, fmt.Errorf("session id mismatch")
		}
		entries, err := s.v2.ReadTurnIndex(id)
		if err != nil && !os.IsNotExist(err) {
			return nil, nil, err
		}
		n := len(entries)
		if n > 0 {
			hotLo := computeHotWindowStartEntry(entries, rec.Compaction)
			startMsgIdx := entries[hotLo].FirstMsgIdx
			msgs, bals, rerr := s.v2.ReadFromMsgIdx(id, startMsgIdx)
			if rerr != nil {
				return nil, nil, rerr
			}
			rec.Messages = msgs
			rec.FileBalloons = bals
			if hotLo > 0 {
				rec.HotBaseTurn = entries[hotLo].TurnSeq
				rec.HotBaseMsgIdx = startMsgIdx
			}
			rec.TotalTurns = n
			rec.TotalMsgs = entries[n-1].LastMsgIdx + 1

			hasIndexed := false
			for _, m := range rec.Messages {
				if m.TurnIndex > 0 {
					hasIndexed = true
					break
				}
			}
			lastTurn := entries[n-1].TurnSeq
			if hasIndexed && rec.TurnSeq < lastTurn {
				rec.TurnSeq = lastTurn
			}
		}
		ensureTranscriptIDs(rec)
		if rec.HotBaseMsgIdx == 0 && migrateLegacyWidgets(rec) {
			if err := s.saveSessionSync(rec); err != nil {
				return nil, nil, fmt.Errorf("widget migration: %w", err)
			}
		}
	} else {
		lines, meta, err := s.readSessionFile(id)
		if err != nil {
			return nil, nil, err
		}
		rec = assembleRecord(lines, meta)
		if rec.ID != id || rec.ID == "" {
			return nil, nil, fmt.Errorf("session id mismatch")
		}
		if len(rec.Messages) > 0 {
			ext, eerr := s.cas.ExternalizeMessageImages(rec.Messages)
			if eerr != nil {
				return nil, nil, eerr
			}
			rec.Messages = sessionstore.ScrubMessagesDetails(ext)
		}
		rec.TotalTurns = len(lines)
		rec.TotalMsgs = len(rec.Messages)
		if migrateLegacyWidgets(rec) {
			if err := s.saveSessionSync(rec); err != nil {
				return nil, nil, fmt.Errorf("widget migration: %w", err)
			}
		}
	}

	if !hasWAL {
		return rec, nil, nil
	}
	prevLen := len(rec.Messages)
	fused, header, err := replayWAL(rec, walData)
	if err != nil {
		return nil, nil, err
	}
	if len(fused.Messages) > 0 {
		// Externalize any inline images replayed from WAL events.
		startExt := max(0, prevLen-8)
		extTail, eerr := s.cas.ExternalizeMessageImages(fused.Messages[startExt:])
		if eerr != nil {
			return nil, nil, eerr
		}
		copy(fused.Messages[startExt:], sessionstore.ScrubMessagesDetails(extTail))
	}
	ensureTranscriptIDs(fused)
	fused.TotalMsgs = fused.HotBaseMsgIdx + len(fused.Messages)
	return fused, header, nil
}

// loadSessionFused loads the frozen session and, when a WAL exists, replays
// it on top without mutating legacy .jsonl fixtures on disk.
func (s *diskStore) loadSessionFused(id string) (*SessionRecord, *walHeader, error) {
	rec, err := s.loadSession(id)
	if err != nil {
		return nil, nil, err
	}
	p := s.walPath(id)
	if p == "" {
		return rec, nil, nil
	}
	data, err := os.ReadFile(p)
	if err != nil {
		if os.IsNotExist(err) {
			return rec, nil, nil
		}
		return nil, nil, err
	}
	fused, header, err := replayWAL(rec, data)
	if err != nil {
		return nil, nil, err
	}
	fused.TotalMsgs = fused.HotBaseMsgIdx + len(fused.Messages)
	return fused, header, nil
}

// saveSessionSync writes the record atomically. Existing v2 sessions update v2
// (preserving any prefix turns < rec.HotBaseMsgIdx); legacy fixtures write .jsonl
// until opened/committed into v2.
func (s *diskStore) saveSessionSync(rec *SessionRecord) error {
	if rec == nil {
		return fmt.Errorf("nil session")
	}
	if sessionPurged(s.dataDir, rec.ID) {
		return errSessionPurged
	}
	if s.v2.HasV2Session(rec.ID) {
		return s.checkpointRecordV2(rec)
	}
	lines, meta := splitRecord(rec)
	return s.writeSessionFile(rec.ID, lines, meta)
}

func (s *diskStore) checkpointRecordV2(rec *SessionRecord) error {
	if !validSessionID(rec.ID) {
		return fmt.Errorf("invalid session id")
	}
	if sessionPurged(s.dataDir, rec.ID) {
		return errSessionPurged
	}
	if err := s.ensureV2(rec.ID); err != nil {
		return err
	}
	if err := s.v2.TruncateAfterMsg(rec.ID, rec.HotBaseMsgIdx); err != nil {
		return err
	}
	writes := buildTurnWritesFromRecord(rec, 0)
	if len(writes) > 0 {
		if _, err := s.v2.AppendTurns(rec.ID, writes); err != nil {
			return err
		}
	}
	return s.writeMetaV2(rec.ID, recordMeta(rec))
}

// scanWALs lists session IDs with a WAL file on disk.
func (s *diskStore) scanWALs() []string {
	entries, err := os.ReadDir(s.sessionsDir())
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || len(name) < 10 || name[len(name)-10:] != ".wal.jsonl" {
			continue
		}
		out = append(out, name[:len(name)-10])
	}
	return out
}
