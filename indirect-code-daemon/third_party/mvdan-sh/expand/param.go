// Copyright (c) 2017, Daniel Martí <mvdan@mvdan.cc>
// See LICENSE for licensing information

package expand

import (
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"mvdan.cc/sh/v3/internal"
	"mvdan.cc/sh/v3/syntax"
)

func nodeLit(node syntax.Node) string {
	if word, ok := node.(*syntax.Word); ok {
		return word.Lit()
	}
	return ""
}

// UnsetParameterError is returned when a parameter expansion encounters an
// unset variable and [Config.NoUnset] has been set.
type UnsetParameterError struct {
	Node    *syntax.ParamExp
	Message string
}

func (u UnsetParameterError) Error() string {
	return fmt.Sprintf("%s: %s", u.Node.Param.Value, u.Message)
}

func overridingUnset(pe *syntax.ParamExp) bool {
	if pe.Exp == nil {
		return false
	}
	switch pe.Exp.Op {
	case syntax.AlternateUnset, syntax.AlternateUnsetOrNull,
		syntax.DefaultUnset, syntax.DefaultUnsetOrNull,
		syntax.ErrorUnset, syntax.ErrorUnsetOrNull,
		syntax.AssignUnset, syntax.AssignUnsetOrNull:
		return true
	}
	return false
}

func (cfg *Config) paramExp(pe *syntax.ParamExp) (string, error) {
	oldParam := cfg.curParam
	cfg.curParam = pe
	defer func() { cfg.curParam = oldParam }()

	if pe.Param == nil { // e.g. zsh's ${}
		return "", fmt.Errorf("unsupported")
	}
	name := pe.Param.Value
	index := pe.Index
	switch name {
	case "@", "*":
		index = &syntax.Word{Parts: []syntax.WordPart{
			&syntax.Lit{Value: name},
		}}
	}
	// "*" expansions like ${*}, ${arr[*]}, or ${!prefix*} join their
	// elements with the first IFS character; others use a space.
	join := func(elems []string) string {
		if nodeLit(index) == "*" || pe.Names == syntax.NamesPrefix {
			return cfg.ifsJoin(elems)
		}
		return strings.Join(elems, " ")
	}
	var vr Variable
	switch name {
	case "LINENO":
		// This is the only parameter expansion that the environment
		// interface cannot satisfy.
		line := uint64(cfg.curParam.Pos().Line())
		vr = Variable{Set: true, Kind: String, Str: strconv.FormatUint(line, 10)}
	default:
		vr = cfg.Env.Get(name)
	}
	orig := vr
	if n, v := vr.Resolve(cfg.Env); n != "" {
		name, vr = n, v
	}
	if cfg.NoUnset && !vr.IsSet() && !overridingUnset(pe) {
		return "", UnsetParameterError{
			Node:    pe,
			Message: "unbound variable",
		}
	}

	var sliceOffset, sliceLen int
	if pe.Slice != nil {
		var err error
		if pe.Slice.Offset != nil {
			sliceOffset, err = Arithm(cfg, pe.Slice.Offset)
			if err != nil {
				return "", err
			}
		}
		if pe.Slice.Length != nil {
			sliceLen, err = Arithm(cfg, pe.Slice.Length)
			if err != nil {
				return "", err
			}
		}
	}

	var (
		str   string
		elems []string

		indexAllElements bool // true if var has been accessed with * or @ index
		callVarInd       = true
		set              = vr.IsSet()
	)

	switch nodeLit(index) {
	case "@", "*":
		switch vr.Kind {
		case Unknown:
			elems = nil
			indexAllElements = true
		case Indexed:
			indexAllElements = true
			callVarInd = false
			elems = cfg.sliceElems(pe, vr.List, vr.Indexes, name == "@" || name == "*")
			str = join(elems)
		}
	}
	if callVarInd {
		var err error
		str, set, err = cfg.varInd(vr, index)
		if err != nil {
			return "", err
		}
	}
	var singleElem [1]string
	if !indexAllElements {
		singleElem[0] = str
		elems = singleElem[:]
	}

	switch {
	case pe.Length:
		n := len(elems)
		switch nodeLit(index) {
		case "@", "*":
		default:
			n = utf8.RuneCountInString(str)
		}
		str = FormatIntFast(n)
	case pe.Excl:
		var strs []string
		switch {
		case pe.Names != 0:
			strs = cfg.namesByPrefix(pe.Param.Value)
		case orig.Kind == NameRef:
			strs = append(strs, orig.Str)
		case pe.Index != nil && vr.Kind == Indexed:
			strs = vr.indexedKeys()
		case pe.Index != nil && vr.Kind == Associative:
			strs = slices.Sorted(maps.Keys(vr.Map))
		case !vr.IsSet():
			return "", fmt.Errorf("invalid indirect expansion")
		case str == "":
			return "", nil
		default:
			vr = cfg.Env.Get(str)
			strs = append(strs, vr.String())
		}
		str = join(strs)
	case pe.Width:
		return "", fmt.Errorf("unsupported")
	case pe.IsSet:
		return "", fmt.Errorf("unsupported")
	case pe.Slice != nil:
		if callVarInd {
			// The offset and length are in characters, not bytes.
			rs := []rune(str)
			slicePos := func(n int) int {
				if n < 0 {
					n = len(rs) + n
					if n < 0 {
						n = len(rs)
					}
				} else if n > len(rs) {
					n = len(rs)
				}
				return n
			}
			if pe.Slice.Offset != nil {
				rs = rs[slicePos(sliceOffset):]
			}
			if pe.Slice.Length != nil {
				rs = rs[:slicePos(sliceLen)]
			}
			str = string(rs)
		} // else, elems are already sliced
	case pe.Repl != nil:
		if !indexAllElements {
			var err error
			str, err = cfg.replaceScalar(pe.Repl, str)
			if err != nil {
				return "", err
			}
			break
		}
		elems, err := cfg.replaceElems(pe.Repl, elems)
		if err != nil {
			return "", err
		}
		str = join(elems)
	case pe.Exp != nil:
		arg, err := Literal(cfg, pe.Exp.Word)
		if err != nil {
			return "", err
		}
		switch op := pe.Exp.Op; op {
		case syntax.AlternateUnsetOrNull:
			if str == "" {
				break
			}
			fallthrough
		case syntax.AlternateUnset:
			if set {
				str = arg
			}
		case syntax.DefaultUnset:
			if set {
				break
			}
			fallthrough
		case syntax.DefaultUnsetOrNull:
			if str == "" {
				str = arg
			}
		case syntax.ErrorUnset:
			if set {
				break
			}
			fallthrough
		case syntax.ErrorUnsetOrNull:
			if str == "" {
				return "", UnsetParameterError{
					Node:    pe,
					Message: arg,
				}
			}
		case syntax.AssignUnset:
			if set {
				break
			}
			fallthrough
		case syntax.AssignUnsetOrNull:
			if str == "" {
				if err := cfg.assignElem(name, vr, index, arg); err != nil {
					return "", err
				}
				str = arg
			}
		case syntax.RemSmallPrefix, syntax.RemLargePrefix,
			syntax.RemSmallSuffix, syntax.RemLargeSuffix:
			if !indexAllElements {
				suffix := op == syntax.RemSmallSuffix || op == syntax.RemLargeSuffix
				small := op == syntax.RemSmallPrefix || op == syntax.RemSmallSuffix
				str = removePattern(str, arg, suffix, small)
				break
			}
			str = join(cfg.removePatternElems(op, arg, elems))
		case syntax.UpperFirst, syntax.UpperAll,
			syntax.LowerFirst, syntax.LowerAll, syntax.ToggleFirst:
			str = join(cfg.caseConvElems(op, arg, elems))
		case syntax.OtherParamOps:
			switch arg {
			case "Q":
				str, err = syntax.Quote(str, syntax.LangBash)
				if err != nil {
					// Is this even possible? If a user runs into this panic,
					// it's most likely a bug we need to fix.
					panic(err)
				}
			case "E":
				tail := str
				var rns []rune
				for tail != "" {
					var rn rune
					rn, _, tail, _ = strconv.UnquoteChar(tail, 0)
					rns = append(rns, rn)
				}
				str = string(rns)
			case "a":
				// ${var@a} returns variable attribute flags.
				// We use orig (before nameref resolve) for the attributes.
				str = orig.Flags()
			case "A":
				// ${var@A} returns a declare statement that recreates the variable.
				flags := orig.Flags()
				quoted, err := syntax.Quote(str, syntax.LangBash)
				if err != nil {
					return "", err
				}
				if flags == "" {
					str = fmt.Sprintf("%s=%s", name, quoted)
				} else {
					str = fmt.Sprintf("declare -%s %s=%s", flags, name, quoted)
				}
			case "P":
				// TODO: implement prompt expansion (\u, \h, \w, etc.).
			case "U":
				str = strings.ToUpper(str)
			case "u":
				rs := []rune(str)
				if len(rs) > 0 {
					rs[0] = unicode.ToUpper(rs[0])
					str = string(rs)
				}
			case "L":
				str = strings.ToLower(str)
			case "K", "k":
				// TODO: implement, like @A but listing keys for assoc arrays.
			default:
				panic(fmt.Sprintf("unexpected @%s param expansion", arg))
			}
		}
	}
	return str, nil
}

func isPlainPatternLiteral(s string) bool {
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '*', '?', '[', '\\':
			return false
		}
	}
	return true
}

func removePattern(str, pat string, fromEnd, shortest bool) string {
	if pat == "" || str == "" {
		return str
	}
	if pat == "*" {
		if shortest {
			return str
		}
		return ""
	}
	if isPlainPatternLiteral(pat) {
		if fromEnd {
			return strings.TrimSuffix(str, pat)
		}
		return strings.TrimPrefix(str, pat)
	}
	if pat[0] == '*' && isPlainPatternLiteral(pat[1:]) {
		lit := pat[1:]
		if !fromEnd {
			if shortest {
				if idx := strings.Index(str, lit); idx >= 0 {
					return str[idx+len(lit):]
				}
				return str
			}
			if idx := strings.LastIndex(str, lit); idx >= 0 {
				return str[idx+len(lit):]
			}
			return str
		}
		if strings.HasSuffix(str, lit) {
			if shortest {
				return str[:len(str)-len(lit)]
			}
			return ""
		}
		return str
	}
	if pat[len(pat)-1] == '*' && isPlainPatternLiteral(pat[:len(pat)-1]) {
		lit := pat[:len(pat)-1]
		if fromEnd {
			if shortest {
				if idx := strings.LastIndex(str, lit); idx >= 0 {
					return str[:idx]
				}
				return str
			}
			if idx := strings.Index(str, lit); idx >= 0 {
				return str[:idx]
			}
			return str
		}
		if strings.HasPrefix(str, lit) {
			if shortest {
				return str[len(lit):]
			}
			return ""
		}
		return str
	}

	rx, ok := cachedRemoveRegexp(pat, fromEnd, shortest)
	if !ok {
		return str
	}
	if loc := rx.FindStringSubmatchIndex(str); loc != nil {
		// remove the original pattern (the submatch)
		str = str[:loc[2]] + str[loc[3]:]
	}
	return str
}

// The helpers below never modify elems in place, as it may alias a
// variable's list of elements.

// perElemOps applies pattern removal, replacement, or case conversion to
// each element, leaving them unchanged for any whole-expansion operator.
func (cfg *Config) perElemOps(pe *syntax.ParamExp, elems []string) ([]string, error) {
	switch {
	case pe.Repl != nil:
		return cfg.replaceElems(pe.Repl, elems)
	case pe.Exp != nil:
		arg, err := Literal(cfg, pe.Exp.Word)
		if err != nil {
			return nil, err
		}
		switch op := pe.Exp.Op; op {
		case syntax.RemSmallPrefix, syntax.RemLargePrefix,
			syntax.RemSmallSuffix, syntax.RemLargeSuffix:
			return cfg.removePatternElems(op, arg, elems), nil
		case syntax.UpperFirst, syntax.UpperAll,
			syntax.LowerFirst, syntax.LowerAll, syntax.ToggleFirst:
			return cfg.caseConvElems(op, arg, elems), nil
		}
	}
	return elems, nil
}

func (cfg *Config) parseReplaceSpec(repl *syntax.Replace) (orig, with string, anchor byte, plainOrig, plainWith, noop bool, err error) {
	orig, err = Pattern(cfg, repl.Orig)
	if err != nil {
		return "", "", 0, false, false, false, err
	}
	if orig == "" {
		return "", "", 0, false, false, true, nil
	}
	// bash/GNU anchors: ${var/#pat/rep} only matches at the start of the
	// value, ${var/%pat/rep} only at the end. Only an unquoted, unescaped
	// leading '#' or '%' acts as an anchor; "${var/"#"/rep}" and
	// "${var/\#/rep}" match literal '#' characters.
	if repl.Orig != nil && len(repl.Orig.Parts) > 0 {
		if lit, ok := repl.Orig.Parts[0].(*syntax.Lit); ok && len(lit.Value) > 0 && (lit.Value[0] == '#' || lit.Value[0] == '%') {
			anchor = orig[0]
			orig = orig[1:]
			if orig == "" {
				return "", "", 0, false, false, true, nil
			}
		}
	}
	with, err = literalReplace(cfg, repl.With)
	if err != nil {
		return "", "", 0, false, false, false, err
	}
	plainOrig = isPlainPatternLiteral(orig)
	plainWith = strings.IndexByte(with, '&') < 0 && strings.IndexByte(with, '\x01') < 0
	return orig, with, anchor, plainOrig, plainWith, false, nil
}

func (cfg *Config) replaceOneElem(orig, with string, anchor byte, all, plainOrig, plainWith bool, elem string) string {
	if plainOrig && plainWith {
		switch anchor {
		case '#':
			if strings.HasPrefix(elem, orig) {
				return with + elem[len(orig):]
			}
			return elem
		case '%':
			if strings.HasSuffix(elem, orig) {
				return elem[:len(elem)-len(orig)] + with
			}
			return elem
		default:
			if all {
				return strings.ReplaceAll(elem, orig, with)
			}
			return strings.Replace(elem, orig, with, 1)
		}
	}
	n := 1
	if all || anchor == '%' {
		n = -1
	}
	locs := findAllIndex(orig, elem, n)
	if anchor != 0 {
		filtered := locs[:0]
		for _, loc := range locs {
			if (anchor == '#' && loc[0] == 0) || (anchor == '%' && loc[1] == len(elem)) {
				filtered = append(filtered, loc)
			}
		}
		locs = filtered
		if anchor == '%' && !all && len(locs) > 1 {
			locs = locs[len(locs)-1:]
		}
		if anchor == '#' && !all && len(locs) > 1 {
			locs = locs[:1]
		}
	}
	if len(locs) == 0 {
		return elem
	}
	sb := cfg.strBuilder()
	last := 0
	for _, loc := range locs {
		sb.WriteString(elem[last:loc[0]])
		if plainWith {
			sb.WriteString(with)
		} else {
			// bash: & is the matched text; \& is a literal &.
			sb.WriteString(strings.ReplaceAll(strings.ReplaceAll(with, "&", elem[loc[0]:loc[1]]), replaceEscAmp, "&"))
		}
		last = loc[1]
	}
	sb.WriteString(elem[last:])
	return sb.String()
}

func (cfg *Config) replaceScalar(repl *syntax.Replace, str string) (string, error) {
	orig, with, anchor, plainOrig, plainWith, noop, err := cfg.parseReplaceSpec(repl)
	if err != nil || noop {
		return str, err
	}
	return cfg.replaceOneElem(orig, with, anchor, repl.All, plainOrig, plainWith, str), nil
}

// replaceElems applies a ${var/pattern/repl} replacement to each element.
func (cfg *Config) replaceElems(repl *syntax.Replace, elems []string) ([]string, error) {
	orig, with, anchor, plainOrig, plainWith, noop, err := cfg.parseReplaceSpec(repl)
	if err != nil || noop {
		return elems, err
	}
	out := make([]string, len(elems))
	for i, elem := range elems {
		out[i] = cfg.replaceOneElem(orig, with, anchor, repl.All, plainOrig, plainWith, elem)
	}
	return out, nil
}

// replaceEscAmp marks a literal '&' coming from a \& escape in the
// replacement word, so that plain '&' can be substituted per match.
const replaceEscAmp = "\x01"

// literalReplace expands the replacement word of ${var/pat/rep}, keeping
// \& and quoted '&' distinguishable from an unquoted '&' (bash matched-text syntax).
func literalReplace(cfg *Config, w *syntax.Word) (string, error) {
	if w == nil {
		return "", nil
	}
	if len(w.Parts) == 1 {
		switch pt := w.Parts[0].(type) {
		case *syntax.Lit:
			s := pt.Value
			if s == "" || (s[0] != '~' && strings.IndexByte(s, '\\') < 0 && strings.IndexByte(s, 0) < 0) {
				return s, nil
			}
		case *syntax.SglQuoted:
			if !pt.Dollar && strings.IndexByte(pt.Value, '&') < 0 {
				return pt.Value, nil
			}
		}
	}
	cloned := *w
	cloned.Parts = escapeReplaceParts(cfg, w.Parts, false)
	return Literal(cfg, &cloned)
}

func escapeReplaceParts(cfg *Config, parts []syntax.WordPart, quoted bool) []syntax.WordPart {
	out := make([]syntax.WordPart, len(parts))
	for i, p := range parts {
		switch pt := p.(type) {
		case *syntax.Lit:
			nl := *pt
			if quoted {
				nl.Value = strings.ReplaceAll(pt.Value, "&", replaceEscAmp)
			} else {
				var sb strings.Builder
				s := pt.Value
				sb.Grow(len(s))
				for j := 0; j < len(s); j++ {
					if s[j] == '\\' && j+1 < len(s) {
						switch s[j+1] {
						case '&':
							sb.WriteString(replaceEscAmp)
							j++
							continue
						case '\\':
							sb.WriteByte('\\')
							j++
							continue
						}
					}
					sb.WriteByte(s[j])
				}
				nl.Value = sb.String()
			}
			out[i] = &nl
		case *syntax.SglQuoted:
			ns := *pt
			if ns.Dollar {
				val, _, _ := Format(cfg, ns.Value, nil)
				val, _, _ = strings.Cut(val, "\x00")
				ns.Dollar = false
				ns.Value = strings.ReplaceAll(val, "&", replaceEscAmp)
			} else {
				ns.Value = strings.ReplaceAll(ns.Value, "&", replaceEscAmp)
			}
			out[i] = &ns
		case *syntax.DblQuoted:
			nd := *pt
			nd.Parts = escapeReplaceParts(cfg, pt.Parts, true)
			out[i] = &nd
		default:
			out[i] = p
		}
	}
	return out
}

// AssocKey expands an associative-array subscript expression as a string key,
// handling both [*syntax.Word] subscripts (e.g. m[foo], m["a-b"]) and
// subscripts tokenized as arithmetic expressions due to unquoted operators
// such as '-' or '+' (e.g. m[foo-bar], m[$k-port]).
func AssocKey(cfg *Config, idx syntax.ArithmExpr) (string, error) {
	if idx == nil {
		return "", nil
	}
	switch x := idx.(type) {
	case *syntax.Word:
		return Literal(cfg, x)
	case *syntax.ParenArithm:
		inner, err := AssocKey(cfg, x.X)
		if err != nil {
			return "", err
		}
		return "(" + inner + ")", nil
	case *syntax.UnaryArithm:
		inner, err := AssocKey(cfg, x.X)
		if err != nil {
			return "", err
		}
		if x.Post {
			return inner + x.Op.String(), nil
		}
		return x.Op.String() + inner, nil
	case *syntax.BinaryArithm:
		left, err := AssocKey(cfg, x.X)
		if err != nil {
			return "", err
		}
		right, err := AssocKey(cfg, x.Y)
		if err != nil {
			return "", err
		}
		op := x.Op.String()
		var lpad, rpad string
		if x.OpPos.IsValid() && x.X.End().IsValid() && x.OpPos.Offset() > x.X.End().Offset() {
			if n := int(x.OpPos.Offset() - x.X.End().Offset()); n > 0 && n <= 64 {
				lpad = strings.Repeat(" ", n)
			}
		}
		if x.OpPos.IsValid() && x.Y.Pos().IsValid() {
			opEnd := x.OpPos.Offset() + uint(len(op))
			if x.Y.Pos().Offset() > opEnd {
				if n := int(x.Y.Pos().Offset() - opEnd); n > 0 && n <= 64 {
					rpad = strings.Repeat(" ", n)
				}
			}
		}
		return left + lpad + op + rpad + right, nil
	default:
		return "", fmt.Errorf("unsupported associative subscript: %T", idx)
	}
}

// removePatternElems applies a pattern removal operator to each element.
func (cfg *Config) removePatternElems(op syntax.ParExpOperator, arg string, elems []string) []string {
	suffix := op == syntax.RemSmallSuffix || op == syntax.RemLargeSuffix
	small := op == syntax.RemSmallPrefix || op == syntax.RemSmallSuffix
	out := make([]string, len(elems))
	for i, elem := range elems {
		out[i] = removePattern(elem, arg, suffix, small)
	}
	return out
}

// caseConvElems applies a case conversion operator to each element.
func (cfg *Config) caseConvElems(op syntax.ParExpOperator, arg string, elems []string) []string {
	caseFunc := unicode.ToLower
	if op == syntax.UpperFirst || op == syntax.UpperAll {
		caseFunc = unicode.ToUpper
	}
	toggle := op == syntax.ToggleFirst
	all := op == syntax.UpperAll || op == syntax.LowerAll

	// empty string means '?'; every character matches — skip the regex.
	allMatch := arg == ""
	var rx *regexp.Regexp
	if !allMatch {
		expr, err := cachedPattern(arg, 0)
		if err != nil {
			return elems
		}
		rx = cachedRegexp(expr)
	}

	out := make([]string, len(elems))
	for i, elem := range elems {
		rs := []rune(elem)
		for ri, r := range rs {
			if allMatch || rx.MatchString(string(r)) {
				if toggle {
					if unicode.IsUpper(r) {
						rs[ri] = unicode.ToLower(r)
					} else {
						rs[ri] = unicode.ToUpper(r)
					}
				} else {
					rs[ri] = caseFunc(r)
				}
			}
			if !all {
				break // only the first character is considered
			}
		}
		out[i] = string(rs)
	}
	return out
}

// varInd expands an indexed variable expansion like ${a[i]}, also reporting
// whether the resulting element is set, which may be false for missing array
// elements such as the holes in a sparse array.
func (cfg *Config) varInd(vr Variable, idx syntax.ArithmExpr) (string, bool, error) {
	if idx == nil {
		switch vr.Kind {
		case Indexed:
			// A bare $a is the element at index zero, which may be unset.
			str, ok := vr.indexedVal(0)
			return str, ok, nil
		case Associative:
			str, ok := vr.Map["0"]
			return str, ok, nil
		}
		return vr.String(), vr.IsSet(), nil
	}
	switch vr.Kind {
	case String:
		n, err := Arithm(cfg, idx)
		if err != nil {
			return "", false, err
		}
		if n == 0 {
			return vr.Str, vr.IsSet(), nil
		}
	case Indexed:
		switch nodeLit(idx) {
		case "*", "@":
			return strings.Join(vr.List, " "), vr.IsSet(), nil
		}
		i, err := Arithm(cfg, idx)
		if err != nil {
			return "", false, err
		}
		if i < 0 {
			// Negative indices count from one past the maximum index.
			if i += internal.IndexedMax(vr.List, vr.Indexes) + 1; i < 0 {
				return "", false, fmt.Errorf("negative array index")
			}
		}
		if str, ok := vr.indexedVal(i); ok {
			return str, true, nil
		}
	case Associative:
		switch lit := nodeLit(idx); lit {
		case "@", "*":
			strs := slices.Sorted(maps.Values(vr.Map))
			if lit == "*" {
				return cfg.ifsJoin(strs), vr.IsSet(), nil
			}
			return strings.Join(strs, " "), vr.IsSet(), nil
		}
		val, err := AssocKey(cfg, idx)
		if err != nil {
			return "", false, err
		}
		str, ok := vr.Map[val]
		return str, ok, nil
	}
	return "", false, nil
}

// assignElem assigns a variable via an expansion like ${a=val} or
// ${a[i]=val}, setting a single element when the variable is an array or is
// indexed, like Bash. ${a[i]=val} on a whole scalar converts it to an array.
func (cfg *Config) assignElem(name string, vr Variable, idx syntax.ArithmExpr, val string) error {
	wenv, ok := cfg.Env.(WriteEnviron)
	if !ok {
		return fmt.Errorf("environment is read-only")
	}
	arrayWise := false
	switch nodeLit(idx) {
	case "@", "*":
		// ${a[@]=val} assigns the element at index zero.
		arrayWise = true
		idx = nil
	}
	if idx == nil && !arrayWise && vr.Kind != Indexed && vr.Kind != Associative {
		// A plain scalar assignment like ${x=val}.
		return wenv.Set(name, Variable{Set: true, Kind: String, Str: val})
	}
	switch vr.Kind {
	case Associative:
		key := "0"
		if idx != nil {
			var err error
			if key, err = AssocKey(cfg, idx); err != nil {
				return err
			}
		}
		vr.Map = maps.Clone(vr.Map)
		if vr.Map == nil {
			vr.Map = make(map[string]string, 1)
		}
		vr.Map[key] = val
	default: // assign a single indexed element
		i := 0
		if idx != nil {
			var err error
			if i, err = Arithm(cfg, idx); err != nil {
				return err
			}
			if i < 0 {
				// Negative indices count from one past the maximum index.
				if i += internal.IndexedMax(vr.List, vr.Indexes) + 1; i < 0 {
					return fmt.Errorf("negative array index")
				}
			}
		}
		list, indexes := slices.Clone(vr.List), slices.Clone(vr.Indexes)
		if vr.Kind == String {
			list, indexes = []string{vr.Str}, nil
		}
		list, indexes = internal.SetIndexedElem(list, indexes, i, val)
		vr.Kind, vr.Str, vr.List, vr.Indexes = Indexed, "", list, indexes
	}
	vr.Set = true
	return wenv.Set(name, vr)
}

func (cfg *Config) namesByPrefix(prefix string) []string {
	var names []string
	for name := range cfg.Env.Each {
		if strings.HasPrefix(name, prefix) {
			names = append(names, name)
		}
	}
	slices.Sort(names)
	return names
}
