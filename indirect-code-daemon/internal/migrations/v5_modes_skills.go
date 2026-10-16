package migrations

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// v5 collapses the four legacy session modes (build/plan/learning/talk) to
// the two base modes (agentic/talk). The legacy behavioral prompts become
// BUILTIN SKILLS (builtin_skills/*.md, embedded in the daemon binary and
// never written to the machine): a migrated build/plan/learning session
// becomes an agentic session whose main skill is the old mode, so its
// behavior is preserved exactly — the skill name resolves to the builtin
// at runtime. talk stays talk (no skill needed).
//
// Two rewrites:
//
//  1. Every session meta line: options.mode build|plan|learning -> agentic
//     plus a "skills" entry naming the migrated mode as the main skill
//     (priority 1, active, usable ask).
//  2. Talk sessions move to the default Home project: their meta "cwd" is
//     rewritten to the user's home directory. Talk has no workspace — the
//     cwd only decided which project grouped the conversation — and new
//     talk sessions are created in Home, so existing ones join them.
//
// Skill DEFINITIONS are never seeded to disk: builtin names are reserved
// and a same-name file in the skills directory is ignored at load.
//
// Idempotent: a second run finds no legacy mode and writes nothing. Meta lines are preserved byte-for-byte
// apart from the two fields above (unknown fields untouched); rewrite is
// atomic via tmp + rename.

func init() {
	register(Migration{Version: 5, Name: "collapse modes to agentic/talk, mode skills, talk sessions to Home", Apply: applyV5, Verify: verifyV5})
}

// v5LegacyModes maps the legacy mode enum to its replacement base mode and
// the skill that carries the old behavior.
var v5LegacyModes = map[string]string{
	"build":    "agentic",
	"plan":     "agentic",
	"learning": "agentic",
}

// v5LegacySkill maps a legacy mode to the builtin skill carrying its
// behavior (embedded in the daemon binary from builtin_skills/*.md —
// migrations never embed prompt strings).
var v5LegacySkill = map[string]string{
	"build":    "build",
	"plan":     "plan",
	"learning": "learning",
}

func applyV5(slotDir string) error {
	// Skill DEFINITIONS are never seeded anywhere: they live embedded in
	// the daemon binary (builtin_skills/*.md) and builtin names are
	// reserved at load. This migration only rewrites session meta:
	// collapse legacy modes and move talk sessions to Home.
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

// verifyV5 confirms no legacy mode survived the collapse and every talk
// session sits in Home.
func verifyV5(slotDir string) error {
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
