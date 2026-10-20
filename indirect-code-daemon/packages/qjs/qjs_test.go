package qjs

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func eval(t *testing.T, src string) string {
	t.Helper()
	out, err := EvalModule(Module{Name: "probe.js", Source: []byte(src)})
	if err != nil {
		t.Fatalf("EvalModule: %v", err)
	}
	return out
}

func TestEvalPlainData(t *testing.T) {
	out := eval(t, `export default { name: "probe", n: 1, ok: true, list: ["a"], nested: { deep: null } };`)
	var got map[string]any
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("snapshot is not JSON: %v (%s)", err, out)
	}
	if got["name"] != "probe" || got["n"] != float64(1) || got["ok"] != true {
		t.Fatalf("unexpected snapshot: %s", out)
	}
	if _, ok := got["nested"].(map[string]any); !ok {
		t.Fatalf("nested object lost: %s", out)
	}
}

func TestSandboxHasNoDynamicCode(t *testing.T) {
	for _, src := range []string{
		`export default { x: eval("1+1") };`,
		`export default { x: new Function("return 1")() };`,
		`export default { x: globalThis.eval("1") };`,
	} {
		if _, err := EvalModule(Module{Name: "escape.js", Source: []byte(src)}); err == nil {
			t.Fatalf("dynamic code was allowed: %s", src)
		}
	}
}

func TestSandboxHasNoHostAccess(t *testing.T) {
	if _, err := EvalModule(Module{Name: "host.js", Source: []byte(`export default { x: process.env.HOME };`)}); err == nil {
		t.Fatal("process was reachable")
	}
	if _, err := EvalModule(Module{Name: "fs.js", Source: []byte(`export default { x: File };`)}); err == nil {
		t.Fatal("File was reachable")
	}
	if strings.Contains(preludeSource, "__proto__") {
		t.Fatal("prelude should not poke at __proto__")
	}
}

// skillSet is a tiny module registry shaped like the real one: specifier ->
// module source, keyed by `skill:<name>`.
func skillSet(mods map[string]string) ResolveModule {
	return func(specifier string) ([]byte, error) {
		src, ok := mods[specifier]
		if !ok {
			return nil, errors.New("no skill module " + specifier)
		}
		return []byte(src), nil
	}
}

func TestImportReachesGo(t *testing.T) {
	resolve := skillSet(map[string]string{
		"skill:base": `export default { name: "base", permissions: { read: "ask" }, body: "BASE" };`,
	})
	out, err := EvalModule(Module{
		Name: "combo.js",
		Source: []byte(`import base from "skill:base";
export default { ...base, name: "combo", permissions: { ...base.permissions, write: "deny" }, body: base.body + " OWN" };`),
		Resolve: resolve,
	})
	if err != nil {
		t.Fatalf("EvalModule: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("snapshot is not JSON: %v (%s)", err, out)
	}
	perms, _ := got["permissions"].(map[string]any)
	if got["name"] != "combo" || got["body"] != "BASE OWN" {
		t.Fatalf("imported module not composed: %s", out)
	}
	if perms["read"] != "ask" || perms["write"] != "deny" {
		t.Fatalf("spread did not carry the base permissions: %s", out)
	}
	if _, ok := got["inherit"]; ok {
		t.Fatalf("import must not fabricate an inherit list: %s", out)
	}
}

func TestImportLinksTransitively(t *testing.T) {
	resolve := skillSet(map[string]string{
		"skill:base":  `export default { body: "base" };`,
		"skill:mid":   `import base from "skill:base"; export default { body: base.body + "/mid" };`,
		"skill:other": `export const marker = "ok";`,
	})
	out, err := EvalModule(Module{
		Name: "leaf.js",
		Source: []byte(`import mid from "skill:mid";
import { marker } from "skill:other";
export default { body: mid.body + "/leaf", marker };`),
		Resolve: resolve,
	})
	if err != nil {
		t.Fatalf("EvalModule: %v", err)
	}
	if !strings.Contains(out, `"body":"base/mid/leaf"`) || !strings.Contains(out, `"marker":"ok"`) {
		t.Fatalf("transitive import failed: %s", out)
	}
}

func TestImportErrorsNameTheSpecifier(t *testing.T) {
	resolve := skillSet(map[string]string{"skill:base": `export default {};`})
	cases := map[string]struct {
		src  string
		want string
	}{
		"missing module": {`import x from "skill:nope"; export default { x };`, "skill:nope"},
		"relative path":  {`import x from "./base.js"; export default { x };`, "skill:name"},
		"bare name":      {`import x from "base"; export default { x };`, "skill:name"},
		"host module":    {`import fs from "node:fs"; export default { fs };`, "skill:name"},
		"absolute path":  {`import x from "/etc/passwd"; export default { x };`, "skill:name"},
		"path traversal": {`import x from "skill:../base"; export default { x };`, "not a path"},
		"empty name":     {`import x from "skill:"; export default { x };`, "no module name"},
	}
	for name, tc := range cases {
		_, err := EvalModule(Module{Name: "wild.js", Source: []byte(tc.src), Resolve: resolve})
		if err == nil {
			t.Errorf("%s: import was accepted", name)
			continue
		}
		if !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: error %q should mention %q", name, err, tc.want)
		}
	}
}

func TestImportWithoutResolver(t *testing.T) {
	_, err := EvalModule(Module{Name: "lonely.js", Source: []byte(`import base from "skill:base"; export default { base };`)})
	if err == nil || !strings.Contains(err.Error(), "imports nothing") {
		t.Fatalf("import without a resolver should be reported: %v", err)
	}
}

func TestImportCycleIsReported(t *testing.T) {
	resolve := skillSet(map[string]string{
		"skill:a": `import b from "skill:b"; export default { name: "a", b };`,
		"skill:b": `import a from "skill:a"; export default { name: "b", a };`,
	})
	start := time.Now()
	_, err := EvalModule(Module{
		Name:    "a.js",
		Source:  []byte(`import a from "skill:a"; export default { a };`),
		Resolve: resolve,
	})
	if err == nil {
		t.Fatal("a cyclic import graph was accepted")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("cycle detection took %s; the graph budget must stop it", elapsed)
	}
}

func TestImportBudgetBoundsTheGraph(t *testing.T) {
	// Every module imports the next; the 128-module budget must stop it
	// instead of linking thousands of modules.
	resolve := func(specifier string) ([]byte, error) {
		return []byte(`import next from "skill:` + specifier + `x";
export default { name: "m" };`), nil
	}
	_, err := EvalModule(Module{
		Name:    "deep.js",
		Source:  []byte(`import first from "skill:m"; export default { first };`),
		Resolve: resolve,
	})
	if err == nil || !strings.Contains(err.Error(), "too large or cyclic") {
		t.Fatalf("unbounded graph should be refused: %v", err)
	}
}

func TestImportedModuleGetsTheSameLimits(t *testing.T) {
	// The deadline covers the whole graph: a runaway IMPORT is interrupted,
	// not only the root module.
	resolve := skillSet(map[string]string{
		"skill:spin": `while (true) {} export default { name: "spin" };`,
	})
	start := time.Now()
	_, err := EvalModule(Module{
		Name:    "root.js",
		Source:  []byte(`import spin from "skill:spin"; export default { spin };`),
		Resolve: resolve,
		Timeout: 150 * time.Millisecond,
	})
	if err == nil {
		t.Fatal("a runaway import was not interrupted")
	}
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("expected a timeout error, got %v", err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("interrupt took %s", elapsed)
	}
}

func TestSandboxHasNoRequireOrExtend(t *testing.T) {
	for _, src := range []string{
		`export default { x: typeof require };`,
		`export default { x: typeof skill };`,
	} {
		out, err := EvalModule(Module{Name: "surface.js", Source: []byte(src)})
		if err != nil {
			t.Fatalf("EvalModule: %v", err)
		}
		if !strings.Contains(out, `"x":"undefined"`) {
			t.Fatalf("sandbox still exposes a retired helper: %s", out)
		}
	}
}

func TestSnapshotRejectsNonData(t *testing.T) {
	cases := map[string]string{
		"function":      `export default { f: function () {} };`,
		"symbol":        `export default { s: Symbol("x") };`,
		"class":         `class Box { constructor() { this.v = 1; } } export default new Box();`,
		"date":          `export default { d: new Date() };`,
		"regexp":        `export default { r: /x/ };`,
		"map":           `export default { m: new Map() };`,
		"cycle":         `const a = { name: "a" }; a.self = a; export default a;`,
		"sparse":        `const a = [1]; a[3] = 4; export default { a };`,
		"nan":           `export default { n: NaN };`,
		"infinity":      `export default { n: Infinity };`,
		"bigint":        `export default { n: 10n };`,
		"accessor":      `export default { get x() { return 1; } };`,
		"depth":         strings.Repeat("export default ", 1) + strings.Repeat("[", 40) + "1" + strings.Repeat("]", 40) + ";",
		"undefined":     `export default { x: [1, undefined] };`,
		"hole":          `const a = [1, 2]; delete a[0]; export default { a };`,
		"hiddenKey":     `const o = {}; Object.defineProperty(o, "x", { value: 1, enumerable: false }); export default o;`,
		"nonPlainProto": `const o = Object.create({ inherited: 1 }); o.name = "a"; export default o;`,
	}
	for name, src := range cases {
		if _, err := EvalModule(Module{Name: "bad.js", Source: []byte(src)}); err == nil {
			t.Errorf("%s: snapshot accepted a non-data value", name)
		}
	}
}

func TestSnapshotRejectsSharedSubtreeBlowup(t *testing.T) {
	src := "let t = { leaf: 1 };\nfor (let i = 0; i < 24; i++) t = { a: t, b: t };\nexport default { t };\n"
	start := time.Now()
	if _, err := EvalModule(Module{Name: "dag.js", Source: []byte(src)}); err == nil {
		t.Fatal("exponential shared subtree was accepted")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("rejection took %s; the budget must stop the walk early", elapsed)
	}
}

func TestTimeoutInterruptsRunawayModule(t *testing.T) {
	start := time.Now()
	_, err := EvalModule(Module{
		Name:    "loop.js",
		Source:  []byte(`while (true) {} export default { name: "loop" };`),
		Timeout: 100 * time.Millisecond,
	})
	if err == nil {
		t.Fatal("runaway module was not interrupted")
	}
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("expected a timeout error, got %v", err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("interrupt took %s", elapsed)
	}
}

func TestErrorsNameTheModule(t *testing.T) {
	_, err := EvalModule(Module{Name: "broken.js", Source: []byte(`export default {`)})
	if err == nil || !strings.Contains(err.Error(), "broken.js") {
		t.Fatalf("syntax error should name the module: %v", err)
	}
	_, err = EvalModule(Module{Name: "nobody.js", Source: []byte(`const x = 1;`)})
	if err == nil || !strings.Contains(err.Error(), "default") {
		t.Fatalf("missing default export should be reported: %v", err)
	}
	_, err = EvalModule(Module{Name: "big.js", Source: make([]byte, MaxSourceBytes+1)})
	if err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("oversized source should be reported: %v", err)
	}
}

func TestUndefinedPropertyIsAbsent(t *testing.T) {
	/* A property set to undefined disappears, exactly like a nil value in a
	   table: JSON has no undefined. */
	out := eval(t, `export default { name: "probe", dropped: undefined };`)
	if strings.Contains(out, "dropped") {
		t.Fatalf("undefined property should be dropped: %s", out)
	}
}

func TestThrownErrorKeepsMessage(t *testing.T) {
	_, err := EvalModule(Module{Name: "throw.js", Source: []byte(`throw new Error("boom");`)})
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("thrown error should keep its message: %v", err)
	}
}

func TestTopLevelAwaitIsRejected(t *testing.T) {
	_, err := EvalModule(Module{Name: "async.js", Source: []byte(`await 1; export default { name: "a" };`)})
	if err == nil {
		t.Fatal("top-level await was accepted")
	}
}

// A diamond graph links the shared module ONCE: two importers of the same
// base must not be mistaken for a cycle.
func TestImportDiamondLinksOnce(t *testing.T) {
	loads := 0
	resolve := func(specifier string) ([]byte, error) {
		loads++
		src, ok := map[string]string{
			"skill:base": `globalThis.__baseEvaluations = (globalThis.__baseEvaluations || 0) + 1;
export default { name: "base", body: "BASE" };`,
			"skill:left":  `import base from "skill:base"; export default { body: "L(" + base.body + ")" };`,
			"skill:right": `import base from "skill:base"; export default { body: "R(" + base.body + ")" };`,
		}[specifier]
		if !ok {
			return nil, errors.New("no module " + specifier)
		}
		return []byte(src), nil
	}
	out, err := EvalModule(Module{
		Name: "top.js",
		Source: []byte(`import left from "skill:left";
import right from "skill:right";
export default { body: left.body + right.body, baseEvaluations: globalThis.__baseEvaluations };`),
		Resolve: resolve,
	})
	if err != nil {
		t.Fatalf("diamond import: %v", err)
	}
	if !strings.Contains(out, `"body":"L(BASE)R(BASE)"`) {
		t.Fatalf("shared base reached both importers: %s", out)
	}
	if !strings.Contains(out, `"baseEvaluations":1`) {
		t.Fatalf("the shared base must evaluate exactly once: %s", out)
	}
	if loads != 3 {
		t.Fatalf("loader calls = %d, want 3 (base, left, right)", loads)
	}
}

// Two modules importing each other is refused, not resolved: an ES module
// cycle would hand one side a half-initialized binding.
func TestImportMutualCycleNamesThePath(t *testing.T) {
	resolve := skillSet(map[string]string{
		"skill:a": `import b from "skill:b"; export default { name: "a", b };`,
		"skill:b": `import a from "skill:a"; export default { name: "b", a };`,
	})
	_, err := EvalModule(Module{
		Name:    "a.js",
		Source:  []byte(`import a from "skill:a"; export default { a };`),
		Resolve: resolve,
	})
	if err == nil {
		t.Fatal("mutual import was accepted")
	}
	if !strings.Contains(err.Error(), "import cycle") || !strings.Contains(err.Error(), "skill:a") {
		t.Fatalf("cycle error must name the path: %v", err)
	}
}

// A self import and a multi-hop cycle are both refused, and the message
// shows the loop so a skill author can see which files point at each other.
func TestImportCyclePaths(t *testing.T) {
	cases := []struct {
		name string
		root string
		mods map[string]string
		want string
	}{
		{
			name: "self",
			root: `import a from "skill:a"; export default { a };`,
			mods: map[string]string{
				"skill:a": `import self from "skill:a"; export default { self };`,
			},
			want: "skill:a -> skill:a",
		},
		{
			name: "three hops",
			root: `import a from "skill:a"; export default { a };`,
			mods: map[string]string{
				"skill:a": `import b from "skill:b"; export default { b };`,
				"skill:b": `import c from "skill:c"; export default { c };`,
				"skill:c": `import a from "skill:a"; export default { a };`,
			},
			want: "skill:a -> skill:b -> skill:c -> skill:a",
		},
	}
	for _, tc := range cases {
		_, err := EvalModule(Module{Name: "root.js", Source: []byte(tc.root), Resolve: skillSet(tc.mods)})
		if err == nil {
			t.Fatalf("%s: cycle was accepted", tc.name)
		}
		if !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s: error %q should show the loop %q", tc.name, err, tc.want)
		}
	}
}
