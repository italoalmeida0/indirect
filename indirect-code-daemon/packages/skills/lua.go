package skills

import (
	"bytes"
	"context"
	"fmt"
	"math"
	"path"
	"sort"
	"strings"
	"time"

	lua "github.com/yuin/gopher-lua"
)

// Lua loading limits. Skills are small prompt/policy modules; the caps
// keep a broken file from stalling daemon startup while staying far above
// any legitimate skill (the largest builtin is ~17 KiB of prompt text).
const (
	maxLuaSourceBytes    = 1 << 20
	maxSnapshotDepth     = 32
	maxSnapshotNodes     = 100000
	maxSnapshotStrBytes  = 4 << 20
	defaultModuleTimeout = 2 * time.Second
)

// moduleTimeout bounds one skill module's execution. A variable so tests
// can shrink it; production keeps the default.
var moduleTimeout = defaultModuleTimeout

// tableSnapshot is the cross-VM representation of a Lua table: plain Go
// data (string/float64/bool/nil/*tableSnapshot) that can be decoded into a
// Skill or materialized as a fresh table inside another module's VM.
// LState is not goroutine-safe and its tables cannot cross states, so all
// require traffic goes through snapshots.
type tableSnapshot struct {
	entries []tableEntry
}

type tableEntry struct {
	key   any
	value any
}

func (t *tableSnapshot) get(key string) (any, bool) {
	for _, e := range t.entries {
		if k, ok := e.key.(string); ok && k == key {
			return e.value, true
		}
	}
	return nil, false
}

func snapshotType(v any) string {
	switch v.(type) {
	case nil:
		return "nil"
	case string:
		return "string"
	case float64:
		return "number"
	case bool:
		return "boolean"
	case *tableSnapshot:
		return "table"
	default:
		return fmt.Sprintf("%T", v)
	}
}

// displayBase is the file label used in errors, for OS and FS paths alike.
func displayBase(p string) string {
	base := path.Base(strings.ReplaceAll(p, "\\", "/"))
	if base == "." || base == "/" || base == "" {
		return p
	}
	return base
}

func moduleStem(p string) string {
	base := displayBase(p)
	if strings.HasSuffix(strings.ToLower(base), ".lua") {
		return base[:len(base)-len(".lua")]
	}
	return base
}

type moduleSource struct {
	src  Source
	stem string
	root bool
}

type moduleResult struct {
	value any
	err   error
	done  bool
}

// luaLoader evaluates one set of skill modules with cross-file require.
// It is single-goroutine: evaluation is recursive (require evaluates its
// target in a fresh VM on the same goroutine), never parallel.
type luaLoader struct {
	roots        []*moduleSource
	resolveOrder []*moduleSource // require-only modules first, then roots
	orderIndex   map[*moduleSource]int
	byStem       map[string]*moduleSource
	byName       map[string]*moduleSource
	results      map[*moduleSource]*moduleResult
	loading      map[*moduleSource]bool
	stack        []*moduleSource
}

func newLuaLoader(roots, modules []Source) *luaLoader {
	l := &luaLoader{
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

func (l *luaLoader) load() (map[string]Skill, []error) {
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
func (l *luaLoader) evalSource(ms *moduleSource) *moduleResult {
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
	value, err := l.runModule(ms)
	l.stack = l.stack[:len(l.stack)-1]
	delete(l.loading, ms)
	res := &moduleResult{value: value, err: err, done: true}
	l.results[ms] = res
	if err == nil {
		if tbl, ok := value.(*tableSnapshot); ok {
			if raw, present := tbl.get("name"); present {
				if name, ok := raw.(string); ok && name != "" {
					// The earliest source in resolution order owns a
					// declared name (the builtin layer wins over disk).
					if cur, taken := l.byName[name]; !taken || l.orderIndex[ms] < l.orderIndex[cur] {
						l.byName[name] = ms
					}
				}
			}
		}
	}
	return res
}

// resolveModule finds a require target by declared skill name or file
// stem. Names are only known after evaluation, so a miss evaluates still
// pending sources in resolution order until the name registers — every
// root is evaluated during a load anyway.
func (l *luaLoader) resolveModule(name string) (*moduleSource, error) {
	clean := name
	if strings.HasSuffix(strings.ToLower(clean), ".lua") {
		clean = clean[:len(clean)-len(".lua")]
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

// runModule executes one Lua chunk in a fresh restricted VM and snapshots
// its returned value. Panics from the VM or host helpers become load
// errors — a skill file must never crash the daemon.
func (l *luaLoader) runModule(ms *moduleSource) (value any, err error) {
	file := displayBase(ms.src.Path)
	defer func() {
		if r := recover(); r != nil {
			value = nil
			err = fmt.Errorf("skill %s: %v", file, r)
		}
	}()
	if len(ms.src.Data) > maxLuaSourceBytes {
		return nil, fmt.Errorf("skill %s: source too large (%d bytes, max %d)", file, len(ms.src.Data), maxLuaSourceBytes)
	}
	L := l.newSkillState()
	defer L.Close()
	if moduleTimeout > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), moduleTimeout)
		defer cancel()
		L.SetContext(ctx)
	}
	fn, err := L.Load(bytes.NewReader(ms.src.Data), ms.src.Path)
	if err != nil {
		return nil, fmt.Errorf("skill %s: %w", file, err)
	}
	L.Push(fn)
	if err := L.PCall(0, 1, nil); err != nil {
		return nil, fmt.Errorf("skill %s: %w", file, err)
	}
	ret := L.Get(-1)
	L.Pop(1)
	snap, err := snapshotLuaValue(ret)
	if err != nil {
		return nil, fmt.Errorf("skill %s: %w", file, err)
	}
	return snap, nil
}

// newSkillState builds the restricted VM for one module: base/table/
// string/math only, with every host or dynamic-code escape removed.
// Dynamic loading, environment access, stdout and nondeterministic math
// would make skill loading impure, so they are deleted rather than merely
// left unopened (OpenBase installs several of them).
func (l *luaLoader) newSkillState() *lua.LState {
	L := lua.NewState(lua.Options{
		SkipOpenLibs:        true,
		RegistryMaxSize:     1 << 18,
		RegistryGrowStep:    8192,
		MinimizeStackMemory: true,
	})
	lua.OpenBase(L)
	lua.OpenTable(L)
	lua.OpenString(L)
	lua.OpenMath(L)
	for _, name := range []string{
		"_G", "dofile", "loadfile", "load", "loadstring", "getfenv",
		"setfenv", "collectgarbage", "print", "_printregs", "module",
		"newproxy", "require",
	} {
		L.SetGlobal(name, lua.LNil)
	}
	if mod, ok := L.GetGlobal("string").(*lua.LTable); ok {
		mod.RawSetString("dump", lua.LNil)
		mod.RawSetString("rep", L.NewFunction(cappedStringRep))
	}
	if mod, ok := L.GetGlobal("math").(*lua.LTable); ok {
		mod.RawSetString("random", lua.LNil)
		mod.RawSetString("randomseed", lua.LNil)
	}
	L.SetGlobal("require", L.NewFunction(l.luaRequire))
	skill := L.NewTable()
	skill.RawSetString("extend", L.NewFunction(l.luaExtend))
	L.SetGlobal("skill", skill)
	return L
}

// cappedStringRep replaces string.rep, whose unbounded allocation happens
// inside one host call where the VM timeout cannot interrupt it.
func cappedStringRep(L *lua.LState) int {
	s := L.CheckString(1)
	n := L.CheckInt(2)
	if n < 0 {
		L.RaiseError("bad argument #2 to 'rep' (invalid count)")
		return 0
	}
	if len(s) > 0 && n > maxSnapshotStrBytes/len(s) {
		L.RaiseError("string.rep result too large (max %d bytes)", maxSnapshotStrBytes)
		return 0
	}
	L.Push(lua.LString(strings.Repeat(s, n)))
	return 1
}

func checkLuaContext(L *lua.LState) error {
	if ctx := L.Context(); ctx != nil {
		return ctx.Err()
	}
	return nil
}

// requireTable resolves and evaluates one skill module, returning a fresh
// deep copy of its returned table inside L.
func (l *luaLoader) requireTable(L *lua.LState, name string) (*lua.LTable, error) {
	if err := checkLuaContext(L); err != nil {
		return nil, err
	}
	target, err := l.resolveModule(name)
	if err != nil {
		return nil, err
	}
	res := l.evalSource(target)
	if res.err != nil {
		return nil, fmt.Errorf("require %q: %w", name, res.err)
	}
	if err := checkLuaContext(L); err != nil {
		return nil, err
	}
	tbl, ok := res.value.(*tableSnapshot)
	if !ok {
		return nil, fmt.Errorf("require %q: module must return a table, got %s", name, snapshotType(res.value))
	}
	return materializeSnapshot(L, tbl), nil
}

func (l *luaLoader) luaRequire(L *lua.LState) int {
	raw := L.Get(1)
	name, ok := raw.(lua.LString)
	if !ok {
		L.ArgError(1, "module name must be a string")
		return 0
	}
	tbl, err := l.requireTable(L, string(name))
	if err != nil {
		L.RaiseError("%s", err.Error())
		return 0
	}
	L.Push(tbl)
	return 1
}

// snapshotLuaValue converts a returned Lua value to plain Go data. Only
// data crosses the VM boundary: functions, userdata, threads, channels,
// metatables, cyclic tables and non-finite numbers are rejected.
func snapshotLuaValue(v lua.LValue) (any, error) {
	s := &snapshotter{}
	return s.value(v, 0, map[*lua.LTable]bool{})
}

type snapshotter struct {
	nodes    int
	strBytes int
}

func (s *snapshotter) count() error {
	s.nodes++
	if s.nodes > maxSnapshotNodes {
		return fmt.Errorf("returned table is too large (over %d values)", maxSnapshotNodes)
	}
	return nil
}

func (s *snapshotter) value(v lua.LValue, depth int, stack map[*lua.LTable]bool) (any, error) {
	if depth > maxSnapshotDepth {
		return nil, fmt.Errorf("returned table is nested too deeply (max %d levels)", maxSnapshotDepth)
	}
	if err := s.count(); err != nil {
		return nil, err
	}
	switch lv := v.(type) {
	case *lua.LNilType:
		return nil, nil
	case lua.LBool:
		return bool(lv), nil
	case lua.LNumber:
		f := float64(lv)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return nil, fmt.Errorf("returned table contains a non-finite number")
		}
		return f, nil
	case lua.LString:
		str := string(lv)
		s.strBytes += len(str)
		if s.strBytes > maxSnapshotStrBytes {
			return nil, fmt.Errorf("returned table holds too much text (over %d bytes)", maxSnapshotStrBytes)
		}
		return str, nil
	case *lua.LTable:
		if lv.Metatable != lua.LNil {
			return nil, fmt.Errorf("returned tables must not carry metatables (plain data only)")
		}
		if stack[lv] {
			return nil, fmt.Errorf("returned table contains a cycle")
		}
		stack[lv] = true
		defer delete(stack, lv)
		out := &tableSnapshot{}
		var firstErr error
		lv.ForEach(func(key, val lua.LValue) {
			if firstErr != nil {
				return
			}
			k, err := s.key(key)
			if err != nil {
				firstErr = err
				return
			}
			sv, err := s.value(val, depth+1, stack)
			if err != nil {
				firstErr = err
				return
			}
			out.entries = append(out.entries, tableEntry{key: k, value: sv})
		})
		if firstErr != nil {
			return nil, firstErr
		}
		return out, nil
	default:
		return nil, fmt.Errorf("returned table contains a %s value (plain data only)", v.Type())
	}
}

// key snapshots a table KEY: scalars only, never tables or functions.
func (s *snapshotter) key(v lua.LValue) (any, error) {
	if err := s.count(); err != nil {
		return nil, err
	}
	switch lv := v.(type) {
	case lua.LBool:
		return bool(lv), nil
	case lua.LNumber:
		f := float64(lv)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return nil, fmt.Errorf("returned table contains a non-finite number key")
		}
		return f, nil
	case lua.LString:
		str := string(lv)
		s.strBytes += len(str)
		if s.strBytes > maxSnapshotStrBytes {
			return nil, fmt.Errorf("returned table holds too much text (over %d bytes)", maxSnapshotStrBytes)
		}
		return str, nil
	default:
		return nil, fmt.Errorf("returned table keys must be strings, numbers or booleans, got %s", v.Type())
	}
}

// materializeSnapshot builds a fresh Lua table from a snapshot inside L.
// Every require call materializes anew, so callers may mutate the result
// freely — the cached snapshot and other skills never see the edits.
func materializeSnapshot(L *lua.LState, tbl *tableSnapshot) *lua.LTable {
	out := L.NewTable()
	for _, e := range tbl.entries {
		out.RawSet(materializeValue(L, e.key), materializeValue(L, e.value))
	}
	return out
}

func materializeValue(L *lua.LState, v any) lua.LValue {
	switch lv := v.(type) {
	case nil:
		return lua.LNil
	case bool:
		return lua.LBool(lv)
	case float64:
		return lua.LNumber(lv)
	case string:
		return lua.LString(lv)
	case *tableSnapshot:
		return materializeSnapshot(L, lv)
	default:
		return lua.LNil
	}
}

// luaExtend implements skill.extend(base..., overrides) — the composition
// primitive. Bases may be tables or module names (required on the spot);
// the last argument is the override table. The result is a NEW table:
// metadata and permissions deep-merge left to right (maps merge, arrays
// and scalars replace), base names and inherit lists union into `inherit`
// (so Resolve pulls the bases in), base bodies are NOT copied (they ride
// the inherit chain — copying would print them twice), and the result
// keeps only the override's name and body. With one argument it simply
// returns a deep copy.
func (l *luaLoader) luaExtend(L *lua.LState) int {
	top := L.GetTop()
	if top < 1 {
		L.ArgError(1, "skill.extend needs at least one table")
		return 0
	}
	if err := checkLuaContext(L); err != nil {
		L.RaiseError("%s", err.Error())
		return 0
	}
	copier := &luaCopier{L: L, stack: map[*lua.LTable]bool{}}
	copies := make([]*lua.LTable, 0, top)
	for i := 1; i <= top; i++ {
		raw := L.Get(i)
		var tbl *lua.LTable
		switch v := raw.(type) {
		case *lua.LTable:
			tbl = v
		case lua.LString:
			if i == top && top > 1 {
				L.ArgError(i, "skill.extend overrides must be a table (only bases may be module names)")
				return 0
			}
			req, err := l.requireTable(L, string(v))
			if err != nil {
				L.RaiseError("%s", err.Error())
				return 0
			}
			tbl = req
		default:
			L.ArgError(i, "skill.extend arguments must be tables or module names")
			return 0
		}
		cpy, err := copier.table(tbl, 0)
		if err != nil {
			L.RaiseError("%s", err.Error())
			return 0
		}
		copies = append(copies, cpy)
	}
	if top == 1 {
		L.Push(copies[0])
		return 1
	}

	result := L.NewTable()
	var inherit []string
	addInherit := func(v lua.LValue) bool {
		names, err := inheritNamesFromLua(v)
		if err != nil {
			L.RaiseError("%s", err.Error())
			return false
		}
		for _, name := range names {
			inherit = appendUniqueString(inherit, name)
		}
		return true
	}
	for _, base := range copies[:len(copies)-1] {
		normalizeToolsTable(base)
		if !addInherit(base.RawGetString("inherit")) {
			return 0
		}
		if name, ok := base.RawGetString("name").(lua.LString); ok && string(name) != "" {
			inherit = appendUniqueString(inherit, string(name))
		}
		base.RawSetString("inherit", lua.LNil)
		base.RawSetString("name", lua.LNil)
		base.RawSetString("body", lua.LNil)
		mergeLuaTables(result, base)
	}
	overrides := copies[len(copies)-1]
	normalizeToolsTable(overrides)
	if !addInherit(overrides.RawGetString("inherit")) {
		return 0
	}
	overrides.RawSetString("inherit", lua.LNil)
	hasBody := overrides.RawGetString("body") != lua.LNil
	mergeLuaTables(result, overrides)
	if !hasBody {
		result.RawSetString("body", lua.LString(""))
	}
	if name, ok := result.RawGetString("name").(lua.LString); ok {
		filtered := inherit[:0]
		for _, dep := range inherit {
			if dep != string(name) {
				filtered = append(filtered, dep)
			}
		}
		inherit = filtered
	}
	if len(inherit) > 0 {
		arr := L.NewTable()
		for _, dep := range inherit {
			arr.Append(lua.LString(dep))
		}
		result.RawSetString("inherit", arr)
	} else {
		result.RawSetString("inherit", lua.LNil)
	}
	L.Push(result)
	return 1
}

func appendUniqueString(list []string, s string) []string {
	for _, v := range list {
		if v == s {
			return list
		}
	}
	return append(list, s)
}

// inheritNamesFromLua reads an inherit value (one name or an array).
func inheritNamesFromLua(v lua.LValue) ([]string, error) {
	switch lv := v.(type) {
	case *lua.LNilType:
		return nil, nil
	case lua.LString:
		if string(lv) == "" {
			return nil, fmt.Errorf("skill.extend: inherit names must not be empty")
		}
		return []string{string(lv)}, nil
	case *lua.LTable:
		n := lv.Len()
		entries := collectLuaEntries(lv)
		if len(entries) == 0 {
			return nil, nil
		}
		if len(entries) != n {
			return nil, fmt.Errorf("skill.extend: `inherit` must be an array of skill names")
		}
		out := make([]string, 0, n)
		for i := 1; i <= n; i++ {
			s, ok := lv.RawGetInt(i).(lua.LString)
			if !ok || string(s) == "" {
				return nil, fmt.Errorf("skill.extend: `inherit` must be an array of skill names")
			}
			out = append(out, string(s))
		}
		return out, nil
	default:
		return nil, fmt.Errorf("skill.extend: `inherit` must be a string or an array of strings, got %s", v.Type())
	}
}

// normalizeToolsTable lifts tools.approvalMode/tools.permissions to the
// top level when the top level does not already define them, so bases in
// either shape merge uniformly. Duplicated definitions are left in place
// for the skill decoder to reject.
func normalizeToolsTable(tbl *lua.LTable) {
	tools, ok := tbl.RawGetString("tools").(*lua.LTable)
	if !ok {
		return
	}
	onlyKnown := true
	duplicated := false
	for _, e := range collectLuaEntries(tools) {
		key, ok := e.key.(lua.LString)
		if !ok {
			onlyKnown = false
			continue
		}
		switch string(key) {
		case "approvalMode", "permissions":
			if tbl.RawGetString(string(key)) != lua.LNil {
				duplicated = true
			}
		default:
			if !strings.HasPrefix(string(key), "_") {
				onlyKnown = false
			}
		}
	}
	if duplicated {
		return
	}
	for _, key := range []string{"approvalMode", "permissions"} {
		if v := tools.RawGetString(key); v != lua.LNil {
			tbl.RawSetString(key, v)
		}
	}
	if onlyKnown {
		tbl.RawSetString("tools", lua.LNil)
	}
}

type luaEntry struct {
	key   lua.LValue
	value lua.LValue
}

func collectLuaEntries(tbl *lua.LTable) []luaEntry {
	var out []luaEntry
	tbl.ForEach(func(k, v lua.LValue) {
		out = append(out, luaEntry{key: k, value: v})
	})
	return out
}

// luaCopier deep-copies table trees inside one VM under the same size
// budget as the snapshot boundary, so a shared-subtable DAG cannot expand
// without bound inside this host call (where the VM timeout cannot
// interrupt). Table/function keys and metatables are rejected (returned
// skills are plain data); function VALUES are shared by reference (they
// can still run locally, and the snapshot boundary rejects them if they
// survive into a returned table).
type luaCopier struct {
	L        *lua.LState
	stack    map[*lua.LTable]bool
	nodes    int
	strBytes int
}

func (c *luaCopier) countString(s string) error {
	c.nodes++
	c.strBytes += len(s)
	if c.nodes > maxSnapshotNodes {
		return fmt.Errorf("skill.extend: table is too large (over %d values)", maxSnapshotNodes)
	}
	if c.strBytes > maxSnapshotStrBytes {
		return fmt.Errorf("skill.extend: table holds too much text (over %d bytes)", maxSnapshotStrBytes)
	}
	return nil
}

func (c *luaCopier) table(tbl *lua.LTable, depth int) (*lua.LTable, error) {
	if depth > maxSnapshotDepth {
		return nil, fmt.Errorf("skill.extend: table is nested too deeply (max %d levels)", maxSnapshotDepth)
	}
	if err := c.countString(""); err != nil {
		return nil, err
	}
	if tbl.Metatable != lua.LNil {
		return nil, fmt.Errorf("skill.extend: tables with metatables cannot be extended (plain data only)")
	}
	if c.stack[tbl] {
		return nil, fmt.Errorf("skill.extend: table contains a cycle")
	}
	c.stack[tbl] = true
	defer delete(c.stack, tbl)
	out := c.L.NewTable()
	for _, e := range collectLuaEntries(tbl) {
		switch k := e.key.(type) {
		case lua.LString:
			if err := c.countString(string(k)); err != nil {
				return nil, err
			}
		case lua.LNumber, lua.LBool:
			if err := c.countString(""); err != nil {
				return nil, err
			}
		default:
			return nil, fmt.Errorf("skill.extend: table keys must be strings, numbers or booleans, got %s", e.key.Type())
		}
		v, err := c.value(e.value, depth+1)
		if err != nil {
			return nil, err
		}
		out.RawSet(e.key, v)
	}
	return out, nil
}

func (c *luaCopier) value(v lua.LValue, depth int) (lua.LValue, error) {
	switch lv := v.(type) {
	case *lua.LTable:
		return c.table(lv, depth)
	case lua.LString:
		if err := c.countString(string(lv)); err != nil {
			return nil, err
		}
		return v, nil
	default:
		if err := c.countString(""); err != nil {
			return nil, err
		}
		return v, nil
	}
}

// isLuaArray reports whether a table is a pure 1..n sequence.
func isLuaArray(tbl *lua.LTable) bool {
	n := tbl.Len()
	if n == 0 {
		return false
	}
	entries := collectLuaEntries(tbl)
	if len(entries) != n {
		return false
	}
	for _, e := range entries {
		num, ok := e.key.(lua.LNumber)
		if !ok || float64(num) != float64(int(num)) || int(num) < 1 || int(num) > n {
			return false
		}
	}
	return true
}

// mergeLuaTables deep-merges src into dst: nested maps merge recursively,
// arrays and scalars from src replace. src is a disposable copy owned by
// the caller, so its subtables may be adopted by dst.
func mergeLuaTables(dst, src *lua.LTable) {
	for _, e := range collectLuaEntries(src) {
		existing := dst.RawGet(e.key)
		dstTbl, dstOK := existing.(*lua.LTable)
		srcTbl, srcOK := e.value.(*lua.LTable)
		if dstOK && srcOK && !isLuaArray(dstTbl) && !isLuaArray(srcTbl) {
			mergeLuaTables(dstTbl, srcTbl)
			continue
		}
		dst.RawSet(e.key, e.value)
	}
}
