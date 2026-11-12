package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"indirect/indirect-code-daemon/packages/provider"
)

type fakeImageReadTool struct{}

func (fakeImageReadTool) Name() string        { return "read" }
func (fakeImageReadTool) Description() string { return "Read image" }
func (fakeImageReadTool) Schema() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"}}}`)
}
func (fakeImageReadTool) Execute(_ context.Context, raw json.RawMessage, _ func(string)) (ToolResult, error) {
	var args struct {
		Path string `json:"path"`
	}
	_ = json.Unmarshal(raw, &args)
	payload := []byte("img-bytes-for-" + args.Path)
	img := provider.ImageBlock{
		MimeType:   "image/jpeg",
		Data:       payload,
		SourcePath: args.Path,
		Width:      1568,
		Height:     882,
		OrigWidth:  3840,
		OrigHeight: 2160,
	}
	img.SHA256 = provider.ImageKey(img)
	return ToolResult{
		Content: []provider.Content{
			provider.TextBlock{Text: "Read image file [image/jpeg]"},
			img,
		},
		Attrs: []Attr{{Key: "path", Value: args.Path}, {Key: "media", Value: "image/jpeg"}},
	}, nil
}

func countRequestLiveImages(msgs []provider.Message) (int, []string) {
	count := 0
	var paths []string
	for _, m := range msgs {
		for _, c := range m.Content {
			switch b := c.(type) {
			case provider.ImageBlock:
				count++
				paths = append(paths, b.SourcePath)
			case provider.ToolResultBlock:
				for _, inner := range b.Content {
					if ib, ok := inner.(provider.ImageBlock); ok {
						count++
						paths = append(paths, ib.SourcePath)
					}
				}
			}
		}
	}
	return count, paths
}

type scriptedVisionClient struct {
	mu              sync.Mutex
	mainRequests    []provider.Request
	visionCalls     []string
	nextReadPath    string
	failVision      bool
	mainHandler     func(callIdx int, req provider.Request) (provider.Message, error)
	warmForkErr     error
	standaloneCalls []provider.Request
}

func (c *scriptedVisionClient) Name() string { return "anthropic" }

func (c *scriptedVisionClient) Stream(ctx context.Context, req provider.Request) (<-chan provider.Event, error) {
	c.mu.Lock()
	if req.System == VisionTranscriberSystemPrompt {
		_, paths := countRequestLiveImages(req.Messages)
		src := "unknown"
		if len(paths) > 0 {
			src = paths[0]
		}
		c.visionCalls = append(c.visionCalls, src)
		fail := c.failVision
		c.mu.Unlock()
		if fail {
			return nil, errors.New("anthropic http 400: vision unavailable on sub-endpoint")
		}
		reply := fmt.Sprintf("- OCR from %s: `ERR_CODE_%s` visible in top banner\n- Layout: 1568x882 dashboard", src, strings.ToUpper(strings.TrimSuffix(src, ".png")))
		return singleMessageStream(req.Model, reply, provider.Usage{InputTokens: 250, OutputTokens: 45}), nil
	}

	isWarmFork := len(req.Messages) > 0 && req.Messages[len(req.Messages)-1].Meta["compaction"] == "summarizer_fork"
	if isWarmFork {
		err := c.warmForkErr
		c.mu.Unlock()
		if err != nil {
			return nil, err
		}
		return singleMessageStream(req.Model, "## Goal\n- Warm fork summary.", provider.Usage{InputTokens: 100, OutputTokens: 30}), nil
	}
	if req.System == SummarizationSystemPrompt {
		reqCopy := req
		reqCopy.Messages = append([]provider.Message(nil), req.Messages...)
		c.standaloneCalls = append(c.standaloneCalls, reqCopy)
		c.mu.Unlock()
		return singleMessageStream(req.Model, "## Goal\n- Standalone narrative summary preserving OCR details.\n\n## Progress\n- Completed cleanly.", provider.Usage{InputTokens: 120, OutputTokens: 40}), nil
	}

	reqCopy := req
	reqCopy.Messages = append([]provider.Message(nil), req.Messages...)
	c.mainRequests = append(c.mainRequests, reqCopy)
	callIdx := len(c.mainRequests) - 1
	readPath := c.nextReadPath
	c.nextReadPath = ""
	handler := c.mainHandler
	c.mu.Unlock()

	if handler != nil {
		msg, err := handler(callIdx, reqCopy)
		if err != nil {
			return nil, err
		}
		out := make(chan provider.Event, 8)
		go func() {
			defer close(out)
			out <- provider.EventStart{Provider: "anthropic", Model: req.Model}
			out <- provider.EventUsage{Usage: provider.Usage{InputTokens: 100, OutputTokens: 20}}
			out <- provider.EventDone{Stop: provider.StopEnd, Message: msg}
		}()
		return out, nil
	}

	if readPath != "" {
		rawArgs, _ := json.Marshal(map[string]string{"path": readPath})
		tc := provider.ToolCallBlock{ID: fmt.Sprintf("tc_%d", callIdx+1), Name: "read", Arguments: rawArgs}
		out := make(chan provider.Event, 8)
		go func() {
			defer close(out)
			out <- provider.EventStart{Provider: "anthropic", Model: req.Model}
			out <- provider.EventToolStart{ID: tc.ID, Name: tc.Name}
			out <- provider.EventToolArgs{ID: tc.ID, Delta: string(rawArgs)}
			out <- provider.EventToolEnd{ID: tc.ID}
			out <- provider.EventUsage{Usage: provider.Usage{InputTokens: 100, OutputTokens: 25}}
			out <- provider.EventDone{
				Stop: provider.StopToolUse,
				Message: provider.Message{
					Role:    provider.RoleAssistant,
					Content: []provider.Content{tc},
				},
			}
		}()
		return out, nil
	}

	return singleMessageStream(req.Model, fmt.Sprintf("Inspected step %d", callIdx+1), provider.Usage{InputTokens: 100, OutputTokens: 20}), nil
}

func singleMessageStream(model, text string, usage provider.Usage) <-chan provider.Event {
	out := make(chan provider.Event, 8)
	go func() {
		defer close(out)
		out <- provider.EventStart{Provider: "anthropic", Model: model}
		out <- provider.EventTextDelta{Delta: text}
		out <- provider.EventUsage{Usage: usage}
		out <- provider.EventDone{
			Stop: provider.StopEnd,
			Message: provider.Message{
				Role:    provider.RoleAssistant,
				Content: []provider.Content{provider.TextBlock{Text: text}},
			},
		}
	}()
	return out
}

func TestHysteresisWireImageWindow6To3AndRereadCacheHit(t *testing.T) {
	client := &scriptedVisionClient{}
	reg := NewRegistry(fakeImageReadTool{})
	ag := NewAgent(client, "claude-sonnet-4-6", "sys", reg)
	ag.MaxWireImages = 6
	ag.KeepWireImages = 3

	// Run 10 sequential turns, each reading img-1.png .. img-10.png.
	// Expected live image counts on the post-tool main request of each turn:
	// Turn 1..6: 1, 2, 3, 4, 5, 6 (no eviction yet!)
	// Turn 7 (7th image read > 6): latches down to 3 (evicts img-1..img-4 -> keeps img-5, img-6, img-7)
	// Turn 8..10: grows 4, 5, 6 WITHOUT re-evicting img-5!
	wantPostReadLive := []int{1, 2, 3, 4, 5, 6, 3, 4, 5, 6}
	for i := 1; i <= 10; i++ {
		imgName := fmt.Sprintf("img-%d.png", i)
		client.mu.Lock()
		client.nextReadPath = imgName
		client.mu.Unlock()

		if err := ag.Prompt(context.Background(), fmt.Sprintf("Read %s", imgName), nil, nil); err != nil {
			t.Fatalf("turn %d Prompt failed: %v", i, err)
		}
		client.mu.Lock()
		lastReq := client.mainRequests[len(client.mainRequests)-1]
		client.mu.Unlock()

		gotLive, livePaths := countRequestLiveImages(lastReq.Messages)
		if gotLive != wantPostReadLive[i-1] {
			t.Fatalf("turn %d: expected %d live wire images, got %d (%v)", i, wantPostReadLive[i-1], gotLive, livePaths)
		}
	}

	// Verify turns 7..10 only triggered the 4 vision transcriptions at turn 7 (hysteresis prevented churn on 8..10).
	client.mu.Lock()
	visionCallsAfter10 := append([]string(nil), client.visionCalls...)
	lastReq10 := client.mainRequests[len(client.mainRequests)-1]
	client.mu.Unlock()
	if len(visionCallsAfter10) != 4 {
		t.Fatalf("expected exactly 4 vision transcriptions across 10 reads (6->3 latch), got %d: %v", len(visionCallsAfter10), visionCallsAfter10)
	}

	// Verify dehydrated wire blocks carry [Visual Digest — img-1.png ...] + OCR text,
	// while raw ag.History() still preserves all 10 ImageBlocks untouched for WAL/UI!
	serializedWire := SerializeConversation(lastReq10.Messages)
	if !strings.Contains(serializedWire, "[Visual Digest — img-1.png") || !strings.Contains(serializedWire, "ERR_CODE_IMG-1") {
		t.Fatalf("expected wire messages to contain Visual Digest + OCR for img-1.png, got:\n%s", serializedWire)
	}
	rawLive, _ := countRequestLiveImages(ag.History())
	if rawLive != 10 {
		t.Fatalf("expected raw agent history to preserve all 10 ImageBlocks untouched, got %d", rawLive)
	}
	if ag.Cost().InputTokens <= 20*100 {
		t.Fatalf("expected subagent vision usage recorded on agent.Cost(), got %+v", ag.Cost())
	}

	// Turn 11: re-read img-1.png at a NEW msgIdx!
	// Now live count reaches 7 -> latches down to 3 (img-9, img-10, and the NEW img-1!).
	// Moreover img-1's SHA256 digest is ALREADY cached, while img-5..img-8 get transcribed (4 new vision calls, NOT re-transcribing img-1).
	client.mu.Lock()
	client.nextReadPath = "img-1.png"
	client.mu.Unlock()
	if err := ag.Prompt(context.Background(), "Re-read img-1.png fresh", nil, nil); err != nil {
		t.Fatalf("turn 11 re-read failed: %v", err)
	}
	client.mu.Lock()
	lastReq11 := client.mainRequests[len(client.mainRequests)-1]
	visionCallsAfter11 := append([]string(nil), client.visionCalls...)
	client.mu.Unlock()

	gotLive11, livePaths11 := countRequestLiveImages(lastReq11.Messages)
	if gotLive11 != 3 || livePaths11[len(livePaths11)-1] != "img-1.png" {
		t.Fatalf("expected re-read img-1.png at new msgIdx to stay LIVE in 3-image tail, got %d (%v)", gotLive11, livePaths11)
	}
	img1Transcriptions := 0
	for _, p := range visionCallsAfter11 {
		if p == "img-1.png" {
			img1Transcriptions++
		}
	}
	if img1Transcriptions != 1 {
		t.Fatalf("expected img-1.png to be transcribed only ONCE thanks to SHA256 digest cache, got %d (%v)", img1Transcriptions, visionCallsAfter11)
	}
}

func TestVisionDigestDeterministicFallbackAndWarmPrefix400FallbackToSummarizer(t *testing.T) {
	// 1. Deterministic fallback when vision transcription errors: extracts metadata + nearby assistant observations.
	client := &scriptedVisionClient{
		failVision:  true,
		warmForkErr: errors.New(`anthropic http 400: {"type":"error","error":{"type":"invalid_request_error","message":"Too many images: 8 > 5"}}`),
	}
	reg := NewRegistry(fakeImageReadTool{})
	ag := NewAgent(client, "claude-sonnet-4-6", "sys", reg)
	ag.MaxWireImages = 2
	ag.KeepWireImages = 1

	img1 := provider.ImageBlock{MimeType: "image/jpeg", Data: []byte("raw-1"), SourcePath: "auth-error.png", Width: 1568, Height: 882, OrigWidth: 3840, OrigHeight: 2160}
	img2 := provider.ImageBlock{MimeType: "image/jpeg", Data: []byte("raw-2"), SourcePath: "net-panel.png", Width: 1280, Height: 720}
	img3 := provider.ImageBlock{MimeType: "image/jpeg", Data: []byte("raw-3"), SourcePath: "final-fix.png", Width: 1280, Height: 720}

	ag.SetMessages([]provider.Message{
		{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "Inspect auth screenshot"}, img1}},
		{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "The screenshot shows HTTP 502 Bad Gateway and ECONNREFUSED on 127.0.0.1:5432."}}},
		{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "Here is network panel"}, img2}},
		{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "Network waterfall confirms /api/login timed out after 30000ms."}}},
		{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "And final fix"}, img3}},
		{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "Login succeeded with 200 OK."}}},
	})

	if err := ag.Prompt(context.Background(), "Summarize status", nil, nil); err != nil {
		t.Fatalf("Prompt with fallback digests failed: %v", err)
	}
	chain := ag.CompactionChain()
	if chain == nil {
		t.Fatalf("expected non-nil CompactionState with cached fallback digests")
	}
	d1 := chain.ImageDigests[provider.ImageKey(img1)]
	if !strings.Contains(d1, "auth-error.png") || !strings.Contains(d1, "ECONNREFUSED") {
		t.Fatalf("expected deterministic fallback digest to include metadata + nearby assistant observation, got:\n%s", d1)
	}

	// Verify SerializeConversationWithDigests includes [Visual Digest — ...] for user/tool images.
	ser := SerializeConversationWithDigests(ag.History(), chain.ImageDigests)
	if !strings.Contains(ser, "[Visual Digest — auth-error.png") || !strings.Contains(ser, "ECONNREFUSED") {
		t.Fatalf("expected SerializeConversationWithDigests to include digest text, got:\n%s", ser)
	}

	// 2. Compact: warm-prefix fork fails with 400 Too many images -> MUST fall back to standalone runSummarizer
	// (NOT MechanicalBlockSummary!) and pass digested text to standalone summarizer.
	summary, err := ag.Compact(context.Background(), 2, nil)
	if err != nil {
		t.Fatalf("Compact failed: %v", err)
	}
	if !strings.Contains(summary, "Standalone narrative summary preserving OCR details") {
		t.Fatalf("expected standalone LLM summarizer output instead of mechanical summary, got:\n%s", summary)
	}
	client.mu.Lock()
	standaloneCount := len(client.standaloneCalls)
	var standalonePrompt string
	if standaloneCount > 0 {
		standalonePrompt = SerializeConversation(client.standaloneCalls[0].Messages)
	}
	client.mu.Unlock()
	if standaloneCount != 1 || !strings.Contains(standalonePrompt, "ECONNREFUSED") {
		t.Fatalf("expected 1 pixel-free standalone summarizer call carrying OCR digest, got %d calls, prompt:\n%s", standaloneCount, standalonePrompt)
	}
}

func TestReactiveVisionSheddingAndFiniteOverflowTermination(t *testing.T) {
	mkImages := func(n int) []provider.Message {
		var msgs []provider.Message
		for i := 1; i <= n; i++ {
			img := provider.ImageBlock{
				MimeType:   "image/jpeg",
				Data:       []byte(fmt.Sprintf("bytes-%d", i)),
				SourcePath: fmt.Sprintf("shot-%d.png", i),
				Width:      1024,
				Height:     768,
			}
			msgs = append(msgs,
				provider.Message{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: fmt.Sprintf("img %d", i)}, img}},
				provider.Message{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: fmt.Sprintf("observed %d", i)}}},
			)
		}
		return msgs
	}

	t.Run("400_too_many_images_escaped_gt_learns_cap_and_recovers", func(t *testing.T) {
		client := &scriptedVisionClient{}
		client.mainHandler = func(callIdx int, req provider.Request) (provider.Message, error) {
			live, _ := countRequestLiveImages(req.Messages)
			if live > 2 {
				return provider.Message{}, errors.New(`anthropic http 400: {"error":{"message":"Too many images: 5 \u003e 2"}}`)
			}
			return provider.Message{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "recovered at <=2 images"}}}, nil
		}
		ag := NewAgent(client, "m", "sys", NewRegistry())
		ag.SetMessages(mkImages(5))
		if err := ag.Prompt(context.Background(), "go", nil, nil); err != nil {
			t.Fatalf("expected reactive recovery on 5 > 2 cap, got: %v", err)
		}
		st := ag.CompactionChain()
		if st == nil || st.LearnedMaxImages == nil || *st.LearnedMaxImages != 2 {
			t.Fatalf("expected *LearnedMaxImages == 2, got %+v", st)
		}
		if len(client.mainRequests) != 2 {
			t.Fatalf("expected 2 main requests (1 fail + 1 immediate recovery), got %d", len(client.mainRequests))
		}
	})

	t.Run("400_vision_unsupported_learns_zero_without_vision_subcalls", func(t *testing.T) {
		client := &scriptedVisionClient{}
		client.mainHandler = func(callIdx int, req provider.Request) (provider.Message, error) {
			live, _ := countRequestLiveImages(req.Messages)
			if live > 0 {
				return provider.Message{}, errors.New(`openai http 400: model does not support image input`)
			}
			return provider.Message{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "text-only recovered"}}}, nil
		}
		ag := NewAgent(client, "deepseek-chat", "sys", NewRegistry())
		ag.SetMessages(mkImages(3))
		if err := ag.Prompt(context.Background(), "go", nil, nil); err != nil {
			t.Fatalf("expected reactive recovery for text-only model, got: %v", err)
		}
		st := ag.CompactionChain()
		if st == nil || st.LearnedMaxImages == nil || *st.LearnedMaxImages != 0 {
			t.Fatalf("expected *LearnedMaxImages == 0, got %+v", st)
		}
		if len(client.visionCalls) != 0 {
			t.Fatalf("expected ZERO vision transcription subcalls when model rejects vision, got %v", client.visionCalls)
		}
	})

	t.Run("413_payload_too_large_halves_down_and_recovers", func(t *testing.T) {
		client := &scriptedVisionClient{}
		client.mainHandler = func(callIdx int, req provider.Request) (provider.Message, error) {
			live, _ := countRequestLiveImages(req.Messages)
			if live > 1 {
				return provider.Message{}, errors.New(`anthropic http 413: Payload Too Large`)
			}
			return provider.Message{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "413 recovered"}}}, nil
		}
		ag := NewAgent(client, "m", "sys", NewRegistry())
		ag.SetMessages(mkImages(4))
		if err := ag.Prompt(context.Background(), "go", nil, nil); err != nil {
			t.Fatalf("expected 413 halving recovery (4 -> 2 -> 1), got: %v", err)
		}
		if len(client.mainRequests) != 3 {
			t.Fatalf("expected 3 main requests (4 -> 2 -> 1), got %d", len(client.mainRequests))
		}
	})

	t.Run("context_overflow_dehydrates_images_and_terminates_finitely_after_pass_2", func(t *testing.T) {
		client := &scriptedVisionClient{}
		var seenLiveCounts []int
		client.mainHandler = func(callIdx int, req provider.Request) (provider.Message, error) {
			live, _ := countRequestLiveImages(req.Messages)
			seenLiveCounts = append(seenLiveCounts, live)
			return provider.Message{}, errors.New(`anthropic http 400: prompt is too long: 250000 tokens > 200000 maximum`)
		}
		ag := NewAgent(client, "m", "sys", NewRegistry())
		ag.SetMessages(mkImages(4))
		err := ag.Prompt(context.Background(), "go", nil, nil)
		if err == nil || !IsContextOverflow(err) {
			t.Fatalf("expected terminal context overflow error after Pass 2, got: %v", err)
		}
		// CRITICAL: must NEVER enter infinite retry loop! Exactly 3 main attempts:
		// Attempt 1 (initial: 4 images) -> Pass 1 (<=2 images) -> Pass 2 (0 images) -> STOP!
		if len(seenLiveCounts) != 3 {
			t.Fatalf("expected finite termination in exactly 3 main attempts (no infinite retry loop!), got %d attempts: %v", len(seenLiveCounts), seenLiveCounts)
		}
		if seenLiveCounts[1] > 2 {
			t.Fatalf("expected Overflow Pass 1 to cap live images <= 2, got %d", seenLiveCounts[1])
		}
		if seenLiveCounts[2] != 0 {
			t.Fatalf("expected Overflow Pass 2 to dehydrate live images to 0, got %d", seenLiveCounts[2])
		}
	})
}
