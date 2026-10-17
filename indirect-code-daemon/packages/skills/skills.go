// Package skills loads agent skills written as Lua modules. A skill file
// is a .lua chunk that RETURNS one table describing the skill:
//
//	return {
//	  name = "review",
//	  description = "Strict read-only code review.",
//	  usable = "ask",          -- deny (default) | never | ask | yolo
//	  mode = "agentic",        -- optional: agentic | talk
//	  approvalMode = "ask",    -- optional: ask | yolo
//	  inherit = { "agentic_base" },
//	  permissions = {
//	    read = "inherit",
//	    edit = "deny",
//	    widget_set = { policy = "inherit", args = { src_file = "deny" } },
//	  },
//	  body = [[ ...prompt text injected inside <skill>...</skill>... ]],
//	}
//
// Skills compose in Lua instead of Go. require("other_skill") returns a
// deep copy of another skill's returned table (resolved by declared skill
// name or by file stem; builtin skills are requireable from disk skills),
// and skill.extend(base..., { overrides }) deep-merges metadata and
// permissions while registering every named base in `inherit`. Only the
// override table's body stays on the new skill — base bodies arrive once
// through the inherit chain at resolve time.
//
// Lua runs restricted and pure: only base/table/string/math, a custom
// require limited to skill modules, no filesystem, network, os/io/package
// access, no dynamic code loading, a fresh VM per module, cycle detection
// and a per-module timeout. A broken or hostile .lua file is dropped with
// a load error — never a crash: a hand-edited skill must not take the
// daemon down. Markdown skills are not supported anymore; storage
// migration v5 converts old .md files to this format.
package skills

import (
	"fmt"
	"io/fs"
	"os"
	pathpkg "path"
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

// Skill is one loaded skill definition. Body is the prompt text injected
// inside the <skill></skill> tag.
type Skill struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	// Usable is the skill file's ORIGINAL activation policy: ask (human
	// approval), yolo (free use), deny (AI-hidden and blocked from
	// use_skill, but the user may still activate it from the frontend) or
	// never (base-only: not even the user sees it — it contributes
	// exclusively as an inherit dependency). There is no file-level
	// "inherit" value: if the Lua table omits the key, the original is
	// deny. "inherit" exists only at session level, where it means "use
	// this original" (no override).
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
	// A dependency with usable deny stays hidden from the model's list.
	// skill.extend fills this list from its bases automatically.
	Inherit []string `json:"inherit,omitempty"`
	// Permissions doubles as the tool GRANT list: a tool listed here with
	// any policy except deny is granted by this skill (the base registry
	// carries only the mode's auto tools). deny still blocks.
	Permissions map[string]PermSpec `json:"permissions,omitempty"`
	Body        string              `json:"body"`
	Path        string              `json:"path,omitempty"`
}

// Source is one in-memory Lua skill module: Path is the display/identity
// path used in errors and as the module stem, Data is the .lua chunk.
type Source struct {
	Path string
	Data []byte
}

// Parse loads one standalone Lua skill. It can compute freely, but require
// has no other module to resolve against — cross-skill imports need one of
// the set loaders below.
func Parse(filename string, data []byte) (Skill, error) {
	list, errs := LoadSet([]Source{{Path: filename, Data: data}}, nil)
	for _, sk := range list {
		return sk, nil
	}
	if len(errs) > 0 {
		return Skill{}, errs[0]
	}
	return Skill{}, fmt.Errorf("skill %s: no skill returned", filepath.Base(filename))
}

// LoadSet evaluates one set of skill modules. Roots become skills in the
// result (keyed by declared name; on duplicate names the first file in
// sorted order wins and the others are reported). Modules are extra
// require-only sources — the builtin layer disk skills may import — and
// never appear in the result. Invalid files are reported and skipped.
func LoadSet(roots, modules []Source) (map[string]Skill, []error) {
	return newLuaLoader(roots, modules).load()
}

// Load parses every top-level *.lua in dir. A missing directory is an
// empty store, not an error. Other extensions (including legacy .md) are
// ignored entirely.
func Load(dir string) (map[string]Skill, []error) {
	return LoadWithModules(dir, nil)
}

// LoadWithModules is Load plus extra require-only module sources.
func LoadWithModules(dir string, modules []Source) (map[string]Skill, []error) {
	roots, errs, ok := readDirSources(dir)
	if !ok {
		return map[string]Skill{}, errs
	}
	list, loadErrs := LoadSet(roots, modules)
	return list, append(errs, loadErrs...)
}

// LoadFS parses every top-level *.lua of dir inside fsys (embedded
// builtin skills). Paths in errors keep the fsys form (dir/name.lua).
func LoadFS(fsys fs.FS, dir string) (map[string]Skill, []error) {
	entries, err := fs.ReadDir(fsys, dir)
	if err != nil {
		return map[string]Skill{}, []error{err}
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !isLuaFile(e.Name()) {
			continue
		}
		names = append(names, e.Name())
	}
	sort.Strings(names)
	roots := make([]Source, 0, len(names))
	var errs []error
	for _, name := range names {
		p := pathpkg.Join(dir, name)
		data, err := fs.ReadFile(fsys, p)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		roots = append(roots, Source{Path: p, Data: data})
	}
	list, loadErrs := LoadSet(roots, nil)
	return list, append(errs, loadErrs...)
}

// SourcesFS reads the top-level *.lua files of dir inside fsys as raw
// sources (for LoadWithModules layering).
func SourcesFS(fsys fs.FS, dir string) ([]Source, []error) {
	entries, err := fs.ReadDir(fsys, dir)
	if err != nil {
		return nil, []error{err}
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !isLuaFile(e.Name()) {
			continue
		}
		names = append(names, e.Name())
	}
	sort.Strings(names)
	out := make([]Source, 0, len(names))
	var errs []error
	for _, name := range names {
		p := pathpkg.Join(dir, name)
		data, err := fs.ReadFile(fsys, p)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		out = append(out, Source{Path: p, Data: data})
	}
	return out, errs
}

// readDirSources reads the top-level *.lua files of an OS directory.
// ok=false means "no store here": a missing dir (empty, no error) or an
// unreadable one (the error rides errs).
func readDirSources(dir string) (roots []Source, errs []error, ok bool) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil, false
		}
		return nil, []error{err}, false
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !isLuaFile(e.Name()) {
			continue
		}
		names = append(names, e.Name())
	}
	sort.Strings(names)
	roots = make([]Source, 0, len(names))
	for _, name := range names {
		p := filepath.Join(dir, name)
		data, err := os.ReadFile(p)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		roots = append(roots, Source{Path: p, Data: data})
	}
	return roots, errs, true
}

func isLuaFile(name string) bool {
	return strings.HasSuffix(strings.ToLower(name), ".lua")
}

// decodeSkill validates one module's returned table snapshot into a Skill.
// The rules mirror the retired frontmatter contract: name and description
// are required; usable has no file-level "inherit" and defaults to deny;
// mode/approvalMode are closed enums; a listed tool or argument key must
// carry an explicit policy; unknown keys are errors. Keys starting with
// "_" are private composition metadata and are ignored everywhere — bases
// can publish values for combos without polluting the skill schema.
// approvalMode/permissions may sit at the top level (canonical) or under a
// nested `tools` table (the old frontmatter grouping), never both.
func decodeSkill(path string, v any) (Skill, error) {
	file := displayBase(path)
	tbl, ok := v.(*tableSnapshot)
	if !ok {
		return Skill{}, fmt.Errorf("skill %s: module must return a table, got %s", file, snapshotType(v))
	}
	top, err := stringMap(tbl, file, "skill table")
	if err != nil {
		return Skill{}, err
	}
	allowed := map[string]bool{
		"name": true, "description": true, "usable": true, "mode": true,
		"approvalMode": true, "inherit": true, "permissions": true,
		"tools": true, "body": true,
	}
	for key := range top {
		if strings.HasPrefix(key, "_") {
			continue
		}
		if !allowed[key] {
			return Skill{}, fmt.Errorf("skill %s: unknown key %q (allowed: name, description, usable, mode, approvalMode, inherit, permissions, tools, body)", file, key)
		}
	}

	sk := Skill{Path: path}
	if sk.Name, err = stringField(top, "name", file); err != nil {
		return Skill{}, err
	}
	if strings.TrimSpace(sk.Name) == "" {
		return Skill{}, fmt.Errorf("skill %s: key 'name' is required", file)
	}
	if sk.Description, err = stringField(top, "description", file); err != nil {
		return Skill{}, err
	}
	if strings.TrimSpace(sk.Description) == "" {
		return Skill{}, fmt.Errorf("skill %s: key 'description' is required", file)
	}
	if _, present := top["usable"]; present {
		if sk.Usable, err = stringField(top, "usable", file); err != nil {
			return Skill{}, err
		}
		if err := checkEnum("usable", sk.Usable, []string{"deny", "never", "ask", "yolo"}); err != nil {
			return Skill{}, fmt.Errorf("skill %s: %v (there is no file-level \"inherit\"; omit the key for deny)", file, err)
		}
	} else {
		sk.Usable = "deny" // no usable key in the skill file: deny original
	}
	if _, present := top["mode"]; present {
		if sk.Mode, err = stringField(top, "mode", file); err != nil {
			return Skill{}, err
		}
		if sk.Mode != "agentic" && sk.Mode != "talk" {
			return Skill{}, fmt.Errorf("skill %s: `mode` must be agentic or talk, got %q", file, sk.Mode)
		}
	}
	if inherit, present := top["inherit"]; present {
		if sk.Inherit, err = decodeInherit(inherit, file); err != nil {
			return Skill{}, err
		}
	}

	approval, hasApproval := top["approvalMode"]
	perms, hasPerms := top["permissions"]
	if toolsVal, present := top["tools"]; present {
		toolsTbl, ok := toolsVal.(*tableSnapshot)
		if !ok {
			return Skill{}, fmt.Errorf("skill %s: `tools` must be a table, got %s", file, snapshotType(toolsVal))
		}
		tools, err := stringMap(toolsTbl, file, "tools table")
		if err != nil {
			return Skill{}, err
		}
		for key := range tools {
			if strings.HasPrefix(key, "_") {
				continue
			}
			if key != "approvalMode" && key != "permissions" {
				return Skill{}, fmt.Errorf("skill %s: unknown key %q under `tools` (allowed: approvalMode, permissions)", file, key)
			}
		}
		if v, ok := tools["approvalMode"]; ok {
			if hasApproval {
				return Skill{}, fmt.Errorf("skill %s: `approvalMode` is defined both at top level and under `tools`", file)
			}
			approval, hasApproval = v, true
		}
		if v, ok := tools["permissions"]; ok {
			if hasPerms {
				return Skill{}, fmt.Errorf("skill %s: `permissions` is defined both at top level and under `tools`", file)
			}
			perms, hasPerms = v, true
		}
	}
	if hasApproval {
		s, ok := approval.(string)
		if !ok {
			return Skill{}, fmt.Errorf("skill %s: `approvalMode` must be a string, got %s", file, snapshotType(approval))
		}
		if err := checkEnum("approvalMode", s, []string{"ask", "yolo"}); err != nil {
			return Skill{}, fmt.Errorf("skill %s: %v", file, err)
		}
		sk.ApprovalMode = s
	}
	if hasPerms {
		if sk.Permissions, err = decodePermissions(perms, file); err != nil {
			return Skill{}, err
		}
	}
	if _, present := top["body"]; present {
		if sk.Body, err = stringField(top, "body", file); err != nil {
			return Skill{}, err
		}
	}
	sk.Body = strings.TrimRight(strings.ReplaceAll(sk.Body, "\r\n", "\n"), "\n")
	return sk, nil
}

// stringMap flattens a snapshot table that must be keyed by strings only.
func stringMap(tbl *tableSnapshot, file, what string) (map[string]any, error) {
	out := make(map[string]any, len(tbl.entries))
	for _, e := range tbl.entries {
		key, ok := e.key.(string)
		if !ok {
			return nil, fmt.Errorf("skill %s: %s keys must be strings, got %s", file, what, snapshotType(e.key))
		}
		out[key] = e.value
	}
	return out, nil
}

func stringField(top map[string]any, key, file string) (string, error) {
	v, present := top[key]
	if !present {
		return "", nil
	}
	s, ok := v.(string)
	if !ok {
		return "", fmt.Errorf("skill %s: key %q must be a string, got %s", file, key, snapshotType(v))
	}
	return s, nil
}

func checkEnum(what, value string, allowed []string) error {
	for _, a := range allowed {
		if value == a {
			return nil
		}
	}
	return fmt.Errorf("%s must be one of %s, got %q", what, strings.Join(allowed, "|"), value)
}

// decodeInherit accepts one skill name or an array of names.
func decodeInherit(v any, file string) ([]string, error) {
	if s, ok := v.(string); ok {
		if strings.TrimSpace(s) == "" {
			return nil, fmt.Errorf("skill %s: `inherit` names must not be empty", file)
		}
		return []string{s}, nil
	}
	tbl, ok := v.(*tableSnapshot)
	if !ok {
		return nil, fmt.Errorf("skill %s: `inherit` must be a string or an array of strings, got %s", file, snapshotType(v))
	}
	if len(tbl.entries) == 0 {
		return nil, nil
	}
	byIndex := make(map[int]any, len(tbl.entries))
	for _, e := range tbl.entries {
		n, ok := e.key.(float64)
		if !ok || n != float64(int(n)) || int(n) < 1 {
			return nil, fmt.Errorf("skill %s: `inherit` must be an array of skill names", file)
		}
		byIndex[int(n)] = e.value
	}
	out := make([]string, 0, len(byIndex))
	for i := 1; i <= len(byIndex); i++ {
		raw, ok := byIndex[i]
		if !ok {
			return nil, fmt.Errorf("skill %s: `inherit` array has a hole at index %d", file, i)
		}
		s, ok := raw.(string)
		if !ok {
			return nil, fmt.Errorf("skill %s: `inherit[%d]` must be a string, got %s", file, i, snapshotType(raw))
		}
		if strings.TrimSpace(s) == "" {
			return nil, fmt.Errorf("skill %s: `inherit` names must not be empty", file)
		}
		out = append(out, s)
	}
	return out, nil
}

// decodePermissions reads the permissions map. Each entry is a policy
// string, or a table with `policy` plus argument-key policies — in an
// `args` table, as direct keys of the spec table, or both merged
// (skill.extend deep-merges specs, so the two forms can meet; conflicting
// policies for one argument are an error).
func decodePermissions(v any, file string) (map[string]PermSpec, error) {
	tbl, ok := v.(*tableSnapshot)
	if !ok {
		return nil, fmt.Errorf("skill %s: `permissions` must be a table, got %s", file, snapshotType(v))
	}
	raw, err := stringMap(tbl, file, "permissions")
	if err != nil {
		return nil, err
	}
	out := make(map[string]PermSpec, len(raw))
	for tool, entry := range raw {
		if strings.HasPrefix(tool, "_") {
			continue
		}
		if tool == "" {
			return nil, fmt.Errorf("skill %s: permission tool names must not be empty", file)
		}
		spec, err := decodePermSpec(entry, file, tool)
		if err != nil {
			return nil, err
		}
		out[tool] = spec
	}
	return out, nil
}

func decodePermSpec(v any, file, tool string) (PermSpec, error) {
	if s, ok := v.(string); ok {
		if err := checkEnum("policy for tool "+tool, s, []string{"deny", "inherit", "ask", "yolo"}); err != nil {
			return PermSpec{}, fmt.Errorf("skill %s: %v (a listed tool must carry a value; leave the key out to inherit)", file, err)
		}
		return PermSpec{Policy: Policy(s)}, nil
	}
	tbl, ok := v.(*tableSnapshot)
	if !ok {
		return PermSpec{}, fmt.Errorf("skill %s: permission for tool %q must be a policy string or a table, got %s", file, tool, snapshotType(v))
	}
	m, err := stringMap(tbl, file, "permission spec for tool "+tool)
	if err != nil {
		return PermSpec{}, err
	}
	policyRaw, present := m["policy"]
	if !present {
		return PermSpec{}, fmt.Errorf("skill %s: permission for tool %q must carry a `policy` value (leave the tool out to inherit)", file, tool)
	}
	policy, ok := policyRaw.(string)
	if !ok {
		return PermSpec{}, fmt.Errorf("skill %s: policy for tool %q must be a string, got %s", file, tool, snapshotType(policyRaw))
	}
	if err := checkEnum("policy for tool "+tool, policy, []string{"deny", "inherit", "ask", "yolo"}); err != nil {
		return PermSpec{}, fmt.Errorf("skill %s: %v", file, err)
	}
	spec := PermSpec{Policy: Policy(policy)}
	args := map[string]Policy{}
	_, hasArgsTable := m["args"]
	if hasArgsTable {
		argsTbl, ok := m["args"].(*tableSnapshot)
		if !ok {
			return PermSpec{}, fmt.Errorf("skill %s: `args` for tool %q must be a table, got %s", file, tool, snapshotType(m["args"]))
		}
		rawArgs, err := stringMap(argsTbl, file, "args for tool "+tool)
		if err != nil {
			return PermSpec{}, err
		}
		for arg, raw := range rawArgs {
			if strings.HasPrefix(arg, "_") {
				continue
			}
			p, err := decodeArgPolicy(raw, file, tool, arg)
			if err != nil {
				return PermSpec{}, err
			}
			args[arg] = p
		}
	}
	for key, raw := range m {
		if key == "policy" || key == "args" || strings.HasPrefix(key, "_") {
			continue
		}
		p, err := decodeArgPolicy(raw, file, tool, key)
		if err != nil {
			return PermSpec{}, err
		}
		if existing, dup := args[key]; dup && existing != p {
			return PermSpec{}, fmt.Errorf("skill %s: argument %q of tool %q has conflicting policies %q and %q", file, key, tool, existing, p)
		}
		args[key] = p
	}
	if hasArgsTable || len(args) > 0 {
		spec.Args = args
	}
	return spec, nil
}

func decodeArgPolicy(v any, file, tool, arg string) (Policy, error) {
	s, ok := v.(string)
	if !ok {
		return "", fmt.Errorf("skill %s: policy for argument %q of tool %q must be a string, got %s", file, arg, tool, snapshotType(v))
	}
	if err := checkEnum("policy for argument "+arg+" of tool "+tool, s, []string{"deny", "inherit", "ask", "yolo"}); err != nil {
		return "", fmt.Errorf("skill %s: %v (a listed argument must carry a value; leave the key out to inherit)", file, err)
	}
	return Policy(s), nil
}
