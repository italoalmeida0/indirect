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
