package migrations

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// v5 collapses the four legacy session modes (build/plan/learning/talk) to
// the two base modes (agentic/talk). The legacy behavioral prompts become
// BUILTIN SKILLS (builtin_skills/*.js, embedded in the daemon binary and
// never written to the machine): a migrated build/plan/learning session
// becomes an agentic session whose main skill is the old mode, so its
// behavior is preserved exactly — the skill name resolves to the builtin
// at runtime. talk stays talk (no skill needed).
//
// Three rewrites:
//
//  1. Every session meta line: options.mode build|plan|learning -> agentic
//     plus a "skills" entry naming the migrated mode as the main skill
//     (priority 1, active, usable ask).
//  2. Talk sessions move to the default Home project: their meta "cwd" is
//     rewritten to the user's home directory. Talk has no workspace — the
//     cwd only decided which project grouped the conversation — and new
//     talk sessions are created in Home, so existing ones join them.
//  3. User skills switch from Markdown to JavaScript: every parseable
//     skills/*.md becomes an equivalent same-stem .js module and the .md
//     is removed. Unparseable files (already dropped by the old loader)
//     and same-stem .md+.js collisions stay untouched.
//
// Builtin skill DEFINITIONS are never seeded to disk: builtin names are
// reserved and a same-name file in the skills directory is ignored at
// load (it still converts — the user's content is never deleted).
//
// Idempotent: a second run finds no legacy mode and writes nothing. Meta lines are preserved byte-for-byte
// apart from the two fields above (unknown fields untouched); rewrites are
// atomic via tmp + rename.

func init() {
	register(Migration{Version: 5, Name: "collapse modes to agentic/talk, mode skills, talk sessions to Home, JS skills", Apply: applyV5, Verify: verifyV5})
}

// v5LegacyModes maps the legacy mode enum to its replacement base mode and
// the skill that carries the old behavior.
var v5LegacyModes = map[string]string{
	"build":    "agentic",
	"plan":     "agentic",
	"learning": "agentic",
}

// v5LegacySkill maps a legacy mode to the builtin skill carrying its
// behavior (embedded in the daemon binary from builtin_skills/*.js —
// migrations never embed prompt strings).
var v5LegacySkill = map[string]string{
	"build":    "build",
	"plan":     "plan",
	"learning": "learning",
}

func applyV5(slotDir string) error {
	// Builtin skill definitions are never seeded anywhere: they live
	// embedded in the daemon binary (builtin_skills/*.js) and builtin
	// names are reserved at load. USER skills on disk convert in place
	// from the retired Markdown format to JavaScript; session meta then
	// gets its mode collapse and the talk-to-Home move.
	if err := convertLegacySkills(slotDir); err != nil {
		return err
	}
	home, _ := os.UserHomeDir()
	sessions := filepath.Join(slotDir, "sessions")
	entries, err := os.ReadDir(sessions)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		if err := migrateSessionModes(filepath.Join(sessions, e.Name()), home); err != nil {
			return fmt.Errorf("%s: %w", e.Name(), err)
		}
	}
	return nil
}

// convertLegacySkills converts every parseable top-level skills/*.md in
// the slot to an equivalent same-stem .js and removes the .md. Files the
// retired parser rejects stay untouched (the old loader dropped them
// too), and a same-stem .js that differs from the conversion wins: both
// files stay. A .js byte-identical to the conversion means an earlier run
// crashed between write and remove — finishing the remove keeps the
// migration idempotent. Symlinks are never followed or replaced.
func convertLegacySkills(slotDir string) error {
	dir := filepath.Join(slotDir, "skills")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || e.Type()&os.ModeSymlink != 0 || !strings.EqualFold(filepath.Ext(e.Name()), ".md") {
			continue
		}
		names = append(names, e.Name())
	}
	sort.Strings(names)
	for _, name := range names {
		mdPath := filepath.Join(dir, name)
		data, err := os.ReadFile(mdPath)
		if err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		sk, err := parseLegacySkill(mdPath, data)
		if err != nil {
			continue // unparseable: already dropped by the old loader
		}
		rendered := renderLegacySkillJS(sk)
		stem := name[:len(name)-len(filepath.Ext(name))]
		jsPath := filepath.Join(dir, stem+".js")
		if info, statErr := os.Lstat(jsPath); statErr == nil {
			if !info.Mode().IsRegular() {
				continue // collision with something else: leave both
			}
			existing, err := os.ReadFile(jsPath)
			if err != nil {
				return fmt.Errorf("%s: %w", stem+".js", err)
			}
			if bytes.Equal(existing, rendered) {
				if err := os.Remove(mdPath); err != nil && !os.IsNotExist(err) {
					return fmt.Errorf("%s: %w", name, err)
				}
			}
			continue // differing .js wins; the .md stays untouched
		} else if !os.IsNotExist(statErr) {
			return fmt.Errorf("%s: %w", stem+".js", statErr)
		}
		perm := os.FileMode(0o644)
		if info, err := os.Stat(mdPath); err == nil {
			perm = info.Mode().Perm()
		}
		if err := writeSkillFileAtomic(jsPath, rendered, perm); err != nil {
			return fmt.Errorf("%s: %w", stem+".js", err)
		}
		if err := os.Remove(mdPath); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("%s: %w", name, err)
		}
	}
	return nil
}

// writeSkillFileAtomic writes via a temp file in the same directory plus
// rename, so a crash never leaves a torn .js behind.
func writeSkillFileAtomic(path string, data []byte, perm os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".skill-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(perm); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

// verifyLegacySkills confirms every convertible Markdown skill was
// converted: a parseable .md with no same-stem .js (or with only the
// byte-identical conversion still beside it) means apply did not finish.
// Unparseable files and differing collisions are allowed leftovers.
func verifyLegacySkills(slotDir string) error {
	dir := filepath.Join(slotDir, "skills")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, e := range entries {
		if e.IsDir() || e.Type()&os.ModeSymlink != 0 || !strings.EqualFold(filepath.Ext(e.Name()), ".md") {
			continue
		}
		mdPath := filepath.Join(dir, e.Name())
		data, err := os.ReadFile(mdPath)
		if err != nil {
			return fmt.Errorf("%s: %w", e.Name(), err)
		}
		sk, err := parseLegacySkill(mdPath, data)
		if err != nil {
			continue
		}
		stem := e.Name()[:len(e.Name())-len(filepath.Ext(e.Name()))]
		jsPath := filepath.Join(dir, stem+".js")
		existing, err := os.ReadFile(jsPath)
		if err != nil {
			if os.IsNotExist(err) {
				return fmt.Errorf("%s: legacy Markdown skill was not converted to JavaScript", e.Name())
			}
			return fmt.Errorf("%s: %w", stem+".js", err)
		}
		if bytes.Equal(existing, renderLegacySkillJS(sk)) {
			return fmt.Errorf("%s: converted Markdown skill was not removed", e.Name())
		}
	}
	return nil
}

// migrateSessionModes rewrites one session JSONL in place. Returns nil (no
// rewrite) when no legacy mode is present and no talk session needs the
// Home move.
func migrateSessionModes(path, home string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	lines := bytes.Split(raw, []byte("\n"))
	changed := false
	out := make([][]byte, 0, len(lines))
	for _, line := range lines {
		trimmed := bytes.TrimSpace(line)
		if len(trimmed) == 0 {
			out = append(out, line)
			continue
		}
		var probe struct {
			Kind    string          `json:"kind"`
			Options json.RawMessage `json:"options"`
		}
		if err := json.Unmarshal(trimmed, &probe); err != nil || probe.Kind != "meta" {
			out = append(out, line)
			continue
		}
		rewrote, newline := rewriteMetaMode(trimmed, home)
		if !rewrote {
			out = append(out, line)
			continue
		}
		changed = true
		out = append(out, newline)
	}
	if !changed {
		return nil
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, bytes.Join(out, []byte("\n")), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// rewriteMetaMode collapses options.mode and attaches the main skill
// entry; a talk meta gets its cwd rewritten to home (already-home talk
// lines are untouched, keeping the migration idempotent). Returns
// ok=false when the line needs neither rewrite.
func rewriteMetaMode(line []byte, home string) (bool, []byte) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(line, &obj); err != nil {
		return false, nil
	}
	optionsRaw, ok := obj["options"]
	if !ok {
		return false, nil
	}
	var options map[string]json.RawMessage
	if err := json.Unmarshal(optionsRaw, &options); err != nil {
		return false, nil
	}
	var mode string
	if m, ok := options["mode"]; ok {
		_ = json.Unmarshal(m, &mode)
	}
	legacyMode := mode
	base, isLegacy := v5LegacyModes[legacyMode]
	if !isLegacy {
		// Talk sessions belong to the default Home project: point their
		// cwd at the home directory (grouping only — talk never touches
		// the workspace).
		if home != "" && strings.EqualFold(strings.TrimSpace(mode), "talk") {
			var cwd string
			if c, ok := obj["cwd"]; ok {
				_ = json.Unmarshal(c, &cwd)
			}
			if filepath.Clean(cwd) == filepath.Clean(home) {
				return false, nil
			}
			hb, err := json.Marshal(home)
			if err != nil {
				return false, nil
			}
			obj["cwd"] = hb
			out, err := json.Marshal(obj)
			if err != nil {
				return false, nil
			}
			return true, out
		}
		return false, nil
	}
	options["mode"] = json.RawMessage(`"` + base + `"`)
	optBytes, err := json.Marshal(options)
	if err != nil {
		return false, nil
	}
	obj["options"] = optBytes

	// Main skill entry: the legacy mode carries its behavior.
	var skills map[string]json.RawMessage
	if s, ok := obj["skills"]; ok {
		_ = json.Unmarshal(s, &skills)
	}
	if skills == nil {
		skills = map[string]json.RawMessage{}
	}
	if _, exists := skills[legacyMode]; !exists {
		entry := map[string]any{"priority": 1, "active": true, "usable": "ask"}
		if eb, err := json.Marshal(entry); err == nil {
			skills[legacyMode] = eb
		}
		sb, err := json.Marshal(skills)
		if err == nil {
			obj["skills"] = sb
		}
	}
	out, err := json.Marshal(obj)
	if err != nil {
		return false, nil
	}
	return true, out
}

// verifyV5 confirms no legacy mode survived the collapse, every talk
// session sits in Home, and every convertible Markdown skill became JavaScript.
func verifyV5(slotDir string) error {
	if err := verifyLegacySkills(slotDir); err != nil {
		return err
	}
	home, _ := os.UserHomeDir()
	sessions := filepath.Join(slotDir, "sessions")
	entries, err := os.ReadDir(sessions)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(sessions, e.Name()))
		if err != nil {
			return err
		}
		for _, line := range bytes.Split(raw, []byte("\n")) {
			trimmed := bytes.TrimSpace(line)
			if len(trimmed) == 0 {
				continue
			}
			var probe struct {
				Kind    string `json:"kind"`
				CWD     string `json:"cwd"`
				Options struct {
					Mode string `json:"mode"`
				} `json:"options"`
			}
			if err := json.Unmarshal(trimmed, &probe); err != nil || probe.Kind != "meta" {
				continue
			}
			if _, isLegacy := v5LegacyModes[probe.Options.Mode]; isLegacy {
				return fmt.Errorf("%s: legacy mode %q survived migration", e.Name(), probe.Options.Mode)
			}
			if home != "" && strings.EqualFold(strings.TrimSpace(probe.Options.Mode), "talk") && filepath.Clean(probe.CWD) != filepath.Clean(home) {
				return fmt.Errorf("%s: talk session outside Home (cwd %q)", e.Name(), probe.CWD)
			}
		}
	}
	return nil
}
