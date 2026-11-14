package tools

import (
	"os"
	"os/exec"
	"strings"
	"testing"

	"indirect/indirect-code-daemon/packages/unishcli"
)

func TestMain(m *testing.M) {
	if ok, code := unishcli.MaybeRunArgs(os.Args); ok {
		os.Exit(code)
	}
	os.Exit(m.Run())
}

func TestEmbeddedEnsureShellAndMultiCall(t *testing.T) {
	t.Cleanup(ClearShellOverride)
	if err := EnsureShell(t.TempDir()); err != nil {
		t.Fatalf("EnsureShell failed: %v", err)
	}
	if !ShellAvailable() {
		t.Fatal("expected ShellAvailable() == true")
	}
	shPath, shFlag := ShellForTests()
	if shPath == "" || shFlag != "--sh-c" {
		t.Fatalf("unexpected ShellForTests() = (%q, %q)", shPath, shFlag)
	}
	if desc := ShellDescription(); !strings.Contains(desc, "unish") {
		t.Fatalf("expected ShellDescription() to mention embedded unish, got %q", desc)
	}

	out, err := exec.Command(shPath, "--sh-c", "printf 'embedded-%s' ok").CombinedOutput()
	if err != nil {
		t.Fatalf("child --sh-c failed: %v (out=%q)", err, string(out))
	}
	if string(out) != "embedded-ok" {
		t.Fatalf("unexpected --sh-c output: %q", string(out))
	}

	verOut, err := exec.Command(shPath, "--sh", "--version").CombinedOutput()
	if err != nil {
		t.Fatalf("child --sh --version failed: %v (out=%q)", err, string(verOut))
	}
	if !strings.Contains(string(verOut), "unish") {
		t.Fatalf("unexpected --sh --version output: %q", string(verOut))
	}
}
