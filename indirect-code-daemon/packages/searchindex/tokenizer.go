package searchindex

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

const maxIndexedTokenBytes = 160

// FoldDiacritics normalizes Latin diacritics to ASCII equivalents and lowercases
// the string (handling both precomposed NFC characters like "ã", "é", "ç" and
// decomposed NFD combining marks). Non-Latin scripts (CJK, Cyrillic, emoji) are
// preserved lowercased and intact.
func FoldDiacritics(s string) string {
	// Fast ASCII scan: if purely ASCII, lowercase directly without rune allocs.
	asciiOnly := true
	hasUpper := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 0x80 {
			asciiOnly = false
			break
		}
		if c >= 'A' && c <= 'Z' {
			hasUpper = true
		}
	}
	if asciiOnly {
		if !hasUpper {
			return s
		}
		return strings.ToLower(s)
	}

	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if r < 0x80 {
			if r >= 'A' && r <= 'Z' {
				b.WriteByte(byte(r + ('a' - 'A')))
			} else {
				b.WriteByte(byte(r))
			}
			continue
		}
		if unicode.Is(unicode.Mn, r) {
			// Drop combining diacritical marks (NFD accents/tildes/cedillas).
			continue
		}
		if folded, ok := foldLatinRune(r); ok {
			b.WriteString(folded)
			continue
		}
		b.WriteRune(unicode.ToLower(r))
	}
	return b.String()
}

// foldLatinRune maps precomposed accented Latin characters to lowercase ASCII.
func foldLatinRune(r rune) (string, bool) {
	switch r {
	case 'À', 'Á', 'Â', 'Ã', 'Ä', 'Å', 'à', 'á', 'â', 'ã', 'ä', 'å',
		'Ā', 'ā', 'Ă', 'ă', 'Ą', 'ą', 'Ǎ', 'ǎ', 'Ǻ', 'ǻ', 'Ạ', 'ạ', 'Ả', 'ả',
		'Ấ', 'ấ', 'Ầ', 'ầ', 'Ẩ', 'ẩ', 'Ẫ', 'ẫ', 'Ậ', 'ậ', 'Ắ', 'ắ', 'Ằ', 'ằ',
		'Ẳ', 'ẳ', 'Ẵ', 'ẵ', 'Ặ', 'ặ':
		return "a", true
	case 'Æ', 'æ', 'Ǣ', 'ǣ':
		return "ae", true
	case 'Ç', 'ç', 'Ć', 'ć', 'Ĉ', 'ĉ', 'Ċ', 'ċ', 'Č', 'č':
		return "c", true
	case 'Ď', 'ď', 'Đ', 'đ', 'Ð', 'ð':
		return "d", true
	case 'È', 'É', 'Ê', 'Ë', 'è', 'é', 'ê', 'ë',
		'Ē', 'ē', 'Ĕ', 'ĕ', 'Ė', 'ė', 'Ę', 'ę', 'Ě', 'ě',
		'Ẹ', 'ẹ', 'Ẻ', 'ẻ', 'Ẽ', 'ẽ', 'Ế', 'ế', 'Ề', 'ề', 'Ể', 'ể', 'Ễ', 'ễ', 'Ệ', 'ệ':
		return "e", true
	case 'Ĝ', 'ĝ', 'Ğ', 'ğ', 'Ġ', 'ġ', 'Ģ', 'ģ':
		return "g", true
	case 'Ĥ', 'ĥ', 'Ħ', 'ħ':
		return "h", true
	case 'Ì', 'Í', 'Î', 'Ï', 'ì', 'í', 'î', 'ï',
		'Ĩ', 'ĩ', 'Ī', 'ī', 'Ĭ', 'ĭ', 'Į', 'į', 'İ', 'ı', 'Ǐ', 'ǐ', 'Ỉ', 'ỉ', 'Ị', 'ị':
		return "i", true
	case 'Ĵ', 'ĵ':
		return "j", true
	case 'Ķ', 'ķ':
		return "k", true
	case 'Ĺ', 'ĺ', 'Ļ', 'ļ', 'Ľ', 'ľ', 'Ŀ', 'ŀ', 'Ł', 'ł':
		return "l", true
	case 'Ñ', 'ñ', 'Ń', 'ń', 'Ņ', 'ņ', 'Ň', 'ň':
		return "n", true
	case 'Ò', 'Ó', 'Ô', 'Õ', 'Ö', 'Ø', 'ò', 'ó', 'ô', 'õ', 'ö', 'ø',
		'Ō', 'ō', 'Ŏ', 'ŏ', 'Ő', 'ő', 'Ǒ', 'ǒ', 'Ǿ', 'ǿ',
		'Ọ', 'ọ', 'Ỏ', 'ỏ', 'Ố', 'ố', 'Ồ', 'ồ', 'Ổ', 'ổ', 'Ỗ', 'ỗ', 'Ộ', 'ộ',
		'Ớ', 'ớ', 'Ờ', 'ờ', 'Ở', 'ở', 'Ỡ', 'ỡ', 'Ợ', 'ợ':
		return "o", true
	case 'Œ', 'œ':
		return "oe", true
	case 'Ŕ', 'ŕ', 'Ŗ', 'ŗ', 'Ř', 'ř':
		return "r", true
	case 'Ś', 'ś', 'Ŝ', 'ŝ', 'Ş', 'ş', 'Š', 'š', 'Ș', 'ș':
		return "s", true
	case 'ß', 'ẞ':
		return "ss", true
	case 'Ţ', 'ţ', 'Ť', 'ť', 'Ŧ', 'ŧ', 'Ț', 'ț':
		return "t", true
	case 'Ù', 'Ú', 'Û', 'Ü', 'ù', 'ú', 'û', 'ü',
		'Ũ', 'ũ', 'Ū', 'ū', 'Ŭ', 'ŭ', 'Ů', 'ů', 'Ű', 'ű', 'Ų', 'ų', 'Ǔ', 'ǔ',
		'Ụ', 'ụ', 'Ủ', 'ủ', 'Ứ', 'ứ', 'Ừ', 'ừ', 'Ử', 'ử', 'Ữ', 'ữ', 'Ự', 'ự':
		return "u", true
	case 'Ŵ', 'ŵ':
		return "w", true
	case 'Ý', 'ý', 'ÿ', 'Ÿ', 'Ŷ', 'ŷ', 'Ỳ', 'ỳ', 'Ỵ', 'ỵ', 'Ỷ', 'ỷ', 'Ỹ', 'ỹ':
		return "y", true
	case 'Ź', 'ź', 'Ż', 'ż', 'Ž', 'ž':
		return "z", true
	default:
		return "", false
	}
}

func isCJKRune(r rune) bool {
	if r < 0x2E80 {
		return false
	}
	return unicode.Is(unicode.Han, r) ||
		unicode.Is(unicode.Hiragana, r) ||
		unicode.Is(unicode.Katakana, r) ||
		unicode.Is(unicode.Hangul, r)
}

func isSpanRune(r rune) bool {
	if r < 0x80 {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			return true
		}
		switch r {
		case '_', '-', '.', '/', '\\', ':':
			return true
		default:
			return false
		}
	}
	if isCJKRune(r) {
		return false
	}
	return unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.Is(unicode.Mn, r)
}

func isSeparatorRune(r rune) bool {
	switch r {
	case '/', '\\', '.', ':', '-', '_':
		return true
	default:
		return false
	}
}

// Tokenize extracts all normalized search tokens (both sub-tokens and compound
// code/path tokens) from text without a token cap.
func Tokenize(text string) []string {
	var out []string
	tokenizeStream(text, 0, func(tok string, _ bool) {
		out = append(out, tok)
	})
	return out
}

// TokenizeField builds a term->TF map and primary token length for one field.
// When maxPrimaryTokens > 0, tokenization halts once maxPrimaryTokens primary
// tokens have been emitted (used for FieldTool's 512-token per-block cap).
func TokenizeField(text string, maxPrimaryTokens int) (map[string]uint32, int) {
	if text == "" {
		return nil, 0
	}
	tf := make(map[string]uint32, 32)
	docLen := 0
	tokenizeStream(text, maxPrimaryTokens, func(tok string, isPrimary bool) {
		tf[tok]++
		if isPrimary {
			docLen++
		}
	})
	if docLen == 0 && len(tf) > 0 {
		docLen = len(tf)
	}
	return tf, docLen
}

// accumulateFieldTokens merges tokens from text into an existing tf map,
// capping this individual block at maxBlockTokens when > 0.
func accumulateFieldTokens(tf map[string]uint32, text string, maxBlockTokens int) int {
	if text == "" {
		return 0
	}
	addedLen := 0
	tokenizeStream(text, maxBlockTokens, func(tok string, isPrimary bool) {
		tf[tok]++
		if isPrimary {
			addedLen++
		}
	})
	return addedLen
}

// tokenizeStream scans text and invokes emit(token, isPrimary) for every valid
// sub-token (isPrimary=true) and compound code/path token (isPrimary=false).
func tokenizeStream(text string, maxPrimary int, emit func(tok string, isPrimary bool)) {
	if !utf8.ValidString(text) {
		text = strings.ToValidUTF8(text, " ")
	}
	primaryCount := 0
	emitBounded := func(tok string, isPrimary bool) bool {
		if len(tok) == 0 || len(tok) > maxIndexedTokenBytes {
			return true
		}
		// Skip 1-char ASCII noise; allow >=2 byte UTF-8 (e.g. CJK) or >=2 ASCII chars.
		if len(tok) < 2 {
			return true
		}
		if isPrimary && maxPrimary > 0 && primaryCount >= maxPrimary {
			return false
		}
		emit(tok, isPrimary)
		if isPrimary {
			primaryCount++
			if maxPrimary > 0 && primaryCount >= maxPrimary {
				return false
			}
		}
		return true
	}

	i := 0
	n := len(text)
	for i < n {
		if maxPrimary > 0 && primaryCount >= maxPrimary {
			return
		}
		r, width := utf8.DecodeRuneInString(text[i:])
		if isCJKRune(r) {
			start := i
			i += width
			for i < n {
				nr, nw := utf8.DecodeRuneInString(text[i:])
				if !isCJKRune(nr) {
					break
				}
				i += nw
			}
			cjkRunes := []rune(text[start:i])
			for idx, cr := range cjkRunes {
				if !emitBounded(string(cr), true) {
					return
				}
				if idx+1 < len(cjkRunes) {
					if !emitBounded(string(cjkRunes[idx:idx+2]), false) {
						return
					}
				}
			}
			continue
		}

		if !isSpanRune(r) {
			i += width
			continue
		}

		start := i
		i += width
		for i < n {
			nr, nw := utf8.DecodeRuneInString(text[i:])
			if !isSpanRune(nr) {
				break
			}
			i += nw
		}

		if !emitCodeOrWordSpan(text[start:i], emitBounded) {
			return
		}
	}
}

// emitCodeOrWordSpan splits a contiguous word/code/path span into folded
// sub-tokens AND compound tokens (camelCase, PascalCase, snake_case,
// kebab-case, and file/path:line forms).
func emitCodeOrWordSpan(raw string, emit func(tok string, isPrimary bool) bool) bool {
	norm := strings.ReplaceAll(raw, `\`, `/`)
	for strings.HasPrefix(norm, "./") {
		norm = strings.TrimPrefix(norm, "./")
	}
	norm = strings.Trim(norm, ".:/-_")
	if norm == "" {
		return true
	}

	var compounds []string
	addCompound := func(s string) {
		f := FoldDiacritics(strings.Trim(s, ".:/-_"))
		if len(f) < 2 || len(f) > maxIndexedTokenBytes {
			return
		}
		for _, ex := range compounds {
			if ex == f {
				return
			}
		}
		compounds = append(compounds, f)
	}

	hasSep := strings.ContainsAny(norm, "/.:-_")
	if hasSep {
		// Whole compound (e.g. "pkg/path/file.ts:123" or "store_wal.go").
		addCompound(norm)
		noLine := stripLineColSuffix(norm)
		if noLine != norm {
			addCompound(noLine)
		}
		if strings.Contains(noLine, "/") {
			rawSegs := strings.Split(noLine, "/")
			cleanSegs := rawSegs[:0]
			for _, sg := range rawSegs {
				if sg != "" {
					cleanSegs = append(cleanSegs, sg)
				}
			}
			for k := 1; k <= 3 && k <= len(cleanSegs); k++ {
				addCompound(strings.Join(cleanSegs[len(cleanSegs)-k:], "/"))
			}
			for _, sg := range cleanSegs {
				if dot := strings.LastIndexByte(sg, '.'); dot > 0 {
					addCompound(sg[:dot])
				}
			}
		} else if dot := strings.LastIndexByte(noLine, '.'); dot > 0 {
			// File stem: "store_wal.go" -> "store_wal".
			addCompound(noLine[:dot])
		}
	}

	// Split by structural separators ('/', '.', ':', '-', '_').
	segments := strings.FieldsFunc(norm, isSeparatorRune)
	var allSubFolded []string
	for _, seg := range segments {
		if seg == "" {
			continue
		}
		if len(segments) > 1 && strings.ContainsAny(seg, "_-") {
			addCompound(seg)
		}
		camelParts := splitCamelRunes(seg)
		if len(camelParts) > 1 {
			// CamelCase compound: "SessionActor" -> "sessionactor".
			joined := FoldDiacritics(seg)
			addCompound(joined)
		}
		for _, part := range camelParts {
			folded := FoldDiacritics(part)
			if len(folded) < 2 {
				continue
			}
			allSubFolded = append(allSubFolded, folded)
			if !emit(folded, true) {
				return false
			}
		}
	}

	// Also emit separator-free concatenation for snake_case / kebab-case
	// identifiers (e.g. "session_actor" -> "sessionactor") when concise.
	if len(allSubFolded) > 1 && len(allSubFolded) <= 6 && !strings.Contains(norm, "/") {
		joined := strings.Join(allSubFolded, "")
		addCompound(joined)
	}

	for _, c := range compounds {
		// Avoid duplicating a single sub-token as a compound token.
		if len(allSubFolded) == 1 && c == allSubFolded[0] {
			continue
		}
		if !emit(c, false) {
			return false
		}
	}
	return true
}

// splitCamelRunes splits camelCase, PascalCase, and acronym-to-word transitions
// while keeping attached Unicode combining marks with their base letter.
func splitCamelRunes(seg string) []string {
	// Fast ASCII check.
	ascii := true
	for i := 0; i < len(seg); i++ {
		if seg[i] >= 0x80 {
			ascii = false
			break
		}
	}
	if ascii {
		n := len(seg)
		if n == 0 {
			return nil
		}
		var out []string
		start := 0
		for i := 1; i < n; i++ {
			prev := seg[i-1]
			cur := seg[i]
			prevLowerOrDigit := (prev >= 'a' && prev <= 'z') || (prev >= '0' && prev <= '9')
			curUpper := cur >= 'A' && cur <= 'Z'
			prevUpper := prev >= 'A' && prev <= 'Z'
			split := false
			if prevLowerOrDigit && curUpper {
				split = true
			} else if prevUpper && curUpper && i+1 < n && seg[i+1] >= 'a' && seg[i+1] <= 'z' {
				split = true
			}
			if split {
				out = append(out, seg[start:i])
				start = i
			}
		}
		out = append(out, seg[start:])
		return out
	}

	// General Unicode path: group base runes with trailing Mn combining marks.
	type letterCluster struct {
		text    string
		isUpper bool
		isLower bool
		isDigit bool
	}
	var clusters []letterCluster
	for i := 0; i < len(seg); {
		r, w := utf8.DecodeRuneInString(seg[i:])
		end := i + w
		for end < len(seg) {
			nr, nw := utf8.DecodeRuneInString(seg[end:])
			if !unicode.Is(unicode.Mn, nr) {
				break
			}
			end += nw
		}
		clusters = append(clusters, letterCluster{
			text:    seg[i:end],
			isUpper: unicode.IsUpper(r),
			isLower: unicode.IsLower(r),
			isDigit: unicode.IsDigit(r),
		})
		i = end
	}
	if len(clusters) == 0 {
		return nil
	}
	var out []string
	start := 0
	for i := 1; i < len(clusters); i++ {
		prev := clusters[i-1]
		cur := clusters[i]
		split := false
		if (prev.isLower || prev.isDigit) && cur.isUpper {
			split = true
		} else if prev.isUpper && cur.isUpper && i+1 < len(clusters) && clusters[i+1].isLower {
			split = true
		}
		if split {
			var sb strings.Builder
			for k := start; k < i; k++ {
				sb.WriteString(clusters[k].text)
			}
			out = append(out, sb.String())
			start = i
		}
	}
	var sb strings.Builder
	for k := start; k < len(clusters); k++ {
		sb.WriteString(clusters[k].text)
	}
	out = append(out, sb.String())
	return out
}

func stripLineColSuffix(s string) string {
	for {
		colon := strings.LastIndexByte(s, ':')
		if colon <= 0 || colon == len(s)-1 {
			return s
		}
		if colon == 1 && colon+1 < len(s) && s[colon+1] == '/' {
			return s
		}
		tail := s[colon+1:]
		numeric := true
		for i := 0; i < len(tail); i++ {
			c := tail[i]
			if (c < '0' || c > '9') && c != '-' {
				numeric = false
				break
			}
		}
		if !numeric {
			return s
		}
		s = s[:colon]
	}
}

// ---------------------------------------------------------------------------
// Query Analysis (Exact Terms + Compound Boosts + Final-Token Prefix Target)
// ---------------------------------------------------------------------------

type queryTermSpec struct {
	term     string
	weight   float64
	isPrefix bool
	groupID  int // groups prefix expansions with their originating query token
}

type analyzedQuery struct {
	terms         []queryTermSpec
	prefixTargets []string // candidate prefixes from the last query token (len >= 2)
	lastGroupID   int
	highlight     []string // folded tokens/prefixes for rune-safe snippet centering
}

func analyzeQuery(raw string, allowPrefix bool) analyzedQuery {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return analyzedQuery{}
	}
	if !utf8.ValidString(trimmed) {
		trimmed = strings.ToValidUTF8(trimmed, " ")
	}

	// Collect contiguous word/code/CJK spans in order so we know which span is last.
	type rawSpan struct {
		text  string
		isCJK bool
	}
	var spans []rawSpan
	for i := 0; i < len(trimmed); {
		r, w := utf8.DecodeRuneInString(trimmed[i:])
		if isCJKRune(r) {
			start := i
			i += w
			for i < len(trimmed) {
				nr, nw := utf8.DecodeRuneInString(trimmed[i:])
				if !isCJKRune(nr) {
					break
				}
				i += nw
			}
			spans = append(spans, rawSpan{text: trimmed[start:i], isCJK: true})
			continue
		}
		if !isSpanRune(r) {
			i += w
			continue
		}
		start := i
		i += w
		for i < len(trimmed) {
			nr, nw := utf8.DecodeRuneInString(trimmed[i:])
			if !isSpanRune(nr) {
				break
			}
			i += nw
		}
		spans = append(spans, rawSpan{text: trimmed[start:i], isCJK: false})
	}

	if len(spans) == 0 {
		return analyzedQuery{}
	}

	var res analyzedQuery
	seen := make(map[string]int) // term -> index in res.terms
	addTerm := func(term string, weight float64, groupID int) {
		if len(term) < 2 || len(term) > maxIndexedTokenBytes {
			return
		}
		if idx, ok := seen[term]; ok {
			if weight > res.terms[idx].weight {
				res.terms[idx].weight = weight
			}
			return
		}
		seen[term] = len(res.terms)
		res.terms = append(res.terms, queryTermSpec{
			term:    term,
			weight:  weight,
			groupID: groupID,
		})
	}
	addHighlight := func(h string) {
		if len(h) < 2 {
			return
		}
		for _, ex := range res.highlight {
			if ex == h {
				return
			}
		}
		res.highlight = append(res.highlight, h)
	}

	nextGroup := 1
	for sIdx, sp := range spans {
		isLastSpan := sIdx == len(spans)-1
		if sp.isCJK {
			cjkRunes := []rune(sp.text)
			for idx, cr := range cjkRunes {
				gid := nextGroup
				nextGroup++
				tok := string(cr)
				addTerm(tok, 1.0, gid)
				addHighlight(tok)
				if idx+1 < len(cjkRunes) {
					bg := string(cjkRunes[idx : idx+2])
					addTerm(bg, 1.2, gid)
					addHighlight(bg)
				}
				if isLastSpan && idx == len(cjkRunes)-1 {
					res.lastGroupID = gid
				}
			}
			continue
		}

		var subs []string
		var compounds []string
		emitCodeOrWordSpan(sp.text, func(tok string, isPrimary bool) bool {
			if isPrimary {
				subs = append(subs, tok)
			} else {
				compounds = append(compounds, tok)
			}
			return true
		})

		// Whole-span normalized form (handles single lowercase concatenated query
		// like "sessionactor" matching "SessionActor" in documents).
		whole := FoldDiacritics(strings.Trim(strings.ReplaceAll(sp.text, `\`, `/`), ".:/-_"))

		spanBaseGroup := nextGroup
		for _, sub := range subs {
			gid := nextGroup
			nextGroup++
			addTerm(sub, 1.0, gid)
			addHighlight(sub)
			res.lastGroupID = gid
		}
		for _, comp := range compounds {
			// Compound code/path tokens carry a slight boost over split words.
			addTerm(comp, 1.35, spanBaseGroup)
			addHighlight(comp)
		}
		if len(subs) == 0 && len(whole) >= 2 {
			gid := nextGroup
			nextGroup++
			addTerm(whole, 1.0, gid)
			addHighlight(whole)
			res.lastGroupID = gid
		}

		if isLastSpan && allowPrefix {
			if res.lastGroupID == 0 {
				res.lastGroupID = nextGroup
				nextGroup++
			}
			if utf8.RuneCountInString(whole) >= 2 && len(whole) <= maxIndexedTokenBytes {
				res.prefixTargets = append(res.prefixTargets, whole)
				addHighlight(whole)
			}
			if len(subs) > 0 {
				lastSub := subs[len(subs)-1]
				if utf8.RuneCountInString(lastSub) >= 2 && lastSub != whole {
					res.prefixTargets = append(res.prefixTargets, lastSub)
					addHighlight(lastSub)
				}
			}
		}
	}

	return res
}

// ---------------------------------------------------------------------------
// 100% UTF-8 Rune-Safe Excerpt Storage & Centered Snippet Engine
// ---------------------------------------------------------------------------

// TruncateExcerptRunes collapses runs of whitespace to single spaces and
// truncates cleanly on a Unicode code-point (rune) boundary to <= maxRunes.
func TruncateExcerptRunes(s string, maxRunes int) string {
	if s == "" || maxRunes <= 0 {
		return ""
	}
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "\uFFFD")
	}
	var b strings.Builder
	limitBytes := len(s)
	if limitBytes > maxRunes*4+64 {
		limitBytes = maxRunes*4 + 64
	}
	b.Grow(limitBytes)

	runeCount := 0
	inSpace := true // trim leading whitespace
	for _, r := range s {
		if unicode.IsSpace(r) {
			if !inSpace {
				inSpace = true
			}
			continue
		}
		if inSpace && runeCount > 0 {
			if runeCount+1 > maxRunes {
				break
			}
			b.WriteByte(' ')
			runeCount++
		}
		inSpace = false
		if runeCount >= maxRunes {
			break
		}
		b.WriteRune(r)
		runeCount++
	}
	return b.String()
}

// ExtractSnippet produces a 100% UTF-8 rune-safe excerpt (~maxRunes, default 120)
// centered around the highest-density cluster of matched query terms (including
// diacritic-folded PT-BR terms, camelCase/snake_case sub-tokens, and prefixes).
func ExtractSnippet(text string, rawQuery string, maxRunes int) string {
	aq := analyzeQuery(rawQuery, true)
	return extractSnippetWithTerms(text, aq.highlight, maxRunes)
}

func extractSnippetWithTerms(text string, matchTerms []string, maxRunes int) string {
	if maxRunes <= 0 {
		maxRunes = DefaultSnippetRunes
	}
	if text == "" {
		return ""
	}
	if !utf8.ValidString(text) {
		text = strings.ToValidUTF8(text, "\uFFFD")
	}

	// Normalize whitespace into a clean single-line rune slice.
	flat := collapseWhitespace(text)
	if flat == "" {
		return ""
	}
	runes := []rune(flat)
	if len(runes) <= maxRunes {
		return string(runes)
	}

	if len(matchTerms) == 0 {
		end := snapWordEnd(runes, maxRunes)
		return strings.TrimSpace(string(runes[:end])) + "…"
	}

	// Locate matched rune spans in `runes` using diacritic-folded token & prefix matching.
	type runeHit struct {
		start   int
		end     int
		termIdx int
	}
	var hits []runeHit

	n := len(runes)
	for i := 0; i < n; {
		r := runes[i]
		if isCJKRune(r) {
			start := i
			for i < n && isCJKRune(runes[i]) {
				i++
			}
			for k := start; k < i; k++ {
				unigram := string(runes[k])
				for tIdx, mt := range matchTerms {
					if unigram == mt {
						hits = append(hits, runeHit{start: k, end: k + 1, termIdx: tIdx})
					} else if k+1 < i && string(runes[k:k+2]) == mt {
						hits = append(hits, runeHit{start: k, end: k + 2, termIdx: tIdx})
					}
				}
			}
			continue
		}
		if !isSpanRune(r) {
			i++
			continue
		}
		start := i
		for i < n && isSpanRune(runes[i]) {
			i++
		}
		spanStr := string(runes[start:i])
		spanFolded := FoldDiacritics(strings.Trim(strings.ReplaceAll(spanStr, `\`, `/`), ".:/-_"))

		var spanTokens []string
		if spanFolded != "" {
			spanTokens = append(spanTokens, spanFolded)
		}
		emitCodeOrWordSpan(spanStr, func(tok string, _ bool) bool {
			spanTokens = append(spanTokens, tok)
			return true
		})

		for tIdx, mt := range matchTerms {
			matched := false
			for _, st := range spanTokens {
				if st == mt || (len(mt) >= 2 && strings.HasPrefix(st, mt)) {
					matched = true
					break
				}
			}
			if matched {
				hits = append(hits, runeHit{start: start, end: i, termIdx: tIdx})
			}
		}
	}

	if len(hits) == 0 {
		end := snapWordEnd(runes, maxRunes)
		return strings.TrimSpace(string(runes[:end])) + "…"
	}

	// Score candidate windows covering hit clusters [hits[a] .. hits[b]] that fit within maxRunes.
	bestScore := -1.0
	bestClusterStart := hits[0].start
	bestClusterEnd := hits[0].end

	for a := 0; a < len(hits); a++ {
		var distinctMask uint64
		distinctCount := 0
		totalHits := 0
		for b := a; b < len(hits); b++ {
			if hits[b].start-hits[a].start >= maxRunes {
				break
			}
			totalHits++
			tIdx := hits[b].termIdx
			if tIdx < 64 {
				bit := uint64(1) << uint(tIdx)
				if distinctMask&bit == 0 {
					distinctMask |= bit
					distinctCount++
				}
			} else {
				distinctCount++
			}
			// Prioritize distinct query terms heavily, then hit count, with slight preference for earlier occurrence.
			score := float64(distinctCount)*10.0 + float64(totalHits)*1.5 - float64(hits[a].start)*1e-5
			if score > bestScore {
				bestScore = score
				bestClusterStart = hits[a].start
				bestClusterEnd = hits[b].end
			}
		}
	}

	if bestClusterEnd > bestClusterStart+maxRunes {
		bestClusterEnd = bestClusterStart + maxRunes
	}
	center := (bestClusterStart + bestClusterEnd) / 2
	wStart := center - maxRunes/2
	if wStart > bestClusterStart {
		wStart = bestClusterStart
	}
	if wStart < 0 {
		wStart = 0
	}
	if wStart+maxRunes > n {
		wStart = n - maxRunes
		if wStart < 0 {
			wStart = 0
		}
	}
	wEnd := wStart + maxRunes
	if wEnd > n {
		wEnd = n
	}

	// Gently snap window edges to clean word boundaries when it does not clip the matched cluster.
	if wStart > 0 {
		snapped := snapWordStart(runes, wStart, bestClusterStart)
		wStart = snapped
	}
	if wEnd < n {
		snapped := snapWordEndAfter(runes, wEnd, bestClusterEnd)
		wEnd = snapped
	}

	body := strings.TrimSpace(string(runes[wStart:wEnd]))
	var out strings.Builder
	out.Grow(len(body) + 8)
	if wStart > 0 {
		out.WriteString("…")
	}
	out.WriteString(body)
	if wEnd < n {
		out.WriteString("…")
	}
	return out.String()
}

func collapseWhitespace(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	inSpace := true
	wroteAny := false
	for _, r := range s {
		if unicode.IsSpace(r) {
			inSpace = true
			continue
		}
		if inSpace && wroteAny {
			b.WriteByte(' ')
		}
		inSpace = false
		wroteAny = true
		b.WriteRune(r)
	}
	return b.String()
}

func snapWordStart(runes []rune, pos int, mustKeep int) int {
	if pos <= 0 || unicode.IsSpace(runes[pos-1]) || unicode.IsSpace(runes[pos]) {
		return pos
	}
	maxAdvance := pos + 12
	if maxAdvance > mustKeep {
		maxAdvance = mustKeep
	}
	for i := pos; i < maxAdvance && i < len(runes); i++ {
		if unicode.IsSpace(runes[i]) {
			return i + 1
		}
	}
	return pos
}

func snapWordEnd(runes []rune, pos int) int {
	if pos >= len(runes) || unicode.IsSpace(runes[pos]) || (pos > 0 && unicode.IsSpace(runes[pos-1])) {
		return pos
	}
	minBack := pos - 12
	if minBack < 1 {
		minBack = 1
	}
	for i := pos; i >= minBack; i-- {
		if unicode.IsSpace(runes[i]) {
			return i
		}
	}
	return pos
}

func snapWordEndAfter(runes []rune, pos int, mustKeepEnd int) int {
	if pos >= len(runes) || unicode.IsSpace(runes[pos]) || (pos > 0 && unicode.IsSpace(runes[pos-1])) {
		return pos
	}
	minBack := pos - 12
	if minBack < mustKeepEnd {
		minBack = mustKeepEnd
	}
	for i := pos; i >= minBack; i-- {
		if i < len(runes) && unicode.IsSpace(runes[i]) {
			return i
		}
	}
	return pos
}
