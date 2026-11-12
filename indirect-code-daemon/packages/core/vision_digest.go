package core

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"indirect/indirect-code-daemon/packages/provider"
)

const (
	// DefaultMaxWireImages is the live wire image count above which older images
	// latch down to DefaultKeepWireImages.
	DefaultMaxWireImages = 6

	// DefaultKeepWireImages is the hysteresis target after eviction so subsequent
	// image reads grow cleanly back up to DefaultMaxWireImages without shifting
	// the cached prefix on every single turn.
	DefaultKeepWireImages = 3

	// DefaultMaxWireImageBytes caps aggregate raw bytes across all live wire images (~10.6 MiB base64).
	DefaultMaxWireImageBytes = 8 * 1024 * 1024

	// MaxCachedImageDigests bounds CompactionState.ImageDigests entries per session.
	MaxCachedImageDigests = 256

	// MaxImageDigestChars bounds each stored visual digest string.
	MaxImageDigestChars = 2400

	// VisionTranscriberMaxTokens bounds output tokens per single-image transcription call.
	VisionTranscriberMaxTokens = 500

	// VisionTranscriberTimeout bounds latency of a single-image transcription call.
	VisionTranscriberTimeout = 15 * time.Second

	visionDigestWorkers = 2
)

// VisionTranscriberSystemPrompt instructs the model to produce a dense technical
// visual digest before an image's raw pixels leave the live wire window.
const VisionTranscriberSystemPrompt = `You are a concise technical visual transcriber for a software engineering agent.
Extract ALL visible text/OCR verbatim (error messages, stack traces, logs, numbers, UI labels, code snippets, file paths, URLs, status codes), UI layout and component state, color/alignment anomalies, and key visual details.
Output ONLY dense structured Markdown bullet points (<= 1200 characters). No preamble, no speculation.`

type wireImageOccurrence struct {
	msgIdx   int
	blockIdx int
	occKey   string
	imgKey   string
	img      provider.ImageBlock
}

// ImageOccurrenceKey formats the message-scoped eviction latch key so re-reading
// the same file at a later msgIdx stays live while reusing its cached SHA256 digest.
func ImageOccurrenceKey(msgIdx, blockIdx int, imgKey string) string {
	return fmt.Sprintf("%d:%d:%s", msgIdx, blockIdx, imgKey)
}

func isImageOccurrenceEvicted(evicted map[string]bool, msgIdx, blockIdx int, imgKey string) bool {
	if len(evicted) == 0 {
		return false
	}
	if evicted[ImageOccurrenceKey(msgIdx, blockIdx, imgKey)] {
		return true
	}
	if evicted[fmt.Sprintf("%d:%d", msgIdx, blockIdx)] {
		return true
	}
	return evicted[imgKey]
}

func parseOccurrenceKeyParts(k string) (msgIdx int, rest string, ok bool) {
	colon := strings.IndexByte(k, ':')
	if colon <= 0 {
		return 0, "", false
	}
	n, err := strconv.Atoi(k[:colon])
	if err != nil || n < 0 {
		return 0, "", false
	}
	return n, k[colon+1:], true
}

func pruneEvictedImagesAbove(evicted map[string]bool, effectiveCut int) map[string]bool {
	if len(evicted) == 0 {
		return nil
	}
	out := make(map[string]bool, len(evicted))
	for k, v := range evicted {
		if !v {
			continue
		}
		if msgIdx, _, ok := parseOccurrenceKeyParts(k); ok {
			if msgIdx >= effectiveCut {
				continue
			}
		}
		out[k] = true
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func shiftEvictedImagesOnDrop(evicted map[string]bool, droppedIdx int) map[string]bool {
	if len(evicted) == 0 || droppedIdx < 0 {
		return evicted
	}
	out := make(map[string]bool, len(evicted))
	for k, v := range evicted {
		if !v {
			continue
		}
		msgIdx, rest, ok := parseOccurrenceKeyParts(k)
		if !ok {
			out[k] = true
			continue
		}
		if msgIdx == droppedIdx {
			continue
		}
		if msgIdx > droppedIdx {
			out[strconv.Itoa(msgIdx-1)+":"+rest] = true
		} else {
			out[k] = true
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// FormatVisualDigestBlock formats the projected TextBlock replacement for an
// evicted ImageBlock on the provider wire.
func FormatVisualDigestBlock(img provider.ImageBlock, digest string) string {
	label := strings.TrimSpace(img.SourcePath)
	if label == "" {
		label = "attachment"
	}
	mime := strings.TrimSpace(img.MimeType)
	if mime == "" {
		mime = "image/unknown"
	}
	dims := formatImageDimsCompact(img)
	readTarget := strings.TrimSpace(img.SourcePath)
	if readTarget == "" {
		readTarget = label
	}
	header := fmt.Sprintf(
		"[Visual Digest — %s (%s, %s) | pixels dehydrated from live wire; call read({\"path\":%q}) only if fresh pixel inspection is needed]",
		label, mime, dims, readTarget,
	)
	trimmed := strings.TrimSpace(digest)
	if trimmed == "" {
		return header
	}
	return header + "\n" + trimmed
}

func formatImageDimsCompact(img provider.ImageBlock) string {
	if img.Width > 0 && img.Height > 0 {
		return fmt.Sprintf("%dx%d", img.Width, img.Height)
	}
	if img.OrigWidth > 0 && img.OrigHeight > 0 {
		return fmt.Sprintf("%dx%d", img.OrigWidth, img.OrigHeight)
	}
	return "unknown-size"
}

func formatImageDimsFull(img provider.ImageBlock) string {
	if img.OrigWidth > 0 && img.OrigHeight > 0 && img.Width > 0 && img.Height > 0 &&
		(img.OrigWidth != img.Width || img.OrigHeight != img.Height) {
		return fmt.Sprintf("%dx%d -> %dx%d", img.OrigWidth, img.OrigHeight, img.Width, img.Height)
	}
	return formatImageDimsCompact(img)
}

// BuildDeterministicImageDigest synthesizes a guaranteed zero-LLM visual digest
// from image metadata plus nearby assistant observations in history.
func BuildDeterministicImageDigest(history []provider.Message, msgIdx int, img provider.ImageBlock) string {
	label := strings.TrimSpace(img.SourcePath)
	if label == "" {
		label = "user attachment"
	}
	mime := strings.TrimSpace(img.MimeType)
	if mime == "" {
		mime = "image/unknown"
	}
	key := provider.ImageKey(img)
	shortHash := key
	if len(shortHash) > 12 {
		shortHash = shortHash[:12]
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "- Image metadata: `%s` (%s, %s, %d bytes, sha256:%s)",
		label, mime, formatImageDimsFull(img), len(img.Data), shortHash)

	if obs := extractNearbyAssistantObservations(history, msgIdx, 600); obs != "" {
		sb.WriteString("\n- Prior assistant observations: ")
		sb.WriteString(obs)
	}
	return truncateRunes(sb.String(), MaxImageDigestChars)
}

func extractNearbyAssistantObservations(history []provider.Message, msgIdx int, maxChars int) string {
	if msgIdx < 0 || msgIdx+1 >= len(history) || maxChars <= 0 {
		return ""
	}
	var parts []string
	assistantSeen := 0
	for i := msgIdx + 1; i < len(history) && assistantSeen < 3; i++ {
		m := history[i]
		if m.Meta != nil && m.Meta["compaction"] == "true" {
			continue
		}
		if m.Role == provider.RoleUser {
			if m.Meta != nil && m.Meta[MetaHidden] == "true" {
				continue
			}
			break
		}
		if m.Role != provider.RoleAssistant {
			continue
		}
		assistantSeen++
		for _, c := range m.Content {
			switch b := c.(type) {
			case provider.TextBlock:
				if t := strings.TrimSpace(b.Text); t != "" {
					parts = append(parts, strings.Join(strings.Fields(t), " "))
				}
			case provider.ReasoningBlock:
				if t := strings.TrimSpace(b.Summary); t != "" {
					parts = append(parts, strings.Join(strings.Fields(t), " "))
				}
			case provider.ToolCallBlock:
				if b.Name == summaryToolName || b.Name == "finish_entire_request" {
					var payload map[string]any
					if json.Unmarshal(b.Arguments, &payload) == nil {
						for _, field := range []string{"for_user", "for_me", "message", "summary"} {
							if s, ok := payload[field].(string); ok && strings.TrimSpace(s) != "" {
								parts = append(parts, strings.Join(strings.Fields(s), " "))
							}
						}
					}
				}
			}
		}
	}
	if len(parts) == 0 {
		return ""
	}
	return truncateRunes(strings.Join(parts, " | "), maxChars)
}

func (a *Agent) effectiveMaxWireImages(state *CompactionState) int {
	maxImgs := a.MaxWireImages
	if maxImgs <= 0 {
		maxImgs = DefaultMaxWireImages
	}
	if state != nil && state.LearnedMaxImages != nil {
		learned := max(0, *state.LearnedMaxImages)
		if learned < maxImgs {
			maxImgs = learned
		}
	}
	return maxImgs
}

func (a *Agent) effectiveKeepWireImages(state *CompactionState, effectiveMax int) int {
	keepImgs := a.KeepWireImages
	if keepImgs <= 0 {
		keepImgs = DefaultKeepWireImages
	}
	if keepImgs > effectiveMax {
		keepImgs = effectiveMax
	}
	if state != nil && state.LearnedMaxImages != nil {
		learned := max(0, *state.LearnedMaxImages)
		if learned < keepImgs {
			keepImgs = learned
		}
	}
	return max(0, keepImgs)
}

func (a *Agent) effectiveMaxWireImageBytes() int {
	if a.MaxWireImageBytes > 0 {
		return a.MaxWireImageBytes
	}
	return DefaultMaxWireImageBytes
}

func collectLiveWireImages(history []provider.Message, keepFrom int, state *CompactionState) ([]wireImageOccurrence, int) {
	if keepFrom < 0 {
		keepFrom = 0
	}
	if keepFrom >= len(history) {
		return nil, 0
	}
	var evicted map[string]bool
	if state != nil {
		evicted = state.EvictedImages
	}
	var live []wireImageOccurrence
	totalBytes := 0
	for msgIdx := keepFrom; msgIdx < len(history); msgIdx++ {
		m := history[msgIdx]
		if m.Meta != nil && (m.Meta[MetaHidden] == "true" || m.Meta["compaction"] == "true") {
			continue
		}
		blockOrd := 0
		for _, c := range m.Content {
			switch v := c.(type) {
			case provider.ImageBlock:
				imgKey := provider.ImageKey(v)
				if !isImageOccurrenceEvicted(evicted, msgIdx, blockOrd, imgKey) {
					live = append(live, wireImageOccurrence{
						msgIdx:   msgIdx,
						blockIdx: blockOrd,
						occKey:   ImageOccurrenceKey(msgIdx, blockOrd, imgKey),
						imgKey:   imgKey,
						img:      v,
					})
					totalBytes += len(v.Data)
				}
				blockOrd++
			case provider.ToolResultBlock:
				for _, inner := range v.Content {
					if ib, ok := inner.(provider.ImageBlock); ok {
						imgKey := provider.ImageKey(ib)
						if !isImageOccurrenceEvicted(evicted, msgIdx, blockOrd, imgKey) {
							live = append(live, wireImageOccurrence{
								msgIdx:   msgIdx,
								blockIdx: blockOrd,
								occKey:   ImageOccurrenceKey(msgIdx, blockOrd, imgKey),
								imgKey:   imgKey,
								img:      ib,
							})
							totalBytes += len(ib.Data)
						}
						blockOrd++
					}
				}
			}
		}
	}
	return live, totalBytes
}

func (a *Agent) liveWireImageCount() int {
	a.mu.Lock()
	history := append([]provider.Message(nil), a.messages...)
	state := a.compactionStateLocked()
	a.mu.Unlock()

	keepFrom := 0
	if ok, kf := projectionAnchor(state, len(history)); ok {
		keepFrom = kf
	}
	if state != nil && state.LearnedMaxImages != nil && *state.LearnedMaxImages <= 0 {
		return 0
	}
	live, _ := collectLiveWireImages(history, keepFrom, state)
	return len(live)
}

// prepareWireImages enforces the hysteresis live-image wire window (6 -> 3 by
// default, LearnedMaxImages when learned, and 8 MiB raw wire cap) before a turn
// request is projected.
func (a *Agent) prepareWireImages(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	a.mu.Lock()
	history := append([]provider.Message(nil), a.messages...)
	state := a.compactionStateLocked()
	a.mu.Unlock()

	keepFrom := 0
	if ok, kf := projectionAnchor(state, len(history)); ok {
		keepFrom = kf
	}
	live, totalBytes := collectLiveWireImages(history, keepFrom, state)
	if len(live) == 0 {
		return
	}

	forceZero := state != nil && state.LearnedMaxImages != nil && *state.LearnedMaxImages <= 0
	maxImgs := a.effectiveMaxWireImages(state)
	keepImgs := a.effectiveKeepWireImages(state, maxImgs)
	maxBytes := a.effectiveMaxWireImageBytes()

	if !forceZero && len(live) <= maxImgs && totalBytes <= maxBytes {
		return
	}

	remCount := len(live)
	remBytes := totalBytes
	var toEvict []wireImageOccurrence
	for _, occ := range live {
		if !forceZero && remCount <= keepImgs && remBytes <= maxBytes {
			break
		}
		toEvict = append(toEvict, occ)
		remCount--
		remBytes -= len(occ.img.Data)
	}
	if len(toEvict) == 0 {
		return
	}

	var existing map[string]string
	var learned *int
	if state != nil {
		existing = maps.Clone(state.ImageDigests)
		learned = state.LearnedMaxImages
	}
	synthesized := a.ensureImageDigests(ctx, history, toEvict, existing, learned, forceZero)
	if ctx.Err() != nil {
		return
	}

	a.mu.Lock()
	cur := a.compactionStateLocked()
	if cur == nil {
		cur = &CompactionState{}
	}
	if cur.ImageDigests == nil {
		cur.ImageDigests = make(map[string]string, len(synthesized))
	}
	for k, d := range synthesized {
		cur.ImageDigests[k] = truncateRunes(d, MaxImageDigestChars)
	}
	trimImageDigestsMap(cur.ImageDigests, a.messages, cur.KeepFrom)
	if cur.EvictedImages == nil {
		cur.EvictedImages = make(map[string]bool, len(toEvict))
	}
	for _, occ := range toEvict {
		cur.EvictedImages[occ.occKey] = true
	}
	a.setCompactionStateLocked(cur)
	a.rev++
	onState := a.OnCompactionState
	snapState := cur.Clone()
	a.mu.Unlock()

	if onState != nil {
		onState(snapState)
	}
}

// shedWireImagesReactive learns an optional provider image cap and dehydrates
// oldest live wire images down to targetKeep, returning how many images were
// newly dehydrated (or newly suppressed by LearnedMaxImages=0) and how many stay live.
func (a *Agent) shedWireImagesReactive(
	ctx context.Context,
	learnedCap *int,
	targetKeep int,
	forceDeterministic bool,
) (int, int) {
	if ctx.Err() != nil {
		return 0, 0
	}
	a.mu.Lock()
	history := append([]provider.Message(nil), a.messages...)
	state := a.compactionStateLocked()
	a.mu.Unlock()

	keepFrom := 0
	if ok, kf := projectionAnchor(state, len(history)); ok {
		keepFrom = kf
	}
	live, totalBytes := collectLiveWireImages(history, keepFrom, state)

	if targetKeep < 0 {
		targetKeep = 0
	}
	maxBytes := a.effectiveMaxWireImageBytes()
	remCount := len(live)
	remBytes := totalBytes
	var toEvict []wireImageOccurrence
	for _, occ := range live {
		if remCount <= targetKeep && remBytes <= maxBytes {
			break
		}
		toEvict = append(toEvict, occ)
		remCount--
		remBytes -= len(occ.img.Data)
	}

	var existing map[string]string
	effectiveLearned := learnedCap
	if state != nil {
		existing = maps.Clone(state.ImageDigests)
		if effectiveLearned == nil {
			effectiveLearned = state.LearnedMaxImages
		}
	}
	forceDet := forceDeterministic || (effectiveLearned != nil && *effectiveLearned <= 0)
	var synthesized map[string]string
	if len(toEvict) > 0 {
		synthesized = a.ensureImageDigests(ctx, history, toEvict, existing, effectiveLearned, forceDet)
	}
	if ctx.Err() != nil {
		return 0, len(live)
	}

	a.mu.Lock()
	cur := a.compactionStateLocked()
	if cur == nil {
		cur = &CompactionState{}
	}
	capChanged := false
	if learnedCap != nil {
		capped := max(0, *learnedCap)
		if cur.LearnedMaxImages == nil || capped < *cur.LearnedMaxImages {
			v := capped
			cur.LearnedMaxImages = &v
			capChanged = true
		}
	}
	if len(synthesized) > 0 {
		if cur.ImageDigests == nil {
			cur.ImageDigests = make(map[string]string, len(synthesized))
		}
		for k, d := range synthesized {
			cur.ImageDigests[k] = truncateRunes(d, MaxImageDigestChars)
		}
		trimImageDigestsMap(cur.ImageDigests, a.messages, cur.KeepFrom)
	}
	if len(toEvict) > 0 {
		if cur.EvictedImages == nil {
			cur.EvictedImages = make(map[string]bool, len(toEvict))
		}
		for _, occ := range toEvict {
			cur.EvictedImages[occ.occKey] = true
		}
	}
	changed := capChanged || len(toEvict) > 0
	var onState func(*CompactionState)
	var snapState *CompactionState
	if changed {
		a.setCompactionStateLocked(cur)
		a.rev++
		onState = a.OnCompactionState
		snapState = cur.Clone()
	}
	a.mu.Unlock()

	if onState != nil && snapState != nil {
		onState(snapState)
	}
	return len(toEvict), remCount
}

// ensureSpanImageDigests populates workingState.ImageDigests for all ImageBlocks
// in history[startIdx:endIdx] before compaction summarizes or folds them.
func (a *Agent) ensureSpanImageDigests(
	ctx context.Context,
	history []provider.Message,
	startIdx, endIdx int,
	workingState *CompactionState,
) {
	if ctx.Err() != nil || workingState == nil || startIdx < 0 || endIdx <= startIdx || startIdx >= len(history) {
		return
	}
	if endIdx > len(history) {
		endIdx = len(history)
	}
	var targets []wireImageOccurrence
	for msgIdx := startIdx; msgIdx < endIdx; msgIdx++ {
		m := history[msgIdx]
		blockOrd := 0
		for _, c := range m.Content {
			switch v := c.(type) {
			case provider.ImageBlock:
				imgKey := provider.ImageKey(v)
				targets = append(targets, wireImageOccurrence{
					msgIdx:   msgIdx,
					blockIdx: blockOrd,
					occKey:   ImageOccurrenceKey(msgIdx, blockOrd, imgKey),
					imgKey:   imgKey,
					img:      v,
				})
				blockOrd++
			case provider.ToolResultBlock:
				for _, inner := range v.Content {
					if ib, ok := inner.(provider.ImageBlock); ok {
						imgKey := provider.ImageKey(ib)
						targets = append(targets, wireImageOccurrence{
							msgIdx:   msgIdx,
							blockIdx: blockOrd,
							occKey:   ImageOccurrenceKey(msgIdx, blockOrd, imgKey),
							imgKey:   imgKey,
							img:      ib,
						})
						blockOrd++
					}
				}
			}
		}
	}
	if len(targets) == 0 {
		return
	}
	forceDet := workingState.LearnedMaxImages != nil && *workingState.LearnedMaxImages <= 0
	synthesized := a.ensureImageDigests(ctx, history, targets, workingState.ImageDigests, workingState.LearnedMaxImages, forceDet)
	if ctx.Err() != nil || len(synthesized) == 0 {
		return
	}
	if workingState.ImageDigests == nil {
		workingState.ImageDigests = make(map[string]string, len(synthesized))
	}
	for k, d := range synthesized {
		workingState.ImageDigests[k] = truncateRunes(d, MaxImageDigestChars)
	}
	trimImageDigestsMap(workingState.ImageDigests, history, endIdx)
}

func (a *Agent) ensureImageDigests(
	ctx context.Context,
	history []provider.Message,
	targets []wireImageOccurrence,
	existing map[string]string,
	learnedMax *int,
	forceDeterministic bool,
) map[string]string {
	out := make(map[string]string, len(targets))
	var missing []wireImageOccurrence
	seenKey := make(map[string]bool, len(targets))

	for _, t := range targets {
		if d := strings.TrimSpace(existing[t.imgKey]); d != "" {
			out[t.imgKey] = d
			continue
		}
		if seenKey[t.imgKey] {
			continue
		}
		seenKey[t.imgKey] = true
		missing = append(missing, t)
	}
	if len(missing) == 0 || ctx.Err() != nil {
		return out
	}

	canVision := a.Client != nil && !forceDeterministic && (learnedMax == nil || *learnedMax > 0)
	if !canVision {
		for _, t := range missing {
			out[t.imgKey] = BuildDeterministicImageDigest(history, t.msgIdx, t.img)
		}
		return out
	}

	var mu sync.Mutex
	visionRejected := false
	ch := make(chan wireImageOccurrence, len(missing))
	for _, t := range missing {
		ch <- t
	}
	close(ch)

	workers := min(visionDigestWorkers, len(missing))
	var wg sync.WaitGroup
	wg.Add(workers)
	for w := 0; w < workers; w++ {
		go func() {
			defer wg.Done()
			for item := range ch {
				if ctx.Err() != nil {
					return
				}
				mu.Lock()
				skipLLM := visionRejected
				mu.Unlock()

				var digest string
				if !skipLLM && ctx.Err() == nil {
					txt, unsupported := a.transcribeImageViaLLM(ctx, item.img)
					if ctx.Err() != nil {
						return
					}
					if unsupported {
						mu.Lock()
						visionRejected = true
						mu.Unlock()
					}
					digest = strings.TrimSpace(txt)
				}
				if ctx.Err() != nil {
					return
				}
				if digest == "" {
					digest = BuildDeterministicImageDigest(history, item.msgIdx, item.img)
				}
				digest = truncateRunes(digest, MaxImageDigestChars)
				mu.Lock()
				out[item.imgKey] = digest
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if ctx.Err() != nil {
		return nil
	}
	return out
}

func (a *Agent) transcribeImageViaLLM(ctx context.Context, img provider.ImageBlock) (string, bool) {
	a.mu.Lock()
	client := a.Client
	model := a.Model
	sessionID := a.SessionID
	onUsage := a.OnUsage
	a.mu.Unlock()

	if client == nil || (len(img.Data) == 0 && img.URL == "") {
		return "", false
	}

	childCtx, cancel := context.WithTimeout(ctx, VisionTranscriberTimeout)
	defer cancel()

	req := provider.Request{
		Model:     model,
		System:    VisionTranscriberSystemPrompt,
		MaxTokens: VisionTranscriberMaxTokens,
		Tools:     nil,
		Reasoning: "",
		SessionID: sessionID,
		Messages: []provider.Message{
			{
				Role: provider.RoleUser,
				Content: []provider.Content{
					img,
					provider.TextBlock{Text: "Transcribe all visible text/OCR verbatim, UI layout/state, errors, numbers, and visual details into dense Markdown bullets (<= 1200 chars)."},
				},
				Time: time.Now(),
				Meta: map[string]string{"vision_digest": "true"},
			},
		},
	}

	stream, err := client.Stream(childCtx, req)
	if err != nil {
		vErr := ClassifyVisionOrPayloadError(err)
		return "", vErr != nil && vErr.Kind == KindVisionUnsupported
	}

	var sb strings.Builder
	var runUsage provider.Usage
	var streamErr error
	for ev := range stream {
		switch e := ev.(type) {
		case provider.EventTextDelta:
			sb.WriteString(e.Delta)
		case provider.EventUsage:
			runUsage = runUsage.Add(e.Usage)
		case provider.EventDone:
			if e.Err != nil {
				streamErr = e.Err
			}
		}
	}

	if runUsage.InputTokens > 0 || runUsage.OutputTokens > 0 || runUsage.CacheReadTokens > 0 || runUsage.CacheWriteTokens > 0 {
		total, _ := a.AddSubagentUsage(runUsage)
		if onUsage != nil {
			onUsage(total)
		}
	}

	if streamErr != nil {
		vErr := ClassifyVisionOrPayloadError(streamErr)
		return "", vErr != nil && vErr.Kind == KindVisionUnsupported
	}
	text := strings.TrimSpace(sb.String())
	if text == "" {
		return "", false
	}
	return truncateRunes(text, 1200), false
}

func trimImageDigestsMap(digests map[string]string, history []provider.Message, keepFrom int) {
	if len(digests) <= MaxCachedImageDigests {
		return
	}
	activeKeys := map[string]bool{}
	if keepFrom < 0 {
		keepFrom = 0
	}
	for i := keepFrom; i < len(history); i++ {
		for _, c := range history[i].Content {
			switch v := c.(type) {
			case provider.ImageBlock:
				activeKeys[provider.ImageKey(v)] = true
			case provider.ToolResultBlock:
				for _, inner := range v.Content {
					if ib, ok := inner.(provider.ImageBlock); ok {
						activeKeys[provider.ImageKey(ib)] = true
					}
				}
			}
		}
	}
	var candidates []string
	for k := range digests {
		if !activeKeys[k] {
			candidates = append(candidates, k)
		}
	}
	sort.Strings(candidates)
	for _, k := range candidates {
		if len(digests) <= MaxCachedImageDigests {
			return
		}
		delete(digests, k)
	}
	if len(digests) > MaxCachedImageDigests {
		all := make([]string, 0, len(digests))
		for k := range digests {
			all = append(all, k)
		}
		sort.Strings(all)
		for _, k := range all {
			if len(digests) <= MaxCachedImageDigests {
				break
			}
			delete(digests, k)
		}
	}
}

// projectWireImagesTail returns a projected copy of tail (raw indices starting at
// rawOffset) where every evicted ImageBlock (or all ImageBlocks when LearnedMaxImages==0)
// is replaced with a [Visual Digest — ...] TextBlock without mutating tail.
func projectWireImagesTail(tail []provider.Message, rawOffset int, state *CompactionState) []provider.Message {
	if state == nil || len(tail) == 0 {
		return tail
	}
	forceAll := state.LearnedMaxImages != nil && *state.LearnedMaxImages <= 0
	if !forceAll && len(state.EvictedImages) == 0 {
		return tail
	}

	var out []provider.Message
	for localIdx, m := range tail {
		msgIdx := rawOffset + localIdx
		replaced, changed := projectMessageImages(m, msgIdx, tail, localIdx, state.EvictedImages, state.ImageDigests, forceAll)
		if !changed {
			if out != nil {
				out = append(out, m)
			}
			continue
		}
		if out == nil {
			out = make([]provider.Message, 0, len(tail))
			out = append(out, tail[:localIdx]...)
		}
		out = append(out, replaced)
	}
	if out == nil {
		return tail
	}
	return out
}

func projectMessageImages(
	m provider.Message,
	msgIdx int,
	tail []provider.Message,
	localIdx int,
	evicted map[string]bool,
	digests map[string]string,
	forceAll bool,
) (provider.Message, bool) {
	changed := false
	blockOrd := 0
	newContent := make([]provider.Content, len(m.Content))

	resolveDigest := func(img provider.ImageBlock) string {
		key := provider.ImageKey(img)
		if d := strings.TrimSpace(digests[key]); d != "" {
			return d
		}
		return BuildDeterministicImageDigest(tail, localIdx, img)
	}

	for i, c := range m.Content {
		switch v := c.(type) {
		case provider.ImageBlock:
			imgKey := provider.ImageKey(v)
			if forceAll || isImageOccurrenceEvicted(evicted, msgIdx, blockOrd, imgKey) {
				newContent[i] = provider.TextBlock{Text: FormatVisualDigestBlock(v, resolveDigest(v))}
				changed = true
			} else {
				newContent[i] = c
			}
			blockOrd++
		case provider.ToolResultBlock:
			innerChanged := false
			newInner := make([]provider.Content, len(v.Content))
			for j, ic := range v.Content {
				if ib, ok := ic.(provider.ImageBlock); ok {
					imgKey := provider.ImageKey(ib)
					if forceAll || isImageOccurrenceEvicted(evicted, msgIdx, blockOrd, imgKey) {
						newInner[j] = provider.TextBlock{Text: FormatVisualDigestBlock(ib, resolveDigest(ib))}
						innerChanged = true
					} else {
						newInner[j] = ic
					}
					blockOrd++
				} else {
					newInner[j] = ic
				}
			}
			if innerChanged {
				cpTR := v
				cpTR.Content = newInner
				newContent[i] = cpTR
				changed = true
			} else {
				newContent[i] = c
			}
		default:
			newContent[i] = c
		}
	}
	if !changed {
		return m, false
	}
	cpMsg := m
	cpMsg.Content = newContent
	return cpMsg, true
}

// capPrefixWireImages caps live ImageBlocks in an already-projected message slice
// (used by runWarmPrefixDirective so warm-prefix summarization never overflows on
// image counts or payload bytes even when invoked before oneTurn).
func capPrefixWireImages(msgs []provider.Message, digests map[string]string, keepMax int, maxBytes int) []provider.Message {
	if keepMax < 0 {
		keepMax = 0
	}
	type pos struct {
		msgIdx int
		blkOrd int
		bytes  int
	}
	var all []pos
	totalBytes := 0
	for mi, m := range msgs {
		ord := 0
		for _, c := range m.Content {
			switch v := c.(type) {
			case provider.ImageBlock:
				all = append(all, pos{msgIdx: mi, blkOrd: ord, bytes: len(v.Data)})
				totalBytes += len(v.Data)
				ord++
			case provider.ToolResultBlock:
				for _, ic := range v.Content {
					if ib, ok := ic.(provider.ImageBlock); ok {
						all = append(all, pos{msgIdx: mi, blkOrd: ord, bytes: len(ib.Data)})
						totalBytes += len(ib.Data)
						ord++
					}
				}
			}
		}
	}
	if len(all) <= keepMax && (maxBytes <= 0 || totalBytes <= maxBytes) {
		return msgs
	}
	evict := make(map[string]bool)
	remCount := len(all)
	remBytes := totalBytes
	for _, p := range all {
		if remCount <= keepMax && (maxBytes <= 0 || remBytes <= maxBytes) {
			break
		}
		evict[fmt.Sprintf("%d:%d", p.msgIdx, p.blkOrd)] = true
		remCount--
		remBytes -= p.bytes
	}
	out := make([]provider.Message, len(msgs))
	for i, m := range msgs {
		replaced, changed := projectMessageImages(m, i, msgs, i, evict, digests, keepMax == 0)
		if changed {
			out[i] = replaced
		} else {
			out[i] = m
		}
	}
	return out
}
