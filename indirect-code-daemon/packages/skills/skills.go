// Package skills parses and stores agent skills: markdown files with a
// YAML frontmatter header that declare a behavioral prompt body plus tool
// policy (approval mode and per-tool permissions).
//
// The header must declare keys in strict order:
//
//	name -> description -> usable -> mode -> tools(approvalMode -> permissions)
//
// YAML itself does not preserve key order, so the header is parsed line by
// line and a key arriving out of order is an error naming the file and the
// offending key. Skills with invalid headers are dropped with an error —
// never a crash: a hand-edited .md must not take the daemon down.
package skills

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Policy is how a tool (or one of its argument keys) may run.
type Policy string

const (
	// PolicyDeny removes the tool from the model-facing registry.
	PolicyDeny Policy = "deny"
	// PolicyInherit follows the skill chain's resolved approval mode.
	PolicyInherit Policy = "inherit"
	// PolicyAsk forces human approval even when the chain resolves to yolo.
	PolicyAsk Policy = "ask"
	// PolicyYolo runs without approval even when the chain resolves to ask.
	PolicyYolo Policy = "yolo"
)

// PermSpec is one tool's permission entry: a tool-level policy plus optional
// per-argument-key overrides. Overrides scope to ARGUMENT KEYS only — they
// decide whether the tool may use that argument at all, never inspect the
// argument's value or content.
type PermSpec struct {
	Policy Policy            `json:"policy"`
	Args   map[string]Policy `json:"args,omitempty"`
}

// Skill is one parsed skill definition. Body is the markdown after the
// frontmatter — the text injected inside the <skill></skill> tag.
type Skill struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	// Usable is the skill file's ORIGINAL activation policy: ask (human
	// approval), yolo (free use), deny (AI-hidden and blocked from
	// use_skill, but the user may still activate it from the frontend) or
	// never (base-only: not even the user sees it — it contributes
	// exclusively as an `inherit:` dependency). There is no file-level
	// "inherit" value: if skill.md omits the key, the original is deny.
	// "inherit" exists only at session level, where it means "use this
	// original" (no override).
	Usable string `json:"usable,omitempty"`
	// Mode is the skill's declared base mode ("agentic" or "talk"; empty =
	// unpinned). The FRONTEND derives the session mode from the primary
	// skill and sends it on create/configure; the daemon never derives it,
	// but uses this field to keep other-mode skills out of the model's
	// use_skill listing.
	Mode string `json:"mode,omitempty"`
	// ApprovalMode is "ask" or "yolo"; empty inherits (default "ask" for
	// the first skill in the priority queue).
	ApprovalMode string `json:"approvalMode,omitempty"`
	// Inherit names dependency skills pulled in whenever this skill is
	// active: their bodies ride the prefix and their tool grants apply,
	// regardless of their own `usable` (that only gates direct use).
	// A dependency with usable:deny stays hidden from the model's list.
	Inherit []string `json:"inherit,omitempty"`
	// Permissions doubles as the tool GRANT list: a tool listed here with
	// any policy except deny is granted by this skill (the base registry
	// carries only the mode's auto tools). deny still blocks.
	Permissions map[string]PermSpec `json:"permissions,omitempty"`
	Body        string              `json:"body"`
	Path        string              `json:"path,omitempty"`
}

// headerKeys lists every known top-level key. Order rules: `name` first,
// `tools` last, and the middle keys (description/usable/mode/inherit) may
// appear in any relative order — hand-written .md files put them wherever
// the author reads best.
var headerKeys = []string{"name", "description", "usable", "mode", "inherit", "tools"}

// Parse parses one skill file. name is the fallback skill name (file base)
// when the header omits it — but a name that appears out of order is still
// an error: the file must open with `name:`.
func Parse(filename string, data []byte) (Skill, error) {
	s := Skill{Path: filename}
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	if !strings.HasPrefix(text, "---\n") {
		return s, fmt.Errorf("skill %s: missing frontmatter (file must start with ---)", filepath.Base(filename))
	}
	rest := text[len("---\n"):]
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return s, fmt.Errorf("skill %s: unterminated frontmatter (closing --- not found)", filepath.Base(filename))
	}
	header := rest[:end]
	body := strings.TrimPrefix(rest[end+len("\n---"):], "\n")
	s.Body = strings.TrimRight(body, "\n")

	if err := parseHeader(&s, header); err != nil {
		return Skill{}, err
	}
	if s.Name == "" {
		return Skill{}, fmt.Errorf("skill %s: header key 'name' is required", filepath.Base(filename))
	}
	if s.Description == "" {
		return Skill{}, fmt.Errorf("skill %s: header key 'description' is required", filepath.Base(filename))
	}
	if s.Usable == "" {
		s.Usable = "deny" // no usable key in skill.md: deny is the original
	}
	return s, nil
}

// parseHeader enforces the strict key order while parsing. Only the
// documented shapes are accepted:
//
//	key: value                     (top level)
//	tools:
//	  approvalMode: value
//	  permissions:
//	    tool_name: policy
//	    tool_name: policy { arg: policy, arg2: policy }
type headerParser struct {
	s       *Skill
	keyIdx  int // next allowed top-level key index (0..4)
	inTools bool
	// sub: 0 = top, 1 = under tools, 2 = under tools.permissions
	sub int
}

func parseHeader(s *Skill, header string) error {
	p := &headerParser{s: s}
	for i, raw := range strings.Split(header, "\n") {
		lineNo := i + 2 // frontmatter opens on line 1 ("---")
		line := strings.TrimRight(raw, " \t")
		if strings.TrimSpace(line) == "" || strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " "))
		if indent == 0 {
			if err := p.topLevel(line, lineNo); err != nil {
				return err
			}
			continue
		}
		if err := p.nested(line, indent, lineNo); err != nil {
			return err
		}
	}
	return nil
}

func (p *headerParser) topLevel(line string, lineNo int) error {
	key, value, ok := splitKey(line)
	if !ok {
		return fmt.Errorf("skill %s line %d: expected `key: value`, got %q", filepath.Base(p.s.Path), lineNo, line)
	}
	idx := -1
	for i, k := range headerKeys {
		if k == key {
			idx = i
			break
		}
	}
	if idx < 0 {
		return fmt.Errorf("skill %s line %d: unknown header key %q (allowed: %s)", filepath.Base(p.s.Path), lineNo, key, strings.Join(headerKeys, " -> "))
	}
	// `name` opens, `tools` closes; the middle keys are order-free.
	if key == "name" && p.keyIdx > 0 {
		return p.orderError(key, lineNo)
	}
	if key == "tools" && p.s.Name == "" {
		return fmt.Errorf("skill %s line %d: `name` must come before `tools`", filepath.Base(p.s.Path), lineNo)
	}
	if key != "tools" && p.inTools {
		return fmt.Errorf("skill %s line %d: %q cannot follow `tools:` (tools must be the last key)", filepath.Base(p.s.Path), lineNo, key)
	}
	if key == "tools" {
		if strings.TrimSpace(value) != "" {
			return fmt.Errorf("skill %s line %d: `tools:` takes no inline value; nest approvalMode/permissions below it", filepath.Base(p.s.Path), lineNo)
		}
		p.inTools = true
		p.sub = 1
		p.keyIdx = idx + 1
		return nil
	}
	value = strings.TrimSpace(value)
	switch key {
	case "name":
		p.s.Name = unquote(value)
	case "description":
		p.s.Description = unquote(value)
	case "inherit":
		list, err := parseInlineList(value, filepath.Base(p.s.Path), lineNo)
		if err != nil {
			return err
		}
		p.s.Inherit = list
	case "usable":
		if err := checkPolicyValue(value, []string{"deny", "never", "ask", "yolo"}); err != nil {
			return fmt.Errorf("skill %s line %d: %v", filepath.Base(p.s.Path), lineNo, err)
		}
		p.s.Usable = value
	case "mode":
		if value != "agentic" && value != "talk" {
			return fmt.Errorf("skill %s line %d: `mode` must be agentic or talk, got %q", filepath.Base(p.s.Path), lineNo, value)
		}
		p.s.Mode = value
	}
	p.keyIdx = idx + 1
	return nil
}

func (p *headerParser) nested(line string, indent, lineNo int) error {
	if !p.inTools {
		return fmt.Errorf("skill %s line %d: unexpected indentation outside `tools:`", filepath.Base(p.s.Path), lineNo)
	}
	key, value, ok := splitKey(line)
	if !ok {
		return fmt.Errorf("skill %s line %d: expected `key: value`, got %q", filepath.Base(p.s.Path), lineNo, line)
	}
	switch p.sub {
	case 1: // under tools:
		if indent != 2 {
			return fmt.Errorf("skill %s line %d: keys under `tools:` must be indented 2 spaces", filepath.Base(p.s.Path), lineNo)
		}
		switch key {
		case "approvalMode":
			if err := checkPolicyValue(value, []string{"ask", "yolo"}); err != nil {
				return fmt.Errorf("skill %s line %d: %v", filepath.Base(p.s.Path), lineNo, err)
			}
			p.s.ApprovalMode = strings.TrimSpace(value)
		case "permissions":
			if strings.TrimSpace(value) != "" {
				return fmt.Errorf("skill %s line %d: `permissions:` takes no inline value", filepath.Base(p.s.Path), lineNo)
			}
			p.s.Permissions = map[string]PermSpec{}
			p.sub = 2
		default:
			return fmt.Errorf("skill %s line %d: unknown key %q under `tools:` (approvalMode -> permissions)", filepath.Base(p.s.Path), lineNo, key)
		}
		return nil
	case 2: // under tools.permissions:
		if indent != 4 {
			return fmt.Errorf("skill %s line %d: permission entries must be indented 4 spaces", filepath.Base(p.s.Path), lineNo)
		}
		spec, err := parsePermSpec(value, filepath.Base(p.s.Path), lineNo)
		if err != nil {
			return err
		}
		p.s.Permissions[key] = spec
		return nil
	}
	return fmt.Errorf("skill %s line %d: unexpected nested key %q", filepath.Base(p.s.Path), lineNo, key)
}

func (p *headerParser) orderError(key string, lineNo int) error {
	return fmt.Errorf("skill %s line %d: key %q out of order (required order: %s)",
		filepath.Base(p.s.Path), lineNo, key, strings.Join(headerKeys, " -> "))
}

// parsePermSpec parses `policy` or `policy { arg: policy, arg2: policy }`.
func parsePermSpec(value, file string, lineNo int) (PermSpec, error) {
	value = strings.TrimSpace(value)
	spec := PermSpec{}
	if i := strings.Index(value, "{"); i >= 0 {
		if !strings.HasSuffix(value, "}") {
			return spec, fmt.Errorf("skill %s line %d: unclosed { in permission %q", file, lineNo, value)
		}
		base := strings.TrimSpace(value[:i])
		inner := strings.TrimSpace(value[i+1 : len(value)-1])
		if err := checkPolicyValue(base, []string{"deny", "inherit", "ask", "yolo"}); err != nil {
			return spec, fmt.Errorf("skill %s line %d: %v (a listed tool must carry a value; leave the key out to inherit)", file, lineNo, err)
		}
		spec.Policy = Policy(base)
		spec.Args = map[string]Policy{}
		if inner != "" {
			for _, part := range strings.Split(inner, ",") {
				argKey, argVal, ok := splitKey(strings.TrimSpace(part))
				if !ok {
					return spec, fmt.Errorf("skill %s line %d: bad argument override %q (expected `arg: policy`)", file, lineNo, part)
				}
				if err := checkPolicyValue(argVal, []string{"deny", "inherit", "ask", "yolo"}); err != nil {
					return spec, fmt.Errorf("skill %s line %d: %v (a listed argument must carry a value; leave the key out to inherit)", file, lineNo, err)
				}
				spec.Args[argKey] = Policy(argVal)
			}
		}
		return spec, nil
	}
	if err := checkPolicyValue(value, []string{"deny", "inherit", "ask", "yolo"}); err != nil {
		return spec, fmt.Errorf("skill %s line %d: %v (a listed tool must carry a value; leave the key out to inherit)", file, lineNo, err)
	}
	spec.Policy = Policy(value)
	return spec, nil
}

// parseInlineList parses `[a, b, c]` (dependency name lists).
func parseInlineList(value, file string, lineNo int) ([]string, error) {
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(value, "[") || !strings.HasSuffix(value, "]") {
		return nil, fmt.Errorf("skill %s line %d: expected a `[a, b]` list, got %q", file, lineNo, value)
	}
	inner := strings.TrimSpace(value[1 : len(value)-1])
	if inner == "" {
		return nil, nil
	}
	parts := strings.Split(inner, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		name := unquote(strings.TrimSpace(part))
		if name == "" {
			return nil, fmt.Errorf("skill %s line %d: empty name in list %q", file, lineNo, value)
		}
		out = append(out, name)
	}
	return out, nil
}

func checkPolicyValue(value string, allowed []string) error {
	value = strings.TrimSpace(value)
	for _, a := range allowed {
		if value == a {
			return nil
		}
	}
	return fmt.Errorf("policy must be one of %s, got %q", strings.Join(allowed, "|"), value)
}

// splitKey splits `key: value`; a key may be quoted.
func splitKey(line string) (key, value string, ok bool) {
	i := strings.Index(line, ":")
	if i < 0 {
		return "", "", false
	}
	key = strings.TrimSpace(line[:i])
	if key == "" {
		return "", "", false
	}
	key = unquote(key)
	return key, strings.TrimSpace(line[i+1:]), true
}

func unquote(s string) string {
	if len(s) >= 2 {
		if (s[0] == '"' && s[len(s)-1] == '"') || (s[0] == '\'' && s[len(s)-1] == '\'') {
			return s[1 : len(s)-1]
		}
	}
	return s
}

// Load parses every *.md in dir. Invalid files are reported in the error
// slice and skipped; valid skills are returned keyed by name. A duplicate
// name keeps the lexicographically first file and reports the other.
func Load(dir string) (map[string]Skill, []error) {
	out := map[string]Skill{}
	var errs []error
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return out, nil
		}
		return out, []error{err}
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
		path := filepath.Join(dir, name)
		data, err := os.ReadFile(path)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		skill, err := Parse(path, data)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if _, dup := out[skill.Name]; dup {
			errs = append(errs, fmt.Errorf("skill %s: duplicate name %q (already defined by an earlier file)", name, skill.Name))
			continue
		}
		out[skill.Name] = skill
	}
	return out, errs
}
