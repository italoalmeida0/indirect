package sessionstore

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"indirect/indirect-code-daemon/internal/durable"
	"indirect/indirect-code-daemon/packages/core"
	"indirect/indirect-code-daemon/packages/filetrack"
	"indirect/indirect-code-daemon/packages/linereader"
	"indirect/indirect-code-daemon/packages/provider"
)

// ErrCorruptLegacySession indicates a malformed or meta-less v1 .jsonl file.
var ErrCorruptLegacySession = errors.New("sessionstore: corrupt legacy jsonl session")

type legacyProbeLine struct {
	Kind string `json:"kind"`
	V    int    `json:"v"`
}

type legacyTurnLine struct {
	V        int                    `json:"v"`
	Kind     string                 `json:"kind"`
	Turn     int                    `json:"turn"`
	Messages []json.RawMessage      `json:"messages"`
	Balloon  *filetrack.TurnChanges `json:"balloon,omitempty"`
}

// MigrateLegacyFile streams a v1 <slot>/sessions/<id>.jsonl file line-by-line
// using packages/linereader, externalizes inline images to CAS, scrubs bloated
// Details, writes aged chunks directly as Cold 64 KiB seekable Zstd segments
// and recent turns as Warm segments, writes meta.json + manifest.json + turn.idx,
// fsyncs directories, and removes jsonlPath.
func MigrateLegacyFile(ctx context.Context, jsonlPath string, policy AgePolicy) error {
	cleanPath := filepath.Clean(jsonlPath)
	parent := filepath.Dir(cleanPath)
	slotDir := filepath.Dir(parent)
	if filepath.Base(parent) != "sessions" {
		// Fallback when a caller places .jsonl directly inside a flat test directory:
		// treat parent as sessionsDir's parent only if parent is named "sessions".
		slotDir = parent
	}
	store := New(slotDir)
	// If cleanPath was not directly under <slotDir>/sessions, align sessionsDir.
	if filepath.Dir(cleanPath) != store.sessionsDir {
		store.sessionsDir = filepath.Dir(cleanPath)
	}
	return store.MigrateLegacyFile(ctx, cleanPath, policy)
}

// MigrateLegacyFile streams jsonlPath into this Store's v2 segmented session format.
func (s *Store) MigrateLegacyFile(ctx context.Context, jsonlPath string, policy AgePolicy) error {
	cleanPath := filepath.Clean(jsonlPath)
	base := filepath.Base(cleanPath)
	if !strings.HasSuffix(base, ".jsonl") || strings.HasSuffix(base, ".wal.jsonl") {
		return fmt.Errorf("%w: invalid filename %q", ErrCorruptLegacySession, base)
	}
	id := strings.TrimSuffix(base, ".jsonl")
	if !ValidSessionID(id) {
		return ErrInvalidSessionID
	}
	if s.IsPurged(id) {
		return ErrSessionPurged
	}

	mu := s.sessionLock(id)
	mu.Lock()
	defer mu.Unlock()

	if s.IsPurged(id) {
		return ErrSessionPurged
	}
	return s.migrateLegacyLocked(ctx, id, cleanPath, policy)
}

func messageContentFingerprint(msg provider.Message) string {
	cp := msg
	cp.ID = ""
	data, err := json.Marshal(cp)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func messageEarliestUnix(msgs []provider.Message, fallback int64) int64 {
	for _, m := range msgs {
		if !m.Time.IsZero() && m.Time.Unix() > 0 {
			return m.Time.Unix()
		}
	}
	return fallback
}

func (s *Store) migrateLegacyLocked(ctx context.Context, id, jsonlPath string, policy AgePolicy) error {
	if s.IsPurged(id) {
		return ErrSessionPurged
	}
	defer s.invalidateSessionCache(id)
	policy = normalizeAgePolicy(policy)
	keepWarmTurns := policy.HotKeepTurns
	if keepWarmTurns < 0 {
		keepWarmTurns = 0
	}

	f, err := os.Open(jsonlPath)
	if err != nil {
		return err
	}
	closed := false
	closeInput := func() {
		if !closed {
			_ = f.Close()
			closed = true
		}
	}
	defer closeInput()

	sessDir := s.sessionDir(id)
	if err := os.MkdirAll(sessDir, 0o700); err != nil {
		return err
	}

	var createdSegIDs []uint32
	cleanupPartial := func() {
		for _, segID := range createdSegIDs {
			removeSegmentFiles(sessDir, segID)
		}
	}

	var nextSegID uint32 = 1
	var segments []SegmentMeta
	var allEntries []TurnEntry
	msgCursor := 0

	// Sliding window of buffered turns. Once buffered turns exceed
	// keepWarmTurns + chunkMaxTurns, the oldest chunk is flushed directly to
	// Cold seekable Zstd on disk so memory stays strictly O(keepWarmTurns + chunk).
	chunkMaxTurns := s.warmMaxTurns
	if chunkMaxTurns <= 0 {
		chunkMaxTurns = DefaultWarmSegmentMaxTurns
	}
	var window []TurnWrite
	turnPosInWindow := make(map[int]int) // TurnSeq -> index in window (for duplicate-turn merge)

	seenIDsFlushed := make(map[string]struct{})
	type msgLoc struct {
		winIdx int
		msgIdx int
	}
	idInWindow := make(map[string]msgLoc)
	seenBalloons := make(map[int]struct{})
	seenFingerprints := make(map[string]struct{})

	rebuildWindowIndex := func() {
		clear(turnPosInWindow)
		clear(idInWindow)
		for wi := range window {
			turnPosInWindow[window[wi].TurnSeq] = wi
			for mi, m := range window[wi].Messages {
				if m.ID != "" {
					idInWindow[m.ID] = msgLoc{winIdx: wi, msgIdx: mi}
				}
			}
		}
	}

	flushOldestColdChunk := func(count int) error {
		if count <= 0 {
			return nil
		}
		chunk := window[:count]
		for _, tw := range chunk {
			for _, m := range tw.Messages {
				if m.ID != "" {
					seenIDsFlushed[m.ID] = struct{}{}
				}
			}
		}
		segID := nextSegID
		nextSegID++
		createdSegIDs = append(createdSegIDs, segID)
		segMeta, segEntries, err := writeColdSegmentDirect(sessDir, segID, s.coldFrameBytes, chunk, msgCursor)
		if err != nil {
			return err
		}
		segments = append(segments, segMeta)
		allEntries = append(allEntries, segEntries...)
		if len(segEntries) > 0 {
			msgCursor = segEntries[len(segEntries)-1].LastMsgIdx + 1
		}
		// Shift sliding window in place.
		remaining := copy(window, window[count:])
		for k := remaining; k < len(window); k++ {
			window[k] = TurnWrite{}
		}
		window = window[:remaining]
		rebuildWindowIndex()
		return nil
	}

	lr := linereader.New(bufio.NewReaderSize(f, 64*1024))
	lineNum := 0
	var lastValidMeta []byte
	nowUnix := policy.Now.Unix()

	type pendingCorrupt struct {
		line int
		err  error
	}
	var lastErr *pendingCorrupt

	for lr.Scan() {
		if s.IsPurged(id) {
			cleanupPartial()
			_ = os.RemoveAll(sessDir)
			return ErrSessionPurged
		}
		if err := ctx.Err(); err != nil {
			cleanupPartial()
			return err
		}
		lineNum++
		// If a previous line failed JSON parsing, it was NOT the final torn line!
		if lastErr != nil {
			cleanupPartial()
			return fmt.Errorf("%w: line %d: %v", ErrCorruptLegacySession, lastErr.line, lastErr.err)
		}

		rawLine := strings.TrimSpace(lr.Text())
		if rawLine == "" {
			continue
		}
		endedNL := lr.EndedWithNewline()
		lineBytes := []byte(rawLine)

		var probe legacyProbeLine
		if err := json.Unmarshal(lineBytes, &probe); err != nil {
			if !endedNL {
				// Torn final line at EOF: record and tolerate if loop ends next.
				lastErr = &pendingCorrupt{line: lineNum, err: err}
				continue
			}
			cleanupPartial()
			return fmt.Errorf("%w: line %d: %v", ErrCorruptLegacySession, lineNum, err)
		}

		switch probe.Kind {
		case "meta":
			if !json.Valid(lineBytes) {
				if !endedNL {
					lastErr = &pendingCorrupt{line: lineNum, err: errors.New("invalid meta json")}
					continue
				}
				cleanupPartial()
				return fmt.Errorf("%w: line %d: invalid meta", ErrCorruptLegacySession, lineNum)
			}
			lastValidMeta = bytes.Clone(lineBytes)

		case "turn":
			var tl legacyTurnLine
			if err := json.Unmarshal(lineBytes, &tl); err != nil {
				if !endedNL {
					lastErr = &pendingCorrupt{line: lineNum, err: err}
					continue
				}
				cleanupPartial()
				return fmt.Errorf("%w: line %d: %v", ErrCorruptLegacySession, lineNum, err)
			}

			fpThisLine := make(map[string]struct{})
			var turnMsgs []provider.Message
			for _, rm := range tl.Messages {
				msg, herr := core.HydrateMessageObject(rm)
				if herr != nil {
					continue
				}
				extSlice, eerr := s.cas.ExternalizeMessageImages([]provider.Message{msg})
				if eerr != nil {
					cleanupPartial()
					return eerr
				}
				msg = ScrubMessageDetails(extSlice[0])

				if msg.ID != "" {
					if loc, ok := idInWindow[msg.ID]; ok {
						window[loc.winIdx].Messages[loc.msgIdx] = msg
						window[loc.winIdx].TokenEst = 0 // recompute on flush
						continue
					}
					if _, flushed := seenIDsFlushed[msg.ID]; flushed {
						continue
					}
					turnMsgs = append(turnMsgs, msg)
					continue
				}

				fp := messageContentFingerprint(msg)
				if fp != "" {
					if _, inLine := fpThisLine[fp]; !inLine {
						if _, prev := seenFingerprints[fp]; prev {
							continue
						}
						fpThisLine[fp] = struct{}{}
					}
				}
				turnMsgs = append(turnMsgs, msg)
			}
			for fp := range fpThisLine {
				seenFingerprints[fp] = struct{}{}
			}

			var bal *filetrack.TurnChanges
			if tl.Balloon != nil {
				bTurn := tl.Balloon.TurnIndex
				if bTurn <= 0 {
					bTurn = tl.Turn
				}
				if _, seen := seenBalloons[bTurn]; !seen {
					seenBalloons[bTurn] = struct{}{}
					cp := *tl.Balloon
					if cp.TurnIndex <= 0 {
						cp.TurnIndex = bTurn
					}
					bal = &cp
				}
			}

			turnSeq := tl.Turn
			if turnSeq <= 0 {
				if len(window) > 0 {
					turnSeq = window[len(window)-1].TurnSeq + 1
				} else if len(allEntries) > 0 {
					turnSeq = allEntries[len(allEntries)-1].TurnSeq + 1
				} else {
					turnSeq = 1
				}
			}

			if existingIdx, exists := turnPosInWindow[turnSeq]; exists {
				if len(turnMsgs) > 0 {
					baseLen := len(window[existingIdx].Messages)
					for k, m := range turnMsgs {
						if m.ID != "" {
							idInWindow[m.ID] = msgLoc{winIdx: existingIdx, msgIdx: baseLen + k}
						}
					}
					window[existingIdx].Messages = append(window[existingIdx].Messages, turnMsgs...)
					window[existingIdx].TokenEst = 0
				}
				if bal != nil && window[existingIdx].DiffBalloon == nil {
					window[existingIdx].DiffBalloon = bal
				}
			} else if len(turnMsgs) > 0 {
				winIdx := len(window)
				for k, m := range turnMsgs {
					if m.ID != "" {
						idInWindow[m.ID] = msgLoc{winIdx: winIdx, msgIdx: k}
					}
				}
				ts := messageEarliestUnix(turnMsgs, nowUnix)
				window = append(window, TurnWrite{
					TurnSeq:       turnSeq,
					Messages:      turnMsgs,
					DiffBalloon:   bal,
					CreatedAtUnix: ts,
				})
				turnPosInWindow[turnSeq] = winIdx
			}

			// Stream-flush completed older chunks directly to Cold .zst segments!
			for len(window) >= keepWarmTurns+chunkMaxTurns {
				if err := flushOldestColdChunk(chunkMaxTurns); err != nil {
					cleanupPartial()
					return err
				}
			}

		default:
			cleanupPartial()
			return fmt.Errorf("%w: line %d: unknown kind %q", ErrCorruptLegacySession, lineNum, probe.Kind)
		}
	}

	if err := lr.Err(); err != nil {
		cleanupPartial()
		return err
	}
	if len(lastValidMeta) == 0 {
		cleanupPartial()
		return fmt.Errorf("%w: missing meta line in %s", ErrCorruptLegacySession, filepath.Base(jsonlPath))
	}

	// Ensure monotonic TurnSeq across remaining window entries.
	prevTurnSeq := 0
	if len(allEntries) > 0 {
		prevTurnSeq = allEntries[len(allEntries)-1].TurnSeq
	}
	for i := range window {
		if window[i].TurnSeq <= prevTurnSeq {
			window[i].TurnSeq = prevTurnSeq + 1
		}
		prevTurnSeq = window[i].TurnSeq
	}

	// Flush any remaining turns older than keepWarmTurns directly as Cold .zst segment(s).
	if len(window) > keepWarmTurns {
		coldCount := len(window) - keepWarmTurns
		for coldCount > 0 {
			n := min(coldCount, chunkMaxTurns)
			if err := flushOldestColdChunk(n); err != nil {
				cleanupPartial()
				return err
			}
			coldCount -= n
		}
	}

	// Check if the session itself is already older than policy.WarmMaxAge (from meta updatedAt);
	// if not, write remaining <= keepWarmTurns turns as Warm segment(s).
	metaOld := false
	if policy.WarmMaxAge > 0 {
		var metaProbe struct {
			UpdatedAt int64 `json:"updatedAt"`
		}
		if json.Unmarshal(lastValidMeta, &metaProbe) == nil && metaProbe.UpdatedAt > 0 {
			// UpdatedAt in daemon metaLine may be unix ms or unix seconds; normalize!
			uSec := metaProbe.UpdatedAt
			if uSec > 1e12 {
				uSec /= 1000
			}
			if policy.Now.Sub(time.Unix(uSec, 0)) > policy.WarmMaxAge && keepWarmTurns == 0 {
				metaOld = true
			}
		}
	}

	for len(window) > 0 {
		n := min(len(window), chunkMaxTurns)
		chunk := window[:n]
		isLastChunk := n == len(window)
		segID := nextSegID
		nextSegID++
		createdSegIDs = append(createdSegIDs, segID)

		var segMeta SegmentMeta
		var segEntries []TurnEntry
		var werr error
		if metaOld {
			segMeta, segEntries, werr = writeColdSegmentDirect(sessDir, segID, s.coldFrameBytes, chunk, msgCursor)
		} else {
			segMeta, segEntries, werr = writeWarmSegmentFromTurns(sessDir, segID, !isLastChunk, chunk, msgCursor)
		}
		if werr != nil {
			cleanupPartial()
			return werr
		}
		segments = append(segments, segMeta)
		allEntries = append(allEntries, segEntries...)
		if len(segEntries) > 0 {
			msgCursor = segEntries[len(segEntries)-1].LastMsgIdx + 1
		}
		window = window[n:]
	}

	if s.IsPurged(id) {
		cleanupPartial()
		_ = os.RemoveAll(sessDir)
		return ErrSessionPurged
	}
	// Write meta.json, turn.idx, and manifest.json atomically.
	if err := durable.Write(s.metaPath(id), lastValidMeta); err != nil {
		cleanupPartial()
		return err
	}
	if err := writeTurnIndexFile(s.turnIndexPath(id), allEntries); err != nil {
		cleanupPartial()
		return err
	}
	manifest := Manifest{
		Version:       manifestFormatVersion,
		SessionID:     id,
		NextSegmentID: nextSegID,
		Segments:      segments,
		UpdatedAtUnix: nowUnix,
	}
	if err := writeManifestFile(s.manifestPath(id), manifest); err != nil {
		cleanupPartial()
		return err
	}
	syncDirBestEffort(sessDir)

	// Close the legacy file handle before removing (mandatory on Windows NTFS).
	closeInput()
	if err := os.Remove(jsonlPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	syncDirBestEffort(filepath.Dir(jsonlPath))
	return nil
}

// readLegacyMetaTail reads ONLY the trailing meta line of a v1 <id>.jsonl file
// using tail ReadAt seeks (tolerating a single torn tail line), avoiding a full scan.
func readLegacyMetaTail(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	size := st.Size()
	if size == 0 {
		return nil, io.EOF
	}
	chunk := int64(64 * 1024)
	if size < chunk {
		chunk = size
	}
	buf := make([]byte, chunk)
	if _, err := f.ReadAt(buf, size-chunk); err != nil {
		return nil, err
	}
	trimmed := bytes.TrimRight(buf, "\r\n")
	if len(bytes.TrimSpace(trimmed)) == 0 {
		return nil, io.EOF
	}

	checkMeta := func(line []byte) ([]byte, bool) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			return nil, false
		}
		var p legacyProbeLine
		if json.Unmarshal(line, &p) == nil && p.Kind == "meta" {
			return bytes.Clone(line), true
		}
		return nil, false
	}

	lastNL := bytes.LastIndexByte(trimmed, '\n')
	if lastNL < 0 {
		if m, ok := checkMeta(trimmed); ok {
			return m, nil
		}
	} else {
		if m, ok := checkMeta(trimmed[lastNL+1:]); ok {
			return m, nil
		}
		// Step back one line to tolerate a torn append tail.
		prev := bytes.TrimRight(trimmed[:lastNL], "\r\n")
		prevNL := bytes.LastIndexByte(prev, '\n')
		cand := prev
		if prevNL >= 0 {
			cand = prev[prevNL+1:]
		}
		if m, ok := checkMeta(cand); ok {
			return m, nil
		}
	}

	// Fallback for oversized (>64 KiB) meta lines: stream with linereader.
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	lr := linereader.New(f)
	var found []byte
	for lr.Scan() {
		if m, ok := checkMeta([]byte(lr.Text())); ok {
			found = m
		}
	}
	if len(found) == 0 {
		return nil, ErrCorruptLegacySession
	}
	return found, nil
}
