package tools

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// PermissionRule is a durable or session-scoped permission rule shared across
// config.json (`permission_rules`), SessionRecord (`sessionGrants`), and
// approval wire payloads (`proposedRule`).
type PermissionRule struct {
	ID        string `json:"id"`
	Effect    string `json:"effect"`              // "allow" | "deny"
	Kind      string `json:"kind"`                // "exec" | "fs_read" | "fs_write" | "net" | "tool"
	Pattern   string `json:"pattern"`             // normalized cmd prefix ("git push"), canonical path/glob ("/abs/dir/**", ".env.local"), host ("api.github.com", "*.npmjs.org"), or tool name
	Label     string `json:"label,omitempty"`
	CreatedAt int64  `json:"createdAt,omitempty"`
}

// ToolApprovalMeta carries structured capability, risk, and scoped rule
// metadata on tool_approval_request and session_data.pendingApproval.
type ToolApprovalMeta struct {
	Capability      string          `json:"capability,omitempty"` // "exec" | "fs_read" | "fs_write" | "net" | "tool"
	Target          string          `json:"target,omitempty"`
	Reason          string          `json:"reason,omitempty"`
	Risk            string          `json:"risk,omitempty"`       // "low" | "medium" | "high"
	AccessMode      string          `json:"accessMode,omitempty"` // "ask" | "auto"
	ProposedRule    *PermissionRule `json:"proposedRule,omitempty"`
	CanAllowSession bool            `json:"canAllowSession"`
	CanAllowAlways  bool            `json:"canAllowAlways"`
	// CallGrants holds ephemeral one-shot rules applied ONLY to this single tool
	// invocation if the user approves ("once", "session", or "always") so mid-execution
	// runner hooks do not double-prompt for the exact target approved pre-tool.
	CallGrants []PermissionRule `json:"-"`
}

// PolicyVerdict represents the decision from the 3-tier policy evaluator.
type PolicyVerdict string

const (
	VerdictAllow PolicyVerdict = "allow"
	VerdictAsk   PolicyVerdict = "ask"
	VerdictDeny  PolicyVerdict = "deny"
)

// PolicyEvaluation is the result of evaluating a tool call or mid-execution
// capability request against rules and the session access mode.
type PolicyEvaluation struct {
	Verdict PolicyVerdict
	Meta    ToolApprovalMeta
}

// NewRuleID generates a compact unique identifier for a PermissionRule.
func NewRuleID() string {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("rule_%d", time.Now().UnixNano())
	}
	return "rule_" + hex.EncodeToString(b[:])
}

// ValidateAndNormalizeRule validates and normalizes one PermissionRule.
func ValidateAndNormalizeRule(r PermissionRule) (PermissionRule, error) {
	r.Effect = strings.ToLower(strings.TrimSpace(r.Effect))
	switch r.Effect {
	case "allow", "deny":
	default:
		return PermissionRule{}, fmt.Errorf("invalid permission rule effect %q (must be allow or deny)", r.Effect)
	}
	r.Kind = strings.ToLower(strings.TrimSpace(r.Kind))
	switch r.Kind {
	case "exec", "fs_read", "fs_write", "net", "tool":
	default:
		return PermissionRule{}, fmt.Errorf("invalid permission rule kind %q", r.Kind)
	}
	pat := strings.TrimSpace(r.Pattern)
	if pat == "" {
		return PermissionRule{}, fmt.Errorf("permission rule pattern cannot be empty")
	}
	switch r.Kind {
	case "exec":
		pat = normalizeExecString(pat)
	case "fs_read", "fs_write":
		pat = normalizeRulePathPattern(pat)
	case "net":
		pat = strings.ToLower(pat)
	case "tool":
		pat = strings.ToLower(pat)
	}
	if pat == "" {
		return PermissionRule{}, fmt.Errorf("permission rule pattern cannot be empty")
	}
	r.Pattern = pat
	r.ID = strings.TrimSpace(r.ID)
	if r.ID == "" {
		r.ID = NewRuleID()
	}
	r.Label = strings.TrimSpace(r.Label)
	return r, nil
}

// NormalizePermissionRules returns a validated, deduplicated slice of rules,
// dropping malformed entries defensively when loading from disk.
func NormalizePermissionRules(in []PermissionRule) []PermissionRule {
	if len(in) == 0 {
		return nil
	}
	out := make([]PermissionRule, 0, len(in))
	seen := make(map[string]bool, len(in))
	for _, r := range in {
		norm, err := ValidateAndNormalizeRule(r)
		if err != nil {
			continue
		}
		key := norm.Effect + "|" + norm.Kind + "|" + ruleDedupPattern(norm.Kind, norm.Pattern)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, norm)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// UpsertPermissionRule appends r to existing if an equivalent (Effect, Kind, Pattern)
// rule is not already present, returning a new slice.
func UpsertPermissionRule(existing []PermissionRule, r PermissionRule) ([]PermissionRule, bool) {
	norm, err := ValidateAndNormalizeRule(r)
	if err != nil {
		return append([]PermissionRule(nil), existing...), false
	}
	if norm.CreatedAt == 0 {
		norm.CreatedAt = time.Now().UnixMilli()
	}
	targetKey := norm.Effect + "|" + norm.Kind + "|" + ruleDedupPattern(norm.Kind, norm.Pattern)
	out := make([]PermissionRule, 0, len(existing)+1)
	for _, cur := range existing {
		cn, cerr := ValidateAndNormalizeRule(cur)
		if cerr != nil {
			continue
		}
		k := cn.Effect + "|" + cn.Kind + "|" + ruleDedupPattern(cn.Kind, cn.Pattern)
		if k == targetKey {
			return append([]PermissionRule(nil), existing...), false
		}
		out = append(out, cn)
	}
	out = append(out, norm)
	return out, true
}

func ruleDedupPattern(kind, pat string) string {
	if runtime.GOOS == "windows" && (kind == "fs_read" || kind == "fs_write") {
		return strings.ToLower(pat)
	}
	return pat
}

func normalizeExecString(s string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(s)), " ")
}

func normalizeRulePathPattern(p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return ""
	}
	slashed := strings.ReplaceAll(p, `\`, `/`)
	if strings.HasSuffix(slashed, "/**") {
		base := strings.TrimSuffix(slashed, "/**")
		if base == "" || base == "/" {
			return "/**"
		}
		if filepath.IsAbs(p) {
			if c, err := canonicalOrParent(filepath.FromSlash(base)); err == nil {
				base = filepath.ToSlash(c)
			}
		}
		return strings.TrimRight(base, "/") + "/**"
	}
	if strings.HasSuffix(slashed, "/*") {
		base := strings.TrimSuffix(slashed, "/*")
		if filepath.IsAbs(p) {
			if c, err := canonicalOrParent(filepath.FromSlash(base)); err == nil {
				base = filepath.ToSlash(c)
			}
		}
		return strings.TrimRight(base, "/") + "/*"
	}
	if filepath.IsAbs(p) && !strings.ContainsAny(slashed, "*?[") {
		if c, err := canonicalOrParent(filepath.FromSlash(slashed)); err == nil {
			return filepath.ToSlash(c)
		}
	}
	return path.Clean(slashed)
}

// MatchRules evaluates explicit rules with strict Deny > Allow precedence.
// Returns ("deny", rule), ("allow", rule), or ("", zero).
func MatchRules(rules []PermissionRule, kind, target, workspace string) (string, PermissionRule) {
	var matchedAllow *PermissionRule
	for i := range rules {
		r := rules[i]
		if !strings.EqualFold(r.Kind, kind) {
			continue
		}
		if !matchSingleRule(r, target, workspace) {
			continue
		}
		if strings.EqualFold(r.Effect, "deny") {
			return "deny", r
		}
		if strings.EqualFold(r.Effect, "allow") && matchedAllow == nil {
			cp := r
			matchedAllow = &cp
		}
	}
	if matchedAllow != nil {
		return "allow", *matchedAllow
	}
	return "", PermissionRule{}
}

func matchSingleRule(r PermissionRule, target, workspace string) bool {
	pat := strings.TrimSpace(r.Pattern)
	target = strings.TrimSpace(target)
	if pat == "" || target == "" {
		return false
	}
	switch strings.ToLower(r.Kind) {
	case "tool":
		return pat == "*" || strings.EqualFold(pat, target)
	case "exec":
		normPat := normalizeExecString(pat)
		normTarget := normalizeExecString(target)
		if normPat == "*" {
			return true
		}
		if normTarget == normPat {
			return true
		}
		if strings.HasPrefix(normTarget, normPat+" ") {
			// Do not let a prefix rule match shell chaining if raw shell string was passed.
			rest := normTarget[len(normPat):]
			if !strings.ContainsAny(rest, ";&|`\n") {
				return true
			}
		}
		return false
	case "net":
		return matchNetPattern(pat, target)
	case "fs_read", "fs_write":
		return matchPathPattern(pat, target, workspace)
	default:
		return false
	}
}

func matchNetPattern(pat, target string) bool {
	p := strings.ToLower(strings.TrimSpace(pat))
	t := strings.ToLower(strings.TrimSpace(target))
	if p == "" || t == "" {
		return false
	}
	if p == "*" || p == t {
		return true
	}
	tHost, tPort := splitHostPortLoose(t)
	pHost, pPort := splitHostPortLoose(p)
	if pPort != "" && tPort != "" && pPort != tPort {
		return false
	}
	if pPort != "" && tPort == "" {
		return false
	}
	if pHost == "*" || pHost == tHost {
		return true
	}
	if strings.HasPrefix(pHost, "*.") {
		suffix := pHost[1:] // ".example.com"
		if strings.HasSuffix(tHost, suffix) && len(tHost) > len(suffix) {
			return true
		}
	}
	return false
}

func splitHostPortLoose(s string) (string, string) {
	s = strings.TrimSpace(s)
	if strings.Contains(s, "://") {
		if u, err := url.Parse(s); err == nil && u.Host != "" {
			s = u.Host
		}
	}
	if h, p, err := net.SplitHostPort(s); err == nil {
		return strings.Trim(h, "[]"), p
	}
	return strings.Trim(s, "[]"), ""
}

func urlEffectivePort(u *url.URL) string {
	if u == nil {
		return ""
	}
	if p := strings.TrimSpace(u.Port()); p != "" {
		return p
	}
	switch strings.ToLower(strings.TrimSpace(u.Scheme)) {
	case "http":
		return "80"
	case "https":
		return "443"
	default:
		return ""
	}
}

// matchNetRulesHostPort evaluates "net" rules against both host:port (when port
// is non-empty) and bare host, preserving strict Deny > Allow precedence across
// both forms so port-scoped rules (e.g. "127.0.0.1:8080") and host-only rules
// (e.g. "example.com") both work consistently.
func matchNetRulesHostPort(rules []PermissionRule, host, port, workspace string) (string, PermissionRule) {
	h := strings.ToLower(strings.Trim(strings.TrimSpace(host), "[]"))
	p := strings.TrimSpace(port)
	var candidates []string
	if h != "" && p != "" {
		candidates = append(candidates, net.JoinHostPort(h, p))
	}
	if h != "" {
		candidates = append(candidates, h)
	}
	var matchedAllow *PermissionRule
	for _, target := range candidates {
		eff, r := MatchRules(rules, "net", target, workspace)
		if eff == "deny" {
			return "deny", r
		}
		if eff == "allow" && matchedAllow == nil {
			cp := r
			matchedAllow = &cp
		}
	}
	if matchedAllow != nil {
		return "allow", *matchedAllow
	}
	return "", PermissionRule{}
}

func matchPathPattern(pat, target, workspace string) bool {
	normPat := normalizeRulePathPattern(pat)
	if normPat == "" {
		return false
	}
	resolved := target
	if !filepath.IsAbs(resolved) && workspace != "" {
		resolved = filepath.Join(workspace, resolved)
	}
	if c, err := canonicalOrParent(resolved); err == nil {
		resolved = c
	}
	targetSlash := filepath.ToSlash(filepath.Clean(resolved))
	cmpPat := normPat
	cmpTarget := targetSlash
	if runtime.GOOS == "windows" {
		cmpPat = strings.ToLower(cmpPat)
		cmpTarget = strings.ToLower(cmpTarget)
	}
	if cmpPat == "/**" || cmpPat == "*" {
		return true
	}
	// Relative basename/subpath pattern (e.g. ".env.local", "*.pem")
	if !strings.HasPrefix(normPat, "/") && (len(normPat) < 2 || normPat[1] != ':') {
		base := path.Base(cmpTarget)
		if ok, _ := path.Match(cmpPat, base); ok {
			return true
		}
		if workspace != "" {
			wsCanon := workspace
			if c, err := canonicalOrParent(workspace); err == nil {
				wsCanon = c
			}
			wsSlash := filepath.ToSlash(filepath.Clean(wsCanon))
			if runtime.GOOS == "windows" {
				wsSlash = strings.ToLower(wsSlash)
			}
			if strings.HasPrefix(cmpTarget, wsSlash+"/") {
				rel := strings.TrimPrefix(cmpTarget, wsSlash+"/")
				if rel == cmpPat {
					return true
				}
				if strings.HasSuffix(cmpPat, "/**") {
					prefix := strings.TrimSuffix(cmpPat, "/**")
					if rel == prefix || strings.HasPrefix(rel, prefix+"/") {
						return true
					}
				}
				if ok, _ := path.Match(cmpPat, rel); ok {
					return true
				}
			}
		}
		return false
	}
	if strings.HasSuffix(cmpPat, "/**") {
		base := strings.TrimSuffix(cmpPat, "/**")
		return cmpTarget == base || strings.HasPrefix(cmpTarget, base+"/")
	}
	if strings.HasSuffix(cmpPat, "/*") {
		base := strings.TrimSuffix(cmpPat, "/*")
		if !strings.HasPrefix(cmpTarget, base+"/") {
			return false
		}
		rem := strings.TrimPrefix(cmpTarget, base+"/")
		return !strings.Contains(rem, "/")
	}
	if cmpTarget == cmpPat {
		return true
	}
	if ok, _ := path.Match(cmpPat, cmpTarget); ok {
		return true
	}
	return false
}

// IsSafeEnvTemplateName reports whether base is a committed template file like
// .env.example that may be read without prompting in auto mode.
func IsSafeEnvTemplateName(base string) bool {
	switch strings.ToLower(base) {
	case ".env.example", ".env.sample", ".env.template", ".env.dist", ".env.defaults", ".env.schema":
		return true
	default:
		return false
	}
}

// IsProtectedWorkspacePath checks whether target (an absolute or workspace-relative
// path) hits a protected subpath inside workspace (.git/hooks/**, .git/config,
// .indirect/**, .env*, private keys, .npmrc, .netrc).
func IsProtectedWorkspacePath(workspace, target string, forWrite bool) (bool, string) {
	if target == "" {
		return false, ""
	}
	resolved := target
	if !filepath.IsAbs(resolved) && workspace != "" {
		resolved = filepath.Join(workspace, resolved)
	}
	canon, err := canonicalOrParent(resolved)
	if err != nil {
		canon = filepath.Clean(resolved)
	}
	slashPath := filepath.ToSlash(canon)
	if prot, reason := checkProtectedSlashPath(slashPath, forWrite); prot {
		return true, reason
	}

	// Also inspect unresolved lexical path so a symlink inside .git/hooks, .indirect,
	// or named .env pointing elsewhere does not bypass detection.
	lexSlash := filepath.ToSlash(filepath.Clean(resolved))
	if !strings.EqualFold(lexSlash, slashPath) {
		if prot, reason := checkProtectedSlashPath(lexSlash, forWrite); prot {
			return true, reason
		}
	}
	return false, ""
}

func checkProtectedSlashPath(slashPath string, forWrite bool) (bool, string) {
	lowerSlash := strings.ToLower(slashPath)
	base := path.Base(lowerSlash)

	// Check .git/hooks and .git/config anywhere in path components.
	if strings.Contains(lowerSlash, "/.git/hooks/") || strings.HasSuffix(lowerSlash, "/.git/hooks") {
		return true, "Git repository hooks (.git/hooks) can execute arbitrary commands on git operations"
	}
	if strings.HasSuffix(lowerSlash, "/.git/config") {
		return true, "Git repository configuration (.git/config) controls remotes, credentials, and hooks"
	}
	if forWrite && strings.HasSuffix(lowerSlash, "/.git") {
		return true, "Modifying .git metadata directly requires explicit approval"
	}
	if strings.Contains(lowerSlash, "/.indirect/") || strings.HasSuffix(lowerSlash, "/.indirect") {
		if forWrite {
			return true, "Modifying .indirect configuration requires approval"
		}
		return true, "Reading .indirect configuration requires approval"
	}
	if forWrite && (strings.HasSuffix(lowerSlash, "/.vscode/tasks.json") || strings.HasSuffix(lowerSlash, "/.vscode/launch.json") || strings.HasSuffix(lowerSlash, "/.vscode/settings.json")) {
		return true, "Modifying IDE workspace execution settings (.vscode) requires approval"
	}

	if base == ".env" || strings.HasPrefix(base, ".env.") {
		if !forWrite && IsSafeEnvTemplateName(base) {
			return false, ""
		}
		if forWrite {
			return true, fmt.Sprintf("Modifying environment file %q requires approval", path.Base(slashPath))
		}
		return true, fmt.Sprintf("Reading environment secret file %q requires approval", path.Base(slashPath))
	}

	switch base {
	case ".npmrc", ".netrc", ".pypirc", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa":
		return true, fmt.Sprintf("Accessing credential/key file %q requires approval", path.Base(slashPath))
	}
	for _, ext := range []string{".pem", ".key", ".p12", ".pfx"} {
		if strings.HasSuffix(base, ext) {
			return true, fmt.Sprintf("Accessing key/certificate file %q requires approval", path.Base(slashPath))
		}
	}
	return false, ""
}

// isBroadWorkspaceCoverPattern reports whether rulePattern is a broad root/workspace
// directory glob (such as "*" or "<workspace>/**") rather than an explicit rule for
// a protected file or subpath inside workspace.
func isBroadWorkspaceCoverPattern(rulePattern, workspace string) bool {
	pat := strings.TrimSpace(rulePattern)
	if pat == "" || pat == "*" || pat == "**" || pat == "/**" {
		return true
	}
	if workspace == "" || !strings.HasSuffix(pat, "/**") {
		return false
	}
	wsCanon, err := canonicalOrParent(workspace)
	if err != nil {
		wsCanon = filepath.Clean(workspace)
	}
	prefix := strings.TrimSuffix(pat, "/**")
	if prefix == "" {
		return true
	}
	pOS := filepath.FromSlash(prefix)
	if !filepath.IsAbs(pOS) {
		pOS = filepath.Join(wsCanon, pOS)
	}
	pCanon, err := canonicalOrParent(pOS)
	if err != nil {
		pCanon = filepath.Clean(pOS)
	}
	// If wsCanon is equal to or under pCanon, then pat ("<pCanon>/**") covers the
	// entire workspace root and must not implicitly unlock protected subpaths.
	return isUnder(pCanon, wsCanon)
}

func allowsPathByRule(rules []PermissionRule, capKind, targetPath, workspace string, isProtectedInWs bool) bool {
	for _, r := range rules {
		if strings.ToLower(strings.TrimSpace(r.Effect)) != "allow" {
			continue
		}
		if strings.ToLower(strings.TrimSpace(r.Kind)) != capKind {
			continue
		}
		if !matchPathPattern(r.Pattern, targetPath, workspace) {
			continue
		}
		if isProtectedInWs && isBroadWorkspaceCoverPattern(r.Pattern, workspace) {
			continue
		}
		return true
	}
	return false
}

// ProposePathRule builds a safe PermissionRule for a filesystem read or write
// approval prompt, avoiding overly broad home/root/temp globs and never offering
// persistent rules for sensitive SSH/cloud/PGP keystores.
func ProposePathRule(kind, targetPath, workspace string, isProtected bool) (*PermissionRule, bool) {
	if targetPath == "" {
		return nil, false
	}
	canon, err := canonicalOrParent(targetPath)
	if err != nil {
		canon = filepath.Clean(targetPath)
	}
	slash := filepath.ToSlash(canon)
	lower := strings.ToLower(slash)
	for _, sensitive := range []string{"/.ssh/", "/.gnupg/", "/.aws/credentials", "/.kube/config"} {
		if strings.Contains(lower, sensitive) {
			return nil, false
		}
	}
	base := path.Base(lower)
	if base == "id_rsa" || base == "id_ed25519" || base == "id_ecdsa" || strings.HasSuffix(base, ".key") || strings.HasSuffix(base, ".pem") {
		if !isUnderWorkspacePath(workspace, canon) {
			return nil, false
		}
	}
	// Protected files inside workspace always scope to the exact file, never directory/**.
	if isProtected || isUnderWorkspacePath(workspace, canon) {
		verb := "Read"
		if kind == "fs_write" {
			verb = "Modify"
		}
		return &PermissionRule{
			ID:      NewRuleID(),
			Effect:  "allow",
			Kind:    kind,
			Pattern: slash,
			Label:   fmt.Sprintf("%s %s", verb, path.Base(slash)),
		}, true
	}

	// Outside workspace: if target is a directory, scope to dir/**; if it is a file
	// inside a specific directory (not filesystem root, not $HOME itself, not raw OS temp root),
	// scope to parentDir/** so sibling files in that external project work naturally.
	dir := canon
	if info, serr := os.Stat(canon); serr != nil || !info.IsDir() {
		dir = filepath.Dir(canon)
	}
	if isBroadSystemDir(dir) {
		verb := "Read"
		if kind == "fs_write" {
			verb = "Modify"
		}
		return &PermissionRule{
			ID:      NewRuleID(),
			Effect:  "allow",
			Kind:    kind,
			Pattern: slash,
			Label:   fmt.Sprintf("%s %s", verb, slash),
		}, true
	}
	dirSlash := strings.TrimRight(filepath.ToSlash(dir), "/")
	verb := "Read in"
	if kind == "fs_write" {
		verb = "Write in"
	}
	return &PermissionRule{
		ID:      NewRuleID(),
		Effect:  "allow",
		Kind:    kind,
		Pattern: dirSlash + "/**",
		Label:   fmt.Sprintf("%s %s", verb, dirSlash),
	}, true
}

func isBroadSystemDir(dir string) bool {
	clean := filepath.Clean(dir)
	if filepath.Dir(clean) == clean {
		return true // "/" or "C:\"
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		if hCanon, herr := canonicalOrParent(home); herr == nil && samePathPlatform(clean, hCanon) {
			return true
		}
		if samePathPlatform(clean, filepath.Clean(home)) {
			return true
		}
	}
	tmp := os.TempDir()
	if tmp != "" {
		if tCanon, terr := canonicalOrParent(tmp); terr == nil && samePathPlatform(clean, tCanon) {
			return true
		}
		if samePathPlatform(clean, filepath.Clean(tmp)) {
			return true
		}
	}
	slashed := strings.ToLower(filepath.ToSlash(clean))
	switch slashed {
	case "/tmp", "/var", "/var/tmp", "/private/tmp", "/etc", "/usr", "/users", "/home", "c:/users", "c:/windows":
		return true
	}
	return false
}

func samePathPlatform(a, b string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
	}
	return filepath.Clean(a) == filepath.Clean(b)
}

func isUnderWorkspacePath(workspace, target string) bool {
	if workspace == "" || target == "" {
		return false
	}
	wsCanon, err := canonicalOrParent(workspace)
	if err != nil {
		wsCanon = filepath.Clean(workspace)
	}
	tCanon, err := canonicalOrParent(target)
	if err != nil {
		tCanon = filepath.Clean(target)
	}
	return isUnder(wsCanon, tCanon)
}

func isAllowedInRoots(target string, roots ...string) bool {
	tCanon, err := canonicalOrParent(target)
	if err != nil {
		return false
	}
	for _, r := range roots {
		if r == "" {
			continue
		}
		rCanon, rerr := canonicalOrParent(r)
		if rerr != nil {
			continue
		}
		if isUnder(rCanon, tCanon) {
			return true
		}
	}
	return false
}

// ProposeNetRule builds a scoped network allow rule for an external host.
func ProposeNetRule(hostOrAddr string) (*PermissionRule, bool) {
	rawHost, _ := splitHostPortLoose(hostOrAddr)
	h := normalizeHostForSSRF(rawHost)
	if h == "" || h == "*" {
		return nil, false
	}
	if isCloudMetadataHost(h) || isLoopbackHost(h) || strings.HasSuffix(h, ".localhost") {
		return nil, false
	}
	if addr, ok := parseNormalizedAddr(h); ok && isPrivateOrReservedAddr(addr) {
		return nil, false
	}
	return &PermissionRule{
		ID:      NewRuleID(),
		Effect:  "allow",
		Kind:    "net",
		Pattern: h,
		Label:   "Allow network access to " + h,
	}, true
}

// ProposeExecRule builds a safe command-prefix PermissionRule when argv is safe
// to generalize, returning (nil, false) for shell wrappers, eval/xargs, bare rm,
// privilege escalation, and inline code flags (-c / -e).
func ProposeExecRule(argv []string) (*PermissionRule, bool) {
	unwrapped, wrapperBlocked := unwrapExecArgv(argv)
	if wrapperBlocked || len(unwrapped) == 0 {
		return nil, false
	}
	bin := baseProgName(unwrapped[0])
	if isNonPersistableBinary(bin) {
		return nil, false
	}
	if isInlineEvalInvocation(bin, unwrapped[1:]) {
		return nil, false
	}
	prefix := buildSafeExecPrefix(bin, unwrapped)
	if prefix == "" {
		return nil, false
	}
	return &PermissionRule{
		ID:      NewRuleID(),
		Effect:  "allow",
		Kind:    "exec",
		Pattern: prefix,
		Label:   "Allow running " + prefix,
	}, true
}

func baseProgName(p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return ""
	}
	b := filepath.Base(strings.ReplaceAll(p, `\`, string(filepath.Separator)))
	lower := strings.ToLower(b)
	for _, ext := range []string{".exe", ".cmd", ".bat", ".com"} {
		if strings.HasSuffix(lower, ext) {
			return lower[:len(lower)-len(ext)]
		}
	}
	return lower
}

func isNonPersistableBinary(bin string) bool {
	switch strings.ToLower(bin) {
	case "", "sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "csh", "tcsh", "unish",
		"cmd", "powershell", "pwsh", "osascript", "wscript", "cscript",
		"eval", "exec", "source", ".", "xargs", "env", "command", "builtin", "nohup",
		"rm", "rmdir", "del", "erase", "shred", "dd", "mkfs", "fdisk", "diskutil", "format",
		"sudo", "su", "doas", "pkexec", "runas", "kill", "pkill", "killall", "taskkill":
		return true
	default:
		return false
	}
}

func isShellInterpreterBinary(bin string) bool {
	switch strings.ToLower(bin) {
	case "sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "csh", "tcsh", "unish",
		"cmd", "powershell", "pwsh", "eval", "source", ".":
		return true
	default:
		return false
	}
}

func isPipeCodeSinkBinary(bin string) bool {
	if isShellInterpreterBinary(bin) {
		return true
	}
	switch strings.ToLower(bin) {
	case "python", "python3", "node", "bun", "deno", "perl", "ruby", "php", "osascript":
		return true
	default:
		return false
	}
}

func isInlineEvalInvocation(bin string, args []string) bool {
	switch bin {
	case "node", "bun", "deno", "python", "python3", "perl", "ruby", "php":
		for _, a := range args {
			switch a {
			case "-e", "--eval", "-p", "--print", "-c":
				return true
			}
		}
	}
	return false
}

var subcommandCLIs = map[string]bool{
	"git": true, "gh": true, "docker": true, "podman": true, "kubectl": true,
	"helm": true, "terraform": true, "tofu": true, "npm": true, "pnpm": true,
	"yarn": true, "bun": true, "cargo": true, "go": true, "pip": true, "pip3": true,
	"uv": true, "poetry": true, "brew": true, "apt": true, "apt-get": true,
	"apk": true, "dnf": true, "yum": true, "pacman": true, "winget": true, "choco": true,
	"aws": true, "gcloud": true, "az": true, "vercel": true, "netlify": true,
	"railway": true, "fly": true, "flyctl": true, "supabase": true, "wrangler": true,
}

func buildSafeExecPrefix(bin string, argv []string) string {
	rawCmd := argv[0]
	// Relative scripts like ./deploy.sh keep their relative script token.
	cmdToken := bin
	if strings.HasPrefix(rawCmd, "./") || strings.HasPrefix(rawCmd, `.\\`) {
		cmdToken = filepath.ToSlash(rawCmd)
	}
	if !subcommandCLIs[bin] {
		return cmdToken
	}
	sub, rest := extractCLISubcommand(bin, argv[1:])
	if sub == "" {
		return cmdToken
	}
	// Two-level subcommands (e.g. `gh pr merge`, `git stash drop`, `npm run build`).
	switch bin {
	case "gh", "docker", "kubectl", "aws", "gcloud", "az":
		if len(rest) > 0 && !strings.HasPrefix(rest[0], "-") && isSafeIdentToken(rest[0]) {
			return cmdToken + " " + sub + " " + rest[0]
		}
	}
	return cmdToken + " " + sub
}

func isSafeIdentToken(s string) bool {
	if s == "" || len(s) > 40 {
		return false
	}
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == ':' {
			continue
		}
		return false
	}
	return true
}

func extractCLISubcommand(bin string, args []string) (string, []string) {
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			return "", nil
		}
		if strings.HasPrefix(a, "-") {
			// Skip flag arguments for common global CLI options.
			if bin == "git" && (a == "-C" || a == "-c" || a == "--git-dir" || a == "--work-tree") {
				i++
			}
			continue
		}
		if isSafeIdentToken(a) {
			return a, args[i+1:]
		}
		return "", nil
	}
	return "", nil
}

// unwrapExecArgv strips benign command modifiers (`nice`, `time`, `timeout <dur>`)
// and detects non-persistable wrappers (`env`, `command`, `nohup`, `xargs`, shells).
func unwrapExecArgv(argv []string) ([]string, bool) {
	cur := argv
	// Strip leading VAR=VAL tokens if present.
	for len(cur) > 0 && isEnvAssignToken(cur[0]) {
		cur = cur[1:]
	}
	if len(cur) == 0 {
		return nil, true
	}
	bin := baseProgName(cur[0])
	switch bin {
	case "env", "command", "builtin", "nohup", "xargs":
		return cur, true
	case "nice":
		i := 1
		if i < len(cur) && (cur[i] == "-n" || strings.HasPrefix(cur[i], "-")) {
			if cur[i] == "-n" && i+1 < len(cur) {
				i += 2
			} else {
				i++
			}
		}
		if i < len(cur) {
			return unwrapExecArgv(cur[i:])
		}
		return cur, true
	case "timeout":
		// timeout [flags] DURATION COMMAND...
		i := 1
		for i < len(cur) && strings.HasPrefix(cur[i], "-") {
			if (cur[i] == "-k" || cur[i] == "-s") && i+1 < len(cur) {
				i += 2
			} else {
				i++
			}
		}
		if i+1 < len(cur) {
			return unwrapExecArgv(cur[i+1:])
		}
		return cur, true
	}
	return cur, false
}

func isEnvAssignToken(s string) bool {
	eq := strings.IndexByte(s, '=')
	if eq <= 0 {
		return false
	}
	for i := 0; i < eq; i++ {
		ch := s[i]
		if i == 0 {
			if !((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch == '_') {
				return false
			}
		} else {
			if !((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_') {
				return false
			}
		}
	}
	return true
}

// EvaluateToolCall evaluates a pre-tool call in cmd/daemon against:
//  1. ProjectReadOnly hard blocks on workspace writes
//  2. Explicit Deny rules in rules (SessionGrants ∪ PermissionRules)
//  3. Explicit Allow rules in rules
//  4. AccessMode baseline ("full", "auto", "ask")
func EvaluateToolCall(
	toolName string,
	rawArgs json.RawMessage,
	accessMode string,
	workspace string,
	brainDir string,
	projectReadOnly bool,
	rules []PermissionRule,
) PolicyEvaluation {
	canonicalTool := strings.ToLower(strings.TrimSpace(toolName))
	switch canonicalTool {
	case "patch":
		canonicalTool = "edit"
	case "python":
		canonicalTool = "exec_script"
	}

	// Check explicit tool-level rule first if any.
	if eff, r := MatchRules(rules, "tool", canonicalTool, workspace); eff == "deny" {
		return PolicyEvaluation{
			Verdict: VerdictDeny,
			Meta: ToolApprovalMeta{
				Capability: "tool",
				Target:     canonicalTool,
				Reason:     fmt.Sprintf("Blocked by permission rule %q", r.Pattern),
			},
		}
	}

	canonArgs, canonErr := CanonicalizeToolArgs(rawArgs)
	if canonErr != nil {
		return PolicyEvaluation{
			Verdict: VerdictDeny,
			Meta: ToolApprovalMeta{
				Capability: "tool",
				Target:     canonicalTool,
				Reason:     fmt.Sprintf("Invalid tool arguments: %v", canonErr),
			},
		}
	}

	var argMap map[string]any
	if len(canonArgs) > 0 && !bytes.Equal(canonArgs, []byte("null")) {
		_ = json.Unmarshal(canonArgs, &argMap)
	}
	strArg := func(keys ...string) string {
		for _, k := range keys {
			if v, ok := argMap[k].(string); ok && strings.TrimSpace(v) != "" {
				return strings.TrimSpace(v)
			}
		}
		return ""
	}

	switch canonicalTool {
	case "read", "glob", "search", "inspect":
		p := strArg("path", "dir", "directory", "file")
		resolved := workspace
		if p != "" {
			resolved = resolvePath(workspace, p)
		}
		return evaluateFSCheck("fs_read", canonicalTool, resolved, p, accessMode, workspace, brainDir, projectReadOnly, rules)

	case "write", "edit":
		p := strArg("path", "file", "file_path")
		if p == "" {
			if accessMode == "full" || accessMode == "auto" {
				return PolicyEvaluation{Verdict: VerdictAllow}
			}
		} else {
			resolved := resolvePath(workspace, p)
			return evaluateFSCheck("fs_write", canonicalTool, resolved, p, accessMode, workspace, brainDir, projectReadOnly, rules)
		}

	case "fetch_url":
		rawURL := strArg("url")
		return evaluateFetchURLCheck(rawURL, accessMode, workspace, rules)

	case "bash":
		cmd := strArg("command", "cmd")
		return EvaluateShellCommand(cmd, workspace, workspace, brainDir, accessMode, projectReadOnly, rules)

	case "exec_script":
		wd := strArg("work_dir")
		if wd != "" {
			resolved := resolvePath(workspace, wd)
			wdEval := evaluateFSCheck("fs_read", "exec_script", resolved, wd, accessMode, workspace, brainDir, projectReadOnly, rules)
			if wdEval.Verdict != VerdictAllow {
				return wdEval
			}
		}
		if eff, _ := MatchRules(rules, "tool", "exec_script", workspace); eff == "allow" {
			return PolicyEvaluation{Verdict: VerdictAllow}
		}
		if accessMode == "full" || accessMode == "auto" {
			// In auto mode, exec_script launches cleanly because QuickJS + unish.Jail
			// enforce live mid-execution Approver gates on outside FS, protected paths,
			// network hosts, and $ / child_process commands.
			return PolicyEvaluation{Verdict: VerdictAllow}
		}
		rule := &PermissionRule{
			ID:      NewRuleID(),
			Effect:  "allow",
			Kind:    "tool",
			Pattern: "exec_script",
			Label:   "Allow running JavaScript in workspace",
		}
		return PolicyEvaluation{
			Verdict: VerdictAsk,
			Meta: ToolApprovalMeta{
				Capability:      "exec",
				Target:          ClipLabel(strArg("code")),
				Reason:          "Ask for approval mode requires confirmation before running JavaScript",
				Risk:            "medium",
				AccessMode:      "ask",
				ProposedRule:    rule,
				CanAllowSession: true,
				CanAllowAlways:  true,
			},
		}

	case "widget_set":
		if srcFile := strArg("src_file"); srcFile != "" {
			resolved := resolvePath(workspace, srcFile)
			fsEval := evaluateFSCheck("fs_read", "widget_set", resolved, srcFile, accessMode, workspace, brainDir, projectReadOnly, rules)
			if fsEval.Verdict != VerdictAllow {
				return fsEval
			}
		}
		if eff, _ := MatchRules(rules, "tool", canonicalTool, workspace); eff == "allow" {
			return PolicyEvaluation{Verdict: VerdictAllow}
		}
		if accessMode == "full" || accessMode == "auto" {
			return PolicyEvaluation{Verdict: VerdictAllow}
		}

	case "search_web":
		allNetAllowed := true
		for _, ddgHost := range []string{"html.duckduckgo.com", "lite.duckduckgo.com"} {
			eff, r := matchNetRulesHostPort(rules, ddgHost, "443", workspace)
			if eff == "deny" {
				return PolicyEvaluation{
					Verdict: VerdictDeny,
					Meta: ToolApprovalMeta{
						Capability: "net",
						Target:     ddgHost,
						Reason:     fmt.Sprintf("Network access to %q blocked by rule %q", ddgHost, r.Pattern),
					},
				}
			}
			if eff != "allow" {
				allNetAllowed = false
			}
		}
		if allNetAllowed {
			return PolicyEvaluation{Verdict: VerdictAllow}
		}
		if eff, _ := MatchRules(rules, "tool", canonicalTool, workspace); eff == "allow" {
			return PolicyEvaluation{Verdict: VerdictAllow}
		}
		if accessMode == "full" || accessMode == "auto" {
			return PolicyEvaluation{Verdict: VerdictAllow}
		}

	case "explore", "bg_await", "bg_check", "bg_cancel",
		"question", "todo", "session_history", "widget_list", "widget_lint", "widget_read", "widget_edit":
		if eff, _ := MatchRules(rules, "tool", canonicalTool, workspace); eff == "allow" {
			return PolicyEvaluation{Verdict: VerdictAllow}
		}
		if accessMode == "full" || accessMode == "auto" {
			return PolicyEvaluation{Verdict: VerdictAllow}
		}
	}

	// Fallback ("ask" mode on tools not already matched by an explicit allow rule,
	// or custom/unknown tools).
	if eff, _ := MatchRules(rules, "tool", canonicalTool, workspace); eff == "allow" {
		return PolicyEvaluation{Verdict: VerdictAllow}
	}
	if accessMode == "full" {
		return PolicyEvaluation{Verdict: VerdictAllow}
	}
	displayTool := humanToolName(canonicalTool)
	toolLabel := "Allow tool " + displayTool
	if displayTool != canonicalTool {
		toolLabel = "Allow " + displayTool
	}
	prop := &PermissionRule{
		ID:      NewRuleID(),
		Effect:  "allow",
		Kind:    "tool",
		Pattern: canonicalTool,
		Label:   toolLabel,
	}
	return PolicyEvaluation{
		Verdict: VerdictAsk,
		Meta: ToolApprovalMeta{
			Capability:      "tool",
			Target:          canonicalTool,
			Reason:          fmt.Sprintf("Ask for approval mode requires confirmation to run %s", displayTool),
			Risk:            "low",
			AccessMode:      accessMode,
			ProposedRule:    prop,
			CanAllowSession: true,
			CanAllowAlways:  true,
		},
	}
}

func evaluateFSCheck(
	capKind string, // "fs_read" | "fs_write"
	toolName string,
	resolvedPath string,
	rawPath string,
	accessMode string,
	workspace string,
	brainDir string,
	projectReadOnly bool,
	rules []PermissionRule,
) PolicyEvaluation {
	forWrite := capKind == "fs_write"
	inBrain := brainDir != "" && isAllowedInRoots(resolvedPath, brainDir)
	inWorkspace := workspace != "" && isAllowedInRoots(resolvedPath, workspace)

	// 1. ProjectReadOnly hard block on workspace writes (brainDir stays writable).
	if forWrite && projectReadOnly && !inBrain {
		return PolicyEvaluation{
			Verdict: VerdictDeny,
			Meta: ToolApprovalMeta{
				Capability: capKind,
				Target:     resolvedPath,
				Reason:     fmt.Sprintf("Read-only mode: modifying %q is not allowed in this mode", nonEmpty(rawPath, resolvedPath)),
			},
		}
	}

	protected, protReason := IsProtectedWorkspacePath(workspace, resolvedPath, forWrite)
	isProtInWs := inWorkspace && protected

	// 2. Explicit Deny / Allow rules (fs_write grant also satisfies fs_read on the same path).
	if eff, r := MatchRules(rules, capKind, resolvedPath, workspace); eff == "deny" {
		return PolicyEvaluation{
			Verdict: VerdictDeny,
			Meta: ToolApprovalMeta{
				Capability: capKind,
				Target:     resolvedPath,
				Reason:     fmt.Sprintf("Permission denied by rule %q", r.Pattern),
			},
		}
	} else if eff == "allow" && allowsPathByRule(rules, capKind, resolvedPath, workspace, isProtInWs) {
		callRule := PermissionRule{Effect: "allow", Kind: capKind, Pattern: filepath.ToSlash(resolvedPath)}
		return PolicyEvaluation{
			Verdict: VerdictAllow,
			Meta:    ToolApprovalMeta{CallGrants: []PermissionRule{callRule}},
		}
	}
	if !forWrite {
		if eff, _ := MatchRules(rules, "fs_write", resolvedPath, workspace); eff == "allow" && allowsPathByRule(rules, "fs_write", resolvedPath, workspace, isProtInWs) {
			callRule := PermissionRule{Effect: "allow", Kind: "fs_read", Pattern: filepath.ToSlash(resolvedPath)}
			return PolicyEvaluation{
				Verdict: VerdictAllow,
				Meta:    ToolApprovalMeta{CallGrants: []PermissionRule{callRule}},
			}
		}
	}
	if toolName != "" {
		if eff, _ := MatchRules(rules, "tool", toolName, workspace); eff == "allow" && (inWorkspace || inBrain) {
			if !protected {
				return PolicyEvaluation{Verdict: VerdictAllow}
			}
		}
	}

	// 3. Full access mode allows everything not explicitly denied above.
	if accessMode == "full" {
		return PolicyEvaluation{Verdict: VerdictAllow}
	}

	// 4. Brain scratch directory is always allowed in auto mode (and read-only in ask? In ask mode, tools prompt unless allowed).
	if inBrain && accessMode == "auto" {
		return PolicyEvaluation{Verdict: VerdictAllow}
	}

	// 5. Protected paths inside workspace ALWAYS prompt in both "auto" and "ask".
	if isProtInWs {
		prop, ok := ProposePathRule(capKind, resolvedPath, workspace, true)
		callGrant := PermissionRule{Effect: "allow", Kind: capKind, Pattern: filepath.ToSlash(resolvedPath)}
		return PolicyEvaluation{
			Verdict: VerdictAsk,
			Meta: ToolApprovalMeta{
				Capability:      capKind,
				Target:          nonEmpty(rawPath, resolvedPath),
				Reason:          protReason,
				Risk:            "high",
				AccessMode:      accessMode,
				ProposedRule:    prop,
				CanAllowSession: ok,
				CanAllowAlways:  ok,
				CallGrants:      []PermissionRule{callGrant},
			},
		}
	}

	// 6. Outside workspace & outside brainDir ALWAYS prompts in both "auto" and "ask".
	if !inWorkspace && !inBrain {
		prop, ok := ProposePathRule(capKind, resolvedPath, workspace, false)
		risk := "medium"
		if forWrite || !ok {
			risk = "high"
		}
		verb := "Read file outside workspace"
		if forWrite {
			verb = "Write file outside workspace"
		}
		callGrant := PermissionRule{Effect: "allow", Kind: capKind, Pattern: filepath.ToSlash(resolvedPath)}
		return PolicyEvaluation{
			Verdict: VerdictAsk,
			Meta: ToolApprovalMeta{
				Capability:      capKind,
				Target:          resolvedPath,
				Reason:          verb,
				Risk:            risk,
				AccessMode:      accessMode,
				ProposedRule:    prop,
				CanAllowSession: ok,
				CanAllowAlways:  ok,
				CallGrants:      []PermissionRule{callGrant},
			},
		}
	}

	// 7. Inside workspace (or brainDir), non-protected:
	//    - "auto" allows both reads and writes immediately.
	//    - "ask" prompts on pre-tool calls (`toolName != ""`) unless covered by a
	//      permission rule above, while allowing mid-execution workspace reads (`toolName == ""`)
	//      inside an already-approved command.
	if accessMode == "auto" || (!forWrite && accessMode == "ask" && toolName == "") {
		return PolicyEvaluation{Verdict: VerdictAllow}
	}

	var prop *PermissionRule
	if workspace != "" {
		wsCanon, err := canonicalOrParent(workspace)
		if err != nil {
			wsCanon = filepath.Clean(workspace)
		}
		wsGlob := strings.TrimRight(filepath.ToSlash(wsCanon), "/") + "/**"
		label := "Allow reading workspace files"
		if forWrite {
			label = "Allow writing workspace files"
		}
		prop = &PermissionRule{
			ID:      NewRuleID(),
			Effect:  "allow",
			Kind:    capKind,
			Pattern: wsGlob,
			Label:   label,
		}
	}
	verb := "reading"
	if forWrite {
		verb = "modifying"
	}
	callGrant := PermissionRule{Effect: "allow", Kind: capKind, Pattern: filepath.ToSlash(resolvedPath)}
	return PolicyEvaluation{
		Verdict: VerdictAsk,
		Meta: ToolApprovalMeta{
			Capability:      capKind,
			Target:          nonEmpty(rawPath, resolvedPath),
			Reason:          fmt.Sprintf("Ask for approval mode requires confirmation before %s this file", verb),
			Risk:            "low",
			AccessMode:      "ask",
			ProposedRule:    prop,
			CanAllowSession: prop != nil,
			CanAllowAlways:  prop != nil,
			CallGrants:      []PermissionRule{callGrant},
		},
	}
}

func evaluateFetchURLCheck(rawURL, accessMode, workspace string, rules []PermissionRule) PolicyEvaluation {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || u.Host == "" {
		if accessMode == "full" || accessMode == "auto" {
			return PolicyEvaluation{Verdict: VerdictAllow}
		}
	}
	rawHost := ""
	if u != nil {
		rawHost = u.Hostname()
	}
	host := normalizeHostForSSRF(rawHost)

	// 1. Cloud instance metadata endpoints are ALWAYS hard-blocked in every mode (including "full").
	if rawHost != "" && isCloudMetadataHost(rawHost) {
		return PolicyEvaluation{
			Verdict: VerdictDeny,
			Meta: ToolApprovalMeta{
				Capability: "net",
				Target:     nonEmpty(u.Host, rawHost),
				Reason:     fmt.Sprintf("Cloud metadata endpoint %q is blocked", rawHost),
			},
		}
	}

	// 2. Explicit Deny rules always win before any Allow rule or mode check.
	if rawHost != "" {
		port := urlEffectivePort(u)
		if eff, r := matchNetRulesHostPort(rules, rawHost, port, workspace); eff == "deny" {
			return PolicyEvaluation{
				Verdict: VerdictDeny,
				Meta: ToolApprovalMeta{
					Capability: "net",
					Target:     nonEmpty(u.Host, rawHost),
					Reason:     fmt.Sprintf("Network access to %q blocked by rule %q", nonEmpty(u.Host, rawHost), r.Pattern),
				},
			}
		}
	}

	// 3. In jailed modes ("auto" and "ask"), hard-deny ambiguous *.localhost subdomains
	// and private/link-local/unspecified/CGNAT literal IP targets against SSRF.
	if accessMode != "full" && rawHost != "" {
		if strings.HasSuffix(host, ".localhost") {
			return PolicyEvaluation{
				Verdict: VerdictDeny,
				Meta: ToolApprovalMeta{
					Capability: "net",
					Target:     nonEmpty(u.Host, rawHost),
					Reason:     fmt.Sprintf("Localhost subdomain %q is blocked for security", rawHost),
				},
			}
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
				}
			}
			if !addr.IsLoopback() && isPrivateOrReservedAddr(addr) {
				return PolicyEvaluation{
					Verdict: VerdictDeny,
					Meta: ToolApprovalMeta{
						Capability: "net",
						Target:     nonEmpty(u.Host, rawHost),
						Reason:     fmt.Sprintf("Private or reserved IP address %q is blocked", rawHost),
					},
				}
			}
		}
	}

	// 4. Explicit Allow rules.
	if rawHost != "" {
		port := urlEffectivePort(u)
		if eff, _ := matchNetRulesHostPort(rules, rawHost, port, workspace); eff == "allow" {
			grantPat := host
			if isLoopbackHost(rawHost) && port != "" {
				grantPat = net.JoinHostPort(host, port)
			}
			return PolicyEvaluation{
				Verdict: VerdictAllow,
				Meta: ToolApprovalMeta{
					CallGrants: []PermissionRule{{Effect: "allow", Kind: "net", Pattern: grantPat}},
				},
			}
		}
	}

	if accessMode == "full" {
		return PolicyEvaluation{Verdict: VerdictAllow}
	}
	if rawHost != "" && isLoopbackHost(rawHost) && accessMode == "auto" {
		return PolicyEvaluation{Verdict: VerdictAllow}
	}
	target := rawURL
	if host != "" {
		target = host
	}
	prop, ok := ProposeNetRule(rawHost)
	var callGrants []PermissionRule
	if host != "" {
		callGrants = []PermissionRule{{Effect: "allow", Kind: "net", Pattern: host}}
	}
	return PolicyEvaluation{
		Verdict: VerdictAsk,
		Meta: ToolApprovalMeta{
			Capability:      "net",
			Target:          target,
			Reason:          "Outbound network request requires approval",
			Risk:            "medium",
			AccessMode:      accessMode,
			ProposedRule:    prop,
			CanAllowSession: ok,
			CanAllowAlways:  ok,
			CallGrants:      callGrants,
		},
	}
}

func humanToolName(canonical string) string {
	switch canonical {
	case "exec_script":
		return "JavaScript"
	case "search_web":
		return "Web search"
	case "fetch_url":
		return "Fetch URL"
	case "bg_cancel":
		return "Cancel background task"
	case "bg_await":
		return "Wait for background task"
	case "bg_check":
		return "Check background task"
	case "session_history":
		return "Session history"
	case "widget_set":
		return "Save widget"
	case "widget_list":
		return "List widgets"
	case "widget_lint":
		return "Lint widget"
	case "widget_read":
		return "Read widget"
	case "widget_edit":
		return "Edit widget"
	default:
		return canonical
	}
}

func nonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}
