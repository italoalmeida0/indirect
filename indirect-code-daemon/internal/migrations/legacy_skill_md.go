package migrations

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"
)

// Legacy Markdown skill support, retained ONLY so storage migration v5 can
// convert a user's old skills/*.md files to Lua. The daemon runtime does
// not load Markdown skills anymore: this parser never runs outside the v5
// conversion, and a file it cannot parse is left untouched on disk (the old
// loader dropped invalid files too).

type legacyPermSpec struct {
	Policy string
	Args   map[string]string
}

type legacySkill struct {
	Name         string
	Description  string
	Usable       string
	Mode         string
	ApprovalMode string
	Inherit      []string
	Permissions  map[string]legacyPermSpec
	Body         string
	Path         string
}

var legacyHeaderKeys = []string{"name", "description", "usable", "mode", "inherit", "tools"}

// parseLegacySkill parses the retired frontmatter format exactly as the old
// runtime loader did: `name` first, `tools` last, middle keys order-free.
func parseLegacySkill(filename string, data []byte) (legacySkill, error) {
	s := legacySkill{Path: filename}
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

	if err := parseLegacyHeader(&s, header); err != nil {
		return legacySkill{}, err
	}
	if s.Name == "" {
		return legacySkill{}, fmt.Errorf("skill %s: header key 'name' is required", filepath.Base(filename))
	}
	if s.Description == "" {
		return legacySkill{}, fmt.Errorf("skill %s: header key 'description' is required", filepath.Base(filename))
	}
	if s.Usable == "" {
		s.Usable = "deny"
	}
	return s, nil
}

type legacyHeaderParser struct {
	s       *legacySkill
	keyIdx  int
	inTools bool
	sub     int
}

func parseLegacyHeader(s *legacySkill, header string) error {
	p := &legacyHeaderParser{s: s}
	for i, raw := range strings.Split(header, "\n") {
		lineNo := i + 2
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

func (p *legacyHeaderParser) topLevel(line string, lineNo int) error {
	key, value, ok := legacySplitKey(line)
	if !ok {
		return fmt.Errorf("skill %s line %d: expected `key: value`, got %q", filepath.Base(p.s.Path), lineNo, line)
	}
	idx := -1
	for i, k := range legacyHeaderKeys {
		if k == key {
			idx = i
			break
		}
	}
	if idx < 0 {
		return fmt.Errorf("skill %s line %d: unknown header key %q (allowed: %s)", filepath.Base(p.s.Path), lineNo, key, strings.Join(legacyHeaderKeys, " -> "))
	}
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
		p.s.Name = legacyUnquote(value)
	case "description":
		p.s.Description = legacyUnquote(value)
	case "inherit":
		list, err := parseLegacyInlineList(value, filepath.Base(p.s.Path), lineNo)
		if err != nil {
			return err
		}
		p.s.Inherit = list
	case "usable":
		if err := checkLegacyPolicyValue(value, []string{"deny", "never", "ask", "yolo"}); err != nil {
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

func (p *legacyHeaderParser) nested(line string, indent, lineNo int) error {
	if !p.inTools {
		return fmt.Errorf("skill %s line %d: unexpected indentation outside `tools:`", filepath.Base(p.s.Path), lineNo)
	}
	key, value, ok := legacySplitKey(line)
	if !ok {
		return fmt.Errorf("skill %s line %d: expected `key: value`, got %q", filepath.Base(p.s.Path), lineNo, line)
	}
	switch p.sub {
	case 1:
		if indent != 2 {
			return fmt.Errorf("skill %s line %d: keys under `tools:` must be indented 2 spaces", filepath.Base(p.s.Path), lineNo)
		}
		switch key {
		case "approvalMode":
			if err := checkLegacyPolicyValue(value, []string{"ask", "yolo"}); err != nil {
				return fmt.Errorf("skill %s line %d: %v", filepath.Base(p.s.Path), lineNo, err)
			}
			p.s.ApprovalMode = strings.TrimSpace(value)
		case "permissions":
			if strings.TrimSpace(value) != "" {
				return fmt.Errorf("skill %s line %d: `permissions:` takes no inline value", filepath.Base(p.s.Path), lineNo)
			}
			p.s.Permissions = map[string]legacyPermSpec{}
			p.sub = 2
		default:
			return fmt.Errorf("skill %s line %d: unknown key %q under `tools:` (approvalMode -> permissions)", filepath.Base(p.s.Path), lineNo, key)
		}
		return nil
	case 2:
		if indent != 4 {
			return fmt.Errorf("skill %s line %d: permission entries must be indented 4 spaces", filepath.Base(p.s.Path), lineNo)
		}
		spec, err := parseLegacyPermSpec(value, filepath.Base(p.s.Path), lineNo)
		if err != nil {
			return err
		}
		p.s.Permissions[key] = spec
		return nil
	}
	return fmt.Errorf("skill %s line %d: unexpected nested key %q", filepath.Base(p.s.Path), lineNo, key)
}

func (p *legacyHeaderParser) orderError(key string, lineNo int) error {
	return fmt.Errorf("skill %s line %d: key %q out of order (required order: %s)",
		filepath.Base(p.s.Path), lineNo, key, strings.Join(legacyHeaderKeys, " -> "))
}

func parseLegacyPermSpec(value, file string, lineNo int) (legacyPermSpec, error) {
	value = strings.TrimSpace(value)
	spec := legacyPermSpec{}
	if i := strings.Index(value, "{"); i >= 0 {
		if !strings.HasSuffix(value, "}") {
			return spec, fmt.Errorf("skill %s line %d: unclosed { in permission %q", file, lineNo, value)
		}
		base := strings.TrimSpace(value[:i])
		inner := strings.TrimSpace(value[i+1 : len(value)-1])
		if err := checkLegacyPolicyValue(base, []string{"deny", "inherit", "ask", "yolo"}); err != nil {
			return spec, fmt.Errorf("skill %s line %d: %v (a listed tool must carry a value; leave the key out to inherit)", file, lineNo, err)
		}
		spec.Policy = base
		spec.Args = map[string]string{}
		if inner != "" {
			for _, part := range strings.Split(inner, ",") {
				argKey, argVal, ok := legacySplitKey(strings.TrimSpace(part))
				if !ok {
					return spec, fmt.Errorf("skill %s line %d: bad argument override %q (expected `arg: policy`)", file, lineNo, part)
				}
				if err := checkLegacyPolicyValue(argVal, []string{"deny", "inherit", "ask", "yolo"}); err != nil {
					return spec, fmt.Errorf("skill %s line %d: %v (a listed argument must carry a value; leave the key out to inherit)", file, lineNo, err)
				}
				spec.Args[argKey] = argVal
			}
		}
		return spec, nil
	}
	if err := checkLegacyPolicyValue(value, []string{"deny", "inherit", "ask", "yolo"}); err != nil {
		return spec, fmt.Errorf("skill %s line %d: %v (a listed tool must carry a value; leave the key out to inherit)", file, lineNo, err)
	}
	spec.Policy = value
	return spec, nil
}

func parseLegacyInlineList(value, file string, lineNo int) ([]string, error) {
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
		name := legacyUnquote(strings.TrimSpace(part))
		if name == "" {
			return nil, fmt.Errorf("skill %s line %d: empty name in list %q", file, lineNo, value)
		}
		out = append(out, name)
	}
	return out, nil
}

func checkLegacyPolicyValue(value string, allowed []string) error {
	value = strings.TrimSpace(value)
	for _, a := range allowed {
		if value == a {
			return nil
		}
	}
	return fmt.Errorf("policy must be one of %s, got %q", strings.Join(allowed, "|"), value)
}

func legacySplitKey(line string) (key, value string, ok bool) {
	i := strings.Index(line, ":")
	if i < 0 {
		return "", "", false
	}
	key = strings.TrimSpace(line[:i])
	if key == "" {
		return "", "", false
	}
	key = legacyUnquote(key)
	return key, strings.TrimSpace(line[i+1:]), true
}

func legacyUnquote(s string) string {
	if len(s) >= 2 {
		if (s[0] == '"' && s[len(s)-1] == '"') || (s[0] == '\'' && s[len(s)-1] == '\'') {
			return s[1 : len(s)-1]
		}
	}
	return s
}

// renderLegacySkillLua renders one parsed legacy skill as a canonical Lua
// module (a chunk returning the skill table). Keys are sorted inside
// permissions/args so the output is deterministic.
func renderLegacySkillLua(s legacySkill) []byte {
	var b strings.Builder
	b.WriteString("-- Converted from a Markdown skill by storage migration v5.\n")
	b.WriteString("return {\n")
	fmt.Fprintf(&b, "  name = %s,\n", luaQuote(s.Name))
	fmt.Fprintf(&b, "  description = %s,\n", luaQuote(s.Description))
	fmt.Fprintf(&b, "  usable = %s,\n", luaQuote(s.Usable))
	if s.Mode != "" {
		fmt.Fprintf(&b, "  mode = %s,\n", luaQuote(s.Mode))
	}
	if s.ApprovalMode != "" {
		fmt.Fprintf(&b, "  approvalMode = %s,\n", luaQuote(s.ApprovalMode))
	}
	if len(s.Inherit) > 0 {
		b.WriteString("  inherit = { ")
		for i, name := range s.Inherit {
			if i > 0 {
				b.WriteString(", ")
			}
			b.WriteString(luaQuote(name))
		}
		b.WriteString(" },\n")
	}
	if len(s.Permissions) > 0 {
		b.WriteString("  permissions = {\n")
		tools := make([]string, 0, len(s.Permissions))
		for tool := range s.Permissions {
			tools = append(tools, tool)
		}
		sort.Strings(tools)
		for _, tool := range tools {
			spec := s.Permissions[tool]
			if len(spec.Args) == 0 {
				fmt.Fprintf(&b, "    %s = %s,\n", luaKey(tool), luaQuote(spec.Policy))
				continue
			}
			args := make([]string, 0, len(spec.Args))
			for arg := range spec.Args {
				args = append(args, arg)
			}
			sort.Strings(args)
			fmt.Fprintf(&b, "    %s = { policy = %s, args = { ", luaKey(tool), luaQuote(spec.Policy))
			for i, arg := range args {
				if i > 0 {
					b.WriteString(", ")
				}
				fmt.Fprintf(&b, "%s = %s", luaKey(arg), luaQuote(spec.Args[arg]))
			}
			b.WriteString(" } },\n")
		}
		b.WriteString("  },\n")
	}
	open, close := luaLongBracket(s.Body)
	fmt.Fprintf(&b, "  body = %s\n%s\n%s,\n", open, s.Body, close)
	b.WriteString("}\n")
	return []byte(b.String())
}

// luaLongBracket picks a long-bracket level whose closing sequence never
// occurs inside body, so any prompt text survives the conversion verbatim.
func luaLongBracket(body string) (open, close string) {
	for level := 0; ; level++ {
		eq := strings.Repeat("=", level)
		close = "]" + eq + "]"
		if !strings.Contains(body, close) {
			return "[" + eq + "[", close
		}
	}
}

// luaQuote renders a short Lua string literal, preserving UTF-8 bytes.
func luaQuote(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 || r == 0x7f {
				fmt.Fprintf(&b, `\%03d`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// luaKey renders a table key: bare for Lua identifiers, bracketed string
// otherwise (tool and argument names are user-controlled).
func luaKey(s string) string {
	switch s {
	case "and", "break", "do", "else", "elseif", "end", "false", "for",
		"function", "if", "in", "local", "nil", "not", "or", "repeat",
		"return", "then", "true", "until", "while":
		return "[" + luaQuote(s) + "]"
	}
	if s == "" {
		return "[" + luaQuote(s) + "]"
	}
	for i, r := range s {
		isAlpha := r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
		isDigit := r >= '0' && r <= '9'
		if (!isAlpha && !isDigit) || (i == 0 && isDigit) {
			return "[" + luaQuote(s) + "]"
		}
	}
	return s
}
