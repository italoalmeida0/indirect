package searchindex

import (
	"slices"
	"strings"
	"sync"
)

type memPosting struct {
	docID uint32
	mask  uint8 // (1<<FieldUser) | (1<<FieldAssistant) | (1<<FieldTool)
	tfU   uint16
	tfA   uint16
	tfT   uint16
}

type memDoc struct {
	sessionID      string
	turnIndex      int32
	firstMsgIdx    int32
	bestMsgIdx     int32
	userMsgIdx     int32
	asstMsgIdx     int32
	toolMsgIdx     int32
	hasFieldMsgIdx bool
	deleted        bool
	updatedAt      int64
	norms          [numTurnFields]uint8
	fieldLens      [numTurnFields]uint32
	userExcerpt    string
	asstExcerpt    string
	toolExcerpt    string
}

func (d *memDoc) resolveMsgIdx(f Field) int {
	if d.hasFieldMsgIdx {
		switch f {
		case FieldUser:
			if d.userMsgIdx >= 0 {
				return int(d.userMsgIdx)
			}
		case FieldAssistant:
			if d.asstMsgIdx >= 0 {
				return int(d.asstMsgIdx)
			}
		case FieldTool:
			if d.toolMsgIdx >= 0 {
				return int(d.toolMsgIdx)
			}
		}
	}
	if d.bestMsgIdx >= d.firstMsgIdx {
		return int(d.bestMsgIdx)
	}
	return int(d.firstMsgIdx)
}

func (d *memDoc) excerptForField(f Field) string {
	switch f {
	case FieldUser:
		if d.userExcerpt != "" {
			return d.userExcerpt
		}
	case FieldAssistant:
		if d.asstExcerpt != "" {
			return d.asstExcerpt
		}
	case FieldTool:
		if d.toolExcerpt != "" {
			return d.toolExcerpt
		}
	}
	if d.asstExcerpt != "" {
		return d.asstExcerpt
	}
	if d.userExcerpt != "" {
		return d.userExcerpt
	}
	return d.toolExcerpt
}

type memTable struct {
	docs           []memDoc
	postings       map[string][]memPosting
	bySession      map[string]map[int32]uint32
	liveCount      int
	sumFieldTokens [numTurnFields]uint64
	approxBytes    int

	termsMu     sync.Mutex
	termsDirty  bool
	sortedTerms []string
}

func newMemTable() *memTable {
	return &memTable{
		docs:      make([]memDoc, 0, 256),
		postings:  make(map[string][]memPosting, 1024),
		bySession: make(map[string]map[int32]uint32, 32),
	}
}

func clampUint16(v uint32) uint16 {
	if v > 65535 {
		return 65535
	}
	return uint16(v)
}

// upsert inserts or replaces (doc.SessionID, doc.TurnIndex) in the MemTable.
func (m *memTable) upsert(doc TurnDoc) {
	if m.bySession != nil {
		if turns, ok := m.bySession[doc.SessionID]; ok {
			if prevID, exists := turns[int32(doc.TurnIndex)]; exists {
				m.markDeleted(prevID)
			}
		}
	}

	userTF, userLen := TokenizeField(doc.UserText, 0)
	asstTF, asstLen := TokenizeField(doc.AssistantText, 0)

	var toolTF map[string]uint32
	toolLen := 0
	if len(doc.ToolBlocks) > 0 {
		toolTF = make(map[string]uint32, 64)
		for _, blk := range doc.ToolBlocks {
			toolLen += accumulateFieldTokens(toolTF, blk, MaxToolBlockTokens)
		}
	} else if doc.ToolText != "" {
		toolTF, toolLen = TokenizeField(doc.ToolText, MaxToolBlockTokens)
	}

	userExc := TruncateExcerptRunes(doc.UserText, MaxSnippetStoreRunes)
	asstExc := TruncateExcerptRunes(doc.AssistantText, MaxSnippetStoreRunes)
	toolSrc := doc.ToolText
	if toolSrc == "" && len(doc.ToolBlocks) > 0 {
		toolSrc = strings.Join(doc.ToolBlocks, " ")
	}
	toolExc := TruncateExcerptRunes(toolSrc, MaxSnippetStoreRunes)

	docID := uint32(len(m.docs))
	md := memDoc{
		sessionID:      doc.SessionID,
		turnIndex:      int32(doc.TurnIndex),
		firstMsgIdx:    int32(doc.FirstMsgIdx),
		bestMsgIdx:     int32(doc.BestUserOrAsstMsgIdx),
		userMsgIdx:     int32(doc.UserMsgIdx),
		asstMsgIdx:     int32(doc.AssistantMsgIdx),
		toolMsgIdx:     int32(doc.ToolMsgIdx),
		hasFieldMsgIdx: doc.HasFieldMsgIdx,
		updatedAt:      doc.UpdatedAtUnix,
		norms: [numTurnFields]uint8{
			encodeNorm(userLen),
			encodeNorm(asstLen),
			encodeNorm(toolLen),
		},
		fieldLens: [numTurnFields]uint32{
			uint32(userLen),
			uint32(asstLen),
			uint32(toolLen),
		},
		userExcerpt: userExc,
		asstExcerpt: asstExc,
		toolExcerpt: toolExc,
	}
	m.docs = append(m.docs, md)
	m.liveCount++
	m.sumFieldTokens[0] += uint64(userLen)
	m.sumFieldTokens[1] += uint64(asstLen)
	m.sumFieldTokens[2] += uint64(toolLen)
	m.approxBytes += 96 + len(doc.SessionID) + len(userExc) + len(asstExc) + len(toolExc)

	turnsMap := m.bySession[doc.SessionID]
	if turnsMap == nil {
		turnsMap = make(map[int32]uint32, 8)
		m.bySession[doc.SessionID] = turnsMap
	}
	turnsMap[int32(doc.TurnIndex)] = docID

	// Merge unique terms across the 3 turn fields for this docID.
	combined := make(map[string]memPosting, len(userTF)+len(asstTF)+len(toolTF))
	for tok, tf := range userTF {
		p := combined[tok]
		p.docID = docID
		p.mask |= 1 << FieldUser
		p.tfU = clampUint16(tf)
		combined[tok] = p
	}
	for tok, tf := range asstTF {
		p := combined[tok]
		p.docID = docID
		p.mask |= 1 << FieldAssistant
		p.tfA = clampUint16(tf)
		combined[tok] = p
	}
	for tok, tf := range toolTF {
		p := combined[tok]
		p.docID = docID
		p.mask |= 1 << FieldTool
		p.tfT = clampUint16(tf)
		combined[tok] = p
	}

	if len(combined) > 0 {
		for tok, p := range combined {
			list, existed := m.postings[tok]
			if !existed {
				m.approxBytes += 32 + len(tok)
			}
			m.postings[tok] = append(list, p)
			m.approxBytes += 12
		}
		m.termsMu.Lock()
		m.termsDirty = true
		m.termsMu.Unlock()
	}
}

func (m *memTable) markDeleted(docID uint32) {
	if int(docID) >= len(m.docs) {
		return
	}
	d := &m.docs[docID]
	if d.deleted {
		return
	}
	d.deleted = true
	m.liveCount--
	for f := 0; f < numTurnFields; f++ {
		sub := uint64(d.fieldLens[f])
		if m.sumFieldTokens[f] >= sub {
			m.sumFieldTokens[f] -= sub
		} else {
			m.sumFieldTokens[f] = 0
		}
	}
}

func (m *memTable) deleteTurn(sessionID string, turnIndex int) {
	turns, ok := m.bySession[sessionID]
	if !ok {
		return
	}
	if docID, exists := turns[int32(turnIndex)]; exists {
		m.markDeleted(docID)
		delete(turns, int32(turnIndex))
		if len(turns) == 0 {
			delete(m.bySession, sessionID)
		}
	}
}

func (m *memTable) truncateFromTurn(sessionID string, minTurnIndex int) (maxRemaining int, hasRemaining bool) {
	maxRemaining = -1
	turns, ok := m.bySession[sessionID]
	if !ok {
		return -1, false
	}
	for t, docID := range turns {
		if int(t) >= minTurnIndex {
			m.markDeleted(docID)
			delete(turns, t)
		} else if !m.docs[docID].deleted {
			hasRemaining = true
			if int(t) > maxRemaining {
				maxRemaining = int(t)
			}
		}
	}
	if len(turns) == 0 {
		delete(m.bySession, sessionID)
	}
	return maxRemaining, hasRemaining
}

func (m *memTable) deleteSession(sessionID string) {
	turns, ok := m.bySession[sessionID]
	if !ok {
		return
	}
	for _, docID := range turns {
		m.markDeleted(docID)
	}
	delete(m.bySession, sessionID)
}

func (m *memTable) shouldFlush(opts Options) bool {
	return m.liveCount >= opts.MaxMemTurns || len(m.docs) >= opts.MaxMemTurns*2 || m.approxBytes >= opts.MaxMemBytes
}

func (m *memTable) getSortedTerms() []string {
	m.termsMu.Lock()
	defer m.termsMu.Unlock()
	if !m.termsDirty && m.sortedTerms != nil {
		return m.sortedTerms
	}
	terms := make([]string, 0, len(m.postings))
	for k := range m.postings {
		terms = append(terms, k)
	}
	slices.Sort(terms)
	m.sortedTerms = terms
	m.termsDirty = false
	return terms
}

// collectPrefixTerms scans sorted terms starting with prefix (excluding exact prefix)
// and accumulates live document frequencies into outDF.
func (m *memTable) collectPrefixTerms(prefix string, outDF map[string]uint32, limit int) {
	if m == nil || m.liveCount == 0 {
		return
	}
	terms := m.getSortedTerms()
	idx, _ := slices.BinarySearch(terms, prefix)
	scanned := 0
	for i := idx; i < len(terms); i++ {
		t := terms[i]
		if !strings.HasPrefix(t, prefix) {
			break
		}
		if t == prefix {
			continue
		}
		plist := m.postings[t]
		var liveDF uint32
		for _, p := range plist {
			if !m.docs[p.docID].deleted {
				liveDF++
			}
		}
		if liveDF > 0 {
			outDF[t] += liveDF
			scanned++
			if scanned >= limit {
				break
			}
		}
	}
}
