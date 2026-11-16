package provider

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAnthropicTruncatedTextStreamWithoutMessageStopErrors(t *testing.T) {
	// A network drop mid-text/mid-thinking (after message_start, before
	// message_stop) must report StopError so core.Agent drops the torn partial
	// message and retries instead of mistaking a dropped TCP stream for end_turn.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl, _ := w.(http.Flusher)
		_, _ = w.Write([]byte("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"m\",\"usage\":{\"input_tokens\":15}}}\n\n"))
		_, _ = w.Write([]byte("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n"))
		_, _ = w.Write([]byte("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"half sentence before socket drop\"}}\n\n"))
		if fl != nil {
			fl.Flush()
		}
		// Close handler without message_stop.
	}))
	defer srv.Close()

	c := NewAnthropic("x", srv.URL)
	evs, err := c.Stream(context.Background(), Request{Model: "m"})
	if err != nil {
		t.Fatal(err)
	}
	var done EventDone
	for ev := range evs {
		if d, ok := ev.(EventDone); ok {
			done = d
		}
	}
	if done.Stop != StopError || done.Err == nil {
		t.Fatalf("stop=%v err=%v; want StopError on mid-stream disconnect without message_stop", done.Stop, done.Err)
	}
	if !strings.Contains(done.Err.Error(), "truncated") {
		t.Fatalf("err=%q; want truncated stream error", done.Err.Error())
	}
}

func TestAnthropicStreamIdleTimeoutInterruptsHalfOpenSocketWithoutCancellingContext(t *testing.T) {
	prev := ProviderStreamIdleTimeout
	ProviderStreamIdleTimeout = 60 * time.Millisecond
	defer func() { ProviderStreamIdleTimeout = prev }()

	unblockServer := make(chan struct{})
	defer close(unblockServer)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if fl, ok := w.(http.Flusher); ok {
			_, _ = w.Write([]byte("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"m\",\"usage\":{\"input_tokens\":10}}}\n\n"))
			fl.Flush()
		}
		// Simulate half-open silent socket stall.
		select {
		case <-unblockServer:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()

	ctx := context.Background()
	c := NewAnthropic("x", srv.URL)
	evs, err := c.Stream(ctx, Request{Model: "m"})
	if err != nil {
		t.Fatal(err)
	}
	var done EventDone
	for ev := range evs {
		if d, ok := ev.(EventDone); ok {
			done = d
		}
	}
	if ctx.Err() != nil {
		t.Fatalf("caller context must remain uncancelled, got %v", ctx.Err())
	}
	if done.Stop != StopError || done.Err == nil {
		t.Fatalf("expected StopError from idle stream watchdog, got stop=%v err=%v", done.Stop, done.Err)
	}
	if !strings.Contains(done.Err.Error(), "idle timeout") && !strings.Contains(done.Err.Error(), "stream interrupted") {
		t.Fatalf("unexpected idle timeout error: %v", done.Err)
	}
}
