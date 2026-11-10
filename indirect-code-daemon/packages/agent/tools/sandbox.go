package tools

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
)

// Sandbox guards tool access to the filesystem and shell. When Locked
// is true (1), file tools refuse paths outside Root and bash runs with
// a restricted environment.
//
// The value is designed to be shared across tool instances (by pointer).
// Enable/Disable are atomic so they can be toggled from the UI.
type Sandbox struct {
	Root         string
	Permissions  *PermissionSet
	locked       atomic.Bool
	readOnlyRoot atomic.Bool
	// extraRoots are additional allowed subtrees outside Root (e.g. the
	// per-session brain scratch space). Set once via AllowExtra during
	// setup, before Lock and before any tool runs.
	extraRoots []string
}

// SetProjectReadOnly marks the primary project Root as read-only while
// keeping extraRoots (such as the session brain directory) writable.
func (s *Sandbox) SetProjectReadOnly(ro bool) {
	if s == nil {
		return
	}
	s.readOnlyRoot.Store(ro)
}

// ProjectReadOnly reports whether the primary project Root is read-only.
func (s *Sandbox) ProjectReadOnly() bool {
	return s != nil && s.readOnlyRoot.Load()
}

// ReadOnlyRoots returns the roots that must be enforced as read-only.
func (s *Sandbox) ReadOnlyRoots() []string {
	if !s.ProjectReadOnly() || s.Root == "" {
		return nil
	}
	return []string{s.Root}
}

// isUnderExtraRoot reports whether target sits under one of extraRoots.
func (s *Sandbox) isUnderExtraRoot(target string) bool {
	if s == nil {
		return false
	}
	for _, extra := range s.extraRoots {
		extraAbs, err := canonicalOrParent(extra)
		if err != nil {
			continue
		}
		if isUnder(extraAbs, target) {
			return true
		}
	}
	return false
}

// AllowExtra permits one more subtree outside Root. Fail-closed on
// unresolvable paths: an extra root that cannot be canonicalized is
// ignored at check time.
func (s *Sandbox) AllowExtra(path string) {
	if s == nil || path == "" {
		return
	}
	s.extraRoots = append(s.extraRoots, path)
}

// isAllowed reports whether a canonicalized target sits under the root
// or any extra root. rootAbs must already be canonicalized.
func (s *Sandbox) isAllowed(rootAbs, target string) bool {
	if isUnder(rootAbs, target) {
		return true
	}
	for _, extra := range s.extraRoots {
		extraAbs, err := canonicalOrParent(extra)
		if err != nil {
			continue
		}
		if isUnder(extraAbs, target) {
			return true
		}
	}
	return false
}

// NewSandbox returns a Sandbox rooted at cwd. It starts unlocked.
func NewSandbox(root string) *Sandbox {
	s := &Sandbox{Root: root}
	return s
}

// Lock enables sandboxing.
func (s *Sandbox) Lock() { s.locked.Store(true) }

// Unlock disables sandboxing.
func (s *Sandbox) Unlock() { s.locked.Store(false) }

// Locked reports whether the sandbox is enforcing limits.
func (s *Sandbox) Locked() bool { return s != nil && s.locked.Load() }

// JailRoots returns the allowed filesystem roots when the sandbox is locked,
// or nil when unlocked.
func (s *Sandbox) JailRoots() []string {
	if !s.Locked() {
		return nil
	}
	roots := make([]string, 0, 1+len(s.extraRoots))
	if s.Root != "" {
		roots = append(roots, s.Root)
	}
	roots = append(roots, s.extraRoots...)
	return roots
}

// CheckPath verifies that path resolves inside the sandbox root.
// Returns an error describing the violation if not. No-op when unlocked.
// Callers should pass an already-absolute path (use resolvePath() first).
func (s *Sandbox) CheckPath(path string) error {
	if !s.Locked() {
		return nil
	}
	rootAbs, err := canonical(s.Root)
	if err != nil {
		return fmt.Errorf("sandbox root: %w", err)
	}
	// Resolve the target to an absolute path. Walk up until we find an
	// existing parent so symlinks inside nonexistent dirs are still caught.
	target, err := canonicalOrParent(path)
	if err != nil {
		return fmt.Errorf("sandbox path: %w", err)
	}
	if !s.isAllowed(rootAbs, target) {
		return fmt.Errorf("jailed: path %q is outside sandbox root %q (use /unjail to disable)", path, s.Root)
	}
	return nil
}

// DisplayPath returns the path the model should see in tool results
// and error messages. When jailed, an absolute path inside the
// sandbox root is rewritten relative to that root ("./pkg/foo.go"),
// which keeps absolute paths out of the context window so the model
// is nudged toward relative paths instead of trying to escape the
// jail (see issue #39). Paths outside root, unjailed sessions, and
// already-relative inputs are returned unchanged.
//
// abs should be the resolved absolute path (resolvePath output);
// given is the path exactly as the model supplied it, used as the
// fallback when no better relative form is available.
func (s *Sandbox) DisplayPath(abs, given string) string {
	if !s.Locked() {
		return given
	}
	rootAbs, err := canonical(s.Root)
	if err != nil {
		return given
	}
	target, err := canonicalOrParent(abs)
	if err != nil {
		return given
	}
	if !isUnder(rootAbs, target) {
		return given
	}
	rel, err := filepath.Rel(rootAbs, target)
	if err != nil || rel == "" || strings.HasPrefix(rel, "..") {
		return given
	}
	if rel == "." {
		return "."
	}
	return "./" + filepath.ToSlash(rel)
}

// CheckExecScript validates that an exec_script invocation may proceed.
// Unlike CheckCommand, JavaScript source code is not tokenized or scanned as a
// shell command; the embedded QuickJS runtime enforces JailRoots,
// ReadOnlyRoots, FSReadRoots, FSWriteRoots, NetAllow, and $ / child_process
// sandboxing at execution time.
func (s *Sandbox) CheckExecScript(code string) error {
	_ = code
	return nil
}

// CheckCommand applies a lightweight sanity check to a bash command
// when jailed. We cannot fully sandbox a shell, but we can reject the
// most obvious escapes so the model does not accidentally touch files
// outside root via shell arguments or redirections.
func (s *Sandbox) CheckCommand(cmd string) error {
	if s == nil || (!s.Locked() && !s.ProjectReadOnly()) {
		return nil
	}
	cmd = strings.TrimSpace(cmd)
	if cmd == "" {
		return nil
	}
	if s.ProjectReadOnly() {
		if err := s.checkReadOnlyBashCommand(cmd); err != nil {
			return err
		}
	}
	if !s.Locked() {
		return nil
	}
	return s.checkLockedCommandDepth(cmd, 0)
}

func (s *Sandbox) checkLockedCommandDepth(cmd string, depth int) error {
	if depth > 8 {
		return fmt.Errorf("jailed: deeply nested shell command is not allowed (use /unjail to disable)")
	}
	cmd = strings.TrimSpace(cmd)
	if cmd == "" {
		return nil
	}
	// Reject obvious destructive roots.
	banned := []string{
		"rm -rf /", "rm -rf ~", "rm -rf $HOME",
		"sudo ", "su ",
		"chmod -R ", "chown -R ",
		"mkfs", "dd if=", "dd of=/",
	}
	lower := strings.ToLower(cmd)
	for _, b := range banned {
		if strings.Contains(lower, strings.ToLower(b)) {
			return fmt.Errorf("jailed: command contains banned pattern %q (use /unjail to disable)", b)
		}
	}
	for _, sub := range extractShellSubstitutions(cmd) {
		if err := s.checkLockedCommandDepth(sub, depth+1); err != nil {
			return err
		}
	}

	nestedShells := map[string]bool{
		"sh": true, "bash": true, "zsh": true, "dash": true, "ksh": true, "ash": true,
		"unish": true, "cmd": true, "powershell": true, "pwsh": true, "eval": true,
		"source": true, ".": true,
	}
	wrappers := map[string]bool{
		"env": true, "command": true, "builtin": true, "exec": true,
		"nice": true, "nohup": true, "time": true, "stdbuf": true,
	}

	for _, seg := range splitShellSegments(cmd) {
		if target, ok := cdTarget(seg); ok {
			if err := s.checkCDTarget(target); err != nil {
				return err
			}
		}
		fields := shellWords(seg)
		for len(fields) > 0 {
			tok := fields[0]
			if eq := strings.IndexByte(tok, '='); eq > 0 && !strings.ContainsAny(tok[:eq], `/\`) {
				fields = fields[1:]
				continue
			}
			base := strings.ToLower(strings.TrimSuffix(filepath.Base(tok), ".exe"))
			if wrappers[base] {
				fields = fields[1:]
				for len(fields) > 0 && strings.HasPrefix(fields[0], "-") {
					if base == "env" && (fields[0] == "-u" || fields[0] == "-C" || fields[0] == "-S") && len(fields) > 1 {
						fields = fields[2:]
						continue
					}
					if base == "nice" && fields[0] == "-n" && len(fields) > 1 {
						fields = fields[2:]
						continue
					}
					if base == "stdbuf" && (fields[0] == "-i" || fields[0] == "-o" || fields[0] == "-e") && len(fields) > 1 {
						fields = fields[2:]
						continue
					}
					fields = fields[1:]
				}
				continue
			}
			if base == "timeout" && len(fields) >= 2 {
				fields = fields[1:]
				for len(fields) > 0 && strings.HasPrefix(fields[0], "-") {
					if (fields[0] == "-k" || fields[0] == "-s") && len(fields) > 1 {
						fields = fields[2:]
						continue
					}
					fields = fields[1:]
				}
				if len(fields) > 0 {
					fields = fields[1:]
				}
				continue
			}
			if base == "xargs" {
				fields = fields[1:]
				for len(fields) > 0 && strings.HasPrefix(fields[0], "-") {
					if (fields[0] == "-I" || fields[0] == "-L" || fields[0] == "-n" || fields[0] == "-P" || fields[0] == "-s" || fields[0] == "-d" || fields[0] == "-a" || fields[0] == "-E") && len(fields) > 1 {
						fields = fields[2:]
						continue
					}
					fields = fields[1:]
				}
				if len(fields) == 0 {
					break
				}
				continue
			}
			break
		}
		if len(fields) == 0 {
			continue
		}
		bin := strings.ToLower(strings.TrimSuffix(filepath.Base(fields[0]), ".exe"))
		if nestedShells[bin] {
			if bin == "eval" {
				if err := s.checkLockedCommandDepth(strings.Join(fields[1:], " "), depth+1); err != nil {
					return err
				}
				continue
			}
			for i := 1; i < len(fields); i++ {
				a := fields[i]
				if a == "-c" || strings.EqualFold(a, "/c") || (strings.HasPrefix(a, "-") && !strings.HasPrefix(a, "--") && strings.ContainsRune(a[1:], 'c')) {
					if i+1 < len(fields) {
						if err := s.checkLockedCommandDepth(fields[i+1], depth+1); err != nil {
							return err
						}
					}
					break
				}
			}
		}
	}

	if err := s.checkCommandPaths(cmd); err != nil {
		return err
	}
	return nil
}

func splitShellSegments(cmd string) []string {
	var segments []string
	var b strings.Builder
	var quote rune
	escaped := false
	flush := func() {
		seg := strings.TrimSpace(b.String())
		if seg != "" {
			segments = append(segments, seg)
		}
		b.Reset()
	}
	for _, r := range cmd {
		if escaped {
			b.WriteRune(r)
			escaped = false
			continue
		}
		if r == '\\' && quote != '\'' {
			b.WriteRune(r)
			escaped = true
			continue
		}
		if quote != 0 {
			if r == quote {
				quote = 0
			}
			b.WriteRune(r)
			continue
		}
		switch r {
		case '\'', '"':
			quote = r
			b.WriteRune(r)
		case ';', '\n', '|', '&':
			flush()
		default:
			b.WriteRune(r)
		}
	}
	flush()
	return segments
}

func extractShellSubstitutions(cmd string) []string {
	var subs []string
	var quote rune
	escaped := false
	for i := 0; i < len(cmd); i++ {
		c := cmd[i]
		if escaped {
			escaped = false
			continue
		}
		if c == '\\' && quote != '\'' {
			escaped = true
			continue
		}
		if quote == '\'' {
			if c == '\'' {
				quote = 0
			}
			continue
		}
		if c == '\'' || c == '"' {
			if quote == 0 {
				quote = rune(c)
			} else if rune(c) == quote {
				quote = 0
			}
		}
		if c == '$' && i+1 < len(cmd) && cmd[i+1] == '(' {
			depth := 1
			start := i + 2
			j := start
			subQuote := rune(0)
			subEsc := false
			for j < len(cmd) && depth > 0 {
				sc := cmd[j]
				if subEsc {
					subEsc = false
					j++
					continue
				}
				if sc == '\\' && subQuote != '\'' {
					subEsc = true
					j++
					continue
				}
				if subQuote != 0 {
					if rune(sc) == subQuote {
						subQuote = 0
					}
					j++
					continue
				}
				if sc == '\'' || sc == '"' {
					subQuote = rune(sc)
					j++
					continue
				}
				if sc == '(' {
					depth++
				} else if sc == ')' {
					depth--
					if depth == 0 {
						subs = append(subs, cmd[start:j])
						break
					}
				}
				j++
			}
			i = j
			continue
		}
		if c == '`' {
			start := i + 1
			j := start
			for j < len(cmd) {
				if cmd[j] == '\\' {
					j += 2
					continue
				}
				if cmd[j] == '`' {
					subs = append(subs, cmd[start:j])
					break
				}
				j++
			}
			i = j
		}
	}
	return subs
}

func (s *Sandbox) checkReadOnlyBashCommand(cmd string) error {
	return s.checkReadOnlyBashCommandDepth(cmd, 0)
}

func (s *Sandbox) checkReadOnlyBashCommandDepth(cmd string, depth int) error {
	if depth > 8 {
		return fmt.Errorf("permission denied: read-only mode does not permit deeply nested shell commands")
	}
	for _, sub := range extractShellSubstitutions(cmd) {
		if err := s.checkReadOnlyBashCommandDepth(sub, depth+1); err != nil {
			return err
		}
	}

	mutatingBins := map[string]bool{
		"rm": true, "rmdir": true, "mkdir": true, "touch": true, "mv": true, "cp": true,
		"install": true, "tee": true, "truncate": true, "chmod": true, "chown": true,
		"chgrp": true, "ln": true, "dd": true, "patch": true, "mktemp": true,
		"rsync": true, "scp": true, "tar": true, "unzip": true, "gunzip": true,
		"bunzip2": true, "xz": true,
	}
	readonlyBlockedBins := map[string]bool{
		"python": true, "python2": true, "python3": true, "py": true, "pypy": true, "pypy3": true,
		"node": true, "nodejs": true, "bun": true, "deno": true, "qjs": true, "quickjs": true,
		"indirect-code": true, "exec_script": true,
		"perl": true, "ruby": true, "irb": true, "erb": true, "php": true, "lua": true, "luajit": true,
		"tclsh": true, "wish": true, "rscript": true, "r": true, "julia": true, "guile": true,
		"awk": true, "gawk": true, "mawk": true, "nawk": true,
		"ed": true, "ex": true, "vi": true, "vim": true, "nvim": true, "nano": true, "emacs": true,
		"npm": true, "npx": true, "pnpm": true, "pnpx": true, "yarn": true, "corepack": true,
		"pip": true, "pip2": true, "pip3": true, "pipx": true, "uv": true, "uvx": true,
		"poetry": true, "pdm": true, "conda": true, "mamba": true, "gem": true, "bundle": true, "bundler": true,
		"cargo": true, "rustup": true, "composer": true, "mvn": true, "mvnw": true, "gradle": true, "gradlew": true, "ant": true,
		"make": true, "gmake": true, "cmake": true, "ctest": true, "ninja": true, "meson": true,
		"just": true, "task": true, "bazel": true, "bazelisk": true, "buck": true, "buck2": true, "scons": true, "waf": true,
		"go": true, "gcc": true, "g++": true, "cc": true, "c++": true, "clang": true, "clang++": true,
		"zig": true, "rustc": true, "javac": true, "java": true, "javaw": true, "kotlinc": true, "scalac": true,
		"tsc": true, "esbuild": true, "vite": true, "webpack": true, "rollup": true, "parcel": true, "swc": true,
		"ld": true, "ar": true, "ranlib": true, "strip": true, "objcopy": true,
		"dotnet": true, "msbuild": true, "nuget": true,
		"sqlite3": true, "psql": true, "mysql": true, "redis-cli": true,
		"curl": true, "wget": true, "ftp": true, "sftp": true, "ssh": true,
		"cscript": true, "wscript": true, "osascript": true,
	}
	nestedShells := map[string]bool{
		"sh": true, "bash": true, "zsh": true, "dash": true, "ksh": true, "ash": true,
		"unish": true, "cmd": true, "powershell": true, "pwsh": true, "eval": true,
		"source": true, ".": true,
	}
	wrappers := map[string]bool{
		"env": true, "command": true, "builtin": true, "exec": true,
		"nice": true, "nohup": true, "time": true, "stdbuf": true,
	}

	segments := splitShellSegments(cmd)
	for _, seg := range segments {
		fields := shellWords(seg)
		for len(fields) > 0 {
			tok := fields[0]
			if eq := strings.IndexByte(tok, '='); eq > 0 && !strings.ContainsAny(tok[:eq], `/\`) {
				fields = fields[1:]
				continue
			}
			base := strings.ToLower(strings.TrimSuffix(filepath.Base(tok), ".exe"))
			if wrappers[base] {
				fields = fields[1:]
				for len(fields) > 0 && strings.HasPrefix(fields[0], "-") {
					if base == "env" && (fields[0] == "-u" || fields[0] == "-C" || fields[0] == "-S") && len(fields) > 1 {
						fields = fields[2:]
						continue
					}
					if base == "nice" && fields[0] == "-n" && len(fields) > 1 {
						fields = fields[2:]
						continue
					}
					if base == "stdbuf" && (fields[0] == "-i" || fields[0] == "-o" || fields[0] == "-e") && len(fields) > 1 {
						fields = fields[2:]
						continue
					}
					fields = fields[1:]
				}
				continue
			}
			if base == "timeout" && len(fields) >= 2 {
				fields = fields[1:]
				for len(fields) > 0 && strings.HasPrefix(fields[0], "-") {
					if (fields[0] == "-k" || fields[0] == "-s") && len(fields) > 1 {
						fields = fields[2:]
						continue
					}
					fields = fields[1:]
				}
				if len(fields) > 0 {
					fields = fields[1:] // duration
				}
				continue
			}
			if base == "xargs" {
				fields = fields[1:]
				for len(fields) > 0 && strings.HasPrefix(fields[0], "-") {
					if (fields[0] == "-I" || fields[0] == "-L" || fields[0] == "-n" || fields[0] == "-P" || fields[0] == "-s" || fields[0] == "-d" || fields[0] == "-a" || fields[0] == "-E") && len(fields) > 1 {
						fields = fields[2:]
						continue
					}
					fields = fields[1:]
				}
				if len(fields) == 0 {
					break
				}
				continue
			}
			break
		}
		if len(fields) == 0 {
			continue
		}
		bin := strings.ToLower(strings.TrimSuffix(filepath.Base(fields[0]), ".exe"))

		if nestedShells[bin] {
			if bin == "eval" {
				if err := s.checkReadOnlyBashCommandDepth(strings.Join(fields[1:], " "), depth+1); err != nil {
					return err
				}
				continue
			}
			foundInline := false
			for i := 1; i < len(fields); i++ {
				a := fields[i]
				if a == "-c" || strings.EqualFold(a, "/c") || (strings.HasPrefix(a, "-") && !strings.HasPrefix(a, "--") && strings.ContainsRune(a[1:], 'c')) {
					if i+1 < len(fields) {
						foundInline = true
						if err := s.checkReadOnlyBashCommandDepth(fields[i+1], depth+1); err != nil {
							return err
						}
					}
					break
				}
			}
			if !foundInline {
				return fmt.Errorf("permission denied: read-only mode does not permit nested shell %q without inline -c command", bin)
			}
			continue
		}

		if readonlyBlockedBins[bin] {
			return fmt.Errorf("permission denied: read-only mode does not permit %q in project workspace", bin)
		}

		if mutatingBins[bin] {
			hasTargetInProject := false
			nonFlagArgs := 0
			for _, arg := range fields[1:] {
				if strings.HasPrefix(arg, "-") {
					if valIdx := strings.IndexByte(arg, '='); valIdx > 0 {
						arg = arg[valIdx+1:]
					} else {
						continue
					}
				}
				nonFlagArgs++
				expanded := expandHome(arg)
				if !filepath.IsAbs(expanded) {
					expanded = filepath.Join(s.Root, filepath.FromSlash(expanded))
				}
				if target, err := canonicalOrParent(expanded); err == nil && !s.isUnderExtraRoot(target) {
					hasTargetInProject = true
					break
				}
			}
			if nonFlagArgs == 0 {
				hasTargetInProject = true
			}
			if hasTargetInProject {
				return fmt.Errorf("permission denied: read-only mode does not permit %q in project workspace", bin)
			}
		}

		if bin == "sed" || bin == "perl" || bin == "ruby" {
			for _, arg := range fields[1:] {
				if arg == "-i" || strings.HasPrefix(arg, "-i") || arg == "--in-place" || strings.HasPrefix(arg, "--in-place=") {
					return fmt.Errorf("permission denied: read-only mode does not permit %s -i in project workspace", bin)
				}
			}
		}

		if bin == "find" {
			for _, arg := range fields[1:] {
				switch arg {
				case "-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls":
					return fmt.Errorf("permission denied: read-only mode does not permit find %s in project workspace", arg)
				}
			}
		}

		if bin == "git" {
			if err := s.checkReadOnlyGitFields(fields[1:]); err != nil {
				return err
			}
		}
	}

	// Check unquoted output redirections (> or >>) outside extraRoots / os.DevNull.
	var quote rune
	escaped := false
	for i := 0; i < len(cmd); i++ {
		c := cmd[i]
		if escaped {
			escaped = false
			continue
		}
		if c == '\\' && quote != '\'' {
			escaped = true
			continue
		}
		if quote != 0 {
			if rune(c) == quote {
				quote = 0
			}
			continue
		}
		if c == '\'' || c == '"' {
			quote = rune(c)
			continue
		}
		if c == '>' {
			if i+1 < len(cmd) && (cmd[i+1] == '>' || cmd[i+1] == '|') {
				i++
			}
			if i+1 < len(cmd) && cmd[i+1] == '&' {
				continue
			}
			rest := strings.TrimSpace(cmd[i+1:])
			words := shellWords(rest)
			if len(words) > 0 {
				targetTok := words[0]
				if targetTok == os.DevNull || targetTok == "/dev/null" || targetTok == "NUL" {
					continue
				}
				expanded := expandHome(targetTok)
				if !filepath.IsAbs(expanded) {
					expanded = filepath.Join(s.Root, filepath.FromSlash(expanded))
				}
				if target, err := canonicalOrParent(expanded); err == nil && s.isUnderExtraRoot(target) {
					continue
				}
				return fmt.Errorf("permission denied: read-only mode does not permit shell output redirection to %q", targetTok)
			}
		}
	}
	return nil
}

func (s *Sandbox) checkReadOnlyGitFields(args []string) error {
	subIdx := -1
	sub := ""
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			break
		}
		switch a {
		case "-c", "--config-env":
			if i+1 < len(args) {
				i++
				kv := strings.ToLower(args[i])
				for _, bad := range []string{"core.editor", "sequence.editor", "core.pager", "core.sshcommand", "core.fsmonitor", "core.hookspath", "diff.external", "credential.helper", "alias.", "filter."} {
					if strings.HasPrefix(kv, bad) {
						return fmt.Errorf("permission denied: read-only mode does not permit git -c %s", args[i])
					}
				}
			}
			continue
		case "-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--exec-path":
			if a == "--exec-path" {
				return fmt.Errorf("permission denied: read-only mode does not permit git --exec-path")
			}
			if i+1 < len(args) {
				i++
			}
			continue
		}
		if strings.HasPrefix(a, "-c") && len(a) > 2 {
			kv := strings.ToLower(a[2:])
			for _, bad := range []string{"core.editor", "sequence.editor", "core.pager", "core.sshcommand", "core.fsmonitor", "core.hookspath", "diff.external", "credential.helper", "alias.", "filter."} {
				if strings.HasPrefix(kv, bad) {
					return fmt.Errorf("permission denied: read-only mode does not permit git %s", a)
				}
			}
			continue
		}
		if strings.HasPrefix(a, "--exec-path") {
			return fmt.Errorf("permission denied: read-only mode does not permit git %s", a)
		}
		if strings.HasPrefix(a, "-") {
			continue
		}
		subIdx = i
		sub = a
		break
	}
	if sub == "" {
		return nil
	}
	rest := args[subIdx+1:]
	for _, ra := range rest {
		if ra == "--output" || strings.HasPrefix(ra, "--output=") {
			return fmt.Errorf("permission denied: read-only mode does not permit git %s --output in project workspace", sub)
		}
	}
	switch sub {
	case "status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree", "cat-file",
		"blame", "shortlog", "describe", "grep", "for-each-ref", "name-rev", "rev-list",
		"var", "version", "help", "check-ignore", "check-attr", "check-mailmap", "ls-remote",
		"merge-base", "cherry", "count-objects", "fsck", "verify-commit", "verify-tag",
		"whatchanged", "range-diff", "diff-files", "diff-index", "diff-tree", "show-ref", "show-branch":
		return nil
	case "stash":
		for _, arg := range rest {
			if strings.HasPrefix(arg, "-") {
				continue
			}
			if arg == "list" || arg == "show" {
				return nil
			}
			break
		}
		return fmt.Errorf("permission denied: read-only mode does not permit git stash in project workspace")
	case "apply":
		hasCheck := false
		for _, arg := range rest {
			if arg == "--check" {
				hasCheck = true
			}
			if arg == "--index" || arg == "--cached" || arg == "--3way" {
				hasCheck = false
				break
			}
		}
		if !hasCheck {
			return fmt.Errorf("permission denied: read-only mode does not permit git apply without --check in project workspace")
		}
		return nil
	case "branch", "tag":
		hasListFlag := false
		posCount := 0
		for _, ra := range rest {
			switch ra {
			case "-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy", "-f", "--force", "-s", "-u", "-a":
				if sub == "tag" && ra == "-a" {
					return fmt.Errorf("permission denied: read-only mode does not permit git tag -a in project workspace")
				}
				if ra != "-a" {
					return fmt.Errorf("permission denied: read-only mode does not permit git %s %s in project workspace", sub, ra)
				}
				hasListFlag = true
			case "-l", "--list", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--show-current", "--contains", "--merged", "--no-merged", "--points-at":
				hasListFlag = true
			default:
				if !strings.HasPrefix(ra, "-") {
					posCount++
				}
			}
		}
		if posCount > 0 && !hasListFlag {
			return fmt.Errorf("permission denied: read-only mode does not permit git %s mutation in project workspace", sub)
		}
		return nil
	case "remote":
		for _, ra := range rest {
			if ra != "-v" && ra != "--verbose" && ra != "show" && ra != "get-url" && !strings.HasPrefix(ra, "-") {
				return fmt.Errorf("permission denied: read-only mode does not permit git remote %s in project workspace", ra)
			}
		}
		return nil
	case "config":
		hasReadFlag := false
		for _, ra := range rest {
			switch ra {
			case "--get", "--get-all", "--get-regexp", "--get-urlmatch", "-l", "--list":
				hasReadFlag = true
			case "--unset", "--unset-all", "--replace-all", "--add", "--remove-section", "--rename-section", "-e", "--edit":
				return fmt.Errorf("permission denied: read-only mode does not permit git config %s in project workspace", ra)
			}
		}
		if !hasReadFlag {
			return fmt.Errorf("permission denied: read-only mode does not permit git config mutation in project workspace")
		}
		return nil
	case "reflog":
		for _, ra := range rest {
			if !strings.HasPrefix(ra, "-") && ra != "show" && ra != "exists" {
				return fmt.Errorf("permission denied: read-only mode does not permit git reflog %s in project workspace", ra)
			}
		}
		return nil
	case "worktree":
		for _, ra := range rest {
			if !strings.HasPrefix(ra, "-") && ra != "list" {
				return fmt.Errorf("permission denied: read-only mode does not permit git worktree %s in project workspace", ra)
			}
		}
		return nil
	default:
		return fmt.Errorf("permission denied: read-only mode does not permit git %s in project workspace", sub)
	}
}

// cdTarget extracts the destination of a leading `cd <dir>` command.
// Returns ok=false when seg is not a `cd` invocation or has no explicit
// target (bare `cd` / `cd -` go home / previous dir; we leave those to
// the path checks on subsequent tool calls rather than guessing).
func cdTarget(seg string) (string, bool) {
	seg = strings.TrimSpace(seg)
	if seg != "cd" && !strings.HasPrefix(seg, "cd ") {
		return "", false
	}
	arg := strings.TrimSpace(strings.TrimPrefix(seg, "cd"))
	if arg == "" || arg == "-" {
		return "", false
	}
	// Drop surrounding quotes if the model wrapped the path.
	if len(arg) >= 2 {
		if (arg[0] == '"' && arg[len(arg)-1] == '"') || (arg[0] == '\'' && arg[len(arg)-1] == '\'') {
			arg = arg[1 : len(arg)-1]
		}
	}
	return arg, true
}

func (s *Sandbox) checkCommandPaths(cmd string) error {
	for _, tok := range shellWords(cmd) {
		for _, p := range candidatePaths(tok) {
			if err := s.checkCommandPath(p); err != nil {
				return err
			}
		}
	}
	return nil
}

func shellWords(cmd string) []string {
	var words []string
	var b strings.Builder
	var quote rune
	escaped := false
	flush := func() {
		if b.Len() == 0 {
			return
		}
		words = append(words, b.String())
		b.Reset()
	}
	for _, r := range cmd {
		if escaped {
			b.WriteRune(r)
			escaped = false
			continue
		}
		if r == '\\' && quote != '\'' {
			b.WriteRune(r)
			escaped = true
			continue
		}
		if quote != 0 {
			if r == quote {
				quote = 0
				continue
			}
			b.WriteRune(r)
			continue
		}
		switch r {
		case '\'', '"':
			quote = r
		case ' ', '\t', '\n', '\r', ';', '&', '|', '(', ')', '<', '>':
			flush()
		default:
			b.WriteRune(r)
		}
	}
	flush()
	return words
}

func candidatePaths(tok string) []string {
	if tok == "" || strings.Contains(tok, "://") {
		return nil
	}
	if strings.HasPrefix(tok, "-") {
		if _, value, ok := strings.Cut(tok, "="); ok {
			return candidatePaths(value)
		}
		return nil
	}
	if name, value, ok := strings.Cut(tok, "="); ok && name != "" && value != "" {
		return candidatePaths(value)
	}
	if looksLikePath(tok) {
		return []string{tok}
	}
	return nil
}

func looksLikePath(s string) bool {
	return filepath.IsAbs(s) ||
		strings.HasPrefix(s, "/") ||
		strings.HasPrefix(s, "~") ||
		strings.HasPrefix(s, "$HOME") ||
		strings.HasPrefix(s, "${HOME}") ||
		strings.HasPrefix(s, "..") ||
		strings.Contains(s, "/") ||
		strings.Contains(s, `\\`)
}

func (s *Sandbox) checkCommandPath(path string) error {
	// The platform null device is safe for shell input/output redirection even
	// though it lives outside the sandbox root. Keep this allowlist exact so
	// other device paths and lookalike descendants still fail closed.
	if path == os.DevNull {
		return nil
	}
	rootAbs, err := canonical(s.Root)
	if err != nil {
		return fmt.Errorf("sandbox root: %w", err)
	}
	expanded := expandHome(path)
	if strings.HasPrefix(expanded, "/") && !filepath.IsAbs(expanded) {
		return fmt.Errorf("jailed: path %q is outside sandbox root %q (use /unjail to disable)", path, s.Root)
	}
	if !filepath.IsAbs(expanded) {
		expanded = filepath.Join(s.Root, filepath.FromSlash(expanded))
	}
	target, err := canonicalOrParent(expanded)
	if err != nil {
		return fmt.Errorf("sandbox path: %w", err)
	}
	if !s.isAllowed(rootAbs, target) {
		return fmt.Errorf("jailed: path %q is outside sandbox root %q (use /unjail to disable)", path, s.Root)
	}
	return nil
}

// checkCDTarget resolves a `cd` destination (relative to the sandbox
// root, with ~ and $HOME expansion) and rejects it only when it lands
// outside the root.
func (s *Sandbox) checkCDTarget(dir string) error {
	rootAbs, err := canonical(s.Root)
	if err != nil {
		return fmt.Errorf("sandbox root: %w", err)
	}
	expanded := expandHome(dir)
	// A leading forward slash is an absolute POSIX path. The shell uses
	// POSIX-style paths regardless of host OS, but on Windows
	// filepath.IsAbs("/etc") is false and filepath.Join would fold it
	// back inside root, so a `cd /etc` escape would slip through. Treat
	// it as an unconditional escape attempt: outside any project root.
	if strings.HasPrefix(expanded, "/") && !filepath.IsAbs(expanded) {
		return fmt.Errorf("jailed: cd outside sandbox root is not allowed (use /unjail to disable)")
	}
	if !filepath.IsAbs(expanded) {
		// Relative targets (including `..`) resolve against the sandbox
		// root, which is the bash tool's working directory when jailed.
		expanded = filepath.Join(s.Root, expanded)
	}
	target, err := canonicalOrParent(expanded)
	if err != nil {
		return fmt.Errorf("sandbox path: %w", err)
	}
	if !s.isAllowed(rootAbs, target) {
		return fmt.Errorf("jailed: cd outside sandbox root is not allowed (use /unjail to disable)")
	}
	return nil
}

// expandHome replaces a leading ~, ~/, or $HOME with the user's home
// directory so cd-target resolution matches what the shell would do.
func expandHome(p string) string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return p
	}
	switch {
	case p == "~" || p == "$HOME" || p == "${HOME}":
		return home
	case strings.HasPrefix(p, "~/"):
		return filepath.Join(home, p[2:])
	case strings.HasPrefix(p, "$HOME/"):
		return filepath.Join(home, p[len("$HOME/"):])
	case strings.HasPrefix(p, "${HOME}/"):
		return filepath.Join(home, p[len("${HOME}/"):])
	}
	if strings.Contains(p, "${HOME}") {
		p = strings.ReplaceAll(p, "${HOME}", home)
	}
	if strings.Contains(p, "$HOME") {
		p = strings.ReplaceAll(p, "$HOME", home)
	}
	return p
}

// canonical returns an absolute, symlink- and junction-resolved path. Errors on missing files.
func canonical(p string) (string, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	cur := filepath.Clean(abs)
	for hops := 0; hops < 40; hops++ {
		vol := filepath.VolumeName(cur)
		rest := cur[len(vol):]
		sep := string(filepath.Separator)
		rest = strings.TrimPrefix(rest, sep)
		if runtime.GOOS == "windows" {
			rest = strings.TrimPrefix(rest, "/")
		}
		var parts []string
		if rest != "" {
			parts = strings.FieldsFunc(rest, func(r rune) bool {
				return r == filepath.Separator || (runtime.GOOS == "windows" && r == '/')
			})
		}
		built := vol + sep
		redirected := false
		for idx, part := range parts {
			if part == "" || part == "." {
				continue
			}
			cand := filepath.Join(built, part)
			fi, lerr := os.Lstat(cand)
			if lerr != nil {
				if hops > 0 && errors.Is(lerr, os.ErrNotExist) {
					if evaled, eerr := filepath.EvalSymlinks(built); eerr == nil {
						built = filepath.Clean(evaled)
					}
					return filepath.Clean(filepath.Join(append([]string{built}, parts[idx:]...)...)), nil
				}
				return "", lerr
			}
			isLink := fi.Mode()&os.ModeSymlink != 0 || (runtime.GOOS == "windows" && fi.Mode()&os.ModeIrregular != 0)
			if isLink {
				target, rerr := os.Readlink(cand)
				if rerr != nil {
					if fi.Mode()&os.ModeSymlink != 0 {
						return "", rerr
					}
				} else if target != "" {
					if runtime.GOOS == "windows" {
						target = strings.TrimPrefix(target, `\??\`)
						target = strings.TrimPrefix(target, `\\?\`)
						if strings.HasPrefix(strings.ToUpper(target), `UNC\`) {
							target = `\\` + target[4:]
						}
					}
					if !filepath.IsAbs(target) {
						target = filepath.Join(built, target)
					}
					if idx+1 < len(parts) {
						target = filepath.Join(append([]string{target}, parts[idx+1:]...)...)
					}
					cur = filepath.Clean(target)
					redirected = true
					break
				}
			}
			built = cand
		}
		if !redirected {
			if evaled, eerr := filepath.EvalSymlinks(built); eerr == nil {
				return filepath.Clean(evaled), nil
			}
			return filepath.Clean(built), nil
		}
	}
	return "", fmt.Errorf("too many symbolic links encountered: %s", p)
}

// canonicalOrParent returns the canonical path for p; if p doesn't exist,
// it walks up until it finds an existing directory, then appends the
// remaining path components. This catches symlink-escapes in non-existent
// subtrees (e.g. "new-file" inside a symlinked dir) and fails closed if an
// existing component cannot be canonicalized.
func canonicalOrParent(p string) (string, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	remaining := ""
	current := filepath.Clean(abs)
	for {
		_, lerr := os.Lstat(current)
		if lerr == nil {
			resolved, err := canonical(current)
			if err != nil {
				return "", err
			}
			if remaining != "" {
				return filepath.Join(resolved, remaining), nil
			}
			return resolved, nil
		}
		if !errors.Is(lerr, os.ErrNotExist) {
			return "", lerr
		}
		parent := filepath.Dir(current)
		if parent == current {
			return abs, nil
		}
		remaining = filepath.Join(filepath.Base(current), remaining)
		current = parent
	}
}

// isUnder reports whether target is equal to root or a descendant of it.
func isUnder(root, target string) bool {
	r := filepath.Clean(root)
	t := filepath.Clean(target)
	if runtime.GOOS == "windows" {
		r = strings.ToLower(r)
		t = strings.ToLower(t)
	}
	rootSep := r
	if !strings.HasSuffix(rootSep, string(filepath.Separator)) {
		rootSep += string(filepath.Separator)
	}
	return t == r || strings.HasPrefix(t, rootSep)
}
