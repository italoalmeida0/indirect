package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"indirect/indirect-code-daemon/internal/durable"
	"indirect/indirect-code-daemon/packages/agent/tools"
	"indirect/indirect-code-daemon/packages/core"
	"indirect/indirect-code-daemon/packages/filetrack"
	"indirect/indirect-code-daemon/packages/provider"
	"indirect/indirect-code-daemon/packages/skills"
)

// Session store: one JSONL file per session, one line per finished turn,
// metadata ALWAYS on the last line.
//
//	{"v":1,"kind":"turn","turn":1,"messages":[...],"balloon":{...},"usage":{...}}
//	{"v":1,"kind":"turn","turn":2,...}
//	{"v":1,"kind":"meta","id":"sess_x",...}
//
// Why: finished turns are immutable (append + tail-truncate only), so old
// lines are NEVER rewritten. The hot paths touch only the tail:
//   - appendTurn:  append 1 line (turn commit)
//   - rewriteMeta: rewrite the LAST line only (title/queue/options/status)
//   - truncate:    cut tail lines + rewrite meta (edit/regenerate)
//   - tail reads:  read backwards (get_session/get_history never scan all)
// Full scans happen only for resume/fork/evict-reload (rare, sequential).

const storeVersion = 1

// turnLine is one finished turn. Usage is the cumulative session usage at
// turn end (same semantics as SessionRecord.Usage today); Context is the
// estimate snapshot (nil when never computed).
type turnLine struct {
	V        int                    `json:"v"`
	Kind     string                 `json:"kind"` // "turn"
	Turn     int                    `json:"turn"`
	Messages []json.RawMessage      `json:"messages"`
	Balloon  *filetrack.TurnChanges `json:"balloon,omitempty"`
	Usage    provider.Usage         `json:"usage"`
	Context  *SessionContext        `json:"context,omitempty"`
}

// metaLine is the session metadata (always the last line). It mirrors the
// non-transcript fields of SessionRecord.
type metaLine struct {
	V           int                   `json:"v"`
	Kind        string                `json:"kind"` // "meta"
	Turn        *TurnActivity         `json:"turn,omitempty"`
	Todos       []tools.TodoItem      `json:"todos,omitempty"`
	TodosOpen   *bool                 `json:"todosOpen,omitempty"`
	Options     SessionOptions        `json:"options"`
	ID          string                `json:"id"`
	CWD         string                `json:"cwd"`
	Title       string                `json:"title"`
	TitleSource string                `json:"titleSource,omitempty"`
	Usage       provider.Usage        `json:"usage"`
	Context     *SessionContext       `json:"context,omitempty"`
	Model       string                `json:"model"`
	Status      string                `json:"status"`
	Jailed      bool                  `json:"jailed,omitempty"`
	Pinned      bool                  `json:"pinned,omitempty"`
	CreatedAt   int64                 `json:"createdAt"`
	UpdatedAt   int64                 `json:"updatedAt"`
	Attachments []AttachmentRef       `json:"attachments,omitempty"`
	LastDate    string                `json:"lastDate,omitempty"`
	LastMode    string                `json:"lastMode,omitempty"`
	Compaction  *core.CompactionState `json:"compaction,omitempty"`
	TurnSeq     int                   `json:"turnSeq,omitempty"`
	Queue       []QueuedMessage       `json:"queue,omitempty"`
	// ApprovalDeadlineUnix bounds a pending approval/question (15-min timer).
	// Persisted so a respawn recomputes the remainder — a restart never
	// bypasses the timeout. Zero = no pending decision.
	ApprovalDeadlineUnix int64 `json:"approvalDeadlineUnix,omitempty"`
	// BgTasks are the session-global background tasks (content tail +
	// counters). Persisted on EVERY save: a chunk is the only copy of
	// that output (the runner log dies at terminal), so losing BgTasks
	// in a crash loses the log itself.
	BgTasks []BgTask `json:"bgTasks,omitempty"`
	// Widgets are the generative-ui widget sources (SessionRecord.Widgets).
	// Persisted on EVERY meta rewrite (commitWAL, rewriteMetaOnly, …): the
	// meta line is the only durable copy once the WAL commits and is
	// removed — dropping them here loses the widget store at the next
	// restart (the "Widget not found" bug).
	Widgets []tools.WidgetFile `json:"widgets,omitempty"`
	// Skills are the session's skill selection (SessionRecord.Skills):
	// priority order + active + usable override per skill name. Persisted
	// on every meta rewrite like Widgets — the meta line is the durable
	// copy once the WAL commits.
	Skills map[string]skills.SessionSkill `json:"skills,omitempty"`
}

// validSessionID refuses traversal.
func validSessionID(id string) bool {
	return id != "" && !strings.ContainsAny(id, "/\\") && id != "." && id != ".."
}

// tmpOrphanPrefixes lists tmp file prefixes our writers use (all
// tmp+rename, never valid data). tmpOrphanSuffixes covers the migration
// rewriters' `<path>.vNtmp` shape. sweepTmpOrphans removes stale ones.
var tmpOrphanPrefixes = []string{
	".session-", ".migrate-", ".storage-version-", ".daemon-", ".launcher-", ".dl-",
	// Writer tmp+rename debris (audit bug 72) — see each writer's CreateTemp:
	".config-",       // config.go
	".publish-",      // internal/durable
	".upd-",          // boot_update.go / update_flow.go
	".stage-",        // fetch.go (bin stage)
	".app-",          // handoff.go (app copy)
	".stage-runner-", // runner_client.go (runner binary stage)
	// NOTE: turn_attachments.go writes "att-*" and KEEPS that name as the
	// committed file (AttachmentRef.ID is its basename) — it is NOT tmp
	// debris and must never be swept.
}
var tmpOrphanSuffixes = []string{".v3tmp", ".v4tmp"}

// sweepTmpOrphans removes crashed-run tmp files older than maxAge in dir and
// its subdirectories (the writers scatter tmp across sessions/, bin/,
// runners/, <sid>/attachments/ and the root). Log/jsonl/json files never
// match a tmp prefix or suffix, so GC-exempt dirs (runners/out) keep their
// logs. Returns the count removed.
func sweepTmpOrphans(dir string, maxAge time.Duration) int {
	now := time.Now()
	n := 0
	_ = filepath.WalkDir(dir, func(path string, e os.DirEntry, err error) error {
		if err != nil || e.IsDir() {
			return nil
		}
		name := e.Name()
		match := false
		for _, p := range tmpOrphanPrefixes {
			if strings.HasPrefix(name, p) {
				match = true
				break
			}
		}
		if !match {
			for _, s := range tmpOrphanSuffixes {
				if strings.HasSuffix(name, s) {
					match = true
					break
				}
			}
		}
		if !match {
			return nil
		}
		info, err := e.Info()
		if err != nil || now.Sub(info.ModTime()) < maxAge {
			return nil
		}
		if err := os.Remove(path); err == nil {
			n++
		}
		return nil
	})
	return n
}

// splitRecord breaks a record into per-turn lines + meta. Messages with
// TurnIndex 0 (pre-turn notices) attach to the following turn; trailing
// zero-index messages attach to the last turn. Balloons ride their turn.
func splitRecord(rec *SessionRecord) ([]turnLine, metaLine) {
	meta := metaLine{
		V: recTurnSeqGuard(), Kind: "meta",
		Turn: rec.Turn, Todos: rec.Todos, TodosOpen: rec.TodosOpen,
		Options: rec.Options, ID: rec.ID, CWD: rec.CWD,
		Title: rec.Title, TitleSource: rec.TitleSource,
		Usage: rec.Usage, Context: rec.Context, Model: rec.Model,
		Status: rec.Status, Pinned: rec.Pinned, Jailed: rec.Jailed,
		CreatedAt: rec.CreatedAt, UpdatedAt: rec.UpdatedAt,
		Attachments: rec.Attachments, LastDate: rec.LastDate, LastMode: rec.LastMode,
		Compaction: rec.Compaction, TurnSeq: rec.TurnSeq, Queue: rec.Queue,
		ApprovalDeadlineUnix: rec.ApprovalDeadlineUnix,
		BgTasks:              rec.BgTasks,
		Widgets:              rec.Widgets,
		Skills:               rec.Skills,
	}
	// Group message indices by turn with the shared rule (turnGroups):
	// zero-index messages attach to the FOLLOWING turn, trailing zeros to
	// the last group (turn 1 when everything is zero-indexed).
	groups := turnGroups(rec.Messages)
	balloonsByTurn := map[int]*filetrack.TurnChanges{}
	for i := range rec.FileBalloons {
		b := rec.FileBalloons[i]
		cp := b
		balloonsByTurn[b.TurnIndex] = &cp
	}
	lines := make([]turnLine, 0, len(groups))
	for _, g := range groups {
		raw := make([]json.RawMessage, 0, len(g.idx))
		for _, i := range g.idx {
			data, err := json.Marshal(rec.Messages[i])
			if err != nil {
				continue
			}
			raw = append(raw, data)
		}
		lines = append(lines, turnLine{
			V: storeVersion, Kind: "turn", Turn: g.turn,
			Messages: raw, Balloon: balloonsByTurn[g.turn],
			Usage: rec.Usage, Context: rec.Context,
		})
	}
	return lines, meta
}

// recTurnSeqGuard is a tiny indirection so splitRecord stays testable
// without a record; always returns storeVersion.
func recTurnSeqGuard() int { return storeVersion }

// dropTurnForPrefix returns the first turn to DROP such that every turn
// fully within msgs is kept. Mirrors splitRecord's grouping: leading
// zero-index messages attach to the first non-zero turn (or turn 1 when
// all messages are zero-indexed).
func dropTurnForPrefix(msgs []provider.Message) int {
	maxTurn := 0
	for _, m := range msgs {
		if m.TurnIndex > maxTurn {
			maxTurn = m.TurnIndex
		}
	}
	if maxTurn <= 0 {
		// All zero-index: single turn-1 line — keep it.
		return 2
	}
	return maxTurn + 1
}

// writeSessionFile atomically replaces <id>.jsonl (tmp + rename + fsync).
func (s *diskStore) writeSessionFile(id string, lines []turnLine, meta metaLine) error {
	if !validSessionID(id) {
		return fmt.Errorf("invalid session id")
	}
	// Purge tombstone (audit bug 77): a late writer must never re-create a
	// deleted session's file.
	if sessionPurged(s.dataDir, id) {
		return errSessionPurged
	}
	dir := s.sessionsDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".session-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	w := bufio.NewWriterSize(tmp, 64*1024)
	write := func(v any) error {
		data, err := json.Marshal(v)
		if err != nil {
			return err
		}
		if _, err := w.Write(data); err != nil {
			return err
		}
		return w.WriteByte('\n')
	}
	for i := range lines {
		if err := write(&lines[i]); err != nil {
			tmp.Close()
			return err
		}
	}
	meta.V, meta.Kind = storeVersion, "meta"
	if err := write(&meta); err != nil {
		tmp.Close()
		return err
	}
	if err := w.Flush(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := durable.Rename(tmpName, s.sessionFile(id)); err != nil {
		return err
	}
	if df, err := os.Open(dir); err == nil {
		_ = df.Sync()
		df.Close()
	}
	return nil
}

// readSessionFile loads a full session (scan). Tolerates a torn tail line
// (crash mid-append): the partial last line is dropped; when the torn
// line is the meta, the previous meta-bearing state is unrecoverable and
// an error is returned (callers treat as corrupt).
func (s *diskStore) readSessionFile(id string) ([]turnLine, metaLine, error) {
	var meta metaLine
	if !validSessionID(id) {
		return nil, meta, fmt.Errorf("invalid session id")
	}
	data, err := os.ReadFile(s.sessionFile(id))
	if err != nil {
		return nil, meta, err
	}
	var lines []turnLine
	var lastValidMeta *metaLine
	// Track byte offset to detect a torn (non-newline-terminated) tail.
	tornTail := len(data) > 0 && data[len(data)-1] != '\n'
	scLines := bytes.Split(data, []byte{'\n'})
	for i, line := range scLines {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		isLast := i == len(scLines)-1
		var probe struct {
			Kind string `json:"kind"`
			V    int    `json:"v"`
		}
		if err := json.Unmarshal(line, &probe); err != nil {
			// Only a torn TAIL is tolerable (partial write at crash).
			if isLast && tornTail {
				continue
			}
			return nil, meta, fmt.Errorf("line %d: %w", i+1, err)
		}
		switch probe.Kind {
		case "turn":
			var tl turnLine
			if err := json.Unmarshal(line, &tl); err != nil {
				if isLast && tornTail {
					continue
				}
				return nil, meta, fmt.Errorf("line %d: %w", i+1, err)
			}
			lines = append(lines, tl)
		case "meta":
			var ml metaLine
			if err := json.Unmarshal(line, &ml); err != nil {
				if isLast && tornTail {
					continue
				}
				return nil, meta, fmt.Errorf("line %d: %w", i+1, err)
			}
			cp := ml
			lastValidMeta = &cp
		default:
			return nil, meta, fmt.Errorf("line %d: unknown kind %q", i+1, probe.Kind)
		}
	}
	if lastValidMeta == nil {
		return nil, meta, fmt.Errorf("no meta line")
	}
	return lines, *lastValidMeta, nil
}

// assembleRecord fuses turn lines + meta into a SessionRecord (hydrate
// messages via the same record-hydration path).
func assembleRecord(lines []turnLine, meta metaLine) *SessionRecord {
	rec := &SessionRecord{
		Turn: meta.Turn, Todos: meta.Todos, TodosOpen: meta.TodosOpen,
		Options: meta.Options, ID: meta.ID, CWD: meta.CWD,
		Title: meta.Title, TitleSource: meta.TitleSource,
		LastDate: meta.LastDate, LastMode: meta.LastMode,
		Usage: meta.Usage, Context: meta.Context, Model: meta.Model,
		Status: meta.Status, Pinned: meta.Pinned, Jailed: meta.Jailed,
		CreatedAt: meta.CreatedAt, UpdatedAt: meta.UpdatedAt,
		Attachments: meta.Attachments, Compaction: meta.Compaction,
		Skills:  meta.Skills,
		TurnSeq: meta.TurnSeq, Queue: meta.Queue,
		ApprovalDeadlineUnix: meta.ApprovalDeadlineUnix,
		BgTasks:              meta.BgTasks,
		Widgets:              meta.Widgets,
	}
	// Merge turn lines by message identity instead of "last line wins":
	// lines sharing a Turn merge in order, deduped by message ID (the
	// complete later copy replaces the partial earlier one in place) and,
	// for ID-less messages, by content fingerprint ACROSS lines (the same
	// zero-index notice used to be written into two turn lines; those
	// legacy duplicates collapse here on read). Duplicates inside one
	// line are kept: a single line never repeats a message artifact.
	idPos := make(map[string]int)
	fpSeen := make(map[string]bool) // fingerprints of finished lines
	var lastLineTurn int
	seenBalloons := make(map[int]struct{})
	fingerprint := func(msg provider.Message) string {
		cp := msg
		cp.ID = ""
		data, err := json.Marshal(cp)
		if err != nil {
			return ""
		}
		sum := sha256.Sum256(data)
		return hex.EncodeToString(sum[:])
	}
	for _, tl := range lines {
		lastLineTurn = tl.Turn
		fpThisLine := make(map[string]bool)
		for _, raw := range tl.Messages {
			msg, err := core.HydrateMessageObject(raw)
			if err != nil {
				continue
			}
			if msg.ID != "" {
				if pos, seen := idPos[msg.ID]; seen {
					// Same message on another line: the newest copy wins,
					// keeping the original transcript position.
					rec.Messages[pos] = msg
					continue
				}
				idPos[msg.ID] = len(rec.Messages)
				rec.Messages = append(rec.Messages, msg)
				continue
			}
			fp := fingerprint(msg)
			if fp == "" {
				rec.Messages = append(rec.Messages, msg)
				continue
			}
			if fpThisLine[fp] {
				// Repeated inside the same line: legitimate content.
				rec.Messages = append(rec.Messages, msg)
				continue
			}
			if fpSeen[fp] {
				// Same ID-less message on another line: legacy duplicate.
				continue
			}
			fpThisLine[fp] = true
			rec.Messages = append(rec.Messages, msg)
		}
		for fp := range fpThisLine {
			fpSeen[fp] = true
		}
		if tl.Balloon != nil {
			if _, seen := seenBalloons[tl.Balloon.TurnIndex]; !seen {
				seenBalloons[tl.Balloon.TurnIndex] = struct{}{}
				cp := *tl.Balloon
				rec.FileBalloons = append(rec.FileBalloons, cp)
			}
		}
	}
	// Commit-window reconcile: torn meta rewrite after a turn append
	// leaves TurnSeq one behind the lines on disk — trust the lines.
	// Guard: only when real (non-zero) turn indexing exists. All-zero
	// all-zero test transcripts group as a fabricated turn-1 line that
	// must NOT advance TurnSeq (it isn't turn 1).
	hasIndexed := false
	for _, m := range rec.Messages {
		if m.TurnIndex > 0 {
			hasIndexed = true
			break
		}
	}
	if hasIndexed {
		if len(lines) > 0 && rec.TurnSeq < lastLineTurn {
			rec.TurnSeq = lastLineTurn
		}
	}
	ensureTranscriptIDs(rec)
	return rec
}

// readMetaTail reads ONLY the last line (seek from end): the sidebar /
// pull path never touches transcripts.
func (s *diskStore) readMetaTail(id string) (metaLine, error) {
	var meta metaLine
	if !validSessionID(id) {
		return meta, fmt.Errorf("invalid session id")
	}
	f, err := os.Open(s.sessionFile(id))
	if err != nil {
		return meta, err
	}
	defer f.Close()
	line, err := readLastLine(f)
	if err != nil {
		return meta, err
	}
	// Torn tail (crash mid-append of a turn line): step one line back —
	// the meta is the last VALID line.
	if err := json.Unmarshal(line, &meta); err != nil || meta.Kind != "meta" {
		prev, perr := readSecondToLastLine(f)
		if perr == nil {
			var m2 metaLine
			if jerr := json.Unmarshal(prev, &m2); jerr == nil && m2.Kind == "meta" {
				return m2, nil
			}
		}
		// Probe missed (giant meta beyond 64KB, or deeper damage):
		// full scan, which tolerates exactly one torn tail line.
		_, full, ferr := s.readSessionFile(id)
		if ferr != nil {
			return meta, fmt.Errorf("no meta line")
		}
		return full, nil
	}
	return meta, nil
}

// readLastLine seeks from the end and returns the last non-empty line.
func readLastLine(f *os.File) ([]byte, error) {
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	size := st.Size()
	if size == 0 {
		return nil, io.EOF
	}
	const chunk = 4096
	var buf []byte
	off := size
	for {
		n := int64(chunk)
		if off < n {
			n = off
		}
		off -= n
		tmp := make([]byte, n)
		if _, err := f.ReadAt(tmp, off); err != nil {
			return nil, err
		}
		buf = append(tmp, buf...)
		if off == 0 {
			break
		}
		if i := bytes.LastIndexByte(buf, '\n'); i >= 0 {
			// Found a newline: everything after the LAST newline...
			tail := bytes.TrimRight(buf[i+1:], "\r\n")
			if len(bytes.TrimSpace(tail)) > 0 {
				return tail, nil
			}
			// File ends with newline: take the line before it.
			buf = buf[:i]
			if j := bytes.LastIndexByte(buf, '\n'); j >= 0 {
				return bytes.TrimRight(buf[j+1:], "\r\n"), nil
			}
			return bytes.TrimRight(buf, "\r\n"), nil
		}
		if int64(len(buf)) >= size {
			break
		}
	}
	line := bytes.TrimRight(buf, "\r\n")
	if len(bytes.TrimSpace(line)) == 0 {
		return nil, io.EOF
	}
	// Multiple lines and no newline found yet (huge single chunk already
	// read everything): take the last line.
	if i := bytes.LastIndexByte(line, '\n'); i >= 0 {
		return line[i+1:], nil
	}
	return line, nil
}

// readSecondToLastLine returns the line before the last line (for torn
// tail recovery in readMetaTail).
func readSecondToLastLine(f *os.File) ([]byte, error) {
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	size := st.Size()
	if size == 0 {
		return nil, io.EOF
	}
	// Read the tail chunk (meta + maybe a torn line fit in 64KB; meta
	// lines are small — queue/todos/options only).
	n := int64(64 * 1024)
	if size < n {
		n = size
	}
	buf := make([]byte, n)
	if _, err := f.ReadAt(buf, size-n); err != nil {
		return nil, err
	}
	buf = bytes.TrimRight(buf, "\r\n")
	i := bytes.LastIndexByte(buf, '\n')
	if i < 0 {
		return nil, io.EOF
	}
	prev := bytes.TrimRight(buf[:i], "\r\n")
	if j := bytes.LastIndexByte(prev, '\n'); j >= 0 {
		return prev[j+1:], nil
	}
	return prev, nil
}

// appendTurnLine appends ONE finished turn line + rewrites the meta tail
// (the turn commit path). Atomicity: turn append and meta rewrite happen
// in a single tmp+rename — readers never see a turn without its meta.
func (s *diskStore) appendTurnLine(id string, tl turnLine, meta metaLine) error {
	if !validSessionID(id) {
		return fmt.Errorf("invalid session id")
	}
	// Purge tombstone (audit bug 77): a late commit must not re-create a
	// deleted session's file.
	if sessionPurged(s.dataDir, id) {
		return errSessionPurged
	}
	path := s.sessionFile(id)
	// Fast path: plain append when the file ends with a valid meta line.
	// (Common case: exactly one writer — the owning turn finalizer.)
	if ok, tailSize := hasMetaTail(path); ok {
		// Rewrite: copy all but the meta tail, append turn + new meta.
		return s.rewriteTailAppend(path, tailSize, tl, meta)
	}
	// Slow path: full read + write (missing/corrupt tail — reconcile).
	lines, oldMeta, err := s.readSessionFile(id)
	if err != nil {
		// Fresh file (first turn): just write turn + meta.
		if os.IsNotExist(err) {
			tl.V, tl.Kind = storeVersion, "turn"
			return s.writeSessionFile(id, []turnLine{tl}, meta)
		}
		return err
	}
	_ = oldMeta
	cleanLines := make([]turnLine, 0, len(lines)+1)
	replaced := false
	for _, l := range lines {
		if l.Turn == tl.Turn && tl.Turn > 0 {
			cleanLines = append(cleanLines, tl)
			replaced = true
		} else {
			cleanLines = append(cleanLines, l)
		}
	}
	if !replaced {
		cleanLines = append(cleanLines, tl)
	}
	return s.writeSessionFile(id, cleanLines, meta)
}

// hasMetaTail checks the file ends with a valid meta line, returning its
// EXACT byte size (line + line terminator as on disk) for rewriteTailAppend.
// Never guesses +1: \r\n vs \n vs missing-newline all measure exactly.
func hasMetaTail(path string) (bool, int64) {
	f, err := os.Open(path)
	if err != nil {
		return false, 0
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.Size() == 0 {
		return false, 0
	}
	// Read the tail (meta lines are small; 64KB covers queue/todos/options
	// plus hundreds of attachments) and split off the last non-empty line
	// with its terminator.
	n := int64(64 * 1024)
	if st.Size() < n {
		n = st.Size()
	}
	buf := make([]byte, n)
	if _, err := f.ReadAt(buf, st.Size()-n); err != nil {
		return false, 0
	}
	trimmed := bytes.TrimRight(buf, "\r\n")
	if len(bytes.TrimSpace(trimmed)) == 0 {
		return false, 0
	}
	lastNL := bytes.LastIndexByte(trimmed, '\n')
	line := trimmed
	if lastNL >= 0 {
		line = trimmed[lastNL+1:]
	}
	var probe struct {
		Kind string `json:"kind"`
		ID   string `json:"id"`
	}
	if err := json.Unmarshal(line, &probe); err != nil || probe.Kind != "meta" || probe.ID == "" {
		return false, 0
	}
	// Tail size = file size - offset of this line's first byte.
	lineStartInBuf := len(trimmed) - len(line)
	tailSize := st.Size() - (st.Size() - n + int64(lineStartInBuf))
	return true, tailSize
}

// rewriteTailAppend replaces the meta tail with turn+meta in one
// tmp+rename: stream-copy everything before the tail, then append.
func (s *diskStore) rewriteTailAppend(path string, tailSize int64, tl turnLine, meta metaLine) error {
	src, err := os.Open(path)
	if err != nil {
		return err
	}
	st, err := src.Stat()
	if err != nil {
		src.Close()
		return err
	}
	keep := st.Size() - tailSize
	if keep < 0 {
		keep = 0
	}
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".session-*")
	if err != nil {
		src.Close()
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := io.CopyN(tmp, src, keep); err != nil {
		src.Close()
		tmp.Close()
		return err
	}
	src.Close() // Explicitly close src so Windows allows renaming over path
	tl.V, tl.Kind = storeVersion, "turn"
	meta.V, meta.Kind = storeVersion, "meta"
	for _, v := range []any{&tl, &meta} {
		data, err := json.Marshal(v)
		if err != nil {
			tmp.Close()
			return err
		}
		if _, err := tmp.Write(data); err != nil {
			tmp.Close()
			return err
		}
		if _, err := tmp.Write([]byte{10}); err != nil {
			tmp.Close()
			return err
		}
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := durable.Rename(tmpName, path); err != nil {
		return err
	}
	if df, err := os.Open(dir); err == nil {
		_ = df.Sync()
		df.Close()
	}
	return nil
}

// rewriteMetaOnly rewrites ONLY the meta tail (title/queue/options/pin/
// status flips): stream-copy + new meta, single tmp+rename.
func (s *diskStore) rewriteMetaOnly(id string, meta metaLine) error {
	if !validSessionID(id) {
		return fmt.Errorf("invalid session id")
	}
	path := s.sessionFile(id)
	ok, tailSize := hasMetaTail(path)
	if !ok {
		// No valid tail: full read + write (reconciles torn state).
		lines, _, err := s.readSessionFile(id)
		if err != nil {
			return err
		}
		return s.writeSessionFile(id, lines, meta)
	}
	src, err := os.Open(path)
	if err != nil {
		return err
	}
	st, err := src.Stat()
	if err != nil {
		src.Close()
		return err
	}
	keep := st.Size() - tailSize
	if keep < 0 {
		keep = 0
	}
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".session-*")
	if err != nil {
		src.Close()
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := io.CopyN(tmp, src, keep); err != nil {
		src.Close()
		tmp.Close()
		return err
	}
	src.Close() // Explicitly close src so Windows allows renaming over path
	meta.V, meta.Kind = storeVersion, "meta"
	data, err := json.Marshal(&meta)
	if err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write([]byte{10}); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := durable.Rename(tmpName, path); err != nil {
		return err
	}
	if df, err := os.Open(dir); err == nil {
		_ = df.Sync()
		df.Close()
	}
	return nil
}

// lineSpan is one file line's byte range + turn identity (probe only,
// no message parsing — cheap scan).
type lineSpan struct {
	turn       int
	start, end int64 // [start, end), end includes the newline
	isMeta     bool
}

// scanSpans records every line's span + turn in one sequential pass.
func scanSpans(f *os.File) ([]lineSpan, error) {
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	var spans []lineSpan
	r := bufio.NewReaderSize(f, 64*1024)
	var off int64
	for {
		line, err := r.ReadBytes('\n')
		n := int64(len(line))
		if n == 0 {
			if err != nil {
				break
			}
			continue
		}
		trimmed := bytes.TrimRight(line, "\r\n")
		if len(bytes.TrimSpace(trimmed)) > 0 {
			// `turn` is a NUMBER on turn lines but an OBJECT (TurnActivity)
			// on the meta line — probe it untyped and read the number only
			// when it IS one. (Typed `Turn int` used to fail the meta line,
			// making every persistEdited/truncateTail on a real session —
			// any session that ever ran a turn — fail with "corrupt line".)
			var probe struct {
				Kind string          `json:"kind"`
				Turn json.RawMessage `json:"turn"`
			}
			if jerr := json.Unmarshal(trimmed, &probe); jerr != nil {
				// Fail closed on corrupt middle lines (never silently
				// propagate garbage through truncate/persist). A torn
				// TAIL (crash mid-append) is the caller's case: it reads
				// the file end and tolerates exactly one partial line.
				return nil, fmt.Errorf("corrupt line at offset %d", off)
			}
			turn := 0
			_ = json.Unmarshal(probe.Turn, &turn) // object (meta) -> stays 0
			spans = append(spans, lineSpan{turn: turn, start: off, end: off + n, isMeta: probe.Kind == "meta"})
		}
		off += n
		if err != nil {
			break
		}
	}
	return spans, nil
}

// copyPrefixTo streams file bytes [0, endOff) into tmp.
func copyPrefixTo(src *os.File, tmp *os.File, endOff int64) error {
	if endOff <= 0 {
		return nil
	}
	if _, err := src.Seek(0, io.SeekStart); err != nil {
		return err
	}
	_, err := io.CopyN(tmp, src, endOff)
	return err
}

// appendJSONLLine marshals one value + newline into tmp.
func appendJSONLLine(tmp *os.File, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		return err
	}
	_, err = tmp.Write([]byte{10})
	return err
}

// commitTmpFile fsyncs + renames tmp over path + fsyncs the dir.
func commitTmpFile(tmp *os.File, tmpName, path string) error {
	defer os.Remove(tmpName)
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := durable.Rename(tmpName, path); err != nil {
		return err
	}
	if df, err := os.Open(filepath.Dir(path)); err == nil {
		_ = df.Sync()
		df.Close()
	}
	return nil
}

// truncateTail drops turns at/above keepTurn (pure tail cut, e.g.
// regenerate): clean prefix lines are byte-copied, never re-marshaled.
// Single tmp+rename.
func (s *diskStore) truncateTail(id string, keepTurn int, meta metaLine) error {
	if !validSessionID(id) {
		return fmt.Errorf("invalid session id")
	}
	path := s.sessionFile(id)
	src, err := os.Open(path)
	if err != nil {
		return err
	}
	spans, err := scanSpans(src)
	if err != nil {
		src.Close()
		return err
	}
	var keepEnd int64
	for _, s := range spans {
		if s.isMeta {
			continue
		}
		if s.turn < keepTurn {
			keepEnd = s.end
		}
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".session-*")
	if err != nil {
		src.Close()
		return err
	}
	tmpName := tmp.Name()
	if err := copyPrefixTo(src, tmp, keepEnd); err != nil {
		src.Close()
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	src.Close() // Explicitly close src so Windows allows renaming over path
	meta.V, meta.Kind = storeVersion, "meta"
	if err := appendJSONLLine(tmp, &meta); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	return commitTmpFile(tmp, tmpName, path)
}

// persistEdited persists an in-memory edit: clean prefix turns (<
// firstDirtyTurn) are byte-copied from disk; suffixMsgs (the dirty tail,
// already truncated to the kept prefix) are re-split + marshaled; then
// meta. Single tmp+rename. firstDirtyTurn<=1 forces full re-split.
func (s *diskStore) persistEdited(id string, firstDirtyTurn int, suffixMsgs []provider.Message, suffixBalloons []filetrack.TurnChanges, meta metaLine) error {
	if !validSessionID(id) {
		return fmt.Errorf("invalid session id")
	}
	path := s.sessionFile(id)
	src, err := os.Open(path)
	if err != nil {
		return err
	}
	spans, err := scanSpans(src)
	if err != nil {
		src.Close()
		return err
	}
	var keepEnd int64
	for _, s := range spans {
		if s.isMeta {
			continue
		}
		if s.turn < firstDirtyTurn {
			keepEnd = s.end
		}
	}
	// Re-split the dirty suffix with splitRecord semantics.
	suffixRec := &SessionRecord{Messages: suffixMsgs}
	suffixLines, _ := splitRecord(suffixRec)
	// Renumber: splitRecord numbers from its own grouping; shift so the
	// first suffix turn == firstDirtyTurn... only valid when the suffix
	// starts at a turn boundary. Callers guarantee: suffixMsgs begins at
	// the first message with TurnIndex >= firstDirtyTurn (plus attached
	// leading zeros), so the first group IS firstDirtyTurn — unless the
	// suffix is all zeros, in which case it forms turn 1 and
	// firstDirtyTurn must be 1 (callers: full rewrite, keepEnd=0).
	if firstDirtyTurn > 1 {
		for i := range suffixLines {
			suffixLines[i].Turn += firstDirtyTurn - suffixLines[0].Turn
		}
	}
	// Attach balloons by (renumbered) turn.
	balByTurn := map[int]*filetrack.TurnChanges{}
	for i := range suffixBalloons {
		b := suffixBalloons[i]
		cp := b
		balByTurn[b.TurnIndex] = &cp
	}
	for i := range suffixLines {
		if b, ok := balByTurn[suffixLines[i].Turn]; ok {
			suffixLines[i].Balloon = b
		}
		suffixLines[i].Usage = meta.Usage
		suffixLines[i].Context = meta.Context
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".session-*")
	if err != nil {
		src.Close()
		return err
	}
	tmpName := tmp.Name()
	if err := copyPrefixTo(src, tmp, keepEnd); err != nil {
		src.Close()
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	src.Close() // Explicitly close src so Windows allows renaming over path
	for i := range suffixLines {
		suffixLines[i].V, suffixLines[i].Kind = storeVersion, "turn"
		if err := appendJSONLLine(tmp, &suffixLines[i]); err != nil {
			tmp.Close()
			os.Remove(tmpName)
			return err
		}
	}
	meta.V, meta.Kind = storeVersion, "meta"
	if err := appendJSONLLine(tmp, &meta); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	return commitTmpFile(tmp, tmpName, path)
}

// sweepTmpLoop removes stale tmp orphans hourly (plus one immediate
// pass), across sessions/ and every slot's sessions+bin. Uses the shared
// sweepTmpOrphans helper (same prefixes + age rule as its unit test).

// sweepTmpDirs walks the slot's tmp-capable dirs (sessions + bin).

// resolvePath expands ~ prefixes. v1 resolved on load; v2 keeps raw values
// on disk and resolves at use sites instead (same visible behavior).
func resolvePath(p string) string {
	target := strings.TrimSpace(p)
	if target == "" || target == "~" {
		home, _ := os.UserHomeDir()
		return home
	}
	if strings.HasPrefix(target, "~/") || strings.HasPrefix(target, `~\`) {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, target[2:])
	}
	return target
}

// turnTokenCount counts one turn's messages with btdby4 (same ruler as
// estimateContext). Messages that serialize to nothing count 0.
func turnTokenCount(msgs []provider.Message) int {
	if len(msgs) == 0 {
		return 0
	}
	_, per := provider.ContextTokensByMessage("", nil, msgs)
	total := 0
	for _, n := range per {
		total += n
	}
	return total
}
