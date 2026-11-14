// Copyright (c) 2017, Daniel Martí <mvdan@mvdan.cc>
// See LICENSE for licensing information

package expand

import (
	"errors"
	"fmt"
	"maps"
	"math"
	"slices"
	"strconv"
	"strings"

	"mvdan.cc/sh/v3/internal"
	"mvdan.cc/sh/v3/syntax"
)

// TODO(v4): the arithmetic APIs should return int64, which is what Bash uses
// via intmax_t even on 32-bit systems, rather than the platform-dependent int.

func Arithm(cfg *Config, expr syntax.ArithmExpr) (int, error) {
	if cfg == nil || cfg.Env == nil {
		cfg = prepareConfig(cfg)
	}
	switch expr := expr.(type) {
	case *syntax.Word:
		// Fast path: plain names and numeric literals dominate real
		// arithmetic ($((sum+i))); skipping the word machinery for them
		// is the difference between matching and beating bash in loops.
		if len(expr.Parts) == 1 {
			if lit, ok := expr.Parts[0].(*syntax.Lit); ok && arithLitSafe(lit.Value) {
				return arithWordNum(cfg, lit.Value)
			}
		}
		str, err := Literal(cfg, expr)
		if err != nil {
			return 0, err
		}
		return arithWordNum(cfg, str)
	case *syntax.ParenArithm:
		return Arithm(cfg, expr.X)
	case *syntax.UnaryArithm:
		switch expr.Op {
		case syntax.Inc, syntax.Dec:
			lv, err := cfg.resolveArithLval(expr.X)
			if err != nil {
				return 0, err
			}
			oldStr, err := lv.get(cfg)
			if err != nil {
				return 0, err
			}
			old, err := atoi(oldStr)
			if err != nil {
				return 0, err
			}
			val := old
			if expr.Op == syntax.Inc {
				val++
			} else {
				val--
			}
			if err := lv.set(cfg, formatArithInt64(val)); err != nil {
				return 0, err
			}
			if expr.Post {
				return int(old), nil
			}
			return int(val), nil
		}
		val, err := Arithm(cfg, expr.X)
		if err != nil {
			return 0, err
		}
		switch expr.Op {
		case syntax.Not:
			return oneIf(val == 0), nil
		case syntax.BitNegation:
			return ^val, nil
		case syntax.Plus:
			return val, nil
		case syntax.Minus:
			return -val, nil
		default:
			return 0, fmt.Errorf("unsupported unary arithmetic operator: %q", expr.Op)
		}
	case *syntax.BinaryArithm:
		switch expr.Op {
		case syntax.Assgn, syntax.AddAssgn, syntax.SubAssgn,
			syntax.MulAssgn, syntax.QuoAssgn, syntax.RemAssgn,
			syntax.AndAssgn, syntax.OrAssgn, syntax.XorAssgn,
			syntax.ShlAssgn, syntax.ShrAssgn:
			return cfg.assgnArit(expr)
		case syntax.TernQuest: // TernColon can't happen here
			cond, err := Arithm(cfg, expr.X)
			if err != nil {
				return 0, err
			}
			b2 := expr.Y.(*syntax.BinaryArithm) // must have Op==TernColon
			if cond != 0 {
				return Arithm(cfg, b2.X)
			}
			return Arithm(cfg, b2.Y)
		case syntax.AndArit, syntax.OrArit:
			// Like Bash, short-circuit the right operand.
			left, err := Arithm(cfg, expr.X)
			if err != nil {
				return 0, err
			}
			if expr.Op == syntax.AndArit && left == 0 {
				return 0, nil
			}
			if expr.Op == syntax.OrArit && left != 0 {
				return 1, nil
			}
			right, err := Arithm(cfg, expr.Y)
			if err != nil {
				return 0, err
			}
			return oneIf(right != 0), nil
		}
		left, err := Arithm(cfg, expr.X)
		if err != nil {
			return 0, err
		}
		right, err := Arithm(cfg, expr.Y)
		if err != nil {
			return 0, err
		}
		return binArit(expr.Op, left, right)
	case *syntax.FlagsArithm: // e.g. zsh's ${a[(r)b]}
		return 0, fmt.Errorf("unsupported")
	default:
		panic(fmt.Sprintf("unexpected arithm expr: %T", expr))
	}
}

func oneIf(b bool) int {
	if b {
		return 1
	}
	return 0
}

// arithLitSafe reports whether an arithmetic word is a plain name or
// number literal (no expansions or escapes to process).
func arithLitSafe(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') ||
			(c >= 'A' && c <= 'Z') || c == '_' {
			continue
		}
		return false
	}
	return s != ""
}

// arithWordNum resolves an arithmetic word: valid names dereference
// variables (including namerefs), everything else is a number.
func arithWordNum(cfg *Config, str string) (int, error) {
	// Fast path: non-empty string starting with an ASCII digit cannot be a
	// shell variable name, so skip ValidName entirely.
	if len(str) == 0 || str[0] < '0' || str[0] > '9' {
		i := 0
		for syntax.ValidName(str) {
			val := cfg.envGet(str)
			if val == "" {
				return 0, nil
			}
			if i++; i >= maxNameRefDepth {
				break
			}
			str = val
			if len(str) > 0 && str[0] >= '0' && str[0] <= '9' {
				break
			}
		}
	}
	// default to 0
	n, err := atoi(str)
	if err != nil {
		return 0, err
	}
	return int(n), nil
}

func formatArithInt64(v int64) string {
	if v >= 0 && v < smallIntLimit {
		return FormatIntFast(int(v))
	}
	return strconv.FormatInt(v, 10)
}

// atoi is like [strconv.ParseInt](s, BASE, 64), but it handles integer
// base prefixes according to bash-shell's rules and trims whitespace.
// Invalid numbers are errors, as in bash ("value too great for base").
//
// For more information about bash's integer base handling syntax,
// refer to the bash manual:
// https://www.man7.org/linux/man-pages/man1/bash.1.html
func atoi(s string) (int64, error) {
	if s == "" || s == "0" {
		return 0, nil
	}
	if len(s) <= 18 && s[0] >= '1' && s[0] <= '9' {
		n := int64(s[0] - '0')
		plain := true
		for i := 1; i < len(s); i++ {
			c := s[i]
			if c < '0' || c > '9' {
				plain = false
				break
			}
			n = n*10 + int64(c-'0')
		}
		if plain {
			return n, nil
		}
	}
	orig := strings.TrimSpace(s)
	s = orig
	neg := false
	switch {
	case strings.HasPrefix(s, "+"):
		s = s[1:]
	case strings.HasPrefix(s, "-"):
		neg = true
		s = s[1:]
	}
	base := int64(10)
	switch {
	case strings.HasPrefix(s, "0x") || strings.HasPrefix(s, "0X"):
		base = 16
		s = s[2:]
	case strings.HasPrefix(s, "0") && len(s) > 1:
		// A leading zero means octal in bash; "0o10" and "08" are
		// therefore "value too great for base" errors.
		base = 8
		s = s[1:]
	case strings.HasPrefix(s, "0"):
		s = s[1:]
	default:
		baseStr, intStr, hasSep := strings.Cut(s, "#")
		if hasSep {
			var err error
			base, err = strconv.ParseInt(baseStr, 10, 8)
			if err != nil || base < 2 || base > 64 {
				return 0, valueTooGreat(orig)
			}
			s = intStr
		}
	}
	if s == "" {
		if neg {
			return 0, nil
		}
		return 0, nil
	}
	var n int64
	if base > 36 {
		var ok bool
		n, ok = atoiLargeBase(s, base)
		if !ok {
			return 0, valueTooGreat(orig)
		}
	} else {
		v, err := strconv.ParseInt(s, int(base), 64)
		if err != nil {
			var numErr *strconv.NumError
			if errors.As(err, &numErr) && numErr.Err == strconv.ErrRange {
				// Overflow clamps, like bash.
				if v < 0 {
					return math.MinInt64, nil
				}
				return math.MaxInt64, nil
			}
			return 0, valueTooGreat(orig)
		}
		n = v
	}
	if neg {
		n = -n
	}
	return n, nil
}

func valueTooGreat(tok string) error {
	return fmt.Errorf("%s: value too great for base (error token is %q)", tok, tok)
}

// atoiLargeBase parses bases 37 to 64, which [strconv.ParseInt] does not
// support, using bash's digit set: 0-9, a-z, A-Z, "@", and "_".
func atoiLargeBase(s string, base int64) (int64, bool) {
	var n int64
	for i := range len(s) {
		var d int64
		switch c := s[i]; {
		case c >= '0' && c <= '9':
			d = int64(c - '0')
		case c >= 'a' && c <= 'z':
			d = int64(c-'a') + 10
		case c >= 'A' && c <= 'Z':
			d = int64(c-'A') + 36
		case c == '@':
			d = 62
		case c == '_':
			d = 63
		default:
			return 0, false
		}
		if d >= base {
			return 0, false
		}
		n = n*base + d
	}
	return n, true
}

type arithLval struct {
	name     string
	indexed  bool
	assoc    bool
	elemIdx  int
	assocKey string
}

func (cfg *Config) resolveArithLval(expr syntax.ArithmExpr) (arithLval, error) {
	for {
		p, ok := expr.(*syntax.ParenArithm)
		if !ok {
			break
		}
		expr = p.X
	}
	w, ok := expr.(*syntax.Word)
	if !ok {
		return arithLval{}, fmt.Errorf("attempted assignment to non-variable")
	}
	if len(w.Parts) == 1 {
		if pe, ok := w.Parts[0].(*syntax.ParamExp); ok && pe.Short && pe.Index != nil && pe.Param != nil &&
			!pe.Excl && !pe.Length && pe.Repl == nil && pe.Exp == nil && pe.Slice == nil {
			name := pe.Param.Value
			if !syntax.ValidName(name) {
				return arithLval{}, fmt.Errorf("attempted assignment to non-variable (error token is %q)", name)
			}
			vr := cfg.Env.Get(name)
			if wenv, ok := cfg.Env.(WriteEnviron); ok {
				if n, v := vr.Resolve(wenv); n != "" {
					name, vr = n, v
				}
			}
			if vr.Kind == Associative {
				key, err := AssocKey(cfg, pe.Index)
				if err != nil {
					return arithLval{}, err
				}
				return arithLval{name: name, assoc: true, assocKey: key}, nil
			}
			idx, err := Arithm(cfg, pe.Index)
			if err != nil {
				return arithLval{}, err
			}
			if idx < 0 {
				var list []string
				var indexes []int
				switch vr.Kind {
				case String:
					if vr.IsSet() {
						list = []string{vr.Str}
					}
				case Indexed:
					list, indexes = vr.List, vr.Indexes
				}
				if idx += internal.IndexedMax(list, indexes) + 1; idx < 0 {
					return arithLval{}, fmt.Errorf("%s: bad array subscript", name)
				}
			}
			return arithLval{name: name, indexed: true, elemIdx: idx}, nil
		}
	}
	name := w.Lit()
	if name == "" {
		var err error
		name, err = Literal(cfg, w)
		if err != nil {
			return arithLval{}, err
		}
	}
	if !syntax.ValidName(name) {
		return arithLval{}, fmt.Errorf("attempted assignment to non-variable (error token is %q)", name)
	}
	return arithLval{name: name}, nil
}

func (lv arithLval) get(cfg *Config) (string, error) {
	if !lv.indexed && !lv.assoc {
		return cfg.envGet(lv.name), nil
	}
	vr := cfg.Env.Get(lv.name)
	if wenv, ok := cfg.Env.(WriteEnviron); ok {
		if _, v := vr.Resolve(wenv); v.IsSet() || v.Kind != Unknown {
			vr = v
		}
	}
	if lv.assoc {
		return vr.Map[lv.assocKey], nil
	}
	switch vr.Kind {
	case String:
		if lv.elemIdx == 0 {
			return vr.Str, nil
		}
	case Indexed:
		if s, ok := vr.indexedVal(lv.elemIdx); ok {
			return s, nil
		}
	}
	return "", nil
}

func (lv arithLval) set(cfg *Config, val string) error {
	if !lv.indexed && !lv.assoc {
		return cfg.envSet(lv.name, val)
	}
	wenv, ok := cfg.Env.(WriteEnviron)
	if !ok {
		return fmt.Errorf("environment is read-only")
	}
	name := lv.name
	vr := cfg.Env.Get(name)
	if n, v := vr.Resolve(wenv); n != "" {
		name, vr = n, v
	}
	if lv.assoc {
		vr.Kind = Associative
		vr.Map = maps.Clone(vr.Map)
		if vr.Map == nil {
			vr.Map = make(map[string]string, 1)
		}
		vr.Map[lv.assocKey] = val
		vr.Set = true
		return wenv.Set(name, vr)
	}
	list, indexes := slices.Clone(vr.List), slices.Clone(vr.Indexes)
	if vr.Kind == String && vr.IsSet() {
		list, indexes = []string{vr.Str}, nil
	}
	list, indexes = internal.SetIndexedElem(list, indexes, lv.elemIdx, val)
	vr.Kind, vr.Str, vr.List, vr.Indexes = Indexed, "", list, indexes
	vr.Set = true
	return wenv.Set(name, vr)
}

func (cfg *Config) assgnArit(b *syntax.BinaryArithm) (int, error) {
	lv, err := cfg.resolveArithLval(b.X)
	if err != nil {
		return 0, err
	}
	var val int64
	if b.Op != syntax.Assgn {
		oldStr, err := lv.get(cfg)
		if err != nil {
			return 0, err
		}
		val, err = atoi(oldStr)
		if err != nil {
			return 0, err
		}
	}
	arg_, err := Arithm(cfg, b.Y)
	if err != nil {
		return 0, err
	}
	arg := int64(arg_)
	switch b.Op {
	case syntax.Assgn:
		val = arg
	case syntax.AddAssgn:
		val += arg
	case syntax.SubAssgn:
		val -= arg
	case syntax.MulAssgn:
		val *= arg
	case syntax.QuoAssgn:
		if arg == 0 {
			return 0, fmt.Errorf("division by 0")
		}
		val /= arg
	case syntax.RemAssgn:
		if arg == 0 {
			return 0, fmt.Errorf("remainder by 0")
		}
		val %= arg
	case syntax.AndAssgn:
		val &= arg
	case syntax.OrAssgn:
		val |= arg
	case syntax.XorAssgn:
		val ^= arg
	case syntax.ShlAssgn:
		val <<= uint(arg)
	case syntax.ShrAssgn:
		val >>= uint(arg)
	}
	if err := lv.set(cfg, formatArithInt64(val)); err != nil {
		return 0, err
	}
	return int(val), nil
}

func intPow(a, b int) int {
	p := 1
	for b > 0 {
		if b&1 != 0 {
			p *= a
		}
		b >>= 1
		a *= a
	}
	return p
}

func binArit(op syntax.BinAritOperator, x, y int) (int, error) {
	switch op {
	case syntax.Add:
		return x + y, nil
	case syntax.Sub:
		return x - y, nil
	case syntax.Mul:
		return x * y, nil
	case syntax.Quo:
		if y == 0 {
			return 0, fmt.Errorf("division by 0")
		}
		return x / y, nil
	case syntax.Rem:
		if y == 0 {
			return 0, fmt.Errorf("remainder by 0")
		}
		return x % y, nil
	case syntax.Pow:
		if y < 0 {
			return 0, fmt.Errorf("exponent less than 0")
		}
		return intPow(x, y), nil
	case syntax.Eql:
		return oneIf(x == y), nil
	case syntax.Gtr:
		return oneIf(x > y), nil
	case syntax.Lss:
		return oneIf(x < y), nil
	case syntax.Neq:
		return oneIf(x != y), nil
	case syntax.Leq:
		return oneIf(x <= y), nil
	case syntax.Geq:
		return oneIf(x >= y), nil
	case syntax.And:
		return x & y, nil
	case syntax.Or:
		return x | y, nil
	case syntax.Xor:
		return x ^ y, nil
	case syntax.Shr:
		return x >> uint(y), nil
	case syntax.Shl:
		return x << uint(y), nil
	case syntax.Comma:
		// x is executed but its result discarded
		return y, nil
	default:
		return 0, fmt.Errorf("unsupported binary arithmetic operator: %q", op)
	}
}
