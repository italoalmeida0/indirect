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

func TestRequireReachesGo(t *testing.T) {
	req := func(name string) (string, error) {
		if name != "base" {
			return "", errors.New(`module "` + name + `" not found`)
		}
		return `{"name":"base","permissions":{"read":"ask"}}`, nil
	}
	out, err := EvalModule(Module{
		Name:    "combo.js",
		Source:  []byte(`export default { name: "combo", base: require("base"), missing: 1 };`),
		Require: req,
	})
	if err != nil {
		t.Fatalf("EvalModule: %v", err)
	}
	if !strings.Contains(out, `"read":"ask"`) {
		t.Fatalf("required snapshot missing: %s", out)
	}
	if _, err := EvalModule(Module{
		Name:    "broken.js",
		Source:  []byte(`export default { base: require("nope") };`),
		Require: req,
	}); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("require error not propagated: %v", err)
	}
}

func TestRequireWithoutLoader(t *testing.T) {
	if _, err := EvalModule(Module{Name: "lonely.js", Source: []byte(`export default { x: require("base") };`)}); err == nil {
		t.Fatal("require succeeded without a loader")
	}
}

func TestExtendMergesAndKeepsOverrides(t *testing.T) {
	src := "const base = { name: \"base\", description: \"b\", permissions: { read: \"ask\", write: \"deny\" }, body: \"BASE\" };\n" +
		"const over = { name: \"combo\", description: \"c\", permissions: { write: \"yolo\" }, body: \"OWN\" };\n" +
		"export default skill.extend(base, over);\n"
	out := eval(t, src)
	var got map[string]any
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("snapshot is not JSON: %v (%s)", err, out)
	}
	if got["name"] != "combo" || got["body"] != "OWN" || got["description"] != "c" {
		t.Fatalf("override metadata lost: %s", out)
	}
	perms, _ := got["permissions"].(map[string]any)
	if perms["read"] != "ask" || perms["write"] != "yolo" {
		t.Fatalf("permissions did not merge: %s", out)
	}
	inherit, _ := got["inherit"].([]any)
	if len(inherit) != 1 || inherit[0] != "base" {
		t.Fatalf("inherit should name the base: %s", out)
	}
}

func TestExtendSingleArgumentCopies(t *testing.T) {
	src := "const base = { name: \"base\", description: \"b\" };\n" +
		"const copy = skill.extend(base);\n" +
		"copy.name = \"renamed\";\n" +
		"export default { original: base.name, copied: copy.name };\n"
	out := eval(t, src)
	if !strings.Contains(out, `"original":"base"`) || !strings.Contains(out, `"copied":"renamed"`) {
		t.Fatalf("copy aliased the original: %s", out)
	}
}

func TestSnapshotRejectsNonData(t *testing.T) {
	cases := map[string]string{
		"function":     `export default { f: function () {} };`,
		"symbol":       `export default { s: Symbol("x") };`,
		"class":        `class Box { constructor() { this.v = 1; } } export default new Box();`,
		"date":         `export default { d: new Date() };`,
		"regexp":       `export default { r: /x/ };`,
		"map":          `export default { m: new Map() };`,
		"cycle":        `const a = { name: "a" }; a.self = a; export default a;`,
		"sparse":       `const a = [1]; a[3] = 4; export default { a };`,
		"nan":          `export default { n: NaN };`,
		"infinity":     `export default { n: Infinity };`,
		"bigint":       `export default { n: 10n };`,
		"accessor":     `export default { get x() { return 1; } };`,
		"depth":        strings.Repeat("export default ", 1) + strings.Repeat("[", 40) + "1" + strings.Repeat("]", 40) + ";",
		"undefined":    `export default { x: [1, undefined] };`,
		"hole":         `const a = [1, 2]; delete a[0]; export default { a };`,
		"hiddenKey":    `const o = {}; Object.defineProperty(o, "x", { value: 1, enumerable: false }); export default o;`,
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
