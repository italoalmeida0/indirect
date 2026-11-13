package sessionstore

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"indirect/indirect-code-daemon/internal/durable"
	"indirect/indirect-code-daemon/packages/core"
	"indirect/indirect-code-daemon/packages/filetrack"
	"indirect/indirect-code-daemon/packages/provider"
)

const (
	// DefaultWarmSegmentMaxBytes rotates an active Warm segment once turns+diffs
	// reach ~8 MiB.
	DefaultWarmSegmentMaxBytes uint64 = 8 * 1024 * 1024

	// DefaultWarmSegmentMaxTurns rotates an active Warm segment every 128 turns.
	DefaultWarmSegmentMaxTurns = 128

	metaFilename      = "meta.json"
	manifestFilename  = "manifest.json"
	turnIndexFilename = "turn.idx"
)

var (
	// ErrInvalidSessionID refuses empty or path-traversing session IDs.
	ErrInvalidSessionID = errors.New("sessionstore: invalid session id")

	// ErrEmptyTurn refuses appending a turn with zero messages.
	ErrEmptyTurn = errors.New("sessionstore: turn must contain at least one message")
)

// Option configures a Store instance.
type Option func(*Store)

// WithWarmSegmentLimits overrides the byte and turn count thresholds at which
// Warm segments rotate.
func WithWarmSegmentLimits(maxBytes uint64, maxTurns int) Option {
	return func(s *Store) {
		if maxBytes > 0 {
			s.warmMaxBytes = maxBytes
		}
		if maxTurns > 0 {
			s.warmMaxTurns = maxTurns
		}
	}
}

// WithColdFrameTargetBytes overrides the target uncompressed Zstandard frame
// size (default 64 KiB).
func WithColdFrameTargetBytes(targetBytes int) Option {
	return func(s *Store) {
		if targetBytes > 0 {
			s.coldFrameBytes = targetBytes
		}
	}
}

const maxCachedSessions = 32

type cachedSessionState struct {
	manifest      Manifest
	entries       []TurnEntry
	validIdxBytes int64
	idxSize       int64
	idxModUnixNs  int64
	hasIdxFile    bool
	frameIdx      map[uint32]cachedFrameIdx
}

// Store manages tiered segmented v2 sessions and CAS blobs inside one slot directory.
type Store struct {
	slotDir        string
	sessionsDir    string
	cas            *CASStore
	warmMaxBytes   uint64
	warmMaxTurns   int
	coldFrameBytes int

	coldFramesDecoded atomic.Uint64

	locksMu sync.Mutex
	locks   map[string]*sync.RWMutex

	cacheMu    sync.RWMutex
	stateCache map[string]*cachedSessionState
}

// New opens a tiered session store rooted at slotDir (<slotDir>/sessions, <slotDir>/blobs).
func New(slotDir string, opts ...Option) *Store {
	s := &Store{
		slotDir:        slotDir,
		sessionsDir:    filepath.Join(slotDir, "sessions"),
		cas:            NewCASStore(slotDir),
		warmMaxBytes:   DefaultWarmSegmentMaxBytes,
		warmMaxTurns:   DefaultWarmSegmentMaxTurns,
		coldFrameBytes: ColdFrameTargetBytes,
		locks:          make(map[string]*sync.RWMutex),
		stateCache:     make(map[string]*cachedSessionState, 8),
	}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	return s
}

// SlotDir returns the slot directory backing this store.
func (s *Store) SlotDir() string { return s.slotDir }

// SessionsDir returns <slotDir>/sessions.
func (s *Store) SessionsDir() string { return s.sessionsDir }

// CAS returns the store's content-addressed blob store.
func (s *Store) CAS() *CASStore { return s.cas }

// ColdFramesDecoded returns the cumulative count of Cold 64 KiB Zstandard frames
// decompressed by random-access and range queries on this Store.
func (s *Store) ColdFramesDecoded() uint64 {
	return s.coldFramesDecoded.Load()
}

// ResetColdFramesDecoded zeroes the Cold frame decode counter (for tests/benchmarks).
func (s *Store) ResetColdFramesDecoded() {
	s.coldFramesDecoded.Store(0)
}

// ValidSessionID reports whether id is safe to use as a single path component.
func ValidSessionID(id string) bool {
	return id != "" && !strings.ContainsAny(id, "/\\") && id != "." && id != ".."
}

func (s *Store) sessionLock(id string) *sync.RWMutex {
	s.locksMu.Lock()
	mu := s.locks[id]
	if mu == nil {
		mu = &sync.RWMutex{}
		s.locks[id] = mu
	}
	s.locksMu.Unlock()
	return mu
}

func (s *Store) sessionDir(id string) string {
	return filepath.Join(s.sessionsDir, id)
}

func (s *Store) legacyFile(id string) string {
	return filepath.Join(s.sessionsDir, id+".jsonl")
}

func (s *Store) metaPath(id string) string {
	return filepath.Join(s.sessionDir(id), metaFilename)
}

func (s *Store) manifestPath(id string) string {
	return filepath.Join(s.sessionDir(id), manifestFilename)
}

func (s *Store) turnIndexPath(id string) string {
	return filepath.Join(s.sessionDir(id), turnIndexFilename)
}

// HasV2Session reports whether id has a v2 segmented directory (manifest.json or meta.json).
func (s *Store) HasV2Session(id string) bool {
	if !ValidSessionID(id) {
		return false
	}
	if st, err := os.Stat(s.manifestPath(id)); err == nil && st.Mode().IsRegular() {
		return true
	}
	if st, err := os.Stat(s.metaPath(id)); err == nil && st.Mode().IsRegular() {
		return true
	}
	return false
}

// HasLegacySession reports whether a v1 <id>.jsonl file still exists on disk.
func (s *Store) HasLegacySession(id string) bool {
	if !ValidSessionID(id) {
		return false
	}
	st, err := os.Stat(s.legacyFile(id))
	return err == nil && st.Mode().IsRegular()
}

// ensureV2Locked transparently migrates <id>.jsonl if present and not yet migrated.
// Caller must hold sessionLock(id).Lock().
func (s *Store) ensureV2Locked(ctx context.Context, id string) error {
	if _, err := os.Stat(s.manifestPath(id)); err == nil {
		return nil
	}
	if _, err := os.Stat(s.metaPath(id)); err == nil {
		return nil
	}
	leg := s.legacyFile(id)
	if st, err := os.Stat(leg); err == nil && st.Mode().IsRegular() {
		return s.migrateLegacyLocked(ctx, id, leg, DefaultAgePolicy())
	}
	return nil
}

// ensureV2ForRead ensures a legacy <id>.jsonl session is migrated before running
// a v2 indexed read, upgrading from no lock to write lock only if needed.
func (s *Store) ensureV2ForRead(ctx context.Context, id string) error {
	if s.HasV2Session(id) || !s.HasLegacySession(id) {
		return nil
	}
	mu := s.sessionLock(id)
	mu.Lock()
	defer mu.Unlock()
	return s.ensureV2Locked(ctx, id)
}

// ReadMeta reads <slot>/sessions/<id>/meta.json in O(1) without touching turn
// segments. If the session still exists only as a legacy <id>.jsonl file, it
// reads the trailing meta line directly without migrating or scanning turns.
func (s *Store) ReadMeta(id string) ([]byte, error) {
	if !ValidSessionID(id) {
		return nil, ErrInvalidSessionID
	}
	mu := s.sessionLock(id)
	mu.RLock()
	data, err := os.ReadFile(s.metaPath(id))
	if err == nil {
		mu.RUnlock()
		return data, nil
	}
	if !os.IsNotExist(err) {
		mu.RUnlock()
		return nil, err
	}
	legPath := s.legacyFile(id)
	legMeta, legErr := readLegacyMetaTail(legPath)
	mu.RUnlock()
	if legErr == nil {
		return legMeta, nil
	}
	return nil, err
}

// WriteMeta atomically writes rawMetaJSON to <slot>/sessions/<id>/meta.json in
// O(1) with zero turn I/O. If a legacy <id>.jsonl exists, it is migrated first.
func (s *Store) WriteMeta(id string, rawMetaJSON []byte) error {
	if !ValidSessionID(id) {
		return ErrInvalidSessionID
	}
	trimmed := bytes.TrimSpace(rawMetaJSON)
	if len(trimmed) == 0 || !json.Valid(trimmed) {
		return errors.New("sessionstore: invalid meta json")
	}
	mu := s.sessionLock(id)
	mu.Lock()
	defer mu.Unlock()

	if err := s.ensureV2Locked(context.Background(), id); err != nil {
		return err
	}
	dir := s.sessionDir(id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	// Ensure an initial manifest.json exists for newly created empty sessions.
	mPath := s.manifestPath(id)
	if _, err := os.Stat(mPath); os.IsNotExist(err) {
		initManifest := Manifest{
			Version:       manifestFormatVersion,
			SessionID:     id,
			NextSegmentID: 1,
			UpdatedAtUnix: time.Now().Unix(),
		}
		if err := writeManifestFile(mPath, initManifest); err != nil {
			return err
		}
	}
	return durable.Write(s.metaPath(id), trimmed)
}

// ReadTurnIndex returns a copy of the session's compact turn index entries.
func (s *Store) ReadTurnIndex(id string) ([]TurnEntry, error) {
	if !ValidSessionID(id) {
		return nil, ErrInvalidSessionID
	}
	if err := s.ensureV2ForRead(context.Background(), id); err != nil {
		return nil, err
	}
	mu := s.sessionLock(id)
	mu.RLock()
	defer mu.RUnlock()

	_, entries, _, err := s.loadStateReadOnlyLocked(id)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	return slices.Clone(entries), nil
}

// LastTurnEntry returns the session's final TurnEntry and total turn count in O(1)
// using the in-memory state cache when clean.
func (s *Store) LastTurnEntry(id string) (TurnEntry, int, bool, error) {
	if !ValidSessionID(id) {
		return TurnEntry{}, 0, false, ErrInvalidSessionID
	}
	if err := s.ensureV2ForRead(context.Background(), id); err != nil {
		return TurnEntry{}, 0, false, err
	}
	mu := s.sessionLock(id)
	mu.RLock()
	defer mu.RUnlock()

	_, entries, _, err := s.loadStateReadOnlyLocked(id)
	if err != nil {
		if os.IsNotExist(err) {
			return TurnEntry{}, 0, false, nil
		}
		return TurnEntry{}, 0, false, err
	}
	if len(entries) == 0 {
		return TurnEntry{}, 0, false, nil
	}
	return entries[len(entries)-1], len(entries), true, nil
}

// ReadManifest returns the session's reconciled segment manifest.
func (s *Store) ReadManifest(id string) (Manifest, error) {
	if !ValidSessionID(id) {
		return Manifest{}, ErrInvalidSessionID
	}
	if err := s.ensureV2ForRead(context.Background(), id); err != nil {
		return Manifest{}, err
	}
	mu := s.sessionLock(id)
	mu.RLock()
	defer mu.RUnlock()

	m, entries, _, err := s.loadStateLocked(id)
	if err != nil {
		return Manifest{}, err
	}
	_ = entries
	return m, nil
}

func (s *Store) invalidateSessionCache(id string) {
	s.cacheMu.Lock()
	delete(s.stateCache, id)
	s.cacheMu.Unlock()
}

func (s *Store) loadStateReadOnlyLocked(id string) (Manifest, []TurnEntry, int64, error) {
	idxPath := s.turnIndexPath(id)
	var idxSize, idxModNs int64
	hasIdxFile := false
	if st, err := os.Stat(idxPath); err == nil {
		hasIdxFile = true
		idxSize = st.Size()
		idxModNs = st.ModTime().UnixNano()
	}

	s.cacheMu.RLock()
	cs := s.stateCache[id]
	if cs != nil && cs.hasIdxFile == hasIdxFile && cs.idxSize == idxSize && cs.idxModUnixNs == idxModNs {
		m, entries, vb := cs.manifest, cs.entries, cs.validIdxBytes
		s.cacheMu.RUnlock()
		return m, entries, vb, nil
	}
	s.cacheMu.RUnlock()

	m, entries, vb, err := s.loadStateFromDiskLocked(id)
	if err != nil {
		return Manifest{}, nil, 0, err
	}

	s.cacheMu.Lock()
	if len(s.stateCache) >= maxCachedSessions {
		for k := range s.stateCache {
			delete(s.stateCache, k)
			break
		}
	}
	var prevFrames map[uint32]cachedFrameIdx
	if old := s.stateCache[id]; old != nil {
		prevFrames = old.frameIdx
	}
	if prevFrames == nil {
		prevFrames = make(map[uint32]cachedFrameIdx, 4)
	}
	s.stateCache[id] = &cachedSessionState{
		manifest:      m,
		entries:       entries,
		validIdxBytes: vb,
		idxSize:       idxSize,
		idxModUnixNs:  idxModNs,
		hasIdxFile:    hasIdxFile,
		frameIdx:      prevFrames,
	}
	s.cacheMu.Unlock()

	return m, entries, vb, nil
}

func (s *Store) getCachedColdFrameIdx(id string, segID uint32) (cachedFrameIdx, bool) {
	s.cacheMu.RLock()
	defer s.cacheMu.RUnlock()
	if cs := s.stateCache[id]; cs != nil && cs.frameIdx != nil {
		fi, ok := cs.frameIdx[segID]
		return fi, ok
	}
	return cachedFrameIdx{}, false
}

func (s *Store) putCachedColdFrameIdx(id string, segID uint32, fi cachedFrameIdx) {
	s.cacheMu.Lock()
	if cs := s.stateCache[id]; cs != nil {
		if cs.frameIdx == nil {
			cs.frameIdx = make(map[uint32]cachedFrameIdx, 4)
		}
		cs.frameIdx[segID] = fi
	}
	s.cacheMu.Unlock()
}

func (s *Store) loadStateLocked(id string) (Manifest, []TurnEntry, int64, error) {
	return s.loadStateFromDiskLocked(id)
}

func (s *Store) loadStateFromDiskLocked(id string) (Manifest, []TurnEntry, int64, error) {
	mPath := s.manifestPath(id)
	m, err := readManifestFile(mPath)
	if err != nil {
		if !os.IsNotExist(err) {
			return Manifest{}, nil, 0, err
		}
		// Check if meta.json exists (valid empty session); otherwise propagate ENOENT.
		if _, merr := os.Stat(s.metaPath(id)); merr != nil {
			return Manifest{}, nil, 0, err
		}
		m = Manifest{
			Version:       manifestFormatVersion,
			SessionID:     id,
			NextSegmentID: 1,
		}
	}
	entries, validIdxBytes, err := readTurnIndexFile(s.turnIndexPath(id))
	if err != nil {
		return Manifest{}, nil, 0, err
	}
	for len(entries) > 0 && entries[len(entries)-1].Tier == TierWarm {
		last := entries[len(entries)-1]
		turnsPath := filepath.Join(s.sessionDir(id), warmTurnsFilename(last.SegmentID))
		st, serr := os.Stat(turnsPath)
		if serr == nil && uint64(st.Size()) >= last.Offset+uint64(last.Length) {
			break
		}
		entries = entries[:len(entries)-1]
		if validIdxBytes >= turnIndexHeaderBytes+turnIndexEntryBytes {
			validIdxBytes -= turnIndexEntryBytes
		}
	}
	reconcileManifestWithIndex(&m, entries)
	return m, entries, validIdxBytes, nil
}

// TurnWrite represents one finished turn to append to a session.
type TurnWrite struct {
	TurnSeq       int                    `json:"turnSeq"`
	Messages      []provider.Message     `json:"messages"`
	DiffBalloon   *filetrack.TurnChanges `json:"diffBalloon,omitempty"`
	TokenEst      int                    `json:"tokenEst,omitempty"`
	CreatedAtUnix int64                  `json:"createdAtUnix,omitempty"`
}

type diskTurnRecord struct {
	Turn          int               `json:"turn"`
	CreatedAtUnix int64             `json:"ts,omitempty"`
	Messages      []json.RawMessage `json:"messages"`
}

// EstimateTurnTokens estimates the token weight of msgs using provider.ContextTokens,
// accounting for CAS-externalized ImageBlocks whose raw Data was cleared.
func EstimateTurnTokens(msgs []provider.Message) int {
	if len(msgs) == 0 {
		return 0
	}
	toks := provider.ContextTokens("", nil, msgs)
	// Add byte-size safety bump for CAS-externalized images (Data == nil, ByteLen > 0).
	for _, m := range msgs {
		for _, blk := range m.Content {
			switch v := blk.(type) {
			case provider.ImageBlock:
				if len(v.Data) == 0 && v.ByteLen > 0 {
					b64Len := base64.StdEncoding.EncodedLen(v.ByteLen)
					toks += min(4096, b64Len/2048)
				}
			case provider.ToolResultBlock:
				for _, inner := range v.Content {
					if ib, ok := inner.(provider.ImageBlock); ok && len(ib.Data) == 0 && ib.ByteLen > 0 {
						b64Len := base64.StdEncoding.EncodedLen(ib.ByteLen)
						toks += min(4096, b64Len/2048)
					}
				}
			}
		}
	}
	if toks <= 0 {
		toks = 1
	}
	return toks
}

func marshalTurnPayload(turnSeq int, createdAt int64, msgs []provider.Message) ([]byte, error) {
	rawMsgs := make([]json.RawMessage, len(msgs))
	for i := range msgs {
		m := msgs[i]
		if m.TurnIndex < 0 {
			m.TurnIndex = 0
		}
		b, err := json.Marshal(m)
		if err != nil {
			return nil, err
		}
		rawMsgs[i] = b
	}
	rec := diskTurnRecord{
		Turn:          turnSeq,
		CreatedAtUnix: createdAt,
		Messages:      rawMsgs,
	}
	enc, err := json.Marshal(rec)
	if err != nil {
		return nil, err
	}
	return enc, nil
}

func unmarshalTurnPayload(raw []byte) (int, []provider.Message, error) {
	var rec diskTurnRecord
	if err := json.Unmarshal(raw, &rec); err != nil {
		return 0, nil, err
	}
	msgs := make([]provider.Message, 0, len(rec.Messages))
	for _, rm := range rec.Messages {
		m, err := core.HydrateMessageObject(rm)
		if err != nil {
			return 0, nil, err
		}
		if m.TurnIndex < 0 {
			m.TurnIndex = 0
		}
		msgs = append(msgs, m)
	}
	return rec.Turn, msgs, nil
}

func stageAtExactEnd(path string, expectedOffset uint64, payload []byte) (*os.File, error) {
	if len(payload) == 0 {
		return nil, nil
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	st, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	if uint64(st.Size()) != expectedOffset {
		if err := f.Truncate(int64(expectedOffset)); err != nil {
			_ = f.Close()
			return nil, err
		}
	}
	if _, err := f.Seek(int64(expectedOffset), io.SeekStart); err != nil {
		_ = f.Close()
		return nil, err
	}
	if _, err := f.Write(payload); err != nil {
		_ = f.Close()
		return nil, err
	}
	return f, nil
}

func stageTempPublish(dir string, data []byte) (*os.File, string, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, "", err
	}
	f, err := os.CreateTemp(dir, ".publish-*")
	if err != nil {
		return nil, "", err
	}
	name := f.Name()
	if err := f.Chmod(0o600); err != nil {
		_ = f.Close()
		_ = os.Remove(name)
		return nil, "", err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(name)
		return nil, "", err
	}
	return f, name, nil
}

func syncAndCloseFiles(files []*os.File) error {
	var firstErr error
	for _, fh := range files {
		if fh == nil {
			continue
		}
		if err := fh.Sync(); err != nil && firstErr == nil {
			firstErr = err
		}
		if err := fh.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func cloneManifest(m Manifest) Manifest {
	cp := m
	if len(m.Segments) > 0 {
		cp.Segments = make([]SegmentMeta, len(m.Segments))
		for i, seg := range m.Segments {
			seg.BlobRefs = slices.Clone(seg.BlobRefs)
			cp.Segments[i] = seg
		}
	}
	return cp
}

func writeAtExactEnd(path string, expectedOffset uint64, payload []byte) error {
	f, err := stageAtExactEnd(path, expectedOffset, payload)
	if err != nil || f == nil {
		return err
	}
	return syncAndCloseFiles([]*os.File{f})
}

// AppendTurn externalizes inline images to CAS, scrubs oversized legacy tool
// Details, appends the turn and optional diff balloon to the active Warm
// segment in O(turn_size) (rotating at ~8 MiB or 128 turns), and appends a
// compact entry to turn.idx.
func (s *Store) AppendTurn(id string, w TurnWrite) (TurnEntry, error) {
	added, err := s.AppendTurns(id, []TurnWrite{w})
	if err != nil {
		return TurnEntry{}, err
	}
	return added[0], nil
}

// AppendTurns appends one or more turns to session id, rotating Warm segments
// at ~8 MiB or 128 turns while coalescing segment/index fsyncs across the batch.
func (s *Store) AppendTurns(id string, writes []TurnWrite) ([]TurnEntry, error) {
	added, _, _, err := s.AppendTurnsAndMeta(id, writes, nil)
	return added, err
}

// AppendTurnsAndMeta appends writes (if non-empty) and atomically updates
// meta.json (if rawMetaJSON is non-empty) under one session lock, coalescing
// data/temp-file fsyncs so turn commits complete in O(turn_size) with minimal
// storage flushes.
func (s *Store) AppendTurnsAndMeta(id string, writes []TurnWrite, rawMetaJSON []byte) ([]TurnEntry, int, int, error) {
	if !ValidSessionID(id) {
		return nil, 0, 0, ErrInvalidSessionID
	}
	trimmedMeta := bytes.TrimSpace(rawMetaJSON)
	if len(rawMetaJSON) > 0 && (len(trimmedMeta) == 0 || !json.Valid(trimmedMeta)) {
		return nil, 0, 0, errors.New("sessionstore: invalid meta json")
	}
	if len(writes) == 0 {
		if len(trimmedMeta) > 0 {
			if err := s.WriteMeta(id, trimmedMeta); err != nil {
				return nil, 0, 0, err
			}
		}
		last, count, ok, err := s.LastTurnEntry(id)
		if err != nil {
			return nil, 0, 0, err
		}
		if !ok {
			return nil, 0, 0, nil
		}
		return nil, count, last.LastMsgIdx + 1, nil
	}

	type prepTurn struct {
		cleanMsgs []provider.Message
		blobRefs  []string
		tokEst    int
		nowUnix   int64
		orig      TurnWrite
	}
	prepped := make([]prepTurn, len(writes))
	for i, w := range writes {
		if len(w.Messages) == 0 {
			return nil, 0, 0, ErrEmptyTurn
		}
		extMsgs, err := s.cas.ExternalizeMessageImages(w.Messages)
		if err != nil {
			return nil, 0, 0, err
		}
		cleanMsgs := ScrubMessagesDetails(extMsgs)
		tokEst := w.TokenEst
		if tokEst <= 0 {
			tokEst = EstimateTurnTokens(cleanMsgs)
		}
		nowUnix := w.CreatedAtUnix
		if nowUnix <= 0 {
			nowUnix = time.Now().Unix()
		}
		prepped[i] = prepTurn{
			cleanMsgs: cleanMsgs,
			blobRefs:  CollectMessageBlobRefs(cleanMsgs),
			tokEst:    tokEst,
			nowUnix:   nowUnix,
			orig:      w,
		}
	}

	mu := s.sessionLock(id)
	mu.Lock()
	defer mu.Unlock()

	if err := s.ensureV2Locked(context.Background(), id); err != nil {
		return nil, 0, 0, err
	}

	sessDir := s.sessionDir(id)
	if err := os.MkdirAll(sessDir, 0o700); err != nil {
		return nil, 0, 0, err
	}

	cachedM, cachedEntries, validIdxBytes, err := s.loadStateReadOnlyLocked(id)
	var m Manifest
	var entries []TurnEntry
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, 0, 0, err
		}
		m = Manifest{
			Version:       manifestFormatVersion,
			SessionID:     id,
			NextSegmentID: 1,
			UpdatedAtUnix: prepped[0].nowUnix,
		}
	} else {
		m = cloneManifest(cachedM)
		entries = cachedEntries
	}

	lastTurnSeq := 0
	nextMsgIdx := 0
	if len(entries) > 0 {
		lastTurnSeq = entries[len(entries)-1].TurnSeq
		nextMsgIdx = entries[len(entries)-1].LastMsgIdx + 1
	}

	type segBatch struct {
		segID      uint32
		turnsStart uint64
		turnsBuf   bytes.Buffer
		diffsStart uint64
		diffsBuf   bytes.Buffer
	}
	var batches []*segBatch
	batchBySeg := make(map[uint32]*segBatch)
	getBatch := func(seg *SegmentMeta) *segBatch {
		if b, ok := batchBySeg[seg.ID]; ok {
			return b
		}
		b := &segBatch{
			segID:      seg.ID,
			turnsStart: seg.TurnsBytes,
			diffsStart: seg.DiffsBytes,
		}
		batchBySeg[seg.ID] = b
		batches = append(batches, b)
		return b
	}

	needManifestWrite := false
	addedEntries := make([]TurnEntry, 0, len(prepped))

	for _, pt := range prepped {
		turnSeq := pt.orig.TurnSeq
		if turnSeq <= 0 || turnSeq <= lastTurnSeq {
			turnSeq = lastTurnSeq + 1
		}
		lastTurnSeq = turnSeq

		firstMsgIdx := nextMsgIdx
		lastMsgIdx := firstMsgIdx + len(pt.cleanMsgs) - 1
		nextMsgIdx = lastMsgIdx + 1

		turnJSON, err := marshalTurnPayload(turnSeq, pt.nowUnix, pt.cleanMsgs)
		if err != nil {
			return nil, 0, 0, err
		}
		turnBytes := append(turnJSON, '\n')

		var diffBytes []byte
		if pt.orig.DiffBalloon != nil && (len(pt.orig.DiffBalloon.Files) > 0 || pt.orig.DiffBalloon.TurnIndex > 0) {
			bal := *pt.orig.DiffBalloon
			if bal.TurnIndex <= 0 {
				bal.TurnIndex = turnSeq
			}
			dj, err := json.Marshal(bal)
			if err != nil {
				return nil, 0, 0, err
			}
			diffBytes = append(dj, '\n')
		}

		activeIdx := -1
		if len(m.Segments) > 0 {
			last := &m.Segments[len(m.Segments)-1]
			addBytes := uint64(len(turnBytes) + len(diffBytes))
			canAppend := last.Tier == TierWarm &&
				!last.Sealed &&
				last.TurnCount < s.warmMaxTurns &&
				(last.TurnCount == 0 || last.TurnsBytes+last.DiffsBytes+addBytes <= s.warmMaxBytes)
			if canAppend {
				activeIdx = len(m.Segments) - 1
			} else if !last.Sealed {
				last.Sealed = true
				needManifestWrite = true
			}
		}

		if activeIdx < 0 {
			if m.NextSegmentID == 0 {
				m.NextSegmentID = 1
			}
			segID := m.NextSegmentID
			m.NextSegmentID++
			m.Segments = append(m.Segments, SegmentMeta{
				ID:            segID,
				Tier:          TierWarm,
				Sealed:        false,
				FirstTurn:     turnSeq,
				LastTurn:      turnSeq,
				TurnCount:     0,
				CreatedAtUnix: pt.nowUnix,
				UpdatedAtUnix: pt.nowUnix,
				HasBlobIndex:  true,
			})
			activeIdx = len(m.Segments) - 1
			needManifestWrite = true
		}

		seg := &m.Segments[activeIdx]
		if !seg.HasBlobIndex {
			seg.HasBlobIndex = true
			needManifestWrite = true
		}
		if merged, added := mergeUniqueStrings(seg.BlobRefs, pt.blobRefs); added {
			seg.BlobRefs = merged
			needManifestWrite = true
		}

		b := getBatch(seg)
		turnOffset := seg.TurnsBytes
		diffOffset := seg.DiffsBytes
		if len(diffBytes) == 0 {
			diffOffset = 0
		}
		b.turnsBuf.Write(turnBytes)
		if len(diffBytes) > 0 {
			b.diffsBuf.Write(diffBytes)
		}

		seg.LastTurn = turnSeq
		seg.TurnCount++
		seg.TurnsBytes += uint64(len(turnBytes))
		seg.DiffsBytes += uint64(len(diffBytes))
		seg.UncompBytes += uint64(len(turnBytes) + len(diffBytes))
		seg.UpdatedAtUnix = pt.nowUnix
		m.UpdatedAtUnix = pt.nowUnix

		addedEntries = append(addedEntries, TurnEntry{
			TurnSeq:       turnSeq,
			SegmentID:     seg.ID,
			Tier:          TierWarm,
			Offset:        turnOffset,
			Length:        uint32(len(turnBytes)),
			DiffOffset:    diffOffset,
			DiffLength:    uint32(len(diffBytes)),
			FirstMsgIdx:   firstMsgIdx,
			LastMsgIdx:    lastMsgIdx,
			TokenEst:      pt.tokEst,
			CreatedAtUnix: pt.nowUnix,
		})
	}

	var stagedFiles []*os.File
	var tempPaths []string
	cleanupStaged := func() {
		for _, f := range stagedFiles {
			if f != nil {
				_ = f.Close()
			}
		}
		for _, p := range tempPaths {
			if p != "" {
				_ = os.Remove(p)
			}
		}
	}

	for _, b := range batches {
		turnsFile := filepath.Join(sessDir, warmTurnsFilename(b.segID))
		tf, err := stageAtExactEnd(turnsFile, b.turnsStart, b.turnsBuf.Bytes())
		if err != nil {
			cleanupStaged()
			return nil, 0, 0, err
		}
		if tf != nil {
			stagedFiles = append(stagedFiles, tf)
		}
		if b.diffsBuf.Len() > 0 {
			diffsFile := filepath.Join(sessDir, warmDiffsFilename(b.segID))
			df, err := stageAtExactEnd(diffsFile, b.diffsStart, b.diffsBuf.Bytes())
			if err != nil {
				cleanupStaged()
				return nil, 0, 0, err
			}
			if df != nil {
				stagedFiles = append(stagedFiles, df)
			}
		}
	}

	idxPath := s.turnIndexPath(id)
	idxFile, idxTmpPath, err := stageTurnIndexEntries(sessDir, idxPath, validIdxBytes, addedEntries)
	if err != nil {
		cleanupStaged()
		return nil, 0, 0, err
	}
	if idxFile != nil {
		stagedFiles = append(stagedFiles, idxFile)
	}
	if idxTmpPath != "" {
		tempPaths = append(tempPaths, idxTmpPath)
	}

	var manifestTmpPath string
	if needManifestWrite {
		mCopy := m
		if mCopy.Version == 0 {
			mCopy.Version = manifestFormatVersion
		}
		mRaw, err := json.Marshal(&mCopy)
		if err != nil {
			cleanupStaged()
			return nil, 0, 0, err
		}
		mRaw = append(mRaw, '\n')
		mf, mp, err := stageTempPublish(sessDir, mRaw)
		if err != nil {
			cleanupStaged()
			return nil, 0, 0, err
		}
		stagedFiles = append(stagedFiles, mf)
		tempPaths = append(tempPaths, mp)
		manifestTmpPath = mp
	}

	var metaTmpPath string
	if len(trimmedMeta) > 0 {
		mf, mp, err := stageTempPublish(sessDir, trimmedMeta)
		if err != nil {
			cleanupStaged()
			return nil, 0, 0, err
		}
		stagedFiles = append(stagedFiles, mf)
		tempPaths = append(tempPaths, mp)
		metaTmpPath = mp
	}

	// Single coalesced concurrent fsync across segment data, turn.idx, and staged temp files.
	if err := syncAndCloseFiles(stagedFiles); err != nil {
		for _, p := range tempPaths {
			_ = os.Remove(p)
		}
		s.invalidateSessionCache(id)
		return nil, 0, 0, err
	}
	stagedFiles = nil

	// Publish staged renames sequentially to avoid Windows NTFS directory lock contention.
	var idxErr, manifestErr, metaErr error
	if idxTmpPath != "" {
		idxErr = durable.Rename(idxTmpPath, idxPath)
	}
	if idxErr == nil && manifestTmpPath != "" {
		manifestErr = durable.Rename(manifestTmpPath, s.manifestPath(id))
	}
	if idxErr == nil && manifestErr == nil && metaTmpPath != "" {
		metaErr = durable.Rename(metaTmpPath, s.metaPath(id))
	}
	if manifestErr != nil || idxErr != nil || metaErr != nil {
		for _, p := range tempPaths {
			_ = os.Remove(p)
		}
		s.invalidateSessionCache(id)
		if idxErr != nil {
			return nil, 0, 0, idxErr
		}
		if manifestErr != nil {
			return nil, 0, 0, manifestErr
		}
		return nil, 0, 0, metaErr
	}
	if idxTmpPath != "" || manifestTmpPath != "" || metaTmpPath != "" {
		_ = durable.SyncDir(sessDir)
	}

	newEntries := make([]TurnEntry, len(entries)+len(addedEntries))
	copy(newEntries, entries)
	copy(newEntries[len(entries):], addedEntries)
	newValidBytes := validIdxBytes
	if newValidBytes < turnIndexHeaderBytes {
		newValidBytes = turnIndexHeaderBytes
	}
	newValidBytes += int64(len(addedEntries) * turnIndexEntryBytes)

	if st, stErr := os.Stat(idxPath); stErr == nil {
		s.cacheMu.Lock()
		var prevFrames map[uint32]cachedFrameIdx
		if old := s.stateCache[id]; old != nil {
			prevFrames = old.frameIdx
		}
		if prevFrames == nil {
			prevFrames = make(map[uint32]cachedFrameIdx, 4)
		}
		s.stateCache[id] = &cachedSessionState{
			manifest:      m,
			entries:       newEntries,
			validIdxBytes: newValidBytes,
			idxSize:       st.Size(),
			idxModUnixNs:  st.ModTime().UnixNano(),
			hasIdxFile:    true,
			frameIdx:      prevFrames,
		}
		s.cacheMu.Unlock()
	} else {
		s.invalidateSessionCache(id)
	}

	totalTurns := len(newEntries)
	totalMsgs := 0
	if totalTurns > 0 {
		totalMsgs = newEntries[totalTurns-1].LastMsgIdx + 1
	}
	return addedEntries, totalTurns, totalMsgs, nil
}

// SessionStorageStats reports disk and compression metrics for one v2 session.
type SessionStorageStats struct {
	TotalTurns        int     `json:"totalTurns"`
	TotalMessages     int     `json:"totalMessages"`
	WarmSegments      int     `json:"warmSegments"`
	ColdSegments      int     `json:"coldSegments"`
	OnDiskTurnBytes   uint64  `json:"onDiskTurnBytes"`
	UncompressedBytes uint64  `json:"uncompressedBytes"`
	ColdFrameIdxBytes uint64  `json:"coldFrameIdxBytes"`
	TurnIndexBytes    uint64  `json:"turnIndexBytes"`
	CompressionRatio  float64 `json:"compressionRatio"`
}

// SessionStats computes storage and compression statistics for session id.
func (s *Store) SessionStats(id string) (SessionStorageStats, error) {
	if !ValidSessionID(id) {
		return SessionStorageStats{}, ErrInvalidSessionID
	}
	if err := s.ensureV2ForRead(context.Background(), id); err != nil {
		return SessionStorageStats{}, err
	}
	mu := s.sessionLock(id)
	mu.RLock()
	defer mu.RUnlock()

	m, entries, _, err := s.loadStateLocked(id)
	if err != nil {
		return SessionStorageStats{}, err
	}
	sessDir := s.sessionDir(id)
	var st SessionStorageStats
	st.TotalTurns = len(entries)
	if len(entries) > 0 {
		st.TotalMessages = entries[len(entries)-1].LastMsgIdx + 1
	}
	if fi, err := os.Stat(s.turnIndexPath(id)); err == nil {
		st.TurnIndexBytes = uint64(fi.Size())
	}
	for _, seg := range m.Segments {
		if seg.Tier == TierCold {
			st.ColdSegments++
			if fi, err := os.Stat(filepath.Join(sessDir, coldFrameIndexFilename(seg.ID))); err == nil {
				st.ColdFrameIdxBytes += uint64(fi.Size())
			}
		} else {
			st.WarmSegments++
		}
		st.OnDiskTurnBytes += seg.TurnsBytes + seg.DiffsBytes
		st.UncompBytesAdd(seg.UncompBytes)
	}
	if st.OnDiskTurnBytes > 0 && st.UncompressedBytes > 0 {
		st.CompressionRatio = float64(st.UncompressedBytes) / float64(st.OnDiskTurnBytes)
	}
	return st, nil
}

func (st *SessionStorageStats) UncompBytesAdd(n uint64) {
	st.UncompressedBytes += n
}

// segmentReader caches file handles, Cold .fidx tables, and the last decoded
// 64 KiB Zstd frame for the lifetime of a single query call, closing all files
// promptly when Close() runs.
type segmentReader struct {
	store     *Store
	sessionID string
	sessDir   string

	files         map[string]*os.File
	frameIdx      map[uint32]cachedFrameIdx
	lastTurnKey   decodedFrameKey
	hasLastTurn   bool
	lastTurnFrame []byte
	lastDiffKey   decodedFrameKey
	hasLastDiff   bool
	lastDiffFrame []byte
}

type cachedFrameIdx struct {
	turnFrames []FrameEntry
	diffFrames []FrameEntry
}

type decodedFrameKey struct {
	segID    uint32
	frameIdx uint32
}

func newSegmentReader(store *Store, sessionID, sessDir string) *segmentReader {
	return &segmentReader{
		store:     store,
		sessionID: sessionID,
		sessDir:   sessDir,
		files:     make(map[string]*os.File, 4),
		frameIdx:  make(map[uint32]cachedFrameIdx, 4),
	}
}

func (r *segmentReader) Close() {
	for k, f := range r.files {
		_ = f.Close()
		delete(r.files, k)
	}
	r.lastTurnFrame = nil
	r.lastDiffFrame = nil
}

func (r *segmentReader) openFile(relName string) (*os.File, error) {
	if f, ok := r.files[relName]; ok {
		return f, nil
	}
	f, err := os.Open(filepath.Join(r.sessDir, relName))
	if err != nil {
		return nil, err
	}
	r.files[relName] = f
	return f, nil
}

func (r *segmentReader) getFrameIndex(segID uint32) (cachedFrameIdx, error) {
	if fi, ok := r.frameIdx[segID]; ok {
		return fi, nil
	}
	if r.sessionID != "" {
		if fi, ok := r.store.getCachedColdFrameIdx(r.sessionID, segID); ok {
			r.frameIdx[segID] = fi
			return fi, nil
		}
	}
	tf, df, err := readFrameIndexFile(filepath.Join(r.sessDir, coldFrameIndexFilename(segID)))
	if err != nil {
		return cachedFrameIdx{}, err
	}
	ci := cachedFrameIdx{turnFrames: tf, diffFrames: df}
	r.frameIdx[segID] = ci
	if r.sessionID != "" {
		r.store.putCachedColdFrameIdx(r.sessionID, segID, ci)
	}
	return ci, nil
}

func (r *segmentReader) decodeColdFrame(segID uint32, isDiff bool, frameIdx uint32, fe FrameEntry) ([]byte, error) {
	key := decodedFrameKey{segID: segID, frameIdx: frameIdx}
	if isDiff {
		if r.hasLastDiff && r.lastDiffKey == key {
			return r.lastDiffFrame, nil
		}
	} else {
		if r.hasLastTurn && r.lastTurnKey == key {
			return r.lastTurnFrame, nil
		}
	}
	var rel string
	if isDiff {
		rel = coldDiffsFilename(segID)
	} else {
		rel = coldTurnsFilename(segID)
	}
	f, err := r.openFile(rel)
	if err != nil {
		return nil, err
	}
	plain, err := preadAndDecompressFrame(f, fe, func() {
		r.store.coldFramesDecoded.Add(1)
	})
	if err != nil {
		return nil, err
	}
	if isDiff {
		r.lastDiffKey = key
		r.hasLastDiff = true
		r.lastDiffFrame = plain
	} else {
		r.lastTurnKey = key
		r.hasLastTurn = true
		r.lastTurnFrame = plain
	}
	return plain, nil
}

func (r *segmentReader) readRawTurn(e TurnEntry) ([]byte, error) {
	if e.Tier == TierWarm {
		if e.Length == 0 {
			return nil, nil
		}
		f, err := r.openFile(warmTurnsFilename(e.SegmentID))
		if err != nil {
			return nil, err
		}
		buf := make([]byte, e.Length)
		if _, err := f.ReadAt(buf, int64(e.Offset)); err != nil {
			return nil, err
		}
		return bytes.TrimRight(buf, "\r\n"), nil
	}
	if e.ByteLen == 0 {
		return nil, nil
	}
	fi, err := r.getFrameIndex(e.SegmentID)
	if err != nil {
		return nil, err
	}
	if int(e.FrameIdx) >= len(fi.turnFrames) {
		return nil, fmt.Errorf("%w: turn frame %d >= %d", ErrCorruptFrameIndex, e.FrameIdx, len(fi.turnFrames))
	}
	frame, err := r.decodeColdFrame(e.SegmentID, false, e.FrameIdx, fi.turnFrames[e.FrameIdx])
	if err != nil {
		return nil, err
	}
	return sliceFrameRecord(frame, e.IntraFrameOffset, e.ByteLen)
}

func (r *segmentReader) readRawDiff(e TurnEntry) ([]byte, error) {
	if e.Tier == TierWarm {
		if e.DiffLength == 0 {
			return nil, nil
		}
		f, err := r.openFile(warmDiffsFilename(e.SegmentID))
		if err != nil {
			return nil, err
		}
		buf := make([]byte, e.DiffLength)
		if _, err := f.ReadAt(buf, int64(e.DiffOffset)); err != nil {
			return nil, err
		}
		return bytes.TrimRight(buf, "\r\n"), nil
	}
	if e.DiffByteLen == 0 {
		return nil, nil
	}
	fi, err := r.getFrameIndex(e.SegmentID)
	if err != nil {
		return nil, err
	}
	if int(e.DiffFrameIdx) >= len(fi.diffFrames) {
		return nil, fmt.Errorf("%w: diff frame %d >= %d", ErrCorruptFrameIndex, e.DiffFrameIdx, len(fi.diffFrames))
	}
	frame, err := r.decodeColdFrame(e.SegmentID, true, e.DiffFrameIdx, fi.diffFrames[e.DiffFrameIdx])
	if err != nil {
		return nil, err
	}
	return sliceFrameRecord(frame, e.DiffIntraOffset, e.DiffByteLen)
}

func (r *segmentReader) readTurn(e TurnEntry) ([]provider.Message, *filetrack.TurnChanges, error) {
	rawTurn, err := r.readRawTurn(e)
	if err != nil {
		return nil, nil, err
	}
	_, msgs, err := unmarshalTurnPayload(rawTurn)
	if err != nil {
		return nil, nil, err
	}
	rawDiff, err := r.readRawDiff(e)
	if err != nil {
		return nil, nil, err
	}
	var bal *filetrack.TurnChanges
	if len(rawDiff) > 0 {
		var tc filetrack.TurnChanges
		if err := json.Unmarshal(rawDiff, &tc); err != nil {
			return nil, nil, err
		}
		bal = &tc
	}
	return msgs, bal, nil
}
