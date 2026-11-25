package provider

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"strings"
	"testing"
)

func TestContextTokensByMessageMatchesContextTokensAndFloorsUndecodableWebP(t *testing.T) {
	// 1. Undecodable/corrupt WebP bytes must NEVER count as 0 tokens: enforce >=1600 floor.
	corruptWebP := ImageBlock{
		MimeType: "image/webp",
		Data:     append([]byte("RIFF\x00\x00\x00\x00WEBPVP8X-corrupt"), bytes.Repeat([]byte{0xab}, 64*1024)...),
	}
	estWebP := EstimateImageTokens(corruptWebP)
	if estWebP < minImageTokenFloor {
		t.Fatalf("expected undecodable WebP >= %d tokens, got %d", minImageTokenFloor, estWebP)
	}

	webpMsg := Message{
		Role:    RoleTool,
		Content: []Content{ToolResultBlock{CallID: "c1", Content: []Content{corruptWebP}}},
	}
	totalWebP, byMsgWebP := ContextTokensByMessage("", nil, []Message{webpMsg})
	if len(byMsgWebP) != 1 || byMsgWebP[0] < minImageTokenFloor {
		t.Fatalf("expected ContextTokensByMessage >= %d for undecodable WebP, got %v", minImageTokenFloor, byMsgWebP)
	}
	diffWebP := totalWebP - byMsgWebP[0]
	if diffWebP < -256 || diffWebP > 256 {
		t.Fatalf("expected ContextTokens (%d) and ContextTokensByMessage (%d) to agree within request framing margin", totalWebP, byMsgWebP[0])
	}

	// 2. Real 1568x882 image in multi-image RoleTool + RoleUser messages:
	// ContextTokensByMessage sum matches ContextTokens multi-provider tile margin.
	canvas := image.NewRGBA(image.Rect(0, 0, 1568, 882))
	for y := 0; y < 882; y += 16 {
		for x := 0; x < 1568; x += 16 {
			canvas.SetRGBA(x, y, color.RGBA{R: 120, G: 80, B: 200, A: 255})
		}
	}
	var pngBuf bytes.Buffer
	if err := png.Encode(&pngBuf, canvas); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	imgBlock := ImageBlock{
		MimeType:   "image/png",
		Data:       pngBuf.Bytes(),
		SourcePath: "ui.png",
		Width:      1568,
		Height:     882,
	}
	msgs := []Message{
		{
			Role:    RoleUser,
			Content: []Content{TextBlock{Text: "Compare these three screenshots"}, imgBlock},
		},
		{
			Role: RoleTool,
			Content: []Content{
				ToolResultBlock{CallID: "r1", Content: []Content{TextBlock{Text: "first"}, imgBlock}},
				ToolResultBlock{CallID: "r2", Content: []Content{TextBlock{Text: "second"}, imgBlock}},
			},
		},
	}
	total, perMsg := ContextTokensByMessage("", nil, msgs)
	if len(perMsg) != 2 {
		t.Fatalf("expected 2 message counts, got %d", len(perMsg))
	}
	if perMsg[1] < 2*EstimateImageTokens(imgBlock) {
		t.Fatalf("expected multi-image tool message (%d) >= 2 * single image (%d)", perMsg[1], EstimateImageTokens(imgBlock))
	}
	sumPerMsg := perMsg[0] + perMsg[1]
	// ContextTokens includes btdby4's request-level safety margin (~5% + framing),
	// whereas perMsg counts raw per-message content+image tokens; verify they agree closely.
	if delta := total - sumPerMsg; delta < 0 || delta > total/10+256 {
		t.Fatalf("expected sum(ContextTokensByMessage)=%d to match ContextTokens=%d within request margin", sumPerMsg, total)
	}
}

func TestImageKeyDeterminismAndAnthropicWireExcludesGoMetadata(t *testing.T) {
	raw := ImageBlock{
		MimeType:   "image/jpeg",
		Data:       []byte("jpeg-payload"),
		SourcePath: "screens/shot.png",
		Width:      1568,
		Height:     882,
		OrigWidth:  3840,
		OrigHeight: 2160,
	}
	k1 := ImageKey(raw)
	k2 := ImageKey(ImageBlock{MimeType: "image/jpeg", Data: []byte("jpeg-payload")})
	if len(k1) != 64 || k1 != k2 {
		t.Fatalf("expected deterministic 64-char fallback ImageKey ignoring path metadata: k1=%q k2=%q", k1, k2)
	}
	explicitSHA := strings.Repeat("a", 64)
	raw.SHA256 = explicitSHA
	if got := ImageKey(raw); got != explicitSHA {
		t.Fatalf("expected explicit SHA256 %q to win, got %q", explicitSHA, got)
	}

	// Verify Anthropic wire serialization strictly emits type/source(type,media_type,data)
	// and never leaks Go-only metadata fields (sourcePath, width, sha256, etc.).
	wireBlock := buildAnthImageBlock(raw)
	wireJSON, err := json.Marshal(wireBlock)
	if err != nil {
		t.Fatalf("marshal anthImageBlock: %v", err)
	}
	s := string(wireJSON)
	for _, forbidden := range []string{"sourcePath", "source_path", "width", "height", "origWidth", "sha256"} {
		if strings.Contains(s, forbidden) {
			t.Fatalf("Anthropic wire image block leaked %q: %s", forbidden, s)
		}
	}
	if !strings.Contains(s, `"media_type":"image/jpeg"`) || !strings.Contains(s, `"type":"base64"`) {
		t.Fatalf("unexpected Anthropic wire image JSON: %s", s)
	}
}

func TestContextTokensByMessagePreservesStrictIndexAlignment(t *testing.T) {
	// Empty slice returns empty per-message breakdown.
	if total, per := ContextTokensByMessage("", nil, nil); total != 0 || len(per) != 0 {
		t.Fatalf("nil messages: got total=%d per=%v, want 0 and empty", total, per)
	}

	img := ImageBlock{
		MimeType: "image/png",
		Data:     bytes.Repeat([]byte{0x42}, 4096),
		Width:    1200,
		Height:   800,
	}
	largeToolText := strings.Repeat("diagnostic log entry line with concrete details\n", 400)

	// Mix all content==nil shapes (leading, middle, 7 consecutive reasoning-only
	// assistant turns as observed in live E2E, and trailing) with wire-visible
	// user, assistant, tool-call, tool-result, and image messages.
	msgs := []Message{
		{Role: RoleAssistant, Content: []Content{ReasoningBlock{Summary: "leading thought"}}},                  // 0 -> 0
		{Role: RoleUser, Content: []Content{TextBlock{Text: "first user turn"}}},                               // 1 -> >0
		{Role: RoleAssistant, Content: []Content{TextBlock{Text: ""}}},                                         // 2 -> 0 (blank text)
		{Role: RoleAssistant, Content: []Content{ToolCallBlock{ID: "srv1", Name: "web_search", Server: true}}}, // 3 -> 0 (server-only tool)
		{Role: RoleUser, Content: nil}, // 4 -> 0 (nil user content)
		{Role: RoleTool, Content: nil}, // 5 -> 0 (empty tool msg)
		{Role: Role("unknown"), Content: []Content{TextBlock{Text: "ignored role"}}},    // 6 -> 0 (unknown role)
		{Role: RoleAssistant, Content: []Content{ReasoningBlock{Summary: "thought 1"}}}, // 7 -> 0
		{Role: RoleAssistant, Content: []Content{ReasoningBlock{Summary: "thought 2"}}}, // 8 -> 0
		{Role: RoleAssistant, Content: []Content{ReasoningBlock{Summary: "thought 3"}}}, // 9 -> 0
		{Role: RoleAssistant, Content: []Content{ReasoningBlock{Summary: "thought 4"}}}, // 10 -> 0
		{Role: RoleAssistant, Content: []Content{ReasoningBlock{Summary: "thought 5"}}}, // 11 -> 0
		{Role: RoleAssistant, Content: []Content{ReasoningBlock{Summary: "thought 6"}}}, // 12 -> 0
		{Role: RoleAssistant, Content: []Content{ReasoningBlock{Summary: "thought 7"}}}, // 13 -> 0
		{Role: RoleAssistant, Content: []Content{ // 14 -> >0
			ToolCallBlock{ID: "tc1", Name: "read", Arguments: json.RawMessage(`{"path":"big.log"}`)},
		}},
		{Role: RoleTool, Content: []Content{ // 15 -> large (>2000)
			ToolResultBlock{CallID: "tc1", Content: []Content{TextBlock{Text: largeToolText}}},
		}},
		{Role: RoleTool, Content: []Content{ // 16 -> image floor (>=1600)
			ToolResultBlock{CallID: "tc2", Content: []Content{TextBlock{Text: "screenshot"}, img}},
		}},
		{Role: RoleAssistant, Content: []Content{ReasoningBlock{Summary: "trailing thought"}}}, // 17 -> 0
	}

	total, per := ContextTokensByMessage("system prompt", nil, msgs)
	if len(per) != len(msgs) {
		t.Fatalf("len(per) = %d, want len(msgs) = %d (per=%v)", len(per), len(msgs), per)
	}
	if total != ContextTokens("system prompt", nil, msgs) {
		t.Fatalf("total = %d, want ContextTokens = %d", total, ContextTokens("system prompt", nil, msgs))
	}

	zeroIndices := map[int]bool{
		0: true, 2: true, 3: true, 4: true, 5: true, 6: true,
		7: true, 8: true, 9: true, 10: true, 11: true, 12: true, 13: true, 17: true,
	}
	for i := range msgs {
		_, single := ContextTokensByMessage("", nil, msgs[i:i+1])
		if len(single) != 1 {
			t.Fatalf("idx %d: single call returned len %d, want 1", i, len(single))
		}
		if zeroIndices[i] {
			if per[i] != 0 {
				t.Fatalf("idx %d: expected 0 for non-wire message, got %d", i, per[i])
			}
		} else if per[i] <= 0 {
			t.Fatalf("idx %d: expected >0 for wire-visible message, got %d", i, per[i])
		}
		if per[i] != single[0] {
			t.Fatalf("idx %d: per[%d]=%d shifted relative to isolated count=%d", i, i, per[i], single[0])
		}
	}

	if per[15] < 2000 {
		t.Fatalf("expected large tool result at exact idx 15 to report >=2000 tokens, got %d", per[15])
	}
	if per[16] < EstimateImageTokens(img) {
		t.Fatalf("expected image tool result at exact idx 16 to report >=%d tokens, got %d", EstimateImageTokens(img), per[16])
	}
}
