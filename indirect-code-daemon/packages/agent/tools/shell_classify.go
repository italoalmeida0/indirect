package tools

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"mvdan.cc/sh/v3/syntax"
)

// EvaluateShellCommand parses and classifies a shell script using mvdan.cc/sh/v3/syntax
// against ProjectReadOnly, PermissionRules, Protected Workspace Paths, and AccessMode.
func EvaluateShellCommand(
	cmd string,
	cwd string,
	workspace string,
	brainDir string,
	accessMode string,
	projectReadOnly bool,
	rules []PermissionRule,
) PolicyEvaluation {
	trimmed := strings.TrimSpace(cmd)
	if trimmed == "" {
		if accessMode == "ask" {
			if eff, _ := MatchRules(rules, "tool", "bash", workspace); eff == "allow" {
				return PolicyEvaluation{Verdict: VerdictAllow}
			}
			return PolicyEvaluation{
				Verdict: VerdictAsk,
				Meta: ToolApprovalMeta{
					Capability: "exec",
					Target:     "bash",
					Reason:     "Supervised mode requires approval before running shell commands",
					Risk:       "low",
					AccessMode: "ask",
				},
			}
		}
		return PolicyEvaluation{Verdict: VerdictAllow}
	}

	parser := syntax.NewParser(syntax.Variant(syntax.LangBash))
	prog, err := parser.Parse(strings.NewReader(trimmed), "")
	if err != nil {
		// Unparseable shell syntax: unish uses the exact same parser and will report
		// a syntax error without executing anything. Only prompt in "ask" mode.
		if accessMode == "ask" {
			return PolicyEvaluation{
				Verdict: VerdictAsk,
				Meta: ToolApprovalMeta{
					Capability: "exec",
					Target:     ClipLabel(trimmed),
					Reason:     "Supervised mode requires approval before running shell commands",
					Risk:       "low",
					AccessMode: "ask",
				},
			}
		}
		return PolicyEvaluation{Verdict: VerdictAllow}
	}

	st := &shellWalkState{
		cwd:             nonEmpty(cwd, workspace),
		workspace:       workspace,
		brainDir:        brainDir,
		accessMode:      accessMode,
		projectReadOnly: projectReadOnly,
		rules:           rules,
	}
	st.walkStmts(prog.Stmts)

	if st.deny != nil {
		return *st.deny
	}
	if len(st.asks) > 0 {
		primary := st.asks[0]
		// Collect CallGrants from all findings so clicking "Allow once" pre-tool
		// permits every statically inspected sub-operation of this single bash call.
		var combinedGrants []PermissionRule
		for _, ask := range st.asks {
			combinedGrants = append(combinedGrants, ask.Meta.CallGrants...)
		}
		// If multiple distinct operations require approval or any is non-persistable,
		// do not offer a misleading single persistent rule.
		if len(st.asks) > 1 {
			primary.Meta.ProposedRule = nil
			primary.Meta.CanAllowSession = false
			primary.Meta.CanAllowAlways = false
			for _, a := range st.asks[1:] {
				if riskRank(a.Meta.Risk) > riskRank(primary.Meta.Risk) {
					primary.Meta.Risk = a.Meta.Risk
				}
			}
		}
		primary.Meta.AccessMode = accessMode
		primary.Meta.CallGrants = combinedGrants
		return primary
	}

	// All AST nodes passed "auto" safety checks!
	// If the session is in "auto" or "full" mode, allow immediately.
	if accessMode == "full" || accessMode == "auto" {
		return PolicyEvaluation{
			Verdict: VerdictAllow,
			Meta:    ToolApprovalMeta{CallGrants: st.callGrants},
		}
	}

	// In "ask" mode: check whether every executed command in the script was
	// ALREADY matched by an explicit "allow" rule (or tool="bash" allow rule).
	if eff, _ := MatchRules(rules, "tool", "bash", workspace); eff == "allow" {
		return PolicyEvaluation{
			Verdict: VerdictAllow,
			Meta:    ToolApprovalMeta{CallGrants: st.callGrants},
		}
	}
	if st.callCount > 0 && st.explicitAllowCount == st.callCount {
		return PolicyEvaluation{
			Verdict: VerdictAllow,
			Meta:    ToolApprovalMeta{CallGrants: st.callGrants},
		}
	}

	// Otherwise in "ask" mode, prompt with low risk and propose a rule when single-command.
	var prop *PermissionRule
	canPersist := false
	if len(st.callArgvs) == 1 {
		prop, canPersist = ProposeExecRule(st.callArgvs[0])
	}
	askCallGrants := append([]PermissionRule(nil), st.callGrants...)
	for _, argv := range st.callArgvs {
		if len(argv) > 0 {
			askCallGrants = append(askCallGrants, PermissionRule{
				Effect:  "allow",
				Kind:    "exec",
				Pattern: strings.Join(argv, " "),
			})
		}
	}
	return PolicyEvaluation{
		Verdict: VerdictAsk,
		Meta: ToolApprovalMeta{
			Capability:      "exec",
			Target:          ClipLabel(trimmed),
			Reason:          "Supervised mode requires approval before running shell commands",
			Risk:            "low",
			AccessMode:      "ask",
			ProposedRule:    prop,
			CanAllowSession: canPersist,
			CanAllowAlways:  canPersist,
			CallGrants:      askCallGrants,
		},
	}
}

func riskRank(r string) int {
	switch r {
	case "high":
		return 3
	case "medium":
		return 2
	default:
		return 1
	}
}

type shellWalkState struct {
	cwd                string
	workspace          string
	brainDir           string
	accessMode         string
	projectReadOnly    bool
	rules              []PermissionRule
	deny               *PolicyEvaluation
	asks               []PolicyEvaluation
	callGrants         []PermissionRule
	callArgvs          [][]string
	callCount          int
	explicitAllowCount int
}

func (s *shellWalkState) recordEval(ev PolicyEvaluation, explicitAllow bool) {
	if s.deny != nil {
		return
	}
	switch ev.Verdict {
	case VerdictDeny:
		cp := ev
		s.deny = &cp
	case VerdictAsk:
		s.asks = append(s.asks, ev)
	case VerdictAllow:
		s.callGrants = append(s.callGrants, ev.Meta.CallGrants...)
		if explicitAllow {
			s.explicitAllowCount++
		}
	}
}

func (s *shellWalkState) walkStmts(stmts []*syntax.Stmt) {
	for _, st := range stmts {
		if s.deny != nil {
			return
		}
		s.walkStmt(st)
	}
}

func (s *shellWalkState) walkStmt(st *syntax.Stmt) {
	if st == nil || s.deny != nil {
		return
	}
	for _, redir := range st.Redirs {
		s.checkRedirect(redir)
		if s.deny != nil {
			return
		}
	}
	if st.Cmd != nil {
		s.walkCommand(st.Cmd)
	}
}

func (s *shellWalkState) walkCommand(cmd syntax.Command) {
	if cmd == nil || s.deny != nil {
		return
	}
	switch c := cmd.(type) {
	case *syntax.CallExpr:
		// Inspect any embedded command/process substitutions inside words and assignments first.
		for _, as := range c.Assigns {
			if as.Value != nil {
				s.walkWordSubscripts(as.Value)
			}
			if as.Array != nil {
				for _, elem := range as.Array.Elems {
					if elem.Value != nil {
						s.walkWordSubscripts(elem.Value)
					}
				}
			}
		}
		for _, w := range c.Args {
			s.walkWordSubscripts(w)
		}
		if s.deny != nil {
			return
		}
		if len(c.Args) == 0 {
			return // pure variable assignment
		}
		argv, dynamic := wordsToArgv(c.Args)
		s.evalCall(argv, dynamic)

	case *syntax.BinaryCmd:
		if c.Op == syntax.Pipe || c.Op == syntax.PipeAll {
			if sinkBin := pipelineCodeSink(c.Y); sinkBin != "" {
				full := formatSyntaxNode(c)
				s.recordEval(PolicyEvaluation{
					Verdict: VerdictAsk,
					Meta: ToolApprovalMeta{
						Capability:      "exec",
						Target:          ClipLabel(full),
						Reason:          fmt.Sprintf("Piping output directly into `%s` executes dynamic code and requires approval", sinkBin),
						Risk:            "high",
						AccessMode:      s.accessMode,
						ProposedRule:    nil,
						CanAllowSession: false,
						CanAllowAlways:  false,
					},
				}, false)
				// Still check LHS for hard denies (e.g. ProjectReadOnly), while suppressing duplicate asks.
				savedAsks := len(s.asks)
				savedCwd := s.cwd
				s.walkStmt(c.X)
				s.cwd = savedCwd
				s.walkStmt(c.Y)
				s.cwd = savedCwd
				if len(s.asks) > savedAsks {
					s.asks = s.asks[:savedAsks]
				}
				return
			}
			savedCwd := s.cwd
			s.walkStmt(c.X)
			s.cwd = savedCwd
			s.walkStmt(c.Y)
			s.cwd = savedCwd
			return
		}
		// Sequential && or ||
		s.walkStmt(c.X)
		s.walkStmt(c.Y)

	case *syntax.Subshell:
		savedCwd := s.cwd
		s.walkStmts(c.Stmts)
		s.cwd = savedCwd

	case *syntax.Block:
		s.walkStmts(c.Stmts)

	case *syntax.IfClause:
		for cur := c; cur != nil; cur = cur.Else {
			s.walkStmts(cur.Cond)
			saved := s.cwd
			s.walkStmts(cur.Then)
			s.cwd = saved
		}

	case *syntax.WhileClause:
		s.walkStmts(c.Cond)
		saved := s.cwd
		s.walkStmts(c.Do)
		s.cwd = saved

	case *syntax.ForClause:
		if wi, ok := c.Loop.(*syntax.WordIter); ok {
			for _, w := range wi.Items {
				s.walkWordSubscripts(w)
			}
		}
		saved := s.cwd
		s.walkStmts(c.Do)
		s.cwd = saved

	case *syntax.CaseClause:
		if c.Word != nil {
			s.walkWordSubscripts(c.Word)
		}
		for _, it := range c.Items {
			saved := s.cwd
			s.walkStmts(it.Stmts)
			s.cwd = saved
		}

	case *syntax.DeclClause:
		for _, as := range c.Args {
			if as.Value != nil {
				s.walkWordSubscripts(as.Value)
			}
		}

	case *syntax.FuncDecl:
		saved := s.cwd
		s.walkStmt(c.Body)
		s.cwd = saved

	case *syntax.CoprocClause:
		saved := s.cwd
		s.walkStmt(c.Stmt)
		s.cwd = saved

	case *syntax.TimeClause:
		s.walkStmt(c.Stmt)
	}
}

func (s *shellWalkState) walkWordSubscripts(w *syntax.Word) {
	if w == nil || s.deny != nil {
		return
	}
	syntax.Walk(w, func(n syntax.Node) bool {
		if s.deny != nil {
			return false
		}
		switch sub := n.(type) {
		case *syntax.CmdSubst:
			saved := s.cwd
			s.walkStmts(sub.Stmts)
			s.cwd = saved
			return false
		case *syntax.ProcSubst:
			saved := s.cwd
			s.walkStmts(sub.Stmts)
			s.cwd = saved
			return false
		}
		return true
	})
}

func pipelineCodeSink(st *syntax.Stmt) string {
	if st == nil || st.Cmd == nil {
		return ""
	}
	switch c := st.Cmd.(type) {
	case *syntax.CallExpr:
		argv, _ := wordsToArgv(c.Args)
		unwrapped, _ := unwrapExecArgv(argv)
		if len(unwrapped) == 0 {
			return ""
		}
		bin := baseProgName(unwrapped[0])
		if isShellInterpreterBinary(bin) {
			return bin
		}
		// `curl ... | python` or `curl ... | node` (stdin script execution when no script file arg)
		switch bin {
		case "python", "python3", "node", "bun", "deno", "perl", "ruby", "php", "osascript":
			hasFileArg := false
			for _, a := range unwrapped[1:] {
				if a == "-" {
					return bin
				}
				if !strings.HasPrefix(a, "-") {
					hasFileArg = true
					break
				}
			}
			if !hasFileArg {
				return bin
			}
		case "sudo", "su", "doas":
			return bin
		}
	case *syntax.BinaryCmd:
		if c.Op == syntax.Pipe || c.Op == syntax.PipeAll {
			if b := pipelineCodeSink(c.X); b != "" {
				return b
			}
			return pipelineCodeSink(c.Y)
		}
	}
	return ""
}

func formatSyntaxNode(n syntax.Node) string {
	var sb strings.Builder
	if err := syntax.NewPrinter().Print(&sb, n); err == nil {
		return strings.TrimSpace(sb.String())
	}
	return ""
}

func (s *shellWalkState) checkRedirect(r *syntax.Redirect) {
	if r == nil || r.Word == nil {
		return
	}
	s.walkWordSubscripts(r.Word)
	if s.deny != nil {
		return
	}
	switch r.Op {
	case syntax.DplIn, syntax.DplOut, syntax.Hdoc, syntax.DashHdoc, syntax.WordHdoc:
		return // fd dup (2>&1) or heredoc
	}
	lit, isStatic := wordStaticString(r.Word)
	if !isStatic || lit == "" {
		return // runtime unish.Jail checks dynamic redirections
	}
	if isNullTarget(lit) {
		return
	}
	capKind := "fs_write"
	if r.Op == syntax.RdrIn {
		capKind = "fs_read"
	}
	resolved := resolvePath(s.cwd, expandHomePrefix(lit))
	ev := evaluateFSCheck(capKind, "", resolved, lit, s.accessMode, s.workspace, s.brainDir, s.projectReadOnly, s.rules)
	if ev.Verdict != VerdictAllow {
		s.recordEval(ev, false)
	}
}

func isNullTarget(p string) bool {
	s := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(p), `\`, `/`))
	switch s {
	case "/dev/null", "nul", "//./nul", "/dev/stdout", "/dev/stderr", "/dev/stdin":
		return true
	}
	return false
}

func expandHomePrefix(p string) string {
	if p == "~" {
		if h, err := filepath.Abs(userHomeOrEmpty()); err == nil && h != "" {
			return h
		}
	}
	if strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		if h := userHomeOrEmpty(); h != "" {
			return filepath.Join(h, p[2:])
		}
	}
	return p
}

func userHomeOrEmpty() string {
	h, _ := os.UserHomeDir()
	return h
}

func wordsToArgv(words []*syntax.Word) ([]string, []bool) {
	argv := make([]string, len(words))
	dynamic := make([]bool, len(words))
	for i, w := range words {
		lit, ok := wordStaticString(w)
		if ok {
			argv[i] = lit
		} else {
			argv[i] = formatSyntaxNode(w)
			dynamic[i] = true
		}
	}
	return argv, dynamic
}

func wordStaticString(w *syntax.Word) (string, bool) {
	if w == nil {
		return "", true
	}
	var b strings.Builder
	for _, p := range w.Parts {
		switch x := p.(type) {
		case *syntax.Lit:
			b.WriteString(x.Value)
		case *syntax.SglQuoted:
			b.WriteString(x.Value)
		case *syntax.DblQuoted:
			for _, dp := range x.Parts {
				lit, ok := dp.(*syntax.Lit)
				if !ok {
					return "", false
				}
				b.WriteString(lit.Value)
			}
		default:
			return "", false
		}
	}
	return b.String(), true
}

func (s *shellWalkState) evalCall(argv []string, dynamic []bool) {
	if len(argv) == 0 {
		return
	}
	// Track literal `cd <dir>` within workspace/brainDir so subsequent commands in
	// `cd sub && git push` resolve relative paths and match `git push` rules cleanly!
	if argv[0] == "cd" {
		s.callCount++
		if len(argv) == 1 {
			// bare `cd` goes to $HOME (outside workspace!)
			home := userHomeOrEmpty()
			if home != "" {
				ev := evaluateFSCheck("fs_read", "", home, "~", s.accessMode, s.workspace, s.brainDir, s.projectReadOnly, s.rules)
				s.recordEval(ev, false)
			}
			return
		}
		idx := 1
		if argv[idx] == "--" && idx+1 < len(argv) {
			idx++
		}
		if idx < len(dynamic) && !dynamic[idx] && argv[idx] != "-" {
			targetDir := resolvePath(s.cwd, expandHomePrefix(argv[idx]))
			ev := evaluateFSCheck("fs_read", "", targetDir, argv[idx], s.accessMode, s.workspace, s.brainDir, s.projectReadOnly, s.rules)
			if ev.Verdict != VerdictAllow {
				s.recordEval(ev, false)
				return
			}
			s.cwd = targetDir
			if eff, _ := MatchRules(s.rules, "fs_read", targetDir, s.workspace); eff == "allow" {
				s.explicitAllowCount++
			}
		}
		return
	}

	s.callCount++
	s.callArgvs = append(s.callArgvs, argv)
	ev, explicitAllow := EvaluateExecArgv(argv, dynamic, s.cwd, s.workspace, s.brainDir, s.accessMode, s.projectReadOnly, s.rules)
	s.recordEval(ev, explicitAllow)
}

// EvaluateExecArgv classifies a single command argv (both statically from AST
// and dynamically from unish OpExec / qjs spawn).
// Note: when called from mid-execution unish OpExec, accessMode is evaluated
// under "auto" baseline if the shell call itself was already approved pre-tool!
func EvaluateExecArgv(
	argv []string,
	dynamic []bool,
	cwd string,
	workspace string,
	brainDir string,
	accessMode string,
	projectReadOnly bool,
	rules []PermissionRule,
) (PolicyEvaluation, bool) {
	ev, explicit := evaluateExecArgvCore(argv, dynamic, cwd, workspace, brainDir, accessMode, projectReadOnly, rules)
	return ev, explicit
}

func evaluateExecArgvCore(
	argv []string,
	dynamic []bool,
	cwd string,
	workspace string,
	brainDir string,
	accessMode string,
	projectReadOnly bool,
	rules []PermissionRule,
) (PolicyEvaluation, bool) {
	if len(argv) == 0 {
		return PolicyEvaluation{Verdict: VerdictAllow}, false
	}
	effectiveCwd := nonEmpty(cwd, workspace)

	// Strip leading VAR=VAL tokens if any.
	startIdx := 0
	for startIdx < len(argv) && isEnvAssignToken(argv[startIdx]) {
		startIdx++
	}
	if startIdx >= len(argv) {
		return PolicyEvaluation{Verdict: VerdictAllow}, true
	}
	argv = argv[startIdx:]
	if len(dynamic) >= startIdx {
		dynamic = dynamic[startIdx:]
	} else {
		dynamic = nil
	}

	// Unwrap `env`, `command`, `builtin`, `nohup`, `nice`, `timeout` to inspect inner command!
	innerArgv, innerDyn, usedWrapper := unwrapArgvWithDynamic(argv, dynamic)
	if len(innerArgv) == 0 {
		return PolicyEvaluation{Verdict: VerdictAllow}, false
	}
	stripIfWrapped := func(ev PolicyEvaluation, exp bool) (PolicyEvaluation, bool) {
		if usedWrapper {
			ev.Meta.ProposedRule = nil
			ev.Meta.CanAllowSession = false
			ev.Meta.CanAllowAlways = false
		}
		return ev, exp
	}

	rawCmdStr := normalizeExecString(strings.Join(innerArgv, " "))
	bin := baseProgName(innerArgv[0])
	isLocalNonSystemBin := strings.ContainsAny(innerArgv[0], `/\`) && !isStandardSystemBinaryPath(innerArgv[0])

	// Handle `sh -c <lit>` / `bash -c <lit>` / `unish -c <lit>`: inspect inner script
	// first for hard Deny (e.g. ProjectReadOnly or Deny rules), and require explicit
	// one-shot approval before spawning a subshell binary outside full mode!
	if isShellInterpreterBinary(bin) {
		if script, ok := extractShellDashC(bin, innerArgv[1:], innerDynOffset(innerDyn, 1)); ok {
			sub := EvaluateShellCommand(script, effectiveCwd, workspace, brainDir, "auto", projectReadOnly, rules)
			if sub.Verdict == VerdictDeny {
				return sub, false
			}
			if eff, r := MatchRules(rules, "exec", rawCmdStr, workspace); eff == "deny" {
				return denyExec(rawCmdStr, r), false
			}
			if accessMode == "full" {
				return PolicyEvaluation{Verdict: VerdictAllow}, true
			}
			if sub.Verdict == VerdictAsk {
				sub.Meta.ProposedRule = nil
				sub.Meta.CanAllowSession = false
				sub.Meta.CanAllowAlways = false
				return sub, false
			}
			return askNonPersistable("exec", rawCmdStr, fmt.Sprintf("Executing subshell `%s` requires explicit approval", bin), "medium", accessMode, rawCmdStr), false
		}
	}

	// 1. ProjectReadOnly check BEFORE allow rules: plan/explore mode never mutates workspace.
	if projectReadOnly && !isLocalNonSystemBin {
		if reason := checkReadOnlyArgvViolation(bin, innerArgv, innerDyn, effectiveCwd, workspace, brainDir); reason != "" {
			return PolicyEvaluation{
				Verdict: VerdictDeny,
				Meta: ToolApprovalMeta{
					Capability: "fs_write",
					Target:     rawCmdStr,
					Reason:     reason,
				},
			}, false
		}
	}

	// 2. Explicit Deny rules in PermissionRules / SessionGrants.
	if eff, r := MatchRules(rules, "exec", rawCmdStr, workspace); eff == "deny" {
		return denyExec(rawCmdStr, r), false
	}

	// 3. Explicit Allow rules (NEVER matching non-persistable dangerous wrappers like eval/sudo,
	// and local/writable-root binaries only match path-qualified or wildcard rules).
	explicitExecAllowed := false
	if !usedWrapper && !isShellInterpreterBinary(bin) && bin != "sudo" && bin != "su" && bin != "doas" {
		if eff, r := MatchRules(rules, "exec", rawCmdStr, workspace); eff == "allow" {
			if !isLocalNonSystemBin || strings.ContainsAny(r.Pattern, `/\*`) {
				explicitExecAllowed = true
			}
		}
	}

	// 4. Full mode allows everything not explicitly denied above — except cloud
	// metadata SSRF via curl/wget, which stays hard-blocked in every mode.
	if accessMode == "full" {
		if bin == "curl" || bin == "wget" {
			ev, _ := evalCurlWgetCommand(bin, innerArgv, innerDyn, effectiveCwd, workspace, brainDir, accessMode, projectReadOnly, rules, true)
			if ev.Verdict == VerdictDeny {
				return ev, false
			}
		}
		return PolicyEvaluation{Verdict: VerdictAllow}, true
	}

	// 5. Local or writable-root executable (`./build.sh` or spoofed `$PWD/git`) MUST NOT
	// masquerade as a trusted system binary (`git`, `go`, `ls`, etc.)!
	if isLocalNonSystemBin {
		if explicitExecAllowed {
			if pathAsk := checkArgvPaths(bin, innerArgv, innerDyn, effectiveCwd, workspace, brainDir, accessMode, projectReadOnly, rules, true); pathAsk != nil {
				return stripIfWrapped(*pathAsk, false)
			}
			return PolicyEvaluation{
				Verdict: VerdictAllow,
				Meta: ToolApprovalMeta{
					CallGrants: []PermissionRule{{Effect: "allow", Kind: "exec", Pattern: rawCmdStr}},
				},
			}, true
		}
		var prop *PermissionRule
		ok := false
		if strings.HasPrefix(innerArgv[0], "./") || strings.HasPrefix(innerArgv[0], `.\\`) {
			prop, ok = ProposeExecRule(innerArgv)
		}
		if usedWrapper {
			prop, ok = nil, false
		}
		return PolicyEvaluation{
			Verdict: VerdictAsk,
			Meta: ToolApprovalMeta{
				Capability:      "exec",
				Target:          rawCmdStr,
				Reason:          fmt.Sprintf("Executing local script/binary `%s` requires approval", innerArgv[0]),
				Risk:            "medium",
				AccessMode:      accessMode,
				ProposedRule:    prop,
				CanAllowSession: ok,
				CanAllowAlways:  ok,
				CallGrants:      []PermissionRule{{Effect: "allow", Kind: "exec", Pattern: rawCmdStr}},
			},
		}, false
	}

	// 6. Privilege escalation / non-persistable wrappers / eval / xargs.
	switch bin {
	case "sudo", "su", "doas", "pkexec", "runas":
		return askNonPersistable("exec", rawCmdStr, fmt.Sprintf("Privilege escalation (`%s`) requires explicit approval", bin), "high", accessMode, rawCmdStr), false
	case "eval", "exec":
		return askNonPersistable("exec", rawCmdStr, fmt.Sprintf("Dynamic shell `%s` execution requires explicit approval", bin), "high", accessMode, rawCmdStr), false
	case "sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "unish", "cmd", "powershell", "pwsh":
		return askNonPersistable("exec", rawCmdStr, fmt.Sprintf("Executing subshell `%s` requires explicit approval", bin), "medium", accessMode, rawCmdStr), false
	case "xargs":
		sub := extractXargsSubcommand(innerArgv[1:])
		if len(sub) == 0 || !isSafeXargsTarget(baseProgName(sub[0])) {
			return askNonPersistable("exec", rawCmdStr, "`xargs` executing external/mutating commands requires approval", "high", accessMode, rawCmdStr), false
		}
	}

	// 7. Inspect specific high-signal commands (rm, git, curl/wget, kill).
	switch bin {
	case "rm", "rmdir", "del", "shred":
		return stripIfWrapped(evalRmCommand(bin, innerArgv, innerDyn, effectiveCwd, workspace, brainDir, accessMode, projectReadOnly, rules), false)

	case "git":
		ev, exp := evalGitCommand(innerArgv, innerDyn, effectiveCwd, workspace, brainDir, accessMode, projectReadOnly, rules, explicitExecAllowed)
		return stripIfWrapped(ev, exp)

	case "curl", "wget":
		ev, exp := evalCurlWgetCommand(bin, innerArgv, innerDyn, effectiveCwd, workspace, brainDir, accessMode, projectReadOnly, rules, explicitExecAllowed)
		return stripIfWrapped(ev, exp)

	case "kill", "pkill", "killall", "taskkill":
		if bin == "kill" && allKillTargetsAreShellJobs(innerArgv[1:]) {
			return PolicyEvaluation{Verdict: VerdictAllow}, explicitExecAllowed
		}
		return askNonPersistable("exec", rawCmdStr, fmt.Sprintf("Signaling host processes (`%s`) requires approval", bin), "high", accessMode, rawCmdStr), false
	}

	// 8. If an explicit exec allow rule matched, still verify literal path arguments don't escape
	// workspace without a path rule!
	if explicitExecAllowed {
		if pathAsk := checkArgvPaths(bin, innerArgv, innerDyn, effectiveCwd, workspace, brainDir, accessMode, projectReadOnly, rules, commandWritesPaths(bin, innerArgv[1:])); pathAsk != nil {
			return stripIfWrapped(*pathAsk, false)
		}
		return PolicyEvaluation{
			Verdict: VerdictAllow,
			Meta: ToolApprovalMeta{
				CallGrants: []PermissionRule{{Effect: "allow", Kind: "exec", Pattern: rawCmdStr}},
			},
		}, true
	}

	// 9. Check safe auto-mode builtins & dev toolchains!
	safe, riskReason, riskLevel := isSafeAutoCommand(bin, innerArgv[1:])
	if !safe {
		prop, ok := ProposeExecRule(innerArgv)
		if usedWrapper {
			prop, ok = nil, false
		}
		if riskReason == "" {
			riskReason = fmt.Sprintf("Executing external command `%s` requires approval", rawCmdStr)
		}
		if riskLevel == "" {
			riskLevel = "medium"
		}
		return PolicyEvaluation{
			Verdict: VerdictAsk,
			Meta: ToolApprovalMeta{
				Capability:      "exec",
				Target:          rawCmdStr,
				Reason:          riskReason,
				Risk:            riskLevel,
				AccessMode:      accessMode,
				ProposedRule:    prop,
				CanAllowSession: ok,
				CanAllowAlways:  ok,
				CallGrants:      []PermissionRule{{Effect: "allow", Kind: "exec", Pattern: rawCmdStr}},
			},
		}, false
	}

	// 10. Even for safe commands (`cat`, `cp`, `sed`, `rg`, `go test`, etc.), check literal path arguments!
	if pathAsk := checkArgvPaths(bin, innerArgv, innerDyn, effectiveCwd, workspace, brainDir, accessMode, projectReadOnly, rules, commandWritesPaths(bin, innerArgv[1:])); pathAsk != nil {
		return stripIfWrapped(*pathAsk, false)
	}

	return PolicyEvaluation{
		Verdict: VerdictAllow,
		Meta: ToolApprovalMeta{
			CallGrants: []PermissionRule{{Effect: "allow", Kind: "exec", Pattern: rawCmdStr}},
		},
	}, false
}

func denyExec(target string, r PermissionRule) PolicyEvaluation {
	return PolicyEvaluation{
		Verdict: VerdictDeny,
		Meta: ToolApprovalMeta{
			Capability: "exec",
			Target:     target,
			Reason:     fmt.Sprintf("Command %q blocked by permission rule %q", target, r.Pattern),
		},
	}
}

func askNonPersistable(capKind, target, reason, risk, accessMode, callExec string) PolicyEvaluation {
	var grants []PermissionRule
	if callExec != "" {
		grants = []PermissionRule{{Effect: "allow", Kind: "exec", Pattern: callExec}}
	}
	return PolicyEvaluation{
		Verdict: VerdictAsk,
		Meta: ToolApprovalMeta{
			Capability:      capKind,
			Target:          target,
			Reason:          reason,
			Risk:            risk,
			AccessMode:      accessMode,
			ProposedRule:    nil,
			CanAllowSession: false,
			CanAllowAlways:  false,
			CallGrants:      grants,
		},
	}
}

func unwrapArgvWithDynamic(argv []string, dyn []bool) ([]string, []bool, bool) {
	usedNonPersist := false
	curA, curD := argv, dyn
	for len(curA) > 0 {
		for len(curA) > 0 && isEnvAssignToken(curA[0]) {
			curA = curA[1:]
			curD = innerDynOffset(curD, 1)
		}
		if len(curA) == 0 {
			break
		}
		bin := baseProgName(curA[0])
		switch bin {
		case "env":
			i := 1
			for i < len(curA) {
				a := curA[i]
				if a == "--" {
					i++
					break
				}
				if strings.HasPrefix(a, "-") {
					if (a == "-u" || a == "-C" || a == "-S") && i+1 < len(curA) {
						i += 2
					} else {
						i++
					}
					continue
				}
				if isEnvAssignToken(a) {
					i++
					continue
				}
				break
			}
			if i >= len(curA) {
				// bare `env` prints environment
				return curA, curD, false
			}
			usedNonPersist = true
			curA = curA[i:]
			curD = innerDynOffset(curD, i)
		case "command", "builtin":
			if len(curA) > 1 && (curA[1] == "-v" || curA[1] == "-V") {
				return curA, curD, false
			}
			i := 1
			for i < len(curA) && strings.HasPrefix(curA[i], "-") {
				i++
			}
			if i >= len(curA) {
				return curA, curD, false
			}
			usedNonPersist = true
			curA = curA[i:]
			curD = innerDynOffset(curD, i)
		case "nohup":
			if len(curA) <= 1 {
				return curA, curD, true
			}
			usedNonPersist = true
			curA = curA[1:]
			curD = innerDynOffset(curD, 1)
		case "nice":
			i := 1
			if i < len(curA) && strings.HasPrefix(curA[i], "-") {
				if curA[i] == "-n" && i+1 < len(curA) {
					i += 2
				} else {
					i++
				}
			}
			if i >= len(curA) {
				return curA, curD, false
			}
			curA = curA[i:]
			curD = innerDynOffset(curD, i)
		case "timeout":
			i := 1
			for i < len(curA) && strings.HasPrefix(curA[i], "-") {
				if (curA[i] == "-k" || curA[i] == "-s") && i+1 < len(curA) {
					i += 2
				} else {
					i++
				}
			}
			if i+1 >= len(curA) {
				return curA, curD, false
			}
			curA = curA[i+1:]
			curD = innerDynOffset(curD, i+1)
		default:
			return curA, curD, usedNonPersist
		}
	}
	return curA, curD, usedNonPersist
}

func innerDynOffset(dyn []bool, off int) []bool {
	if len(dyn) <= off {
		return nil
	}
	return dyn[off:]
}

func extractShellDashC(bin string, args []string, dyn []bool) (string, bool) {
	if !isShellInterpreterBinary(bin) {
		return "", false
	}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "-c" || a == "--sh-c" {
			if i+1 < len(args) && (len(dyn) <= i+1 || !dyn[i+1]) {
				return args[i+1], true
			}
			return "", false
		}
		if strings.HasPrefix(a, "-") && len(a) > 1 && !strings.HasPrefix(a, "--") && strings.HasSuffix(a, "c") {
			if i+1 < len(args) && (len(dyn) <= i+1 || !dyn[i+1]) {
				return args[i+1], true
			}
			return "", false
		}
		if !strings.HasPrefix(a, "-") {
			return "", false
		}
	}
	return "", false
}

func extractXargsSubcommand(args []string) []string {
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			return args[i+1:]
		}
		if strings.HasPrefix(a, "-") {
			switch a {
			case "-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a":
				i++
			}
			continue
		}
		return args[i:]
	}
	return []string{"echo"}
}

func isSafeXargsTarget(bin string) bool {
	switch bin {
	case "echo", "printf", "cat", "head", "tail", "wc", "ls", "stat", "file",
		"grep", "egrep", "fgrep", "rg", "jq", "sha256sum", "sha1sum", "md5sum", "shasum", "dirname", "basename":
		return true
	default:
		return false
	}
}

func evalRmCommand(
	bin string,
	argv []string,
	dyn []bool,
	cwd, workspace, brainDir, accessMode string,
	projectReadOnly bool,
	rules []PermissionRule,
) PolicyEvaluation {
	rawCmd := normalizeExecString(strings.Join(argv, " "))
	recursive := false
	var targets []string
	var targetDyn []bool
	pastDash := false
	for i := 1; i < len(argv); i++ {
		a := argv[i]
		isDyn := i < len(dyn) && dyn[i]
		if !pastDash && a == "--" {
			pastDash = true
			continue
		}
		if !pastDash && strings.HasPrefix(a, "-") && len(a) > 1 {
			if a == "--recursive" {
				recursive = true
			} else if !strings.HasPrefix(a, "--") {
				if strings.ContainsAny(a[1:], "rR") {
					recursive = true
				}
			}
			continue
		}
		targets = append(targets, a)
		targetDyn = append(targetDyn, isDyn)
	}

	// Check paths first (catches ProjectReadOnly hard block and outside-workspace paths).
	var grantRules []PermissionRule
	grantRules = append(grantRules, PermissionRule{Effect: "allow", Kind: "exec", Pattern: rawCmd})
	for i, t := range targets {
		if targetDyn[i] {
			return askNonPersistable("fs_write", rawCmd, "Deleting dynamically expanded paths requires approval", "high", accessMode, rawCmd)
		}
		resolved := resolvePath(cwd, expandHomePrefix(t))
		ev := evaluateFSCheck("fs_write", "", resolved, t, "auto", workspace, brainDir, projectReadOnly, rules)
		if ev.Verdict == VerdictDeny {
			return ev
		}
		grantRules = append(grantRules, PermissionRule{Effect: "allow", Kind: "fs_write", Pattern: filepath.ToSlash(resolved)})
		if ev.Verdict == VerdictAsk {
			res := askNonPersistable("fs_write", resolved, fmt.Sprintf("Deleting %q requires explicit approval", t), "high", accessMode, rawCmd)
			res.Meta.CallGrants = grantRules
			return res
		}
		if t == "." || t == "*" || t == "./*" || strings.HasSuffix(t, "/*") || samePathPlatform(resolved, workspace) {
			res := askNonPersistable("fs_write", rawCmd, fmt.Sprintf("Bulk deletion (`%s`) requires explicit approval", rawCmd), "high", accessMode, rawCmd)
			res.Meta.CallGrants = grantRules
			return res
		}
	}

	if recursive || bin == "shred" {
		res := askNonPersistable("fs_write", rawCmd, fmt.Sprintf("Recursive deletion (`%s`) requires explicit approval", rawCmd), "high", accessMode, rawCmd)
		res.Meta.CallGrants = grantRules
		return res
	}

	return PolicyEvaluation{
		Verdict: VerdictAllow,
		Meta:    ToolApprovalMeta{CallGrants: grantRules},
	}
}

func evalGitCommand(
	argv []string,
	dyn []bool,
	cwd, workspace, brainDir, accessMode string,
	projectReadOnly bool,
	rules []PermissionRule,
	explicitExecAllowed bool,
) (PolicyEvaluation, bool) {
	rawCmd := normalizeExecString(strings.Join(argv, " "))
	gitCwd := cwd
	// Inspect global git flags before subcommand (`git -C <dir> ...`, `git -c core.sshCommand=...`).
	subIdx := -1
	for i := 1; i < len(argv); i++ {
		a := argv[i]
		if a == "--" {
			break
		}
		if a == "-C" && i+1 < len(argv) {
			if i+1 < len(dyn) && dyn[i+1] {
				return askNonPersistable("exec", rawCmd, "`git -C` with dynamic directory requires approval", "medium", accessMode, rawCmd), false
			}
			gitCwd = resolvePath(cwd, expandHomePrefix(argv[i+1]))
			ev := evaluateFSCheck("fs_read", "", gitCwd, argv[i+1], "auto", workspace, brainDir, projectReadOnly, rules)
			if ev.Verdict != VerdictAllow {
				return ev, false
			}
			i++
			continue
		}
		if a == "-c" && i+1 < len(argv) {
			cfgKV := strings.ToLower(argv[i+1])
			if strings.Contains(cfgKV, "sshcommand") || strings.Contains(cfgKV, "fsmonitor") ||
				strings.Contains(cfgKV, "hookspath") || strings.Contains(cfgKV, "pager") ||
				strings.Contains(cfgKV, "credential") || strings.Contains(cfgKV, "proxy") ||
				strings.Contains(cfgKV, "alias.") || strings.Contains(cfgKV, "diff.external") {
				return askNonPersistable("exec", rawCmd, fmt.Sprintf("`git -c %s` overrides executable git hooks/helpers and requires approval", argv[i+1]), "high", accessMode, rawCmd), false
			}
			i++
			continue
		}
		if strings.HasPrefix(a, "--git-dir") || strings.HasPrefix(a, "--work-tree") {
			return askNonPersistable("exec", rawCmd, fmt.Sprintf("`git %s` targeting custom git directory requires approval", a), "medium", accessMode, rawCmd), false
		}
		if strings.HasPrefix(a, "-") {
			// `git --version` or `git --help`
			if a == "--version" || a == "-v" || a == "--help" || a == "-h" {
				return PolicyEvaluation{Verdict: VerdictAllow}, explicitExecAllowed
			}
			continue
		}
		subIdx = i
		break
	}
	if subIdx < 0 {
		return PolicyEvaluation{Verdict: VerdictAllow}, explicitExecAllowed
	}
	sub := strings.ToLower(argv[subIdx])
	subArgs := argv[subIdx+1:]

	// Destructive git operations ALWAYS ask unless explicitly allowed (and never persist!).
	switch sub {
	case "reset":
		for _, a := range subArgs {
			if a == "--hard" || a == "--merge" {
				return askNonPersistable("exec", rawCmd, fmt.Sprintf("Destructive git operation (`%s`) discards uncommitted work", rawCmd), "high", accessMode, rawCmd), false
			}
		}
	case "clean":
		for _, a := range subArgs {
			if strings.HasPrefix(a, "-") && !strings.Contains(a, "n") && a != "--dry-run" && strings.ContainsAny(a, "fdxX") {
				return askNonPersistable("exec", rawCmd, fmt.Sprintf("Destructive git clean (`%s`) deletes untracked files", rawCmd), "high", accessMode, rawCmd), false
			}
		}
	case "checkout":
		for _, a := range subArgs {
			if a == "--" || a == "." || a == "-f" || a == "--force" {
				return askNonPersistable("exec", rawCmd, fmt.Sprintf("Discarding working-tree changes (`%s`) requires approval", rawCmd), "high", accessMode, rawCmd), false
			}
		}
	case "restore":
		stagedOnly := false
		for _, a := range subArgs {
			if a == "--staged" || a == "-S" {
				stagedOnly = true
			}
			if a == "--worktree" || a == "-W" {
				stagedOnly = false
			}
		}
		if !stagedOnly {
			return askNonPersistable("exec", rawCmd, fmt.Sprintf("Discarding working-tree changes (`%s`) requires approval", rawCmd), "high", accessMode, rawCmd), false
		}
	case "branch":
		for _, a := range subArgs {
			if a == "-D" || strings.Contains(a, "D") && strings.HasPrefix(a, "-") && !strings.HasPrefix(a, "--") {
				return askNonPersistable("exec", rawCmd, fmt.Sprintf("Force-deleting a git branch (`%s`) requires approval", rawCmd), "high", accessMode, rawCmd), false
			}
		}
	}

	if explicitExecAllowed {
		return PolicyEvaluation{
			Verdict: VerdictAllow,
			Meta: ToolApprovalMeta{
				CallGrants: []PermissionRule{{Effect: "allow", Kind: "exec", Pattern: rawCmd}},
			},
		}, true
	}

	// Read-only git subcommands:
	isReadOnlyGit := false
	switch sub {
	case "status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree", "cat-file",
		"blame", "shortlog", "describe", "name-rev", "for-each-ref", "grep", "reflog", " merge-base", "merge-base":
		isReadOnlyGit = true
	case "branch":
		isReadOnlyGit = len(subArgs) == 0 || allFlagsIn(subArgs, "-a", "--all", "-r", "--remotes", "-l", "--list", "-v", "-vv", "--show-current", "--contains", "--merged", "--no-merged")
	case "tag":
		isReadOnlyGit = len(subArgs) == 0 || (len(subArgs) >= 1 && (subArgs[0] == "-l" || subArgs[0] == "--list"))
	case "remote":
		isReadOnlyGit = len(subArgs) == 0 || (len(subArgs) == 1 && subArgs[0] == "-v") || (len(subArgs) == 2 && subArgs[0] == "get-url")
	case "stash":
		isReadOnlyGit = len(subArgs) >= 1 && (subArgs[0] == "list" || subArgs[0] == "show")
	case "apply":
		for _, a := range subArgs {
			if a == "--check" {
				isReadOnlyGit = true
			}
		}
	case "config":
		for _, a := range subArgs {
			if a == "--get" || a == "--get-all" || a == "--list" || a == "-l" {
				isReadOnlyGit = true
			}
		}
	}
	if isReadOnlyGit {
		return PolicyEvaluation{
			Verdict: VerdictAllow,
			Meta: ToolApprovalMeta{
				CallGrants: []PermissionRule{{Effect: "allow", Kind: "exec", Pattern: rawCmd}},
			},
		}, false
	}

	// Workspace-local non-destructive git subcommands (allowed in auto when !projectReadOnly):
	if !projectReadOnly {
		switch sub {
		case "add", "commit", "mv", "rm":
			return PolicyEvaluation{
				Verdict: VerdictAllow,
				Meta: ToolApprovalMeta{
					CallGrants: []PermissionRule{{Effect: "allow", Kind: "exec", Pattern: rawCmd}},
				},
			}, false
		case "stash":
			if len(subArgs) == 0 || subArgs[0] == "push" || subArgs[0] == "save" || subArgs[0] == "apply" || subArgs[0] == "pop" {
				return PolicyEvaluation{
					Verdict: VerdictAllow,
					Meta: ToolApprovalMeta{
						CallGrants: []PermissionRule{{Effect: "allow", Kind: "exec", Pattern: rawCmd}},
					},
				}, false
			}
		case "switch":
			return PolicyEvaluation{
				Verdict: VerdictAllow,
				Meta: ToolApprovalMeta{
					CallGrants: []PermissionRule{{Effect: "allow", Kind: "exec", Pattern: rawCmd}},
				},
			}, false
		case "checkout":
			if len(subArgs) == 2 && (subArgs[0] == "-b" || subArgs[0] == "-B") {
				return PolicyEvaluation{
					Verdict: VerdictAllow,
					Meta: ToolApprovalMeta{
						CallGrants: []PermissionRule{{Effect: "allow", Kind: "exec", Pattern: rawCmd}},
					},
				}, false
			}
		}
	}

	// Remote / mutating git subcommands (`git push`, `git pull`, `git fetch`, `git rebase`, etc.) prompt!
	prop, ok := ProposeExecRule([]string{"git", sub})
	risk := "medium"
	reason := fmt.Sprintf("Git `%s` modifies repository state or communicates with remotes", sub)
	if sub == "push" {
		reason = fmt.Sprintf("Pushing commits to a remote repository (`%s`) requires approval", rawCmd)
	}
	return PolicyEvaluation{
		Verdict: VerdictAsk,
		Meta: ToolApprovalMeta{
			Capability:      "exec",
			Target:          rawCmd,
			Reason:          reason,
			Risk:            risk,
			AccessMode:      accessMode,
			ProposedRule:    prop,
			CanAllowSession: ok,
			CanAllowAlways:  ok,
			CallGrants:      []PermissionRule{{Effect: "allow", Kind: "exec", Pattern: rawCmd}},
		},
	}, false
}

func allFlagsIn(args []string, allowed ...string) bool {
	set := make(map[string]bool, len(allowed))
	for _, a := range allowed {
		set[a] = true
	}
	for _, a := range args {
		if !set[a] {
			return false
		}
	}
	return true
}

func evalCurlWgetCommand(
	bin string,
	argv []string,
	dyn []bool,
	cwd, workspace, brainDir, accessMode string,
	projectReadOnly bool,
	rules []PermissionRule,
	explicitExecAllowed bool,
) (PolicyEvaluation, bool) {
	rawCmd := normalizeExecString(strings.Join(argv, " "))
	var urls []string
	var outFiles []string
	for i := 1; i < len(argv); i++ {
		a := argv[i]
		if a == "--" {
			urls = append(urls, argv[i+1:]...)
			break
		}
		if (a == "-o" || a == "--output" || a == "-O" || a == "--output-document") && i+1 < len(argv) {
			if a != "-O" || bin == "wget" {
				outFiles = append(outFiles, argv[i+1])
				i++
			} else if projectReadOnly {
				return PolicyEvaluation{
					Verdict: VerdictDeny,
					Meta: ToolApprovalMeta{
						Capability: "fs_write",
						Target:     rawCmd,
						Reason:     "Read-only mode: downloading files into workspace is not allowed",
					},
				}, false
			}
			continue
		}
		if a == "--url" && i+1 < len(argv) {
			urls = append(urls, argv[i+1])
			i++
			continue
		}
		if strings.HasPrefix(a, "--url=") {
			urls = append(urls, strings.TrimPrefix(a, "--url="))
			continue
		}
		if (a == "--resolve" || a == "--connect-to") && i+1 < len(argv) {
			urls = append(urls, extractCurlOverrideTargets(a, argv[i+1])...)
			i++
			continue
		}
		if strings.HasPrefix(a, "--resolve=") {
			urls = append(urls, extractCurlOverrideTargets("--resolve", strings.TrimPrefix(a, "--resolve="))...)
			continue
		}
		if strings.HasPrefix(a, "--connect-to=") {
			urls = append(urls, extractCurlOverrideTargets("--connect-to", strings.TrimPrefix(a, "--connect-to="))...)
			continue
		}
		if isCurlWgetValueFlag(bin, a) && i+1 < len(argv) {
			i++
			continue
		}
		if strings.HasPrefix(a, "-") {
			continue
		}
		if looksLikeCurlWgetURLArg(a) {
			urls = append(urls, a)
		}
	}
	fsEvalMode := "auto"
	if accessMode == "full" {
		fsEvalMode = "full"
	}
	for _, out := range outFiles {
		if isNullTarget(out) || out == "-" {
			continue
		}
		resolved := resolvePath(cwd, expandHomePrefix(out))
		ev := evaluateFSCheck("fs_write", "", resolved, out, fsEvalMode, workspace, brainDir, projectReadOnly, rules)
		if ev.Verdict != VerdictAllow {
			return ev, false
		}
	}

	if len(urls) == 0 {
		if accessMode == "full" || explicitExecAllowed {
			return PolicyEvaluation{Verdict: VerdictAllow}, true
		}
		prop, ok := ProposeExecRule(argv)
		return PolicyEvaluation{
			Verdict: VerdictAsk,
			Meta: ToolApprovalMeta{
				Capability:      "net",
				Target:          rawCmd,
				Reason:          fmt.Sprintf("Outbound network command `%s` requires approval", rawCmd),
				Risk:            "medium",
				AccessMode:      accessMode,
				ProposedRule:    prop,
				CanAllowSession: ok,
				CanAllowAlways:  ok,
				CallGrants:      []PermissionRule{{Effect: "allow", Kind: "exec", Pattern: rawCmd}},
			},
		}, false
	}

	var callGrants []PermissionRule
	callGrants = append(callGrants, PermissionRule{Effect: "allow", Kind: "exec", Pattern: rawCmd})
	allExplicit := explicitExecAllowed
	for _, rawU := range urls {
		candidate := strings.TrimSpace(rawU)
		if candidate == "" {
			continue
		}
		if !strings.Contains(candidate, "://") {
			candidate = "http://" + candidate
		}
		u, err := url.Parse(candidate)
		if err != nil || u.Hostname() == "" {
			allExplicit = false
			continue
		}
		rawHost := u.Hostname()
		host := normalizeHostForSSRF(rawHost)

		// 1. Cloud metadata endpoints are ALWAYS hard-blocked in every mode (including "full" and explicitExecAllowed).
		if isCloudMetadataHost(rawHost) {
			return PolicyEvaluation{
				Verdict: VerdictDeny,
				Meta: ToolApprovalMeta{
					Capability: "net",
					Target:     nonEmpty(u.Host, rawHost),
					Reason:     fmt.Sprintf("Cloud metadata endpoint %q is blocked", rawHost),
				},
			}, false
		}

		// 2. Explicit Deny rules always win.
		if eff, r := MatchRules(rules, "net", strings.ToLower(u.Host), workspace); eff == "deny" {
			return PolicyEvaluation{
				Verdict: VerdictDeny,
				Meta: ToolApprovalMeta{
					Capability: "net",
					Target:     u.Host,
					Reason:     fmt.Sprintf("Network access to %q blocked by rule %q", u.Host, r.Pattern),
				},
			}, false
		}

		// 3. In jailed modes ("auto" and "ask"), hard-deny *.localhost subdomains,
		// non-canonical IP encodings (127.1, integer/hex/octal IPs), and non-loopback
		// private/reserved IPs — matching fetch_url & QuickJS fetch SSRF parity.
		if accessMode != "full" {
			if strings.HasSuffix(host, ".localhost") {
				return PolicyEvaluation{
					Verdict: VerdictDeny,
					Meta: ToolApprovalMeta{
						Capability: "net",
						Target:     nonEmpty(u.Host, rawHost),
						Reason:     fmt.Sprintf("Subdomain %q under .localhost is blocked against SSRF", rawHost),
					},
				}, false
			}
			if addr, nonCanonical, ok := parseNormalizedAddrWithKind(rawHost); ok {
				if nonCanonical {
					return PolicyEvaluation{
						Verdict: VerdictDeny,
						Meta: ToolApprovalMeta{
							Capability: "net",
							Target:     nonEmpty(u.Host, rawHost),
							Reason:     fmt.Sprintf("Non-canonical IP address encoding %q is blocked", rawHost),
						},
					}, false
				}
				if !addr.IsLoopback() && isPrivateOrReservedAddr(addr) {
					return PolicyEvaluation{
						Verdict: VerdictDeny,
						Meta: ToolApprovalMeta{
							Capability: "net",
							Target:     nonEmpty(u.Host, rawHost),
							Reason:     fmt.Sprintf("Private or reserved IP address %q is blocked", rawHost),
						},
					}, false
				}
			}
		}

		// 4. Explicit Allow rules on net.
		if eff, _ := MatchRules(rules, "net", strings.ToLower(u.Host), workspace); eff == "allow" {
			callGrants = append(callGrants, PermissionRule{Effect: "allow", Kind: "net", Pattern: host})
			continue
		}

		if accessMode == "full" {
			continue
		}
		if isLoopbackHost(rawHost) && accessMode == "auto" {
			continue
		}
		if explicitExecAllowed {
			callGrants = append(callGrants, PermissionRule{Effect: "allow", Kind: "net", Pattern: host})
			continue
		}
		prop, ok := ProposeNetRule(rawHost)
		callGrants = append(callGrants, PermissionRule{Effect: "allow", Kind: "net", Pattern: host})
		return PolicyEvaluation{
			Verdict: VerdictAsk,
			Meta: ToolApprovalMeta{
				Capability:      "net",
				Target:          host,
				Reason:          fmt.Sprintf("Outbound network request to `%s` via `%s` requires approval", host, bin),
				Risk:            "medium",
				AccessMode:      accessMode,
				ProposedRule:    prop,
				CanAllowSession: ok,
				CanAllowAlways:  ok,
				CallGrants:      callGrants,
			},
		}, false
	}
	return PolicyEvaluation{
		Verdict: VerdictAllow,
		Meta:    ToolApprovalMeta{CallGrants: callGrants},
	}, allExplicit
}

func isCurlWgetValueFlag(bin, flag string) bool {
	switch flag {
	case "-X", "--request", "-H", "--header", "-d", "--data", "--data-raw",
		"--data-binary", "--data-urlencode", "-F", "--form", "-u", "--user",
		"-A", "--user-agent", "-e", "--referer", "-m", "--max-time",
		"--connect-timeout", "--retry", "-b", "--cookie", "-c", "--cookie-jar",
		"-x", "--proxy", "--resolve", "--connect-to", "-w", "--write-out":
		return true
	}
	if bin == "wget" {
		switch flag {
		case "-t", "--tries", "-T", "--timeout", "-U", "-P", "--directory-prefix",
			"--post-data", "--post-file", "--method", "--body-data":
			return true
		}
	}
	return false
}

func looksLikeCurlWgetURLArg(a string) bool {
	s := strings.TrimSpace(a)
	if s == "" || strings.HasPrefix(s, "/") {
		return false
	}
	if strings.Contains(s, "://") || strings.Contains(s, ".") || strings.Contains(s, ":") {
		return true
	}
	hostPart := s
	if slash := strings.IndexByte(hostPart, '/'); slash >= 0 {
		hostPart = hostPart[:slash]
	}
	if strings.EqualFold(hostPart, "localhost") || strings.EqualFold(hostPart, "metadata") || strings.EqualFold(hostPart, "instance-data") {
		return true
	}
	_, ok := parseInetAtonIPv4(hostPart)
	return ok
}

func extractCurlOverrideTargets(flag, val string) []string {
	v := strings.TrimSpace(strings.TrimPrefix(val, "+"))
	if v == "" {
		return nil
	}
	var out []string
	if flag == "--resolve" {
		// Format: [+]host:port:addr[,addr]...
		first := strings.IndexByte(v, ':')
		if first >= 0 {
			rest := v[first+1:]
			second := strings.IndexByte(rest, ':')
			if second >= 0 {
				addrs := rest[second+1:]
				for _, addr := range strings.Split(addrs, ",") {
					addr = strings.TrimSpace(addr)
					if addr != "" {
						if strings.Contains(addr, ":") && !strings.HasPrefix(addr, "[") {
							addr = "[" + addr + "]"
						}
						out = append(out, "http://"+addr)
					}
				}
			}
		}
	} else if flag == "--connect-to" {
		// Format: HOST1:PORT1:HOST2:PORT2 (where HOST/PORT may be bracketed IPv6 or empty)
		// Inspect the trailing connect target if non-empty.
		parts := strings.Split(v, ":")
		if len(parts) >= 4 {
			host2 := strings.TrimSpace(parts[len(parts)-2])
			port2 := strings.TrimSpace(parts[len(parts)-1])
			if host2 != "" {
				if port2 != "" {
					out = append(out, "http://"+host2+":"+port2)
				} else {
					out = append(out, "http://"+host2)
				}
			}
		}
	}
	return out
}

func allKillTargetsAreShellJobs(args []string) bool {
	sawJob := false
	for _, a := range args {
		if a == "-l" {
			return true
		}
		if strings.HasPrefix(a, "-") {
			continue
		}
		if strings.HasPrefix(a, "%") {
			sawJob = true
			continue
		}
		return false
	}
	return sawJob
}

func isStandardSystemBinaryPath(p string) bool {
	sl := strings.ToLower(filepath.ToSlash(p))
	for _, prefix := range []string{"/bin/", "/usr/bin/", "/usr/local/bin/", "/sbin/", "/usr/sbin/", "/opt/homebrew/bin/", "c:/windows/"} {
		if strings.HasPrefix(sl, prefix) {
			return true
		}
	}
	return false
}

func checkReadOnlyArgvViolation(bin string, argv []string, dyn []bool, cwd, workspace, brainDir string) string {
	switch bin {
	case "mkdir", "touch", "mv", "ln", "truncate", "install", "patch":
		// Allowed ONLY if every destination target is explicitly inside brainDir!
		paths := nonFlagArgs(argv[1:])
		if len(paths) == 0 {
			return fmt.Sprintf("Read-only mode: `%s` is not allowed in workspace", bin)
		}
		for _, p := range paths {
			resolved := resolvePath(cwd, expandHomePrefix(p))
			if brainDir == "" || !isAllowedInRoots(resolved, brainDir) {
				return fmt.Sprintf("Read-only mode: `%s` cannot modify workspace path %q", bin, p)
			}
		}
	case "cp":
		paths := nonFlagArgs(argv[1:])
		if len(paths) >= 2 {
			dst := resolvePath(cwd, expandHomePrefix(paths[len(paths)-1]))
			if brainDir == "" || !isAllowedInRoots(dst, brainDir) {
				return fmt.Sprintf("Read-only mode: `cp` cannot write to workspace path %q", paths[len(paths)-1])
			}
		}
	case "tee":
		for _, p := range nonFlagArgs(argv[1:]) {
			if isNullTarget(p) {
				continue
			}
			resolved := resolvePath(cwd, expandHomePrefix(p))
			if brainDir == "" || !isAllowedInRoots(resolved, brainDir) {
				return fmt.Sprintf("Read-only mode: `tee` cannot write to workspace path %q", p)
			}
		}
	case "sed":
		for _, a := range argv[1:] {
			if a == "-i" || strings.HasPrefix(a, "-i") || a == "--in-place" || strings.HasPrefix(a, "--in-place=") {
				return "Read-only mode: `sed -i` in-place file editing is not allowed"
			}
		}
	case "gofmt":
		for _, a := range argv[1:] {
			if a == "-w" {
				return "Read-only mode: `gofmt -w` is not allowed"
			}
		}
	case "go":
		sub, _ := extractCLISubcommand("go", argv[1:])
		switch sub {
		case "fmt", "generate", "get", "install":
			return fmt.Sprintf("Read-only mode: `go %s` modifies workspace files", sub)
		case "mod":
			if len(argv) >= 3 && (argv[2] == "tidy" || argv[2] == "init" || argv[2] == "edit" || argv[2] == "vendor") {
				return fmt.Sprintf("Read-only mode: `go mod %s` modifies workspace files", argv[2])
			}
		}
	case "npm", "pnpm", "yarn", "bun":
		sub, _ := extractCLISubcommand(bin, argv[1:])
		switch sub {
		case "install", "i", "add", "remove", "uninstall", "update", "up", "init", "create", "link", "publish":
			return fmt.Sprintf("Read-only mode: `%s %s` modifies files", bin, sub)
		}
	}
	return ""
}

func nonFlagArgs(args []string) []string {
	var out []string
	pastDash := false
	for _, a := range args {
		if !pastDash && a == "--" {
			pastDash = true
			continue
		}
		if !pastDash && strings.HasPrefix(a, "-") && len(a) > 1 {
			continue
		}
		out = append(out, a)
	}
	return out
}

func isSafeAutoCommand(bin string, args []string) (bool, string, string) {
	switch bin {
	case "true", "false", ":", "[", "[[", "test",
		"echo", "printf", "pwd", "ls", "dir",
		"cat", "head", "tail", "wc", "nl", "od", "xxd", "hexdump",
		"stat", "file", "realpath", "readlink", "dirname", "basename",
		"which", "type", "uname", "whoami", "id", "hostname", "arch", "nproc",
		"date", "sleep", "seq", "yes",
		"tr", "cut", "paste", "sort", "uniq", "comm", "diff", "cmp",
		"grep", "egrep", "fgrep", "rg", "jq", "yq",
		"sha256sum", "sha1sum", "md5sum", "shasum", "b2sum", "base64",
		"gzip", "gunzip", "zcat", "mktemp", "tee",
		"mkdir", "touch", "cp", "mv", "ln", "chmod",
		"export", "unset", "local", "declare", "typeset", "readonly",
		"shift", "return", "exit", "wait", "jobs", "fg", "bg", "trap",
		"read", "mapfile", "readarray", "getopts", "hash", "times", "printenv", "env", "xargs":
		return true, "", ""

	case "command", "builtin":
		return true, "", ""

	case "sed":
		return true, "", ""

	case "awk", "gawk", "mawk":
		for _, a := range args {
			if strings.Contains(a, "system(") {
				return false, "`awk` program invoking `system()` requires approval", "high"
			}
		}
		return true, "", ""

	case "find":
		for _, a := range args {
			switch a {
			case "-exec", "-execdir", "-ok", "-okdir", "-delete":
				return false, fmt.Sprintf("`find %s` executes commands or deletes files and requires approval", a), "high"
			}
			if strings.HasPrefix(a, "-fprint") || a == "-fls" {
				return false, fmt.Sprintf("`find %s` writes arbitrary files and requires approval", a), "medium"
			}
		}
		return true, "", ""

	case "tar":
		for _, a := range args {
			if a == "-P" || a == "--absolute-names" {
				return false, "`tar --absolute-names` can overwrite outside paths and requires approval", "high"
			}
		}
		return true, "", ""

	case "go":
		sub, rest := extractCLISubcommand("go", args)
		switch sub {
		case "", "version", "env", "list", "vet", "build", "test", "doc", "fmt", "tool":
			// `go build -o ../outside` is caught by checkArgvPaths below.
			return true, "", ""
		case "mod":
			if len(rest) > 0 {
				switch rest[0] {
				case "tidy", "download", "verify", "graph", "why":
					return true, "", ""
				}
			}
		}
		return false, fmt.Sprintf("`go %s` requires approval", sub), "medium"

	case "gofmt", "golangci-lint", "staticcheck", "tsc", "eslint", "biome", "vitest", "jest", "pytest":
		return true, "", ""

	case "prettier":
		return true, "", ""

	case "bun":
		if hasAnyFlag(args, "-e", "--eval", "-p", "--print") {
			return false, "Inline `bun -e` execution requires approval (use `exec_script` instead)", "medium"
		}
		for _, a := range args {
			if a == "-g" || a == "--global" {
				return false, "Global package installation (`bun -g`) requires approval", "medium"
			}
		}
		sub, _ := extractCLISubcommand("bun", args)
		switch sub {
		case "", "test", "run", "pm", "x":
			if len(args) == 0 {
				return false, "", "medium"
			}
			return true, "", ""
		}
		if hasAnyFlag(args, "--version", "-v") {
			return true, "", ""
		}
		return false, fmt.Sprintf("`bun %s` requires approval", sub), "medium"

	case "npm", "pnpm", "yarn":
		for _, a := range args {
			if a == "-g" || a == "--global" {
				return false, fmt.Sprintf("Global package installation (`%s -g`) requires approval", bin), "medium"
			}
		}
		sub, _ := extractCLISubcommand(bin, args)
		switch sub {
		case "test", "t", "tst", "run", "run-script", "list", "ls", "why", "outdated", "pack":
			return true, "", ""
		case "publish":
			return false, fmt.Sprintf("Publishing package (`%s publish`) requires approval", bin), "high"
		}
		if hasAnyFlag(args, "--version", "-v") {
			return true, "", ""
		}
		return false, fmt.Sprintf("`%s %s` requires approval", bin, sub), "medium"

	case "node":
		if hasAnyFlag(args, "--version", "-v") {
			return true, "", ""
		}
		if hasAnyFlag(args, "--check", "-c") && !hasAnyFlag(args, "-e", "--eval", "-p", "--print") {
			return true, "", ""
		}
		return false, "`node` execution requires approval (use `exec_script` for jailed JS)", "medium"

	case "python", "python3":
		if hasAnyFlag(args, "--version", "-V") {
			return true, "", ""
		}
		if len(args) >= 2 && args[0] == "-m" && (args[1] == "pytest" || args[1] == "unittest" || args[1] == "py_compile" || args[1] == "json.tool") {
			return true, "", ""
		}
		return false, fmt.Sprintf("`%s` execution requires approval", bin), "medium"

	case "cargo":
		sub, _ := extractCLISubcommand("cargo", args)
		switch sub {
		case "check", "test", "build", "clippy", "fmt", "metadata", "tree", "version":
			return true, "", ""
		case "publish":
			return false, "`cargo publish` requires approval", "high"
		}
		if hasAnyFlag(args, "--version", "-V") {
			return true, "", ""
		}
		return false, fmt.Sprintf("`cargo %s` requires approval", sub), "medium"

	case "rustc", "zig":
		if hasAnyFlag(args, "--version", "-V", "version") {
			return true, "", ""
		}
		return false, fmt.Sprintf("`%s` execution requires approval", bin), "medium"
	}

	return false, "", "medium"
}

func hasAnyFlag(args []string, flags ...string) bool {
	set := make(map[string]bool, len(flags))
	for _, f := range flags {
		set[f] = true
	}
	for _, a := range args {
		if set[a] {
			return true
		}
	}
	return false
}

func commandWritesPaths(bin string, args []string) bool {
	switch bin {
	case "mkdir", "touch", "cp", "mv", "ln", "chmod", "tee", "gofmt":
		return true
	case "sed":
		for _, a := range args {
			if a == "-i" || strings.HasPrefix(a, "-i") || a == "--in-place" || strings.HasPrefix(a, "--in-place=") {
				return true
			}
		}
	}
	return false
}

func checkArgvPaths(
	bin string,
	argv []string,
	dyn []bool,
	cwd, workspace, brainDir, accessMode string,
	projectReadOnly bool,
	rules []PermissionRule,
	writes bool,
) *PolicyEvaluation {
	// Commands whose non-flag arguments are patterns/expressions rather than solely paths:
	// skip non-path positional arg0 (e.g. `grep PATTERN FILE`, `sed SCRIPT FILE`, `jq FILTER FILE`).
	args := argv[1:]
	argDyn := innerDynOffset(dyn, 1)
	skipFirstNonFlag := false
	switch bin {
	case "grep", "egrep", "fgrep", "rg", "jq", "yq", "awk", "gawk", "mawk", "sed":
		if !hasExplicitPatternFlag(bin, args) {
			skipFirstNonFlag = true
		}
	case "echo", "printf", "export", "unset", "local", "declare", "typeset", "readonly",
		"sleep", "seq", "yes", "tr", "date", "uname", "whoami", "id", "wait", "jobs", "return", "exit":
		return nil
	case "go", "bun", "npm", "pnpm", "yarn", "cargo":
		// Only inspect explicit path-looking arguments (starting with `/`, `~`, `..`, `./`, `.\`, or `-o <path>` / `-C <path>`).
		return checkExplicitPathArgsOnly(argv, dyn, cwd, workspace, brainDir, accessMode, projectReadOnly, rules)
	}

	nonFlagSeen := 0
	pastDash := false
	for i := 0; i < len(args); i++ {
		a := args[i]
		isDyn := i < len(argDyn) && argDyn[i]
		if !pastDash && a == "--" {
			pastDash = true
			continue
		}
		if !pastDash && strings.HasPrefix(a, "-") && len(a) > 1 {
			// Skip flag value for flags taking non-path arguments (`-e PATTERN`, `-n 10`, `-d :`, etc.)
			if flagTakesNonPathValue(bin, a) {
				i++
			}
			continue
		}
		nonFlagSeen++
		if skipFirstNonFlag && nonFlagSeen == 1 {
			continue
		}
		if isDyn || a == "" || a == "-" || isNullTarget(a) {
			continue
		}
		// For `cp src dst` or `mv src dst`, earlier args are read, last arg is write!
		capKind := "fs_read"
		if writes {
			if (bin == "cp" || bin == "mv" || bin == "ln") && i < len(args)-1 {
				capKind = "fs_read"
			} else {
				capKind = "fs_write"
			}
		}
		resolved := resolvePath(cwd, expandHomePrefix(a))
		ev := evaluateFSCheck(capKind, "", resolved, a, "auto", workspace, brainDir, projectReadOnly, rules)
		if ev.Verdict != VerdictAllow {
			ev.Meta.AccessMode = accessMode
			return &ev
		}
	}
	return nil
}

func checkExplicitPathArgsOnly(
	argv []string,
	dyn []bool,
	cwd, workspace, brainDir, accessMode string,
	projectReadOnly bool,
	rules []PermissionRule,
) *PolicyEvaluation {
	for i := 1; i < len(argv); i++ {
		a := argv[i]
		isDyn := i < len(dyn) && dyn[i]
		if isDyn {
			continue
		}
		if (a == "-o" || a == "-C" || a == "--cwd" || a == "--prefix") && i+1 < len(argv) {
			capKind := "fs_read"
			if a == "-o" {
				capKind = "fs_write"
			}
			target := argv[i+1]
			if !isNullTarget(target) {
				resolved := resolvePath(cwd, expandHomePrefix(target))
				ev := evaluateFSCheck(capKind, "", resolved, target, "auto", workspace, brainDir, projectReadOnly, rules)
				if ev.Verdict != VerdictAllow {
					ev.Meta.AccessMode = accessMode
					return &ev
				}
			}
			i++
			continue
		}
		if looksLikeExplicitPathToken(a) && !isNullTarget(a) {
			// Skip Go package patterns like `./...` inside workspace (resolvePath handles `.` cleanly when stripped).
			cleanTok := strings.TrimSuffix(strings.TrimSuffix(a, "/..."), `\...`)
			if cleanTok == "" {
				cleanTok = "."
			}
			resolved := resolvePath(cwd, expandHomePrefix(cleanTok))
			ev := evaluateFSCheck("fs_read", "", resolved, a, "auto", workspace, brainDir, projectReadOnly, rules)
			if ev.Verdict != VerdictAllow {
				ev.Meta.AccessMode = accessMode
				return &ev
			}
		}
	}
	return nil
}

func looksLikeExplicitPathToken(a string) bool {
	if strings.HasPrefix(a, "-") || strings.Contains(a, "://") {
		return false
	}
	if a == ".." || strings.HasPrefix(a, "../") || strings.HasPrefix(a, `..\`) ||
		strings.HasPrefix(a, "/") || strings.HasPrefix(a, "~/") || strings.HasPrefix(a, `~\`) || a == "~" {
		return true
	}
	if len(a) >= 3 && ((a[0] >= 'a' && a[0] <= 'z') || (a[0] >= 'A' && a[0] <= 'Z')) && a[1] == ':' && (a[2] == '\\' || a[2] == '/') {
		return true
	}
	return false
}

func hasExplicitPatternFlag(bin string, args []string) bool {
	for _, a := range args {
		if a == "-e" || a == "-f" || strings.HasPrefix(a, "--regexp=") || strings.HasPrefix(a, "--file=") {
			return true
		}
	}
	return false
}

func flagTakesNonPathValue(bin, flag string) bool {
	switch flag {
	case "-e", "-m", "-A", "-B", "-C", "-n", "-c", "-d", "-f", "-k", "-t", "-g", "--glob", "--iglob", "-T", "--type", "--type-not":
		return bin != "tar"
	}
	return false
}
