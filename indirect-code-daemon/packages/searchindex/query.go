package searchindex

import (
	"context"
	"encoding/binary"
	"math"
	"slices"
	"strings"
	"sync"
)

type hitSourceKind uint8

const (
	hitSourceNone hitSourceKind = iota
	hitSourceMem
	hitSourceSegment
)

type sessionAccum struct {
	touched       bool
	titleScore    float64
	matchTurns    int
	bestTurnScore float64
	bestTurnIdx   int32
	bestField     Field
	bestSource    hitSourceKind

	// When bestSource == hitSourceMem (copied under RLock so race-free after RUnlock):
	memMsgIdx  int
	memExcerpt string

	// When bestSource == hitSourceSegment (resolved lazily via .sdoc pread ONLY for Top-K):
	bestSeg   *diskSegment
	bestDocID uint32
}

type queryScratch struct {
	docTotal     []float32
	docLastGroup []float32
	docFields    []float32 // length = cap * 3
	touchedDocs  []uint32
	postingsBuf  []byte
	sessAcc      []sessionAccum
	touchedSess  []int
}

var queryScratchPool = sync.Pool{
	New: func() any {
		return &queryScratch{
			docTotal:     make([]float32, 4096),
			docLastGroup: make([]float32, 4096),
			docFields:    make([]float32, 4096*numTurnFields),
			touchedDocs:  make([]uint32, 0, 512),
			postingsBuf:  make([]byte, 16<<10),
			sessAcc:      make([]sessionAccum, 256),
			touchedSess:  make([]int, 0, 128),
		}
	},
}

func (qs *queryScratch) ensureDocCap(n int) {
	if cap(qs.docTotal) < n {
		qs.docTotal = make([]float32, n)
		qs.docLastGroup = make([]float32, n)
		qs.docFields = make([]float32, n*numTurnFields)
	} else {
		qs.docTotal = qs.docTotal[:n]
		qs.docLastGroup = qs.docLastGroup[:n]
		qs.docFields = qs.docFields[:n*numTurnFields]
	}
}

func (qs *queryScratch) clearTouchedDocs() {
	for _, docID := range qs.touchedDocs {
		qs.docTotal[docID] = 0
		qs.docLastGroup[docID] = 0
		base := int(docID) * numTurnFields
		qs.docFields[base] = 0
		qs.docFields[base+1] = 0
		qs.docFields[base+2] = 0
	}
	qs.touchedDocs = qs.touchedDocs[:0]
}

func (qs *queryScratch) ensureSessCap(n int) {
	if cap(qs.sessAcc) < n {
		qs.sessAcc = make([]sessionAccum, n)
	} else {
		qs.sessAcc = qs.sessAcc[:n]
	}
}

func (qs *queryScratch) clearTouchedSessions() {
	for _, idx := range qs.touchedSess {
		qs.sessAcc[idx] = sessionAccum{}
	}
	qs.touchedSess = qs.touchedSess[:0]
}

type snapSession struct {
	sessionID string
	title     string
	cwd       string
	updatedAt int64
	titleNorm uint8
}

type resolvedTerm struct {
	spec       queryTermSpec
	idf        float32
	segEntries []termDictEntry
	segFound   []bool
}

// Search executes a cancellable 4-field weighted BM25F query across the live
// session catalog, MemTable, and immutable disk segments.
func (e *Engine) Search(ctx context.Context, q Query) ([]SessionSearchResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	limit := q.Limit
	if limit <= 0 {
		limit = DefaultQueryLimit
	}
	if limit > MaxQueryLimit {
		limit = MaxQueryLimit
	}
	snippetRunes := q.SnippetRunes
	if snippetRunes <= 0 {
		snippetRunes = DefaultSnippetRunes
	}

	aq := analyzeQuery(q.Text, !q.DisablePrefix)
	if len(aq.terms) == 0 && len(aq.prefixTargets) == 0 {
		return []SessionSearchResult{}, nil
	}

	// Phase 1: Snapshot ref-counted disk segments + in-RAM prefix candidates under brief RLock.
	var prefixDF map[string]uint32
	if len(aq.prefixTargets) > 0 {
		prefixDF = make(map[string]uint32, 32)
	}

	e.mu.RLock()
	if e.closed {
		e.mu.RUnlock()
		return nil, ErrClosed
	}
	segs := make([]*diskSegment, 0, len(e.segments))
	for _, seg := range e.segments {
		if seg.incRef() {
			segs = append(segs, seg)
		}
	}
	for _, pfx := range aq.prefixTargets {
		e.mem.collectPrefixTerms(pfx, prefixDF, 64)
		if e.flushing != nil {
			e.flushing.collectPrefixTerms(pfx, prefixDF, 64)
		}
		e.collectTitlePrefixTerms(pfx, prefixDF, 64)
	}
	e.mu.RUnlock()

	defer func() {
		for _, seg := range segs {
			seg.decRef()
		}
	}()

	// Phase 2: Disk dictionary prefix expansion + exact dictionary lookups (NO LOCK HELD).
	if len(aq.prefixTargets) > 0 {
		for _, seg := range segs {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			for _, pfx := range aq.prefixTargets {
				if err := seg.collectPrefixTerms(pfx, prefixDF, 64); err != nil {
					return nil, err
				}
			}
		}
		expandPrefixTerms(&aq, prefixDF, MaxPrefixTerms)
	}

	if len(aq.terms) == 0 {
		return []SessionSearchResult{}, nil
	}

	numSegs := len(segs)
	terms := make([]resolvedTerm, len(aq.terms))
	for tIdx := range aq.terms {
		terms[tIdx].spec = aq.terms[tIdx]
		if numSegs > 0 {
			terms[tIdx].segEntries = make([]termDictEntry, numSegs)
			terms[tIdx].segFound = make([]bool, numSegs)
		}
	}
	var segDocTotal int64
	var segTokenSums [numTurnFields]int64
	maxSegDocCount := 0

	for sIdx, seg := range segs {
		live := int64(seg.liveCount.Load())
		if live > 0 {
			segDocTotal += live
		}
		for f := 0; f < numTurnFields; f++ {
			v := seg.sumFieldTokens[f].Load()
			if v > 0 {
				segTokenSums[f] += v
			}
		}
		if int(seg.docCount) > maxSegDocCount {
			maxSegDocCount = int(seg.docCount)
		}
		for tIdx := range aq.terms {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			ent, ok, err := seg.lookupTerm(aq.terms[tIdx].term)
			if err != nil {
				return nil, err
			}
			if ok {
				terms[tIdx].segEntries[sIdx] = ent
				terms[tIdx].segFound[sIdx] = true
			}
		}
	}

	// Acquire pooled scratch workspace.
	scratch := queryScratchPool.Get().(*queryScratch)
	defer func() {
		scratch.clearTouchedDocs()
		scratch.clearTouchedSessions()
		queryScratchPool.Put(scratch)
	}()

	// Phase 3: Compute global corpus IDF + Norm tables and score Title + MemTable under brief RLock.
	e.mu.RLock()
	if e.closed {
		e.mu.RUnlock()
		return nil, ErrClosed
	}

	sessCount := len(e.catalog)
	if sessCount == 0 {
		e.mu.RUnlock()
		return []SessionSearchResult{}, nil
	}

	sessions := make([]snapSession, 0, sessCount)
	sessSlotByID := make(map[string]int, sessCount)
	for sid, ent := range e.catalog {
		if q.CWDPrefix != "" && !strings.HasPrefix(ent.cwd, q.CWDPrefix) {
			continue
		}
		slot := len(sessions)
		sessions = append(sessions, snapSession{
			sessionID: sid,
			title:     ent.title,
			cwd:       ent.cwd,
			updatedAt: ent.updatedAt,
			titleNorm: ent.titleNorm,
		})
		sessSlotByID[sid] = slot
	}

	if len(sessions) == 0 {
		e.mu.RUnlock()
		return []SessionSearchResult{}, nil
	}
	scratch.ensureSessCap(len(sessions))

	totalTurnDocs := segDocTotal + int64(e.mem.liveCount)
	if e.flushing != nil {
		totalTurnDocs += int64(e.flushing.liveCount)
	}
	corpusDocs := totalTurnDocs
	if int64(len(e.catalog)) > corpusDocs {
		corpusDocs = int64(len(e.catalog))
	}
	if corpusDocs < 1 {
		corpusDocs = 1
	}

	avgTitleLen := 4.0
	if e.titledSessions > 0 && e.sumTitleTokens > 0 {
		avgTitleLen = float64(e.sumTitleTokens) / float64(e.titledSessions)
	}

	var avgTurnFieldLen [numTurnFields]float64
	for f := 0; f < numTurnFields; f++ {
		totTok := segTokenSums[f] + int64(e.mem.sumFieldTokens[f])
		if e.flushing != nil {
			totTok += int64(e.flushing.sumFieldTokens[f])
		}
		if totalTurnDocs > 0 && totTok > 0 {
			avgTurnFieldLen[f] = float64(totTok) / float64(totalTurnDocs)
		} else {
			avgTurnFieldLen[f] = 16.0
		}
		if avgTurnFieldLen[f] < 1.0 {
			avgTurnFieldLen[f] = 1.0
		}
	}

	// Precompute quantized norm denominator tables: k1 * (1 - b + b * dl / avgdl).
	var k1NormTitle [256]float32
	var k1NormTurn [numTurnFields][256]float32
	for qByte := 0; qByte < 256; qByte++ {
		dl := float64(decodeNorm(uint8(qByte)))
		k1NormTitle[qByte] = float32(BM25K1 * (1.0 - BM25B + BM25B*(dl/avgTitleLen)))
		for f := 0; f < numTurnFields; f++ {
			k1NormTurn[f][qByte] = float32(BM25K1 * (1.0 - BM25B + BM25B*(dl/avgTurnFieldLen[f])))
		}
	}

	// Compute global IDF for each term.
	nDocsF := float64(corpusDocs)
	for i := range terms {
		tok := terms[i].spec.term
		var df uint64
		for sIdx := range segs {
			if terms[i].segFound[sIdx] {
				df += uint64(terms[i].segEntries[sIdx].df)
			}
		}
		if mList := e.mem.postings[tok]; len(mList) > 0 {
			for _, mp := range mList {
				if !e.mem.docs[mp.docID].deleted {
					df++
				}
			}
		}
		if e.flushing != nil {
			if fList := e.flushing.postings[tok]; len(fList) > 0 {
				for _, mp := range fList {
					if !e.flushing.docs[mp.docID].deleted {
						df++
					}
				}
			}
		}
		if tMap := e.titlePostings[tok]; len(tMap) > 0 {
			df += uint64(len(tMap))
		}
		if df == 0 {
			terms[i].idf = 0
			continue
		}
		dfF := float64(df)
		if dfF > nDocsF {
			dfF = nDocsF
		}
		idf := math.Log(1.0 + (nDocsF-dfF+0.5)/(dfF+0.5))
		terms[i].idf = float32(idf * terms[i].spec.weight)
	}

	// Score FieldTitle directly against the O(1) live session catalog!
	titleLastGroupBest := make(map[int]float32, 16)
	for i := range terms {
		wIDF := terms[i].idf
		if wIDF <= 0 {
			continue
		}
		tMap := e.titlePostings[terms[i].spec.term]
		if len(tMap) == 0 {
			continue
		}
		isLastGrp := aq.lastGroupID > 0 && terms[i].spec.groupID == aq.lastGroupID
		for sid, tf := range tMap {
			slot, ok := sessSlotByID[sid]
			if !ok {
				continue
			}
			tfF := float32(tf)
			denom := tfF + k1NormTitle[sessions[slot].titleNorm]
			s := wIDF * float32(BoostTitle) * (tfF * float32(BM25K1+1.0)) / denom

			acc := &scratch.sessAcc[slot]
			if !acc.touched {
				acc.touched = true
				scratch.touchedSess = append(scratch.touchedSess, slot)
			}
			if isLastGrp {
				prev := titleLastGroupBest[slot]
				if s > prev {
					acc.titleScore += float64(s - prev)
					titleLastGroupBest[slot] = s
				}
			} else {
				acc.titleScore += float64(s)
			}
		}
	}

	// Score MemTable (and any in-flight flushing MemTable) under RLock.
	if e.flushing != nil && e.flushing.liveCount > 0 {
		scoreMemTableInto(e.flushing, terms, aq.lastGroupID, &k1NormTurn, sessSlotByID, scratch)
	}
	if e.mem != nil && e.mem.liveCount > 0 {
		scoreMemTableInto(e.mem, terms, aq.lastGroupID, &k1NormTurn, sessSlotByID, scratch)
	}
	e.mu.RUnlock()

	if err := ctx.Err(); err != nil {
		return nil, err
	}

	// Phase 4: Traverse disk segment postings lists with ZERO locks held!
	if maxSegDocCount > 0 {
		scratch.ensureDocCap(maxSegDocCount)
	}
	for sIdx, seg := range segs {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if seg.liveCount.Load() <= 0 {
			continue
		}
		if err := scoreDiskSegment(ctx, seg, sIdx, terms, aq.lastGroupID, &k1NormTurn, sessSlotByID, scratch); err != nil {
			return nil, err
		}
	}

	if len(scratch.touchedSess) == 0 {
		return []SessionSearchResult{}, nil
	}

	// Aggregate per-session candidates and rank!
	type rankedCandidate struct {
		slot  int
		score float64
	}
	var maxUpdated int64
	for _, slot := range scratch.touchedSess {
		if sessions[slot].updatedAt > maxUpdated {
			maxUpdated = sessions[slot].updatedAt
		}
	}

	cands := make([]rankedCandidate, 0, len(scratch.touchedSess))
	for _, slot := range scratch.touchedSess {
		acc := &scratch.sessAcc[slot]
		if acc.titleScore <= 0 && acc.matchTurns == 0 {
			continue
		}
		var baseScore float64
		if acc.matchTurns > 0 {
			density := 0.15 * acc.bestTurnScore * math.Log1p(float64(acc.matchTurns-1))
			if density > 0.60*acc.bestTurnScore {
				density = 0.60 * acc.bestTurnScore
			}
			turnPlus := acc.bestTurnScore + density
			if acc.titleScore > 0 {
				hi := math.Max(acc.titleScore, turnPlus)
				lo := math.Min(acc.titleScore, turnPlus)
				baseScore = hi + 0.35*lo
			} else {
				baseScore = turnPlus
			}
		} else {
			baseScore = acc.titleScore
		}

		// Subtle recency tie-breaker (bounded <= 0.01 so relevance always dominates).
		var recency float64
		if maxUpdated > 0 && sessions[slot].updatedAt > 0 {
			ageDays := float64(maxUpdated-sessions[slot].updatedAt) / 86400.0
			if ageDays < 0 {
				ageDays = 0
			}
			recency = 0.01 / (1.0 + ageDays/30.0)
		}
		cands = append(cands, rankedCandidate{
			slot:  slot,
			score: baseScore + recency,
		})
	}

	slices.SortFunc(cands, func(a, b rankedCandidate) int {
		diff := a.score - b.score
		if diff > 1e-9 {
			return -1
		}
		if diff < -1e-9 {
			return 1
		}
		sa := &sessions[a.slot]
		sb := &sessions[b.slot]
		if sa.updatedAt != sb.updatedAt {
			if sa.updatedAt > sb.updatedAt {
				return -1
			}
			return 1
		}
		return strings.Compare(sa.sessionID, sb.sessionID)
	})

	if len(cands) > limit {
		cands = cands[:limit]
	}

	// Materialize Top-K snippets via .sdoc pread ONLY for the winning sessions!
	results := make([]SessionSearchResult, 0, len(cands))
	for _, c := range cands {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		sess := &sessions[c.slot]
		acc := &scratch.sessAcc[c.slot]

		matchCount := acc.matchTurns
		if acc.titleScore > 0 {
			matchCount++
		}

		res := SessionSearchResult{
			SessionID:  sess.sessionID,
			Title:      sess.title,
			CWD:        sess.cwd,
			UpdatedAt:  sess.updatedAt,
			MatchCount: matchCount,
			Score:      c.score,
			MessageIdx: -1,
			TurnIndex:  -1,
			Field:      FieldTitle.String(),
		}

		if acc.matchTurns == 0 {
			res.Field = FieldTitle.String()
			res.Snippet = extractSnippetWithTerms(sess.title, aq.highlight, snippetRunes)
			results = append(results, res)
			continue
		}

		res.TurnIndex = int(acc.bestTurnIdx)
		winField := acc.bestField
		if acc.titleScore > acc.bestTurnScore {
			res.Field = FieldTitle.String()
		} else {
			res.Field = winField.String()
		}

		switch acc.bestSource {
		case hitSourceMem:
			res.MessageIdx = acc.memMsgIdx
			srcText := acc.memExcerpt
			if srcText == "" {
				srcText = sess.title
			}
			res.Snippet = extractSnippetWithTerms(srcText, aq.highlight, snippetRunes)

		case hitSourceSegment:
			stDoc, err := acc.bestSeg.readStoredDoc(acc.bestDocID)
			if err != nil {
				return nil, err
			}
			res.MessageIdx = stDoc.resolveMsgIdx(winField)
			srcText := stDoc.excerptForField(winField)
			if srcText == "" {
				srcText = sess.title
			}
			res.Snippet = extractSnippetWithTerms(srcText, aq.highlight, snippetRunes)
		}

		results = append(results, res)
	}

	return results, nil
}

func expandPrefixTerms(aq *analyzedQuery, prefixDF map[string]uint32, maxTerms int) {
	if len(prefixDF) == 0 || maxTerms <= 0 {
		return
	}
	existing := make(map[string]bool, len(aq.terms))
	for _, t := range aq.terms {
		existing[t.term] = true
	}

	type pfxCand struct {
		term string
		df   uint32
	}
	cands := make([]pfxCand, 0, len(prefixDF))
	for t, df := range prefixDF {
		if df == 0 || existing[t] {
			continue
		}
		cands = append(cands, pfxCand{term: t, df: df})
	}
	if len(cands) == 0 {
		return
	}
	slices.SortFunc(cands, func(a, b pfxCand) int {
		if a.df != b.df {
			if a.df > b.df {
				return -1
			}
			return 1
		}
		return strings.Compare(a.term, b.term)
	})
	if len(cands) > maxTerms {
		cands = cands[:maxTerms]
	}
	for _, c := range cands {
		aq.terms = append(aq.terms, queryTermSpec{
			term:     c.term,
			weight:   PrefixWeight,
			isPrefix: true,
			groupID:  aq.lastGroupID,
		})
	}
}

func combineTurnFieldTermScore(sU, sA, sT float32) float32 {
	// Per-term cross-field BM25F combination: full credit to best matching field
	// plus dampened reinforcement from secondary fields in the same turn.
	best := sU
	if sA > best {
		best = sA
	}
	if sT > best {
		best = sT
	}
	other := (sU + sA + sT) - best
	return best + 0.35*other
}

func scoreMemTableInto(
	m *memTable,
	terms []resolvedTerm,
	lastGroupID int,
	k1Norm *[numTurnFields][256]float32,
	sessSlotByID map[string]int,
	scratch *queryScratch,
) {
	if len(m.docs) == 0 {
		return
	}
	scratch.ensureDocCap(len(m.docs))
	scratch.clearTouchedDocs()

	for i := range terms {
		wIDF := terms[i].idf
		if wIDF <= 0 {
			continue
		}
		plist := m.postings[terms[i].spec.term]
		if len(plist) == 0 {
			continue
		}
		isLastGrp := lastGroupID > 0 && terms[i].spec.groupID == lastGroupID
		k1Plus1 := float32(BM25K1 + 1.0)

		for _, p := range plist {
			doc := &m.docs[p.docID]
			if doc.deleted {
				continue
			}
			var sU, sA, sT float32
			if p.mask&(1<<FieldUser) != 0 {
				tf := float32(p.tfU)
				sU = wIDF * float32(BoostUser) * (tf * k1Plus1) / (tf + k1Norm[0][doc.norms[0]])
			}
			if p.mask&(1<<FieldAssistant) != 0 {
				tf := float32(p.tfA)
				sA = wIDF * float32(BoostAssistant) * (tf * k1Plus1) / (tf + k1Norm[1][doc.norms[1]])
			}
			if p.mask&(1<<FieldTool) != 0 {
				tf := float32(p.tfT)
				sT = wIDF * float32(BoostTool) * (tf * k1Plus1) / (tf + k1Norm[2][doc.norms[2]])
			}
			combined := combineTurnFieldTermScore(sU, sA, sT)
			if combined <= 0 {
				continue
			}

			if scratch.docTotal[p.docID] == 0 && scratch.docLastGroup[p.docID] == 0 {
				scratch.touchedDocs = append(scratch.touchedDocs, p.docID)
			}
			if isLastGrp {
				prev := scratch.docLastGroup[p.docID]
				if combined > prev {
					scratch.docTotal[p.docID] += combined - prev
					scratch.docLastGroup[p.docID] = combined
				}
			} else {
				scratch.docTotal[p.docID] += combined
			}
			fb := int(p.docID) * numTurnFields
			scratch.docFields[fb] += sU
			scratch.docFields[fb+1] += sA
			scratch.docFields[fb+2] += sT
		}
	}

	for _, docID := range scratch.touchedDocs {
		turnScore := float64(scratch.docTotal[docID])
		if turnScore <= 0 {
			continue
		}
		doc := &m.docs[docID]
		slot, ok := sessSlotByID[doc.sessionID]
		if !ok {
			continue
		}
		fb := int(docID) * numTurnFields
		winField := pickBestTurnField(scratch.docFields[fb], scratch.docFields[fb+1], scratch.docFields[fb+2])

		acc := &scratch.sessAcc[slot]
		if !acc.touched {
			acc.touched = true
			scratch.touchedSess = append(scratch.touchedSess, slot)
		}
		acc.matchTurns++
		if turnScore > acc.bestTurnScore || (math.Abs(turnScore-acc.bestTurnScore) <= 1e-6 && doc.turnIndex >= acc.bestTurnIdx) {
			acc.bestTurnScore = turnScore
			acc.bestTurnIdx = doc.turnIndex
			acc.bestField = winField
			acc.bestSource = hitSourceMem
			acc.memMsgIdx = doc.resolveMsgIdx(winField)
			acc.memExcerpt = doc.excerptForField(winField)
			acc.bestSeg = nil
		}
	}
	scratch.clearTouchedDocs()
}

func scoreDiskSegment(
	ctx context.Context,
	seg *diskSegment,
	segIdx int,
	terms []resolvedTerm,
	lastGroupID int,
	k1Norm *[numTurnFields][256]float32,
	sessSlotByID map[string]int,
	scratch *queryScratch,
) error {
	// Map segment-local session index -> query session slot (-1 if filtered/deleted).
	localToSlot := make([]int, len(seg.sessions))
	anyActiveSession := false
	for i, sp := range seg.sessions {
		if slot, ok := sessSlotByID[sp.sessionID]; ok {
			localToSlot[i] = slot
			anyActiveSession = true
		} else {
			localToSlot[i] = -1
		}
	}
	if !anyActiveSession {
		return nil
	}

	scratch.clearTouchedDocs()
	k1Plus1 := float32(BM25K1 + 1.0)
	norms := seg.norms

	for tIdx := range terms {
		if !terms[tIdx].segFound[segIdx] || terms[tIdx].idf <= 0 {
			continue
		}
		if err := ctx.Err(); err != nil {
			scratch.clearTouchedDocs()
			return err
		}

		ent := terms[tIdx].segEntries[segIdx]
		if cap(scratch.postingsBuf) < int(ent.postingsLen) {
			scratch.postingsBuf = make([]byte, ent.postingsLen)
		} else {
			scratch.postingsBuf = scratch.postingsBuf[:ent.postingsLen]
		}
		if _, err := seg.idxFile.ReadAt(scratch.postingsBuf, int64(ent.postingsOff)); err != nil {
			scratch.clearTouchedDocs()
			return err
		}

		wIDF := terms[tIdx].idf
		isLastGrp := lastGroupID > 0 && terms[tIdx].spec.groupID == lastGroupID

		buf := scratch.postingsBuf
		pos := 0
		chunkBaseDoc := uint32(0)

		for pos < len(buf) {
			// Regular context check every <=128 postings chunk (<0.02ms granularity!).
			if err := ctx.Err(); err != nil {
				scratch.clearTouchedDocs()
				return err
			}
			if pos+8 > len(buf) {
				scratch.clearTouchedDocs()
				return errCorruptSegment
			}
			count := int(buf[pos]) + 1
			payloadLen := int(binary.LittleEndian.Uint16(buf[pos+1 : pos+3]))
			pos += 8
			if pos+payloadLen > len(buf) {
				scratch.clearTouchedDocs()
				return errCorruptSegment
			}
			chunkEnd := pos + payloadLen
			prevDoc := chunkBaseDoc

			for i := 0; i < count; i++ {
				delta, n1 := binary.Uvarint(buf[pos:chunkEnd])
				if n1 <= 0 {
					scratch.clearTouchedDocs()
					return errCorruptSegment
				}
				pos += n1
				var docID uint32
				if i == 0 {
					docID = chunkBaseDoc + uint32(delta)
				} else {
					docID = prevDoc + uint32(delta) + 1
				}
				prevDoc = docID
				if pos >= chunkEnd {
					scratch.clearTouchedDocs()
					return errCorruptSegment
				}
				fm := buf[pos]
				pos++
				mask := fm & ((1 << FieldUser) | (1 << FieldAssistant) | (1 << FieldTool))

				var tfU, tfA, tfT uint32
				if fm&flagAllTFOne != 0 {
					tfU, tfA, tfT = 1, 1, 1
				} else {
					if mask&(1<<FieldUser) != 0 {
						v, n2 := binary.Uvarint(buf[pos:chunkEnd])
						if n2 <= 0 {
							scratch.clearTouchedDocs()
							return errCorruptSegment
						}
						pos += n2
						tfU = uint32(v)
					}
					if mask&(1<<FieldAssistant) != 0 {
						v, n2 := binary.Uvarint(buf[pos:chunkEnd])
						if n2 <= 0 {
							scratch.clearTouchedDocs()
							return errCorruptSegment
						}
						pos += n2
						tfA = uint32(v)
					}
					if mask&(1<<FieldTool) != 0 {
						v, n2 := binary.Uvarint(buf[pos:chunkEnd])
						if n2 <= 0 {
							scratch.clearTouchedDocs()
							return errCorruptSegment
						}
						pos += n2
						tfT = uint32(v)
					}
				}

				if seg.isDeleted(docID) {
					continue
				}
				if localToSlot[seg.docSessIdx[docID]] < 0 {
					continue
				}

				nb := int(docID) * numTurnFields
				var sU, sA, sT float32
				if mask&(1<<FieldUser) != 0 {
					tf := float32(tfU)
					sU = wIDF * float32(BoostUser) * (tf * k1Plus1) / (tf + k1Norm[0][norms[nb]])
				}
				if mask&(1<<FieldAssistant) != 0 {
					tf := float32(tfA)
					sA = wIDF * float32(BoostAssistant) * (tf * k1Plus1) / (tf + k1Norm[1][norms[nb+1]])
				}
				if mask&(1<<FieldTool) != 0 {
					tf := float32(tfT)
					sT = wIDF * float32(BoostTool) * (tf * k1Plus1) / (tf + k1Norm[2][norms[nb+2]])
				}

				combined := combineTurnFieldTermScore(sU, sA, sT)
				if combined <= 0 {
					continue
				}

				if scratch.docTotal[docID] == 0 && scratch.docLastGroup[docID] == 0 {
					scratch.touchedDocs = append(scratch.touchedDocs, docID)
				}
				if isLastGrp {
					prev := scratch.docLastGroup[docID]
					if combined > prev {
						scratch.docTotal[docID] += combined - prev
						scratch.docLastGroup[docID] = combined
					}
				} else {
					scratch.docTotal[docID] += combined
				}
				scratch.docFields[nb] += sU
				scratch.docFields[nb+1] += sA
				scratch.docFields[nb+2] += sT
			}
			chunkBaseDoc = prevDoc + 1
		}
	}

	// Fold touched segment docs into session accumulators.
	for _, docID := range scratch.touchedDocs {
		turnScore := float64(scratch.docTotal[docID])
		if turnScore <= 0 {
			continue
		}
		slot := localToSlot[seg.docSessIdx[docID]]
		if slot < 0 {
			continue
		}
		nb := int(docID) * numTurnFields
		winField := pickBestTurnField(scratch.docFields[nb], scratch.docFields[nb+1], scratch.docFields[nb+2])
		turnIdx := seg.docTurns[docID]

		acc := &scratch.sessAcc[slot]
		if !acc.touched {
			acc.touched = true
			scratch.touchedSess = append(scratch.touchedSess, slot)
		}
		acc.matchTurns++
		if turnScore > acc.bestTurnScore || (math.Abs(turnScore-acc.bestTurnScore) <= 1e-6 && turnIdx >= acc.bestTurnIdx) {
			acc.bestTurnScore = turnScore
			acc.bestTurnIdx = turnIdx
			acc.bestField = winField
			acc.bestSource = hitSourceSegment
			acc.bestSeg = seg
			acc.bestDocID = docID
		}
	}
	scratch.clearTouchedDocs()
	return nil
}

func pickBestTurnField(sU, sA, sT float32) Field {
	if sU >= sA && sU >= sT {
		return FieldUser
	}
	if sA >= sU && sA >= sT {
		return FieldAssistant
	}
	return FieldTool
}
