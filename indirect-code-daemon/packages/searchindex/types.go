// Package searchindex implements a pure-Go, zero-cgo incremental LSM-BM25F
// full-text search engine tailored for multi-session agent transcripts.
package searchindex

import "math"

// Field identifies one of the 4 weighted BM25F fields.
type Field uint8

const (
	FieldTitle     Field = 0
	FieldUser      Field = 1
	FieldAssistant Field = 2
	FieldTool      Field = 3

	numFields     = 4
	numTurnFields = 3 // User, Assistant, Tool stored in turn segments
)

// String returns the wire identifier for f.
func (f Field) String() string {
	switch f {
	case FieldTitle:
		return "title"
	case FieldUser:
		return "user"
	case FieldAssistant:
		return "assistant"
	case FieldTool:
		return "tool"
	default:
		return "assistant"
	}
}

// Boost returns the BM25F field weight for f.
func (f Field) Boost() float64 {
	switch f {
	case FieldTitle:
		return BoostTitle
	case FieldUser:
		return BoostUser
	case FieldAssistant:
		return BoostAssistant
	case FieldTool:
		return BoostTool
	default:
		return 1.0
	}
}

// BM25F and indexing tuning constants.
const (
	BM25K1 = 1.2
	BM25B  = 0.75

	BoostTitle     = 4.0
	BoostUser      = 2.0
	BoostAssistant = 1.8
	BoostTool      = 1.0

	// PrefixWeight weights prefix-expanded terms on the final query token
	// relative to exact term matches (1.0x).
	PrefixWeight   = 0.65
	MaxPrefixTerms = 16

	// MaxToolBlockTokens caps indexed tokens per individual tool block so
	// multi-megabyte command/file dumps cannot skew corpus IDF or bloat segments.
	MaxToolBlockTokens = 512

	// MaxSnippetStoreRunes caps compressed per-field excerpts stored in .sdoc.
	MaxSnippetStoreRunes = 512

	// DefaultSnippetRunes is the default rune length for search result snippets.
	DefaultSnippetRunes = 120

	// DefaultQueryLimit is used when Query.Limit <= 0.
	DefaultQueryLimit = 30
	MaxQueryLimit     = 200
)

// SessionMeta holds lightweight per-session catalog metadata persisted in
// MANIFEST.json so renames/CWD/timestamp updates remain O(1).
type SessionMeta struct {
	Title     string `json:"title"`
	CWD       string `json:"cwd"`
	UpdatedAt int64  `json:"updatedAt"`
}

// TurnDoc represents one indexed conversation turn across the 3 turn-level
// BM25F fields (User, Assistant, Tool). Session Title is maintained in the
// O(1) session catalog via UpdateSessionMeta / IndexSessionTurns.
type TurnDoc struct {
	SessionID            string
	TurnIndex            int
	FirstMsgIdx          int
	BestUserOrAsstMsgIdx int
	UpdatedAtUnix        int64

	UserText      string
	AssistantText string
	ToolText      string
	// ToolBlocks holds individual tool call / summary / widget blocks; each
	// entry is independently capped at MaxToolBlockTokens when indexed.
	ToolBlocks []string

	// Optional per-field message indices populated by ExtractTurnDoc /
	// ExtractSessionTurns so hits in User vs Assistant vs Tool jump to the
	// exact raw message index inside the turn.
	HasFieldMsgIdx  bool
	UserMsgIdx      int
	AssistantMsgIdx int
	ToolMsgIdx      int
}

// ResolveMsgIdx returns the exact message index for the winning turn field.
func (d *TurnDoc) ResolveMsgIdx(f Field) int {
	if d.HasFieldMsgIdx {
		switch f {
		case FieldUser:
			if d.UserMsgIdx >= 0 {
				return d.UserMsgIdx
			}
		case FieldAssistant:
			if d.AssistantMsgIdx >= 0 {
				return d.AssistantMsgIdx
			}
		case FieldTool:
			if d.ToolMsgIdx >= 0 {
				return d.ToolMsgIdx
			}
		}
	}
	if d.BestUserOrAsstMsgIdx >= d.FirstMsgIdx {
		return d.BestUserOrAsstMsgIdx
	}
	return d.FirstMsgIdx
}

// Query configures a full-text BM25F search across indexed sessions.
type Query struct {
	Text          string
	Limit         int
	SnippetRunes  int
	CWDPrefix     string
	DisablePrefix bool
}

// SessionSearchResult is an aggregated per-session search hit ranked by BM25F.
type SessionSearchResult struct {
	SessionID  string  `json:"sessionId"`
	Title      string  `json:"title"`
	CWD        string  `json:"cwd"`
	UpdatedAt  int64   `json:"updatedAt"`
	MatchCount int     `json:"matchCount"`
	Score      float64 `json:"score"`
	MessageIdx int     `json:"messageIdx"`
	TurnIndex  int     `json:"turnIndex"`
	Field      string  `json:"field"`
	Snippet    string  `json:"snippet"`
}

// Options tunes LSM memory bounds, dictionary block layout, and compaction.
type Options struct {
	// MaxMemTurns triggers an automatic MemTable flush when reached (default 2000).
	MaxMemTurns int
	// MaxMemBytes triggers an automatic MemTable flush when postings/excerpt
	// memory reaches this budget (default 2 MiB).
	MaxMemBytes int
	// MaxSegments bounds total disk segments during compaction (default 12).
	MaxSegments int
	// TierMergeWidth is the max small segments merged per tier step (default 4).
	TierMergeWidth int
	// DictBlockStride stores every Nth term in the in-memory sparse index (default 32).
	DictBlockStride int
	// DictBlockMaxBytes caps on-disk dictionary block byte size (default 4096).
	DictBlockMaxBytes int
}

func normalizeOptions(opts []Options) Options {
	var o Options
	if len(opts) > 0 {
		o = opts[0]
	}
	if o.MaxMemTurns <= 0 {
		o.MaxMemTurns = 2000
	}
	if o.MaxMemBytes <= 0 {
		o.MaxMemBytes = 2 << 20 // 2 MiB
	}
	if o.MaxSegments <= 0 {
		o.MaxSegments = 12
	}
	if o.TierMergeWidth <= 1 {
		o.TierMergeWidth = 4
	}
	if o.DictBlockStride <= 0 {
		o.DictBlockStride = 32
	}
	if o.DictBlockMaxBytes <= 0 {
		o.DictBlockMaxBytes = 4096
	}
	return o
}

// Stats exposes operational and memory telemetry for tests and monitoring.
type Stats struct {
	Sessions       int
	MemTurns       int
	MemBytes       int
	SegmentCount   int
	SegmentDocs    int
	LiveDocs       int
	TombstoneDocs  int
	DictLeaders    int
	DictLeadersRAM int
	EstimatedRAM   int64
}

// ---------------------------------------------------------------------------
// Quantized 1-Byte Field Length Norms (0 = empty, 1..64 exact, 65..255 log)
// ---------------------------------------------------------------------------

const normLogStep = 1.055

var (
	normLogDenom    = math.Log(normLogStep)
	normDecodeTable [256]float32
)

func init() {
	normDecodeTable[0] = 0
	for i := 1; i <= 64; i++ {
		normDecodeTable[i] = float32(i)
	}
	for i := 65; i < 256; i++ {
		v := 64.0 * math.Pow(normLogStep, float64(i-64))
		normDecodeTable[i] = float32(math.Round(v))
	}
}

// encodeNorm quantizes a non-negative token length into 1 byte:
//   - 0 -> 0
//   - 1..64 -> exact
//   - >64 -> logarithmic steps (~2.7% max relative error up to ~1.75M tokens)
func encodeNorm(docLen int) uint8 {
	if docLen <= 0 {
		return 0
	}
	if docLen <= 64 {
		return uint8(docLen)
	}
	q := 64 + int(math.Round(math.Log(float64(docLen)/64.0)/normLogDenom))
	if q < 65 {
		q = 65
	}
	if q > 255 {
		q = 255
	}
	return uint8(q)
}

func decodeNorm(b uint8) float32 {
	return normDecodeTable[b]
}
