package tools

import (
	"fmt"
	"os"
)

// EmbeddedUnishVersion is the version of the embedded cross-platform unish shell
// linked directly into the daemon binary (zero external download or host shell dependency).
const EmbeddedUnishVersion = "v1.2.0"

// EnsureShell resolves the current executable and pins embedded unish ("<exe> --sh-c")
// as the process-wide shell. No network downloads or host shell probing occur.
func EnsureShell(_ string) error {
	exe, err := os.Executable()
	if err != nil || exe == "" {
		return fmt.Errorf("embedded unish unavailable: cannot resolve executable path: %w", err)
	}
	SetShellOverride(exe, "--sh-c", true)
	return nil
}

// ShellAvailable reports whether this process has a usable shell configured.
func ShellAvailable() bool {
	return currentShell().path != ""
}
