package runner

import (
	"os"
	"testing"

	"indirect/indirect-code-daemon/packages/unishcli"
)

func TestMain(m *testing.M) {
	if ok, code := unishcli.MaybeRunArgs(os.Args); ok {
		os.Exit(code)
	}
	if len(os.Args) == 2 && os.Args[1] == "--runner-command" {
		os.Exit(CommandMain())
	}
	os.Exit(m.Run())
}
