package searchindex

import (
	"bufio"
	"bytes"
	"compress/flate"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"math/bits"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"

	"indirect/indirect-code-daemon/internal/durable"
)

const (
	sidxMagic      = "ICDSIDX1"
	sdocMagic      = "ICDSDOC1"
	sdelMagic      = "ICDDEL01"
	sidxVersion    = 1
	sidxHeaderSize = 112

	postingsChunkSize = 128
	flagAllTFOne      = 0x10
)

var (
	errCorruptSegment = errors.New("searchindex: corrupt segment file")

	flateWriterPool = sync.Pool{
		New: func() any {
			w, _ := flate.NewWriter(nil, flate.BestSpeed)
			return w
		},
	}
	flateReaderPool = sync.Pool{}

	dictBlockBufPool = sync.Pool{
		New: func() any {
			b := make([]byte, 4096)
			return &b
		},
	}
)

func segmentBaseName(seq uint64) string {
	return fmt.Sprintf("seg-%06d", seq)
}

func segmentPaths(dir string, seq uint64) (sidxPath, sdocPath, sdelPath string) {
	base := filepath.Join(dir, segmentBaseName(seq))
	return base + ".sidx", base + ".sdoc", base + ".del"
}

// dictBlockLeader is a 16-byte pointer-free sparse term index entry kept in RAM
// (one entry per 32 dictionary terms).
type dictBlockLeader struct {
	strOff   uint32
	strLen   uint16
	blockLen uint16 // 0 means 65536; blocks are capped at 4096 bytes unless a single term exceeds it
	fileOff  uint64
}

type segSessionSpan struct {
	sessionID string
	startDoc  uint32
	endDoc    uint32
}

type storedTurnDoc struct {
	firstMsgIdx    int
	bestMsgIdx     int
	userMsgIdx     int
	asstMsgIdx     int
	toolMsgIdx     int
	hasFieldMsgIdx bool
	updatedAt      int64
	userExcerpt    string
	asstExcerpt    string
	toolExcerpt    string
}

func (d *storedTurnDoc) resolveMsgIdx(f Field) int {
	if d.hasFieldMsgIdx {
		switch f {
		case FieldUser:
			if d.userMsgIdx >= 0 {
				return d.userMsgIdx
			}
		case FieldAssistant:
			if d.asstMsgIdx >= 0 {
				return d.asstMsgIdx
			}
		case FieldTool:
			if d.toolMsgIdx >= 0 {
				return d.toolMsgIdx
			}
		}
	}
	if d.bestMsgIdx >= d.firstMsgIdx {
		return d.bestMsgIdx
	}
	return d.firstMsgIdx
}

func (d *storedTurnDoc) excerptForField(f Field) string {
	switch f {
	case FieldUser:
		if d.userExcerpt != "" {
			return d.userExcerpt
		}
	case FieldAssistant:
		if d.asstExcerpt != "" {
			return d.asstExcerpt
		}
	case FieldTool:
		if d.toolExcerpt != "" {
			return d.toolExcerpt
		}
	}
	if d.asstExcerpt != "" {
		return d.asstExcerpt
	}
	if d.userExcerpt != "" {
		return d.userExcerpt
	}
	return d.toolExcerpt
}

// diskSegment is an immutable on-disk inverted index + compressed snippet store
// with an atomic monotonic tombstone bitmap and ref-counted file handles.
type diskSegment struct {
	dir       string
	seq       uint64
	tier      int
	docCount  uint32
	termCount uint32

	idxFile *os.File
	docFile *os.File

	docLocOffset uint64

	// Sparse dictionary index in RAM (pointer-free arena: <500 KB for 500k unique terms).
	leaderBytes []byte
	leaders     []dictBlockLeader
	maxTerm     []byte

	// Per-segment session spans sorted by sessionID, plus O(1) docID->sessionIdx map.
	sessions   []segSessionSpan
	docSessIdx []uint32
	docTurns   []int32
	norms      []uint8 // length = docCount * 3

	// Lock-free monotonic tombstones (0 -> 1 transitions only).
	delWords       []atomic.Uint64
	liveCount      atomic.Int32
	sumFieldTokens [numTurnFields]atomic.Int64
	delDirty       atomic.Bool

	// Reference count: starts at 1 while owned by Engine; Search increments/decrements.
	// When retired by Compact or Close, dropping to 0 closes files (and unlinks if obsolete).
	refs      atomic.Int32
	obsolete  atomic.Bool
	closeOnce sync.Once
}

func (s *diskSegment) incRef() bool {
	for {
		cur := s.refs.Load()
		if cur <= 0 {
			return false
		}
		if s.refs.CompareAndSwap(cur, cur+1) {
			return true
		}
	}
}

func (s *diskSegment) decRef() {
	if s.refs.Add(-1) == 0 {
		s.finalizeClose()
	}
}

func (s *diskSegment) markObsoleteAndRelease() {
	s.obsolete.Store(true)
	s.decRef()
}

func (s *diskSegment) finalizeClose() {
	s.closeOnce.Do(func() {
		if s.idxFile != nil {
			_ = s.idxFile.Close()
		}
		if s.docFile != nil {
			_ = s.docFile.Close()
		}
		if s.obsolete.Load() {
			sidx, sdoc, sdel := segmentPaths(s.dir, s.seq)
			_ = os.Remove(sidx)
			_ = os.Remove(sdoc)
			_ = os.Remove(sdel)
		}
	})
}

func (s *diskSegment) isDeleted(docID uint32) bool {
	if docID >= s.docCount {
		return true
	}
	w := s.delWords[docID>>6].Load()
	return (w & (uint64(1) << (docID & 63))) != 0
}

func (s *diskSegment) markDocDeleted(docID uint32) bool {
	if docID >= s.docCount {
		return false
	}
	wordIdx := docID >> 6
	bit := uint64(1) << (docID & 63)
	for {
		old := s.delWords[wordIdx].Load()
		if old&bit != 0 {
			return false
		}
		if s.delWords[wordIdx].CompareAndSwap(old, old|bit) {
			s.liveCount.Add(-1)
			base := int(docID) * numTurnFields
			for f := 0; f < numTurnFields; f++ {
				approx := int64(decodeNorm(s.norms[base+f]))
				s.sumFieldTokens[f].Add(-approx)
			}
			s.delDirty.Store(true)
			return true
		}
	}
}

func (s *diskSegment) findSessionSpan(sessionID string) (segSessionSpan, bool) {
	idx, ok := slices.BinarySearchFunc(s.sessions, sessionID, func(sp segSessionSpan, target string) int {
		return strings.Compare(sp.sessionID, target)
	})
	if !ok {
		return segSessionSpan{}, false
	}
	return s.sessions[idx], true
}

func (s *diskSegment) deleteTurn(sessionID string, turnIndex int) bool {
	sp, ok := s.findSessionSpan(sessionID)
	if !ok {
		return false
	}
	turns := s.docTurns[sp.startDoc:sp.endDoc]
	rel, found := slices.BinarySearch(turns, int32(turnIndex))
	if !found {
		return false
	}
	return s.markDocDeleted(sp.startDoc + uint32(rel))
}

func (s *diskSegment) truncateSessionFromTurn(sessionID string, minTurnIndex int) (maxRemaining int, hasRemaining bool) {
	maxRemaining = -1
	sp, ok := s.findSessionSpan(sessionID)
	if !ok {
		return -1, false
	}
	turns := s.docTurns[sp.startDoc:sp.endDoc]
	cutRel, _ := slices.BinarySearch(turns, int32(minTurnIndex))
	cutDoc := sp.startDoc + uint32(cutRel)
	for docID := cutDoc; docID < sp.endDoc; docID++ {
		s.markDocDeleted(docID)
	}
	// Walk backward from cutDoc-1 to find highest non-tombstoned turn < minTurnIndex.
	for docID := int(cutDoc) - 1; docID >= int(sp.startDoc); docID-- {
		if !s.isDeleted(uint32(docID)) {
			return int(s.docTurns[docID]), true
		}
	}
	return -1, false
}

func (s *diskSegment) deleteSession(sessionID string) bool {
	sp, ok := s.findSessionSpan(sessionID)
	if !ok {
		return false
	}
	changed := false
	for docID := sp.startDoc; docID < sp.endDoc; docID++ {
		if s.markDocDeleted(docID) {
			changed = true
		}
	}
	return changed
}

func (s *diskSegment) persistTombstonesIfDirty() error {
	if !s.delDirty.CompareAndSwap(true, false) {
		return nil
	}
	_, _, sdelPath := segmentPaths(s.dir, s.seq)
	live := s.liveCount.Load()
	if live < 0 {
		live = 0
	}
	buf := make([]byte, 16+len(s.delWords)*8+4)
	copy(buf[0:8], sdelMagic)
	binary.LittleEndian.PutUint32(buf[8:12], s.docCount)
	binary.LittleEndian.PutUint32(buf[12:16], uint32(live))
	off := 16
	for i := range s.delWords {
		binary.LittleEndian.PutUint64(buf[off:off+8], s.delWords[i].Load())
		off += 8
	}
	crc := crc32.ChecksumIEEE(buf[:off])
	binary.LittleEndian.PutUint32(buf[off:off+4], crc)
	if err := durable.Write(sdelPath, buf); err != nil {
		s.delDirty.Store(true)
		return err
	}
	return nil
}

func (s *diskSegment) tombstoneCount() int {
	live := int(s.liveCount.Load())
	if live < 0 {
		live = 0
	}
	t := int(s.docCount) - live
	if t < 0 {
		return 0
	}
	return t
}

func (s *diskSegment) estimatedRAMBytes() int64 {
	var n int64 = 256
	n += int64(len(s.leaderBytes))
	n += int64(len(s.leaders)) * 16
	n += int64(len(s.maxTerm))
	n += int64(len(s.sessions)) * 32
	n += int64(len(s.docSessIdx)) * 4
	n += int64(len(s.docTurns)) * 4
	n += int64(len(s.norms))
	n += int64(len(s.delWords)) * 8
	return n
}

// ---------------------------------------------------------------------------
// Flushing MemTable -> Immutable Disk Segment
// ---------------------------------------------------------------------------

func writeMemTableSegment(dir string, seq uint64, m *memTable, opts Options) (*diskSegment, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	// Collect live memDocIDs and sort deterministically by (sessionID, turnIndex).
	liveOldIDs := make([]uint32, 0, m.liveCount)
	for i := range m.docs {
		if !m.docs[i].deleted {
			liveOldIDs = append(liveOldIDs, uint32(i))
		}
	}
	if len(liveOldIDs) == 0 {
		return nil, nil
	}

	sort.Slice(liveOldIDs, func(i, j int) bool {
		di := &m.docs[liveOldIDs[i]]
		dj := &m.docs[liveOldIDs[j]]
		if di.sessionID != dj.sessionID {
			return di.sessionID < dj.sessionID
		}
		return di.turnIndex < dj.turnIndex
	})

	remap := make([]int32, len(m.docs))
	for i := range remap {
		remap[i] = -1
	}
	for newID, oldID := range liveOldIDs {
		remap[oldID] = int32(newID)
	}

	docCount := uint32(len(liveOldIDs))
	sidxPath, sdocPath, _ := segmentPaths(dir, seq)
	tmpSdoc := sdocPath + ".tmp"
	tmpSidx := sidxPath + ".tmp"
	cleanup := func() {
		_ = os.Remove(tmpSdoc)
		_ = os.Remove(tmpSidx)
	}

	// 1. Write seg-<seq>.sdoc with compressed per-turn snippet payloads.
	docLocs := make([][2]uint64, docCount) // [offset, compLen]
	sdocFile, err := os.OpenFile(tmpSdoc, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		cleanup()
		return nil, err
	}
	sdocBuf := bufio.NewWriterSize(sdocFile, 64<<10)
	if _, err := sdocBuf.WriteString(sdocMagic); err != nil {
		_ = sdocFile.Close()
		cleanup()
		return nil, err
	}
	sdocOffset := uint64(len(sdocMagic))

	var rawDocBuf bytes.Buffer
	var compDocBuf bytes.Buffer
	fw := flateWriterPool.Get().(*flate.Writer)
	defer flateWriterPool.Put(fw)

	var sumTokens [numTurnFields]uint64
	docTurns := make([]int32, docCount)
	norms := make([]uint8, int(docCount)*numTurnFields)
	var sessions []segSessionSpan

	for newID, oldID := range liveOldIDs {
		md := &m.docs[oldID]
		docTurns[newID] = md.turnIndex
		copy(norms[newID*numTurnFields:(newID+1)*numTurnFields], md.norms[:])
		for f := 0; f < numTurnFields; f++ {
			sumTokens[f] += uint64(md.fieldLens[f])
		}
		if len(sessions) == 0 || sessions[len(sessions)-1].sessionID != md.sessionID {
			sessions = append(sessions, segSessionSpan{
				sessionID: md.sessionID,
				startDoc:  uint32(newID),
				endDoc:    uint32(newID + 1),
			})
		} else {
			sessions[len(sessions)-1].endDoc = uint32(newID + 1)
		}

		encodeStoredTurnDoc(&rawDocBuf, storedTurnDoc{
			firstMsgIdx:    int(md.firstMsgIdx),
			bestMsgIdx:     int(md.bestMsgIdx),
			userMsgIdx:     int(md.userMsgIdx),
			asstMsgIdx:     int(md.asstMsgIdx),
			toolMsgIdx:     int(md.toolMsgIdx),
			hasFieldMsgIdx: md.hasFieldMsgIdx,
			updatedAt:      md.updatedAt,
			userExcerpt:    md.userExcerpt,
			asstExcerpt:    md.asstExcerpt,
			toolExcerpt:    md.toolExcerpt,
		})

		compDocBuf.Reset()
		fw.Reset(&compDocBuf)
		_, _ = fw.Write(rawDocBuf.Bytes())
		_ = fw.Close()

		compBytes := compDocBuf.Bytes()
		if _, err := sdocBuf.Write(compBytes); err != nil {
			_ = sdocFile.Close()
			cleanup()
			return nil, err
		}
		docLocs[newID] = [2]uint64{sdocOffset, uint64(len(compBytes))}
		sdocOffset += uint64(len(compBytes))
	}

	if err := sdocBuf.Flush(); err != nil {
		_ = sdocFile.Close()
		cleanup()
		return nil, err
	}
	if err := sdocFile.Sync(); err != nil {
		_ = sdocFile.Close()
		cleanup()
		return nil, err
	}
	if err := sdocFile.Close(); err != nil {
		cleanup()
		return nil, err
	}

	// 2. Write seg-<seq>.sidx (Postings + 4KiB Front-Coded Dict Blocks + Sparse Index + Sessions + DocArrays + DocLocs).
	sortedTerms := m.getSortedTerms()
	w, err := newSegmentIndexWriter(tmpSidx, docCount, sessions, docTurns, norms, docLocs, sumTokens, 0, opts)
	if err != nil {
		cleanup()
		return nil, err
	}

	var remapped []postingEntry
	for _, term := range sortedTerms {
		rawList := m.postings[term]
		remapped = remapped[:0]
		for _, p := range rawList {
			newDoc := remap[p.docID]
			if newDoc < 0 {
				continue
			}
			remapped = append(remapped, postingEntry{
				docID: uint32(newDoc),
				mask:  p.mask,
				tfU:   uint32(p.tfU),
				tfA:   uint32(p.tfA),
				tfT:   uint32(p.tfT),
			})
		}
		if len(remapped) == 0 {
			continue
		}
		slices.SortFunc(remapped, func(a, b postingEntry) int {
			if a.docID < b.docID {
				return -1
			}
			if a.docID > b.docID {
				return 1
			}
			return 0
		})
		if err := w.addTerm(term, remapped); err != nil {
			_ = w.abort()
			cleanup()
			return nil, err
		}
	}

	if err := w.finish(); err != nil {
		cleanup()
		return nil, err
	}

	if err := durable.Rename(tmpSdoc, sdocPath); err != nil {
		cleanup()
		return nil, err
	}
	if err := durable.Rename(tmpSidx, sidxPath); err != nil {
		cleanup()
		return nil, err
	}
	if err := durable.SyncDir(dir); err != nil {
		return nil, err
	}

	return openDiskSegment(dir, seq)
}

// ---------------------------------------------------------------------------
// Shared Segment Index Writer (Used by Both Flush and Streaming Compaction)
// ---------------------------------------------------------------------------

type postingEntry struct {
	docID uint32
	mask  uint8
	tfU   uint32
	tfA   uint32
	tfT   uint32
}

type pendingDictTerm struct {
	term        string
	df          uint32
	postingsOff uint64
	postingsLen uint32
}

type segmentIndexWriter struct {
	path      string
	f         *os.File
	bw        *bufio.Writer
	pos       uint64
	opts      Options
	docCount  uint32
	tier      int
	sessions  []segSessionSpan
	docTurns  []int32
	norms     []uint8
	docLocs   [][2]uint64
	sumTokens [numTurnFields]uint64
	termCount uint32
	lastTerm  string
	dictTerms []pendingDictTerm
	postBuf   bytes.Buffer
	chunkBuf  bytes.Buffer
}

func newSegmentIndexWriter(
	path string,
	docCount uint32,
	sessions []segSessionSpan,
	docTurns []int32,
	norms []uint8,
	docLocs [][2]uint64,
	sumTokens [numTurnFields]uint64,
	tier int,
	opts Options,
) (*segmentIndexWriter, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, err
	}
	bw := bufio.NewWriterSize(f, 64<<10)
	var placeholder [sidxHeaderSize]byte
	if _, err := bw.Write(placeholder[:]); err != nil {
		_ = f.Close()
		return nil, err
	}
	return &segmentIndexWriter{
		path:      path,
		f:         f,
		bw:        bw,
		pos:       sidxHeaderSize,
		opts:      opts,
		docCount:  docCount,
		tier:      tier,
		sessions:  sessions,
		docTurns:  docTurns,
		norms:     norms,
		docLocs:   docLocs,
		sumTokens: sumTokens,
		dictTerms: make([]pendingDictTerm, 0, 1024),
	}, nil
}

func (w *segmentIndexWriter) abort() error {
	return w.f.Close()
}

func (w *segmentIndexWriter) addTerm(term string, postings []postingEntry) error {
	if len(postings) == 0 {
		return nil
	}
	startOff := w.pos
	w.postBuf.Reset()
	encodePostingsList(&w.postBuf, &w.chunkBuf, postings, w.norms)
	encoded := w.postBuf.Bytes()
	if _, err := w.bw.Write(encoded); err != nil {
		return err
	}
	w.pos += uint64(len(encoded))
	w.dictTerms = append(w.dictTerms, pendingDictTerm{
		term:        term,
		df:          uint32(len(postings)),
		postingsOff: startOff,
		postingsLen: uint32(len(encoded)),
	})
	w.termCount++
	w.lastTerm = term
	return nil
}

func encodePostingsList(out *bytes.Buffer, chunkPayload *bytes.Buffer, postings []postingEntry, norms []uint8) {
	var varBuf [binary.MaxVarintLen64]byte
	var chunkHdr [8]byte

	n := len(postings)
	chunkBaseDoc := uint32(0)

	for start := 0; start < n; start += postingsChunkSize {
		end := start + postingsChunkSize
		if end > n {
			end = n
		}
		chunk := postings[start:end]
		chunkPayload.Reset()

		unionMask := uint8(0)
		maxTF := uint32(0)
		minNormU := uint8(255)
		minNormA := uint8(255)
		minNormT := uint8(255)

		prevDoc := chunkBaseDoc
		for i, p := range chunk {
			var delta uint32
			if i == 0 {
				delta = p.docID - chunkBaseDoc
			} else {
				delta = p.docID - prevDoc - 1
			}
			prevDoc = p.docID

			k := binary.PutUvarint(varBuf[:], uint64(delta))
			chunkPayload.Write(varBuf[:k])

			m := p.mask & ((1 << FieldUser) | (1 << FieldAssistant) | (1 << FieldTool))
			unionMask |= m

			allOnes := true
			normBase := int(p.docID) * numTurnFields
			if m&(1<<FieldUser) != 0 {
				if p.tfU != 1 {
					allOnes = false
				}
				if p.tfU > maxTF {
					maxTF = p.tfU
				}
				if nu := norms[normBase]; nu > 0 && nu < minNormU {
					minNormU = nu
				}
			}
			if m&(1<<FieldAssistant) != 0 {
				if p.tfA != 1 {
					allOnes = false
				}
				if p.tfA > maxTF {
					maxTF = p.tfA
				}
				if na := norms[normBase+1]; na > 0 && na < minNormA {
					minNormA = na
				}
			}
			if m&(1<<FieldTool) != 0 {
				if p.tfT != 1 {
					allOnes = false
				}
				if p.tfT > maxTF {
					maxTF = p.tfT
				}
				if nt := norms[normBase+2]; nt > 0 && nt < minNormT {
					minNormT = nt
				}
			}

			if allOnes {
				chunkPayload.WriteByte(m | flagAllTFOne)
			} else {
				chunkPayload.WriteByte(m)
				if m&(1<<FieldUser) != 0 {
					k = binary.PutUvarint(varBuf[:], uint64(p.tfU))
					chunkPayload.Write(varBuf[:k])
				}
				if m&(1<<FieldAssistant) != 0 {
					k = binary.PutUvarint(varBuf[:], uint64(p.tfA))
					chunkPayload.Write(varBuf[:k])
				}
				if m&(1<<FieldTool) != 0 {
					k = binary.PutUvarint(varBuf[:], uint64(p.tfT))
					chunkPayload.Write(varBuf[:k])
				}
			}
		}

		chunkBaseDoc = prevDoc + 1

		maxTFByte := uint8(255)
		if maxTF < 255 {
			maxTFByte = uint8(maxTF)
		}
		payloadBytes := chunkPayload.Bytes()
		chunkHdr[0] = uint8(len(chunk) - 1)
		binary.LittleEndian.PutUint16(chunkHdr[1:3], uint16(len(payloadBytes)))
		chunkHdr[3] = unionMask
		chunkHdr[4] = maxTFByte
		chunkHdr[5] = minNormU
		chunkHdr[6] = minNormA
		chunkHdr[7] = minNormT

		out.Write(chunkHdr[:])
		out.Write(payloadBytes)
	}
}

func (w *segmentIndexWriter) finish() error {
	postingsOffset := uint64(sidxHeaderSize)
	dictBlocksOffset := w.pos

	type leaderRec struct {
		leader   string
		fileOff  uint64
		blockLen uint32
	}
	var leaders []leaderRec

	// Write front-coded 4 KiB dictionary blocks (<= DictBlockStride terms per block).
	var blockBuf bytes.Buffer
	var entryBuf bytes.Buffer
	var varBuf [binary.MaxVarintLen64]byte

	stride := w.opts.DictBlockStride
	maxBlockBytes := w.opts.DictBlockMaxBytes

	idx := 0
	for idx < len(w.dictTerms) {
		blockStartIdx := idx
		blockLeader := w.dictTerms[idx].term
		basePostOff := w.dictTerms[idx].postingsOff

		blockBuf.Reset()
		var hdr [10]byte // [0..2) count uint16, [2..10) basePostingsOff uint64
		blockBuf.Write(hdr[:])

		countInBlock := 0
		prevTerm := ""
		for idx < len(w.dictTerms) && countInBlock < stride {
			dt := w.dictTerms[idx]
			entryBuf.Reset()
			shared := 0
			if countInBlock > 0 {
				shared = commonPrefixLen(prevTerm, dt.term)
			}
			suffix := dt.term[shared:]
			k := binary.PutUvarint(varBuf[:], uint64(shared))
			entryBuf.Write(varBuf[:k])
			k = binary.PutUvarint(varBuf[:], uint64(len(suffix)))
			entryBuf.Write(varBuf[:k])
			entryBuf.WriteString(suffix)
			k = binary.PutUvarint(varBuf[:], uint64(dt.df))
			entryBuf.Write(varBuf[:k])
			k = binary.PutUvarint(varBuf[:], uint64(dt.postingsLen))
			entryBuf.Write(varBuf[:k])

			if countInBlock > 0 && blockBuf.Len()+entryBuf.Len() > maxBlockBytes {
				break
			}
			blockBuf.Write(entryBuf.Bytes())
			prevTerm = dt.term
			countInBlock++
			idx++
		}
		if idx == blockStartIdx {
			// Ensure forward progress even on oversized single entry.
			idx++
		}

		rawBlock := blockBuf.Bytes()
		binary.LittleEndian.PutUint16(rawBlock[0:2], uint16(countInBlock))
		binary.LittleEndian.PutUint64(rawBlock[2:10], basePostOff)

		leaders = append(leaders, leaderRec{
			leader:   blockLeader,
			fileOff:  w.pos,
			blockLen: uint32(len(rawBlock)),
		})
		if _, err := w.bw.Write(rawBlock); err != nil {
			_ = w.f.Close()
			return err
		}
		w.pos += uint64(len(rawBlock))
	}

	// Write Sparse Dictionary Index section.
	dictIndexOffset := w.pos
	var u32 [4]byte
	var u16 [2]byte
	var u64 [8]byte

	binary.LittleEndian.PutUint32(u32[:], uint32(len(leaders)))
	if _, err := w.bw.Write(u32[:]); err != nil {
		_ = w.f.Close()
		return err
	}
	w.pos += 4

	binary.LittleEndian.PutUint16(u16[:], uint16(len(w.lastTerm)))
	if _, err := w.bw.Write(u16[:]); err != nil {
		_ = w.f.Close()
		return err
	}
	w.pos += 2
	if len(w.lastTerm) > 0 {
		if _, err := w.bw.WriteString(w.lastTerm); err != nil {
			_ = w.f.Close()
			return err
		}
		w.pos += uint64(len(w.lastTerm))
	}

	for _, ld := range leaders {
		binary.LittleEndian.PutUint16(u16[:], uint16(len(ld.leader)))
		if _, err := w.bw.Write(u16[:]); err != nil {
			_ = w.f.Close()
			return err
		}
		if _, err := w.bw.WriteString(ld.leader); err != nil {
			_ = w.f.Close()
			return err
		}
		binary.LittleEndian.PutUint64(u64[:], ld.fileOff)
		if _, err := w.bw.Write(u64[:]); err != nil {
			_ = w.f.Close()
			return err
		}
		binary.LittleEndian.PutUint32(u32[:], ld.blockLen)
		if _, err := w.bw.Write(u32[:]); err != nil {
			_ = w.f.Close()
			return err
		}
		w.pos += uint64(2 + len(ld.leader) + 8 + 4)
	}

	// Write Segment Sessions section.
	sessionsOffset := w.pos
	for _, sp := range w.sessions {
		binary.LittleEndian.PutUint16(u16[:], uint16(len(sp.sessionID)))
		if _, err := w.bw.Write(u16[:]); err != nil {
			_ = w.f.Close()
			return err
		}
		if _, err := w.bw.WriteString(sp.sessionID); err != nil {
			_ = w.f.Close()
			return err
		}
		var spanBuf [8]byte
		binary.LittleEndian.PutUint32(spanBuf[0:4], sp.startDoc)
		binary.LittleEndian.PutUint32(spanBuf[4:8], sp.endDoc)
		if _, err := w.bw.Write(spanBuf[:]); err != nil {
			_ = w.f.Close()
			return err
		}
		w.pos += uint64(2 + len(sp.sessionID) + 8)
	}

	// Write DocArrays section (DocTurns + Norms).
	docArraysOffset := w.pos
	for _, t := range w.docTurns {
		binary.LittleEndian.PutUint32(u32[:], uint32(t))
		if _, err := w.bw.Write(u32[:]); err != nil {
			_ = w.f.Close()
			return err
		}
	}
	w.pos += uint64(len(w.docTurns)) * 4
	if _, err := w.bw.Write(w.norms); err != nil {
		_ = w.f.Close()
		return err
	}
	w.pos += uint64(len(w.norms))

	// Write DocLoc section (12 bytes per docID: sdocOffset uint64 + sdocLen uint32).
	docLocOffset := w.pos
	var locBuf [12]byte
	for _, loc := range w.docLocs {
		binary.LittleEndian.PutUint64(locBuf[0:8], loc[0])
		binary.LittleEndian.PutUint32(locBuf[8:12], uint32(loc[1]))
		if _, err := w.bw.Write(locBuf[:]); err != nil {
			_ = w.f.Close()
			return err
		}
	}
	w.pos += uint64(len(w.docLocs)) * 12
	totalSize := w.pos

	if err := w.bw.Flush(); err != nil {
		_ = w.f.Close()
		return err
	}

	// Patch 112-byte header at offset 0 with CRC32.
	var hdr [sidxHeaderSize]byte
	copy(hdr[0:8], sidxMagic)
	binary.LittleEndian.PutUint32(hdr[8:12], sidxVersion)
	binary.LittleEndian.PutUint32(hdr[12:16], w.docCount)
	binary.LittleEndian.PutUint32(hdr[16:20], w.termCount)
	binary.LittleEndian.PutUint32(hdr[20:24], uint32(len(w.sessions)))
	binary.LittleEndian.PutUint64(hdr[24:32], w.sumTokens[0])
	binary.LittleEndian.PutUint64(hdr[32:40], w.sumTokens[1])
	binary.LittleEndian.PutUint64(hdr[40:48], w.sumTokens[2])
	binary.LittleEndian.PutUint64(hdr[48:56], postingsOffset)
	binary.LittleEndian.PutUint64(hdr[56:64], dictBlocksOffset)
	binary.LittleEndian.PutUint64(hdr[64:72], dictIndexOffset)
	binary.LittleEndian.PutUint64(hdr[72:80], sessionsOffset)
	binary.LittleEndian.PutUint64(hdr[80:88], docArraysOffset)
	binary.LittleEndian.PutUint64(hdr[88:96], docLocOffset)
	binary.LittleEndian.PutUint64(hdr[96:104], totalSize)
	crc := crc32.ChecksumIEEE(hdr[0:104])
	binary.LittleEndian.PutUint32(hdr[104:108], crc)
	binary.LittleEndian.PutUint32(hdr[108:112], uint32(w.tier))

	if _, err := w.f.WriteAt(hdr[:], 0); err != nil {
		_ = w.f.Close()
		return err
	}
	if err := w.f.Sync(); err != nil {
		_ = w.f.Close()
		return err
	}
	return w.f.Close()
}

func commonPrefixLen(a, b string) int {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	i := 0
	for i < n && a[i] == b[i] {
		i++
	}
	return i
}

// ---------------------------------------------------------------------------
// Opening & Reading Immutable Disk Segments
// ---------------------------------------------------------------------------

func openDiskSegment(dir string, seq uint64) (*diskSegment, error) {
	sidxPath, sdocPath, sdelPath := segmentPaths(dir, seq)
	idxFile, err := os.Open(sidxPath)
	if err != nil {
		return nil, err
	}
	docFile, err := os.Open(sdocPath)
	if err != nil {
		_ = idxFile.Close()
		return nil, err
	}

	closeBoth := func() {
		_ = idxFile.Close()
		_ = docFile.Close()
	}

	var docMagic [8]byte
	if _, err := docFile.ReadAt(docMagic[:], 0); err != nil || string(docMagic[:]) != sdocMagic {
		closeBoth()
		return nil, errCorruptSegment
	}

	var hdr [sidxHeaderSize]byte
	if _, err := idxFile.ReadAt(hdr[:], 0); err != nil {
		closeBoth()
		return nil, err
	}
	if string(hdr[0:8]) != sidxMagic {
		closeBoth()
		return nil, errCorruptSegment
	}
	if binary.LittleEndian.Uint32(hdr[8:12]) != sidxVersion {
		closeBoth()
		return nil, errCorruptSegment
	}
	wantCRC := binary.LittleEndian.Uint32(hdr[104:108])
	if crc32.ChecksumIEEE(hdr[0:104]) != wantCRC {
		closeBoth()
		return nil, errCorruptSegment
	}

	docCount := binary.LittleEndian.Uint32(hdr[12:16])
	termCount := binary.LittleEndian.Uint32(hdr[16:20])
	sessCount := binary.LittleEndian.Uint32(hdr[20:24])
	sumUser := binary.LittleEndian.Uint64(hdr[24:32])
	sumAsst := binary.LittleEndian.Uint64(hdr[32:40])
	sumTool := binary.LittleEndian.Uint64(hdr[40:48])
	dictIndexOff := binary.LittleEndian.Uint64(hdr[64:72])
	sessionsOff := binary.LittleEndian.Uint64(hdr[72:80])
	docArraysOff := binary.LittleEndian.Uint64(hdr[80:88])
	docLocOff := binary.LittleEndian.Uint64(hdr[88:96])
	tier := int(binary.LittleEndian.Uint32(hdr[108:112]))

	// Read DictIndex..DocLocOff metadata tail in one contiguous pread.
	if docLocOff < dictIndexOff {
		closeBoth()
		return nil, errCorruptSegment
	}
	tailLen := docLocOff - dictIndexOff
	tail := make([]byte, tailLen)
	if _, err := idxFile.ReadAt(tail, int64(dictIndexOff)); err != nil {
		closeBoth()
		return nil, err
	}

	// Parse Sparse Dictionary Index.
	r := 0
	dictEnd := int(sessionsOff - dictIndexOff)
	if dictEnd < 6 || dictEnd > len(tail) {
		closeBoth()
		return nil, errCorruptSegment
	}
	blockCount := binary.LittleEndian.Uint32(tail[r : r+4])
	r += 4
	maxTermLen := int(binary.LittleEndian.Uint16(tail[r : r+2]))
	r += 2
	if r+maxTermLen > dictEnd {
		closeBoth()
		return nil, errCorruptSegment
	}
	maxTerm := make([]byte, maxTermLen)
	copy(maxTerm, tail[r:r+maxTermLen])
	r += maxTermLen

	// Pre-size leaderBytes arena.
	approxArena := dictEnd - r - int(blockCount)*14
	if approxArena < 0 {
		approxArena = 0
	}
	leaderBytes := make([]byte, 0, approxArena)
	leaders := make([]dictBlockLeader, 0, blockCount)
	for i := uint32(0); i < blockCount; i++ {
		if r+2 > dictEnd {
			closeBoth()
			return nil, errCorruptSegment
		}
		lLen := int(binary.LittleEndian.Uint16(tail[r : r+2]))
		r += 2
		if r+lLen+12 > dictEnd {
			closeBoth()
			return nil, errCorruptSegment
		}
		strOff := uint32(len(leaderBytes))
		leaderBytes = append(leaderBytes, tail[r:r+lLen]...)
		r += lLen
		fileOff := binary.LittleEndian.Uint64(tail[r : r+8])
		r += 8
		blkLen := binary.LittleEndian.Uint32(tail[r : r+4])
		r += 4
		leaders = append(leaders, dictBlockLeader{
			strOff:   strOff,
			strLen:   uint16(lLen),
			blockLen: uint16(blkLen),
			fileOff:  fileOff,
		})
	}

	// Parse Sessions.
	r = dictEnd
	sessEnd := int(docArraysOff - dictIndexOff)
	if sessEnd < r || sessEnd > len(tail) {
		closeBoth()
		return nil, errCorruptSegment
	}
	sessions := make([]segSessionSpan, 0, sessCount)
	docSessIdx := make([]uint32, docCount)
	for i := uint32(0); i < sessCount; i++ {
		if r+2 > sessEnd {
			closeBoth()
			return nil, errCorruptSegment
		}
		sLen := int(binary.LittleEndian.Uint16(tail[r : r+2]))
		r += 2
		if r+sLen+8 > sessEnd {
			closeBoth()
			return nil, errCorruptSegment
		}
		sid := string(tail[r : r+sLen])
		r += sLen
		startDoc := binary.LittleEndian.Uint32(tail[r : r+4])
		endDoc := binary.LittleEndian.Uint32(tail[r+4 : r+8])
		r += 8
		if endDoc > docCount || startDoc > endDoc {
			closeBoth()
			return nil, errCorruptSegment
		}
		sessions = append(sessions, segSessionSpan{
			sessionID: sid,
			startDoc:  startDoc,
			endDoc:    endDoc,
		})
		for d := startDoc; d < endDoc; d++ {
			docSessIdx[d] = i
		}
	}

	// Parse DocArrays (DocTurns + Norms).
	r = sessEnd
	arraysNeed := int(docCount)*4 + int(docCount)*numTurnFields
	if r+arraysNeed > len(tail) {
		closeBoth()
		return nil, errCorruptSegment
	}
	docTurns := make([]int32, docCount)
	for i := uint32(0); i < docCount; i++ {
		docTurns[i] = int32(binary.LittleEndian.Uint32(tail[r : r+4]))
		r += 4
	}
	norms := make([]uint8, int(docCount)*numTurnFields)
	copy(norms, tail[r:r+int(docCount)*numTurnFields])

	seg := &diskSegment{
		dir:          dir,
		seq:          seq,
		tier:         tier,
		docCount:     docCount,
		termCount:    termCount,
		idxFile:      idxFile,
		docFile:      docFile,
		docLocOffset: docLocOff,
		leaderBytes:  leaderBytes,
		leaders:      leaders,
		maxTerm:      maxTerm,
		sessions:     sessions,
		docSessIdx:   docSessIdx,
		docTurns:     docTurns,
		norms:        norms,
		delWords:     make([]atomic.Uint64, (docCount+63)/64),
	}
	seg.refs.Store(1)
	seg.liveCount.Store(int32(docCount))
	seg.sumFieldTokens[0].Store(int64(sumUser))
	seg.sumFieldTokens[1].Store(int64(sumAsst))
	seg.sumFieldTokens[2].Store(int64(sumTool))

	// Load optional seg-<seq>.del tombstone bitmap if present.
	if delBytes, err := os.ReadFile(sdelPath); err == nil {
		if err := seg.loadTombstones(delBytes); err != nil {
			closeBoth()
			return nil, err
		}
	}

	return seg, nil
}

func (s *diskSegment) loadTombstones(data []byte) error {
	wantBytes := 16 + len(s.delWords)*8 + 4
	if len(data) != wantBytes || string(data[0:8]) != sdelMagic {
		return errCorruptSegment
	}
	if binary.LittleEndian.Uint32(data[8:12]) != s.docCount {
		return errCorruptSegment
	}
	crcOff := len(data) - 4
	if crc32.ChecksumIEEE(data[:crcOff]) != binary.LittleEndian.Uint32(data[crcOff:]) {
		return errCorruptSegment
	}

	deletedDocs := 0
	off := 16
	for i := range s.delWords {
		w := binary.LittleEndian.Uint64(data[off : off+8])
		off += 8
		if w == 0 {
			continue
		}
		s.delWords[i].Store(w)
		deletedDocs += bits.OnesCount64(w)
		baseDoc := uint32(i) * 64
		tmp := w
		for tmp != 0 {
			bit := uint32(bits.TrailingZeros64(tmp))
			docID := baseDoc + bit
			if docID < s.docCount {
				nb := int(docID) * numTurnFields
				for f := 0; f < numTurnFields; f++ {
					s.sumFieldTokens[f].Add(-int64(decodeNorm(s.norms[nb+f])))
				}
			}
			tmp &= tmp - 1
		}
	}
	live := int32(int(s.docCount) - deletedDocs)
	if live < 0 {
		live = 0
	}
	s.liveCount.Store(live)
	return nil
}

// ---------------------------------------------------------------------------
// Sparse Dictionary Lookup & Prefix Scan (Single 4 KiB pread!)
// ---------------------------------------------------------------------------

func (s *diskSegment) leaderStringBytes(ld dictBlockLeader) []byte {
	return s.leaderBytes[ld.strOff : ld.strOff+uint32(ld.strLen)]
}

func (s *diskSegment) leaderBlockBytes(ld dictBlockLeader) int {
	if ld.blockLen == 0 {
		return 65536
	}
	return int(ld.blockLen)
}

type termDictEntry struct {
	df          uint32
	postingsOff uint64
	postingsLen uint32
}

// lookupTerm binary-searches RAM block leaders and preads a single <=4 KiB
// front-coded dictionary block from .sidx.
func (s *diskSegment) lookupTerm(term string) (termDictEntry, bool, error) {
	if len(s.leaders) == 0 || s.liveCount.Load() <= 0 {
		return termDictEntry{}, false, nil
	}
	termBytes := []byte(term)
	if bytes.Compare(termBytes, s.leaderStringBytes(s.leaders[0])) < 0 {
		return termDictEntry{}, false, nil
	}
	if len(s.maxTerm) > 0 && bytes.Compare(termBytes, s.maxTerm) > 0 {
		return termDictEntry{}, false, nil
	}

	// Find highest leader <= termBytes.
	lo, hi := 0, len(s.leaders)-1
	blockIdx := 0
	for lo <= hi {
		mid := int(uint(lo+hi) >> 1)
		cmp := bytes.Compare(s.leaderStringBytes(s.leaders[mid]), termBytes)
		if cmp <= 0 {
			blockIdx = mid
			lo = mid + 1
		} else {
			hi = mid - 1
		}
	}

	ld := s.leaders[blockIdx]
	blkLen := s.leaderBlockBytes(ld)

	var buf []byte
	var pooled *[]byte
	if blkLen <= 4096 {
		pooled = dictBlockBufPool.Get().(*[]byte)
		buf = (*pooled)[:blkLen]
		defer dictBlockBufPool.Put(pooled)
	} else {
		buf = make([]byte, blkLen)
	}

	if _, err := s.idxFile.ReadAt(buf, int64(ld.fileOff)); err != nil {
		return termDictEntry{}, false, err
	}

	return scanDictBlockExact(buf, termBytes)
}

func scanDictBlockExact(buf []byte, target []byte) (termDictEntry, bool, error) {
	if len(buf) < 10 {
		return termDictEntry{}, false, errCorruptSegment
	}
	count := int(binary.LittleEndian.Uint16(buf[0:2]))
	curPostOff := binary.LittleEndian.Uint64(buf[2:10])
	pos := 10

	var curTerm [maxIndexedTokenBytes * 2]byte
	curLen := 0

	for i := 0; i < count; i++ {
		shared, n1 := binary.Uvarint(buf[pos:])
		if n1 <= 0 {
			return termDictEntry{}, false, errCorruptSegment
		}
		pos += n1
		sufLen, n2 := binary.Uvarint(buf[pos:])
		if n2 <= 0 {
			return termDictEntry{}, false, errCorruptSegment
		}
		pos += n2
		if int(shared)+int(sufLen) > len(curTerm) || pos+int(sufLen) > len(buf) {
			return termDictEntry{}, false, errCorruptSegment
		}
		copy(curTerm[int(shared):int(shared)+int(sufLen)], buf[pos:pos+int(sufLen)])
		curLen = int(shared) + int(sufLen)
		pos += int(sufLen)

		df, n3 := binary.Uvarint(buf[pos:])
		if n3 <= 0 {
			return termDictEntry{}, false, errCorruptSegment
		}
		pos += n3
		pLen, n4 := binary.Uvarint(buf[pos:])
		if n4 <= 0 {
			return termDictEntry{}, false, errCorruptSegment
		}
		pos += n4

		cmp := bytes.Compare(curTerm[:curLen], target)
		if cmp == 0 {
			return termDictEntry{
				df:          uint32(df),
				postingsOff: curPostOff,
				postingsLen: uint32(pLen),
			}, true, nil
		}
		if cmp > 0 {
			return termDictEntry{}, false, nil
		}
		curPostOff += pLen
	}
	return termDictEntry{}, false, nil
}

// collectPrefixTerms binary-searches the sparse dictionary index for prefix and
// scans matching dictionary entries across block boundaries up to maxScan.
func (s *diskSegment) collectPrefixTerms(prefix string, outDF map[string]uint32, maxScan int) error {
	if len(s.leaders) == 0 || s.liveCount.Load() <= 0 || prefix == "" {
		return nil
	}
	pBytes := []byte(prefix)
	if len(s.maxTerm) > 0 && bytes.Compare(pBytes, s.maxTerm) > 0 {
		return nil
	}

	// Find last block whose leader <= prefix (start at 0 if prefix < leaders[0]).
	lo, hi := 0, len(s.leaders)-1
	startBlock := 0
	for lo <= hi {
		mid := int(uint(lo+hi) >> 1)
		if bytes.Compare(s.leaderStringBytes(s.leaders[mid]), pBytes) <= 0 {
			startBlock = mid
			lo = mid + 1
		} else {
			hi = mid - 1
		}
	}

	pooled := dictBlockBufPool.Get().(*[]byte)
	defer dictBlockBufPool.Put(pooled)

	scanned := 0
	var curTerm [maxIndexedTokenBytes * 2]byte
	for blk := startBlock; blk < len(s.leaders); blk++ {
		ld := s.leaders[blk]
		if blk > startBlock && !bytes.HasPrefix(s.leaderStringBytes(ld), pBytes) {
			break
		}
		blkLen := s.leaderBlockBytes(ld)
		var buf []byte
		if blkLen <= len(*pooled) {
			buf = (*pooled)[:blkLen]
		} else {
			buf = make([]byte, blkLen)
		}
		if _, err := s.idxFile.ReadAt(buf, int64(ld.fileOff)); err != nil {
			return err
		}
		if len(buf) < 10 {
			return errCorruptSegment
		}
		count := int(binary.LittleEndian.Uint16(buf[0:2]))
		pos := 10
		curLen := 0
		pastPrefix := false

		for i := 0; i < count; i++ {
			shared, n1 := binary.Uvarint(buf[pos:])
			if n1 <= 0 {
				return errCorruptSegment
			}
			pos += n1
			sufLen, n2 := binary.Uvarint(buf[pos:])
			if n2 <= 0 {
				return errCorruptSegment
			}
			pos += n2
			if int(shared)+int(sufLen) > len(curTerm) || pos+int(sufLen) > len(buf) {
				return errCorruptSegment
			}
			copy(curTerm[int(shared):int(shared)+int(sufLen)], buf[pos:pos+int(sufLen)])
			curLen = int(shared) + int(sufLen)
			pos += int(sufLen)

			df, n3 := binary.Uvarint(buf[pos:])
			if n3 <= 0 {
				return errCorruptSegment
			}
			pos += n3
			_, n4 := binary.Uvarint(buf[pos:])
			if n4 <= 0 {
				return errCorruptSegment
			}
			pos += n4

			tb := curTerm[:curLen]
			if bytes.HasPrefix(tb, pBytes) {
				if !bytes.Equal(tb, pBytes) {
					outDF[string(tb)] += uint32(df)
					scanned++
					if scanned >= maxScan {
						return nil
					}
				}
			} else if bytes.Compare(tb, pBytes) > 0 {
				pastPrefix = true
				break
			}
		}
		if pastPrefix {
			break
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Stored Turn Excerpt (.sdoc) Encoding & Top-K Random-Access Pread
// ---------------------------------------------------------------------------

func encodeStoredTurnDoc(out *bytes.Buffer, d storedTurnDoc) {
	out.Reset()
	var vb [binary.MaxVarintLen64]byte

	k := binary.PutVarint(vb[:], int64(d.firstMsgIdx))
	out.Write(vb[:k])
	k = binary.PutVarint(vb[:], int64(d.bestMsgIdx))
	out.Write(vb[:k])

	flags := uint8(0)
	if d.hasFieldMsgIdx {
		flags |= 1
	}
	out.WriteByte(flags)
	if d.hasFieldMsgIdx {
		k = binary.PutVarint(vb[:], int64(d.userMsgIdx))
		out.Write(vb[:k])
		k = binary.PutVarint(vb[:], int64(d.asstMsgIdx))
		out.Write(vb[:k])
		k = binary.PutVarint(vb[:], int64(d.toolMsgIdx))
		out.Write(vb[:k])
	}
	k = binary.PutVarint(vb[:], d.updatedAt)
	out.Write(vb[:k])

	for _, exc := range []string{d.userExcerpt, d.asstExcerpt, d.toolExcerpt} {
		k = binary.PutUvarint(vb[:], uint64(len(exc)))
		out.Write(vb[:k])
		out.WriteString(exc)
	}
}

func decodeStoredTurnDoc(data []byte) (storedTurnDoc, error) {
	var d storedTurnDoc
	pos := 0

	v1, n := binary.Varint(data[pos:])
	if n <= 0 {
		return d, errCorruptSegment
	}
	d.firstMsgIdx = int(v1)
	pos += n

	v2, n := binary.Varint(data[pos:])
	if n <= 0 {
		return d, errCorruptSegment
	}
	d.bestMsgIdx = int(v2)
	pos += n

	if pos >= len(data) {
		return d, errCorruptSegment
	}
	flags := data[pos]
	pos++
	if flags&1 != 0 {
		d.hasFieldMsgIdx = true
		u, n1 := binary.Varint(data[pos:])
		if n1 <= 0 {
			return d, errCorruptSegment
		}
		pos += n1
		a, n2 := binary.Varint(data[pos:])
		if n2 <= 0 {
			return d, errCorruptSegment
		}
		pos += n2
		t, n3 := binary.Varint(data[pos:])
		if n3 <= 0 {
			return d, errCorruptSegment
		}
		pos += n3
		d.userMsgIdx = int(u)
		d.asstMsgIdx = int(a)
		d.toolMsgIdx = int(t)
	}

	upd, n := binary.Varint(data[pos:])
	if n <= 0 {
		return d, errCorruptSegment
	}
	d.updatedAt = upd
	pos += n

	readStr := func() (string, error) {
		sLen, m := binary.Uvarint(data[pos:])
		if m <= 0 || pos+m+int(sLen) > len(data) {
			return "", errCorruptSegment
		}
		pos += m
		s := string(data[pos : pos+int(sLen)])
		pos += int(sLen)
		return s, nil
	}

	var err error
	if d.userExcerpt, err = readStr(); err != nil {
		return d, err
	}
	if d.asstExcerpt, err = readStr(); err != nil {
		return d, err
	}
	if d.toolExcerpt, err = readStr(); err != nil {
		return d, err
	}
	return d, nil
}

func (s *diskSegment) readDocLoc(docID uint32) (sdocOff uint64, sdocLen uint32, err error) {
	if docID >= s.docCount {
		return 0, 0, errCorruptSegment
	}
	var loc [12]byte
	off := s.docLocOffset + uint64(docID)*12
	if _, err := s.idxFile.ReadAt(loc[:], int64(off)); err != nil {
		return 0, 0, err
	}
	return binary.LittleEndian.Uint64(loc[0:8]), binary.LittleEndian.Uint32(loc[8:12]), nil
}

// readStoredDoc preads ONLY the single compressed record for docID from .sdoc
// via io.SectionReader and decompresses it. Called ONLY for Top-K hits.
func (s *diskSegment) readStoredDoc(docID uint32) (storedTurnDoc, error) {
	sdocOff, sdocLen, err := s.readDocLoc(docID)
	if err != nil {
		return storedTurnDoc{}, err
	}
	sr := io.NewSectionReader(s.docFile, int64(sdocOff), int64(sdocLen))

	var fr io.ReadCloser
	if pooled := flateReaderPool.Get(); pooled != nil {
		fr = pooled.(io.ReadCloser)
		if err := fr.(flate.Resetter).Reset(sr, nil); err != nil {
			fr = flate.NewReader(sr)
		}
	} else {
		fr = flate.NewReader(sr)
	}
	defer func() {
		_ = fr.Close()
		flateReaderPool.Put(fr)
	}()

	raw, err := io.ReadAll(fr)
	if err != nil {
		return storedTurnDoc{}, err
	}
	return decodeStoredTurnDoc(raw)
}

// ---------------------------------------------------------------------------
// Streaming Dictionary & Postings Iterator (For Low-RAM K-Way Compaction)
// ---------------------------------------------------------------------------

type segmentTermIter struct {
	seg        *diskSegment
	blockIdx   int
	blockBuf   []byte
	posInBlock int
	remInBlock int
	curPostOff uint64
	curTermBuf [maxIndexedTokenBytes * 2]byte
	curTermLen int

	term  string
	entry termDictEntry
	err   error
}

func newSegmentTermIter(seg *diskSegment) *segmentTermIter {
	return &segmentTermIter{
		seg:      seg,
		blockBuf: make([]byte, 4096),
	}
}

func (it *segmentTermIter) next() bool {
	for {
		if it.remInBlock > 0 {
			shared, n1 := binary.Uvarint(it.blockBuf[it.posInBlock:])
			if n1 <= 0 {
				it.err = errCorruptSegment
				return false
			}
			it.posInBlock += n1
			sufLen, n2 := binary.Uvarint(it.blockBuf[it.posInBlock:])
			if n2 <= 0 {
				it.err = errCorruptSegment
				return false
			}
			it.posInBlock += n2
			if int(shared)+int(sufLen) > len(it.curTermBuf) || it.posInBlock+int(sufLen) > len(it.blockBuf) {
				it.err = errCorruptSegment
				return false
			}
			copy(it.curTermBuf[int(shared):int(shared)+int(sufLen)], it.blockBuf[it.posInBlock:it.posInBlock+int(sufLen)])
			it.curTermLen = int(shared) + int(sufLen)
			it.posInBlock += int(sufLen)

			df, n3 := binary.Uvarint(it.blockBuf[it.posInBlock:])
			if n3 <= 0 {
				it.err = errCorruptSegment
				return false
			}
			it.posInBlock += n3
			pLen, n4 := binary.Uvarint(it.blockBuf[it.posInBlock:])
			if n4 <= 0 {
				it.err = errCorruptSegment
				return false
			}
			it.posInBlock += n4

			it.term = string(it.curTermBuf[:it.curTermLen])
			it.entry = termDictEntry{
				df:          uint32(df),
				postingsOff: it.curPostOff,
				postingsLen: uint32(pLen),
			}
			it.curPostOff += pLen
			it.remInBlock--
			return true
		}

		if it.blockIdx >= len(it.seg.leaders) {
			return false
		}
		ld := it.seg.leaders[it.blockIdx]
		it.blockIdx++
		blkLen := it.seg.leaderBlockBytes(ld)
		if cap(it.blockBuf) < blkLen {
			it.blockBuf = make([]byte, blkLen)
		} else {
			it.blockBuf = it.blockBuf[:blkLen]
		}
		if _, err := it.seg.idxFile.ReadAt(it.blockBuf, int64(ld.fileOff)); err != nil {
			it.err = err
			return false
		}
		if len(it.blockBuf) < 10 {
			it.err = errCorruptSegment
			return false
		}
		it.remInBlock = int(binary.LittleEndian.Uint16(it.blockBuf[0:2]))
		it.curPostOff = binary.LittleEndian.Uint64(it.blockBuf[2:10])
		it.posInBlock = 10
		it.curTermLen = 0
	}
}

func decodePostingsInto(buf []byte, dst []postingEntry) ([]postingEntry, error) {
	pos := 0
	chunkBaseDoc := uint32(0)
	for pos < len(buf) {
		if pos+8 > len(buf) {
			return dst, errCorruptSegment
		}
		count := int(buf[pos]) + 1
		payloadLen := int(binary.LittleEndian.Uint16(buf[pos+1 : pos+3]))
		pos += 8
		if pos+payloadLen > len(buf) {
			return dst, errCorruptSegment
		}
		chunkEnd := pos + payloadLen
		prevDoc := chunkBaseDoc
		for i := 0; i < count; i++ {
			delta, n1 := binary.Uvarint(buf[pos:chunkEnd])
			if n1 <= 0 {
				return dst, errCorruptSegment
			}
			pos += n1
			var docID uint32
			if i == 0 {
				docID = chunkBaseDoc + uint32(delta)
			} else {
				docID = prevDoc + uint32(delta) + 1
			}
			prevDoc = docID
			if pos >= chunkEnd {
				return dst, errCorruptSegment
			}
			fm := buf[pos]
			pos++
			mask := fm & ((1 << FieldUser) | (1 << FieldAssistant) | (1 << FieldTool))
			var tfU, tfA, tfT uint32
			if fm&flagAllTFOne != 0 {
				if mask&(1<<FieldUser) != 0 {
					tfU = 1
				}
				if mask&(1<<FieldAssistant) != 0 {
					tfA = 1
				}
				if mask&(1<<FieldTool) != 0 {
					tfT = 1
				}
			} else {
				if mask&(1<<FieldUser) != 0 {
					v, n2 := binary.Uvarint(buf[pos:chunkEnd])
					if n2 <= 0 {
						return dst, errCorruptSegment
					}
					pos += n2
					tfU = uint32(v)
				}
				if mask&(1<<FieldAssistant) != 0 {
					v, n2 := binary.Uvarint(buf[pos:chunkEnd])
					if n2 <= 0 {
						return dst, errCorruptSegment
					}
					pos += n2
					tfA = uint32(v)
				}
				if mask&(1<<FieldTool) != 0 {
					v, n2 := binary.Uvarint(buf[pos:chunkEnd])
					if n2 <= 0 {
						return dst, errCorruptSegment
					}
					pos += n2
					tfT = uint32(v)
				}
			}
			dst = append(dst, postingEntry{
				docID: docID,
				mask:  mask,
				tfU:   tfU,
				tfA:   tfA,
				tfT:   tfT,
			})
		}
		chunkBaseDoc = prevDoc + 1
	}
	return dst, nil
}
