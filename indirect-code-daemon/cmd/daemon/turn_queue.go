package main

import (
	"crypto/rand"
	"fmt"
	"sort"
	"strings"
	"time"

	"indirect/indirect-code-daemon/packages/agent/tools"
	"indirect/indirect-code-daemon/packages/provider"
)

// Message queue: while a turn is running, new user messages wait here
// instead of being refused. When a turn completes normally, the queue head
// is promoted to a new turn automatically. A plain user-cancelled turn never
// drains the queue; an interrupt-staged item ("interrupt") cancels the active
// turn and promotes immediately in finishTurn. Queue items persist in the
// session file like everything else.
//
// Editing an item ("update", see queueOpMsg) distinguishes "attachments
// unchanged" (the wire omits attachmentIds) from "replace with []" — an
// item's attachments survive a text-only edit.

const maxQueueItems = 30

const (
	deliveryQueue     = "queue"
	deliverySteer     = "steer"
	deliveryInterrupt = "interrupt"
)

func normalizeDelivery(d string) string {
	switch strings.ToLower(strings.TrimSpace(d)) {
	case deliverySteer:
		return deliverySteer
	case deliveryInterrupt:
		return deliveryInterrupt
	default:
		return deliveryQueue
	}
}

func deliveryRank(d string) int {
	switch normalizeDelivery(d) {
	case deliveryInterrupt:
		return 0
	case deliverySteer:
		return 1
	default:
		return 2
	}
}

func cloneQueuedOptions(o *SessionOptions) *SessionOptions {
	if o == nil {
		return nil
	}
	norm := normalizedOptions(*o)
	if len(o.Skills) > 0 {
		norm.Skills = append([]SkillChoice(nil), o.Skills...)
	}
	return &norm
}

func cloneQueueSlice(q []QueuedMessage) []QueuedMessage {
	if len(q) == 0 {
		return nil
	}
	out := make([]QueuedMessage, len(q))
	for i, item := range q {
		out[i] = item
		if len(item.AttachmentIDs) > 0 {
			out[i].AttachmentIDs = append([]string(nil), item.AttachmentIDs...)
		}
		out[i].Options = cloneQueuedOptions(item.Options)
	}
	return out
}

func ensureQueueSeqs(q []QueuedMessage) {
	var maxSeq int64
	for _, item := range q {
		if item.Seq > maxSeq {
			maxSeq = item.Seq
		}
	}
	for i := range q {
		if q[i].Seq <= 0 {
			maxSeq++
			q[i].Seq = maxSeq
		}
	}
}

func nextQueueSeq(q []QueuedMessage) int64 {
	ensureQueueSeqs(q)
	var maxSeq int64
	for _, item := range q {
		if item.Seq > maxSeq {
			maxSeq = item.Seq
		}
	}
	return maxSeq + 1
}

// sortQueueByDelivery enforces canonical queue ordering:
//   1. "interrupt" items first (FIFO in staging order)
//   2. "steer" items second (FIFO in staging order)
//   3. "queue" items third (ordered by passive Seq / manual reorder)
func sortQueueByDelivery(q []QueuedMessage) {
	if len(q) == 0 {
		return
	}
	ensureQueueSeqs(q)
	for i := range q {
		q[i].Delivery = normalizeDelivery(q[i].Delivery)
	}
	sort.SliceStable(q, func(i, j int) bool {
		ri, rj := deliveryRank(q[i].Delivery), deliveryRank(q[j].Delivery)
		if ri != rj {
			return ri < rj
		}
		if ri != 2 {
			// Preserve FIFO staging order within "interrupt" and "steer".
			return false
		}
		if q[i].Seq != q[j].Seq {
			return q[i].Seq < q[j].Seq
		}
		return q[i].CreatedAt < q[j].CreatedAt
	})
}

// demoteStagedQueueItems resets any "steer" or "interrupt" items in q back to
// passive "queue" delivery, returning true if at least one item changed.
func demoteStagedQueueItems(q []QueuedMessage) bool {
	changed := false
	for i := range q {
		norm := normalizeDelivery(q[i].Delivery)
		if norm != deliveryQueue {
			q[i].Delivery = deliveryQueue
			changed = true
		} else if q[i].Delivery != deliveryQueue {
			q[i].Delivery = deliveryQueue
		}
	}
	return changed
}

// demoteInterruptToSteer converts any existing "interrupt" items in q to
// "steer" so at most one active interrupt exists at Queue[0] while superseded
// interrupts remain staged for the next step (and cancellable back to queue).
func demoteInterruptToSteer(q []QueuedMessage) bool {
	changed := false
	for i := range q {
		if normalizeDelivery(q[i].Delivery) == deliveryInterrupt {
			q[i].Delivery = deliverySteer
			changed = true
		}
	}
	return changed
}

// reorderQueueItems updates passive "queue" ordering according to ids while
// preserving unnamed items in relative order and keeping "interrupt" and
// "steer" groups ahead of passive "queue" items.
func reorderQueueItems(current []QueuedMessage, ids []string) []QueuedMessage {
	if len(current) == 0 {
		return nil
	}
	cloned := cloneQueueSlice(current)
	ensureQueueSeqs(cloned)
	byID := make(map[string]QueuedMessage, len(cloned))
	for _, q := range cloned {
		byID[q.ID] = q
	}
	seen := make(map[string]bool, len(cloned))
	ordered := make([]QueuedMessage, 0, len(cloned))
	for _, id := range ids {
		if q, ok := byID[id]; ok && !seen[id] {
			seen[id] = true
			ordered = append(ordered, q)
		}
	}
	for _, q := range cloned {
		if !seen[q.ID] {
			seen[q.ID] = true
			ordered = append(ordered, q)
		}
	}
	var passiveSeqs []int64
	for _, q := range ordered {
		if normalizeDelivery(q.Delivery) == deliveryQueue {
			passiveSeqs = append(passiveSeqs, q.Seq)
		}
	}
	sort.Slice(passiveSeqs, func(i, j int) bool { return passiveSeqs[i] < passiveSeqs[j] })
	pi := 0
	for i := range ordered {
		if normalizeDelivery(ordered[i].Delivery) == deliveryQueue {
			ordered[i].Seq = passiveSeqs[pi]
			pi++
		}
	}
	sortQueueByDelivery(ordered)
	return ordered
}

func randomQueueID() string {
	id := make([]byte, 8)
	if _, err := rand.Read(id); err != nil {
		panic(err)
	}
	return fmt.Sprintf("%x", id)
}

func queuePayload(queue []QueuedMessage) []any {
	out := make([]any, 0, len(queue))
	for _, q := range queue {
		entry := map[string]any{
			"id":            q.ID,
			"text":          q.Text,
			"attachmentIds": q.AttachmentIDs,
			"model":         q.Model,
			"yolo":          q.YOLO,
			"createdAt":     q.CreatedAt,
			"delivery":      normalizeDelivery(q.Delivery),
		}
		if q.Options != nil {
			entry["options"] = *cloneQueuedOptions(q.Options)
		}
		out = append(out, entry)
	}
	return out
}

// buildQueuedUserMessage converts a queued message into a transcript user message
// for live mid-turn steering (BeforeRequest). It mirrors seededUserMessage's
// directive handling: the date system-reminder is prepended when the date rolled
// over since the last announcement (and LastDate/LastMode are advanced), so a
// queued turn promoted after midnight announces the new date exactly like a
// normal opening prompt.
func (a *sessionActor) buildQueuedUserMessage(q QueuedMessage) provider.Message {
	options := normalizedOptions(a.rec.Options)
	snap := workerSnapshot{options: options, lastDate: a.rec.LastDate, lastMode: a.rec.LastMode, todos: append([]tools.TodoItem(nil), a.rec.Todos...), bgTasks: runningBgTasks(a.rec.BgTasks)}
	fullText, images := buildTurnPrompt(a.rec.Attachments, q.Text, q.AttachmentIDs, options.Mode)
	sysBlock := buildTurnSystemDirectives(&snap, time.Now())
	a.rec.LastDate, a.rec.LastMode = snap.lastDate, snap.lastMode
	content := []provider.Content{}
	if sysBlock != "" {
		content = append(content, provider.TextBlock{Text: sysBlock})
	}
	if fullText != "" {
		content = append(content, provider.TextBlock{Text: fullText})
	}
	for _, img := range images {
		content = append(content, img)
	}
	meta := attachmentMessageMeta(q.Text, q.AttachmentIDs, a.rec.Attachments)
	if meta == nil {
		meta = make(map[string]string)
	}
	meta["steering"] = "true"
	return a.externalizeMsg(provider.Message{
		ID:        provider.NewMessageID(),
		Role:      provider.RoleUser,
		Content:   content,
		Time:      time.Now(),
		TurnIndex: a.rec.TurnSeq,
		Meta:      meta,
	})
}
