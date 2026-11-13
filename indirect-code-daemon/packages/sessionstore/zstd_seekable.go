package sessionstore

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/klauspost/compress/zstd"

	"indirect/indirect-code-daemon/internal/durable"
)

const (
	// ColdFrameTargetBytes is the target uncompressed payload size per independent
	// Zstandard frame in Cold segment archives (64 KiB).
	ColdFrameTargetBytes = 64 * 1024

	frameIndexMagic   = "ICF1"
	frameIndexVersion = 1
	frameHeaderBytes  = 16
	frameEntryBytes   = 16
	frameTrailerBytes = 4
)

var (
	// ErrCorruptFrameIndex indicates a damaged or truncated .fidx frame index file.
	ErrCorruptFrameIndex = errors.New("sessionstore: corrupt frame index")

	// ErrCorruptColdFrame indicates a Zstandard frame decode or bounds mismatch.
	ErrCorruptColdFrame = errors.New("sessionstore: corrupt cold zstd frame")
)

var zstdEncoderPool = sync.Pool{
	New: func() any {
		enc, err := zstd.NewWriter(
			nil,
			zstd.WithEncoderLevel(zstd.SpeedDefault),
			zstd.WithEncoderConcurrency(1),
		)
		if err != nil {
			panic(fmt.Sprintf("sessionstore: zstd encoder init: %v", err))
		}
		return enc
	},
}

var zstdDecoderPool = sync.Pool{
	New: func() any {
		dec, err := zstd.NewReader(
			nil,
			zstd.WithDecoderConcurrency(1),
			zstd.WithDecoderLowmem(true),
		)
		if err != nil {
			panic(fmt.Sprintf("sessionstore: zstd decoder init: %v", err))
		}
		return dec
	},
}

func acquireZstdEncoder() *zstd.Encoder {
	return zstdEncoderPool.Get().(*zstd.Encoder)
}

func releaseZstdEncoder(enc *zstd.Encoder) {
	if enc != nil {
		enc.Reset(nil)
		zstdEncoderPool.Put(enc)
	}
}

func acquireZstdDecoder() *zstd.Decoder {
	return zstdDecoderPool.Get().(*zstd.Decoder)
}

func releaseZstdDecoder(dec *zstd.Decoder) {
	if dec != nil {
		_ = dec.Reset(nil)
		zstdDecoderPool.Put(dec)
	}
}

// FrameEntry describes one independent Zstandard frame inside a Cold .zst archive.
type FrameEntry struct {
	CompOffset uint64 `json:"compOffset"`
	CompLen    uint32 `json:"compLen"`
	UncompLen  uint32 `json:"uncompLen"`
}

// RecordCoord locates one uncompressed record within an indexed Zstandard frame.
type RecordCoord struct {
	FrameIdx         uint32
	IntraFrameOffset uint32
	ByteLen          uint32
}

// buildSeekableFrames packs non-empty records into independent Zstandard frames
// targeting targetFrameBytes of uncompressed data per frame. Empty records map
// to a zero-length RecordCoord without emitting frames.
func buildSeekableFrames(records [][]byte, targetFrameBytes int) ([]byte, []FrameEntry, []RecordCoord, error) {
	if targetFrameBytes <= 0 {
		targetFrameBytes = ColdFrameTargetBytes
	}
	coords := make([]RecordCoord, len(records))
	var frames []FrameEntry
	var compOut bytes.Buffer
	var plainBuf bytes.Buffer
	plainBuf.Grow(targetFrameBytes)

	enc := acquireZstdEncoder()
	defer releaseZstdEncoder(enc)

	var scratch []byte

	flushFrame := func() error {
		if plainBuf.Len() == 0 {
			return nil
		}
		if plainBuf.Len() > math.MaxUint32 {
			return fmt.Errorf("sessionstore: uncompressed frame exceeds uint32: %d", plainBuf.Len())
		}
		uncomp := plainBuf.Bytes()
		scratch = enc.EncodeAll(uncomp, scratch[:0])
		if len(scratch) > math.MaxUint32 {
			return fmt.Errorf("sessionstore: compressed frame exceeds uint32: %d", len(scratch))
		}
		compOffset := uint64(compOut.Len())
		if _, err := compOut.Write(scratch); err != nil {
			return err
		}
		frames = append(frames, FrameEntry{
			CompOffset: compOffset,
			CompLen:    uint32(len(scratch)),
			UncompLen:  uint32(len(uncomp)),
		})
		plainBuf.Reset()
		return nil
	}

	for i, rec := range records {
		if len(rec) == 0 {
			coords[i] = RecordCoord{}
			continue
		}
		if len(rec) > math.MaxUint32-1 {
			return nil, nil, nil, fmt.Errorf("sessionstore: record %d exceeds uint32", i)
		}
		// Flush current frame before adding rec if adding rec (+ newline) would exceed target.
		if plainBuf.Len() > 0 && plainBuf.Len()+len(rec)+1 > targetFrameBytes {
			if err := flushFrame(); err != nil {
				return nil, nil, nil, err
			}
		}
		intraOff := uint32(plainBuf.Len())
		frameIdx := uint32(len(frames))
		plainBuf.Write(rec)
		plainBuf.WriteByte('\n')
		coords[i] = RecordCoord{
			FrameIdx:         frameIdx,
			IntraFrameOffset: intraOff,
			ByteLen:          uint32(len(rec)),
		}
		// If a single oversized record already reached/exceeded targetFrameBytes, flush now.
		if plainBuf.Len() >= targetFrameBytes {
			if err := flushFrame(); err != nil {
				return nil, nil, nil, err
			}
		}
	}
	if err := flushFrame(); err != nil {
		return nil, nil, nil, err
	}
	return compOut.Bytes(), frames, coords, nil
}

// writeFrameIndexFile writes turnFrames and diffFrames to a compact binary .fidx
// file protected by an IEEE CRC-32 trailer.
func writeFrameIndexFile(path string, turnFrames, diffFrames []FrameEntry) error {
	totalEntries := len(turnFrames) + len(diffFrames)
	buf := make([]byte, frameHeaderBytes+totalEntries*frameEntryBytes+frameTrailerBytes)
	copy(buf[0:4], frameIndexMagic)
	binary.LittleEndian.PutUint32(buf[4:8], frameIndexVersion)
	binary.LittleEndian.PutUint32(buf[8:12], uint32(len(turnFrames)))
	binary.LittleEndian.PutUint32(buf[12:16], uint32(len(diffFrames)))

	pos := frameHeaderBytes
	putEntry := func(fe FrameEntry) {
		binary.LittleEndian.PutUint64(buf[pos:pos+8], fe.CompOffset)
		binary.LittleEndian.PutUint32(buf[pos+8:pos+12], fe.CompLen)
		binary.LittleEndian.PutUint32(buf[pos+12:pos+16], fe.UncompLen)
		pos += frameEntryBytes
	}
	for _, fe := range turnFrames {
		putEntry(fe)
	}
	for _, fe := range diffFrames {
		putEntry(fe)
	}
	sum := crc32.ChecksumIEEE(buf[:pos])
	binary.LittleEndian.PutUint32(buf[pos:pos+4], sum)
	return durable.Write(path, buf)
}

// readFrameIndexFile parses and verifies a binary .fidx frame index file.
func readFrameIndexFile(path string) ([]FrameEntry, []FrameEntry, error) {
	buf, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, err
	}
	if len(buf) < frameHeaderBytes+frameTrailerBytes {
		return nil, nil, fmt.Errorf("%w: too short (%d bytes)", ErrCorruptFrameIndex, len(buf))
	}
	if string(buf[0:4]) != frameIndexMagic {
		return nil, nil, fmt.Errorf("%w: bad magic", ErrCorruptFrameIndex)
	}
	ver := binary.LittleEndian.Uint32(buf[4:8])
	if ver != frameIndexVersion {
		return nil, nil, fmt.Errorf("%w: unsupported version %d", ErrCorruptFrameIndex, ver)
	}
	turnCount := int(binary.LittleEndian.Uint32(buf[8:12]))
	diffCount := int(binary.LittleEndian.Uint32(buf[12:16]))
	expectedLen := frameHeaderBytes + (turnCount+diffCount)*frameEntryBytes + frameTrailerBytes
	if len(buf) != expectedLen {
		return nil, nil, fmt.Errorf("%w: size mismatch got %d want %d", ErrCorruptFrameIndex, len(buf), expectedLen)
	}
	bodyEnd := len(buf) - frameTrailerBytes
	wantCRC := binary.LittleEndian.Uint32(buf[bodyEnd:])
	gotCRC := crc32.ChecksumIEEE(buf[:bodyEnd])
	if wantCRC != gotCRC {
		return nil, nil, fmt.Errorf("%w: crc32 mismatch", ErrCorruptFrameIndex)
	}
	pos := frameHeaderBytes
	readSlice := func(n int) []FrameEntry {
		if n == 0 {
			return nil
		}
		out := make([]FrameEntry, n)
		for i := 0; i < n; i++ {
			out[i] = FrameEntry{
				CompOffset: binary.LittleEndian.Uint64(buf[pos : pos+8]),
				CompLen:    binary.LittleEndian.Uint32(buf[pos+8 : pos+12]),
				UncompLen:  binary.LittleEndian.Uint32(buf[pos+12 : pos+16]),
			}
			pos += frameEntryBytes
		}
		return out
	}
	turnFrames := readSlice(turnCount)
	diffFrames := readSlice(diffCount)
	return turnFrames, diffFrames, nil
}

// preadAndDecompressFrame reads strictly [CompOffset, CompOffset+CompLen) from f
// via ReadAt (pread) and decompresses that single Zstandard frame.
func preadAndDecompressFrame(f *os.File, fe FrameEntry, onDecode func()) ([]byte, error) {
	if fe.CompLen == 0 {
		return nil, nil
	}
	comp := make([]byte, fe.CompLen)
	if _, err := f.ReadAt(comp, int64(fe.CompOffset)); err != nil {
		return nil, fmt.Errorf("sessionstore: pread cold frame at %d+%d: %w", fe.CompOffset, fe.CompLen, err)
	}
	dec := acquireZstdDecoder()
	defer releaseZstdDecoder(dec)

	dst := make([]byte, 0, int(fe.UncompLen))
	plain, err := dec.DecodeAll(comp, dst)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCorruptColdFrame, err)
	}
	if uint32(len(plain)) != fe.UncompLen {
		return nil, fmt.Errorf("%w: decoded %d bytes, expected %d", ErrCorruptColdFrame, len(plain), fe.UncompLen)
	}
	if onDecode != nil {
		onDecode()
	}
	return plain, nil
}

// sliceFrameRecord extracts [intraOff, intraOff+byteLen) from a decoded frame.
func sliceFrameRecord(frame []byte, intraOff, byteLen uint32) ([]byte, error) {
	if byteLen == 0 {
		return nil, nil
	}
	end := uint64(intraOff) + uint64(byteLen)
	if end > uint64(len(frame)) {
		return nil, fmt.Errorf("%w: record [%d:%d] out of frame bounds %d", ErrCorruptColdFrame, intraOff, end, len(frame))
	}
	return frame[intraOff:end], nil
}

// compressFileStreamingZstd stream-compresses srcPath to dstPath atomically
// without loading the entire file into memory, preserving modTime on dstPath.
func compressFileStreamingZstd(srcPath, dstPath string, modTime time.Time) error {
	in, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer in.Close()

	dir := filepath.Dir(dstPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".publish-*")
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

	enc := acquireZstdEncoder()
	enc.Reset(tmp)
	_, copyErr := io.Copy(enc, in)
	closeEncErr := enc.Close()
	releaseZstdEncoder(enc)

	if copyErr != nil {
		_ = tmp.Close()
		return copyErr
	}
	if closeEncErr != nil {
		_ = tmp.Close()
		return closeEncErr
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
	if !modTime.IsZero() {
		_ = os.Chtimes(tmpName, modTime, modTime)
	}
	if err := durable.Rename(tmpName, dstPath); err != nil {
		return err
	}
	cleanup = false
	if !modTime.IsZero() {
		_ = os.Chtimes(dstPath, modTime, modTime)
	}
	return nil
}
