package unishcli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"

	"github.com/italoalmeida0/unish/pkg/unish"
)

// MaybeRunArgs intercepts multi-call "--sh" and "--sh-c" invocations at process
// startup (both the production daemon binary and `go test` binaries).
// It uses unish.NewSession rather than RunCLI standaloneCLIMode so backgrounded
// builtins (`cmd &`) run via trackInProcess instead of re-spawning os.Executable()
// without "--sh".
func MaybeRunArgs(args []string) (bool, int) {
	if len(args) < 2 {
		return false, 0
	}
	switch args[1] {
	case "--sh-c":
		var script string
		var posArgs []string
		if len(args) >= 3 {
			script = args[2]
		}
		if len(args) >= 5 {
			// POSIX: sh -c <script> <arg0> <arg1>...
			posArgs = args[4:]
		}
		return true, runEmbeddedScript(script, posArgs)
	case "--sh":
		return true, runEmbeddedShCLI(args[2:])
	default:
		return false, 0
	}
}

func runEmbeddedShCLI(rest []string) int {
	for i := 0; i < len(rest); i++ {
		arg := rest[i]
		if arg == "--" {
			rest = rest[i+1:]
			break
		}
		switch arg {
		case "--version":
			_, _ = fmt.Fprintln(os.Stdout, "unish v1.2.0")
			return 0
		case "-c":
			if i+1 >= len(rest) {
				_, _ = fmt.Fprintln(os.Stderr, "unish: -c: option requires an argument")
				return 2
			}
			script := rest[i+1]
			var posArgs []string
			if i+3 < len(rest) {
				posArgs = rest[i+3:]
			}
			return runEmbeddedScript(script, posArgs)
		case "-s":
			raw, err := io.ReadAll(os.Stdin)
			if err != nil {
				_, _ = fmt.Fprintf(os.Stderr, "unish: stdin: %v\n", err)
				return 1
			}
			return runEmbeddedScriptWithStdin(string(raw), rest[i+1:], strings.NewReader(""))
		default:
			if strings.HasPrefix(arg, "-") {
				// Ignore benign POSIX shell compatibility flags (-e, -u, -x, -l, +e) if passed;
				// forward set flags into script prologue when recognized.
				if isShortSetFlag(arg) {
					scriptRest := rest[i+1:]
					prefix := "set " + arg + "\n"
					code := runRestWithPrologue(prefix, scriptRest)
					return code
				}
				_, _ = fmt.Fprintf(os.Stderr, "unish: unsupported option %s\n", arg)
				return 2
			}
			// Script file + optional positional arguments.
			scriptFile := arg
			posArgs := rest[i+1:]
			raw, err := os.ReadFile(scriptFile)
			if err != nil {
				_, _ = fmt.Fprintf(os.Stderr, "unish: %s: %v\n", scriptFile, err)
				return 127
			}
			return runEmbeddedScript(string(raw), posArgs)
		}
	}
	if len(rest) > 0 {
		scriptFile := rest[0]
		raw, err := os.ReadFile(scriptFile)
		if err != nil {
			_, _ = fmt.Fprintf(os.Stderr, "unish: %s: %v\n", scriptFile, err)
			return 127
		}
		return runEmbeddedScript(string(raw), rest[1:])
	}
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "unish: stdin: %v\n", err)
		return 1
	}
	return runEmbeddedScriptWithStdin(string(raw), nil, strings.NewReader(""))
}

func isShortSetFlag(arg string) bool {
	if len(arg) < 2 || (arg[0] != '-' && arg[0] != '+') {
		return false
	}
	for _, ch := range arg[1:] {
		switch ch {
		case 'e', 'u', 'x', 'f', 'v', 'n', 'a', 'C':
		default:
			return false
		}
	}
	return true
}

func runRestWithPrologue(prologue string, rest []string) int {
	if len(rest) >= 2 && rest[0] == "-c" {
		var posArgs []string
		if len(rest) >= 4 {
			posArgs = rest[3:]
		}
		return runEmbeddedScript(prologue+rest[1], posArgs)
	}
	if len(rest) >= 1 && !strings.HasPrefix(rest[0], "-") {
		raw, err := os.ReadFile(rest[0])
		if err != nil {
			_, _ = fmt.Fprintf(os.Stderr, "unish: %s: %v\n", rest[0], err)
			return 127
		}
		return runEmbeddedScript(prologue+string(raw), rest[1:])
	}
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		return 1
	}
	return runEmbeddedScriptWithStdin(prologue+string(raw), nil, strings.NewReader(""))
}

func runEmbeddedScript(script string, posArgs []string) int {
	return runEmbeddedScriptWithStdin(script, posArgs, os.Stdin)
}

func runEmbeddedScriptWithStdin(script string, posArgs []string, stdin io.Reader) int {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cwd, _ := os.Getwd()
	jail, cleanEnv, err := buildEnvJail(os.Environ())
	if err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "unish: jail init failed: %v\n", err)
		return 1
	}

	opts := []unish.SessionOption{
		unish.WithWorkDir(cwd),
		unish.WithInheritEnv(false),
		unish.WithEnv(cleanEnv),
	}
	if jail != nil {
		opts = append(opts, unish.WithJail(jail))
	}

	sess, err := unish.NewSession(opts...)
	if err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "unish: %v\n", err)
		return 1
	}
	defer func() { _ = sess.Close() }()

	if len(posArgs) > 0 {
		quoted := make([]string, len(posArgs))
		for i, a := range posArgs {
			quoted[i] = "'" + strings.ReplaceAll(a, "'", `'\''`) + "'"
		}
		_, _ = sess.ExecWith(ctx, "set -- "+strings.Join(quoted, " "), unish.ExecOptions{
			Stdout: io.Discard,
			Stderr: io.Discard,
		})
	}

	res, execErr := sess.ExecWith(ctx, script, unish.ExecOptions{
		Stdin:  stdin,
		Stdout: os.Stdout,
		Stderr: os.Stderr,
	})
	if res != nil {
		if execErr != nil && res.ExitCode == 0 {
			if errors.Is(execErr, context.Canceled) {
				return 130
			}
			return 1
		}
		return res.ExitCode
	}
	if execErr != nil {
		if errors.Is(execErr, context.Canceled) {
			return 130
		}
		_, _ = fmt.Fprintf(os.Stderr, "unish: %v\n", execErr)
		return 2
	}
	return 0
}

// buildEnvJail honors __INDIRECT_* sandbox environment variables when the
// multi-call binary is spawned as a child shell process.
func buildEnvJail(rawEnv []string) (*unish.Jail, []string, error) {
	var jailRoots, roRoots, fsRead, fsWrite, netAllow []string
	clean := make([]string, 0, len(rawEnv))
	for _, kv := range rawEnv {
		eq := strings.IndexByte(kv, '=')
		if eq <= 0 {
			clean = append(clean, kv)
			continue
		}
		k, v := kv[:eq], kv[eq+1:]
		switch k {
		case "__INDIRECT_JAIL_ROOTS":
			_ = json.Unmarshal([]byte(v), &jailRoots)
		case "__INDIRECT_READONLY_ROOTS":
			_ = json.Unmarshal([]byte(v), &roRoots)
		case "__INDIRECT_FS_READ_ROOTS":
			_ = json.Unmarshal([]byte(v), &fsRead)
		case "__INDIRECT_FS_WRITE_ROOTS":
			_ = json.Unmarshal([]byte(v), &fsWrite)
		case "__INDIRECT_NET_ALLOW":
			_ = json.Unmarshal([]byte(v), &netAllow)
		case "__INDIRECT_SHELL_PATH", "__INDIRECT_SHELL_FLAG":
			// Internal qjs test plumbing; strip from shell env.
		default:
			clean = append(clean, kv)
		}
	}

	if len(jailRoots) == 0 && len(roRoots) == 0 && len(fsRead) == 0 && len(fsWrite) == 0 && len(netAllow) == 0 {
		return nil, clean, nil
	}

	roSet := make(map[string]bool, len(roRoots))
	for _, r := range roRoots {
		if r != "" {
			roSet[filepath.Clean(r)] = true
		}
	}

	var writable []string
	var readOnly []string
	if len(fsWrite) > 0 {
		for _, w := range fsWrite {
			if w != "" && w != "__NONE__" && !roSet[filepath.Clean(w)] {
				writable = append(writable, w)
			}
		}
	} else {
		for _, r := range jailRoots {
			if r != "" && !roSet[filepath.Clean(r)] {
				writable = append(writable, r)
			}
		}
	}
	readOnly = append(readOnly, roRoots...)
	for _, r := range fsRead {
		if r != "" && r != "__NONE__" {
			readOnly = append(readOnly, r)
		}
	}
	readOnly = append(readOnly, SystemReadOnlyRoots(clean)...)

	cfg := unish.DefaultJailConfig(writable...)
	cfg.ReadOnlyRoots = readOnly
	cfg.OutsideAction = unish.DecisionDeny
	cfg.ReadOnlyWriteAction = unish.DecisionDeny
	for _, r := range roRoots {
		if r == "" {
			continue
		}
		cfg.Rules = append(cfg.Rules, unish.PathRule{
			Pattern:  filepath.ToSlash(r) + "/**",
			Ops:      []unish.AccessOp{unish.OpWrite, unish.OpDelete, unish.OpLink},
			Decision: unish.DecisionDeny,
			Reason:   "read-only mode: write is not allowed",
		})
	}
	if len(fsRead) == 1 && fsRead[0] == "__NONE__" {
		cfg.ReadOnlyRoots = SystemReadOnlyRoots(clean)
	}
	if len(netAllow) > 0 {
		if len(netAllow) == 1 && netAllow[0] == "__NONE__" {
			cfg.Net = unish.NetPolicy{
				Default:       unish.DecisionDeny,
				AllowLoopback: false,
				AllowListen:   unish.DecisionDeny,
			}
		} else {
			allowAll := false
			var rules []unish.NetRule
			for _, h := range netAllow {
				h = strings.TrimSpace(h)
				if h == "*" {
					allowAll = true
					break
				}
				if h != "" && h != "__NONE__" {
					rules = append(rules, unish.NetRule{HostPattern: h, Decision: unish.DecisionAllow})
				}
			}
			if allowAll {
				cfg.Net = unish.NetPolicy{
					Default:       unish.DecisionAllow,
					AllowLoopback: true,
					AllowListen:   unish.DecisionAllow,
				}
			} else {
				cfg.Net = unish.NetPolicy{
					Default:       unish.DecisionDeny,
					AllowLoopback: true,
					AllowListen:   unish.DecisionAllow,
					Rules:         rules,
				}
			}
		}
	}
	jail, err := unish.NewJail(cfg)
	if err != nil {
		return nil, nil, err
	}
	return jail, clean, nil
}

// SystemReadOnlyRoots collects existing PATH directories and standard OS
// binary/library roots so jailed unish binary resolution (searchPathFileJailed
// OpStat across PATH) and shared-library loading work without false outside-root
// prompts while user home, temp roots, and sibling directories remain protected.
func SystemReadOnlyRoots(env []string, excludeAncestorsOf ...string) []string {
	seen := make(map[string]bool)
	homeDir, _ := os.UserHomeDir()
	tmpDir := os.TempDir()
	isUnsafeBroad := func(clean string) bool {
		if filepath.Dir(clean) == clean {
			return true
		}
		eq := func(a, b string) bool {
			if a == "" || b == "" {
				return false
			}
			if runtime.GOOS == "windows" {
				return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
			}
			return filepath.Clean(a) == filepath.Clean(b)
		}
		if eq(clean, homeDir) || eq(clean, tmpDir) {
			return true
		}
		sl := strings.ToLower(filepath.ToSlash(clean))
		switch sl {
		case "/tmp", "/private/tmp", "/var/tmp", "/home", "/users", "c:/users":
			return true
		}
		for _, child := range excludeAncestorsOf {
			if child == "" {
				continue
			}
			cClean := filepath.Clean(child)
			cSl := filepath.ToSlash(cClean)
			pSl := filepath.ToSlash(clean)
			if runtime.GOOS == "windows" {
				cSl = strings.ToLower(cSl)
				pSl = strings.ToLower(pSl)
			}
			if cSl == pSl || strings.HasPrefix(cSl, strings.TrimRight(pSl, "/")+"/") {
				return true
			}
		}
		return false
	}

	var out []string
	add := func(p string, checkBroad bool) {
		p = strings.TrimSpace(p)
		if p == "" || !filepath.IsAbs(p) {
			return
		}
		clean := filepath.Clean(p)
		if checkBroad && isUnsafeBroad(clean) {
			return
		}
		key := clean
		if runtime.GOOS == "windows" {
			key = strings.ToLower(key)
		}
		if seen[key] {
			return
		}
		if _, err := os.Stat(clean); err != nil {
			return
		}
		seen[key] = true
		out = append(out, clean)
	}

	var pathVal string
	for _, kv := range env {
		if eq := strings.IndexByte(kv, '='); eq > 0 {
			k := kv[:eq]
			if k == "PATH" || (runtime.GOOS == "windows" && strings.EqualFold(k, "PATH")) {
				pathVal = kv[eq+1:]
			}
		}
	}
	if pathVal == "" {
		pathVal = os.Getenv("PATH")
	}
	for _, dir := range filepath.SplitList(pathVal) {
		add(dir, true)
	}
	if exe, err := os.Executable(); err == nil && exe != "" {
		add(filepath.Dir(exe), true)
	}

	if runtime.GOOS == "windows" {
		for _, k := range []string{"SystemRoot", "WINDIR", "ProgramFiles", "ProgramFiles(x86)"} {
			if v := os.Getenv(k); v != "" {
				add(v, false)
			}
		}
		add(`C:\Windows`, false)
	} else {
		for _, sysDir := range []string{
			"/bin",
			"/sbin",
			"/usr",
			"/lib",
			"/lib64",
			"/etc/ssl",
			"/etc/ca-certificates",
			"/etc/pki",
			"/etc/resolv.conf",
			"/etc/hosts",
			"/etc/nsswitch.conf",
			"/etc/localtime",
			"/dev/null",
			"/dev/zero",
			"/dev/urandom",
			"/dev/random",
			"/System/Library",
			"/Library/Developer",
			"/Library/Apple",
			"/opt/homebrew",
			"/nix/store",
			"/run/current-system/sw",
		} {
			add(sysDir, false)
		}
	}
	return out
}
