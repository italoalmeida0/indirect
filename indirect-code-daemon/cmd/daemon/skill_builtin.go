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

// builtinSkillsFS holds the builtin skill DEFINITIONS as real .md files
// (builtin_skills/*.md). They are the customization surface: nothing about
// identity, behavior or turn conventions is hardcoded in Go — if it is not
// protocol, it lives in one of these files (or a user-authored skill).
//
//go:embed builtin_skills/*.md
var builtinSkillsFS embed.FS

var (
	builtinOnce sync.Once
	builtinList map[string]skills.Skill
	builtinErrs []error
)

// builtinSkills parses every embedded builtin_skills/*.md, keyed by skill
// name. The files live ONLY in the binary — they are never copied to the
// machine's skills directory. A builtin that fails to parse is reported and
// skipped (a build bug must never crash the daemon). Parsed once per
// process: the embedded bytes never change.
func builtinSkills() (map[string]skills.Skill, []error) {
	builtinOnce.Do(func() {
		builtinList, builtinErrs = parseBuiltinSkills()
	})
	return builtinList, builtinErrs
}

func parseBuiltinSkills() (map[string]skills.Skill, []error) {
	out := map[string]skills.Skill{}
	var errs []error
	entries, err := fs.ReadDir(builtinSkillsFS, "builtin_skills")
	if err != nil {
		return out, []error{fmt.Errorf("builtin_skills missing from binary: %w", err)}
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".md") {
			continue
		}
		names = append(names, e.Name())
	}
	sort.Strings(names)
	for _, name := range names {
		path := "builtin_skills/" + name
		data, err := builtinSkillsFS.ReadFile(path)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		sk, err := skills.Parse(path, data)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if _, dup := out[sk.Name]; dup {
			errs = append(errs, fmt.Errorf("builtin skill %s: duplicate name %q", name, sk.Name))
			continue
		}
		out[sk.Name] = sk
	}
	return out, errs
}
