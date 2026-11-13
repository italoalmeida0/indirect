package main

import (
	"context"
	"fmt"
	"hash/fnv"
	"os"
	"path/filepath"
	"sync"
	"time"

	"indirect/indirect-code-daemon/packages/provider"
	"indirect/indirect-code-daemon/packages/searchindex"
	"indirect/indirect-code-daemon/packages/sessionstore"
)

var (
	searchEnginesMu    sync.Mutex
	searchEngines      = map[string]*searchindex.Engine{}
	searchSessionLocks [64]sync.Mutex
)

func searchSessionMutex(dataDir, id string) *sync.Mutex {
	h := fnv.New64a()
	_, _ = h.Write([]byte(filepath.Clean(dataDir)))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(id))
	return &searchSessionLocks[h.Sum64()%uint64(len(searchSessionLocks))]
}

func purgeSessionFromSearch(dataDir string, eng *searchindex.Engine, id string) {
	if eng == nil || !validSessionID(id) {
		return
	}
	mu := searchSessionMutex(dataDir, id)
	mu.Lock()
	defer mu.Unlock()
	_ = eng.DeleteSession(id)
}

func indexSessionTurnsIfAlive(dataDir string, eng *searchindex.Engine, id string, meta searchindex.SessionMeta, docs []searchindex.TurnDoc, isDeleted func(string) bool) bool {
	mu := searchSessionMutex(dataDir, id)
	mu.Lock()
	defer mu.Unlock()
	if sessionPurged(dataDir, id) || (isDeleted != nil && isDeleted(id)) {
		return false
	}
	_ = eng.IndexSessionTurns(id, meta, docs)
	return true
}

func getSearchEngine(dataDir string) *searchindex.Engine {
	if dataDir == "" {
		return nil
	}
	clean := filepath.Clean(dataDir)
	searchEnginesMu.Lock()
	defer searchEnginesMu.Unlock()
	if eng, ok := searchEngines[clean]; ok && eng != nil {
		return eng
	}
	eng, err := searchindex.Open(filepath.Join(clean, "search"))
	if err != nil {
		fmt.Printf("[WARN] searchindex open (%s): %v\n", clean, err)
		return nil
	}
	searchEngines[clean] = eng
	return eng
}

func closeSearchEngine(dataDir string) {
	if dataDir == "" {
		return
	}
	clean := filepath.Clean(dataDir)
	searchEnginesMu.Lock()
	eng := searchEngines[clean]
	delete(searchEngines, clean)
	searchEnginesMu.Unlock()
	if eng != nil {
		_ = eng.Close()
	}
}

func buildSearchExtractOpts(rec *SessionRecord) *searchindex.ExtractOptions {
	if rec == nil {
		return nil
	}
	hasAtt := len(rec.Attachments) > 0
	hasWid := len(rec.Widgets) > 0
	hasComp := rec.Compaction != nil && len(rec.Compaction.Blocks) > 0
	if !hasAtt && !hasWid && !hasComp {
		return nil
	}
	opts := &searchindex.ExtractOptions{}
	if hasAtt {
		atts := append([]AttachmentRef(nil), rec.Attachments...)
		opts.ResolveAttachmentText = func(attachmentID string) string {
			for _, a := range atts {
				if a.ID == attachmentID && a.TextPath != "" {
					data, err := os.ReadFile(a.TextPath)
					if err != nil {
						return ""
					}
					if len(data) > 256*1024 {
						data = data[:256*1024]
					}
					return string(data)
				}
			}
			return ""
		}
	}
	if hasWid {
		opts.Widgets = make([]searchindex.WidgetMeta, 0, len(rec.Widgets))
		for _, w := range rec.Widgets {
			opts.Widgets = append(opts.Widgets, searchindex.WidgetMeta{
				ID:          w.ID,
				Placeholder: w.Placeholder,
			})
		}
	}
	if hasComp {
		opts.CompactionBlocks = make([]searchindex.CompactionBlockMeta, 0, len(rec.Compaction.Blocks))
		for _, b := range rec.Compaction.Blocks {
			opts.CompactionBlocks = append(opts.CompactionBlocks, searchindex.CompactionBlockMeta{
				ID:       b.ID,
				Topic:    b.Topic,
				Summary:  b.Summary,
				StartIdx: b.StartIdx,
				EndIdx:   b.EndIdx,
			})
		}
	}
	return opts
}

func indexTurnSliceIntoSearch(eng *searchindex.Engine, rec *SessionRecord, turnIndex int, firstMsgIdx int, turnMsgs []provider.Message) {
	if eng == nil || rec == nil || len(turnMsgs) == 0 {
		return
	}
	opts := buildSearchExtractOpts(rec)
	doc, ok := searchindex.ExtractTurnDoc(rec.ID, turnIndex, turnMsgs, firstMsgIdx, opts)
	if !ok {
		return
	}
	doc.UpdatedAtUnix = rec.UpdatedAt
	_ = eng.IndexTurn(doc)
}

// indexColdSessionIntoSearch streams turns from disk into eng without spawning
// a sessionActor or retaining full multi-thousand-turn sessions in RAM.
func indexColdSessionIntoSearch(st *diskStore, eng *searchindex.Engine, id string) {
	indexColdSessionIntoSearchFenced(st, eng, id, nil)
}

func indexColdSessionIntoSearchFenced(st *diskStore, eng *searchindex.Engine, id string, isDeleted func(string) bool) {
	if st == nil || eng == nil || !validSessionID(id) {
		return
	}
	if sessionPurged(st.dataDir, id) || (isDeleted != nil && isDeleted(id)) {
		return
	}
	if st.v2.HasV2Session(id) {
		meta, err := st.readMeta(id)
		if err != nil {
			return
		}
		recMeta := recordFromMeta(meta)
		fullOpts := buildSearchExtractOpts(recMeta)
		sMeta := searchindex.SessionMeta{
			Title:     meta.Title,
			CWD:       meta.CWD,
			UpdatedAt: meta.UpdatedAt,
		}
		entries, err := st.v2.ReadTurnIndex(id)
		if err != nil && !os.IsNotExist(err) {
			return
		}
		if len(entries) == 0 {
			var docs []searchindex.TurnDoc
			if fullOpts != nil && (len(fullOpts.Widgets) > 0 || len(fullOpts.CompactionBlocks) > 0) {
				docs = searchindex.ExtractSessionTurns(id, nil, fullOpts)
			}
			indexSessionTurnsIfAlive(st.dataDir, eng, id, sMeta, docs, isDeleted)
			return
		}

		// Stream v2 turns in bounded 64-turn chunks so peak RAM stays tiny.
		var attOnlyOpts *searchindex.ExtractOptions
		if fullOpts != nil && fullOpts.ResolveAttachmentText != nil {
			attOnlyOpts = &searchindex.ExtractOptions{ResolveAttachmentText: fullOpts.ResolveAttachmentText}
		}

		const batchTurns = 64
		registeredMeta := false
		for start := 0; start < len(entries); start += batchTurns {
			if sessionPurged(st.dataDir, id) || (isDeleted != nil && isDeleted(id)) {
				return
			}
			end := min(start+batchTurns, len(entries))
			firstSeq := entries[start].TurnSeq
			lastSeq := entries[end-1].TurnSeq
			msgs, _, rerr := st.v2.ReadTurnRange(id, firstSeq, lastSeq)
			if rerr != nil {
				return
			}
			baseMsgIdx := entries[start].FirstMsgIdx
			batchDocs := make([]searchindex.TurnDoc, 0, end-start)
			for i := start; i < end; i++ {
				ent := entries[i]
				lo := ent.FirstMsgIdx - baseMsgIdx
				hi := ent.LastMsgIdx + 1 - baseMsgIdx
				if lo < 0 || hi > len(msgs) || lo >= hi {
					continue
				}
				opts := attOnlyOpts
				if i == len(entries)-1 {
					opts = fullOpts
				}
				doc, ok := searchindex.ExtractTurnDoc(id, ent.TurnSeq, msgs[lo:hi], ent.FirstMsgIdx, opts)
				if ok {
					doc.UpdatedAtUnix = meta.UpdatedAt
					batchDocs = append(batchDocs, doc)
				}
			}
			if !registeredMeta || len(batchDocs) > 0 {
				if !indexSessionTurnsIfAlive(st.dataDir, eng, id, sMeta, batchDocs, isDeleted) {
					return
				}
				registeredMeta = true
			}
		}
		if !registeredMeta {
			indexSessionTurnsIfAlive(st.dataDir, eng, id, sMeta, nil, isDeleted)
		}
		return
	}

	if st.v2.HasLegacySession(id) {
		lines, meta, err := st.readSessionFile(id)
		if err != nil {
			return
		}
		rec := assembleRecord(lines, meta)
		docs := searchindex.ExtractSessionTurns(id, rec.Messages, buildSearchExtractOpts(rec))
		indexSessionTurnsIfAlive(st.dataDir, eng, id, searchindex.SessionMeta{
			Title:     meta.Title,
			CWD:       meta.CWD,
			UpdatedAt: meta.UpdatedAt,
		}, docs, isDeleted)
	}
}

type maintenanceWorker struct {
	rootDir string
	dataDir string
	sup     *sessionSupervisor
	search  *searchindex.Engine

	ctx      context.Context
	cancel   context.CancelFunc
	done     chan struct{}
	stopOnce sync.Once
}

func defaultMaintenanceGCPolicy() sessionstore.GCPolicy {
	return sessionstore.GCPolicy{
		CompressLogsAfter: 24 * time.Hour,
		DeleteLogsAfter:   30 * 24 * time.Hour,
		MaxDaemonLogBytes: 16 << 20,
	}
}

func startMaintenanceWorker(rootDir, dataDir string, sup *sessionSupervisor, search *searchindex.Engine) *maintenanceWorker {
	ctx, cancel := context.WithCancel(context.Background())
	m := &maintenanceWorker{
		rootDir: rootDir,
		dataDir: dataDir,
		sup:     sup,
		search:  search,
		ctx:     ctx,
		cancel:  cancel,
		done:    make(chan struct{}),
	}
	go m.loop()
	return m
}

func (m *maintenanceWorker) stop() {
	if m == nil {
		return
	}
	m.stopOnce.Do(func() {
		if m.cancel != nil {
			m.cancel()
		}
		select {
		case <-m.done:
		case <-time.After(5 * time.Second):
		}
	})
}

func (m *maintenanceWorker) isSessionResidentOrWAL(st *diskStore, id string) bool {
	if sessionPurged(m.dataDir, id) {
		return true
	}
	if _, err := os.Stat(st.walPath(id)); err == nil {
		return true
	}
	if m.sup != nil {
		m.sup.mu.Lock()
		_, live := m.sup.resident[id]
		del := m.sup.deleted[id]
		m.sup.mu.Unlock()
		if live || del {
			return true
		}
	}
	return false
}

func (m *maintenanceWorker) yieldWhileBusy(ctx context.Context) bool {
	for m.sup != nil && m.sup.hasActiveTurn() {
		select {
		case <-ctx.Done():
			return false
		case <-time.After(100 * time.Millisecond):
		}
	}
	return ctx.Err() == nil
}

// backfillSearch indexes any unindexed sessions on disk without spawning actors,
// then flushes the MemTable so segments are durable on disk.
func (m *maintenanceWorker) backfillSearch(ctx context.Context) {
	eng := m.search
	if eng == nil {
		eng = getSearchEngine(m.dataDir)
	}
	if eng == nil {
		return
	}
	st := newDiskStore(m.dataDir)
	isDeleted := func(id string) bool {
		return sessionPurged(m.dataDir, id) || (m.sup != nil && m.sup.isDeleted(id))
	}
	indexedAny := false
	for _, sid := range st.listSessionIDs() {
		if !m.yieldWhileBusy(ctx) {
			return
		}
		if isDeleted(sid) {
			continue
		}
		if _, ok := eng.HasSession(sid); !ok {
			indexColdSessionIntoSearchFenced(st, eng, sid, isDeleted)
			indexedAny = true
		}
	}
	if indexedAny && ctx.Err() == nil {
		_ = eng.Flush()
	}
}

// runOnce executes one complete idle maintenance cycle (search backfill,
// cold legacy .jsonl -> v2 migration, warm -> cold .zst aging, search segment
// compaction, and runner/CAS/log disk GC).
func (m *maintenanceWorker) runOnce(ctx context.Context) {
	if ctx == nil {
		ctx = context.Background()
	}
	if !m.yieldWhileBusy(ctx) {
		return
	}
	m.backfillSearch(ctx)

	st := newDiskStore(m.dataDir)
	agePolicy := defaultSessionAgePolicy()
	for _, sid := range st.listSessionIDs() {
		if !m.yieldWhileBusy(ctx) {
			return
		}
		if m.isSessionResidentOrWAL(st, sid) {
			continue
		}
		if !st.v2.HasV2Session(sid) && st.v2.HasLegacySession(sid) {
			_ = st.v2.MigrateLegacyFile(ctx, st.sessionFile(sid), agePolicy)
			continue
		}
		if st.v2.HasV2Session(sid) {
			_, _ = st.v2.AgeSession(ctx, sid, agePolicy)
		}
	}

	if !m.yieldWhileBusy(ctx) {
		return
	}
	eng := m.search
	if eng == nil {
		eng = getSearchEngine(m.dataDir)
	}
	if eng != nil {
		_ = eng.Compact(ctx)
	}

	if !m.yieldWhileBusy(ctx) {
		return
	}
	_, _ = sessionstore.RunDiskGC(ctx, m.rootDir, m.dataDir, defaultMaintenanceGCPolicy())
}

func (m *maintenanceWorker) loop() {
	defer close(m.done)

	// Brief startup grace before background backfill so boot path stays crisp.
	select {
	case <-m.ctx.Done():
		return
	case <-time.After(150 * time.Millisecond):
	}

	m.backfillSearch(m.ctx)
	if m.ctx.Err() != nil {
		return
	}

	// Incremental cold legacy migration + periodic aging/compaction/GC.
	migrateTick := time.NewTicker(5 * time.Second)
	defer migrateTick.Stop()
	gcTick := time.NewTicker(15 * time.Minute)
	defer gcTick.Stop()

	for {
		select {
		case <-m.ctx.Done():
			return
		case <-migrateTick.C:
			if !m.yieldWhileBusy(m.ctx) {
				return
			}
			st := newDiskStore(m.dataDir)
			migrated := 0
			for _, sid := range st.listSessionIDs() {
				if !m.yieldWhileBusy(m.ctx) {
					return
				}
				if m.isSessionResidentOrWAL(st, sid) {
					continue
				}
				if !st.v2.HasV2Session(sid) && st.v2.HasLegacySession(sid) {
					_ = st.v2.MigrateLegacyFile(m.ctx, st.sessionFile(sid), defaultSessionAgePolicy())
					migrated++
					if migrated >= 2 {
						break
					}
				}
			}
		case <-gcTick.C:
			m.runOnce(m.ctx)
		}
	}
}
