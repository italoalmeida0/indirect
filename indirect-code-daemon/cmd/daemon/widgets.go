package main

import (
	"errors"
	"sort"

	"indirect/indirect-code-daemon/packages/agent/tools"
)

var (
	errStaleWorker = errors.New("stale worker")
	errWidgetID    = errors.New("widget id is required")
	errWidgetOp    = errors.New("unknown widget store op")
)

// widgetStoreMsg is the worker -> actor round-trip for the session widget
// store (mirrors bgTaskListMsg): the actor owns rec.Widgets, so every
// read/write goes through its mailbox. Reply is widgetStoreResult.
type widgetStoreMsg struct {
	gen   int
	op    string // "list" | "get" | "set" | "delete"
	id    string
	file  tools.WidgetFile
	Reply chan widgetStoreResult
}

type widgetStoreResult struct {
	files []tools.WidgetFile
	file  tools.WidgetFile
	found bool
	err   error
}

// onWidgetStore applies one widget store operation and persists it as a
// WAL "widgets" replace event (same durability contract as todos).
func (a *sessionActor) onWidgetStore(m widgetStoreMsg) {
	if m.Reply == nil {
		return
	}
	reply := func(res widgetStoreResult) {
		select {
		case m.Reply <- res:
		default:
		}
	}
	// Gen gate (B1): a zombie worker must not mutate the new turn's store.
	// gen==0 is the legacy/pre-gen caller (tests) and is accepted.
	if m.gen != 0 && m.gen != a.gen {
		trace("actor.widgets.stale", map[string]any{"sid": a.id, "gen": m.gen, "cur": a.gen})
		reply(widgetStoreResult{err: errStaleWorker})
		return
	}
	switch m.op {
	case "list":
		reply(widgetStoreResult{files: append([]tools.WidgetFile(nil), a.rec.Widgets...)})
	case "get":
		for _, f := range a.rec.Widgets {
			if f.ID == m.id {
				reply(widgetStoreResult{file: f, found: true})
				return
			}
		}
		reply(widgetStoreResult{})
	case "set":
		if m.file.ID == "" {
			reply(widgetStoreResult{err: errWidgetID})
			return
		}
		found := false
		for i, f := range a.rec.Widgets {
			if f.ID == m.file.ID {
				a.rec.Widgets[i] = m.file
				found = true
				break
			}
		}
		if !found {
			a.rec.Widgets = append(a.rec.Widgets, m.file)
		}
		sort.Slice(a.rec.Widgets, func(i, j int) bool { return a.rec.Widgets[i].ID < a.rec.Widgets[j].ID })
		a.persistWidgets()
		reply(widgetStoreResult{file: m.file, found: true})
	case "delete":
		out := a.rec.Widgets[:0]
		found := false
		for _, f := range a.rec.Widgets {
			if f.ID == m.id {
				found = true
				continue
			}
			out = append(out, f)
		}
		if !found {
			reply(widgetStoreResult{})
			return
		}
		a.rec.Widgets = out
		a.persistWidgets()
		reply(widgetStoreResult{found: true})
	default:
		reply(widgetStoreResult{err: errWidgetOp})
	}
}

// persistWidgets stores the widget set as a WAL "widgets" replace event
// (saveOrAppend falls back to a direct record save when no turn WAL is
// open).
func (a *sessionActor) persistWidgets() {
	a.saveOrAppend(walEvent{Type: walTypeWidgets, Widgets: append([]tools.WidgetFile(nil), a.rec.Widgets...)})
}

// widgetPayloads renders widget METADATA for session snapshots — never the
// sources (those are fetched on demand with get_widget).
func widgetPayloads(files []tools.WidgetFile) []map[string]any {
	out := make([]map[string]any, 0, len(files))
	for _, f := range files {
		out = append(out, map[string]any{
			"id":          f.ID,
			"placeholder": f.Placeholder,
			"size":        f.Size,
			"updatedAt":   f.UpdatedAt,
		})
	}
	return out
}

// onGetWidget serves one widget SOURCE on demand (widget_data), mirroring
// onGetAttachment: snapshots carry metadata only, the frontend fetches the
// source when a fence with that id actually renders.
func (s *wsServer) onGetWidget(requestID, sessionID, widgetID string) {
	rec := s.readRecord(sessionID)
	resp := map[string]any{
		"type": "widget_data", "hostId": s.host(), "sessionId": sessionID,
		"requestId": requestID, "widgetId": widgetID,
	}
	if rec != nil {
		for _, f := range rec.Widgets {
			if f.ID == widgetID {
				resp["widget"] = map[string]any{
					"id":          f.ID,
					"source":      f.Source,
					"placeholder": f.Placeholder,
					"size":        f.Size,
					"updatedAt":   f.UpdatedAt,
				}
				break
			}
		}
	}
	s.emit(resp)
}
