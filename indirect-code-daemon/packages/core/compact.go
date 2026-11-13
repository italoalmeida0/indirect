package core

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"strings"
	"time"

	"indirect/indirect-code-daemon/packages/provider"
)

func copyVisionStateInto(dst, src *CompactionState, maxLen int) {
	if dst == nil || src == nil {
		return
	}
	if len(src.ImageDigests) > 0 {
		dst.ImageDigests = maps.Clone(src.ImageDigests)
	}
	if len(src.EvictedImages) > 0 {
		dst.EvictedImages = pruneEvictedImagesAbove(src.EvictedImages, maxLen)
	}
	if src.LearnedMaxImages != nil {
		v := *src.LearnedMaxImages
		dst.LearnedMaxImages = &v
	}
}

var errSummarizerToolCall = errors.New("summarizer attempted a tool call")

type compactOptions struct {
	keepTail         int
	keepRecentTokens int
	forceCut         bool
}

// Compact summarizes older raw transcript spans into append-only FoldBlocks
// and advances the compaction chain head without mutating a.messages.
//
// keepTail, when > 0, specifies an explicit tail message count to retain
// (manual /compact and unit tests). When keepTail <= 0, the hybrid keep floor
// (20K..40K tokens) selects the retained suffix.
func (a *Agent) Compact(ctx context.Context, keepTail int, sink func(delta string)) (string, error) {
	return a.compactWithOptions(ctx, compactOptions{
		keepTail: keepTail,
		forceCut: keepTail > 0,
	}, sink)
}

// CompactToTokenBudget compacts the transcript so the retained raw tail stays
// near keepRecentTokens, slicing folded history into ~45K-token immutable
// Tier-1 FoldBlocks and running Tier-2 rollups when needed.
func (a *Agent) CompactToTokenBudget(ctx context.Context, keepRecentTokens int, onProgress func(string)) (string, error) {
	if keepRecentTokens <= 0 {
		keepRecentTokens = CompactionKeepRecentTokens
	}
	return a.compactWithOptions(ctx, compactOptions{
		keepRecentTokens: keepRecentTokens,
		forceCut:         true,
	}, onProgress)
}

func (a *Agent) compactWithOptions(ctx context.Context, opts compactOptions, sink func(delta string)) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}

	a.mu.Lock()
	history := append([]provider.Message(nil), a.messages...)
	baseMsgIdx := a.baseMsgIdx
	prevState := a.compactionStateLocked()
	window := a.contextWindow
	system := a.System
	toolSpecs := a.Tools.Specs()
	a.mu.Unlock()

	if len(history) == 0 {
		return "", fmt.Errorf("nothing to compact")
	}
	if baseMsgIdx < 0 {
		baseMsgIdx = 0
	}
	totalLen := baseMsgIdx + len(history)

	projected := projectMessagesAt(history, baseMsgIdx, prevState)
	if len(projected) < CompactionMinMessages && !opts.forceCut {
		return "", fmt.Errorf("nothing to compact: transcript below minimum (%d messages)", CompactionMinMessages)
	}

	workingState := &CompactionState{}
	carryOverSummary := ""
	if prevState != nil {
		workingState = prevState.Clone()
		if len(workingState.Blocks) == 0 {
			synthetic, legacyKeepFrom := projectionAnchorAt(workingState, baseMsgIdx, len(history))
			if synthetic && legacyKeepFrom > baseMsgIdx {
				localKeep := legacyKeepFrom - baseMsgIdx
				rawSpan := history[:localKeep]
				ops := ExtractFileOps(rawSpan)
				ops.Read = MergeFileOps(workingState.ReadFiles, ops.Read)
				ops.Modified = MergeFileOps(workingState.ModifiedFiles, ops.Modified)
				legacyBlock := FoldBlock{
					ID:             workingState.allocBlockID(),
					Tier:           1,
					StartIdx:       baseMsgIdx,
					EndIdx:         legacyKeepFrom,
					Topic:          deriveBlockTopic(rawSpan, workingState.PreviousSummary),
					Summary:        strings.TrimSpace(workingState.PreviousSummary),
					ReadFiles:      ops.Read,
					ModifiedFiles:  ops.Modified,
					FileSpans:      ExtractFileSpans(rawSpan),
					ActivatedTools: collectActivatedTools(rawSpan),
					FailedCommands: ExtractFailedCommands(rawSpan),
					RawTokens:      provider.ContextTokens("", nil, rawSpan),
					CreatedAt:      time.Now().UnixMilli(),
				}
				legacyBlock.BlockTokens = estimateFoldBlockTokens(legacyBlock)
				workingState.Blocks = append(workingState.Blocks, legacyBlock)
				workingState.SyncMirrors()
			} else if legacyKeepFrom == baseMsgIdx && strings.TrimSpace(workingState.PreviousSummary) != "" {
				carryOverSummary = strings.TrimSpace(workingState.PreviousSummary)
			} else if !synthetic {
				// No compacted prefix yet (or corrupt legacy anchor): preserve any
				// cached visual digests, evicted wire latches, and learned image caps.
				workingState = &CompactionState{}
				copyVisionStateInto(workingState, prevState, totalLen)
			}
		} else if ok, _ := projectionAnchorAt(workingState, baseMsgIdx, len(history)); !ok {
			workingState = TruncateCompaction(workingState, totalLen)
			if workingState == nil {
				workingState = &CompactionState{}
				copyVisionStateInto(workingState, prevState, totalLen)
			}
		}
	}

	globalStart := baseMsgIdx
	if len(workingState.Blocks) > 0 {
		if ok, kf := projectionAnchorAt(workingState, baseMsgIdx, len(history)); ok {
			globalStart = kf
		}
	}
	localStart := globalStart - baseMsgIdx
	if localStart < 0 {
		localStart = 0
		globalStart = baseMsgIdx
	}
	if localStart >= len(history) {
		return "", fmt.Errorf("nothing to compact: keep-tail covers the whole transcript")
	}

	unfolded := history[localStart:]
	latchedUnfolded := ApplyViewLatchTail(unfolded, globalStart, workingState.PrunedBefore)

	localCut := 0
	if opts.keepTail > 0 {
		localCut = len(unfolded) - opts.keepTail
		if localCut <= 0 {
			localCut = len(unfolded) / 2
			if localCut <= 0 && len(unfolded) >= 2 {
				localCut = 1
			}
		}
		localCut = adjustPairSafeLocalCut(unfolded, localCut)
	} else {
		keepTokens := opts.keepRecentTokens
		if keepTokens <= 0 {
			keepTokens = hybridKeepFloor(projected)
		}
		_, perMsg := provider.ContextTokensByMessage(system, toolSpecs, latchedUnfolded)
		localCut = FindCutPointMsgs(latchedUnfolded, keepTokens, perMsg).Index
		if localCut <= 0 {
			if opts.forceCut && len(unfolded) >= 2 {
				localCut = adjustPairSafeLocalCut(unfolded, max(1, len(unfolded)/2))
			} else {
				return "", fmt.Errorf("nothing to compact: transcript fits under the keep floor")
			}
		}
	}

	if localCut <= 0 {
		return "", fmt.Errorf("nothing to compact: transcript fits under the keep floor")
	}
	localCutIdx := localStart + localCut
	if localCutIdx > len(history) {
		localCutIdx = len(history)
	}
	if localCutIdx >= len(history) {
		return "", fmt.Errorf("nothing to compact: keep-tail covers the whole transcript")
	}
	globalCutIdx := baseMsgIdx + localCutIdx

	spans := sliceFoldSpans(history, localStart, localCutIdx, FoldBlockTargetTokens)
	if len(spans) == 0 {
		return "", fmt.Errorf("nothing to compact")
	}

	// Ensure visual digests exist for any ImageBlocks being folded into FoldBlocks.
	a.ensureSpanImageDigestsAt(ctx, history, baseMsgIdx, localStart, localCutIdx, workingState)

	var totalUsage provider.Usage
	for spanIdx, sp := range spans {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		localCStart, localCEnd := sp[0], sp[1]
		globalCStart, globalCEnd := baseMsgIdx+localCStart, baseMsgIdx+localCEnd
		isFinalSpan := spanIdx == len(spans)-1
		carry := ""
		if spanIdx == 0 {
			carry = carryOverSummary
		}

		blockSummary, spanUsage, err := a.summarizeSpan(ctx, history, baseMsgIdx, localCStart, localCEnd, localCutIdx, isFinalSpan, carry, workingState.ImageDigests, sink)
		if err != nil {
			return "", err
		}
		totalUsage = totalUsage.Add(spanUsage)

		chunk := history[localCStart:localCEnd]
		ops := ExtractFileOps(chunk)
		if spanIdx == 0 && carry != "" && prevState != nil {
			ops.Read = MergeFileOps(prevState.ReadFiles, ops.Read)
			ops.Modified = MergeFileOps(prevState.ModifiedFiles, ops.Modified)
		}
		rawToks := provider.ContextTokens("", nil, chunk)
		blk := FoldBlock{
			ID:             workingState.allocBlockID(),
			Tier:           1,
			StartIdx:       globalCStart,
			EndIdx:         globalCEnd,
			Topic:          deriveBlockTopic(chunk, blockSummary),
			Summary:        blockSummary,
			ReadFiles:      ops.Read,
			ModifiedFiles:  ops.Modified,
			FileSpans:      ExtractFileSpans(chunk),
			ActivatedTools: collectActivatedTools(chunk),
			FailedCommands: ExtractFailedCommands(chunk),
			RawTokens:      rawToks,
			CreatedAt:      time.Now().UnixMilli(),
		}
		blk.BlockTokens = estimateFoldBlockTokens(blk)

		// Enforce NET_SHRINK_TOLERANCE: if the model regurgitated content past
		// the allowed token budget, fall back deterministically to MechanicalBlockSummary.
		if exceedsShrinkBudget(rawToks, blk.BlockTokens) {
			mech := MechanicalBlockSummaryWithDigests(chunk, globalCStart, globalCEnd, workingState.ImageDigests)
			if carry != "" && !strings.Contains(mech, carry) {
				mech = carry + "\n\n---\n\n" + mech
			}
			blk.Summary = mech
			blk.Topic = deriveBlockTopic(chunk, mech)
			blk.BlockTokens = estimateFoldBlockTokens(blk)
		}

		workingState.Blocks = append(workingState.Blocks, blk)
	}

	// Run Tier-2 merge rollup when active block count > 8 or active block
	// tokens exceed 15% of the model context window.
	mergeUsage, err := a.maybeMergeTier2Blocks(ctx, workingState, window, sink)
	if err != nil {
		return "", err
	}
	totalUsage = totalUsage.Add(mergeUsage)

	prevCount := 0
	prevPrunedBefore := 0
	if prevState != nil {
		prevCount = prevState.Count
		prevPrunedBefore = prevState.PrunedBefore
	}
	workingState.Count = prevCount + 1

	protectBudget := PruneProtectTokens
	if opts.keepRecentTokens > 0 && opts.keepRecentTokens < protectBudget {
		protectBudget = opts.keepRecentTokens
	}
	workingState.PrunedBefore = max(prevPrunedBefore, ComputeLatchWatermarkAt(history, baseMsgIdx, globalCutIdx, protectBudget))
	workingState.SyncMirrors()
	hasUsage := totalUsage.InputTokens > 0 || totalUsage.OutputTokens > 0 ||
		totalUsage.CacheReadTokens > 0 || totalUsage.CacheWriteTokens > 0
	if hasUsage {
		workingState.Usage = &totalUsage
	}

	a.mu.Lock()
	a.setCompactionStateLocked(workingState)
	a.rev++
	onState := a.OnCompactionState
	var (
		cum     provider.Usage
		onUsage func(provider.Usage)
	)
	if hasUsage {
		cum = a.cost.Add(totalUsage)
		onUsage = a.OnUsage
	}
	a.mu.Unlock()

	if hasUsage && onUsage != nil {
		onUsage(cum)
	}

	if onState != nil {
		onState(a.CompactionChain())
	}

	return workingState.PreviousSummary, nil
}

func adjustPairSafeLocalCut(unfolded []provider.Message, localCut int) int {
	if localCut <= 0 || localCut >= len(unfolded) {
		return localCut
	}
	orig := localCut
	for localCut > 0 && isToolResultHead(unfolded[localCut]) && !ownsToolCall(unfolded[localCut:], 0) {
		localCut--
	}
	if localCut > 0 {
		return localCut
	}
	for j := orig; j < len(unfolded); j++ {
		if !isToolResultHead(unfolded[j]) {
			return j
		}
	}
	return orig
}

// sliceFoldSpans partitions history[rawStart:rawCutIdx] into contiguous
// ~targetTokens Tier-1 spans along pair-safe (and preferably user-turn)
// boundaries without splitting tool_use/tool_result pairs.
func sliceFoldSpans(history []provider.Message, rawStart, rawCutIdx, targetTokens int) [][2]int {
	if rawCutIdx <= rawStart {
		return nil
	}
	if targetTokens <= 0 {
		targetTokens = FoldBlockTargetTokens
	}
	spanMsgs := history[rawStart:rawCutIdx]
	_, perMsg := provider.ContextTokensByMessage("", nil, spanMsgs)

	prefixSum := make([]int, len(spanMsgs)+1)
	for i := range spanMsgs {
		t := 0
		if i < len(perMsg) {
			t = perMsg[i]
		}
		if t <= 0 {
			t = provider.ContextTokens("", nil, spanMsgs[i:i+1])
		}
		if t <= 0 {
			t = 1
		}
		prefixSum[i+1] = prefixSum[i] + t
	}
	rangeToks := func(a, b int) int {
		if b <= a {
			return 0
		}
		return prefixSum[b] - prefixSum[a]
	}

	var out [][2]int
	pos := 0
	for pos < len(spanMsgs) {
		if rangeToks(pos, len(spanMsgs)) <= targetTokens {
			out = append(out, [2]int{rawStart + pos, rawCutIdx})
			break
		}

		end := pos + 1
		for end < len(spanMsgs) && rangeToks(pos, end+1) <= targetTokens {
			end++
		}

		// Never split an assistant tool call from its immediately following tool results.
		for end < len(spanMsgs) && isToolResultHead(spanMsgs[end]) {
			end++
		}

		if end < len(spanMsgs) && !isUserBoundary(spanMsgs[end]) {
			snapped := -1
			for u := end; u > pos; u-- {
				if isUserBoundary(spanMsgs[u]) && rangeToks(pos, u) >= targetTokens/2 {
					snapped = u
					break
				}
			}
			if snapped < 0 {
				for u := end + 1; u < len(spanMsgs); u++ {
					if rangeToks(end, u) > targetTokens/3 {
						break
					}
					if isUserBoundary(spanMsgs[u]) {
						snapped = u
						break
					}
				}
			}
			if snapped > pos {
				end = snapped
			}
		}

		// Avoid leaving a tiny trailing sliver when absorbing it stays reasonable.
		if end < len(spanMsgs) && rangeToks(end, len(spanMsgs)) < targetTokens/4 && rangeToks(pos, len(spanMsgs)) <= targetTokens*3/2 {
			end = len(spanMsgs)
		}

		out = append(out, [2]int{rawStart + pos, rawStart + end})
		pos = end
	}
	return out
}

func (a *Agent) summarizeSpan(
	ctx context.Context,
	history []provider.Message,
	baseMsgIdx int,
	localCStart, localCEnd, localCutIdx int,
	isFinalSpan bool,
	carryOverSummary string,
	digests map[string]string,
	sink func(delta string),
) (string, provider.Usage, error) {
	var totalUsage provider.Usage
	chunk := history[localCStart:localCEnd]
	globalCStart := baseMsgIdx + localCStart
	globalCEnd := baseMsgIdx + localCEnd

	// Check whether this final span splits an active user turn at localCutIdx.
	if isFinalSpan && localCutIdx < len(history) && !isUserBoundary(history[localCutIdx]) {
		turnStart := findTurnStartIndex(history, localCutIdx)
		if turnStart > localCStart && turnStart < localCEnd {
			globalTurnStart := baseMsgIdx + turnStart
			histChunk := history[localCStart:turnStart]
			histSummary, u1, err := a.summarizeChunkWithFallback(ctx, histChunk, globalCStart, globalTurnStart, false, carryOverSummary, digests, sink)
			if err != nil {
				return "", totalUsage, err
			}
			totalUsage = totalUsage.Add(u1)

			prefixChunk := history[turnStart:localCEnd]
			prefixSummary, u2, err := a.summarizeChunkWithFallback(ctx, prefixChunk, globalTurnStart, globalCEnd, true, "", digests, sink)
			if err != nil {
				return "", totalUsage, err
			}
			totalUsage = totalUsage.Add(u2)
			combined := fmt.Sprintf("%s\n\n---\n\n**Turn Context (split turn):**\n\n%s", strings.TrimSpace(histSummary), strings.TrimSpace(prefixSummary))
			return combined, totalUsage, nil
		}
		if turnStart < localCStart && carryOverSummary != "" {
			prefixSummary, u2, err := a.summarizeChunkWithFallback(ctx, chunk, globalCStart, globalCEnd, true, "", digests, sink)
			if err != nil {
				return "", totalUsage, err
			}
			totalUsage = totalUsage.Add(u2)
			combined := fmt.Sprintf("%s\n\n---\n\n**Turn Context (split turn):**\n\n%s", carryOverSummary, strings.TrimSpace(prefixSummary))
			return combined, totalUsage, nil
		}
		if turnStart >= 0 && turnStart < localCStart {
			prefixSummary, u2, err := a.summarizeChunkWithFallback(ctx, chunk, globalCStart, globalCEnd, true, "", digests, sink)
			if err != nil {
				return "", totalUsage, err
			}
			totalUsage = totalUsage.Add(u2)
			return "**Turn Context (split turn):**\n\n" + strings.TrimSpace(prefixSummary), totalUsage, nil
		}
	}

	summary, u, err := a.summarizeChunkWithFallback(ctx, chunk, globalCStart, globalCEnd, false, carryOverSummary, digests, sink)
	totalUsage = totalUsage.Add(u)
	if err != nil {
		return "", totalUsage, err
	}
	if carryOverSummary != "" && !strings.Contains(summary, carryOverSummary) {
		summary = carryOverSummary + "\n\n---\n\n" + summary
	}
	return summary, totalUsage, nil
}

func (a *Agent) hasLivePrefixState() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.System != "" || len(a.Tools) > 0 || a.RequestMessages != nil
}

func (a *Agent) summarizeChunkWithFallback(
	ctx context.Context,
	chunk []provider.Message,
	cStart, cEnd int,
	isTurnPrefix bool,
	carryOverSummary string,
	digests map[string]string,
	sink func(delta string),
) (string, provider.Usage, error) {
	var totalUsage provider.Usage
	if err := ctx.Err(); err != nil {
		return "", totalUsage, err
	}
	if a.Client == nil {
		return MechanicalBlockSummaryWithDigests(chunk, cStart, cEnd, digests), totalUsage, nil
	}

	checkpoints := ExtractSummaryCheckpoints(chunk)
	tryStandalone := !a.hasLivePrefixState()

	if !tryStandalone {
		text, stopLen, u, err := a.runForkedSummarizer(ctx, chunk, cStart, cEnd, checkpoints, isTurnPrefix, false, digests, sink)
		totalUsage = totalUsage.Add(u)
		if err == nil && stopLen {
			if ctx.Err() != nil {
				return "", totalUsage, ctx.Err()
			}
			text2, stopLen2, u2, err2 := a.runForkedSummarizer(ctx, chunk, cStart, cEnd, checkpoints, isTurnPrefix, true, digests, sink)
			totalUsage = totalUsage.Add(u2)
			if err2 == nil && !stopLen2 && strings.TrimSpace(text2) != "" {
				return strings.TrimSpace(text2), totalUsage, nil
			}
			if ctx.Err() != nil {
				return "", totalUsage, ctx.Err()
			}
			tryStandalone = true
		} else if err == nil && strings.TrimSpace(text) != "" {
			return strings.TrimSpace(text), totalUsage, nil
		} else {
			if ctx.Err() != nil {
				return "", totalUsage, ctx.Err()
			}
			// Always fall back to pixel-free standalone runSummarizer (using
			// SerializeConversationWithDigests) on ANY warm-prefix failure
			// (e.g. 400 Too many images, 413, vision unsupported, overflow)
			// before degrading to MechanicalBlockSummary.
			tryStandalone = true
		}
	}

	if tryStandalone {
		prompt := buildStandalonePrompt(chunk, checkpoints, isTurnPrefix, carryOverSummary, digests, serializeBlockBudgetBytes, serializeArgsBudgetBytes, false)
		text, stopLen, u, err := a.runSummarizer(ctx, prompt, sink)
		totalUsage = totalUsage.Add(u)
		if err == nil && stopLen {
			if ctx.Err() != nil {
				return "", totalUsage, ctx.Err()
			}
			concisePrompt := buildStandalonePrompt(chunk, checkpoints, isTurnPrefix, carryOverSummary, digests, serializeBlockBudgetBytes/2, serializeArgsBudgetBytes/2, true)
			text2, stopLen2, u2, err2 := a.runSummarizer(ctx, concisePrompt, sink)
			totalUsage = totalUsage.Add(u2)
			if err2 == nil && !stopLen2 && strings.TrimSpace(text2) != "" {
				return strings.TrimSpace(text2), totalUsage, nil
			}
		} else if err == nil && strings.TrimSpace(text) != "" {
			return strings.TrimSpace(text), totalUsage, nil
		}
		if ctx.Err() != nil {
			return "", totalUsage, ctx.Err()
		}
	}

	return MechanicalBlockSummaryWithDigests(chunk, cStart, cEnd, digests), totalUsage, nil
}

func buildStandalonePrompt(
	chunk []provider.Message,
	checkpoints []string,
	isTurnPrefix bool,
	carryOverSummary string,
	digests map[string]string,
	blockBudget, argsBudget int,
	conciseRetry bool,
) string {
	conv := serializeConversationWithBudgetAndDigests(chunk, digests, blockBudget, argsBudget)
	var prompt string
	if isTurnPrefix {
		prompt = TurnPrefixSummarizationPrompt(conv)
	} else if carryOverSummary != "" {
		ops := ExtractFileOps(chunk)
		prompt = UpdateSummarizationPrompt(carryOverSummary, conv, FormatFileOperations(ops))
	} else {
		prompt = InitialSummarizationPrompt(conv)
	}
	if len(checkpoints) > 0 {
		var sb strings.Builder
		sb.WriteString(prompt)
		sb.WriteString("\n\n<summary_checkpoints>\n")
		for _, cp := range checkpoints {
			sb.WriteString("- ")
			sb.WriteString(cp)
			sb.WriteString("\n")
		}
		sb.WriteString("</summary_checkpoints>")
		prompt = sb.String()
	}
	if conciseRetry {
		prompt += "\n\nIMPORTANT: Keep the summary concise (under 1,000 words) so it completes without length truncation."
	}
	return prompt
}

func buildForkSummarizerDirective(
	chunk []provider.Message,
	cStart, cEnd int,
	checkpoints []string,
	isTurnPrefix bool,
	conciseRetry bool,
) string {
	endDisp := max(cStart, cEnd-1)
	firstAnchor := previewMessageAnchor(chunk, true)
	lastAnchor := previewMessageAnchor(chunk, false)
	ops := ExtractFileOps(chunk)
	failed := ExtractFailedCommands(chunk)

	var sb strings.Builder
	sb.WriteString("<system-reminder>INTERNAL COMPACTION FORK — DO NOT CALL ANY TOOLS.\n")
	sb.WriteString("DO NOT invoke any tool, function, shell command, or completion tool. Output ONLY the Markdown FoldBlock summary below.\n\n")
	sb.WriteString(fmt.Sprintf("Target span to summarize: raw transcript messages #%d through #%d (%d messages).\n", cStart, endDisp, len(chunk)))
	sb.WriteString("Summarize ONLY this target span from the conversation above. Do NOT re-summarize earlier `[FoldBlock ...]` messages and do NOT answer or continue the latest active user turn.\n")
	if firstAnchor != "" {
		sb.WriteString(fmt.Sprintf("- Span start anchor (#%d): %s\n", cStart, firstAnchor))
	}
	if lastAnchor != "" && cEnd-1 > cStart {
		sb.WriteString(fmt.Sprintf("- Span end anchor (#%d): %s\n", endDisp, lastAnchor))
	}
	if len(ops.Modified) > 0 {
		sb.WriteString("- Modified files in span: " + strings.Join(ops.Modified, ", ") + "\n")
	}
	if len(ops.Read) > 0 {
		sb.WriteString("- Read files in span: " + strings.Join(ops.Read, ", ") + "\n")
	}
	if len(failed) > 0 {
		sb.WriteString("- Failed commands in span:\n")
		for _, fc := range failed {
			sb.WriteString(fmt.Sprintf("  * `%s` (exit %s)", fc.Command, fc.ExitCode))
			if fc.FirstError != "" {
				sb.WriteString(": " + fc.FirstError)
			}
			sb.WriteString("\n")
		}
	}
	if len(checkpoints) > 0 {
		sb.WriteString("- Recorded progress checkpoints (`for_me` notes) in span:\n")
		for _, cp := range checkpoints {
			sb.WriteString("  * " + strings.Join(strings.Fields(cp), " ") + "\n")
		}
	}
	sb.WriteString("\n")
	if isTurnPrefix {
		sb.WriteString(TurnPrefixSummarizationPromptTemplate)
	} else {
		sb.WriteString(`Write a dense, factual Markdown summary using these exact headings:
## Goal
## Constraints
## Progress
## Decisions
## Next Steps
## Critical Context

Preserve exact file paths, symbol names, root causes, error diagnostics, and verified outcomes.`)
	}
	if conciseRetry {
		sb.WriteString("\nKeep total output concise (under 1,000 words) so the summary finishes cleanly within budget.")
	}
	sb.WriteString("\n\nREMEMBER: DO NOT CALL ANY TOOLS. Output ONLY the Markdown summary.</system-reminder>")
	return sb.String()
}

func previewMessageAnchor(chunk []provider.Message, fromStart bool) string {
	if len(chunk) == 0 {
		return ""
	}
	idx := 0
	step := 1
	if !fromStart {
		idx = len(chunk) - 1
		step = -1
	}
	for ; idx >= 0 && idx < len(chunk); idx += step {
		m := chunk[idx]
		if m.Meta != nil && (m.Meta[MetaHidden] == "true" || m.Meta["compaction"] == "true") {
			continue
		}
		var snippet string
		for _, c := range m.Content {
			switch b := c.(type) {
			case provider.TextBlock:
				t := strings.TrimSpace(StripLeadingSystemPrompt(b.Text))
				if t != "" {
					snippet = string(m.Role) + ": " + t
				}
			case provider.ToolCallBlock:
				snippet = fmt.Sprintf("assistant tool_use %s", b.Name)
			case provider.ToolResultBlock:
				t := strings.TrimSpace(stripToolResultEnvelope(toolResultText(b)))
				if t != "" {
					snippet = "tool_result: " + t
				}
			}
			if snippet != "" {
				break
			}
		}
		if snippet != "" {
			snippet = strings.Join(strings.Fields(snippet), " ")
			return truncateRunes(snippet, 220)
		}
	}
	return ""
}

// runForkedSummarizer executes a Prefix-Warm Forked Summarizer call that reuses
// the agent's exact live request prefix (BuildContextLocked + RequestMessages,
// byte-identical System, Tools, Reasoning, skill_prefix, and omitted ToolChoice)
// plus 1 trailing uncached user directive.
func (a *Agent) runForkedSummarizer(
	ctx context.Context,
	chunk []provider.Message,
	cStart, cEnd int,
	checkpoints []string,
	isTurnPrefix bool,
	conciseRetry bool,
	extraDigests map[string]string,
	sink func(delta string),
) (string, bool, provider.Usage, error) {
	directive := buildForkSummarizerDirective(chunk, cStart, cEnd, checkpoints, isTurnPrefix, conciseRetry)
	return a.runWarmPrefixDirective(ctx, directive, extraDigests, sink)
}

func (a *Agent) runWarmPrefixDirective(ctx context.Context, directive string, extraDigests map[string]string, sink func(delta string)) (string, bool, provider.Usage, error) {
	a.mu.Lock()
	baseMsgs := a.BuildContextLocked()
	if a.RequestMessages != nil {
		baseMsgs = a.RequestMessages(baseMsgs)
	}
	curState := a.compactionStateLocked()
	maxImgs := a.effectiveMaxWireImages(curState)
	keepImgs := a.effectiveKeepWireImages(curState, maxImgs)
	maxBytes := a.effectiveMaxWireImageBytes()
	var mergedDigests map[string]string
	if curState != nil && len(curState.ImageDigests) > 0 {
		mergedDigests = maps.Clone(curState.ImageDigests)
	}
	if len(extraDigests) > 0 {
		if mergedDigests == nil {
			mergedDigests = maps.Clone(extraDigests)
		} else {
			for k, v := range extraDigests {
				mergedDigests[k] = v
			}
		}
	}
	baseMsgs = capPrefixWireImages(baseMsgs, mergedDigests, keepImgs, maxBytes)
	reasoning := a.Reasoning
	maxTokens := a.MaxTokens
	forkMaxTokens := 4096
	if level := provider.NormalizeReasoning(reasoning); level != "" {
		forkMaxTokens = max(forkMaxTokens, provider.ReasoningBudget(level)+4096)
	}
	if maxTokens > 0 && forkMaxTokens > maxTokens {
		forkMaxTokens = maxTokens
	}
	reqMsgs := make([]provider.Message, 0, len(baseMsgs)+1)
	reqMsgs = append(reqMsgs, baseMsgs...)
	reqMsgs = append(reqMsgs, provider.Message{
		Role:    provider.RoleUser,
		Content: []provider.Content{provider.TextBlock{Text: directive}},
		Time:    time.Now(),
		Meta:    map[string]string{"compaction": "summarizer_fork"},
	})
	req := provider.Request{
		Model:     a.Model,
		System:    a.System,
		Messages:  reqMsgs,
		Tools:     a.Tools.Specs(),
		Reasoning: reasoning,
		MaxTokens: forkMaxTokens,
		SessionID: a.SessionID,
	}
	a.mu.Unlock()

	return a.streamSummarizerRequest(ctx, req, sink)
}

// MaybeAutoCompact is the proactive compaction trigger for the AutoCompact hook.
func (a *Agent) MaybeAutoCompact(ctx context.Context, window int, sink func(delta string)) (bool, error) {
	return a.MaybeAutoCompactAt(ctx, window, 0, sink)
}

// MaybeAutoCompactAt evaluates the wire-ready projected context against window
// and thresholdPct, compacting proactively when needed.
func (a *Agent) MaybeAutoCompactAt(ctx context.Context, window int, thresholdPct int, sink func(delta string)) (bool, error) {
	if window <= 0 {
		return false, nil
	}
	a.mu.Lock()
	a.contextWindow = window
	a.mu.Unlock()

	system, tools, msgs := a.ContextSnapshot()
	if len(msgs) <= CompactionMinMessages {
		return false, nil
	}
	if !ShouldCompactAt(window, provider.ContextTokens(system, tools, msgs), thresholdPct) {
		return false, nil
	}

	target := compactTargetTokens(window, thresholdPct)
	for attempt := 0; ; attempt++ {
		var (
			summary string
			err     error
		)
		if attempt == 0 {
			summary, err = a.Compact(ctx, 0, sink)
		} else {
			budget := max(1024, min(target/2, CompactionKeepRecentTokens/(1<<attempt)))
			summary, err = a.CompactToTokenBudget(ctx, budget, sink)
		}
		if err != nil || summary == "" {
			return attempt > 0, nil
		}
		system, tools, msgs = a.ContextSnapshot()
		if !ShouldCompactAt(window, provider.ContextTokens(system, tools, msgs), thresholdPct) {
			return true, nil
		}
		if attempt >= 2 {
			return true, nil
		}
	}
}

// runSummarizer issues a standalone summarization request with
// SummarizationSystemPrompt and rejects tool calls immediately.
func (a *Agent) runSummarizer(ctx context.Context, prompt string, sink func(delta string)) (string, bool, provider.Usage, error) {
	req := provider.Request{
		Model:     a.Model,
		System:    SummarizationSystemPrompt,
		MaxTokens: 4096,
		SessionID: a.SessionID,
		Messages: []provider.Message{
			{
				Role:    provider.RoleUser,
				Content: []provider.Content{provider.TextBlock{Text: prompt}},
				Time:    time.Now(),
				Meta:    map[string]string{"compaction": "summarizer"},
			},
		},
	}
	return a.streamSummarizerRequest(ctx, req, sink)
}

func (a *Agent) streamSummarizerRequest(ctx context.Context, req provider.Request, sink func(delta string)) (string, bool, provider.Usage, error) {
	reqCtx, cancelReq := context.WithCancel(ctx)
	defer cancelReq()

	stream, err := a.Client.Stream(reqCtx, req)
	if err != nil {
		return "", false, provider.Usage{}, err
	}

	var sb strings.Builder
	var runUsage provider.Usage
	stopLen := false
	sawToolCall := false
	for ev := range stream {
		switch e := ev.(type) {
		case provider.EventTextDelta:
			sb.WriteString(e.Delta)
			if sink != nil {
				sink(e.Delta)
			}
		case provider.EventToolStart, provider.EventToolArgs, provider.EventToolEnd:
			sawToolCall = true
			cancelReq()
		case provider.EventUsage:
			runUsage = runUsage.Add(e.Usage)
		case provider.EventDone:
			if sawToolCall {
				break
			}
			if e.Err != nil {
				return "", false, runUsage, e.Err
			}
			if e.Stop == provider.StopLength {
				stopLen = true
			}
		}
	}
	if sawToolCall {
		return "", false, runUsage, errSummarizerToolCall
	}
	return sb.String(), stopLen, runUsage, nil
}

func (a *Agent) maybeMergeTier2Blocks(
	ctx context.Context,
	state *CompactionState,
	window int,
	sink func(delta string),
) (provider.Usage, error) {
	var totalUsage provider.Usage
	if state == nil {
		return totalUsage, nil
	}

	needsMerge := func(active []FoldBlock) bool {
		if len(active) < Tier2MergeBatchSize {
			return false
		}
		if len(active) > Tier2MergeBlockThreshold {
			return true
		}
		if window > 0 && sumFoldBlockTokens(active) > window*Tier2MergeWindowPct/100 {
			return true
		}
		return false
	}

	for {
		active := state.ActiveBlocks()
		if !needsMerge(active) {
			break
		}
		if err := ctx.Err(); err != nil {
			return totalUsage, err
		}

		// Find the oldest contiguous batch of Tier2MergeBatchSize Tier-1 active blocks.
		batchIdx := -1
		for i := 0; i+Tier2MergeBatchSize <= len(active); i++ {
			allT1 := true
			for j := 0; j < Tier2MergeBatchSize; j++ {
				b := active[i+j]
				if b.Tier > 1 {
					allT1 = false
					break
				}
				if j > 0 && b.StartIdx != active[i+j-1].EndIdx {
					allT1 = false
					break
				}
			}
			if allT1 {
				batchIdx = i
				break
			}
		}
		if batchIdx < 0 {
			break
		}

		group := active[batchIdx : batchIdx+Tier2MergeBatchSize]
		var (
			readFiles      []string
			modFiles       []string
			fileSpans      []string
			activatedTools []string
			failedCmds     []FailedCommandSummary
			sourceIDs      []string
			rawToksSum     int
			sourceBlkToks  int
		)
		for _, b := range group {
			readFiles = MergeFileOps(readFiles, b.ReadFiles)
			modFiles = MergeFileOps(modFiles, b.ModifiedFiles)
			fileSpans = MergeFileOps(fileSpans, b.FileSpans)
			activatedTools = MergeFileOps(activatedTools, b.ActivatedTools)
			failedCmds = unionFailedCommands(failedCmds, b.FailedCommands)
			sourceIDs = append(sourceIDs, b.ID)
			rawToksSum += b.RawTokens
			if b.BlockTokens > 0 {
				sourceBlkToks += b.BlockTokens
			} else {
				sourceBlkToks += estimateFoldBlockTokens(b)
			}
		}

		mergedSummary, u, err := a.summarizeTier2Group(ctx, group, sink)
		totalUsage = totalUsage.Add(u)
		if err != nil {
			return totalUsage, err
		}

		t2ID := state.allocBlockID()
		t2 := FoldBlock{
			ID:             t2ID,
			Tier:           2,
			StartIdx:       group[0].StartIdx,
			EndIdx:         group[len(group)-1].EndIdx,
			Topic:          deriveTier2Topic(group, mergedSummary),
			Summary:        mergedSummary,
			ReadFiles:      readFiles,
			ModifiedFiles:  modFiles,
			FileSpans:      fileSpans,
			ActivatedTools: activatedTools,
			FailedCommands: failedCmds,
			SourceBlockIDs: sourceIDs,
			RawTokens:      rawToksSum,
			CreatedAt:      time.Now().UnixMilli(),
		}
		t2.BlockTokens = estimateFoldBlockTokens(t2)

		// Tier-2 block must shrink relative to the combined Tier-1 blocks it replaces.
		if exceedsShrinkBudget(max(sourceBlkToks, rawToksSum), t2.BlockTokens) || (sourceBlkToks >= netShrinkFloorTokens && t2.BlockTokens > int(float64(sourceBlkToks)*NetShrinkTolerance)) {
			t2.Summary = mechanicalTier2Summary(group)
			t2.Topic = deriveTier2Topic(group, t2.Summary)
			t2.BlockTokens = estimateFoldBlockTokens(t2)
		}

		retireSet := map[string]bool{}
		for _, id := range sourceIDs {
			retireSet[id] = true
		}
		for i := range state.Blocks {
			if retireSet[state.Blocks[i].ID] && state.Blocks[i].RetiredByBlockID == "" {
				state.Blocks[i].RetiredByBlockID = t2ID
			}
		}
		state.Blocks = append(state.Blocks, t2)
	}

	return totalUsage, nil
}

func (a *Agent) summarizeTier2Group(ctx context.Context, group []FoldBlock, sink func(delta string)) (string, provider.Usage, error) {
	var totalUsage provider.Usage
	if err := ctx.Err(); err != nil {
		return "", totalUsage, err
	}
	if a.Client == nil {
		return mechanicalTier2Summary(group), totalUsage, nil
	}

	var eras strings.Builder
	for _, b := range group {
		eras.WriteString(fmt.Sprintf("<era id=%q msgs=\"#%d-#%d\">\n%s\n</era>\n\n",
			b.ID, b.StartIdx, max(b.StartIdx, b.EndIdx-1), strings.TrimSpace(b.Summary)))
	}

	if a.hasLivePrefixState() {
		directive := fmt.Sprintf(`<system-reminder>INTERNAL TIER-2 COMPACTION ROLLUP — DO NOT CALL ANY TOOLS.
Consolidate the %d chronological FoldBlock summaries below (covering messages #%d–#%d) into a single dense Tier-2 Markdown summary using headings:
## Goal
## Constraints
## Progress
## Decisions
## Next Steps
## Critical Context

Preserve durable decisions, file paths, root causes, and unresolved items while removing superseded intermediate steps.

%sREMEMBER: DO NOT CALL ANY TOOLS. Output ONLY the consolidated Markdown summary.</system-reminder>`,
			len(group), group[0].StartIdx, max(group[0].StartIdx, group[len(group)-1].EndIdx-1), eras.String())

		text, stopLen, u, err := a.runWarmPrefixDirective(ctx, directive, nil, sink)
		totalUsage = totalUsage.Add(u)
		if err == nil && !stopLen && strings.TrimSpace(text) != "" {
			return strings.TrimSpace(text), totalUsage, nil
		}
		if ctx.Err() != nil {
			return "", totalUsage, ctx.Err()
		}
	}

	standalonePrompt := fmt.Sprintf("Consolidate these %d chronological conversation era summaries (#%d–#%d) into one cohesive summary using the required format. Preserve durable decisions, key file paths, errors, and pending work.\n\n%s",
		len(group), group[0].StartIdx, max(group[0].StartIdx, group[len(group)-1].EndIdx-1), eras.String())
	text, stopLen, u, err := a.runSummarizer(ctx, standalonePrompt, sink)
	totalUsage = totalUsage.Add(u)
	if err == nil && !stopLen && strings.TrimSpace(text) != "" {
		return strings.TrimSpace(text), totalUsage, nil
	}
	if ctx.Err() != nil {
		return "", totalUsage, ctx.Err()
	}
	return mechanicalTier2Summary(group), totalUsage, nil
}

func mechanicalTier2Summary(group []FoldBlock) string {
	var sb strings.Builder
	sb.WriteString("## Progress\n")
	for _, b := range group {
		endDisp := max(b.StartIdx, b.EndIdx-1)
		headline := b.Topic
		if headline == "" {
			headline = firstSummaryLine(b.Summary)
		}
		if headline == "" {
			headline = "Compacted era"
		}
		sb.WriteString(fmt.Sprintf("- **%s (#%d–#%d)**: %s\n", b.ID, b.StartIdx, endDisp, truncateRunes(headline, 240)))
	}
	return strings.TrimSpace(sb.String())
}

func estimateFoldBlockTokens(b FoldBlock) int {
	msg := renderFoldBlockMessage(b, false, 0, nil)
	return provider.ContextTokens("", nil, []provider.Message{msg})
}

func sumFoldBlockTokens(blocks []FoldBlock) int {
	sum := 0
	for _, b := range blocks {
		if b.BlockTokens > 0 {
			sum += b.BlockTokens
		} else {
			sum += estimateFoldBlockTokens(b)
		}
	}
	return sum
}

func exceedsShrinkBudget(rawTokens, candidateBlockTokens int) bool {
	limit := int(float64(rawTokens) * NetShrinkTolerance)
	if limit < netShrinkFloorTokens {
		limit = netShrinkFloorTokens
	}
	return candidateBlockTokens > limit
}

func deriveBlockTopic(chunk []provider.Message, summary string) string {
	for _, m := range chunk {
		if m.Role != provider.RoleUser {
			continue
		}
		if m.Meta != nil && (m.Meta[MetaHidden] == "true" || m.Meta["compaction"] == "true") {
			continue
		}
		txt := strings.TrimSpace(StripLeadingSystemPrompt(extractText(m)))
		if txt == "" || strings.HasPrefix(txt, "<system-warn>") {
			continue
		}
		line := strings.Join(strings.Fields(txt), " ")
		return truncateRunes(line, 96)
	}
	return firstSummaryLine(summary)
}

func deriveTier2Topic(group []FoldBlock, summary string) string {
	var topics []string
	for _, b := range group {
		if b.Topic != "" && !containsString(topics, b.Topic) {
			topics = append(topics, truncateRunes(b.Topic, 40))
		}
		if len(topics) >= 2 {
			break
		}
	}
	if len(topics) > 0 {
		return truncateRunes(strings.Join(topics, " → "), 96)
	}
	return firstSummaryLine(summary)
}

func firstSummaryLine(summary string) string {
	for _, rawLine := range strings.Split(summary, "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") || line == "---" {
			continue
		}
		line = strings.TrimPrefix(line, "- ")
		line = strings.TrimPrefix(line, "* ")
		line = strings.Join(strings.Fields(line), " ")
		if line != "" {
			return truncateRunes(line, 96)
		}
	}
	return ""
}

// advanceCompactionChain advances the legacy single-summary chain head after a
// standalone plan evaluation. Kept for unit-test compatibility.
func advanceCompactionChain(plan *CompactionPlan, summary string, prev *CompactionState) *CompactionState {
	var readFiles, modFiles []string
	if prev != nil {
		readFiles = MergeFileOps(prev.ReadFiles, plan.WindowOps.Read)
		modFiles = MergeFileOps(prev.ModifiedFiles, plan.WindowOps.Modified)
	} else {
		readFiles = append([]string(nil), plan.WindowOps.Read...)
		modFiles = append([]string(nil), plan.WindowOps.Modified...)
	}
	count := 1
	if prev != nil {
		count = prev.Count + 1
	}
	return &CompactionState{
		PreviousSummary: summary,
		ReadFiles:       readFiles,
		ModifiedFiles:   modFiles,
		Count:           count,
	}
}

// projectionIndexForContext maps a cut point expressed in projected-context
// coordinates back to a raw history index.
func projectionIndexForContext(history []provider.Message, state *CompactionState, ctxKeepFrom int) int {
	active, base := projectionAnchor(state, len(history))
	if active {
		synCount := 1
		if state != nil && len(state.Blocks) > 0 {
			synCount = len(state.ActiveBlocks())
			if synCount <= 0 {
				synCount = 1
			}
		}
		idx := ctxKeepFrom
		if idx < synCount {
			idx = synCount
		}
		if idx >= len(history)-base+synCount {
			return len(history)
		}
		return base + idx - synCount
	}
	if ctxKeepFrom < 0 {
		return 0
	}
	if ctxKeepFrom > len(history) {
		return len(history)
	}
	return ctxKeepFrom
}

// SeedCompactionState primes the compaction state (e.g. restored from session
// storage on resume). A nil state clears the chain.
func (a *Agent) SeedCompactionState(state *CompactionState) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.compactionState = state.Clone()
}

// CompactionChain returns a deep copy of the current compaction state, or nil.
func (a *Agent) CompactionChain() *CompactionState {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.compactionStateLocked()
}

func (a *Agent) compactionStateLocked() *CompactionState {
	return a.compactionState.Clone()
}

func (a *Agent) setCompactionStateLocked(state *CompactionState) {
	if state != nil {
		state.SyncMirrors()
	}
	a.compactionState = state.Clone()
}

// hybridKeepFloor computes the keep floor: a 20k-token baseline raised toward
// 30% of the projected transcript on large windows, capped at 40k tokens.
func hybridKeepFloor(msgs []provider.Message) int {
	total := provider.ContextTokens("", nil, msgs)
	floor := CompactionKeepRecentTokens
	if thirty := total * 30 / 100; thirty > floor {
		floor = thirty
	}
	if floor > CompactionKeepMaxTokens {
		floor = CompactionKeepMaxTokens
	}
	return floor
}
