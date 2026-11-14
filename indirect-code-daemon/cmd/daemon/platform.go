package main

import (
	"fmt"
	"os/exec"

	"indirect/indirect-code-daemon/packages/agent/tools"
)

func lookPath(name string) (string, error) {
	return exec.LookPath(name)
}

// detectShell reports the embedded unish engine compiled into the daemon.
func detectShell() (string, error) {
	return fmt.Sprintf("embedded unish (%s)", tools.EmbeddedUnishVersion), nil
}
