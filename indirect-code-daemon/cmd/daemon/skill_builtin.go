package main

import (
	"embed"
	"fmt"
	"io/fs"
	"sort"
	"strings"
	"sync"

	"llm-gateway/indirect-code-daemon/packages/skills"
)

// builtinSkillsFS holds the builtin skill DEFINITIONS as real .js modules
// (builtin_skills/*.js). They are the customization surface: nothing about
// identity, behavior or turn conventions is hardcoded in Go — if it is not
// protocol, it lives in one of these files (or a user-authored skill).
//
//go:embed builtin_skills/*.js
var builtinSkillsFS embed.FS

var (
	builtinOnce    sync.Once
	builtinList    map[string]skills.Skill
	builtinErrs    []error
	builtinSources []skills.Source
)

// builtinSkills parses every embedded builtin_skills/*.js as one module
// set (builtins import each other with `skill:<stem>`), keyed by skill name. The
// files live ONLY in the binary — they are never copied to the machine's
// skills directory. A builtin that fails to parse is reported and skipped
// (a build bug must never crash the daemon). Parsed once per process: the
// embedded bytes never change.
func builtinSkills() (map[string]skills.Skill, []error) {
	builtinOnce.Do(func() {
		builtinList, builtinErrs = parseBuiltinSkills()
	})
	return builtinList, builtinErrs
}

// builtinSkillSources returns the raw embedded module sources so disk
// skills can import builtin modules by stem. The parsed builtin still wins
// by name in the merged store.
func builtinSkillSources() []skills.Source {
	builtinSkills()
	out := make([]skills.Source, len(builtinSources))
	copy(out, builtinSources)
	return out
}

func parseBuiltinSkills() (map[string]skills.Skill, []error) {
	entries, err := fs.ReadDir(builtinSkillsFS, "builtin_skills")
	if err != nil {
		return map[string]skills.Skill{}, []error{fmt.Errorf("builtin_skills missing from binary: %w", err)}
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".js") {
			continue
		}
		names = append(names, e.Name())
	}
	if len(names) == 0 {
		return map[string]skills.Skill{}, []error{fmt.Errorf("builtin_skills holds no .js modules")}
	}
	sort.Strings(names)
	sources := make([]skills.Source, 0, len(names))
	var errs []error
	for _, name := range names {
		path := "builtin_skills/" + name
		data, err := builtinSkillsFS.ReadFile(path)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		sources = append(sources, skills.Source{Path: path, Data: data})
	}
	builtinSources = sources
	out, loadErrs := skills.LoadSet(sources, nil)
	errs = append(errs, loadErrs...)
	return out, errs
}
