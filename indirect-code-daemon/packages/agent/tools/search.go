package tools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"indirect/indirect-code-daemon/packages/core"
	"indirect/indirect-code-daemon/packages/ignore"
	"indirect/indirect-code-daemon/packages/provider"
)

// searchSoftTimeout caps a single foreground search call so an enormous or
// network-mounted directory returns partial/truncated results instead of
// hanging the turn or tripping the session watchdog. Overridable in tests.
var searchSoftTimeout = 90 * time.Second

const toolHeartbeatInterval = 2 * time.Second

var errToolSoftTimeout = errors.New("tool soft time budget reached")

type SearchArgs struct {
	// Pattern is always an RE2 regular expression.
	Pattern string `json:"pattern"`
	// Path scopes the search (workspace-relative file or dir, default ".").
	Path string `json:"path,omitempty"`
	// Include limits files by glob(s), e.g. ["*.ts", "*.tsx"].
	Include []string `json:"include,omitempty"`
	// Exclude skips files by glob(s), e.g. ["dist/**", "*.min.js"].
	Exclude []string `json:"exclude,omitempty"`
	// MaxResults caps returned matches (default 50, max 200).
	MaxResults int `json:"max_results,omitempty"`
	// ContextLines includes N lines before/after each match (default 0, max 20).
	ContextLines int `json:"context_lines,omitempty"`
	// CaseSensitive enables case-sensitive matching (default false).
	CaseSensitive bool `json:"case_sensitive,omitempty"`
	// OnlyMatching returns only the matched substrings per line (grep -o):
	// one entry per match with col pointing at the match start instead of
	// one entry per matching line.
	OnlyMatching bool `json:"only_matching,omitempty"`
	// Count returns per-file match counts instead of individual matches
	// (grep -c): one "file: N matches" line per file with matches.
	Count bool `json:"count,omitempty"`
	// FilesOnly returns only file paths with at least one match (grep -l),
	// one path per line, no line/col/text.
	FilesOnly bool `json:"files_only,omitempty"`
	// RespectGitignore skips gitignored files (default true).
	RespectGitignore *bool `json:"respect_gitignore,omitempty"`
	// MaxFileBytes skips files larger than this (default 1MB).
	MaxFileBytes int64 `json:"max_file_bytes,omitempty"`
}

type SearchMatch struct {
	File    string   `json:"file"`
	Line    int      `json:"line"`
	Col     int      `json:"col"`
	Text    string   `json:"text"`
	Context []string `json:"context,omitempty"`
}

// SearchTool is structured content search (grep, but machine-readable).
// Returns [{file, line, col, text}] with optional context lines — the model
// can open exact locations with read instead of re-scanning output text.
type SearchTool struct {
	CWD     string
	Sandbox *Sandbox
}

func (t *SearchTool) Name() string { return "search" }

func (t *SearchTool) Description() string {
	return "Search file contents with an RE2 regular expression. Params: `pattern` (required regex), `path` (file/dir scope, default '.'), `include`/`exclude` globs, `max_results` (default 50, max 200), `context_lines` (default 0, max 20), `case_sensitive` (default false), `only_matching` (grep -o: one entry per match), `count` (grep -c: per-file counts), `files_only` (grep -l: paths only), `respect_gitignore` (default true). Returns structured matches [{file, line, col, text}] — open hits with read."
}

const searchSchema = `{"type":"object","required":["pattern"],"properties":{"pattern":{"type":"string","description":"RE2 regular expression to find."},"path":{"type":"string","description":"Workspace-relative file or dir scope (default '.')."},"include":{"type":"array","items":{"type":"string"},"description":"File glob patterns to include (e.g. ['*.ts', '*.tsx'])."},"exclude":{"type":"array","items":{"type":"string"},"description":"File glob patterns to exclude (e.g. ['dist/**', '*.min.js'])."},"max_results":{"type":"number","description":"Maximum number of matches to return (default 50, max 200)."},"context_lines":{"type":"number","description":"Number of context lines before and after each match (default 0, max 20)."},"case_sensitive":{"type":"boolean","description":"Case-sensitive search (default false)."},"only_matching":{"type":"boolean","description":"Return only the matched substrings, one entry per match (grep -o)."},"count":{"type":"boolean","description":"Return per-file match counts instead of matches (grep -c)."},"files_only":{"type":"boolean","description":"Return only matching file paths, one per line (grep -l)."},"respect_gitignore":{"type":"boolean","description":"Skip files ignored by git (default true)."},"max_file_bytes":{"type":"number","description":"Skip files larger than this size in bytes (default 1MB)."}}}`

func (t *SearchTool) Schema() json.RawMessage { return json.RawMessage(searchSchema) }

func (t *SearchTool) Execute(ctx context.Context, raw json.RawMessage, progress func(string)) (core.ToolResult, error) {
	var a SearchArgs
	if err := unmarshalArgs(raw, &a); err != nil {
		return core.ToolResult{}, fmt.Errorf("invalid args: %w", err)
	}
	pattern := a.Pattern
	if pattern == "" {
		return core.ToolResult{}, fmt.Errorf("search: `pattern` is required")
	}
	maxResults := a.MaxResults
	if maxResults <= 0 {
		maxResults = 50
	}
	if maxResults > 200 {
		maxResults = 200
	}
	ctxLines := a.ContextLines
	if ctxLines < 0 {
		ctxLines = 0
	}
	if ctxLines > 20 {
		ctxLines = 20
	}
	// count/filesOnly are aggregate modes: context and per-match text add
	// nothing, so they are ignored there (no error — permissive parsing).
	if a.Count || a.FilesOnly {
		ctxLines = 0
	}
	maxBytes := a.MaxFileBytes
	if maxBytes <= 0 {
		maxBytes = 1024 * 1024
	}
	respectIgnore := true
	if a.RespectGitignore != nil {
		respectIgnore = *a.RespectGitignore
	}

	// Compile matcher: pattern is always an RE2 regex.
	src := pattern
	if !a.CaseSensitive {
		src = "(?i)" + src
	}
	re, err := regexp.Compile(src)
	if err != nil {
		return core.ToolResult{}, fmt.Errorf("search: invalid regex: %v", err)
	}
	var rePrefilter *regexp.Regexp
	if !strings.Contains(pattern, `\A`) && !strings.Contains(pattern, `\z`) {
		rePrefilter, _ = regexp.Compile("(?m)" + src)
	}

	// Resolve scope and validate once up front so regular walked children do
	// not pay per-file EvalSymlinks overhead across 50k+ file trees.
	scope := "."
	if p := strings.TrimSpace(a.Path); p != "" {
		scope = p
	}
	givenScope := resolvePath(t.CWD, scope)
	if err := t.Sandbox.CheckReadPath(givenScope); err != nil {
		return core.ToolResult{}, fmt.Errorf("search: invalid path: %v", err)
	}
	st, err := os.Stat(givenScope)
	if err != nil {
		return core.ToolResult{}, fmt.Errorf("search: path not found: %s", scope)
	}
	absScope := givenScope
	if resolved, rerr := filepath.EvalSymlinks(givenScope); rerr == nil {
		if err := t.Sandbox.CheckReadPath(resolved); err != nil {
			return core.ToolResult{}, fmt.Errorf("search: invalid path: %v", err)
		}
		absScope = resolved
	}

	cwdCanon := resolvePath(t.CWD, ".")
	if resolvedCWD, rerr := filepath.EvalSymlinks(cwdCanon); rerr == nil {
		cwdCanon = resolvedCWD
	}

	include, exclude := compileGlobFilter(a.Include, true), compileGlobFilter(a.Exclude, false)

	started := time.Now()
	lastPing := started
	var pingMu sync.Mutex
	maybeHeartbeat := func() {
		if progress == nil {
			return
		}
		pingMu.Lock()
		now := time.Now()
		if now.Sub(lastPing) >= toolHeartbeatInterval {
			lastPing = now
			pingMu.Unlock()
			progress("")
			return
		}
		pingMu.Unlock()
	}

	type searchFile struct {
		abs      string
		relSlash string
	}

	// Collect candidate files.
	var files []searchFile
	timedOut := false
	if !st.IsDir() {
		rel, rerr := filepath.Rel(cwdCanon, absScope)
		if rerr != nil {
			rel, _ = filepath.Rel(t.CWD, givenScope)
		}
		files = []searchFile{{abs: absScope, relSlash: slash(rel)}}
	} else {
		var gi *ignore.Gitignore
		if respectIgnore {
			gi = ignore.Load(absScope)
		}
		err = filepath.WalkDir(absScope, func(p string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			maybeHeartbeat()
			if searchSoftTimeout > 0 && time.Since(started) >= searchSoftTimeout {
				timedOut = true
				return errToolSoftTimeout
			}
			if p == absScope {
				return nil
			}
			rel, rerr := filepath.Rel(cwdCanon, p)
			if rerr != nil {
				rel, _ = filepath.Rel(t.CWD, p)
			}
			if rel == "." {
				return nil
			}
			relSlash := slash(rel)
			// Skip well-known heavy dirs early (also covered by gitignore usually).
			base := filepath.Base(p)
			if d.IsDir() {
				if base == ".git" || base == "node_modules" || base == ".hg" || base == ".svn" {
					return filepath.SkipDir
				}
				if err := t.Sandbox.CheckWalkedReadEntry(p, d); err != nil {
					return filepath.SkipDir
				}
				if respectIgnore && gi != nil && gi.Match(relSlash+"/", true) {
					return filepath.SkipDir
				}
				return nil
			}
			if d.Type()&os.ModeSymlink != 0 {
				if err := t.Sandbox.CheckReadPath(p); err != nil {
					return nil
				}
				info, ierr := os.Stat(p)
				if ierr != nil || !info.Mode().IsRegular() || info.Size() > maxBytes {
					return nil
				}
			} else {
				if !d.Type().IsRegular() {
					return nil
				}
				if err := t.Sandbox.CheckWalkedReadEntry(p, d); err != nil {
					return nil
				}
			}
			if respectIgnore && gi != nil && gi.Match(relSlash, false) {
				return nil
			}
			if !include(rel) {
				return nil
			}
			if exclude(rel) {
				return nil
			}
			files = append(files, searchFile{abs: p, relSlash: relSlash})
			return nil
		})
		if err != nil && !errors.Is(err, errToolSoftTimeout) {
			return core.ToolResult{}, err
		}
	}
	sort.Slice(files, func(i, j int) bool {
		return files[i].relSlash < files[j].relSlash
	})

	type fileScanResult struct {
		relSlash string
		count    int
		hasFile  bool
		matches  []SearchMatch
	}

	scanOne := func(sf searchFile) (fileScanResult, error) {
		if ctx.Err() != nil {
			return fileScanResult{}, ctx.Err()
		}
		data, err := readSearchFile(sf.abs, maxBytes)
		if err != nil || len(data) == 0 || !isText(data) {
			return fileScanResult{}, nil
		}
		// Raw-byte RE2 prefilter: skips 99%+ of non-matching files without
		// string conversion or per-line allocations while preserving ^ / $ semantics.
		if rePrefilter != nil && !rePrefilter.Match(data) {
			return fileScanResult{}, nil
		}
		if a.FilesOnly && rePrefilter != nil {
			return fileScanResult{relSlash: sf.relSlash, hasFile: true}, nil
		}
		lines := strings.Split(string(data), "\n")
		if a.FilesOnly {
			for _, ln := range lines {
				if re.MatchString(ln) {
					return fileScanResult{relSlash: sf.relSlash, hasFile: true}, nil
				}
			}
			return fileScanResult{}, nil
		}
		if a.Count {
			n := 0
			for _, ln := range lines {
				n += len(re.FindAllStringIndex(ln, -1))
			}
			if n > 0 {
				return fileScanResult{relSlash: sf.relSlash, count: n}, nil
			}
			return fileScanResult{}, nil
		}
		var fMatches []SearchMatch
		for i, ln := range lines {
			if ctx.Err() != nil {
				return fileScanResult{}, ctx.Err()
			}
			if a.OnlyMatching {
				for _, loc := range re.FindAllStringIndex(ln, -1) {
					m := SearchMatch{File: sf.relSlash, Line: i + 1, Col: loc[0] + 1, Text: trimLine(ln[loc[0]:loc[1]])}
					if ctxLines > 0 {
						for k := i - ctxLines; k <= i+ctxLines; k++ {
							if k < 0 || k >= len(lines) || k == i {
								continue
							}
							m.Context = append(m.Context, fmt.Sprintf("%d:%s", k+1, trimLine(lines[k])))
						}
					}
					fMatches = append(fMatches, m)
					if len(fMatches) >= maxResults {
						return fileScanResult{relSlash: sf.relSlash, matches: fMatches}, nil
					}
				}
				continue
			}
			loc := re.FindStringIndex(ln)
			if loc == nil {
				continue
			}
			m := SearchMatch{File: sf.relSlash, Line: i + 1, Col: loc[0] + 1, Text: trimLine(ln)}
			if ctxLines > 0 {
				for k := i - ctxLines; k <= i+ctxLines; k++ {
					if k < 0 || k >= len(lines) || k == i {
						continue
					}
					m.Context = append(m.Context, fmt.Sprintf("%d:%s", k+1, trimLine(lines[k])))
				}
			}
			fMatches = append(fMatches, m)
			if len(fMatches) >= maxResults {
				return fileScanResult{relSlash: sf.relSlash, matches: fMatches}, nil
			}
		}
		return fileScanResult{relSlash: sf.relSlash, matches: fMatches}, nil
	}

	var matches []SearchMatch
	counts := map[string]int{}
	var countOrder []string
	var filesOnly []string
	truncated := timedOut

	workers := min(max(runtime.NumCPU(), 2), 8)
	const batchSize = 256
outer:
	for startIdx := 0; startIdx < len(files); startIdx += batchSize {
		if ctx.Err() != nil {
			return core.ToolResult{}, ctx.Err()
		}
		maybeHeartbeat()
		if searchSoftTimeout > 0 && time.Since(started) >= searchSoftTimeout {
			timedOut = true
			truncated = true
			break
		}
		endIdx := min(startIdx+batchSize, len(files))
		batch := files[startIdx:endIdx]
		batchOut := make([]fileScanResult, len(batch))
		wCount := min(workers, len(batch))
		if wCount <= 1 {
			for i, sf := range batch {
				r, scanErr := scanOne(sf)
				if scanErr != nil {
					return core.ToolResult{}, scanErr
				}
				batchOut[i] = r
			}
		} else {
			var wg sync.WaitGroup
			var errOnce sync.Once
			var firstErr error
			idxCh := make(chan int, len(batch))
			for i := range batch {
				idxCh <- i
			}
			close(idxCh)
			wg.Add(wCount)
			for w := 0; w < wCount; w++ {
				go func() {
					defer wg.Done()
					for i := range idxCh {
						if ctx.Err() != nil {
							errOnce.Do(func() { firstErr = ctx.Err() })
							return
						}
						r, scanErr := scanOne(batch[i])
						if scanErr != nil {
							errOnce.Do(func() { firstErr = scanErr })
							return
						}
						batchOut[i] = r
					}
				}()
			}
			wg.Wait()
			if firstErr != nil {
				return core.ToolResult{}, firstErr
			}
		}

		for _, r := range batchOut {
			if a.Count {
				if r.count > 0 {
					if counts[r.relSlash] == 0 {
						countOrder = append(countOrder, r.relSlash)
					}
					counts[r.relSlash] += r.count
				}
				continue
			}
			if a.FilesOnly {
				if r.hasFile {
					filesOnly = append(filesOnly, r.relSlash)
					if len(filesOnly) >= maxResults {
						truncated = true
						break outer
					}
				}
				continue
			}
			for _, m := range r.matches {
				matches = append(matches, m)
				if len(matches) >= maxResults {
					truncated = true
					break outer
				}
			}
		}
	}

	var b strings.Builder
	var attrs []core.Attr
	appendTimeoutNotice := func(sb *strings.Builder) {
		if timedOut {
			attrs = append(attrs, core.Attr{Key: "timed_out", Value: "true"})
			fmt.Fprintf(sb, "\n[search reached its %s time budget after scanning %d candidate files; narrow `path` or `include` globs to scan deeper]\n", searchSoftTimeout.Round(time.Second), len(files))
		}
	}
	if a.Count {
		total := 0
		for _, f := range countOrder {
			total += counts[f]
		}
		attrs = append(attrs,
			core.Attr{Key: "total", Value: fmt.Sprintf("%d", total)},
			core.Attr{Key: "files", Value: fmt.Sprintf("%d", len(countOrder))},
		)
		for i, f := range countOrder {
			if i >= maxResults {
				truncated = true
				break
			}
			fmt.Fprintf(&b, "%s: %d match%s\n", f, counts[f], plural(counts[f]))
		}
		if len(countOrder) == 0 && !timedOut {
			attrs = append(attrs, core.Attr{Key: "info", Value: "no matches"})
		}
		if truncated {
			attrs = append(attrs, core.Attr{Key: "truncated", Value: "true"})
		}
		appendTimeoutNotice(&b)
		return core.ToolResult{
				Content: []provider.Content{provider.TextBlock{Text: b.String()}},
				Attrs:   attrs,
			},
			nil
	}
	if a.FilesOnly {
		attrs = append(attrs, core.Attr{Key: "total", Value: fmt.Sprintf("%d", len(filesOnly))})
		for _, f := range filesOnly {
			fmt.Fprintf(&b, "%s\n", f)
		}
		if len(filesOnly) == 0 && !timedOut {
			attrs = append(attrs, core.Attr{Key: "info", Value: "no matches"})
		}
		if truncated {
			attrs = append(attrs, core.Attr{Key: "truncated", Value: "true"})
		}
		appendTimeoutNotice(&b)
		return core.ToolResult{
				Content: []provider.Content{provider.TextBlock{Text: b.String()}},
				Attrs:   attrs,
			},
			nil
	}

	var nb strings.Builder
	attrs = append(attrs, core.Attr{Key: "total", Value: fmt.Sprintf("%d", len(matches))})
	if truncated {
		attrs = append(attrs, core.Attr{Key: "truncated", Value: "true"})
	}
	for _, m := range matches {
		fmt.Fprintf(&nb, "%s:%d:%d: %s\n", m.File, m.Line, m.Col, m.Text)
		for _, c := range m.Context {
			fmt.Fprintf(&nb, "  %s\n", c)
		}
	}
	if len(matches) == 0 && !timedOut {
		attrs = append(attrs, core.Attr{Key: "info", Value: "no matches"})
	}
	appendTimeoutNotice(&nb)
	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: nb.String()}},
		Attrs:   attrs,
	}, nil
}

func slash(p string) string { return filepath.ToSlash(p) }

func trimLine(s string) string {
	s = strings.TrimRight(s, "\r")
	if len(s) > 300 {
		end := 300
		for end > 0 && !utf8.RuneStart(s[end]) {
			end--
		}
		return s[:end] + "…"
	}
	return s
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "es"
}

func filePlural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// compileGlobFilter compiles once per tool call, not once per visited file.
// Slash-separated patterns share glob's semantics on every OS.
func compileGlobFilter(patterns []string, allowEmpty bool) func(string) bool {
	type pattern struct {
		re       *regexp.Regexp
		hasSlash bool
		prefix   string
	}
	var compiled []pattern
	for _, pat := range patterns {
		re, hasSlash, err := compileGlob(pat)
		if err != nil {
			continue
		}
		prefix := ""
		normalized := filepath.ToSlash(strings.TrimSpace(pat))
		if strings.HasSuffix(normalized, "/**") {
			prefix = strings.TrimSuffix(normalized, "/**")
		}
		compiled = append(compiled, pattern{re, hasSlash, prefix})
	}
	return func(rel string) bool {
		if len(patterns) == 0 {
			return allowEmpty
		}
		relSlash, base := slash(rel), slash(filepath.Base(rel))
		for _, pat := range compiled {
			target := base
			if pat.hasSlash {
				target = relSlash
			}
			if pat.re.MatchString(target) || (pat.prefix != "" && relSlash == pat.prefix) {
				return true
			}
		}
		return false
	}
}

// Bound reads even if a file grows between Stat and Open.
func readSearchFile(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, limit))
	if err != nil {
		return nil, err
	}
	var extra [1]byte
	if n, err := f.Read(extra[:]); n != 0 || err != io.EOF {
		return nil, fmt.Errorf("search: file exceeds size limit or cannot be read")
	}
	return data, nil
}

// isText skips binary files (NUL byte in the first 8KB).
func isText(data []byte) bool {
	n := len(data)
	if n > 8192 {
		n = 8192
	}
	for i := 0; i < n; i++ {
		if data[i] == 0 {
			return false
		}
	}
	return true
}

// resolvePath is defined in read.go (shared workspace-relative join).
