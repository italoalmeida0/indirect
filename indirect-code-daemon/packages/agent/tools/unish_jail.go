package tools

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"

	"github.com/italoalmeida0/unish/pkg/unish"
	"indirect/indirect-code-daemon/packages/qjs"
	"indirect/indirect-code-daemon/packages/unishcli"
)

// RuntimeJailSpec describes the complete sandbox, policy rules, and control-port
// isolation configuration for one bash or exec_script execution.
type RuntimeJailSpec struct {
	Workspace       string           `json:"workspace"`
	BrainDir        string           `json:"brainDir,omitempty"`
	TmpDir          string           `json:"tmpDir,omitempty"`
	ExtraRoots      []string         `json:"extraRoots,omitempty"`
	ReadOnlyRoots   []string         `json:"readOnlyRoots,omitempty"`
	FSReadScopes    []string         `json:"fsReadScopes,omitempty"`
	FSWriteScopes   []string         `json:"fsWriteScopes,omitempty"`
	NetAllow        []string         `json:"netAllow,omitempty"`
	ProjectReadOnly bool             `json:"projectReadOnly,omitempty"`
	AccessMode      string           `json:"accessMode"` // "ask" | "auto" | "full"
	Rules           []PermissionRule `json:"rules,omitempty"`
	CallGrants      []PermissionRule `json:"callGrants,omitempty"`
	ControlPort     int              `json:"controlPort,omitempty"`
}

// MidExecApprovalReq carries a mid-execution capability prompt from a running
// unish or exec_script invocation up to the daemon session actor.
type MidExecApprovalReq struct {
	Capability      string          `json:"capability"` // "exec" | "fs_read" | "fs_write" | "net"
	Target          string          `json:"target"`
	Reason          string          `json:"reason,omitempty"`
	Risk            string          `json:"risk,omitempty"`       // "low" | "medium" | "high"
	AccessMode      string          `json:"accessMode,omitempty"` // "ask" | "auto"
	ProposedRule    *PermissionRule `json:"proposedRule,omitempty"`
	CanAllowSession bool            `json:"canAllowSession"`
	CanAllowAlways  bool            `json:"canAllowAlways"`
}

// MidExecApprovalResp returns the user's approval decision back to the blocked
// runtime capability hook.
type MidExecApprovalResp struct {
	Decision    string          `json:"decision"` // "once" | "session" | "always" | "deny"
	GrantedRule *PermissionRule `json:"grantedRule,omitempty"`
}

// MidExecApprover blocks until the user responds to req or ctx is cancelled.
type MidExecApprover func(ctx context.Context, req MidExecApprovalReq) (MidExecApprovalResp, error)

// PolicyRuntime wraps a live *unish.Jail and PolicyCapabilityHook shared by
// in-process unish sessions and QuickJS exec_script runtimes.
type PolicyRuntime struct {
	spec          RuntimeJailSpec
	jail          *unish.Jail
	hook          *PolicyCapabilityHook
	approver      MidExecApprover
	apprMu        sync.Mutex
	rulesMu       sync.RWMutex
	liveRules     []PermissionRule
	onceGrants    map[string]bool
	writableRoots []string
	readableRoots []string
}

// PolicyCapabilityHook implements unish.CapabilityHook with full argv-aware
// OpExec inspection, PermissionRule matching (Deny > Allow), protected workspace
// subpaths, and serialized interactive mid-execution approvals.
type PolicyCapabilityHook struct {
	rt *PolicyRuntime
}

// NewPolicyRuntime constructs a live PolicyRuntime from spec, env, and approver.
func NewPolicyRuntime(spec RuntimeJailSpec, env []string, approver MidExecApprover) (*PolicyRuntime, error) {
	mode := strings.ToLower(strings.TrimSpace(spec.AccessMode))
	switch mode {
	case "ask", "auto", "full":
	default:
		mode = "auto"
	}
	spec.AccessMode = mode

	if spec.Workspace != "" {
		if abs, err := filepath.Abs(spec.Workspace); err == nil {
			spec.Workspace = abs
		}
	}
	if spec.BrainDir != "" {
		if abs, err := filepath.Abs(spec.BrainDir); err == nil {
			spec.BrainDir = abs
		}
	}
	if spec.TmpDir == "" && spec.BrainDir != "" {
		spec.TmpDir = filepath.Join(spec.BrainDir, "tmp")
	}
	if spec.TmpDir != "" {
		if abs, err := filepath.Abs(spec.TmpDir); err == nil {
			spec.TmpDir = abs
		}
		_ = os.MkdirAll(spec.TmpDir, 0o755)
	}

	combinedRules := make([]PermissionRule, 0, len(spec.Rules)+len(spec.CallGrants))
	combinedRules = append(combinedRules, spec.Rules...)
	combinedRules = append(combinedRules, spec.CallGrants...)

	rt := &PolicyRuntime{
		spec:       spec,
		approver:   approver,
		liveRules:  combinedRules,
		onceGrants: make(map[string]bool),
	}

	var roots []string
	var roRoots []string
	var writableRoots []string

	addUnique := func(dst *[]string, p string) {
		p = strings.Trim(strings.TrimSpace(p), `"`)
		if runtime.GOOS == "windows" && strings.HasPrefix(p, `\\?\`) && !strings.HasPrefix(strings.ToUpper(p), `\\?\UNC\`) {
			p = p[4:]
		}
		if p == "" {
			return
		}
		if abs, err := filepath.Abs(p); err == nil {
			p = abs
		}
		for _, cur := range *dst {
			if sameCleanOSPath(cur, p) {
				return
			}
		}
		*dst = append(*dst, p)
	}

	addRootAndCanon := func(dst *[]string, p string, skipBroad bool) {
		if strings.TrimSpace(p) == "" {
			return
		}
		addUnique(dst, p)
		if c, err := canonicalOrParent(p); err == nil && c != "" {
			if !skipBroad || !isBroadSystemDir(c) {
				addUnique(dst, c)
			}
		}
	}

	if spec.ProjectReadOnly {
		addRootAndCanon(&roRoots, spec.Workspace, false)
	} else {
		addRootAndCanon(&roots, spec.Workspace, false)
		addRootAndCanon(&writableRoots, spec.Workspace, false)
	}
	for _, er := range spec.ExtraRoots {
		addRootAndCanon(&roots, er, false)
		addRootAndCanon(&writableRoots, er, false)
	}
	if spec.BrainDir != "" {
		addRootAndCanon(&roots, spec.BrainDir, false)
		addRootAndCanon(&writableRoots, spec.BrainDir, false)
	}
	if spec.TmpDir != "" {
		addRootAndCanon(&roots, spec.TmpDir, false)
		addRootAndCanon(&writableRoots, spec.TmpDir, false)
	}
	for _, ror := range spec.ReadOnlyRoots {
		addRootAndCanon(&roRoots, ror, false)
	}

	jailed := mode != "full"
	if jailed {
		homeDir, _ := os.UserHomeDir()
		excludes := []string{spec.Workspace, homeDir, os.TempDir()}
		for _, sysRoot := range unishcli.SystemReadOnlyRoots(env, excludes...) {
			addCandidate := func(cand string, skipBroad bool) {
				if cand == "" || (skipBroad && isBroadSystemDir(cand)) {
					return
				}
				for _, wr := range writableRoots {
					if isUnderCleanOSPath(wr, cand) {
						return
					}
				}
				addUnique(&roRoots, cand)
			}
			addCandidate(sysRoot, false)
			if c, err := canonicalOrParent(sysRoot); err == nil && c != "" {
				addCandidate(c, true)
			}
		}
	}
	rt.writableRoots = writableRoots
	readable := make([]string, 0, len(roots)+len(roRoots))
	readable = append(readable, roots...)
	readable = append(readable, roRoots...)
	rt.readableRoots = readable

	var pathRules []unish.PathRule
	if jailed && spec.Workspace != "" {
		ws := filepath.ToSlash(spec.Workspace)
		writeOps := []unish.AccessOp{unish.OpWrite, unish.OpDelete, unish.OpLink}
		// Omit OpStat from workspace-internal protected path rules so `ls -la` or
		// `[ -f .env ]` in the workspace root never triggers spurious stat prompts;
		// content reads (OpRead), directory listings/chdir (OpList, OpChdir), and all
		// mutations (OpWrite, OpDelete, OpLink) still require approval.
		contentFSOps := []unish.AccessOp{unish.OpRead, unish.OpWrite, unish.OpDelete, unish.OpList, unish.OpChdir, unish.OpLink}
		pathRules = append(pathRules,
			unish.PathRule{
				Pattern:  ws + "/.git/hooks/**",
				Ops:      contentFSOps,
				Decision: unish.DecisionAsk,
				Reason:   "Git repository hooks (.git/hooks) can execute arbitrary commands on git operations",
			},
			unish.PathRule{
				Pattern:  ws + "/.git/hooks",
				Ops:      contentFSOps,
				Decision: unish.DecisionAsk,
				Reason:   "Git repository hooks (.git/hooks) can execute arbitrary commands on git operations",
			},
			unish.PathRule{
				Pattern:  ws + "/.git/config",
				Ops:      contentFSOps,
				Decision: unish.DecisionAsk,
				Reason:   "Git repository configuration (.git/config) controls remotes, credentials, and hooks",
			},
			unish.PathRule{
				Pattern:  ws + "/.indirect/**",
				Ops:      contentFSOps,
				Decision: unish.DecisionAsk,
				Reason:   "Accessing .indirect configuration requires approval",
			},
			unish.PathRule{
				Pattern:  ws + "/.indirect",
				Ops:      contentFSOps,
				Decision: unish.DecisionAsk,
				Reason:   "Accessing .indirect configuration requires approval",
			},
			unish.PathRule{
				Pattern:  ws + "/.vscode/tasks.json",
				Ops:      writeOps,
				Decision: unish.DecisionAsk,
				Reason:   "Modifying IDE workspace execution settings (.vscode/tasks.json) requires approval",
			},
			unish.PathRule{
				Pattern:  ws + "/.vscode/launch.json",
				Ops:      writeOps,
				Decision: unish.DecisionAsk,
				Reason:   "Modifying IDE workspace execution settings (.vscode/launch.json) requires approval",
			},
			unish.PathRule{
				Pattern:  ws + "/.vscode/settings.json",
				Ops:      writeOps,
				Decision: unish.DecisionAsk,
				Reason:   "Modifying IDE workspace execution settings (.vscode/settings.json) requires approval",
			},
			unish.PathRule{
				Pattern:  ws + "/.env",
				Ops:      contentFSOps,
				Decision: unish.DecisionAsk,
				Reason:   "Accessing environment secret file \".env\" requires approval",
			},
			unish.PathRule{
				Pattern:  ws + "/.env.*",
				Ops:      contentFSOps,
				Decision: unish.DecisionAsk,
				Reason:   "Accessing environment secret file requires approval",
			},
		)
	}

	var netRules []unish.NetRule
	// Always block the runner loopback IPC control port in ALL access modes so a
	// child script can never forge approval replies or disrupt daemon-runner IPC.
	if spec.ControlPort > 0 {
		netRules = append(netRules,
			unish.NetRule{
				CIDR:     "127.0.0.0/8",
				Ports:    []int{spec.ControlPort},
				Decision: unish.DecisionDeny,
				Reason:   "runner control port is restricted",
			},
			unish.NetRule{
				CIDR:     "::1/128",
				Ports:    []int{spec.ControlPort},
				Decision: unish.DecisionDeny,
				Reason:   "runner control port is restricted",
			},
			unish.NetRule{
				HostPattern: "localhost",
				Ports:       []int{spec.ControlPort},
				Decision:    unish.DecisionDeny,
				Reason:      "runner control port is restricted",
			},
			unish.NetRule{
				HostPattern: "0.0.0.0",
				Ports:       []int{spec.ControlPort},
				Decision:    unish.DecisionDeny,
				Reason:      "runner control port is restricted",
			},
			unish.NetRule{
				HostPattern: "::",
				Ports:       []int{spec.ControlPort},
				Decision:    unish.DecisionDeny,
				Reason:      "runner control port is restricted",
			},
		)
	}
	// Always block cloud instance metadata endpoints against SSRF.
	netRules = append(netRules,
		unish.NetRule{
			CIDR:     "169.254.169.254/32",
			Decision: unish.DecisionDeny,
			Reason:   "cloud metadata endpoint is blocked",
		},
		unish.NetRule{
			CIDR:     "fd00:ec2::254/128",
			Decision: unish.DecisionDeny,
			Reason:   "cloud metadata endpoint is blocked",
		},
		unish.NetRule{
			CIDR:     "100.100.100.200/32",
			Decision: unish.DecisionDeny,
			Reason:   "cloud metadata endpoint is blocked",
		},
		unish.NetRule{
			HostPattern: "metadata.google.internal",
			Decision:    unish.DecisionDeny,
			Reason:      "cloud metadata endpoint is blocked",
		},
		unish.NetRule{
			HostPattern: "metadata.google.internal.",
			Decision:    unish.DecisionDeny,
			Reason:      "cloud metadata endpoint is blocked",
		},
	)

	var cfg unish.JailConfig
	if jailed {
		readOnlyWrite := unish.DecisionAsk
		if spec.ProjectReadOnly {
			readOnlyWrite = unish.DecisionDeny
		}
		cfg = unish.JailConfig{
			Roots:               roots,
			ReadOnlyRoots:       roRoots,
			Rules:               pathRules,
			OutsideAction:       unish.DecisionAsk,
			ReadOnlyWriteAction: readOnlyWrite,
			Net: unish.NetPolicy{
				Default:         unish.DecisionAsk,
				AllowLoopback:   true,
				BlockPrivateLAN: true,
				AllowListen:     unish.DecisionAsk,
				Rules:           netRules,
			},
			Exec: unish.ExecPolicy{
				Mode: unish.ExecAsk,
			},
			Proc: unish.ProcPolicy{
				Mode: unish.ProcOwnSessionOnly,
			},
			Approver: rt.jailApprover,
		}
	} else {
		readOnlyWrite := unish.DecisionAllow
		if spec.ProjectReadOnly {
			readOnlyWrite = unish.DecisionDeny
		}
		cfg = unish.JailConfig{
			Roots:               roots,
			ReadOnlyRoots:       roRoots,
			OutsideAction:       unish.DecisionAllow,
			ReadOnlyWriteAction: readOnlyWrite,
			Net: unish.NetPolicy{
				Default:         unish.DecisionAllow,
				AllowLoopback:   true,
				BlockPrivateLAN: false,
				AllowListen:     unish.DecisionAllow,
				Rules:           netRules,
			},
			Exec: unish.ExecPolicy{
				Mode: unish.ExecAllowAll,
			},
			Proc: unish.ProcPolicy{
				Mode: unish.ProcAllowAll,
			},
			Approver: rt.jailApprover,
		}
	}

	jail, err := unish.NewJail(cfg)
	if err != nil {
		return nil, err
	}
	rt.jail = jail
	rt.hook = &PolicyCapabilityHook{rt: rt}
	return rt, nil
}

// TmpDir returns the isolated session temporary directory configured for rt.
func (rt *PolicyRuntime) TmpDir() string {
	if rt == nil {
		return ""
	}
	return rt.spec.TmpDir
}

// Jail returns the underlying *unish.Jail.
func (rt *PolicyRuntime) Jail() *unish.Jail {
	if rt == nil {
		return nil
	}
	return rt.jail
}

// Hook returns the PolicyCapabilityHook implementing unish.CapabilityHook.
func (rt *PolicyRuntime) Hook() *PolicyCapabilityHook {
	if rt == nil {
		return nil
	}
	return rt.hook
}

func (rt *PolicyRuntime) effectiveRules() []PermissionRule {
	rt.rulesMu.RLock()
	defer rt.rulesMu.RUnlock()
	cp := make([]PermissionRule, len(rt.liveRules))
	copy(cp, rt.liveRules)
	return cp
}

func (rt *PolicyRuntime) hasOnceGrant(capKind, target string) bool {
	key := capKind + "|" + normalizeOnceKey(capKind, target)
	rt.rulesMu.RLock()
	defer rt.rulesMu.RUnlock()
	return rt.onceGrants[key]
}

func (rt *PolicyRuntime) recordOnceGrant(capKind, target string) {
	key := capKind + "|" + normalizeOnceKey(capKind, target)
	rt.rulesMu.Lock()
	rt.onceGrants[key] = true
	rt.rulesMu.Unlock()
}

func normalizeOnceKey(capKind, target string) string {
	switch capKind {
	case "fs_read", "fs_write":
		if c, err := canonicalOrParent(target); err == nil {
			target = c
		}
		s := filepath.ToSlash(filepath.Clean(target))
		if runtime.GOOS == "windows" {
			s = strings.ToLower(s)
		}
		return s
	case "net":
		h, _ := splitHostPortLoose(strings.ToLower(strings.TrimSpace(target)))
		if h != "" {
			return h
		}
		return strings.ToLower(strings.TrimSpace(target))
	default:
		return normalizeExecString(target)
	}
}

func (rt *PolicyRuntime) recordPersistentGrant(r *PermissionRule) {
	if r == nil {
		return
	}
	rt.rulesMu.Lock()
	defer rt.rulesMu.Unlock()
	if updated, changed := UpsertPermissionRule(rt.liveRules, *r); changed {
		rt.liveRules = updated
	}
}

func (rt *PolicyRuntime) isInsideWritableRoot(p string) bool {
	if p == "" {
		return false
	}
	canon, err := canonicalOrParent(p)
	if err != nil {
		canon = filepath.Clean(p)
	}
	for _, wr := range rt.writableRoots {
		wCanon, werr := canonicalOrParent(wr)
		if werr != nil {
			wCanon = filepath.Clean(wr)
		}
		if isUnderCleanOSPath(wCanon, canon) {
			return true
		}
	}
	return false
}

func (rt *PolicyRuntime) isUnderReadOnlyProject(p string) bool {
	if !rt.spec.ProjectReadOnly || p == "" {
		return false
	}
	canon, err := canonicalOrParent(p)
	if err != nil {
		canon = filepath.Clean(p)
	}
	if rt.spec.BrainDir != "" {
		bCanon, berr := canonicalOrParent(rt.spec.BrainDir)
		if berr != nil {
			bCanon = filepath.Clean(rt.spec.BrainDir)
		}
		if isUnderCleanOSPath(bCanon, canon) {
			return false
		}
	}
	if rt.spec.TmpDir != "" {
		tCanon, terr := canonicalOrParent(rt.spec.TmpDir)
		if terr != nil {
			tCanon = filepath.Clean(rt.spec.TmpDir)
		}
		if isUnderCleanOSPath(tCanon, canon) {
			return false
		}
	}
	if rt.spec.Workspace != "" {
		wsCanon, werr := canonicalOrParent(rt.spec.Workspace)
		if werr != nil {
			wsCanon = filepath.Clean(rt.spec.Workspace)
		}
		if isUnderCleanOSPath(wsCanon, canon) {
			return true
		}
	}
	for _, ror := range rt.spec.ReadOnlyRoots {
		rorCanon, rerr := canonicalOrParent(ror)
		if rerr != nil {
			rorCanon = filepath.Clean(ror)
		}
		if isUnderCleanOSPath(rorCanon, canon) {
			return true
		}
	}
	return false
}

func (rt *PolicyRuntime) promptUser(ctx context.Context, req MidExecApprovalReq) (bool, error) {
	if rt.hasOnceGrant(req.Capability, req.Target) {
		return true, nil
	}
	rt.apprMu.Lock()
	defer rt.apprMu.Unlock()

	// Re-check live rules and onceGrants after acquiring serialization lock in
	// case an earlier concurrent check in the same pipeline just granted access!
	if rt.hasOnceGrant(req.Capability, req.Target) {
		return true, nil
	}
	if eff, _ := MatchRules(rt.effectiveRules(), req.Capability, req.Target, rt.spec.Workspace); eff == "allow" {
		return true, nil
	} else if eff == "deny" {
		return false, nil
	}

	if rt.approver == nil {
		return false, nil
	}
	resp, err := rt.approver(ctx, req)
	if err != nil {
		return false, err
	}
	switch strings.ToLower(strings.TrimSpace(resp.Decision)) {
	case "once":
		rt.recordOnceGrant(req.Capability, req.Target)
		return true, nil
	case "session", "always":
		if resp.GrantedRule != nil {
			rt.recordPersistentGrant(resp.GrantedRule)
		} else if req.ProposedRule != nil {
			rt.recordPersistentGrant(req.ProposedRule)
		}
		rt.recordOnceGrant(req.Capability, req.Target)
		return true, nil
	default:
		return false, nil
	}
}

func (rt *PolicyRuntime) resolveTargetPaths(rawTarget, workDir string) (lexAbs, tCanon string, canonDiffers bool) {
	p := strings.TrimSpace(rawTarget)
	if p == "" {
		return "", "", false
	}
	if !filepath.IsAbs(p) {
		base := nonEmptyStr(workDir, rt.spec.Workspace)
		if base != "" {
			p = filepath.Join(base, p)
		}
	}
	lexAbs = filepath.Clean(p)
	if c, err := canonicalOrParent(lexAbs); err == nil && c != "" {
		tCanon = filepath.Clean(c)
	} else {
		tCanon = lexAbs
	}
	return lexAbs, tCanon, !sameCleanOSPath(lexAbs, tCanon)
}

func (rt *PolicyRuntime) isPathInWorkspace(p string) bool {
	if rt.spec.Workspace == "" || p == "" {
		return false
	}
	wsLex := filepath.Clean(rt.spec.Workspace)
	if isUnderCleanOSPath(wsLex, p) {
		return true
	}
	if wsCanon, err := canonicalOrParent(rt.spec.Workspace); err == nil && wsCanon != "" {
		if isUnderCleanOSPath(wsCanon, p) {
			return true
		}
	}
	return false
}

func (rt *PolicyRuntime) isWorkspaceParentDir(p string) bool {
	if rt.spec.Workspace == "" || p == "" {
		return false
	}
	wsCanon, err := canonicalOrParent(rt.spec.Workspace)
	if err != nil || wsCanon == "" {
		wsCanon = filepath.Clean(rt.spec.Workspace)
	}
	parent := filepath.Dir(wsCanon)
	if sameCleanOSPath(parent, wsCanon) {
		return false
	}
	return sameCleanOSPath(p, parent)
}

func (rt *PolicyRuntime) isSafeWorkspaceEnvTemplate(lexAbs, tCanon string) bool {
	if rt.spec.Workspace == "" || lexAbs == "" || tCanon == "" {
		return false
	}
	wsCanon, err := canonicalOrParent(rt.spec.Workspace)
	if err != nil || wsCanon == "" {
		return false
	}
	if !rt.isPathInWorkspace(lexAbs) || !isUnderCleanOSPath(wsCanon, tCanon) {
		return false
	}
	return IsSafeEnvTemplateName(filepath.Base(lexAbs)) && IsSafeEnvTemplateName(filepath.Base(tCanon))
}

func (rt *PolicyRuntime) checkProtectedWorkspaceTarget(lexAbs, tCanon string, forWrite bool) (bool, string) {
	if rt.spec.Workspace == "" {
		return false, ""
	}
	if tCanon != "" && rt.isPathInWorkspace(tCanon) {
		if prot, reason := checkProtectedSlashPath(filepath.ToSlash(tCanon), forWrite); prot {
			return true, reason
		}
	}
	if lexAbs != "" && rt.isPathInWorkspace(lexAbs) {
		if prot, reason := checkProtectedSlashPath(filepath.ToSlash(lexAbs), forWrite); prot {
			return true, reason
		}
	}
	return false, ""
}

func (rt *PolicyRuntime) checkHardBlockedNet(host string, port int, resolvedIP string) string {
	if host != "" && isCloudMetadataHost(host) {
		return "cloud metadata endpoint is blocked"
	}
	if resolvedIP != "" && isCloudMetadataHost(resolvedIP) {
		return "cloud metadata endpoint is blocked"
	}
	if rt.spec.ControlPort > 0 && port == rt.spec.ControlPort {
		if isLoopbackOrUnspecifiedHost(host) || (resolvedIP != "" && isLoopbackOrUnspecifiedHost(resolvedIP)) {
			return "runner control port is restricted"
		}
	}
	if rt.spec.AccessMode != "full" {
		if host != "" && strings.HasSuffix(normalizeHostForSSRF(host), ".localhost") {
			return fmt.Sprintf("subdomain %q under .localhost is blocked", host)
		}
		if resolvedIP != "" && host != "" && !isLoopbackHost(host) && isLoopbackHost(resolvedIP) {
			return fmt.Sprintf("DNS rebinding from %q to loopback address %s is blocked", host, resolvedIP)
		}
	}
	return ""
}

// jailApprover bridges unish.Jail DecisionAsk callbacks (filesystem & network)
// to PolicyRuntime's rule engine and interactive MidExecApprover.
func (rt *PolicyRuntime) jailApprover(ctx context.Context, req unish.AccessRequest) (unish.Decision, error) {
	rules := rt.effectiveRules()
	switch req.Op {
	case unish.OpRead, unish.OpList, unish.OpStat, unish.OpChdir:
		rawTarget := nonEmptyStr(req.Path, req.RawPath)
		lexAbs, tCanon, canonDiffers := rt.resolveTargetPaths(rawTarget, req.WorkDir)
		target := nonEmptyStr(tCanon, rawTarget)
		if eff, _ := MatchRules(rules, "fs_read", lexAbs, rt.spec.Workspace); eff == "deny" {
			return unish.DecisionDeny, nil
		}
		if canonDiffers {
			if eff, _ := MatchRules(rules, "fs_read", tCanon, rt.spec.Workspace); eff == "deny" {
				return unish.DecisionDeny, nil
			}
		}
		prot, protReason := rt.checkProtectedWorkspaceTarget(lexAbs, tCanon, false)
		if allowsPathByRule(rules, "fs_read", target, rt.spec.Workspace, prot) || allowsPathByRule(rules, "fs_write", target, rt.spec.Workspace, prot) {
			return unish.DecisionAllow, nil
		}
		if rt.isSafeWorkspaceEnvTemplate(lexAbs, tCanon) {
			return unish.DecisionAllow, nil
		}
		prop, ok := ProposePathRule("fs_read", target, rt.spec.Workspace, prot)
		reason := fmt.Sprintf("Reading path %q requires approval", target)
		risk := "medium"
		if prot && protReason != "" {
			reason = protReason
			risk = "high"
		} else if rt.spec.Workspace != "" {
			reason = fmt.Sprintf("Reading %q outside workspace requires approval", target)
		}
		allowed, err := rt.promptUser(ctx, MidExecApprovalReq{
			Capability:      "fs_read",
			Target:          target,
			Reason:          reason,
			Risk:            risk,
			AccessMode:      rt.promptAccessMode(),
			ProposedRule:    prop,
			CanAllowSession: ok,
			CanAllowAlways:  ok,
		})
		if err != nil || !allowed {
			return unish.DecisionDeny, err
		}
		return unish.DecisionAllow, nil

	case unish.OpWrite, unish.OpDelete, unish.OpLink:
		rawTarget := nonEmptyStr(req.Path, req.RawPath)
		lexAbs, tCanon, canonDiffers := rt.resolveTargetPaths(rawTarget, req.WorkDir)
		target := nonEmptyStr(tCanon, rawTarget)
		if rt.isUnderReadOnlyProject(lexAbs) || rt.isUnderReadOnlyProject(tCanon) {
			return unish.DecisionDeny, nil
		}
		if eff, _ := MatchRules(rules, "fs_write", lexAbs, rt.spec.Workspace); eff == "deny" {
			return unish.DecisionDeny, nil
		}
		if canonDiffers {
			if eff, _ := MatchRules(rules, "fs_write", tCanon, rt.spec.Workspace); eff == "deny" {
				return unish.DecisionDeny, nil
			}
		}
		prot, protReason := rt.checkProtectedWorkspaceTarget(lexAbs, tCanon, true)
		if allowsPathByRule(rules, "fs_write", target, rt.spec.Workspace, prot) {
			return unish.DecisionAllow, nil
		}
		prop, ok := ProposePathRule("fs_write", target, rt.spec.Workspace, prot)
		risk := "medium"
		reason := fmt.Sprintf("Writing to %q outside workspace requires approval", target)
		if prot && protReason != "" {
			reason = protReason
			risk = "high"
		}
		allowed, err := rt.promptUser(ctx, MidExecApprovalReq{
			Capability:      "fs_write",
			Target:          target,
			Reason:          reason,
			Risk:            risk,
			AccessMode:      rt.promptAccessMode(),
			ProposedRule:    prop,
			CanAllowSession: ok,
			CanAllowAlways:  ok,
		})
		if err != nil || !allowed {
			return unish.DecisionDeny, err
		}
		return unish.DecisionAllow, nil

	case unish.OpNetConnect, unish.OpNetListen:
		if blockReason := rt.checkHardBlockedNet(req.Host, req.Port, req.ResolvedIP); blockReason != "" {
			return unish.DecisionDeny, nil
		}
		hostTarget := formatNetTarget(req.Host, req.Port)
		if eff, _ := MatchRules(rules, "net", hostTarget, rt.spec.Workspace); eff == "deny" {
			return unish.DecisionDeny, nil
		} else if eff == "allow" {
			return unish.DecisionAllow, nil
		}
		prop, ok := ProposeNetRule(req.Host)
		reason := fmt.Sprintf("Outbound network access to %q requires approval", hostTarget)
		if req.Op == unish.OpNetListen {
			reason = fmt.Sprintf("Binding network listener on %q requires approval", hostTarget)
			prop, ok = nil, false
		}
		allowed, err := rt.promptUser(ctx, MidExecApprovalReq{
			Capability:      "net",
			Target:          hostTarget,
			Reason:          reason,
			Risk:            "medium",
			AccessMode:      rt.promptAccessMode(),
			ProposedRule:    prop,
			CanAllowSession: ok,
			CanAllowAlways:  ok,
		})
		if err != nil || !allowed {
			return unish.DecisionDeny, err
		}
		return unish.DecisionAllow, nil

	default:
		return unish.DecisionDeny, nil
	}
}

func (rt *PolicyRuntime) promptAccessMode() string {
	if rt.spec.AccessMode == "ask" {
		return "ask"
	}
	return "auto"
}

// CheckAccess implements unish.CapabilityHook.
func (h *PolicyCapabilityHook) CheckAccess(ctx context.Context, req unish.AccessRequest) error {
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	rt := h.rt
	rules := rt.effectiveRules()

	switch req.Op {
	case unish.OpExec:
		binPath := nonEmptyStr(req.Binary, req.Path)
		argv := append([]string(nil), req.Argv...)
		if len(argv) == 0 && binPath != "" {
			argv = []string{binPath}
		}
		if rt.spec.ControlPort > 0 && argvTargetsControlPort(argv, rt.spec.ControlPort) {
			return &unish.AccessDenialError{
				Op:     unish.OpExec,
				Target: nonEmptyStr(strings.Join(argv, " "), binPath),
				Reason: "runner control port is restricted",
			}
		}
		// Prevent writable-root binary spoofing (`PATH="$PWD:$PATH" git` or `./git`):
		// if the resolved binary lives inside a writable root (workspace, tmpDir, brainDir),
		// evaluate it as a local path binary rather than crediting a bare system basename!
		if len(argv) > 0 && !strings.ContainsAny(argv[0], `/\`) && binPath != "" && rt.isInsideWritableRoot(binPath) {
			argv[0] = binPath
		}
		workDir := nonEmptyStr(req.WorkDir, rt.spec.Workspace)
		evalMode := "auto"
		if rt.spec.AccessMode == "full" {
			evalMode = "full"
		}
		ev, _ := EvaluateExecArgv(argv, nil, workDir, rt.spec.Workspace, rt.spec.BrainDir, evalMode, rt.spec.ProjectReadOnly, rules)
		switch ev.Verdict {
		case VerdictAllow:
			return nil
		case VerdictDeny:
			return &unish.AccessDenialError{
				Op:     unish.OpExec,
				Target: nonEmptyStr(ev.Meta.Target, binPath),
				Reason: nonEmptyStr(ev.Meta.Reason, "command blocked by permission policy"),
			}
		default:
			allowed, err := rt.promptUser(ctx, MidExecApprovalReq{
				Capability:      nonEmptyStr(ev.Meta.Capability, "exec"),
				Target:          nonEmptyStr(ev.Meta.Target, strings.Join(argv, " ")),
				Reason:          nonEmptyStr(ev.Meta.Reason, "Executing external command requires approval"),
				Risk:            nonEmptyStr(ev.Meta.Risk, "medium"),
				AccessMode:      rt.promptAccessMode(),
				ProposedRule:    ev.Meta.ProposedRule,
				CanAllowSession: ev.Meta.CanAllowSession,
				CanAllowAlways:  ev.Meta.CanAllowAlways,
			})
			if err != nil {
				return err
			}
			if !allowed {
				return &unish.AccessDenialError{
					Op:     unish.OpExec,
					Target: nonEmptyStr(ev.Meta.Target, binPath),
					Reason: "permission denied by user",
				}
			}
			return nil
		}

	case unish.OpRead, unish.OpList, unish.OpStat, unish.OpChdir:
		rawTarget := nonEmptyStr(req.Path, req.RawPath)
		lexAbs, tCanon, canonDiffers := rt.resolveTargetPaths(rawTarget, req.WorkDir)
		if eff, r := MatchRules(rules, "fs_read", lexAbs, rt.spec.Workspace); eff == "deny" {
			return &unish.AccessDenialError{
				Op:     req.Op,
				Target: rawTarget,
				Reason: fmt.Sprintf("path blocked by permission rule %q", r.Pattern),
			}
		}
		if canonDiffers {
			if eff, r := MatchRules(rules, "fs_read", tCanon, rt.spec.Workspace); eff == "deny" {
				return &unish.AccessDenialError{
					Op:     req.Op,
					Target: rawTarget,
					Reason: fmt.Sprintf("path blocked by permission rule %q", r.Pattern),
				}
			}
		}
		prot, protReason := rt.checkProtectedWorkspaceTarget(lexAbs, tCanon, false)
		if tCanon != "" && (allowsPathByRule(rules, "fs_read", tCanon, rt.spec.Workspace, prot) || allowsPathByRule(rules, "fs_write", tCanon, rt.spec.Workspace, prot)) {
			return nil
		}
		if rt.spec.AccessMode != "full" {
			if rt.isSafeWorkspaceEnvTemplate(lexAbs, tCanon) {
				return nil
			}
			// Allow `ls -la` in workspace root to stat the `..` entry (exact parent
			// directory metadata only — never OpList, OpRead, OpChdir, or sibling files).
			if req.Op == unish.OpStat && rt.isWorkspaceParentDir(tCanon) {
				return nil
			}
			if prot && req.Op != unish.OpStat {
				dec, err := rt.jailApprover(ctx, unish.AccessRequest{
					Op:      req.Op,
					Command: req.Command,
					Path:    nonEmptyStr(tCanon, lexAbs),
					RawPath: rawTarget,
					WorkDir: req.WorkDir,
				})
				if err != nil {
					return err
				}
				if dec != unish.DecisionAllow {
					return &unish.AccessDenialError{
						Op:     req.Op,
						Target: rawTarget,
						Reason: nonEmptyStr(protReason, "access to protected workspace path denied"),
					}
				}
				if tCanon != "" && rt.isPathInWorkspace(tCanon) {
					return nil
				}
			}
		}
		if err := rt.jail.CheckAccess(ctx, req); err != nil {
			return err
		}
		if tCanon != "" && (!sameCleanOSPath(rawTarget, tCanon) || (req.Path != "" && !sameCleanOSPath(req.Path, tCanon))) {
			canonReq := req
			canonReq.Path = tCanon
			canonReq.RawPath = tCanon
			if err := rt.jail.CheckAccess(ctx, canonReq); err != nil {
				return err
			}
		}
		return nil

	case unish.OpWrite, unish.OpDelete, unish.OpLink:
		rawTarget := nonEmptyStr(req.Path, req.RawPath)
		lexAbs, tCanon, canonDiffers := rt.resolveTargetPaths(rawTarget, req.WorkDir)
		linkLex, linkCanon, linkDiffers := "", "", false
		if req.TargetPath != "" {
			linkLex, linkCanon, linkDiffers = rt.resolveTargetPaths(req.TargetPath, req.WorkDir)
		}
		if rt.isUnderReadOnlyProject(lexAbs) || rt.isUnderReadOnlyProject(tCanon) ||
			(req.TargetPath != "" && (rt.isUnderReadOnlyProject(linkLex) || rt.isUnderReadOnlyProject(linkCanon))) {
			return &unish.AccessDenialError{
				Op:     req.Op,
				Target: rawTarget,
				Reason: "write not allowed in read-only mode",
			}
		}
		if eff, r := MatchRules(rules, "fs_write", lexAbs, rt.spec.Workspace); eff == "deny" {
			return &unish.AccessDenialError{
				Op:     req.Op,
				Target: rawTarget,
				Reason: fmt.Sprintf("path blocked by permission rule %q", r.Pattern),
			}
		}
		if canonDiffers {
			if eff, r := MatchRules(rules, "fs_write", tCanon, rt.spec.Workspace); eff == "deny" {
				return &unish.AccessDenialError{
					Op:     req.Op,
					Target: rawTarget,
					Reason: fmt.Sprintf("path blocked by permission rule %q", r.Pattern),
				}
			}
		}
		if req.TargetPath != "" {
			if eff, r := MatchRules(rules, "fs_write", linkLex, rt.spec.Workspace); eff == "deny" {
				return &unish.AccessDenialError{
					Op:     req.Op,
					Target: req.TargetPath,
					Reason: fmt.Sprintf("path blocked by permission rule %q", r.Pattern),
				}
			}
			if linkDiffers {
				if eff, r := MatchRules(rules, "fs_write", linkCanon, rt.spec.Workspace); eff == "deny" {
					return &unish.AccessDenialError{
						Op:     req.Op,
						Target: req.TargetPath,
						Reason: fmt.Sprintf("path blocked by permission rule %q", r.Pattern),
					}
				}
			}
		}
		prot, protReason := rt.checkProtectedWorkspaceTarget(lexAbs, tCanon, true)
		if !prot && req.TargetPath != "" {
			prot, protReason = rt.checkProtectedWorkspaceTarget(linkLex, linkCanon, true)
		}
		if req.Op != unish.OpLink && tCanon != "" && allowsPathByRule(rules, "fs_write", tCanon, rt.spec.Workspace, prot) {
			return nil
		}
		if rt.spec.AccessMode != "full" && prot {
			dec, err := rt.jailApprover(ctx, unish.AccessRequest{
				Op:         req.Op,
				Command:    req.Command,
				Path:       nonEmptyStr(tCanon, lexAbs),
				RawPath:    rawTarget,
				TargetPath: req.TargetPath,
				WorkDir:    req.WorkDir,
			})
			if err != nil {
				return err
			}
			if dec != unish.DecisionAllow {
				return &unish.AccessDenialError{
					Op:     req.Op,
					Target: rawTarget,
					Reason: nonEmptyStr(protReason, "modifying protected workspace path denied"),
				}
			}
			if req.Op != unish.OpLink && tCanon != "" && rt.isPathInWorkspace(tCanon) {
				return nil
			}
		}
		if err := rt.jail.CheckAccess(ctx, req); err != nil {
			return err
		}
		needCanonCheck := (tCanon != "" && (!sameCleanOSPath(rawTarget, tCanon) || (req.Path != "" && !sameCleanOSPath(req.Path, tCanon)))) ||
			(req.TargetPath != "" && linkCanon != "" && !sameCleanOSPath(req.TargetPath, linkCanon))
		if needCanonCheck {
			canonReq := req
			if tCanon != "" {
				canonReq.Path = tCanon
				canonReq.RawPath = tCanon
			}
			if req.TargetPath != "" && linkCanon != "" {
				canonReq.TargetPath = linkCanon
			}
			if err := rt.jail.CheckAccess(ctx, canonReq); err != nil {
				return err
			}
		}
		return nil

	case unish.OpNetConnect, unish.OpNetListen:
		hostTarget := formatNetTarget(req.Host, req.Port)
		if blockReason := rt.checkHardBlockedNet(req.Host, req.Port, req.ResolvedIP); blockReason != "" {
			return &unish.AccessDenialError{
				Op:     req.Op,
				Target: nonEmptyStr(hostTarget, req.ResolvedIP),
				Reason: blockReason,
			}
		}
		if eff, r := MatchRules(rules, "net", hostTarget, rt.spec.Workspace); eff == "deny" {
			return &unish.AccessDenialError{
				Op:     req.Op,
				Target: hostTarget,
				Reason: fmt.Sprintf("network host blocked by permission rule %q", r.Pattern),
			}
		}
		if req.ResolvedIP != "" {
			resolvedTarget := formatNetTarget(req.ResolvedIP, req.Port)
			if eff, r := MatchRules(rules, "net", resolvedTarget, rt.spec.Workspace); eff == "deny" {
				return &unish.AccessDenialError{
					Op:     req.Op,
					Target: resolvedTarget,
					Reason: fmt.Sprintf("network address blocked by permission rule %q", r.Pattern),
				}
			}
		}
		return rt.jail.CheckAccess(ctx, req)

	default:
		return rt.jail.CheckAccess(ctx, req)
	}
}

// DialContext implements unish.CapabilityHook.
func (h *PolicyCapabilityHook) DialContext(ctx context.Context, cmdName, network, address string) (net.Conn, error) {
	host, port := parseNetHostPort(address)
	if blockReason := h.rt.checkHardBlockedNet(host, port, ""); blockReason != "" {
		return nil, &unish.AccessDenialError{
			Op:     unish.OpNetConnect,
			Target: address,
			Reason: blockReason,
		}
	}
	if eff, r := MatchRules(h.rt.effectiveRules(), "net", address, h.rt.spec.Workspace); eff == "deny" {
		return nil, &unish.AccessDenialError{
			Op:     unish.OpNetConnect,
			Target: address,
			Reason: fmt.Sprintf("network host blocked by permission rule %q", r.Pattern),
		}
	}
	return h.rt.jail.DialContext(ctx, cmdName, network, address)
}

// Listen implements unish.CapabilityHook.
func (h *PolicyCapabilityHook) Listen(ctx context.Context, cmdName, network, address string) (net.Listener, error) {
	host, port := parseNetHostPort(address)
	if blockReason := h.rt.checkHardBlockedNet(host, port, ""); blockReason != "" {
		return nil, &unish.AccessDenialError{
			Op:     unish.OpNetListen,
			Target: address,
			Reason: blockReason,
		}
	}
	if eff, r := MatchRules(h.rt.effectiveRules(), "net", address, h.rt.spec.Workspace); eff == "deny" {
		return nil, &unish.AccessDenialError{
			Op:     unish.OpNetListen,
			Target: address,
			Reason: fmt.Sprintf("network address blocked by permission rule %q", r.Pattern),
		}
	}
	return h.rt.jail.Listen(ctx, cmdName, network, address)
}

// ListenPacket implements unish.CapabilityHook.
func (h *PolicyCapabilityHook) ListenPacket(ctx context.Context, cmdName, network, address string) (net.PacketConn, error) {
	host, port := parseNetHostPort(address)
	if blockReason := h.rt.checkHardBlockedNet(host, port, ""); blockReason != "" {
		return nil, &unish.AccessDenialError{
			Op:     unish.OpNetListen,
			Target: address,
			Reason: blockReason,
		}
	}
	if eff, r := MatchRules(h.rt.effectiveRules(), "net", address, h.rt.spec.Workspace); eff == "deny" {
		return nil, &unish.AccessDenialError{
			Op:     unish.OpNetListen,
			Target: address,
			Reason: fmt.Sprintf("network address blocked by permission rule %q", r.Pattern),
		}
	}
	return h.rt.jail.ListenPacket(ctx, cmdName, network, address)
}

// PrepareEnv injects session TMPDIR/TEMP/TMP, strips non-existent PATH entries
// that would otherwise trigger outside-jail stat prompts during binary lookup,
// and scrubs sensitive loader environment overrides when jailed.
func (rt *PolicyRuntime) PrepareEnv(env []string) []string {
	out := make([]string, 0, len(env)+4)
	jailed := rt.spec.AccessMode != "full"
	seenTmp := map[string]bool{}
	seenPath := false
	for _, kv := range env {
		idx := strings.IndexByte(kv, '=')
		if idx <= 0 {
			continue
		}
		k := kv[:idx]
		v := kv[idx+1:]
		upper := strings.ToUpper(k)
		if jailed && isDangerousLoaderEnv(upper) {
			continue
		}
		if rt.spec.TmpDir != "" && (upper == "TMPDIR" || upper == "TEMP" || upper == "TMP") {
			if seenTmp[upper] {
				continue
			}
			seenTmp[upper] = true
			out = append(out, k+"="+rt.spec.TmpDir)
			continue
		}
		if jailed && upper == "PATH" {
			if runtime.GOOS == "windows" {
				if seenPath {
					continue
				}
				seenPath = true
				k = "PATH"
			}
			out = append(out, k+"="+rt.sanitizePathEnvValue(v, rt.spec.Workspace))
			continue
		}
		out = append(out, kv)
	}
	if rt.spec.TmpDir != "" {
		for _, k := range []string{"TMPDIR", "TEMP", "TMP"} {
			if !seenTmp[k] {
				out = append(out, k+"="+rt.spec.TmpDir)
			}
		}
	}
	return out
}

func (rt *PolicyRuntime) isCoveredByReadableRoot(p string) bool {
	if p == "" || len(rt.readableRoots) == 0 {
		return true
	}
	for _, r := range rt.readableRoots {
		if isUnderCleanOSPath(r, p) {
			return true
		}
	}
	return false
}

func (rt *PolicyRuntime) sanitizePathEnvValue(rawPath, workDir string) string {
	if strings.TrimSpace(rawPath) == "" {
		return ""
	}
	parts := filepath.SplitList(rawPath)
	kept := make([]string, 0, len(parts))
	for _, entry := range parts {
		d := strings.Trim(strings.TrimSpace(entry), `"`)
		if runtime.GOOS == "windows" && strings.HasPrefix(d, `\\?\`) && !strings.HasPrefix(strings.ToUpper(d), `\\?\UNC\`) {
			d = d[4:]
		}
		if d == "" {
			continue
		}
		checkDir := d
		if !filepath.IsAbs(checkDir) && workDir != "" {
			checkDir = filepath.Join(workDir, checkDir)
		}
		checkDir = filepath.Clean(checkDir)
		info, err := os.Stat(checkDir)
		if err != nil || !info.IsDir() {
			continue
		}
		if len(rt.readableRoots) > 0 {
			if !rt.isCoveredByReadableRoot(checkDir) {
				continue
			}
			if c, cerr := canonicalOrParent(checkDir); cerr == nil && c != "" && !rt.isCoveredByReadableRoot(c) {
				continue
			}
		}
		kept = append(kept, checkDir)
	}
	return strings.Join(kept, string(filepath.ListSeparator))
}

func isDangerousLoaderEnv(upper string) bool {
	if strings.HasPrefix(upper, "LD_") || strings.HasPrefix(upper, "DYLD_") {
		return true
	}
	switch upper {
	case "BASH_ENV", "ENV", "CDPATH", "NODE_OPTIONS", "GIT_SSH_COMMAND", "GIT_EXEC_PATH", "PROMPT_COMMAND":
		return true
	}
	return false
}

// ExecShell runs script inside an embedded unish.Session wired to rt's Jail and
// PolicyCapabilityHook, streaming stdout/stderr live and closing the session on exit.
func (rt *PolicyRuntime) ExecShell(
	ctx context.Context,
	script string,
	cwd string,
	env []string,
	stdin io.Reader,
	stdout, stderr io.Writer,
) (int, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	workDir := strings.TrimSpace(cwd)
	if workDir == "" {
		workDir = rt.spec.Workspace
	}
	if workDir == "" {
		workDir, _ = os.Getwd()
	}
	cleanEnv := rt.PrepareEnv(env)
	if stdin == nil {
		stdin = strings.NewReader("")
	}

	sess, err := unish.NewSession(
		unish.WithWorkDir(workDir),
		unish.WithInheritEnv(false),
		unish.WithEnv(cleanEnv),
		unish.WithJail(rt.jail),
		unish.WithHook(rt.hook),
	)
	if err != nil {
		if stderr != nil {
			_, _ = fmt.Fprintf(stderr, "unish: %v\n", err)
		}
		return 1, err
	}
	defer func() { _ = sess.Close() }()

	res, execErr := sess.ExecWith(ctx, script, unish.ExecOptions{
		Stdin:  stdin,
		Stdout: stdout,
		Stderr: stderr,
	})
	if res != nil {
		if execErr != nil && res.ExitCode == 0 {
			if errors.Is(execErr, context.Canceled) {
				return 130, execErr
			}
			return 1, execErr
		}
		return res.ExitCode, execErr
	}
	if execErr != nil {
		if errors.Is(execErr, context.Canceled) {
			return 130, execErr
		}
		return 1, execErr
	}
	return 0, nil
}

// QJSOptions augments base with rt's live CheckAccess, DialContext, Listen,
// ListenPacket, ShellExec, TmpDir, and child-VM JailRoots/ReadOnlyRoots hooks.
func (rt *PolicyRuntime) QJSOptions(base qjs.ScriptOptions) qjs.ScriptOptions {
	if rt == nil {
		return base
	}
	out := base
	if out.TmpDir == "" && rt.spec.TmpDir != "" {
		out.TmpDir = rt.spec.TmpDir
	}
	if out.Env != nil && (rt.spec.TmpDir != "" || rt.spec.AccessMode != "full") {
		envCopy := make(map[string]string, len(out.Env)+3)
		for k, v := range out.Env {
			if rt.spec.AccessMode != "full" {
				upper := strings.ToUpper(k)
				if isDangerousLoaderEnv(upper) {
					continue
				}
				if upper == "PATH" {
					v = rt.sanitizePathEnvValue(v, rt.spec.Workspace)
				}
			}
			envCopy[k] = v
		}
		if rt.spec.TmpDir != "" {
			envCopy["TMPDIR"] = rt.spec.TmpDir
			envCopy["TEMP"] = rt.spec.TmpDir
			envCopy["TMP"] = rt.spec.TmpDir
		}
		out.Env = envCopy
	}
	if rt.spec.AccessMode != "full" && len(out.JailRoots) == 0 {
		for _, r := range []string{rt.spec.Workspace, rt.spec.BrainDir, rt.spec.TmpDir} {
			if r != "" {
				out.JailRoots = append(out.JailRoots, r)
			}
		}
		out.JailRoots = append(out.JailRoots, rt.spec.ExtraRoots...)
	}
	if rt.spec.ProjectReadOnly && len(out.ReadOnlyRoots) == 0 {
		if rt.spec.Workspace != "" {
			out.ReadOnlyRoots = append(out.ReadOnlyRoots, rt.spec.Workspace)
		}
		out.ReadOnlyRoots = append(out.ReadOnlyRoots, rt.spec.ExtraRoots...)
	}
	if len(out.FSReadRoots) == 0 && len(rt.spec.FSReadScopes) > 0 {
		out.FSReadRoots = append([]string(nil), rt.spec.FSReadScopes...)
	}
	if len(out.FSWriteRoots) == 0 && len(rt.spec.FSWriteScopes) > 0 {
		out.FSWriteRoots = append([]string(nil), rt.spec.FSWriteScopes...)
	}
	if len(out.NetAllow) == 0 && len(rt.spec.NetAllow) > 0 {
		out.NetAllow = append([]string(nil), rt.spec.NetAllow...)
	}

	out.CheckAccess = func(ctx context.Context, kind, target string, argv []string) error {
		switch kind {
		case "fs_read":
			return rt.hook.CheckAccess(ctx, unish.AccessRequest{
				Op:      unish.OpRead,
				Command: "exec_script",
				Path:    target,
				RawPath: target,
			})
		case "fs_write":
			return rt.hook.CheckAccess(ctx, unish.AccessRequest{
				Op:      unish.OpWrite,
				Command: "exec_script",
				Path:    target,
				RawPath: target,
			})
		case "net":
			host, port := parseNetHostPort(target)
			resolvedIP := ""
			if len(argv) > 0 && strings.TrimSpace(argv[0]) != "" {
				origHost, origPort := parseNetHostPort(argv[0])
				if origHost != "" {
					resolvedIP = host
					host = origHost
					if port == 0 {
						port = origPort
					}
				}
			}
			return rt.hook.CheckAccess(ctx, unish.AccessRequest{
				Op:         unish.OpNetConnect,
				Command:    "exec_script",
				Proto:      "tcp",
				Host:       host,
				Port:       port,
				ResolvedIP: resolvedIP,
			})
		case "net_listen":
			host, port := parseNetHostPort(target)
			return rt.hook.CheckAccess(ctx, unish.AccessRequest{
				Op:      unish.OpNetListen,
				Command: "exec_script",
				Proto:   "tcp",
				Host:    host,
				Port:    port,
			})
		case "exec":
			return rt.hook.CheckAccess(ctx, unish.AccessRequest{
				Op:      unish.OpExec,
				Command: "exec_script",
				Path:    target,
				RawPath: target,
				Binary:  target,
				Argv:    argv,
				WorkDir: out.CWD,
			})
		default:
			return &unish.AccessDenialError{
				Op:     unish.AccessOp(kind),
				Target: target,
				Reason: "unsupported capability kind",
			}
		}
	}
	out.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		return rt.hook.DialContext(ctx, "exec_script", network, addr)
	}
	out.Listen = func(ctx context.Context, network, addr string) (net.Listener, error) {
		return rt.hook.Listen(ctx, "exec_script", network, addr)
	}
	out.ListenPacket = func(ctx context.Context, network, addr string) (net.PacketConn, error) {
		return rt.hook.ListenPacket(ctx, "exec_script", network, addr)
	}
	out.ShellExec = func(ctx context.Context, cmd, cwd string, env []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
		return rt.ExecShell(ctx, cmd, cwd, env, stdin, stdout, stderr)
	}
	return out
}

func parseNetHostPort(target string) (string, int) {
	s := strings.TrimSpace(target)
	if h, pStr, err := net.SplitHostPort(s); err == nil {
		p, _ := strconv.Atoi(pStr)
		return strings.Trim(h, "[]"), p
	}
	return strings.Trim(s, "[]"), 0
}

func formatNetTarget(host string, port int) string {
	h := strings.TrimSpace(host)
	if port > 0 && h != "" {
		return net.JoinHostPort(h, strconv.Itoa(port))
	}
	return h
}

func nonEmptyStr(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}

func sameCleanOSPath(a, b string) bool {
	ca := filepath.Clean(a)
	cb := filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(ca, cb)
	}
	return ca == cb
}

func isUnderCleanOSPath(root, target string) bool {
	r := filepath.Clean(root)
	t := filepath.Clean(target)
	if runtime.GOOS == "windows" {
		r = strings.ToLower(r)
		t = strings.ToLower(t)
	}
	if r == t {
		return true
	}
	sep := string(filepath.Separator)
	if !strings.HasSuffix(r, sep) {
		r += sep
	}
	return strings.HasPrefix(t, r)
}

func argvTargetsControlPort(argv []string, port int) bool {
	if port <= 0 || len(argv) == 0 {
		return false
	}
	portStr := strconv.Itoa(port)
	colonPort := ":" + portStr
	for _, arg := range argv {
		if containsBoundedPortRef(arg, colonPort) {
			return true
		}
	}
	unwrapped, _ := unwrapExecArgv(argv)
	checkArgv := argv
	if len(unwrapped) > 0 {
		checkArgv = unwrapped
	}
	bin := baseProgName(checkArgv[0])
	if isNetworkOrScriptExecBinary(bin) {
		for _, arg := range checkArgv[1:] {
			if containsStandaloneToken(arg, portStr) {
				return true
			}
		}
	}
	return false
}

func containsBoundedPortRef(s, colonPort string) bool {
	idx := 0
	for {
		pos := strings.Index(s[idx:], colonPort)
		if pos < 0 {
			return false
		}
		absPos := idx + pos
		end := absPos + len(colonPort)
		nextIsDigit := end < len(s) && s[end] >= '0' && s[end] <= '9'
		if !nextIsDigit {
			return true
		}
		idx = absPos + 1
	}
}

func containsStandaloneToken(s, token string) bool {
	if s == token {
		return true
	}
	idx := 0
	for {
		pos := strings.Index(s[idx:], token)
		if pos < 0 {
			return false
		}
		absPos := idx + pos
		end := absPos + len(token)
		prevAlnum := absPos > 0 && isASCIIAlnum(s[absPos-1])
		nextAlnum := end < len(s) && isASCIIAlnum(s[end])
		if !prevAlnum && !nextAlnum {
			return true
		}
		idx = absPos + 1
	}
}

func isASCIIAlnum(b byte) bool {
	return (b >= '0' && b <= '9') || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || b == '_'
}

func isNetworkOrScriptExecBinary(bin string) bool {
	switch bin {
	case "curl", "wget", "nc", "ncat", "netcat", "socat", "telnet", "openssl",
		"ssh", "scp", "sftp", "python", "python3", "python2", "node", "bun", "deno",
		"perl", "ruby", "php", "powershell", "pwsh", "cmd":
		return true
	default:
		return strings.HasPrefix(bin, "python3.")
	}
}
