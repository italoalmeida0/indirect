package expand

import (
	"regexp"
	"sync"

	"mvdan.cc/sh/v3/pattern"
)

// Shell code tends to run the same parameter-expansion patterns in hot
// loops (think ${var#pat} inside a while loop), and recompiling the
// pattern translation and regexp dominates those loops. Memoize both
// stages; the caches are bounded so pathological scripts can't grow
// them forever.

const patCacheMax = 2048

type removePatKey struct {
	pat      string
	fromEnd  bool
	shortest bool
}

var (
	patMu    sync.Mutex
	patCache = map[string]string{}
	reMu     sync.Mutex
	reCache  = map[string]*regexp.Regexp{}

	remReMu    sync.RWMutex
	remReCache = map[removePatKey]*regexp.Regexp{}

	findReMu    sync.RWMutex
	findReCache = map[string]*regexp.Regexp{}
)

// cachedPattern memoizes pattern.Regexp (shell pattern -> regex source).
func cachedPattern(pat string, mode pattern.Mode) (string, error) {
	key := string(rune(mode)) + "\x00" + pat
	patMu.Lock()
	re, ok := patCache[key]
	patMu.Unlock()
	if ok {
		return re, nil
	}
	re, err := pattern.Regexp(pat, mode)
	if err != nil {
		return "", err
	}
	patMu.Lock()
	if len(patCache) >= patCacheMax {
		patCache = map[string]string{}
	}
	patCache[key] = re
	patMu.Unlock()
	return re, nil
}

// cachedRegexp memoizes regexp.MustCompile of the final regex source.
func cachedRegexp(re string) *regexp.Regexp {
	reMu.Lock()
	rx, ok := reCache[re]
	reMu.Unlock()
	if ok {
		return rx
	}
	rx = regexp.MustCompile(re)
	reMu.Lock()
	if len(reCache) >= patCacheMax {
		reCache = map[string]*regexp.Regexp{}
	}
	reCache[re] = rx
	reMu.Unlock()
	return rx
}

// cachedRemoveRegexp memoizes the anchored *regexp.Regexp for ${var#pat},
// ${var##pat}, ${var%pat}, and ${var%%pat} in a single read-locked lookup.
func cachedRemoveRegexp(pat string, fromEnd, shortest bool) (*regexp.Regexp, bool) {
	key := removePatKey{pat: pat, fromEnd: fromEnd, shortest: shortest}
	remReMu.RLock()
	rx, ok := remReCache[key]
	remReMu.RUnlock()
	if ok {
		return rx, rx != nil
	}
	var mode pattern.Mode
	if shortest {
		mode |= pattern.Shortest
	}
	expr, err := pattern.Regexp(pat, mode)
	if err != nil {
		return nil, false
	}
	switch {
	case fromEnd && shortest:
		expr = ".*(" + expr + ")$"
	case fromEnd:
		expr = "(" + expr + ")$"
	default:
		expr = "^(" + expr + ")"
	}
	rx = regexp.MustCompile(expr)
	remReMu.Lock()
	if len(remReCache) >= patCacheMax {
		remReCache = map[removePatKey]*regexp.Regexp{}
	}
	remReCache[key] = rx
	remReMu.Unlock()
	return rx, true
}

// cachedFindRegexp memoizes the compiled *regexp.Regexp for ${var/pat/rep}.
func cachedFindRegexp(pat string) (*regexp.Regexp, bool) {
	findReMu.RLock()
	rx, ok := findReCache[pat]
	findReMu.RUnlock()
	if ok {
		return rx, rx != nil
	}
	expr, err := pattern.Regexp(pat, 0)
	if err != nil {
		return nil, false
	}
	rx = regexp.MustCompile(expr)
	findReMu.Lock()
	if len(findReCache) >= patCacheMax {
		findReCache = map[string]*regexp.Regexp{}
	}
	findReCache[pat] = rx
	findReMu.Unlock()
	return rx, true
}
