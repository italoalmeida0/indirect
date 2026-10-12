package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGatewayModelReasoning(t *testing.T) {
	catalogResponse := map[string]any{
		"models": []map[string]any{
			{
				"id": "model-off",
				"reasoning_parameters": map[string]any{
					"efforts": []string{"off"},
				},
				"supported_features": []string{"tools", "reasoning"},
			},
			{
				"id": "model-none",
				"reasoning_parameters": map[string]any{
					"efforts": []string{"none"},
				},
				"supported_features": []string{"tools"},
			},
			{
				"id": "model-reasoning",
				"reasoning_parameters": map[string]any{
					"efforts": []string{"low", "medium", "high"},
				},
				"supported_features": []string{"tools"},
			},
			{
				"id": "model-reasoning-high",
				"reasoning_parameters": map[string]any{
					"efforts": []string{"high"},
				},
				"supported_features": []string{"tools"},
			},
			{
				"id": "model-mixed-efforts",
				"reasoning_parameters": map[string]any{
					"efforts": []string{"off", "high"},
				},
				"supported_features": []string{"tools"},
			},
		},
	}

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/indirect-code/models" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer test-token" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(catalogResponse)
	}))
	defer ts.Close()

	ctx := context.Background()

	// 1. Model with only "off" effort should NOT be reasoning, even though
	// the gateway advertises a "reasoning" feature.
	mOff := gatewayModel(ctx, ts.URL, "test-token", "model-off")
	if mOff.Reasoning {
		t.Fatalf("model-off: expected Reasoning=false, got true")
	}

	// 2. Model with only "none" effort should NOT be reasoning.
	mNone := gatewayModel(ctx, ts.URL, "test-token", "model-none")
	if mNone.Reasoning {
		t.Fatalf("model-none: expected Reasoning=false, got true")
	}

	// 3. Model with reasoning efforts should be reasoning.
	mReasoning := gatewayModel(ctx, ts.URL, "test-token", "model-reasoning")
	if !mReasoning.Reasoning {
		t.Fatalf("model-reasoning: expected Reasoning=true, got false")
	}

	// 4. Model with a single reasoning effort should be reasoning.
	mHigh := gatewayModel(ctx, ts.URL, "test-token", "model-reasoning-high")
	if !mHigh.Reasoning {
		t.Fatalf("model-reasoning-high: expected Reasoning=true, got false")
	}

	// 5. Model with mixed efforts (off + high) should be reasoning.
	mMixed := gatewayModel(ctx, ts.URL, "test-token", "model-mixed-efforts")
	if !mMixed.Reasoning {
		t.Fatalf("model-mixed-efforts: expected Reasoning=true, got false")
	}
}
