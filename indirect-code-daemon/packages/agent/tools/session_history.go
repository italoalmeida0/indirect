package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"indirect/indirect-code-daemon/packages/core"
	"indirect/indirect-code-daemon/packages/provider"
)

const (
	sessionHistoryDefaultSearchLimit = 10
	sessionHistoryMaxSearchLimit     = 25
	sessionHistoryDefaultRecallChars = 16000
	sessionHistoryMaxRecallChars     = 40000

	bm25K1 = 1.2
	bm25B  = 0.75

	bm25ExactBoost = 2.0

	roleWeightUser      = 1.5
	roleWeightBlock     = 1.2
	roleWeightAssistant = 1.0
	roleWeightTool      = 0.6
)

// SessionHistoryBlock is a decoupled snapshot of one compaction era block
// (active Tier-1/Tier-2 or retired Tier-1) exposed to session_history.
type SessionHistoryBlock struct {
	ID               string   `json:"id"`
	Tier             int      `json:"tier"`
	StartIdx         int      `json:"startIdx"`
	EndIdx           int      `json:"endIdx"`
	Topic            string   `json:"topic,omitempty"`
	Summary          string   `json:"summary"`
	ReadFiles        []string `json:"readFiles,omitempty"`
	ModifiedFiles    []string `json:"modifiedFiles,omitempty"`
	FailedCommands   []string `json:"failedCommands,omitempty"`
	RetiredByBlockID string   `json:"retiredByBlockId,omitempty"`
}

// SessionHistorySnapshot is the point-in-time session history view read by
// SessionHistoryTool. Messages is the full append-only raw session ledger.
type SessionHistorySnapshot struct {
	Messages     []provider.Message
	KeepFrom     int
	Blocks       []SessionHistoryBlock
	ImageDigests map[string]string
	BrainDir     string
}

// SessionHistorySource returns an immutable snapshot of the session's raw
// messages and compaction blocks without mutating live agent context.
type SessionHistorySource func() SessionHistorySnapshot

// SessionHistoryTool lets the model search or recall compacted raw messages
// and era summaries on demand without mutating the live KV-cached prefix.
type SessionHistoryTool struct {
	Source SessionHistorySource
}

type SessionHistoryArgs struct {
	Action          string `json:"action"`
	Query           string `json:"query,omitempty"`
	Limit           int    `json:"limit,omitempty"`
	IncludeLiveTail bool   `json:"include_live_tail,omitempty"`
	BlockID         string `json:"block_id,omitempty"`
	StartMsg        *int   `json:"start_msg,omitempty"`
	EndMsg          *int   `json:"end_msg,omitempty"`
	OffsetChars     int    `json:"offset_chars,omitempty"`
	MaxChars        int    `json:"max_chars,omitempty"`
}

const sessionHistorySchema = `{"type":"object","required":["action"],"properties":{"action":{"type":"string","enum":["search","recall"],"description":"\"search\" runs code-aware BM25 over compacted history and block summaries; \"recall\" reads verbatim raw messages by block_id or start_msg..end_msg."},"query":{"type":"string","description":"Search query (identifiers, file paths, commands, error messages, or keywords) for action=\"search\"."},"limit":{"type":"integer","description":"Max search results to return (default 10, max 25)."},"include_live_tail":{"type":"boolean","description":"Also search uncompacted live-tail messages in addition to compacted history (default false)."},"block_id":{"type":"string","description":"Compaction block ID (e.g. \"b1\") whose raw message span should be recalled verbatim."},"start_msg":{"type":"integer","description":"Inclusive 0-based raw message index to start recall from."},"end_msg":{"type":"integer","description":"Inclusive 0-based raw message index to end recall at (defaults to start_msg when omitted)."},"offset_chars":{"type":"integer","description":"Character offset into the rendered recall transcript for pagination (default 0)."},"max_chars":{"type":"integer","description":"Maximum characters to return for action=\"recall\" (default 16000, max 40000)."}}}`

func (t *SessionHistoryTool) Name() string { return "session_history" }

func (t *SessionHistoryTool) Description() string {
	return "Search or recall compacted earlier conversation turns, era summaries, and full unpruned tool outputs on demand. Use `action: \"search\"` (`query`, optional `limit`, `include_live_tail`) for code-aware BM25 lookup over symbols, paths, commands, and decisions; use `action: \"recall\"` (`block_id` or `start_msg`+`end_msg`, `offset_chars`, `max_chars`) to read verbatim raw messages."
}

func (t *SessionHistoryTool) Schema() json.RawMessage {
	return json.RawMessage(sessionHistorySchema)
}

func (t *SessionHistoryTool) Execute(ctx context.Context, raw json.RawMessage, _ func(string)) (core.ToolResult, error) {
	if err := ctx.Err(); err != nil {
		return core.ToolResult{}, err
	}
	if t.Source == nil {
		return core.ToolResult{}, fmt.Errorf("session_history: history source unavailable")
	}
	var a SessionHistoryArgs
	if err := unmarshalArgs(raw, &a); err != nil {
		return core.ToolResult{}, fmt.Errorf("invalid args: %w", err)
	}

	action := strings.ToLower(strings.TrimSpace(a.Action))
	if action == "" {
		switch {
		case strings.TrimSpace(a.Query) != "":
			action = "search"
		case strings.TrimSpace(a.BlockID) != "" || a.StartMsg != nil || a.EndMsg != nil:
			action = "recall"
		default:
			return core.ToolResult{}, fmt.Errorf("session_history: `action` must be \"search\" or \"recall\"")
		}
	}

	snap := t.Source()
	switch action {
	case "search":
		return executeSessionHistorySearch(snap, a)
	case "recall":
		return executeSessionHistoryRecall(snap, a)
	default:
		return core.ToolResult{}, fmt.Errorf("session_history: unsupported action %q (expected \"search\" or \"recall\")", a.Action)
	}
}

// ---------------------------------------------------------------------------
// Search: Code-Aware BM25 (k1=1.2, b=0.75) + 2.0x exact identifier/path boost
// ---------------------------------------------------------------------------

type historyDocKind int

const (
	docKindMessage historyDocKind = iota
	docKindBlock
)

type historyDoc struct {
	kind       historyDocKind
	msgIdx     int
	role       string // "user", "assistant", "tool", "block"
	roleWeight float64
	blockID    string
	retiredBy  string
	tier       int
	startIdx   int
	endIdx     int
	topic      string
	text       string
	tf         map[string]int
	docLen     int
}

type historyHit struct {
	doc   historyDoc
	score float64
}

type queryTerm struct {
	key    string
	weight float64
	raw    string // lowercased surface for snippet centering
}

func executeSessionHistorySearch(snap SessionHistorySnapshot, a SessionHistoryArgs) (core.ToolResult, error) {
	query := strings.TrimSpace(a.Query)
	if query == "" {
		return core.ToolResult{}, fmt.Errorf("session_history: `query` is required when action=\"search\"")
	}
	limit := a.Limit
	if limit <= 0 {
		limit = sessionHistoryDefaultSearchLimit
	}
	if limit > sessionHistoryMaxSearchLimit {
		limit = sessionHistoryMaxSearchLimit
	}

	keepFrom := snap.KeepFrom
	if keepFrom < 0 {
		keepFrom = 0
	}
	if keepFrom > len(snap.Messages) {
		keepFrom = len(snap.Messages)
	}

	msgBound := keepFrom
	if a.IncludeLiveTail {
		msgBound = len(snap.Messages)
	}

	buildSearchAttrs := func(hitCount, indexedCount int) []core.Attr {
		attrs := []core.Attr{
			{Key: "action", Value: "search"},
			{Key: "hits", Value: strconv.Itoa(hitCount)},
			{Key: "indexed", Value: strconv.Itoa(indexedCount)},
		}
		if a.IncludeLiveTail {
			attrs = append(attrs, core.Attr{Key: "live_tail", Value: "true"})
		}
		return attrs
	}
	buildSearchDetails := func(indexedCount int, hitItems []map[string]any) map[string]any {
		if hitItems == nil {
			hitItems = []map[string]any{}
		}
		return map[string]any{
			"action":            "search",
			"query":             query,
			"indexed":           indexedCount,
			"include_live_tail": a.IncludeLiveTail,
			"hits":              hitItems,
		}
	}

	if msgBound == 0 && len(snap.Blocks) == 0 {
		body := fmt.Sprintf("No compacted history yet (0 compacted messages, %d live messages). Pass `include_live_tail: true` to search the live transcript.", len(snap.Messages))
		return core.ToolResult{
			Content: []provider.Content{provider.TextBlock{Text: body}},
			Attrs:   buildSearchAttrs(0, 0),
			Details: buildSearchDetails(0, nil),
		}, nil
	}

	docs := buildHistoryDocs(snap, keepFrom, msgBound)
	hits, qTerms := bm25SearchDocs(docs, query, limit)

	var sb strings.Builder
	if len(hits) == 0 {
		fmt.Fprintf(&sb, "No matches for %q across %d indexed history entries", query, len(docs))
		if !a.IncludeLiveTail && len(snap.Messages) > keepFrom {
			fmt.Fprintf(&sb, " (%d live-tail messages excluded; set include_live_tail=true to include them)", len(snap.Messages)-keepFrom)
		}
		sb.WriteString(".")
		return core.ToolResult{
			Content: []provider.Content{provider.TextBlock{Text: sb.String()}},
			Attrs:   buildSearchAttrs(0, len(docs)),
			Details: buildSearchDetails(len(docs), nil),
		}, nil
	}

	var highlightTerms []string
	for _, qt := range qTerms {
		if qt.raw != "" && !sliceContains(highlightTerms, qt.raw) {
			highlightTerms = append(highlightTerms, qt.raw)
		}
	}

	hitItems := make([]map[string]any, 0, len(hits))
	fmt.Fprintf(&sb, "Found %d match(es) for %q:\n", len(hits), query)
	for i, h := range hits {
		d := h.doc
		snippet := extractMatchSnippet(d.text, highlightTerms, 240)
		scoreRounded := math.Round(h.score*100) / 100
		sb.WriteString("\n")
		if d.kind == docKindBlock {
			blockLabel := d.blockID
			if d.retiredBy != "" {
				blockLabel = fmt.Sprintf("%s (retired->%s)", d.blockID, d.retiredBy)
			}
			tier := maxInt(1, d.tier)
			endInc := maxInt(d.startIdx, d.endIdx-1)
			topicPart := ""
			if d.topic != "" {
				topicPart = " · " + d.topic
			}
			fmt.Fprintf(&sb, "%d. [block %s · tier %d · msgs #%d-#%d%s] (score %.2f)\n",
				i+1, blockLabel, tier, d.startIdx, endInc, topicPart, h.score)
			fmt.Fprintf(&sb, "   %s\n", snippet)
			fmt.Fprintf(&sb, "   recall: {\"action\":\"recall\",\"block_id\":%q}\n", d.blockID)
			hitItems = append(hitItems, map[string]any{
				"kind":       "block",
				"msg_idx":    d.msgIdx,
				"role":       d.role,
				"block_id":   d.blockID,
				"retired_by": d.retiredBy,
				"tier":       tier,
				"start_idx":  d.startIdx,
				"end_idx":    endInc,
				"topic":      d.topic,
				"score":      scoreRounded,
				"snippet":    snippet,
			})
		} else {
			fmt.Fprintf(&sb, "%d. [msg #%d · %s · block %s] (score %.2f)\n",
				i+1, d.msgIdx, d.role, d.blockID, h.score)
			fmt.Fprintf(&sb, "   %s\n", snippet)
			if d.blockID != "" && d.blockID != "compacted" && d.blockID != "live" {
				fmt.Fprintf(&sb, "   recall: {\"action\":\"recall\",\"start_msg\":%d,\"end_msg\":%d} (or {\"action\":\"recall\",\"block_id\":%q})\n",
					d.msgIdx, d.msgIdx, d.blockID)
			} else {
				fmt.Fprintf(&sb, "   recall: {\"action\":\"recall\",\"start_msg\":%d,\"end_msg\":%d}\n",
					d.msgIdx, d.msgIdx)
			}
			hitItems = append(hitItems, map[string]any{
				"kind":       "message",
				"msg_idx":    d.msgIdx,
				"role":       d.role,
				"block_id":   d.blockID,
				"retired_by": d.retiredBy,
				"tier":       d.tier,
				"start_idx":  d.startIdx,
				"end_idx":    d.endIdx,
				"topic":      d.topic,
				"score":      scoreRounded,
				"snippet":    snippet,
			})
		}
	}

	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: strings.TrimRight(sb.String(), "\n")}},
		Attrs:   buildSearchAttrs(len(hits), len(docs)),
		Details: buildSearchDetails(len(docs), hitItems),
	}, nil
}

func buildHistoryDocs(snap SessionHistorySnapshot, keepFrom, msgBound int) []historyDoc {
	callNames := collectToolCallNames(snap.Messages)
	docs := make([]historyDoc, 0, msgBound+len(snap.Blocks))

	// 1. Index raw messages in [0, msgBound).
	for idx := 0; idx < msgBound && idx < len(snap.Messages); idx++ {
		m := snap.Messages[idx]
		if isSyntheticSystemMessage(m) {
			continue
		}
		text := searchableMessageText(m, callNames, snap.ImageDigests)
		if strings.TrimSpace(text) == "" {
			continue
		}
		tf, docLen := indexDocumentTerms(text)
		if len(tf) == 0 {
			continue
		}
		role, weight := messageRoleAndWeight(m.Role)
		blockID := owningBlockID(snap.Blocks, idx, keepFrom)
		docs = append(docs, historyDoc{
			kind:       docKindMessage,
			msgIdx:     idx,
			role:       role,
			roleWeight: weight,
			blockID:    blockID,
			text:       text,
			tf:         tf,
			docLen:     docLen,
		})
	}

	// 2. Index active block summaries AND retired Tier-1 blocks.
	for _, b := range snap.Blocks {
		isActive := b.RetiredByBlockID == ""
		isRetiredT1 := b.RetiredByBlockID != "" && (b.Tier <= 1)
		if !isActive && !isRetiredT1 {
			continue
		}
		text := searchableBlockText(b)
		if strings.TrimSpace(text) == "" {
			continue
		}
		tf, docLen := indexDocumentTerms(text)
		if len(tf) == 0 {
			continue
		}
		id := b.ID
		if id == "" {
			id = "block"
		}
		docs = append(docs, historyDoc{
			kind:       docKindBlock,
			msgIdx:     b.StartIdx,
			role:       "block",
			roleWeight: roleWeightBlock,
			blockID:    id,
			retiredBy:  b.RetiredByBlockID,
			tier:       b.Tier,
			startIdx:   b.StartIdx,
			endIdx:     b.EndIdx,
			topic:      b.Topic,
			text:       text,
			tf:         tf,
			docLen:     docLen,
		})
	}

	return docs
}

func bm25SearchDocs(docs []historyDoc, query string, limit int) ([]historyHit, []queryTerm) {
	qTerms := buildQueryTerms(query)
	if len(qTerms) == 0 || len(docs) == 0 {
		return nil, qTerms
	}

	totalLen := 0
	for _, d := range docs {
		totalLen += d.docLen
	}
	avgDL := float64(totalLen) / float64(len(docs))
	if avgDL <= 0 {
		avgDL = 1
	}

	nDocs := float64(len(docs))
	df := make(map[string]int, len(qTerms))
	for _, qt := range qTerms {
		if _, seen := df[qt.key]; seen {
			continue
		}
		count := 0
		for _, d := range docs {
			if d.tf[qt.key] > 0 {
				count++
			}
		}
		df[qt.key] = count
	}

	var hits []historyHit
	for _, d := range docs {
		rawScore := 0.0
		dlNorm := bm25K1 * (1.0 - bm25B + bm25B*(float64(d.docLen)/avgDL))
		for _, qt := range qTerms {
			tf := d.tf[qt.key]
			if tf <= 0 {
				continue
			}
			docFreq := float64(df[qt.key])
			idf := math.Log(1.0 + (nDocs-docFreq+0.5)/(docFreq+0.5))
			tfFloat := float64(tf)
			tfNorm := (tfFloat * (bm25K1 + 1.0)) / (tfFloat + dlNorm)
			rawScore += qt.weight * idf * tfNorm
		}
		if rawScore <= 0 {
			continue
		}
		hits = append(hits, historyHit{
			doc:   d,
			score: rawScore * d.roleWeight,
		})
	}

	sort.SliceStable(hits, func(i, j int) bool {
		if math.Abs(hits[i].score-hits[j].score) > 1e-9 {
			return hits[i].score > hits[j].score
		}
		// Tie-breaker: prefer messages over blocks, then newer index.
		if hits[i].doc.kind != hits[j].doc.kind {
			return hits[i].doc.kind == docKindMessage
		}
		return hits[i].doc.msgIdx > hits[j].doc.msgIdx
	})

	if len(hits) > limit {
		hits = hits[:limit]
	}
	return hits, qTerms
}

// indexDocumentTerms tokenizes text with codeAwareTokenize and builds the
// combined term-frequency map ("sub:<tok>" for split sub-tokens,
// "exact:<id>" for exact lowercased identifiers and paths) plus sub-token
// document length.
func indexDocumentTerms(text string) (map[string]int, int) {
	subs, exacts := codeAwareTokenize(text)
	tf := make(map[string]int, len(subs)+len(exacts))
	for _, s := range subs {
		tf["sub:"+s]++
	}
	for _, ex := range exacts {
		tf["exact:"+ex]++
	}
	docLen := len(subs)
	if docLen == 0 && len(exacts) > 0 {
		docLen = len(exacts)
	}
	return tf, docLen
}

// buildQueryTerms builds deduplicated BM25 query terms. Exact lowercased
// identifiers/paths carry a 2.0x boost; split sub-tokens carry 1.0x weight.
func buildQueryTerms(query string) []queryTerm {
	var out []queryTerm
	seen := map[string]bool{}
	add := func(key string, weight float64, raw string) {
		if key == "" || seen[key] {
			return
		}
		seen[key] = true
		out = append(out, queryTerm{key: key, weight: weight, raw: raw})
	}

	subs, exacts := codeAwareTokenize(query)
	for _, ex := range exacts {
		add("exact:"+ex, bm25ExactBoost, ex)
	}
	// Also emit whole-span exact keys for lowercase single-word queries (e.g.
	// "refreshmodelmirror" matching camelCase `refreshModelMirror` in docs)
	// without granting 2.0x exact boost to split sub-parts like "model".
	for _, span := range extractQuerySpans(query) {
		low := strings.ToLower(strings.Trim(strings.ReplaceAll(span, `\`, `/`), ".:/-"))
		if utf8.RuneCountInString(low) >= 2 {
			add("exact:"+low, bm25ExactBoost, low)
		}
	}
	for _, s := range subs {
		add("sub:"+s, 1.0, s)
	}
	return out
}

func extractQuerySpans(text string) []string {
	runes := []rune(text)
	var spans []string
	for i := 0; i < len(runes); {
		if isCJKRune(runes[i]) || !isCodeSpanRune(runes[i]) {
			i++
			continue
		}
		start := i
		for i < len(runes) && isCodeSpanRune(runes[i]) {
			i++
		}
		spans = append(spans, string(runes[start:i]))
	}
	return spans
}

// codeAwareTokenize splits camelCase, PascalCase, snake_case, kebab-case,
// and path/segments/file.ext:line into lowercased sub-tokens while also
// extracting exact lowercased code identifiers and file paths.
// Never emits fuzzy Latin character n-grams.
func codeAwareTokenize(text string) (subTokens []string, exactTokens []string) {
	runes := []rune(text)
	n := len(runes)
	i := 0
	for i < n {
		r := runes[i]
		if isCJKRune(r) {
			start := i
			for i < n && isCJKRune(runes[i]) {
				i++
			}
			cjkRun := runes[start:i]
			for idx, cr := range cjkRun {
				subTokens = append(subTokens, string(cr))
				if idx+1 < len(cjkRun) {
					subTokens = append(subTokens, string(cjkRun[idx:idx+2]))
				}
			}
			continue
		}
		if !isCodeSpanRune(r) {
			i++
			continue
		}
		start := i
		for i < n && isCodeSpanRune(runes[i]) {
			i++
		}
		raw := string(runes[start:i])
		subs, exacts := tokenizeCodeSpan(raw)
		subTokens = append(subTokens, subs...)
		exactTokens = append(exactTokens, exacts...)
	}
	return subTokens, exactTokens
}

func tokenizeCodeSpan(raw string) (subs []string, exacts []string) {
	norm := strings.ReplaceAll(raw, `\`, `/`)
	for strings.HasPrefix(norm, "./") {
		norm = strings.TrimPrefix(norm, "./")
	}
	norm = strings.Trim(norm, ".:/-")
	if norm == "" {
		return nil, nil
	}

	addExact := func(s string) {
		s = strings.ToLower(strings.Trim(s, ".:/-"))
		if utf8.RuneCountInString(s) < 2 {
			return
		}
		if !sliceContains(exacts, s) {
			exacts = append(exacts, s)
		}
	}

	if isCodeShapedSpan(norm) {
		addExact(norm)
		base := stripTrailingLineCol(norm)
		if base != norm {
			addExact(base)
		}
		if strings.Contains(base, "/") {
			segs := strings.Split(base, "/")
			var cleanSegs []string
			for _, seg := range segs {
				if seg != "" {
					cleanSegs = append(cleanSegs, seg)
				}
			}
			// Index trailing path suffixes (up to 3 segments, including basename).
			for k := 1; k <= 3 && k <= len(cleanSegs); k++ {
				suffix := strings.Join(cleanSegs[len(cleanSegs)-k:], "/")
				addExact(suffix)
			}
			for _, seg := range cleanSegs {
				if isCodeShapedSpan(seg) {
					addExact(seg)
				}
				if dot := strings.LastIndexByte(seg, '.'); dot > 0 {
					stem := seg[:dot]
					if isCodeShapedSpan(stem) || len(cleanSegs) > 0 {
						addExact(stem)
					}
				}
			}
		} else if strings.Contains(base, ".") {
			parts := strings.Split(base, ".")
			if len(parts) >= 2 {
				// File stem (e.g. "session_actor" from "session_actor.go") or
				// member symbols (e.g. "ToolChoice" from "req.ToolChoice").
				for idx, p := range parts {
					if isCodeShapedSpan(p) || (idx == 0 && len(parts) == 2 && isLikelyFileExt(parts[1])) {
						addExact(p)
					}
				}
			}
		}
	}

	// Split on structural separators: /, ., :, -, _
	segments := strings.FieldsFunc(norm, func(r rune) bool {
		switch r {
		case '/', '.', ':', '-', '_':
			return true
		default:
			return false
		}
	})
	for _, seg := range segments {
		if seg == "" {
			continue
		}
		if len(segments) > 1 && isCodeShapedSpan(seg) {
			addExact(seg)
		}
		for _, part := range splitCamelAndDigits(seg) {
			low := strings.ToLower(part)
			if utf8.RuneCountInString(low) >= 2 {
				subs = append(subs, low)
			}
		}
	}
	return subs, exacts
}

// splitCamelAndDigits splits camelCase, PascalCase, and acronym boundaries:
//   - "refreshModelMirror" -> ["refresh", "Model", "Mirror"]
//   - "HTTPServerConfig"   -> ["HTTP", "Server", "Config"]
//   - "v2Architecture"     -> ["v2", "Architecture"]
func splitCamelAndDigits(seg string) []string {
	rs := []rune(seg)
	if len(rs) == 0 {
		return nil
	}
	var out []string
	start := 0
	for i := 1; i < len(rs); i++ {
		prev := rs[i-1]
		cur := rs[i]
		split := false
		if (unicode.IsLower(prev) || unicode.IsDigit(prev)) && unicode.IsUpper(cur) {
			split = true
		} else if unicode.IsUpper(prev) && unicode.IsUpper(cur) && i+1 < len(rs) && unicode.IsLower(rs[i+1]) {
			split = true
		}
		if split {
			out = append(out, string(rs[start:i]))
			start = i
		}
	}
	out = append(out, string(rs[start:]))
	return out
}

func isCodeShapedSpan(s string) bool {
	hasLetter := false
	hasDigit := false
	for _, r := range s {
		if unicode.IsUpper(r) {
			return true
		}
		switch r {
		case '_', '-', '/', '.', ':':
			return true
		}
		if unicode.IsLetter(r) {
			hasLetter = true
		} else if unicode.IsDigit(r) {
			hasDigit = true
		}
	}
	return hasLetter && hasDigit
}

func stripTrailingLineCol(s string) string {
	for {
		colon := strings.LastIndexByte(s, ':')
		if colon <= 0 || colon == len(s)-1 {
			return s
		}
		// Keep Windows drive prefixes like "c:/foo".
		if colon == 1 && colon+1 < len(s) && s[colon+1] == '/' {
			return s
		}
		tail := s[colon+1:]
		allLineRef := true
		for _, r := range tail {
			if !unicode.IsDigit(r) && r != '-' {
				allLineRef = false
				break
			}
		}
		if !allLineRef {
			return s
		}
		s = s[:colon]
	}
}

func isLikelyFileExt(ext string) bool {
	if len(ext) == 0 || len(ext) > 6 {
		return false
	}
	for _, r := range ext {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) {
			return false
		}
	}
	return true
}

func isCodeSpanRune(r rune) bool {
	if isCJKRune(r) {
		return false
	}
	if unicode.IsLetter(r) || unicode.IsDigit(r) {
		return true
	}
	switch r {
	case '_', '-', '.', '/', '\\', ':':
		return true
	default:
		return false
	}
}

func isCJKRune(r rune) bool {
	return unicode.Is(unicode.Han, r) ||
		unicode.Is(unicode.Hiragana, r) ||
		unicode.Is(unicode.Katakana, r) ||
		unicode.Is(unicode.Hangul, r)
}

func messageRoleAndWeight(role provider.Role) (string, float64) {
	switch role {
	case provider.RoleUser:
		return "user", roleWeightUser
	case provider.RoleAssistant:
		return "assistant", roleWeightAssistant
	case provider.RoleTool:
		return "tool", roleWeightTool
	default:
		return string(role), roleWeightAssistant
	}
}

func owningBlockID(blocks []SessionHistoryBlock, msgIdx, keepFrom int) string {
	// Prefer active blocks first, then retired blocks if no active block matches.
	for _, b := range blocks {
		if b.RetiredByBlockID == "" && msgIdx >= b.StartIdx && msgIdx < b.EndIdx && b.ID != "" {
			return b.ID
		}
	}
	for _, b := range blocks {
		if msgIdx >= b.StartIdx && msgIdx < b.EndIdx && b.ID != "" {
			return b.ID
		}
	}
	if msgIdx < keepFrom {
		return "compacted"
	}
	return "live"
}

func isSyntheticSystemMessage(m provider.Message) bool {
	if m.Meta != nil && (m.Meta["hidden"] == "true" || m.Meta["compaction"] == "true") {
		return true
	}
	if m.Role == provider.RoleUser {
		raw := strings.TrimSpace(extractRawMessageText(m))
		if strings.HasPrefix(raw, "<system-warn>") && strings.HasSuffix(raw, "</system-warn>") {
			return true
		}
	}
	return false
}

func extractRawMessageText(m provider.Message) string {
	var parts []string
	for _, c := range m.Content {
		if tb, ok := c.(provider.TextBlock); ok && tb.Text != "" {
			parts = append(parts, tb.Text)
		}
	}
	return strings.Join(parts, "\n")
}

func searchableImageText(img provider.ImageBlock, digests map[string]string) string {
	var parts []string
	if img.SourcePath != "" {
		parts = append(parts, img.SourcePath)
	}
	if img.MimeType != "" {
		parts = append(parts, img.MimeType)
	}
	if img.Width > 0 && img.Height > 0 {
		parts = append(parts, fmt.Sprintf("%dx%d", img.Width, img.Height))
	}
	if len(digests) > 0 {
		if d := strings.TrimSpace(digests[provider.ImageKey(img)]); d != "" {
			parts = append(parts, d)
		}
	}
	return strings.Join(parts, " ")
}

func searchableMessageText(m provider.Message, callNames map[string]string, digests map[string]string) string {
	var parts []string
	switch m.Role {
	case provider.RoleUser:
		for _, c := range m.Content {
			switch b := c.(type) {
			case provider.TextBlock:
				cleaned := core.StripLeadingSystemPrompt(b.Text)
				if strings.TrimSpace(cleaned) == "" {
					cleaned = b.Text
				}
				if strings.TrimSpace(cleaned) != "" {
					parts = append(parts, cleaned)
				}
			case provider.ImageBlock:
				if txt := searchableImageText(b, digests); txt != "" {
					parts = append(parts, txt)
				}
			case provider.ToolResultBlock:
				if txt := extractToolResultBodyAttrsAndDigests(b, digests); txt != "" {
					parts = append(parts, txt)
				}
			}
		}
	case provider.RoleAssistant:
		for _, c := range m.Content {
			switch b := c.(type) {
			case provider.TextBlock:
				if strings.TrimSpace(b.Text) != "" {
					parts = append(parts, b.Text)
				}
			case provider.ReasoningBlock:
				if strings.TrimSpace(b.Summary) != "" {
					parts = append(parts, b.Summary)
				}
			case provider.ToolCallBlock:
				parts = append(parts, b.Name+" "+string(b.Arguments))
			case provider.ImageBlock:
				if txt := searchableImageText(b, digests); txt != "" {
					parts = append(parts, txt)
				}
			}
		}
	case provider.RoleTool:
		for _, c := range m.Content {
			switch b := c.(type) {
			case provider.ToolResultBlock:
				if toolName := callNames[b.CallID]; toolName != "" {
					parts = append(parts, toolName)
				}
				if txt := extractToolResultBodyAttrsAndDigests(b, digests); txt != "" {
					parts = append(parts, txt)
				}
			case provider.TextBlock:
				if parsed, ok := core.ParseToolEnvelope(b.Text); ok {
					parts = append(parts, parsed.Body)
				} else if strings.TrimSpace(b.Text) != "" {
					parts = append(parts, b.Text)
				}
			}
		}
	}
	return strings.Join(parts, "\n")
}

func searchableBlockText(b SessionHistoryBlock) string {
	var parts []string
	if b.ID != "" {
		parts = append(parts, b.ID)
	}
	if b.Topic != "" {
		parts = append(parts, b.Topic)
	}
	if b.Summary != "" {
		parts = append(parts, b.Summary)
	}
	if len(b.ModifiedFiles) > 0 {
		parts = append(parts, "modified: "+strings.Join(b.ModifiedFiles, " "))
	}
	if len(b.ReadFiles) > 0 {
		parts = append(parts, "read: "+strings.Join(b.ReadFiles, " "))
	}
	if len(b.FailedCommands) > 0 {
		parts = append(parts, "failed: "+strings.Join(b.FailedCommands, " "))
	}
	return strings.Join(parts, "\n")
}

func extractToolResultBodyAndAttrs(tr provider.ToolResultBlock) string {
	return extractToolResultBodyAttrsAndDigests(tr, nil)
}

func extractToolResultBodyAttrsAndDigests(tr provider.ToolResultBlock, digests map[string]string) string {
	var parts []string
	for _, c := range tr.Content {
		switch inner := c.(type) {
		case provider.TextBlock:
			if inner.Text == "" {
				continue
			}
			if parsed, ok := core.ParseToolEnvelope(inner.Text); ok {
				for _, k := range []string{"path", "url", "info", "error", "exit", "status", "media", "orig_media"} {
					if v := parsed.Attrs[k]; v != "" {
						parts = append(parts, k+"="+v)
					}
				}
				if parsed.Body != "" {
					parts = append(parts, parsed.Body)
				}
			} else {
				parts = append(parts, inner.Text)
			}
		case provider.ImageBlock:
			if txt := searchableImageText(inner, digests); txt != "" {
				parts = append(parts, txt)
			}
		}
	}
	return strings.Join(parts, "\n")
}

func extractMatchSnippet(text string, terms []string, maxChars int) string {
	flat := strings.Join(strings.Fields(text), " ")
	if flat == "" {
		return ""
	}
	if len(flat) <= maxChars {
		return flat
	}
	lower := strings.ToLower(flat)
	bestIdx := -1
	for _, term := range terms {
		if term == "" {
			continue
		}
		if idx := strings.Index(lower, term); idx >= 0 {
			if bestIdx < 0 || idx < bestIdx {
				bestIdx = idx
			}
		}
	}
	if bestIdx < 0 {
		return snapUTF8Slice(flat, 0, maxChars) + "…"
	}
	half := maxChars / 2
	start := bestIdx - half
	if start < 0 {
		start = 0
	}
	if start+maxChars > len(flat) {
		start = len(flat) - maxChars
		if start < 0 {
			start = 0
		}
	}
	snip := snapUTF8Slice(flat, start, start+maxChars)
	prefix := ""
	suffix := ""
	if start > 0 {
		prefix = "…"
	}
	if start+len(snip) < len(flat) {
		suffix = "…"
	}
	return prefix + strings.TrimSpace(snip) + suffix
}

// ---------------------------------------------------------------------------
// Recall: Verbatim raw messages with character-offset pagination
// ---------------------------------------------------------------------------

func executeSessionHistoryRecall(snap SessionHistorySnapshot, a SessionHistoryArgs) (core.ToolResult, error) {
	if len(snap.Messages) == 0 {
		return core.ToolResult{}, fmt.Errorf("session_history: session has no messages to recall")
	}

	var startIdx, endExclusive int
	blockID := strings.TrimSpace(a.BlockID)
	if blockID != "" {
		var matched *SessionHistoryBlock
		for i := range snap.Blocks {
			if snap.Blocks[i].ID == blockID {
				matched = &snap.Blocks[i]
				break
			}
		}
		if matched == nil {
			for i := range snap.Blocks {
				if strings.EqualFold(snap.Blocks[i].ID, blockID) {
					matched = &snap.Blocks[i]
					break
				}
			}
		}
		if matched == nil {
			var ids []string
			for _, b := range snap.Blocks {
				if b.ID != "" {
					ids = append(ids, b.ID)
				}
			}
			avail := "none"
			if len(ids) > 0 {
				avail = strings.Join(ids, ", ")
			}
			return core.ToolResult{}, fmt.Errorf("session_history: unknown block_id %q (available blocks: %s)", blockID, avail)
		}
		startIdx = matched.StartIdx
		endExclusive = matched.EndIdx
		if startIdx < 0 {
			startIdx = 0
		}
		if endExclusive > len(snap.Messages) {
			endExclusive = len(snap.Messages)
		}
		if endExclusive <= startIdx {
			return core.ToolResult{}, fmt.Errorf("session_history: block %q covers an empty message span [%d, %d)", matched.ID, matched.StartIdx, matched.EndIdx)
		}
	} else {
		if a.StartMsg == nil && a.EndMsg == nil {
			return core.ToolResult{}, fmt.Errorf("session_history: recall requires either `block_id` or `start_msg` (and optional `end_msg`)")
		}
		s := 0
		if a.StartMsg != nil {
			s = *a.StartMsg
		} else if a.EndMsg != nil {
			s = *a.EndMsg
		}
		e := s
		if a.EndMsg != nil {
			e = *a.EndMsg
		}
		if s < 0 {
			return core.ToolResult{}, fmt.Errorf("session_history: start_msg (%d) must be >= 0", s)
		}
		if e < s {
			return core.ToolResult{}, fmt.Errorf("session_history: end_msg (%d) must be >= start_msg (%d)", e, s)
		}
		if s >= len(snap.Messages) {
			return core.ToolResult{}, fmt.Errorf("session_history: start_msg (%d) out of range (session has %d messages, valid indices 0..%d)", s, len(snap.Messages), len(snap.Messages)-1)
		}
		if e >= len(snap.Messages) {
			e = len(snap.Messages) - 1
		}
		startIdx = s
		endExclusive = e + 1
	}

	maxChars := a.MaxChars
	if maxChars <= 0 {
		maxChars = sessionHistoryDefaultRecallChars
	}
	if maxChars > sessionHistoryMaxRecallChars {
		maxChars = sessionHistoryMaxRecallChars
	}
	offset := a.OffsetChars
	if offset < 0 {
		offset = 0
	}

	keepFrom := snap.KeepFrom
	if keepFrom < 0 {
		keepFrom = 0
	}
	if keepFrom > len(snap.Messages) {
		keepFrom = len(snap.Messages)
	}

	callNames := collectToolCallNames(snap.Messages)
	fullText := renderVerbatimRange(snap.Messages, snap.Blocks, keepFrom, startIdx, endExclusive, callNames, snap.ImageDigests)
	totalChars := len(fullText)

	buildRecallResult := func(body string, effOffset int, truncated bool, nextOffset int) core.ToolResult {
		attrs := []core.Attr{
			{Key: "action", Value: "recall"},
			{Key: "start_msg", Value: strconv.Itoa(startIdx)},
			{Key: "end_msg", Value: strconv.Itoa(endExclusive - 1)},
			{Key: "offset_chars", Value: strconv.Itoa(effOffset)},
			{Key: "total_chars", Value: strconv.Itoa(totalChars)},
			{Key: "truncated", Value: strconv.FormatBool(truncated)},
		}
		if blockID != "" {
			attrs = append(attrs, core.Attr{Key: "block_id", Value: blockID})
		}
		if truncated {
			attrs = append(attrs, core.Attr{Key: "next_offset", Value: strconv.Itoa(nextOffset)})
		}
		return core.ToolResult{
			Content: []provider.Content{provider.TextBlock{Text: body}},
			Attrs:   attrs,
			Details: map[string]any{
				"action":       "recall",
				"block_id":     blockID,
				"start_msg":    startIdx,
				"end_msg":      endExclusive - 1,
				"offset_chars": effOffset,
				"total_chars":  totalChars,
				"truncated":    truncated,
				"next_offset":  nextOffset,
			},
		}
	}

	if offset >= totalChars {
		body := fmt.Sprintf("[offset_chars=%d is at or past end of recalled text (%d chars)]", offset, totalChars)
		return buildRecallResult(body, offset, false, 0), nil
	}

	for offset < totalChars && !utf8.RuneStart(fullText[offset]) {
		offset++
	}
	endByte := offset + maxChars
	truncated := false
	nextOffset := 0
	if endByte < totalChars {
		for endByte > offset && !utf8.RuneStart(fullText[endByte]) {
			endByte--
		}
		if endByte == offset {
			// Single multibyte rune wider than maxChars (only possible for tiny maxChars).
			_, w := utf8.DecodeRuneInString(fullText[offset:])
			endByte = offset + w
		}
		truncated = endByte < totalChars
		if truncated {
			nextOffset = endByte
		}
	} else {
		endByte = totalChars
	}

	window := fullText[offset:endByte]
	if truncated {
		window += fmt.Sprintf("\n\n[... recall paginated: offset_chars=%d, next_offset=%d, total_chars=%d, truncated=true — call session_history with offset_chars=%d to continue]",
			offset, nextOffset, totalChars, nextOffset)
	}

	return buildRecallResult(window, offset, truncated, nextOffset), nil
}

func renderVerbatimImage(sb *strings.Builder, img provider.ImageBlock, digests map[string]string) {
	if len(digests) > 0 {
		if d := strings.TrimSpace(digests[provider.ImageKey(img)]); d != "" {
			sb.WriteString(core.FormatVisualDigestBlock(img, d))
			sb.WriteString("\n")
			return
		}
	}
	label := img.MimeType
	if img.SourcePath != "" {
		label = img.SourcePath + ", " + label
	}
	if img.Width > 0 && img.Height > 0 {
		fmt.Fprintf(sb, "[image: %s, %dx%d, %d bytes]\n", label, img.Width, img.Height, len(img.Data))
		return
	}
	fmt.Fprintf(sb, "[image: %s, %d bytes]\n", label, len(img.Data))
}

func renderVerbatimRange(msgs []provider.Message, blocks []SessionHistoryBlock, keepFrom, startIdx, endExclusive int, callNames map[string]string, digests map[string]string) string {
	var sb strings.Builder
	for idx := startIdx; idx < endExclusive && idx < len(msgs); idx++ {
		if sb.Len() > 0 {
			sb.WriteString("\n\n")
		}
		m := msgs[idx]
		role, _ := messageRoleAndWeight(m.Role)
		blk := owningBlockID(blocks, idx, keepFrom)
		fmt.Fprintf(&sb, "=== [msg #%d · %s · block %s] ===\n", idx, role, blk)

		switch m.Role {
		case provider.RoleUser:
			for _, c := range m.Content {
				switch b := c.(type) {
				case provider.TextBlock:
					cleaned := core.StripLeadingSystemPrompt(b.Text)
					if strings.TrimSpace(cleaned) == "" {
						cleaned = b.Text
					}
					sb.WriteString(cleaned)
					sb.WriteString("\n")
				case provider.ImageBlock:
					renderVerbatimImage(&sb, b, digests)
				case provider.ToolResultBlock:
					renderVerbatimToolResult(&sb, b, callNames, digests)
				}
			}
		case provider.RoleAssistant:
			for _, c := range m.Content {
				switch b := c.(type) {
				case provider.ReasoningBlock:
					if strings.TrimSpace(b.Summary) != "" {
						sb.WriteString("[reasoning]\n")
						sb.WriteString(b.Summary)
						sb.WriteString("\n")
					}
				case provider.TextBlock:
					sb.WriteString(b.Text)
					sb.WriteString("\n")
				case provider.ToolCallBlock:
					fmt.Fprintf(&sb, "[tool_call id=%s name=%s]\n%s\n", b.ID, b.Name, string(b.Arguments))
				case provider.ImageBlock:
					renderVerbatimImage(&sb, b, digests)
				case provider.ToolResultBlock:
					renderVerbatimToolResult(&sb, b, callNames, digests)
				}
			}
		case provider.RoleTool:
			for _, c := range m.Content {
				switch b := c.(type) {
				case provider.ToolResultBlock:
					renderVerbatimToolResult(&sb, b, callNames, digests)
				case provider.TextBlock:
					if parsed, ok := core.ParseToolEnvelope(b.Text); ok {
						sb.WriteString(parsed.Body)
						sb.WriteString("\n")
					} else {
						sb.WriteString(b.Text)
						sb.WriteString("\n")
					}
				}
			}
		}
	}
	return strings.TrimRight(sb.String(), "\n")
}

func renderVerbatimToolResult(sb *strings.Builder, tr provider.ToolResultBlock, callNames map[string]string, digests map[string]string) {
	toolName := callNames[tr.CallID]
	if toolName != "" {
		fmt.Fprintf(sb, "[tool_result call_id=%s tool=%s is_error=%t]\n", tr.CallID, toolName, tr.IsError)
	} else {
		fmt.Fprintf(sb, "[tool_result call_id=%s is_error=%t]\n", tr.CallID, tr.IsError)
	}
	for _, c := range tr.Content {
		switch inner := c.(type) {
		case provider.TextBlock:
			if parsed, ok := core.ParseToolEnvelope(inner.Text); ok {
				if len(parsed.Attrs) > 0 {
					keys := make([]string, 0, len(parsed.Attrs))
					for k := range parsed.Attrs {
						keys = append(keys, k)
					}
					sort.Strings(keys)
					var pairs []string
					for _, k := range keys {
						pairs = append(pairs, fmt.Sprintf("%s=%q", k, parsed.Attrs[k]))
					}
					fmt.Fprintf(sb, "[attrs %s]\n", strings.Join(pairs, " "))
				}
				if parsed.Body != "" {
					sb.WriteString(parsed.Body)
					sb.WriteString("\n")
				}
			} else {
				sb.WriteString(inner.Text)
				sb.WriteString("\n")
			}
		case provider.ImageBlock:
			renderVerbatimImage(sb, inner, digests)
		}
	}
}

func collectToolCallNames(msgs []provider.Message) map[string]string {
	out := map[string]string{}
	for _, m := range msgs {
		for _, c := range m.Content {
			if tc, ok := c.(provider.ToolCallBlock); ok && tc.ID != "" && tc.Name != "" {
				out[tc.ID] = tc.Name
			}
		}
	}
	return out
}

func snapUTF8Slice(s string, start, end int) string {
	if start < 0 {
		start = 0
	}
	if end > len(s) {
		end = len(s)
	}
	for start < end && !utf8.RuneStart(s[start]) {
		start++
	}
	for end > start && !utf8.RuneStart(s[end]) {
		end--
	}
	return s[start:end]
}

func sliceContains(list []string, target string) bool {
	for _, s := range list {
		if s == target {
			return true
		}
	}
	return false
}
