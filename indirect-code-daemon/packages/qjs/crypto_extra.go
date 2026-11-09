package qjs

import (
	"crypto/hmac"
	"crypto/sha3"
	"encoding/binary"
	"fmt"
	"hash"
	"math/big"
	"math/bits"
	"strings"
	"sync"
	"time"
	_ "time/tzdata"
)

var blake2bIV = [8]uint64{
	0x6a09e667f3bcc908, 0xbb67ae8584caa73b,
	0x3c6ef372fe94f82b, 0xa54ff53a5f1d36f1,
	0x510e527fade682d1, 0x9b05688c2b3e6c1f,
	0x1f83d9abfb41bd6b, 0x5be0cd19137e2179,
}

var blake2sIV = [8]uint32{
	0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
	0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
}

var blake2Sigma = [10][16]uint8{
	{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
	{14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3},
	{11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4},
	{7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8},
	{9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13},
	{2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9},
	{12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11},
	{13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10},
	{6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5},
	{10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0},
}

type blake2bHash struct {
	h      [8]uint64
	t0     uint64
	t1     uint64
	buf    [128]byte
	bufLen int
	size   int
}

func newBlake2b512() hash.Hash {
	d := &blake2bHash{size: 64}
	d.Reset()
	return d
}

func (d *blake2bHash) Reset() {
	d.h = blake2bIV
	d.h[0] ^= 0x01010000 | uint64(d.size)
	d.t0 = 0
	d.t1 = 0
	d.bufLen = 0
}

func (d *blake2bHash) Size() int      { return d.size }
func (d *blake2bHash) BlockSize() int { return 128 }

func (d *blake2bHash) Write(p []byte) (int, error) {
	origLen := len(p)
	for len(p) > 0 {
		if d.bufLen == 128 {
			d.t0 += 128
			if d.t0 < 128 {
				d.t1++
			}
			d.compress(&d.buf, false)
			d.bufLen = 0
		}
		n := copy(d.buf[d.bufLen:], p)
		d.bufLen += n
		p = p[n:]
	}
	return origLen, nil
}

func (d *blake2bHash) compress(block *[128]byte, last bool) {
	var v [16]uint64
	var m [16]uint64
	for i := 0; i < 8; i++ {
		v[i] = d.h[i]
		v[i+8] = blake2bIV[i]
	}
	v[12] ^= d.t0
	v[13] ^= d.t1
	if last {
		v[14] = ^v[14]
	}
	for i := 0; i < 16; i++ {
		m[i] = binary.LittleEndian.Uint64(block[i*8 : i*8+8])
	}
	g := func(a, b, c, dd int, x, y uint64) {
		v[a] = v[a] + v[b] + x
		v[dd] = bits.RotateLeft64(v[dd]^v[a], -32)
		v[c] = v[c] + v[dd]
		v[b] = bits.RotateLeft64(v[b]^v[c], -24)
		v[a] = v[a] + v[b] + y
		v[dd] = bits.RotateLeft64(v[dd]^v[a], -16)
		v[c] = v[c] + v[dd]
		v[b] = bits.RotateLeft64(v[b]^v[c], -63)
	}
	for r := 0; r < 12; r++ {
		s := &blake2Sigma[r%10]
		g(0, 4, 8, 12, m[s[0]], m[s[1]])
		g(1, 5, 9, 13, m[s[2]], m[s[3]])
		g(2, 6, 10, 14, m[s[4]], m[s[5]])
		g(3, 7, 11, 15, m[s[6]], m[s[7]])
		g(0, 5, 10, 15, m[s[8]], m[s[9]])
		g(1, 6, 11, 12, m[s[10]], m[s[11]])
		g(2, 7, 8, 13, m[s[12]], m[s[13]])
		g(3, 4, 9, 14, m[s[14]], m[s[15]])
	}
	for i := 0; i < 8; i++ {
		d.h[i] ^= v[i] ^ v[i+8]
	}
}

func (d *blake2bHash) Sum(in []byte) []byte {
	cp := *d
	cp.t0 += uint64(cp.bufLen)
	if cp.t0 < uint64(cp.bufLen) {
		cp.t1++
	}
	for i := cp.bufLen; i < 128; i++ {
		cp.buf[i] = 0
	}
	cp.compress(&cp.buf, true)
	var out [64]byte
	for i := 0; i < 8; i++ {
		binary.LittleEndian.PutUint64(out[i*8:i*8+8], cp.h[i])
	}
	return append(in, out[:cp.size]...)
}

type blake2sHash struct {
	h      [8]uint32
	t0     uint32
	t1     uint32
	buf    [64]byte
	bufLen int
	size   int
}

func newBlake2s256() hash.Hash {
	d := &blake2sHash{size: 32}
	d.Reset()
	return d
}

func (d *blake2sHash) Reset() {
	d.h = blake2sIV
	d.h[0] ^= 0x01010000 | uint32(d.size)
	d.t0 = 0
	d.t1 = 0
	d.bufLen = 0
}

func (d *blake2sHash) Size() int      { return d.size }
func (d *blake2sHash) BlockSize() int { return 64 }

func (d *blake2sHash) Write(p []byte) (int, error) {
	origLen := len(p)
	for len(p) > 0 {
		if d.bufLen == 64 {
			d.t0 += 64
			if d.t0 < 64 {
				d.t1++
			}
			d.compress(&d.buf, false)
			d.bufLen = 0
		}
		n := copy(d.buf[d.bufLen:], p)
		d.bufLen += n
		p = p[n:]
	}
	return origLen, nil
}

func (d *blake2sHash) compress(block *[64]byte, last bool) {
	var v [16]uint32
	var m [16]uint32
	for i := 0; i < 8; i++ {
		v[i] = d.h[i]
		v[i+8] = blake2sIV[i]
	}
	v[12] ^= d.t0
	v[13] ^= d.t1
	if last {
		v[14] = ^v[14]
	}
	for i := 0; i < 16; i++ {
		m[i] = binary.LittleEndian.Uint32(block[i*4 : i*4+4])
	}
	g := func(a, b, c, dd int, x, y uint32) {
		v[a] = v[a] + v[b] + x
		v[dd] = bits.RotateLeft32(v[dd]^v[a], -16)
		v[c] = v[c] + v[dd]
		v[b] = bits.RotateLeft32(v[b]^v[c], -12)
		v[a] = v[a] + v[b] + y
		v[dd] = bits.RotateLeft32(v[dd]^v[a], -8)
		v[c] = v[c] + v[dd]
		v[b] = bits.RotateLeft32(v[b]^v[c], -7)
	}
	for r := 0; r < 10; r++ {
		s := &blake2Sigma[r]
		g(0, 4, 8, 12, m[s[0]], m[s[1]])
		g(1, 5, 9, 13, m[s[2]], m[s[3]])
		g(2, 6, 10, 14, m[s[4]], m[s[5]])
		g(3, 7, 11, 15, m[s[6]], m[s[7]])
		g(0, 5, 10, 15, m[s[8]], m[s[9]])
		g(1, 6, 11, 12, m[s[10]], m[s[11]])
		g(2, 7, 8, 13, m[s[12]], m[s[13]])
		g(3, 4, 9, 14, m[s[14]], m[s[15]])
	}
	for i := 0; i < 8; i++ {
		d.h[i] ^= v[i] ^ v[i+8]
	}
}

func (d *blake2sHash) Sum(in []byte) []byte {
	cp := *d
	cp.t0 += uint32(cp.bufLen)
	if cp.t0 < uint32(cp.bufLen) {
		cp.t1++
	}
	for i := cp.bufLen; i < 64; i++ {
		cp.buf[i] = 0
	}
	cp.compress(&cp.buf, true)
	var out [32]byte
	for i := 0; i < 8; i++ {
		binary.LittleEndian.PutUint32(out[i*4:i*4+4], cp.h[i])
	}
	return append(in, out[:cp.size]...)
}

func newSHA3_224() hash.Hash { return sha3.New224() }
func newSHA3_256() hash.Hash { return sha3.New256() }
func newSHA3_384() hash.Hash { return sha3.New384() }
func newSHA3_512() hash.Hash { return sha3.New512() }

type shakeHash struct {
	is256 bool
	size  int
	buf   []byte
}

func newSHAKE128() hash.Hash { return &shakeHash{is256: false, size: 16} }
func newSHAKE256() hash.Hash { return &shakeHash{is256: true, size: 32} }

func newSHAKEWithLen(is256 bool, outLen int) hash.Hash {
	if outLen < 0 {
		if is256 {
			outLen = 32
		} else {
			outLen = 16
		}
	}
	return &shakeHash{is256: is256, size: outLen}
}

func (s *shakeHash) Write(p []byte) (int, error) {
	s.buf = append(s.buf, p...)
	return len(p), nil
}

func (s *shakeHash) Reset() {
	s.buf = s.buf[:0]
}

func (s *shakeHash) Size() int { return s.size }

func (s *shakeHash) BlockSize() int {
	if s.is256 {
		return 136
	}
	return 168
}

func (s *shakeHash) Sum(in []byte) []byte {
	var h *sha3.SHAKE
	if s.is256 {
		h = sha3.NewSHAKE256()
	} else {
		h = sha3.NewSHAKE128()
	}
	_, _ = h.Write(s.buf)
	out := make([]byte, s.size)
	_, _ = h.Read(out)
	return append(in, out...)
}

var ripemd160RL = [80]uint8{
	0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
	7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
	3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
	1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
	4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13,
}

var ripemd160RR = [80]uint8{
	5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12,
	6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
	15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
	8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
	12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11,
}

var ripemd160SL = [80]uint8{
	11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8,
	7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
	11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
	11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
	9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6,
}

var ripemd160SR = [80]uint8{
	8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6,
	9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
	9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
	15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
	8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11,
}

type ripemd160Hash struct {
	s   [5]uint32
	x   [64]byte
	nx  int
	len uint64
}

func newRIPEMD160() hash.Hash {
	d := new(ripemd160Hash)
	d.Reset()
	return d
}

func (d *ripemd160Hash) Reset() {
	d.s[0] = 0x67452301
	d.s[1] = 0xefcdab89
	d.s[2] = 0x98badcfe
	d.s[3] = 0x10325476
	d.s[4] = 0xc3d2e1f0
	d.nx = 0
	d.len = 0
}

func (d *ripemd160Hash) Size() int      { return 20 }
func (d *ripemd160Hash) BlockSize() int { return 64 }

func (d *ripemd160Hash) Write(p []byte) (int, error) {
	nn := len(p)
	d.len += uint64(nn)
	if d.nx > 0 {
		n := copy(d.x[d.nx:], p)
		d.nx += n
		if d.nx == 64 {
			d.block(d.x[:])
			d.nx = 0
		}
		p = p[n:]
	}
	for len(p) >= 64 {
		d.block(p[:64])
		p = p[64:]
	}
	if len(p) > 0 {
		d.nx = copy(d.x[:], p)
	}
	return nn, nil
}

func (d *ripemd160Hash) block(p []byte) {
	var w [16]uint32
	for i := 0; i < 16; i++ {
		w[i] = binary.LittleEndian.Uint32(p[i*4 : i*4+4])
	}
	al, bl, cl, dl, el := d.s[0], d.s[1], d.s[2], d.s[3], d.s[4]
	ar, br, cr, dr, er := d.s[0], d.s[1], d.s[2], d.s[3], d.s[4]
	for j := 0; j < 80; j++ {
		var fl, fr, kl, kr uint32
		switch j / 16 {
		case 0:
			fl = bl ^ cl ^ dl
			fr = br ^ (cr | ^dr)
			kl = 0x00000000
			kr = 0x50a28be6
		case 1:
			fl = (bl & cl) | (^bl & dl)
			fr = (br & dr) | (cr & ^dr)
			kl = 0x5a827999
			kr = 0x5c4dd124
		case 2:
			fl = (bl | ^cl) ^ dl
			fr = (br | ^cr) ^ dr
			kl = 0x6ed9eba1
			kr = 0x6d703ef3
		case 3:
			fl = (bl & dl) | (cl & ^dl)
			fr = (br & cr) | (^br & dr)
			kl = 0x8f1bbcdc
			kr = 0x7a6d76e9
		case 4:
			fl = bl ^ (cl | ^dl)
			fr = br ^ cr ^ dr
			kl = 0xa953fd4e
			kr = 0x00000000
		}
		tl := bits.RotateLeft32(al+fl+w[ripemd160RL[j]]+kl, int(ripemd160SL[j])) + el
		al = el
		el = dl
		dl = bits.RotateLeft32(cl, 10)
		cl = bl
		bl = tl

		tr := bits.RotateLeft32(ar+fr+w[ripemd160RR[j]]+kr, int(ripemd160SR[j])) + er
		ar = er
		er = dr
		dr = bits.RotateLeft32(cr, 10)
		cr = br
		br = tr
	}
	t := d.s[1] + cl + dr
	d.s[1] = d.s[2] + dl + er
	d.s[2] = d.s[3] + el + ar
	d.s[3] = d.s[4] + al + br
	d.s[4] = d.s[0] + bl + cr
	d.s[0] = t
}

func (d *ripemd160Hash) Sum(in []byte) []byte {
	tc := *d
	var tmp [64]byte
	tmp[0] = 0x80
	if tc.nx < 56 {
		_, _ = tc.Write(tmp[0 : 56-tc.nx])
	} else {
		_, _ = tc.Write(tmp[0 : 64+56-tc.nx])
	}
	var lenBytes [8]byte
	binary.LittleEndian.PutUint64(lenBytes[:], d.len<<3)
	_, _ = tc.Write(lenBytes[:])
	var digest [20]byte
	for i, s := range tc.s {
		binary.LittleEndian.PutUint32(digest[i*4:i*4+4], s)
	}
	return append(in, digest[:]...)
}

func chacha20Block(key *[32]byte, counter uint32, nonce *[12]byte, out *[64]byte) {
	var state [16]uint32
	state[0] = 0x61707865
	state[1] = 0x3320646e
	state[2] = 0x79622d32
	state[3] = 0x6b206574
	for i := 0; i < 8; i++ {
		state[4+i] = binary.LittleEndian.Uint32(key[i*4 : i*4+4])
	}
	state[12] = counter
	state[13] = binary.LittleEndian.Uint32(nonce[0:4])
	state[14] = binary.LittleEndian.Uint32(nonce[4:8])
	state[15] = binary.LittleEndian.Uint32(nonce[8:12])

	w := state
	qr := func(a, b, c, d int) {
		w[a] += w[b]
		w[d] = bits.RotateLeft32(w[d]^w[a], 16)
		w[c] += w[d]
		w[b] = bits.RotateLeft32(w[b]^w[c], 12)
		w[a] += w[b]
		w[d] = bits.RotateLeft32(w[d]^w[a], 8)
		w[c] += w[d]
		w[b] = bits.RotateLeft32(w[b]^w[c], 7)
	}
	for i := 0; i < 10; i++ {
		qr(0, 4, 8, 12)
		qr(1, 5, 9, 13)
		qr(2, 6, 10, 14)
		qr(3, 7, 11, 15)
		qr(0, 5, 10, 15)
		qr(1, 6, 11, 12)
		qr(2, 7, 8, 13)
		qr(3, 4, 9, 14)
	}
	for i := 0; i < 16; i++ {
		binary.LittleEndian.PutUint32(out[i*4:i*4+4], w[i]+state[i])
	}
}

func chacha20XOR(key *[32]byte, counter uint32, nonce *[12]byte, src []byte) []byte {
	dst := make([]byte, len(src))
	var block [64]byte
	off := 0
	for off < len(src) {
		chacha20Block(key, counter, nonce, &block)
		counter++
		n := len(src) - off
		if n > 64 {
			n = 64
		}
		for i := 0; i < n; i++ {
			dst[off+i] = src[off+i] ^ block[i]
		}
		off += n
	}
	return dst
}

func reverseBytesCopy(b []byte) []byte {
	out := make([]byte, len(b))
	for i := range b {
		out[len(b)-1-i] = b[i]
	}
	return out
}

func poly1305Tag(otk *[32]byte, msg []byte) [16]byte {
	var rBytes [16]byte
	copy(rBytes[:], otk[0:16])
	rBytes[3] &= 15
	rBytes[7] &= 15
	rBytes[11] &= 15
	rBytes[15] &= 15
	rBytes[4] &= 252
	rBytes[8] &= 252
	rBytes[12] &= 252

	r := new(big.Int).SetBytes(reverseBytesCopy(rBytes[:]))
	s := new(big.Int).SetBytes(reverseBytesCopy(otk[16:32]))
	p := new(big.Int).Lsh(big.NewInt(1), 130)
	p.Sub(p, big.NewInt(5))

	acc := new(big.Int)
	for off := 0; off < len(msg); off += 16 {
		end := off + 16
		if end > len(msg) {
			end = len(msg)
		}
		chunk := make([]byte, end-off+1)
		copy(chunk, msg[off:end])
		chunk[len(chunk)-1] = 1
		n := new(big.Int).SetBytes(reverseBytesCopy(chunk))
		acc.Add(acc, n)
		acc.Mul(acc, r)
		acc.Mod(acc, p)
	}
	acc.Add(acc, s)
	var tag [16]byte
	be := acc.Bytes()
	for i := 0; i < 16 && i < len(be); i++ {
		tag[i] = be[len(be)-1-i]
	}
	return tag
}

func chacha20Poly1305Cipher(key, iv, aad, tag, data []byte, decrypt bool) ([]byte, string, error) {
	if len(key) != 32 {
		return nil, "ERR_CRYPTO_INVALID_KEYLEN", fmt.Errorf("Invalid key length")
	}
	if len(iv) != 12 {
		return nil, "ERR_CRYPTO_INVALID_IV", fmt.Errorf("Invalid initialization vector")
	}
	var kArr [32]byte
	var nArr [12]byte
	copy(kArr[:], key)
	copy(nArr[:], iv)

	var block0 [64]byte
	chacha20Block(&kArr, 0, &nArr, &block0)
	var otk [32]byte
	copy(otk[:], block0[:32])

	buildMacInput := func(ct []byte) []byte {
		var macBuf []byte
		macBuf = append(macBuf, aad...)
		if rem := len(aad) % 16; rem != 0 {
			macBuf = append(macBuf, make([]byte, 16-rem)...)
		}
		macBuf = append(macBuf, ct...)
		if rem := len(ct) % 16; rem != 0 {
			macBuf = append(macBuf, make([]byte, 16-rem)...)
		}
		var lens [16]byte
		binary.LittleEndian.PutUint64(lens[0:8], uint64(len(aad)))
		binary.LittleEndian.PutUint64(lens[8:16], uint64(len(ct)))
		macBuf = append(macBuf, lens[:]...)
		return macBuf
	}

	if !decrypt {
		ct := chacha20XOR(&kArr, 1, &nArr, data)
		computed := poly1305Tag(&otk, buildMacInput(ct))
		out := make([]byte, len(ct)+16)
		copy(out, ct)
		copy(out[len(ct):], computed[:])
		return out, "", nil
	}
	if len(tag) != 16 {
		return nil, "ERR_CRYPTO_INVALID_AUTH_TAG", fmt.Errorf("Invalid authentication tag length: %d", len(tag))
	}
	expected := poly1305Tag(&otk, buildMacInput(data))
	if !hmac.Equal(expected[:], tag) {
		return nil, "ERR_CRYPTO_INVALID_STATE", fmt.Errorf("Unsupported state or unable to authenticate data")
	}
	pt := chacha20XOR(&kArr, 1, &nArr, data)
	return pt, "", nil
}

var (
	tzCacheMu sync.Mutex
	tzCache   = make(map[string]*time.Location)
)

func loadCachedTZLocation(name string) (*time.Location, error) {
	clean := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(name), ":"))
	if clean == "" {
		return time.Local, nil
	}
	switch strings.ToUpper(clean) {
	case "UTC", "GMT", "ETC/UTC", "ETC/GMT", "Z":
		return time.UTC, nil
	}
	if len(clean) >= 5 && (clean[0] == '+' || clean[0] == '-') {
		rest := clean[1:]
		var hh, mm int
		var n int
		if strings.Contains(rest, ":") {
			n, _ = fmt.Sscanf(rest, "%2d:%2d", &hh, &mm)
		} else if len(rest) == 4 {
			n, _ = fmt.Sscanf(rest, "%2d%2d", &hh, &mm)
		}
		if n == 2 && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59 {
			sign := 1
			if clean[0] == '-' {
				sign = -1
			}
			return time.FixedZone(clean, sign*(hh*3600+mm*60)), nil
		}
	}
	tzCacheMu.Lock()
	if loc, ok := tzCache[clean]; ok {
		tzCacheMu.Unlock()
		return loc, nil
	}
	tzCacheMu.Unlock()

	loc, err := time.LoadLocation(clean)
	if err != nil {
		return nil, err
	}
	tzCacheMu.Lock()
	tzCache[clean] = loc
	tzCacheMu.Unlock()
	return loc, nil
}
