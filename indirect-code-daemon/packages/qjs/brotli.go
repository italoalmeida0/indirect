package qjs

import (
	"bytes"
	"compress/flate"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"math/bits"
	"sort"
	"sync"
)

//go:embed brotli_dict.flate
var brotliStaticDictFlate []byte

var (
	brotliStaticDictOnce sync.Once
	brotliStaticDictData []byte
	brotliDictOffsets    [25]int
)

var brotliDictNDBits = [25]uint8{
	0, 0, 0, 0, 10, 10, 11, 11, 10, 10, 10, 10, 10, 9, 9, 8, 7, 7, 8, 7, 7, 6, 6, 5, 5,
}

var brotliTransforms = [121]struct {
	prefix string
	op     uint8
	suffix string
}{
	{"", 0, ""},
	{"", 0, " "},
	{" ", 0, " "},
	{"", 12, ""},
	{"", 10, " "},
	{"", 0, " the "},
	{" ", 0, ""},
	{"s ", 0, " "},
	{"", 0, " of "},
	{"", 10, ""},
	{"", 0, " and "},
	{"", 13, ""},
	{"", 1, ""},
	{", ", 0, " "},
	{"", 0, ", "},
	{" ", 10, " "},
	{"", 0, " in "},
	{"", 0, " to "},
	{"e ", 0, " "},
	{"", 0, "\""},
	{"", 0, "."},
	{"", 0, "\">"},
	{"", 0, "\n"},
	{"", 3, ""},
	{"", 0, "]"},
	{"", 0, " for "},
	{"", 14, ""},
	{"", 2, ""},
	{"", 0, " a "},
	{"", 0, " that "},
	{" ", 10, ""},
	{"", 0, ". "},
	{".", 0, ""},
	{" ", 0, ", "},
	{"", 15, ""},
	{"", 0, " with "},
	{"", 0, "'"},
	{"", 0, " from "},
	{"", 0, " by "},
	{"", 16, ""},
	{"", 17, ""},
	{" the ", 0, ""},
	{"", 4, ""},
	{"", 0, ". The "},
	{"", 11, ""},
	{"", 0, " on "},
	{"", 0, " as "},
	{"", 0, " is "},
	{"", 7, ""},
	{"", 1, "ing "},
	{"", 0, "\n\t"},
	{"", 0, ":"},
	{" ", 0, ". "},
	{"", 0, "ed "},
	{"", 20, ""},
	{"", 18, ""},
	{"", 6, ""},
	{"", 0, "("},
	{"", 10, ", "},
	{"", 8, ""},
	{"", 0, " at "},
	{"", 0, "ly "},
	{" the ", 0, " of "},
	{"", 5, ""},
	{"", 9, ""},
	{" ", 10, ", "},
	{"", 10, "\""},
	{".", 0, "("},
	{"", 11, " "},
	{"", 10, "\">"},
	{"", 0, "=\""},
	{" ", 0, "."},
	{".com/", 0, ""},
	{" the ", 0, " of the "},
	{"", 10, "'"},
	{"", 0, ". This "},
	{"", 0, ","},
	{".", 0, " "},
	{"", 10, "("},
	{"", 10, "."},
	{"", 0, " not "},
	{" ", 0, "=\""},
	{"", 0, "er "},
	{" ", 11, " "},
	{"", 0, "al "},
	{" ", 11, ""},
	{"", 0, "='"},
	{"", 11, "\""},
	{"", 10, ". "},
	{" ", 0, "("},
	{"", 0, "ful "},
	{" ", 10, ". "},
	{"", 0, "ive "},
	{"", 0, "less "},
	{"", 11, "'"},
	{"", 0, "est "},
	{" ", 10, "."},
	{"", 11, "\">"},
	{" ", 0, "='"},
	{"", 10, ","},
	{"", 0, "ize "},
	{"", 11, "."},
	{"\xc2\xa0", 0, ""},
	{" ", 0, ","},
	{"", 10, "=\""},
	{"", 11, "=\""},
	{"", 0, "ous "},
	{"", 11, ", "},
	{"", 10, "='"},
	{" ", 10, ","},
	{" ", 11, "=\""},
	{" ", 11, ", "},
	{"", 11, ","},
	{"", 11, "("},
	{"", 11, ". "},
	{" ", 11, "."},
	{"", 11, "='"},
	{" ", 11, ". "},
	{" ", 10, "=\""},
	{" ", 11, "='"},
	{" ", 10, "='"},
}

func getBrotliStaticDict() []byte {
	brotliStaticDictOnce.Do(func() {
		fr := flate.NewReader(bytes.NewReader(brotliStaticDictFlate))
		defer fr.Close()
		b, err := io.ReadAll(fr)
		if err == nil && len(b) == 122784 {
			brotliStaticDictData = b
		}
		off := 0
		for l := 4; l <= 24; l++ {
			brotliDictOffsets[l] = off
			off += l * (1 << brotliDictNDBits[l])
		}
	})
	return brotliStaticDictData
}

func brotliUppercaseChar(p []byte, i int) int {
	if p[i] < 192 {
		if p[i] >= 'a' && p[i] <= 'z' {
			p[i] ^= 32
		}
		return 1
	}
	if p[i] < 224 {
		if i+1 < len(p) {
			p[i+1] ^= 32
		}
		return 2
	}
	if i+2 < len(p) {
		p[i+2] ^= 5
	}
	return 3
}

func brotliLookupStaticDict(copyLen int, wordIdx int) ([]byte, error) {
	if copyLen < 4 || copyLen > 24 || wordIdx < 0 {
		return nil, errBrotliCorrupt
	}
	dict := getBrotliStaticDict()
	if len(dict) != 122784 {
		return nil, errBrotliCorrupt
	}
	ndbits := brotliDictNDBits[copyLen]
	nwords := 1 << ndbits
	wordID := wordIdx & (nwords - 1)
	transformID := wordIdx >> ndbits
	if transformID < 0 || transformID >= len(brotliTransforms) {
		return nil, errBrotliCorrupt
	}
	off := brotliDictOffsets[copyLen] + wordID*copyLen
	if off < 0 || off+copyLen > len(dict) {
		return nil, errBrotliCorrupt
	}
	base := dict[off : off+copyLen]
	tr := brotliTransforms[transformID]
	var mid []byte
	op := tr.op
	switch {
	case op == 0:
		mid = base
	case op >= 1 && op <= 9:
		k := int(op)
		if len(base) > k {
			mid = base[:len(base)-k]
		}
	case op >= 12 && op <= 20:
		k := int(op - 11)
		if len(base) > k {
			mid = base[k:]
		}
	case op == 10:
		mid = append([]byte(nil), base...)
		if len(mid) > 0 {
			brotliUppercaseChar(mid, 0)
		}
	case op == 11:
		mid = append([]byte(nil), base...)
		for i := 0; i < len(mid); {
			i += brotliUppercaseChar(mid, i)
		}
	default:
		return nil, errBrotliCorrupt
	}
	res := make([]byte, 0, len(tr.prefix)+len(mid)+len(tr.suffix))
	res = append(res, tr.prefix...)
	res = append(res, mid...)
	res = append(res, tr.suffix...)
	return res, nil
}

var errBrotliCorrupt = errors.New("Decompression failed")

type brotliBitWriter struct {
	buf   []byte
	acc   uint64
	nbits uint
}

func (w *brotliBitWriter) writeBits(val uint32, n uint) {
	w.acc |= (uint64(val) & ((1 << n) - 1)) << w.nbits
	w.nbits += n
	for w.nbits >= 8 {
		w.buf = append(w.buf, byte(w.acc&0xff))
		w.acc >>= 8
		w.nbits -= 8
	}
}

func (w *brotliBitWriter) alignToByte() {
	if w.nbits > 0 {
		w.buf = append(w.buf, byte(w.acc&0xff))
		w.acc = 0
		w.nbits = 0
	}
}

func (w *brotliBitWriter) writeBytes(b []byte) {
	w.alignToByte()
	w.buf = append(w.buf, b...)
}

type brotliEncTree struct {
	codes   []uint32
	lengths []uint8
}

func buildBrotliEncLengths(freqs []int, maxBits uint8) ([]uint8, int) {
	n := len(freqs)
	lengths := make([]uint8, n)
	type symFreq struct {
		sym  int
		freq int
	}
	var active []symFreq
	totalFreq := 0
	for s, f := range freqs {
		if f > 0 {
			active = append(active, symFreq{sym: s, freq: f})
			totalFreq += f
		}
	}
	if len(active) <= 1 {
		if len(active) == 1 {
			lengths[active[0].sym] = 0
		}
		return lengths, len(active)
	}
	sort.Slice(active, func(i, j int) bool {
		if active[i].freq != active[j].freq {
			return active[i].freq > active[j].freq
		}
		return active[i].sym < active[j].sym
	})
	fullSpace := 1 << maxBits
	sum := 0
	for _, sf := range active {
		ratio := totalFreq / sf.freq
		l := uint8(bits.Len(uint(ratio)))
		if l < 1 {
			l = 1
		}
		if l > maxBits {
			l = maxBits
		}
		lengths[sf.sym] = l
		sum += fullSpace >> l
	}
	for sum > fullSpace {
		changed := false
		for i := len(active) - 1; i >= 0 && sum > fullSpace; i-- {
			s := active[i].sym
			if lengths[s] < maxBits {
				oldW := fullSpace >> lengths[s]
				lengths[s]++
				newW := fullSpace >> lengths[s]
				sum -= oldW - newW
				changed = true
			}
		}
		if !changed {
			break
		}
	}
	for sum < fullSpace {
		rem := fullSpace - sum
		bestIdx := -1
		bestWeight := 0
		for i := 0; i < len(active); i++ {
			s := active[i].sym
			if lengths[s] > 1 {
				w := fullSpace >> lengths[s]
				if w <= rem && w > bestWeight {
					bestWeight = w
					bestIdx = i
				}
			}
		}
		if bestIdx < 0 {
			break
		}
		s := active[bestIdx].sym
		lengths[s]--
		sum += bestWeight
	}
	return lengths, len(active)
}

func makeBrotliEncTree(lengths []uint8) *brotliEncTree {
	var count [16]int
	nonZero := 0
	for _, l := range lengths {
		if l > 0 {
			count[l]++
			nonZero++
		}
	}
	codes := make([]uint32, len(lengths))
	if nonZero <= 1 {
		return &brotliEncTree{codes: codes, lengths: make([]uint8, len(lengths))}
	}
	var nextCode [16]uint32
	code := uint32(0)
	for b := 1; b <= 15; b++ {
		code = (code + uint32(count[b-1])) << 1
		nextCode[b] = code
	}
	for sym, l := range lengths {
		if l == 0 {
			continue
		}
		c := nextCode[l]
		nextCode[l]++
		rev := uint32(0)
		for i := uint8(0); i < l; i++ {
			if (c & (1 << (l - 1 - i))) != 0 {
				rev |= 1 << i
			}
		}
		codes[sym] = rev
	}
	return &brotliEncTree{codes: codes, lengths: lengths}
}

func (t *brotliEncTree) writeSymbol(w *brotliBitWriter, sym int) {
	l := t.lengths[sym]
	if l > 0 {
		w.writeBits(t.codes[sym], uint(l))
	}
}

func writeBrotliPrefixCode(w *brotliBitWriter, freqs []int, alphabetSize int) *brotliEncTree {
	alphabetBits := uint(0)
	for (1 << alphabetBits) < alphabetSize {
		alphabetBits++
	}
	var active []int
	for s := 0; s < alphabetSize; s++ {
		if s < len(freqs) && freqs[s] > 0 {
			active = append(active, s)
		}
	}
	if len(active) == 0 {
		active = []int{0}
	}
	if len(active) <= 4 {
		sort.Slice(active, func(i, j int) bool {
			if freqs[active[i]] != freqs[active[j]] {
				return freqs[active[i]] > freqs[active[j]]
			}
			return active[i] < active[j]
		})
		nsym := len(active)
		lengths := make([]uint8, alphabetSize)
		switch nsym {
		case 1:
			// single symbol: length 0
		case 2:
			if active[0] > active[1] {
				active[0], active[1] = active[1], active[0]
			}
			lengths[active[0]] = 1
			lengths[active[1]] = 1
		case 3:
			if active[1] > active[2] {
				active[1], active[2] = active[2], active[1]
			}
			lengths[active[0]] = 1
			lengths[active[1]] = 2
			lengths[active[2]] = 2
		case 4:
			sort.Ints(active)
			lengths[active[0]] = 2
			lengths[active[1]] = 2
			lengths[active[2]] = 2
			lengths[active[3]] = 2
		}
		// HSKIP = 1 (simple prefix code)
		w.writeBits(1, 2)
		w.writeBits(uint32(nsym-1), 2)
		for _, s := range active {
			w.writeBits(uint32(s), alphabetBits)
		}
		if nsym == 4 {
			w.writeBits(0, 1) // treeSelect = 0 (all lengths 2)
		}
		return makeBrotliEncTree(lengths)
	}

	lengths, _ := buildBrotliEncLengths(freqs, 15)
	lastNonZero := 0
	for s, l := range lengths {
		if l > 0 {
			lastNonZero = s
		}
	}
	var clFreqs [18]int
	for s := 0; s <= lastNonZero; s++ {
		clFreqs[lengths[s]]++
	}
	clLengthsSlice, clActive := buildBrotliEncLengths(clFreqs[:], 5)
	if clActive == 1 {
		for s, f := range clFreqs {
			if f > 0 {
				clLengthsSlice[s] = 1
				break
			}
		}
	}
	clTree := makeBrotliEncTree(clLengthsSlice)

	// HSKIP = 0 (complex prefix code, RFC 7932 Section 3.5)
	w.writeBits(0, 2)
	codeLengthOrder := [18]int{1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15}
	space := 32
	for i := 0; i < 18 && space > 0; i++ {
		sym := codeLengthOrder[i]
		v := clLengthsSlice[sym]
		switch v {
		case 0:
			w.writeBits(0b00, 2)
		case 1:
			w.writeBits(0b0111, 4)
		case 2:
			w.writeBits(0b011, 3)
		case 3:
			w.writeBits(0b10, 2)
		case 4:
			w.writeBits(0b01, 2)
		case 5:
			w.writeBits(0b1111, 4)
		}
		if v != 0 {
			space -= 32 >> v
		}
	}
	symSpace := 32768
	for s := 0; s <= lastNonZero && symSpace > 0; s++ {
		l := lengths[s]
		clTree.writeSymbol(w, int(l))
		if l != 0 {
			symSpace -= 32768 >> l
		}
	}
	return makeBrotliEncTree(lengths)
}

func encodeBrotliInsertCode(length int) (int, uint32) {
	for i := 23; i >= 0; i-- {
		if length >= brotliInsertBase[i] {
			return i, uint32(length - brotliInsertBase[i])
		}
	}
	return 0, 0
}

func encodeBrotliCopyCode(length int) (int, uint32) {
	for i := 23; i >= 0; i-- {
		if length >= brotliCopyBase[i] {
			return i, uint32(length - brotliCopyBase[i])
		}
	}
	return 0, 0
}

func encodeBrotliICCode(insIdx, copyIdx int, useLastDist bool) int {
	var rangeIdx int
	if useLastDist && insIdx < 8 && copyIdx < 16 {
		if copyIdx < 8 {
			rangeIdx = 0
		} else {
			rangeIdx = 1
		}
	} else {
		switch {
		case insIdx < 8 && copyIdx < 8:
			rangeIdx = 2
		case insIdx < 8 && copyIdx < 16:
			rangeIdx = 3
		case insIdx < 16 && copyIdx < 8:
			rangeIdx = 4
		case insIdx < 16 && copyIdx < 16:
			rangeIdx = 5
		case insIdx < 8 && copyIdx >= 16:
			rangeIdx = 6
		case insIdx >= 16 && copyIdx < 8:
			rangeIdx = 7
		case insIdx < 16 && copyIdx >= 16:
			rangeIdx = 8
		case insIdx >= 16 && copyIdx < 16:
			rangeIdx = 9
		default:
			rangeIdx = 10
		}
	}
	return (rangeIdx << 6) | ((insIdx & 7) << 3) | (copyIdx & 7)
}

func encodeBrotliDistance(dist int, distRing *[4]int) (int, uint32, uint) {
	for i := 0; i < 4; i++ {
		if dist == distRing[i] {
			if i != 0 {
				distRing[3] = distRing[2]
				distRing[2] = distRing[1]
				distRing[1] = distRing[0]
				distRing[0] = dist
			}
			return i, 0, 0
		}
	}
	m := uint32(dist + 3)
	msb := uint(bits.Len32(m) - 1)
	ndistbits := msb - 1
	hbit := (m >> ndistbits) & 1
	hcode := ((int(ndistbits) - 1) << 1) | int(hbit)
	ds := 16 + hcode
	dextra := m & ((1 << ndistbits) - 1)
	distRing[3] = distRing[2]
	distRing[2] = distRing[1]
	distRing[1] = distRing[0]
	distRing[0] = dist
	return ds, dextra, ndistbits
}

func brotliCompressBlock(data []byte) []byte {
	type lzCmd struct {
		lits     []byte
		insIdx   int
		insExtra uint32
		copyLen  int
		copyIdx  int
		copyEx   uint32
		icSym    int
		useLast  bool
		distSym  int
		distEx   uint32
		distBits uint
	}

	const hashBits = 14
	var hashTable [1 << hashBits]int
	for i := range hashTable {
		hashTable[i] = -1
	}
	hash4 := func(b []byte) uint32 {
		v := uint32(b[0]) | (uint32(b[1]) << 8) | (uint32(b[2]) << 16) | (uint32(b[3]) << 24)
		return (v * 0x1e35a7bd) >> (32 - hashBits)
	}

	distRing := [4]int{4, 11, 15, 16}
	var cmds []lzCmd
	litStart := 0
	pos := 0
	n := len(data)
	for pos+4 <= n {
		h := hash4(data[pos:])
		cand := hashTable[h]
		hashTable[h] = pos
		if cand >= 0 && pos-cand <= (1<<20) &&
			data[cand] == data[pos] &&
			data[cand+1] == data[pos+1] &&
			data[cand+2] == data[pos+2] &&
			data[cand+3] == data[pos+3] {
			matchLen := 4
			for pos+matchLen < n && data[cand+matchLen] == data[pos+matchLen] {
				matchLen++
			}
			lits := data[litStart:pos]
			insIdx, insExtra := encodeBrotliInsertCode(len(lits))
			copyIdx, copyEx := encodeBrotliCopyCode(matchLen)
			dist := pos - cand
			useLast := dist == distRing[0] && insIdx < 8 && copyIdx < 16
			icSym := encodeBrotliICCode(insIdx, copyIdx, useLast)
			distSym := 0
			var distEx uint32
			var distBits uint
			if !useLast {
				distSym, distEx, distBits = encodeBrotliDistance(dist, &distRing)
			}
			cmds = append(cmds, lzCmd{
				lits:     lits,
				insIdx:   insIdx,
				insExtra: insExtra,
				copyLen:  matchLen,
				copyIdx:  copyIdx,
				copyEx:   copyEx,
				icSym:    icSym,
				useLast:  useLast,
				distSym:  distSym,
				distEx:   distEx,
				distBits: distBits,
			})
			for k := 1; k < matchLen && pos+k+4 <= n; k++ {
				hashTable[hash4(data[pos+k:])] = pos + k
			}
			pos += matchLen
			litStart = pos
			continue
		}
		pos++
	}
	if len(cmds) == 0 {
		return nil
	}
	if litStart < n {
		lits := data[litStart:n]
		insIdx, insExtra := encodeBrotliInsertCode(len(lits))
		copyIdx, copyEx := 0, uint32(0)
		icSym := encodeBrotliICCode(insIdx, copyIdx, false)
		cmds = append(cmds, lzCmd{
			lits:     lits,
			insIdx:   insIdx,
			insExtra: insExtra,
			copyLen:  0,
			copyIdx:  copyIdx,
			copyEx:   copyEx,
			icSym:    icSym,
		})
	}

	litFreqs := make([]int, 256)
	icFreqs := make([]int, 704)
	distFreqs := make([]int, 64)
	for _, c := range cmds {
		for _, b := range c.lits {
			litFreqs[b]++
		}
		icFreqs[c.icSym]++
		if c.copyLen > 0 && !c.useLast {
			if c.distSym >= len(distFreqs) {
				return nil
			}
			distFreqs[c.distSym]++
		}
	}

	var w brotliBitWriter
	// WBITS = 22 (0b1011)
	w.writeBits(0x0b, 4)
	// ISLAST = 1, ISLASTEMPTY = 0
	w.writeBits(1, 1)
	w.writeBits(0, 1)

	mlenM1 := uint32(n - 1)
	switch {
	case mlenM1 < (1 << 16):
		w.writeBits(0, 2)
		w.writeBits(mlenM1, 16)
	case mlenM1 < (1 << 20):
		w.writeBits(1, 2)
		w.writeBits(mlenM1, 20)
	default:
		w.writeBits(2, 2)
		w.writeBits(mlenM1, 24)
	}

	// NBLTYPESL = 1, NBLTYPESI = 1, NBLTYPESD = 1 (each encoded as 0 bit)
	w.writeBits(0, 1)
	w.writeBits(0, 1)
	w.writeBits(0, 1)
	// NPOSTFIX = 0 (2 bits), NDIRECT = 0 (4 bits)
	w.writeBits(0, 2)
	w.writeBits(0, 4)
	// Context mode for literal block type 0 = 0 (LSB6, 2 bits)
	w.writeBits(0, 2)
	// NTREESL = 1 (1 bit 0), NTREESD = 1 (1 bit 0)
	w.writeBits(0, 1)
	w.writeBits(0, 1)

	litTree := writeBrotliPrefixCode(&w, litFreqs, 256)
	icTree := writeBrotliPrefixCode(&w, icFreqs, 704)
	distTree := writeBrotliPrefixCode(&w, distFreqs, 64)

	for _, c := range cmds {
		icTree.writeSymbol(&w, c.icSym)
		if brotliInsertExtra[c.insIdx] > 0 {
			w.writeBits(c.insExtra, brotliInsertExtra[c.insIdx])
		}
		if brotliCopyExtra[c.copyIdx] > 0 {
			w.writeBits(c.copyEx, brotliCopyExtra[c.copyIdx])
		}
		for _, b := range c.lits {
			litTree.writeSymbol(&w, int(b))
		}
		if c.copyLen > 0 && !c.useLast {
			distTree.writeSymbol(&w, c.distSym)
			if c.distBits > 0 {
				w.writeBits(c.distEx, c.distBits)
			}
		}
	}
	w.alignToByte()
	return w.buf
}

// brotliCompress encodes data into a valid RFC 7932 Brotli stream.
// It uses LZ77 + prefix-code compressed meta-blocks when that produces a smaller
// stream, falling back to uncompressed meta-blocks for short or incompressible data.
func brotliCompress(data []byte) []byte {
	var w brotliBitWriter
	// WBITS = 22 -> 1 followed by 101 (5 = 22 - 17), LSB-first = 0b1011 = 0x0b
	w.writeBits(0x0b, 4)

	rem := data
	for len(rem) > 0 {
		chunkLen := len(rem)
		if chunkLen > 65536 {
			chunkLen = 65536
		}
		chunk := rem[:chunkLen]
		rem = rem[chunkLen:]

		// ISLAST = 0 (1 bit)
		w.writeBits(0, 1)
		// MNIBBLES = 00 -> 4 nibbles (16 bits)
		w.writeBits(0, 2)
		// MLEN - 1 (16 bits)
		w.writeBits(uint32(chunkLen-1), 16)
		// ISUNCOMPRESSED = 1 (1 bit)
		w.writeBits(1, 1)
		// Align to byte boundary and write raw literal bytes
		w.writeBytes(chunk)
	}

	// Final empty meta-block: ISLAST = 1 (1 bit), ISLASTEMPTY = 1 (1 bit)
	w.writeBits(3, 2)
	w.alignToByte()
	rawOut := w.buf

	if len(data) >= 16 && len(data) <= (1<<20) {
		if comp := brotliCompressBlock(data); len(comp) > 0 && len(comp) < len(rawOut) {
			if dec, _, err := brotliDecompress(comp, int64(len(data))+64); err == nil && len(dec) == len(data) {
				return comp
			}
		}
	}
	return rawOut
}

type brotliBitReader struct {
	data    []byte
	bytePos int
	bitPos  uint
}

func (r *brotliBitReader) readBits(n uint) (uint32, error) {
	var out uint32
	for shift := uint(0); shift < n; {
		if r.bytePos >= len(r.data) {
			return 0, errBrotliCorrupt
		}
		avail := 8 - r.bitPos
		take := n - shift
		if take > avail {
			take = avail
		}
		mask := uint32((1 << take) - 1)
		bits := (uint32(r.data[r.bytePos]) >> r.bitPos) & mask
		out |= bits << shift
		shift += take
		r.bitPos += take
		if r.bitPos == 8 {
			r.bitPos = 0
			r.bytePos++
		}
	}
	return out, nil
}

func (r *brotliBitReader) alignToByte() error {
	if r.bitPos == 0 {
		return nil
	}
	rem := 8 - r.bitPos
	pad, err := r.readBits(rem)
	if err != nil {
		return err
	}
	if pad != 0 {
		return errBrotliCorrupt
	}
	return nil
}

func (r *brotliBitReader) readAlignedBytes(n int) ([]byte, error) {
	if err := r.alignToByte(); err != nil {
		return nil, err
	}
	if n < 0 || r.bytePos+n > len(r.data) {
		return nil, errBrotliCorrupt
	}
	slice := r.data[r.bytePos : r.bytePos+n]
	r.bytePos += n
	return slice, nil
}

type brotliHuffmanTree struct {
	maxLen  uint
	entries map[uint32]uint16 // key: (length << 16) | bitReversedCode
	single  int               // >= 0 if single-symbol tree
}

func buildBrotliHuffman(lengths []uint8) (*brotliHuffmanTree, error) {
	var count [16]int
	maxLen := uint(0)
	nonZero := 0
	lastSym := 0
	for sym, l := range lengths {
		if l > 15 {
			return nil, errBrotliCorrupt
		}
		if l > 0 {
			count[l]++
			nonZero++
			lastSym = sym
			if uint(l) > maxLen {
				maxLen = uint(l)
			}
		}
	}
	if nonZero == 0 {
		return nil, errBrotliCorrupt
	}
	if nonZero == 1 {
		return &brotliHuffmanTree{single: lastSym}, nil
	}
	// Verify Kraft inequality (complete prefix code)
	space := 1 << 15
	for l := 1; l <= 15; l++ {
		space -= count[l] << (15 - l)
	}
	if space != 0 {
		return nil, errBrotliCorrupt
	}
	var nextCode [16]uint32
	code := uint32(0)
	for bits := 1; bits <= 15; bits++ {
		code = (code + uint32(count[bits-1])) << 1
		nextCode[bits] = code
	}
	entries := make(map[uint32]uint16, nonZero)
	for sym, l := range lengths {
		if l == 0 {
			continue
		}
		c := nextCode[l]
		nextCode[l]++
		// Reverse bits for LSB-first reading
		rev := uint32(0)
		for i := uint8(0); i < l; i++ {
			if (c & (1 << (l - 1 - i))) != 0 {
				rev |= 1 << i
			}
		}
		key := (uint32(l) << 16) | rev
		entries[key] = uint16(sym)
	}
	return &brotliHuffmanTree{
		maxLen:  maxLen,
		entries: entries,
		single:  -1,
	}, nil
}

func (t *brotliHuffmanTree) decode(r *brotliBitReader) (int, error) {
	if t.single >= 0 {
		return t.single, nil
	}
	code := uint32(0)
	for l := uint(1); l <= t.maxLen; l++ {
		b, err := r.readBits(1)
		if err != nil {
			return 0, err
		}
		code |= b << (l - 1)
		if sym, ok := t.entries[(uint32(l)<<16)|code]; ok {
			return int(sym), nil
		}
	}
	return 0, errBrotliCorrupt
}

func readBrotliPrefixCode(r *brotliBitReader, alphabetSize int) (*brotliHuffmanTree, error) {
	if alphabetSize <= 0 {
		return nil, errBrotliCorrupt
	}
	alphabetBits := uint(0)
	for (1 << alphabetBits) < alphabetSize {
		alphabetBits++
	}
	hskip, err := r.readBits(2)
	if err != nil {
		return nil, err
	}
	if hskip == 1 {
		// Simple prefix code
		nsym, err := r.readBits(2)
		if err != nil {
			return nil, err
		}
		nsym++
		syms := make([]int, nsym)
		seen := make(map[int]bool, nsym)
		for i := uint32(0); i < nsym; i++ {
			s, err := r.readBits(alphabetBits)
			if err != nil {
				return nil, err
			}
			if int(s) >= alphabetSize || seen[int(s)] {
				return nil, errBrotliCorrupt
			}
			seen[int(s)] = true
			syms[i] = int(s)
		}
		lengths := make([]uint8, alphabetSize)
		switch nsym {
		case 1:
			return &brotliHuffmanTree{single: syms[0]}, nil
		case 2:
			lengths[syms[0]] = 1
			lengths[syms[1]] = 1
		case 3:
			lengths[syms[0]] = 1
			lengths[syms[1]] = 2
			lengths[syms[2]] = 2
		case 4:
			treeSelect, err := r.readBits(1)
			if err != nil {
				return nil, err
			}
			if treeSelect == 0 {
				lengths[syms[0]] = 2
				lengths[syms[1]] = 2
				lengths[syms[2]] = 2
				lengths[syms[3]] = 2
			} else {
				lengths[syms[0]] = 1
				lengths[syms[1]] = 2
				lengths[syms[2]] = 3
				lengths[syms[3]] = 3
			}
		}
		return buildBrotliHuffman(lengths)
	}

	// Complex prefix code (RFC 7932 Section 3.5)
	codeLengthOrder := [18]int{1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15}
	var clLengths [18]uint8
	space := 32
	numCodes := 0
	for i := int(hskip); i < 18 && space > 0; i++ {
		sym := codeLengthOrder[i]
		// Fixed Huffman code for code-length code lengths (RFC 7932 Section 3.5, read LSB-first):
		// 0 -> 00   (b0=0, b1=0)
		// 3 -> 01   (b0=0, b1=1) [value 0b10]
		// 4 -> 10   (b0=1, b1=0) [value 0b01]
		// 2 -> 110  (b0=1, b1=1, b2=0) [value 0b011]
		// 1 -> 1110 (b0=1, b1=1, b2=1, b3=0) [value 0b0111]
		// 5 -> 1111 (b0=1, b1=1, b2=1, b3=1) [value 0b1111]
		b0, err := r.readBits(1)
		if err != nil {
			return nil, err
		}
		var v uint8
		if b0 == 0 {
			b1, err := r.readBits(1)
			if err != nil {
				return nil, err
			}
			if b1 == 0 {
				v = 0
			} else {
				v = 3
			}
		} else {
			b1, err := r.readBits(1)
			if err != nil {
				return nil, err
			}
			if b1 == 0 {
				v = 4
			} else {
				b2, err := r.readBits(1)
				if err != nil {
					return nil, err
				}
				if b2 == 0 {
					v = 2
				} else {
					b3, err := r.readBits(1)
					if err != nil {
						return nil, err
					}
					if b3 == 0 {
						v = 1
					} else {
						v = 5
					}
				}
			}
		}
		clLengths[sym] = v
		if v != 0 {
			space -= 32 >> v
			numCodes++
		}
	}
	if space != 0 && numCodes != 1 {
		return nil, errBrotliCorrupt
	}
	clTree, err := buildBrotliHuffman(clLengths[:])
	if err != nil {
		return nil, err
	}

	lengths := make([]uint8, alphabetSize)
	symbol := 0
	prevLen := uint8(8)
	repeat := 0
	repeatLen := uint8(0)
	symSpace := 32768
	for symbol < alphabetSize && symSpace > 0 {
		codeLen, err := clTree.decode(r)
		if err != nil {
			return nil, err
		}
		if codeLen < 16 {
			repeat = 0
			lengths[symbol] = uint8(codeLen)
			symbol++
			if codeLen != 0 {
				prevLen = uint8(codeLen)
				symSpace -= 32768 >> codeLen
			}
		} else {
			extraBits := uint(2)
			newLen := prevLen
			if codeLen == 17 {
				extraBits = 3
				newLen = 0
			}
			if repeatLen != newLen {
				repeat = 0
				repeatLen = newLen
			}
			oldRepeat := repeat
			if repeat > 0 {
				repeat = (repeat - 2) << extraBits
			}
			eb, err := r.readBits(extraBits)
			if err != nil {
				return nil, err
			}
			repeat += int(eb) + 3
			delta := repeat - oldRepeat
			if symbol+delta > alphabetSize {
				return nil, errBrotliCorrupt
			}
			for k := 0; k < delta; k++ {
				lengths[symbol] = repeatLen
				symbol++
				if repeatLen != 0 {
					symSpace -= 32768 >> repeatLen
				}
			}
		}
	}
	if symSpace != 0 {
		return nil, errBrotliCorrupt
	}
	return buildBrotliHuffman(lengths)
}

var brotliInsertBase = [24]int{
	0, 1, 2, 3, 4, 5, 6, 8, 10, 14, 18, 26, 34, 50, 66, 98, 130, 194, 322, 578, 1090, 2114, 6210, 22594,
}
var brotliInsertExtra = [24]uint{
	0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10, 12, 14, 24,
}
var brotliCopyBase = [24]int{
	2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 18, 22, 30, 38, 54, 70, 102, 134, 198, 326, 582, 1094, 2118,
}
var brotliCopyExtra = [24]uint{
	0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10, 24,
}

func decodeBrotliInsertCopyCode(icCode int) (insertIdx int, copyIdx int, useLastDist bool, err error) {
	if icCode < 0 || icCode >= 704 {
		return 0, 0, false, errBrotliCorrupt
	}
	rangeIdx := icCode >> 6
	rem := icCode & 63
	insertSub := (rem >> 3) & 7
	copySub := rem & 7
	var insOff, copyOff int
	switch rangeIdx {
	case 0:
		insOff, copyOff, useLastDist = 0, 0, true
	case 1:
		insOff, copyOff, useLastDist = 0, 8, true
	case 2:
		insOff, copyOff, useLastDist = 0, 0, false
	case 3:
		insOff, copyOff, useLastDist = 0, 8, false
	case 4:
		insOff, copyOff, useLastDist = 8, 0, false
	case 5:
		insOff, copyOff, useLastDist = 8, 8, false
	case 6:
		insOff, copyOff, useLastDist = 0, 16, false
	case 7:
		insOff, copyOff, useLastDist = 16, 0, false
	case 8:
		insOff, copyOff, useLastDist = 8, 16, false
	case 9:
		insOff, copyOff, useLastDist = 16, 8, false
	case 10:
		insOff, copyOff, useLastDist = 16, 16, false
	default:
		return 0, 0, false, errBrotliCorrupt
	}
	return insOff + insertSub, copyOff + copySub, useLastDist, nil
}

var brotliBlockLenBase = [26]int{
	1, 5, 9, 13, 17, 25, 33, 41, 49, 65, 81, 97, 113, 145, 177, 209, 241, 305, 369, 497, 753, 1265, 2289, 4337, 8433, 16625,
}
var brotliBlockLenExtra = [26]uint{
	2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 7, 8, 9, 10, 11, 12, 13, 24,
}

// RFC 7932 Section 7.1 context lookup tables (LUT0, LUT1, LUT2).
var brotliUTF8LUT0 = [256]uint8{
	0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 0, 0, 4, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	8, 12, 16, 12, 12, 20, 12, 16, 24, 28, 12, 12, 32, 12, 36, 12,
	44, 44, 44, 44, 44, 44, 44, 44, 44, 44, 32, 32, 24, 40, 28, 32,
	12, 48, 52, 52, 52, 48, 52, 52, 52, 48, 52, 52, 52, 52, 52, 48,
	52, 52, 52, 52, 52, 48, 52, 52, 52, 52, 52, 24, 12, 28, 12, 12,
	12, 56, 60, 60, 60, 56, 60, 60, 60, 56, 60, 60, 60, 60, 60, 56,
	60, 60, 60, 60, 60, 56, 60, 60, 60, 60, 60, 24, 12, 28, 12, 0,
	0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1,
	0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1,
	0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1,
	0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1,
	2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3,
	2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3,
	2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3,
	2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3,
}

var brotliUTF8LUT1 = [256]uint8{
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
	2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1,
	1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
	2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1,
	1, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
	3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 1, 1, 1, 1, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
	2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
}

var brotliSignedLUT2 = [256]uint8{
	0, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
	3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
	3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
	3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
	4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
	4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
	4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
	4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
	4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
	4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
	4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
	4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
	5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
	5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
	5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
	6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 7, 7, 7, 7,
}

func brotliLitContextID(p1, p2 byte, mode uint8) int {
	switch mode & 3 {
	case 0: // LSB6
		return int(p1 & 0x3f)
	case 1: // MSB6
		return int(p1 >> 2)
	case 2: // UTF8
		return int(brotliUTF8LUT0[p1] | brotliUTF8LUT1[p2])
	default: // Signed
		return int((brotliSignedLUT2[p1] << 3) | brotliSignedLUT2[p2])
	}
}

func readBrotliVarLenUint8(r *brotliBitReader) (int, error) {
	b, err := r.readBits(1)
	if err != nil {
		return 0, err
	}
	if b == 0 {
		return 1, nil
	}
	n, err := r.readBits(3)
	if err != nil {
		return 0, err
	}
	if n == 0 {
		return 2, nil
	}
	v, err := r.readBits(uint(n))
	if err != nil {
		return 0, err
	}
	return (1 << n) + int(v) + 1, nil
}

func decodeBrotliBlockLength(r *brotliBitReader, tree *brotliHuffmanTree) (int, error) {
	code, err := tree.decode(r)
	if err != nil || code < 0 || code >= 26 {
		return 0, errBrotliCorrupt
	}
	extra, err := r.readBits(brotliBlockLenExtra[code])
	if err != nil {
		return 0, err
	}
	return brotliBlockLenBase[code] + int(extra), nil
}

type brotliBlockSwitch struct {
	numTypes int
	btTree   *brotliHuffmanTree
	blTree   *brotliHuffmanTree
	curType  int
	prevType int
	remLen   int
}

func readBrotliBlockSwitch(r *brotliBitReader) (*brotliBlockSwitch, error) {
	numTypes, err := readBrotliVarLenUint8(r)
	if err != nil {
		return nil, err
	}
	bs := &brotliBlockSwitch{
		numTypes: numTypes,
		curType:  0,
		prevType: 1,
		remLen:   1 << 30,
	}
	if numTypes >= 2 {
		btTree, err := readBrotliPrefixCode(r, numTypes+2)
		if err != nil {
			return nil, err
		}
		blTree, err := readBrotliPrefixCode(r, 26)
		if err != nil {
			return nil, err
		}
		remLen, err := decodeBrotliBlockLength(r, blTree)
		if err != nil {
			return nil, err
		}
		bs.btTree = btTree
		bs.blTree = blTree
		bs.remLen = remLen
	}
	return bs, nil
}

func (bs *brotliBlockSwitch) step(r *brotliBitReader) error {
	if bs.numTypes < 2 {
		return nil
	}
	if bs.remLen == 0 {
		code, err := bs.btTree.decode(r)
		if err != nil {
			return err
		}
		var nextType int
		switch code {
		case 0:
			nextType = bs.prevType
		case 1:
			nextType = (bs.curType + 1) % bs.numTypes
		default:
			nextType = code - 2
			if nextType >= bs.numTypes {
				return errBrotliCorrupt
			}
		}
		bs.prevType = bs.curType
		bs.curType = nextType
		remLen, err := decodeBrotliBlockLength(r, bs.blTree)
		if err != nil {
			return err
		}
		bs.remLen = remLen
	}
	bs.remLen--
	return nil
}

func readBrotliContextMap(r *brotliBitReader, mapSize int) (int, []uint8, error) {
	ntrees, err := readBrotliVarLenUint8(r)
	if err != nil {
		return 0, nil, err
	}
	cmap := make([]uint8, mapSize)
	if ntrees < 2 {
		return 1, cmap, nil
	}
	useRLE, err := r.readBits(1)
	if err != nil {
		return 0, nil, err
	}
	rleMax := 0
	if useRLE == 1 {
		v, err := r.readBits(4)
		if err != nil {
			return 0, nil, err
		}
		rleMax = int(v) + 1
	}
	cmTree, err := readBrotliPrefixCode(r, ntrees+rleMax)
	if err != nil {
		return 0, nil, err
	}
	for i := 0; i < mapSize; {
		sym, err := cmTree.decode(r)
		if err != nil {
			return 0, nil, err
		}
		if sym == 0 {
			cmap[i] = 0
			i++
		} else if sym <= rleMax {
			eb, err := r.readBits(uint(sym))
			if err != nil {
				return 0, nil, err
			}
			reps := (1 << sym) + int(eb)
			if i+reps > mapSize {
				return 0, nil, errBrotliCorrupt
			}
			for k := 0; k < reps; k++ {
				cmap[i] = 0
				i++
			}
		} else {
			cmap[i] = uint8(sym - rleMax)
			i++
		}
	}
	imtf, err := r.readBits(1)
	if err != nil {
		return 0, nil, err
	}
	if imtf == 1 {
		var mtf [256]uint8
		for i := range 256 {
			mtf[i] = uint8(i)
		}
		for i, idx := range cmap {
			val := mtf[idx]
			cmap[i] = val
			for j := int(idx); j > 0; j-- {
				mtf[j] = mtf[j-1]
			}
			mtf[0] = val
		}
	}
	return ntrees, cmap, nil
}

// brotliDecompress decodes an RFC 7932 Brotli stream, enforcing maxOut.
func brotliDecompress(data []byte, maxOut int64) ([]byte, string, error) {
	if len(data) == 0 {
		return nil, "ERR_INVALID_ARG_VALUE", errBrotliCorrupt
	}
	r := &brotliBitReader{data: data}

	// 1. Read WBITS (RFC 7932 Section 9.1)
	b0, err := r.readBits(1)
	if err != nil {
		return nil, "ERR_INVALID_ARG_VALUE", err
	}
	wbits := uint(16)
	if b0 == 1 {
		n, err := r.readBits(3)
		if err != nil {
			return nil, "ERR_INVALID_ARG_VALUE", err
		}
		if n != 0 {
			wbits = 17 + uint(n)
		} else {
			n2, err := r.readBits(3)
			if err != nil {
				return nil, "ERR_INVALID_ARG_VALUE", err
			}
			if n2 == 1 {
				// Reserved value -> invalid stream
				return nil, "ERR_INVALID_ARG_VALUE", errBrotliCorrupt
			}
			if n2 != 0 {
				wbits = 8 + uint(n2)
			} else {
				wbits = 17
			}
		}
	}
	maxWindow := (1 << wbits) - 16
	// RFC 7932 Section 4: ring buffer of last four distances is initialized to 4, 11, 15, 16
	// (where distRing[0] = 4 is the last distance).
	distRing := [4]int{4, 11, 15, 16}
	var out []byte

	for {
		isLast, err := r.readBits(1)
		if err != nil {
			return nil, "ERR_INVALID_ARG_VALUE", err
		}
		if isLast == 1 {
			isLastEmpty, err := r.readBits(1)
			if err != nil {
				return nil, "ERR_INVALID_ARG_VALUE", err
			}
			if isLastEmpty == 1 {
				if err := r.alignToByte(); err != nil {
					return nil, "ERR_INVALID_ARG_VALUE", err
				}
				if r.bytePos != len(r.data) {
					return nil, "ERR_INVALID_ARG_VALUE", errBrotliCorrupt
				}
				return out, "", nil
			}
		}

		mnibbles, err := r.readBits(2)
		if err != nil {
			return nil, "ERR_INVALID_ARG_VALUE", err
		}
		if mnibbles == 3 {
			// Metadata meta-block
			if isLast == 1 {
				return nil, "ERR_INVALID_ARG_VALUE", errBrotliCorrupt
			}
			resBit, err := r.readBits(1)
			if err != nil || resBit != 0 {
				return nil, "ERR_INVALID_ARG_VALUE", errBrotliCorrupt
			}
			mskipBytes, err := r.readBits(2)
			if err != nil {
				return nil, "ERR_INVALID_ARG_VALUE", err
			}
			if mskipBytes == 0 {
				if err := r.alignToByte(); err != nil {
					return nil, "ERR_INVALID_ARG_VALUE", err
				}
				continue
			}
			mlenM1, err := r.readBits(uint(mskipBytes) * 8)
			if err != nil {
				return nil, "ERR_INVALID_ARG_VALUE", err
			}
			if mskipBytes > 1 && (mlenM1>>(uint(mskipBytes-1)*8)) == 0 {
				return nil, "ERR_INVALID_ARG_VALUE", errBrotliCorrupt
			}
			if _, err := r.readAlignedBytes(int(mlenM1) + 1); err != nil {
				return nil, "ERR_INVALID_ARG_VALUE", err
			}
			continue
		}

		nibbles := uint(mnibbles + 4)
		mlenM1, err := r.readBits(nibbles * 4)
		if err != nil {
			return nil, "ERR_INVALID_ARG_VALUE", err
		}
		if nibbles > 4 && (mlenM1>>((nibbles-1)*4)) == 0 {
			return nil, "ERR_INVALID_ARG_VALUE", errBrotliCorrupt
		}
		mlen := int(mlenM1) + 1
		if int64(len(out))+int64(mlen) > maxOut {
			return nil, "ERR_BUFFER_TOO_LARGE", fmt.Errorf("ERR_BUFFER_TOO_LARGE: Cannot create a Buffer larger than %d bytes", maxOut)
		}

		if isLast == 0 {
			isUncompressed, err := r.readBits(1)
			if err != nil {
				return nil, "ERR_INVALID_ARG_VALUE", err
			}
			if isUncompressed == 1 {
				raw, err := r.readAlignedBytes(mlen)
				if err != nil {
					return nil, "ERR_INVALID_ARG_VALUE", err
				}
				out = append(out, raw...)
				continue
			}
		}

		litBS, err := readBrotliBlockSwitch(r)
		if err != nil {
			return nil, "ERR_INVALID_ARG_VALUE", err
		}
		icBS, err := readBrotliBlockSwitch(r)
		if err != nil {
			return nil, "ERR_INVALID_ARG_VALUE", err
		}
		distBS, err := readBrotliBlockSwitch(r)
		if err != nil {
			return nil, "ERR_INVALID_ARG_VALUE", err
		}

		npostfix, err := r.readBits(2)
		if err != nil {
			return nil, "ERR_INVALID_ARG_VALUE", err
		}
		ndirectUpper, err := r.readBits(4)
		if err != nil {
			return nil, "ERR_INVALID_ARG_VALUE", err
		}
		ndirect := int(ndirectUpper) << npostfix

		litCtxModes := make([]uint8, litBS.numTypes)
		for i := 0; i < litBS.numTypes; i++ {
			cm, err := r.readBits(2)
			if err != nil {
				return nil, "ERR_INVALID_ARG_VALUE", err
			}
			litCtxModes[i] = uint8(cm)
		}

		ntreesL, litCMap, err := readBrotliContextMap(r, litBS.numTypes*64)
		if err != nil {
			return nil, "ERR_INVALID_ARG_VALUE", err
		}
		ntreesD, distCMap, err := readBrotliContextMap(r, distBS.numTypes*4)
		if err != nil {
			return nil, "ERR_INVALID_ARG_VALUE", err
		}

		litTrees := make([]*brotliHuffmanTree, ntreesL)
		for i := 0; i < ntreesL; i++ {
			t, err := readBrotliPrefixCode(r, 256)
			if err != nil {
				return nil, "ERR_INVALID_ARG_VALUE", err
			}
			litTrees[i] = t
		}
		icTrees := make([]*brotliHuffmanTree, icBS.numTypes)
		for i := 0; i < icBS.numTypes; i++ {
			t, err := readBrotliPrefixCode(r, 704)
			if err != nil {
				return nil, "ERR_INVALID_ARG_VALUE", err
			}
			icTrees[i] = t
		}
		distAlphaSize := 16 + ndirect + (48 << npostfix)
		distTrees := make([]*brotliHuffmanTree, ntreesD)
		for i := 0; i < ntreesD; i++ {
			t, err := readBrotliPrefixCode(r, distAlphaSize)
			if err != nil {
				return nil, "ERR_INVALID_ARG_VALUE", err
			}
			distTrees[i] = t
		}

		metaProduced := 0
		for metaProduced < mlen {
			if err := icBS.step(r); err != nil {
				return nil, "ERR_INVALID_ARG_VALUE", err
			}
			icSym, err := icTrees[icBS.curType].decode(r)
			if err != nil {
				return nil, "ERR_INVALID_ARG_VALUE", err
			}
			insIdx, copyIdx, useLastDist, err := decodeBrotliInsertCopyCode(icSym)
			if err != nil {
				return nil, "ERR_INVALID_ARG_VALUE", err
			}
			insExtra, err := r.readBits(brotliInsertExtra[insIdx])
			if err != nil {
				return nil, "ERR_INVALID_ARG_VALUE", err
			}
			insertLen := brotliInsertBase[insIdx] + int(insExtra)
			copyExtra, err := r.readBits(brotliCopyExtra[copyIdx])
			if err != nil {
				return nil, "ERR_INVALID_ARG_VALUE", err
			}
			copyLen := brotliCopyBase[copyIdx] + int(copyExtra)

			if metaProduced+insertLen > mlen {
				return nil, "ERR_INVALID_ARG_VALUE", errBrotliCorrupt
			}
			for i := 0; i < insertLen; i++ {
				if err := litBS.step(r); err != nil {
					return nil, "ERR_INVALID_ARG_VALUE", err
				}
				var p1, p2 byte
				if len(out) >= 1 {
					p1 = out[len(out)-1]
				}
				if len(out) >= 2 {
					p2 = out[len(out)-2]
				}
				ctxID := brotliLitContextID(p1, p2, litCtxModes[litBS.curType])
				treeIdx := int(litCMap[litBS.curType*64+ctxID])
				if treeIdx < 0 || treeIdx >= len(litTrees) {
					return nil, "ERR_INVALID_ARG_VALUE", errBrotliCorrupt
				}
				lit, err := litTrees[treeIdx].decode(r)
				if err != nil {
					return nil, "ERR_INVALID_ARG_VALUE", err
				}
				out = append(out, byte(lit))
			}
			metaProduced += insertLen
			if metaProduced == mlen {
				break
			}

			var dist int
			distSym := -1
			if useLastDist {
				dist = distRing[0]
				distSym = 0
			} else {
				if err := distBS.step(r); err != nil {
					return nil, "ERR_INVALID_ARG_VALUE", err
				}
				distCtx := copyLen - 2
				if distCtx > 3 {
					distCtx = 3
				}
				if distCtx < 0 {
					distCtx = 0
				}
				dTreeIdx := int(distCMap[distBS.curType*4+distCtx])
				if dTreeIdx < 0 || dTreeIdx >= len(distTrees) {
					return nil, "ERR_INVALID_ARG_VALUE", errBrotliCorrupt
				}
				ds, err := distTrees[dTreeIdx].decode(r)
				if err != nil {
					return nil, "ERR_INVALID_ARG_VALUE", err
				}
				distSym = ds
				switch {
				case ds == 0:
					dist = distRing[0]
				case ds == 1:
					dist = distRing[1]
				case ds == 2:
					dist = distRing[2]
				case ds == 3:
					dist = distRing[3]
				case ds < 16:
					shortTable := [12][2]int{
						{0, -1}, {0, 1}, {0, -2}, {0, 2}, {0, -3}, {0, 3},
						{1, -1}, {1, 1}, {1, -2}, {1, 2}, {1, -3}, {1, 3},
					}
					entry := shortTable[ds-4]
					dist = distRing[entry[0]] + entry[1]
					if dist <= 0 {
						return nil, "ERR_INVALID_ARG_VALUE", errBrotliCorrupt
					}
				case ds < 16+ndirect:
					dist = ds - 15
				default:
					dcode := ds - 16 - ndirect
					ndistbits := uint(1 + (dcode >> (npostfix + 1)))
					dextra, err := r.readBits(ndistbits)
					if err != nil {
						return nil, "ERR_INVALID_ARG_VALUE", err
					}
					hcode := dcode >> npostfix
					lcode := dcode & ((1 << npostfix) - 1)
					offset := ((2 + (hcode & 1)) << ndistbits) - 4
					dist = ((offset + int(dextra)) << npostfix) + lcode + ndirect + 1
				}
			}

			maxAllowedDist := len(out)
			if maxAllowedDist > maxWindow {
				maxAllowedDist = maxWindow
			}
			if dist <= 0 {
				return nil, "ERR_INVALID_ARG_VALUE", errBrotliCorrupt
			}
			if dist > maxAllowedDist {
				word, err := brotliLookupStaticDict(copyLen, dist-maxAllowedDist-1)
				if err != nil || metaProduced+len(word) > mlen {
					return nil, "ERR_INVALID_ARG_VALUE", errBrotliCorrupt
				}
				out = append(out, word...)
				metaProduced += len(word)
				continue
			}
			if metaProduced+copyLen > mlen {
				return nil, "ERR_INVALID_ARG_VALUE", errBrotliCorrupt
			}
			if distSym != 0 {
				distRing[3] = distRing[2]
				distRing[2] = distRing[1]
				distRing[1] = distRing[0]
				distRing[0] = dist
			}
			for i := 0; i < copyLen; i++ {
				out = append(out, out[len(out)-dist])
			}
			metaProduced += copyLen
		}

		if isLast == 1 {
			if err := r.alignToByte(); err != nil {
				return nil, "ERR_INVALID_ARG_VALUE", err
			}
			if r.bytePos != len(r.data) {
				return nil, "ERR_INVALID_ARG_VALUE", errBrotliCorrupt
			}
			return out, "", nil
		}
	}
}

const zstdMaxBlockSize = 128 * 1024

func zstdCompress(data []byte) []byte {
	n := len(data)
	out := make([]byte, 0, n+16+(n/zstdMaxBlockSize)*3)
	// Zstandard Frame Magic Number: 0xFD2FB528 (little-endian)
	out = append(out, 0x28, 0xB5, 0x2F, 0xFD)
	// Frame_Header_Descriptor:
	// Single_Segment_Flag = 1 (bit 5), Frame_Content_Size_Flag = 3 (8-byte content size, bits 7-6) => 0xE0
	out = append(out, 0xE0)
	// 8-byte little-endian Frame_Content_Size
	u := uint64(n)
	out = append(out,
		byte(u), byte(u>>8), byte(u>>16), byte(u>>24),
		byte(u>>32), byte(u>>40), byte(u>>48), byte(u>>56),
	)
	if n == 0 {
		// Last_Block = 1, Block_Type = 0 (Raw_Block), Block_Size = 0
		out = append(out, 0x01, 0x00, 0x00)
		return out
	}
	for off := 0; off < n; {
		rem := n - off
		blkLen := rem
		if blkLen > zstdMaxBlockSize {
			blkLen = zstdMaxBlockSize
		}
		lastBit := uint32(0)
		if off+blkLen == n {
			lastBit = 1
		}
		// Check if the entire block is a single repeated byte -> RLE_Block (type 1)
		allSame := blkLen >= 4
		if allSame {
			b0 := data[off]
			for i := 1; i < blkLen; i++ {
				if data[off+i] != b0 {
					allSame = false
					break
				}
			}
		}
		if allSame {
			hdr := lastBit | (1 << 1) | (uint32(blkLen) << 3)
			out = append(out, byte(hdr), byte(hdr>>8), byte(hdr>>16), data[off])
		} else {
			hdr := lastBit | (0 << 1) | (uint32(blkLen) << 3)
			out = append(out, byte(hdr), byte(hdr>>8), byte(hdr>>16))
			out = append(out, data[off:off+blkLen]...)
		}
		off += blkLen
	}
	return out
}

func zstdDecompress(data []byte, maxOut int64) ([]byte, string, error) {
	if len(data) < 4 {
		return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: unexpected end of zstd input")
	}
	var out []byte
	pos := 0
	framesRead := 0
	for pos < len(data) {
		if pos+4 > len(data) {
			return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: truncated zstd frame magic")
		}
		magic := uint32(data[pos]) | (uint32(data[pos+1]) << 8) | (uint32(data[pos+2]) << 16) | (uint32(data[pos+3]) << 24)
		pos += 4
		// Skippable frames: 0x184D2A50..0x184D2A5F
		if magic >= 0x184D2A50 && magic <= 0x184D2A5F {
			if pos+4 > len(data) {
				return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: truncated zstd skippable frame")
			}
			skipLen := int(uint32(data[pos]) | (uint32(data[pos+1]) << 8) | (uint32(data[pos+2]) << 16) | (uint32(data[pos+3]) << 24))
			pos += 4
			if skipLen < 0 || pos+skipLen > len(data) {
				return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: truncated zstd skippable payload")
			}
			pos += skipLen
			framesRead++
			continue
		}
		if magic != 0xFD2FB528 {
			return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: invalid zstd magic number")
		}
		if pos >= len(data) {
			return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: missing zstd frame header descriptor")
		}
		fhd := data[pos]
		pos++
		if (fhd & 0x08) != 0 {
			return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: reserved bit set in zstd frame header")
		}
		fcsFlag := (fhd >> 6) & 0x03
		singleSeg := (fhd & 0x20) != 0
		hasChecksum := (fhd & 0x04) != 0
		dictIDFlag := fhd & 0x03

		if !singleSeg {
			if pos >= len(data) {
				return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: missing zstd window descriptor")
			}
			pos++
		}
		dictBytes := [4]int{0, 1, 2, 4}[dictIDFlag]
		if pos+dictBytes > len(data) {
			return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: truncated zstd dictionary id")
		}
		pos += dictBytes

		fcsBytes := 0
		switch fcsFlag {
		case 0:
			if singleSeg {
				fcsBytes = 1
			}
		case 1:
			fcsBytes = 2
		case 2:
			fcsBytes = 4
		case 3:
			fcsBytes = 8
		}
		var expectedSize int64 = -1
		if fcsBytes > 0 {
			if pos+fcsBytes > len(data) {
				return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: truncated zstd frame content size")
			}
			var fcs uint64
			for i := 0; i < fcsBytes; i++ {
				fcs |= uint64(data[pos+i]) << (8 * i)
			}
			if fcsFlag == 1 {
				fcs += 256
			}
			pos += fcsBytes
			if maxOut >= 0 && fcs > uint64(maxOut) {
				return nil, "ERR_BUFFER_TOO_LARGE", fmt.Errorf("ERR_BUFFER_TOO_LARGE: Cannot create a Buffer larger than %d bytes", maxOut)
			}
			expectedSize = int64(fcs)
		}

		var frameProduced int64
		frameStart := len(out)
		st := &zstdFrameState{
			rep: [3]int{1, 4, 8},
		}
		for {
			if pos+3 > len(data) {
				return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: truncated zstd block header")
			}
			bh := uint32(data[pos]) | (uint32(data[pos+1]) << 8) | (uint32(data[pos+2]) << 16)
			pos += 3
			lastBlock := (bh & 1) != 0
			blockType := (bh >> 1) & 0x03
			blockSize := int(bh >> 3)
			if blockSize > zstdMaxBlockSize {
				return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: zstd block size exceeds maximum")
			}
			switch blockType {
			case 0: // Raw_Block
				if pos+blockSize > len(data) {
					return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: truncated zstd raw block")
				}
				if maxOut >= 0 && int64(len(out))+int64(blockSize) > maxOut {
					return nil, "ERR_BUFFER_TOO_LARGE", fmt.Errorf("ERR_BUFFER_TOO_LARGE: Cannot create a Buffer larger than %d bytes", maxOut)
				}
				out = append(out, data[pos:pos+blockSize]...)
				pos += blockSize
				frameProduced += int64(blockSize)
			case 1: // RLE_Block
				if pos+1 > len(data) {
					return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: truncated zstd RLE block")
				}
				if maxOut >= 0 && int64(len(out))+int64(blockSize) > maxOut {
					return nil, "ERR_BUFFER_TOO_LARGE", fmt.Errorf("ERR_BUFFER_TOO_LARGE: Cannot create a Buffer larger than %d bytes", maxOut)
				}
				b := data[pos]
				pos++
				start := len(out)
				out = append(out, make([]byte, blockSize)...)
				for i := start; i < len(out); i++ {
					out[i] = b
				}
				frameProduced += int64(blockSize)
			case 2: // Compressed_Block (RFC 8878 Section 3.1.1.3)
				if pos+blockSize > len(data) {
					return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: truncated zstd compressed block")
				}
				blockData := data[pos : pos+blockSize]
				pos += blockSize
				prevLen := len(out)
				var errCode string
				var err error
				out, errCode, err = zstdDecodeCompressedBlock(out, frameStart, blockData, st, maxOut)
				if err != nil {
					return nil, errCode, err
				}
				frameProduced += int64(len(out) - prevLen)
			default:
				return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: unsupported or corrupt zstd block type %d", blockType)
			}
			if lastBlock {
				break
			}
		}
		if expectedSize >= 0 && frameProduced != expectedSize {
			return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: zstd frame size mismatch")
		}
		if hasChecksum {
			if pos+4 > len(data) {
				return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: truncated zstd content checksum")
			}
			pos += 4
		}
		framesRead++
	}
	if framesRead == 0 {
		return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: empty zstd input")
	}
	return out, "", nil
}

type zstdHuffEntry struct {
	symbol  byte
	numBits uint8
}

type zstdHuffTable struct {
	maxBits uint8
	entries []zstdHuffEntry
}

type zstdFSEEntry struct {
	symbol       uint8
	numBits      uint8
	newStateBase uint16
}

type zstdFSETable struct {
	tableLog uint8
	entries  []zstdFSEEntry
}

type zstdFrameState struct {
	rep       [3]int
	huffTable *zstdHuffTable
	llTable   *zstdFSETable
	ofTable   *zstdFSETable
	mlTable   *zstdFSETable
}

type zstdBackwardReader struct {
	src    []byte
	bitPos int
}

func newZstdBackwardReader(src []byte) (*zstdBackwardReader, error) {
	if len(src) == 0 {
		return nil, fmt.Errorf("Z_DATA_ERROR: empty zstd bitstream")
	}
	last := src[len(src)-1]
	if last == 0 {
		return nil, fmt.Errorf("Z_DATA_ERROR: missing zstd bitstream sentinel")
	}
	highBit := bits.Len8(last) - 1
	return &zstdBackwardReader{
		src:    src,
		bitPos: (len(src)-1)*8 + highBit,
	}, nil
}

func (r *zstdBackwardReader) peekBits(n uint) uint32 {
	if n == 0 {
		return 0
	}
	var val uint32
	for i := 0; i < int(n); i++ {
		idx := r.bitPos - 1 - i
		var b uint32
		if idx >= 0 {
			b = uint32((r.src[idx>>3] >> uint(idx&7)) & 1)
		}
		val = (val << 1) | b
	}
	return val
}

func (r *zstdBackwardReader) readBits(n uint) (uint32, bool) {
	if int(n) > r.bitPos {
		return 0, false
	}
	val := r.peekBits(n)
	r.bitPos -= int(n)
	return val, true
}

func zstdReadForwardBits(src []byte, bitOffset *int, n uint) (uint32, bool) {
	if n == 0 {
		return 0, true
	}
	if *bitOffset+int(n) > len(src)*8 {
		return 0, false
	}
	var val uint32
	for i := uint(0); i < n; i++ {
		idx := *bitOffset + int(i)
		b := (src[idx>>3] >> uint(idx&7)) & 1
		val |= uint32(b) << i
	}
	*bitOffset += int(n)
	return val, true
}

func zstdBuildFSETable(norm []int16, maxSymbol int, tableLog uint8) (*zstdFSETable, error) {
	if maxSymbol >= len(norm) {
		maxSymbol = len(norm) - 1
	}
	tableSize := 1 << tableLog
	tableMask := tableSize - 1
	step := (tableSize >> 1) + (tableSize >> 3) + 3
	entries := make([]zstdFSEEntry, tableSize)
	symbolNext := make([]uint16, maxSymbol+1)
	highThreshold := tableSize - 1

	for s := 0; s <= maxSymbol; s++ {
		if norm[s] == -1 {
			if highThreshold < 0 {
				return nil, fmt.Errorf("Z_DATA_ERROR: corrupt FSE table")
			}
			entries[highThreshold].symbol = uint8(s)
			highThreshold--
			symbolNext[s] = 1
		}
	}
	pos := 0
	for s := 0; s <= maxSymbol; s++ {
		if norm[s] <= 0 {
			continue
		}
		symbolNext[s] = uint16(norm[s])
		for i := int16(0); i < norm[s]; i++ {
			entries[pos].symbol = uint8(s)
			for {
				pos = (pos + step) & tableMask
				if pos <= highThreshold {
					break
				}
			}
		}
	}
	if pos != 0 {
		return nil, fmt.Errorf("Z_DATA_ERROR: invalid FSE distribution sum")
	}
	for u := 0; u < tableSize; u++ {
		s := entries[u].symbol
		nextState := int(symbolNext[s])
		symbolNext[s]++
		if nextState <= 0 {
			return nil, fmt.Errorf("Z_DATA_ERROR: invalid FSE nextState")
		}
		nBits := tableLog - uint8(bits.Len16(uint16(nextState))-1)
		entries[u].numBits = nBits
		entries[u].newStateBase = uint16((nextState << nBits) - tableSize)
	}
	return &zstdFSETable{tableLog: tableLog, entries: entries}, nil
}

func zstdReadFSETable(src []byte, maxSymbol int, maxLog uint8) (*zstdFSETable, int, error) {
	if len(src) == 0 {
		return nil, 0, fmt.Errorf("Z_DATA_ERROR: truncated FSE header")
	}
	bitOffset := 0
	tlBits, ok := zstdReadForwardBits(src, &bitOffset, 4)
	if !ok {
		return nil, 0, fmt.Errorf("Z_DATA_ERROR: truncated FSE tableLog")
	}
	tableLog := uint8(tlBits) + 5
	if tableLog > maxLog {
		return nil, 0, fmt.Errorf("Z_DATA_ERROR: FSE tableLog exceeds maximum")
	}
	remaining := (1 << tableLog) + 1
	threshold := 1 << tableLog
	nbBits := uint(tableLog + 1)
	norm := make([]int16, maxSymbol+1)
	charnum := 0
	previous0 := false

	for remaining > 1 && charnum <= maxSymbol {
		if previous0 {
			repeat := 0
			for {
				v, ok := zstdReadForwardBits(src, &bitOffset, 2)
				if !ok {
					return nil, 0, fmt.Errorf("Z_DATA_ERROR: truncated FSE zero repeat")
				}
				repeat += int(v)
				if v < 3 {
					break
				}
			}
			charnum += repeat
			if charnum > maxSymbol+1 {
				return nil, 0, fmt.Errorf("Z_DATA_ERROR: FSE repeat overflow")
			}
			if charnum > maxSymbol {
				break
			}
		}
		maxVal := (2*threshold - 1) - remaining
		v, ok := zstdReadForwardBits(src, &bitOffset, nbBits-1)
		if !ok {
			return nil, 0, fmt.Errorf("Z_DATA_ERROR: truncated FSE count")
		}
		count := int(v)
		if count >= maxVal {
			extra, ok := zstdReadForwardBits(src, &bitOffset, 1)
			if !ok {
				return nil, 0, fmt.Errorf("Z_DATA_ERROR: truncated FSE count extra bit")
			}
			count += int(extra) << (nbBits - 1)
			if count >= threshold {
				count -= maxVal
			}
		}
		count--
		if count == -1 {
			remaining--
		} else {
			remaining -= count
		}
		if remaining < 1 {
			return nil, 0, fmt.Errorf("Z_DATA_ERROR: FSE probability overflow")
		}
		norm[charnum] = int16(count)
		charnum++
		previous0 = (count == 0)
		for remaining < threshold && threshold > 1 {
			nbBits--
			threshold >>= 1
		}
	}
	if remaining != 1 {
		return nil, 0, fmt.Errorf("Z_DATA_ERROR: FSE distribution incomplete")
	}
	bytesRead := (bitOffset + 7) >> 3
	tbl, err := zstdBuildFSETable(norm, maxSymbol, tableLog)
	if err != nil {
		return nil, 0, err
	}
	return tbl, bytesRead, nil
}

func zstdBuildRLEFSETable(sym uint8) *zstdFSETable {
	return &zstdFSETable{
		tableLog: 0,
		entries:  []zstdFSEEntry{{symbol: sym, numBits: 0, newStateBase: 0}},
	}
}

func zstdReadHuffTable(src []byte) (*zstdHuffTable, int, error) {
	if len(src) == 0 {
		return nil, 0, fmt.Errorf("Z_DATA_ERROR: empty Huffman tree description")
	}
	headerByte := src[0]
	var weights []uint8
	var bytesRead int
	if headerByte >= 128 {
		numWeights := int(headerByte - 127)
		bytesNeeded := (numWeights + 1) / 2
		if 1+bytesNeeded > len(src) {
			return nil, 0, fmt.Errorf("Z_DATA_ERROR: truncated direct Huffman weights")
		}
		weights = make([]uint8, numWeights)
		for i := 0; i < numWeights; i++ {
			b := src[1+(i>>1)]
			if (i & 1) == 0 {
				weights[i] = b >> 4
			} else {
				weights[i] = b & 0x0f
			}
		}
		bytesRead = 1 + bytesNeeded
	} else {
		compSize := int(headerByte)
		if compSize == 0 || 1+compSize > len(src) {
			return nil, 0, fmt.Errorf("Z_DATA_ERROR: invalid FSE Huffman weights size")
		}
		fsePayload := src[1 : 1+compSize]
		fseTbl, hdrLen, err := zstdReadFSETable(fsePayload, 12, 6)
		if err != nil {
			return nil, 0, err
		}
		if hdrLen >= len(fsePayload) {
			return nil, 0, fmt.Errorf("Z_DATA_ERROR: empty FSE Huffman bitstream")
		}
		br, err := newZstdBackwardReader(fsePayload[hdrLen:])
		if err != nil {
			return nil, 0, err
		}
		st1, ok1 := br.readBits(uint(fseTbl.tableLog))
		st2, ok2 := br.readBits(uint(fseTbl.tableLog))
		if !ok1 || !ok2 {
			return nil, 0, fmt.Errorf("Z_DATA_ERROR: truncated FSE Huffman initial state")
		}
		state1 := int(st1)
		state2 := int(st2)
		for len(weights) < 255 {
			e1 := fseTbl.entries[state1]
			weights = append(weights, e1.symbol)
			if br.bitPos < int(e1.numBits) {
				weights = append(weights, fseTbl.entries[state2].symbol)
				break
			}
			bits1, _ := br.readBits(uint(e1.numBits))
			state1 = int(e1.newStateBase) + int(bits1)

			if len(weights) >= 255 {
				break
			}
			e2 := fseTbl.entries[state2]
			weights = append(weights, e2.symbol)
			if br.bitPos < int(e2.numBits) {
				weights = append(weights, fseTbl.entries[state1].symbol)
				break
			}
			bits2, _ := br.readBits(uint(e2.numBits))
			state2 = int(e2.newStateBase) + int(bits2)
		}
		bytesRead = 1 + compSize
	}

	if len(weights) == 0 || len(weights) >= 256 {
		return nil, 0, fmt.Errorf("Z_DATA_ERROR: invalid Huffman weight count")
	}
	sumWeight := 0
	for _, w := range weights {
		if w > 11 {
			return nil, 0, fmt.Errorf("Z_DATA_ERROR: Huffman weight exceeds maxBits 11")
		}
		if w > 0 {
			sumWeight += 1 << (w - 1)
		}
	}
	if sumWeight == 0 {
		return nil, 0, fmt.Errorf("Z_DATA_ERROR: all-zero Huffman weights")
	}
	maxBits := uint8(bits.Len(uint(sumWeight)))
	if maxBits > 11 {
		return nil, 0, fmt.Errorf("Z_DATA_ERROR: Huffman maxBits exceeds 11")
	}
	rem := (1 << maxBits) - sumWeight
	if rem <= 0 || (rem&(rem-1)) != 0 {
		return nil, 0, fmt.Errorf("Z_DATA_ERROR: invalid Huffman Kraft remainder")
	}
	lastWeight := uint8(bits.TrailingZeros(uint(rem)) + 1)
	weights = append(weights, lastWeight)

	var rankCount [13]int
	for _, w := range weights {
		if w > 0 {
			rankCount[w]++
		}
	}
	var rankIdx [13]int
	idx := 0
	for w := uint8(1); w <= maxBits; w++ {
		rankIdx[w] = idx
		idx += rankCount[w] * (1 << (w - 1))
	}
	entries := make([]zstdHuffEntry, 1<<maxBits)
	for sym, w := range weights {
		if w == 0 {
			continue
		}
		length := 1 << (w - 1)
		nb := maxBits + 1 - w
		start := rankIdx[w]
		for i := 0; i < length; i++ {
			entries[start+i] = zstdHuffEntry{symbol: byte(sym), numBits: nb}
		}
		rankIdx[w] += length
	}
	return &zstdHuffTable{maxBits: maxBits, entries: entries}, bytesRead, nil
}

func zstdDecodeHuffStream(tbl *zstdHuffTable, src []byte, outLen int) ([]byte, error) {
	if outLen == 0 {
		return nil, nil
	}
	br, err := newZstdBackwardReader(src)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, outLen)
	for len(out) < outLen {
		if br.bitPos <= 0 {
			return nil, fmt.Errorf("Z_DATA_ERROR: Huffman stream ended early")
		}
		peek := br.peekBits(uint(tbl.maxBits))
		entry := tbl.entries[peek]
		if entry.numBits == 0 || int(entry.numBits) > br.bitPos {
			return nil, fmt.Errorf("Z_DATA_ERROR: Huffman symbol overruns stream")
		}
		br.bitPos -= int(entry.numBits)
		out = append(out, entry.symbol)
	}
	if br.bitPos != 0 {
		return nil, fmt.Errorf("Z_DATA_ERROR: trailing bits in Huffman stream")
	}
	return out, nil
}

var (
	zstdDefaultLLNorm = []int16{
		4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1,
		2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1,
		-1, -1, -1, -1,
	}
	zstdDefaultMLNorm = []int16{
		1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1,
		1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
		1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1,
		-1, -1, -1, -1, -1,
	}
	zstdDefaultOFNorm = []int16{
		1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1,
		1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1,
	}
	zstdLLBits = [36]uint8{
		0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
		1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12,
		13, 14, 15, 16,
	}
	zstdLLBase = [36]int{
		0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
		16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096,
		8192, 16384, 32768, 65536,
	}
	zstdMLBits = [53]uint8{
		0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
		1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11,
		12, 13, 14, 15, 16,
	}
	zstdMLBase = [53]int{
		3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
		19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34,
		35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051,
		4099, 8195, 16387, 32771, 65539,
	}
)

func zstdDecodeCompressedBlock(out []byte, frameStart int, blockData []byte, st *zstdFrameState, maxOut int64) ([]byte, string, error) {
	if len(blockData) == 0 {
		return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: empty zstd compressed block")
	}
	litType := blockData[0] & 0x03
	sizeFmt := (blockData[0] >> 2) & 0x03

	var literals []byte
	var seqData []byte

	switch litType {
	case 0, 1: // Raw_Literals_Block or RLE_Literals_Block
		var regenSize, hdrSize int
		switch sizeFmt {
		case 0, 2:
			regenSize = int(blockData[0] >> 3)
			hdrSize = 1
		case 1:
			if len(blockData) < 2 {
				return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: truncated zstd literals header")
			}
			regenSize = int(blockData[0]>>4) | (int(blockData[1]) << 4)
			hdrSize = 2
		case 3:
			if len(blockData) < 3 {
				return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: truncated zstd literals header")
			}
			regenSize = int(blockData[0]>>4) | (int(blockData[1]) << 4) | (int(blockData[2]) << 12)
			hdrSize = 3
		}
		if regenSize > zstdMaxBlockSize {
			return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: literals size exceeds block maximum")
		}
		if litType == 0 {
			if hdrSize+regenSize > len(blockData) {
				return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: truncated raw literals")
			}
			literals = blockData[hdrSize : hdrSize+regenSize]
			seqData = blockData[hdrSize+regenSize:]
		} else {
			if hdrSize+1 > len(blockData) {
				return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: truncated RLE literals")
			}
			b := blockData[hdrSize]
			literals = make([]byte, regenSize)
			for i := range literals {
				literals[i] = b
			}
			seqData = blockData[hdrSize+1:]
		}

	case 2, 3: // Compressed_Literals_Block or Treeless_Literals_Block
		numStreams := 4
		var regenSize, compSize, hdrSize int
		switch sizeFmt {
		case 0:
			numStreams = 1
			if len(blockData) < 3 {
				return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: truncated compressed literals header")
			}
			regenSize = int(blockData[0]>>4) | ((int(blockData[1]) & 0x3f) << 4)
			compSize = int(blockData[1]>>6) | (int(blockData[2]) << 2)
			hdrSize = 3
		case 1:
			if len(blockData) < 3 {
				return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: truncated compressed literals header")
			}
			regenSize = int(blockData[0]>>4) | ((int(blockData[1]) & 0x3f) << 4)
			compSize = int(blockData[1]>>6) | (int(blockData[2]) << 2)
			hdrSize = 3
		case 2:
			if len(blockData) < 4 {
				return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: truncated compressed literals header")
			}
			regenSize = int(blockData[0]>>4) | (int(blockData[1]) << 4) | ((int(blockData[2]) & 0x03) << 12)
			compSize = int(blockData[2]>>2) | (int(blockData[3]) << 6)
			hdrSize = 4
		case 3:
			if len(blockData) < 5 {
				return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: truncated compressed literals header")
			}
			regenSize = int(blockData[0]>>4) | (int(blockData[1]) << 4) | ((int(blockData[2]) & 0x3f) << 12)
			compSize = int(blockData[2]>>6) | (int(blockData[3]) << 2) | (int(blockData[4]) << 10)
			hdrSize = 5
		}
		if regenSize > zstdMaxBlockSize || hdrSize+compSize > len(blockData) {
			return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: invalid compressed literals size")
		}
		litPayload := blockData[hdrSize : hdrSize+compSize]
		seqData = blockData[hdrSize+compSize:]
		if litType == 2 {
			tbl, treeBytes, err := zstdReadHuffTable(litPayload)
			if err != nil {
				return nil, "Z_DATA_ERROR", err
			}
			st.huffTable = tbl
			litPayload = litPayload[treeBytes:]
		} else if st.huffTable == nil {
			return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: treeless literals without prior Huffman table")
		}
		if numStreams == 1 {
			dec, err := zstdDecodeHuffStream(st.huffTable, litPayload, regenSize)
			if err != nil {
				return nil, "Z_DATA_ERROR", err
			}
			literals = dec
		} else {
			if len(litPayload) < 6 {
				return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: truncated 4-stream Huffman jump table")
			}
			len1 := int(litPayload[0]) | (int(litPayload[1]) << 8)
			len2 := int(litPayload[2]) | (int(litPayload[3]) << 8)
			len3 := int(litPayload[4]) | (int(litPayload[5]) << 8)
			if 6+len1+len2+len3 > len(litPayload) {
				return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: invalid 4-stream Huffman jump table")
			}
			s1 := litPayload[6 : 6+len1]
			s2 := litPayload[6+len1 : 6+len1+len2]
			s3 := litPayload[6+len1+len2 : 6+len1+len2+len3]
			s4 := litPayload[6+len1+len2+len3:]
			chunkSize := (regenSize + 3) / 4
			remSize := regenSize - 3*chunkSize
			if remSize < 0 {
				return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: invalid 4-stream regenSize")
			}
			b1, err := zstdDecodeHuffStream(st.huffTable, s1, chunkSize)
			if err != nil {
				return nil, "Z_DATA_ERROR", err
			}
			b2, err := zstdDecodeHuffStream(st.huffTable, s2, chunkSize)
			if err != nil {
				return nil, "Z_DATA_ERROR", err
			}
			b3, err := zstdDecodeHuffStream(st.huffTable, s3, chunkSize)
			if err != nil {
				return nil, "Z_DATA_ERROR", err
			}
			b4, err := zstdDecodeHuffStream(st.huffTable, s4, remSize)
			if err != nil {
				return nil, "Z_DATA_ERROR", err
			}
			literals = make([]byte, 0, regenSize)
			literals = append(literals, b1...)
			literals = append(literals, b2...)
			literals = append(literals, b3...)
			literals = append(literals, b4...)
		}
	}

	if len(seqData) == 0 {
		return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: missing sequences section")
	}
	var numSeq, seqPos int
	b0 := seqData[0]
	if b0 == 0 {
		if len(seqData) != 1 {
			return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: trailing bytes after 0 sequences")
		}
		if maxOut >= 0 && int64(len(out))+int64(len(literals)) > maxOut {
			return nil, "ERR_BUFFER_TOO_LARGE", fmt.Errorf("ERR_BUFFER_TOO_LARGE: Cannot create a Buffer larger than %d bytes", maxOut)
		}
		out = append(out, literals...)
		return out, "", nil
	} else if b0 < 128 {
		numSeq = int(b0)
		seqPos = 1
	} else if b0 < 255 {
		if len(seqData) < 2 {
			return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: truncated sequence count")
		}
		numSeq = ((int(b0) - 128) << 8) + int(seqData[1])
		seqPos = 2
	} else {
		if len(seqData) < 3 {
			return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: truncated sequence count")
		}
		numSeq = int(seqData[1]) + (int(seqData[2]) << 8) + 0x7f00
		seqPos = 3
	}

	if seqPos >= len(seqData) {
		return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: missing sequence compression modes")
	}
	modes := seqData[seqPos]
	seqPos++
	if (modes & 0x03) != 0 {
		return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: reserved sequence mode bits set")
	}
	llMode := (modes >> 6) & 0x03
	ofMode := (modes >> 4) & 0x03
	mlMode := (modes >> 2) & 0x03

	resolveSeqTable := func(mode byte, maxSym int, maxLog uint8, defNorm []int16, defLog uint8, prev **zstdFSETable) (*zstdFSETable, error) {
		switch mode {
		case 0: // Predefined_Mode
			tbl, err := zstdBuildFSETable(defNorm, len(defNorm)-1, defLog)
			if err != nil {
				return nil, err
			}
			*prev = tbl
			return tbl, nil
		case 1: // RLE_Mode
			if seqPos >= len(seqData) {
				return nil, fmt.Errorf("Z_DATA_ERROR: truncated RLE sequence table")
			}
			sym := seqData[seqPos]
			seqPos++
			if int(sym) > maxSym {
				return nil, fmt.Errorf("Z_DATA_ERROR: RLE sequence symbol out of range")
			}
			tbl := zstdBuildRLEFSETable(sym)
			*prev = tbl
			return tbl, nil
		case 2: // FSE_Compressed_Mode
			tbl, n, err := zstdReadFSETable(seqData[seqPos:], maxSym, maxLog)
			if err != nil {
				return nil, err
			}
			seqPos += n
			*prev = tbl
			return tbl, nil
		case 3: // Repeat_Mode
			if *prev == nil {
				return nil, fmt.Errorf("Z_DATA_ERROR: repeat sequence mode without prior table")
			}
			return *prev, nil
		}
		return nil, fmt.Errorf("Z_DATA_ERROR: invalid sequence mode")
	}

	llTbl, err := resolveSeqTable(llMode, 35, 9, zstdDefaultLLNorm, 6, &st.llTable)
	if err != nil {
		return nil, "Z_DATA_ERROR", err
	}
	ofTbl, err := resolveSeqTable(ofMode, 31, 8, zstdDefaultOFNorm, 5, &st.ofTable)
	if err != nil {
		return nil, "Z_DATA_ERROR", err
	}
	mlTbl, err := resolveSeqTable(mlMode, 52, 9, zstdDefaultMLNorm, 6, &st.mlTable)
	if err != nil {
		return nil, "Z_DATA_ERROR", err
	}

	br, err := newZstdBackwardReader(seqData[seqPos:])
	if err != nil {
		return nil, "Z_DATA_ERROR", err
	}
	llSt, ok1 := br.readBits(uint(llTbl.tableLog))
	ofSt, ok2 := br.readBits(uint(ofTbl.tableLog))
	mlSt, ok3 := br.readBits(uint(mlTbl.tableLog))
	if !ok1 || !ok2 || !ok3 {
		return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: truncated sequence initial states")
	}
	llState := int(llSt)
	ofState := int(ofSt)
	mlState := int(mlSt)

	litPos := 0
	for i := 0; i < numSeq; i++ {
		llEntry := llTbl.entries[llState]
		ofEntry := ofTbl.entries[ofState]
		mlEntry := mlTbl.entries[mlState]

		ofCode := ofEntry.symbol
		mlCode := mlEntry.symbol
		llCode := llEntry.symbol
		if ofCode > 31 || mlCode > 52 || llCode > 35 {
			return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: sequence symbol out of bounds")
		}

		ofExtra, ok := br.readBits(uint(ofCode))
		if !ok {
			return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: truncated sequence offset bits")
		}
		offsetValue := (1 << ofCode) + int(ofExtra)

		mlExtra, ok := br.readBits(uint(zstdMLBits[mlCode]))
		if !ok {
			return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: truncated sequence match-length bits")
		}
		ml := zstdMLBase[mlCode] + int(mlExtra)

		llExtra, ok := br.readBits(uint(zstdLLBits[llCode]))
		if !ok {
			return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: truncated sequence literals-length bits")
		}
		ll := zstdLLBase[llCode] + int(llExtra)

		var realOffset int
		if offsetValue > 3 {
			realOffset = offsetValue - 3
			st.rep[2] = st.rep[1]
			st.rep[1] = st.rep[0]
			st.rep[0] = realOffset
		} else {
			repIdx := offsetValue
			if ll == 0 {
				repIdx++
			}
			switch repIdx {
			case 1:
				realOffset = st.rep[0]
			case 2:
				realOffset = st.rep[1]
				st.rep[1] = st.rep[0]
				st.rep[0] = realOffset
			case 3:
				realOffset = st.rep[2]
				st.rep[2] = st.rep[1]
				st.rep[1] = st.rep[0]
				st.rep[0] = realOffset
			case 4:
				realOffset = st.rep[0] - 1
				if realOffset <= 0 {
					return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: invalid repeat offset 0")
				}
				st.rep[2] = st.rep[1]
				st.rep[1] = st.rep[0]
				st.rep[0] = realOffset
			}
		}

		if i < numSeq-1 {
			llNext, ok1 := br.readBits(uint(llEntry.numBits))
			mlNext, ok2 := br.readBits(uint(mlEntry.numBits))
			ofNext, ok3 := br.readBits(uint(ofEntry.numBits))
			if !ok1 || !ok2 || !ok3 {
				return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: truncated sequence state transition")
			}
			llState = int(llEntry.newStateBase) + int(llNext)
			mlState = int(mlEntry.newStateBase) + int(mlNext)
			ofState = int(ofEntry.newStateBase) + int(ofNext)
		}

		if litPos+ll > len(literals) {
			return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: sequence literals overrun")
		}
		if maxOut >= 0 && int64(len(out))+int64(ll+ml) > maxOut {
			return nil, "ERR_BUFFER_TOO_LARGE", fmt.Errorf("ERR_BUFFER_TOO_LARGE: Cannot create a Buffer larger than %d bytes", maxOut)
		}
		out = append(out, literals[litPos:litPos+ll]...)
		litPos += ll

		if realOffset <= 0 || len(out)-realOffset < frameStart {
			return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: sequence match offset before frame start")
		}
		for m := 0; m < ml; m++ {
			out = append(out, out[len(out)-realOffset])
		}
	}
	if br.bitPos != 0 {
		return nil, "Z_DATA_ERROR", fmt.Errorf("Z_DATA_ERROR: trailing bits in sequence stream")
	}
	remLit := len(literals) - litPos
	if remLit > 0 {
		if maxOut >= 0 && int64(len(out))+int64(remLit) > maxOut {
			return nil, "ERR_BUFFER_TOO_LARGE", fmt.Errorf("ERR_BUFFER_TOO_LARGE: Cannot create a Buffer larger than %d bytes", maxOut)
		}
		out = append(out, literals[litPos:]...)
	}
	return out, "", nil
}
