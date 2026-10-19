// Package skills loads agent skills written as JavaScript modules. A skill
// file is a .js ES module whose default export describes the skill:
//
//	export default {
//	  name: "review",
//	  description: "Strict read-only code review.",
//	  usable: "ask",           // deny (default) | never | ask | yolo
//	  mode: "agentic",         // optional: agentic | talk
//	  approvalMode: "ask",     // optional: ask | yolo
//	  inherit: ["agentic_base"],
//	  permissions: {
//	    read: "inherit",
//	    edit: "deny",
//	    widget_set: { policy: "inherit", args: { src_file: "deny" } },
//	  },
//	  body: `...prompt text injected inside <skill>...</skill>...`,
//	};
//
// Skills compose in JavaScript instead of Go. require("other_skill")
// returns a deep copy of another skill's default export (resolved by
// declared skill name or by file stem; builtin skills are requireable from
// disk skills), and skill.extend(base..., { ...overrides }) deep-merges
// metadata and permissions while registering every named base in `inherit`.
// Only the overrides body stays on the new skill — base bodies arrive once
// through the inherit chain at resolve time.
//
// JavaScript runs restricted and pure inside QuickJS: one fresh runtime and
// context per module, a custom require limited to skill modules, no
// filesystem, network, process, os/io or package access, no way to compile
// code (eval, Function and the derived constructors are removed), cycle
// detection, a per-module timeout and a plain-data snapshot boundary. A
// broken or hostile .js file is dropped with a load error — never a crash:
// a hand-edited skill must not take the daemon down. Markdown skills are
// not supported anymore; storage migration v5 converts old .md files to
// this format.
package skills

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	pathpkg "path"
	"path/filepath"
	"sort"
	"strings"

	"llm-gateway/indirect-code-daemon/packages/qjs"
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
	// "inherit" value: if the module omits the key, the original is deny.
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

// Source is one in-memory JavaScript skill module: Path is the
// display/identity path used in errors and as the module stem, Data is the
// module source.
type Source struct {
	Path string
	Data []byte
}

// moduleTimeout bounds one module evaluation, requires included. Tests
// shrink it to prove a runaway module cannot stall the daemon.
var moduleTimeout = qjs.DefaultTimeout

// Parse loads one standalone JavaScript skill. It can compute freely, but
// require has no other module to resolve against — cross-skill imports need
// one of the set loaders below.
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
	return newSkillLoader(roots, modules).load()
}

// Load parses every top-level *.js in dir. A missing directory is an empty
// store, not an error. Other extensions (including legacy .md) are ignored
// entirely.
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

// LoadFS parses every top-level *.js of dir inside fsys (embedded builtin
// skills). Paths in errors keep the fsys form (dir/name.js).
func LoadFS(fsys fs.FS, dir string) (map[string]Skill, []error) {
	roots, errs := SourcesFS(fsys, dir)
	list, loadErrs := LoadSet(roots, nil)
	return list, append(errs, loadErrs...)
}

// SourcesFS reads the top-level *.js files of dir inside fsys as raw
// sources (for LoadWithModules layering).
func SourcesFS(fsys fs.FS, dir string) ([]Source, []error) {
	entries, err := fs.ReadDir(fsys, dir)
	if err != nil {
		return nil, []error{err}
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !isSkillFile(e.Name()) {
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

// readDirSources reads the top-level *.js files of an OS directory.
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
		if e.IsDir() || !isSkillFile(e.Name()) {
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

// isSkillFile reports whether name is a JavaScript skill module. Legacy
// .md files are ignored; migration v5 rewrites them.
func isSkillFile(name string) bool {
	return strings.HasSuffix(strings.ToLower(name), ".js")
}

// moduleStem is the file stem a require() name may match.
func moduleStem(p string) string {
	base := displayBase(p)
	if strings.HasSuffix(strings.ToLower(base), ".js") {
		return base[:len(base)-len(".js")]
	}
	return base
}

// displayBase is the file label used in errors, for OS and FS paths alike.
func displayBase(p string) string {
	base := pathpkg.Base(strings.ReplaceAll(p, "\\", "/"))
	if base == "." || base == "/" || base == "" {
		return p
	}
	return base
}

// decodeSkill validates one module's returned snapshot into a Skill. The
// rules mirror the retired frontmatter contract: name and description are
// required; usable has no file-level "inherit" and defaults to deny;
// mode/approvalMode are closed enums; a listed tool or argument key must
// carry an explicit policy; unknown keys are errors. Keys starting with
// "_" are private composition metadata and are ignored everywhere — bases
// can publish values for combos without polluting the skill schema.
// approvalMode/permissions may sit at the top level (canonical) or under a
// nested `tools` object (the old frontmatter grouping), never both.
func decodeSkill(path string, v any) (Skill, error) {
	file := displayBase(path)
	top, ok := v.(map[string]any)
	if !ok {
		return Skill{}, fmt.Errorf("skill %s: module must export one object, got %s", file, snapshotType(v))
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

	var err error
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
		tools, ok := toolsVal.(map[string]any)
		if !ok {
			return Skill{}, fmt.Errorf("skill %s: `tools` must be an object, got %s", file, snapshotType(toolsVal))
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

// snapshotType names a decoded snapshot value in error messages.
func snapshotType(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case float64:
		return "number"
	case bool:
		return "boolean"
	case map[string]any:
		return "object"
	case []any:
		return "array"
	default:
		return fmt.Sprintf("%T", v)
	}
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

// decodeInherit accepts one skill name or an array of names. An object with
// consecutive 1-based numeric keys is accepted as a list too, so a module
// written that way loads unchanged.
func decodeInherit(v any, file string) ([]string, error) {
	switch value := v.(type) {
	case string:
		if strings.TrimSpace(value) == "" {
			return nil, fmt.Errorf("skill %s: `inherit` names must not be empty", file)
		}
		return []string{value}, nil
	case []any:
		out := make([]string, 0, len(value))
		for i, raw := range value {
			s, ok := raw.(string)
			if !ok {
				return nil, fmt.Errorf("skill %s: `inherit[%d]` must be a string, got %s", file, i+1, snapshotType(raw))
			}
			if strings.TrimSpace(s) == "" {
				return nil, fmt.Errorf("skill %s: `inherit` names must not be empty", file)
			}
			out = append(out, s)
		}
		return out, nil
	case map[string]any:
		if len(value) == 0 {
			return nil, nil
		}
		byIndex := make(map[int]string, len(value))
		for key, raw := range value {
			var n int
			if _, err := fmt.Sscanf(key, "%d", &n); err != nil || n < 1 {
				return nil, fmt.Errorf("skill %s: `inherit` must be an array of skill names", file)
			}
			s, ok := raw.(string)
			if !ok {
				return nil, fmt.Errorf("skill %s: `inherit[%d]` must be a string, got %s", file, n, snapshotType(raw))
			}
			if strings.TrimSpace(s) == "" {
				return nil, fmt.Errorf("skill %s: `inherit` names must not be empty", file)
			}
			byIndex[n] = s
		}
		out := make([]string, 0, len(byIndex))
		for i := 1; i <= len(byIndex); i++ {
			s, ok := byIndex[i]
			if !ok {
				return nil, fmt.Errorf("skill %s: `inherit` array has a hole at index %d", file, i)
			}
			out = append(out, s)
		}
		return out, nil
	default:
		return nil, fmt.Errorf("skill %s: `inherit` must be a string or an array of strings, got %s", file, snapshotType(v))
	}
}

// decodePermissions reads the permissions object. Each entry is a policy
// string, or an object with `policy` plus argument-key policies — in an
// `args` object, as direct keys of the spec object, or both merged
// (skill.extend deep-merges specs, so the two forms can meet; conflicting
// policies for one argument are an error).
// decodePermissions reads the permissions map: tool name to permission
// entry. Keys starting with "_" are private composition metadata.
func decodePermissions(v any, file string) (map[string]PermSpec, error) {
	raw, ok := v.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("skill %s: `permissions` must be an object, got %s", file, snapshotType(v))
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

// decodePermSpec reads one permission entry: a policy string, or an object
// with `policy` plus argument-key policies. A listed tool or argument key
// must carry an explicit policy — that is what makes an entry a GRANT.
func decodePermSpec(entry any, file, tool string) (PermSpec, error) {
	if s, ok := entry.(string); ok {
		if err := checkEnum("policy for tool "+tool, s, []string{"deny", "inherit", "ask", "yolo"}); err != nil {
			return PermSpec{}, fmt.Errorf("skill %s: %v (a listed tool must carry a value; leave the key out to inherit)", file, err)
		}
		return PermSpec{Policy: Policy(s)}, nil
	}
	spec, ok := entry.(map[string]any)
	if !ok {
		return PermSpec{}, fmt.Errorf("skill %s: permission for tool %q must be a policy string or an object, got %s", file, tool, snapshotType(entry))
	}
	policyRaw, present := spec["policy"]
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
	out := PermSpec{Policy: Policy(policy)}
	args := map[string]Policy{}
	if rawArgs, hasArgs := spec["args"]; hasArgs {
		inner, ok := rawArgs.(map[string]any)
		if !ok {
			return PermSpec{}, fmt.Errorf("skill %s: `args` for tool %q must be an object, got %s", file, tool, snapshotType(rawArgs))
		}
		for arg, raw := range inner {
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
	// skill.extend deep-merges specs, so direct argument keys and an `args`
	// object can meet on one entry; equal policies collapse, conflicting
	// ones are an error rather than a silent winner.
	for key, raw := range spec {
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
	if _, hasArgs := spec["args"]; hasArgs || len(args) > 0 {
		out.Args = args
	}
	return out, nil
}

// decodeArgPolicy reads one argument-key policy: an explicit value always,
// never a value inspection.
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

// moduleResult caches one module evaluation: the JSON snapshot handed to
// require, the decoded value used for decoding, and the error.
type moduleResult struct {
	json  string
	value any
	err   error
	done  bool
}

// moduleSource is one module in the resolution set.
type moduleSource struct {
	src  Source
	stem string
	root bool
}

// skillLoader evaluates one set of skill modules with cross-file require.
// It is single-goroutine: evaluation is recursive (require evaluates its
// target in a fresh VM on the same goroutine), never parallel.
type skillLoader struct {
	roots        []*moduleSource
	resolveOrder []*moduleSource // require-only modules first, then roots
	orderIndex   map[*moduleSource]int
	byStem       map[string]*moduleSource
	byName       map[string]*moduleSource
	results      map[*moduleSource]*moduleResult
	loading      map[*moduleSource]bool
	stack        []*moduleSource
}

func newSkillLoader(roots, modules []Source) *skillLoader {
	l := &skillLoader{
		orderIndex: map[*moduleSource]int{},
		byStem:     map[string]*moduleSource{},
		byName:     map[string]*moduleSource{},
		results:    map[*moduleSource]*moduleResult{},
		loading:    map[*moduleSource]bool{},
	}
	makeSources := func(list []Source, root bool) []*moduleSource {
		out := make([]*moduleSource, 0, len(list))
		for _, s := range list {
			out = append(out, &moduleSource{src: s, stem: moduleStem(s.Path), root: root})
		}
		sort.SliceStable(out, func(i, j int) bool {
			bi, bj := displayBase(out[i].src.Path), displayBase(out[j].src.Path)
			if bi != bj {
				return bi < bj
			}
			return out[i].src.Path < out[j].src.Path
		})
		return out
	}
	mods := makeSources(modules, false)
	l.roots = makeSources(roots, true)
	l.resolveOrder = append(l.resolveOrder, mods...)
	l.resolveOrder = append(l.resolveOrder, l.roots...)
	for i, ms := range l.resolveOrder {
		l.orderIndex[ms] = i
		if ms.stem != "" {
			if _, taken := l.byStem[ms.stem]; !taken {
				l.byStem[ms.stem] = ms
			}
		}
	}
	return l
}

func (l *skillLoader) load() (map[string]Skill, []error) {
	out := map[string]Skill{}
	var errs []error
	for _, root := range l.roots {
		res := l.evalSource(root)
		if res.err != nil {
			errs = append(errs, res.err)
			continue
		}
		sk, err := decodeSkill(root.src.Path, res.value)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if _, dup := out[sk.Name]; dup {
			errs = append(errs, fmt.Errorf("skill %s: duplicate name %q (already defined by an earlier file)", displayBase(root.src.Path), sk.Name))
			continue
		}
		out[sk.Name] = sk
	}
	return out, errs
}

// evalSource evaluates one module once per load, caching value and error.
// Re-entering a module that is still loading is a require cycle: the
// caller gets the cycle error (its own evaluation then fails with it),
// while the ancestor's result is cached by its own frame.
func (l *skillLoader) evalSource(ms *moduleSource) *moduleResult {
	if res, ok := l.results[ms]; ok && res.done {
		return res
	}
	if l.loading[ms] {
		chain := make([]string, 0, len(l.stack)+1)
		for _, s := range l.stack {
			chain = append(chain, displayBase(s.src.Path))
		}
		chain = append(chain, displayBase(ms.src.Path))
		return &moduleResult{err: fmt.Errorf("require cycle detected: %s", strings.Join(chain, " -> "))}
	}
	l.loading[ms] = true
	l.stack = append(l.stack, ms)
	jsonText, err := l.runModule(ms)
	l.stack = l.stack[:len(l.stack)-1]
	delete(l.loading, ms)
	res := &moduleResult{json: jsonText, err: err, done: true}
	if err == nil {
		var value any
		dec := json.NewDecoder(strings.NewReader(jsonText))
		dec.UseNumber()
		if err := dec.Decode(&value); err != nil {
			res.err = fmt.Errorf("skill %s: module snapshot is not valid JSON: %w", displayBase(ms.src.Path), err)
		} else {
			res.value = normalizeJSON(value)
			if name := declaredName(res.value); name != "" {
				// The earliest source in resolution order owns a
				// declared name (the builtin layer wins over disk).
				if cur, taken := l.byName[name]; !taken || l.orderIndex[ms] < l.orderIndex[cur] {
					l.byName[name] = ms
				}
			}
		}
	}
	l.results[ms] = res
	return res
}

// declaredName reads the name a module published, used to resolve require
// by skill name.
func declaredName(value any) string {
	top, ok := value.(map[string]any)
	if !ok {
		return ""
	}
	name, _ := top["name"].(string)
	return name
}

// normalizeJSON converts decoded JSON into the value language the decoder
// uses: objects are map[string]any, arrays []any, numbers float64.
func normalizeJSON(value any) any {
	switch v := value.(type) {
	case map[string]any:
		for key, raw := range v {
			v[key] = normalizeJSON(raw)
		}
		return v
	case []any:
		for i, raw := range v {
			v[i] = normalizeJSON(raw)
		}
		return v
	case json.Number:
		if f, err := v.Float64(); err == nil {
			return f
		}
		return v.String()
	default:
		return v
	}
}

// resolveModule finds a require target by declared skill name or file
// stem. Names are only known after evaluation, so a miss evaluates still
// pending sources in resolution order until the name registers — every
// root is evaluated during a load anyway.
func (l *skillLoader) resolveModule(name string) (*moduleSource, error) {
	clean := name
	if strings.HasSuffix(strings.ToLower(clean), ".js") {
		clean = clean[:len(clean)-len(".js")]
	}
	if clean == "" || strings.ContainsAny(clean, "/\\") || strings.Contains(clean, "..") || strings.ContainsRune(clean, '\x00') {
		return nil, fmt.Errorf("invalid module name %q (require takes a skill name or file stem)", name)
	}
	if ms, ok := l.byName[clean]; ok {
		return ms, nil
	}
	if ms, ok := l.byStem[clean]; ok {
		return ms, nil
	}
	for _, cand := range l.resolveOrder {
		if l.loading[cand] {
			continue
		}
		if res, done := l.results[cand]; done && res.done {
			continue
		}
		l.evalSource(cand)
		if ms, ok := l.byName[clean]; ok {
			return ms, nil
		}
	}
	if ms, ok := l.byName[clean]; ok {
		return ms, nil
	}
	return nil, fmt.Errorf("module %q not found (require is limited to skill modules)", name)
}

// runModule executes one module in a fresh QuickJS sandbox and returns the
// JSON snapshot of its default export. Panics in the engine become load
// errors — a skill file must never crash the daemon.
func (l *skillLoader) runModule(ms *moduleSource) (out string, err error) {
	file := displayBase(ms.src.Path)
	defer func() {
		if r := recover(); r != nil {
			out = ""
			err = fmt.Errorf("skill %s: %v", file, r)
		}
	}()
	req := func(name string) (string, error) {
		target, err := l.resolveModule(name)
		if err != nil {
			return "", err
		}
		res := l.evalSource(target)
		if res.err != nil {
			return "", fmt.Errorf("require %q: %w", name, res.err)
		}
		return res.json, nil
	}
	snapshot, err := qjs.EvalModule(qjs.Module{
		Name:    ms.src.Path,
		Source:  ms.src.Data,
		Timeout: moduleTimeout,
		Require: req,
	})
	if err != nil {
		return "", fmt.Errorf("skill %s: %w", file, err)
	}
	return snapshot, nil
}
