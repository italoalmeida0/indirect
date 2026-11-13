package sessionstore

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"indirect/indirect-code-daemon/internal/durable"
)

const (
	// DefaultHotKeepTurns is the number of recent turns retained in Warm segments
	// during routine session aging.
	DefaultHotKeepTurns = 100

	// DefaultWarmMaxAge is the maximum age of an inactive Warm segment before it
	// is sealed and compressed into a Cold seekable Zstandard segment.
	DefaultWarmMaxAge = 7 * 24 * time.Hour
)

// AgePolicy controls when Warm segments transition to Cold seekable Zstd archives.
type AgePolicy struct {
	HotKeepTurns int
	WarmMaxAge   time.Duration
	Now          time.Time
}

// DefaultAgePolicy returns the standard 100-turn / 7-day aging policy.
func DefaultAgePolicy() AgePolicy {
	return AgePolicy{
		HotKeepTurns: DefaultHotKeepTurns,
		WarmMaxAge:   DefaultWarmMaxAge,
	}
}

func normalizeAgePolicy(p AgePolicy) AgePolicy {
	if p.HotKeepTurns == 0 && p.WarmMaxAge == 0 {
		p.HotKeepTurns = DefaultHotKeepTurns
		p.WarmMaxAge = DefaultWarmMaxAge
	}
	if p.Now.IsZero() {
		p.Now = time.Now()
	}
	return p
}

// writeColdSegmentDirect serializes turns directly into a sealed Cold 64 KiB
// seekable Zstd segment (seg-<id>.turns.zst, optional seg-<id>.diffs.zst, and
// seg-<id>.fidx) without writing intermediate Warm files.
func writeColdSegmentDirect(sessDir string, segID uint32, coldFrameBytes int, turns []TurnWrite, startMsgIdx int) (SegmentMeta, []TurnEntry, error) {
	turnPayloads := make([][]byte, len(turns))
	diffPayloads := make([][]byte, len(turns))
	tokEsts := make([]int, len(turns))
	firstIdxs := make([]int, len(turns))
	lastIdxs := make([]int, len(turns))
	timestamps := make([]int64, len(turns))

	var blobRefs []string
	var minTurn, maxTurn int
	var minTS, maxTS int64
	var uncompBytes uint64

	msgCursor := startMsgIdx
	for i, tw := range turns {
		ts := tw.CreatedAtUnix
		if ts <= 0 {
			ts = time.Now().Unix()
		}
		timestamps[i] = ts
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
		turnPayloads[i] = tJSON
		uncompBytes += uint64(len(tJSON) + 1)

		if tw.DiffBalloon != nil && (len(tw.DiffBalloon.Files) > 0 || tw.DiffBalloon.TurnIndex > 0) {
			bal := *tw.DiffBalloon
			if bal.TurnIndex <= 0 {
				bal.TurnIndex = tw.TurnSeq
			}
			dJSON, err := json.Marshal(bal)
			if err != nil {
				return SegmentMeta{}, nil, err
			}
			diffPayloads[i] = dJSON
			uncompBytes += uint64(len(dJSON) + 1)
		}

		tok := tw.TokenEst
		if tok <= 0 {
			tok = EstimateTurnTokens(tw.Messages)
		}
		tokEsts[i] = tok
		firstIdxs[i] = msgCursor
		lastIdxs[i] = msgCursor + len(tw.Messages) - 1
		msgCursor = lastIdxs[i] + 1

		refs := CollectMessageBlobRefs(tw.Messages)
		blobRefs, _ = mergeUniqueStrings(blobRefs, refs)
	}

	compTurns, turnFrames, turnCoords, err := buildSeekableFrames(turnPayloads, coldFrameBytes)
	if err != nil {
		return SegmentMeta{}, nil, err
	}
	compDiffs, diffFrames, diffCoords, err := buildSeekableFrames(diffPayloads, coldFrameBytes)
	if err != nil {
		return SegmentMeta{}, nil, err
	}

	turnsZstPath := filepath.Join(sessDir, coldTurnsFilename(segID))
	diffsZstPath := filepath.Join(sessDir, coldDiffsFilename(segID))
	fidxPath := filepath.Join(sessDir, coldFrameIndexFilename(segID))

	if err := durable.Write(turnsZstPath, compTurns); err != nil {
		return SegmentMeta{}, nil, err
	}
	if len(compDiffs) > 0 {
		if err := durable.Write(diffsZstPath, compDiffs); err != nil {
			_ = os.Remove(turnsZstPath)
			return SegmentMeta{}, nil, err
		}
	}
	if err := writeFrameIndexFile(fidxPath, turnFrames, diffFrames); err != nil {
		_ = os.Remove(turnsZstPath)
		_ = os.Remove(diffsZstPath)
		return SegmentMeta{}, nil, err
	}

	entries := make([]TurnEntry, len(turns))
	for i, tw := range turns {
		tc := turnCoords[i]
		dc := diffCoords[i]
		entries[i] = TurnEntry{
			TurnSeq:          tw.TurnSeq,
			SegmentID:        segID,
			Tier:             TierCold,
			FrameIdx:         tc.FrameIdx,
			IntraFrameOffset: tc.IntraFrameOffset,
			ByteLen:          tc.ByteLen,
			DiffFrameIdx:     dc.FrameIdx,
			DiffIntraOffset:  dc.IntraFrameOffset,
			DiffByteLen:      dc.ByteLen,
			FirstMsgIdx:      firstIdxs[i],
			LastMsgIdx:       lastIdxs[i],
			TokenEst:         tokEsts[i],
			CreatedAtUnix:    timestamps[i],
		}
	}

	meta := SegmentMeta{
		ID:            segID,
		Tier:          TierCold,
		Sealed:        true,
		FirstTurn:     minTurn,
		LastTurn:      maxTurn,
		TurnCount:     len(turns),
		TurnsBytes:    uint64(len(compTurns)),
		DiffsBytes:    uint64(len(compDiffs)),
		UncompBytes:   uncompBytes,
		CreatedAtUnix: minTS,
		UpdatedAtUnix: maxTS,
		HasBlobIndex:  true,
		BlobRefs:      blobRefs,
	}
	return meta, entries, nil
}

// AgeSession seals and compresses any Warm segment whose highest turn sits at or
// below totalTurns - policy.HotKeepTurns OR whose last-modified age exceeds
// policy.WarmMaxAge into Cold 64 KiB seekable Zstandard segments atomically.
// Returns the number of Warm segments converted to Cold.
func (s *Store) AgeSession(ctx context.Context, id string, policy AgePolicy) (int, error) {
	if !ValidSessionID(id) {
		return 0, ErrInvalidSessionID
	}
	if s.IsPurged(id) {
		return 0, ErrSessionPurged
	}
	policy = normalizeAgePolicy(policy)

	mu := s.sessionLock(id)
	mu.Lock()
	defer mu.Unlock()
	defer s.invalidateSessionCache(id)

	if s.IsPurged(id) {
		return 0, ErrSessionPurged
	}
	if err := s.ensureV2Locked(ctx, id); err != nil {
		return 0, err
	}

	m, entries, _, err := s.loadStateLocked(id)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	totalTurns := len(entries)
	if totalTurns == 0 || len(m.Segments) == 0 {
		return 0, nil
	}

	// Map segment ID -> [lo, hi) slice range in entries.
	type span struct{ lo, hi int }
	segSpans := make(map[uint32]span, len(m.Segments))
	for i := 0; i < totalTurns; {
		segID := entries[i].SegmentID
		j := i + 1
		for j < totalTurns && entries[j].SegmentID == segID {
			j++
		}
		segSpans[segID] = span{lo: i, hi: j}
		i = j
	}

	sessDir := s.sessionDir(id)
	keepTurns := policy.HotKeepTurns
	if keepTurns < 0 {
		keepTurns = 0
	}
	cutoffEntryCount := totalTurns - keepTurns // entries[0 : cutoffEntryCount] are outside HotKeepTurns

	var convertedSegIDs []uint32
	newEntries := append([]TurnEntry(nil), entries...)

	for si := range m.Segments {
		if s.IsPurged(id) {
			for _, cid := range convertedSegIDs {
				_ = os.Remove(filepath.Join(sessDir, coldTurnsFilename(cid)))
				_ = os.Remove(filepath.Join(sessDir, coldDiffsFilename(cid)))
				_ = os.Remove(filepath.Join(sessDir, coldFrameIndexFilename(cid)))
			}
			return 0, ErrSessionPurged
		}
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		seg := &m.Segments[si]
		if seg.Tier != TierWarm || seg.TurnCount == 0 {
			continue
		}
		sp, ok := segSpans[seg.ID]
		if !ok || sp.lo >= sp.hi {
			continue
		}

		byTurnDistance := cutoffEntryCount > 0 && sp.hi <= cutoffEntryCount
		byAge := false
		if policy.WarmMaxAge > 0 {
			warmPath := filepath.Join(sessDir, warmTurnsFilename(seg.ID))
			var lastMod time.Time
			if seg.UpdatedAtUnix > 0 {
				lastMod = time.Unix(seg.UpdatedAtUnix, 0)
			}
			if fi, stErr := os.Stat(warmPath); stErr == nil {
				// If segment metadata wasn't explicitly backdated, prefer actual file mtime when newer.
				if lastMod.IsZero() {
					lastMod = fi.ModTime()
				}
			}
			if !lastMod.IsZero() && policy.Now.Sub(lastMod) > policy.WarmMaxAge {
				byAge = true
			}
		}

		if !byTurnDistance && !byAge {
			continue
		}

		// Read Warm records for this segment and close file handles before writing/deleting.
		segCount := sp.hi - sp.lo
		turnRecs := make([][]byte, segCount)
		diffRecs := make([][]byte, segCount)

		warmReader := newSegmentReader(s, id, sessDir)
		for k := 0; k < segCount; k++ {
			e := entries[sp.lo+k]
			rt, rerr := warmReader.readRawTurn(e)
			if rerr != nil {
				warmReader.Close()
				return 0, rerr
			}
			turnRecs[k] = bytes.Clone(rt)
			rd, derr := warmReader.readRawDiff(e)
			if derr != nil {
				warmReader.Close()
				return 0, derr
			}
			if len(rd) > 0 {
				diffRecs[k] = bytes.Clone(rd)
			}
		}
		warmReader.Close()

		compTurns, turnFrames, turnCoords, err := buildSeekableFrames(turnRecs, s.coldFrameBytes)
		if err != nil {
			return 0, err
		}
		compDiffs, diffFrames, diffCoords, err := buildSeekableFrames(diffRecs, s.coldFrameBytes)
		if err != nil {
			return 0, err
		}

		turnsZstPath := filepath.Join(sessDir, coldTurnsFilename(seg.ID))
		diffsZstPath := filepath.Join(sessDir, coldDiffsFilename(seg.ID))
		fidxPath := filepath.Join(sessDir, coldFrameIndexFilename(seg.ID))

		if err := durable.Write(turnsZstPath, compTurns); err != nil {
			return 0, err
		}
		if len(compDiffs) > 0 {
			if err := durable.Write(diffsZstPath, compDiffs); err != nil {
				_ = os.Remove(turnsZstPath)
				return 0, err
			}
		}
		if err := writeFrameIndexFile(fidxPath, turnFrames, diffFrames); err != nil {
			_ = os.Remove(turnsZstPath)
			_ = os.Remove(diffsZstPath)
			return 0, err
		}

		for k := 0; k < segCount; k++ {
			tc := turnCoords[k]
			dc := diffCoords[k]
			orig := newEntries[sp.lo+k]
			newEntries[sp.lo+k] = TurnEntry{
				TurnSeq:          orig.TurnSeq,
				SegmentID:        seg.ID,
				Tier:             TierCold,
				FrameIdx:         tc.FrameIdx,
				IntraFrameOffset: tc.IntraFrameOffset,
				ByteLen:          tc.ByteLen,
				DiffFrameIdx:     dc.FrameIdx,
				DiffIntraOffset:  dc.IntraFrameOffset,
				DiffByteLen:      dc.ByteLen,
				FirstMsgIdx:      orig.FirstMsgIdx,
				LastMsgIdx:       orig.LastMsgIdx,
				TokenEst:         orig.TokenEst,
				CreatedAtUnix:    orig.CreatedAtUnix,
			}
		}

		seg.Tier = TierCold
		seg.Sealed = true
		seg.TurnsBytes = uint64(len(compTurns))
		seg.DiffsBytes = uint64(len(compDiffs))
		convertedSegIDs = append(convertedSegIDs, seg.ID)
	}

	if len(convertedSegIDs) == 0 {
		return 0, nil
	}
	if s.IsPurged(id) {
		for _, cid := range convertedSegIDs {
			_ = os.Remove(filepath.Join(sessDir, coldTurnsFilename(cid)))
			_ = os.Remove(filepath.Join(sessDir, coldDiffsFilename(cid)))
			_ = os.Remove(filepath.Join(sessDir, coldFrameIndexFilename(cid)))
		}
		return 0, ErrSessionPurged
	}

	m.UpdatedAtUnix = policy.Now.Unix()
	if err := writeTurnIndexFile(s.turnIndexPath(id), newEntries); err != nil {
		return 0, err
	}
	if err := writeManifestFile(s.manifestPath(id), m); err != nil {
		return 0, err
	}

	// Safe to unlink superseded Warm files now that turn.idx and manifest.json point to Cold.
	for _, segID := range convertedSegIDs {
		_ = os.Remove(filepath.Join(sessDir, warmTurnsFilename(segID)))
		_ = os.Remove(filepath.Join(sessDir, warmDiffsFilename(segID)))
	}
	syncDirBestEffort(sessDir)
	return len(convertedSegIDs), nil
}

func syncDirBestEffort(dir string) {
	if df, err := os.Open(dir); err == nil {
		_ = df.Sync()
		_ = df.Close()
	}
}
