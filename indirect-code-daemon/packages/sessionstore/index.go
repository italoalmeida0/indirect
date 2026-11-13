package sessionstore

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"sort"

	"indirect/indirect-code-daemon/internal/durable"
)

// Tier identifies the storage tier of a session segment.
type Tier string

const (
	// TierWarm stores uncompressed append-only JSON records for recent turns.
	TierWarm Tier = "warm"
	// TierCold stores immutable 64 KiB seekable Zstandard frames for aged turns.
	TierCold Tier = "cold"
)

const (
	manifestFormatVersion = 2

	turnIndexMagic       = "ICT1"
	turnIndexVersion     = 1
	turnIndexHeaderBytes = 16
	turnIndexEntryBytes  = 88

	tierCodeWarm uint8 = 1
	tierCodeCold uint8 = 2
)

// ErrCorruptTurnIndex indicates interior corruption in turn.idx.
var ErrCorruptTurnIndex = errors.New("sessionstore: corrupt turn index")

// ErrCorruptManifest indicates an unreadable or invalid manifest.json.
var ErrCorruptManifest = errors.New("sessionstore: corrupt manifest")

// TurnEntry indexes a single turn's storage coordinates, message span, and token
// estimate in turn.idx.
type TurnEntry struct {
	TurnSeq   int    `json:"turnSeq"`
	SegmentID uint32 `json:"segmentId"`
	Tier      Tier   `json:"tier"`

	// Warm tier byte offsets inside seg-<id>.turns and seg-<id>.diffs.
	Offset     uint64 `json:"offset"`
	Length     uint32 `json:"length"`
	DiffOffset uint64 `json:"diffOffset"`
	DiffLength uint32 `json:"diffLength"`

	// Cold tier seekable frame coordinates inside seg-<id>.turns.zst and seg-<id>.diffs.zst.
	FrameIdx         uint32 `json:"frameIdx"`
	IntraFrameOffset uint32 `json:"intraFrameOffset"`
	ByteLen          uint32 `json:"byteLen"`
	DiffFrameIdx     uint32 `json:"diffFrameIdx"`
	DiffIntraOffset  uint32 `json:"diffIntraOffset"`
	DiffByteLen      uint32 `json:"diffByteLen"`

	// Contiguous raw message index range [FirstMsgIdx, LastMsgIdx] (inclusive).
	FirstMsgIdx   int   `json:"firstMsgIdx"`
	LastMsgIdx    int   `json:"lastMsgIdx"`
	TokenEst      int   `json:"tokenEst"`
	CreatedAtUnix int64 `json:"createdAtUnix"`
}

// MsgCount returns the number of messages indexed in this turn.
func (e TurnEntry) MsgCount() int {
	if e.LastMsgIdx < e.FirstMsgIdx {
		return 0
	}
	return e.LastMsgIdx - e.FirstMsgIdx + 1
}

// SegmentMeta describes one Warm or Cold segment inside manifest.json.
type SegmentMeta struct {
	ID            uint32   `json:"id"`
	Tier          Tier     `json:"tier"`
	Sealed        bool     `json:"sealed"`
	FirstTurn     int      `json:"firstTurn"`
	LastTurn      int      `json:"lastTurn"`
	TurnCount     int      `json:"turnCount"`
	TurnsBytes    uint64   `json:"turnsBytes"`
	DiffsBytes    uint64   `json:"diffsBytes"`
	UncompBytes   uint64   `json:"uncompBytes"`
	CreatedAtUnix int64    `json:"createdAtUnix"`
	UpdatedAtUnix int64    `json:"updatedAtUnix"`
	HasBlobIndex  bool     `json:"hasBlobIndex,omitempty"`
	BlobRefs      []string `json:"blobRefs,omitempty"`
}

// Manifest tracks the ordered list of segments for a v2 session.
type Manifest struct {
	Version       int           `json:"version"`
	SessionID     string        `json:"sessionId"`
	NextSegmentID uint32        `json:"nextSegmentId"`
	Segments      []SegmentMeta `json:"segments"`
	UpdatedAtUnix int64         `json:"updatedAtUnix"`
}

func warmTurnsFilename(segID uint32) string {
	return fmt.Sprintf("seg-%06d.turns", segID)
}

func warmDiffsFilename(segID uint32) string {
	return fmt.Sprintf("seg-%06d.diffs", segID)
}

func coldTurnsFilename(segID uint32) string {
	return fmt.Sprintf("seg-%06d.turns.zst", segID)
}

func coldDiffsFilename(segID uint32) string {
	return fmt.Sprintf("seg-%06d.diffs.zst", segID)
}

func coldFrameIndexFilename(segID uint32) string {
	return fmt.Sprintf("seg-%06d.fidx", segID)
}

func encodeTurnIndexHeader(dst []byte) {
	copy(dst[0:4], turnIndexMagic)
	binary.LittleEndian.PutUint32(dst[4:8], turnIndexVersion)
	hdrCRC := crc32.ChecksumIEEE(dst[0:8])
	binary.LittleEndian.PutUint32(dst[8:12], hdrCRC)
	binary.LittleEndian.PutUint32(dst[12:16], 0)
}

func verifyTurnIndexHeader(buf []byte) error {
	if len(buf) < turnIndexHeaderBytes {
		return fmt.Errorf("%w: short header (%d bytes)", ErrCorruptTurnIndex, len(buf))
	}
	if string(buf[0:4]) != turnIndexMagic {
		return fmt.Errorf("%w: bad magic", ErrCorruptTurnIndex)
	}
	ver := binary.LittleEndian.Uint32(buf[4:8])
	if ver != turnIndexVersion {
		return fmt.Errorf("%w: unsupported version %d", ErrCorruptTurnIndex, ver)
	}
	wantCRC := binary.LittleEndian.Uint32(buf[8:12])
	gotCRC := crc32.ChecksumIEEE(buf[0:8])
	if wantCRC != gotCRC {
		return fmt.Errorf("%w: header crc mismatch", ErrCorruptTurnIndex)
	}
	return nil
}

func encodeTurnEntry(dst []byte, e TurnEntry) {
	for i := 0; i < turnIndexEntryBytes; i++ {
		dst[i] = 0
	}
	binary.LittleEndian.PutUint32(dst[0:4], uint32(int32(e.TurnSeq)))
	binary.LittleEndian.PutUint32(dst[4:8], e.SegmentID)
	code := tierCodeWarm
	if e.Tier == TierCold {
		code = tierCodeCold
	}
	dst[8] = code
	binary.LittleEndian.PutUint64(dst[12:20], e.Offset)
	binary.LittleEndian.PutUint32(dst[20:24], e.Length)
	binary.LittleEndian.PutUint64(dst[24:32], e.DiffOffset)
	binary.LittleEndian.PutUint32(dst[32:36], e.DiffLength)
	binary.LittleEndian.PutUint32(dst[36:40], e.FrameIdx)
	binary.LittleEndian.PutUint32(dst[40:44], e.IntraFrameOffset)
	binary.LittleEndian.PutUint32(dst[44:48], e.ByteLen)
	binary.LittleEndian.PutUint32(dst[48:52], e.DiffFrameIdx)
	binary.LittleEndian.PutUint32(dst[52:56], e.DiffIntraOffset)
	binary.LittleEndian.PutUint32(dst[56:60], e.DiffByteLen)
	binary.LittleEndian.PutUint32(dst[60:64], uint32(int32(e.FirstMsgIdx)))
	binary.LittleEndian.PutUint32(dst[64:68], uint32(int32(e.LastMsgIdx)))
	binary.LittleEndian.PutUint32(dst[68:72], uint32(int32(e.TokenEst)))
	binary.LittleEndian.PutUint64(dst[72:80], uint64(e.CreatedAtUnix))
	sum := crc32.ChecksumIEEE(dst[0:80])
	binary.LittleEndian.PutUint32(dst[80:84], sum)
}

func decodeTurnEntry(src []byte) (TurnEntry, error) {
	if len(src) < turnIndexEntryBytes {
		return TurnEntry{}, fmt.Errorf("%w: short entry", ErrCorruptTurnIndex)
	}
	wantCRC := binary.LittleEndian.Uint32(src[80:84])
	gotCRC := crc32.ChecksumIEEE(src[0:80])
	if wantCRC != gotCRC {
		return TurnEntry{}, fmt.Errorf("%w: entry crc mismatch", ErrCorruptTurnIndex)
	}
	var tier Tier
	switch src[8] {
	case tierCodeWarm:
		tier = TierWarm
	case tierCodeCold:
		tier = TierCold
	default:
		return TurnEntry{}, fmt.Errorf("%w: unknown tier code %d", ErrCorruptTurnIndex, src[8])
	}
	return TurnEntry{
		TurnSeq:          int(int32(binary.LittleEndian.Uint32(src[0:4]))),
		SegmentID:        binary.LittleEndian.Uint32(src[4:8]),
		Tier:             tier,
		Offset:           binary.LittleEndian.Uint64(src[12:20]),
		Length:           binary.LittleEndian.Uint32(src[20:24]),
		DiffOffset:       binary.LittleEndian.Uint64(src[24:32]),
		DiffLength:       binary.LittleEndian.Uint32(src[32:36]),
		FrameIdx:         binary.LittleEndian.Uint32(src[36:40]),
		IntraFrameOffset: binary.LittleEndian.Uint32(src[40:44]),
		ByteLen:          binary.LittleEndian.Uint32(src[44:48]),
		DiffFrameIdx:     binary.LittleEndian.Uint32(src[48:52]),
		DiffIntraOffset:  binary.LittleEndian.Uint32(src[52:56]),
		DiffByteLen:      binary.LittleEndian.Uint32(src[56:60]),
		FirstMsgIdx:      int(int32(binary.LittleEndian.Uint32(src[60:64]))),
		LastMsgIdx:       int(int32(binary.LittleEndian.Uint32(src[64:68]))),
		TokenEst:         int(int32(binary.LittleEndian.Uint32(src[68:72]))),
		CreatedAtUnix:    int64(binary.LittleEndian.Uint64(src[72:80])),
	}, nil
}

// writeTurnIndexFile atomically replaces turn.idx with entries.
func writeTurnIndexFile(path string, entries []TurnEntry) error {
	buf := make([]byte, turnIndexHeaderBytes+len(entries)*turnIndexEntryBytes)
	encodeTurnIndexHeader(buf[0:turnIndexHeaderBytes])
	pos := turnIndexHeaderBytes
	for _, e := range entries {
		encodeTurnEntry(buf[pos:pos+turnIndexEntryBytes], e)
		pos += turnIndexEntryBytes
	}
	return durable.Write(path, buf)
}

// readTurnIndexFile loads all valid TurnEntries from path. A single incomplete
// or CRC-damaged trailing entry from an interrupted append is ignored, whereas
// interior corruption fails closed with ErrCorruptTurnIndex.
func readTurnIndexFile(path string) ([]TurnEntry, int64, error) {
	buf, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, 0, nil
		}
		return nil, 0, err
	}
	if len(buf) == 0 {
		return nil, 0, nil
	}
	if err := verifyTurnIndexHeader(buf); err != nil {
		return nil, 0, err
	}
	payload := buf[turnIndexHeaderBytes:]
	fullCount := len(payload) / turnIndexEntryBytes
	hasPartialTail := len(payload)%turnIndexEntryBytes != 0
	entries := make([]TurnEntry, 0, fullCount)
	validBytes := int64(turnIndexHeaderBytes)

	for i := 0; i < fullCount; i++ {
		off := i * turnIndexEntryBytes
		e, err := decodeTurnEntry(payload[off : off+turnIndexEntryBytes])
		if err != nil {
			// Only the very last entry may be torn by a crash mid-append.
			if i == fullCount-1 && !hasPartialTail {
				break
			}
			return nil, 0, fmt.Errorf("entry %d: %w", i, err)
		}
		entries = append(entries, e)
		validBytes += turnIndexEntryBytes
	}
	return entries, validBytes, nil
}

// appendTurnIndexEntry appends a single 88-byte TurnEntry to path in O(1),
// repairing any uncommitted tail bytes left by an earlier interrupted write.
func appendTurnIndexEntry(path string, validBytes int64, entry TurnEntry) error {
	return appendTurnIndexEntries(path, validBytes, []TurnEntry{entry})
}

// appendTurnIndexEntries appends one or more 88-byte TurnEntries to path in a
// single write + Sync, repairing any uncommitted tail bytes first.
func appendTurnIndexEntries(path string, validBytes int64, added []TurnEntry) error {
	if len(added) == 0 {
		return nil
	}
	if validBytes < turnIndexHeaderBytes {
		return writeTurnIndexFile(path, added)
	}
	f, err := os.OpenFile(path, os.O_RDWR, 0o600)
	if err != nil {
		if os.IsNotExist(err) {
			return writeTurnIndexFile(path, added)
		}
		return err
	}
	st, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return err
	}
	if st.Size() != validBytes {
		if err := f.Truncate(validBytes); err != nil {
			_ = f.Close()
			return err
		}
	}
	if _, err := f.Seek(validBytes, io.SeekStart); err != nil {
		_ = f.Close()
		return err
	}
	buf := make([]byte, len(added)*turnIndexEntryBytes)
	for i, e := range added {
		off := i * turnIndexEntryBytes
		encodeTurnEntry(buf[off:off+turnIndexEntryBytes], e)
	}
	if _, err := f.Write(buf); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

func readManifestFile(path string) (Manifest, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Manifest{}, err
	}
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return Manifest{}, fmt.Errorf("%w: %v", ErrCorruptManifest, err)
	}
	if m.Version == 0 {
		m.Version = manifestFormatVersion
	}
	return m, nil
}

func writeManifestFile(path string, m Manifest) error {
	if m.Version == 0 {
		m.Version = manifestFormatVersion
	}
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return durable.Write(path, data)
}

// reconcileManifestWithIndex updates Warm segment statistics from the durable
// turn.idx entries so ordinary AppendTurn calls do not rewrite manifest.json.
func reconcileManifestWithIndex(m *Manifest, entries []TurnEntry) {
	if m == nil {
		return
	}
	type acc struct {
		firstTurn int
		lastTurn  int
		count     int
		turnsEnd  uint64
		diffsEnd  uint64
		uncomp    uint64
		maxTS     int64
	}
	bySeg := make(map[uint32]*acc, len(m.Segments))
	for _, e := range entries {
		a := bySeg[e.SegmentID]
		if a == nil {
			a = &acc{firstTurn: e.TurnSeq, lastTurn: e.TurnSeq, maxTS: e.CreatedAtUnix}
			bySeg[e.SegmentID] = a
		}
		if e.TurnSeq < a.firstTurn {
			a.firstTurn = e.TurnSeq
		}
		if e.TurnSeq > a.lastTurn {
			a.lastTurn = e.TurnSeq
		}
		a.count++
		if e.Tier == TierWarm {
			if end := e.Offset + uint64(e.Length); end > a.turnsEnd {
				a.turnsEnd = end
			}
			if end := e.DiffOffset + uint64(e.DiffLength); end > a.diffsEnd {
				a.diffsEnd = end
			}
			a.uncomp += uint64(e.Length) + uint64(e.DiffLength)
		} else {
			a.uncomp += uint64(e.ByteLen) + uint64(e.DiffByteLen)
		}
		if e.CreatedAtUnix > a.maxTS {
			a.maxTS = e.CreatedAtUnix
		}
	}

	filtered := m.Segments[:0]
	for _, seg := range m.Segments {
		a := bySeg[seg.ID]
		if a == nil {
			continue
		}
		seg.FirstTurn = a.firstTurn
		seg.LastTurn = a.lastTurn
		seg.TurnCount = a.count
		if seg.Tier == TierWarm {
			seg.TurnsBytes = a.turnsEnd
			seg.DiffsBytes = a.diffsEnd
			seg.UncompBytes = a.uncomp
		} else if seg.UncompBytes == 0 {
			seg.UncompBytes = a.uncomp
		}
		if a.maxTS > seg.UpdatedAtUnix {
			seg.UpdatedAtUnix = a.maxTS
		}
		if seg.CreatedAtUnix == 0 {
			seg.CreatedAtUnix = a.maxTS
		}
		filtered = append(filtered, seg)
		if seg.ID >= m.NextSegmentID {
			m.NextSegmentID = seg.ID + 1
		}
	}
	m.Segments = filtered
	if m.NextSegmentID == 0 {
		m.NextSegmentID = 1
	}
}

func mergeUniqueStrings(existing, added []string) ([]string, bool) {
	if len(added) == 0 {
		return existing, false
	}
	seen := make(map[string]struct{}, len(existing)+len(added))
	for _, s := range existing {
		seen[s] = struct{}{}
	}
	changed := false
	out := existing
	for _, s := range added {
		if _, ok := seen[s]; !ok {
			seen[s] = struct{}{}
			out = append(out, s)
			changed = true
		}
	}
	return out, changed
}

// findTurnIdxByMsg binary-searches entries (ordered by ascending FirstMsgIdx)
// for the turn containing targetMsgIdx, clamping out-of-range targets to the
// nearest turn.
func findTurnIdxByMsg(entries []TurnEntry, targetMsgIdx int) int {
	n := len(entries)
	if n == 0 {
		return -1
	}
	if targetMsgIdx <= entries[0].LastMsgIdx {
		return 0
	}
	if targetMsgIdx >= entries[n-1].FirstMsgIdx {
		return n - 1
	}
	// First index i where entries[i].LastMsgIdx >= targetMsgIdx.
	idx := sort.Search(n, func(i int) bool {
		return entries[i].LastMsgIdx >= targetMsgIdx
	})
	if idx >= n {
		return n - 1
	}
	return idx
}
