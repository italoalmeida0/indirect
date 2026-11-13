package searchindex

import (
	"encoding/json"
	"strings"

	"indirect/indirect-code-daemon/packages/provider"
)

// WidgetMeta provides generative-UI widget metadata for indexing in FieldTool.
type WidgetMeta struct {
	ID          string
	Title       string
	Placeholder string
}

// CompactionBlockMeta provides compaction summary metadata to index in FieldTool.
type CompactionBlockMeta struct {
	ID       string
	Topic    string
	Summary  string
	StartIdx int
	EndIdx   int
}

// ExtractOptions configures optional out-of-line data sources when extracting
// TurnDocs from raw provider.Message slices.
type ExtractOptions struct {
	// AttachmentText maps attachment ID -> extracted attachment text.
	AttachmentText map[string]string
	// ResolveAttachmentText lazily resolves extracted text for an attachment ID.
	ResolveAttachmentText func(attachmentID string) string
	// Widgets lists session-level generative-UI widget metadata.
	Widgets []WidgetMeta
	// CompactionBlocks lists compaction fold summaries to attach to turns.
	CompactionBlocks []CompactionBlockMeta
}

var systemBlockTags = [][2]string{
	{"<system-reminder>", "</system-reminder>"},
	{"<system_prompt>", "</system_prompt>"},
	{"<system-warn>", "</system-warn>"},
}

// StripSystemReminders removes all <system-reminder>...</system-reminder>,
// <system_prompt>...</system_prompt>, and <system-warn>...</system-warn> blocks
// anywhere in text (leading, stacked, inline, or trailing).
func StripSystemReminders(text string) string {
	if !strings.Contains(text, "<system") {
		return text
	}
	s := text
	for _, pair := range systemBlockTags {
		openTag, closeTag := pair[0], pair[1]
		for {
			start := strings.Index(s, openTag)
			if start < 0 {
				break
			}
			rest := s[start+len(openTag):]
			endRel := strings.Index(rest, closeTag)
			if endRel < 0 {
				// Unclosed system tag: drop to end of text so directives never leak.
				s = s[:start]
				break
			}
			after := start + len(openTag) + endRel + len(closeTag)
			if start > 0 && after < len(s) && s[start-1] != ' ' && s[start-1] != '\n' && s[after] != ' ' && s[after] != '\n' {
				s = s[:start] + " " + s[after:]
			} else {
				s = s[:start] + s[after:]
			}
		}
	}
	return strings.TrimSpace(s)
}

// IsHiddenMessage reports whether m is a synthetic/internal message that must
// never be indexed (background_delivery, skill_notice, hidden, compaction, ephemeral).
func IsHiddenMessage(m provider.Message) bool {
	if len(m.Meta) > 0 {
		if m.Meta["background_delivery"] != "" ||
			m.Meta["skill_notice"] != "" ||
			m.Meta["hidden"] == "true" ||
			m.Meta["compaction"] == "true" ||
			m.Meta["ephemeral"] == "true" ||
			m.Meta["image_mirror"] == "true" {
			return true
		}
	}
	return false
}

type msgTurnGroup struct {
	turn int
	idxs []int
}

// groupMessagesByTurn mirrors cmd/daemon/turn_grouping.go:
//   - TurnIndex <= 0 attaches to the FOLLOWING turn.
//   - Trailing TurnIndex <= 0 attaches to the LAST turn (or turn 1 if all <= 0).
func groupMessagesByTurn(msgs []provider.Message) []msgTurnGroup {
	var groups []msgTurnGroup
	var pending []int

	flushPending := func(turn int) {
		if len(pending) == 0 {
			return
		}
		if len(groups) > 0 && groups[len(groups)-1].turn == turn {
			groups[len(groups)-1].idxs = append(groups[len(groups)-1].idxs, pending...)
		} else {
			cp := make([]int, len(pending))
			copy(cp, pending)
			groups = append(groups, msgTurnGroup{turn: turn, idxs: cp})
		}
		pending = pending[:0]
	}

	for i, m := range msgs {
		if m.TurnIndex <= 0 {
			pending = append(pending, i)
			continue
		}
		flushPending(m.TurnIndex)
		if len(groups) > 0 && groups[len(groups)-1].turn == m.TurnIndex {
			groups[len(groups)-1].idxs = append(groups[len(groups)-1].idxs, i)
		} else {
			groups = append(groups, msgTurnGroup{turn: m.TurnIndex, idxs: []int{i}})
		}
	}
	if len(pending) > 0 {
		if len(groups) > 0 {
			groups[len(groups)-1].idxs = append(groups[len(groups)-1].idxs, pending...)
		} else {
			cp := make([]int, len(pending))
			copy(cp, pending)
			groups = append(groups, msgTurnGroup{turn: 1, idxs: cp})
		}
	}
	return groups
}

// ExtractSessionTurns groups a session's messages into turns and extracts one
// TurnDoc per non-empty turn with exact raw message indices.
func ExtractSessionTurns(sessionID string, msgs []provider.Message, opts *ExtractOptions) []TurnDoc {
	if len(msgs) == 0 && (opts == nil || (len(opts.Widgets) == 0 && len(opts.CompactionBlocks) == 0)) {
		return nil
	}
	groups := groupMessagesByTurn(msgs)
	callNames := collectCallNames(msgs)

	out := make([]TurnDoc, 0, len(groups))
	for gIdx, g := range groups {
		if len(g.idxs) == 0 {
			continue
		}
		doc, ok := extractIndexedGroup(sessionID, g.turn, msgs, g.idxs, callNames, opts, gIdx == len(groups)-1)
		if ok {
			out = append(out, doc)
		}
	}

	// If session has widgets/compaction metadata on an otherwise empty transcript,
	// emit a synthetic turn 0 carrier so those items remain searchable.
	if len(out) == 0 && opts != nil && (len(opts.Widgets) > 0 || len(opts.CompactionBlocks) > 0) {
		var blocks []string
		for _, w := range opts.Widgets {
			if s := formatWidgetBlock(w); s != "" {
				blocks = append(blocks, s)
			}
		}
		for _, cb := range opts.CompactionBlocks {
			if s := formatCompactionBlock(cb); s != "" {
				blocks = append(blocks, s)
			}
		}
		if len(blocks) > 0 {
			out = append(out, TurnDoc{
				SessionID:            sessionID,
				TurnIndex:            0,
				FirstMsgIdx:          0,
				BestUserOrAsstMsgIdx: 0,
				ToolBlocks:           blocks,
				ToolText:             strings.Join(blocks, "\n"),
			})
		}
	}
	return out
}

// ExtractTurnDoc extracts a single TurnDoc from a contiguous turn slice `turnMsgs`
// whose first element is at raw session offset `firstMsgIdx`.
func ExtractTurnDoc(sessionID string, turnIndex int, turnMsgs []provider.Message, firstMsgIdx int, opts *ExtractOptions) (TurnDoc, bool) {
	if len(turnMsgs) == 0 {
		return TurnDoc{}, false
	}
	callNames := collectCallNames(turnMsgs)
	idxs := make([]int, len(turnMsgs))
	for i := range turnMsgs {
		idxs[i] = i
	}
	doc, ok := extractIndexedGroup(sessionID, turnIndex, turnMsgs, idxs, callNames, opts, false)
	if !ok {
		return TurnDoc{}, false
	}
	doc.FirstMsgIdx += firstMsgIdx
	doc.BestUserOrAsstMsgIdx += firstMsgIdx
	if doc.UserMsgIdx >= 0 {
		doc.UserMsgIdx += firstMsgIdx
	}
	if doc.AssistantMsgIdx >= 0 {
		doc.AssistantMsgIdx += firstMsgIdx
	}
	if doc.ToolMsgIdx >= 0 {
		doc.ToolMsgIdx += firstMsgIdx
	}
	return doc, true
}

func collectCallNames(msgs []provider.Message) map[string]string {
	var names map[string]string
	for _, m := range msgs {
		for _, c := range m.Content {
			if tc, ok := c.(provider.ToolCallBlock); ok && tc.ID != "" && tc.Name != "" {
				if names == nil {
					names = make(map[string]string, 16)
				}
				names[tc.ID] = tc.Name
			}
		}
	}
	return names
}

func extractIndexedGroup(
	sessionID string,
	turnIndex int,
	msgs []provider.Message,
	idxs []int,
	callNames map[string]string,
	opts *ExtractOptions,
	isLastGroup bool,
) (TurnDoc, bool) {
	firstMsgIdx := idxs[0]
	lastMsgIdx := idxs[len(idxs)-1]

	userMsgIdx := -1
	asstMsgIdx := -1
	hasFinalReply := false
	toolMsgIdx := -1
	var maxUnix int64

	var userParts []string
	var asstParts []string
	var toolBlocks []string

	for _, rawIdx := range idxs {
		m := msgs[rawIdx]
		if !m.Time.IsZero() {
			if u := m.Time.Unix(); u > maxUnix {
				maxUnix = u
			}
		}
		if IsHiddenMessage(m) {
			continue
		}

		switch m.Role {
		case provider.RoleUser:
			addedUser := false
			for _, c := range m.Content {
				switch b := c.(type) {
				case provider.TextBlock:
					cleaned := StripSystemReminders(b.Text)
					if cleaned != "" {
						userParts = append(userParts, cleaned)
						addedUser = true
					}
				case provider.ImageBlock:
					if b.SourcePath != "" {
						userParts = append(userParts, b.SourcePath)
						addedUser = true
					}
				case provider.ToolResultBlock:
					if tb := extractToolResultBlock(b, callNames[b.CallID]); tb != "" {
						toolBlocks = append(toolBlocks, tb)
						if toolMsgIdx < 0 {
							toolMsgIdx = rawIdx
						}
					}
				}
			}
			// Out-of-line attachment metadata & extracted text.
			for _, attText := range extractAttachmentTexts(m, opts) {
				userParts = append(userParts, attText)
				addedUser = true
			}
			if addedUser && userMsgIdx < 0 {
				userMsgIdx = rawIdx
			}

		case provider.RoleAssistant:
			for _, c := range m.Content {
				switch b := c.(type) {
				case provider.TextBlock:
					trimmed := strings.TrimSpace(b.Text)
					if trimmed != "" {
						asstParts = append(asstParts, trimmed)
						if !hasFinalReply {
							asstMsgIdx = rawIdx
						}
						for _, fenceMeta := range extractGenUIFences(trimmed) {
							toolBlocks = append(toolBlocks, fenceMeta)
							if toolMsgIdx < 0 {
								toolMsgIdx = rawIdx
							}
						}
					}
				case provider.ToolCallBlock:
					switch b.Name {
					case "finish_entire_request":
						if finalMsg := extractFinishMessage(b.Arguments); finalMsg != "" {
							asstParts = append(asstParts, finalMsg)
							asstMsgIdx = rawIdx
							hasFinalReply = true
							for _, fenceMeta := range extractGenUIFences(finalMsg) {
								toolBlocks = append(toolBlocks, fenceMeta)
							}
						}
					case "summary":
						if sumMsg := extractSummaryMessage(b.Arguments); sumMsg != "" {
							asstParts = append(asstParts, sumMsg)
							if !hasFinalReply {
								asstMsgIdx = rawIdx
							}
						}
					default:
						if tb := extractToolCallBlock(b); tb != "" {
							toolBlocks = append(toolBlocks, tb)
							if toolMsgIdx < 0 {
								toolMsgIdx = rawIdx
							}
						}
					}
				}
			}

		case provider.RoleTool:
			for _, c := range m.Content {
				switch b := c.(type) {
				case provider.ToolResultBlock:
					if tb := extractToolResultBlock(b, callNames[b.CallID]); tb != "" {
						toolBlocks = append(toolBlocks, tb)
						if toolMsgIdx < 0 {
							toolMsgIdx = rawIdx
						}
					}
				case provider.TextBlock:
					if tb := unwrapToolResultText(b.Text); tb != "" {
						toolBlocks = append(toolBlocks, tb)
						if toolMsgIdx < 0 {
							toolMsgIdx = rawIdx
						}
					}
				}
			}
		}
	}

	if opts != nil {
		for _, cb := range opts.CompactionBlocks {
			if cb.StartIdx >= firstMsgIdx && cb.StartIdx <= lastMsgIdx {
				if s := formatCompactionBlock(cb); s != "" {
					toolBlocks = append(toolBlocks, s)
					if toolMsgIdx < 0 {
						toolMsgIdx = cb.StartIdx
					}
				}
			}
		}
		if isLastGroup && len(opts.Widgets) > 0 {
			for _, w := range opts.Widgets {
				if s := formatWidgetBlock(w); s != "" {
					toolBlocks = append(toolBlocks, s)
				}
			}
		}
	}

	if len(userParts) == 0 && len(asstParts) == 0 && len(toolBlocks) == 0 {
		return TurnDoc{}, false
	}

	bestIdx := firstMsgIdx
	if asstMsgIdx >= 0 {
		bestIdx = asstMsgIdx
	} else if userMsgIdx >= 0 {
		bestIdx = userMsgIdx
	} else if toolMsgIdx >= 0 {
		bestIdx = toolMsgIdx
	}

	var toolSnippetBuilder strings.Builder
	for i, tb := range toolBlocks {
		if toolSnippetBuilder.Len() >= 2048 {
			break
		}
		if i > 0 {
			toolSnippetBuilder.WriteByte('\n')
		}
		if len(tb) > 1024 {
			toolSnippetBuilder.WriteString(TruncateExcerptRunes(tb, 256))
		} else {
			toolSnippetBuilder.WriteString(tb)
		}
	}

	return TurnDoc{
		SessionID:            sessionID,
		TurnIndex:            turnIndex,
		FirstMsgIdx:          firstMsgIdx,
		BestUserOrAsstMsgIdx: bestIdx,
		UpdatedAtUnix:        maxUnix,
		UserText:             strings.Join(userParts, "\n"),
		AssistantText:        strings.Join(asstParts, "\n"),
		ToolText:             toolSnippetBuilder.String(),
		ToolBlocks:           toolBlocks,
		HasFieldMsgIdx:       true,
		UserMsgIdx:           userMsgIdx,
		AssistantMsgIdx:      asstMsgIdx,
		ToolMsgIdx:           toolMsgIdx,
	}, true
}

func extractFinishMessage(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var args struct {
		FinalMessageToUser string `json:"final_message_to_user"`
	}
	if err := json.Unmarshal(raw, &args); err != nil {
		return ""
	}
	return strings.TrimSpace(args.FinalMessageToUser)
}

func extractSummaryMessage(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var args struct {
		ForUser string `json:"for_user"`
		Summary string `json:"summary"`
		Message string `json:"message"`
		Text    string `json:"text"`
	}
	if err := json.Unmarshal(raw, &args); err != nil {
		return ""
	}
	var parts []string
	addUnique := func(s string) {
		s = strings.TrimSpace(s)
		if s == "" {
			return
		}
		for _, p := range parts {
			if p == s {
				return
			}
		}
		parts = append(parts, s)
	}
	addUnique(args.ForUser)
	addUnique(args.Summary)
	addUnique(args.Message)
	addUnique(args.Text)
	return strings.Join(parts, "\n")
}

// toolArgKeys lists structured JSON argument keys worth indexing on tool calls.
var toolArgKeys = []string{
	"command", "cmd", "description",
	"path", "file_path", "file", "files", "dir", "cwd", "target", "src_file",
	"glob", "include", "pattern",
	"query", "queries", "url", "urls", "domain",
	"id", "widget_id", "title", "placeholder",
	"skill", "name", "topic", "block_id",
	"code", "script",
}

const maxRawToolBlockBytes = 8192

func extractToolCallBlock(tc provider.ToolCallBlock) string {
	var parts []string
	if tc.Name != "" {
		parts = append(parts, tc.Name)
	}
	if len(tc.Arguments) > 0 {
		var m map[string]any
		if err := json.Unmarshal(tc.Arguments, &m); err == nil && len(m) > 0 {
			for _, k := range toolArgKeys {
				v, ok := m[k]
				if !ok || v == nil {
					continue
				}
				switch tv := v.(type) {
				case string:
					s := strings.TrimSpace(tv)
					if s != "" {
						if len(s) > maxRawToolBlockBytes {
							s = TruncateExcerptRunes(s, 1024)
						}
						parts = append(parts, s)
					}
				case []any:
					for _, elem := range tv {
						if es, ok := elem.(string); ok {
							es = strings.TrimSpace(es)
							if es != "" {
								parts = append(parts, es)
							}
						}
					}
				}
			}
		}
	}
	out := strings.Join(parts, " ")
	if len(out) > maxRawToolBlockBytes {
		out = TruncateExcerptRunes(out, 1024)
	}
	return out
}

func extractToolResultBlock(tr provider.ToolResultBlock, toolName string) string {
	if toolName == "finish_entire_request" || toolName == "summary" {
		return ""
	}
	var parts []string
	if toolName != "" {
		parts = append(parts, toolName)
	}
	totalBytes := 0
	for _, c := range tr.Content {
		if totalBytes >= maxRawToolBlockBytes {
			break
		}
		if tb, ok := c.(provider.TextBlock); ok && tb.Text != "" {
			unwrapped := unwrapToolResultText(tb.Text)
			if unwrapped != "" {
				parts = append(parts, unwrapped)
				totalBytes += len(unwrapped)
			}
		}
	}
	return strings.Join(parts, " ")
}

func unwrapToolResultText(s string) string {
	trimmed := strings.TrimSpace(s)
	if trimmed == "" {
		return ""
	}
	// Skip completion/summary receipt boilerplate.
	if strings.HasPrefix(trimmed, "Request finished; final_message_to_user") ||
		strings.HasPrefix(trimmed, "Progress summary recorded.") {
		return ""
	}
	if strings.HasPrefix(trimmed, "<tool_result") {
		gt := strings.IndexByte(trimmed, '>')
		if gt > 0 {
			header := trimmed[:gt]
			body := trimmed[gt+1:]
			if end := strings.LastIndex(body, "</tool_result>"); end >= 0 {
				body = body[:end]
			}
			var meta []string
			for _, attr := range []string{"path=", "url=", "info=", "error="} {
				if idx := strings.Index(header, attr+`"`); idx >= 0 {
					valStart := idx + len(attr) + 1
					if qEnd := strings.IndexByte(header[valStart:], '"'); qEnd > 0 {
						meta = append(meta, header[valStart:valStart+qEnd])
					}
				}
			}
			if len(body) > maxRawToolBlockBytes {
				body = TruncateExcerptRunes(body, 1024)
			}
			body = strings.TrimSpace(body)
			if strings.HasPrefix(body, "Request finished; final_message_to_user") ||
				strings.HasPrefix(body, "Progress summary recorded.") {
				return ""
			}
			if len(meta) > 0 && body != "" {
				return strings.Join(meta, " ") + " " + body
			}
			if len(meta) > 0 {
				return strings.Join(meta, " ")
			}
			return body
		}
	}
	if len(trimmed) > maxRawToolBlockBytes {
		return TruncateExcerptRunes(trimmed, 1024)
	}
	return trimmed
}

func extractAttachmentTexts(m provider.Message, opts *ExtractOptions) []string {
	if len(m.Meta) == 0 {
		return nil
	}
	raw, ok := m.Meta["attachments"]
	if !ok || raw == "" {
		return nil
	}
	var refs []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal([]byte(raw), &refs); err != nil || len(refs) == 0 {
		return nil
	}
	var out []string
	for _, r := range refs {
		if r.Name != "" {
			out = append(out, r.Name)
		}
		if opts != nil && r.ID != "" {
			if txt, ok := opts.AttachmentText[r.ID]; ok && strings.TrimSpace(txt) != "" {
				out = append(out, txt)
			} else if opts.ResolveAttachmentText != nil {
				if resolved := strings.TrimSpace(opts.ResolveAttachmentText(r.ID)); resolved != "" {
					out = append(out, resolved)
				}
			}
		}
	}
	return out
}

func extractGenUIFences(text string) []string {
	const marker = "```generative_ui"
	if !strings.Contains(text, marker) {
		return nil
	}
	var out []string
	rem := text
	for {
		idx := strings.Index(rem, marker)
		if idx < 0 {
			break
		}
		rem = rem[idx+len(marker):]
		end := strings.Index(rem, "```")
		block := rem
		if end >= 0 {
			block = rem[:end]
			rem = rem[end+3:]
		} else {
			rem = ""
		}
		var hdr []string
		for _, line := range strings.Split(block, "\n") {
			line = strings.TrimSpace(line)
			for _, pfx := range []string{"widget_id:", "id:", "placeholder:", "title:"} {
				if strings.HasPrefix(line, pfx) {
					v := strings.TrimSpace(strings.TrimPrefix(line, pfx))
					if v != "" {
						hdr = append(hdr, v)
					}
				}
			}
		}
		if len(hdr) > 0 {
			out = append(out, "generative_ui "+strings.Join(hdr, " "))
		}
	}
	return out
}

func formatWidgetBlock(w WidgetMeta) string {
	var parts []string
	if w.ID != "" {
		parts = append(parts, w.ID)
	}
	if w.Title != "" {
		parts = append(parts, w.Title)
	}
	if w.Placeholder != "" && w.Placeholder != w.Title {
		parts = append(parts, w.Placeholder)
	}
	return strings.Join(parts, " ")
}

func formatCompactionBlock(cb CompactionBlockMeta) string {
	var parts []string
	if cb.ID != "" {
		parts = append(parts, cb.ID)
	}
	if cb.Topic != "" {
		parts = append(parts, cb.Topic)
	}
	if cb.Summary != "" {
		parts = append(parts, cb.Summary)
	}
	return strings.Join(parts, "\n")
}
