package searchindex

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"indirect/indirect-code-daemon/internal/durable"
)

const manifestFileName = "MANIFEST.json"
const manifestVersion = 1

var ErrClosed = errors.New("searchindex: engine is closed")

type manifestSegment struct {
	Seq      uint64 `json:"seq"`
	DocCount uint32 `json:"docCount"`
	Tier     int    `json:"tier"`
}

type manifestSession struct {
	Title        string `json:"title"`
	CWD          string `json:"cwd"`
	UpdatedAt    int64  `json:"updatedAt"`
	MaxTurnIndex int    `json:"maxTurnIndex"`
}

type manifestFile struct {
	Version    int                        `json:"version"`
	NextSegSeq uint64                     `json:"nextSegSeq"`
	Segments   []manifestSegment          `json:"segments"`
	Sessions   map[string]manifestSession `json:"sessions"`
}

type sessionCatalogEntry struct {
	sessionID    string
	title        string
	cwd          string
	updatedAt    int64
	maxTurnIndex int // -1 when 0 turns are indexed, >= 0 otherwise
	titleTF      map[string]uint32
	titleNorm    uint8
	titleLen     int
}

// Engine is a concurrency-safe incremental LSM-BM25F full-text search index.
type Engine struct {
	dir  string
	opts Options

	// Lock order when both are needed: flushMu BEFORE mu.
	flushMu sync.Mutex
	mu      sync.RWMutex

	closed     bool
	nextSegSeq uint64
	mem        *memTable
	flushing   *memTable
	segments   []*diskSegment

	catalog         map[string]*sessionCatalogEntry
	titlePostings   map[string]map[string]uint32 // term -> sessionID -> tf
	sumTitleTokens  int64
	titledSessions  int
	titleTermsMu    sync.Mutex
	titleTermsDirty bool
	sortedTitleTerm []string
}

// Index is a type alias for Engine for ergonomic naming in callers.
type Index = Engine

// Open opens or initializes an LSM-BM25F search index rooted at dir.
func Open(dir string, opts ...Options) (*Engine, error) {
	normOpts := normalizeOptions(opts)
	if normOpts.DictBlockMaxBytes > 32768 {
		normOpts.DictBlockMaxBytes = 32768
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}

	e := &Engine{
		dir:           dir,
		opts:          normOpts,
		nextSegSeq:    1,
		mem:           newMemTable(),
		catalog:       make(map[string]*sessionCatalogEntry, 128),
		titlePostings: make(map[string]map[string]uint32, 256),
	}

	mPath := filepath.Join(dir, manifestFileName)
	if raw, err := os.ReadFile(mPath); err == nil {
		var mf manifestFile
		if err := json.Unmarshal(raw, &mf); err != nil {
			return nil, err
		}
		if mf.NextSegSeq >= 1 {
			e.nextSegSeq = mf.NextSegSeq
		}
		for sid, sm := range mf.Sessions {
			e.upsertCatalogLocked(sid, sm.Title, sm.CWD, sm.UpdatedAt, false, sm.MaxTurnIndex, true)
		}
		validSeqs := make(map[uint64]bool, len(mf.Segments))
		for _, ms := range mf.Segments {
			seg, err := openDiskSegment(dir, ms.Seq)
			if err != nil {
				for _, opened := range e.segments {
					opened.decRef()
				}
				return nil, err
			}
			seg.tier = ms.Tier
			e.segments = append(e.segments, seg)
			validSeqs[ms.Seq] = true
			if ms.Seq >= e.nextSegSeq {
				e.nextSegSeq = ms.Seq + 1
			}
		}
		e.reconcileSegmentDuplicatesLocked()
		cleanOrphanSegmentFiles(dir, validSeqs)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	} else {
		cleanOrphanSegmentFiles(dir, nil)
	}

	return e, nil
}

// reconcileSegmentDuplicatesLocked ensures that if an unclean shutdown left the
// same (sessionID, turnIndex) live in two segments, the newer segment wins.
func (e *Engine) reconcileSegmentDuplicatesLocked() {
	if len(e.segments) <= 1 {
		return
	}
	seen := make(map[string]map[int32]bool)
	for i := len(e.segments) - 1; i >= 0; i-- {
		seg := e.segments[i]
		for _, sp := range seg.sessions {
			sm := seen[sp.sessionID]
			if sm == nil {
				sm = make(map[int32]bool, int(sp.endDoc-sp.startDoc))
				seen[sp.sessionID] = sm
			}
			for docID := sp.startDoc; docID < sp.endDoc; docID++ {
				if seg.isDeleted(docID) {
					continue
				}
				t := seg.docTurns[docID]
				if sm[t] {
					seg.markDocDeleted(docID)
				} else {
					sm[t] = true
				}
			}
		}
	}
}

func cleanOrphanSegmentFiles(dir string, validSeqs map[uint64]bool) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	keepPrefixes := make(map[string]bool, len(validSeqs))
	for seq := range validSeqs {
		keepPrefixes[segmentBaseName(seq)] = true
	}
	for _, ent := range entries {
		if ent.IsDir() {
			continue
		}
		name := ent.Name()
		if strings.HasPrefix(name, ".publish-") || strings.HasSuffix(name, ".tmp") {
			_ = os.Remove(filepath.Join(dir, name))
			continue
		}
		if strings.HasPrefix(name, "seg-") {
			dot := strings.IndexByte(name, '.')
			if dot > 0 {
				stem := name[:dot]
				if !keepPrefixes[stem] {
					_ = os.Remove(filepath.Join(dir, name))
				}
			}
		}
	}
}

// Close flushes any buffered MemTable state and tombstones to disk, commits
// MANIFEST.json, and closes all open segment file handles.
func (e *Engine) Close() error {
	e.flushMu.Lock()
	defer e.flushMu.Unlock()

	if err := e.flushLocked(); err != nil {
		return err
	}

	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return nil
	}
	manifestBytes, mErr := e.marshalManifestLocked()
	e.closed = true
	segs := e.segments
	e.segments = nil
	e.mu.Unlock()

	var firstErr error
	for _, seg := range segs {
		if err := seg.persistTombstonesIfDirty(); err != nil && firstErr == nil {
			firstErr = err
		}
		seg.decRef()
	}
	if mErr == nil {
		if err := durable.Write(filepath.Join(e.dir, manifestFileName), manifestBytes); err != nil && firstErr == nil {
			firstErr = err
		}
	} else if firstErr == nil {
		firstErr = mErr
	}
	return firstErr
}

// HasSession reports whether sessionID exists in the index catalog along with
// the highest indexed TurnIndex (-1 if registered with 0 turns).
func (e *Engine) HasSession(sessionID string) (indexedTurnMax int, ok bool) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	ent, exists := e.catalog[sessionID]
	if !exists {
		return 0, false
	}
	return ent.maxTurnIndex, true
}

// Stats returns a point-in-time snapshot of index counts and RAM usage.
func (e *Engine) Stats() Stats {
	e.mu.RLock()
	defer e.mu.RUnlock()

	var st Stats
	st.Sessions = len(e.catalog)
	if e.mem != nil {
		st.MemTurns = e.mem.liveCount
		st.MemBytes = e.mem.approxBytes
		st.LiveDocs += e.mem.liveCount
		st.EstimatedRAM += int64(e.mem.approxBytes)
	}
	if e.flushing != nil {
		st.MemTurns += e.flushing.liveCount
		st.MemBytes += e.flushing.approxBytes
		st.LiveDocs += e.flushing.liveCount
		st.EstimatedRAM += int64(e.flushing.approxBytes)
	}
	st.SegmentCount = len(e.segments)
	for _, seg := range e.segments {
		st.SegmentDocs += int(seg.docCount)
		live := int(seg.liveCount.Load())
		if live < 0 {
			live = 0
		}
		st.LiveDocs += live
		st.TombstoneDocs += seg.tombstoneCount()
		st.DictLeaders += len(seg.leaders)
		st.DictLeadersRAM += len(seg.leaderBytes) + len(seg.leaders)*16
		st.EstimatedRAM += seg.estimatedRAMBytes()
	}
	// Catalog RAM estimate.
	st.EstimatedRAM += int64(len(e.catalog)) * 256
	return st
}

// ---------------------------------------------------------------------------
// Mutations: IndexTurn, IndexSessionTurns, UpdateSessionMeta, Truncate, Delete
// ---------------------------------------------------------------------------

// IndexTurn indexes or idempotently replaces (doc.SessionID, doc.TurnIndex).
func (e *Engine) IndexTurn(doc TurnDoc) error {
	if doc.SessionID == "" {
		return nil
	}

	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return ErrClosed
	}
	e.indexTurnLocked(doc)
	needFlush := e.mem.shouldFlush(e.opts)
	e.mu.Unlock()

	if needFlush {
		return e.Flush()
	}
	return nil
}

// IndexSessionTurns updates session metadata and indexes a batch of turns.
func (e *Engine) IndexSessionTurns(sessionID string, meta SessionMeta, turns []TurnDoc) error {
	if sessionID == "" {
		return nil
	}

	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return ErrClosed
	}
	effectiveTitle := meta.Title
	if effectiveTitle == "" {
		if existing, ok := e.catalog[sessionID]; ok {
			effectiveTitle = existing.title
		}
	}
	e.upsertCatalogLocked(sessionID, effectiveTitle, meta.CWD, meta.UpdatedAt, true, -1, false)
	for i := range turns {
		t := turns[i]
		if t.SessionID == "" {
			t.SessionID = sessionID
		}
		if t.UpdatedAtUnix == 0 && meta.UpdatedAt > 0 {
			t.UpdatedAtUnix = meta.UpdatedAt
		}
		e.indexTurnLocked(t)
	}
	needFlush := e.mem.shouldFlush(e.opts)
	e.mu.Unlock()

	if needFlush {
		return e.Flush()
	}
	return nil
}

func (e *Engine) indexTurnLocked(doc TurnDoc) {
	ent, existed := e.catalog[doc.SessionID]
	prevMaxTurn := -1
	if existed {
		prevMaxTurn = ent.maxTurnIndex
	}

	// Fast path: when TurnIndex > prevMaxTurn, no older segment or flushing
	// memtable can possibly hold (doc.SessionID, doc.TurnIndex).
	if existed && doc.TurnIndex <= prevMaxTurn {
		if e.flushing != nil {
			e.flushing.deleteTurn(doc.SessionID, doc.TurnIndex)
		}
		for _, seg := range e.segments {
			seg.deleteTurn(doc.SessionID, doc.TurnIndex)
		}
	}

	e.mem.upsert(doc)

	if !existed {
		e.upsertCatalogLocked(doc.SessionID, "", "", doc.UpdatedAtUnix, false, doc.TurnIndex, true)
	} else {
		if doc.TurnIndex > ent.maxTurnIndex {
			ent.maxTurnIndex = doc.TurnIndex
		}
		if doc.UpdatedAtUnix > ent.updatedAt {
			ent.updatedAt = doc.UpdatedAtUnix
		}
	}
}

// UpdateSessionMeta updates session title, CWD, and updatedAt in O(1) without
// re-indexing any turn segments, and persists the updated catalog.
func (e *Engine) UpdateSessionMeta(sessionID, title, cwd string, updatedAt int64) error {
	if sessionID == "" {
		return nil
	}
	e.flushMu.Lock()
	defer e.flushMu.Unlock()

	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return ErrClosed
	}
	e.upsertCatalogLocked(sessionID, title, cwd, updatedAt, true, -1, false)
	manifestBytes, err := e.marshalManifestLocked()
	e.mu.Unlock()
	if err != nil {
		return err
	}
	return durable.Write(filepath.Join(e.dir, manifestFileName), manifestBytes)
}

func (e *Engine) upsertCatalogLocked(
	sessionID, title, cwd string,
	updatedAt int64,
	overwriteMeta bool,
	turnIndex int,
	forceMaxTurn bool,
) {
	ent, ok := e.catalog[sessionID]
	if !ok {
		initMax := -1
		if turnIndex >= 0 || forceMaxTurn {
			initMax = turnIndex
		}
		ent = &sessionCatalogEntry{
			sessionID:    sessionID,
			cwd:          cwd,
			updatedAt:    updatedAt,
			maxTurnIndex: initMax,
		}
		e.catalog[sessionID] = ent
		e.updateTitleIndexLocked(ent, title)
		return
	}

	if overwriteMeta {
		if cwd != "" || ent.cwd == "" {
			ent.cwd = cwd
		}
		if updatedAt > 0 {
			ent.updatedAt = updatedAt
		}
		if ent.title != title {
			e.updateTitleIndexLocked(ent, title)
		}
	} else if updatedAt > ent.updatedAt {
		ent.updatedAt = updatedAt
	}

	if forceMaxTurn {
		ent.maxTurnIndex = turnIndex
	} else if turnIndex > ent.maxTurnIndex {
		ent.maxTurnIndex = turnIndex
	}
}

func (e *Engine) updateTitleIndexLocked(ent *sessionCatalogEntry, newTitle string) {
	if ent.title == newTitle && ent.titleTF != nil {
		return
	}
	// Remove old title tokens.
	if len(ent.titleTF) > 0 {
		for tok := range ent.titleTF {
			if sm, ok := e.titlePostings[tok]; ok {
				delete(sm, ent.sessionID)
				if len(sm) == 0 {
					delete(e.titlePostings, tok)
				}
			}
		}
		e.sumTitleTokens -= int64(ent.titleLen)
		if e.sumTitleTokens < 0 {
			e.sumTitleTokens = 0
		}
		e.titledSessions--
		if e.titledSessions < 0 {
			e.titledSessions = 0
		}
	}

	ent.title = newTitle
	tf, tLen := TokenizeField(newTitle, 0)
	ent.titleTF = tf
	ent.titleLen = tLen
	ent.titleNorm = encodeNorm(tLen)

	if len(tf) > 0 {
		for tok, count := range tf {
			sm := e.titlePostings[tok]
			if sm == nil {
				sm = make(map[string]uint32, 4)
				e.titlePostings[tok] = sm
			}
			sm[ent.sessionID] = count
		}
		e.sumTitleTokens += int64(tLen)
		e.titledSessions++
	}

	e.titleTermsMu.Lock()
	e.titleTermsDirty = true
	e.titleTermsMu.Unlock()
}

func (e *Engine) removeSessionFromCatalogLocked(sessionID string) {
	ent, ok := e.catalog[sessionID]
	if !ok {
		return
	}
	e.updateTitleIndexLocked(ent, "")
	delete(e.catalog, sessionID)
}

func (e *Engine) collectTitlePrefixTerms(prefix string, outDF map[string]uint32, limit int) {
	e.titleTermsMu.Lock()
	if e.titleTermsDirty || e.sortedTitleTerm == nil {
		terms := make([]string, 0, len(e.titlePostings))
		for k := range e.titlePostings {
			terms = append(terms, k)
		}
		slices.Sort(terms)
		e.sortedTitleTerm = terms
		e.titleTermsDirty = false
	}
	terms := e.sortedTitleTerm
	e.titleTermsMu.Unlock()

	idx, _ := slices.BinarySearch(terms, prefix)
	scanned := 0
	for i := idx; i < len(terms); i++ {
		t := terms[i]
		if !strings.HasPrefix(t, prefix) {
			break
		}
		if t == prefix {
			continue
		}
		if sm := e.titlePostings[t]; len(sm) > 0 {
			outDF[t] += uint32(len(sm))
			scanned++
			if scanned >= limit {
				break
			}
		}
	}
}

// TruncateSessionFromTurn tombstones all turns of sessionID with TurnIndex >= minTurnIndex
// across MemTable and all disk segments, updating HasSession's maxTurnIndex.
func (e *Engine) TruncateSessionFromTurn(sessionID string, minTurnIndex int) error {
	if sessionID == "" {
		return nil
	}
	e.flushMu.Lock()
	defer e.flushMu.Unlock()

	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return ErrClosed
	}

	maxRem := -1
	if rem, ok := e.mem.truncateFromTurn(sessionID, minTurnIndex); ok && rem > maxRem {
		maxRem = rem
	}
	if e.flushing != nil {
		if rem, ok := e.flushing.truncateFromTurn(sessionID, minTurnIndex); ok && rem > maxRem {
			maxRem = rem
		}
	}
	segs := make([]*diskSegment, 0, len(e.segments))
	for _, seg := range e.segments {
		if rem, ok := seg.truncateSessionFromTurn(sessionID, minTurnIndex); ok && rem > maxRem {
			maxRem = rem
		}
		if seg.incRef() {
			segs = append(segs, seg)
		}
	}
	if ent, exists := e.catalog[sessionID]; exists {
		ent.maxTurnIndex = maxRem
	}
	manifestBytes, mErr := e.marshalManifestLocked()
	e.mu.Unlock()

	defer func() {
		for _, seg := range segs {
			seg.decRef()
		}
	}()

	for _, seg := range segs {
		if err := seg.persistTombstonesIfDirty(); err != nil {
			return err
		}
	}
	if mErr != nil {
		return mErr
	}
	return durable.Write(filepath.Join(e.dir, manifestFileName), manifestBytes)
}

// DeleteSession immediately tombstones all turns of sessionID across MemTable
// and all disk segments and removes sessionID from the live catalog.
func (e *Engine) DeleteSession(sessionID string) error {
	if sessionID == "" {
		return nil
	}
	e.flushMu.Lock()
	defer e.flushMu.Unlock()

	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return ErrClosed
	}
	e.mem.deleteSession(sessionID)
	if e.flushing != nil {
		e.flushing.deleteSession(sessionID)
	}
	segs := make([]*diskSegment, 0, len(e.segments))
	for _, seg := range e.segments {
		seg.deleteSession(sessionID)
		if seg.incRef() {
			segs = append(segs, seg)
		}
	}
	e.removeSessionFromCatalogLocked(sessionID)
	manifestBytes, mErr := e.marshalManifestLocked()
	e.mu.Unlock()

	defer func() {
		for _, seg := range segs {
			seg.decRef()
		}
	}()

	for _, seg := range segs {
		if err := seg.persistTombstonesIfDirty(); err != nil {
			return err
		}
	}
	if mErr != nil {
		return mErr
	}
	return durable.Write(filepath.Join(e.dir, manifestFileName), manifestBytes)
}

// ---------------------------------------------------------------------------
// Flushing & Tiered Streaming Compaction
// ---------------------------------------------------------------------------

// Flush writes any buffered MemTable turns into a new immutable disk segment,
// persists dirty segment tombstones, and atomically updates MANIFEST.json.
func (e *Engine) Flush() error {
	e.flushMu.Lock()
	defer e.flushMu.Unlock()
	if err := e.flushLocked(); err != nil {
		return err
	}
	// Keep total segments bounded automatically after flushes.
	if e.segmentCount() > e.opts.MaxSegments {
		return e.compactTiersLocked(context.Background(), false)
	}
	return nil
}

func (e *Engine) segmentCount() int {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return len(e.segments)
}

func (e *Engine) flushLocked() error {
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return ErrClosed
	}
	if e.mem.liveCount == 0 {
		// Still persist any dirty tombstones + manifest if segments exist.
		e.mem = newMemTable()
		segs := make([]*diskSegment, 0, len(e.segments))
		for _, seg := range e.segments {
			if seg.incRef() {
				segs = append(segs, seg)
			}
		}
		manifestBytes, mErr := e.marshalManifestLocked()
		e.mu.Unlock()
		defer func() {
			for _, seg := range segs {
				seg.decRef()
			}
		}()
		for _, seg := range segs {
			if err := seg.persistTombstonesIfDirty(); err != nil {
				return err
			}
		}
		if mErr != nil {
			return mErr
		}
		if len(manifestBytes) > 0 {
			return durable.Write(filepath.Join(e.dir, manifestFileName), manifestBytes)
		}
		return nil
	}

	seq := e.nextSegSeq
	e.nextSegSeq++
	e.flushing = e.mem
	e.mem = newMemTable()
	flushingRef := e.flushing
	opts := e.opts
	e.mu.Unlock()

	newSeg, err := writeMemTableSegment(e.dir, seq, flushingRef, opts)
	if err != nil {
		// Restore flushing table on error so no turns are lost.
		e.mu.Lock()
		if e.mem.liveCount == 0 {
			e.mem = e.flushing
		}
		e.flushing = nil
		e.mu.Unlock()
		return err
	}

	e.mu.Lock()
	// Carry over any deletes/truncates that arrived on e.flushing while writing to disk!
	if newSeg != nil {
		for i := range flushingRef.docs {
			d := &flushingRef.docs[i]
			if d.deleted {
				newSeg.deleteTurn(d.sessionID, int(d.turnIndex))
			}
		}
		newSeg.tier = tierForDocCount(int(newSeg.docCount))
		e.segments = append(e.segments, newSeg)
	}
	e.flushing = nil

	segs := make([]*diskSegment, 0, len(e.segments))
	for _, seg := range e.segments {
		if seg.incRef() {
			segs = append(segs, seg)
		}
	}
	manifestBytes, mErr := e.marshalManifestLocked()
	e.mu.Unlock()

	defer func() {
		for _, seg := range segs {
			seg.decRef()
		}
	}()

	for _, seg := range segs {
		if err := seg.persistTombstonesIfDirty(); err != nil {
			return err
		}
	}
	if mErr != nil {
		return mErr
	}
	return durable.Write(filepath.Join(e.dir, manifestFileName), manifestBytes)
}

func tierForDocCount(docs int) int {
	switch {
	case docs <= 2500:
		return 0
	case docs <= 10000:
		return 1
	case docs <= 40000:
		return 2
	default:
		return 3
	}
}

// Compact merges small segments (<= 4 per tier) into larger sorted segments,
// keeps total segment count <= 12, and physically strips tombstoned docs.
func (e *Engine) Compact(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	e.flushMu.Lock()
	defer e.flushMu.Unlock()

	// If MemTable holds pending turns/deletes, flush them first so compaction
	// produces clean on-disk segments with zero lingering tombstones.
	e.mu.RLock()
	closed := e.closed
	hasMem := len(e.mem.docs) > 0
	e.mu.RUnlock()
	if closed {
		return ErrClosed
	}
	if hasMem {
		if err := e.flushLocked(); err != nil {
			return err
		}
	}
	return e.compactTiersLocked(ctx, true)
}

func (e *Engine) compactTiersLocked(ctx context.Context, stripAllTombstones bool) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}

		e.mu.Lock()
		if e.closed {
			e.mu.Unlock()
			return ErrClosed
		}
		batchIdx := e.pickCompactionBatchLocked(stripAllTombstones)
		if len(batchIdx) == 0 {
			e.mu.Unlock()
			return nil
		}
		inputs := make([]*diskSegment, len(batchIdx))
		for i, idx := range batchIdx {
			seg := e.segments[idx]
			if !seg.incRef() {
				for k := 0; k < i; k++ {
					inputs[k].decRef()
				}
				e.mu.Unlock()
				return nil
			}
			inputs[i] = seg
		}
		newSeq := e.nextSegSeq
		e.nextSegSeq++
		opts := e.opts
		e.mu.Unlock()

		mergedSeg, remaps, err := mergeDiskSegments(ctx, e.dir, newSeq, inputs, opts)
		for _, inSeg := range inputs {
			inSeg.decRef()
		}
		if err != nil {
			return err
		}

		// Atomically splice inputs -> mergedSeg (or remove if 0 surviving docs).
		e.mu.Lock()
		if e.closed {
			e.mu.Unlock()
			if mergedSeg != nil {
				mergedSeg.markObsoleteAndRelease()
			}
			return ErrClosed
		}

		// Verify all input segments are still present in e.segments.
		inputSet := make(map[uint64]int, len(inputs))
		for i, inSeg := range inputs {
			inputSet[inSeg.seq] = i
		}
		if mergedSeg != nil {
			// Carry over any concurrent tombstones applied to inputs while merging.
			for i, inSeg := range inputs {
				rm := remaps[i]
				for oldDoc := uint32(0); oldDoc < inSeg.docCount; oldDoc++ {
					newDoc := rm[oldDoc]
					if newDoc >= 0 && inSeg.isDeleted(oldDoc) {
						mergedSeg.markDocDeleted(uint32(newDoc))
					}
				}
			}
			mergedSeg.tier = tierForDocCount(int(mergedSeg.liveCount.Load()))
		}

		newList := make([]*diskSegment, 0, len(e.segments)-len(inputs)+1)
		inserted := false
		var retired []*diskSegment
		for _, seg := range e.segments {
			if _, inBatch := inputSet[seg.seq]; inBatch {
				if !inserted {
					if mergedSeg != nil && mergedSeg.liveCount.Load() > 0 {
						newList = append(newList, mergedSeg)
					} else if mergedSeg != nil {
						mergedSeg.markObsoleteAndRelease()
						mergedSeg = nil
					}
					inserted = true
				}
				retired = append(retired, seg)
				continue
			}
			newList = append(newList, seg)
		}
		e.segments = newList
		manifestBytes, mErr := e.marshalManifestLocked()
		e.mu.Unlock()

		if mergedSeg != nil {
			if err := mergedSeg.persistTombstonesIfDirty(); err != nil {
				return err
			}
		}
		if mErr != nil {
			return mErr
		}
		if err := durable.Write(filepath.Join(e.dir, manifestFileName), manifestBytes); err != nil {
			return err
		}
		for _, oldSeg := range retired {
			oldSeg.markObsoleteAndRelease()
		}
	}
}

// pickCompactionBatchLocked selects a contiguous slice of segment indices to merge:
//  1. Any segment with 0 live docs (immediate cleanup).
//  2. Any tier with >= TierMergeWidth (4) contiguous/same-tier segments (up to 4).
//  3. Total segments > MaxSegments (12): merge smallest-sum adjacent group of up to 4.
//  4. When stripAllTombstones is true: any segment with tombstones (merging with up to 3 small neighbors).
func (e *Engine) pickCompactionBatchLocked(stripAllTombstones bool) []int {
	n := len(e.segments)
	if n == 0 {
		return nil
	}
	w := e.opts.TierMergeWidth
	if w < 2 {
		w = 4
	}

	// 1. Completely dead segment(s).
	for i, seg := range e.segments {
		if seg.liveCount.Load() <= 0 {
			end := i + 1
			for end < n && end-i < w && e.segments[end].liveCount.Load() <= 0 {
				end++
			}
			return makeRangeSlice(i, end)
		}
	}

	// 2. Contiguous runs in the same tier of length >= w.
	for tier := 0; tier <= 3; tier++ {
		runStart := -1
		for i := 0; i < n; i++ {
			t := tierForDocCount(int(e.segments[i].liveCount.Load()))
			if t == tier {
				if runStart < 0 {
					runStart = i
				}
				if i-runStart+1 >= w {
					return makeRangeSlice(runStart, runStart+w)
				}
			} else {
				runStart = -1
			}
		}
	}

	// 3. Enforce total segment cap <= MaxSegments (12) by merging smallest adjacent group.
	if n > e.opts.MaxSegments {
		groupLen := n - e.opts.MaxSegments + 1
		if groupLen < 2 {
			groupLen = 2
		}
		if groupLen > w {
			groupLen = w
		}
		bestStart := 0
		bestSum := int64(1)<<62 - 1
		for i := 0; i+groupLen <= n; i++ {
			var sum int64
			for k := i; k < i+groupLen; k++ {
				sum += int64(e.segments[k].liveCount.Load())
			}
			if sum < bestSum {
				bestSum = sum
				bestStart = i
			}
		}
		return makeRangeSlice(bestStart, bestStart+groupLen)
	}

	// 4. Explicit tombstone reclamation (or >25% dead docs during background compaction).
	for i, seg := range e.segments {
		tombs := seg.tombstoneCount()
		if tombs == 0 {
			continue
		}
		if !stripAllTombstones && tombs*4 < int(seg.docCount) {
			continue
		}
		// Include up to w-1 adjacent segments that also have tombstones or are small.
		end := i + 1
		for end < n && end-i < w {
			next := e.segments[end]
			if next.tombstoneCount() > 0 || next.liveCount.Load() <= 2500 {
				end++
			} else {
				break
			}
		}
		return makeRangeSlice(i, end)
	}

	return nil
}

func makeRangeSlice(start, end int) []int {
	out := make([]int, end-start)
	for i := range out {
		out[i] = start + i
	}
	return out
}

// mergeDiskSegments performs a low-RAM K-way streaming merge across inputs
// (ordered oldest-to-newest), copying compressed .sdoc slices directly without
// decompression and dropping all tombstoned documents and dead dictionary terms.
func mergeDiskSegments(
	ctx context.Context,
	dir string,
	newSeq uint64,
	inputs []*diskSegment,
	opts Options,
) (*diskSegment, [][]int32, error) {
	k := len(inputs)
	remaps := make([][]int32, k)
	snapDeleted := make([][]bool, k)
	totalLiveUpper := 0

	for i, seg := range inputs {
		dc := int(seg.docCount)
		rm := make([]int32, dc)
		sd := make([]bool, dc)
		for d := 0; d < dc; d++ {
			rm[d] = -1
			del := seg.isDeleted(uint32(d))
			sd[d] = del
			if !del {
				totalLiveUpper++
			}
		}
		remaps[i] = rm
		snapDeleted[i] = sd
	}

	if totalLiveUpper == 0 {
		return nil, remaps, nil
	}

	// Per-input cursor over (sessionSpanIdx, docID) in sorted (sessionID, turnIndex) order.
	type docCursor struct {
		segIdx  int
		sessIdx int
		docID   uint32
		active  bool
	}
	advanceCursor := func(c *docCursor) {
		seg := inputs[c.segIdx]
		sd := snapDeleted[c.segIdx]
		for c.sessIdx < len(seg.sessions) {
			sp := seg.sessions[c.sessIdx]
			if c.docID < sp.startDoc {
				c.docID = sp.startDoc
			}
			for c.docID < sp.endDoc && sd[c.docID] {
				c.docID++
			}
			if c.docID < sp.endDoc {
				c.active = true
				return
			}
			c.sessIdx++
			if c.sessIdx < len(seg.sessions) {
				c.docID = seg.sessions[c.sessIdx].startDoc
			}
		}
		c.active = false
	}

	cursors := make([]docCursor, k)
	for i := 0; i < k; i++ {
		cursors[i] = docCursor{segIdx: i}
		advanceCursor(&cursors[i])
	}

	sidxPath, sdocPath, _ := segmentPaths(dir, newSeq)
	tmpSdoc := sdocPath + ".tmp"
	tmpSidx := sidxPath + ".tmp"
	cleanup := func() {
		_ = os.Remove(tmpSdoc)
		_ = os.Remove(tmpSidx)
	}

	sdocFile, err := os.OpenFile(tmpSdoc, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		cleanup()
		return nil, nil, err
	}
	sdocBuf := bufio.NewWriterSize(sdocFile, 64<<10)
	if _, err := sdocBuf.WriteString(sdocMagic); err != nil {
		_ = sdocFile.Close()
		cleanup()
		return nil, nil, err
	}
	sdocOff := uint64(len(sdocMagic))

	var docTurns []int32
	var norms []uint8
	var docLocs [][2]uint64
	var sessions []segSessionSpan
	var sumTokens [numTurnFields]uint64
	var copyScratch []byte

	newDocID := uint32(0)
	for {
		if newDocID&255 == 0 {
			if err := ctx.Err(); err != nil {
				_ = sdocFile.Close()
				cleanup()
				return nil, nil, err
			}
		}

		// Pick minimum (sessionID, turnIndex); on exact tie, newest segment (highest segIdx) wins.
		bestCur := -1
		var bestSID string
		var bestTurn int32
		for i := 0; i < k; i++ {
			if !cursors[i].active {
				continue
			}
			seg := inputs[i]
			sid := seg.sessions[cursors[i].sessIdx].sessionID
			turn := seg.docTurns[cursors[i].docID]
			if bestCur < 0 || sid < bestSID || (sid == bestSID && turn < bestTurn) || (sid == bestSID && turn == bestTurn && i > bestCur) {
				bestCur = i
				bestSID = sid
				bestTurn = turn
			}
		}
		if bestCur < 0 {
			break
		}

		winSeg := inputs[bestCur]
		winDoc := cursors[bestCur].docID
		remaps[bestCur][winDoc] = int32(newDocID)

		// Advance winning cursor and skip any older segments carrying the exact same (bestSID, bestTurn).
		for i := 0; i < k; i++ {
			if !cursors[i].active {
				continue
			}
			seg := inputs[i]
			if seg.sessions[cursors[i].sessIdx].sessionID == bestSID && seg.docTurns[cursors[i].docID] == bestTurn {
				cursors[i].docID++
				advanceCursor(&cursors[i])
			}
		}

		// Copy raw already-compressed .sdoc slice directly!
		srcOff, srcLen, err := winSeg.readDocLoc(winDoc)
		if err != nil {
			_ = sdocFile.Close()
			cleanup()
			return nil, nil, err
		}
		if cap(copyScratch) < int(srcLen) {
			copyScratch = make([]byte, srcLen)
		} else {
			copyScratch = copyScratch[:srcLen]
		}
		if _, err := winSeg.docFile.ReadAt(copyScratch, int64(srcOff)); err != nil {
			_ = sdocFile.Close()
			cleanup()
			return nil, nil, err
		}
		if _, err := sdocBuf.Write(copyScratch); err != nil {
			_ = sdocFile.Close()
			cleanup()
			return nil, nil, err
		}
		docLocs = append(docLocs, [2]uint64{sdocOff, uint64(srcLen)})
		sdocOff += uint64(srcLen)

		docTurns = append(docTurns, bestTurn)
		nb := int(winDoc) * numTurnFields
		norms = append(norms, winSeg.norms[nb], winSeg.norms[nb+1], winSeg.norms[nb+2])
		for f := 0; f < numTurnFields; f++ {
			sumTokens[f] += uint64(decodeNorm(winSeg.norms[nb+f]))
		}
		if len(sessions) == 0 || sessions[len(sessions)-1].sessionID != bestSID {
			sessions = append(sessions, segSessionSpan{
				sessionID: bestSID,
				startDoc:  newDocID,
				endDoc:    newDocID + 1,
			})
		} else {
			sessions[len(sessions)-1].endDoc = newDocID + 1
		}
		newDocID++
	}

	if newDocID == 0 {
		_ = sdocFile.Close()
		cleanup()
		return nil, remaps, nil
	}

	if err := sdocBuf.Flush(); err != nil {
		_ = sdocFile.Close()
		cleanup()
		return nil, nil, err
	}
	if err := sdocFile.Sync(); err != nil {
		_ = sdocFile.Close()
		cleanup()
		return nil, nil, err
	}
	if err := sdocFile.Close(); err != nil {
		cleanup()
		return nil, nil, err
	}

	// Phase 2: Streaming K-Way Dictionary & Postings Merge.
	newTier := tierForDocCount(int(newDocID))
	idxWriter, err := newSegmentIndexWriter(tmpSidx, newDocID, sessions, docTurns, norms, docLocs, sumTokens, newTier, opts)
	if err != nil {
		cleanup()
		return nil, nil, err
	}

	iters := make([]*segmentTermIter, k)
	iterActive := make([]bool, k)
	for i := 0; i < k; i++ {
		iters[i] = newSegmentTermIter(inputs[i])
		iterActive[i] = iters[i].next()
		if iters[i].err != nil {
			_ = idxWriter.abort()
			cleanup()
			return nil, nil, iters[i].err
		}
	}

	var postReadBuf []byte
	var decoded []postingEntry
	var merged []postingEntry
	termStep := 0

	for {
		if termStep&255 == 0 {
			if err := ctx.Err(); err != nil {
				_ = idxWriter.abort()
				cleanup()
				return nil, nil, err
			}
		}
		termStep++

		minTerm := ""
		hasMin := false
		for i := 0; i < k; i++ {
			if !iterActive[i] {
				continue
			}
			if !hasMin || iters[i].term < minTerm {
				minTerm = iters[i].term
				hasMin = true
			}
		}
		if !hasMin {
			break
		}

		merged = merged[:0]
		for i := 0; i < k; i++ {
			if !iterActive[i] || iters[i].term != minTerm {
				continue
			}
			ent := iters[i].entry
			if cap(postReadBuf) < int(ent.postingsLen) {
				postReadBuf = make([]byte, ent.postingsLen)
			} else {
				postReadBuf = postReadBuf[:ent.postingsLen]
			}
			if _, err := inputs[i].idxFile.ReadAt(postReadBuf, int64(ent.postingsOff)); err != nil {
				_ = idxWriter.abort()
				cleanup()
				return nil, nil, err
			}
			decoded, err = decodePostingsInto(postReadBuf, decoded[:0])
			if err != nil {
				_ = idxWriter.abort()
				cleanup()
				return nil, nil, err
			}
			rm := remaps[i]
			for _, p := range decoded {
				if int(p.docID) < len(rm) {
					nd := rm[p.docID]
					if nd >= 0 {
						p.docID = uint32(nd)
						merged = append(merged, p)
					}
				}
			}
			iterActive[i] = iters[i].next()
			if iters[i].err != nil {
				_ = idxWriter.abort()
				cleanup()
				return nil, nil, iters[i].err
			}
		}

		if len(merged) > 0 {
			slices.SortFunc(merged, func(a, b postingEntry) int {
				if a.docID < b.docID {
					return -1
				}
				if a.docID > b.docID {
					return 1
				}
				return 0
			})
			// Deduplicate identical docIDs if any.
			dedup := merged[:0]
			for _, p := range merged {
				if len(dedup) > 0 && dedup[len(dedup)-1].docID == p.docID {
					dedup[len(dedup)-1] = p
				} else {
					dedup = append(dedup, p)
				}
			}
			if err := idxWriter.addTerm(minTerm, dedup); err != nil {
				_ = idxWriter.abort()
				cleanup()
				return nil, nil, err
			}
		}
	}

	if err := idxWriter.finish(); err != nil {
		cleanup()
		return nil, nil, err
	}
	if err := durable.Rename(tmpSdoc, sdocPath); err != nil {
		cleanup()
		return nil, nil, err
	}
	if err := durable.Rename(tmpSidx, sidxPath); err != nil {
		cleanup()
		return nil, nil, err
	}
	if err := durable.SyncDir(dir); err != nil {
		return nil, nil, err
	}

	seg, err := openDiskSegment(dir, newSeq)
	return seg, remaps, err
}

func (e *Engine) marshalManifestLocked() ([]byte, error) {
	mf := manifestFile{
		Version:    manifestVersion,
		NextSegSeq: e.nextSegSeq,
		Segments:   make([]manifestSegment, 0, len(e.segments)),
		Sessions:   make(map[string]manifestSession, len(e.catalog)),
	}
	for _, seg := range e.segments {
		mf.Segments = append(mf.Segments, manifestSegment{
			Seq:      seg.seq,
			DocCount: seg.docCount,
			Tier:     seg.tier,
		})
	}
	for sid, ent := range e.catalog {
		mf.Sessions[sid] = manifestSession{
			Title:        ent.title,
			CWD:          ent.cwd,
			UpdatedAt:    ent.updatedAt,
			MaxTurnIndex: ent.maxTurnIndex,
		}
	}
	return json.Marshal(mf)
}
