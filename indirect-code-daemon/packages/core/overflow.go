package core

import (
	"regexp"
	"strconv"
	"strings"
)

var contextOverflowPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)prompt is too long`),
	regexp.MustCompile(`(?i)request_too_large`),
	regexp.MustCompile(`(?i)input is too long for requested model`),
	regexp.MustCompile(`(?i)exceeds the context window`),
	regexp.MustCompile(`(?i)exceeds (?:the )?(?:model'?s )?maximum context length`),
	regexp.MustCompile(`(?i)input token count.*exceeds the maximum`),
	regexp.MustCompile(`(?i)tokens in request more than max tokens allowed`),
	regexp.MustCompile(`(?i)maximum prompt length is \d+`),
	regexp.MustCompile(`(?i)reduce the length of (?:either one|the messages)`),
	regexp.MustCompile(`(?i)maximum context length is \d+ tokens`),
	regexp.MustCompile(`(?i)exceeds (?:the )?maximum allowed input length`),
	regexp.MustCompile(`(?i)input \(\d+ tokens\) is longer than the model'?s context length`),
	regexp.MustCompile(`(?i)exceeds the limit of \d+`),
	regexp.MustCompile(`(?i)exceeds the available context size`),
	regexp.MustCompile(`(?i)greater than the context length`),
	regexp.MustCompile(`(?i)context window exceeds limit`),
	regexp.MustCompile(`(?i)exceeded model token limit`),
	regexp.MustCompile(`(?i)context[_ ]length[_ ]exceeded`),
	regexp.MustCompile(`(?i)request entity too large`),
	regexp.MustCompile(`(?i)payload too large`),
	regexp.MustCompile(`(?i)\bhttp 413\b`),
	regexp.MustCompile(`(?i)\bstatus code 413\b`),
	regexp.MustCompile(`(?i)body exceeded`),
	regexp.MustCompile(`(?i)context length is only \d+ tokens`),
	regexp.MustCompile(`(?i)input length.*exceeds.*context length`),
	regexp.MustCompile(`(?i)prompt too long; exceeded (?:max )?context length`),
	regexp.MustCompile(`(?i)too large for model with \d+ maximum context length`),
	regexp.MustCompile(`(?i)prompt has [\d,]+ tokens?, but the configured context size is`),
	regexp.MustCompile(`(?i)model_context_window_exceeded`),
	regexp.MustCompile(`(?i)too many tokens`),
	regexp.MustCompile(`(?i)token limit exceeded`),
}

var contextOverflowExclusions = []*regexp.Regexp{
	regexp.MustCompile(`(?i)^(throttling error|service unavailable):`),
	regexp.MustCompile(`(?i)rate limit`),
	regexp.MustCompile(`(?i)too many requests`),
	regexp.MustCompile(`(?i)\bhttp 429\b`),
	regexp.MustCompile(`(?i)\bstatus code 429\b`),
}

// VisionErrorKind classifies upstream multimodal / payload rejection errors
// so runLoop can shed or dehydrate wire images reactively in-turn.
type VisionErrorKind int

const (
	KindNone VisionErrorKind = iota
	KindImageCountCap
	KindVisionUnsupported
	KindImagePayloadTooLarge
)

// VisionPayloadError describes a parsed multimodal or payload-size rejection.
type VisionPayloadError struct {
	Kind       VisionErrorKind
	MaxAllowed int
	HasMax     bool
}

var visionUnsupportedPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)does not support image`),
	regexp.MustCompile(`(?i)doesn'?t support image`),
	regexp.MustCompile(`(?i)image input is not supported`),
	regexp.MustCompile(`(?i)images? are not supported`),
	regexp.MustCompile(`(?i)vision is not supported`),
	regexp.MustCompile(`(?i)does not support vision`),
	regexp.MustCompile(`(?i)multimodal[^\n]{0,60}not supported`),
	regexp.MustCompile(`(?i)no endpoints found that support image`),
	regexp.MustCompile(`(?i)unsupported content (?:block )?type[^\n]{0,60}image`),
	regexp.MustCompile(`(?i)unknown variant[^\n]{0,60}image`),
	regexp.MustCompile(`(?i)image_url is not supported`),
	regexp.MustCompile(`(?i)modality[^\n]{0,40}image[^\n]{0,40}not supported`),
}

var imageCountCapWithLimitPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)too many images[^\d\n]{0,30}\d+\s*>\s*(\d+)`),
	regexp.MustCompile(`(?i)at most (\d+) images?`),
	regexp.MustCompile(`(?i)maximum (?:number of )?images?[^\d\n]{0,35}(\d+)`),
	regexp.MustCompile(`(?i)max(?:imum)? of (\d+) images?`),
	regexp.MustCompile(`(?i)more than (\d+) images?`),
	regexp.MustCompile(`(?i)up to (\d+) images?`),
	regexp.MustCompile(`(?i)exceeds? (?:the )?(?:maximum|limit) of (\d+) images?`),
	regexp.MustCompile(`(?i)limit[-_ ]mm[-_ ]per[-_ ]prompt[^\d\n]{0,35}(\d+)`),
}

var imageCountCapGenericPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)too many images`),
	regexp.MustCompile(`(?i)limit[-_ ]mm[-_ ]per[-_ ]prompt`),
	regexp.MustCompile(`(?i)image count exceeds`),
}

var imagePayloadTooLargePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)exceeds? max(?:imum)? allowed size for many-image`),
	regexp.MustCompile(`(?i)image exceeds\b`),
	regexp.MustCompile(`(?i)image dimensions? exceed`),
	regexp.MustCompile(`(?i)image[^\n]{0,40}too large`),
	regexp.MustCompile(`(?i)max_pixels`),
	regexp.MustCompile(`(?i)base64[^\n]{0,40}too large`),
	regexp.MustCompile(`(?i)\bhttp 413\b`),
	regexp.MustCompile(`(?i)\bstatus code 413\b`),
	regexp.MustCompile(`(?i)payload too large`),
	regexp.MustCompile(`(?i)request entity too large`),
	regexp.MustCompile(`(?i)body exceeded`),
}

var unicodeJSONUnescaper = strings.NewReplacer(
	`\u003e`, `>`,
	`\u003E`, `>`,
	`\u003c`, `<`,
	`\u003C`, `<`,
	`\u0026`, `&`,
)

// ClassifyVisionOrPayloadError parses real upstream multimodal and payload-cliff
// errors across Anthropic, OpenAI, OpenRouter, Gemini, vLLM, SGLang, Qwen, and DeepSeek.
func ClassifyVisionOrPayloadError(err error) *VisionPayloadError {
	if err == nil {
		return nil
	}
	msg := strings.TrimSpace(unicodeJSONUnescaper.Replace(err.Error()))
	if msg == "" {
		return nil
	}
	for _, excl := range contextOverflowExclusions {
		if excl.MatchString(msg) {
			return nil
		}
	}

	for _, p := range visionUnsupportedPatterns {
		if p.MatchString(msg) {
			return &VisionPayloadError{
				Kind:       KindVisionUnsupported,
				MaxAllowed: 0,
				HasMax:     true,
			}
		}
	}

	for _, p := range imageCountCapWithLimitPatterns {
		if m := p.FindStringSubmatch(msg); len(m) >= 2 {
			if n, convErr := strconv.Atoi(m[1]); convErr == nil && n >= 0 {
				return &VisionPayloadError{
					Kind:       KindImageCountCap,
					MaxAllowed: n,
					HasMax:     true,
				}
			}
		}
	}
	for _, p := range imageCountCapGenericPatterns {
		if p.MatchString(msg) {
			return &VisionPayloadError{
				Kind:   KindImageCountCap,
				HasMax: false,
			}
		}
	}

	for _, p := range imagePayloadTooLargePatterns {
		if p.MatchString(msg) {
			return &VisionPayloadError{
				Kind: KindImagePayloadTooLarge,
			}
		}
	}
	return nil
}

// IsContextOverflow reports whether an error from an LLM provider indicates
// that the context window length or prompt size was exceeded.
func IsContextOverflow(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.TrimSpace(unicodeJSONUnescaper.Replace(err.Error()))
	if msg == "" {
		return false
	}
	for _, excl := range contextOverflowExclusions {
		if excl.MatchString(msg) {
			return false
		}
	}
	// Image-specific count or vision-modality rejections are handled by
	// ClassifyVisionOrPayloadError, not generic text overflow compaction.
	if vErr := ClassifyVisionOrPayloadError(err); vErr != nil && (vErr.Kind == KindVisionUnsupported || vErr.Kind == KindImageCountCap) {
		return false
	}
	for _, p := range contextOverflowPatterns {
		if p.MatchString(msg) {
			return true
		}
	}
	return false
}

// Non-retryable upstream error patterns: client-caused rejections where
// retrying the identical request can never succeed (400-class, 413, auth).
// Rate limits (429) and 5xx are deliberately absent: those are transient
// and keep the turn alive on the backoff schedule. Context-overflow and
// multimodal rejections are handled in dedicated finite recovery passes
// before canRetryError is consulted, and must NEVER enter infinite backoff.
var nonRetryablePatterns = []*regexp.Regexp{
	regexp.MustCompile(`\bhttp 400\b`),
	regexp.MustCompile(`\bhttp 401\b`),
	regexp.MustCompile(`\bhttp 403\b`),
	regexp.MustCompile(`\bhttp 413\b`),
	regexp.MustCompile(`\bstatus code 400\b`),
	regexp.MustCompile(`\bstatus code 401\b`),
	regexp.MustCompile(`\bstatus code 403\b`),
	regexp.MustCompile(`\bstatus code 413\b`),
	regexp.MustCompile(`(?i)invalid_request_error`),
	regexp.MustCompile(`(?i)authentication_error`),
	regexp.MustCompile(`(?i)invalid_api_key`),
	regexp.MustCompile(`(?i)incorrect api key`),
	regexp.MustCompile(`(?i)payload too large`),
	regexp.MustCompile(`(?i)request entity too large`),
	regexp.MustCompile(`(?i)body exceeded`),
	regexp.MustCompile(`(?i)unsupported (parameter|value)`),
	regexp.MustCompile(`(?i)not supported for .* in /v1/`),
	regexp.MustCompile(`(?i)unrecognized request argument`),
	regexp.MustCompile(`(?i)unknown (parameter|field)`),
	regexp.MustCompile(`(?i)invalid (parameter|value|request)`),
	regexp.MustCompile(`(?i)unsupported protocol scheme`),
	regexp.MustCompile(`(?i)unsupported scheme`),
}

// isRetryableUpstream reports whether an upstream error is worth retrying
// verbatim on the backoff schedule. Context-overflow and vision/payload
// rejections are NEVER retried verbatim here — once agent.go's finite
// compaction/shedding passes are exhausted, they fail fast instead of looping.
func isRetryableUpstream(err error) bool {
	if err == nil {
		return false
	}
	if IsContextOverflow(err) {
		return false
	}
	if ClassifyVisionOrPayloadError(err) != nil {
		return false
	}
	msg := err.Error()
	for _, p := range nonRetryablePatterns {
		if p.MatchString(msg) {
			return false
		}
	}
	return true
}
