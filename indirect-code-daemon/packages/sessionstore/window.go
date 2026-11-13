package sessionstore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"time"

	"indirect/indirect-code-daemon/internal/durable"
	"indirect/indirect-code-daemon/packages/filetrack"
	"indirect/indirect-code-daemon/packages/provider"
)

const (
	// DefaultWindowTokenBudget is the default whole-turn page token target (128 KiB tokens).
	DefaultWindowTokenBudget = 128 * 1024

	// DefaultWindowMaxMessages caps messages per window slice so a dense turn page stays bounded.
	DefaultWindowMaxMessages = 200
)

// HistoryCursor describes the position of a WindowSlice within the full session
// transcript for bidirectional pagination and jump-to-message navigation.
type HistoryCursor struct {
	OldestTurn   int  `json:"oldestTurn"`
	NewestTurn   int  `json:"newestTurn"`
	HasOlder     bool `json:"hasOlder"`
	HasNewer     bool `json:"hasNewer,omitempty"`
	TotalTurns   int  `json:"totalTurns"`
	FirstIndex   int  `json:"firstIndex"`
	TargetMsgIdx *int `json:"targetMsgIdx,omitempty"`
}

// WindowSlice holds a contiguous slice of whole turns, their file-change
// balloons, and the bidirectional pagination cursor.
type WindowSlice struct {
	Messages     []provider.Message      `json:"messages"`
	FileBalloons []filetrack.TurnChanges `json:"fileBalloons,omitempty"`
	History      HistoryCursor           `json:"history"`
}

func normalizeWindowLimits(tokenBudget, maxMsgs int) (int, int) {
	if tokenBudget <= 0 {
		tokenBudget = DefaultWindowTokenBudget
	}
	if maxMsgs <= 0 {
		maxMsgs = DefaultWindowMaxMessages
	}
	return tokenBudget, maxMsgs
}

func (s *Store) materializeSliceLocked(id string, entries []TurnEntry, lo, hi int, targetMsgIdx *int) (WindowSlice, error) {
	totalTurns := len(entries)
	if totalTurns == 0 || lo >= hi || lo < 0 || hi > totalTurns {
		return WindowSlice{
			History: HistoryCursor{
				TotalTurns:   totalTurns,
				TargetMsgIdx: targetMsgIdx,
			},
		}, nil
	}

	expectedMsgs := 0
	for i := lo; i < hi; i++ {
		expectedMsgs += entries[i].MsgCount()
	}

	reader := newSegmentReader(s, id, s.sessionDir(id))
	defer reader.Close()

	msgs := make([]provider.Message, 0, expectedMsgs)
	var balloons []filetrack.TurnChanges
	for i := lo; i < hi; i++ {
		tMsgs, bal, err := reader.readTurn(entries[i])
		if err != nil {
			return WindowSlice{}, err
		}
		msgs = append(msgs, tMsgs...)
		if bal != nil {
			balloons = append(balloons, *bal)
		}
	}

	return WindowSlice{
		Messages:     msgs,
		FileBalloons: balloons,
		History: HistoryCursor{
			OldestTurn:   entries[lo].TurnSeq,
			NewestTurn:   entries[hi-1].TurnSeq,
			HasOlder:     lo > 0,
			HasNewer:     hi < totalTurns,
			TotalTurns:   totalTurns,
			FirstIndex:   entries[lo].FirstMsgIdx,
			TargetMsgIdx: targetMsgIdx,
		},
	}, nil
}

// ReadTailWindow returns the newest whole turns up to tokenBudget / maxMsgs
// (minimum one whole turn), along with matching FileBalloons and HistoryCursor.
func (s *Store) ReadTailWindow(id string, tokenBudget, maxMsgs int) (WindowSlice, error) {
	if !ValidSessionID(id) {
		return WindowSlice{}, ErrInvalidSessionID
	}
	if err := s.ensureV2ForRead(context.Background(), id); err != nil {
		return WindowSlice{}, err
	}
	tokenBudget, maxMsgs = normalizeWindowLimits(tokenBudget, maxMsgs)

	mu := s.sessionLock(id)
	mu.RLock()
	defer mu.RUnlock()

	_, entries, _, err := s.loadStateReadOnlyLocked(id)
	if err != nil {
		return WindowSlice{}, err
	}
	n := len(entries)
	if n == 0 {
		return WindowSlice{}, nil
	}

	lo := backwardTurnWindow(entries, n, tokenBudget, maxMsgs)
	return s.materializeSliceLocked(id, entries, lo, n, nil)
}

// backwardTurnWindow walks backwards from hi-1 down to 0 accumulating whole
// turns up to tokenBudget and maxMsgs (always keeping at least hi-1).
func backwardTurnWindow(entries []TurnEntry, hi, tokenBudget, maxMsgs int) int {
	if hi <= 0 {
		return 0
	}
	budget := 0
	held := 0
	lo := hi - 1
	for i := hi - 1; i >= 0; i-- {
		if i < hi-1 && held >= maxMsgs {
			break
		}
		budget += max(1, entries[i].TokenEst)
		held += entries[i].MsgCount()
		lo = i
		if budget >= tokenBudget {
			break
		}
	}
	return lo
}

// ReadBeforeTurn returns a window of whole turns strictly older than beforeTurn.
// When beforeTurn <= 0, it behaves identically to ReadTailWindow.
func (s *Store) ReadBeforeTurn(id string, beforeTurn, tokenBudget, maxMsgs int) (WindowSlice, error) {
	if beforeTurn <= 0 {
		return s.ReadTailWindow(id, tokenBudget, maxMsgs)
	}
	if !ValidSessionID(id) {
		return WindowSlice{}, ErrInvalidSessionID
	}
	if err := s.ensureV2ForRead(context.Background(), id); err != nil {
		return WindowSlice{}, err
	}
	tokenBudget, maxMsgs = normalizeWindowLimits(tokenBudget, maxMsgs)

	mu := s.sessionLock(id)
	mu.RLock()
	defer mu.RUnlock()

	_, entries, _, err := s.loadStateReadOnlyLocked(id)
	if err != nil {
		return WindowSlice{}, err
	}
	n := len(entries)
	if n == 0 {
		return WindowSlice{}, nil
	}

	// First index i where entries[i].TurnSeq >= beforeTurn.
	hi := sort.Search(n, func(i int) bool {
		return entries[i].TurnSeq >= beforeTurn
	})
	if hi == 0 {
		return WindowSlice{
			History: HistoryCursor{
				HasNewer:   true,
				TotalTurns: n,
			},
		}, nil
	}
	lo := backwardTurnWindow(entries, hi, tokenBudget, maxMsgs)
	return s.materializeSliceLocked(id, entries, lo, hi, nil)
}

// ReadAfterTurn returns a window of whole turns strictly newer than afterTurn,
// setting HasNewer = newestReturned < TotalTurns.
func (s *Store) ReadAfterTurn(id string, afterTurn, tokenBudget, maxMsgs int) (WindowSlice, error) {
	if !ValidSessionID(id) {
		return WindowSlice{}, ErrInvalidSessionID
	}
	if err := s.ensureV2ForRead(context.Background(), id); err != nil {
		return WindowSlice{}, err
	}
	tokenBudget, maxMsgs = normalizeWindowLimits(tokenBudget, maxMsgs)

	mu := s.sessionLock(id)
	mu.RLock()
	defer mu.RUnlock()

	_, entries, _, err := s.loadStateReadOnlyLocked(id)
	if err != nil {
		return WindowSlice{}, err
	}
	n := len(entries)
	if n == 0 {
		return WindowSlice{}, nil
	}

	// First index i where entries[i].TurnSeq > afterTurn.
	lo := sort.Search(n, func(i int) bool {
		return entries[i].TurnSeq > afterTurn
	})
	if lo >= n {
		return WindowSlice{
			History: HistoryCursor{
				HasOlder:   true,
				HasNewer:   false,
				TotalTurns: n,
				FirstIndex: entries[n-1].LastMsgIdx + 1,
			},
		}, nil
	}

	budget := 0
	held := 0
	hi := lo
	for i := lo; i < n; i++ {
		if i > lo && held >= maxMsgs {
			break
		}
		budget += max(1, entries[i].TokenEst)
		held += entries[i].MsgCount()
		hi = i + 1
		if budget >= tokenBudget {
			break
		}
	}
	return s.materializeSliceLocked(id, entries, lo, hi, nil)
}

// ReadAroundMsg binary-searches turn.idx by [FirstMsgIdx..LastMsgIdx] in O(log T)
// and returns a centered whole-turn window around targetMsgIdx with accurate
// HasOlder and HasNewer flags.
func (s *Store) ReadAroundMsg(id string, targetMsgIdx, tokenBudget, maxMsgs int) (WindowSlice, error) {
	if !ValidSessionID(id) {
		return WindowSlice{}, ErrInvalidSessionID
	}
	if err := s.ensureV2ForRead(context.Background(), id); err != nil {
		return WindowSlice{}, err
	}
	tokenBudget, maxMsgs = normalizeWindowLimits(tokenBudget, maxMsgs)

	mu := s.sessionLock(id)
	mu.RLock()
	defer mu.RUnlock()

	_, entries, _, err := s.loadStateReadOnlyLocked(id)
	if err != nil {
		return WindowSlice{}, err
	}
	n := len(entries)
	if n == 0 {
		return WindowSlice{}, nil
	}

	clampedTarget := targetMsgIdx
	if clampedTarget < 0 {
		clampedTarget = 0
	} else if maxMsg := entries[n-1].LastMsgIdx; clampedTarget > maxMsg {
		clampedTarget = maxMsg
	}

	center := findTurnIdxByMsg(entries, clampedTarget)
	lo, hi := expandCenteredWindow(entries, center, tokenBudget, maxMsgs)
	return s.materializeSliceLocked(id, entries, lo, hi, &clampedTarget)
}

// ReadAroundTurn returns a centered whole-turn window around targetTurn.
func (s *Store) ReadAroundTurn(id string, targetTurn, tokenBudget, maxMsgs int) (WindowSlice, error) {
	if !ValidSessionID(id) {
		return WindowSlice{}, ErrInvalidSessionID
	}
	if err := s.ensureV2ForRead(context.Background(), id); err != nil {
		return WindowSlice{}, err
	}
	tokenBudget, maxMsgs = normalizeWindowLimits(tokenBudget, maxMsgs)

	mu := s.sessionLock(id)
	mu.RLock()
	defer mu.RUnlock()

	_, entries, _, err := s.loadStateReadOnlyLocked(id)
	if err != nil {
		return WindowSlice{}, err
	}
	n := len(entries)
	if n == 0 {
		return WindowSlice{}, nil
	}
	center := sort.Search(n, func(i int) bool {
		return entries[i].TurnSeq >= targetTurn
	})
	if center >= n {
		center = n - 1
	}
	lo, hi := expandCenteredWindow(entries, center, tokenBudget, maxMsgs)
	targetMsg := entries[center].FirstMsgIdx
	return s.materializeSliceLocked(id, entries, lo, hi, &targetMsg)
}

func expandCenteredWindow(entries []TurnEntry, center, tokenBudget, maxMsgs int) (int, int) {
	n := len(entries)
	lo := center
	hi := center + 1
	budget := max(1, entries[center].TokenEst)
	held := entries[center].MsgCount()

	for budget < tokenBudget && held < maxMsgs && (lo > 0 || hi < n) {
		progressed := false
		if lo > 0 && budget < tokenBudget && held < maxMsgs {
			lo--
			budget += max(1, entries[lo].TokenEst)
			held += entries[lo].MsgCount()
			progressed = true
		}
		if hi < n && budget < tokenBudget && held < maxMsgs {
			budget += max(1, entries[hi].TokenEst)
			held += entries[hi].MsgCount()
			hi++
			progressed = true
		}
		if !progressed {
			break
		}
	}
	return lo, hi
}

// ReadLastNTurns returns the final n whole turns of session id without touching
// earlier segments.
func (s *Store) ReadLastNTurns(id string, count int) (WindowSlice, error) {
	if !ValidSessionID(id) {
		return WindowSlice{}, ErrInvalidSessionID
	}
	if count <= 0 {
		count = 1
	}
	if err := s.ensureV2ForRead(context.Background(), id); err != nil {
		return WindowSlice{}, err
	}
	mu := s.sessionLock(id)
	mu.RLock()
	defer mu.RUnlock()

	_, entries, _, err := s.loadStateReadOnlyLocked(id)
	if err != nil {
		return WindowSlice{}, err
	}
	n := len(entries)
	if n == 0 {
		return WindowSlice{}, nil
	}
	lo := n - count
	if lo < 0 {
		lo = 0
	}
	return s.materializeSliceLocked(id, entries, lo, n, nil)
}

// ReadTurnRange reads turns in the inclusive [startTurn, endTurn] range (startTurn <= 0
// starts at the first turn; endTurn <= 0 reads through the final turn).
func (s *Store) ReadTurnRange(id string, startTurn, endTurn int) ([]provider.Message, []filetrack.TurnChanges, error) {
	if !ValidSessionID(id) {
		return nil, nil, ErrInvalidSessionID
	}
	if err := s.ensureV2ForRead(context.Background(), id); err != nil {
		return nil, nil, err
	}
	mu := s.sessionLock(id)
	mu.RLock()
	defer mu.RUnlock()

	_, entries, _, err := s.loadStateReadOnlyLocked(id)
	if err != nil {
		return nil, nil, err
	}
	n := len(entries)
	if n == 0 {
		return nil, nil, nil
	}
	lo := 0
	if startTurn > 0 {
		lo = sort.Search(n, func(i int) bool {
			return entries[i].TurnSeq >= startTurn
		})
	}
	hi := n
	if endTurn > 0 {
		hi = sort.Search(n, func(i int) bool {
			return entries[i].TurnSeq > endTurn
		})
	}
	if lo >= hi || lo >= n {
		return nil, nil, nil
	}
	ws, err := s.materializeSliceLocked(id, entries, lo, hi, nil)
	if err != nil {
		return nil, nil, err
	}
	return ws.Messages, ws.FileBalloons, nil
}

// ReadFromMsgIdx reads all messages starting at raw message index startMsgIdx
// through the end of the session (used to hydrate the Hot Active Era >= Compaction.CoverageEnd()).
func (s *Store) ReadFromMsgIdx(id string, startMsgIdx int) ([]provider.Message, []filetrack.TurnChanges, error) {
	if !ValidSessionID(id) {
		return nil, nil, ErrInvalidSessionID
	}
	if err := s.ensureV2ForRead(context.Background(), id); err != nil {
		return nil, nil, err
	}
	mu := s.sessionLock(id)
	mu.RLock()
	defer mu.RUnlock()

	_, entries, _, err := s.loadStateReadOnlyLocked(id)
	if err != nil {
		return nil, nil, err
	}
	n := len(entries)
	if n == 0 {
		return nil, nil, nil
	}
	if startMsgIdx <= 0 {
		ws, err := s.materializeSliceLocked(id, entries, 0, n, nil)
		if err != nil {
			return nil, nil, err
		}
		return ws.Messages, ws.FileBalloons, nil
	}
	if startMsgIdx > entries[n-1].LastMsgIdx {
		return nil, nil, nil
	}
	lo := findTurnIdxByMsg(entries, startMsgIdx)
	ws, err := s.materializeSliceLocked(id, entries, lo, n, nil)
	if err != nil {
		return nil, nil, err
	}
	trimFront := startMsgIdx - entries[lo].FirstMsgIdx
	if trimFront > 0 && trimFront <= len(ws.Messages) {
		ws.Messages = ws.Messages[trimFront:]
	}
	return ws.Messages, ws.FileBalloons, nil
}

func removeSegmentFiles(sessDir string, segID uint32) {
	_ = os.Remove(filepath.Join(sessDir, warmTurnsFilename(segID)))
	_ = os.Remove(filepath.Join(sessDir, warmDiffsFilename(segID)))
	_ = os.Remove(filepath.Join(sessDir, coldTurnsFilename(segID)))
	_ = os.Remove(filepath.Join(sessDir, coldDiffsFilename(segID)))
	_ = os.Remove(filepath.Join(sessDir, coldFrameIndexFilename(segID)))
}

// writeWarmSegmentFromTurns writes a batch of hydrated turns as a new Warm segment
// under newSegID and returns its SegmentMeta and TurnEntry slice.
func writeWarmSegmentFromTurns(sessDir string, newSegID uint32, sealed bool, turns []TurnWrite, startMsgIdx int) (SegmentMeta, []TurnEntry, error) {
	var turnsBuf []byte
	var diffsBuf []byte
	entries := make([]TurnEntry, 0, len(turns))
	var blobRefs []string
	var minTurn, maxTurn int
	var minTS, maxTS int64

	msgCursor := startMsgIdx
	for i, tw := range turns {
		ts := tw.CreatedAtUnix
		if ts <= 0 {
			ts = time.Now().Unix()
		}
		if i == 0 || tw.TurnSeq < minTurn {
			minTurn = tw.TurnSeq
		}
		if i == 0 || tw.TurnSeq > maxTurn {
			maxTurn = tw.TurnSeq
		}
		if i == 0 || ts < minTS {
			minTS = ts
		}
		if i == 0 || ts > maxTS {
			maxTS = ts
		}

		tJSON, err := marshalTurnPayload(tw.TurnSeq, ts, tw.Messages)
		if err != nil {
			return SegmentMeta{}, nil, err
		}
		tBytes := append(tJSON, '\n')
		tOff := uint64(len(turnsBuf))
		turnsBuf = append(turnsBuf, tBytes...)

		var dOff uint64
		var dLen uint32
		if tw.DiffBalloon != nil && (len(tw.DiffBalloon.Files) > 0 || tw.DiffBalloon.TurnIndex > 0) {
			bal := *tw.DiffBalloon
			if bal.TurnIndex <= 0 {
				bal.TurnIndex = tw.TurnSeq
			}
			dJSON, err := json.Marshal(bal)
			if err != nil {
				return SegmentMeta{}, nil, err
			}
			dBytes := append(dJSON, '\n')
			dOff = uint64(len(diffsBuf))
			dLen = uint32(len(dBytes))
			diffsBuf = append(diffsBuf, dBytes...)
		}

		tokEst := tw.TokenEst
		if tokEst <= 0 {
			tokEst = EstimateTurnTokens(tw.Messages)
		}
		firstIdx := msgCursor
		lastIdx := firstIdx + len(tw.Messages) - 1
		msgCursor = lastIdx + 1

		refs := CollectMessageBlobRefs(tw.Messages)
		blobRefs, _ = mergeUniqueStrings(blobRefs, refs)

		entries = append(entries, TurnEntry{
			TurnSeq:       tw.TurnSeq,
			SegmentID:     newSegID,
			Tier:          TierWarm,
			Offset:        tOff,
			Length:        uint32(len(tBytes)),
			DiffOffset:    dOff,
			DiffLength:    dLen,
			FirstMsgIdx:   firstIdx,
			LastMsgIdx:    lastIdx,
			TokenEst:      tokEst,
			CreatedAtUnix: ts,
		})
	}

	if err := durable.Write(filepath.Join(sessDir, warmTurnsFilename(newSegID)), turnsBuf); err != nil {
		return SegmentMeta{}, nil, err
	}
	if len(diffsBuf) > 0 {
		if err := durable.Write(filepath.Join(sessDir, warmDiffsFilename(newSegID)), diffsBuf); err != nil {
			_ = os.Remove(filepath.Join(sessDir, warmTurnsFilename(newSegID)))
			return SegmentMeta{}, nil, err
		}
	}

	segMeta := SegmentMeta{
		ID:            newSegID,
		Tier:          TierWarm,
		Sealed:        sealed,
		FirstTurn:     minTurn,
		LastTurn:      maxTurn,
		TurnCount:     len(turns),
		TurnsBytes:    uint64(len(turnsBuf)),
		DiffsBytes:    uint64(len(diffsBuf)),
		UncompBytes:   uint64(len(turnsBuf) + len(diffsBuf)),
		CreatedAtUnix: minTS,
		UpdatedAtUnix: maxTS,
		HasBlobIndex:  true,
		BlobRefs:      blobRefs,
	}
	return segMeta, entries, nil
}

// TruncateAfterMsg truncates session id so only the first keepMsgCount raw
// messages [0, keepMsgCount) remain, cutting cleanly inside either Warm or Cold
// Zstd segments while leaving untouched prefix segments intact.
func (s *Store) TruncateAfterMsg(id string, keepMsgCount int) error {
	if !ValidSessionID(id) {
		return ErrInvalidSessionID
	}
	mu := s.sessionLock(id)
	mu.Lock()
	defer mu.Unlock()
	defer s.invalidateSessionCache(id)

	if err := s.ensureV2Locked(context.Background(), id); err != nil {
		return err
	}
	sessDir := s.sessionDir(id)
	m, entries, _, err := s.loadStateLocked(id)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	n := len(entries)
	if n == 0 {
		return nil
	}
	totalMsgs := entries[n-1].LastMsgIdx + 1
	if keepMsgCount >= totalMsgs {
		return nil
	}

	nowUnix := time.Now().Unix()

	// Dropping all turns: write empty index + empty manifest, then unlink segments.
	if keepMsgCount <= 0 {
		oldSegs := append([]SegmentMeta(nil), m.Segments...)
		m.Segments = nil
		m.UpdatedAtUnix = nowUnix
		if err := writeTurnIndexFile(s.turnIndexPath(id), nil); err != nil {
			return err
		}
		if err := writeManifestFile(s.manifestPath(id), m); err != nil {
			return err
		}
		for _, seg := range oldSegs {
			removeSegmentFiles(sessDir, seg.ID)
		}
		return nil
	}

	// Locate the last turn that still contributes at least 1 message:
	// keepMsgCount - 1 is the final retained message index.
	cutTurnIdx := findTurnIdxByMsg(entries, keepMsgCount-1)
	cutEntry := entries[cutTurnIdx]
	cutSegID := cutEntry.SegmentID

	// Check if cutEntry ends at the exact end of its segment AND exact end of turn!
	isExactTurnEnd := (keepMsgCount - 1) == cutEntry.LastMsgIdx
	isLastTurnOfSeg := cutTurnIdx == n-1 || entries[cutTurnIdx+1].SegmentID != cutSegID

	if isExactTurnEnd && isLastTurnOfSeg {
		// Fast O(1) segment-boundary cut: no segment file rewrite needed at all!
		keptEntries := entries[:cutTurnIdx+1]
		var keptSegs []SegmentMeta
		var dropSegs []uint32
		for _, seg := range m.Segments {
			if seg.ID == cutSegID || (len(keptSegs) < len(m.Segments) && seg.LastTurn <= cutEntry.TurnSeq) {
				keptSegs = append(keptSegs, seg)
			} else {
				dropSegs = append(dropSegs, seg.ID)
			}
		}
		m.Segments = keptSegs
		m.UpdatedAtUnix = nowUnix
		if err := writeTurnIndexFile(s.turnIndexPath(id), keptEntries); err != nil {
			return err
		}
		if err := writeManifestFile(s.manifestPath(id), m); err != nil {
			return err
		}
		for _, segID := range dropSegs {
			removeSegmentFiles(sessDir, segID)
		}
		return nil
	}

	// Find all turns in cutSegID up to cutTurnIdx, read them (Warm or Cold),
	// slice the final turn if mid-turn, and emit a clean replacement Warm segment
	// under a fresh SegmentID before atomically flipping turn.idx + manifest.json.
	segFirstIdx := cutTurnIdx
	for segFirstIdx > 0 && entries[segFirstIdx-1].SegmentID == cutSegID {
		segFirstIdx--
	}

	reader := newSegmentReader(s, id, sessDir)
	rewrittenTurns := make([]TurnWrite, 0, cutTurnIdx-segFirstIdx+1)
	for i := segFirstIdx; i <= cutTurnIdx; i++ {
		e := entries[i]
		tMsgs, bal, err := reader.readTurn(e)
		if err != nil {
			reader.Close()
			return err
		}
		tokEst := e.TokenEst
		if i == cutTurnIdx && !isExactTurnEnd {
			keepInTurn := keepMsgCount - e.FirstMsgIdx
			tMsgs = tMsgs[:keepInTurn]
			tokEst = EstimateTurnTokens(tMsgs)
			// Drop diff balloon if mid-turn cut removed assistant/tool turns? Keep if TurnIndex matches,
			// or drop when cutting down to just the initial user message (len == 1 and RoleUser).
			if len(tMsgs) == 1 && tMsgs[0].Role == provider.RoleUser {
				bal = nil
			}
		}
		rewrittenTurns = append(rewrittenTurns, TurnWrite{
			TurnSeq:       e.TurnSeq,
			Messages:      tMsgs,
			DiffBalloon:   bal,
			TokenEst:      tokEst,
			CreatedAtUnix: e.CreatedAtUnix,
		})
	}
	reader.Close()

	if m.NextSegmentID == 0 {
		m.NextSegmentID = 1
	}
	newSegID := m.NextSegmentID
	m.NextSegmentID++

	newSegMeta, newSegEntries, err := writeWarmSegmentFromTurns(
		sessDir,
		newSegID,
		false, // unsealed Warm tail ready for subsequent AppendTurn
		rewrittenTurns,
		entries[segFirstIdx].FirstMsgIdx,
	)
	if err != nil {
		return err
	}

	newEntries := make([]TurnEntry, 0, segFirstIdx+len(newSegEntries))
	newEntries = append(newEntries, entries[:segFirstIdx]...)
	newEntries = append(newEntries, newSegEntries...)

	var newSegments []SegmentMeta
	var dropSegs []uint32
	for _, seg := range m.Segments {
		if seg.LastTurn < entries[segFirstIdx].TurnSeq && seg.ID != cutSegID {
			newSegments = append(newSegments, seg)
		} else {
			dropSegs = append(dropSegs, seg.ID)
		}
	}
	newSegments = append(newSegments, newSegMeta)
	m.Segments = newSegments
	m.UpdatedAtUnix = nowUnix

	// Write manifest (containing newSegID) then turn.idx, then remove old segments.
	if err := writeManifestFile(s.manifestPath(id), m); err != nil {
		removeSegmentFiles(sessDir, newSegID)
		return err
	}
	if err := writeTurnIndexFile(s.turnIndexPath(id), newEntries); err != nil {
		return err
	}
	for _, oldID := range dropSegs {
		if oldID != newSegID {
			removeSegmentFiles(sessDir, oldID)
		}
	}
	return nil
}

func copyFileDurable(srcPath, dstPath string) error {
	in, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer in.Close()

	if err := os.MkdirAll(filepath.Dir(dstPath), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(dstPath), ".publish-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpName)
		}
	}()
	if _, err := io.Copy(tmp, in); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := durable.Rename(tmpName, dstPath); err != nil {
		return err
	}
	cleanup = false
	return nil
}

func copySegmentFiles(srcSessDir, dstSessDir string, seg SegmentMeta) error {
	if seg.Tier == TierCold {
		if err := copyFileDurable(
			filepath.Join(srcSessDir, coldTurnsFilename(seg.ID)),
			filepath.Join(dstSessDir, coldTurnsFilename(seg.ID)),
		); err != nil {
			return err
		}
		if err := copyFileDurable(
			filepath.Join(srcSessDir, coldFrameIndexFilename(seg.ID)),
			filepath.Join(dstSessDir, coldFrameIndexFilename(seg.ID)),
		); err != nil {
			return err
		}
		if seg.DiffsBytes > 0 {
			diffSrc := filepath.Join(srcSessDir, coldDiffsFilename(seg.ID))
			if _, err := os.Stat(diffSrc); err == nil {
				if err := copyFileDurable(diffSrc, filepath.Join(dstSessDir, coldDiffsFilename(seg.ID))); err != nil {
					return err
				}
			}
		}
		return nil
	}

	if err := copyFileDurable(
		filepath.Join(srcSessDir, warmTurnsFilename(seg.ID)),
		filepath.Join(dstSessDir, warmTurnsFilename(seg.ID)),
	); err != nil {
		return err
	}
	if seg.DiffsBytes > 0 {
		diffSrc := filepath.Join(srcSessDir, warmDiffsFilename(seg.ID))
		if _, err := os.Stat(diffSrc); err == nil {
			if err := copyFileDurable(diffSrc, filepath.Join(dstSessDir, warmDiffsFilename(seg.ID))); err != nil {
				return err
			}
		}
	}
	return nil
}

func rewriteMetaSessionID(rawMeta []byte, dstID string) []byte {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(rawMeta, &obj); err != nil || obj == nil {
		return rawMeta
	}
	idJSON, err := json.Marshal(dstID)
	if err != nil {
		return rawMeta
	}
	obj["id"] = idJSON
	out, err := json.Marshal(obj)
	if err != nil {
		return rawMeta
	}
	return out
}

// CloneSessionUpTo clones srcID into dstID keeping the first keepMsgCount raw
// messages (when keepMsgCount < 0, all messages are cloned). Untouched Cold .zst
// and Warm segments are stream-copied directly without re-encoding.
func (s *Store) CloneSessionUpTo(srcID, dstID string, keepMsgCount int) error {
	if !ValidSessionID(srcID) || !ValidSessionID(dstID) {
		return ErrInvalidSessionID
	}
	if srcID == dstID {
		return errors.New("sessionstore: cannot clone session onto itself")
	}
	if err := s.ensureV2ForRead(context.Background(), srcID); err != nil {
		return err
	}

	// Acquire session locks in deterministic lexical order to prevent deadlocks.
	srcMu := s.sessionLock(srcID)
	dstMu := s.sessionLock(dstID)
	if srcID < dstID {
		srcMu.RLock()
		defer srcMu.RUnlock()
		dstMu.Lock()
		defer dstMu.Unlock()
	} else {
		dstMu.Lock()
		defer dstMu.Unlock()
		srcMu.RLock()
		defer srcMu.RUnlock()
	}

	srcDir := s.sessionDir(srcID)
	dstDir := s.sessionDir(dstID)
	defer s.invalidateSessionCache(dstID)
	if err := os.RemoveAll(dstDir); err != nil {
		return err
	}
	if err := os.MkdirAll(dstDir, 0o700); err != nil {
		return err
	}

	// Copy meta.json if present (updating top-level "id" to dstID).
	if rawMeta, err := os.ReadFile(s.metaPath(srcID)); err == nil {
		if err := durable.Write(s.metaPath(dstID), rewriteMetaSessionID(rawMeta, dstID)); err != nil {
			return err
		}
	}

	// Copy attachments directory if present.
	srcAtt := filepath.Join(srcDir, "attachments")
	if entries, err := os.ReadDir(srcAtt); err == nil && len(entries) > 0 {
		dstAtt := filepath.Join(dstDir, "attachments")
		if err := os.MkdirAll(dstAtt, 0o700); err != nil {
			return err
		}
		for _, de := range entries {
			if de.IsDir() {
				continue
			}
			_ = copyFileDurable(filepath.Join(srcAtt, de.Name()), filepath.Join(dstAtt, de.Name()))
		}
	}

	srcManifest, srcEntries, _, err := s.loadStateLocked(srcID)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	nowUnix := time.Now().Unix()
	totalTurns := len(srcEntries)
	if totalTurns == 0 || keepMsgCount == 0 {
		dstManifest := Manifest{
			Version:       manifestFormatVersion,
			SessionID:     dstID,
			NextSegmentID: 1,
			UpdatedAtUnix: nowUnix,
		}
		if err := writeTurnIndexFile(s.turnIndexPath(dstID), nil); err != nil {
			return err
		}
		return writeManifestFile(s.manifestPath(dstID), dstManifest)
	}

	totalMsgs := srcEntries[totalTurns-1].LastMsgIdx + 1
	if keepMsgCount < 0 || keepMsgCount > totalMsgs {
		keepMsgCount = totalMsgs
	}

	cutTurnIdx := findTurnIdxByMsg(srcEntries, keepMsgCount-1)
	cutEntry := srcEntries[cutTurnIdx]
	cutSegID := cutEntry.SegmentID
	isExactTurnEnd := (keepMsgCount - 1) == cutEntry.LastMsgIdx
	isLastTurnOfSeg := cutTurnIdx == totalTurns-1 || srcEntries[cutTurnIdx+1].SegmentID != cutSegID

	var dstSegments []SegmentMeta
	var dstEntries []TurnEntry
	nextSegID := srcManifest.NextSegmentID
	if nextSegID == 0 {
		nextSegID = 1
	}

	if isExactTurnEnd && isLastTurnOfSeg {
		// Every retained segment is copied whole!
		for _, seg := range srcManifest.Segments {
			if seg.LastTurn <= cutEntry.TurnSeq {
				if err := copySegmentFiles(srcDir, dstDir, seg); err != nil {
					return fmt.Errorf("sessionstore: clone segment %d: %w", seg.ID, err)
				}
				dstSegments = append(dstSegments, seg)
				if seg.ID >= nextSegID {
					nextSegID = seg.ID + 1
				}
			}
		}
		dstEntries = append(dstEntries, srcEntries[:cutTurnIdx+1]...)
	} else {
		segFirstIdx := cutTurnIdx
		for segFirstIdx > 0 && srcEntries[segFirstIdx-1].SegmentID == cutSegID {
			segFirstIdx--
		}
		for _, seg := range srcManifest.Segments {
			if seg.LastTurn < srcEntries[segFirstIdx].TurnSeq && seg.ID != cutSegID {
				if err := copySegmentFiles(srcDir, dstDir, seg); err != nil {
					return fmt.Errorf("sessionstore: clone prefix segment %d: %w", seg.ID, err)
				}
				dstSegments = append(dstSegments, seg)
				if seg.ID >= nextSegID {
					nextSegID = seg.ID + 1
				}
			}
		}
		dstEntries = append(dstEntries, srcEntries[:segFirstIdx]...)

		reader := newSegmentReader(s, srcID, srcDir)
		tailTurns := make([]TurnWrite, 0, cutTurnIdx-segFirstIdx+1)
		for i := segFirstIdx; i <= cutTurnIdx; i++ {
			e := srcEntries[i]
			tMsgs, bal, err := reader.readTurn(e)
			if err != nil {
				reader.Close()
				return err
			}
			tokEst := e.TokenEst
			if i == cutTurnIdx && !isExactTurnEnd {
				keepInTurn := keepMsgCount - e.FirstMsgIdx
				tMsgs = tMsgs[:keepInTurn]
				tokEst = EstimateTurnTokens(tMsgs)
				if len(tMsgs) == 1 && tMsgs[0].Role == provider.RoleUser {
					bal = nil
				}
			}
			tailTurns = append(tailTurns, TurnWrite{
				TurnSeq:       e.TurnSeq,
				Messages:      tMsgs,
				DiffBalloon:   bal,
				TokenEst:      tokEst,
				CreatedAtUnix: e.CreatedAtUnix,
			})
		}
		reader.Close()

		tailSegID := nextSegID
		nextSegID++
		tailSegMeta, tailSegEntries, err := writeWarmSegmentFromTurns(
			dstDir,
			tailSegID,
			false,
			tailTurns,
			srcEntries[segFirstIdx].FirstMsgIdx,
		)
		if err != nil {
			return err
		}
		dstSegments = append(dstSegments, tailSegMeta)
		dstEntries = append(dstEntries, tailSegEntries...)
	}

	dstManifest := Manifest{
		Version:       manifestFormatVersion,
		SessionID:     dstID,
		NextSegmentID: nextSegID,
		Segments:      dstSegments,
		UpdatedAtUnix: nowUnix,
	}
	if err := writeManifestFile(s.manifestPath(dstID), dstManifest); err != nil {
		return err
	}
	return writeTurnIndexFile(s.turnIndexPath(dstID), dstEntries)
}
