package core

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"indirect/indirect-code-daemon/packages/provider"
)

// Compaction tuning and heuristics.
const (
	// CompactionReserveTokens is the headroom kept for the summarizer's
	// own output plus the next turn. RESERVE_TOKENS = 16384.
	CompactionReserveTokens = 16384
	// CompactionKeepRecentTokens is the floor of recent context that is
	// never summarized away. KEEP_RECENT_TOKENS = 20000.
	CompactionKeepRecentTokens = 20000
	// CompactionKeepMaxTokens caps the hybrid keep floor (which raises
	// the 20k floor toward 30% of the transcript on large histories) so
	// compacting a huge transcript lands near the same size as
	// compacting a small one.
	CompactionKeepMaxTokens = 40000
	// CompactionMinMessages is the minimum history length worth
	// compacting. Below this there is nothing meaningful to summarize.
	CompactionMinMessages = 6

	// FoldBlockTargetTokens is the target raw token span per immutable
	// Tier-1 FoldBlock (~45K tokens).
	FoldBlockTargetTokens = 45000
	// Tier2MergeBlockThreshold is the active block count above which the
	// oldest Tier2MergeBatchSize active Tier-1 blocks merge into 1 Tier-2 block.
	Tier2MergeBlockThreshold = 8
	// Tier2MergeBatchSize is the number of oldest contiguous active Tier-1
	// blocks rolled up into a single Tier-2 FoldBlock.
	Tier2MergeBatchSize = 4
	// Tier2MergeWindowPct is the max percentage of context window that active
	// FoldBlocks may occupy before triggering a Tier-2 merge.
	Tier2MergeWindowPct = 15

	// NetShrinkTolerance enforces net token shrinkage against regurgitative
	// summarizer outputs; violations fall back to MechanicalBlockSummary.
	NetShrinkTolerance   = 0.95
	netShrinkFloorTokens = 1000

	serializeBlockBudgetBytes = 12 * 1024
	serializeArgsBudgetBytes  = 2 * 1024
)

// FailedCommandSummary records a failed shell/script command inside a FoldBlock's
// deterministic Tombstone header so error anchors survive across folds and merges.
type FailedCommandSummary struct {
	Command    string `json:"command"`
	ExitCode   string `json:"exitCode,omitempty"`
	FirstError string `json:"firstError,omitempty"`
}

// FoldBlock is one append-only compacted era in the LSM compaction log.
// Tier-1 blocks fold contiguous raw spans [StartIdx, EndIdx); Tier-2 blocks
// merge older Tier-1 blocks while mechanically unioning their Tombstones.
type FoldBlock struct {
	ID               string                 `json:"id"`
	Tier             int                    `json:"tier"`
	StartIdx         int                    `json:"startIdx"`
	EndIdx           int                    `json:"endIdx"`
	Topic            string                 `json:"topic,omitempty"`
	Summary          string                 `json:"summary"`
	ReadFiles        []string               `json:"readFiles,omitempty"`
	ModifiedFiles    []string               `json:"modifiedFiles,omitempty"`
	FileSpans        []string               `json:"fileSpans,omitempty"`
	ActivatedTools   []string               `json:"activatedTools,omitempty"`
	FailedCommands   []FailedCommandSummary `json:"failedCommands,omitempty"`
	SourceBlockIDs   []string               `json:"sourceBlockIds,omitempty"`
	RetiredByBlockID string                 `json:"retiredByBlockId,omitempty"`
	RawTokens        int                    `json:"rawTokens,omitempty"`
	BlockTokens      int                    `json:"blockTokens,omitempty"`
	CreatedAt        int64                  `json:"createdAt"`
}

func (b FoldBlock) clone() FoldBlock {
	cp := b
	cp.ReadFiles = append([]string(nil), b.ReadFiles...)
	cp.ModifiedFiles = append([]string(nil), b.ModifiedFiles...)
	cp.FileSpans = append([]string(nil), b.FileSpans...)
	cp.ActivatedTools = append([]string(nil), b.ActivatedTools...)
	cp.FailedCommands = append([]FailedCommandSummary(nil), b.FailedCommands...)
	cp.SourceBlockIDs = append([]string(nil), b.SourceBlockIDs...)
	return cp
}

// CompactionState is persisted on the session record across turns and restarts.
// Blocks holds the multi-block LSM era chain; KeepFrom, PreviousSummary,
// ReadFiles, ModifiedFiles, and FirstKeptEntryID stay synced as mirror fields
// for UI/E2E and legacy compatibility.
type CompactionState struct {
	PreviousSummary  string          `json:"previousSummary,omitempty"`
	ReadFiles        []string        `json:"readFiles,omitempty"`
	ModifiedFiles    []string        `json:"modifiedFiles,omitempty"`
	FirstKeptEntryID string          `json:"firstKeptEntryId,omitempty"`
	Count            int             `json:"count,omitempty"`
	KeepFrom         int             `json:"keepFrom,omitempty"`
	Usage            *provider.Usage `json:"usage,omitempty"`
	Blocks           []FoldBlock     `json:"blocks,omitempty"`
	NextBlockSeq     int             `json:"nextBlockSeq,omitempty"`
	PrunedBefore     int             `json:"prunedBefore,omitempty"`
}

// Clone returns a deep copy of s, or nil when s is nil.
func (s *CompactionState) Clone() *CompactionState {
	if s == nil {
		return nil
	}
	cp := *s
	cp.ReadFiles = append([]string(nil), s.ReadFiles...)
	cp.ModifiedFiles = append([]string(nil), s.ModifiedFiles...)
	if s.Usage != nil {
		u := *s.Usage
		cp.Usage = &u
	}
	if len(s.Blocks) > 0 {
		cp.Blocks = make([]FoldBlock, len(s.Blocks))
		for i, b := range s.Blocks {
			cp.Blocks[i] = b.clone()
		}
	}
	return &cp
}

// ActiveBlocks returns non-retired FoldBlocks sorted chronologically by StartIdx.
func (s *CompactionState) ActiveBlocks() []FoldBlock {
	if s == nil || len(s.Blocks) == 0 {
		return nil
	}
	out := make([]FoldBlock, 0, len(s.Blocks))
	for _, b := range s.Blocks {
		if b.RetiredByBlockID == "" && b.EndIdx > b.StartIdx {
			out = append(out, b)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].StartIdx != out[j].StartIdx {
			return out[i].StartIdx < out[j].StartIdx
		}
		return out[i].EndIdx < out[j].EndIdx
	})
	return out
}

func (s *CompactionState) allocBlockID() string {
	for _, b := range s.Blocks {
		if strings.HasPrefix(b.ID, "b") {
			if n, err := strconv.Atoi(b.ID[1:]); err == nil && n > s.NextBlockSeq {
				s.NextBlockSeq = n
			}
		}
	}
	s.NextBlockSeq++
	return "b" + strconv.Itoa(s.NextBlockSeq)
}

// SyncMirrors recomputes derived mirror fields (KeepFrom, FirstKeptEntryID,
// ReadFiles, ModifiedFiles, PreviousSummary, NextBlockSeq) from active Blocks.
// On legacy states with len(Blocks)==0, existing fields are preserved intact.
func (s *CompactionState) SyncMirrors() {
	if s == nil {
		return
	}
	for _, b := range s.Blocks {
		if strings.HasPrefix(b.ID, "b") {
			if n, err := strconv.Atoi(b.ID[1:]); err == nil && n > s.NextBlockSeq {
				s.NextBlockSeq = n
			}
		}
	}
	if len(s.Blocks) == 0 {
		if s.KeepFrom > 0 && s.FirstKeptEntryID == "" {
			s.FirstKeptEntryID = "h" + strconv.Itoa(s.KeepFrom)
		}
		return
	}

	active := s.ActiveBlocks()
	if len(active) == 0 {
		s.KeepFrom = 0
		s.FirstKeptEntryID = ""
		s.PreviousSummary = ""
		s.ReadFiles = nil
		s.ModifiedFiles = nil
		return
	}

	s.KeepFrom = active[len(active)-1].EndIdx
	s.FirstKeptEntryID = "h" + strconv.Itoa(s.KeepFrom)

	var readFiles, modFiles []string
	for _, b := range active {
		readFiles = MergeFileOps(readFiles, b.ReadFiles)
		modFiles = MergeFileOps(modFiles, b.ModifiedFiles)
	}
	s.ReadFiles = readFiles
	s.ModifiedFiles = modFiles

	if len(active) == 1 {
		s.PreviousSummary = strings.TrimSpace(active[0].Summary)
	} else {
		parts := make([]string, 0, len(active))
		for _, b := range active {
			endDisp := max(b.StartIdx, b.EndIdx-1)
			hdr := fmt.Sprintf("### Era %s (msgs #%d–#%d)", b.ID, b.StartIdx, endDisp)
			if b.Topic != "" {
				hdr += " — " + b.Topic
			}
			parts = append(parts, hdr+"\n\n"+strings.TrimSpace(b.Summary))
		}
		s.PreviousSummary = strings.Join(parts, "\n\n---\n\n")
	}
	if s.Count <= 0 {
		s.Count = len(active)
	}
}

// TruncateCompaction rolls back compaction state when the raw transcript is
// truncated or edited at effectiveCut (keeping raw messages [0, effectiveCut)).
//
// Any FoldBlock with EndIdx > effectiveCut is dropped. If a dropped block was
// a Tier-2 merge rollup, its retired Tier-1 children are un-retired first so
// any child completely below effectiveCut survives intact. Returns nil when no
// valid compacted prefix remains below effectiveCut.
func TruncateCompaction(state *CompactionState, effectiveCut int) *CompactionState {
	if state == nil || effectiveCut <= 0 {
		return nil
	}
	cp := state.Clone()
	if len(cp.Blocks) == 0 {
		if cp.KeepFrom <= 0 || cp.KeepFrom > effectiveCut || cp.PreviousSummary == "" {
			return nil
		}
		if cp.PrunedBefore > effectiveCut {
			cp.PrunedBefore = effectiveCut
		}
		cp.SyncMirrors()
		return cp
	}

	removedIDs := map[string]bool{}
	for _, b := range cp.Blocks {
		if b.EndIdx > effectiveCut || b.StartIdx >= effectiveCut || b.EndIdx <= b.StartIdx {
			if b.ID != "" {
				removedIDs[b.ID] = true
			}
		}
	}

	// Un-retire children of any removed Tier-2 rollup (fixed-point for safety).
	for len(removedIDs) > 0 {
		changed := false
		for i := range cp.Blocks {
			retirer := cp.Blocks[i].RetiredByBlockID
			if retirer != "" && removedIDs[retirer] {
				cp.Blocks[i].RetiredByBlockID = ""
				changed = true
			}
		}
		if !changed {
			break
		}
	}

	kept := make([]FoldBlock, 0, len(cp.Blocks))
	keptIDs := map[string]bool{}
	for _, b := range cp.Blocks {
		if b.StartIdx >= 0 && b.EndIdx > b.StartIdx && b.EndIdx <= effectiveCut && !removedIDs[b.ID] {
			kept = append(kept, b)
			if b.ID != "" {
				keptIDs[b.ID] = true
			}
		}
	}
	for i := range kept {
		if kept[i].RetiredByBlockID != "" && !keptIDs[kept[i].RetiredByBlockID] {
			kept[i].RetiredByBlockID = ""
		}
	}
	cp.Blocks = kept
	if cp.PrunedBefore > effectiveCut {
		cp.PrunedBefore = effectiveCut
	}
	cp.SyncMirrors()
	if len(cp.ActiveBlocks()) == 0 {
		return nil
	}
	return cp
}

// ShiftCompactionOnDrop updates all raw transcript indices in state in-place
// when a single ephemeral message at droppedIdx is stripped from raw history.
func ShiftCompactionOnDrop(state *CompactionState, droppedIdx int) {
	if state == nil || droppedIdx < 0 {
		return
	}
	if droppedIdx < state.KeepFrom {
		state.KeepFrom--
	}
	if droppedIdx < state.PrunedBefore {
		state.PrunedBefore--
	}
	if len(state.Blocks) == 0 {
		if state.KeepFrom > 0 {
			state.FirstKeptEntryID = "h" + strconv.Itoa(state.KeepFrom)
		}
		return
	}

	removedIDs := map[string]bool{}
	for i := range state.Blocks {
		if droppedIdx < state.Blocks[i].StartIdx {
			state.Blocks[i].StartIdx--
		}
		if droppedIdx < state.Blocks[i].EndIdx {
			state.Blocks[i].EndIdx--
		}
		if state.Blocks[i].EndIdx <= state.Blocks[i].StartIdx && state.Blocks[i].ID != "" {
			removedIDs[state.Blocks[i].ID] = true
		}
	}
	if len(removedIDs) > 0 {
		filtered := make([]FoldBlock, 0, len(state.Blocks))
		for _, b := range state.Blocks {
			if b.EndIdx <= b.StartIdx {
				continue
			}
			if b.RetiredByBlockID != "" && removedIDs[b.RetiredByBlockID] {
				b.RetiredByBlockID = ""
			}
			filtered = append(filtered, b)
		}
		state.Blocks = filtered
	}
	state.SyncMirrors()
}

// summaryMessageText renders the legacy single-summary message text wrapped in
// <system-reminder> so frontend nudge filtering hides it as a chat bubble.
func summaryMessageText(summary string) string {
	return "<system-reminder>## Context Summary (compacted)\n\n" + summary + "</system-reminder>"
}

// formatFoldBlockMessageText renders one FoldBlock into its deterministic
// Tombstone header + recall affordance + narrative summary, wrapped in
// <system-reminder>## Context Summary (compacted).
//
// Depends strictly on b's own immutable fields so earlier blocks b_0..b_{k-1}
// stay 100% byte-identical across subsequent compactions (preserving KV cache).
func formatFoldBlockMessageText(b FoldBlock) string {
	var sb strings.Builder
	sb.WriteString("<system-reminder>## Context Summary (compacted)\n\n")

	endDisp := max(b.StartIdx, b.EndIdx-1)
	tier := b.Tier
	if tier <= 0 {
		tier = 1
	}
	sb.WriteString(fmt.Sprintf("[FoldBlock %s · Tier %d · msgs #%d–#%d]", b.ID, tier, b.StartIdx, endDisp))
	if len(b.SourceBlockIDs) > 0 {
		sb.WriteString(fmt.Sprintf(" (merged: %s)", strings.Join(b.SourceBlockIDs, ", ")))
	}
	sb.WriteString("\n")
	if b.Topic != "" {
		sb.WriteString("Topic: ")
		sb.WriteString(b.Topic)
		sb.WriteString("\n")
	}
	if len(b.ModifiedFiles) > 0 {
		sb.WriteString("Files modified: ")
		sb.WriteString(strings.Join(b.ModifiedFiles, ", "))
		sb.WriteString("\n")
	}
	if len(b.ReadFiles) > 0 {
		sb.WriteString("Files read: ")
		sb.WriteString(strings.Join(b.ReadFiles, ", "))
		sb.WriteString("\n")
	}
	if len(b.FileSpans) > 0 {
		sb.WriteString("File spans: ")
		sb.WriteString(strings.Join(b.FileSpans, ", "))
		sb.WriteString("\n")
	}
	if len(b.FailedCommands) > 0 {
		sb.WriteString("Failed commands:\n")
		for _, fc := range b.FailedCommands {
			sb.WriteString("- `")
			sb.WriteString(fc.Command)
			sb.WriteString("`")
			if fc.ExitCode != "" {
				sb.WriteString(" (exit ")
				sb.WriteString(fc.ExitCode)
				sb.WriteString(")")
			}
			if fc.FirstError != "" {
				sb.WriteString(": ")
				sb.WriteString(fc.FirstError)
			}
			sb.WriteString("\n")
		}
	}
	omitted := max(1, b.EndIdx-b.StartIdx)
	sb.WriteString(fmt.Sprintf(
		"Recall: Omitted %d raw messages (#%d–#%d) — call `session_history` with `{\"action\":\"recall\",\"block_id\":%q}` (or `start_msg`=%d, `end_msg`=%d) or `{\"action\":\"search\",\"query\":\"...\"}` before relying on exact prior lines, code, or logs.\n\n",
		omitted, b.StartIdx, endDisp, b.ID, b.StartIdx, b.EndIdx,
	))
	sb.WriteString(strings.TrimSpace(b.Summary))
	sb.WriteString("</system-reminder>")
	return sb.String()
}

func renderFoldBlockMessage(b FoldBlock, isLast bool, count int, extraTools []string) provider.Message {
	meta := map[string]string{
		"compaction": "true",
		"block_id":   b.ID,
	}
	if isLast {
		meta["compaction_last_block"] = "true"
		if count > 0 {
			meta["count"] = strconv.Itoa(count)
		}
	}
	activated := MergeFileOps(b.ActivatedTools, extraTools)
	var ts time.Time
	if b.CreatedAt > 0 {
		ts = time.UnixMilli(b.CreatedAt)
	}
	return provider.Message{
		Role:           provider.RoleUser,
		Time:           ts,
		Content:        []provider.Content{provider.TextBlock{Text: formatFoldBlockMessageText(b)}},
		Meta:           meta,
		AddedToolNames: activated,
	}
}

// projectionAnchor resolves a legacy/mirrored chain head against a history length.
// Corrupted/out-of-range anchors fail open to pass-through.
func projectionAnchor(state *CompactionState, historyLen int) (synthetic bool, keepFrom int) {
	if state == nil {
		return false, 0
	}
	if len(state.Blocks) > 0 {
		active := state.ActiveBlocks()
		if len(active) == 0 {
			return false, 0
		}
		kf := state.KeepFrom
		if kf <= 0 {
			kf = active[len(active)-1].EndIdx
		}
		if kf < 0 || kf > historyLen {
			return false, 0
		}
		for _, b := range active {
			if b.StartIdx < 0 || b.EndIdx > historyLen || b.EndIdx <= b.StartIdx {
				return false, 0
			}
		}
		return true, kf
	}
	if state.PreviousSummary == "" {
		return false, 0
	}
	if state.KeepFrom < 0 || state.KeepFrom > historyLen {
		return false, 0
	}
	return true, state.KeepFrom
}

// projectMessages derives the effective model context from the append-only
// history and CompactionState without mutating history.
//
// In multi-block mode (len(state.Blocks) > 0), emits 1 synthetic RoleUser per
// active FoldBlock followed by the ViewLatch-stabilized tail history[keepFrom:].
// Legacy states (len(state.Blocks) == 0 && PreviousSummary != "") continue to
// emit a single synthetic summary message seamlessly.
func projectMessages(history []provider.Message, state *CompactionState) []provider.Message {
	if state == nil {
		return history
	}
	synthetic, keepFrom := projectionAnchor(state, len(history))
	if !synthetic {
		if state.PrunedBefore > 0 {
			return ApplyViewLatchTail(history, 0, state.PrunedBefore)
		}
		return history
	}

	latchedTail := ApplyViewLatchTail(history[keepFrom:], keepFrom, state.PrunedBefore)

	if len(state.Blocks) > 0 {
		active := state.ActiveBlocks()
		coveredTools := map[string]bool{}
		for _, b := range active {
			for _, name := range b.ActivatedTools {
				coveredTools[name] = true
			}
		}
		var uncapturedTools []string
		for _, m := range history[:keepFrom] {
			for _, name := range m.AddedToolNames {
				if !coveredTools[name] && !containsString(uncapturedTools, name) {
					uncapturedTools = append(uncapturedTools, name)
				}
			}
		}

		out := make([]provider.Message, 0, len(active)+len(latchedTail))
		for i, b := range active {
			isLast := i == len(active)-1
			var extra []string
			if isLast {
				extra = uncapturedTools
			}
			out = append(out, renderFoldBlockMessage(b, isLast, state.Count, extra))
		}
		out = append(out, latchedTail...)
		return out
	}

	// Legacy single-summary projection path.
	var activated []string
	for _, m := range history {
		for _, name := range m.AddedToolNames {
			if !containsString(activated, name) {
				activated = append(activated, name)
			}
		}
	}
	syn := provider.Message{
		Role:    provider.RoleUser,
		Time:    time.Now(),
		Content: []provider.Content{provider.TextBlock{Text: summaryMessageText(state.PreviousSummary)}},
		Meta: map[string]string{
			"compaction":            "true",
			"compaction_last_block": "true",
			"count":                 strconv.Itoa(state.Count),
		},
		AddedToolNames: activated,
	}
	out := make([]provider.Message, 0, 1+len(latchedTail))
	out = append(out, syn)
	out = append(out, latchedTail...)
	return out
}

// FileOps is the per-window file activity extracted for the summary.
type FileOps struct {
	Read     []string
	Modified []string
}

func contextTokens(system string, tools []provider.Tool, msgs []provider.Message) int {
	return provider.ContextTokens(system, tools, msgs)
}

func compactTargetTokens(window int, thresholdPct int) int {
	if thresholdPct > 0 && thresholdPct < 100 {
		target := window * thresholdPct / 100
		if headroom := window - target; headroom < CompactionReserveTokens {
			target = window - CompactionReserveTokens
		}
		if target < 1 {
			target = 1
		}
		return target
	}
	return window - CompactionReserveTokens
}

// ShouldCompact reports whether the session should auto-compact before the
// next model call: counted context vs window minus reserve.
func ShouldCompact(window int, countedContext int) bool {
	return ShouldCompactAt(window, countedContext, 0)
}

// ShouldCompactAt is ShouldCompact honoring a threshold percent.
func ShouldCompactAt(window int, countedContext int, thresholdPct int) bool {
	if window <= 0 {
		return false
	}
	return countedContext > compactTargetTokens(window, thresholdPct)
}

// SerializeConversation renders raw messages into a <conversation> XML-ish
// format for standalone/fallback summarization.
//
// Synthetic compaction FoldBlock messages are skipped so chained compactions
// never serialize prior summaries as raw turns. Long tool outputs pass through
// LogSelect first and then a generous 12KB head+tail UTF-8-safe budget.
func SerializeConversation(msgs []provider.Message) string {
	return serializeConversationWithBudget(msgs, serializeBlockBudgetBytes, serializeArgsBudgetBytes)
}

func serializeConversationWithBudget(msgs []provider.Message, blockMaxBytes, argsMaxBytes int) string {
	if blockMaxBytes <= 0 {
		blockMaxBytes = serializeBlockBudgetBytes
	}
	if argsMaxBytes <= 0 {
		argsMaxBytes = serializeArgsBudgetBytes
	}
	var sb strings.Builder
	sb.WriteString("<conversation>\n")
	for _, m := range msgs {
		if m.Meta != nil && m.Meta["compaction"] == "true" {
			continue
		}
		if m.Meta != nil && m.Meta["summary_checkpoint"] == "true" {
			note := strings.TrimSpace(m.Meta["for_me"])
			if note == "" {
				note = strings.TrimSpace(extractText(m))
			}
			if note != "" {
				sb.WriteString("<summary_checkpoint>\n")
				sb.WriteString(truncateHeadTail(note, blockMaxBytes))
				sb.WriteString("\n</summary_checkpoint>\n")
				continue
			}
		}
		switch m.Role {
		case provider.RoleUser:
			sb.WriteString("<user>\n")
			for _, c := range m.Content {
				switch b := c.(type) {
				case provider.TextBlock:
					sb.WriteString(truncateHeadTail(b.Text, blockMaxBytes))
					sb.WriteString("\n")
				case provider.ImageBlock:
					sb.WriteString("[image attached]\n")
				case provider.ToolResultBlock:
					sb.WriteString("[tool result: ")
					sb.WriteString(condenseToolOutputForSummary(toolResultText(b), blockMaxBytes))
					sb.WriteString("]\n")
				}
			}
			sb.WriteString("</user>\n")
		case provider.RoleAssistant:
			sb.WriteString("<assistant>\n")
			for _, c := range m.Content {
				switch b := c.(type) {
				case provider.TextBlock:
					sb.WriteString(truncateHeadTail(b.Text, blockMaxBytes))
					sb.WriteString("\n")
				case provider.ReasoningBlock:
					if b.Summary == "" {
						continue
					}
					sb.WriteString("[thinking: ")
					sb.WriteString(truncateHeadTail(b.Summary, argsMaxBytes))
					sb.WriteString("]\n")
				case provider.ToolCallBlock:
					sb.WriteString("[tool call: ")
					sb.WriteString(b.Name)
					sb.WriteString(" ")
					argBudget := argsMaxBytes
					if b.Name == summaryToolName {
						argBudget = blockMaxBytes
					}
					sb.WriteString(truncateHeadTail(string(b.Arguments), argBudget))
					sb.WriteString("]\n")
				case provider.ImageBlock:
					sb.WriteString("[image attached]\n")
				case provider.ToolResultBlock:
					sb.WriteString("[tool result: ")
					sb.WriteString(condenseToolOutputForSummary(toolResultText(b), blockMaxBytes))
					sb.WriteString("]\n")
				}
			}
			sb.WriteString("</assistant>\n")
		case provider.RoleTool:
			sb.WriteString("<tool_result>\n")
			for _, c := range m.Content {
				if tr, ok := c.(provider.ToolResultBlock); ok {
					sb.WriteString(condenseToolOutputForSummary(toolResultText(tr), blockMaxBytes))
					sb.WriteString("\n")
				} else if t, ok := c.(provider.TextBlock); ok {
					sb.WriteString(condenseToolOutputForSummary(t.Text, blockMaxBytes))
					sb.WriteString("\n")
				}
			}
			sb.WriteString("</tool_result>\n")
		}
	}
	sb.WriteString("</conversation>")
	return sb.String()
}

func condenseToolOutputForSummary(raw string, maxBytes int) string {
	if selected, ok := LogSelect(raw, 100); ok {
		raw = selected
	}
	return truncateHeadTail(raw, maxBytes)
}

func truncateHeadTail(s string, maxBytes int) string {
	if maxBytes <= 0 || len(s) <= maxBytes {
		return s
	}
	const marker = "\n...[middle truncated]...\n"
	if maxBytes <= len(marker)+32 {
		return truncateForSummary(s, maxBytes)
	}
	avail := maxBytes - len(marker)
	headBytes := avail * 6 / 10
	tailBytes := avail - headBytes
	head := truncateRunes(s, headBytes)
	tail := truncateRunesSuffix(s, tailBytes)
	return head + marker + tail
}

func truncateRunesSuffix(s string, maxBytes int) string {
	if len(s) <= maxBytes {
		return s
	}
	start := len(s) - maxBytes
	for start < len(s) && !utf8.RuneStart(s[start]) {
		start++
	}
	return s[start:]
}

func toolResultText(b provider.ToolResultBlock) string {
	var sb strings.Builder
	for _, c := range b.Content {
		if t, ok := c.(provider.TextBlock); ok {
			sb.WriteString(t.Text)
		}
	}
	return sb.String()
}

// truncateRunes cuts s to at most max bytes without splitting a multibyte rune.
func truncateRunes(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

func truncateForSummary(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return truncateRunes(s, max) + "...[truncated]"
}

// SummarizationSystemPrompt configures standalone/fallback summarization.
const SummarizationSystemPrompt = `You are a conversation summarizer. Your task is to create a structured summary of the conversation span that preserves all critical context needed to continue the work.

<instructions>
- Summarize the conversation: goals, constraints, key decisions, progress, and next steps.
- Preserve file paths, code changes, tool results, error messages, and user preferences.
- Be concise but complete. Use the structure below.
- Do NOT answer the user's questions or continue the task. Only summarize.
- Do NOT call any tools.
</instructions>

<format>
## Goal
What the user is trying to accomplish.

## Constraints
User preferences, technical constraints, things to avoid.

## Progress
What has been done so far, including files read/modified and key tool results.

## Decisions
Key decisions made and why.

## Next Steps
What remains to be done.

## Critical Context
Anything else needed to continue (error messages, partial results, user feedback).
</format>`

// InitialSummarizationPrompt builds the initial summarization prompt.
func InitialSummarizationPrompt(conversation string) string {
	return fmt.Sprintf(`Summarize the following conversation:

%s

Provide the summary using the required format.`, conversation)
}

// UpdateSummarizationPrompt builds the update summarization prompt.
func UpdateSummarizationPrompt(previous, conversation, fileOps string) string {
	var sb strings.Builder
	sb.WriteString("A previous summary exists. Update it with the new conversation below. ")
	sb.WriteString("Preserve still-relevant context, move completed items to Progress, ")
	sb.WriteString("and update Next Steps. Do not drop critical context that is still pending.\n\n")
	sb.WriteString("<previous_summary>\n")
	sb.WriteString(previous)
	sb.WriteString("\n</previous_summary>\n\n")
	if fileOps != "" {
		sb.WriteString("<file_operations>\n")
		sb.WriteString(fileOps)
		sb.WriteString("\n</file_operations>\n\n")
	}
	sb.WriteString("<new_conversation>\n")
	sb.WriteString(conversation)
	sb.WriteString("\n</new_conversation>\n\n")
	sb.WriteString("Provide the updated summary using the required format.")
	return sb.String()
}

func toolArgPath(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	var obj map[string]any
	if err := json.Unmarshal([]byte(trimmed), &obj); err != nil {
		return ""
	}
	for _, k := range []string{"path", "file_path", "file", "pattern"} {
		if v, ok := obj[k]; ok {
			if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
				return s
			}
		}
	}
	return ""
}

// FormatFileOperations renders read/modified file lists.
func FormatFileOperations(ops FileOps) string {
	var sb strings.Builder
	if len(ops.Read) > 0 {
		sb.WriteString("Files read:\n")
		for _, f := range ops.Read {
			sb.WriteString("- ")
			sb.WriteString(f)
			sb.WriteString("\n")
		}
	}
	if len(ops.Modified) > 0 {
		if sb.Len() > 0 {
			sb.WriteString("\n")
		}
		sb.WriteString("Files modified:\n")
		for _, f := range ops.Modified {
			sb.WriteString("- ")
			sb.WriteString(f)
			sb.WriteString("\n")
		}
	}
	return strings.TrimSpace(sb.String())
}

// ExtractFileOps scans a message window for file activity.
func ExtractFileOps(msgs []provider.Message) FileOps {
	var ops FileOps
	seenRead := map[string]bool{}
	seenMod := map[string]bool{}
	for _, m := range msgs {
		if m.Role != provider.RoleAssistant {
			continue
		}
		for _, c := range m.Content {
			tc, ok := c.(provider.ToolCallBlock)
			if !ok {
				continue
			}
			path := toolArgPath(string(tc.Arguments))
			if path == "" {
				continue
			}
			switch tc.Name {
			case "write", "edit", "patch":
				if !seenMod[path] {
					seenMod[path] = true
					ops.Modified = append(ops.Modified, path)
				}
			case "read", "glob", "search", "inspect":
				if !seenRead[path] {
					seenRead[path] = true
					ops.Read = append(ops.Read, path)
				}
			}
		}
	}
	return ops
}

// ExtractFileSpans extracts path:start-end spans from read/edit/write tool arguments.
func ExtractFileSpans(msgs []provider.Message) []string {
	seen := map[string]bool{}
	var spans []string
	addSpan := func(s string) {
		if s == "" || seen[s] || len(spans) >= 32 {
			return
		}
		seen[s] = true
		spans = append(spans, s)
	}
	for _, m := range msgs {
		if m.Role != provider.RoleAssistant {
			continue
		}
		for _, c := range m.Content {
			tc, ok := c.(provider.ToolCallBlock)
			if !ok {
				continue
			}
			var obj map[string]any
			if err := json.Unmarshal(tc.Arguments, &obj); err != nil {
				continue
			}
			path := ""
			for _, k := range []string{"path", "file_path", "file"} {
				if v, ok := obj[k].(string); ok && strings.TrimSpace(v) != "" {
					path = strings.TrimSpace(v)
					break
				}
			}
			if path == "" {
				continue
			}
			switch tc.Name {
			case "read":
				offset := jsonInt(obj, "offset", "start_line", "StartLine")
				limit := jsonInt(obj, "limit")
				endLine := jsonInt(obj, "end_line", "EndLine")
				if offset > 0 && endLine >= offset {
					addSpan(fmt.Sprintf("%s:%d-%d", path, offset, endLine))
				} else if offset > 0 && limit > 0 {
					addSpan(fmt.Sprintf("%s:%d-%d", path, offset, offset+limit-1))
				} else if limit > 0 {
					addSpan(fmt.Sprintf("%s:1-%d", path, limit))
				}
			case "edit", "patch", "write":
				addSpan(fmt.Sprintf("%s (%s)", path, tc.Name))
			}
		}
	}
	return spans
}

func jsonInt(obj map[string]any, keys ...string) int {
	for _, k := range keys {
		switch v := obj[k].(type) {
		case float64:
			return int(v)
		case int:
			return v
		}
	}
	return 0
}

var reExitCodeExtract = regexp.MustCompile(`(?i)(?:exit(?:\s+code|\s+status)?\s*:?\s*([1-9]\d*)|\[exit\s+([1-9]\d*)\])`)

// ExtractFailedCommands collects failed bash/exec_script invocations with exit
// codes and first diagnostic error lines for a FoldBlock's Tombstone header.
func ExtractFailedCommands(msgs []provider.Message) []FailedCommandSummary {
	type callMeta struct {
		name string
		cmd  string
	}
	calls := map[string]callMeta{}
	for _, m := range msgs {
		if m.Role != provider.RoleAssistant {
			continue
		}
		for _, c := range m.Content {
			tc, ok := c.(provider.ToolCallBlock)
			if !ok || (tc.Name != "bash" && tc.Name != "exec_script") {
				continue
			}
			var obj map[string]any
			cmd := ""
			if err := json.Unmarshal(tc.Arguments, &obj); err == nil {
				for _, k := range []string{"command", "cmd", "script"} {
					if s, ok := obj[k].(string); ok && strings.TrimSpace(s) != "" {
						cmd = strings.TrimSpace(s)
						break
					}
				}
			}
			if cmd == "" {
				cmd = strings.TrimSpace(string(tc.Arguments))
			}
			cmd = strings.Join(strings.Fields(cmd), " ")
			cmd = truncateRunes(cmd, 120)
			calls[tc.ID] = callMeta{name: tc.Name, cmd: cmd}
		}
	}
	if len(calls) == 0 {
		return nil
	}

	seen := map[string]bool{}
	var out []FailedCommandSummary
	for _, m := range msgs {
		if m.Role != provider.RoleTool {
			continue
		}
		for _, c := range m.Content {
			tr, ok := c.(provider.ToolResultBlock)
			if !ok {
				continue
			}
			cm, known := calls[tr.CallID]
			if !known {
				continue
			}
			fullText := strings.TrimSpace(toolResultText(tr))
			raw := fullText
			exitCode := ""
			isEnvErr := false
			if env, envOK := ParseToolEnvelope(fullText); envOK {
				raw = strings.TrimSpace(env.Body)
				if ec := strings.TrimSpace(env.Attrs["exit"]); ec != "" && ec != "0" {
					exitCode = ec
				}
				if env.Type == "error" {
					isEnvErr = true
				}
			} else {
				raw = stripToolResultEnvelope(fullText)
			}
			if exitCode == "" {
				if sub := reExitCodeExtract.FindStringSubmatch(raw); len(sub) >= 3 {
					if sub[1] != "" {
						exitCode = sub[1]
					} else {
						exitCode = sub[2]
					}
				}
			}
			if !tr.IsError && !isEnvErr && exitCode == "" {
				continue
			}
			if exitCode == "" && (tr.IsError || isEnvErr) {
				exitCode = "error"
			}
			firstErr := extractFirstErrorLine(raw)
			entry := FailedCommandSummary{
				Command:    cm.cmd,
				ExitCode:   exitCode,
				FirstError: firstErr,
			}
			key := entry.Command + "|" + entry.ExitCode + "|" + entry.FirstError
			if !seen[key] && len(out) < 12 {
				seen[key] = true
				out = append(out, entry)
			}
		}
	}
	return out
}

func stripToolResultEnvelope(s string) string {
	trimmed := strings.TrimSpace(s)
	if strings.HasPrefix(trimmed, "<tool_result") {
		if nl := strings.IndexByte(trimmed, '>'); nl >= 0 {
			trimmed = trimmed[nl+1:]
		}
		trimmed = strings.TrimSuffix(strings.TrimSpace(trimmed), "</tool_result>")
	}
	return strings.TrimSpace(trimmed)
}

func extractFirstErrorLine(raw string) string {
	if raw == "" {
		return ""
	}
	lines := strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n")
	for _, l := range lines {
		t := strings.TrimSpace(l)
		if t == "" {
			continue
		}
		if isLogErrorLine(t) && !reNonZeroExit.MatchString(t) {
			return truncateRunes(t, 160)
		}
	}
	for _, l := range lines {
		t := strings.TrimSpace(l)
		if t != "" && !reNonZeroExit.MatchString(t) {
			return truncateRunes(t, 160)
		}
	}
	return ""
}

// ExtractSummaryCheckpoints harvests model-authored progress checkpoints from
// both Meta["summary_checkpoint"]=="true" messages and non-errored summary
// tool calls (the private for_me field).
func ExtractSummaryCheckpoints(msgs []provider.Message) []string {
	errCalls := map[string]bool{}
	for _, m := range msgs {
		if m.Role != provider.RoleTool {
			continue
		}
		for _, c := range m.Content {
			if tr, ok := c.(provider.ToolResultBlock); ok && tr.IsError {
				errCalls[tr.CallID] = true
			}
		}
	}

	seen := map[string]bool{}
	var notes []string
	add := func(s string) {
		s = strings.TrimSpace(s)
		if s == "" || seen[s] {
			return
		}
		seen[s] = true
		notes = append(notes, truncateRunes(s, 1024))
	}

	for _, m := range msgs {
		if m.Meta != nil && m.Meta["summary_checkpoint"] == "true" {
			if fm := strings.TrimSpace(m.Meta["for_me"]); fm != "" {
				add(fm)
			} else {
				add(extractText(m))
			}
		}
		if m.Role == provider.RoleAssistant {
			for _, c := range m.Content {
				tc, ok := c.(provider.ToolCallBlock)
				if !ok || tc.Name != summaryToolName || errCalls[tc.ID] {
					continue
				}
				var obj struct {
					ForMe string `json:"for_me"`
				}
				if err := json.Unmarshal(tc.Arguments, &obj); err == nil && obj.ForMe != "" {
					add(obj.ForMe)
				}
			}
		}
	}
	return notes
}

func collectActivatedTools(msgs []provider.Message) []string {
	var out []string
	for _, m := range msgs {
		for _, name := range m.AddedToolNames {
			if !containsString(out, name) {
				out = append(out, name)
			}
		}
	}
	return out
}

func unionFailedCommands(existing, added []FailedCommandSummary) []FailedCommandSummary {
	seen := map[string]bool{}
	out := make([]FailedCommandSummary, 0, len(existing)+len(added))
	for _, list := range [][]FailedCommandSummary{existing, added} {
		for _, fc := range list {
			key := fc.Command + "|" + fc.ExitCode + "|" + fc.FirstError
			if !seen[key] {
				seen[key] = true
				out = append(out, fc)
			}
		}
	}
	return out
}

// MechanicalBlockSummary builds a deterministic, zero-LLM fallback summary for
// msgs covering [startIdx, endIdx). Used whenever the LLM summarizer errors,
// attempts a tool call, truncates repeatedly, or exceeds NET_SHRINK_TOLERANCE.
func MechanicalBlockSummary(msgs []provider.Message, startIdx, endIdx int) string {
	var userPrompts []string
	var lastAssistant string
	toolCounts := map[string]int{}
	var toolOrder []string

	for _, m := range msgs {
		if m.Meta != nil && m.Meta["compaction"] == "true" {
			continue
		}
		switch m.Role {
		case provider.RoleUser:
			if m.Meta != nil && m.Meta[MetaHidden] == "true" {
				continue
			}
			txt := strings.TrimSpace(StripLeadingSystemPrompt(extractText(m)))
			if txt == "" || strings.HasPrefix(txt, "<system-warn>") {
				continue
			}
			if len(userPrompts) < 5 {
				userPrompts = append(userPrompts, truncateRunes(strings.Join(strings.Fields(txt), " "), 240))
			}
		case provider.RoleAssistant:
			if txt := strings.TrimSpace(extractText(m)); txt != "" {
				lastAssistant = truncateRunes(strings.Join(strings.Fields(txt), " "), 280)
			}
			for _, c := range m.Content {
				if tc, ok := c.(provider.ToolCallBlock); ok {
					if toolCounts[tc.Name] == 0 {
						toolOrder = append(toolOrder, tc.Name)
					}
					toolCounts[tc.Name]++
				}
			}
		}
	}

	ops := ExtractFileOps(msgs)
	failed := ExtractFailedCommands(msgs)
	checkpoints := ExtractSummaryCheckpoints(msgs)

	var sb strings.Builder
	sb.WriteString("## Goal\n")
	if len(userPrompts) > 0 {
		for _, p := range userPrompts {
			sb.WriteString("- ")
			sb.WriteString(p)
			sb.WriteString("\n")
		}
	} else {
		sb.WriteString(fmt.Sprintf("- Compacted raw transcript span #%d–#%d (%d messages).\n", startIdx, max(startIdx, endIdx-1), len(msgs)))
	}

	sb.WriteString("\n## Progress\n")
	if len(checkpoints) > 0 {
		for i, cp := range checkpoints {
			if i >= 4 {
				break
			}
			sb.WriteString("- Checkpoint: ")
			sb.WriteString(truncateRunes(strings.Join(strings.Fields(cp), " "), 300))
			sb.WriteString("\n")
		}
	}
	if len(toolOrder) > 0 {
		parts := make([]string, 0, len(toolOrder))
		for _, name := range toolOrder {
			parts = append(parts, fmt.Sprintf("%s (%d)", name, toolCounts[name]))
		}
		sb.WriteString("- Executed tools: ")
		sb.WriteString(strings.Join(parts, ", "))
		sb.WriteString("\n")
	}
	if len(ops.Modified) > 0 || len(ops.Read) > 0 {
		sb.WriteString(fmt.Sprintf("- Touched %d modified file(s) and %d read file(s).\n", len(ops.Modified), len(ops.Read)))
	}
	if len(checkpoints) == 0 && len(toolOrder) == 0 && len(ops.Modified) == 0 && len(ops.Read) == 0 {
		sb.WriteString(fmt.Sprintf("- Processed %d conversation turns.\n", len(msgs)))
	}

	if len(failed) > 0 || lastAssistant != "" {
		sb.WriteString("\n## Critical Context\n")
		for _, fc := range failed {
			sb.WriteString(fmt.Sprintf("- Failed command `%s` (exit %s)", fc.Command, fc.ExitCode))
			if fc.FirstError != "" {
				sb.WriteString(": ")
				sb.WriteString(fc.FirstError)
			}
			sb.WriteString("\n")
		}
		if lastAssistant != "" {
			sb.WriteString("- Last assistant state: ")
			sb.WriteString(lastAssistant)
			sb.WriteString("\n")
		}
	}

	return strings.TrimSpace(sb.String())
}

// MergeFileOps unions old and new file lists, deduplicated, order-stable.
func MergeFileOps(old []string, add []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(old)+len(add))
	for _, f := range old {
		if !seen[f] {
			seen[f] = true
			out = append(out, f)
		}
	}
	for _, f := range add {
		if !seen[f] {
			seen[f] = true
			out = append(out, f)
		}
	}
	return out
}

// CutPoint is the result of FindCutPoint.
type CutPoint struct {
	Index          int
	SplitTurn      bool
	TurnStartIndex int
}

func findTurnStartIndex(msgs []provider.Message, cutIndex int) int {
	for i := cutIndex - 1; i >= 0; i-- {
		if isUserBoundary(msgs[i]) {
			return i
		}
	}
	return -1
}

// FindCutPoint walks back from the end keeping at least keepRecent tokens
// and never cutting in the middle of a tool result sequence.
func FindCutPoint(msgs []provider.Message, keepRecent int) CutPoint {
	_, perMsg := provider.ContextTokensByMessage("", nil, msgs)
	return FindCutPointMsgs(msgs, keepRecent, perMsg)
}

// FindCutPointMsgs is FindCutPoint with a caller-supplied per-message breakdown.
func FindCutPointMsgs(msgs []provider.Message, keepRecent int, perMsg []int) CutPoint {
	if len(msgs) == 0 {
		return CutPoint{Index: 0, TurnStartIndex: -1}
	}
	acc := 0
	idx := len(msgs)
	for idx > 0 && acc < keepRecent {
		idx--
		n := 0
		if idx < len(perMsg) {
			n = perMsg[idx]
		}
		if n <= 0 {
			n = provider.ContextTokens("", nil, msgs[idx:idx+1])
		}
		acc += n
	}
	if idx <= 0 {
		return CutPoint{Index: 0, TurnStartIndex: -1}
	}
	if idx >= len(msgs) {
		idx = len(msgs) - 1
	}
	walkIdx := idx
	for idx > 0 && idx < len(msgs) && isToolCallTail(msgs[idx-1]) && isToolResultHead(msgs[idx]) {
		idx++
	}
	if idx >= len(msgs) {
		idx = len(msgs) - 1
	}
	for idx > 0 && isToolResultHead(msgs[idx]) && !ownsToolCall(msgs, idx) {
		idx--
	}
	if idx < 0 {
		idx = 0
	}
	if idx >= len(msgs) {
		idx = len(msgs) - 1
	}

	cut := CutPoint{TurnStartIndex: -1}
	if isUserBoundary(msgs[idx]) {
		cut.Index = idx
	} else if turnStart := findTurnStartIndex(msgs, idx); turnStart >= 0 {
		cut.Index, cut.SplitTurn, cut.TurnStartIndex = idx, true, turnStart
	} else {
		cut.Index = snapCutToUserBoundary(msgs, idx)
	}
	if cut.Index <= 0 && walkIdx > 0 {
		cut = CutPoint{Index: oldestGroupStartAt(msgs, walkIdx), SplitTurn: false, TurnStartIndex: -1}
	}
	return cut
}

func oldestGroupStartAt(msgs []provider.Message, idx int) int {
	for j := idx; j < len(msgs); j++ {
		if j > 0 && isToolResultHead(msgs[j]) && (isToolCallTail(msgs[j-1]) || isToolResultHead(msgs[j-1])) {
			continue
		}
		return j
	}
	return idx
}

func snapCutToUserBoundary(msgs []provider.Message, idx int) int {
	if idx <= 0 || idx >= len(msgs) {
		return idx
	}
	if isUserBoundary(msgs[idx]) {
		return idx
	}
	for i := idx; i < len(msgs); i++ {
		if isUserBoundary(msgs[i]) {
			return i
		}
	}
	return idx
}

func isUserBoundary(m provider.Message) bool {
	if m.Role != provider.RoleUser {
		return false
	}
	if m.Meta != nil && (m.Meta[MetaHidden] == "true" || m.Meta[MetaEphemeral] == "true" || m.Meta["compaction"] == "true") {
		return false
	}
	return true
}

func isToolCallTail(m provider.Message) bool {
	if m.Role != provider.RoleAssistant {
		return false
	}
	for _, c := range m.Content {
		if _, ok := c.(provider.ToolCallBlock); ok {
			return true
		}
	}
	return false
}

func isToolResultHead(m provider.Message) bool {
	if m.Role == provider.RoleTool {
		return true
	}
	if m.Role == provider.RoleAssistant {
		for _, c := range m.Content {
			if _, ok := c.(provider.ToolResultBlock); ok {
				return true
			}
		}
	}
	return false
}

func ownsToolCall(msgs []provider.Message, idx int) bool {
	for i := idx - 1; i >= 0 && i >= idx-3; i-- {
		if isToolCallTail(msgs[i]) {
			return true
		}
		if msgs[i].Role == provider.RoleUser {
			break
		}
	}
	return false
}

const TurnPrefixSummarizationPromptTemplate = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`

// TurnPrefixSummarizationPrompt formats the prompt for the split-turn prefix.
func TurnPrefixSummarizationPrompt(conversation string) string {
	return fmt.Sprintf("<conversation>\n%s\n</conversation>\n\n%s", conversation, TurnPrefixSummarizationPromptTemplate)
}

// CompactionPlan is the output of PrepareCompaction.
type CompactionPlan struct {
	Summarize        []provider.Message
	TurnPrefix       []provider.Message
	KeepFrom         int
	TurnStartIndex   int
	SplitTurn        bool
	Prompt           string
	TurnPrefixPrompt string
	FileOpsNote      string
	WindowOps        FileOps
	Incremental      bool
}

// PrepareCompaction prepares a standalone compaction plan over msgs.
func PrepareCompaction(msgs []provider.Message, state *CompactionState, keepRecent int) *CompactionPlan {
	if keepRecent <= 0 {
		keepRecent = CompactionKeepRecentTokens
	}
	cut := FindCutPoint(msgs, keepRecent)
	keepFrom := cut.Index
	if keepFrom < 0 {
		keepFrom = 0
	}
	if keepFrom > len(msgs) {
		keepFrom = len(msgs)
	}

	historyEnd := keepFrom
	if cut.SplitTurn && cut.TurnStartIndex >= 0 && cut.TurnStartIndex < keepFrom {
		historyEnd = cut.TurnStartIndex
	}

	summarizeWindow := filterOutSyntheticCompaction(msgs[:historyEnd])
	var turnPrefixWindow []provider.Message
	if cut.SplitTurn && cut.TurnStartIndex >= 0 && cut.TurnStartIndex < keepFrom {
		turnPrefixWindow = filterOutSyntheticCompaction(msgs[cut.TurnStartIndex:keepFrom])
	}

	allSummarized := filterOutSyntheticCompaction(msgs[:keepFrom])
	ops := ExtractFileOps(allSummarized)

	plan := &CompactionPlan{
		Summarize:      summarizeWindow,
		TurnPrefix:     turnPrefixWindow,
		KeepFrom:       keepFrom,
		TurnStartIndex: cut.TurnStartIndex,
		SplitTurn:      cut.SplitTurn && len(turnPrefixWindow) > 0,
		WindowOps:      ops,
		FileOpsNote:    FormatFileOperations(ops),
	}

	if len(summarizeWindow) > 0 {
		conversation := SerializeConversation(summarizeWindow)
		if state != nil && state.PreviousSummary != "" {
			plan.Incremental = true
			merged := FileOps{
				Read:     MergeFileOps(state.ReadFiles, ops.Read),
				Modified: MergeFileOps(state.ModifiedFiles, ops.Modified),
			}
			plan.FileOpsNote = FormatFileOperations(merged)
			plan.Prompt = UpdateSummarizationPrompt(state.PreviousSummary, conversation, plan.FileOpsNote)
		} else {
			plan.Prompt = InitialSummarizationPrompt(conversation)
		}
	} else if state != nil && state.PreviousSummary != "" {
		plan.Incremental = true
		merged := FileOps{
			Read:     MergeFileOps(state.ReadFiles, ops.Read),
			Modified: MergeFileOps(state.ModifiedFiles, ops.Modified),
		}
		plan.FileOpsNote = FormatFileOperations(merged)
	}

	if plan.SplitTurn && len(turnPrefixWindow) > 0 {
		prefixConv := SerializeConversation(turnPrefixWindow)
		plan.TurnPrefixPrompt = TurnPrefixSummarizationPrompt(prefixConv)
	}

	return plan
}

func filterOutSyntheticCompaction(msgs []provider.Message) []provider.Message {
	if len(msgs) == 0 {
		return nil
	}
	out := make([]provider.Message, 0, len(msgs))
	for _, m := range msgs {
		if m.Meta != nil && m.Meta["compaction"] == "true" {
			continue
		}
		out = append(out, m)
	}
	return out
}
