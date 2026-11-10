package qjs

import (
	"bufio"
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"context"
	"crypto"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/md5"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"hash"
	"hash/fnv"
	"io"
	"io/fs"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"indirect/indirect-code-daemon/packages/proctable"
)

func (en *rtEntry) getCWD() string {
	en.mu.Lock()
	defer en.mu.Unlock()
	return en.cwd
}

func isNullDevicePath(p string) bool {
	s := strings.TrimSpace(p)
	if s == "" {
		return false
	}
	if strings.EqualFold(s, os.DevNull) {
		return true
	}
	switch strings.ToLower(strings.ReplaceAll(s, `\`, `/`)) {
	case "/dev/null", "//./nul", "//?/nul", "nul":
		return true
	}
	return false
}

func joinCWDPath(cwd, p string) string {
	if isNullDevicePath(p) {
		return os.DevNull
	}
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	if runtime.GOOS == "windows" && len(p) > 0 && (p[0] == '/' || p[0] == '\\') {
		if len(p) >= 2 && (p[1] == '/' || p[1] == '\\') {
			return filepath.Clean(p)
		}
		vol := filepath.VolumeName(cwd)
		return filepath.Clean(vol + p)
	}
	return filepath.Join(cwd, p)
}

func (en *rtEntry) resolvePath(p string) string {
	if p == "" {
		return en.getCWD()
	}
	if isNullDevicePath(p) {
		return os.DevNull
	}
	if strings.HasPrefix(p, "file://") {
		if resolved, err := en.resolveModulePath(en.getCWD(), p); err == nil {
			return resolved
		}
	}
	return joinCWDPath(en.getCWD(), p)
}

func (en *rtEntry) hasSandboxRestrictions() bool {
	en.mu.Lock()
	defer en.mu.Unlock()
	return len(en.jailRoots) > 0 || len(en.readOnlyRoots) > 0 || len(en.fsReadRoots) > 0 || len(en.fsWriteRoots) > 0 || len(en.netAllow) > 0
}

func checkScopedTarget(op, rawPath, target string, scopes []string) error {
	if len(scopes) == 0 {
		return nil
	}
	if len(scopes) == 1 && scopes[0] == "__NONE__" {
		return fmt.Errorf("EACCES: permission denied: this agent has no filesystem %s permission", op)
	}
	for _, scope := range scopes {
		if scope == "" || scope == "__NONE__" {
			continue
		}
		rootAbs, rerr := canonicalOrParentPath(scope)
		if rerr != nil {
			continue
		}
		if isUnderPath(rootAbs, target) {
			return nil
		}
	}
	return fmt.Errorf("EACCES: permission denied: %s %q is outside declared scopes", op, rawPath)
}

func (en *rtEntry) checkJailPath(p string) error {
	if isNullDevicePath(p) {
		return nil
	}
	resolved := en.resolvePath(p)
	if len(en.jailRoots) == 0 {
		return nil
	}
	target, err := canonicalOrParentPath(resolved)
	if err != nil {
		return fmt.Errorf("EACCES: jailed: cannot resolve path %q: %v", p, err)
	}
	for _, root := range en.jailRoots {
		if root == "" {
			continue
		}
		rootAbs, rerr := canonicalOrParentPath(root)
		if rerr != nil {
			continue
		}
		if isUnderPath(rootAbs, target) {
			return nil
		}
	}
	return fmt.Errorf("EACCES: jailed: path %q is outside sandbox root (use /unjail to disable)", p)
}

func (en *rtEntry) checkJailPathNoFollow(p string) error {
	if isNullDevicePath(p) {
		return nil
	}
	resolved := en.resolvePath(p)
	if len(en.jailRoots) == 0 {
		return nil
	}
	target, err := canonicalOrParentPathNoFollow(resolved)
	if err != nil {
		return fmt.Errorf("EACCES: jailed: cannot resolve path %q: %v", p, err)
	}
	for _, root := range en.jailRoots {
		if root == "" {
			continue
		}
		rootAbs, rerr := canonicalOrParentPath(root)
		if rerr != nil {
			continue
		}
		if isUnderPath(rootAbs, target) {
			return nil
		}
	}
	return fmt.Errorf("EACCES: jailed: path %q is outside sandbox root (use /unjail to disable)", p)
}

func (en *rtEntry) checkPath(p string) error {
	if isNullDevicePath(p) {
		return nil
	}
	if err := en.checkJailPath(p); err != nil {
		return err
	}
	if len(en.fsReadRoots) == 0 {
		return nil
	}
	resolved := en.resolvePath(p)
	target, err := canonicalOrParentPath(resolved)
	if err != nil {
		return fmt.Errorf("EACCES: permission denied: cannot resolve path %q: %v", p, err)
	}
	return checkScopedTarget("read", p, target, en.fsReadRoots)
}

func (en *rtEntry) checkPathNoFollow(p string) error {
	if isNullDevicePath(p) {
		return nil
	}
	if err := en.checkJailPathNoFollow(p); err != nil {
		return err
	}
	if len(en.fsReadRoots) == 0 {
		return nil
	}
	resolved := en.resolvePath(p)
	target, err := canonicalOrParentPathNoFollow(resolved)
	if err != nil {
		return fmt.Errorf("EACCES: permission denied: cannot resolve path %q: %v", p, err)
	}
	return checkScopedTarget("read", p, target, en.fsReadRoots)
}

func (en *rtEntry) checkWritePath(p string) error {
	if isNullDevicePath(p) {
		return nil
	}
	if err := en.checkJailPath(p); err != nil {
		return err
	}
	en.mu.Lock()
	roRoots := en.readOnlyRoots
	wScopes := en.fsWriteRoots
	en.mu.Unlock()
	if len(roRoots) == 0 && len(wScopes) == 0 {
		return nil
	}
	resolved := en.resolvePath(p)
	target, err := canonicalOrParentPath(resolved)
	if err != nil {
		return fmt.Errorf("EACCES: read-only mode: cannot resolve path %q: %v", p, err)
	}
	for _, root := range roRoots {
		if root == "" {
			continue
		}
		rootAbs, rerr := canonicalOrParentPath(root)
		if rerr != nil {
			continue
		}
		if isUnderPath(rootAbs, target) {
			return fmt.Errorf("EACCES: read-only mode: write to %q is not allowed in read-only mode", p)
		}
	}
	return checkScopedTarget("write", p, target, wScopes)
}

func (en *rtEntry) checkWritePathNoFollow(p string) error {
	if isNullDevicePath(p) {
		return nil
	}
	if err := en.checkJailPathNoFollow(p); err != nil {
		return err
	}
	en.mu.Lock()
	roRoots := en.readOnlyRoots
	wScopes := en.fsWriteRoots
	en.mu.Unlock()
	if len(roRoots) == 0 && len(wScopes) == 0 {
		return nil
	}
	resolved := en.resolvePath(p)
	target, err := canonicalOrParentPathNoFollow(resolved)
	if err != nil {
		return fmt.Errorf("EACCES: read-only mode: cannot resolve path %q: %v", p, err)
	}
	for _, root := range roRoots {
		if root == "" {
			continue
		}
		rootAbs, rerr := canonicalOrParentPath(root)
		if rerr != nil {
			continue
		}
		if isUnderPath(rootAbs, target) {
			return fmt.Errorf("EACCES: read-only mode: write to %q is not allowed in read-only mode", p)
		}
	}
	return checkScopedTarget("write", p, target, wScopes)
}

func (en *rtEntry) checkNetHost(host string) error {
	en.mu.Lock()
	allow := en.netAllow
	en.mu.Unlock()
	if len(allow) == 0 {
		return nil
	}
	if len(allow) == 1 && allow[0] == "__NONE__" {
		return fmt.Errorf("EACCES: permission denied: this agent has no network permission (blocked %q)", host)
	}
	h := strings.ToLower(strings.TrimSpace(host))
	if h == "" {
		return fmt.Errorf("EACCES: permission denied: empty network host")
	}
	bareHost := h
	if sh, _, err := net.SplitHostPort(h); err == nil && sh != "" {
		bareHost = sh
	}
	bareHost = strings.Trim(bareHost, "[]")
	for _, pat := range allow {
		p := strings.ToLower(strings.TrimSpace(pat))
		if p == "" || p == "__NONE__" {
			continue
		}
		if p == "*" || p == h || p == bareHost {
			return nil
		}
		if strings.HasPrefix(p, "*.") && strings.HasSuffix(bareHost, p[1:]) {
			return nil
		}
	}
	return fmt.Errorf("EACCES: permission denied: network host %q is outside declared allowlist", host)
}

func evalPathSymlinksAndJunctionsEx(p string, allowMissingLeaf bool) (string, error) {
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
				if allowMissingLeaf && (errors.Is(lerr, os.ErrNotExist) || strings.ContainsAny(part, "*?<>\"|")) {
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
	return "", fmt.Errorf("ELOOP: too many symbolic links encountered: %s", p)
}

func evalPathSymlinksAndJunctions(p string) (string, error) {
	return evalPathSymlinksAndJunctionsEx(p, false)
}

func canonicalOrParentPath(p string) (string, error) {
	return evalPathSymlinksAndJunctionsEx(p, true)
}

func canonicalOrParentPathNoFollow(p string) (string, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	clean := filepath.Clean(abs)
	parent := filepath.Dir(clean)
	if parent == clean {
		return clean, nil
	}
	realParent, err := canonicalOrParentPath(parent)
	if err != nil {
		return "", err
	}
	return filepath.Clean(filepath.Join(realParent, filepath.Base(clean))), nil
}

func isUnderPath(root, target string) bool {
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

func mapOSPlatform() string {
	switch runtime.GOOS {
	case "windows":
		return "win32"
	default:
		return runtime.GOOS
	}
}

func mapOSArch() string {
	switch runtime.GOARCH {
	case "amd64":
		return "x64"
	case "386":
		return "ia32"
	default:
		return runtime.GOARCH
	}
}

func classifyOSError(op, path string, err error) (string, error) {
	if err == nil {
		return "", nil
	}
	rawMsg := err.Error()
	for _, known := range []string{
		"ENOENT", "EACCES", "EPERM", "EEXIST", "EISDIR", "ENOTDIR",
		"ENOTEMPTY", "EINVAL", "EBADF", "ENOSYS", "EXDEV", "EBUSY",
		"EMFILE", "ENFILE", "ENOSPC", "EROFS", "EIO", "ELOOP", "ENAMETOOLONG",
	} {
		if strings.HasPrefix(rawMsg, known+":") {
			return known, err
		}
	}
	code := "EIO"
	msgLower := strings.ToLower(rawMsg)
	switch {
	case errors.Is(err, os.ErrNotExist) ||
		strings.Contains(msgLower, "no such file or directory") ||
		strings.Contains(msgLower, "cannot find the file") ||
		strings.Contains(msgLower, "cannot find the path"):
		code = "ENOENT"
	case errors.Is(err, syscall.ENOTEMPTY) ||
		strings.Contains(msgLower, "directory is not empty") ||
		strings.Contains(msgLower, "directory not empty") ||
		(op == "rmdir" && errors.Is(err, os.ErrExist)):
		code = "ENOTEMPTY"
	case errors.Is(err, os.ErrExist):
		code = "EEXIST"
	case errors.Is(err, os.ErrPermission):
		code = "EACCES"
	case errors.Is(err, syscall.EISDIR):
		code = "EISDIR"
	case errors.Is(err, syscall.ENOTDIR):
		code = "ENOTDIR"
	case errors.Is(err, syscall.EINVAL):
		code = "EINVAL"
	case errors.Is(err, syscall.ENOSYS):
		code = "ENOSYS"
	default:
		switch {
		case strings.Contains(msgLower, "not supported by windows"):
			code = "ENOSYS"
		case strings.Contains(msgLower, "is a directory") || strings.Contains(msgLower, "incorrect function"):
			code = "EISDIR"
		case strings.Contains(msgLower, "not a directory"):
			code = "ENOTDIR"
		case strings.Contains(msgLower, "directory not empty") || strings.Contains(msgLower, "directory is not empty"):
			code = "ENOTEMPTY"
		}
	}
	if path != "" {
		return code, fmt.Errorf("%s: %w, %s '%s'", code, err, op, path)
	}
	return code, fmt.Errorf("%s: %w", code, err)
}

func (en *rtEntry) handleHostCall(op string, argsStr string, inBin []byte) (outJSON string, outBin []byte, hasBin bool, errCode string, err error) {
	switch op {
	case "runtime.init":
		return en.opRuntimeInit()
	case "process.cwd":
		return en.getCWD(), nil, false, "", nil
	case "process.chdir":
		return en.opProcessChdir(argsStr)
	case "process.setEnv":
		return en.opProcessSetEnv(argsStr)
	case "process.deleteEnv":
		return en.opProcessDeleteEnv(argsStr)
	case "process.stdinRead":
		return en.opProcessStdinRead(argsStr)
	case "process.stdinPoll":
		return en.opProcessStdinPoll(argsStr)
	case "process.stdinStart":
		return en.opProcessStdinStart()
	case "process.stdinStop":
		en.stdinMu.Lock()
		en.stdinAsyncStarted = false
		en.stdinMu.Unlock()
		return "", nil, false, "", nil
	case "process.stdinPull":
		if en.stdinCredits != nil {
			select {
			case en.stdinCredits <- struct{}{}:
			default:
			}
		}
		return "", nil, false, "", nil
	case "worker.start":
		return en.opWorkerStart()
	case "worker.listen":
		return en.opWorkerListen(argsStr)
	case "worker.send":
		return en.opWorkerSend(argsStr, inBin)
	case "worker.close":
		return en.opWorkerClose(argsStr)
	case "process.hrtime":
		ns := time.Since(en.startTime).Nanoseconds()
		return strconv.FormatInt(ns, 10), nil, false, "", nil
	case "process.memoryUsage":
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		b, _ := json.Marshal(map[string]uint64{
			"rss":          m.Sys,
			"heapTotal":    m.HeapSys,
			"heapUsed":     m.HeapAlloc,
			"external":     m.OtherSys,
			"arrayBuffers": 0,
		})
		return string(b), nil, false, "", nil
	case "process.kill":
		return en.opProcessKill(argsStr)

	// Timers
	case "timer.start":
		return en.opTimerStart(argsStr)
	case "timer.cancel":
		return en.opTimerCancel(argsStr)

	// Module resolution for CJS require()
	case "module.resolve":
		return en.opModuleResolve(argsStr)

	// Filesystem
	case "fs.readFile":
		return en.opFSReadFile(argsStr)
	case "fs.writeFile":
		return en.opFSWriteFile(argsStr, inBin)
	case "fs.appendFile":
		return en.opFSAppendFile(argsStr, inBin)
	case "fs.exists":
		return en.opFSExists(argsStr)
	case "fs.stat":
		return en.opFSStat(argsStr, false)
	case "fs.lstat":
		return en.opFSStat(argsStr, true)
	case "fs.readdir":
		return en.opFSReaddir(argsStr)
	case "fs.mkdir":
		return en.opFSMkdir(argsStr)
	case "fs.rm":
		return en.opFSRm(argsStr)
	case "fs.rmdir":
		return en.opFSRmdir(argsStr)
	case "fs.unlink":
		return en.opFSUnlink(argsStr)
	case "fs.rename":
		return en.opFSRename(argsStr)
	case "fs.copyFile":
		return en.opFSCopyFile(argsStr)
	case "fs.cp":
		return en.opFSCp(argsStr)
	case "fs.realpath":
		return en.opFSRealpath(argsStr)
	case "fs.chmod":
		return en.opFSChmod(argsStr)
	case "fs.chown":
		return en.opFSChown(argsStr)
	case "fs.lchown":
		return en.opFSLchown(argsStr)
	case "fs.utimes":
		return en.opFSUtimes(argsStr)
	case "fs.access":
		return en.opFSAccess(argsStr)
	case "fs.mkdtemp":
		return en.opFSMkdtemp(argsStr)
	case "fs.truncate":
		return en.opFSTruncate(argsStr)
	case "fs.readlink":
		return en.opFSReadlink(argsStr)
	case "fs.symlink":
		return en.opFSSymlink(argsStr)
	case "fs.link":
		return en.opFSLink(argsStr)
	case "fs.glob":
		return en.opFSGlob(argsStr)
	case "fs.open":
		return en.opFSOpen(argsStr)
	case "fs.read":
		return en.opFSReadFD(argsStr)
	case "fs.write":
		return en.opFSWriteFD(argsStr, inBin)
	case "fs.close":
		return en.opFSCloseFD(argsStr)
	case "fs.fstat":
		return en.opFSFstatFD(argsStr)
	case "fs.fchmod":
		return en.opFSFchmodFD(argsStr)
	case "fs.fchown":
		return en.opFSFchownFD(argsStr)
	case "fs.futimes":
		return en.opFSFutimesFD(argsStr)
	case "fs.ftruncate":
		return en.opFSFtruncateFD(argsStr)
	case "fs.fsync":
		return en.opFSFsyncFD(argsStr)

	// Child process & Shell ($)
	case "cp.spawnSync":
		return en.opCPSpawnSync(argsStr, inBin)
	case "cp.spawnAsync":
		return en.opCPSpawnAsync(argsStr, inBin)
	case "cp.writeStdin":
		return en.opCPWriteStdin(argsStr, inBin)
	case "cp.closeStdin":
		return en.opCPCloseStdin(argsStr)
	case "cp.killChild":
		return en.opCPKillChild(argsStr)
	case "cp.pullOutput":
		return en.opCPPullOutput(argsStr)
	case "cp.waitChild":
		return en.opCPWaitChild(argsStr)
	case "cp.setRef":
		return en.opCPSetRef(argsStr)

	// Crypto
	case "crypto.randomBytes":
		return en.opCryptoRandomBytes(argsStr)
	case "crypto.randomUUID":
		return en.opCryptoRandomUUID()
	case "crypto.hash":
		return en.opCryptoHash(argsStr, inBin)
	case "crypto.hmac":
		return en.opCryptoHmac(argsStr, inBin)
	case "crypto.pbkdf2":
		return en.opCryptoPBKDF2(argsStr, inBin)
	case "crypto.hkdf":
		return en.opCryptoHKDF(argsStr, inBin)
	case "crypto.scrypt":
		return en.opCryptoScrypt(argsStr, inBin)
	case "crypto.cipher":
		return en.opCryptoCipher(argsStr, inBin)
	case "crypto.webcrypto":
		return en.opCryptoWebCrypto(argsStr, inBin)

	// Zlib
	case "zlib.transform":
		return en.opZlibTransform(argsStr, inBin)

	// OS & DNS & Timezone
	case "os.networkInterfaces":
		return en.opOSNetworkInterfaces()
	case "os.userInfo":
		return en.opOSUserInfo()
	case "os.info":
		b, err := json.Marshal(collectOSMetrics())
		return string(b), nil, false, "", err
	case "time.tzOffset":
		return en.opTimeTZOffset(argsStr)
	case "dns.lookup":
		return en.opDNSLookup(argsStr)
	case "dns.resolve":
		return en.opDNSResolve(argsStr)

	// HTTP / Fetch / Server
	case "http.fetchAsync":
		return en.opHTTPFetchAsync(argsStr, inBin)
	case "http.writeFetchBody":
		return en.opHTTPWriteFetchBody(argsStr, inBin)
	case "http.abortFetch":
		return en.opHTTPAbortFetch(argsStr)
	case "http.pullFetch":
		return en.opHTTPPullFetch(argsStr)
	case "http.pullRequest":
		return en.opHTTPPullRequest(argsStr)
	case "http.serverListen":
		return en.opHTTPServerListen(argsStr)
	case "http.serverRespond":
		return en.opHTTPServerRespond(argsStr, inBin)
	case "http.serverStopAccept":
		return en.opHTTPServerStopAccept(argsStr)
	case "http.serverCloseConns":
		return en.opHTTPServerCloseConns(argsStr)
	case "http.serverClose":
		return en.opHTTPServerClose(argsStr)

	// TCP Net
	case "net.listen":
		return en.opNetListen(argsStr)
	case "net.closeServer":
		return en.opNetCloseServer(argsStr)
	case "net.connect":
		return en.opNetConnect(argsStr)
	case "net.write":
		return en.opNetWrite(argsStr, inBin)
	case "net.closeConn":
		return en.opNetCloseConn(argsStr)
	case "net.pullConn":
		return en.opNetPullConn(argsStr)

	// UDP Dgram
	case "dgram.bind":
		return en.opDgramBind(argsStr)
	case "dgram.send":
		return en.opDgramSend(argsStr, inBin)
	case "dgram.close":
		return en.opDgramClose(argsStr)

	// Generic async wrapper for FS / DNS operations
	case "async.call":
		return en.opAsyncCall(argsStr, inBin)

	// VM deadline
	case "vm.setDeadline":
		var req struct {
			MS int64 `json:"ms"`
		}
		_ = json.Unmarshal([]byte(argsStr), &req)
		if req.MS > 0 {
			en.vmDeadlineNano.Store(time.Now().Add(time.Duration(req.MS) * time.Millisecond).UnixNano())
		} else {
			en.vmDeadlineNano.Store(0)
		}
		return "", nil, false, "", nil

	default:
		return "", nil, false, "ERR_UNKNOWN_OP", fmt.Errorf("unknown host operation %q", op)
	}
}

func (en *rtEntry) opRuntimeInit() (string, []byte, bool, string, error) {
	en.mu.Lock()
	defer en.mu.Unlock()

	home, _ := os.UserHomeDir()
	host, _ := os.Hostname()
	numCPU := runtime.NumCPU()
	if numCPU < 1 {
		numCPU = 1
	}

	osMetrics := collectOSMetrics()
	initData := map[string]any{
		"argv":        en.argv,
		"execPath":    en.execPath,
		"cwd":         en.cwd,
		"env":         en.env,
		"platform":    mapOSPlatform(),
		"arch":        mapOSArch(),
		"pid":         os.Getpid(),
		"ppid":        os.Getppid(),
		"homedir":     home,
		"tmpdir":      os.TempDir(),
		"hostname":    host,
		"cpus":        numCPU,
		"osMetrics":   osMetrics,
		"entryFile":   en.entryFile,
		"entryDir":    en.entryDir,
		"isEvalEntry": en.isEvalEntry,
		"sep":         string(os.PathSeparator),
		"delimiter":   string(os.PathListSeparator),
	}
	b, err := json.Marshal(initData)
	return string(b), nil, false, "", err
}

func (en *rtEntry) opTimeTZOffset(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		MS *int64 `json:"ms"`
		TZ string `json:"tz"`
	}
	if argsStr != "" {
		_ = json.Unmarshal([]byte(argsStr), &req)
	}
	ms := time.Now().UnixMilli()
	if req.MS != nil {
		ms = *req.MS
	}
	explicitTZ := strings.TrimSpace(req.TZ)
	tzName := explicitTZ
	if tzName == "" {
		en.mu.Lock()
		tzName = strings.TrimSpace(en.env["TZ"])
		en.mu.Unlock()
	}
	var (
		loc *time.Location
		err error
	)
	if tzName != "" {
		loc, err = loadCachedTZLocation(tzName)
		if err != nil {
			if explicitTZ != "" {
				return "", nil, false, "RangeError", fmt.Errorf("Invalid time zone specified: %s", explicitTZ)
			}
			loc = time.Local
		}
	} else {
		loc = time.Local
	}
	t := time.UnixMilli(ms).In(loc)
	zoneAbbr, offsetSec := t.Zone()
	tzID := loc.String()
	if tzID == "" || tzID == "Local" {
		if tzName != "" && err == nil {
			tzID = strings.TrimPrefix(tzName, ":")
		} else {
			tzID = localIANATimeZone(zoneAbbr, offsetSec)
		}
	}
	b, _ := json.Marshal(map[string]any{
		"offsetSec": offsetSec,
		"offsetMin": offsetSec / 60,
		"zone":      zoneAbbr,
		"timeZone":  tzID,
		"tz":        tzID,
	})
	return string(b), nil, false, "", nil
}

func localIANATimeZone(zoneAbbr string, offsetSec int) string {
	if runtime.GOOS != "windows" {
		if target, err := os.Readlink("/etc/localtime"); err == nil {
			if idx := strings.Index(target, "zoneinfo/"); idx >= 0 {
				cand := strings.TrimSpace(target[idx+len("zoneinfo/"):])
				if cand != "" {
					return cand
				}
			}
		}
		if b, err := os.ReadFile("/etc/timezone"); err == nil {
			if cand := strings.TrimSpace(string(b)); cand != "" {
				return cand
			}
		}
	}
	_, winterOff := time.Date(2026, 1, 15, 12, 0, 0, 0, time.Local).Zone()
	_, summerOff := time.Date(2026, 7, 15, 12, 0, 0, 0, time.Local).Zone()
	if winterOff == 0 && summerOff == 3600 {
		if strings.EqualFold(strings.TrimSpace(zoneAbbr), "BST") {
			return "Europe/London"
		}
		return "Europe/Lisbon"
	}
	switch strings.ToUpper(strings.TrimSpace(zoneAbbr)) {
	case "UTC":
		if offsetSec == 0 && winterOff == 0 && summerOff == 0 {
			return "UTC"
		}
	case "GMT":
		if offsetSec == 0 && winterOff == 0 && summerOff == 0 {
			return "UTC"
		}
		if winterOff == 0 && summerOff == 3600 {
			return "Europe/Lisbon"
		}
	case "WET", "WEST", "GDT", "GST":
		return "Europe/Lisbon"
	case "BRT", "BRST", "-03":
		if offsetSec == -10800 || offsetSec == -7200 {
			return "America/Sao_Paulo"
		}
	case "EST", "EDT":
		return "America/New_York"
	case "CST":
		if offsetSec == 28800 {
			return "Asia/Shanghai"
		}
		return "America/Chicago"
	case "CDT":
		return "America/Chicago"
	case "MST", "MDT":
		return "America/Denver"
	case "PST", "PDT":
		return "America/Los_Angeles"
	case "BST":
		if offsetSec == 3600 {
			return "Europe/London"
		}
	case "CET", "CEST":
		return "Europe/Berlin"
	case "EET", "EEST":
		return "Europe/Athens"
	case "MSK":
		return "Europe/Moscow"
	case "IST":
		if offsetSec == 19800 {
			return "Asia/Kolkata"
		}
	case "JST":
		return "Asia/Tokyo"
	case "KST":
		return "Asia/Seoul"
	case "AEST", "AEDT":
		return "Australia/Sydney"
	case "NZST", "NZDT":
		return "Pacific/Auckland"
	}
	switch offsetSec {
	case 0:
		return "UTC"
	case -3600:
		return "Atlantic/Azores"
	case -7200:
		return "America/Noronha"
	case -10800:
		return "America/Sao_Paulo"
	case -12600:
		return "America/St_Johns"
	case -14400:
		return "America/Halifax"
	case -18000:
		return "America/New_York"
	case -21600:
		return "America/Chicago"
	case -25200:
		return "America/Denver"
	case -28800:
		return "America/Los_Angeles"
	case -32400:
		return "America/Anchorage"
	case -36000:
		return "Pacific/Honolulu"
	case 3600:
		return "Europe/Berlin"
	case 7200:
		return "Europe/Athens"
	case 10800:
		return "Europe/Moscow"
	case 12600:
		return "Asia/Tehran"
	case 14400:
		return "Asia/Dubai"
	case 16200:
		return "Asia/Kabul"
	case 18000:
		return "Asia/Karachi"
	case 19800:
		return "Asia/Kolkata"
	case 20700:
		return "Asia/Kathmandu"
	case 21600:
		return "Asia/Dhaka"
	case 25200:
		return "Asia/Bangkok"
	case 28800:
		return "Asia/Shanghai"
	case 32400:
		return "Asia/Tokyo"
	case 34200:
		return "Australia/Adelaide"
	case 36000:
		return "Australia/Sydney"
	case 39600:
		return "Pacific/Noumea"
	case 43200:
		return "Pacific/Auckland"
	default:
		return "UTC"
	}
}

func (en *rtEntry) opProcessChdir(dir string) (string, []byte, bool, string, error) {
	if dir == "" {
		return "", nil, false, "ENOENT", fmt.Errorf("ENOENT: no such file or directory, chdir ''")
	}
	target := en.resolvePath(dir)
	if jerr := en.checkPath(target); jerr != nil {
		return "", nil, false, "EACCES", jerr
	}
	info, err := os.Stat(target)
	if err != nil {
		code, cerr := classifyOSError("chdir", target, err)
		return "", nil, false, code, cerr
	}
	if !info.IsDir() {
		return "", nil, false, "ENOTDIR", fmt.Errorf("ENOTDIR: not a directory, chdir '%s'", target)
	}
	en.mu.Lock()
	en.cwd = target
	en.mu.Unlock()
	return target, nil, false, "", nil
}

func (en *rtEntry) opProcessSetEnv(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	if req.Key == "" || strings.ContainsRune(req.Key, '=') || strings.ContainsRune(req.Key, 0) {
		return "", nil, false, "", nil
	}
	if nulIdx := strings.IndexByte(req.Value, 0); nulIdx >= 0 {
		req.Value = req.Value[:nulIdx]
	}
	if en.hasSandboxRestrictions() && (isBlockedJailedEnvKey(req.Key) || isRejectedJailedEnvKey(req.Key)) {
		return "", nil, false, "EACCES", fmt.Errorf("EACCES: jailed: modifying environment variable %q is not allowed in sandbox", req.Key)
	}
	en.mu.Lock()
	if runtime.GOOS == "windows" {
		for k := range en.env {
			if k != req.Key && strings.EqualFold(k, req.Key) {
				delete(en.env, k)
			}
		}
	}
	en.env[req.Key] = req.Value
	en.mu.Unlock()
	return "", nil, false, "", nil
}

func (en *rtEntry) opProcessDeleteEnv(key string) (string, []byte, bool, string, error) {
	if en.hasSandboxRestrictions() && (isBlockedJailedEnvKey(key) || isRejectedJailedEnvKey(key)) {
		return "", nil, false, "EACCES", fmt.Errorf("EACCES: jailed: deleting environment variable %q is not allowed in sandbox", key)
	}
	en.mu.Lock()
	delete(en.env, key)
	if runtime.GOOS == "windows" {
		for k := range en.env {
			if strings.EqualFold(k, key) {
				delete(en.env, k)
			}
		}
	}
	en.mu.Unlock()
	return "", nil, false, "", nil
}

const maxHostBufferBytes = 128 * 1024 * 1024

func readAllBounded(r io.Reader, maxBytes int64) ([]byte, error) {
	if maxBytes <= 0 {
		maxBytes = maxHostBufferBytes
	}
	lr := io.LimitReader(r, maxBytes+1)
	data, err := io.ReadAll(lr)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("ERR_OUT_OF_RANGE: input exceeds maximum buffer size (%d bytes)", maxBytes)
	}
	return data, nil
}

func isNonBlockingStdinReader(r io.Reader) bool {
	if r == nil {
		return true
	}
	type bufferedLen interface {
		Len() int
	}
	if _, ok := r.(bufferedLen); ok {
		return true
	}
	if f, ok := r.(*os.File); ok {
		if info, err := f.Stat(); err == nil && info.Mode().IsRegular() {
			return true
		}
	}
	return false
}

func (en *rtEntry) compactStdinLocked() {
	if en.stdinOff == 0 {
		return
	}
	if en.stdinOff >= len(en.stdinData) {
		en.stdinData = en.stdinData[:0]
		en.stdinOff = 0
		return
	}
	if en.stdinOff >= 65536 {
		en.stdinData = append(en.stdinData[:0], en.stdinData[en.stdinOff:]...)
		en.stdinOff = 0
	}
}

func (en *rtEntry) ensureStdinBgReaderLocked() {
	if en.stdinBgStarted || en.stdin == nil || en.stdinEOF {
		return
	}
	en.stdinBgStarted = true
	r := en.stdin
	go func() {
		buf := make([]byte, 32*1024)
		for {
			if en.ctx.Err() != nil {
				return
			}
			en.stdinMu.Lock()
			asyncMode := en.stdinAsyncStarted && !en.stdinSyncWait
			en.stdinMu.Unlock()
			if asyncMode && en.stdinCredits != nil {
				select {
				case <-en.stdinCredits:
				case <-en.ctx.Done():
					return
				}
			}
			n, err := r.Read(buf)
			en.stdinMu.Lock()
			if n > 0 {
				if en.stdinAsyncStarted && !en.stdinSyncWait {
					chunk := make([]byte, n)
					copy(chunk, buf[:n])
					if en.stdinNotify != nil {
						close(en.stdinNotify)
						en.stdinNotify = nil
					}
					en.stdinMu.Unlock()
					en.pushEvent(rtAsyncEvent{id: 0, kind: rtEventStdinData, bin: chunk})
					en.stdinMu.Lock()
				} else {
					en.compactStdinLocked()
					if int64(len(en.stdinData)-en.stdinOff)+int64(n) > maxHostBufferBytes {
						en.stdinOverflow = true
						en.stdinEOF = true
						if en.stdinNotify != nil {
							close(en.stdinNotify)
							en.stdinNotify = nil
						}
						en.stdinMu.Unlock()
						return
					}
					en.stdinData = append(en.stdinData, buf[:n]...)
				}
			}
			if en.stdinNotify != nil {
				close(en.stdinNotify)
				en.stdinNotify = nil
			}
			if err != nil {
				en.stdinEOF = true
				asyncStarted := en.stdinAsyncStarted && !en.stdinSyncWait
				en.stdinMu.Unlock()
				if asyncStarted {
					en.pushEvent(rtAsyncEvent{id: 0, kind: rtEventStdinEnd})
				}
				return
			}
			en.stdinMu.Unlock()
		}
	}()
}

func (en *rtEntry) opProcessStdinPoll(argsStr string) (string, []byte, bool, string, error) {
	en.stdinMu.Lock()
	if en.stdin == nil {
		en.stdinMu.Unlock()
		return `{"eof":true}`, nil, false, "", nil
	}
	wantBytes := 65536
	if argsStr != "" {
		n, err := strconv.Atoi(strings.TrimSpace(argsStr))
		if err != nil || n < 0 || int64(n) > maxHostBufferBytes {
			en.stdinMu.Unlock()
			return "", nil, false, "ERR_OUT_OF_RANGE", fmt.Errorf("ERR_OUT_OF_RANGE: The value of \"size\" is out of range. It must be >= 0 and <= %d", maxHostBufferBytes)
		}
		if n > 0 {
			wantBytes = n
		}
	}
	if en.stdinOff < len(en.stdinData) {
		rem := len(en.stdinData) - en.stdinOff
		if wantBytes < rem {
			rem = wantBytes
		}
		chunk := make([]byte, rem)
		copy(chunk, en.stdinData[en.stdinOff:en.stdinOff+rem])
		en.stdinOff += rem
		en.compactStdinLocked()
		en.stdinMu.Unlock()
		return `{"eof":false}`, chunk, true, "", nil
	}
	if en.stdinEOF {
		en.stdinMu.Unlock()
		return `{"eof":true}`, nil, false, "", nil
	}
	if en.stdinAsyncStarted {
		en.stdinMu.Unlock()
		return `{"pending":true}`, nil, false, "", nil
	}
	if isNonBlockingStdinReader(en.stdin) && !en.stdinBgStarted {
		buf := make([]byte, wantBytes)
		n, err := en.stdin.Read(buf)
		if errors.Is(err, io.EOF) {
			en.stdinEOF = true
		}
		en.stdinMu.Unlock()
		if n > 0 {
			return `{"eof":false}`, buf[:n], true, "", nil
		}
		return `{"eof":true}`, nil, false, "", nil
	}
	en.ensureStdinBgReaderLocked()
	if en.stdinNotify == nil {
		en.stdinNotify = make(chan struct{})
	}
	notify := en.stdinNotify
	en.stdinMu.Unlock()

	select {
	case <-notify:
	case <-time.After(10 * time.Millisecond):
	case <-en.ctx.Done():
	}

	en.stdinMu.Lock()
	defer en.stdinMu.Unlock()
	if en.stdinOff < len(en.stdinData) {
		rem := len(en.stdinData) - en.stdinOff
		if wantBytes < rem {
			rem = wantBytes
		}
		chunk := make([]byte, rem)
		copy(chunk, en.stdinData[en.stdinOff:en.stdinOff+rem])
		en.stdinOff += rem
		en.compactStdinLocked()
		return `{"eof":false}`, chunk, true, "", nil
	}
	if en.stdinEOF {
		return `{"eof":true}`, nil, false, "", nil
	}
	return `{"pending":true}`, nil, false, "", nil
}

func (en *rtEntry) opProcessStdinStart() (string, []byte, bool, string, error) {
	en.stdinMu.Lock()
	if en.stdinAsyncStarted {
		en.stdinMu.Unlock()
		return "", nil, false, "", nil
	}
	r := en.stdin
	var initial []byte
	if en.stdinOff < len(en.stdinData) {
		initial = make([]byte, len(en.stdinData)-en.stdinOff)
		copy(initial, en.stdinData[en.stdinOff:])
		en.stdinOff = len(en.stdinData)
		en.compactStdinLocked()
	}
	if len(initial) > 0 {
		en.pushEvent(rtAsyncEvent{id: 0, kind: rtEventStdinData, bin: initial})
	}
	en.stdinAsyncStarted = true
	alreadyEOF := en.stdinEOF
	if r != nil && !alreadyEOF {
		en.ensureStdinBgReaderLocked()
	}
	en.stdinMu.Unlock()

	if r == nil || alreadyEOF {
		en.pushEvent(rtAsyncEvent{id: 0, kind: rtEventStdinEnd})
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) wakeStdinCredit() {
	if en.stdinCredits != nil {
		select {
		case en.stdinCredits <- struct{}{}:
		default:
		}
	}
}

func (en *rtEntry) opProcessStdinRead(argsStr string) (string, []byte, bool, string, error) {
	en.stdinMu.Lock()
	trimmedArg := strings.TrimSpace(argsStr)
	waitUntilEOF := trimmedArg == "eof"
	if en.stdinAsyncStarted && !waitUntilEOF && trimmedArg == "" {
		if en.stdinOff < len(en.stdinData) {
			chunk := make([]byte, len(en.stdinData)-en.stdinOff)
			copy(chunk, en.stdinData[en.stdinOff:])
			en.stdinOff = len(en.stdinData)
			en.compactStdinLocked()
			en.stdinMu.Unlock()
			return "", chunk, true, "", nil
		}
		en.stdinMu.Unlock()
		return "", nil, true, "", nil
	}

	if en.stdin == nil {
		en.stdinMu.Unlock()
		return "", nil, true, "", nil
	}
	wantBytes := 0
	if !waitUntilEOF && trimmedArg != "" {
		n, err := strconv.Atoi(trimmedArg)
		if err != nil || n < 0 || int64(n) > maxHostBufferBytes {
			en.stdinMu.Unlock()
			return "", nil, false, "ERR_OUT_OF_RANGE", fmt.Errorf("ERR_OUT_OF_RANGE: The value of \"size\" is out of range. It must be >= 0 and <= %d", maxHostBufferBytes)
		}
		wantBytes = n
	}
	wasAsync := en.stdinAsyncStarted
	en.stdinSyncWait = true
	if waitUntilEOF {
		en.stdinAsyncStarted = false
	}
	en.wakeStdinCredit()
	defer func() {
		en.stdinMu.Lock()
		en.stdinSyncWait = false
		if wasAsync {
			en.stdinAsyncStarted = true
		}
		shouldPushEnd := wasAsync && en.stdinEOF && en.stdinOff >= len(en.stdinData)
		en.stdinMu.Unlock()
		if shouldPushEnd {
			en.pushEvent(rtAsyncEvent{id: 0, kind: rtEventStdinEnd})
		}
	}()

	if wantBytes > 0 {
		if en.stdinOff < len(en.stdinData) {
			rem := len(en.stdinData) - en.stdinOff
			if wantBytes < rem {
				rem = wantBytes
			}
			chunk := make([]byte, rem)
			copy(chunk, en.stdinData[en.stdinOff:en.stdinOff+rem])
			en.stdinOff += rem
			en.compactStdinLocked()
			en.stdinMu.Unlock()
			return "", chunk, true, "", nil
		}
		if en.stdinEOF {
			en.stdinMu.Unlock()
			return "", nil, true, "", nil
		}
		if isNonBlockingStdinReader(en.stdin) && !en.stdinBgStarted {
			buf := make([]byte, wantBytes)
			n, err := en.stdin.Read(buf)
			if errors.Is(err, io.EOF) {
				en.stdinEOF = true
			}
			en.stdinMu.Unlock()
			if n > 0 {
				return "", buf[:n], true, "", nil
			}
			return "", nil, true, "", nil
		}
		en.ensureStdinBgReaderLocked()
		for en.stdinOff >= len(en.stdinData) && !en.stdinEOF {
			en.wakeStdinCredit()
			if en.stdinNotify == nil {
				en.stdinNotify = make(chan struct{})
			}
			notify := en.stdinNotify
			en.stdinMu.Unlock()
			select {
			case <-notify:
			case <-en.ctx.Done():
				en.stdinMu.Lock()
				defer en.stdinMu.Unlock()
				return "", nil, true, "", nil
			}
			en.stdinMu.Lock()
		}
		defer en.stdinMu.Unlock()
		if en.stdinOff < len(en.stdinData) {
			rem := len(en.stdinData) - en.stdinOff
			if wantBytes < rem {
				rem = wantBytes
			}
			chunk := make([]byte, rem)
			copy(chunk, en.stdinData[en.stdinOff:en.stdinOff+rem])
			en.stdinOff += rem
			en.compactStdinLocked()
			return "", chunk, true, "", nil
		}
		return "", nil, true, "", nil
	}

	if !en.stdinEOF {
		if isNonBlockingStdinReader(en.stdin) && !en.stdinBgStarted {
			remCap := int64(maxHostBufferBytes) - int64(len(en.stdinData)-en.stdinOff)
			if remCap < 0 {
				remCap = 0
			}
			rest, rerr := readAllBounded(en.stdin, remCap)
			if rerr != nil && strings.HasPrefix(rerr.Error(), "ERR_OUT_OF_RANGE") {
				en.stdinMu.Unlock()
				return "", nil, false, "ERR_FS_FILE_TOO_LARGE", fmt.Errorf("ERR_FS_FILE_TOO_LARGE: File size is greater than maximum buffer (%d)", maxHostBufferBytes)
			}
			en.stdinEOF = true
			if len(rest) > 0 {
				en.stdinData = append(en.stdinData, rest...)
			}
		} else if waitUntilEOF {
			en.ensureStdinBgReaderLocked()
			for !en.stdinEOF {
				en.wakeStdinCredit()
				if en.stdinNotify == nil {
					en.stdinNotify = make(chan struct{})
				}
				notify := en.stdinNotify
				en.stdinMu.Unlock()
				select {
				case <-notify:
				case <-en.ctx.Done():
					en.stdinMu.Lock()
					goto doneWait
				}
				en.stdinMu.Lock()
			}
		doneWait:
		} else {
			en.ensureStdinBgReaderLocked()
			if en.stdinOff >= len(en.stdinData) && !en.stdinEOF {
				en.wakeStdinCredit()
				if en.stdinNotify == nil {
					en.stdinNotify = make(chan struct{})
				}
				notify := en.stdinNotify
				en.stdinMu.Unlock()
				select {
				case <-notify:
				case <-time.After(10 * time.Millisecond):
				case <-en.ctx.Done():
				}
				en.stdinMu.Lock()
			}
		}
	}
	defer en.stdinMu.Unlock()
	if en.stdinOverflow {
		return "", nil, false, "ERR_FS_FILE_TOO_LARGE", fmt.Errorf("ERR_FS_FILE_TOO_LARGE: File size is greater than maximum buffer (%d)", maxHostBufferBytes)
	}
	if en.stdinOff >= len(en.stdinData) {
		return "", nil, true, "", nil
	}
	chunk := make([]byte, len(en.stdinData)-en.stdinOff)
	copy(chunk, en.stdinData[en.stdinOff:])
	en.stdinOff = len(en.stdinData)
	en.compactStdinLocked()
	return "", chunk, true, "", nil
}

type rtWorkerChannel struct {
	mu           sync.Mutex
	ln           net.Listener
	conn         net.Conn
	pending      [][]byte
	pendingBytes int64
	notify       chan struct{}
	writeDone    chan struct{}
	credits      chan struct{}
	stopping     bool
	closed       bool
	done         chan struct{}
}

func makeWorkerCredits() chan struct{} {
	c := make(chan struct{}, 64)
	for range 64 {
		c <- struct{}{}
	}
	return c
}

func pumpWorkerWrites(wc *rtWorkerChannel) {
	defer func() {
		if wc.writeDone != nil {
			close(wc.writeDone)
		}
	}()
	for {
		wc.mu.Lock()
		for len(wc.pending) == 0 && !wc.closed && !wc.stopping {
			wc.mu.Unlock()
			_, ok := <-wc.notify
			if !ok {
				return
			}
			wc.mu.Lock()
		}
		if wc.closed || (wc.stopping && len(wc.pending) == 0) {
			wc.mu.Unlock()
			return
		}
		batch := wc.pending
		wc.pending = nil
		wc.pendingBytes = 0
		conn := wc.conn
		wc.mu.Unlock()
		if conn == nil {
			return
		}
		for _, frame := range batch {
			if _, err := conn.Write(frame); err != nil {
				return
			}
		}
	}
}

func pumpWorkerFrames(en *rtEntry, id int32, conn net.Conn, credits chan struct{}, done chan struct{}) {
	defer func() {
		_ = conn.Close()
		if done != nil {
			close(done)
		}
	}()
	var hdr [4]byte
	for {
		if _, err := io.ReadFull(conn, hdr[:]); err != nil {
			en.pushEvent(rtAsyncEvent{id: id, kind: rtEventWorkerMessage, json: "eof"})
			return
		}
		frameLen := int(binary.BigEndian.Uint32(hdr[:]))
		if frameLen < 0 || int64(frameLen) > maxHostBufferBytes {
			return
		}
		payload := make([]byte, frameLen)
		if frameLen > 0 {
			if _, err := io.ReadFull(conn, payload); err != nil {
				return
			}
		}
		if credits != nil {
			select {
			case <-credits:
			case <-en.ctx.Done():
				return
			}
		}
		en.pushEvent(rtAsyncEvent{id: id, kind: rtEventWorkerMessage, bin: payload})
	}
}

func (en *rtEntry) opWorkerListen(argsStr string) (string, []byte, bool, string, error) {
	id64, err := strconv.ParseInt(strings.TrimSpace(argsStr), 10, 32)
	if err != nil {
		return "", nil, false, "EINVAL", err
	}
	id := int32(id64)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", nil, false, "EIO", err
	}
	wc := &rtWorkerChannel{
		ln:        ln,
		notify:    make(chan struct{}, 1),
		writeDone: make(chan struct{}),
		credits:   makeWorkerCredits(),
		done:      make(chan struct{}),
	}
	en.workerChansMu.Lock()
	en.workerChans[id] = wc
	en.workerChansMu.Unlock()

	go func() {
		conn, err := ln.Accept()
		_ = ln.Close()
		if err != nil {
			close(wc.writeDone)
			close(wc.done)
			return
		}
		wc.mu.Lock()
		if wc.closed {
			wc.mu.Unlock()
			_ = conn.Close()
			close(wc.writeDone)
			close(wc.done)
			return
		}
		wc.conn = conn
		select {
		case wc.notify <- struct{}{}:
		default:
		}
		wc.mu.Unlock()
		go pumpWorkerWrites(wc)
		pumpWorkerFrames(en, id, conn, wc.credits, wc.done)
	}()

	port := ln.Addr().(*net.TCPAddr).Port
	return strconv.Itoa(port), nil, false, "", nil
}

func (en *rtEntry) ensureChildWorkerChannel() (*rtWorkerChannel, error) {
	en.workerChansMu.Lock()
	wc := en.workerChans[0]
	if wc != nil {
		en.workerChansMu.Unlock()
		return wc, nil
	}
	en.mu.Lock()
	portStr := en.env["__INDIRECT_WT_CTL_PORT"]
	en.mu.Unlock()
	if portStr == "" {
		en.workerChansMu.Unlock()
		return nil, fmt.Errorf("missing worker control port")
	}
	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", portStr), 5*time.Second)
	if err != nil {
		en.workerChansMu.Unlock()
		return nil, err
	}
	wc = &rtWorkerChannel{
		conn:      conn,
		notify:    make(chan struct{}, 1),
		writeDone: make(chan struct{}),
		credits:   makeWorkerCredits(),
		done:      make(chan struct{}),
	}
	en.workerChans[0] = wc
	en.workerChansMu.Unlock()
	go pumpWorkerWrites(wc)
	go pumpWorkerFrames(en, 0, conn, wc.credits, wc.done)
	return wc, nil
}

func (en *rtEntry) opWorkerStart() (string, []byte, bool, string, error) {
	en.stdinMu.Lock()
	if en.workerReaderStarted {
		en.stdinMu.Unlock()
		return "", nil, false, "", nil
	}
	en.workerReaderStarted = true
	en.stdinMu.Unlock()
	if _, err := en.ensureChildWorkerChannel(); err != nil {
		en.pushEvent(rtAsyncEvent{id: 0, kind: rtEventWorkerMessage, json: "eof"})
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) opWorkerSend(argsStr string, payload []byte) (string, []byte, bool, string, error) {
	id64, err := strconv.ParseInt(strings.TrimSpace(argsStr), 10, 32)
	if err != nil {
		return "", nil, false, "EINVAL", err
	}
	id := int32(id64)
	var wc *rtWorkerChannel
	if id == 0 {
		wc, err = en.ensureChildWorkerChannel()
		if err != nil {
			return "", nil, false, "", nil
		}
	} else {
		en.workerChansMu.Lock()
		wc = en.workerChans[id]
		en.workerChansMu.Unlock()
		if wc == nil {
			return "", nil, false, "", nil
		}
	}
	frame := make([]byte, 4+len(payload))
	binary.BigEndian.PutUint32(frame[:4], uint32(len(payload)))
	copy(frame[4:], payload)

	wc.mu.Lock()
	if wc.closed || wc.stopping {
		wc.mu.Unlock()
		return "", nil, false, "", nil
	}
	if wc.pendingBytes+int64(len(frame)) > maxHostBufferBytes {
		wc.mu.Unlock()
		return "", nil, false, "ERR_OUT_OF_RANGE", fmt.Errorf("worker channel send buffer exceeded %d bytes", maxHostBufferBytes)
	}
	wc.pending = append(wc.pending, frame)
	wc.pendingBytes += int64(len(frame))
	if wc.notify != nil {
		select {
		case wc.notify <- struct{}{}:
		default:
		}
	}
	wc.mu.Unlock()
	return "", nil, false, "", nil
}

func (en *rtEntry) opWorkerClose(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		ID   int32 `json:"id"`
		Wait bool  `json:"wait"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		id64, _ := strconv.ParseInt(strings.TrimSpace(argsStr), 10, 32)
		req.ID = int32(id64)
	}
	en.workerChansMu.Lock()
	wc := en.workerChans[req.ID]
	if !req.Wait {
		delete(en.workerChans, req.ID)
	}
	en.workerChansMu.Unlock()
	if wc == nil {
		return "", nil, false, "", nil
	}
	wc.mu.Lock()
	hasConn := wc.conn != nil
	wc.stopping = true
	if wc.notify != nil {
		select {
		case wc.notify <- struct{}{}:
		default:
		}
	}
	wc.mu.Unlock()
	if hasConn && wc.writeDone != nil {
		select {
		case <-wc.writeDone:
		case <-time.After(250 * time.Millisecond):
		case <-en.ctx.Done():
		}
	}
	if req.Wait {
		select {
		case <-wc.done:
		case <-time.After(50 * time.Millisecond):
		case <-en.ctx.Done():
		}
		en.workerChansMu.Lock()
		delete(en.workerChans, req.ID)
		en.workerChansMu.Unlock()
	}
	wc.mu.Lock()
	wc.closed = true
	if wc.notify != nil {
		select {
		case wc.notify <- struct{}{}:
		default:
		}
	}
	if wc.ln != nil {
		_ = wc.ln.Close()
	}
	if wc.conn != nil {
		_ = wc.conn.Close()
	}
	wc.mu.Unlock()
	return "", nil, false, "", nil
}

func parseKillSignal(sig any) (int, error) {
	switch v := sig.(type) {
	case nil:
		return 15, nil
	case float64:
		n := int(v)
		if float64(n) != v || n < 0 || n > 64 {
			return -1, fmt.Errorf("ERR_UNKNOWN_SIGNAL: Unknown signal: %v", sig)
		}
		return n, nil
	case int:
		if v < 0 || v > 64 {
			return -1, fmt.Errorf("ERR_UNKNOWN_SIGNAL: Unknown signal: %v", sig)
		}
		return v, nil
	case string:
		switch strings.ToUpper(strings.TrimSpace(v)) {
		case "", "SIGTERM", "15":
			return 15, nil
		case "0":
			return 0, nil
		case "SIGHUP", "1":
			return 1, nil
		case "SIGINT", "2":
			return 2, nil
		case "SIGQUIT", "3":
			return 3, nil
		case "SIGILL", "4":
			return 4, nil
		case "SIGTRAP", "5":
			return 5, nil
		case "SIGABRT", "6":
			return 6, nil
		case "SIGBUS", "7":
			return 7, nil
		case "SIGFPE", "8":
			return 8, nil
		case "SIGKILL", "9":
			return 9, nil
		case "SIGUSR1", "10":
			return 10, nil
		case "SIGSEGV", "11":
			return 11, nil
		case "SIGUSR2", "12":
			return 12, nil
		case "SIGPIPE", "13":
			return 13, nil
		case "SIGALRM", "14":
			return 14, nil
		case "SIGCHLD", "17":
			return 17, nil
		case "SIGCONT", "18":
			return 18, nil
		case "SIGSTOP", "19":
			return 19, nil
		case "SIGTSTP", "20":
			return 20, nil
		case "SIGBREAK", "21":
			return 21, nil
		case "SIGWINCH", "28":
			return 28, nil
		default:
			return -1, fmt.Errorf("ERR_UNKNOWN_SIGNAL: Unknown signal: %s", v)
		}
	default:
		return -1, fmt.Errorf("ERR_UNKNOWN_SIGNAL: Unknown signal: %v", sig)
	}
}

func isProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	if pid == os.Getpid() {
		return true
	}
	procs, err := proctable.List()
	if err != nil {
		p, ferr := os.FindProcess(pid)
		if ferr != nil || p == nil {
			return false
		}
		_ = p.Release()
		return true
	}
	for _, pr := range procs {
		if pr.PID == pid && pr.Stat != "Z" {
			return true
		}
	}
	return false
}

func (en *rtEntry) isAllowedKillTarget(targetPID int) bool {
	if targetPID == os.Getpid() {
		return true
	}
	en.mu.Lock()
	hasJail := len(en.jailRoots) > 0
	en.mu.Unlock()
	if !hasJail {
		return true
	}
	en.childMu.Lock()
	for _, ch := range en.children {
		if ch != nil && ch.cmd != nil && ch.cmd.Process != nil && ch.cmd.Process.Pid == targetPID {
			en.childMu.Unlock()
			return true
		}
	}
	en.childMu.Unlock()
	if procs, err := proctable.List(); err == nil {
		parentOf := make(map[int]int, len(procs))
		for _, pr := range procs {
			parentOf[pr.PID] = pr.PPID
		}
		selfPID := os.Getpid()
		cur := targetPID
		for step := 0; step < 64 && cur > 1; step++ {
			p, ok := parentOf[cur]
			if !ok {
				break
			}
			if p == selfPID {
				return true
			}
			cur = p
		}
	}
	return false
}

func (en *rtEntry) opProcessKill(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		PID    *int `json:"pid"`
		Signal any  `json:"signal"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "ERR_INVALID_ARG_TYPE", fmt.Errorf("ERR_INVALID_ARG_TYPE: The \"pid\" argument must be of type number")
	}
	if req.PID == nil {
		return "", nil, false, "ERR_INVALID_ARG_TYPE", fmt.Errorf("ERR_INVALID_ARG_TYPE: The \"pid\" argument must be of type number")
	}
	sigNum, err := parseKillSignal(req.Signal)
	if err != nil {
		return "", nil, false, "ERR_UNKNOWN_SIGNAL", err
	}
	if runtime.GOOS == "windows" {
		switch sigNum {
		case 10, 12, 13, 14, 17, 18, 19, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31:
			return "", nil, false, "ERR_UNKNOWN_SIGNAL", fmt.Errorf("ERR_UNKNOWN_SIGNAL: Unknown signal: %v", req.Signal)
		}
	}
	targetPID := *req.PID
	if targetPID == 0 {
		targetPID = os.Getpid()
	}
	killGroup := false
	if targetPID < 0 && -targetPID > 1 {
		targetPID = -targetPID
		killGroup = true
	}
	if targetPID <= 0 {
		return "", nil, false, "ESRCH", fmt.Errorf("ESRCH: no such process")
	}
	if targetPID >= 1_000_000_000 && targetPID < 2_000_000_000 {
		childID := int32(targetPID - 1_000_000_000)
		en.childMu.Lock()
		ch := en.children[childID]
		en.childMu.Unlock()
		if ch == nil {
			return "", nil, false, "ESRCH", fmt.Errorf("ESRCH: no such process")
		}
		if sigNum == 0 {
			return "true", nil, false, "", nil
		}
		ch.mu.Lock()
		ch.killedSignal = signalNameFromNumber(sigNum)
		ch.mu.Unlock()
		if ch.cancel != nil {
			ch.cancel()
		}
		return "true", nil, false, "", nil
	}
	if !en.isAllowedKillTarget(targetPID) {
		return "", nil, false, "EPERM", fmt.Errorf("EPERM: operation not permitted, kill %d", *req.PID)
	}
	if !isProcessAlive(targetPID) {
		return "", nil, false, "ESRCH", fmt.Errorf("ESRCH: no such process")
	}
	if sigNum == 0 {
		return "true", nil, false, "", nil
	}
	if targetPID == os.Getpid() {
		switch sigNum {
		case 17, 18, 23, 28:
			return "true", nil, false, "", nil
		}
		en.exitCode.Store(int32(128 + sigNum))
		en.exited.Store(true)
		en.cancel()
		return "true", nil, false, "", nil
	}
	sigName := signalNameFromNumber(sigNum)
	en.childMu.Lock()
	for _, ch := range en.children {
		if ch != nil && ch.cmd != nil && ch.cmd.Process != nil && ch.cmd.Process.Pid == targetPID {
			ch.mu.Lock()
			if ch.killedSignal == "" {
				ch.killedSignal = sigName
			}
			ch.mu.Unlock()
		}
	}
	en.childMu.Unlock()
	if killGroup {
		if runtime.GOOS == "windows" {
			killProcessTree(targetPID)
		} else {
			proctable.KillTree(targetPID, sigNum)
		}
		return "true", nil, false, "", nil
	}
	if runtime.GOOS == "windows" {
		if p, perr := os.FindProcess(targetPID); perr == nil && p != nil {
			_ = p.Kill()
			_ = p.Release()
		}
	} else {
		if p, perr := os.FindProcess(targetPID); perr == nil && p != nil {
			_ = p.Signal(syscall.Signal(sigNum))
			_ = p.Release()
		}
	}
	return "true", nil, false, "", nil
}

func killProcessTree(pid int) {
	if pid <= 0 {
		return
	}
	if runtime.GOOS == "windows" {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = exec.CommandContext(ctx, "taskkill", "/PID", strconv.Itoa(pid), "/T", "/F").Run()
	}
	proctable.KillTree(pid, 9)
	if p, err := os.FindProcess(pid); err == nil && p != nil {
		_ = p.Kill()
		_ = p.Release()
	}
}

// ---- Timers ----

func (en *rtEntry) opTimerStart(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		ID      int32 `json:"id"`
		DelayMs int64 `json:"delayMs"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	if req.DelayMs < 0 {
		req.DelayMs = 0
	}
	d := time.Duration(req.DelayMs) * time.Millisecond
	en.timersMu.Lock()
	if old, ok := en.timers[req.ID]; ok {
		old.Stop()
	}
	id := req.ID
	var t *time.Timer
	t = time.AfterFunc(d, func() {
		en.timersMu.Lock()
		if en.timers[id] != t {
			en.timersMu.Unlock()
			return
		}
		delete(en.timers, id)
		en.timersMu.Unlock()
		en.pushEvent(rtAsyncEvent{id: id, kind: rtEventTimer})
	})
	en.timers[id] = t
	en.timersMu.Unlock()
	return "", nil, false, "", nil
}

func (en *rtEntry) opTimerCancel(argsStr string) (string, []byte, bool, string, error) {
	id64, err := strconv.ParseInt(strings.TrimSpace(argsStr), 10, 32)
	if err != nil {
		return "", nil, false, "", nil
	}
	id := int32(id64)
	en.timersMu.Lock()
	if t, ok := en.timers[id]; ok {
		t.Stop()
		delete(en.timers, id)
	}
	en.timersMu.Unlock()
	return "", nil, false, "", nil
}

// ---- Module resolution for CJS require() ----

func (en *rtEntry) opModuleResolve(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		ID      string `json:"id"`
		BaseDir string `json:"baseDir"`
		IsESM   bool   `json:"isESM"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	if canon, ok := canonicalBuiltinName(req.ID); ok {
		return "node:" + canon, nil, false, "", nil
	}
	baseDir := req.BaseDir
	if baseDir == "" {
		baseDir = en.getCWD()
	}
	resolved, err := en.resolveModulePathEx(baseDir, req.ID, !req.IsESM)
	if err != nil {
		errCode := "MODULE_NOT_FOUND"
		if strings.HasPrefix(err.Error(), "ERR_PACKAGE_PATH_NOT_EXPORTED") {
			errCode = "ERR_PACKAGE_PATH_NOT_EXPORTED"
		}
		return "", nil, false, errCode, err
	}
	if err := en.checkPath(resolved); err != nil {
		return "", nil, false, "EACCES", err
	}
	return resolved, nil, false, "", nil
}

// ---- Filesystem operations ----

func (en *rtEntry) resolveFSPath(opName, pathArg string) (string, string, error) {
	if pathArg == "" {
		return "", "ENOENT", fmt.Errorf("ENOENT: no such file or directory, %s ''", opName)
	}
	p := en.resolvePath(pathArg)
	if err := en.checkPath(p); err != nil {
		return "", "EACCES", err
	}
	return p, "", nil
}

func (en *rtEntry) resolveFSPathNoFollow(opName, pathArg string) (string, string, error) {
	if pathArg == "" {
		return "", "ENOENT", fmt.Errorf("ENOENT: no such file or directory, %s ''", opName)
	}
	p := en.resolvePath(pathArg)
	if err := en.checkPathNoFollow(p); err != nil {
		return "", "EACCES", err
	}
	return p, "", nil
}

func (en *rtEntry) resolveFSWritePath(opName, pathArg string) (string, string, error) {
	if pathArg == "" {
		return "", "ENOENT", fmt.Errorf("ENOENT: no such file or directory, %s ''", opName)
	}
	p := en.resolvePath(pathArg)
	if err := en.checkWritePath(p); err != nil {
		return "", "EACCES", err
	}
	return p, "", nil
}

func (en *rtEntry) resolveFSWritePathNoFollow(opName, pathArg string) (string, string, error) {
	if pathArg == "" {
		return "", "ENOENT", fmt.Errorf("ENOENT: no such file or directory, %s ''", opName)
	}
	p := en.resolvePath(pathArg)
	if err := en.checkWritePathNoFollow(p); err != nil {
		return "", "EACCES", err
	}
	return p, "", nil
}

func parseJSONFileMode(v any, def fs.FileMode) (fs.FileMode, error) {
	switch m := v.(type) {
	case nil:
		return def, nil
	case float64:
		if m < 0 || m > 0o777777 {
			return 0, fmt.Errorf("ERR_OUT_OF_RANGE: The value of \"mode\" is out of range")
		}
		return fs.FileMode(uint32(m)), nil
	case string:
		if m == "" {
			return def, nil
		}
		parsed, err := strconv.ParseUint(m, 8, 32)
		if err != nil {
			parsed, err = strconv.ParseUint(m, 0, 32)
			if err != nil {
				return 0, fmt.Errorf("ERR_INVALID_ARG_VALUE: The argument 'mode' must be a 32-bit unsigned integer or an octal string. Received %q", m)
			}
		}
		return fs.FileMode(uint32(parsed)), nil
	default:
		return 0, fmt.Errorf("ERR_INVALID_ARG_TYPE: The \"mode\" argument must be of type number or string")
	}
}

func writeAllBytes(w io.Writer, data []byte) (int, error) {
	total := 0
	for total < len(data) {
		n, err := w.Write(data[total:])
		if n > 0 {
			total += n
		}
		if err != nil {
			return total, err
		}
		if n == 0 {
			return total, io.ErrShortWrite
		}
	}
	return total, nil
}

func writeAllBytesAt(w io.WriterAt, data []byte, off int64) (int, error) {
	total := 0
	for total < len(data) {
		n, err := w.WriteAt(data[total:], off+int64(total))
		if n > 0 {
			total += n
		}
		if err != nil {
			return total, err
		}
		if n == 0 {
			return total, io.ErrShortWrite
		}
	}
	return total, nil
}

func (en *rtEntry) checkSubtreeWritable(p string) error {
	if err := en.checkWritePath(p); err != nil {
		return err
	}
	en.mu.Lock()
	roRoots := en.readOnlyRoots
	wScopes := en.fsWriteRoots
	en.mu.Unlock()
	if len(roRoots) == 0 && len(wScopes) == 0 && len(en.jailRoots) == 0 {
		return nil
	}
	target, err := canonicalOrParentPath(p)
	if err != nil {
		return fmt.Errorf("EACCES: cannot resolve path %q: %v", p, err)
	}
	for _, root := range roRoots {
		if root == "" {
			continue
		}
		rootAbs, rerr := canonicalOrParentPath(root)
		if rerr != nil {
			continue
		}
		if isUnderPath(target, rootAbs) || isUnderPath(rootAbs, target) {
			return fmt.Errorf("EACCES: read-only mode: operation on %q affects read-only root", p)
		}
	}
	if info, lerr := os.Lstat(p); lerr == nil && info.IsDir() {
		return filepath.WalkDir(p, func(sub string, d fs.DirEntry, werr error) error {
			if werr != nil {
				return nil
			}
			return en.checkWritePathNoFollow(sub)
		})
	}
	return nil
}

func (en *rtEntry) openFileSandboxed(opName, p string, flags int, mode os.FileMode, isWrite bool) (*os.File, string, error) {
	if !en.hasSandboxRestrictions() || isNullDevicePath(p) {
		f, err := openFilePlatform(p, flags, mode)
		if err != nil {
			code, cerr := classifyOSError(opName, p, err)
			return nil, code, cerr
		}
		return f, "", nil
	}
	if isWrite {
		if err := en.checkWritePath(p); err != nil {
			return nil, "EACCES", err
		}
	} else {
		if err := en.checkPath(p); err != nil {
			return nil, "EACCES", err
		}
	}
	realP, err := canonicalOrParentPath(p)
	if err != nil {
		return nil, "EACCES", fmt.Errorf("EACCES: cannot resolve path %q: %v", p, err)
	}
	if isWrite {
		if err := en.checkWritePath(realP); err != nil {
			return nil, "EACCES", err
		}
	} else {
		if err := en.checkPath(realP); err != nil {
			return nil, "EACCES", err
		}
	}
	if linfo, lerr := os.Lstat(realP); lerr == nil {
		if linfo.Mode()&os.ModeSymlink != 0 || (runtime.GOOS == "windows" && linfo.Mode()&os.ModeIrregular != 0) {
			return nil, "EACCES", fmt.Errorf("EACCES: symlink traversal refused on %q", p)
		}
	}
	openFlags := flags &^ os.O_TRUNC
	f, err := openFilePlatform(realP, openFlags, mode)
	if err != nil {
		code, cerr := classifyOSError(opName, p, err)
		return nil, code, cerr
	}
	finfo, serr := f.Stat()
	linfo2, lerr2 := os.Lstat(realP)
	if serr != nil || lerr2 != nil || linfo2.Mode()&os.ModeSymlink != 0 || (runtime.GOOS == "windows" && linfo2.Mode()&os.ModeIrregular != 0) || !os.SameFile(finfo, linfo2) {
		_ = f.Close()
		return nil, "EACCES", fmt.Errorf("EACCES: race condition or symlink swap detected on %q", p)
	}
	if isWrite {
		if cerr := en.checkWritePath(realP); cerr != nil {
			_ = f.Close()
			return nil, "EACCES", cerr
		}
	} else {
		if cerr := en.checkPath(realP); cerr != nil {
			_ = f.Close()
			return nil, "EACCES", cerr
		}
	}
	if flags&os.O_TRUNC != 0 && finfo.Mode().IsRegular() {
		if terr := f.Truncate(0); terr != nil {
			_ = f.Close()
			code, cerr := classifyOSError(opName, p, terr)
			return nil, code, cerr
		}
	}
	return f, "", nil
}

func (en *rtEntry) opFSReadFile(argsStr string) (string, []byte, bool, string, error) {
	pathArg := argsStr
	var flagAny any
	if strings.HasPrefix(strings.TrimSpace(argsStr), `{"path":`) {
		var req struct {
			Path string `json:"path"`
			Flag any    `json:"flag"`
		}
		if err := json.Unmarshal([]byte(argsStr), &req); err == nil && req.Path != "" {
			pathArg = req.Path
			flagAny = req.Flag
		}
	}
	if pathArg == "/dev/stdin" || pathArg == "/dev/fd/0" {
		return en.opProcessStdinRead("eof")
	}
	flags, err := parseOpenFlagAny(flagAny, os.O_RDONLY)
	if err != nil {
		return "", nil, false, "ERR_INVALID_OPT_VALUE", err
	}
	isWriteOpen := flags&(os.O_WRONLY|os.O_RDWR|os.O_CREATE|os.O_TRUNC|os.O_APPEND) != 0
	var p, errCode string
	if isWriteOpen {
		p, errCode, err = en.resolveFSWritePath("open", pathArg)
	} else {
		p, errCode, err = en.resolveFSPath("open", pathArg)
	}
	if err != nil {
		return "", nil, false, errCode, err
	}
	f, code, cerr := en.openFileSandboxed("open", p, flags, 0o666, isWriteOpen)
	if cerr != nil {
		return "", nil, false, code, cerr
	}
	defer f.Close()
	if info, serr := f.Stat(); serr == nil {
		if info.IsDir() {
			return "", nil, false, "EISDIR", fmt.Errorf("EISDIR: illegal operation on a directory, read '%s'", p)
		}
		if info.Size() > maxHostBufferBytes {
			return "", nil, false, "ERR_FS_FILE_TOO_LARGE", fmt.Errorf("ERR_FS_FILE_TOO_LARGE: File size (%d) is greater than maximum buffer (%d)", info.Size(), maxHostBufferBytes)
		}
	}
	data, err := readAllBounded(f, maxHostBufferBytes)
	if err != nil {
		if strings.HasPrefix(err.Error(), "ERR_OUT_OF_RANGE") {
			return "", nil, false, "ERR_FS_FILE_TOO_LARGE", err
		}
		code, cerr := classifyOSError("read", p, err)
		return "", nil, false, code, cerr
	}
	return "", data, true, "", nil
}

func (en *rtEntry) opFSWriteFile(argsStr string, data []byte) (string, []byte, bool, string, error) {
	var req struct {
		Path string `json:"path"`
		Mode any    `json:"mode"`
		Flag any    `json:"flag"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		if strings.HasPrefix(strings.TrimSpace(argsStr), "{") {
			return "", nil, false, "EINVAL", err
		}
		req.Path = argsStr
	}
	p, errCode, err := en.resolveFSWritePath("open", req.Path)
	if err != nil {
		return "", nil, false, errCode, err
	}
	mode, err := parseJSONFileMode(req.Mode, 0o666)
	if err != nil {
		return "", nil, false, "ERR_INVALID_ARG_VALUE", err
	}
	flags, err := parseOpenFlagAny(req.Flag, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		return "", nil, false, "ERR_INVALID_OPT_VALUE", err
	}
	f, code, oerr := en.openFileSandboxed("open", p, flags, mode, true)
	if oerr != nil {
		return "", nil, false, code, oerr
	}
	_, werr := writeAllBytes(f, data)
	cerr := f.Close()
	if werr != nil {
		code, e := classifyOSError("write", p, werr)
		return "", nil, false, code, e
	}
	if cerr != nil {
		code, e := classifyOSError("close", p, cerr)
		return "", nil, false, code, e
	}
	if req.Mode != nil && mode != 0o666 {
		_ = os.Chmod(p, mode)
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) opFSAppendFile(argsStr string, data []byte) (string, []byte, bool, string, error) {
	var req struct {
		Path string `json:"path"`
		Mode any    `json:"mode"`
		Flag any    `json:"flag"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		if strings.HasPrefix(strings.TrimSpace(argsStr), `{"path":`) {
			return "", nil, false, "EINVAL", err
		}
		req.Path = argsStr
	}
	p, errCode, err := en.resolveFSWritePath("open", req.Path)
	if err != nil {
		return "", nil, false, errCode, err
	}
	mode, err := parseJSONFileMode(req.Mode, 0o666)
	if err != nil {
		return "", nil, false, "ERR_INVALID_ARG_VALUE", err
	}
	flags, err := parseOpenFlagAny(req.Flag, os.O_WRONLY|os.O_CREATE|os.O_APPEND)
	if err != nil {
		return "", nil, false, "ERR_INVALID_OPT_VALUE", err
	}
	f, code, oerr := en.openFileSandboxed("open", p, flags, mode, true)
	if oerr != nil {
		return "", nil, false, code, oerr
	}
	_, werr := writeAllBytes(f, data)
	_ = f.Close()
	if werr != nil {
		code, cerr := classifyOSError("write", p, werr)
		return "", nil, false, code, cerr
	}
	if req.Mode != nil && mode != 0o666 {
		_ = os.Chmod(p, mode)
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) opFSExists(pathArg string) (string, []byte, bool, string, error) {
	if pathArg == "" {
		return "false", nil, false, "", nil
	}
	p := en.resolvePath(pathArg)
	if err := en.checkPath(p); err != nil {
		return "false", nil, false, "", nil
	}
	_, err := os.Stat(p)
	if err == nil {
		return "true", nil, false, "", nil
	}
	return "false", nil, false, "", nil
}

func isSymlinkOrJunction(mode fs.FileMode) bool {
	return mode&fs.ModeSymlink != 0 || (runtime.GOOS == "windows" && mode&fs.ModeIrregular != 0)
}

func toPOSIXMode(mode fs.FileMode) uint32 {
	perm := uint32(mode.Perm())
	switch {
	case isSymlinkOrJunction(mode):
		return 0o120000 | perm
	case mode.IsDir():
		return 0o040000 | perm
	case mode&fs.ModeNamedPipe != 0:
		return 0o010000 | perm
	case mode&fs.ModeSocket != 0:
		return 0o140000 | perm
	case mode&fs.ModeCharDevice != 0:
		return 0o020000 | perm
	case mode&fs.ModeDevice != 0:
		return 0o060000 | perm
	default:
		return 0o100000 | perm
	}
}

func extractTimespecMs(v reflect.Value, name string) (float64, bool) {
	f := v.FieldByName(name)
	if !f.IsValid() || f.Kind() != reflect.Struct {
		return 0, false
	}
	sec := f.FieldByName("Sec")
	nsec := f.FieldByName("Nsec")
	if !sec.IsValid() || !nsec.IsValid() {
		return 0, false
	}
	return float64(sec.Int()*1e9+nsec.Int()) / 1e6, true
}

func extractUintField(v reflect.Value, name string, def uint64) uint64 {
	f := v.FieldByName(name)
	if !f.IsValid() {
		return def
	}
	switch f.Kind() {
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		return f.Uint()
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		if f.Int() >= 0 {
			return uint64(f.Int())
		}
	}
	return def
}

func formatFileInfo(info fs.FileInfo, fullPath string) map[string]any {
	mode := info.Mode()
	mtimeMs := float64(info.ModTime().UnixNano()) / 1e6
	atimeMs := mtimeMs
	ctimeMs := mtimeMs
	birthtimeMs := mtimeMs

	var (
		dev     uint64
		ino     uint64
		nlink   uint64 = 1
		uid     uint64
		gid     uint64
		rdev    uint64
		blksize uint64 = 4096
		blocks  uint64 = uint64((info.Size() + 511) / 512)
	)

	if sys := info.Sys(); sys != nil {
		rv := reflect.ValueOf(sys)
		if rv.Kind() == reflect.Ptr && !rv.IsNil() {
			rv = rv.Elem()
		}
		if rv.Kind() == reflect.Struct {
			dev = extractUintField(rv, "Dev", 0)
			ino = extractUintField(rv, "Ino", 0)
			nlink = extractUintField(rv, "Nlink", 1)
			uid = extractUintField(rv, "Uid", 0)
			gid = extractUintField(rv, "Gid", 0)
			rdev = extractUintField(rv, "Rdev", 0)
			blksize = extractUintField(rv, "Blksize", 4096)
			blocks = extractUintField(rv, "Blocks", blocks)

			if ms, ok := extractTimespecMs(rv, "Atim"); ok {
				atimeMs = ms
			} else if ms, ok := extractTimespecMs(rv, "Atimespec"); ok {
				atimeMs = ms
			}
			if ms, ok := extractTimespecMs(rv, "Ctim"); ok {
				ctimeMs = ms
			} else if ms, ok := extractTimespecMs(rv, "Ctimespec"); ok {
				ctimeMs = ms
			}
			if ms, ok := extractTimespecMs(rv, "Birthtimespec"); ok {
				birthtimeMs = ms
			}

			// Windows Win32FileAttributeData fields
			if lat := rv.FieldByName("LastAccessTime"); lat.IsValid() && lat.CanAddr() {
				if m := lat.Addr().MethodByName("Nanoseconds"); m.IsValid() {
					if res := m.Call(nil); len(res) == 1 {
						atimeMs = float64(res[0].Int()) / 1e6
					}
				}
			}
			if ct := rv.FieldByName("CreationTime"); ct.IsValid() && ct.CanAddr() {
				if m := ct.Addr().MethodByName("Nanoseconds"); m.IsValid() {
					if res := m.Call(nil); len(res) == 1 {
						birthtimeMs = float64(res[0].Int()) / 1e6
						ctimeMs = birthtimeMs
					}
				}
			}
		}
	}

	if ino == 0 {
		h := fnv.New64a()
		key := fullPath
		if key == "" {
			key = info.Name()
		} else if real, err := filepath.EvalSymlinks(key); err == nil {
			key = real
		}
		if runtime.GOOS == "windows" {
			key = strings.ToLower(filepath.Clean(key))
		}
		_, _ = h.Write([]byte(key))
		ino = (h.Sum64() & 0x1fffffffffffff) | 1
	}

	isSym := isSymlinkOrJunction(mode)
	return map[string]any{
		"dev":          dev,
		"ino":          ino,
		"nlink":        nlink,
		"uid":          uid,
		"gid":          gid,
		"rdev":         rdev,
		"blksize":      blksize,
		"blocks":       blocks,
		"size":         info.Size(),
		"mode":         toPOSIXMode(mode),
		"mtimeMs":      mtimeMs,
		"atimeMs":      atimeMs,
		"ctimeMs":      ctimeMs,
		"birthtimeMs":  birthtimeMs,
		"isFile":       mode.IsRegular(),
		"isDirectory":  mode.IsDir() && !isSym,
		"isSymlink":    isSym,
		"isFIFO":       mode&fs.ModeNamedPipe != 0,
		"isSocket":     mode&fs.ModeSocket != 0,
		"isCharDevice": mode&fs.ModeCharDevice != 0,
		"isBlockDev":   mode&fs.ModeDevice != 0 && mode&fs.ModeCharDevice == 0,
	}
}

func (en *rtEntry) opFSStat(pathArg string, lstat bool) (string, []byte, bool, string, error) {
	opName := "stat"
	var (
		p       string
		errCode string
		err     error
	)
	if lstat {
		opName = "lstat"
		p, errCode, err = en.resolveFSPathNoFollow(opName, pathArg)
	} else {
		p, errCode, err = en.resolveFSPath(opName, pathArg)
	}
	if err != nil {
		return "", nil, false, errCode, err
	}
	var info fs.FileInfo
	if lstat {
		info, err = os.Lstat(p)
	} else {
		info, err = os.Stat(p)
	}
	if err != nil {
		code, cerr := classifyOSError(opName, p, err)
		return "", nil, false, code, cerr
	}
	b, _ := json.Marshal(formatFileInfo(info, p))
	return string(b), nil, false, "", nil
}

func (en *rtEntry) opFSReaddir(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		Path      string `json:"path"`
		Recursive bool   `json:"recursive"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		if strings.HasPrefix(strings.TrimSpace(argsStr), "{") {
			return "", nil, false, "EINVAL", err
		}
		req.Path = argsStr
	}
	root, errCode, err := en.resolveFSPath("scandir", req.Path)
	if err != nil {
		return "", nil, false, errCode, err
	}
	info, serr := os.Stat(root)
	if serr != nil {
		code, cerr := classifyOSError("scandir", root, serr)
		return "", nil, false, code, cerr
	}
	if !info.IsDir() {
		return "", nil, false, "ENOTDIR", fmt.Errorf("ENOTDIR: not a directory, scandir '%s'", root)
	}
	type direntJSON struct {
		Name          string `json:"name"`
		RelPath       string `json:"relPath"`
		ParentPath    string `json:"parentPath"`
		IsFile        bool   `json:"isFile"`
		IsDirectory   bool   `json:"isDirectory"`
		IsSymlink     bool   `json:"isSymlink"`
		IsFIFO        bool   `json:"isFIFO"`
		IsSocket      bool   `json:"isSocket"`
		IsCharDevice  bool   `json:"isCharDevice"`
		IsBlockDevice bool   `json:"isBlockDev"`
	}
	var out []direntJSON
	if !req.Recursive {
		entries, err := os.ReadDir(root)
		if err != nil {
			code, cerr := classifyOSError("scandir", root, err)
			return "", nil, false, code, cerr
		}
		out = make([]direntJSON, 0, len(entries))
		for _, e := range entries {
			t := e.Type()
			isSym := isSymlinkOrJunction(t)
			out = append(out, direntJSON{
				Name:          e.Name(),
				RelPath:       e.Name(),
				ParentPath:    req.Path,
				IsFile:        t.IsRegular(),
				IsDirectory:   t.IsDir() && !isSym,
				IsSymlink:     isSym,
				IsFIFO:        t&fs.ModeNamedPipe != 0,
				IsSocket:      t&fs.ModeSocket != 0,
				IsCharDevice:  t&fs.ModeCharDevice != 0,
				IsBlockDevice: t&fs.ModeDevice != 0 && t&fs.ModeCharDevice == 0,
			})
		}
	} else {
		if _, err := os.ReadDir(root); err != nil {
			code, cerr := classifyOSError("scandir", root, err)
			return "", nil, false, code, cerr
		}
		activeRealDirs := make(map[string]bool)
		if rootReal, rerr := evalPathSymlinksAndJunctions(root); rerr == nil && rootReal != "" {
			if runtime.GOOS == "windows" {
				rootReal = strings.ToLower(filepath.Clean(rootReal))
			}
			activeRealDirs[rootReal] = true
		}
		var walkRec func(physDir, relPrefix string) error
		walkRec = func(physDir, relPrefix string) error {
			entries, rerr := os.ReadDir(physDir)
			if rerr != nil {
				return rerr
			}
			for _, d := range entries {
				p := filepath.Join(physDir, d.Name())
				if cerr := en.checkPath(p); cerr != nil {
					return cerr
				}
				rel := d.Name()
				parentPath := req.Path
				if relPrefix != "" {
					rel = filepath.Join(relPrefix, d.Name())
					parentPath = filepath.Join(req.Path, relPrefix)
				}
				t := d.Type()
				isSym := isSymlinkOrJunction(t)
				out = append(out, direntJSON{
					Name:          d.Name(),
					RelPath:       rel,
					ParentPath:    parentPath,
					IsFile:        t.IsRegular(),
					IsDirectory:   t.IsDir() && !isSym,
					IsSymlink:     isSym,
					IsFIFO:        t&fs.ModeNamedPipe != 0,
					IsSocket:      t&fs.ModeSocket != 0,
					IsCharDevice:  t&fs.ModeCharDevice != 0,
					IsBlockDevice: t&fs.ModeDevice != 0 && t&fs.ModeCharDevice == 0,
				})
				descendDir := ""
				if t.IsDir() && !isSym {
					descendDir = p
				} else if isSym {
					if tInfo, terr := os.Stat(p); terr == nil && tInfo.IsDir() {
						descendDir = p
					}
				}
				if descendDir != "" {
					realKey := ""
					if rPath, rerr := evalPathSymlinksAndJunctions(descendDir); rerr == nil && rPath != "" {
						if runtime.GOOS == "windows" {
							rPath = strings.ToLower(filepath.Clean(rPath))
						}
						realKey = rPath
					}
					if realKey != "" {
						if activeRealDirs[realKey] {
							continue
						}
						activeRealDirs[realKey] = true
					}
					if werr := walkRec(descendDir, rel); werr != nil {
						if realKey != "" {
							delete(activeRealDirs, realKey)
						}
						return werr
					}
					if realKey != "" {
						delete(activeRealDirs, realKey)
					}
				}
			}
			return nil
		}
		if werr := walkRec(root, ""); werr != nil {
			if strings.HasPrefix(werr.Error(), "EACCES:") {
				return "", nil, false, "EACCES", werr
			}
			code, cerr := classifyOSError("scandir", root, werr)
			return "", nil, false, code, cerr
		}
	}
	b, _ := json.Marshal(out)
	return string(b), nil, false, "", nil
}

func (en *rtEntry) opFSMkdir(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		Path      string `json:"path"`
		Recursive bool   `json:"recursive"`
		Mode      any    `json:"mode"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		if strings.HasPrefix(strings.TrimSpace(argsStr), "{") {
			return "", nil, false, "EINVAL", err
		}
		req.Path = argsStr
	}
	p, errCode, err := en.resolveFSWritePath("mkdir", req.Path)
	if err != nil {
		return "", nil, false, errCode, err
	}
	mode, err := parseJSONFileMode(req.Mode, 0o777)
	if err != nil {
		return "", nil, false, "ERR_INVALID_ARG_VALUE", err
	}
	if req.Recursive {
		firstCreated := ""
		cur := filepath.Clean(p)
		var missing []string
		for {
			if info, serr := os.Stat(cur); serr == nil {
				if !info.IsDir() {
					return "", nil, false, "EEXIST", fmt.Errorf("EEXIST: file already exists, mkdir '%s'", p)
				}
				break
			}
			missing = append(missing, cur)
			parent := filepath.Dir(cur)
			if parent == cur {
				break
			}
			cur = parent
		}
		if len(missing) > 0 {
			firstCreated = missing[len(missing)-1]
		}
		err = os.MkdirAll(p, mode)
		if err != nil {
			code, cerr := classifyOSError("mkdir", p, err)
			return "", nil, false, code, cerr
		}
		return firstCreated, nil, false, "", nil
	}
	err = os.Mkdir(p, mode)
	if err != nil {
		code, cerr := classifyOSError("mkdir", p, err)
		return "", nil, false, code, cerr
	}
	return p, nil, false, "", nil
}

func (en *rtEntry) opFSRm(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		Path      string `json:"path"`
		Recursive bool   `json:"recursive"`
		Force     bool   `json:"force"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		if strings.HasPrefix(strings.TrimSpace(argsStr), "{") {
			return "", nil, false, "EINVAL", err
		}
		req.Path = argsStr
	}
	if req.Path == "" {
		if req.Force {
			return "", nil, false, "", nil
		}
		return "", nil, false, "ENOENT", fmt.Errorf("ENOENT: no such file or directory, rm ''")
	}
	p := en.resolvePath(req.Path)
	if err := en.checkWritePathNoFollow(p); err != nil {
		return "", nil, false, "EACCES", err
	}
	info, lerr := os.Lstat(p)
	if lerr != nil {
		if req.Force && errors.Is(lerr, os.ErrNotExist) {
			return "", nil, false, "", nil
		}
		code, cerr := classifyOSError("rm", p, lerr)
		return "", nil, false, code, cerr
	}
	if info.IsDir() && !req.Recursive {
		return "", nil, false, "ERR_FS_EISDIR", fmt.Errorf("ERR_FS_EISDIR: Path is a directory: rm returned EISDIR (is a directory) %s", p)
	}
	if info.IsDir() && req.Recursive {
		if err := en.checkSubtreeWritable(p); err != nil {
			return "", nil, false, "EACCES", err
		}
	}
	var err error
	if req.Recursive && info.IsDir() {
		err = os.RemoveAll(p)
	} else {
		err = os.Remove(p)
	}
	if err != nil {
		if req.Force && errors.Is(err, os.ErrNotExist) {
			return "", nil, false, "", nil
		}
		code, cerr := classifyOSError("rm", p, err)
		return "", nil, false, code, cerr
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) opFSRmdir(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		Path      string `json:"path"`
		Recursive bool   `json:"recursive"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		if strings.HasPrefix(strings.TrimSpace(argsStr), "{") {
			return "", nil, false, "EINVAL", err
		}
		req.Path = argsStr
	}
	p, errCode, err := en.resolveFSWritePathNoFollow("rmdir", req.Path)
	if err != nil {
		return "", nil, false, errCode, err
	}
	info, err := os.Lstat(p)
	if err != nil {
		code, cerr := classifyOSError("rmdir", p, err)
		return "", nil, false, code, cerr
	}
	if !info.IsDir() {
		return "", nil, false, "ENOTDIR", fmt.Errorf("ENOTDIR: not a directory, rmdir '%s'", p)
	}
	if err := en.checkSubtreeWritable(p); err != nil {
		return "", nil, false, "EACCES", err
	}
	if req.Recursive {
		err = os.RemoveAll(p)
	} else {
		err = os.Remove(p)
	}
	if err != nil {
		code, cerr := classifyOSError("rmdir", p, err)
		return "", nil, false, code, cerr
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) opFSUnlink(pathArg string) (string, []byte, bool, string, error) {
	p, errCode, err := en.resolveFSWritePathNoFollow("unlink", pathArg)
	if err != nil {
		return "", nil, false, errCode, err
	}
	info, err := os.Lstat(p)
	if err != nil {
		code, cerr := classifyOSError("unlink", p, err)
		return "", nil, false, code, cerr
	}
	if info.IsDir() {
		return "", nil, false, "EISDIR", fmt.Errorf("EISDIR: illegal operation on a directory, unlink '%s'", p)
	}
	if err := os.Remove(p); err != nil {
		code, cerr := classifyOSError("unlink", p, err)
		return "", nil, false, code, cerr
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) opFSRename(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		OldPath string `json:"oldPath"`
		NewPath string `json:"newPath"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	oldP, errCode, err := en.resolveFSWritePathNoFollow("rename", req.OldPath)
	if err != nil {
		return "", nil, false, errCode, err
	}
	if err := en.checkSubtreeWritable(oldP); err != nil {
		return "", nil, false, "EACCES", err
	}
	newP, errCode, err := en.resolveFSWritePathNoFollow("rename", req.NewPath)
	if err != nil {
		return "", nil, false, errCode, err
	}
	if err := os.Rename(oldP, newP); err != nil {
		code, cerr := classifyOSError("rename", oldP, err)
		return "", nil, false, code, cerr
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) opFSCopyFile(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		Src   string `json:"src"`
		Dest  string `json:"dest"`
		Flags int    `json:"flags"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	src, errCode, err := en.resolveFSPath("copyfile", req.Src)
	if err != nil {
		return "", nil, false, errCode, err
	}
	dest, errCode, err := en.resolveFSWritePath("copyfile", req.Dest)
	if err != nil {
		return "", nil, false, errCode, err
	}
	if req.Flags&1 != 0 { // COPYFILE_EXCL
		if _, err := os.Stat(dest); err == nil {
			return "", nil, false, "EEXIST", fmt.Errorf("EEXIST: file already exists, copyfile '%s' -> '%s'", src, dest)
		}
	}
	if err := en.copySingleFile(src, dest); err != nil {
		code, cerr := classifyOSError("copyfile", src, err)
		return "", nil, false, code, cerr
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) copySingleFile(src, dest string) error {
	in, _, err := en.openFileSandboxed("open", src, os.O_RDONLY, 0, false)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	if info.IsDir() {
		return syscall.EISDIR
	}
	if dInfo, derr := os.Stat(dest); derr == nil {
		if dInfo.IsDir() {
			return syscall.EISDIR
		}
		if os.SameFile(info, dInfo) {
			return nil
		}
	}
	out, _, err := en.openFileSandboxed("open", dest, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, info.Mode().Perm(), true)
	if err != nil {
		return err
	}
	_, cerr := io.Copy(out, in)
	if closeErr := out.Close(); cerr == nil {
		cerr = closeErr
	}
	return cerr
}

func (en *rtEntry) opFSCp(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		Src          string `json:"src"`
		Dest         string `json:"dest"`
		Recursive    bool   `json:"recursive"`
		Force        *bool  `json:"force"`
		ErrorOnExist bool   `json:"errorOnExist"`
		Dereference  bool   `json:"dereference"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	force := true
	if req.Force != nil {
		force = *req.Force
	}
	src, errCode, err := en.resolveFSPath("cp", req.Src)
	if err != nil {
		return "", nil, false, errCode, err
	}
	dest, errCode, err := en.resolveFSWritePath("cp", req.Dest)
	if err != nil {
		return "", nil, false, errCode, err
	}
	var info fs.FileInfo
	if !req.Dereference {
		info, err = os.Lstat(src)
	} else {
		info, err = os.Stat(src)
	}
	if err != nil {
		code, cerr := classifyOSError("cp", src, err)
		return "", nil, false, code, cerr
	}
	srcReal, _ := canonicalOrParentPath(src)
	destReal, _ := canonicalOrParentPath(dest)
	if srcReal != "" && destReal != "" && isUnderPath(srcReal, destReal) {
		return "", nil, false, "ERR_FS_CP_EINVAL", fmt.Errorf("ERR_FS_CP_EINVAL: Invalid src or dest: cp returned EINVAL (cannot copy %s to a subdirectory of self %s)", src, dest)
	}
	if dInfo, derr := os.Stat(dest); derr == nil && os.SameFile(info, dInfo) {
		return "", nil, false, "ERR_FS_CP_EINVAL", fmt.Errorf("ERR_FS_CP_EINVAL: Invalid src or dest: cp returned EINVAL (src and dest cannot be the same) %s", dest)
	}
	if !info.IsDir() {
		if _, derr := os.Lstat(dest); derr == nil {
			if !force {
				if req.ErrorOnExist {
					return "", nil, false, "ERR_FS_CP_EEXIST", fmt.Errorf("ERR_FS_CP_EEXIST: %s already exists", dest)
				}
				return "", nil, false, "", nil
			}
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o777); err != nil {
			code, cerr := classifyOSError("cp", dest, err)
			return "", nil, false, code, cerr
		}
		if !req.Dereference {
			if linfo, lerr := os.Lstat(src); lerr == nil && isSymlinkOrJunction(linfo.Mode()) {
				if linkTarget, rerr := os.Readlink(src); rerr == nil {
					resolvedLink := linkTarget
					if !filepath.IsAbs(resolvedLink) {
						resolvedLink = filepath.Join(filepath.Dir(dest), resolvedLink)
					}
					if cerr := en.checkPath(resolvedLink); cerr != nil {
						return "", nil, false, "EACCES", cerr
					}
					_ = os.Remove(dest)
					if serr := os.Symlink(linkTarget, dest); serr != nil {
						code, cerr := classifyOSError("cp", dest, serr)
						return "", nil, false, code, cerr
					}
					return "", nil, false, "", nil
				}
			}
		}
		if err := en.copySingleFile(src, dest); err != nil {
			code, cerr := classifyOSError("cp", src, err)
			return "", nil, false, code, cerr
		}
		return "", nil, false, "", nil
	}
	if !req.Recursive {
		return "", nil, false, "EISDIR", fmt.Errorf("EISDIR: cannot copy a directory without recursive option '%s'", src)
	}
	activeReal := make(map[string]bool)
	var copyTree func(curSrc, curDest string) error
	copyTree = func(curSrc, curDest string) error {
		if realCur, rerr := evalPathSymlinksAndJunctions(curSrc); rerr == nil && realCur != "" {
			key := realCur
			if runtime.GOOS == "windows" {
				key = strings.ToLower(filepath.Clean(key))
			}
			if activeReal[key] {
				return syscall.ELOOP
			}
			activeReal[key] = true
			defer delete(activeReal, key)
		}
		return filepath.WalkDir(curSrc, func(p string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if err := en.checkPathNoFollow(p); err != nil {
				return err
			}
			rel, err := filepath.Rel(curSrc, p)
			if err != nil {
				return err
			}
			target := filepath.Join(curDest, rel)
			if err := en.checkWritePathNoFollow(target); err != nil {
				return err
			}
			if isSymlinkOrJunction(d.Type()) {
				if !req.Dereference {
					linkTarget, rerr := os.Readlink(p)
					if rerr == nil {
						resolvedLink := linkTarget
						if !filepath.IsAbs(resolvedLink) {
							resolvedLink = filepath.Join(filepath.Dir(target), resolvedLink)
						}
						if cerr := en.checkPath(resolvedLink); cerr != nil {
							return cerr
						}
						if _, derr := os.Lstat(target); derr == nil {
							if !force {
								if req.ErrorOnExist {
									return fmt.Errorf("ERR_FS_CP_EEXIST: %s already exists", target)
								}
								return nil
							}
							_ = os.Remove(target)
						}
						return os.Symlink(linkTarget, target)
					}
				}
				realSrc, err := evalPathSymlinksAndJunctions(p)
				if err != nil {
					return err
				}
				if err := en.checkPath(realSrc); err != nil {
					return err
				}
				sInfo, serr := os.Stat(realSrc)
				if serr != nil {
					return serr
				}
				if sInfo.IsDir() {
					if merr := os.MkdirAll(target, 0o777); merr != nil {
						return merr
					}
					return copyTree(realSrc, target)
				}
				if _, derr := os.Lstat(target); derr == nil {
					if !force {
						if req.ErrorOnExist {
							return fmt.Errorf("ERR_FS_CP_EEXIST: %s already exists", target)
						}
						return nil
					}
				}
				return en.copySingleFile(realSrc, target)
			}
			if d.IsDir() {
				return os.MkdirAll(target, 0o777)
			}
			if _, derr := os.Lstat(target); derr == nil {
				if !force {
					if req.ErrorOnExist {
						return fmt.Errorf("ERR_FS_CP_EEXIST: %s already exists", target)
					}
					return nil
				}
			}
			return en.copySingleFile(p, target)
		})
	}
	err = copyTree(src, dest)
	if err != nil {
		if strings.HasPrefix(err.Error(), "EACCES:") {
			return "", nil, false, "EACCES", err
		}
		if strings.HasPrefix(err.Error(), "ERR_FS_CP_EEXIST:") {
			return "", nil, false, "ERR_FS_CP_EEXIST", err
		}
		code, cerr := classifyOSError("cp", src, err)
		return "", nil, false, code, cerr
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) opFSRealpath(pathArg string) (string, []byte, bool, string, error) {
	p, errCode, err := en.resolveFSPath("realpath", pathArg)
	if err != nil {
		return "", nil, false, errCode, err
	}
	if _, err := os.Stat(p); err != nil {
		code, cerr := classifyOSError("realpath", p, err)
		return "", nil, false, code, cerr
	}
	real, err := evalPathSymlinksAndJunctions(p)
	if err != nil {
		code, cerr := classifyOSError("realpath", p, err)
		return "", nil, false, code, cerr
	}
	if abs, err := filepath.Abs(real); err == nil {
		real = abs
	}
	if err := en.checkPath(real); err != nil {
		return "", nil, false, "EACCES", err
	}
	return real, nil, false, "", nil
}

func (en *rtEntry) opFSChmod(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		Path string `json:"path"`
		Mode any    `json:"mode"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	p, errCode, err := en.resolveFSWritePath("chmod", req.Path)
	if err != nil {
		return "", nil, false, errCode, err
	}
	mode, err := parseJSONFileMode(req.Mode, 0)
	if err != nil {
		return "", nil, false, "ERR_INVALID_ARG_VALUE", err
	}
	if err := os.Chmod(p, mode); err != nil {
		code, cerr := classifyOSError("chmod", p, err)
		return "", nil, false, code, cerr
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) opFSChown(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		Path string `json:"path"`
		UID  int    `json:"uid"`
		GID  int    `json:"gid"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	p, errCode, err := en.resolveFSWritePath("chown", req.Path)
	if err != nil {
		return "", nil, false, errCode, err
	}
	if runtime.GOOS == "windows" {
		if _, serr := os.Stat(p); serr != nil {
			code, cerr := classifyOSError("chown", p, serr)
			return "", nil, false, code, cerr
		}
		return "", nil, false, "", nil
	}
	if err := os.Chown(p, req.UID, req.GID); err != nil {
		code, cerr := classifyOSError("chown", p, err)
		return "", nil, false, code, cerr
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) opFSLchown(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		Path string `json:"path"`
		UID  int    `json:"uid"`
		GID  int    `json:"gid"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	p, errCode, err := en.resolveFSWritePathNoFollow("lchown", req.Path)
	if err != nil {
		return "", nil, false, errCode, err
	}
	if runtime.GOOS == "windows" {
		if _, serr := os.Lstat(p); serr != nil {
			code, cerr := classifyOSError("lchown", p, serr)
			return "", nil, false, code, cerr
		}
		return "", nil, false, "", nil
	}
	if err := os.Lchown(p, req.UID, req.GID); err != nil {
		code, cerr := classifyOSError("lchown", p, err)
		return "", nil, false, code, cerr
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) opFSUtimes(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		Path  string  `json:"path"`
		Atime float64 `json:"atime"`
		Mtime float64 `json:"mtime"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	p, errCode, err := en.resolveFSWritePath("utime", req.Path)
	if err != nil {
		return "", nil, false, errCode, err
	}
	at := time.UnixMilli(int64(req.Atime))
	mt := time.UnixMilli(int64(req.Mtime))
	if err := os.Chtimes(p, at, mt); err != nil {
		code, cerr := classifyOSError("utime", p, err)
		return "", nil, false, code, cerr
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) opFSAccess(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		Path string `json:"path"`
		Mode int    `json:"mode"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		if strings.HasPrefix(strings.TrimSpace(argsStr), "{") {
			return "", nil, false, "EINVAL", err
		}
		req.Path = argsStr
	}
	p, errCode, err := en.resolveFSPath("access", req.Path)
	if err != nil {
		return "", nil, false, errCode, err
	}
	if req.Mode&2 != 0 {
		if err := en.checkWritePath(p); err != nil {
			return "", nil, false, "EACCES", err
		}
	}
	info, err := os.Stat(p)
	if err != nil {
		code, cerr := classifyOSError("access", p, err)
		return "", nil, false, code, cerr
	}
	perm := info.Mode().Perm()
	if req.Mode&4 != 0 && perm&0o444 == 0 {
		return "", nil, false, "EACCES", fmt.Errorf("EACCES: permission denied, access '%s'", p)
	}
	if req.Mode&2 != 0 && perm&0o222 == 0 {
		return "", nil, false, "EACCES", fmt.Errorf("EACCES: permission denied, access '%s'", p)
	}
	if req.Mode&1 != 0 && runtime.GOOS != "windows" && perm&0o111 == 0 {
		return "", nil, false, "EACCES", fmt.Errorf("EACCES: permission denied, access '%s'", p)
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) opFSMkdtemp(prefixArg string) (string, []byte, bool, string, error) {
	if prefixArg == "" {
		return "", nil, false, "EINVAL", fmt.Errorf("EINVAL: invalid argument, mkdtemp ''")
	}
	p := en.resolvePath(prefixArg)
	dir := filepath.Dir(p)
	if prefixArg == "" || strings.HasSuffix(prefixArg, "/") || strings.HasSuffix(prefixArg, "\\") {
		dir = p
	}
	if err := en.checkWritePath(dir); err != nil {
		return "", nil, false, "EACCES", err
	}
	const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
	var lastErr error
	for range 64 {
		var rnd [6]byte
		_, _ = rand.Read(rnd[:])
		var suffix [6]byte
		for i := range 6 {
			suffix[i] = chars[int(rnd[i])%len(chars)]
		}
		candRet := prefixArg + string(suffix[:])
		candFull := en.resolvePath(candRet)
		if err := en.checkWritePath(candFull); err != nil {
			return "", nil, false, "EACCES", err
		}
		err := os.Mkdir(candFull, 0o700)
		if err == nil {
			return candRet, nil, false, "", nil
		}
		lastErr = err
		if !os.IsExist(err) {
			break
		}
	}
	code, cerr := classifyOSError("mkdtemp", p, lastErr)
	return "", nil, false, code, cerr
}

func (en *rtEntry) opFSTruncate(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		Path string `json:"path"`
		Len  int64  `json:"len"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	p, errCode, err := en.resolveFSWritePath("truncate", req.Path)
	if err != nil {
		return "", nil, false, errCode, err
	}
	if err := os.Truncate(p, req.Len); err != nil {
		code, cerr := classifyOSError("truncate", p, err)
		return "", nil, false, code, cerr
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) opFSReadlink(pathArg string) (string, []byte, bool, string, error) {
	p, errCode, err := en.resolveFSPathNoFollow("readlink", pathArg)
	if err != nil {
		return "", nil, false, errCode, err
	}
	target, err := os.Readlink(p)
	if err != nil {
		code, cerr := classifyOSError("readlink", p, err)
		return "", nil, false, code, cerr
	}
	resolvedTarget := target
	if !filepath.IsAbs(resolvedTarget) {
		resolvedTarget = filepath.Join(filepath.Dir(p), resolvedTarget)
	}
	if err := en.checkPath(resolvedTarget); err != nil {
		return "", nil, false, "EACCES", err
	}
	return target, nil, false, "", nil
}

func (en *rtEntry) opFSSymlink(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		Target string `json:"target"`
		Path   string `json:"path"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	p, errCode, err := en.resolveFSWritePathNoFollow("symlink", req.Path)
	if err != nil {
		return "", nil, false, errCode, err
	}
	targetAbs := req.Target
	if !filepath.IsAbs(targetAbs) {
		targetAbs = filepath.Join(filepath.Dir(p), targetAbs)
	}
	if err := en.checkPath(targetAbs); err != nil {
		return "", nil, false, "EACCES", err
	}
	if err := os.Symlink(req.Target, p); err != nil {
		code, cerr := classifyOSError("symlink", p, err)
		return "", nil, false, code, cerr
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) jailRootForPath(p string) string {
	resolved := en.resolvePath(p)
	target, err := canonicalOrParentPath(resolved)
	if err != nil {
		return ""
	}
	var best string
	for _, root := range en.jailRoots {
		if root == "" {
			continue
		}
		rootAbs, rerr := canonicalOrParentPath(root)
		if rerr != nil {
			continue
		}
		if isUnderPath(rootAbs, target) && len(rootAbs) > len(best) {
			best = rootAbs
		}
	}
	return best
}

func (en *rtEntry) opFSLink(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		ExistingPath string `json:"existingPath"`
		NewPath      string `json:"newPath"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	oldP, errCode, err := en.resolveFSWritePath("link", req.ExistingPath)
	if err != nil {
		return "", nil, false, errCode, err
	}
	newP, errCode, err := en.resolveFSWritePath("link", req.NewPath)
	if err != nil {
		return "", nil, false, errCode, err
	}
	if len(en.jailRoots) > 0 {
		oldRoot := en.jailRootForPath(oldP)
		newRoot := en.jailRootForPath(newP)
		if oldRoot == "" || newRoot == "" || !strings.EqualFold(filepath.Clean(oldRoot), filepath.Clean(newRoot)) {
			return "", nil, false, "EACCES", fmt.Errorf("EACCES: jailed: cross-root hard link from %q to %q is not allowed", req.ExistingPath, req.NewPath)
		}
	}
	if err := os.Link(oldP, newP); err != nil {
		code, cerr := classifyOSError("link", oldP, err)
		return "", nil, false, code, cerr
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) opFSGlob(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		Pattern string   `json:"pattern"`
		CWD     string   `json:"cwd"`
		Exclude []string `json:"exclude"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		req.Pattern = argsStr
	}
	base := en.getCWD()
	if req.CWD != "" {
		base = en.resolvePath(req.CWD)
	}
	if err := en.checkPath(base); err != nil {
		return "", nil, false, "EACCES", err
	}
	var excludeRes []*regexp.Regexp
	for _, ex := range req.Exclude {
		exNorm := strings.TrimSuffix(filepath.ToSlash(ex), "/")
		if exNorm == "" {
			continue
		}
		if re, rerr := globToRegexp(exNorm); rerr == nil {
			excludeRes = append(excludeRes, re)
		}
		if reSub, rerr := globToRegexp(exNorm + "/**"); rerr == nil {
			excludeRes = append(excludeRes, reSub)
		}
	}
	matches, errCode, err := en.matchGlobWithExclude(base, req.Pattern, excludeRes)
	if err != nil {
		if errCode == "" {
			errCode = "EINVAL"
		}
		return "", nil, false, errCode, err
	}
	filtered := make([]string, 0, len(matches))
	for _, m := range matches {
		cand := m
		if !filepath.IsAbs(cand) {
			cand = filepath.Join(base, cand)
		}
		if en.checkPath(cand) != nil {
			continue
		}
		if len(excludeRes) > 0 {
			mSlash := filepath.ToSlash(m)
			mBase := filepath.Base(m)
			excluded := false
			for _, re := range excludeRes {
				if re.MatchString(mSlash) || re.MatchString(mBase) {
					excluded = true
					break
				}
			}
			if excluded {
				continue
			}
		}
		filtered = append(filtered, m)
	}
	b, _ := json.Marshal(filtered)
	return string(b), nil, false, "", nil
}

func (en *rtEntry) matchGlob(baseDir, pattern string) ([]string, string, error) {
	return en.matchGlobWithExclude(baseDir, pattern, nil)
}

func normalizeGlobDotSegments(p string) (string, bool) {
	parts := strings.Split(p, "/")
	out := make([]string, 0, len(parts))
	hasDotDot := false
	for i, seg := range parts {
		if seg == "." {
			continue
		}
		if seg == "" && i > 0 && i < len(parts)-1 {
			continue
		}
		if seg == ".." {
			hasDotDot = true
		}
		out = append(out, seg)
	}
	res := strings.Join(out, "/")
	if res == "" && p != "" {
		res = "."
	}
	return res, hasDotDot
}

func (en *rtEntry) matchGlobWithDotDot(baseDir, startDir, relPattern string, isAbsPat, dirOnly bool, excludeRes []*regexp.Regexp) ([]string, string, error) {
	if err := en.checkPath(startDir); err != nil {
		return nil, "EACCES", err
	}
	rawParts := strings.Split(relPattern, "/")
	segs := make([]string, 0, len(rawParts))
	for _, s := range rawParts {
		if s == "" || s == "." {
			continue
		}
		segs = append(segs, s)
	}
	if len(segs) == 0 {
		return []string{}, "", nil
	}
	isExcluded := func(p string) bool {
		if len(excludeRes) == 0 {
			return false
		}
		relFromBase := filepath.ToSlash(p)
		if rb, err := filepath.Rel(baseDir, p); err == nil {
			relFromBase = filepath.ToSlash(rb)
		}
		baseName := filepath.Base(p)
		for _, exRe := range excludeRes {
			if exRe.MatchString(relFromBase) || exRe.MatchString(baseName) {
				return true
			}
		}
		return false
	}
	candDirs := []string{filepath.Clean(startDir)}
	for idx := 0; idx < len(segs)-1; idx++ {
		seg := segs[idx]
		allowDot := strings.HasPrefix(seg, ".")
		var nextDirs []string
		seen := map[string]bool{}
		addDir := func(d string) {
			d = filepath.Clean(d)
			if seen[d] || en.checkPath(d) != nil {
				return
			}
			if st, err := os.Stat(d); err == nil && st.IsDir() {
				seen[d] = true
				nextDirs = append(nextDirs, d)
			}
		}
		if seg == ".." {
			for _, d := range candDirs {
				addDir(filepath.Dir(d))
			}
		} else if seg == "**" {
			for _, d := range candDirs {
				addDir(d)
				_ = filepath.WalkDir(d, func(p string, de fs.DirEntry, walkErr error) error {
					if walkErr != nil || p == d {
						return nil
					}
					if de == nil || !de.IsDir() {
						return nil
					}
					if !allowDot && strings.HasPrefix(de.Name(), ".") && de.Name() != "." && de.Name() != ".." {
						return filepath.SkipDir
					}
					if en.checkPath(p) != nil || isExcluded(p) {
						return filepath.SkipDir
					}
					addDir(p)
					return nil
				})
			}
		} else {
			segRe, err := globToRegexp(seg)
			if err != nil {
				return nil, "EINVAL", err
			}
			for _, d := range candDirs {
				entries, err := os.ReadDir(d)
				if err != nil {
					continue
				}
				for _, e := range entries {
					name := e.Name()
					if !allowDot && strings.HasPrefix(name, ".") {
						continue
					}
					if !segRe.MatchString(name) {
						continue
					}
					sub := filepath.Join(d, name)
					if isExcluded(sub) {
						continue
					}
					addDir(sub)
				}
			}
		}
		candDirs = nextDirs
		if len(candDirs) == 0 {
			return []string{}, "", nil
		}
	}

	lastSeg := segs[len(segs)-1]
	allowLastDot := strings.HasPrefix(lastSeg, ".")
	var out []string
	seenOut := map[string]bool{}
	emitMatch := func(full string) {
		full = filepath.Clean(full)
		if en.checkPath(full) != nil || isExcluded(full) {
			return
		}
		val := full
		if !isAbsPat {
			if r, err := filepath.Rel(baseDir, full); err == nil {
				val = r
			}
		}
		if !seenOut[val] {
			seenOut[val] = true
			out = append(out, val)
		}
	}
	if lastSeg == ".." {
		for _, d := range candDirs {
			parent := filepath.Dir(d)
			if st, err := os.Stat(parent); err == nil && st.IsDir() {
				emitMatch(parent)
			}
		}
	} else if lastSeg == "**" {
		for _, d := range candDirs {
			_ = filepath.WalkDir(d, func(p string, de fs.DirEntry, walkErr error) error {
				if walkErr != nil {
					return nil
				}
				if p == d {
					if isAbsPat {
						emitMatch(p)
					}
					return nil
				}
				if !allowLastDot && de != nil && strings.HasPrefix(de.Name(), ".") && de.Name() != "." && de.Name() != ".." {
					if de.IsDir() {
						return filepath.SkipDir
					}
					return nil
				}
				if en.checkPath(p) != nil || isExcluded(p) {
					if de != nil && de.IsDir() {
						return filepath.SkipDir
					}
					return nil
				}
				if dirOnly && (de == nil || !de.IsDir()) {
					return nil
				}
				emitMatch(p)
				return nil
			})
		}
	} else {
		lastRe, err := globToRegexp(lastSeg)
		if err != nil {
			return nil, "EINVAL", err
		}
		for _, d := range candDirs {
			entries, err := os.ReadDir(d)
			if err != nil {
				continue
			}
			for _, e := range entries {
				name := e.Name()
				if !allowLastDot && strings.HasPrefix(name, ".") {
					continue
				}
				if !lastRe.MatchString(name) {
					continue
				}
				full := filepath.Join(d, name)
				if dirOnly {
					st, serr := os.Stat(full)
					if serr != nil || !st.IsDir() {
						continue
					}
				}
				emitMatch(full)
			}
		}
	}
	sort.Strings(out)
	if out == nil {
		out = []string{}
	}
	return out, "", nil
}

func (en *rtEntry) matchGlobWithExclude(baseDir, pattern string, excludeRes []*regexp.Regexp) ([]string, string, error) {
	isAbsPat := filepath.IsAbs(pattern)
	if !isAbsPat {
		for strings.HasPrefix(pattern, "./") || strings.HasPrefix(pattern, `.\`) {
			pattern = pattern[2:]
		}
	}
	walkRoot := baseDir
	relPattern := filepath.ToSlash(pattern)
	dirOnly := len(relPattern) > 1 && strings.HasSuffix(relPattern, "/")
	if dirOnly {
		relPattern = strings.TrimRight(relPattern, "/")
		pattern = strings.TrimRight(pattern, `/\`)
	}
	normRel, hasDotDot := normalizeGlobDotSegments(relPattern)
	relPattern = normRel
	if !isAbsPat {
		pattern = filepath.FromSlash(normRel)
	}
	if hasDotDot && !isAbsPat {
		return en.matchGlobWithDotDot(baseDir, baseDir, relPattern, false, dirOnly, excludeRes)
	}
	isGlobMeta := func(c byte) bool {
		return c == '*' || c == '?' || c == '[' || c == '{'
	}
	if isAbsPat {
		cleanPat := filepath.FromSlash(pattern)
		prefix := cleanPat
		for i := 0; i < len(cleanPat); i++ {
			if isGlobMeta(cleanPat[i]) {
				prefix = cleanPat[:i]
				break
			}
		}
		walkRoot = filepath.Dir(prefix)
		if info, err := os.Stat(prefix); err == nil && info.IsDir() {
			walkRoot = prefix
		}
		if err := en.checkPath(walkRoot); err != nil {
			return nil, "EACCES", err
		}
		relPat, err := filepath.Rel(walkRoot, cleanPat)
		if err == nil {
			relPattern = filepath.ToSlash(relPat)
		}
	} else {
		cleanRel := filepath.FromSlash(pattern)
		prefix := cleanRel
		for i := 0; i < len(cleanRel); i++ {
			if isGlobMeta(cleanRel[i]) {
				prefix = cleanRel[:i]
				break
			}
		}
		if prefix != "" {
			candRoot := filepath.Join(baseDir, filepath.Dir(prefix))
			if err := en.checkPath(candRoot); err != nil {
				return nil, "EACCES", err
			}
		}
	}
	if !strings.Contains(relPattern, "**") && !strings.Contains(relPattern, "{") && !strings.Contains(relPattern, "*") && !strings.Contains(relPattern, "?") && !strings.Contains(relPattern, "[") {
		fullPat := filepath.Join(walkRoot, filepath.FromSlash(relPattern))
		if isAbsPat {
			fullPat = filepath.FromSlash(pattern)
		}
		if st, err := os.Lstat(fullPat); err == nil && (!dirOnly || st.IsDir()) && en.checkPath(fullPat) == nil {
			if isAbsPat {
				return []string{fullPat}, "", nil
			}
			if rel, rerr := filepath.Rel(baseDir, fullPat); rerr == nil {
				return []string{rel}, "", nil
			}
			return []string{fullPat}, "", nil
		}
		return []string{}, "", nil
	}
	re, err := globToRegexp(relPattern)
	if err != nil {
		return nil, "EINVAL", err
	}
	allowDot := strings.HasPrefix(relPattern, ".") || strings.Contains(relPattern, "/.")
	var out []string
	_ = filepath.WalkDir(walkRoot, func(p string, d fs.DirEntry, walkErr error) error {
		if en.ctx.Err() != nil {
			return en.ctx.Err()
		}
		if walkErr != nil {
			return nil
		}
		if p == walkRoot {
			if isAbsPat && relPattern == "**" && en.checkPath(p) == nil {
				out = append(out, filepath.Clean(p))
			}
			return nil
		}
		if !allowDot && d != nil && strings.HasPrefix(d.Name(), ".") && d.Name() != "." && d.Name() != ".." {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if en.checkPath(p) != nil {
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(walkRoot, p)
		if err != nil {
			return nil
		}
		slashRel := filepath.ToSlash(rel)
		if len(excludeRes) > 0 {
			relFromBase := slashRel
			if !isAbsPat {
				if rb, rerr := filepath.Rel(baseDir, p); rerr == nil {
					relFromBase = filepath.ToSlash(rb)
				}
			}
			baseName := filepath.Base(p)
			for _, exRe := range excludeRes {
				if exRe.MatchString(relFromBase) || exRe.MatchString(slashRel) || exRe.MatchString(baseName) {
					if d != nil && d.IsDir() {
						return filepath.SkipDir
					}
					return nil
				}
			}
		}
		if dirOnly && (d == nil || !d.IsDir()) {
			return nil
		}
		if re.MatchString(slashRel) {
			if isAbsPat {
				out = append(out, p)
			} else if r, err := filepath.Rel(baseDir, p); err == nil {
				out = append(out, r)
			} else {
				out = append(out, rel)
			}
		}
		return nil
	})
	if out == nil {
		out = []string{}
	}
	return out, "", nil
}

func globToRegexp(pat string) (*regexp.Regexp, error) {
	var sb strings.Builder
	sb.WriteString("^")
	inBrace := 0
	atSegStart := true
	for i := 0; i < len(pat); i++ {
		c := pat[i]
		switch c {
		case '/':
			if i+3 == len(pat) && pat[i+1] == '*' && pat[i+2] == '*' {
				sb.WriteString("(?:/[^/.][^/]*)*")
				i += 2
				atSegStart = false
			} else {
				sb.WriteByte('/')
				atSegStart = true
			}
		case '*':
			if i+1 < len(pat) && pat[i+1] == '*' {
				i++
				if i+1 < len(pat) && pat[i+1] == '/' {
					i++
					sb.WriteString("(?:[^/.][^/]*/)*")
					atSegStart = true
				} else {
					if atSegStart {
						sb.WriteString("(?:[^/.][^/]*(?:/[^/.][^/]*)*)?")
					} else {
						sb.WriteString(".*")
					}
					atSegStart = false
				}
			} else {
				if atSegStart {
					sb.WriteString("[^/.][^/]*")
				} else {
					sb.WriteString("[^/]*")
				}
				atSegStart = false
			}
		case '?':
			if atSegStart {
				sb.WriteString("[^/.]")
			} else {
				sb.WriteString("[^/]")
			}
			atSegStart = false
		case '[':
			end := strings.IndexByte(pat[i+1:], ']')
			if end >= 0 {
				inner := pat[i+1 : i+1+end]
				sb.WriteByte('[')
				if strings.HasPrefix(inner, "!") {
					sb.WriteByte('^')
					inner = inner[1:]
				}
				sb.WriteString(inner)
				sb.WriteByte(']')
				i += end + 1
			} else {
				sb.WriteString("\\[")
			}
			atSegStart = false
		case '{':
			end := strings.IndexByte(pat[i+1:], '}')
			if end >= 0 {
				inBrace++
				sb.WriteString("(?:")
			} else {
				sb.WriteString("\\{")
				atSegStart = false
			}
		case '}':
			if inBrace > 0 {
				inBrace--
				sb.WriteByte(')')
			} else {
				sb.WriteString("\\}")
			}
			atSegStart = false
		case ',':
			if inBrace > 0 {
				sb.WriteByte('|')
			} else {
				sb.WriteByte(',')
				atSegStart = false
			}
		case '.', '+', '^', '$', '(', ')', ']', '|', '\\':
			sb.WriteByte('\\')
			sb.WriteByte(c)
			atSegStart = false
		default:
			sb.WriteByte(c)
			atSegStart = false
		}
	}
	sb.WriteString("$")
	return regexp.Compile(sb.String())
}

func parseOpenFlags(flag string, def int) (int, error) {
	switch flag {
	case "":
		return def, nil
	case "r", "rs", "sr":
		return os.O_RDONLY, nil
	case "r+", "rs+", "sr+":
		return os.O_RDWR, nil
	case "w":
		return os.O_WRONLY | os.O_CREATE | os.O_TRUNC, nil
	case "wx", "xw":
		return os.O_WRONLY | os.O_CREATE | os.O_EXCL, nil
	case "w+":
		return os.O_RDWR | os.O_CREATE | os.O_TRUNC, nil
	case "wx+", "xw+":
		return os.O_RDWR | os.O_CREATE | os.O_EXCL, nil
	case "a", "as", "sa":
		return os.O_WRONLY | os.O_CREATE | os.O_APPEND, nil
	case "ax", "xa":
		return os.O_WRONLY | os.O_CREATE | os.O_APPEND | os.O_EXCL, nil
	case "a+", "as+", "sa+":
		return os.O_RDWR | os.O_CREATE | os.O_APPEND, nil
	case "ax+", "xa+":
		return os.O_RDWR | os.O_CREATE | os.O_APPEND | os.O_EXCL, nil
	default:
		return 0, fmt.Errorf("ERR_INVALID_OPT_VALUE: The value %q is invalid for option \"flags\"", flag)
	}
}

func translateNumericOpenFlags(n int) int {
	var out int
	switch n & 3 {
	case 1:
		out = os.O_WRONLY
	case 2:
		out = os.O_RDWR
	default:
		out = os.O_RDONLY
	}
	switch runtime.GOOS {
	case "windows":
		if n&(256|64) != 0 {
			out |= os.O_CREATE
		}
		if n&(1024|128) != 0 {
			out |= os.O_EXCL
		}
		if n&512 != 0 {
			out |= os.O_TRUNC
		}
		if n&8 != 0 {
			out |= os.O_APPEND
		}
		if n&4096 != 0 {
			out |= os.O_SYNC
		}
	case "darwin":
		if n&(512|64) != 0 {
			out |= os.O_CREATE
		}
		if n&2048 != 0 {
			out |= os.O_EXCL
		}
		if n&1024 != 0 {
			out |= os.O_TRUNC
		}
		if n&8 != 0 {
			out |= os.O_APPEND
		}
		if n&(128|4096) != 0 {
			out |= os.O_SYNC
		}
	default:
		if n&64 != 0 {
			out |= os.O_CREATE
		}
		if n&128 != 0 {
			out |= os.O_EXCL
		}
		if n&512 != 0 {
			out |= os.O_TRUNC
		}
		if n&(1024|8) != 0 {
			out |= os.O_APPEND
		}
		if n&(4096|1052672) != 0 {
			out |= os.O_SYNC
		}
	}
	return out
}

func parseOpenFlagAny(flagAny any, def int) (int, error) {
	switch v := flagAny.(type) {
	case nil:
		return def, nil
	case string:
		if v == "" {
			return def, nil
		}
		if n, err := strconv.Atoi(v); err == nil {
			return translateNumericOpenFlags(n), nil
		}
		return parseOpenFlags(v, def)
	case float64:
		return translateNumericOpenFlags(int(v)), nil
	default:
		return 0, fmt.Errorf("ERR_INVALID_ARG_TYPE: The \"flags\" argument must be of type string or number")
	}
}

func (en *rtEntry) opFSOpen(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		Path string `json:"path"`
		Flag any    `json:"flag"`
		Mode any    `json:"mode"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	mode, err := parseJSONFileMode(req.Mode, 0o666)
	if err != nil {
		return "", nil, false, "ERR_INVALID_ARG_VALUE", err
	}
	flags, err := parseOpenFlagAny(req.Flag, os.O_RDONLY)
	if err != nil {
		return "", nil, false, "ERR_INVALID_OPT_VALUE", err
	}
	isWriteOnly := flags&os.O_WRONLY != 0 && flags&os.O_RDWR == 0
	var p, errCode string
	if isWriteOnly {
		p, errCode, err = en.resolveFSWritePath("open", req.Path)
	} else {
		p, errCode, err = en.resolveFSPath("open", req.Path)
	}
	if err != nil {
		return "", nil, false, errCode, err
	}
	isWriteOpen := flags&(os.O_WRONLY|os.O_RDWR|os.O_CREATE|os.O_TRUNC|os.O_APPEND) != 0
	if !isWriteOnly && isWriteOpen {
		if err := en.checkWritePath(p); err != nil {
			return "", nil, false, "EACCES", err
		}
	}
	f, code, cerr := en.openFileSandboxed("open", p, flags, mode, isWriteOpen)
	if cerr != nil {
		return "", nil, false, code, cerr
	}
	en.fdsMu.Lock()
	fd := en.nextFD
	en.nextFD++
	en.fds[fd] = f
	en.fdsMu.Unlock()
	return strconv.Itoa(fd), nil, false, "", nil
}

func (en *rtEntry) getFD(fd int) (*os.File, error) {
	en.fdsMu.Lock()
	f := en.fds[fd]
	en.fdsMu.Unlock()
	if f == nil {
		return nil, fmt.Errorf("EBADF: bad file descriptor, fd %d", fd)
	}
	return f, nil
}

func (en *rtEntry) opFSReadFD(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		FD       int    `json:"fd"`
		Length   int    `json:"length"`
		Position *int64 `json:"position"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	if req.Length < 0 || int64(req.Length) > maxHostBufferBytes {
		return "", nil, false, "ERR_OUT_OF_RANGE", fmt.Errorf("ERR_OUT_OF_RANGE: The value of \"length\" is out of range. It must be >= 0 and <= %d", maxHostBufferBytes)
	}
	if req.FD == 0 {
		if req.Length <= 0 {
			return "", []byte{}, true, "", nil
		}
		return en.opProcessStdinRead(strconv.Itoa(req.Length))
	}
	f, err := en.getFD(req.FD)
	if err != nil {
		return "", nil, false, "EBADF", err
	}
	if req.Length <= 0 {
		return "", []byte{}, true, "", nil
	}
	buf := make([]byte, req.Length)
	var n int
	if req.Position != nil && *req.Position >= 0 {
		n, err = f.ReadAt(buf, *req.Position)
	} else {
		n, err = f.Read(buf)
	}
	if err != nil && !errors.Is(err, io.EOF) {
		code, cerr := classifyOSError("read", "", err)
		return "", nil, false, code, cerr
	}
	return "", buf[:n], true, "", nil
}

func (en *rtEntry) opFSWriteFD(argsStr string, data []byte) (string, []byte, bool, string, error) {
	var req struct {
		FD       int    `json:"fd"`
		Position *int64 `json:"position"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	if req.FD == 1 || req.FD == 2 {
		en.writeMu.Lock()
		defer en.writeMu.Unlock()
		var n int
		if req.FD == 2 {
			n, _ = en.stderr.Write(data)
		} else {
			n, _ = en.stdout.Write(data)
		}
		return strconv.Itoa(n), nil, false, "", nil
	}
	f, err := en.getFD(req.FD)
	if err != nil {
		return "", nil, false, "EBADF", err
	}
	if err := en.checkWritePath(f.Name()); err != nil {
		return "", nil, false, "EACCES", err
	}
	var n int
	if req.Position != nil && *req.Position >= 0 {
		n, err = writeAllBytesAt(f, data, *req.Position)
	} else {
		n, err = writeAllBytes(f, data)
	}
	if err != nil {
		code, cerr := classifyOSError("write", "", err)
		return "", nil, false, code, cerr
	}
	return strconv.Itoa(n), nil, false, "", nil
}

func (en *rtEntry) opFSCloseFD(argsStr string) (string, []byte, bool, string, error) {
	fd, err := strconv.Atoi(strings.TrimSpace(argsStr))
	if err != nil {
		return "", nil, false, "EBADF", fmt.Errorf("EBADF: invalid fd")
	}
	if fd >= 0 && fd <= 2 {
		return "", nil, false, "", nil
	}
	en.fdsMu.Lock()
	f := en.fds[fd]
	delete(en.fds, fd)
	en.fdsMu.Unlock()
	if f == nil {
		return "", nil, false, "EBADF", fmt.Errorf("EBADF: bad file descriptor")
	}
	if err := f.Close(); err != nil {
		code, cerr := classifyOSError("close", "", err)
		return "", nil, false, code, cerr
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) opFSFstatFD(argsStr string) (string, []byte, bool, string, error) {
	fd, err := strconv.Atoi(strings.TrimSpace(argsStr))
	if err != nil {
		return "", nil, false, "EBADF", fmt.Errorf("EBADF: invalid fd")
	}
	if fd >= 0 && fd <= 2 {
		var stdFile *os.File
		var stdSize int64
		switch fd {
		case 0:
			en.stdinMu.Lock()
			if f, ok := en.stdin.(*os.File); ok {
				stdFile = f
			} else if lener, ok := en.stdin.(interface{ Len() int }); ok {
				stdSize = int64(lener.Len())
			}
			en.stdinMu.Unlock()
		case 1:
			if f, ok := en.stdout.(*os.File); ok {
				stdFile = f
			}
		case 2:
			if f, ok := en.stderr.(*os.File); ok {
				stdFile = f
			}
		}
		if stdFile != nil {
			if info, serr := stdFile.Stat(); serr == nil {
				b, _ := json.Marshal(formatFileInfo(info, stdFile.Name()))
				return string(b), nil, false, "", nil
			}
		}
		nowMs := float64(time.Now().UnixNano()) / 1e6
		b, _ := json.Marshal(map[string]any{
			"size":         stdSize,
			"mode":         uint32(0o010666),
			"mtimeMs":      nowMs,
			"atimeMs":      nowMs,
			"ctimeMs":      nowMs,
			"birthtimeMs":  nowMs,
			"isFile":       false,
			"isDirectory":  false,
			"isSymlink":    false,
			"isFIFO":       true,
			"isSocket":     false,
			"isCharDevice": false,
			"isBlockDev":   false,
		})
		return string(b), nil, false, "", nil
	}
	f, err := en.getFD(fd)
	if err != nil {
		return "", nil, false, "EBADF", err
	}
	info, err := f.Stat()
	if err != nil {
		code, cerr := classifyOSError("fstat", "", err)
		return "", nil, false, code, cerr
	}
	b, _ := json.Marshal(formatFileInfo(info, f.Name()))
	return string(b), nil, false, "", nil
}

func (en *rtEntry) opFSFchownFD(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		FD  int `json:"fd"`
		UID int `json:"uid"`
		GID int `json:"gid"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	f, err := en.getFD(req.FD)
	if err != nil {
		return "", nil, false, "EBADF", err
	}
	if err := en.checkWritePath(f.Name()); err != nil {
		return "", nil, false, "EACCES", err
	}
	if runtime.GOOS == "windows" {
		if _, serr := f.Stat(); serr != nil {
			code, cerr := classifyOSError("fchown", f.Name(), serr)
			return "", nil, false, code, cerr
		}
		return "", nil, false, "", nil
	}
	if err := f.Chown(req.UID, req.GID); err != nil {
		code, cerr := classifyOSError("fchown", f.Name(), err)
		return "", nil, false, code, cerr
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) opFSFchmodFD(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		FD   int `json:"fd"`
		Mode any `json:"mode"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	f, err := en.getFD(req.FD)
	if err != nil {
		return "", nil, false, "EBADF", err
	}
	if err := en.checkWritePath(f.Name()); err != nil {
		return "", nil, false, "EACCES", err
	}
	mode, err := parseJSONFileMode(req.Mode, 0o666)
	if err != nil {
		return "", nil, false, "ERR_INVALID_ARG_VALUE", err
	}
	if err := f.Chmod(mode); err != nil {
		if runtime.GOOS == "windows" {
			if cerr := os.Chmod(f.Name(), mode); cerr == nil {
				return "", nil, false, "", nil
			}
		}
		code, cerr := classifyOSError("fchmod", f.Name(), err)
		return "", nil, false, code, cerr
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) opFSFutimesFD(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		FD    int     `json:"fd"`
		Atime float64 `json:"atime"`
		Mtime float64 `json:"mtime"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	f, err := en.getFD(req.FD)
	if err != nil {
		return "", nil, false, "EBADF", err
	}
	if err := en.checkWritePath(f.Name()); err != nil {
		return "", nil, false, "EACCES", err
	}
	at := time.UnixMilli(int64(req.Atime))
	mt := time.UnixMilli(int64(req.Mtime))
	if err := os.Chtimes(f.Name(), at, mt); err != nil {
		code, cerr := classifyOSError("futimes", f.Name(), err)
		return "", nil, false, code, cerr
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) opFSFtruncateFD(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		FD  int   `json:"fd"`
		Len int64 `json:"len"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	f, err := en.getFD(req.FD)
	if err != nil {
		return "", nil, false, "EBADF", err
	}
	if err := en.checkWritePath(f.Name()); err != nil {
		return "", nil, false, "EACCES", err
	}
	if err := f.Truncate(req.Len); err != nil {
		code, cerr := classifyOSError("ftruncate", "", err)
		return "", nil, false, code, cerr
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) opFSFsyncFD(argsStr string) (string, []byte, bool, string, error) {
	fd, err := strconv.Atoi(strings.TrimSpace(argsStr))
	if err != nil {
		return "", nil, false, "EBADF", fmt.Errorf("EBADF: invalid fd")
	}
	if fd >= 0 && fd <= 2 {
		return "", nil, false, "", nil
	}
	f, err := en.getFD(fd)
	if err != nil {
		return "", nil, false, "EBADF", err
	}
	if err := f.Sync(); err != nil {
		code, cerr := classifyOSError("fsync", "", err)
		return "", nil, false, code, cerr
	}
	return "", nil, false, "", nil
}

// ---- Child Process & Shell ($) ----

type cpSpawnReq struct {
	ID         int32             `json:"id"`
	Command    string            `json:"command"`
	Args       []string          `json:"args"`
	CWD        string            `json:"cwd"`
	Env        map[string]string `json:"env"`
	Shell      any               `json:"shell"`
	Stdio      []string          `json:"stdio"`
	TimeoutMs  int64             `json:"timeoutMs"`
	MaxBuffer  int64             `json:"maxBuffer"`
	HasInput   bool              `json:"hasInput"`
	Detached   bool              `json:"detached"`
	KillSignal any               `json:"killSignal"`
}

func resolveKillSignalName(sig any) string {
	if sig == nil {
		return "SIGTERM"
	}
	if s, ok := sig.(string); ok && strings.TrimSpace(s) == "" {
		return "SIGTERM"
	}
	sigNum, err := parseKillSignal(sig)
	if err != nil || sigNum == 0 {
		return "SIGTERM"
	}
	return signalNameFromNumber(sigNum)
}

func stdioModeAt(stdio []string, idx int) string {
	if idx >= 0 && idx < len(stdio) && stdio[idx] != "" {
		return stdio[idx]
	}
	return "pipe"
}

type boundedBufferWriter struct {
	mu       sync.Mutex
	buf      bytes.Buffer
	max      int64
	exceeded bool
	onExceed func()
}

func (w *boundedBufferWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	rem := w.max - int64(w.buf.Len())
	if int64(len(p)) > rem {
		if rem > 0 {
			_, _ = w.buf.Write(p[:rem])
		}
		if !w.exceeded {
			w.exceeded = true
			if w.onExceed != nil {
				go w.onExceed()
			}
		}
		return len(p), nil
	}
	return w.buf.Write(p)
}

func (w *boundedBufferWriter) Bytes() []byte {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := make([]byte, w.buf.Len())
	copy(out, w.buf.Bytes())
	return out
}

func (w *boundedBufferWriter) Exceeded() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.exceeded
}

func lookupShellEnvVar(env map[string]string, name string) (string, bool) {
	if v, ok := env[name]; ok {
		return v, true
	}
	if runtime.GOOS == "windows" {
		for k, v := range env {
			if strings.EqualFold(k, name) {
				return v, true
			}
		}
	}
	return "", false
}

func unescapeShellMarkers(s string) string {
	if !strings.ContainsAny(s, "\x01\x02\x03\x04\x05\x06") {
		return s
	}
	var sb strings.Builder
	sb.Grow(len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '\x01' && i+1 < len(s) {
			i++
			sb.WriteByte(s[i])
			continue
		}
		if s[i] == '\x02' || s[i] == '\x03' || s[i] == '\x04' || s[i] == '\x05' || s[i] == '\x06' {
			continue
		}
		sb.WriteByte(s[i])
	}
	return sb.String()
}

func shellGlobMatch(pat, str string) bool {
	if pat == "*" {
		return true
	}
	var sb strings.Builder
	sb.WriteString("(?s)^")
	for i := 0; i < len(pat); i++ {
		c := pat[i]
		if c == '\x01' && i+1 < len(pat) {
			i++
			sb.WriteString(regexp.QuoteMeta(string(pat[i])))
			continue
		}
		switch c {
		case '*':
			sb.WriteString(".*")
		case '?':
			sb.WriteByte('.')
		case '[':
			end := strings.IndexByte(pat[i+1:], ']')
			if end >= 0 {
				inner := pat[i+1 : i+1+end]
				sb.WriteByte('[')
				if strings.HasPrefix(inner, "!") {
					sb.WriteByte('^')
					inner = inner[1:]
				}
				sb.WriteString(inner)
				sb.WriteByte(']')
				i += end + 1
			} else {
				sb.WriteString("\\[")
			}
		default:
			sb.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	sb.WriteString("$")
	re, err := regexp.Compile(sb.String())
	if err != nil {
		return false
	}
	return re.MatchString(str)
}

func shellGlobTrimPrefix(val, pat string, longest bool) string {
	if pat == "" {
		return val
	}
	if longest {
		for i := len(val); i >= 0; i-- {
			if shellGlobMatch(pat, val[:i]) {
				return val[i:]
			}
		}
	} else {
		for i := 0; i <= len(val); i++ {
			if shellGlobMatch(pat, val[:i]) {
				return val[i:]
			}
		}
	}
	return val
}

func shellGlobTrimSuffix(val, pat string, longest bool) string {
	if pat == "" {
		return val
	}
	if longest {
		for i := 0; i <= len(val); i++ {
			if shellGlobMatch(pat, val[i:]) {
				return val[:i]
			}
		}
	} else {
		for i := len(val); i >= 0; i-- {
			if shellGlobMatch(pat, val[i:]) {
				return val[:i]
			}
		}
	}
	return val
}

type shellArithParser struct {
	src string
	pos int
	env map[string]string
}

func (p *shellArithParser) skipWS() {
	for p.pos < len(p.src) && (p.src[p.pos] == ' ' || p.src[p.pos] == '\t' || p.src[p.pos] == '\r' || p.src[p.pos] == '\n') {
		p.pos++
	}
}

func (p *shellArithParser) match(op string) bool {
	p.skipWS()
	if strings.HasPrefix(p.src[p.pos:], op) {
		p.pos += len(op)
		return true
	}
	return false
}

func (p *shellArithParser) parseExpr() int64 {
	v := p.parseLogicalOr()
	p.skipWS()
	if p.match("?") {
		tVal := p.parseExpr()
		p.match(":")
		fVal := p.parseExpr()
		if v != 0 {
			return tVal
		}
		return fVal
	}
	return v
}

func (p *shellArithParser) parseLogicalOr() int64 {
	v := p.parseLogicalAnd()
	for {
		p.skipWS()
		if strings.HasPrefix(p.src[p.pos:], "||") {
			p.pos += 2
			r := p.parseLogicalAnd()
			if v != 0 || r != 0 {
				v = 1
			} else {
				v = 0
			}
		} else {
			break
		}
	}
	return v
}

func (p *shellArithParser) parseLogicalAnd() int64 {
	v := p.parseBitOr()
	for {
		p.skipWS()
		if strings.HasPrefix(p.src[p.pos:], "&&") {
			p.pos += 2
			r := p.parseBitOr()
			if v != 0 && r != 0 {
				v = 1
			} else {
				v = 0
			}
		} else {
			break
		}
	}
	return v
}

func (p *shellArithParser) parseBitOr() int64 {
	v := p.parseBitXor()
	for {
		p.skipWS()
		if p.pos < len(p.src) && p.src[p.pos] == '|' && (p.pos+1 >= len(p.src) || p.src[p.pos+1] != '|') {
			p.pos++
			v |= p.parseBitXor()
		} else {
			break
		}
	}
	return v
}

func (p *shellArithParser) parseBitXor() int64 {
	v := p.parseBitAnd()
	for {
		if p.match("^") {
			v ^= p.parseBitAnd()
		} else {
			break
		}
	}
	return v
}

func (p *shellArithParser) parseBitAnd() int64 {
	v := p.parseEquality()
	for {
		p.skipWS()
		if p.pos < len(p.src) && p.src[p.pos] == '&' && (p.pos+1 >= len(p.src) || p.src[p.pos+1] != '&') {
			p.pos++
			v &= p.parseEquality()
		} else {
			break
		}
	}
	return v
}

func (p *shellArithParser) parseEquality() int64 {
	v := p.parseRelational()
	for {
		if p.match("==") {
			r := p.parseRelational()
			if v == r {
				v = 1
			} else {
				v = 0
			}
		} else if p.match("!=") {
			r := p.parseRelational()
			if v != r {
				v = 1
			} else {
				v = 0
			}
		} else {
			break
		}
	}
	return v
}

func (p *shellArithParser) parseRelational() int64 {
	v := p.parseShift()
	for {
		if p.match("<=") {
			if v <= p.parseShift() {
				v = 1
			} else {
				v = 0
			}
		} else if p.match(">=") {
			if v >= p.parseShift() {
				v = 1
			} else {
				v = 0
			}
		} else if p.pos < len(p.src) && p.src[p.pos] == '<' && (p.pos+1 >= len(p.src) || p.src[p.pos+1] != '<') {
			p.pos++
			if v < p.parseShift() {
				v = 1
			} else {
				v = 0
			}
		} else if p.pos < len(p.src) && p.src[p.pos] == '>' && (p.pos+1 >= len(p.src) || p.src[p.pos+1] != '>') {
			p.pos++
			if v > p.parseShift() {
				v = 1
			} else {
				v = 0
			}
		} else {
			break
		}
	}
	return v
}

func (p *shellArithParser) parseShift() int64 {
	v := p.parseAdditive()
	for {
		if p.match("<<") {
			r := p.parseAdditive()
			if r >= 0 && r < 64 {
				v <<= uint(r)
			}
		} else if p.match(">>") {
			r := p.parseAdditive()
			if r >= 0 && r < 64 {
				v >>= uint(r)
			}
		} else {
			break
		}
	}
	return v
}

func (p *shellArithParser) parseAdditive() int64 {
	v := p.parseMultiplicative()
	for {
		if p.match("+") {
			v += p.parseMultiplicative()
		} else if p.match("-") {
			v -= p.parseMultiplicative()
		} else {
			break
		}
	}
	return v
}

func (p *shellArithParser) parseMultiplicative() int64 {
	v := p.parseUnary()
	for {
		if p.match("**") {
			exp := p.parseUnary()
			if exp < 0 {
				v = 0
			} else {
				res := int64(1)
				base := v
				for exp > 0 {
					if exp&1 != 0 {
						res *= base
					}
					base *= base
					exp >>= 1
				}
				v = res
			}
		} else if p.match("*") {
			v *= p.parseUnary()
		} else if p.match("/") {
			r := p.parseUnary()
			if r != 0 {
				v /= r
			} else {
				v = 0
			}
		} else if p.match("%") {
			r := p.parseUnary()
			if r != 0 {
				v %= r
			} else {
				v = 0
			}
		} else {
			break
		}
	}
	return v
}

func (p *shellArithParser) parseUnary() int64 {
	p.skipWS()
	if p.match("+") {
		return p.parseUnary()
	}
	if p.match("-") {
		return -p.parseUnary()
	}
	if p.pos < len(p.src) && p.src[p.pos] == '!' && (p.pos+1 >= len(p.src) || p.src[p.pos+1] != '=') {
		p.pos++
		if p.parseUnary() == 0 {
			return 1
		}
		return 0
	}
	if p.match("~") {
		return ^p.parseUnary()
	}
	return p.parsePrimary()
}

func (p *shellArithParser) parsePrimary() int64 {
	p.skipWS()
	if p.match("(") {
		v := p.parseExpr()
		p.match(")")
		return v
	}
	start := p.pos
	for p.pos < len(p.src) && ((p.src[p.pos] >= '0' && p.src[p.pos] <= '9') || (p.src[p.pos] >= 'a' && p.src[p.pos] <= 'z') || (p.src[p.pos] >= 'A' && p.src[p.pos] <= 'Z') || p.src[p.pos] == '_') {
		p.pos++
	}
	if p.pos > start {
		tok := p.src[start:p.pos]
		if n, err := strconv.ParseInt(tok, 0, 64); err == nil {
			return n
		}
		if val, ok := lookupShellEnvVar(p.env, tok); ok {
			if n, err := strconv.ParseInt(strings.TrimSpace(val), 0, 64); err == nil {
				return n
			}
		}
	}
	return 0
}

func evalShellArithmetic(expr string, env map[string]string) int64 {
	expanded := expandShellVars(expr, env)
	parser := &shellArithParser{src: expanded, env: env}
	return parser.parseExpr()
}

func escapeUnquotedExpansionChars(s string) string {
	var sb strings.Builder
	sb.Grow(len(s))
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '$', '%', '`', '{', '}', ',':
			sb.WriteByte('\x01')
		}
		sb.WriteByte(s[i])
	}
	return sb.String()
}

func expandShellDefaultWord(raw string, env map[string]string) (string, bool) {
	if !strings.ContainsAny(raw, `"'`) {
		return expandShellVars(raw, env), false
	}
	var sb strings.Builder
	wasQuoted := false
	for i := 0; i < len(raw); {
		if raw[i] == '\'' {
			wasQuoted = true
			i++
			for i < len(raw) && raw[i] != '\'' {
				sb.WriteByte(raw[i])
				i++
			}
			if i < len(raw) {
				i++
			}
			continue
		}
		if raw[i] == '"' {
			wasQuoted = true
			i++
			var dq strings.Builder
			for i < len(raw) && raw[i] != '"' {
				if raw[i] == '\\' && i+1 < len(raw) && (raw[i+1] == '"' || raw[i+1] == '\\' || raw[i+1] == '$' || raw[i+1] == '`') {
					if raw[i+1] == '$' || raw[i+1] == '`' {
						dq.WriteByte('\x01')
					}
					dq.WriteByte(raw[i+1])
					i += 2
					continue
				}
				dq.WriteByte(raw[i])
				i++
			}
			if i < len(raw) {
				i++
			}
			sb.WriteString(expandShellVars(dq.String(), env))
			continue
		}
		start := i
		for i < len(raw) && raw[i] != '\'' && raw[i] != '"' {
			if raw[i] == '\\' && i+1 < len(raw) {
				i += 2
				continue
			}
			i++
		}
		sb.WriteString(expandShellVars(raw[start:i], env))
	}
	return sb.String(), wasQuoted
}

func formatExpandedShellVal(val string, inDQuote bool) string {
	if inDQuote {
		return escapeQuotedGlobChars(val)
	}
	return "\x04" + escapeUnquotedExpansionChars(val) + "\x04"
}

func checkNounsetVar(env map[string]string, varName string, hasKey bool) {
	if hasKey || env == nil || env["\x00OPT_U"] != "1" {
		return
	}
	switch varName {
	case "@", "*", "#", "?", "$", "!", "0", "IFS":
		return
	}
	if env["\x00NOUNSET_ERR"] == "" {
		env["\x00NOUNSET_ERR"] = varName
	}
}

func expandShellVarsKeepMarkers(word string, env map[string]string) string {
	if word == "" {
		return ""
	}
	// Expand leading ~ or ~/ or ~\ (only if unquoted)
	if word == "~" || strings.HasPrefix(word, "~/") || strings.HasPrefix(word, `~\`) {
		home, ok := lookupShellEnvVar(env, "HOME")
		if !ok || home == "" {
			home, ok = lookupShellEnvVar(env, "USERPROFILE")
		}
		if !ok || home == "" {
			home, _ = os.UserHomeDir()
		}
		if home != "" {
			word = home + word[1:]
		}
	}
	// Expand %VAR%, %VAR:~start,len%, and %VAR:old=new% (Windows cmd style, only when unquoted)
	if strings.Count(word, "%") >= 2 {
		var sb strings.Builder
		for i := 0; i < len(word); {
			if word[i] == '\x01' && i+1 < len(word) && word[i+1] == '%' {
				sb.WriteByte('\x01')
				sb.WriteByte('%')
				i += 2
				continue
			}
			if word[i] == '%' {
				end := -1
				for j := i + 1; j < len(word); j++ {
					if word[j] == '\x01' {
						j++
						continue
					}
					if word[j] == '%' {
						end = j - (i + 1)
						break
					}
				}
				if end > 0 && !strings.ContainsRune(word[i+1:i+1+end], '\x01') {
					spec := word[i+1 : i+1+end]
					varName := spec
					mod := ""
					if colon := strings.IndexByte(spec, ':'); colon > 0 {
						varName = spec[:colon]
						mod = spec[colon+1:]
					}
					if isEnvVarIdent(varName) {
						if val, ok := lookupShellEnvVar(env, varName); ok {
							if strings.HasPrefix(mod, "~") {
								parts := strings.SplitN(mod[1:], ",", 2)
								start, _ := strconv.Atoi(strings.TrimSpace(parts[0]))
								if start < 0 {
									start = len(val) + start
								}
								if start < 0 {
									start = 0
								}
								if start > len(val) {
									start = len(val)
								}
								endIdx := len(val)
								if len(parts) == 2 {
									length, _ := strconv.Atoi(strings.TrimSpace(parts[1]))
									if length < 0 {
										endIdx = len(val) + length
									} else {
										endIdx = start + length
									}
								}
								if endIdx < start {
									endIdx = start
								}
								if endIdx > len(val) {
									endIdx = len(val)
								}
								val = val[start:endIdx]
							} else if eq := strings.IndexByte(mod, '='); eq >= 0 {
								val = strings.ReplaceAll(val, mod[:eq], mod[eq+1:])
							}
							sb.WriteString(val)
							i += end + 2
							continue
						}
					}
				}
			}
			sb.WriteByte(word[i])
			i++
		}
		word = sb.String()
	}
	// Expand $(( ... )), $VAR, and ${VAR...}
	if !strings.Contains(word, "$") {
		return word
	}
	var sb strings.Builder
	for i := 0; i < len(word); {
		if word[i] == '\x01' && i+1 < len(word) {
			sb.WriteByte('\x01')
			sb.WriteByte(word[i+1])
			i += 2
			continue
		}
		inDQuote := false
		if word[i] == '\x02' && i+1 < len(word) && word[i+1] == '$' {
			inDQuote = true
			i++
		}
		if word[i] == '$' && i+1 < len(word) {
			if word[i+1] == '(' && i+2 < len(word) && word[i+2] == '(' {
				// Arithmetic expansion $(( ... ))
				depth := 2
				j := i + 3
				for j < len(word) && depth > 0 {
					if word[j] == '(' {
						depth++
					} else if word[j] == ')' {
						depth--
					}
					j++
				}
				if depth == 0 && j >= i+4 && word[j-2] == ')' && word[j-1] == ')' {
					expr := word[i+3 : j-2]
					sb.WriteString(formatExpandedShellVal(strconv.FormatInt(evalShellArithmetic(expr, env), 10), inDQuote))
					i = j
					continue
				}
			}
			if word[i+1] == '{' {
				depth := 1
				k := i + 2
				for k < len(word) && depth > 0 {
					if word[k] == '\x01' && k+1 < len(word) {
						k += 2
						continue
					}
					if word[k] == '{' {
						depth++
					} else if word[k] == '}' {
						depth--
						if depth == 0 {
							break
						}
					}
					k++
				}
				end := -1
				if depth == 0 && k > i+2 {
					end = k - (i + 2)
				}
				if end > 0 {
					spec := word[i+2 : i+2+end]
					if (spec == "@" || spec == "*") && inDQuote {
						posArgs := getPositionalArgs(env)
						if spec == "@" {
							if len(posArgs) == 0 {
								sb.WriteString("\x06")
							} else {
								for idx, pa := range posArgs {
									if idx > 0 {
										sb.WriteByte('\x05')
									}
									sb.WriteString(escapeQuotedGlobChars(pa))
								}
							}
						} else {
							sep := " "
							if ifsVal, hasIFS := env["IFS"]; hasIFS {
								if len(ifsVal) > 0 {
									sep = ifsVal[:1]
								} else {
									sep = ""
								}
							}
							sb.WriteString(escapeQuotedGlobChars(strings.Join(posArgs, sep)))
						}
						i += end + 3
						continue
					}
					if spec == "@" || spec == "*" {
						posArgs := getPositionalArgs(env)
						if len(posArgs) == 0 {
							sb.WriteString("\x04\x04")
						} else {
							sb.WriteByte('\x04')
							for idx, pa := range posArgs {
								if idx > 0 {
									sb.WriteByte('\x05')
								}
								sb.WriteString(escapeUnquotedExpansionChars(pa))
							}
							sb.WriteByte('\x04')
						}
						i += end + 3
						continue
					}
					if spec == "#" || spec == "?" || spec == "$" || (len(spec) == 1 && spec[0] >= '0' && spec[0] <= '9') {
						val, ok := lookupShellEnvVar(env, spec)
						if spec == "?" && !ok {
							val = "0"
							ok = true
						} else if spec == "$" && !ok {
							val = strconv.Itoa(os.Getpid())
							ok = true
						}
						checkNounsetVar(env, spec, ok)
						sb.WriteString(formatExpandedShellVal(val, inDQuote))
						i += end + 3
						continue
					}
					if strings.HasPrefix(spec, "#") && len(spec) > 1 && isEnvVarIdent(spec[1:]) {
						val, ok := lookupShellEnvVar(env, spec[1:])
						checkNounsetVar(env, spec[1:], ok)
						sb.WriteString(formatExpandedShellVal(strconv.Itoa(len(val)), inDQuote))
						i += end + 3
						continue
					}
					j := 0
					for j < len(spec) && ((spec[j] >= 'a' && spec[j] <= 'z') || (spec[j] >= 'A' && spec[j] <= 'Z') || (spec[j] >= '0' && spec[j] <= '9') || spec[j] == '_') {
						j++
					}
					if j > 0 && isEnvVarIdent(spec[:j]) {
						varName := spec[:j]
						val, hasKey := lookupShellEnvVar(env, varName)
						mod := spec[j:]
						hasDefaultOp := false
						defaultQuoted := false
						if (strings.HasPrefix(mod, ":-") || strings.HasPrefix(mod, ":=")) && val == "" {
							hasDefaultOp = true
							val, defaultQuoted = expandShellDefaultWord(mod[2:], env)
							if strings.HasPrefix(mod, ":=") && !isBlockedJailedEnvKey(varName) {
								env[varName] = val
							}
						} else if strings.HasPrefix(mod, ":-") || strings.HasPrefix(mod, ":=") {
							hasDefaultOp = true
						} else if (strings.HasPrefix(mod, "-") || strings.HasPrefix(mod, "=")) && !hasKey {
							hasDefaultOp = true
							val, defaultQuoted = expandShellDefaultWord(mod[1:], env)
							if strings.HasPrefix(mod, "=") && !isBlockedJailedEnvKey(varName) {
								env[varName] = val
							}
						} else if strings.HasPrefix(mod, "-") || strings.HasPrefix(mod, "=") {
							hasDefaultOp = true
						} else if strings.HasPrefix(mod, ":+") {
							hasDefaultOp = true
							if val != "" {
								val, defaultQuoted = expandShellDefaultWord(mod[2:], env)
							} else {
								val = ""
							}
						} else if strings.HasPrefix(mod, "+") {
							hasDefaultOp = true
							if hasKey {
								val, defaultQuoted = expandShellDefaultWord(mod[1:], env)
							} else {
								val = ""
							}
						} else if strings.HasPrefix(mod, "##") {
							val = shellGlobTrimPrefix(val, expandShellVars(mod[2:], env), true)
						} else if strings.HasPrefix(mod, "#") {
							val = shellGlobTrimPrefix(val, expandShellVars(mod[1:], env), false)
						} else if strings.HasPrefix(mod, "%%") {
							val = shellGlobTrimSuffix(val, expandShellVars(mod[2:], env), true)
						} else if strings.HasPrefix(mod, "%") {
							val = shellGlobTrimSuffix(val, expandShellVars(mod[1:], env), false)
						} else if strings.HasPrefix(mod, "//") {
							parts := strings.SplitN(mod[2:], "/", 2)
							oldStr := expandShellVars(parts[0], env)
							newStr := ""
							if len(parts) == 2 {
								newStr = expandShellVars(parts[1], env)
							}
							if oldStr != "" {
								val = strings.ReplaceAll(val, oldStr, newStr)
							}
						} else if strings.HasPrefix(mod, "/") {
							parts := strings.SplitN(mod[1:], "/", 2)
							oldStr := expandShellVars(parts[0], env)
							newStr := ""
							if len(parts) == 2 {
								newStr = expandShellVars(parts[1], env)
							}
							if oldStr != "" {
								val = strings.Replace(val, oldStr, newStr, 1)
							}
						} else if strings.HasPrefix(mod, ":") && len(mod) > 1 {
							parts := strings.SplitN(mod[1:], ":", 2)
							start, _ := strconv.Atoi(strings.TrimSpace(parts[0]))
							if start < 0 {
								start = len(val) + start
							}
							if start < 0 {
								start = 0
							}
							if start > len(val) {
								start = len(val)
							}
							endIdx := len(val)
							if len(parts) == 2 {
								length, _ := strconv.Atoi(strings.TrimSpace(parts[1]))
								if length >= 0 {
									endIdx = start + length
								} else {
									endIdx = len(val) + length
								}
							}
							if endIdx < start {
								endIdx = start
							}
							if endIdx > len(val) {
								endIdx = len(val)
							}
							val = val[start:endIdx]
						}
						if !hasDefaultOp {
							checkNounsetVar(env, varName, hasKey)
						}
						sb.WriteString(formatExpandedShellVal(val, inDQuote || defaultQuoted))
						i += end + 3
						continue
					}
				}
			} else if (word[i+1] == '@' || word[i+1] == '*') && inDQuote {
				posArgs := getPositionalArgs(env)
				if word[i+1] == '@' {
					if len(posArgs) == 0 {
						sb.WriteString("\x06")
					} else {
						for idx, pa := range posArgs {
							if idx > 0 {
								sb.WriteByte('\x05')
							}
							sb.WriteString(escapeQuotedGlobChars(pa))
						}
					}
				} else {
					sep := " "
					if ifsVal, hasIFS := env["IFS"]; hasIFS {
						if len(ifsVal) > 0 {
							sep = ifsVal[:1]
						} else {
							sep = ""
						}
					}
					sb.WriteString(escapeQuotedGlobChars(strings.Join(posArgs, sep)))
				}
				i += 2
				continue
			} else if word[i+1] == '@' || word[i+1] == '*' {
				posArgs := getPositionalArgs(env)
				if len(posArgs) == 0 {
					sb.WriteString("\x04\x04")
				} else {
					sb.WriteByte('\x04')
					for idx, pa := range posArgs {
						if idx > 0 {
							sb.WriteByte('\x05')
						}
						sb.WriteString(escapeUnquotedExpansionChars(pa))
					}
					sb.WriteByte('\x04')
				}
				i += 2
				continue
			} else if (word[i+1] >= '0' && word[i+1] <= '9') || word[i+1] == '#' || word[i+1] == '?' || word[i+1] == '$' {
				ch := string(word[i+1])
				val, ok := lookupShellEnvVar(env, ch)
				if ch == "?" && !ok {
					val = "0"
					ok = true
				} else if ch == "$" && !ok {
					val = strconv.Itoa(os.Getpid())
					ok = true
				}
				checkNounsetVar(env, ch, ok)
				sb.WriteString(formatExpandedShellVal(val, inDQuote))
				i += 2
				continue
			} else if (word[i+1] >= 'a' && word[i+1] <= 'z') || (word[i+1] >= 'A' && word[i+1] <= 'Z') || word[i+1] == '_' {
				j := i + 1
				for j < len(word) && ((word[j] >= 'a' && word[j] <= 'z') || (word[j] >= 'A' && word[j] <= 'Z') || (word[j] >= '0' && word[j] <= '9') || word[j] == '_') {
					j++
				}
				varName := word[i+1 : j]
				val, ok := lookupShellEnvVar(env, varName)
				checkNounsetVar(env, varName, ok)
				sb.WriteString(formatExpandedShellVal(val, inDQuote))
				i = j
				continue
			}
		}
		sb.WriteByte(word[i])
		i++
	}
	return sb.String()
}

func expandShellVars(word string, env map[string]string) string {
	return unescapeShellMarkers(expandShellVarsKeepMarkers(word, env))
}

func extractSubshells(s string) []string {
	var out []string
	for i := 0; i < len(s); i++ {
		if s[i] == '\x01' && i+1 < len(s) {
			i++
			continue
		}
		if s[i] == '\'' {
			i++
			for i < len(s) && s[i] != '\'' {
				i++
			}
			continue
		}
		if s[i] == '\\' && i+1 < len(s) {
			i++
			continue
		}
		if s[i] == '$' && i+1 < len(s) && s[i+1] == '(' {
			isArith := i+2 < len(s) && s[i+2] == '('
			depth := 1
			start := i + 2
			j := start
			for j < len(s) && depth > 0 {
				if s[j] == '(' {
					depth++
				} else if s[j] == ')' {
					depth--
				}
				j++
			}
			if !isArith && depth == 0 && j-1 > start {
				out = append(out, s[start:j-1])
			}
			if j > i+1 {
				i = j - 1
			}
		} else if s[i] == '`' {
			end := strings.IndexByte(s[i+1:], '`')
			if end > 0 {
				out = append(out, s[i+1:i+1+end])
				i += end + 1
			}
		}
	}
	return out
}

func (en *rtEntry) checkArgvPaths(cwd string, argv []string) error {
	en.mu.Lock()
	hasJail := len(en.jailRoots) > 0
	en.mu.Unlock()
	if !hasJail {
		return nil
	}
	checkSingleToken := func(tok string) error {
		if tok == "" {
			return nil
		}
		cand := tok
		if idx := strings.IndexByte(cand, '='); idx > 0 {
			cand = cand[idx+1:]
		}
		cand = strings.Trim(cand, `"'`)
		if cand == "" || strings.HasPrefix(cand, "-") || strings.Contains(cand, "://") {
			return nil
		}
		looksLikePath := filepath.IsAbs(cand) ||
			cand == "~" ||
			strings.HasPrefix(cand, "~/") ||
			strings.HasPrefix(cand, `~\`) ||
			strings.HasPrefix(cand, "..") ||
			strings.HasPrefix(cand, "./") ||
			strings.HasPrefix(cand, `.\\`) ||
			strings.Contains(cand, "/") ||
			strings.Contains(cand, `\`)
		if !looksLikePath {
			return nil
		}
		if cand == "~" || strings.HasPrefix(cand, "~/") || strings.HasPrefix(cand, `~\`) {
			if home, err := os.UserHomeDir(); err == nil && home != "" {
				cand = home + cand[1:]
			}
		}
		resolved := joinCWDPath(cwd, cand)
		return en.checkPath(resolved)
	}
	for _, tok := range argv {
		if err := checkSingleToken(tok); err != nil {
			return err
		}
		if strings.ContainsAny(tok, " \t\r\n") {
			for _, field := range strings.Fields(tok) {
				if err := checkSingleToken(field); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func isPOSIXBuiltinName(name string) bool {
	switch strings.ToLower(strings.TrimSuffix(filepath.Base(name), ".exe")) {
	case "echo", "printf", "true", ":", "false", "pwd", "cd", "export", "exit", "sleep", "cat", "type", "env",
		"ls", "dir", "mkdir", "rm", "rmdir", "cp", "mv", "touch", "head", "tail", "wc", "grep", "find",
		"sort", "uniq", "tr", "cut", "tee", "basename", "dirname", "uname", "whoami", "id", "date", "seq", "yes", "which",
		"test", "[", "[[", "break", "continue", "return", "shift", "unset", "local", "readonly",
		"read", "trap", "set", "command", "!", "{", "}":
		return true
	default:
		return false
	}
}

func isShellInterpreterName(name string) bool {
	switch strings.ToLower(strings.TrimSuffix(filepath.Base(name), ".exe")) {
	case "sh", "bash", "dash", "zsh", "ash", "ksh", "cmd", "unish":
		return true
	default:
		return false
	}
}

func posixShellQuote(s string) string {
	if s == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func isShellOptTruthy(shell any) bool {
	switch v := shell.(type) {
	case bool:
		return v
	case string:
		return v != ""
	default:
		return false
	}
}

func (en *rtEntry) isSelfExePath(command string) bool {
	if command == "" {
		return false
	}
	cleanCmd := filepath.Clean(command)
	if en.execPath != "" && strings.EqualFold(cleanCmd, filepath.Clean(en.execPath)) {
		return true
	}
	if selfExe, err := os.Executable(); err == nil && selfExe != "" && strings.EqualFold(cleanCmd, filepath.Clean(selfExe)) {
		return true
	}
	return false
}

func (en *rtEntry) isSelfJSExec(command string, args []string) bool {
	return len(args) > 0 && args[0] == "--js" && en.isSelfExePath(command)
}

func isBlockedJailedEnvKey(k string) bool {
	u := strings.ToUpper(strings.TrimSpace(k))
	if strings.HasPrefix(u, "__INDIRECT_") {
		switch u {
		case "__INDIRECT_WORKER_THREAD_ID", "__INDIRECT_WORKER_THREAD", "__INDIRECT_WORKER_ID", "__INDIRECT_WORKER_DATA",
			"__INDIRECT_WORKER_DATA_FILE", "__INDIRECT_WORKER_EVAL_FILE", "__INDIRECT_WT_CTL_PORT", "__INDIRECT_FORK_IPC":
			return false
		default:
			return true
		}
	}
	if strings.HasPrefix(u, "LD_") || strings.HasPrefix(u, "_LD_") || strings.HasPrefix(u, "DYLD_") {
		return true
	}
	if strings.HasPrefix(u, "GIT_") {
		switch u {
		case "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_DATE",
			"GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_DATE":
			return false
		default:
			return true
		}
	}
	switch u {
	case "NODE_OPTIONS", "NODE_REPL_EXTERNAL_MODULE", "NODE_EXTRA_CA_CERTS",
		"BASH_ENV", "ENV", "PROMPT_COMMAND", "SHELLOPTS", "BASHOPTS", "CDPATH", "GLOBIGNORE",
		"PERL5OPT", "PERL5LIB", "PERLLIB",
		"PYTHONSTARTUP", "PYTHONPATH", "PYTHONHOME",
		"RUBYOPT", "RUBYLIB",
		"OPENSSL_CONF", "OPENSSL_ENGINES", "OPENSSL_MODULES",
		"SSH_ASKPASS", "SSH_ASKPASS_REQUIRE", "SUDO_ASKPASS",
		"EDITOR", "VISUAL", "PAGER", "LESSOPEN", "LESSCLOSE",
		"GCONV_PATH", "LOCPATH", "NLSPATH", "HOSTALIASES",
		"BROWSER", "MANPAGER", "MANPATH", "MANOPT",
		"GNUPGHOME", "GPG_TTY", "GPG_AGENT_INFO":
		return true
	}
	return false
}

func isRejectedJailedEnvKey(k string) bool {
	u := strings.ToUpper(strings.TrimSpace(k))
	if strings.HasPrefix(u, "__INDIRECT_") && isBlockedJailedEnvKey(u) {
		return true
	}
	if strings.HasPrefix(u, "LD_PRELOAD") || strings.HasPrefix(u, "LD_AUDIT") || strings.HasPrefix(u, "DYLD_INSERT_") {
		return true
	}
	if strings.HasPrefix(u, "GIT_CONFIG_KEY_") || strings.HasPrefix(u, "GIT_CONFIG_VALUE_") {
		return true
	}
	switch u {
	case "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
		"GIT_EXTERNAL_DIFF", "GIT_SSH_COMMAND", "GIT_SSH", "GIT_ASKPASS",
		"GIT_EXEC_PATH", "GIT_TEMPLATE_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
		"GCONV_PATH", "LOCPATH", "HOSTALIASES", "BROWSER", "MANPAGER":
		return true
	}
	return false
}

func isAllowedJailedGitSubcmd(subcmd string) bool {
	switch subcmd {
	case "", "status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree", "cat-file",
		"blame", "shortlog", "describe", "rev-list", "for-each-ref", "name-rev", "merge-base", "version",
		"branch", "tag", "remote", "init", "add", "mv", "restore", "rm", "sparse-checkout",
		"bisect", "grep", "reset", "switch", "checkout", "commit", "merge", "rebase",
		"cherry-pick", "revert", "stash", "clean", "reflog", "apply", "format-patch", "am", "notes":
		return true
	default:
		return false
	}
}

func (en *rtEntry) inspectJailedGitRepo(startDir string) error {
	cur := filepath.Clean(startDir)
	for depth := 0; depth < 32; depth++ {
		if err := en.checkPath(cur); err != nil {
			break
		}
		dotGit := filepath.Join(cur, ".git")
		fi, err := os.Lstat(dotGit)
		if err == nil {
			if err := en.checkPath(dotGit); err != nil {
				return err
			}
			gitDir := dotGit
			if !fi.IsDir() {
				b, rerr := readFileBounded(dotGit, 8192)
				if rerr != nil {
					return fmt.Errorf("EACCES: jailed: cannot read .git file: %v", rerr)
				}
				line := strings.TrimSpace(string(b))
				if strings.HasPrefix(strings.ToLower(line), "gitdir:") {
					target := strings.TrimSpace(line[len("gitdir:"):])
					if !filepath.IsAbs(target) {
						target = filepath.Join(cur, target)
					}
					gitDir = filepath.Clean(target)
				}
				if err := en.checkPath(gitDir); err != nil {
					return err
				}
			}
			commonDir := gitDir
			if cb, cerr := readFileBounded(filepath.Join(gitDir, "commondir"), 8192); cerr == nil {
				cTarget := strings.TrimSpace(string(cb))
				if cTarget != "" {
					if !filepath.IsAbs(cTarget) {
						cTarget = filepath.Join(gitDir, cTarget)
					}
					commonDir = filepath.Clean(cTarget)
					if err := en.checkPath(commonDir); err != nil {
						return err
					}
				}
			}
			for _, altPath := range []string{
				filepath.Join(gitDir, "objects", "info", "alternates"),
				filepath.Join(gitDir, "objects", "info", "http-alternates"),
				filepath.Join(commonDir, "objects", "info", "alternates"),
				filepath.Join(commonDir, "objects", "info", "http-alternates"),
			} {
				if _, stErr := os.Lstat(altPath); stErr == nil {
					return fmt.Errorf("EACCES: jailed: git alternates file %q is not allowed in sandbox", altPath)
				}
			}
			checkGitTree := func(root string) error {
				visited := 0
				return filepath.WalkDir(root, func(p string, d fs.DirEntry, werr error) error {
					if werr != nil {
						return nil
					}
					visited++
					if visited > 2048 {
						return fs.SkipAll
					}
					return en.checkPath(p)
				})
			}
			if err := checkGitTree(gitDir); err != nil {
				return err
			}
			if commonDir != gitDir {
				if err := checkGitTree(commonDir); err != nil {
					return err
				}
			}
			cfgFiles := []string{
				filepath.Join(gitDir, "config"),
				filepath.Join(commonDir, "config"),
				filepath.Join(gitDir, "config.worktree"),
			}
			for _, cfgPath := range cfgFiles {
				if _, stErr := os.Lstat(cfgPath); stErr != nil {
					continue
				}
				if err := en.checkPath(cfgPath); err != nil {
					return err
				}
				b, rerr := readFileBounded(cfgPath, 256*1024)
				if rerr != nil {
					return fmt.Errorf("EACCES: jailed: cannot read git config: %v", rerr)
				}
				for _, rawLine := range strings.Split(string(b), "\n") {
					line := strings.ToLower(strings.TrimSpace(rawLine))
					if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
						continue
					}
					for _, bad := range []string{
						"[alias", "[filter", "[include", "[interactive", "interactive.",
						"[gpg", "gpg.", "gpgsign", "signingkey",
						"[man", "man.", "[web", "web.", "browser", "openfilesinpager",
						"fsmonitor", "sshcommand", "askpass", "gitproxy", "hookspath",
						"pager", "editor", "diff.external", "difffilter", "alternaterefs", "credential", "uploadpack", "receivepack",
						"attributesfile", "excludesfile", "worktree",
						"clean", "smudge", "process", "textconv", "command", "driver", "helper", "ext::",
					} {
						if strings.Contains(line, bad) {
							return fmt.Errorf("EACCES: jailed: repository .git/config contains unsafe directive %q", bad)
						}
					}
				}
			}
			attrFiles := []string{
				filepath.Join(gitDir, "info", "attributes"),
				filepath.Join(commonDir, "info", "attributes"),
				filepath.Join(cur, ".gitattributes"),
				filepath.Join(startDir, ".gitattributes"),
			}
			for _, attrPath := range attrFiles {
				if _, stErr := os.Lstat(attrPath); stErr != nil {
					continue
				}
				if err := en.checkPath(attrPath); err != nil {
					return err
				}
				b, rerr := readFileBounded(attrPath, 256*1024)
				if rerr != nil {
					return fmt.Errorf("EACCES: jailed: cannot read gitattributes: %v", rerr)
				}
				for _, rawLine := range strings.Split(string(b), "\n") {
					line := strings.ToLower(strings.TrimSpace(rawLine))
					if line == "" || strings.HasPrefix(line, "#") {
						continue
					}
					if strings.Contains(line, "filter=") || strings.Contains(line, "diff=") || strings.Contains(line, "merge=") {
						return fmt.Errorf("EACCES: jailed: gitattributes contains unsafe external driver directive")
					}
				}
			}
			break
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			break
		}
		cur = parent
	}
	return nil
}

func (en *rtEntry) checkGitArgs(cwd string, args []string) error {
	if err := en.checkPath(cwd); err != nil {
		return err
	}
	effectiveCWD := cwd
	repoDirs := []string{cwd}
	subcmd := ""
	subcmdIdx := -1
	for i := 0; i < len(args); i++ {
		a := args[i]
		lower := strings.ToLower(a)
		if strings.Contains(lower, "ext::") || strings.Contains(lower, "://") {
			return fmt.Errorf("EACCES: jailed: git remote transport %q is not allowed in sandbox", a)
		}
		if a == "-c" || (strings.HasPrefix(a, "-c") && strings.Contains(a, "=")) ||
			a == "--config" || a == "--config-env" || a == "--exec-path" || a == "--upload-pack" || a == "--receive-pack" ||
			a == "--ext-diff" || a == "--textconv" || a == "--filters" || a == "--unsafe-paths" ||
			a == "--output" || a == "--exec" || a == "-x" ||
			a == "-O" || strings.HasPrefix(a, "-O") || a == "--open-files-in-pager" || strings.HasPrefix(lower, "--open-files-in-pager=") ||
			a == "--show-signature" || a == "--verify-signatures" || a == "--gpg-sign" || strings.HasPrefix(lower, "--gpg-sign=") ||
			a == "-S" || (strings.HasPrefix(a, "-S") && subcmd != "diff" && subcmd != "log") ||
			((strings.HasPrefix(lower, "--format=") || strings.HasPrefix(lower, "--pretty=") || strings.HasPrefix(lower, "format:")) && strings.ContainsAny(a, "Gg") && strings.Contains(a, "%")) ||
			strings.HasPrefix(lower, "--config=") || strings.HasPrefix(lower, "--config-env=") || strings.HasPrefix(lower, "--exec-path=") ||
			strings.HasPrefix(lower, "--upload-pack=") || strings.HasPrefix(lower, "--receive-pack=") ||
			strings.HasPrefix(lower, "--output=") || strings.HasPrefix(lower, "--exec=") {
			return fmt.Errorf("EACCES: jailed: git option %q is not allowed in sandbox", a)
		}
		if subcmd == "" {
			if a == "-C" {
				if i+1 < len(args) {
					i++
					dir := joinCWDPath(effectiveCWD, args[i])
					if err := en.checkPath(dir); err != nil {
						return err
					}
					effectiveCWD = filepath.Clean(dir)
					repoDirs = append(repoDirs, effectiveCWD)
				}
				continue
			}
			if strings.HasPrefix(a, "-C") && len(a) > 2 {
				dir := joinCWDPath(effectiveCWD, a[2:])
				if err := en.checkPath(dir); err != nil {
					return err
				}
				effectiveCWD = filepath.Clean(dir)
				repoDirs = append(repoDirs, effectiveCWD)
				continue
			}
			if a == "--git-dir" || a == "--work-tree" {
				if i+1 < len(args) {
					i++
					dir := joinCWDPath(effectiveCWD, args[i])
					if err := en.checkPath(dir); err != nil {
						return err
					}
					repoDirs = append(repoDirs, filepath.Clean(dir))
				}
				continue
			}
			if strings.HasPrefix(lower, "--git-dir=") || strings.HasPrefix(lower, "--work-tree=") {
				idx := strings.IndexByte(a, '=')
				dir := joinCWDPath(effectiveCWD, a[idx+1:])
				if err := en.checkPath(dir); err != nil {
					return err
				}
				repoDirs = append(repoDirs, filepath.Clean(dir))
				continue
			}
			if strings.HasPrefix(a, "-") {
				continue
			}
			subcmd = lower
			subcmdIdx = i
		}
	}
	if !isAllowedJailedGitSubcmd(subcmd) {
		return fmt.Errorf("EACCES: jailed: git subcommand %q is not allowed in sandbox", subcmd)
	}
	if subcmdIdx >= 0 {
		rest := args[subcmdIdx+1:]
		if subcmd == "bisect" {
			for _, ra := range rest {
				if strings.EqualFold(ra, "run") {
					return fmt.Errorf("EACCES: jailed: git bisect run is not allowed in sandbox")
				}
			}
		}
		if subcmd == "rebase" || subcmd == "add" || subcmd == "checkout" || subcmd == "reset" || subcmd == "stash" || subcmd == "clean" {
			for _, ra := range rest {
				lowerRa := strings.ToLower(ra)
				if ra == "-i" || lowerRa == "--interactive" || ra == "-p" || lowerRa == "--patch" ||
					ra == "-e" || lowerRa == "--edit" || ra == "-x" || lowerRa == "--exec" || strings.HasPrefix(lowerRa, "--exec=") {
					return fmt.Errorf("EACCES: jailed: git %s %s is not allowed in sandbox", subcmd, ra)
				}
			}
		}
		if subcmd == "tag" {
			for _, ra := range rest {
				if ra == "-v" || ra == "--verify" || ra == "-s" || ra == "-u" || ra == "--sign" {
					return fmt.Errorf("EACCES: jailed: git tag %s is not allowed in sandbox", ra)
				}
			}
		}
	}
	if err := en.checkArgvPaths(effectiveCWD, args); err != nil {
		return err
	}
	for _, d := range repoDirs {
		if err := en.inspectJailedGitRepo(d); err != nil {
			return err
		}
	}
	isReadOnlyTarget := false
	for _, d := range repoDirs {
		if en.checkWritePath(d) != nil {
			isReadOnlyTarget = true
			break
		}
	}
	if isReadOnlyTarget {
		switch subcmd {
		case "", "status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree", "cat-file",
			"blame", "shortlog", "describe", "rev-list", "for-each-ref", "name-rev", "merge-base", "version", "grep":
			return nil
		case "stash":
			rest := args[subcmdIdx+1:]
			for _, ra := range rest {
				if strings.HasPrefix(ra, "-") {
					continue
				}
				if ra == "list" || ra == "show" {
					return nil
				}
				return fmt.Errorf("EACCES: read-only mode: git stash %s is not allowed in read-only mode", ra)
			}
			return fmt.Errorf("EACCES: read-only mode: git stash is not allowed in read-only mode")
		case "apply":
			rest := args[subcmdIdx+1:]
			hasCheck := false
			for _, ra := range rest {
				if ra == "--check" {
					hasCheck = true
				}
				if ra == "--index" || ra == "--cached" {
					return fmt.Errorf("EACCES: read-only mode: git apply %s is not allowed in read-only mode", ra)
				}
			}
			if !hasCheck {
				return fmt.Errorf("EACCES: read-only mode: git apply without --check is not allowed in read-only mode")
			}
			return nil
		case "branch", "tag":
			rest := args[subcmdIdx+1:]
			hasListFlag := false
			posCount := 0
			for _, ra := range rest {
				switch ra {
				case "-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy", "-f", "--force", "-s", "-u":
					return fmt.Errorf("EACCES: read-only mode: git %s %s is not allowed in read-only mode", subcmd, ra)
				case "-l", "--list", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--show-current", "--contains", "--merged", "--no-merged", "--points-at":
					hasListFlag = true
				default:
					if !strings.HasPrefix(ra, "-") {
						posCount++
					}
				}
			}
			if posCount > 0 && !hasListFlag {
				return fmt.Errorf("EACCES: read-only mode: creating git %s is not allowed in read-only mode", subcmd)
			}
			return nil
		case "remote":
			rest := args[subcmdIdx+1:]
			for _, ra := range rest {
				if ra != "-v" && ra != "--verbose" && ra != "show" && ra != "get-url" && !strings.HasPrefix(ra, "-") {
					return fmt.Errorf("EACCES: read-only mode: git remote %s is not allowed in read-only mode", ra)
				}
			}
			return nil
		default:
			return fmt.Errorf("EACCES: read-only mode: git %s is not allowed in read-only mode", subcmd)
		}
	}
	return nil
}

func (en *rtEntry) checkReadOnlyNativeCommand(cwd, baseCmd string, args []string) error {
	en.mu.Lock()
	hasRO := len(en.readOnlyRoots) > 0
	en.mu.Unlock()
	if !hasRO {
		return nil
	}
	cwdReadOnly := en.checkWritePath(cwd) != nil
	switch baseCmd {
	case "go":
		for i, a := range args {
			if a == "-o" || a == "-coverprofile" {
				if i+1 < len(args) {
					if err := en.checkWritePath(joinCWDPath(cwd, args[i+1])); err != nil {
						return err
					}
				}
			} else if strings.HasPrefix(a, "-o=") || strings.HasPrefix(a, "-coverprofile=") {
				val := a[strings.IndexByte(a, '=')+1:]
				if err := en.checkWritePath(joinCWDPath(cwd, val)); err != nil {
					return err
				}
			}
		}
		if cwdReadOnly {
			for _, a := range args {
				if strings.HasPrefix(a, "-") {
					continue
				}
				switch a {
				case "version", "env", "list", "doc", "vet", "test", "bug", "help", "tool":
					return nil
				default:
					return fmt.Errorf("EACCES: read-only mode: 'go %s' is not allowed in read-only directory", a)
				}
			}
		}
	case "cargo":
		if cwdReadOnly {
			for _, a := range args {
				if a == "--version" || a == "-V" || a == "--help" || a == "-h" {
					return nil
				}
				if strings.HasPrefix(a, "-") {
					continue
				}
				switch a {
				case "version", "test", "check", "clippy", "metadata", "tree", "bench", "help":
					return nil
				default:
					return fmt.Errorf("EACCES: read-only mode: 'cargo %s' is not allowed in read-only directory", a)
				}
			}
		}
	case "npm", "pnpm", "yarn":
		if cwdReadOnly {
			for _, a := range args {
				if a == "--version" || a == "-v" || a == "--help" || a == "-h" {
					return nil
				}
				if strings.HasPrefix(a, "-") {
					continue
				}
				switch a {
				case "test", "t", "tst", "list", "ls", "outdated", "audit", "why", "info", "view", "help", "config", "prefix", "root", "bin":
					return nil
				default:
					return fmt.Errorf("EACCES: read-only mode: '%s %s' is not allowed in read-only directory", baseCmd, a)
				}
			}
		}
	case "python", "python3":
		if cwdReadOnly {
			for i := 0; i < len(args); i++ {
				a := args[i]
				if a == "--version" || a == "-V" || a == "--help" || a == "-h" {
					return nil
				}
				if a == "-m" && i+1 < len(args) {
					mod := args[i+1]
					if mod == "pytest" || mod == "unittest" || mod == "py_compile" {
						return nil
					}
					return fmt.Errorf("EACCES: read-only mode: '%s -m %s' is not allowed in read-only directory", baseCmd, mod)
				}
			}
			return fmt.Errorf("EACCES: read-only mode: '%s' arbitrary code execution is not allowed in read-only directory", baseCmd)
		}
	case "perl", "ruby", "php", "lua":
		if cwdReadOnly {
			for _, a := range args {
				if a == "--version" || a == "-v" || a == "-V" || a == "--help" || a == "-h" {
					return nil
				}
			}
			return fmt.Errorf("EACCES: read-only mode: '%s' is not allowed in read-only directory", baseCmd)
		}
	case "make", "gmake":
		if cwdReadOnly {
			for _, a := range args {
				if a == "--version" || a == "-v" || a == "-n" || a == "--dry-run" || a == "--just-print" || a == "test" || a == "check" {
					return nil
				}
			}
			return fmt.Errorf("EACCES: read-only mode: '%s' without -n/test/check is not allowed in read-only directory", baseCmd)
		}
	}
	return nil
}

func classifyScriptFileKind(filePath string, header []byte) string {
	ext := strings.ToLower(filepath.Ext(filePath))
	switch ext {
	case ".sh", ".bash":
		return "sh"
	case ".js", ".mjs", ".cjs":
		return "js"
	}
	if bytes.HasPrefix(header, []byte("#!")) {
		firstLine := string(header)
		if idx := strings.IndexByte(firstLine, '\n'); idx >= 0 {
			firstLine = firstLine[:idx]
		}
		lower := strings.ToLower(firstLine)
		if strings.Contains(lower, "node") || strings.Contains(lower, "qjs") {
			return "js"
		}
		if strings.Contains(lower, "sh") || strings.Contains(lower, "bash") || strings.Contains(lower, "zsh") {
			return "sh"
		}
	}
	return ""
}

func (en *rtEntry) checkSpawnCmdline(cwd string, src string, envOrig map[string]string, depth int) error {
	if depth > 6 || strings.TrimSpace(src) == "" {
		return nil
	}
	envMap := make(map[string]string, len(envOrig))
	for k, v := range envOrig {
		envMap[k] = v
	}
	for _, sub := range extractSubshells(src) {
		if err := en.checkSpawnCmdline(cwd, sub, envMap, depth+1); err != nil {
			return err
		}
	}
	toks, err := tokenizePOSIXShell(src)
	if err != nil {
		return en.checkArgvPaths(cwd, strings.Fields(src))
	}

	curCWD := cwd
	var curWords []string
	var flushSimpleCmd func() error
	flushSimpleCmd = func() error {
		if len(curWords) == 0 {
			return nil
		}
		argv := curWords
		curWords = nil
		prog := argv[0]
		args := argv[1:]
		baseCmd := strings.ToLower(strings.TrimSuffix(filepath.Base(prog), ".exe"))

		if baseCmd == "git" && !strings.ContainsAny(prog, `/\`) {
			return en.checkGitArgs(curCWD, args)
		}
		if (baseCmd == "node" && !strings.ContainsAny(prog, `/\`)) || en.isSelfJSExec(prog, args) {
			startIdx := 0
			if en.isSelfJSExec(prog, args) {
				startIdx = 1
			}
			for i := startIdx; i < len(args); i++ {
				a := args[i]
				if a == "-e" || a == "--eval" || a == "-p" || a == "--print" {
					i++
					if i+1 < len(args) {
						return en.checkArgvPaths(curCWD, args[i+1:])
					}
					return nil
				}
				if strings.HasPrefix(a, "-") {
					continue
				}
				resolved := joinCWDPath(curCWD, a)
				if err := en.checkPath(resolved); err != nil {
					return err
				}
				if i+1 < len(args) {
					return en.checkArgvPaths(curCWD, args[i+1:])
				}
				return nil
			}
			return nil
		}
		if err := en.checkArgvPaths(curCWD, argv); err != nil {
			return err
		}
		if isShellInterpreterName(baseCmd) && !strings.ContainsAny(prog, `/\`) {
			for i := 0; i < len(args); i++ {
				a := args[i]
				if a == "-c" || strings.EqualFold(a, "/c") {
					if i+1 < len(args) {
						if err := en.checkSpawnCmdline(curCWD, args[i+1], envMap, depth+1); err != nil {
							return err
						}
					}
					return nil
				}
				if a == "-s" || a == "/d" || a == "/s" || strings.HasPrefix(a, "-") {
					continue
				}
				scriptPath := a
				if !filepath.IsAbs(scriptPath) {
					scriptPath = filepath.Join(curCWD, scriptPath)
				}
				if err := en.checkPath(scriptPath); err != nil {
					return err
				}
				if b, rerr := readFileBounded(scriptPath, 256*1024); rerr == nil {
					if err := en.checkSpawnCmdline(filepath.Dir(scriptPath), string(b), envMap, depth+1); err != nil {
						return err
					}
				}
				return nil
			}
			return nil
		}
		if isPOSIXBuiltinName(baseCmd) && !strings.ContainsAny(prog, `/\`) {
			switch baseCmd {
			case "cd":
				if len(args) > 0 && args[0] != "-" {
					target := args[0]
					if !filepath.IsAbs(target) {
						target = filepath.Join(curCWD, target)
					}
					if err := en.checkPath(target); err != nil {
						return err
					}
					curCWD = filepath.Clean(target)
				}
			case "command":
				for idx, a := range args {
					if a == "-v" || a == "-V" {
						return nil
					}
					if a == "-p" || a == "--" {
						continue
					}
					curWords = args[idx:]
					return flushSimpleCmd()
				}
			case "export":
				for _, a := range args {
					if idx := strings.IndexByte(a, '='); idx > 0 {
						key := a[:idx]
						if isRejectedJailedEnvKey(key) {
							return fmt.Errorf("EACCES: jailed: environment variable %q is not allowed in sandbox", key)
						}
						if !isBlockedJailedEnvKey(key) {
							envMap[key] = a[idx+1:]
						}
					}
				}
			case "mkdir", "rm", "rmdir", "touch", "tee":
				for _, a := range args {
					if strings.HasPrefix(a, "-") {
						continue
					}
					p := joinCWDPath(curCWD, a)
					if baseCmd == "rm" || baseCmd == "rmdir" {
						if err := en.checkSubtreeWritable(p); err != nil {
							return err
						}
					} else if err := en.checkWritePath(p); err != nil {
						return err
					}
				}
			case "mv":
				for _, a := range args {
					if strings.HasPrefix(a, "-") {
						continue
					}
					p := joinCWDPath(curCWD, a)
					if err := en.checkSubtreeWritable(p); err != nil {
						return err
					}
				}
			case "cp":
				var nonFlags []string
				for _, a := range args {
					if !strings.HasPrefix(a, "-") {
						nonFlags = append(nonFlags, a)
					}
				}
				for idx, p := range nonFlags {
					resolved := p
					if !filepath.IsAbs(resolved) {
						resolved = filepath.Join(curCWD, resolved)
					}
					if idx == len(nonFlags)-1 && len(nonFlags) >= 2 {
						if err := en.checkWritePath(resolved); err != nil {
							return err
						}
					} else {
						if err := en.checkPath(resolved); err != nil {
							return err
						}
					}
				}
			}
			return nil
		}

		if err := en.checkReadOnlyNativeCommand(curCWD, baseCmd, args); err != nil {
			return err
		}
		isBareCmd := !strings.ContainsAny(prog, `/\`) && !filepath.IsAbs(prog)
		if isBareCmd {
			if lp, err := lookPathWithEnv(prog, curCWD, envMapToSlice(envMap)); err == nil {
				if en.checkPath(lp) == nil {
					if b, rerr := readFileBounded(lp, 256*1024); rerr == nil {
						if classifyScriptFileKind(lp, b) == "sh" {
							if err := en.checkSpawnCmdline(curCWD, string(b), envMap, depth+1); err != nil {
								return err
							}
						}
					}
				}
				return nil
			}
		}

		resolvedProg := prog
		if !filepath.IsAbs(resolvedProg) {
			resolvedProg = filepath.Join(curCWD, prog)
		}
		if err := en.checkPath(resolvedProg); err != nil {
			return err
		}
		if b, rerr := readFileBounded(resolvedProg, 256*1024); rerr == nil {
			kind := classifyScriptFileKind(resolvedProg, b)
			if kind == "sh" {
				if err := en.checkSpawnCmdline(curCWD, string(b), envMap, depth+1); err != nil {
					return err
				}
			} else if kind == "" {
				en.mu.Lock()
				hasJail := len(en.jailRoots) > 0
				en.mu.Unlock()
				if hasJail {
					return fmt.Errorf("EACCES: jailed: executing native binary %q is not allowed in sandbox", prog)
				}
			}
		}
		return nil
	}

	for i := 0; i < len(toks); i++ {
		t := toks[i]
		if t.op != "" {
			switch t.op {
			case ";", ";;", "|", "&&", "||":
				if err := flushSimpleCmd(); err != nil {
					return err
				}
			case "subshell":
				if err := flushSimpleCmd(); err != nil {
					return err
				}
				if err := en.checkSpawnCmdline(curCWD, t.word, envMap, depth+1); err != nil {
					return err
				}
			case "<<<":
				if i+1 < len(toks) && toks[i+1].op == "" {
					i++
				}
			case "<", ">", ">>", "2>", "2>>", "&>", "&>>":
				if i+1 < len(toks) && toks[i+1].op == "" {
					i++
					target := expandShellVars(toks[i].word, envMap)
					target = joinCWDPath(curCWD, target)
					if t.op == "<" {
						if err := en.checkPath(target); err != nil {
							return err
						}
					} else {
						if err := en.checkWritePath(target); err != nil {
							return err
						}
					}
				}
			}
			continue
		}
		if t.word == "" {
			continue
		}
		w := t.word
		if len(curWords) == 0 {
			if strings.HasSuffix(w, ")") {
				continue
			}
			switch w {
			case "if", "then", "elif", "else", "fi", "do", "done", "while", "until", "esac", "!", "{", "}", "function":
				continue
			case "for":
				// Skip `for var [in words...]` up to `;` or `do`
				for i+1 < len(toks) {
					i++
					if toks[i].op == ";" {
						break
					}
					if toks[i].op == "" && toks[i].word == "do" {
						break
					}
				}
				continue
			case "case":
				for i+1 < len(toks) {
					i++
					if toks[i].op == "" && toks[i].word == "in" {
						break
					}
				}
				continue
			}
		}
		if len(curWords) == 0 && strings.IndexByte(w, '=') > 0 && isEnvVarIdent(w[:strings.IndexByte(w, '=')]) {
			idx := strings.IndexByte(w, '=')
			key := w[:idx]
			if isRejectedJailedEnvKey(key) {
				return fmt.Errorf("EACCES: jailed: environment variable %q is not allowed in sandbox", key)
			}
			val := expandShellVars(w[idx+1:], envMap)
			if !isBlockedJailedEnvKey(key) {
				envMap[key] = val
			}
			if err := en.checkArgvPaths(curCWD, []string{val}); err != nil {
				return err
			}
			continue
		}
		expanded := expandShellVars(w, envMap)
		if !(len(curWords) == 0 && (en.isSelfExePath(w) || en.isSelfExePath(expanded))) {
			prevWord := ""
			if len(curWords) > 0 {
				prevWord = curWords[len(curWords)-1]
			}
			isInlineJSEval := (prevWord == "-e" || prevWord == "--eval" || prevWord == "-p" || prevWord == "--print") &&
				len(curWords) >= 2 && (strings.EqualFold(strings.TrimSuffix(filepath.Base(curWords[0]), ".exe"), "node") || en.isSelfExePath(curWords[0]))
			if !isInlineJSEval {
				if err := en.checkArgvPaths(curCWD, []string{w, expanded}); err != nil {
					return err
				}
			}
		}
		for _, sub := range extractSubshells(w) {
			if err := en.checkSpawnCmdline(curCWD, sub, envMap, depth+1); err != nil {
				return err
			}
		}
		curWords = append(curWords, expanded)
	}
	return flushSimpleCmd()
}

func (en *rtEntry) checkSpawnReqPaths(cwd string, req cpSpawnReq, stdinBytes []byte) error {
	if !en.hasSandboxRestrictions() {
		return nil
	}
	if s, ok := req.Shell.(string); ok && s != "" && s != "$" && s != "true" {
		if !isShellInterpreterName(filepath.Base(s)) {
			return fmt.Errorf("EACCES: jailed: custom shell %q is not allowed in sandbox", s)
		}
	}
	if req.Env != nil {
		for k := range req.Env {
			if isRejectedJailedEnvKey(k) {
				return fmt.Errorf("EACCES: jailed: environment variable %q is not allowed in sandbox", k)
			}
		}
	}
	if !isShellOptTruthy(req.Shell) && en.isSelfJSExec(req.Command, req.Args) {
		for i := 1; i < len(req.Args); i++ {
			a := req.Args[i]
			if a == "-e" || a == "--eval" || a == "-p" || a == "--print" {
				i++
				if i+1 < len(req.Args) {
					return en.checkArgvPaths(cwd, req.Args[i+1:])
				}
				return nil
			}
			if strings.HasPrefix(a, "-") {
				continue
			}
			resolved := joinCWDPath(cwd, a)
			if err := en.checkPath(resolved); err != nil {
				return err
			}
			if i+1 < len(req.Args) {
				return en.checkArgvPaths(cwd, req.Args[i+1:])
			}
			return nil
		}
		return nil
	}
	envMap := en.resolveSpawnEnv(req)
	cmdline := extractFallbackCmdline(req)
	if err := en.checkSpawnCmdline(cwd, cmdline, envMap, 0); err != nil {
		return err
	}
	if len(stdinBytes) > 0 && shellReadsScriptFromStdin(req) {
		if err := en.checkSpawnCmdline(cwd, string(stdinBytes), envMap, 0); err != nil {
			return err
		}
	}
	return nil
}

func shellReadsScriptFromStdin(req cpSpawnReq) bool {
	checkArgs := func(args []string) bool {
		hasS := false
		for i := 0; i < len(args); i++ {
			a := args[i]
			if a == "-c" || strings.EqualFold(a, "/c") {
				return false
			}
			if a == "-s" {
				hasS = true
				break
			}
			if a == "/d" || a == "/s" || strings.HasPrefix(a, "-") {
				continue
			}
			return false
		}
		_ = hasS
		return true
	}
	if isShellInterpreterName(req.Command) && !isShellOptTruthy(req.Shell) {
		return checkArgs(req.Args)
	}
	cmdline := extractFallbackCmdline(req)
	toks, err := tokenizePOSIXShell(cmdline)
	if err != nil || len(toks) == 0 {
		return false
	}
	var curWords []string
	for _, t := range toks {
		if t.op != "" {
			if (t.op == ";" || t.op == "|" || t.op == "&&" || t.op == "||") && len(curWords) > 0 {
				if isShellInterpreterName(curWords[0]) && checkArgs(curWords[1:]) {
					return true
				}
				curWords = nil
			}
			continue
		}
		if len(curWords) == 0 && strings.IndexByte(t.word, '=') > 0 && isEnvVarIdent(t.word[:strings.IndexByte(t.word, '=')]) {
			continue
		}
		curWords = append(curWords, t.word)
	}
	if len(curWords) > 0 && isShellInterpreterName(curWords[0]) && checkArgs(curWords[1:]) {
		return true
	}
	return false
}

func signalNameFromNumber(sig int) string {
	switch sig {
	case 1:
		return "SIGHUP"
	case 2:
		return "SIGINT"
	case 3:
		return "SIGQUIT"
	case 4:
		return "SIGILL"
	case 5:
		return "SIGTRAP"
	case 6:
		return "SIGABRT"
	case 7:
		return "SIGBUS"
	case 8:
		return "SIGFPE"
	case 9:
		return "SIGKILL"
	case 10:
		return "SIGUSR1"
	case 11:
		return "SIGSEGV"
	case 12:
		return "SIGUSR2"
	case 13:
		return "SIGPIPE"
	case 14:
		return "SIGALRM"
	case 15:
		return "SIGTERM"
	case 17:
		return "SIGCHLD"
	case 18:
		return "SIGCONT"
	case 19:
		return "SIGSTOP"
	case 20:
		return "SIGTSTP"
	case 21:
		return "SIGBREAK"
	case 28:
		return "SIGWINCH"
	default:
		return "SIGTERM"
	}
}

func (en *rtEntry) applySandboxEnvRoots(out map[string]string) {
	en.mu.Lock()
	defer en.mu.Unlock()
	if len(en.jailRoots) > 0 {
		out["__INDIRECT_JAIL_ROOTS"] = strings.Join(en.jailRoots, string(os.PathListSeparator))
	} else {
		delete(out, "__INDIRECT_JAIL_ROOTS")
	}
	if len(en.readOnlyRoots) > 0 {
		out["__INDIRECT_READONLY_ROOTS"] = strings.Join(en.readOnlyRoots, string(os.PathListSeparator))
	} else {
		delete(out, "__INDIRECT_READONLY_ROOTS")
	}
	if len(en.fsReadRoots) > 0 {
		out["__INDIRECT_FS_READ_ROOTS"] = strings.Join(en.fsReadRoots, string(os.PathListSeparator))
	} else {
		delete(out, "__INDIRECT_FS_READ_ROOTS")
	}
	if len(en.fsWriteRoots) > 0 {
		out["__INDIRECT_FS_WRITE_ROOTS"] = strings.Join(en.fsWriteRoots, string(os.PathListSeparator))
	} else {
		delete(out, "__INDIRECT_FS_WRITE_ROOTS")
	}
	if len(en.netAllow) > 0 {
		out["__INDIRECT_NET_ALLOW"] = strings.Join(en.netAllow, ",")
	} else {
		delete(out, "__INDIRECT_NET_ALLOW")
	}
}

func (en *rtEntry) enforceChildEnvMap(out map[string]string) {
	if !en.hasSandboxRestrictions() {
		return
	}
	for k := range out {
		if isBlockedJailedEnvKey(k) {
			delete(out, k)
		}
	}
	en.applySandboxEnvRoots(out)
}

func (en *rtEntry) resolveSpawnEnv(req cpSpawnReq) map[string]string {
	var out map[string]string
	if req.Env != nil {
		out = make(map[string]string, len(req.Env)+4)
		for k, v := range req.Env {
			out[k] = v
		}
	} else {
		en.mu.Lock()
		out = make(map[string]string, len(en.env)+4)
		for k, v := range en.env {
			out[k] = v
		}
		en.mu.Unlock()
	}
	en.enforceChildEnvMap(out)
	return out
}

func envMapToSlice(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k, v := range m {
		if strings.HasPrefix(k, "\x00") {
			continue
		}
		out = append(out, k+"="+v)
	}
	return out
}

func isDollarShellFallback(en *rtEntry, req cpSpawnReq) bool {
	en.mu.Lock()
	hasJail := len(en.jailRoots) > 0
	en.mu.Unlock()
	if hasJail && (isShellOptTruthy(req.Shell) || !en.isSelfJSExec(req.Command, req.Args)) {
		return true
	}
	if s, ok := req.Shell.(string); ok && s == "$" {
		return en.shellPath == ""
	}
	return false
}

func isAlreadyShellQuoted(s string) bool {
	if len(s) >= 2 {
		if (s[0] == '"' && s[len(s)-1] == '"') || (s[0] == '\'' && s[len(s)-1] == '\'') {
			return true
		}
	}
	return false
}

func quotePOSIXShellArgIfNeeded(a string) string {
	if a == "" {
		return "''"
	}
	if isAlreadyShellQuoted(a) {
		return a
	}
	if strings.ContainsAny(a, " \t\r\n\"'&|<>^();$`\\") {
		return posixShellQuote(a)
	}
	return a
}

func quoteCmdExeArg(a string, isEcho bool) string {
	if isEcho {
		var b strings.Builder
		for i := 0; i < len(a); i++ {
			c := a[i]
			switch c {
			case '^', '&', '|', '<', '>', '(', ')':
				b.WriteByte('^')
				b.WriteByte(c)
			default:
				b.WriteByte(c)
			}
		}
		return b.String()
	}
	if a == "" {
		return `""`
	}
	if isAlreadyShellQuoted(a) {
		return a
	}
	if !strings.ContainsAny(a, " \t\"&|<>^()") {
		return a
	}
	return `"` + strings.ReplaceAll(a, `"`, `\"`) + `"`
}

func setWindowsCmdLine(cmd *exec.Cmd, shPath, cmdline string) {
	if runtime.GOOS != "windows" {
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{}
	rv := reflect.ValueOf(cmd.SysProcAttr).Elem()
	if f := rv.FieldByName("CmdLine"); f.IsValid() && f.CanSet() && f.Kind() == reflect.String {
		qSh := shPath
		if strings.ContainsAny(qSh, " \t") && !strings.HasPrefix(qSh, `"`) {
			qSh = `"` + qSh + `"`
		}
		f.SetString(qSh + ` /d /s /c "` + cmdline + `"`)
	}
}

func extractFallbackCmdline(req cpSpawnReq) string {
	if isShellOptTruthy(req.Shell) {
		if isShellInterpreterName(req.Command) && len(req.Args) >= 2 && (req.Args[0] == "-c" || strings.EqualFold(req.Args[0], "/c")) {
			return strings.Join(req.Args[1:], " ")
		}
		cmdline := req.Command
		if len(req.Args) > 0 {
			if (filepath.IsAbs(req.Command) || strings.ContainsAny(req.Command, " \t")) && !strings.ContainsAny(req.Command, "\"';|&<>()$`") {
				cmdline = posixShellQuote(req.Command)
			}
			quotedArgs := make([]string, len(req.Args))
			for i, a := range req.Args {
				quotedArgs[i] = quotePOSIXShellArgIfNeeded(a)
			}
			cmdline = cmdline + " " + strings.Join(quotedArgs, " ")
		}
		return cmdline
	}
	if isShellInterpreterName(req.Command) && len(req.Args) == 2 && (req.Args[0] == "-c" || strings.EqualFold(req.Args[0], "/c")) {
		return req.Args[1]
	}
	quoted := make([]string, 0, 1+len(req.Args))
	quoted = append(quoted, posixShellQuote(req.Command))
	for _, a := range req.Args {
		quoted = append(quoted, posixShellQuote(a))
	}
	return strings.Join(quoted, " ")
}

func tokensRequireStdinWait(toks []posixToken) bool {
	if len(toks) == 0 {
		return false
	}
	inPipeRHS := false
	hasInputRedirect := false
	var curWords []string
	flushCmd := func() bool {
		if len(curWords) == 0 {
			hasInputRedirect = false
			return false
		}
		words := curWords
		curWords = nil
		redir := hasInputRedirect
		hasInputRedirect = false
		if inPipeRHS || redir {
			return false
		}
		for len(words) > 0 {
			w := words[0]
			if w == "!" || w == "{" || w == "}" || w == "then" || w == "else" || w == "elif" || w == "do" {
				words = words[1:]
				continue
			}
			if idx := strings.IndexByte(w, '='); idx > 0 && isEnvVarIdent(w[:idx]) {
				words = words[1:]
				continue
			}
			break
		}
		if len(words) == 0 {
			return false
		}
		return requiresStdinWait(cpSpawnReq{Command: words[0], Args: words[1:]})
	}
	for i := 0; i < len(toks); i++ {
		t := toks[i]
		if t.op != "" {
			switch t.op {
			case "|":
				if flushCmd() {
					return true
				}
				inPipeRHS = true
			case ";", "&&", "||", ";;":
				if flushCmd() {
					return true
				}
				inPipeRHS = false
			case "<", "<<", "<<'", "<<<":
				hasInputRedirect = true
				if (t.op == "<" || t.op == "<<<") && i+1 < len(toks) && toks[i+1].op == "" {
					i++
				}
			case ">", ">>", "2>", "2>>", "&>", "&>>":
				if i+1 < len(toks) && toks[i+1].op == "" {
					i++
				}
			case "subshell":
				if !inPipeRHS && !hasInputRedirect {
					if subToks, err := tokenizePOSIXShell(t.word); err == nil && tokensRequireStdinWait(subToks) {
						return true
					}
				}
			}
			continue
		}
		if t.word != "" {
			curWords = append(curWords, t.word)
		}
	}
	return flushCmd()
}

func requiresStdinWait(req cpSpawnReq) bool {
	if isShellOptTruthy(req.Shell) {
		cmdline := extractFallbackCmdline(req)
		toks, err := tokenizePOSIXShell(cmdline)
		if err == nil {
			return tokensRequireStdinWait(toks)
		}
		return false
	}
	if isShellInterpreterName(req.Command) {
		for idx, a := range req.Args {
			if a == "-c" || strings.EqualFold(a, "/c") {
				if idx+1 < len(req.Args) {
					toks, err := tokenizePOSIXShell(req.Args[idx+1])
					if err == nil {
						return tokensRequireStdinWait(toks)
					}
				}
				return false
			}
			if a == "-s" {
				return true
			}
			if !strings.HasPrefix(a, "-") {
				return false
			}
		}
		return true
	}
	base := strings.ToLower(strings.TrimSuffix(filepath.Base(req.Command), ".exe"))
	switch base {
	case "tr", "read":
		return true
	case "cat", "head", "tail", "wc", "sort", "uniq", "cut", "tee", "base64", "shasum", "sha256sum", "md5sum", "xargs", "more", "less":
		for i := 0; i < len(req.Args); i++ {
			a := req.Args[i]
			switch base {
			case "head", "tail":
				if a == "-n" || a == "-c" {
					i++
					continue
				}
			case "sort":
				if a == "-k" || a == "-t" || a == "-o" {
					i++
					continue
				}
			case "uniq":
				if a == "-f" || a == "-s" || a == "-w" {
					i++
					continue
				}
			case "cut":
				if a == "-d" || a == "-f" || a == "-c" || a == "-b" {
					i++
					continue
				}
			case "xargs":
				if a == "-n" || a == "-L" || a == "-I" || a == "-P" || a == "-s" {
					i++
					continue
				}
			}
			if !strings.HasPrefix(a, "-") || a == "-" {
				return a == "-"
			}
		}
		return true
	case "grep", "egrep", "fgrep", "rg":
		posCount := 0
		hasExplicitPat := false
		for i := 0; i < len(req.Args); i++ {
			a := req.Args[i]
			if a == "-e" || a == "-f" {
				hasExplicitPat = true
				i++
				continue
			}
			if strings.HasPrefix(a, "-e") || strings.HasPrefix(a, "-f") || strings.HasPrefix(a, "--regexp=") || strings.HasPrefix(a, "--file=") {
				hasExplicitPat = true
				continue
			}
			if a == "-m" || a == "-A" || a == "-B" || a == "-C" {
				i++
				continue
			}
			if strings.HasPrefix(a, "-") && a != "-" {
				continue
			}
			posCount++
		}
		if hasExplicitPat {
			return posCount == 0
		}
		return posCount <= 1
	case "sed", "awk", "gawk", "jq":
		hasExplicitScript := false
		posCount := 0
		for i := 0; i < len(req.Args); i++ {
			a := req.Args[i]
			if a == "-e" || a == "-f" {
				hasExplicitScript = true
				i++
				continue
			}
			if (strings.HasPrefix(a, "-e") || strings.HasPrefix(a, "-f")) && len(a) > 2 {
				hasExplicitScript = true
				continue
			}
			if a == "-F" || a == "-v" || a == "--arg" || a == "--argjson" {
				if a == "--arg" || a == "--argjson" {
					i += 2
				} else {
					i++
				}
				continue
			}
			if strings.HasPrefix(a, "-") && a != "-" {
				continue
			}
			posCount++
		}
		if hasExplicitScript {
			return posCount == 0
		}
		return posCount <= 1
	}
	return false
}

func readFileBounded(p string, maxBytes int64) ([]byte, error) {
	if maxBytes <= 0 {
		maxBytes = maxHostBufferBytes
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if info, serr := f.Stat(); serr == nil {
		if info.IsDir() {
			return nil, fmt.Errorf("EISDIR: illegal operation on a directory, read '%s'", p)
		}
		if info.Size() > maxBytes {
			return nil, fmt.Errorf("ENOBUFS: file %q exceeds maxBuffer (%d bytes)", p, maxBytes)
		}
	}
	lr := io.LimitReader(f, maxBytes+1)
	b, err := io.ReadAll(lr)
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > maxBytes {
		return nil, fmt.Errorf("ENOBUFS: file %q exceeds maxBuffer (%d bytes)", p, maxBytes)
	}
	return b, nil
}

func findExecutableCandidate(cand string, pathext []string) (string, bool) {
	if runtime.GOOS == "windows" {
		ext := strings.ToLower(filepath.Ext(cand))
		hasKnownExt := false
		for _, pe := range pathext {
			if ext != "" && strings.EqualFold(ext, pe) {
				hasKnownExt = true
				break
			}
		}
		if hasKnownExt {
			if info, err := os.Stat(cand); err == nil && !info.IsDir() {
				return cand, true
			}
		}
		for _, pe := range pathext {
			if pe == "" {
				continue
			}
			withExt := cand + pe
			if info, err := os.Stat(withExt); err == nil && !info.IsDir() {
				return withExt, true
			}
		}
		if ext != "" {
			if info, err := os.Stat(cand); err == nil && !info.IsDir() {
				return cand, true
			}
		}
		return "", false
	}
	info, err := os.Stat(cand)
	if err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
		return cand, true
	}
	return "", false
}

func lookPathWithEnv(file, cwd string, envSlice []string) (string, error) {
	if file == "" {
		return "", &exec.Error{Name: file, Err: exec.ErrNotFound}
	}
	pathVal := ""
	pathextVal := ""
	hasPathKey := false
	for _, kv := range envSlice {
		idx := strings.IndexByte(kv, '=')
		if idx <= 0 {
			continue
		}
		k, v := kv[:idx], kv[idx+1:]
		if runtime.GOOS == "windows" {
			if strings.EqualFold(k, "PATH") {
				pathVal = v
				hasPathKey = true
			} else if strings.EqualFold(k, "PATHEXT") {
				pathextVal = v
			}
		} else if k == "PATH" {
			pathVal = v
			hasPathKey = true
		}
	}
	if !hasPathKey {
		pathVal = os.Getenv("PATH")
	}
	var pathext []string
	if runtime.GOOS == "windows" {
		if pathextVal == "" {
			pathextVal = os.Getenv("PATHEXT")
		}
		if pathextVal == "" {
			pathextVal = ".COM;.EXE;.BAT;.CMD"
		}
		for _, e := range strings.Split(pathextVal, ";") {
			e = strings.TrimSpace(e)
			if e == "" {
				continue
			}
			if e[0] != '.' {
				e = "." + e
			}
			pathext = append(pathext, strings.ToLower(e))
		}
	}

	hasSlash := strings.ContainsAny(file, `/\`) || (runtime.GOOS == "windows" && strings.Contains(file, ":"))
	if hasSlash || filepath.IsAbs(file) {
		cand := file
		if !filepath.IsAbs(cand) && cwd != "" {
			cand = filepath.Join(cwd, cand)
		}
		if found, ok := findExecutableCandidate(cand, pathext); ok {
			return found, nil
		}
		return "", &exec.Error{Name: file, Err: exec.ErrNotFound}
	}

	for _, dir := range filepath.SplitList(pathVal) {
		if dir == "" {
			if runtime.GOOS == "windows" {
				continue
			}
			dir = "."
		}
		if !filepath.IsAbs(dir) && cwd != "" {
			dir = filepath.Join(cwd, dir)
		}
		cand := filepath.Join(dir, file)
		if found, ok := findExecutableCandidate(cand, pathext); ok {
			return found, nil
		}
	}
	return "", &exec.Error{Name: file, Err: exec.ErrNotFound}
}

func (en *rtEntry) buildExecCmd(ctx context.Context, req cpSpawnReq, cwd string, envSlice []string) *exec.Cmd {
	var cmd *exec.Cmd
	useShell := false
	customShell := ""
	switch v := req.Shell.(type) {
	case bool:
		useShell = v
	case string:
		if v != "" {
			useShell = true
			customShell = v
		}
	}

	en.mu.Lock()
	if len(en.jailRoots) > 0 {
		useShell = false
	}
	en.mu.Unlock()

	if useShell {
		shPath := customShell
		shFlag := "-c"
		if shPath == "" || shPath == "$" || shPath == "true" {
			if en.shellPath != "" {
				shPath = en.shellPath
				if en.shellFlag != "" {
					shFlag = en.shellFlag
				}
			} else if runtime.GOOS == "windows" {
				shPath = "cmd.exe"
				shFlag = "/d /s /c"
			} else {
				shPath = "/bin/sh"
				shFlag = "-c"
			}
		} else if strings.HasSuffix(strings.ToLower(shPath), "cmd.exe") || strings.EqualFold(shPath, "cmd") {
			shFlag = "/d /s /c"
		}
		if resolvedSh, lerr := lookPathWithEnv(shPath, cwd, envSlice); lerr == nil {
			shPath = resolvedSh
		}
		cmdline := req.Command
		if len(req.Args) > 0 {
			if shFlag == "/d /s /c" {
				isEcho := strings.EqualFold(strings.TrimSpace(req.Command), "echo")
				cmdPart := req.Command
				if !isEcho && strings.ContainsAny(cmdPart, " \t") && !isAlreadyShellQuoted(cmdPart) && !strings.ContainsAny(cmdPart, "\"&|<>^()") {
					cmdPart = `"` + cmdPart + `"`
				}
				quotedArgs := make([]string, len(req.Args))
				for i, a := range req.Args {
					quotedArgs[i] = quoteCmdExeArg(a, isEcho)
				}
				cmdline = cmdPart + " " + strings.Join(quotedArgs, " ")
			} else {
				cmdPart := req.Command
				if strings.ContainsAny(cmdPart, " \t") && !isAlreadyShellQuoted(cmdPart) && !strings.ContainsAny(cmdPart, "\"';|&<>()$`") {
					cmdPart = posixShellQuote(cmdPart)
				}
				quotedArgs := make([]string, len(req.Args))
				for i, a := range req.Args {
					quotedArgs[i] = quotePOSIXShellArgIfNeeded(a)
				}
				cmdline = cmdPart + " " + strings.Join(quotedArgs, " ")
			}
		}
		if shFlag == "/d /s /c" {
			cmd = exec.CommandContext(ctx, shPath, "/d", "/s", "/c", cmdline)
			setWindowsCmdLine(cmd, shPath, cmdline)
		} else {
			cmd = exec.CommandContext(ctx, shPath, shFlag, cmdline)
		}
	} else {
		resolvedProg, lookErr := lookPathWithEnv(req.Command, cwd, envSlice)
		execArgs := req.Args
		if en.execPath != "" && (req.Command == en.execPath || (lookErr == nil && strings.EqualFold(filepath.Clean(resolvedProg), filepath.Clean(en.execPath)))) {
			if len(execArgs) > 0 && execArgs[0] != "--js" && execArgs[0] != "--worker" && execArgs[0] != "--runner" && execArgs[0] != "--runner-command" && execArgs[0] != "--update-start" && execArgs[0] != "--update-end" && execArgs[0] != "--slot" && !strings.HasPrefix(execArgs[0], "-test.") {
				execArgs = append([]string{"--js"}, execArgs...)
			}
		}
		if lookErr != nil {
			cmd = exec.CommandContext(ctx, req.Command, execArgs...)
			cmd.Path = req.Command
			cmd.Err = lookErr
		} else {
			cmd = exec.CommandContext(ctx, resolvedProg, execArgs...)
			if len(cmd.Args) > 0 {
				cmd.Args[0] = req.Command
			}
		}
	}

	cmd.Dir = cwd
	cmd.Env = envSlice
	return cmd
}

type posixToken struct {
	word string
	op   string
	raw  string
}

func scanBalancedParens(src string, start int) (int, error) {
	depth := 0
	i := start
	for i < len(src) {
		c := src[i]
		if c == '\\' && i+1 < len(src) {
			i += 2
			continue
		}
		if c == '\'' {
			i++
			for i < len(src) && src[i] != '\'' {
				i++
			}
			if i >= len(src) {
				return i, fmt.Errorf("unterminated single quote")
			}
			i++
			continue
		}
		if c == '"' {
			i++
			for i < len(src) && src[i] != '"' {
				if src[i] == '\\' && i+1 < len(src) {
					i += 2
					continue
				}
				i++
			}
			if i >= len(src) {
				return i, fmt.Errorf("unterminated double quote")
			}
			i++
			continue
		}
		if c == '(' {
			depth++
		} else if c == ')' {
			depth--
			if depth == 0 {
				return i + 1, nil
			}
		}
		i++
	}
	return i, fmt.Errorf("unterminated '('")
}

func tokenizePOSIXShell(src string) ([]posixToken, error) {
	var tokens []posixToken
	var cur strings.Builder
	inToken := false
	tokStart := 0
	i := 0
	startToken := func(pos int) {
		if !inToken {
			inToken = true
			tokStart = pos
		}
	}
	flushWord := func(endPos int) {
		if inToken {
			raw := ""
			if tokStart >= 0 && endPos <= len(src) && tokStart <= endPos {
				raw = src[tokStart:endPos]
			}
			tokens = append(tokens, posixToken{word: cur.String(), raw: raw})
			cur.Reset()
			inToken = false
		}
	}
	for i < len(src) {
		c := src[i]
		if c == ' ' || c == '\t' || c == '\r' {
			flushWord(i)
			i++
			continue
		}
		if c == '#' && !inToken {
			for i < len(src) && src[i] != '\n' {
				i++
			}
			continue
		}
		if c == '\n' || c == ';' {
			flushWord(i)
			if c == ';' && i+1 < len(src) && src[i+1] == ';' {
				tokens = append(tokens, posixToken{op: ";;", raw: ";;"})
				i += 2
			} else {
				tokens = append(tokens, posixToken{op: ";", raw: ";"})
				i++
			}
			continue
		}
		if c == '(' && inToken && i+1 < len(src) && src[i+1] == ')' && isEnvVarIdent(cur.String()) {
			cur.WriteString("()")
			flushWord(i + 2)
			i += 2
			continue
		}
		if c == '(' && !inToken {
			endIdx, err := scanBalancedParens(src, i)
			if err != nil {
				return nil, err
			}
			inner := src[i+1 : endIdx-1]
			tokens = append(tokens, posixToken{word: inner, op: "subshell", raw: src[i:endIdx]})
			i = endIdx
			continue
		}
		if c == ')' && !inToken {
			tokens = append(tokens, posixToken{op: ")", raw: ")"})
			i++
			continue
		}
		if c == '&' {
			flushWord(i)
			if i+1 < len(src) && src[i+1] == '&' {
				tokens = append(tokens, posixToken{op: "&&", raw: "&&"})
				i += 2
			} else if i+2 < len(src) && src[i+1] == '>' && src[i+2] == '>' {
				tokens = append(tokens, posixToken{op: "&>>", raw: "&>>"})
				i += 3
			} else if i+1 < len(src) && src[i+1] == '>' {
				tokens = append(tokens, posixToken{op: "&>", raw: "&>"})
				i += 2
			} else {
				tokens = append(tokens, posixToken{op: ";", raw: ";"})
				i++
			}
			continue
		}
		if c == '|' {
			flushWord(i)
			if i+1 < len(src) && src[i+1] == '|' {
				tokens = append(tokens, posixToken{op: "||", raw: "||"})
				i += 2
			} else {
				tokens = append(tokens, posixToken{op: "|", raw: "|"})
				i++
			}
			continue
		}
		if c == '1' && !inToken && i+1 < len(src) && src[i+1] == '>' {
			if i+3 < len(src) && src[i+2] == '&' && src[i+3] == '2' {
				tokens = append(tokens, posixToken{op: "1>&2", raw: "1>&2"})
				i += 4
				continue
			}
			if i+3 < len(src) && src[i+2] == '&' && src[i+3] == '1' {
				i += 4
				continue
			}
			if i+2 < len(src) && src[i+2] == '>' {
				tokens = append(tokens, posixToken{op: ">>", raw: "1>>"})
				i += 3
				continue
			}
			tokens = append(tokens, posixToken{op: ">", raw: "1>"})
			i += 2
			continue
		}
		if c == '2' && !inToken && i+1 < len(src) && src[i+1] == '>' {
			if i+3 < len(src) && src[i+2] == '&' && src[i+3] == '1' {
				tokens = append(tokens, posixToken{op: "2>&1", raw: "2>&1"})
				i += 4
				continue
			}
			if i+3 < len(src) && src[i+2] == '&' && src[i+3] == '2' {
				i += 4
				continue
			}
			if i+2 < len(src) && src[i+2] == '>' {
				tokens = append(tokens, posixToken{op: "2>>", raw: "2>>"})
				i += 3
				continue
			}
			tokens = append(tokens, posixToken{op: "2>", raw: "2>"})
			i += 2
			continue
		}
		if c == '>' {
			flushWord(i)
			if i+2 < len(src) && src[i+1] == '&' && src[i+2] == '2' {
				tokens = append(tokens, posixToken{op: "1>&2", raw: ">&2"})
				i += 3
			} else if i+2 < len(src) && src[i+1] == '&' && src[i+2] == '1' {
				i += 3
			} else if i+1 < len(src) && src[i+1] == '>' {
				tokens = append(tokens, posixToken{op: ">>", raw: ">>"})
				i += 2
			} else {
				tokens = append(tokens, posixToken{op: ">", raw: ">"})
				i++
			}
			continue
		}
		if c == '<' {
			flushWord(i)
			if i+2 < len(src) && src[i+1] == '<' && src[i+2] == '<' {
				tokens = append(tokens, posixToken{op: "<<<", raw: "<<<"})
				i += 3
			} else if i+1 < len(src) && src[i+1] == '<' {
				i += 2
				stripTabs := false
				if i < len(src) && src[i] == '-' {
					stripTabs = true
					i++
				}
				for i < len(src) && (src[i] == ' ' || src[i] == '\t') {
					i++
				}
				var delimBuf strings.Builder
				quotedDelim := false
				for i < len(src) && src[i] != ' ' && src[i] != '\t' && src[i] != '\r' && src[i] != '\n' && src[i] != ';' && src[i] != '&' && src[i] != '|' && src[i] != '<' && src[i] != '>' && src[i] != ')' {
					if src[i] == '\'' {
						quotedDelim = true
						i++
						for i < len(src) && src[i] != '\'' {
							delimBuf.WriteByte(src[i])
							i++
						}
						if i < len(src) {
							i++
						}
						continue
					}
					if src[i] == '"' {
						quotedDelim = true
						i++
						for i < len(src) && src[i] != '"' {
							if src[i] == '\\' && i+1 < len(src) {
								i++
							}
							delimBuf.WriteByte(src[i])
							i++
						}
						if i < len(src) {
							i++
						}
						continue
					}
					if src[i] == '\\' && i+1 < len(src) {
						quotedDelim = true
						i++
						delimBuf.WriteByte(src[i])
						i++
						continue
					}
					delimBuf.WriteByte(src[i])
					i++
				}
				delim := delimBuf.String()
				nlRel := strings.IndexByte(src[i:], '\n')
				var heredocBody string
				if nlRel >= 0 {
					lineStart := i + nlRel + 1
					bodyEnd := len(src)
					var bodyLines strings.Builder
					pos := lineStart
					for pos < len(src) {
						nextNL := strings.IndexByte(src[pos:], '\n')
						var line string
						var nextPos int
						if nextNL >= 0 {
							line = src[pos : pos+nextNL]
							nextPos = pos + nextNL + 1
						} else {
							line = src[pos:]
							nextPos = len(src)
						}
						cleanLine := strings.TrimSuffix(line, "\r")
						checkLine := cleanLine
						if stripTabs {
							checkLine = strings.TrimLeft(checkLine, "\t")
						}
						if checkLine == delim {
							bodyEnd = nextPos
							break
						}
						if stripTabs {
							cleanLine = strings.TrimLeft(cleanLine, "\t")
						}
						bodyLines.WriteString(cleanLine)
						bodyLines.WriteByte('\n')
						pos = nextPos
					}
					heredocBody = bodyLines.String()
					src = src[:lineStart] + src[bodyEnd:]
				}
				opStr := "<<"
				if quotedDelim {
					opStr = "<<'"
				}
				tokens = append(tokens, posixToken{op: opStr, word: heredocBody})
			} else {
				tokens = append(tokens, posixToken{op: "<", raw: "<"})
				i++
			}
			continue
		}
		if c == '$' && i+1 < len(src) && src[i+1] == '\'' {
			wasStart := !inToken
			startToken(i)
			cur.WriteByte('\x03')
			i += 2
			var ansiBuf strings.Builder
			for i < len(src) && src[i] != '\'' {
				if src[i] == '\\' && i+1 < len(src) {
					if src[i+1] == '\'' || src[i+1] == '"' {
						ansiBuf.WriteByte(src[i+1])
						i += 2
						continue
					}
					ansiBuf.WriteByte(src[i])
					ansiBuf.WriteByte(src[i+1])
					i += 2
					continue
				}
				ansiBuf.WriteByte(src[i])
				i++
			}
			if i >= len(src) {
				return nil, fmt.Errorf("unterminated ANSI-C quote")
			}
			i++
			expanded, _ := expandEchoEscapes(ansiBuf.String())
			for k := 0; k < len(expanded); k++ {
				if wasStart && expanded[k] == '~' {
					cur.WriteByte('\x01')
				}
				wasStart = false
				switch expanded[k] {
				case '$', '%', '`', '*', '?', '[', '{', '}', ',':
					cur.WriteByte('\x01')
				}
				cur.WriteByte(expanded[k])
			}
			cur.WriteByte('\x03')
			continue
		}
		if c == '$' && i+1 < len(src) && src[i+1] == '{' {
			startToken(i)
			depth := 1
			j := i + 2
			for j < len(src) && depth > 0 {
				if src[j] == '\\' && j+1 < len(src) {
					j += 2
					continue
				}
				if src[j] == '\'' {
					j++
					for j < len(src) && src[j] != '\'' {
						j++
					}
					if j < len(src) {
						j++
					}
					continue
				}
				if src[j] == '"' {
					j++
					for j < len(src) && src[j] != '"' {
						if src[j] == '\\' && j+1 < len(src) {
							j += 2
							continue
						}
						j++
					}
					if j < len(src) {
						j++
					}
					continue
				}
				if src[j] == '{' {
					depth++
				} else if src[j] == '}' {
					depth--
				}
				j++
			}
			if depth == 0 {
				cur.WriteString(src[i:j])
				i = j
				continue
			}
		}
		if c == '$' && i+1 < len(src) && src[i+1] == '(' {
			startToken(i)
			endIdx, err := scanBalancedParens(src, i+1)
			if err != nil {
				return nil, err
			}
			cur.WriteString(src[i:endIdx])
			i = endIdx
			continue
		}
		if c == '`' {
			startToken(i)
			cur.WriteByte('`')
			i++
			for i < len(src) && src[i] != '`' {
				if src[i] == '\\' && i+1 < len(src) {
					cur.WriteByte(src[i])
					cur.WriteByte(src[i+1])
					i += 2
					continue
				}
				cur.WriteByte(src[i])
				i++
			}
			if i >= len(src) {
				return nil, fmt.Errorf("unterminated backquote")
			}
			cur.WriteByte('`')
			i++
			continue
		}
		if c == '\'' {
			wasStart := !inToken
			startToken(i)
			cur.WriteByte('\x03')
			i++
			for i < len(src) && src[i] != '\'' {
				if wasStart && src[i] == '~' {
					cur.WriteByte('\x01')
				}
				wasStart = false
				switch src[i] {
				case '$', '%', '`', '*', '?', '[', '{', '}', ',':
					cur.WriteByte('\x01')
				}
				cur.WriteByte(src[i])
				i++
			}
			if i >= len(src) {
				return nil, fmt.Errorf("unterminated single quote")
			}
			cur.WriteByte('\x03')
			i++
			continue
		}
		if c == '"' {
			wasStart := !inToken
			startToken(i)
			cur.WriteByte('\x03')
			i++
			for i < len(src) && src[i] != '"' {
				if wasStart && src[i] == '~' {
					cur.WriteByte('\x01')
				}
				wasStart = false
				if src[i] == '$' && i+1 < len(src) && src[i+1] == '{' {
					depth := 1
					j := i + 2
					for j < len(src) && depth > 0 {
						if src[j] == '\\' && j+1 < len(src) {
							j += 2
							continue
						}
						if src[j] == '{' {
							depth++
						} else if src[j] == '}' {
							depth--
						}
						j++
					}
					if depth == 0 {
						cur.WriteByte('\x02')
						cur.WriteString(src[i:j])
						i = j
						continue
					}
				}
				if src[i] == '$' && i+1 < len(src) && src[i+1] == '(' {
					endIdx, err := scanBalancedParens(src, i+1)
					if err != nil {
						return nil, err
					}
					cur.WriteByte('\x02')
					cur.WriteString(src[i:endIdx])
					i = endIdx
					continue
				}
				if src[i] == '`' {
					cur.WriteByte('\x02')
					cur.WriteByte('`')
					i++
					for i < len(src) && src[i] != '`' {
						if src[i] == '\\' && i+1 < len(src) {
							cur.WriteByte(src[i])
							cur.WriteByte(src[i+1])
							i += 2
							continue
						}
						cur.WriteByte(src[i])
						i++
					}
					if i >= len(src) {
						return nil, fmt.Errorf("unterminated backquote")
					}
					cur.WriteByte('`')
					i++
					continue
				}
				if src[i] == '\\' && i+1 < len(src) {
					next := src[i+1]
					if next == '\n' {
						i += 2
						continue
					}
					if next == '\r' && i+2 < len(src) && src[i+2] == '\n' {
						i += 3
						continue
					}
					if next == '"' || next == '\\' || next == '$' || next == '`' {
						if next == '$' || next == '`' {
							cur.WriteByte('\x01')
						}
						cur.WriteByte(next)
						i += 2
						continue
					}
				}
				if src[i] == '$' && i+1 < len(src) {
					next := src[i+1]
					if next == '?' || next == '*' || next == '@' || next == '#' || next == '$' || next == '!' || (next >= '0' && next <= '9') {
						cur.WriteByte('\x02')
						cur.WriteByte('$')
						cur.WriteByte(next)
						i += 2
						continue
					}
					if (next >= 'a' && next <= 'z') || (next >= 'A' && next <= 'Z') || next == '_' {
						cur.WriteByte('\x02')
						cur.WriteByte('$')
						i++
						continue
					}
				}
				switch src[i] {
				case '*', '?', '[', '{', '}', ',':
					cur.WriteByte('\x01')
				}
				cur.WriteByte(src[i])
				i++
			}
			if i >= len(src) {
				return nil, fmt.Errorf("unterminated double quote")
			}
			cur.WriteByte('\x03')
			i++
			continue
		}
		if c == '\\' && i+1 < len(src) {
			next := src[i+1]
			if next == '\n' {
				i += 2
				continue
			}
			if next == '\r' && i+2 < len(src) && src[i+2] == '\n' {
				i += 3
				continue
			}
			wasStart := !inToken
			startToken(i)
			if runtime.GOOS == "windows" && !strings.ContainsRune(" \t\r\n\"'\\$`;|&<>()*?[]{},", rune(next)) {
				cur.WriteByte('\\')
				cur.WriteByte(next)
			} else {
				if next == '$' || next == '%' || next == '`' || next == '*' || next == '?' || next == '[' || next == '{' || next == '}' || next == ',' || (wasStart && next == '~') {
					cur.WriteByte('\x01')
				}
				cur.WriteByte(next)
			}
			i += 2
			continue
		}
		startToken(i)
		cur.WriteByte(c)
		i++
	}
	flushWord(i)
	return tokens, nil
}

func joinPOSIXTokens(toks []posixToken) string {
	var sb strings.Builder
	var pendingHeredocs []string
	hdCounter := 0
	for idx, t := range toks {
		if t.op == ";" && len(pendingHeredocs) > 0 {
			for _, hd := range pendingHeredocs {
				sb.WriteString(hd)
			}
			pendingHeredocs = nil
			continue
		}
		if idx > 0 {
			sb.WriteByte(' ')
		}
		if t.op == "<<" || t.op == "<<'" {
			delim := fmt.Sprintf("__INDIRECT_HD_%d__", hdCounter)
			hdCounter++
			if t.op == "<<'" {
				sb.WriteString("<<'" + delim + "'")
			} else {
				sb.WriteString("<<" + delim)
			}
			body := t.word
			if !strings.HasSuffix(body, "\n") {
				body += "\n"
			}
			pendingHeredocs = append(pendingHeredocs, "\n"+body+delim+"\n")
		} else if t.raw != "" {
			sb.WriteString(t.raw)
		} else if t.op == "subshell" {
			sb.WriteByte('(')
			sb.WriteString(t.word)
			sb.WriteByte(')')
		} else if t.op != "" {
			sb.WriteString(t.op)
		} else {
			sb.WriteString(posixShellQuote(unescapeShellMarkers(t.word)))
		}
	}
	for _, hd := range pendingHeredocs {
		sb.WriteString(hd)
	}
	return sb.String()
}

type posixIfBranch struct {
	cond []posixToken
	body []posixToken
}

type posixCaseItem struct {
	patterns []string
	body     []posixToken
}

type posixSimpleCmd struct {
	envAssigns     map[string]string
	argv           []string
	stdinFile      string
	hereString     string
	hasHereString  bool
	hereDoc        string
	hasHereDoc     bool
	hereDocLiteral bool
	stdoutFile     string
	stdoutApp     bool
	stderrFile    string
	stderrApp     bool
	stderrTo1     bool
	stdoutTo2     bool
	subshellCmd   string
	isSubshell    bool
	braceBody     []posixToken
	isBraceGroup  bool
	funcName      string
	funcBody      string
	ifBranches    []posixIfBranch
	elseTokens    []posixToken
	isIf          bool
	forVar        string
	forWords      []string
	hasForIn      bool
	whileCond     []posixToken
	isWhile       bool
	isUntil       bool
	loopBody      []posixToken
	caseWord      string
	caseItems     []posixCaseItem
	isCase        bool
}

func posixPrintf(format string, args []string) string {
	var out strings.Builder
	argIdx := 0
	nextStr := func() string {
		if argIdx < len(args) {
			v := args[argIdx]
			argIdx++
			return v
		}
		return ""
	}
	nextInt := func() int64 {
		s := strings.TrimSpace(nextStr())
		if s == "" {
			return 0
		}
		if (strings.HasPrefix(s, "'") || strings.HasPrefix(s, `"`)) && len(s) >= 2 {
			r, _ := strconv.Unquote(`"` + strings.ReplaceAll(s[1:2], `"`, `\"`) + `"`)
			if len(r) > 0 {
				return int64([]rune(r)[0])
			}
			return int64(s[1])
		}
		v, err := strconv.ParseInt(s, 0, 64)
		if err != nil {
			if f, ferr := strconv.ParseFloat(s, 64); ferr == nil {
				return int64(f)
			}
			return 0
		}
		return v
	}
	nextUint := func() uint64 {
		s := strings.TrimSpace(nextStr())
		if s == "" {
			return 0
		}
		if (strings.HasPrefix(s, "'") || strings.HasPrefix(s, `"`)) && len(s) >= 2 {
			return uint64(s[1])
		}
		if u, err := strconv.ParseUint(s, 0, 64); err == nil {
			return u
		}
		if v, err := strconv.ParseInt(s, 0, 64); err == nil {
			return uint64(v)
		}
		return 0
	}
	nextFloat := func() float64 {
		s := strings.TrimSpace(nextStr())
		if s == "" {
			return 0
		}
		f, _ := strconv.ParseFloat(s, 64)
		return f
	}

	firstPass := true
	for firstPass || argIdx < len(args) {
		firstPass = false
		startArgIdx := argIdx
		for i := 0; i < len(format); {
			c := format[i]
			if c == '\\' {
				if i+1 >= len(format) {
					out.WriteByte('\\')
					i++
					continue
				}
				nc := format[i+1]
				switch nc {
				case 'n':
					out.WriteByte('\n')
					i += 2
				case 't':
					out.WriteByte('\t')
					i += 2
				case 'r':
					out.WriteByte('\r')
					i += 2
				case 'a':
					out.WriteByte('\a')
					i += 2
				case 'b':
					out.WriteByte('\b')
					i += 2
				case 'f':
					out.WriteByte('\f')
					i += 2
				case 'v':
					out.WriteByte('\v')
					i += 2
				case '\\', '"', '\'':
					out.WriteByte(nc)
					i += 2
				case 'c':
					return out.String()
				case 'x':
					j := i + 2
					for j < len(format) && j < i+4 {
						hc := format[j]
						if (hc >= '0' && hc <= '9') || (hc >= 'a' && hc <= 'f') || (hc >= 'A' && hc <= 'F') {
							j++
						} else {
							break
						}
					}
					if j > i+2 {
						v, _ := strconv.ParseUint(format[i+2:j], 16, 8)
						out.WriteByte(byte(v))
						i = j
					} else {
						out.WriteString(`\x`)
						i += 2
					}
				default:
					if nc >= '0' && nc <= '7' {
						j := i + 1
						maxOct := i + 4
						if nc == '0' {
							maxOct = i + 5
						}
						for j < len(format) && j < maxOct && format[j] >= '0' && format[j] <= '7' {
							j++
						}
						v, _ := strconv.ParseUint(format[i+1:j], 8, 8)
						out.WriteByte(byte(v))
						i = j
					} else {
						out.WriteByte('\\')
						out.WriteByte(nc)
						i += 2
					}
				}
				continue
			}
			if c != '%' {
				out.WriteByte(c)
				i++
				continue
			}
			if i+1 < len(format) && format[i+1] == '%' {
				out.WriteByte('%')
				i += 2
				continue
			}
			j := i + 1
			var spec strings.Builder
			spec.WriteByte('%')
			for j < len(format) && strings.ContainsRune("-+ #0", rune(format[j])) {
				spec.WriteByte(format[j])
				j++
			}
			if j < len(format) && format[j] == '*' {
				w := nextInt()
				spec.WriteString(strconv.FormatInt(w, 10))
				j++
			} else {
				for j < len(format) && format[j] >= '0' && format[j] <= '9' {
					spec.WriteByte(format[j])
					j++
				}
			}
			if j < len(format) && format[j] == '.' {
				spec.WriteByte('.')
				j++
				if j < len(format) && format[j] == '*' {
					p := nextInt()
					if p < 0 {
						p = 0
					}
					spec.WriteString(strconv.FormatInt(p, 10))
					j++
				} else {
					for j < len(format) && format[j] >= '0' && format[j] <= '9' {
						spec.WriteByte(format[j])
						j++
					}
				}
			}
			for j < len(format) && strings.ContainsRune("hljztL", rune(format[j])) {
				j++
			}
			if j >= len(format) {
				out.WriteString(format[i:])
				break
			}
			verb := format[j]
			j++
			switch verb {
			case 's':
				spec.WriteByte('s')
				out.WriteString(fmt.Sprintf(spec.String(), nextStr()))
			case 'b':
				expanded, stop := expandEchoEscapes(nextStr())
				spec.WriteByte('s')
				out.WriteString(fmt.Sprintf(spec.String(), expanded))
				if stop {
					return out.String()
				}
			case 'c':
				s := nextStr()
				if len(s) > 0 {
					out.WriteByte(s[0])
				} else {
					out.WriteByte(0)
				}
			case 'd', 'i':
				spec.WriteByte('d')
				out.WriteString(fmt.Sprintf(spec.String(), nextInt()))
			case 'u':
				spec.WriteByte('d')
				out.WriteString(fmt.Sprintf(spec.String(), nextUint()))
			case 'o', 'x', 'X':
				spec.WriteByte(verb)
				out.WriteString(fmt.Sprintf(spec.String(), nextUint()))
			case 'f', 'F', 'e', 'E', 'g', 'G':
				spec.WriteByte(verb)
				out.WriteString(fmt.Sprintf(spec.String(), nextFloat()))
			default:
				out.WriteString(format[i:j])
			}
			i = j
		}
		if argIdx == startArgIdx {
			break
		}
	}
	return out.String()
}

type shellStdinPipeCtxKey struct{}

type shellStdinPipeHolder struct {
	mu   sync.Mutex
	r    *io.PipeReader
	used bool
}

func (h *shellStdinPipeHolder) take() *io.PipeReader {
	if h == nil {
		return nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.used || h.r == nil {
		return nil
	}
	h.used = true
	return h.r
}

func takeShellStdinPipe(ctx context.Context) *io.PipeReader {
	if ctx == nil {
		return nil
	}
	if h, ok := ctx.Value(shellStdinPipeCtxKey{}).(*shellStdinPipeHolder); ok {
		return h.take()
	}
	return nil
}

func (en *rtEntry) runBoundedExecCmd(ctx context.Context, cmd *exec.Cmd, stdinData []byte, stderrTo1 bool, maxBuf int64) ([]byte, []byte, int, *string, string) {
	var pipedStdin io.WriteCloser
	var pipedSource *io.PipeReader
	if len(stdinData) > 0 {
		cmd.Stdin = bytes.NewReader(stdinData)
	} else if pr := takeShellStdinPipe(ctx); pr != nil {
		if sp, err := cmd.StdinPipe(); err == nil {
			pipedStdin = sp
			pipedSource = pr
		}
	}
	var killOnce sync.Once
	killChild := func() {
		killOnce.Do(func() {
			if cmd.Process != nil {
				killProcessTree(cmd.Process.Pid)
			}
		})
	}
	cmd.Cancel = func() error {
		killChild()
		return nil
	}
	cmd.WaitDelay = 250 * time.Millisecond
	stdoutBuf := &boundedBufferWriter{max: maxBuf, onExceed: killChild}
	stderrBuf := &boundedBufferWriter{max: maxBuf, onExceed: killChild}
	cmd.Stdout = stdoutBuf
	if stderrTo1 {
		cmd.Stderr = stdoutBuf
	} else {
		cmd.Stderr = stderrBuf
	}
	if err := cmd.Start(); err != nil {
		if pipedStdin != nil {
			_ = pipedStdin.Close()
		}
		return nil, []byte(err.Error() + "\n"), 127, nil, ""
	}
	if pipedStdin != nil && pipedSource != nil {
		go func() {
			_, _ = io.Copy(pipedStdin, io.LimitReader(pipedSource, maxBuf))
			_ = pipedStdin.Close()
		}()
		defer func() {
			_ = pipedSource.Close()
			_ = pipedStdin.Close()
		}()
	}
	stopCtx := context.AfterFunc(ctx, killChild)
	defer stopCtx()
	pid := cmd.Process.Pid
	waitErr := cmd.Wait()
	exitCode := 0
	var sigStr *string
	var errStr string
	if stdoutBuf.Exceeded() || stderrBuf.Exceeded() {
		killChild()
		errStr = "ENOBUFS"
		exitCode = 1
	} else if ctx.Err() != nil {
		killProcessTree(pid)
		if ctx.Err() == context.DeadlineExceeded {
			s := "SIGTERM"
			sigStr = &s
			errStr = "ETIMEDOUT"
			exitCode = 143
		} else {
			exitCode = 130
		}
	} else if waitErr != nil {
		var ee *exec.ExitError
		if errors.As(waitErr, &ee) {
			exitCode = ee.ExitCode()
		} else {
			exitCode = 1
			errStr = waitErr.Error()
		}
	}
	return stdoutBuf.Bytes(), stderrBuf.Bytes(), exitCode, sigStr, errStr
}

func setPositionalEnv(env map[string]string, posArgs []string) {
	oldCount := 9
	if prevN, err := strconv.Atoi(env["#"]); err == nil && prevN > oldCount {
		oldCount = prevN
	}
	env["#"] = strconv.Itoa(len(posArgs))
	env["@"] = strings.Join(posArgs, " ")
	env["*"] = strings.Join(posArgs, " ")
	if len(posArgs) > 0 {
		env["\x00POS_ARGS"] = strings.Join(posArgs, "\x00")
	} else {
		delete(env, "\x00POS_ARGS")
	}
	limit := oldCount
	if len(posArgs) > limit {
		limit = len(posArgs)
	}
	for i := 0; i < limit; i++ {
		key := strconv.Itoa(i + 1)
		if i < len(posArgs) {
			env[key] = posArgs[i]
		} else {
			delete(env, key)
		}
	}
}

func getPositionalArgs(env map[string]string) []string {
	n, err := strconv.Atoi(env["#"])
	if err != nil || n <= 0 {
		if at := env["@"]; at != "" {
			return strings.Fields(at)
		}
		return nil
	}
	if raw, ok := env["\x00POS_ARGS"]; ok {
		parts := strings.Split(raw, "\x00")
		if len(parts) == n {
			return parts
		}
	}
	out := make([]string, 0, n)
	for i := 1; i <= n; i++ {
		out = append(out, env[strconv.Itoa(i)])
	}
	return out
}

func bindPositionalEnv(base map[string]string, arg0 string, posArgs []string) map[string]string {
	out := make(map[string]string, len(base)+12)
	for k, v := range base {
		out[k] = v
	}
	out["0"] = arg0
	setPositionalEnv(out, posArgs)
	return out
}

func escapeQuotedGlobChars(s string) string {
	var sb strings.Builder
	sb.Grow(len(s))
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '$', '%', '`', '*', '?', '[', '{', '}', ',':
			sb.WriteByte('\x01')
		}
		sb.WriteByte(s[i])
	}
	return sb.String()
}

func (en *rtEntry) expandCommandSubstitutions(ctx context.Context, word string, cwd string, env map[string]string, stderrBuf *boundedBufferWriter, maxBuf int64, depth int) (string, int, bool) {
	if !strings.Contains(word, "$(") && !strings.Contains(word, "`") {
		return word, 0, false
	}
	var sb strings.Builder
	lastCode := 0
	ranSub := false
	i := 0
	for i < len(word) {
		if word[i] == '\x01' && i+1 < len(word) {
			sb.WriteByte('\x01')
			sb.WriteByte(word[i+1])
			i += 2
			continue
		}
		inDQuote := false
		if word[i] == '\x02' && i+1 < len(word) {
			if (word[i+1] == '$' && i+2 < len(word) && word[i+2] == '(' && (i+3 >= len(word) || word[i+3] != '(')) || word[i+1] == '`' {
				inDQuote = true
				i++
			} else {
				sb.WriteByte('\x02')
				i++
				continue
			}
		}
		if word[i] == '$' && i+1 < len(word) && word[i+1] == '(' {
			if i+2 < len(word) && word[i+2] == '(' {
				endIdx, err := scanBalancedParens(word, i+1)
				if err == nil {
					sb.WriteString(word[i:endIdx])
					i = endIdx
					continue
				}
			}
			endIdx, err := scanBalancedParens(word, i+1)
			if err == nil && endIdx > i+2 {
				subCmd := word[i+2 : endIdx-1]
				subEnv := make(map[string]string, len(env))
				for k, v := range env {
					subEnv[k] = v
				}
				delete(subEnv, "\x00TRAP_EXIT")
				subCWD := cwd
				outB, errB, code, _, _ := en.evalPOSIXShellWithMax(ctx, subCmd, subCWD, subEnv, nil, maxBuf, depth+1)
				if trapCmd := subEnv["\x00TRAP_EXIT"]; trapCmd != "" {
					delete(subEnv, "\x00TRAP_EXIT")
					subEnv["?"] = strconv.Itoa(code)
					tOut, tErr, tCode, _, _, tFlow := en.evalPOSIXShellWithCWD(ctx, trapCmd, &subCWD, subEnv, nil, maxBuf, depth+1)
					outB = append(outB, tOut...)
					errB = append(errB, tErr...)
					if tFlow == "exit" {
						code = tCode
					}
				}
				if stderrBuf != nil && len(errB) > 0 {
					_, _ = stderrBuf.Write(errB)
				}
				lastCode = code
				ranSub = true
				outStr := strings.TrimRight(string(outB), "\r\n")
				if inDQuote {
					sb.WriteString(escapeQuotedGlobChars(outStr))
				} else {
					sb.WriteByte('\x04')
					sb.WriteString(escapeUnquotedExpansionChars(outStr))
					sb.WriteByte('\x04')
				}
				i = endIdx
				continue
			}
		}
		if word[i] == '`' {
			j := i + 1
			for j < len(word) && word[j] != '`' {
				if word[j] == '\\' && j+1 < len(word) {
					j += 2
					continue
				}
				j++
			}
			if j < len(word) && word[j] == '`' {
				subCmd := word[i+1 : j]
				subEnv := make(map[string]string, len(env))
				for k, v := range env {
					subEnv[k] = v
				}
				delete(subEnv, "\x00TRAP_EXIT")
				subCWD := cwd
				outB, errB, code, _, _ := en.evalPOSIXShellWithMax(ctx, subCmd, subCWD, subEnv, nil, maxBuf, depth+1)
				if trapCmd := subEnv["\x00TRAP_EXIT"]; trapCmd != "" {
					delete(subEnv, "\x00TRAP_EXIT")
					subEnv["?"] = strconv.Itoa(code)
					tOut, tErr, tCode, _, _, tFlow := en.evalPOSIXShellWithCWD(ctx, trapCmd, &subCWD, subEnv, nil, maxBuf, depth+1)
					outB = append(outB, tOut...)
					errB = append(errB, tErr...)
					if tFlow == "exit" {
						code = tCode
					}
				}
				if stderrBuf != nil && len(errB) > 0 {
					_, _ = stderrBuf.Write(errB)
				}
				lastCode = code
				ranSub = true
				outStr := strings.TrimRight(string(outB), "\r\n")
				if inDQuote {
					sb.WriteString(escapeQuotedGlobChars(outStr))
				} else {
					sb.WriteByte('\x04')
					sb.WriteString(escapeUnquotedExpansionChars(outStr))
					sb.WriteByte('\x04')
				}
				i = j + 1
				continue
			}
		}
		sb.WriteByte(word[i])
		i++
	}
	return sb.String(), lastCode, ranSub
}

func expandBraceWord(word string) []string {
	openIdx := -1
	closeIdx := -1
	var parts []string
	depth := 0
	partStart := 0
	for i := 0; i < len(word); i++ {
		if word[i] == '\x01' && i+1 < len(word) {
			i++
			continue
		}
		if word[i] == '{' {
			if depth == 0 {
				openIdx = i
				partStart = i + 1
			}
			depth++
		} else if word[i] == '}' && depth > 0 {
			depth--
			if depth == 0 {
				parts = append(parts, word[partStart:i])
				closeIdx = i
				break
			}
		} else if word[i] == ',' && depth == 1 {
			parts = append(parts, word[partStart:i])
			partStart = i + 1
		}
	}
	if openIdx < 0 || closeIdx < 0 {
		return []string{word}
	}
	prefix := word[:openIdx]
	suffix := word[closeIdx+1:]
	if len(parts) == 1 && strings.Contains(parts[0], "..") {
		seqParts := strings.SplitN(parts[0], "..", 2)
		startN, err1 := strconv.Atoi(seqParts[0])
		endN, err2 := strconv.Atoi(seqParts[1])
		if err1 == nil && err2 == nil {
			step := 1
			if startN > endN {
				step = -1
			}
			var expanded []string
			for n := startN; (step > 0 && n <= endN) || (step < 0 && n >= endN); n += step {
				for _, tail := range expandBraceWord(suffix) {
					expanded = append(expanded, prefix+strconv.Itoa(n)+tail)
				}
				if len(expanded) > 1024 {
					break
				}
			}
			return expanded
		}
		return []string{word}
	}
	if len(parts) < 2 {
		return []string{word}
	}
	var out []string
	for _, p := range parts {
		for _, tail := range expandBraceWord(suffix) {
			out = append(out, prefix+p+tail)
		}
	}
	return out
}

func hasUnescapedGlobMeta(word string) bool {
	for i := 0; i < len(word); i++ {
		if word[i] == '\x01' && i+1 < len(word) {
			i++
			continue
		}
		if word[i] == '*' || word[i] == '?' || word[i] == '[' {
			return true
		}
	}
	return false
}

func splitShellWordIFS(word string, ifs string) []string {
	isIFS := func(b byte) bool {
		return strings.IndexByte(ifs, b) >= 0
	}
	isIFSWhite := func(b byte) bool {
		return (b == ' ' || b == '\t' || b == '\n') && isIFS(b)
	}
	var fields []string
	var cur strings.Builder
	curHasToken := false
	inQuoted := false
	inUnquotedExp := false
	i := 0
	for i < len(word) {
		c := word[i]
		if c == '\x03' {
			inQuoted = !inQuoted
			curHasToken = true
			cur.WriteByte('\x03')
			i++
			continue
		}
		if c == '\x04' {
			inUnquotedExp = !inUnquotedExp
			i++
			continue
		}
		if c == '\x05' {
			fields = append(fields, cur.String())
			cur.Reset()
			curHasToken = true
			i++
			continue
		}
		if c == '\x06' {
			i++
			continue
		}
		if c == '\x01' && i+1 < len(word) {
			if inUnquotedExp && !inQuoted && isIFS(word[i+1]) {
				i++
				c = word[i]
			} else {
				cur.WriteByte('\x01')
				cur.WriteByte(word[i+1])
				curHasToken = true
				i += 2
				continue
			}
		}
		if !inUnquotedExp || inQuoted || !isIFS(c) {
			cur.WriteByte(c)
			curHasToken = true
			i++
			continue
		}
		// c is an IFS delimiter inside an unquoted expansion
		if isIFSWhite(c) {
			for i < len(word) {
				if word[i] == '\x04' {
					inUnquotedExp = !inUnquotedExp
					i++
					if !inUnquotedExp {
						break
					}
					continue
				}
				if word[i] == '\x01' && i+1 < len(word) && isIFSWhite(word[i+1]) {
					i += 2
					continue
				}
				if isIFSWhite(word[i]) {
					i++
					continue
				}
				break
			}
			// Check if followed by a non-whitespace IFS char while still in unquoted expansion
			if inUnquotedExp && i < len(word) {
				nextC := word[i]
				step := 1
				if nextC == '\x01' && i+1 < len(word) && isIFS(word[i+1]) && !isIFSWhite(word[i+1]) {
					nextC = word[i+1]
					step = 2
				}
				if nextC != '\x03' && nextC != '\x04' && isIFS(nextC) && !isIFSWhite(nextC) {
					fields = append(fields, cur.String())
					cur.Reset()
					curHasToken = false
					i += step
					for i < len(word) {
						if word[i] == '\x04' {
							inUnquotedExp = !inUnquotedExp
							i++
							if !inUnquotedExp {
								break
							}
							continue
						}
						if word[i] == '\x01' && i+1 < len(word) && isIFSWhite(word[i+1]) {
							i += 2
							continue
						}
						if isIFSWhite(word[i]) {
							i++
							continue
						}
						break
					}
					continue
				}
			}
			if curHasToken {
				fields = append(fields, cur.String())
				cur.Reset()
				curHasToken = false
			}
			continue
		}
		// c is a non-whitespace IFS delimiter
		fields = append(fields, cur.String())
		cur.Reset()
		curHasToken = false
		i++
		for i < len(word) {
			if word[i] == '\x04' {
				inUnquotedExp = !inUnquotedExp
				i++
				if !inUnquotedExp {
					break
				}
				continue
			}
			if word[i] == '\x01' && i+1 < len(word) && isIFSWhite(word[i+1]) {
				i += 2
				continue
			}
			if isIFSWhite(word[i]) {
				i++
				continue
			}
			break
		}
	}
	if curHasToken {
		fields = append(fields, cur.String())
	}
	return fields
}

func (en *rtEntry) expandShellWordList(ctx context.Context, rawWords []string, cwd string, env map[string]string, stderrBuf *boundedBufferWriter, maxBuf int64, depth int) ([]string, int, bool) {
	var out []string
	lastSubCode := 0
	anySub := false
	ifs := " \t\n"
	if customIFS, ok := env["IFS"]; ok {
		ifs = customIFS
	}
	noGlob := env["\x00OPT_F"] == "1"
	for _, raw := range rawWords {
		if len(getPositionalArgs(env)) == 0 && (raw == "\x03\x02$@\x03" || raw == "\x03\x02${@}\x03") {
			continue
		}
		w1, subCode, ranSub := en.expandCommandSubstitutions(ctx, raw, cwd, env, stderrBuf, maxBuf, depth)
		if ranSub {
			lastSubCode = subCode
			anySub = true
		}
		w2 := expandShellVarsKeepMarkers(w1, env)
		braceWords := expandBraceWord(w2)
		for _, bw := range braceWords {
			splitWords := splitShellWordIFS(bw, ifs)
			for _, sw := range splitWords {
				if !noGlob && hasUnescapedGlobMeta(sw) {
					cleanPat := unescapeShellMarkers(sw)
					absPat := cleanPat
					isRel := !filepath.IsAbs(cleanPat)
					hasDotSlash := strings.HasPrefix(cleanPat, "./") || strings.HasPrefix(cleanPat, `.\`)
					if isRel {
						absPat = filepath.Join(cwd, cleanPat)
					}
					matches, err := filepath.Glob(absPat)
					if err == nil && len(matches) > 0 {
						basePat := filepath.Base(cleanPat)
						wantDot := strings.HasPrefix(basePat, ".")
						var filtered []string
						for _, m := range matches {
							if !wantDot && strings.HasPrefix(filepath.Base(m), ".") {
								continue
							}
							if en.checkPath(m) != nil {
								continue
							}
							if isRel {
								if rel, rerr := filepath.Rel(cwd, m); rerr == nil {
									relSlash := filepath.ToSlash(rel)
									if hasDotSlash && !strings.HasPrefix(relSlash, "./") && !strings.HasPrefix(relSlash, "../") {
										relSlash = "./" + relSlash
									}
									filtered = append(filtered, relSlash)
									continue
								}
							}
							filtered = append(filtered, filepath.ToSlash(m))
						}
						if len(filtered) > 0 {
							sort.Strings(filtered)
							out = append(out, filtered...)
							continue
						}
					}
				}
				out = append(out, unescapeShellMarkers(sw))
			}
		}
	}
	return out, lastSubCode, anySub
}

func expandEchoEscapes(s string) (string, bool) {
	var sb strings.Builder
	sb.Grow(len(s))
	for i := 0; i < len(s); i++ {
		if s[i] != '\\' || i+1 >= len(s) {
			sb.WriteByte(s[i])
			continue
		}
		i++
		switch s[i] {
		case 'n':
			sb.WriteByte('\n')
		case 't':
			sb.WriteByte('\t')
		case 'r':
			sb.WriteByte('\r')
		case '\\':
			sb.WriteByte('\\')
		case 'a':
			sb.WriteByte('\a')
		case 'b':
			sb.WriteByte('\b')
		case 'f':
			sb.WriteByte('\f')
		case 'v':
			sb.WriteByte('\v')
		case 'e', 'E':
			sb.WriteByte(0x1b)
		case 'c':
			return sb.String(), true
		case '0':
			val := 0
			cnt := 0
			for cnt < 3 && i+1 < len(s) && s[i+1] >= '0' && s[i+1] <= '7' {
				i++
				cnt++
				val = val*8 + int(s[i]-'0')
			}
			sb.WriteByte(byte(val))
		case 'x':
			if i+2 < len(s) {
				if v, err := strconv.ParseUint(s[i+1:i+3], 16, 8); err == nil {
					sb.WriteByte(byte(v))
					i += 2
					continue
				}
			}
			sb.WriteByte('\\')
			sb.WriteByte('x')
		default:
			sb.WriteByte('\\')
			sb.WriteByte(s[i])
		}
	}
	return sb.String(), false
}

func formatStrftime(t time.Time, format string) string {
	var sb strings.Builder
	for i := 0; i < len(format); i++ {
		if format[i] != '%' || i+1 >= len(format) {
			sb.WriteByte(format[i])
			continue
		}
		i++
		switch format[i] {
		case '%':
			sb.WriteByte('%')
		case 'Y':
			sb.WriteString(t.Format("2006"))
		case 'y':
			sb.WriteString(t.Format("06"))
		case 'm':
			sb.WriteString(t.Format("01"))
		case 'd':
			sb.WriteString(t.Format("02"))
		case 'e':
			sb.WriteString(t.Format("_2"))
		case 'H':
			sb.WriteString(t.Format("15"))
		case 'I':
			sb.WriteString(t.Format("03"))
		case 'M':
			sb.WriteString(t.Format("04"))
		case 'S':
			sb.WriteString(t.Format("05"))
		case 's':
			sb.WriteString(strconv.FormatInt(t.Unix(), 10))
		case 'N':
			sb.WriteString(fmt.Sprintf("%09d", t.Nanosecond()))
		case 'F':
			sb.WriteString(t.Format("2006-01-02"))
		case 'T', 'X':
			sb.WriteString(t.Format("15:04:05"))
		case 'R':
			sb.WriteString(t.Format("15:04"))
		case 'D', 'x':
			sb.WriteString(t.Format("01/02/06"))
		case 'Z':
			sb.WriteString(t.Format("MST"))
		case 'z':
			sb.WriteString(t.Format("-0700"))
		case 'a':
			sb.WriteString(t.Format("Mon"))
		case 'A':
			sb.WriteString(t.Format("Monday"))
		case 'b', 'h':
			sb.WriteString(t.Format("Jan"))
		case 'B':
			sb.WriteString(t.Format("January"))
		case 'p':
			sb.WriteString(t.Format("PM"))
		case 'P':
			sb.WriteString(strings.ToLower(t.Format("PM")))
		case 'j':
			sb.WriteString(fmt.Sprintf("%03d", t.YearDay()))
		case 'u':
			wd := int(t.Weekday())
			if wd == 0 {
				wd = 7
			}
			sb.WriteString(strconv.Itoa(wd))
		case 'w':
			sb.WriteString(strconv.Itoa(int(t.Weekday())))
		case 'n':
			sb.WriteByte('\n')
		case 't':
			sb.WriteByte('\t')
		default:
			sb.WriteByte('%')
			sb.WriteByte(format[i])
		}
	}
	return sb.String()
}

func (en *rtEntry) evalPOSIXSimpleCmd(ctx context.Context, sc posixSimpleCmd, cwd *string, env map[string]string, stdinData []byte, maxBuf int64, depth int) ([]byte, []byte, int, *string, string, string) {
	if maxBuf <= 0 || maxBuf > maxHostBufferBytes {
		maxBuf = maxHostBufferBytes
	}
	stdoutBuf := &boundedBufferWriter{max: maxBuf}
	stderrBuf := &boundedBufferWriter{max: maxBuf}
	exitCode := 0
	var sigStr *string
	var errStr string
	var flowCtrl string

	sandboxed := en.hasSandboxRestrictions()
	if sandboxed {
		for k := range sc.envAssigns {
			if isRejectedJailedEnvKey(k) {
				return nil, []byte(fmt.Sprintf("EACCES: jailed: environment variable %q is not allowed in sandbox\n", k)), 1, nil, "", ""
			}
		}
	}

	cmdEnv := make(map[string]string, len(env)+len(sc.envAssigns)+4)
	for k, v := range env {
		cmdEnv[k] = v
	}

	checkNounset := func() bool {
		if nerr := cmdEnv["\x00NOUNSET_ERR"]; nerr != "" {
			delete(cmdEnv, "\x00NOUNSET_ERR")
			delete(env, "\x00NOUNSET_ERR")
			_, _ = stderrBuf.Write([]byte(nerr))
			return true
		}
		if nerr := env["\x00NOUNSET_ERR"]; nerr != "" {
			delete(env, "\x00NOUNSET_ERR")
			delete(cmdEnv, "\x00NOUNSET_ERR")
			_, _ = stderrBuf.Write([]byte(nerr))
			return true
		}
		return false
	}

	if sc.stdinFile != "" {
		rawIn, _, _ := en.expandCommandSubstitutions(ctx, sc.stdinFile, *cwd, cmdEnv, stderrBuf, maxBuf, depth)
		rawIn = expandShellVars(rawIn, cmdEnv)
		if checkNounset() {
			env["?"] = "1"
			return nil, stderrBuf.Bytes(), 1, nil, "", "exit"
		}
		if isNullDevicePath(rawIn) {
			stdinData = nil
		} else {
			p := joinCWDPath(*cwd, rawIn)
			if err := en.checkPath(p); err != nil {
				return nil, []byte(err.Error() + "\n"), 1, nil, "", ""
			}
			b, err := readFileBounded(p, maxBuf)
			if err != nil {
				if strings.HasPrefix(err.Error(), "ENOBUFS:") {
					return nil, []byte(err.Error() + "\n"), 1, nil, "ENOBUFS", ""
				}
				return nil, []byte(err.Error() + "\n"), 1, nil, "", ""
			}
			stdinData = b
		}
	}
	if sc.hasHereString {
		hs, _, _ := en.expandCommandSubstitutions(ctx, sc.hereString, *cwd, cmdEnv, stderrBuf, maxBuf, depth)
		hs = expandShellVars(hs, cmdEnv)
		if checkNounset() {
			env["?"] = "1"
			return nil, stderrBuf.Bytes(), 1, nil, "", "exit"
		}
		stdinData = []byte(hs + "\n")
	}
	if sc.hasHereDoc {
		hd := sc.hereDoc
		if !sc.hereDocLiteral {
			hd, _, _ = en.expandCommandSubstitutions(ctx, hd, *cwd, cmdEnv, stderrBuf, maxBuf, depth)
			hd = expandShellVars(hd, cmdEnv)
			if checkNounset() {
				env["?"] = "1"
				return nil, stderrBuf.Bytes(), 1, nil, "", "exit"
			}
		}
		stdinData = []byte(hd)
	}

	consumeShellStdin := func() []byte {
		if stdinData != nil || sc.stdinFile != "" || sc.hasHereString || sc.hasHereDoc {
			if stdinData == nil {
				return []byte{}
			}
			return stdinData
		}
		if s, ok := env["\x00STDIN"]; ok {
			delete(env, "\x00STDIN")
			delete(cmdEnv, "\x00STDIN")
			return []byte(s)
		}
		if pr := takeShellStdinPipe(ctx); pr != nil {
			b, _ := readAllBounded(pr, maxBuf)
			_ = pr.Close()
			return b
		}
		return nil
	}

	withScopedStdin := func(fn func()) {
		if stdinData == nil && sc.stdinFile == "" && !sc.hasHereString && !sc.hasHereDoc {
			fn()
			return
		}
		prevStdin, hadPrev := env["\x00STDIN"]
		env["\x00STDIN"] = string(stdinData)
		defer func() {
			if hadPrev {
				env["\x00STDIN"] = prevStdin
			} else {
				delete(env, "\x00STDIN")
			}
		}()
		fn()
	}

	runInCond := func(condCmd string) ([]byte, []byte, int, *string, string, string) {
		prevCond := env["\x00IN_COND"]
		env["\x00IN_COND"] = "1"
		cOut, cErr, cCode, cSig, cErrStr, cFlow := en.evalPOSIXShellWithCWD(ctx, condCmd, cwd, env, nil, maxBuf, depth+1)
		if prevCond != "" {
			env["\x00IN_COND"] = prevCond
		} else {
			delete(env, "\x00IN_COND")
		}
		return cOut, cErr, cCode, cSig, cErrStr, cFlow
	}

	if sc.funcName != "" || sc.isBraceGroup || sc.isSubshell || sc.isIf || sc.forVar != "" || sc.isWhile || sc.isUntil || sc.isCase {
		switch {
		case sc.funcName != "":
			env["\x00FN_"+sc.funcName] = sc.funcBody
			exitCode = 0

		case sc.isBraceGroup:
			withScopedStdin(func() {
				bodyCmd := joinPOSIXTokens(sc.braceBody)
				outB, errB, code, sig, eStr, bFlow := en.evalPOSIXShellWithCWD(ctx, bodyCmd, cwd, env, nil, maxBuf, depth+1)
				_, _ = stdoutBuf.Write(outB)
				_, _ = stderrBuf.Write(errB)
				exitCode = code
				sigStr = sig
				errStr = eStr
				flowCtrl = bFlow
			})

		case sc.isSubshell:
			hasOwnStdin := stdinData != nil || sc.stdinFile != "" || sc.hasHereString || sc.hasHereDoc
			var subIn []byte
			if hasOwnStdin {
				if stdinData == nil {
					subIn = []byte{}
				} else {
					subIn = stdinData
				}
			}
			_, hadParentStdin := env["\x00STDIN"]
			subEnv := make(map[string]string, len(cmdEnv))
			for k, v := range cmdEnv {
				subEnv[k] = v
			}
			if hasOwnStdin {
				delete(subEnv, "\x00STDIN")
			}
			delete(subEnv, "\x00TRAP_EXIT")
			subCWD := *cwd
			outB, errB, code, sig, eStr, _ := en.evalPOSIXShellWithCWD(ctx, sc.subshellCmd, &subCWD, subEnv, subIn, maxBuf, depth+1)
			if !hasOwnStdin && hadParentStdin {
				if rem, ok := subEnv["\x00STDIN"]; ok {
					env["\x00STDIN"] = rem
					cmdEnv["\x00STDIN"] = rem
				} else {
					delete(env, "\x00STDIN")
					delete(cmdEnv, "\x00STDIN")
				}
			}
			if trapCmd := subEnv["\x00TRAP_EXIT"]; trapCmd != "" {
				delete(subEnv, "\x00TRAP_EXIT")
				subEnv["?"] = strconv.Itoa(code)
				tOut, tErr, tCode, _, _, tFlow := en.evalPOSIXShellWithCWD(ctx, trapCmd, &subCWD, subEnv, nil, maxBuf, depth+1)
				outB = append(outB, tOut...)
				errB = append(errB, tErr...)
				if tFlow == "exit" {
					code = tCode
				}
			}
			_, _ = stdoutBuf.Write(outB)
			_, _ = stderrBuf.Write(errB)
			exitCode = code
			sigStr = sig
			errStr = eStr

		case sc.isIf:
			withScopedStdin(func() {
				matched := false
				for _, br := range sc.ifBranches {
					condCmd := joinPOSIXTokens(br.cond)
					cOut, cErr, cCode, cSig, cErrStr, cFlow := runInCond(condCmd)
					_, _ = stdoutBuf.Write(cOut)
					_, _ = stderrBuf.Write(cErr)
					if cSig != nil {
						sigStr = cSig
					}
					if cErrStr != "" {
						errStr = cErrStr
					}
					if cFlow != "" {
						exitCode = cCode
						flowCtrl = cFlow
						matched = true
						break
					}
					if cCode == 0 {
						matched = true
						bodyCmd := joinPOSIXTokens(br.body)
						bOut, bErr, bCode, bSig, bErrStr, bFlow := en.evalPOSIXShellWithCWD(ctx, bodyCmd, cwd, env, nil, maxBuf, depth+1)
						_, _ = stdoutBuf.Write(bOut)
						_, _ = stderrBuf.Write(bErr)
						exitCode = bCode
						if bSig != nil {
							sigStr = bSig
						}
						if bErrStr != "" {
							errStr = bErrStr
						}
						flowCtrl = bFlow
						break
					}
				}
				if !matched && len(sc.elseTokens) > 0 {
					elseCmd := joinPOSIXTokens(sc.elseTokens)
					bOut, bErr, bCode, bSig, bErrStr, bFlow := en.evalPOSIXShellWithCWD(ctx, elseCmd, cwd, env, nil, maxBuf, depth+1)
					_, _ = stdoutBuf.Write(bOut)
					_, _ = stderrBuf.Write(bErr)
					exitCode = bCode
					if bSig != nil {
						sigStr = bSig
					}
					if bErrStr != "" {
						errStr = bErrStr
					}
					flowCtrl = bFlow
				}
			})

		case sc.forVar != "":
			withScopedStdin(func() {
				var items []string
				if sc.hasForIn {
					items, _, _ = en.expandShellWordList(ctx, sc.forWords, *cwd, env, stderrBuf, maxBuf, depth)
					if checkNounset() {
						exitCode = 1
						flowCtrl = "exit"
						return
					}
				} else {
					items = getPositionalArgs(env)
				}
				bodyCmd := joinPOSIXTokens(sc.loopBody)
				for _, item := range items {
					if ctx.Err() != nil {
						break
					}
					if !(sandboxed && isBlockedJailedEnvKey(sc.forVar)) {
						env[sc.forVar] = item
					}
					bOut, bErr, bCode, bSig, bErrStr, bFlow := en.evalPOSIXShellWithCWD(ctx, bodyCmd, cwd, env, nil, maxBuf, depth+1)
					_, _ = stdoutBuf.Write(bOut)
					_, _ = stderrBuf.Write(bErr)
					exitCode = bCode
					if bSig != nil {
						sigStr = bSig
					}
					if bErrStr != "" {
						errStr = bErrStr
					}
					if stdoutBuf.Exceeded() || stderrBuf.Exceeded() || errStr == "ENOBUFS" {
						errStr = "ENOBUFS"
						break
					}
					if bFlow == "break" {
						break
					}
					if bFlow == "continue" {
						continue
					}
					if bFlow == "exit" || bFlow == "return" {
						flowCtrl = bFlow
						break
					}
				}
			})

		case sc.isWhile || sc.isUntil:
			withScopedStdin(func() {
				condCmd := joinPOSIXTokens(sc.whileCond)
				bodyCmd := joinPOSIXTokens(sc.loopBody)
				for ctx.Err() == nil {
					cOut, cErr, cCode, cSig, cErrStr, cFlow := runInCond(condCmd)
					_, _ = stdoutBuf.Write(cOut)
					_, _ = stderrBuf.Write(cErr)
					if cSig != nil {
						sigStr = cSig
					}
					if cErrStr != "" {
						errStr = cErrStr
					}
					if cFlow != "" {
						exitCode = cCode
						flowCtrl = cFlow
						break
					}
					condOK := (sc.isWhile && cCode == 0) || (sc.isUntil && cCode != 0)
					if !condOK {
						break
					}
					bOut, bErr, bCode, bSig, bErrStr, bFlow := en.evalPOSIXShellWithCWD(ctx, bodyCmd, cwd, env, nil, maxBuf, depth+1)
					_, _ = stdoutBuf.Write(bOut)
					_, _ = stderrBuf.Write(bErr)
					exitCode = bCode
					if bSig != nil {
						sigStr = bSig
					}
					if bErrStr != "" {
						errStr = bErrStr
					}
					if stdoutBuf.Exceeded() || stderrBuf.Exceeded() || errStr == "ENOBUFS" {
						errStr = "ENOBUFS"
						break
					}
					if bFlow == "break" {
						break
					}
					if bFlow == "continue" {
						continue
					}
					if bFlow == "exit" || bFlow == "return" {
						flowCtrl = bFlow
						break
					}
				}
			})

		case sc.isCase:
			withScopedStdin(func() {
				valWords, _, _ := en.expandShellWordList(ctx, []string{sc.caseWord}, *cwd, env, stderrBuf, maxBuf, depth)
				if checkNounset() {
					exitCode = 1
					flowCtrl = "exit"
					return
				}
				targetVal := ""
				if len(valWords) > 0 {
					targetVal = valWords[0]
				}
				for _, item := range sc.caseItems {
					matched := false
					for _, patRaw := range item.patterns {
						pat := expandShellVars(patRaw, env)
						if shellGlobMatch(pat, targetVal) {
							matched = true
							break
						}
					}
					if matched {
						bodyCmd := joinPOSIXTokens(item.body)
						bOut, bErr, bCode, bSig, bErrStr, bFlow := en.evalPOSIXShellWithCWD(ctx, bodyCmd, cwd, env, nil, maxBuf, depth+1)
						_, _ = stdoutBuf.Write(bOut)
						_, _ = stderrBuf.Write(bErr)
						exitCode = bCode
						if bSig != nil {
							sigStr = bSig
						}
						if bErrStr != "" {
							errStr = bErrStr
						}
						flowCtrl = bFlow
						break
					}
				}
			})
		}
	} else {
		if len(sc.argv) == 0 {
			lastAssignCode := 0
			for k, v := range sc.envAssigns {
				if sandboxed && isBlockedJailedEnvKey(k) {
					continue
				}
				vSub, subCode, ranSub := en.expandCommandSubstitutions(ctx, v, *cwd, env, stderrBuf, maxBuf, depth)
				if ranSub {
					lastAssignCode = subCode
				}
				env[k] = expandShellVars(vSub, env)
				if checkNounset() {
					env["?"] = "1"
					return stdoutBuf.Bytes(), stderrBuf.Bytes(), 1, nil, "", "exit"
				}
			}
			if sandboxed {
				en.enforceChildEnvMap(env)
			}
			env["?"] = strconv.Itoa(lastAssignCode)
			return stdoutBuf.Bytes(), stderrBuf.Bytes(), lastAssignCode, nil, "", ""
		}

		for k, v := range sc.envAssigns {
			if sandboxed && isBlockedJailedEnvKey(k) {
				continue
			}
			vSub, _, _ := en.expandCommandSubstitutions(ctx, v, *cwd, cmdEnv, stderrBuf, maxBuf, depth)
			cmdEnv[k] = expandShellVars(vSub, cmdEnv)
			if checkNounset() {
				env["?"] = "1"
				return stdoutBuf.Bytes(), stderrBuf.Bytes(), 1, nil, "", "exit"
			}
		}
		if sandboxed {
			en.enforceChildEnvMap(cmdEnv)
		}
		expandedArgv, _, _ := en.expandShellWordList(ctx, sc.argv, *cwd, cmdEnv, stderrBuf, maxBuf, depth)
		if checkNounset() {
			env["?"] = "1"
			return stdoutBuf.Bytes(), stderrBuf.Bytes(), 1, nil, "", "exit"
		}
		if len(expandedArgv) == 0 {
			return stdoutBuf.Bytes(), stderrBuf.Bytes(), 0, nil, "", ""
		}
		sc.argv = expandedArgv

		prog := sc.argv[0]
		args := sc.argv[1:]
		baseProg := strings.ToLower(strings.TrimSuffix(filepath.Base(prog), ".exe"))
		isBareCmd := !strings.ContainsAny(prog, `/\`)

		switch {
		case isBareCmd && cmdEnv["\x00BYPASS_FN"] != "1" && env["\x00FN_"+prog] != "":
			if depth > 32 {
				_, _ = stderrBuf.Write([]byte("shell function recursion limit exceeded\n"))
				exitCode = 1
				break
			}
			fnBody := env["\x00FN_"+prog]
			origEnv := make(map[string]string, len(env))
			for k, v := range env {
				origEnv[k] = v
			}
			oldPos := getPositionalArgs(env)
			prevInFunc := env["\x00IN_FUNC"]
			prevLocalVars := env["\x00LOCAL_VARS"]
			env["\x00IN_FUNC"] = "1"
			env["\x00LOCAL_VARS"] = ""
			for k, v := range sc.envAssigns {
				if !(sandboxed && isBlockedJailedEnvKey(k)) {
					env[k] = cmdEnv[k]
					_ = v
				}
			}
			setPositionalEnv(env, args)
			withScopedStdin(func() {
				outB, errB, code, sig, eStr, bFlow := en.evalPOSIXShellWithCWD(ctx, fnBody, cwd, env, nil, maxBuf, depth+1)
				_, _ = stdoutBuf.Write(outB)
				_, _ = stderrBuf.Write(errB)
				exitCode = code
				sigStr = sig
				errStr = eStr
				if bFlow == "exit" {
					flowCtrl = "exit"
				}
			})
			localVars := strings.Split(env["\x00LOCAL_VARS"], ",")
			for k := range sc.envAssigns {
				localVars = append(localVars, k)
			}
			for _, lv := range localVars {
				if lv == "" {
					continue
				}
				if oldV, ok := origEnv[lv]; ok {
					env[lv] = oldV
				} else {
					delete(env, lv)
				}
			}
			if prevInFunc != "" {
				env["\x00IN_FUNC"] = prevInFunc
			} else {
				delete(env, "\x00IN_FUNC")
			}
			if prevLocalVars != "" {
				env["\x00LOCAL_VARS"] = prevLocalVars
			} else {
				delete(env, "\x00LOCAL_VARS")
			}
			setPositionalEnv(env, oldPos)

		case isBareCmd && isShellInterpreterName(baseProg):
			stdinData = consumeShellStdin()
			if depth > 6 {
				stderrBuf.Write([]byte("shell recursion limit exceeded\n"))
				exitCode = 1
				break
			}
			var (
				hasC       bool
				hasS       bool
				scriptCmd  string
				posArgs    []string
				scriptFile string
			)
			for i := 0; i < len(args); i++ {
				a := args[i]
				if a == "-c" || strings.EqualFold(a, "/c") {
					hasC = true
					if i+1 < len(args) {
						scriptCmd = args[i+1]
						posArgs = args[i+2:]
					}
					break
				}
				if a == "-s" {
					hasS = true
					posArgs = args[i+1:]
					break
				}
				if a == "/d" || a == "/s" || strings.HasPrefix(a, "-") {
					continue
				}
				scriptFile = a
				posArgs = args[i+1:]
				break
			}
			var subEnv map[string]string
			var subStdin []byte
			if hasC {
				arg0 := prog
				var scriptPos []string
				if len(posArgs) > 0 {
					arg0 = posArgs[0]
					scriptPos = posArgs[1:]
				}
				subEnv = bindPositionalEnv(cmdEnv, arg0, scriptPos)
				subStdin = stdinData
			} else if scriptFile != "" && !hasS {
				sp := scriptFile
				if !filepath.IsAbs(sp) {
					sp = filepath.Join(*cwd, sp)
				}
				if err := en.checkPath(sp); err != nil {
					stderrBuf.Write([]byte(err.Error() + "\n"))
					exitCode = 126
					break
				}
				b, rerr := readFileBounded(sp, maxBuf)
				if rerr != nil {
					stderrBuf.Write([]byte(rerr.Error() + "\n"))
					if strings.HasPrefix(rerr.Error(), "ENOBUFS:") {
						errStr = "ENOBUFS"
					}
					exitCode = 127
					break
				}
				scriptCmd = string(b)
				subEnv = bindPositionalEnv(cmdEnv, scriptFile, posArgs)
				subStdin = stdinData
			} else {
				scriptCmd = string(stdinData)
				subEnv = bindPositionalEnv(cmdEnv, prog, posArgs)
				subStdin = nil
			}
			delete(subEnv, "\x00TRAP_EXIT")
			en.mu.Lock()
			hasJail := len(en.jailRoots) > 0
			en.mu.Unlock()
			if hasJail {
				if err := en.checkSpawnCmdline(*cwd, scriptCmd, subEnv, depth+1); err != nil {
					stderrBuf.Write([]byte(err.Error() + "\n"))
					exitCode = 126
					break
				}
			}
			subCWD := *cwd
			outB, errB, code, sig, eStr := en.evalPOSIXShellWithMax(ctx, scriptCmd, subCWD, subEnv, subStdin, maxBuf, depth+1)
			_, _ = stdoutBuf.Write(outB)
			_, _ = stderrBuf.Write(errB)
			exitCode = code
			sigStr = sig
			errStr = eStr

		case isBareCmd && baseProg == "git":
			stdinData = consumeShellStdin()
			en.mu.Lock()
			hasJail := len(en.jailRoots) > 0
			en.mu.Unlock()
			if hasJail {
				for k := range sc.envAssigns {
					if isRejectedJailedEnvKey(k) {
						stderrBuf.Write([]byte(fmt.Sprintf("EACCES: jailed: environment variable %q is not allowed in sandbox\n", k)))
						exitCode = 1
						break
					}
				}
				if exitCode != 0 {
					break
				}
			}
			if err := en.checkGitArgs(*cwd, args); err != nil {
				stderrBuf.Write([]byte(err.Error() + "\n"))
				exitCode = 1
				break
			}
			gitBin, lerr := lookPathWithEnv("git", *cwd, envMapToSlice(cmdEnv))
			if lerr != nil {
				gitBin, lerr = exec.LookPath("git")
			}
			if lerr != nil {
				stderrBuf.Write([]byte("git: command not found\n"))
				exitCode = 127
				break
			}
			gitArgs := args
			var gitSandboxDir string
			if hasJail {
				for k := range cmdEnv {
					if isBlockedJailedEnvKey(k) {
						delete(cmdEnv, k)
					}
				}
				emptyCfg := os.DevNull
				emptyHooks := ""
				if tmpDir, terr := os.MkdirTemp("", "indirect-git-sandbox-*"); terr == nil {
					gitSandboxDir = tmpDir
					cfgFile := filepath.Join(tmpDir, "gitconfig")
					hooksDir := filepath.Join(tmpDir, "hooks")
					if err := os.WriteFile(cfgFile, nil, 0o600); err == nil {
						emptyCfg = cfgFile
					}
					if err := os.MkdirAll(hooksDir, 0o700); err == nil {
						emptyHooks = hooksDir
					}
				}
				sanitizedArgs := make([]string, 0, len(args)+2)
				injectedNoExtDiff := false
				for _, a := range args {
					sanitizedArgs = append(sanitizedArgs, a)
					if !injectedNoExtDiff && !strings.HasPrefix(a, "-") {
						lowerSub := strings.ToLower(a)
						if lowerSub == "diff" || lowerSub == "log" || lowerSub == "show" {
							sanitizedArgs = append(sanitizedArgs, "--no-ext-diff", "--no-textconv")
						}
						injectedNoExtDiff = true
					}
				}
				gitArgs = append([]string{
					"--no-pager",
					"--no-optional-locks",
					"-c", "core.hooksPath=" + emptyHooks,
					"-c", "core.attributesFile=" + emptyCfg,
					"-c", "core.excludesFile=" + emptyCfg,
					"-c", "core.fsmonitor=false",
					"-c", "core.pager=cat",
					"-c", "core.editor=false",
					"-c", "core.sshCommand=false",
					"-c", "core.askPass=",
					"-c", "core.gitProxy=none",
					"-c", "diff.external=",
					"-c", "protocol.allow=never",
					"-c", "protocol.ext.allow=never",
					"-c", "credential.helper=",
					"-c", "commit.gpgSign=false",
					"-c", "tag.gpgSign=false",
					"-c", "gpg.program=false",
					"-c", "gpg.ssh.program=false",
					"-c", "gpg.openpgp.program=false",
					"-c", "gpg.x509.program=false",
					"-c", "man.viewer=false",
					"-c", "web.browser=false",
					"-c", "grep.openFilesInPager=false",
					"-c", "interactive.diffFilter=false",
					"-c", "core.alternateRefsCommand=false",
				}, sanitizedArgs...)
				cmdEnv["GIT_CONFIG_NOSYSTEM"] = "1"
				cmdEnv["GIT_CONFIG_GLOBAL"] = emptyCfg
				cmdEnv["GIT_CONFIG_SYSTEM"] = emptyCfg
				cmdEnv["GIT_ATTR_NOSYSTEM"] = "1"
				cmdEnv["GIT_OPTIONAL_LOCKS"] = "0"
				cmdEnv["GIT_TERMINAL_PROMPT"] = "0"
				cmdEnv["GIT_ASKPASS"] = "echo"
				cmdEnv["SSH_ASKPASS"] = "echo"
				cmdEnv["GIT_SSH_COMMAND"] = "false"
				cmdEnv["GIT_EDITOR"] = "false"
				cmdEnv["GIT_SEQUENCE_EDITOR"] = "false"
				cmdEnv["GIT_PAGER"] = "cat"
				cmdEnv["PAGER"] = "cat"
				en.applySandboxEnvRoots(cmdEnv)
			}
			cmd := exec.CommandContext(ctx, gitBin, gitArgs...)
			cmd.Dir = *cwd
			cmd.Env = envMapToSlice(cmdEnv)
			outB, errB, code, sig, eStr := en.runBoundedExecCmd(ctx, cmd, stdinData, sc.stderrTo1, maxBuf)
			if gitSandboxDir != "" {
				_ = os.RemoveAll(gitSandboxDir)
			}
			_, _ = stdoutBuf.Write(outB)
			_, _ = stderrBuf.Write(errB)
			exitCode = code
			sigStr = sig
			errStr = eStr

		case isBareCmd && baseProg == "node":
			stdinData = consumeShellStdin()
			if err := en.checkArgvPaths(*cwd, args); err != nil {
				stderrBuf.Write([]byte(err.Error() + "\n"))
				exitCode = 1
				break
			}
			for i := 0; i < len(args); i++ {
				a := args[i]
				if a == "-e" || a == "--eval" || a == "-p" || a == "--print" {
					i++
					continue
				}
				if strings.HasPrefix(a, "-") {
					continue
				}
				p := a
				if !filepath.IsAbs(p) {
					p = filepath.Join(*cwd, p)
				}
				if err := en.checkPath(p); err != nil {
					stderrBuf.Write([]byte(err.Error() + "\n"))
					exitCode = 126
					break
				}
				break
			}
			if exitCode != 0 {
				break
			}
			nodeArgs := append([]string{"--js"}, args...)
			cmd := exec.CommandContext(ctx, en.execPath, nodeArgs...)
			cmd.Dir = *cwd
			en.enforceChildEnvMap(cmdEnv)
			cmd.Env = envMapToSlice(cmdEnv)
			outB, errB, code, sig, eStr := en.runBoundedExecCmd(ctx, cmd, stdinData, sc.stderrTo1, maxBuf)
			_, _ = stdoutBuf.Write(outB)
			_, _ = stderrBuf.Write(errB)
			exitCode = code
			sigStr = sig
			errStr = eStr

		case isBareCmd && baseProg == "echo":
			noNewline := false
			interpEsc := false
			for len(args) > 0 && strings.HasPrefix(args[0], "-") && len(args[0]) > 1 {
				valid := true
				for _, ch := range args[0][1:] {
					if ch != 'n' && ch != 'e' && ch != 'E' {
						valid = false
						break
					}
				}
				if !valid {
					break
				}
				for _, ch := range args[0][1:] {
					switch ch {
					case 'n':
						noNewline = true
					case 'e':
						interpEsc = true
					case 'E':
						interpEsc = false
					}
				}
				args = args[1:]
			}
			outStr := strings.Join(args, " ")
			if interpEsc {
				var stop bool
				outStr, stop = expandEchoEscapes(outStr)
				if stop {
					noNewline = true
				}
			}
			_, _ = stdoutBuf.Write([]byte(outStr))
			if !noNewline {
				_, _ = stdoutBuf.Write([]byte{'\n'})
			}

		case isBareCmd && baseProg == "printf":
			pArgs := args
			if len(pArgs) > 0 && pArgs[0] == "--" {
				pArgs = pArgs[1:]
			}
			if len(pArgs) > 0 {
				_, _ = stdoutBuf.Write([]byte(posixPrintf(pArgs[0], pArgs[1:])))
			}

		case isBareCmd && (baseProg == "true" || baseProg == ":"):
			exitCode = 0

		case isBareCmd && baseProg == "false":
			exitCode = 1

		case isBareCmd && baseProg == "pwd":
			_, _ = stdoutBuf.Write([]byte(*cwd + "\n"))

		case isBareCmd && baseProg == "cd":
			cArgs := args
			if len(cArgs) > 0 && (cArgs[0] == "-L" || cArgs[0] == "-P" || cArgs[0] == "--") {
				cArgs = cArgs[1:]
			}
			target := *cwd
			printTarget := false
			if len(cArgs) == 0 {
				if home := env["HOME"]; home != "" {
					target = joinCWDPath(*cwd, home)
				}
			} else if cArgs[0] == "-" {
				oldPwd := env["OLDPWD"]
				if oldPwd == "" {
					_, _ = stderrBuf.Write([]byte("cd: OLDPWD not set\n"))
					exitCode = 1
					break
				}
				target = oldPwd
				printTarget = true
			} else {
				target = joinCWDPath(*cwd, cArgs[0])
			}
			if err := en.checkPath(target); err != nil {
				_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
				exitCode = 1
			} else if info, err := os.Stat(target); err != nil || !info.IsDir() {
				_, _ = stderrBuf.Write([]byte(fmt.Sprintf("cd: %s: No such directory\n", target)))
				exitCode = 1
			} else {
				env["OLDPWD"] = *cwd
				*cwd = target
				env["PWD"] = target
				if printTarget {
					_, _ = stdoutBuf.Write([]byte(target + "\n"))
				}
			}

		case isBareCmd && baseProg == "export":
			for _, a := range args {
				if a == "-p" || a == "--" {
					continue
				}
				if idx := strings.IndexByte(a, '='); idx > 0 {
					key := a[:idx]
					if sandboxed && isRejectedJailedEnvKey(key) {
						_, _ = stderrBuf.Write([]byte(fmt.Sprintf("EACCES: jailed: environment variable %q is not allowed in sandbox\n", key)))
						exitCode = 1
						break
					}
					if sandboxed && isBlockedJailedEnvKey(key) {
						continue
					}
					env[key] = a[idx+1:]
				}
			}
			if sandboxed {
				en.enforceChildEnvMap(env)
			}

		case isBareCmd && (baseProg == "local" || baseProg == "readonly"):
			for _, a := range args {
				if strings.HasPrefix(a, "-") {
					continue
				}
				if idx := strings.IndexByte(a, '='); idx > 0 {
					key := a[:idx]
					if sandboxed && isRejectedJailedEnvKey(key) {
						_, _ = stderrBuf.Write([]byte(fmt.Sprintf("EACCES: jailed: environment variable %q is not allowed in sandbox\n", key)))
						exitCode = 1
						break
					}
					if sandboxed && isBlockedJailedEnvKey(key) {
						continue
					}
					if baseProg == "local" && env["\x00IN_FUNC"] == "1" {
						env["\x00LOCAL_VARS"] = env["\x00LOCAL_VARS"] + "," + key
					}
					env[key] = a[idx+1:]
				} else if isEnvVarIdent(a) {
					if baseProg == "local" && env["\x00IN_FUNC"] == "1" {
						env["\x00LOCAL_VARS"] = env["\x00LOCAL_VARS"] + "," + a
					}
				}
			}
			if sandboxed {
				en.enforceChildEnvMap(env)
			}

		case isBareCmd && baseProg == "unset":
			fnMode := false
			for _, a := range args {
				if a == "-f" {
					fnMode = true
					continue
				}
				if strings.HasPrefix(a, "-") {
					continue
				}
				if fnMode {
					delete(env, "\x00FN_"+a)
				} else if !(sandboxed && isBlockedJailedEnvKey(a)) {
					delete(env, a)
				}
			}

		case isBareCmd && baseProg == "shift":
			n := 1
			if len(args) > 0 {
				parsed, err := strconv.Atoi(args[0])
				if err != nil || parsed < 0 {
					exitCode = 1
					break
				}
				n = parsed
			}
			posArgs := getPositionalArgs(env)
			if n > len(posArgs) {
				exitCode = 1
				break
			}
			setPositionalEnv(env, posArgs[n:])

		case isBareCmd && baseProg == "set":
			i := 0
			setPos := false
			var newPosArgs []string
			for i < len(args) {
				a := args[i]
				if a == "--" {
					setPos = true
					newPosArgs = args[i+1:]
					break
				}
				if a == "-" {
					setPos = true
					newPosArgs = args[i+1:]
					break
				}
				if len(a) > 1 && (a[0] == '-' || a[0] == '+') {
					enable := a[0] == '-'
					flags := a[1:]
					i++
					for fIdx := 0; fIdx < len(flags); fIdx++ {
						switch flags[fIdx] {
						case 'e':
							if enable {
								env["\x00OPT_E"] = "1"
							} else {
								delete(env, "\x00OPT_E")
							}
						case 'u':
							if enable {
								env["\x00OPT_U"] = "1"
							} else {
								delete(env, "\x00OPT_U")
							}
						case 'f':
							if enable {
								env["\x00OPT_F"] = "1"
							} else {
								delete(env, "\x00OPT_F")
							}
						case 'o':
							optName := ""
							if fIdx+1 < len(flags) {
								optName = flags[fIdx+1:]
								fIdx = len(flags)
							} else if i < len(args) {
								optName = args[i]
								i++
							}
							switch optName {
							case "errexit":
								if enable {
									env["\x00OPT_E"] = "1"
								} else {
									delete(env, "\x00OPT_E")
								}
							case "nounset":
								if enable {
									env["\x00OPT_U"] = "1"
								} else {
									delete(env, "\x00OPT_U")
								}
							case "pipefail":
								if enable {
									env["\x00OPT_PIPEFAIL"] = "1"
								} else {
									delete(env, "\x00OPT_PIPEFAIL")
								}
							case "noglob":
								if enable {
									env["\x00OPT_F"] = "1"
								} else {
									delete(env, "\x00OPT_F")
								}
							}
						}
					}
					continue
				}
				setPos = true
				newPosArgs = args[i:]
				break
			}
			if setPos {
				setPositionalEnv(env, newPosArgs)
			}

		case isBareCmd && baseProg == "trap":
			tArgs := args
			for len(tArgs) > 0 && (tArgs[0] == "-p" || tArgs[0] == "--") {
				tArgs = tArgs[1:]
			}
			if len(tArgs) >= 2 {
				action := tArgs[0]
				for _, sig := range tArgs[1:] {
					sigUpper := strings.ToUpper(strings.TrimPrefix(strings.ToUpper(sig), "SIG"))
					if sigUpper == "EXIT" || sigUpper == "0" {
						if action == "-" {
							delete(env, "\x00TRAP_EXIT")
						} else {
							env["\x00TRAP_EXIT"] = action
						}
					}
				}
			}

		case isBareCmd && baseProg == "read":
			rawMode := false
			var varNames []string
			for i := 0; i < len(args); i++ {
				a := args[i]
				if a == "--" {
					varNames = append(varNames, args[i+1:]...)
					break
				}
				if a == "-p" || a == "-d" || a == "-n" || a == "-t" || a == "-u" {
					i++
					continue
				}
				if strings.HasPrefix(a, "-") && len(a) > 1 {
					if strings.Contains(a[1:], "r") {
						rawMode = true
					}
					continue
				}
				varNames = append(varNames, a)
			}
			defaultReply := false
			if len(varNames) == 0 {
				varNames = []string{"REPLY"}
				defaultReply = true
			}
			var srcStr string
			useEnvStdin := false
			if len(stdinData) > 0 || sc.stdinFile != "" || sc.hasHereString {
				srcStr = string(stdinData)
			} else if s, ok := env["\x00STDIN"]; ok {
				srcStr = s
				useEnvStdin = true
			} else if pr := takeShellStdinPipe(ctx); pr != nil {
				b, _ := readAllBounded(pr, maxBuf)
				_ = pr.Close()
				srcStr = string(b)
				useEnvStdin = true
			}
			if len(srcStr) == 0 {
				for _, vn := range varNames {
					if !(sandboxed && isBlockedJailedEnvKey(vn)) {
						env[vn] = ""
					}
				}
				exitCode = 1
				break
			}
			var lineBuf strings.Builder
			pos := 0
			sawNewline := false
			for pos < len(srcStr) {
				ch := srcStr[pos]
				pos++
				if !rawMode && ch == '\\' && pos < len(srcStr) {
					if srcStr[pos] == '\n' {
						pos++
						continue
					}
					if srcStr[pos] == '\r' && pos+1 < len(srcStr) && srcStr[pos+1] == '\n' {
						pos += 2
						continue
					}
					lineBuf.WriteByte(srcStr[pos])
					pos++
					continue
				}
				if ch == '\n' {
					sawNewline = true
					break
				}
				lineBuf.WriteByte(ch)
			}
			if useEnvStdin {
				env["\x00STDIN"] = srcStr[pos:]
			}
			line := strings.TrimSuffix(lineBuf.String(), "\r")
			if !sawNewline {
				exitCode = 1
			}
			if defaultReply {
				env["REPLY"] = line
				break
			}
			ifs := " \t\n"
			if customIFS, ok := env["IFS"]; ok {
				ifs = customIFS
			}
			isIFS := func(b byte) bool {
				return strings.IndexByte(ifs, b) >= 0
			}
			isIFSWhite := func(b byte) bool {
				return (b == ' ' || b == '\t' || b == '\n') && isIFS(b)
			}
			// Trim leading IFS whitespace
			lIdx := 0
			for lIdx < len(line) && isIFSWhite(line[lIdx]) {
				lIdx++
			}
			rIdx := len(line)
			for rIdx > lIdx && isIFSWhite(line[rIdx-1]) {
				rIdx--
			}
			rem := line[lIdx:rIdx]
			for vIdx := 0; vIdx < len(varNames); vIdx++ {
				vn := varNames[vIdx]
				if vIdx == len(varNames)-1 {
					if !(sandboxed && isBlockedJailedEnvKey(vn)) {
						env[vn] = rem
					}
					break
				}
				if len(rem) == 0 {
					if !(sandboxed && isBlockedJailedEnvKey(vn)) {
						env[vn] = ""
					}
					continue
				}
				fEnd := 0
				for fEnd < len(rem) && !isIFS(rem[fEnd]) {
					fEnd++
				}
				fieldVal := rem[:fEnd]
				nextStart := fEnd
				for nextStart < len(rem) && isIFSWhite(rem[nextStart]) {
					nextStart++
				}
				if nextStart < len(rem) && isIFS(rem[nextStart]) && !isIFSWhite(rem[nextStart]) {
					nextStart++
					for nextStart < len(rem) && isIFSWhite(rem[nextStart]) {
						nextStart++
					}
				}
				rem = rem[nextStart:]
				if !(sandboxed && isBlockedJailedEnvKey(vn)) {
					env[vn] = fieldVal
				}
			}

		case isBareCmd && baseProg == "command":
			optV := false
			optBigV := false
			cIdx := 0
			for cIdx < len(args) {
				a := args[cIdx]
				if a == "--" {
					cIdx++
					break
				}
				if strings.HasPrefix(a, "-") && len(a) > 1 {
					for _, ch := range a[1:] {
						switch ch {
						case 'v':
							optV = true
						case 'V':
							optBigV = true
						}
					}
					cIdx++
					continue
				}
				break
			}
			remArgs := args[cIdx:]
			if optV || optBigV {
				if len(remArgs) == 0 {
					exitCode = 1
					break
				}
				for _, target := range remArgs {
					if env["\x00FN_"+target] != "" {
						if optBigV {
							_, _ = stdoutBuf.Write([]byte(target + " is a function\n"))
						} else {
							_, _ = stdoutBuf.Write([]byte(target + "\n"))
						}
					} else if isPOSIXBuiltinName(target) {
						if optBigV {
							_, _ = stdoutBuf.Write([]byte(target + " is a shell builtin\n"))
						} else {
							_, _ = stdoutBuf.Write([]byte(target + "\n"))
						}
					} else if target == "git" || target == "node" {
						if optBigV {
							_, _ = stdoutBuf.Write([]byte(target + " is /bin/" + target + "\n"))
						} else {
							_, _ = stdoutBuf.Write([]byte("/bin/" + target + "\n"))
						}
					} else if lp, err := lookPathWithEnv(target, *cwd, envMapToSlice(cmdEnv)); err == nil {
						if optBigV {
							_, _ = stdoutBuf.Write([]byte(target + " is " + lp + "\n"))
						} else {
							_, _ = stdoutBuf.Write([]byte(lp + "\n"))
						}
					} else {
						if optBigV {
							_, _ = stderrBuf.Write([]byte(fmt.Sprintf("command: %s: not found\n", target)))
						}
						exitCode = 1
					}
				}
				break
			}
			if len(remArgs) > 0 {
				subAssigns := make(map[string]string, len(sc.envAssigns)+1)
				for k, v := range sc.envAssigns {
					subAssigns[k] = v
				}
				subAssigns["\x00BYPASS_FN"] = "1"
				subSC := posixSimpleCmd{
					envAssigns: subAssigns,
					argv:       remArgs,
				}
				outB, errB, code, sig, eStr, bFlow := en.evalPOSIXSimpleCmd(ctx, subSC, cwd, env, stdinData, maxBuf, depth+1)
				_, _ = stdoutBuf.Write(outB)
				_, _ = stderrBuf.Write(errB)
				exitCode = code
				sigStr = sig
				errStr = eStr
				flowCtrl = bFlow
			}

		case isBareCmd && baseProg == "return":
			if len(args) > 0 {
				if n, err := strconv.Atoi(args[0]); err == nil {
					exitCode = n
				}
			} else if prev, err := strconv.Atoi(env["?"]); err == nil {
				exitCode = prev
			}
			flowCtrl = "return"

		case isBareCmd && baseProg == "exit":
			if len(args) > 0 {
				if n, err := strconv.Atoi(args[0]); err == nil {
					exitCode = n
				}
			} else if prev, err := strconv.Atoi(env["?"]); err == nil {
				exitCode = prev
			}
			flowCtrl = "exit"

		case isBareCmd && baseProg == "break":
			flowCtrl = "break"

		case isBareCmd && baseProg == "continue":
			flowCtrl = "continue"

		case isBareCmd && baseProg == "sleep":
			secs := 0.0
			if len(args) > 0 {
				secs, _ = strconv.ParseFloat(args[0], 64)
			}
			d := time.Duration(secs * float64(time.Second))
			select {
			case <-time.After(d):
			case <-ctx.Done():
				if ctx.Err() == context.DeadlineExceeded {
					s := "SIGTERM"
					sigStr = &s
					errStr = "ETIMEDOUT"
					exitCode = 143
				} else {
					exitCode = 130
				}
			}

		case isBareCmd && baseProg == "type":
			shortType := false
			var targets []string
			for _, a := range args {
				if a == "-t" {
					shortType = true
					continue
				}
				if strings.HasPrefix(a, "-") {
					continue
				}
				targets = append(targets, a)
			}
			for _, t := range targets {
				if env["\x00FN_"+t] != "" {
					if shortType {
						_, _ = stdoutBuf.Write([]byte("function\n"))
					} else {
						_, _ = stdoutBuf.Write([]byte(t + " is a function\n"))
					}
				} else if isPOSIXBuiltinName(t) {
					if shortType {
						_, _ = stdoutBuf.Write([]byte("builtin\n"))
					} else {
						_, _ = stdoutBuf.Write([]byte(t + " is a shell builtin\n"))
					}
				} else if lp, err := lookPathWithEnv(t, *cwd, envMapToSlice(cmdEnv)); err == nil {
					if shortType {
						_, _ = stdoutBuf.Write([]byte("file\n"))
					} else {
						_, _ = stdoutBuf.Write([]byte(t + " is " + lp + "\n"))
					}
				} else {
					_, _ = stderrBuf.Write([]byte(fmt.Sprintf("type: %s: not found\n", t)))
					exitCode = 1
				}
			}

		case isBareCmd && baseProg == "cat":
			numberAll := false
			numberNonBlank := false
			var fileArgs []string
			afterDashDash := false
			for _, a := range args {
				if !afterDashDash && a == "--" {
					afterDashDash = true
					continue
				}
				if !afterDashDash && len(a) > 1 && strings.HasPrefix(a, "-") {
					for _, ch := range a[1:] {
						switch ch {
						case 'n':
							numberAll = true
						case 'b':
							numberNonBlank = true
						}
					}
					continue
				}
				fileArgs = append(fileArgs, a)
			}
			lineNum := 1
			writeCatChunk := func(data []byte) {
				if !numberAll && !numberNonBlank {
					_, _ = stdoutBuf.Write(data)
					return
				}
				s := string(data)
				for len(s) > 0 {
					idx := strings.IndexByte(s, '\n')
					var line string
					if idx >= 0 {
						line = s[:idx+1]
						s = s[idx+1:]
					} else {
						line = s
						s = ""
					}
					contentOnly := strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
					if numberNonBlank {
						if contentOnly != "" {
							_, _ = fmt.Fprintf(stdoutBuf, "%6d\t%s", lineNum, line)
							lineNum++
						} else {
							_, _ = stdoutBuf.Write([]byte(line))
						}
					} else if numberAll {
						_, _ = fmt.Fprintf(stdoutBuf, "%6d\t%s", lineNum, line)
						lineNum++
					}
				}
			}
			if len(fileArgs) == 0 {
				writeCatChunk(consumeShellStdin())
			} else {
				for _, a := range fileArgs {
					if a == "-" {
						writeCatChunk(consumeShellStdin())
						continue
					}
					if isNullDevicePath(a) {
						continue
					}
					p := joinCWDPath(*cwd, a)
					if err := en.checkPath(p); err != nil {
						_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
						exitCode = 1
						continue
					}
					b, err := readFileBounded(p, maxBuf)
					if err != nil {
						_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
						if strings.HasPrefix(err.Error(), "ENOBUFS:") {
							errStr = "ENOBUFS"
						}
						exitCode = 1
						continue
					}
					writeCatChunk(b)
				}
			}

		case isBareCmd && baseProg == "env":
			eIdx := 0
			subEnv := make(map[string]string, len(cmdEnv))
			for k, v := range cmdEnv {
				subEnv[k] = v
			}
			for eIdx < len(args) {
				a := args[eIdx]
				if a == "-i" || a == "-" {
					for k := range subEnv {
						if !strings.HasPrefix(k, "\x00") {
							delete(subEnv, k)
						}
					}
					eIdx++
					continue
				}
				if idx := strings.IndexByte(a, '='); idx > 0 && isEnvVarIdent(a[:idx]) {
					subEnv[a[:idx]] = a[idx+1:]
					eIdx++
					continue
				}
				break
			}
			if eIdx < len(args) {
				subSC := posixSimpleCmd{
					envAssigns: make(map[string]string),
					argv:       args[eIdx:],
				}
				outB, errB, code, sig, eStr, bFlow := en.evalPOSIXSimpleCmd(ctx, subSC, cwd, subEnv, stdinData, maxBuf, depth+1)
				_, _ = stdoutBuf.Write(outB)
				_, _ = stderrBuf.Write(errB)
				exitCode = code
				sigStr = sig
				errStr = eStr
				flowCtrl = bFlow
				break
			}
			keys := make([]string, 0, len(subEnv))
			for k := range subEnv {
				if strings.HasPrefix(k, "\x00") || k == "?" || k == "#" || k == "@" || k == "*" {
					continue
				}
				if len(k) == 1 && k[0] >= '0' && k[0] <= '9' {
					continue
				}
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				_, _ = stdoutBuf.Write([]byte(k + "=" + subEnv[k] + "\n"))
			}

		case isBareCmd && (baseProg == "ls" || baseProg == "dir"):
			showAll := false
			longFmt := false
			dirAsEntry := false
			var targets []string
			for _, a := range args {
				if strings.HasPrefix(a, "-") && len(a) > 1 {
					if strings.ContainsAny(a[1:], "aA") {
						showAll = true
					}
					if strings.Contains(a[1:], "l") {
						longFmt = true
					}
					if strings.Contains(a[1:], "d") {
						dirAsEntry = true
					}
					continue
				}
				targets = append(targets, a)
			}
			if len(targets) == 0 {
				targets = []string{*cwd}
			}
			formatLsEntry := func(name string, info fs.FileInfo) string {
				if !longFmt || info == nil {
					return name + "\n"
				}
				return fmt.Sprintf("%s 1 user group %8d %s %s\n", info.Mode().String(), info.Size(), info.ModTime().Format("Jan _2 15:04"), name)
			}
			for _, t := range targets {
				p := joinCWDPath(*cwd, t)
				if err := en.checkPath(p); err != nil {
					_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
					exitCode = 1
					continue
				}
				info, err := os.Stat(p)
				if err != nil {
					_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
					exitCode = 1
					continue
				}
				if !info.IsDir() || dirAsEntry {
					_, _ = stdoutBuf.Write([]byte(formatLsEntry(t, info)))
					continue
				}
				entries, err := os.ReadDir(p)
				if err != nil {
					_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
					exitCode = 1
					continue
				}
				for _, e := range entries {
					name := e.Name()
					if !showAll && strings.HasPrefix(name, ".") {
						continue
					}
					eInfo, _ := e.Info()
					_, _ = stdoutBuf.Write([]byte(formatLsEntry(name, eInfo)))
				}
			}

		case isBareCmd && baseProg == "mkdir":
			parents := false
			var dirs []string
			for _, a := range args {
				if a == "-p" || a == "--parents" {
					parents = true
					continue
				}
				if strings.HasPrefix(a, "-") {
					continue
				}
				dirs = append(dirs, a)
			}
			for _, d := range dirs {
				p := joinCWDPath(*cwd, d)
				if err := en.checkWritePath(p); err != nil {
					_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
					exitCode = 1
					continue
				}
				var err error
				if parents {
					err = os.MkdirAll(p, 0o777)
				} else {
					err = os.Mkdir(p, 0o777)
				}
				if err != nil {
					_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
					exitCode = 1
				}
			}

		case isBareCmd && (baseProg == "rm" || baseProg == "rmdir"):
			recursive := false
			force := false
			var paths []string
			for _, a := range args {
				if strings.HasPrefix(a, "-") {
					if strings.ContainsAny(a, "rR") {
						recursive = true
					}
					if strings.Contains(a, "f") {
						force = true
					}
					continue
				}
				paths = append(paths, a)
			}
			for _, rawP := range paths {
				p := joinCWDPath(*cwd, rawP)
				if err := en.checkSubtreeWritable(p); err != nil {
					_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
					exitCode = 1
					continue
				}
				var err error
				if recursive {
					err = os.RemoveAll(p)
				} else {
					err = os.Remove(p)
				}
				if err != nil && (!force || !errors.Is(err, os.ErrNotExist)) {
					_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
					exitCode = 1
				}
			}

		case isBareCmd && baseProg == "touch":
			now := time.Now()
			for _, a := range args {
				if strings.HasPrefix(a, "-") {
					continue
				}
				p := a
				if !filepath.IsAbs(p) {
					p = filepath.Join(*cwd, p)
				}
				if err := en.checkWritePath(p); err != nil {
					_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
					exitCode = 1
					continue
				}
				if _, err := os.Stat(p); errors.Is(err, os.ErrNotExist) {
					f, cerr := os.OpenFile(p, os.O_CREATE|os.O_WRONLY, 0o666)
					if cerr != nil {
						_, _ = stderrBuf.Write([]byte(cerr.Error() + "\n"))
						exitCode = 1
						continue
					}
					_ = f.Close()
				} else {
					_ = os.Chtimes(p, now, now)
				}
			}

		case isBareCmd && (baseProg == "cp" || baseProg == "mv"):
			recursive := false
			var nonFlags []string
			for _, a := range args {
				if strings.HasPrefix(a, "-") && len(a) > 1 {
					if a == "--recursive" || a == "--archive" || (!strings.HasPrefix(a, "--") && strings.ContainsAny(a[1:], "rRa")) {
						recursive = true
					}
					continue
				}
				nonFlags = append(nonFlags, a)
			}
			if len(nonFlags) < 2 {
				_, _ = stderrBuf.Write([]byte(baseProg + ": missing file operand\n"))
				exitCode = 1
				break
			}
			srcs := nonFlags[:len(nonFlags)-1]
			dstRaw := nonFlags[len(nonFlags)-1]
			dstBase := joinCWDPath(*cwd, dstRaw)
			if err := en.checkWritePath(dstBase); err != nil {
				_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
				exitCode = 1
				break
			}
			dInfo, dErr := os.Stat(dstBase)
			dstIsDir := dErr == nil && dInfo.IsDir()
			if len(srcs) > 1 && !dstIsDir {
				_, _ = stderrBuf.Write([]byte(fmt.Sprintf("%s: target %q is not a directory\n", baseProg, dstRaw)))
				exitCode = 1
				break
			}
			for _, srcRaw := range srcs {
				src := joinCWDPath(*cwd, srcRaw)
				if baseProg == "mv" {
					if err := en.checkSubtreeWritable(src); err != nil {
						_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
						exitCode = 1
						continue
					}
				} else {
					if err := en.checkPath(src); err != nil {
						_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
						exitCode = 1
						continue
					}
				}
				dst := dstBase
				if dstIsDir {
					dst = filepath.Join(dstBase, filepath.Base(src))
				}
				if err := en.checkWritePath(dst); err != nil {
					_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
					exitCode = 1
					continue
				}
				var opErr error
				if baseProg == "mv" {
					opErr = os.Rename(src, dst)
				} else {
					sInfo, sErr := os.Stat(src)
					if sErr != nil {
						opErr = sErr
					} else if sInfo.IsDir() {
						if !recursive {
							opErr = fmt.Errorf("cp: -r not specified; omitting directory %q", srcRaw)
						} else {
							reqBytes, _ := json.Marshal(map[string]any{
								"src":       src,
								"dest":      dst,
								"recursive": true,
								"force":     true,
							})
							_, _, _, _, opErr = en.opFSCp(string(reqBytes))
						}
					} else {
						opErr = en.copySingleFile(src, dst)
					}
				}
				if opErr != nil {
					_, _ = stderrBuf.Write([]byte(opErr.Error() + "\n"))
					exitCode = 1
				}
			}

		case isBareCmd && (baseProg == "head" || baseProg == "tail"):
			linesCount := 10
			bytesCount := -1
			var files []string
			for i := 0; i < len(args); i++ {
				a := args[i]
				if a == "-n" && i+1 < len(args) {
					i++
					if n, err := strconv.Atoi(args[i]); err == nil && n >= 0 {
						linesCount = n
					}
					continue
				}
				if strings.HasPrefix(a, "-n") && len(a) > 2 {
					if n, err := strconv.Atoi(a[2:]); err == nil && n >= 0 {
						linesCount = n
					}
					continue
				}
				if a == "-c" && i+1 < len(args) {
					i++
					if n, err := strconv.Atoi(args[i]); err == nil && n >= 0 {
						bytesCount = n
					}
					continue
				}
				if strings.HasPrefix(a, "-c") && len(a) > 2 {
					if n, err := strconv.Atoi(a[2:]); err == nil && n >= 0 {
						bytesCount = n
					}
					continue
				}
				if strings.HasPrefix(a, "-") && len(a) > 1 {
					if n, err := strconv.Atoi(a[1:]); err == nil && n >= 0 {
						linesCount = n
						continue
					}
				}
				files = append(files, a)
			}
			processBytes := func(data []byte) {
				if bytesCount >= 0 {
					if baseProg == "head" {
						if bytesCount < len(data) {
							data = data[:bytesCount]
						}
					} else {
						if bytesCount < len(data) {
							data = data[len(data)-bytesCount:]
						}
					}
					_, _ = stdoutBuf.Write(data)
					return
				}
				s := string(data)
				lines := strings.SplitAfter(s, "\n")
				if len(lines) > 0 && lines[len(lines)-1] == "" {
					lines = lines[:len(lines)-1]
				}
				if baseProg == "head" {
					if linesCount < len(lines) {
						lines = lines[:linesCount]
					}
				} else {
					if linesCount < len(lines) {
						lines = lines[len(lines)-linesCount:]
					}
				}
				for _, l := range lines {
					_, _ = stdoutBuf.Write([]byte(l))
				}
			}
			if len(files) == 0 {
				processBytes(consumeShellStdin())
			} else {
				for _, f := range files {
					if isNullDevicePath(f) {
						continue
					}
					p := joinCWDPath(*cwd, f)
					if err := en.checkPath(p); err != nil {
						_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
						exitCode = 1
						continue
					}
					b, err := readFileBounded(p, maxBuf)
					if err != nil {
						_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
						exitCode = 1
						continue
					}
					processBytes(b)
				}
			}

		case isBareCmd && baseProg == "wc":
			countLines := false
			countWords := false
			countBytes := false
			var files []string
			for _, a := range args {
				if strings.HasPrefix(a, "-") && len(a) > 1 {
					if strings.Contains(a, "l") {
						countLines = true
					}
					if strings.Contains(a, "w") {
						countWords = true
					}
					if strings.ContainsAny(a, "cm") {
						countBytes = true
					}
					continue
				}
				files = append(files, a)
			}
			if !countLines && !countWords && !countBytes {
				countLines, countWords, countBytes = true, true, true
			}
			formatWC := func(l, w, c int, name string) string {
				var parts []string
				if countLines {
					parts = append(parts, strconv.Itoa(l))
				}
				if countWords {
					parts = append(parts, strconv.Itoa(w))
				}
				if countBytes {
					parts = append(parts, strconv.Itoa(c))
				}
				if name != "" {
					parts = append(parts, name)
				}
				return strings.Join(parts, " ")
			}
			countBuf := func(b []byte) (int, int, int) {
				return bytes.Count(b, []byte{'\n'}), len(strings.Fields(string(b))), len(b)
			}
			if len(files) == 0 {
				l, w, c := countBuf(consumeShellStdin())
				_, _ = stdoutBuf.Write([]byte(formatWC(l, w, c, "") + "\n"))
			} else {
				totL, totW, totC := 0, 0, 0
				for _, f := range files {
					if isNullDevicePath(f) {
						_, _ = stdoutBuf.Write([]byte(formatWC(0, 0, 0, f) + "\n"))
						continue
					}
					p := joinCWDPath(*cwd, f)
					if err := en.checkPath(p); err != nil {
						_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
						exitCode = 1
						continue
					}
					b, err := readFileBounded(p, maxBuf)
					if err != nil {
						_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
						exitCode = 1
						continue
					}
					l, w, c := countBuf(b)
					totL += l
					totW += w
					totC += c
					_, _ = stdoutBuf.Write([]byte(formatWC(l, w, c, f) + "\n"))
				}
				if len(files) > 1 {
					_, _ = stdoutBuf.Write([]byte(formatWC(totL, totW, totC, "total") + "\n"))
				}
			}

		case isBareCmd && baseProg == "grep":
			ignoreCase := false
			invert := false
			lineNum := false
			countOnly := false
			filesWithMatches := false
			quiet := false
			fixed := false
			recursive := false
			noFilename := false
			withFilename := false
			var patterns []string
			var nonFlags []string
			for i := 0; i < len(args); i++ {
				a := args[i]
				if a == "-e" && i+1 < len(args) {
					i++
					patterns = append(patterns, args[i])
					continue
				}
				if strings.HasPrefix(a, "-") && len(a) > 1 {
					for _, ch := range a[1:] {
						switch ch {
						case 'i':
							ignoreCase = true
						case 'v':
							invert = true
						case 'n':
							lineNum = true
						case 'c':
							countOnly = true
						case 'l':
							filesWithMatches = true
						case 'q':
							quiet = true
						case 'F':
							fixed = true
						case 'r', 'R':
							recursive = true
						case 'h':
							noFilename = true
						case 'H':
							withFilename = true
						}
					}
					continue
				}
				nonFlags = append(nonFlags, a)
			}
			if len(patterns) == 0 {
				if len(nonFlags) == 0 {
					exitCode = 2
					break
				}
				patterns = []string{nonFlags[0]}
				nonFlags = nonFlags[1:]
			}
			files := nonFlags
			if recursive && len(files) == 0 {
				files = []string{"."}
			}
			var regParts []string
			for _, pat := range patterns {
				if fixed {
					regParts = append(regParts, regexp.QuoteMeta(pat))
				} else {
					regParts = append(regParts, pat)
				}
			}
			fullPat := strings.Join(regParts, "|")
			if ignoreCase {
				fullPat = "(?i)" + fullPat
			}
			re, rerr := regexp.Compile(fullPat)
			if rerr != nil {
				_, _ = stderrBuf.Write([]byte(rerr.Error() + "\n"))
				exitCode = 2
				break
			}
			matchedAny := false
			showPrefix := (withFilename || recursive || len(files) > 1) && !noFilename
			grepContent := func(label string, data []byte) {
				lines := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
				if len(data) == 0 {
					lines = nil
				}
				matchCount := 0
				for idx, line := range lines {
					lineClean := strings.TrimSuffix(line, "\r")
					ok := re.MatchString(lineClean)
					if invert {
						ok = !ok
					}
					if ok {
						matchedAny = true
						matchCount++
						if filesWithMatches {
							if !quiet && label != "" {
								_, _ = stdoutBuf.Write([]byte(label + "\n"))
							}
							return
						}
						if !quiet && !countOnly {
							pfx := ""
							if showPrefix && label != "" {
								pfx = label + ":"
							}
							if lineNum {
								_, _ = stdoutBuf.Write([]byte(fmt.Sprintf("%s%d:%s\n", pfx, idx+1, lineClean)))
							} else {
								_, _ = stdoutBuf.Write([]byte(fmt.Sprintf("%s%s\n", pfx, lineClean)))
							}
						}
					}
				}
				if countOnly && !quiet && !filesWithMatches {
					if showPrefix && label != "" {
						_, _ = stdoutBuf.Write([]byte(fmt.Sprintf("%s:%d\n", label, matchCount)))
					} else {
						_, _ = stdoutBuf.Write([]byte(strconv.Itoa(matchCount) + "\n"))
					}
				}
			}
			if len(files) == 0 {
				grepContent("", consumeShellStdin())
			} else {
				for _, f := range files {
					if isNullDevicePath(f) {
						continue
					}
					p := joinCWDPath(*cwd, f)
					if err := en.checkPath(p); err != nil {
						_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
						exitCode = 2
						continue
					}
					info, serr := os.Stat(p)
					if serr != nil {
						_, _ = stderrBuf.Write([]byte(serr.Error() + "\n"))
						exitCode = 2
						continue
					}
					if info.IsDir() {
						if !recursive {
							_, _ = stderrBuf.Write([]byte(fmt.Sprintf("grep: %s: Is a directory\n", f)))
							exitCode = 2
							continue
						}
						_ = filepath.WalkDir(p, func(wp string, d fs.DirEntry, werr error) error {
							if werr != nil || d.IsDir() || en.checkPath(wp) != nil {
								return nil
							}
							b, err := readFileBounded(wp, maxBuf)
							if err != nil {
								return nil
							}
							label := wp
							if rel, rerr := filepath.Rel(*cwd, wp); rerr == nil {
								label = filepath.ToSlash(rel)
							}
							grepContent(label, b)
							return nil
						})
						continue
					}
					b, err := readFileBounded(p, maxBuf)
					if err != nil {
						_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
						exitCode = 2
						continue
					}
					grepContent(filepath.ToSlash(f), b)
				}
			}
			if !matchedAny && exitCode == 0 {
				exitCode = 1
			}

		case isBareCmd && baseProg == "find":
			rootArg := "."
			namePat := ""
			typeFilter := ""
			i := 0
			if i < len(args) && !strings.HasPrefix(args[i], "-") {
				rootArg = args[i]
				i++
			}
			for ; i < len(args); i++ {
				switch args[i] {
				case "-name":
					if i+1 < len(args) {
						i++
						namePat = args[i]
					}
				case "-type":
					if i+1 < len(args) {
						i++
						typeFilter = args[i]
					}
				}
			}
			rootPath := joinCWDPath(*cwd, rootArg)
			if err := en.checkPath(rootPath); err != nil {
				_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
				exitCode = 1
				break
			}
			_ = filepath.WalkDir(rootPath, func(p string, d fs.DirEntry, walkErr error) error {
				if walkErr != nil || en.checkPath(p) != nil {
					return nil
				}
				if typeFilter == "f" && d.IsDir() {
					return nil
				}
				if typeFilter == "d" && !d.IsDir() {
					return nil
				}
				if namePat != "" {
					if ok, _ := filepath.Match(namePat, d.Name()); !ok {
						return nil
					}
				}
				rel, rerr := filepath.Rel(rootPath, p)
				outPath := rootArg
				if rerr == nil && rel != "." {
					if rootArg == "." {
						outPath = "./" + filepath.ToSlash(rel)
					} else {
						outPath = filepath.ToSlash(filepath.Join(rootArg, rel))
					}
				}
				_, _ = stdoutBuf.Write([]byte(outPath + "\n"))
				return nil
			})

		case isBareCmd && baseProg == "sort":
			reverse := false
			unique := false
			var files []string
			for _, a := range args {
				if strings.HasPrefix(a, "-") && len(a) > 1 {
					if strings.Contains(a, "r") {
						reverse = true
					}
					if strings.Contains(a, "u") {
						unique = true
					}
					continue
				}
				files = append(files, a)
			}
			var data []byte
			if len(files) > 0 {
				var all []byte
				for _, f := range files {
					if isNullDevicePath(f) {
						continue
					}
					p := joinCWDPath(*cwd, f)
					if err := en.checkPath(p); err != nil {
						_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
						exitCode = 1
						continue
					}
					b, err := readFileBounded(p, maxBuf)
					if err != nil {
						_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
						exitCode = 1
						continue
					}
					all = append(all, b...)
				}
				data = all
			} else {
				data = consumeShellStdin()
			}
			if len(data) > 0 {
				lines := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
				sort.Strings(lines)
				if reverse {
					for l, r := 0, len(lines)-1; l < r; l, r = l+1, r-1 {
						lines[l], lines[r] = lines[r], lines[l]
					}
				}
				var prev string
				for idx, l := range lines {
					if unique && idx > 0 && l == prev {
						continue
					}
					prev = l
					_, _ = stdoutBuf.Write([]byte(l + "\n"))
				}
			}

		case isBareCmd && baseProg == "uniq":
			countMode := false
			dupOnly := false
			uniqOnly := false
			ignoreCase := false
			var files []string
			for _, a := range args {
				if strings.HasPrefix(a, "-") && len(a) > 1 {
					if strings.Contains(a, "c") {
						countMode = true
					}
					if strings.Contains(a, "d") {
						dupOnly = true
					}
					if strings.Contains(a, "u") {
						uniqOnly = true
					}
					if strings.Contains(a, "i") {
						ignoreCase = true
					}
					continue
				}
				files = append(files, a)
			}
			var inB []byte
			if len(files) > 0 && files[0] != "-" {
				if !isNullDevicePath(files[0]) {
					p := joinCWDPath(*cwd, files[0])
					if err := en.checkPath(p); err != nil {
						_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
						exitCode = 1
						break
					}
					b, err := readFileBounded(p, maxBuf)
					if err != nil {
						_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
						exitCode = 1
						break
					}
					inB = b
				}
			} else {
				inB = consumeShellStdin()
			}
			var outUniq strings.Builder
			if len(inB) > 0 {
				lines := strings.Split(strings.TrimSuffix(string(inB), "\n"), "\n")
				type uniqGroup struct {
					line  string
					count int
				}
				var groups []uniqGroup
				for _, l := range lines {
					lClean := strings.TrimSuffix(l, "\r")
					if len(groups) > 0 {
						prev := groups[len(groups)-1].line
						same := lClean == prev
						if !same && ignoreCase {
							same = strings.EqualFold(lClean, prev)
						}
						if same {
							groups[len(groups)-1].count++
							continue
						}
					}
					groups = append(groups, uniqGroup{line: lClean, count: 1})
				}
				for _, g := range groups {
					if dupOnly && g.count < 2 {
						continue
					}
					if uniqOnly && g.count != 1 {
						continue
					}
					if countMode {
						outUniq.WriteString(fmt.Sprintf("%7d %s\n", g.count, g.line))
					} else {
						outUniq.WriteString(g.line + "\n")
					}
				}
			}
			if len(files) > 1 && files[1] != "-" {
				if !isNullDevicePath(files[1]) {
					outP := joinCWDPath(*cwd, files[1])
					if err := en.checkWritePath(outP); err != nil {
						_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
						exitCode = 1
						break
					}
					if err := os.WriteFile(outP, []byte(outUniq.String()), 0o666); err != nil {
						_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
						exitCode = 1
						break
					}
				}
			} else {
				_, _ = stdoutBuf.Write([]byte(outUniq.String()))
			}

		case isBareCmd && baseProg == "tr":
			deleteMode := false
			var sets []string
			for _, a := range args {
				if a == "-d" {
					deleteMode = true
					continue
				}
				sets = append(sets, a)
			}
			expandTrSet := func(s string) []rune {
				s = strings.ReplaceAll(s, `\n`, "\n")
				s = strings.ReplaceAll(s, `\t`, "\t")
				s = strings.ReplaceAll(s, `\r`, "\r")
				r := []rune(s)
				var out []rune
				for i := 0; i < len(r); i++ {
					if i+2 < len(r) && r[i+1] == '-' {
						for ch := r[i]; ch <= r[i+2]; ch++ {
							out = append(out, ch)
						}
						i += 2
					} else {
						out = append(out, r[i])
					}
				}
				return out
			}
			inB := consumeShellStdin()
			inStr := string(inB)
			if deleteMode && len(sets) >= 1 {
				delSet := make(map[rune]bool)
				for _, ch := range expandTrSet(sets[0]) {
					delSet[ch] = true
				}
				var sb strings.Builder
				for _, ch := range inStr {
					if !delSet[ch] {
						sb.WriteRune(ch)
					}
				}
				_, _ = stdoutBuf.Write([]byte(sb.String()))
			} else if len(sets) >= 2 {
				from := expandTrSet(sets[0])
				to := expandTrSet(sets[1])
				trMap := make(map[rune]rune, len(from))
				for i, ch := range from {
					if len(to) > 0 {
						idx := i
						if idx >= len(to) {
							idx = len(to) - 1
						}
						trMap[ch] = to[idx]
					}
				}
				var sb strings.Builder
				for _, ch := range inStr {
					if rep, ok := trMap[ch]; ok {
						sb.WriteRune(rep)
					} else {
						sb.WriteRune(ch)
					}
				}
				_, _ = stdoutBuf.Write([]byte(sb.String()))
			} else {
				_, _ = stdoutBuf.Write(inB)
			}

		case isBareCmd && baseProg == "tee":
			appendMode := false
			var files []string
			for _, a := range args {
				if a == "-a" {
					appendMode = true
					continue
				}
				if strings.HasPrefix(a, "-") {
					continue
				}
				files = append(files, a)
			}
			inB := consumeShellStdin()
			_, _ = stdoutBuf.Write(inB)
			for _, f := range files {
				if isNullDevicePath(f) {
					continue
				}
				p := joinCWDPath(*cwd, f)
				if err := en.checkWritePath(p); err != nil {
					_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
					exitCode = 1
					continue
				}
				flags := os.O_WRONLY | os.O_CREATE | os.O_TRUNC
				if appendMode {
					flags = os.O_WRONLY | os.O_CREATE | os.O_APPEND
				}
				fh, err := os.OpenFile(p, flags, 0o666)
				if err != nil {
					_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
					exitCode = 1
					continue
				}
				_, _ = fh.Write(inB)
				_ = fh.Close()
			}

		case isBareCmd && baseProg == "basename":
			if len(args) > 0 {
				b := filepath.Base(args[0])
				if len(args) > 1 {
					b = strings.TrimSuffix(b, args[1])
				}
				_, _ = stdoutBuf.Write([]byte(b + "\n"))
			}

		case isBareCmd && baseProg == "dirname":
			if len(args) > 0 {
				_, _ = stdoutBuf.Write([]byte(filepath.Dir(args[0]) + "\n"))
			}

		case isBareCmd && baseProg == "uname":
			if len(args) > 0 && args[0] == "-m" {
				_, _ = stdoutBuf.Write([]byte(runtime.GOARCH + "\n"))
			} else {
				_, _ = stdoutBuf.Write([]byte(runtime.GOOS + "\n"))
			}

		case isBareCmd && (baseProg == "whoami" || baseProg == "id"):
			u, err := user.Current()
			if err == nil && u != nil {
				_, _ = stdoutBuf.Write([]byte(u.Username + "\n"))
			} else {
				_, _ = stdoutBuf.Write([]byte("user\n"))
			}

		case isBareCmd && baseProg == "date":
			now := time.Now().UTC()
			customFmt := ""
			for _, a := range args {
				if strings.HasPrefix(a, "+") {
					customFmt = a[1:]
				}
			}
			if customFmt != "" {
				_, _ = stdoutBuf.Write([]byte(formatStrftime(now, customFmt) + "\n"))
			} else {
				_, _ = stdoutBuf.Write([]byte(now.Format(time.RFC3339) + "\n"))
			}

		case isBareCmd && baseProg == "seq":
			start, step, end := 1, 1, 1
			if len(args) == 1 {
				end, _ = strconv.Atoi(args[0])
			} else if len(args) == 2 {
				start, _ = strconv.Atoi(args[0])
				end, _ = strconv.Atoi(args[1])
			} else if len(args) >= 3 {
				start, _ = strconv.Atoi(args[0])
				step, _ = strconv.Atoi(args[1])
				end, _ = strconv.Atoi(args[2])
			}
			if step == 0 {
				step = 1
			}
			for n := start; (step > 0 && n <= end) || (step < 0 && n >= end); n += step {
				_, _ = stdoutBuf.Write([]byte(strconv.Itoa(n) + "\n"))
				if stdoutBuf.Exceeded() {
					break
				}
			}

		case isBareCmd && baseProg == "yes":
			word := "y"
			if len(args) > 0 {
				word = strings.Join(args, " ")
			}
			line := []byte(word + "\n")
			for !stdoutBuf.Exceeded() && ctx.Err() == nil {
				_, _ = stdoutBuf.Write(line)
			}

		case isBareCmd && baseProg == "which":
			for _, a := range args {
				if isPOSIXBuiltinName(a) || a == "git" || a == "node" {
					_, _ = stdoutBuf.Write([]byte("/bin/" + a + "\n"))
				} else if lp, err := lookPathWithEnv(a, *cwd, envMapToSlice(cmdEnv)); err == nil {
					_, _ = stdoutBuf.Write([]byte(lp + "\n"))
				} else {
					exitCode = 1
				}
			}

		case isBareCmd && (baseProg == "test" || baseProg == "[" || baseProg == "[["):
			tArgs := args
			if (baseProg == "[" && len(tArgs) > 0 && tArgs[len(tArgs)-1] == "]") ||
				(baseProg == "[[" && len(tArgs) > 0 && tArgs[len(tArgs)-1] == "]]") {
				tArgs = tArgs[:len(tArgs)-1]
			}
			var evalTest func([]string) bool
			evalTest = func(ta []string) bool {
				for idx, tok := range ta {
					if tok == "-o" || tok == "||" {
						return evalTest(ta[:idx]) || evalTest(ta[idx+1:])
					}
				}
				for idx, tok := range ta {
					if tok == "-a" || tok == "&&" {
						return evalTest(ta[:idx]) && evalTest(ta[idx+1:])
					}
				}
				neg := false
				for len(ta) > 0 && ta[0] == "!" {
					neg = !neg
					ta = ta[1:]
				}
				ok := false
				switch len(ta) {
				case 1:
					ok = ta[0] != ""
				case 2:
					op, val := ta[0], ta[1]
					switch op {
					case "-n":
						ok = val != ""
					case "-z":
						ok = val == ""
					case "-e", "-f", "-d", "-s", "-r", "-w", "-x", "-L", "-h":
						p := joinCWDPath(*cwd, val)
						if en.checkPath(p) == nil {
							if op == "-L" || op == "-h" {
								if linfo, err := os.Lstat(p); err == nil {
									ok = linfo.Mode()&os.ModeSymlink != 0
								}
							} else if info, err := os.Stat(p); err == nil {
								switch op {
								case "-e", "-r":
									ok = true
								case "-w":
									ok = en.checkWritePath(p) == nil
								case "-x":
									ok = info.IsDir() || info.Mode()&0o111 != 0 || runtime.GOOS == "windows"
								case "-f":
									ok = info.Mode().IsRegular()
								case "-d":
									ok = info.IsDir()
								case "-s":
									ok = info.Size() > 0
								}
							}
						}
					}
				case 3:
					lhs, op, rhs := ta[0], ta[1], ta[2]
					switch op {
					case "=", "==":
						if baseProg == "[[" && (strings.ContainsAny(rhs, "*?[")) {
							ok = shellGlobMatch(rhs, lhs)
						} else {
							ok = lhs == rhs
						}
					case "!=":
						if baseProg == "[[" && (strings.ContainsAny(rhs, "*?[")) {
							ok = !shellGlobMatch(rhs, lhs)
						} else {
							ok = lhs != rhs
						}
					case "-eq", "-ne", "-lt", "-le", "-gt", "-ge":
						ln, _ := strconv.ParseInt(lhs, 10, 64)
						rn, _ := strconv.ParseInt(rhs, 10, 64)
						switch op {
						case "-eq":
							ok = ln == rn
						case "-ne":
							ok = ln != rn
						case "-lt":
							ok = ln < rn
						case "-le":
							ok = ln <= rn
						case "-gt":
							ok = ln > rn
						case "-ge":
							ok = ln >= rn
						}
					}
				}
				if neg {
					ok = !ok
				}
				return ok
			}
			if !evalTest(tArgs) {
				exitCode = 1
			}

	default:
		if en.isSelfJSExec(prog, args) {
			for i := 1; i < len(args); i++ {
				a := args[i]
				if a == "-e" || a == "--eval" || a == "-p" || a == "--print" {
					i++
					continue
				}
				if strings.HasPrefix(a, "-") {
					continue
				}
				if isNullDevicePath(a) {
					continue
				}
				p := joinCWDPath(*cwd, a)
				if err := en.checkPath(p); err != nil {
					_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
					exitCode = 126
					break
				}
			}
			if exitCode != 0 {
				break
			}
		} else if err := en.checkArgvPaths(*cwd, sc.argv); err != nil {
			_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
			exitCode = 1
			break
		}
		if err := en.checkReadOnlyNativeCommand(*cwd, baseProg, args); err != nil {
			_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
			exitCode = 126
			break
		}
		execStdin := consumeShellStdin()
		en.mu.Lock()
		hasJail := len(en.jailRoots) > 0
		en.mu.Unlock()
		if hasJail && !en.isSelfJSExec(prog, args) {
			if isBareCmd {
				if lp, err := lookPathWithEnv(prog, *cwd, envMapToSlice(cmdEnv)); err == nil {
					if en.checkPath(lp) == nil {
						if b, rerr := readFileBounded(lp, maxBuf); rerr == nil {
							kind := classifyScriptFileKind(lp, b)
							if kind == "sh" {
								subEnv := bindPositionalEnv(cmdEnv, prog, args)
								if err := en.checkSpawnCmdline(*cwd, string(b), subEnv, depth+1); err != nil {
									_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
									exitCode = 126
									break
								}
								subCWD := *cwd
								outB, errB, code, sig, eStr := en.evalPOSIXShellWithMax(ctx, string(b), subCWD, subEnv, execStdin, maxBuf, depth+1)
								_, _ = stdoutBuf.Write(outB)
								_, _ = stderrBuf.Write(errB)
								exitCode = code
								sigStr = sig
								errStr = eStr
								break
							}
							if kind == "js" {
								jsArgs := append([]string{"--js", lp}, args...)
								cmd := exec.CommandContext(ctx, en.execPath, jsArgs...)
								cmd.Dir = *cwd
								en.enforceChildEnvMap(cmdEnv)
								cmd.Env = envMapToSlice(cmdEnv)
								outB, errB, code, sig, eStr := en.runBoundedExecCmd(ctx, cmd, execStdin, sc.stderrTo1, maxBuf)
								_, _ = stdoutBuf.Write(outB)
								_, _ = stderrBuf.Write(errB)
								exitCode = code
								sigStr = sig
								errStr = eStr
								break
							}
						}
					}
					if en.checkWritePath(*cwd) != nil {
						cmdEnv["PYTHONDONTWRITEBYTECODE"] = "1"
						if baseProg == "cargo" && cmdEnv["CARGO_TARGET_DIR"] == "" {
							cmdEnv["CARGO_TARGET_DIR"] = os.TempDir()
						}
					}
					cmd := exec.CommandContext(ctx, lp, args...)
					cmd.Dir = *cwd
					en.enforceChildEnvMap(cmdEnv)
					cmd.Env = envMapToSlice(cmdEnv)
					outB, errB, code, sig, eStr := en.runBoundedExecCmd(ctx, cmd, execStdin, sc.stderrTo1, maxBuf)
					_, _ = stdoutBuf.Write(outB)
					_, _ = stderrBuf.Write(errB)
					exitCode = code
					sigStr = sig
					errStr = eStr
					break
				}
			}
			resolvedProg := prog
			if !filepath.IsAbs(resolvedProg) {
				resolvedProg = filepath.Join(*cwd, prog)
			}
			if err := en.checkPath(resolvedProg); err != nil {
				_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
				exitCode = 126
				break
			}
			b, rerr := readFileBounded(resolvedProg, maxBuf)
			if rerr != nil {
				_, _ = stderrBuf.Write([]byte(rerr.Error() + "\n"))
				exitCode = 127
				break
			}
			kind := classifyScriptFileKind(resolvedProg, b)
			if kind == "sh" {
				subEnv := bindPositionalEnv(cmdEnv, prog, args)
				if err := en.checkSpawnCmdline(*cwd, string(b), subEnv, depth+1); err != nil {
					_, _ = stderrBuf.Write([]byte(err.Error() + "\n"))
					exitCode = 126
					break
				}
				subCWD := *cwd
				outB, errB, code, sig, eStr := en.evalPOSIXShellWithMax(ctx, string(b), subCWD, subEnv, execStdin, maxBuf, depth+1)
				_, _ = stdoutBuf.Write(outB)
				_, _ = stderrBuf.Write(errB)
				exitCode = code
				sigStr = sig
				errStr = eStr
				break
			}
			if kind == "js" {
				jsArgs := append([]string{"--js", resolvedProg}, args...)
				cmd := exec.CommandContext(ctx, en.execPath, jsArgs...)
				cmd.Dir = *cwd
				en.enforceChildEnvMap(cmdEnv)
				cmd.Env = envMapToSlice(cmdEnv)
				outB, errB, code, sig, eStr := en.runBoundedExecCmd(ctx, cmd, execStdin, sc.stderrTo1, maxBuf)
				_, _ = stdoutBuf.Write(outB)
				_, _ = stderrBuf.Write(errB)
				exitCode = code
				sigStr = sig
				errStr = eStr
				break
			}
			_, _ = stderrBuf.Write([]byte(fmt.Sprintf("EACCES: jailed: executing native binary %q is not allowed in sandbox\n", prog)))
			exitCode = 126
			break
		}
		execProg := prog
		execArgs := args
		if lp, lerr := lookPathWithEnv(prog, *cwd, envMapToSlice(cmdEnv)); lerr == nil {
			execProg = lp
		}
		if en.execPath != "" && (prog == en.execPath || strings.EqualFold(filepath.Clean(execProg), filepath.Clean(en.execPath))) {
			if len(execArgs) > 0 && execArgs[0] != "--js" && execArgs[0] != "--worker" && execArgs[0] != "--runner" && execArgs[0] != "--runner-command" && execArgs[0] != "--update-start" && execArgs[0] != "--update-end" && execArgs[0] != "--slot" && !strings.HasPrefix(execArgs[0], "-test.") {
				execArgs = append([]string{"--js"}, execArgs...)
			}
		}
		cmd := exec.CommandContext(ctx, execProg, execArgs...)
		cmd.Dir = *cwd
		en.enforceChildEnvMap(cmdEnv)
		cmd.Env = envMapToSlice(cmdEnv)
		outB, errB, code, sig, eStr := en.runBoundedExecCmd(ctx, cmd, execStdin, sc.stderrTo1, maxBuf)
		_, _ = stdoutBuf.Write(outB)
		_, _ = stderrBuf.Write(errB)
		exitCode = code
		sigStr = sig
		errStr = eStr
	}
	}

	if stdoutBuf.Exceeded() || stderrBuf.Exceeded() {
		errStr = "ENOBUFS"
	}

	outBytes := stdoutBuf.Bytes()
	errBytes := stderrBuf.Bytes()
	if sc.stderrTo1 && len(errBytes) > 0 {
		outBytes = append(outBytes, errBytes...)
		if int64(len(outBytes)) > maxBuf {
			outBytes = outBytes[:maxBuf]
			errStr = "ENOBUFS"
		}
		errBytes = nil
	}
	if sc.stdoutTo2 && len(outBytes) > 0 {
		errBytes = append(errBytes, outBytes...)
		if int64(len(errBytes)) > maxBuf {
			errBytes = errBytes[:maxBuf]
			errStr = "ENOBUFS"
		}
		outBytes = nil
	}
	if sc.stdoutFile != "" {
		rawOut := expandShellVars(sc.stdoutFile, cmdEnv)
		if isNullDevicePath(rawOut) {
			outBytes = nil
		} else {
			p := joinCWDPath(*cwd, rawOut)
			if err := en.checkWritePath(p); err != nil {
				errBytes = append(errBytes, []byte(err.Error()+"\n")...)
				exitCode = 1
			} else {
				flags := os.O_WRONLY | os.O_CREATE | os.O_TRUNC
				if sc.stdoutApp {
					flags = os.O_WRONLY | os.O_CREATE | os.O_APPEND
				}
				if f, err := os.OpenFile(p, flags, 0o666); err == nil {
					_, _ = f.Write(outBytes)
					_ = f.Close()
					outBytes = nil
				} else {
					errBytes = append(errBytes, []byte(err.Error()+"\n")...)
					exitCode = 1
				}
			}
		}
	}
	if sc.stderrFile != "" {
		rawErr := expandShellVars(sc.stderrFile, cmdEnv)
		if isNullDevicePath(rawErr) {
			errBytes = nil
		} else {
			p := joinCWDPath(*cwd, rawErr)
			if err := en.checkWritePath(p); err != nil {
				errBytes = append(errBytes, []byte(err.Error()+"\n")...)
				exitCode = 1
			} else {
				flags := os.O_WRONLY | os.O_CREATE | os.O_TRUNC
				if sc.stderrApp {
					flags = os.O_WRONLY | os.O_CREATE | os.O_APPEND
				}
				if f, err := os.OpenFile(p, flags, 0o666); err == nil {
					_, _ = f.Write(errBytes)
					_ = f.Close()
					errBytes = nil
				}
			}
		}
	}

	env["?"] = strconv.Itoa(exitCode)
	return outBytes, errBytes, exitCode, sigStr, errStr, flowCtrl
}

func (en *rtEntry) evalPOSIXShell(ctx context.Context, cmdline string, cwd string, env map[string]string, stdinData []byte) ([]byte, []byte, int, *string, string) {
	return en.evalPOSIXShellWithMax(ctx, cmdline, cwd, env, stdinData, maxHostBufferBytes, 0)
}

func (en *rtEntry) evalPOSIXShellWithMax(ctx context.Context, cmdline string, cwd string, env map[string]string, stdinData []byte, maxBuf int64, depth int) ([]byte, []byte, int, *string, string) {
	c := cwd
	outB, errB, code, sig, eStr, _ := en.evalPOSIXShellWithCWD(ctx, cmdline, &c, env, stdinData, maxBuf, depth)
	if trapCmd := env["\x00TRAP_EXIT"]; trapCmd != "" {
		delete(env, "\x00TRAP_EXIT")
		env["?"] = strconv.Itoa(code)
		tOut, tErr, tCode, _, _, tFlow := en.evalPOSIXShellWithCWD(ctx, trapCmd, &c, env, nil, maxBuf, depth+1)
		outB = append(outB, tOut...)
		errB = append(errB, tErr...)
		if tFlow == "exit" {
			code = tCode
		}
	}
	return outB, errB, code, sig, eStr
}

func isStatementStartAt(tokens []posixToken, idx int) bool {
	if idx == 0 {
		return true
	}
	prev := tokens[idx-1]
	if prev.op == ";" || prev.op == "&&" || prev.op == "||" || prev.op == "|" || prev.op == ";;" {
		return true
	}
	if prev.op == "" {
		switch prev.word {
		case "if", "then", "elif", "else", "do", "while", "until", "{", "!":
			return true
		}
	}
	return false
}

func (en *rtEntry) evalPOSIXShellWithCWD(ctx context.Context, cmdline string, cwdPtr *string, env map[string]string, stdinData []byte, maxBuf int64, depth int) ([]byte, []byte, int, *string, string, string) {
	if maxBuf <= 0 || maxBuf > maxHostBufferBytes {
		maxBuf = maxHostBufferBytes
	}
	tokens, err := tokenizePOSIXShell(cmdline)
	if err != nil {
		return nil, []byte(err.Error() + "\n"), 2, nil, "", ""
	}
	if stdinData != nil {
		prevStdin, hadPrevStdin := env["\x00STDIN"]
		env["\x00STDIN"] = string(stdinData)
		stdinData = nil
		defer func() {
			if hadPrevStdin {
				env["\x00STDIN"] = prevStdin
			} else {
				delete(env, "\x00STDIN")
			}
		}()
	}
	allStdout := &boundedBufferWriter{max: maxBuf}
	allStderr := &boundedBufferWriter{max: maxBuf}
	lastCode := 0
	if prevQ, ok := env["?"]; ok {
		if n, err := strconv.Atoi(prevQ); err == nil {
			lastCode = n
		}
	} else {
		env["?"] = "0"
	}
	var lastSig *string
	var lastErr string

	parseRedirections := func(sc *posixSimpleCmd, idx *int) {
		for *idx < len(tokens) {
			op := tokens[*idx].op
			if op == ">" || op == ">>" || op == "<" || op == "<<<" || op == "2>" || op == "2>>" || op == "&>" || op == "&>>" {
				*idx++
				if *idx < len(tokens) && tokens[*idx].op == "" {
					target := tokens[*idx].word
					*idx++
					switch op {
					case ">":
						sc.stdoutFile = target
						sc.stdoutApp = false
					case ">>":
						sc.stdoutFile = target
						sc.stdoutApp = true
					case "<":
						sc.stdinFile = target
					case "<<<":
						sc.hereString = target
						sc.hasHereString = true
					case "2>":
						sc.stderrFile = target
						sc.stderrApp = false
					case "2>>":
						sc.stderrFile = target
						sc.stderrApp = true
					case "&>":
						sc.stdoutFile = target
						sc.stdoutApp = false
						sc.stderrTo1 = true
					case "&>>":
						sc.stdoutFile = target
						sc.stdoutApp = true
						sc.stderrTo1 = true
					}
				}
				continue
			}
			if op == "<<" || op == "<<'" {
				sc.hereDoc = tokens[*idx].word
				sc.hasHereDoc = true
				sc.hereDocLiteral = (op == "<<'")
				*idx++
				continue
			}
			if op == "2>&1" {
				sc.stderrTo1 = true
				*idx++
				continue
			}
			if op == "1>&2" {
				sc.stdoutTo2 = true
				*idx++
				continue
			}
			break
		}
	}

	i := 0
	nextCond := ""
	for i < len(tokens) {
		for i < len(tokens) && tokens[i].op == ";" {
			i++
		}
		if i >= len(tokens) {
			break
		}
		negatePipe := false
		for i < len(tokens) && tokens[i].op == "" && tokens[i].word == "!" {
			negatePipe = !negatePipe
			i++
		}
		var pipeCmds []posixSimpleCmd
		for i < len(tokens) {
			sc := posixSimpleCmd{envAssigns: make(map[string]string)}
			if tokens[i].op == "subshell" {
				sc.isSubshell = true
				sc.subshellCmd = tokens[i].word
				i++
				parseRedirections(&sc, &i)
			} else if tokens[i].op == "" && tokens[i].word == "{" {
				sc.isBraceGroup = true
				i++
				braceDepth := 1
				var bodyToks []posixToken
				for i < len(tokens) && braceDepth > 0 {
					t := tokens[i]
					if t.op == "" && isStatementStartAt(tokens, i) {
						if t.word == "{" {
							braceDepth++
						} else if t.word == "}" {
							braceDepth--
							if braceDepth == 0 {
								i++
								break
							}
						}
					}
					bodyToks = append(bodyToks, t)
					i++
				}
				sc.braceBody = bodyToks
				parseRedirections(&sc, &i)
			} else if tokens[i].op == "" && (tokens[i].word == "function" ||
				(strings.HasSuffix(tokens[i].word, "()") && isEnvVarIdent(strings.TrimSuffix(tokens[i].word, "()"))) ||
				(isEnvVarIdent(tokens[i].word) && i+1 < len(tokens) && tokens[i+1].op == "subshell" && strings.TrimSpace(tokens[i+1].word) == "")) {
				fnName := ""
				if tokens[i].word == "function" {
					i++
					if i < len(tokens) && tokens[i].op == "" {
						fnName = strings.TrimSuffix(tokens[i].word, "()")
						i++
					}
					if i < len(tokens) && tokens[i].op == "subshell" && strings.TrimSpace(tokens[i].word) == "" {
						i++
					}
				} else if strings.HasSuffix(tokens[i].word, "()") {
					fnName = strings.TrimSuffix(tokens[i].word, "()")
					i++
				} else {
					fnName = tokens[i].word
					i += 2
				}
				for i < len(tokens) && tokens[i].op == ";" {
					i++
				}
				sc.funcName = fnName
				if i < len(tokens) && tokens[i].op == "" && tokens[i].word == "{" {
					i++
					braceDepth := 1
					var bodyToks []posixToken
					for i < len(tokens) && braceDepth > 0 {
						t := tokens[i]
						if t.op == "" && isStatementStartAt(tokens, i) {
							if t.word == "{" {
								braceDepth++
							} else if t.word == "}" {
								braceDepth--
								if braceDepth == 0 {
									i++
									break
								}
							}
						}
						bodyToks = append(bodyToks, t)
						i++
					}
					sc.funcBody = joinPOSIXTokens(bodyToks)
				} else if i < len(tokens) && tokens[i].op == "subshell" {
					sc.funcBody = "(" + tokens[i].word + ")"
					i++
				}
				parseRedirections(&sc, &i)
			} else if tokens[i].op == "" && tokens[i].word == "if" {
				sc.isIf = true
				i++
				ifDepth := 1
				var branchCondToks []posixToken
				var branchBodyToks []posixToken
				state := "cond"
				for i < len(tokens) && ifDepth > 0 {
					t := tokens[i]
					if t.op == "" && isStatementStartAt(tokens, i) {
						if t.word == "if" {
							ifDepth++
						} else if t.word == "fi" {
							ifDepth--
							if ifDepth == 0 {
								i++
								if state == "body" {
									sc.ifBranches = append(sc.ifBranches, posixIfBranch{
										cond: branchCondToks,
										body: branchBodyToks,
									})
								} else if state == "else" {
									sc.elseTokens = branchBodyToks
								}
								break
							}
						} else if ifDepth == 1 {
							if t.word == "then" && state == "cond" {
								state = "body"
								i++
								if i < len(tokens) && tokens[i].op == ";" {
									i++
								}
								continue
							}
							if t.word == "elif" && state == "body" {
								sc.ifBranches = append(sc.ifBranches, posixIfBranch{
									cond: branchCondToks,
									body: branchBodyToks,
								})
								branchCondToks = nil
								branchBodyToks = nil
								state = "cond"
								i++
								continue
							}
							if t.word == "else" && state == "body" {
								sc.ifBranches = append(sc.ifBranches, posixIfBranch{
									cond: branchCondToks,
									body: branchBodyToks,
								})
								branchCondToks = nil
								branchBodyToks = nil
								state = "else"
								i++
								if i < len(tokens) && tokens[i].op == ";" {
									i++
								}
								continue
							}
						}
					}
					if state == "cond" {
						branchCondToks = append(branchCondToks, t)
					} else {
						branchBodyToks = append(branchBodyToks, t)
					}
					i++
				}
				parseRedirections(&sc, &i)
			} else if tokens[i].op == "" && tokens[i].word == "for" && i+1 < len(tokens) && tokens[i+1].op == "" {
				sc.forVar = tokens[i+1].word
				i += 2
				if i < len(tokens) && tokens[i].op == "" && tokens[i].word == "in" {
					sc.hasForIn = true
					i++
					for i < len(tokens) {
						if tokens[i].op == ";" {
							i++
							break
						}
						if tokens[i].op == "" && tokens[i].word == "do" {
							break
						}
						if tokens[i].op == "" {
							sc.forWords = append(sc.forWords, tokens[i].word)
						}
						i++
					}
				} else if i < len(tokens) && tokens[i].op == ";" {
					i++
				}
				if i < len(tokens) && tokens[i].op == "" && tokens[i].word == "do" {
					i++
					if i < len(tokens) && tokens[i].op == ";" {
						i++
					}
				}
				loopDepth := 1
				var bodyToks []posixToken
				for i < len(tokens) && loopDepth > 0 {
					t := tokens[i]
					if t.op == "" && isStatementStartAt(tokens, i) {
						if t.word == "for" || t.word == "while" || t.word == "until" {
							loopDepth++
						} else if t.word == "done" {
							loopDepth--
							if loopDepth == 0 {
								i++
								break
							}
						}
					}
					bodyToks = append(bodyToks, t)
					i++
				}
				sc.loopBody = bodyToks
				parseRedirections(&sc, &i)
			} else if tokens[i].op == "" && (tokens[i].word == "while" || tokens[i].word == "until") {
				if tokens[i].word == "while" {
					sc.isWhile = true
				} else {
					sc.isUntil = true
				}
				i++
				loopDepth := 1
				var condToks []posixToken
				var bodyToks []posixToken
				inCond := true
				for i < len(tokens) && loopDepth > 0 {
					t := tokens[i]
					if t.op == "" && isStatementStartAt(tokens, i) {
						if inCond && t.word == "do" && loopDepth == 1 {
							inCond = false
							i++
							if i < len(tokens) && tokens[i].op == ";" {
								i++
							}
							continue
						}
						if !inCond {
							if t.word == "for" || t.word == "while" || t.word == "until" {
								loopDepth++
							} else if t.word == "done" {
								loopDepth--
								if loopDepth == 0 {
									i++
									break
								}
							}
						}
					}
					if inCond {
						condToks = append(condToks, t)
					} else {
						bodyToks = append(bodyToks, t)
					}
					i++
				}
				sc.whileCond = condToks
				sc.loopBody = bodyToks
				parseRedirections(&sc, &i)
			} else if tokens[i].op == "" && tokens[i].word == "case" && i+1 < len(tokens) && tokens[i+1].op == "" {
				sc.isCase = true
				sc.caseWord = tokens[i+1].word
				i += 2
				for i < len(tokens) && tokens[i].op == ";" {
					i++
				}
				if i < len(tokens) && tokens[i].op == "" && tokens[i].word == "in" {
					i++
				}
				for i < len(tokens) {
					for i < len(tokens) && tokens[i].op == ";" {
						i++
					}
					if i >= len(tokens) {
						break
					}
					if tokens[i].op == "" && tokens[i].word == "esac" {
						i++
						break
					}
					var patterns []string
					for i < len(tokens) {
						if tokens[i].op == "|" {
							i++
							continue
						}
						if tokens[i].op == "subshell" {
							for _, part := range strings.Split(tokens[i].word, "|") {
								part = strings.TrimSpace(part)
								if part != "" {
									patterns = append(patterns, part)
								}
							}
							i++
							break
						}
						if tokens[i].op == ")" {
							i++
							break
						}
						if tokens[i].op == "" {
							w := tokens[i].word
							if strings.HasPrefix(w, "(") {
								w = w[1:]
							}
							if strings.HasSuffix(w, ")") {
								pat := w[:len(w)-1]
								if pat != "" {
									patterns = append(patterns, pat)
								}
								i++
								break
							}
							if w != "" {
								patterns = append(patterns, w)
							}
							i++
							continue
						}
						break
					}
					var armToks []posixToken
					caseDepth := 1
					for i < len(tokens) && caseDepth > 0 {
						t := tokens[i]
						if t.op == "" && isStatementStartAt(tokens, i) {
							if t.word == "case" {
								caseDepth++
							} else if t.word == "esac" {
								caseDepth--
								if caseDepth == 0 {
									break
								}
							}
						}
						if caseDepth == 1 && t.op == ";;" {
							i++
							break
						}
						armToks = append(armToks, t)
						i++
					}
					if len(patterns) > 0 {
						sc.caseItems = append(sc.caseItems, posixCaseItem{
							patterns: patterns,
							body:     armToks,
						})
					}
				}
				parseRedirections(&sc, &i)
			} else {
				for i < len(tokens) {
					if tokens[i].op == "" {
						w := tokens[i].word
						if len(sc.argv) == 0 {
							if idx := strings.IndexByte(w, '='); idx > 0 && isEnvVarIdent(w[:idx]) {
								sc.envAssigns[w[:idx]] = w[idx+1:]
								i++
								continue
							}
						}
						sc.argv = append(sc.argv, w)
						i++
						continue
					}
					prevI := i
					parseRedirections(&sc, &i)
					if i > prevI {
						continue
					}
					break
				}
			}
			pipeCmds = append(pipeCmds, sc)
			if i < len(tokens) && tokens[i].op == "|" {
				i++
				continue
			}
			break
		}
		condAfter := ""
		if i < len(tokens) {
			if tokens[i].op == ";" || tokens[i].op == "&&" || tokens[i].op == "||" {
				condAfter = tokens[i].op
				i++
			} else {
				tokName := tokens[i].op
				if tokName == "" {
					tokName = tokens[i].word
				}
				_, _ = allStderr.Write([]byte(fmt.Sprintf("sh: syntax error near unexpected token `%s'\n", tokName)))
				lastCode = 2
				env["?"] = "2"
				return allStdout.Bytes(), allStderr.Bytes(), lastCode, lastSig, lastErr, ""
			}
		}

		shouldRun := true
		if nextCond == "&&" && lastCode != 0 {
			shouldRun = false
		} else if nextCond == "||" && lastCode == 0 {
			shouldRun = false
		}
		nextCond = condAfter
		if !shouldRun || len(pipeCmds) == 0 {
			continue
		}

		var curIn []byte
		pipeFailCode := 0
		var flowOut string
		for pIdx, sc := range pipeCmds {
			var cmdEnv map[string]string
			var cmdCWDPtr *string
			if len(pipeCmds) > 1 {
				cmdEnv = make(map[string]string, len(env))
				for k, v := range env {
					cmdEnv[k] = v
				}
				if pIdx > 0 {
					delete(cmdEnv, "\x00STDIN")
				}
				cCopy := *cwdPtr
				cmdCWDPtr = &cCopy
			} else {
				cmdEnv = env
				cmdCWDPtr = cwdPtr
			}
			outB, errB, code, sig, eStr, flowCtrl := en.evalPOSIXSimpleCmd(ctx, sc, cmdCWDPtr, cmdEnv, curIn, maxBuf, depth)
			_, _ = allStderr.Write(errB)
			if code != 0 {
				pipeFailCode = code
			}
			lastCode = code
			env["?"] = strconv.Itoa(lastCode)
			if sig != nil {
				lastSig = sig
			}
			if eStr != "" {
				lastErr = eStr
			}
			if pIdx+1 < len(pipeCmds) {
				if outB == nil {
					curIn = []byte{}
				} else {
					curIn = outB
				}
			} else {
				_, _ = allStdout.Write(outB)
			}
			if allStdout.Exceeded() || allStderr.Exceeded() || lastErr == "ENOBUFS" {
				lastErr = "ENOBUFS"
				return allStdout.Bytes(), allStderr.Bytes(), lastCode, lastSig, lastErr, flowCtrl
			}
			if flowCtrl != "" {
				flowOut = flowCtrl
				break
			}
		}
		if len(pipeCmds) > 1 && env["\x00OPT_PIPEFAIL"] == "1" && pipeFailCode != 0 {
			lastCode = pipeFailCode
			env["?"] = strconv.Itoa(lastCode)
		}
		if negatePipe {
			if lastCode == 0 {
				lastCode = 1
			} else {
				lastCode = 0
			}
			env["?"] = strconv.Itoa(lastCode)
		}
		if flowOut != "" {
			return allStdout.Bytes(), allStderr.Bytes(), lastCode, lastSig, lastErr, flowOut
		}
		if env["\x00OPT_E"] == "1" && lastCode != 0 && !negatePipe && condAfter != "&&" && condAfter != "||" && env["\x00IN_COND"] != "1" {
			return allStdout.Bytes(), allStderr.Bytes(), lastCode, lastSig, lastErr, "exit"
		}
		if ctx.Err() != nil {
			break
		}
	}
	return allStdout.Bytes(), allStderr.Bytes(), lastCode, lastSig, lastErr, ""
}

func isEnvVarIdent(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if i == 0 && c >= '0' && c <= '9' {
			return false
		}
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_') {
			return false
		}
	}
	return true
}

func extractExitStatusAndSignal(ee *exec.ExitError) (*int, *string) {
	if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		s := signalNameFromNumber(int(ws.Signal()))
		return nil, &s
	}
	code := ee.ExitCode()
	if code < 0 {
		s := "SIGTERM"
		return nil, &s
	}
	return &code, nil
}

func (en *rtEntry) opCPSpawnSync(argsStr string, stdinBytes []byte) (string, []byte, bool, string, error) {
	var req cpSpawnReq
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}

	inMode := stdioModeAt(req.Stdio, 0)
	if inMode == "inherit" && len(stdinBytes) == 0 {
		waitMode := ""
		if requiresStdinWait(req) {
			waitMode = "eof"
		}
		_, stdinBytes, _, _, _ = en.opProcessStdinRead(waitMode)
	}

	cwd := en.getCWD()
	if req.CWD != "" {
		cwd = en.resolvePath(req.CWD)
	}
	if err := en.checkPath(cwd); err != nil {
		return "", nil, false, "EACCES", err
	}
	if err := en.checkSpawnReqPaths(cwd, req, stdinBytes); err != nil {
		return "", nil, false, "EACCES", err
	}

	maxBuf := req.MaxBuffer
	if maxBuf <= 0 || maxBuf > maxHostBufferBytes {
		maxBuf = maxHostBufferBytes
	}

	cmdCtx := en.ctx
	var cancel context.CancelFunc
	if req.TimeoutMs > 0 {
		cmdCtx, cancel = context.WithTimeout(en.ctx, time.Duration(req.TimeoutMs)*time.Millisecond)
		defer cancel()
	}

	outMode := stdioModeAt(req.Stdio, 1)
	errMode := stdioModeAt(req.Stdio, 2)

	envMap := en.resolveSpawnEnv(req)
	if info, serr := os.Stat(cwd); serr != nil || !info.IsDir() {
		errCode := "ENOENT"
		if errors.Is(serr, os.ErrPermission) {
			errCode = "EACCES"
		}
		res, _ := json.Marshal(map[string]any{
			"pid":        0,
			"status":     nil,
			"signal":     nil,
			"error":      fmt.Sprintf("spawnSync %s %s", req.Command, errCode),
			"errorCode":  errCode,
			"syscall":    "spawnSync " + req.Command,
			"path":       req.Command,
			"stdoutNull": true,
			"stderrNull": true,
		})
		return string(res), nil, true, "", nil
	}
	killSigName := resolveKillSignalName(req.KillSignal)
	if isDollarShellFallback(en, req) {
		cmdline := extractFallbackCmdline(req)
		stdoutBytes, stderrBytes, code, sigStr, errStr := en.evalPOSIXShellWithMax(cmdCtx, cmdline, cwd, envMap, stdinBytes, maxBuf, 0)
		var errCode string
		if errStr == "ENOBUFS" || int64(len(stdoutBytes)) > maxBuf || int64(len(stderrBytes)) > maxBuf {
			if int64(len(stdoutBytes)) > maxBuf {
				stdoutBytes = stdoutBytes[:maxBuf]
			}
			if int64(len(stderrBytes)) > maxBuf {
				stderrBytes = stderrBytes[:maxBuf]
			}
			errStr = fmt.Sprintf("spawnSync %s ENOBUFS", req.Command)
			errCode = "ENOBUFS"
			s := killSigName
			sigStr = &s
		} else if errStr == "ETIMEDOUT" || (sigStr != nil && *sigStr == "SIGTERM" && cmdCtx.Err() != nil) {
			s := killSigName
			sigStr = &s
			if errStr == "ETIMEDOUT" || cmdCtx.Err() == context.DeadlineExceeded {
				errStr = fmt.Sprintf("spawnSync %s ETIMEDOUT", req.Command)
				errCode = "ETIMEDOUT"
			}
		}
		if outMode == "ignore" {
			stdoutBytes = nil
		} else if outMode == "inherit" {
			en.writeMu.Lock()
			_, _ = en.stdout.Write(stdoutBytes)
			en.writeMu.Unlock()
			stdoutBytes = nil
		}
		if errMode == "ignore" {
			stderrBytes = nil
		} else if errMode == "inherit" {
			en.writeMu.Lock()
			_, _ = en.stderr.Write(stderrBytes)
			en.writeMu.Unlock()
			stderrBytes = nil
		}
		combined := make([]byte, len(stdoutBytes)+len(stderrBytes))
		copy(combined, stdoutBytes)
		copy(combined[len(stdoutBytes):], stderrBytes)
		var status *int
		if sigStr == nil {
			status = &code
		}
		meta := map[string]any{
			"pid":        1_500_000_000 + int(en.nextReq.Add(1)),
			"status":     status,
			"signal":     sigStr,
			"stdoutLen":  len(stdoutBytes),
			"stderrLen":  len(stderrBytes),
			"stdoutNull": outMode != "pipe",
			"stderrNull": errMode != "pipe",
		}
		if errStr != "" {
			meta["error"] = errStr
			if errCode != "" {
				meta["errorCode"] = errCode
				meta["syscall"] = "spawnSync " + req.Command
				meta["path"] = req.Command
			}
		}
		resJSON, _ := json.Marshal(meta)
		return string(resJSON), combined, true, "", nil
	}

	cmd := en.buildExecCmd(cmdCtx, req, cwd, envMapToSlice(envMap))
	if stdioModeAt(req.Stdio, 0) != "ignore" && len(stdinBytes) > 0 {
		cmd.Stdin = bytes.NewReader(stdinBytes)
	}
	var killOnce sync.Once
	killChild := func() {
		killOnce.Do(func() {
			if cmd.Process != nil {
				killProcessTree(cmd.Process.Pid)
			}
		})
	}
	stdoutBuf := &boundedBufferWriter{max: maxBuf, onExceed: killChild}
	stderrBuf := &boundedBufferWriter{max: maxBuf, onExceed: killChild}
	switch outMode {
	case "ignore":
		cmd.Stdout = io.Discard
	case "inherit":
		cmd.Stdout = en.stdout
	default:
		cmd.Stdout = stdoutBuf
	}
	switch errMode {
	case "ignore":
		cmd.Stderr = io.Discard
	case "inherit":
		cmd.Stderr = en.stderr
	default:
		cmd.Stderr = stderrBuf
	}

	err := cmd.Start()
	if err != nil {
		errCode := "ENOENT"
		if errors.Is(err, os.ErrPermission) {
			errCode = "EACCES"
		}
		res, _ := json.Marshal(map[string]any{
			"pid":        0,
			"status":     nil,
			"signal":     nil,
			"error":      fmt.Sprintf("spawnSync %s %s", req.Command, errCode),
			"errorCode":  errCode,
			"syscall":    "spawnSync " + req.Command,
			"path":       req.Command,
			"stdoutNull": true,
			"stderrNull": true,
		})
		return string(res), nil, true, "", nil
	}
	pid := cmd.Process.Pid
	stopKill := context.AfterFunc(cmdCtx, killChild)
	waitErr := cmd.Wait()
	stopKill()

	var (
		status  *int
		sigStr  *string
		errStr  string
		errCode string
	)
	if stdoutBuf.Exceeded() || stderrBuf.Exceeded() {
		killChild()
		errStr = fmt.Sprintf("spawnSync %s ENOBUFS", req.Command)
		errCode = "ENOBUFS"
		status = nil
		s := killSigName
		sigStr = &s
	} else if cmdCtx.Err() != nil {
		killProcessTree(pid)
		s := killSigName
		sigStr = &s
		if cmdCtx.Err() == context.DeadlineExceeded {
			errStr = fmt.Sprintf("spawnSync %s ETIMEDOUT", req.Command)
			errCode = "ETIMEDOUT"
		} else {
			errStr = cmdCtx.Err().Error()
		}
	} else if waitErr == nil {
		zero := 0
		status = &zero
	} else {
		var ee *exec.ExitError
		if errors.As(waitErr, &ee) {
			status, sigStr = extractExitStatusAndSignal(ee)
		} else {
			errStr = waitErr.Error()
		}
	}

	stdoutBytes := stdoutBuf.Bytes()
	stderrBytes := stderrBuf.Bytes()
	combined := make([]byte, len(stdoutBytes)+len(stderrBytes))
	copy(combined, stdoutBytes)
	copy(combined[len(stdoutBytes):], stderrBytes)

	meta := map[string]any{
		"pid":        pid,
		"status":     status,
		"signal":     sigStr,
		"stdoutLen":  len(stdoutBytes),
		"stderrLen":  len(stderrBytes),
		"stdoutNull": outMode != "pipe",
		"stderrNull": errMode != "pipe",
	}
	if errStr != "" {
		meta["error"] = errStr
		if errCode != "" {
			meta["errorCode"] = errCode
			meta["syscall"] = "spawnSync " + req.Command
			meta["path"] = req.Command
		}
	}
	resJSON, _ := json.Marshal(meta)
	return string(resJSON), combined, true, "", nil
}

type asyncByteWriter struct {
	writeFn   func([]byte) (int, error)
	closeFn   func() error
	abortFn   func()
	onDrain   func()
	done      chan struct{}
	mu        sync.Mutex
	cond      *sync.Cond
	queue     [][]byte
	queuedSz  int64
	needDrain bool
	closing   bool
	aborted   bool
	err       error
}

func newAsyncByteWriter(w io.WriteCloser, abortFn func()) *asyncByteWriter {
	if w == nil {
		return nil
	}
	aw := &asyncByteWriter{
		writeFn: w.Write,
		closeFn: w.Close,
		abortFn: abortFn,
		done:    make(chan struct{}),
	}
	aw.cond = sync.NewCond(&aw.mu)
	go aw.loop()
	return aw
}

func newCustomAsyncByteWriter(writeFn func([]byte) (int, error), closeFn func() error, abortFn func()) *asyncByteWriter {
	aw := &asyncByteWriter{
		writeFn: writeFn,
		closeFn: closeFn,
		abortFn: abortFn,
		done:    make(chan struct{}),
	}
	aw.cond = sync.NewCond(&aw.mu)
	go aw.loop()
	return aw
}

func (aw *asyncByteWriter) loop() {
	defer close(aw.done)
	for {
		aw.mu.Lock()
		for len(aw.queue) == 0 && !aw.closing && !aw.aborted {
			aw.cond.Wait()
		}
		if aw.aborted {
			aw.mu.Unlock()
			if aw.closeFn != nil {
				_ = aw.closeFn()
			}
			return
		}
		if len(aw.queue) == 0 && aw.closing {
			aw.mu.Unlock()
			if aw.closeFn != nil {
				_ = aw.closeFn()
			}
			return
		}
		chunk := aw.queue[0]
		aw.queue[0] = nil
		aw.queue = aw.queue[1:]
		aw.mu.Unlock()

		var werr error
		if aw.writeFn != nil && len(chunk) > 0 {
			_, werr = aw.writeFn(chunk)
		}

		aw.mu.Lock()
		aw.queuedSz -= int64(len(chunk))
		if aw.queuedSz < 0 {
			aw.queuedSz = 0
		}
		if werr != nil && aw.err == nil {
			aw.err = werr
			aw.queue = nil
			aw.queuedSz = 0
			aw.closing = true
		}
		fireDrain := false
		if aw.needDrain && aw.queuedSz < 64*1024 && len(aw.queue) == 0 && !aw.closing && !aw.aborted && aw.err == nil {
			aw.needDrain = false
			fireDrain = true
		}
		drainCb := aw.onDrain
		aw.cond.Broadcast()
		aw.mu.Unlock()
		if fireDrain && drainCb != nil {
			drainCb()
		}
	}
}

func (aw *asyncByteWriter) Enqueue(data []byte) (bool, error) {
	if aw == nil {
		return true, nil
	}
	aw.mu.Lock()
	defer aw.mu.Unlock()
	for aw.queuedSz >= 16*1024*1024 && !aw.aborted && !aw.closing && aw.err == nil {
		aw.cond.Wait()
	}
	if aw.aborted || aw.closing {
		return false, fmt.Errorf("EPIPE: write after end")
	}
	if aw.err != nil {
		return false, aw.err
	}
	if len(data) > 0 {
		cp := make([]byte, len(data))
		copy(cp, data)
		aw.queue = append(aw.queue, cp)
		aw.queuedSz += int64(len(cp))
		aw.cond.Signal()
	}
	if aw.queuedSz >= 64*1024 {
		aw.needDrain = true
		return false, nil
	}
	return true, nil
}

func (aw *asyncByteWriter) EnqueueClose() {
	if aw == nil {
		return
	}
	aw.mu.Lock()
	aw.closing = true
	aw.cond.Broadcast()
	aw.mu.Unlock()
}

func (aw *asyncByteWriter) Abort() {
	if aw == nil {
		return
	}
	aw.mu.Lock()
	wasAborted := aw.aborted
	aw.aborted = true
	aw.queue = nil
	aw.queuedSz = 0
	aw.cond.Broadcast()
	aw.mu.Unlock()
	if !wasAborted {
		if aw.abortFn != nil {
			aw.abortFn()
		}
		if aw.closeFn != nil {
			_ = aw.closeFn()
		}
	}
}

func (en *rtEntry) opCPSpawnAsync(argsStr string, stdinBytes []byte) (string, []byte, bool, string, error) {
	var req cpSpawnReq
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}

	cwd := en.getCWD()
	if req.CWD != "" {
		cwd = en.resolvePath(req.CWD)
	}
	if err := en.checkPath(cwd); err != nil {
		return "", nil, false, "EACCES", err
	}
	if err := en.checkSpawnReqPaths(cwd, req, stdinBytes); err != nil {
		return "", nil, false, "EACCES", err
	}

	maxBuf := req.MaxBuffer
	if maxBuf <= 0 || maxBuf > maxHostBufferBytes {
		maxBuf = maxHostBufferBytes
	}

	baseCtx := en.ctx
	if en.parentCtx != nil {
		baseCtx = en.parentCtx
	}
	var (
		cmdCtx context.Context
		cancel context.CancelFunc
	)
	if req.TimeoutMs > 0 {
		cmdCtx, cancel = context.WithTimeout(baseCtx, time.Duration(req.TimeoutMs)*time.Millisecond)
	} else {
		cmdCtx, cancel = context.WithCancel(baseCtx)
	}

	envMap := en.resolveSpawnEnv(req)
	if info, serr := os.Stat(cwd); serr != nil || !info.IsDir() {
		cancel()
		errCode := "ENOENT"
		if errors.Is(serr, os.ErrPermission) {
			errCode = "EACCES"
		}
		meta, _ := json.Marshal(map[string]any{
			"pid":       0,
			"error":     fmt.Sprintf("spawn %s %s", req.Command, errCode),
			"errorCode": errCode,
			"syscall":   "spawn " + req.Command,
			"path":      req.Command,
		})
		return string(meta), nil, false, "", nil
	}
	if isDollarShellFallback(en, req) {
		id := req.ID
		inMode := stdioModeAt(req.Stdio, 0)
		outMode := stdioModeAt(req.Stdio, 1)
		errMode := stdioModeAt(req.Stdio, 2)
		var (
			stdinR      *io.PipeReader
			stdinW      *io.PipeWriter
			stdinWriter *asyncByteWriter
		)
		if !req.HasInput && len(stdinBytes) == 0 && inMode == "pipe" {
			stdinR, stdinW = io.Pipe()
			stdinWriter = newAsyncByteWriter(stdinW, func() {
				_ = stdinR.Close()
				_ = stdinW.Close()
			})
			stdinWriter.onDrain = func() {
				en.pushEvent(rtAsyncEvent{id: id, kind: rtEventChildDrain})
			}
		}
		doneCh := make(chan struct{})
		childEntry := &rtChildProc{stdin: stdinWriter, cancel: cancel, detached: req.Detached, done: doneCh}
		en.childMu.Lock()
		en.children[id] = childEntry
		en.childMu.Unlock()
		inCopy := make([]byte, len(stdinBytes))
		copy(inCopy, stdinBytes)
		cmdline := extractFallbackCmdline(req)
		go func() {
			defer close(doneCh)
			if stdinR != nil {
				defer func() {
					_ = stdinR.Close()
					_ = stdinW.Close()
				}()
			}
			stopPipe := context.AfterFunc(cmdCtx, func() {
				if stdinR != nil {
					_ = stdinR.Close()
				}
				if stdinW != nil {
					_ = stdinW.Close()
				}
			})
			defer stopPipe()
			shellCtx := cmdCtx
			if stdinR != nil {
				if requiresStdinWait(req) {
					pipedIn, _ := readAllBounded(stdinR, maxBuf)
					_ = stdinR.Close()
					inCopy = pipedIn
				} else {
					shellCtx = context.WithValue(cmdCtx, shellStdinPipeCtxKey{}, &shellStdinPipeHolder{r: stdinR})
				}
			} else if inMode == "inherit" && len(inCopy) == 0 {
				waitMode := ""
				if requiresStdinWait(req) {
					waitMode = "eof"
				}
				_, inCopy, _, _, _ = en.opProcessStdinRead(waitMode)
				if en.hasSandboxRestrictions() && len(inCopy) > 0 && shellReadsScriptFromStdin(req) {
					if jerr := en.checkSpawnCmdline(cwd, string(inCopy), envMap, 0); jerr != nil {
						c126 := 126
						childEntry.mu.Lock()
						if req.Shell == "$" {
							childEntry.errBytes = []byte(jerr.Error() + "\n")
						}
						childEntry.finalCode = &c126
						childEntry.mu.Unlock()
						en.childMu.Lock()
						delete(en.children, id)
						if en.finishedChildren != nil && req.Shell == "$" {
							for k := range en.finishedChildren {
								if len(en.finishedChildren) < 8 {
									break
								}
								delete(en.finishedChildren, k)
							}
							en.finishedChildren[id] = childEntry
						}
						en.childMu.Unlock()
						cancel()
						if errMode == "inherit" {
							en.writeMu.Lock()
							_, _ = en.stderr.Write([]byte(jerr.Error() + "\n"))
							en.writeMu.Unlock()
						} else if errMode != "ignore" {
							en.pushEvent(rtAsyncEvent{id: id, kind: rtEventChildStderr, bin: []byte(jerr.Error() + "\n")})
						}
						meta, _ := json.Marshal(map[string]any{"code": 126, "signal": nil})
						en.pushEvent(rtAsyncEvent{id: id, kind: rtEventChildExit, json: string(meta)})
						return
					}
				}
			}
			stdoutBytes, stderrBytes, code, sigStr, _ := en.evalPOSIXShellWithMax(shellCtx, cmdline, cwd, envMap, inCopy, maxBuf, 0)
			en.childMu.Lock()
			ch := en.children[id]
			delete(en.children, id)
			if en.finishedChildren != nil && ch != nil && req.Shell == "$" {
				for k := range en.finishedChildren {
					if len(en.finishedChildren) < 8 {
						break
					}
					delete(en.finishedChildren, k)
				}
				en.finishedChildren[id] = ch
			}
			en.childMu.Unlock()
			cancel()
			var killedSig string
			if ch != nil {
				ch.mu.Lock()
				killedSig = ch.killedSignal
				ch.mu.Unlock()
			}
			var codeOut any = code
			if killedSig != "" {
				sigStr = &killedSig
				codeOut = nil
			} else if sigStr != nil && *sigStr == "SIGTERM" && cmdCtx.Err() != nil {
				s := resolveKillSignalName(req.KillSignal)
				sigStr = &s
				codeOut = nil
			}
			if ch != nil {
				ch.mu.Lock()
				if req.Shell == "$" {
					ch.outBytes = stdoutBytes
					ch.errBytes = stderrBytes
				}
				if cInt, ok := codeOut.(int); ok {
					ch.finalCode = &cInt
				}
				ch.finalSignal = sigStr
				ch.mu.Unlock()
			}
			if len(stdoutBytes) > 0 {
				if outMode == "inherit" {
					en.writeMu.Lock()
					_, _ = en.stdout.Write(stdoutBytes)
					en.writeMu.Unlock()
				} else if outMode != "ignore" {
					en.pushEvent(rtAsyncEvent{id: id, kind: rtEventChildStdout, bin: stdoutBytes})
				}
			}
			if len(stderrBytes) > 0 {
				if errMode == "inherit" {
					en.writeMu.Lock()
					_, _ = en.stderr.Write(stderrBytes)
					en.writeMu.Unlock()
				} else if errMode != "ignore" {
					en.pushEvent(rtAsyncEvent{id: id, kind: rtEventChildStderr, bin: stderrBytes})
				}
			}
			meta, _ := json.Marshal(map[string]any{
				"code":   codeOut,
				"signal": sigStr,
			})
			en.pushEvent(rtAsyncEvent{id: id, kind: rtEventChildExit, json: string(meta)})
		}()
		meta, _ := json.Marshal(map[string]any{"pid": 1_000_000_000 + int(id)})
		return string(meta), nil, false, "", nil
	}

	inMode := stdioModeAt(req.Stdio, 0)
	outMode := stdioModeAt(req.Stdio, 1)
	errMode := stdioModeAt(req.Stdio, 2)

	cmd := en.buildExecCmd(cmdCtx, req, cwd, envMapToSlice(envMap))
	var (
		stdinPipe  io.WriteCloser
		stdoutPipe io.ReadCloser
		stderrPipe io.ReadCloser
		err        error
	)
	if inMode == "inherit" && !req.HasInput && len(stdinBytes) == 0 {
		if f, ok := en.stdin.(*os.File); ok {
			cmd.Stdin = f
		} else {
			stdinPipe, err = cmd.StdinPipe()
			if err != nil {
				cancel()
				return "", nil, false, "EIO", err
			}
		}
	} else if inMode != "ignore" {
		stdinPipe, err = cmd.StdinPipe()
		if err != nil {
			cancel()
			return "", nil, false, "EIO", err
		}
	}
	if outMode == "inherit" && req.Shell != "$" {
		if f, ok := en.stdout.(*os.File); ok {
			cmd.Stdout = f
		} else {
			stdoutPipe, err = cmd.StdoutPipe()
			if err != nil {
				if stdinPipe != nil {
					_ = stdinPipe.Close()
				}
				cancel()
				return "", nil, false, "EIO", err
			}
		}
	} else if outMode != "ignore" {
		stdoutPipe, err = cmd.StdoutPipe()
		if err != nil {
			if stdinPipe != nil {
				_ = stdinPipe.Close()
			}
			cancel()
			return "", nil, false, "EIO", err
		}
	}
	if errMode == "inherit" && req.Shell != "$" {
		if f, ok := en.stderr.(*os.File); ok {
			cmd.Stderr = f
		} else {
			stderrPipe, err = cmd.StderrPipe()
			if err != nil {
				if stdinPipe != nil {
					_ = stdinPipe.Close()
				}
				if stdoutPipe != nil {
					_ = stdoutPipe.Close()
				}
				cancel()
				return "", nil, false, "EIO", err
			}
		}
	} else if errMode != "ignore" {
		stderrPipe, err = cmd.StderrPipe()
		if err != nil {
			if stdinPipe != nil {
				_ = stdinPipe.Close()
			}
			if stdoutPipe != nil {
				_ = stdoutPipe.Close()
			}
			cancel()
			return "", nil, false, "EIO", err
		}
	}

	if err := cmd.Start(); err != nil {
		if stdinPipe != nil {
			_ = stdinPipe.Close()
		}
		if stdoutPipe != nil {
			_ = stdoutPipe.Close()
		}
		if stderrPipe != nil {
			_ = stderrPipe.Close()
		}
		cancel()
		errCode := "ENOENT"
		if errors.Is(err, os.ErrPermission) {
			errCode = "EACCES"
		}
		meta, _ := json.Marshal(map[string]any{
			"pid":       0,
			"error":     fmt.Sprintf("spawn %s %s", req.Command, errCode),
			"errorCode": errCode,
			"syscall":   "spawn " + req.Command,
			"path":      req.Command,
		})
		return string(meta), nil, false, "", nil
	}

	var stdinWriter *asyncByteWriter
	if stdinPipe != nil {
		stdinWriter = newAsyncByteWriter(stdinPipe, func() {
			_ = stdinPipe.Close()
		})
	}

	pid := cmd.Process.Pid
	id := req.ID
	if stdinWriter != nil {
		stdinWriter.onDrain = func() {
			en.pushEvent(rtAsyncEvent{id: id, kind: rtEventChildDrain})
		}
	}
	outCredits := makeStreamCredits()
	errCredits := makeStreamCredits()
	doneCh := make(chan struct{})
	childEntry := &rtChildProc{
		cmd:        cmd,
		stdin:      stdinWriter,
		stdoutPipe: stdoutPipe,
		stderrPipe: stderrPipe,
		outCredits: outCredits,
		errCredits: errCredits,
		cancel:     cancel,
		detached:   req.Detached,
		done:       doneCh,
	}
	en.childMu.Lock()
	en.children[id] = childEntry
	en.childMu.Unlock()

	if inMode != "ignore" && (req.HasInput || len(stdinBytes) > 0) && stdinWriter != nil {
		if len(stdinBytes) > 0 {
			_, _ = stdinWriter.Enqueue(stdinBytes)
		}
		stdinWriter.EnqueueClose()
	} else if inMode == "inherit" && stdinWriter != nil {
		waitMode := ""
		if requiresStdinWait(req) {
			waitMode = "eof"
		}
		go func() {
			_, inherited, _, _, _ := en.opProcessStdinRead(waitMode)
			if len(inherited) > 0 {
				_, _ = stdinWriter.Enqueue(inherited)
			}
			stdinWriter.EnqueueClose()
		}()
	}

	var wg sync.WaitGroup
	pumpPipe := func(r io.Reader, kind int32, mode string, inheritOut io.Writer, credits chan struct{}, isStderr bool) {
		defer wg.Done()
		buf := make([]byte, 32*1024)
		var creditBytes int
		needCredit := true
		for {
			if mode != "inherit" && mode != "ignore" && credits != nil && needCredit {
				select {
				case <-credits:
					needCredit = false
				case <-cmdCtx.Done():
					return
				}
			}
			n, rerr := r.Read(buf)
			if n > 0 {
				creditBytes += n
				if creditBytes >= 4096 {
					creditBytes = 0
					needCredit = true
				}
				if mode == "inherit" {
					en.writeMu.Lock()
					_, _ = inheritOut.Write(buf[:n])
					en.writeMu.Unlock()
				} else if mode != "ignore" {
					chunk := make([]byte, n)
					copy(chunk, buf[:n])
					if req.Shell == "$" {
						childEntry.mu.Lock()
						syncWait := childEntry.syncWaiting
						if isStderr {
							if int64(len(childEntry.errBytes))+int64(len(chunk)) <= maxBuf {
								childEntry.errBytes = append(childEntry.errBytes, chunk...)
							}
						} else {
							if int64(len(childEntry.outBytes))+int64(len(chunk)) <= maxBuf {
								childEntry.outBytes = append(childEntry.outBytes, chunk...)
							}
						}
						childEntry.mu.Unlock()
						if syncWait {
							continue
						}
					}
					en.pushEvent(rtAsyncEvent{id: id, kind: kind, bin: chunk})
				}
			}
			if rerr != nil {
				return
			}
		}
	}
	if stdoutPipe != nil {
		wg.Add(1)
		go pumpPipe(stdoutPipe, rtEventChildStdout, outMode, en.stdout, outCredits, false)
	}
	if stderrPipe != nil {
		wg.Add(1)
		go pumpPipe(stderrPipe, rtEventChildStderr, errMode, en.stderr, errCredits, true)
	}

	stopAfter := context.AfterFunc(cmdCtx, func() {
		childEntry.mu.Lock()
		alreadyReaped := childEntry.reaped
		childEntry.mu.Unlock()
		if !alreadyReaped {
			killProcessTree(pid)
		}
		if stdinWriter != nil {
			stdinWriter.Abort()
		}
		if stdoutPipe != nil {
			_ = stdoutPipe.Close()
		}
		if stderrPipe != nil {
			_ = stderrPipe.Close()
		}
	})

	go func() {
		defer close(doneCh)
		wg.Wait()
		waitErr := cmd.Wait()
		childEntry.mu.Lock()
		childEntry.reaped = true
		childEntry.mu.Unlock()
		stopAfter()
		if stdinWriter != nil {
			stdinWriter.Abort()
		}
		ctxErr := cmdCtx.Err()
		en.childMu.Lock()
		ch := en.children[id]
		delete(en.children, id)
		if en.finishedChildren != nil && ch != nil && req.Shell == "$" {
			for k := range en.finishedChildren {
				if len(en.finishedChildren) < 8 {
					break
				}
				delete(en.finishedChildren, k)
			}
			en.finishedChildren[id] = ch
		}
		en.childMu.Unlock()
		cancel()

		var killedSig string
		if ch != nil {
			ch.mu.Lock()
			killedSig = ch.killedSignal
			ch.mu.Unlock()
		}

		var code any = 0
		var sigStr *string
		if killedSig != "" {
			sigStr = &killedSig
			code = nil
		} else if ctxErr != nil {
			killProcessTree(pid)
			s := resolveKillSignalName(req.KillSignal)
			sigStr = &s
			code = nil
		} else if waitErr != nil {
			var ee *exec.ExitError
			if errors.As(waitErr, &ee) {
				st, sig := extractExitStatusAndSignal(ee)
				if sig != nil {
					sigStr = sig
					code = nil
				} else if st != nil {
					code = *st
				} else {
					code = 1
				}
			} else {
				code = 1
			}
		}
		if ch != nil {
			ch.mu.Lock()
			if cInt, ok := code.(int); ok {
				ch.finalCode = &cInt
			}
			ch.finalSignal = sigStr
			ch.mu.Unlock()
		}
		meta, _ := json.Marshal(map[string]any{
			"code":   code,
			"signal": sigStr,
		})
		en.pushEvent(rtAsyncEvent{id: id, kind: rtEventChildExit, json: string(meta)})
	}()

	meta, _ := json.Marshal(map[string]any{"pid": pid})
	return string(meta), nil, false, "", nil
}

func (en *rtEntry) opCPWaitChild(argsStr string) (string, []byte, bool, string, error) {
	id64, err := strconv.ParseInt(strings.TrimSpace(argsStr), 10, 32)
	if err != nil {
		return "", nil, false, "EINVAL", err
	}
	id := int32(id64)
	en.childMu.Lock()
	ch := en.children[id]
	if ch == nil && en.finishedChildren != nil {
		ch = en.finishedChildren[id]
		delete(en.finishedChildren, id)
	}
	en.childMu.Unlock()
	if ch == nil || ch.done == nil {
		return `{"status":0,"signal":null,"stdoutLen":0,"stderrLen":0}`, nil, true, "", nil
	}
	ch.mu.Lock()
	ch.syncWaiting = true
	ch.mu.Unlock()
	en.discardChildStreamEvents(id)
	for {
		select {
		case <-ch.done:
			goto done
		case <-en.ctx.Done():
			goto done
		default:
			en.discardChildStreamEvents(id)
			if ch.outCredits != nil {
				select {
				case ch.outCredits <- struct{}{}:
				default:
				}
			}
			if ch.errCredits != nil {
				select {
				case ch.errCredits <- struct{}{}:
				default:
				}
			}
			select {
			case <-ch.done:
				goto done
			case <-en.ctx.Done():
				goto done
			case <-time.After(2 * time.Millisecond):
			}
		}
	}
done:
	ch.mu.Lock()
	stdoutBytes := ch.outBytes
	stderrBytes := ch.errBytes
	ch.outBytes = nil
	ch.errBytes = nil
	status := ch.finalCode
	sigStr := ch.finalSignal
	ch.mu.Unlock()

	combined := make([]byte, len(stdoutBytes)+len(stderrBytes))
	copy(combined, stdoutBytes)
	copy(combined[len(stdoutBytes):], stderrBytes)
	meta := map[string]any{
		"status":    status,
		"signal":    sigStr,
		"stdoutLen": len(stdoutBytes),
		"stderrLen": len(stderrBytes),
	}
	resJSON, _ := json.Marshal(meta)
	return string(resJSON), combined, true, "", nil
}

func (en *rtEntry) opCPWriteStdin(argsStr string, data []byte) (string, []byte, bool, string, error) {
	id64, err := strconv.ParseInt(strings.TrimSpace(argsStr), 10, 32)
	if err != nil {
		return "", nil, false, "EINVAL", err
	}
	en.childMu.Lock()
	ch := en.children[int32(id64)]
	en.childMu.Unlock()
	if ch == nil || ch.stdin == nil {
		return "false", nil, false, "", nil
	}
	ok, werr := ch.stdin.Enqueue(data)
	if werr != nil {
		return "", nil, false, "EPIPE", werr
	}
	if !ok {
		return "false", nil, false, "", nil
	}
	return "true", nil, false, "", nil
}

func (en *rtEntry) opCPSetRef(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		ID  int32 `json:"id"`
		Ref bool  `json:"ref"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	en.childMu.Lock()
	ch := en.children[req.ID]
	en.childMu.Unlock()
	if ch != nil {
		ch.mu.Lock()
		ch.unrefed = !req.Ref
		ch.mu.Unlock()
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) opCPCloseStdin(argsStr string) (string, []byte, bool, string, error) {
	id64, err := strconv.ParseInt(strings.TrimSpace(argsStr), 10, 32)
	if err != nil {
		return "", nil, false, "EINVAL", err
	}
	en.childMu.Lock()
	ch := en.children[int32(id64)]
	en.childMu.Unlock()
	if ch != nil && ch.stdin != nil {
		ch.stdin.EnqueueClose()
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) opCPKillChild(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		ID     int32 `json:"id"`
		Signal any   `json:"signal"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		id64, perr := strconv.ParseInt(strings.TrimSpace(argsStr), 10, 32)
		if perr != nil {
			return "", nil, false, "EINVAL", err
		}
		req.ID = int32(id64)
	}
	sigNum, err := parseKillSignal(req.Signal)
	if err != nil {
		return "", nil, false, "ERR_UNKNOWN_SIGNAL", err
	}
	en.childMu.Lock()
	ch := en.children[req.ID]
	en.childMu.Unlock()
	if ch == nil {
		return "false", nil, false, "", nil
	}
	if ch.cmd == nil || ch.cmd.Process == nil {
		if sigNum == 0 {
			return "true", nil, false, "", nil
		}
		ch.mu.Lock()
		ch.killedSignal = signalNameFromNumber(sigNum)
		ch.mu.Unlock()
		if ch.cancel != nil {
			ch.cancel()
		}
		return "true", nil, false, "", nil
	}
	ch.mu.Lock()
	reaped := ch.reaped
	ch.mu.Unlock()
	if reaped {
		return "false", nil, false, "", nil
	}
	if sigNum == 0 {
		if isProcessAlive(ch.cmd.Process.Pid) {
			return "true", nil, false, "", nil
		}
		return "false", nil, false, "", nil
	}
	ch.mu.Lock()
	ch.killedSignal = signalNameFromNumber(sigNum)
	ch.mu.Unlock()
	if runtime.GOOS == "windows" || sigNum == 9 || sigNum == 15 {
		killProcessTree(ch.cmd.Process.Pid)
		if ch.cancel != nil {
			ch.cancel()
		}
	} else {
		proctable.KillTree(ch.cmd.Process.Pid, sigNum)
	}
	return "true", nil, false, "", nil
}

func makeStreamCredits() chan struct{} {
	c := make(chan struct{}, 16)
	for range 16 {
		c <- struct{}{}
	}
	return c
}

func (en *rtEntry) opCPPullOutput(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		ID  int32  `json:"id"`
		Out string `json:"out"`
		N   int    `json:"n"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "", nil
	}
	if req.N <= 0 {
		req.N = 1
	}
	en.childMu.Lock()
	ch := en.children[req.ID]
	en.childMu.Unlock()
	if ch == nil {
		return "", nil, false, "", nil
	}
	var c chan struct{}
	if req.Out == "stderr" {
		c = ch.errCredits
	} else {
		c = ch.outCredits
	}
	if c != nil {
		for {
			select {
			case c <- struct{}{}:
			default:
				return "", nil, false, "", nil
			}
		}
	}
	return "", nil, false, "", nil
}

// ---- Crypto ----

func (en *rtEntry) opCryptoRandomBytes(argsStr string) (string, []byte, bool, string, error) {
	n, err := strconv.Atoi(strings.TrimSpace(argsStr))
	if err != nil || n < 0 || int64(n) > maxHostBufferBytes {
		return "", nil, false, "ERR_OUT_OF_RANGE", fmt.Errorf("invalid randomBytes size")
	}
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", nil, false, "EIO", err
	}
	return "", buf, true, "", nil
}

func (en *rtEntry) opCryptoRandomUUID() (string, []byte, bool, string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", nil, false, "EIO", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	uuid := fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
	return uuid, nil, false, "", nil
}

func newHashByName(alg string) (func() hash.Hash, error) {
	switch strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(alg, "-", ""), "_", "")) {
	case "md5":
		return md5.New, nil
	case "ripemd160", "rmd160", "ripemd":
		return newRIPEMD160, nil
	case "sha1":
		return sha1.New, nil
	case "sha224":
		return sha256.New224, nil
	case "sha256":
		return sha256.New, nil
	case "sha384":
		return sha512.New384, nil
	case "sha512":
		return sha512.New, nil
	case "sha512224":
		return sha512.New512_224, nil
	case "sha512256":
		return sha512.New512_256, nil
	case "sha3224":
		return newSHA3_224, nil
	case "sha3256":
		return newSHA3_256, nil
	case "sha3384":
		return newSHA3_384, nil
	case "sha3512":
		return newSHA3_512, nil
	case "shake128":
		return newSHAKE128, nil
	case "shake256":
		return newSHAKE256, nil
	case "blake2b512":
		return newBlake2b512, nil
	case "blake2s256":
		return newBlake2s256, nil
	default:
		return nil, fmt.Errorf("Unsupported digest algorithm: %s", alg)
	}
}

func (en *rtEntry) opCryptoHash(alg string, data []byte) (string, []byte, bool, string, error) {
	var outLen *int
	if strings.HasPrefix(strings.TrimSpace(alg), "{") {
		var req struct {
			Alg          string `json:"alg"`
			OutputLength *int   `json:"outputLength"`
		}
		if err := json.Unmarshal([]byte(alg), &req); err == nil && req.Alg != "" {
			alg = req.Alg
			outLen = req.OutputLength
		}
	}
	norm := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(alg, "-", ""), "_", ""))
	if outLen != nil && (norm == "shake128" || norm == "shake256") {
		if *outLen < 0 || int64(*outLen) > maxHostBufferBytes {
			return "", nil, false, "ERR_OUT_OF_RANGE", fmt.Errorf("invalid outputLength")
		}
		h := newSHAKEWithLen(norm == "shake256", *outLen)
		_, _ = h.Write(data)
		return "", h.Sum(nil), true, "", nil
	}
	hfn, err := newHashByName(alg)
	if err != nil {
		return "", nil, false, "ERR_CRYPTO_HASH_UNKNOWN", err
	}
	h := hfn()
	_, _ = h.Write(data)
	return "", h.Sum(nil), true, "", nil
}

func (en *rtEntry) opCryptoHmac(argsStr string, payload []byte) (string, []byte, bool, string, error) {
	var req struct {
		Alg    string `json:"alg"`
		KeyLen int    `json:"keyLen"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	if req.KeyLen < 0 || req.KeyLen > len(payload) {
		return "", nil, false, "EINVAL", fmt.Errorf("invalid hmac payload")
	}
	hfn, err := newHashByName(req.Alg)
	if err != nil {
		return "", nil, false, "ERR_CRYPTO_HASH_UNKNOWN", err
	}
	mac := hmac.New(hfn, payload[:req.KeyLen])
	_, _ = mac.Write(payload[req.KeyLen:])
	return "", mac.Sum(nil), true, "", nil
}

func (en *rtEntry) opCryptoPBKDF2(argsStr string, payload []byte) (string, []byte, bool, string, error) {
	var req struct {
		Digest     string `json:"digest"`
		PassLen    int    `json:"passLen"`
		Iterations int    `json:"iterations"`
		KeyLen     int    `json:"keyLen"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	if req.PassLen < 0 || req.PassLen > len(payload) || req.Iterations < 1 || req.KeyLen < 0 || req.KeyLen > 16*1024*1024 {
		return "", nil, false, "EINVAL", fmt.Errorf("invalid pbkdf2 arguments")
	}
	if req.Digest == "" {
		req.Digest = "sha1"
	}
	hfn, err := newHashByName(req.Digest)
	if err != nil {
		return "", nil, false, "ERR_CRYPTO_INVALID_DIGEST", err
	}
	pass := payload[:req.PassLen]
	salt := payload[req.PassLen:]
	dk := pbkdf2Key(pass, salt, req.Iterations, req.KeyLen, hfn)
	return "", dk, true, "", nil
}

func pbkdf2Key(password, salt []byte, iter, keyLen int, h func() hash.Hash) []byte {
	prf := hmac.New(h, password)
	hashLen := prf.Size()
	numBlocks := (keyLen + hashLen - 1) / hashLen
	var buf [4]byte
	dk := make([]byte, 0, numBlocks*hashLen)
	U := make([]byte, hashLen)
	for block := 1; block <= numBlocks; block++ {
		prf.Reset()
		prf.Write(salt)
		binary.BigEndian.PutUint32(buf[:], uint32(block))
		prf.Write(buf[:])
		dk = prf.Sum(dk)
		T := dk[len(dk)-hashLen:]
		copy(U, T)
		for n := 2; n <= iter; n++ {
			prf.Reset()
			prf.Write(U)
			U = prf.Sum(U[:0])
			for x := range U {
				T[x] ^= U[x]
			}
		}
	}
	return dk[:keyLen]
}

func (en *rtEntry) opCryptoHKDF(argsStr string, payload []byte) (string, []byte, bool, string, error) {
	var req struct {
		Digest  string `json:"digest"`
		IKMLen  int    `json:"ikmLen"`
		SaltLen int    `json:"saltLen"`
		KeyLen  int    `json:"keyLen"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	if req.IKMLen < 0 || req.SaltLen < 0 || req.IKMLen+req.SaltLen > len(payload) || req.KeyLen < 0 {
		return "", nil, false, "EINVAL", fmt.Errorf("invalid hkdf arguments")
	}
	hfn, err := newHashByName(req.Digest)
	if err != nil {
		return "", nil, false, "ERR_CRYPTO_INVALID_DIGEST", err
	}
	ikm := payload[:req.IKMLen]
	salt := payload[req.IKMLen : req.IKMLen+req.SaltLen]
	info := payload[req.IKMLen+req.SaltLen:]
	if len(salt) == 0 {
		salt = make([]byte, hfn().Size())
	}
	extractor := hmac.New(hfn, salt)
	extractor.Write(ikm)
	prk := extractor.Sum(nil)

	hashLen := len(prk)
	n := (req.KeyLen + hashLen - 1) / hashLen
	if n > 255 {
		return "", nil, false, "ERR_CRYPTO_INVALID_KEYLEN", fmt.Errorf("hkdf key length too large")
	}
	okm := make([]byte, 0, n*hashLen)
	var prev []byte
	for i := 1; i <= n; i++ {
		mac := hmac.New(hfn, prk)
		mac.Write(prev)
		mac.Write(info)
		mac.Write([]byte{byte(i)})
		prev = mac.Sum(nil)
		okm = append(okm, prev...)
	}
	return "", okm[:req.KeyLen], true, "", nil
}

// RFC 7914 scrypt implementation.
func salsa20_8(B *[16]uint32) {
	var x [16]uint32
	for i := range 16 {
		x[i] = B[i]
	}
	rotl := func(a uint32, b uint) uint32 {
		return (a << b) | (a >> (32 - b))
	}
	for i := 0; i < 8; i += 2 {
		x[4] ^= rotl(x[0]+x[12], 7)
		x[8] ^= rotl(x[4]+x[0], 9)
		x[12] ^= rotl(x[8]+x[4], 13)
		x[0] ^= rotl(x[12]+x[8], 18)

		x[9] ^= rotl(x[5]+x[1], 7)
		x[13] ^= rotl(x[9]+x[5], 9)
		x[1] ^= rotl(x[13]+x[9], 13)
		x[5] ^= rotl(x[1]+x[13], 18)

		x[14] ^= rotl(x[10]+x[6], 7)
		x[2] ^= rotl(x[14]+x[10], 9)
		x[6] ^= rotl(x[2]+x[14], 13)
		x[10] ^= rotl(x[6]+x[2], 18)

		x[3] ^= rotl(x[15]+x[11], 7)
		x[7] ^= rotl(x[3]+x[15], 9)
		x[11] ^= rotl(x[7]+x[3], 13)
		x[15] ^= rotl(x[11]+x[7], 18)

		x[1] ^= rotl(x[0]+x[3], 7)
		x[2] ^= rotl(x[1]+x[0], 9)
		x[3] ^= rotl(x[2]+x[1], 13)
		x[0] ^= rotl(x[3]+x[2], 18)

		x[6] ^= rotl(x[5]+x[4], 7)
		x[7] ^= rotl(x[6]+x[5], 9)
		x[4] ^= rotl(x[7]+x[6], 13)
		x[5] ^= rotl(x[4]+x[7], 18)

		x[11] ^= rotl(x[10]+x[9], 7)
		x[8] ^= rotl(x[11]+x[10], 9)
		x[9] ^= rotl(x[8]+x[11], 13)
		x[10] ^= rotl(x[9]+x[8], 18)

		x[12] ^= rotl(x[15]+x[14], 7)
		x[13] ^= rotl(x[12]+x[15], 9)
		x[14] ^= rotl(x[13]+x[12], 13)
		x[15] ^= rotl(x[14]+x[13], 18)
	}
	for i := range 16 {
		B[i] += x[i]
	}
}

func scryptBlockMix(B, Y []uint32, r int) {
	var X [16]uint32
	copy(X[:], B[(2*r-1)*16:2*r*16])
	for i := 0; i < 2*r; i++ {
		for j := range 16 {
			X[j] ^= B[i*16+j]
		}
		salsa20_8(&X)
		if i&1 == 0 {
			copy(Y[(i/2)*16:(i/2+1)*16], X[:])
		} else {
			copy(Y[(r+i/2)*16:(r+i/2+1)*16], X[:])
		}
	}
	copy(B[:32*r], Y[:32*r])
}

func scryptSMix(B []byte, r, N int, V, XY []uint32) {
	X := XY[:32*r]
	Y := XY[32*r : 64*r]
	for i := 0; i < 32*r; i++ {
		X[i] = binary.LittleEndian.Uint32(B[i*4 : i*4+4])
	}
	for i := 0; i < N; i++ {
		copy(V[i*32*r:(i+1)*32*r], X)
		scryptBlockMix(X, Y, r)
	}
	mask := uint32(N - 1)
	for i := 0; i < N; i++ {
		j := int(X[(2*r-1)*16] & mask)
		vSlice := V[j*32*r : (j+1)*32*r]
		for k := range X {
			X[k] ^= vSlice[k]
		}
		scryptBlockMix(X, Y, r)
	}
	for i := 0; i < 32*r; i++ {
		binary.LittleEndian.PutUint32(B[i*4:i*4+4], X[i])
	}
}

func scryptKey(password, salt []byte, N, r, p, maxMem, keyLen int) ([]byte, error) {
	if N <= 1 || N&(N-1) != 0 || N > (1<<20) {
		return nil, fmt.Errorf("Invalid scrypt params: N must be a power of 2 greater than 1")
	}
	if r <= 0 || p <= 0 || r > (1<<16) || p > (1<<16) {
		return nil, fmt.Errorf("Invalid scrypt params: r and p must be positive")
	}
	if keyLen < 0 || keyLen > 64*1024*1024 {
		return nil, fmt.Errorf("Invalid scrypt keylen")
	}
	const hardMaxScryptMem = 128 * 1024 * 1024
	if maxMem <= 0 {
		maxMem = 32 * 1024 * 1024
	}
	if maxMem > hardMaxScryptMem {
		maxMem = hardMaxScryptMem
	}
	if int64(r)*int64(N) > int64(maxMem)/128 || int64(r)*int64(p) > int64(maxMem)/128 {
		return nil, fmt.Errorf("Invalid scrypt params: memory limit exceeded")
	}
	memNeeded := int64(128) * int64(r) * (int64(N) + int64(p) + 2)
	if memNeeded <= 0 || memNeeded > int64(maxMem) {
		return nil, fmt.Errorf("Invalid scrypt params: memory limit exceeded")
	}
	B := pbkdf2Key(password, salt, 1, p*128*r, sha256.New)
	XY := make([]uint32, 64*r)
	V := make([]uint32, 32*N*r)
	for i := 0; i < p; i++ {
		scryptSMix(B[i*128*r:(i+1)*128*r], r, N, V, XY)
	}
	return pbkdf2Key(password, B, 1, keyLen, sha256.New), nil
}

func (en *rtEntry) opCryptoScrypt(argsStr string, payload []byte) (string, []byte, bool, string, error) {
	var req struct {
		PassLen int `json:"passLen"`
		KeyLen  int `json:"keyLen"`
		N       int `json:"N"`
		R       int `json:"r"`
		P       int `json:"p"`
		MaxMem  int `json:"maxmem"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	if req.PassLen < 0 || req.PassLen > len(payload) || req.KeyLen < 0 {
		return "", nil, false, "EINVAL", fmt.Errorf("invalid scrypt arguments")
	}
	if req.N == 0 {
		req.N = 16384
	}
	if req.R == 0 {
		req.R = 8
	}
	if req.P == 0 {
		req.P = 1
	}
	dk, err := scryptKey(payload[:req.PassLen], payload[req.PassLen:], req.N, req.R, req.P, req.MaxMem, req.KeyLen)
	if err != nil {
		return "", nil, false, "ERR_CRYPTO_INVALID_SCRYPT_PARAMS", err
	}
	return "", dk, true, "", nil
}

func (en *rtEntry) opCryptoCipher(argsStr string, payload []byte) (string, []byte, bool, string, error) {
	var req struct {
		Alg        string `json:"alg"`
		Decrypt    bool   `json:"decrypt"`
		KeyLen     int    `json:"keyLen"`
		IVLen      int    `json:"ivLen"`
		AADLen     int    `json:"aadLen"`
		TagLen     int    `json:"tagLen"`
		AuthTagLen int    `json:"authTagLen"`
		AutoPad    *bool  `json:"autoPad"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	headerLen := req.KeyLen + req.IVLen + req.AADLen + req.TagLen
	if req.KeyLen < 0 || req.IVLen < 0 || req.AADLen < 0 || req.TagLen < 0 || headerLen > len(payload) {
		return "", nil, false, "EINVAL", fmt.Errorf("invalid cipher payload")
	}
	key := payload[:req.KeyLen]
	iv := payload[req.KeyLen : req.KeyLen+req.IVLen]
	aad := payload[req.KeyLen+req.IVLen : req.KeyLen+req.IVLen+req.AADLen]
	tag := payload[req.KeyLen+req.IVLen+req.AADLen : headerLen]
	data := payload[headerLen:]
	alg := strings.ToLower(strings.TrimSpace(req.Alg))
	if alg == "chacha20-poly1305" {
		out, errCode, cerr := chacha20Poly1305Cipher(key, iv, aad, tag, data, req.Decrypt)
		if cerr != nil {
			return "", nil, false, errCode, cerr
		}
		return "", out, true, "", nil
	}
	var expectedKeyLen int
	switch alg {
	case "aes-128-cbc", "aes-128-ctr", "aes-128-gcm":
		expectedKeyLen = 16
	case "aes-192-cbc", "aes-192-ctr", "aes-192-gcm":
		expectedKeyLen = 24
	case "aes-256-cbc", "aes-256-ctr", "aes-256-gcm":
		expectedKeyLen = 32
	default:
		return "", nil, false, "ERR_CRYPTO_UNKNOWN_CIPHER", fmt.Errorf("Unknown cipher %s", req.Alg)
	}
	if len(key) != expectedKeyLen {
		return "", nil, false, "ERR_CRYPTO_INVALID_KEYLEN", fmt.Errorf("Invalid key length")
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", nil, false, "ERR_CRYPTO_INVALID_KEYLEN", err
	}

	switch {
	case strings.HasSuffix(alg, "-gcm"):
		tagSize := 16
		if req.AuthTagLen > 0 {
			switch req.AuthTagLen {
			case 4, 8, 12, 13, 14, 15, 16:
				tagSize = req.AuthTagLen
			default:
				return "", nil, false, "ERR_CRYPTO_INVALID_AUTH_TAG", fmt.Errorf("Invalid authentication tag length: %d", req.AuthTagLen)
			}
		}
		gcm, err := cipher.NewGCMWithNonceSize(block, len(iv))
		if err != nil {
			return "", nil, false, "ERR_CRYPTO_INVALID_IV", err
		}
		if !req.Decrypt {
			sealed := gcm.Seal(nil, iv, data, aad)
			if tagSize != 16 && len(sealed) >= 16 {
				ct := sealed[:len(sealed)-16]
				t := sealed[len(sealed)-16 : len(sealed)-16+tagSize]
				sealed = append(ct, t...)
			}
			return "", sealed, true, "", nil
		}
		if len(tag) != tagSize {
			return "", nil, false, "ERR_CRYPTO_INVALID_AUTH_TAG", fmt.Errorf("Invalid authentication tag length: %d", len(tag))
		}
		if tagSize != 16 {
			candPlain := gcm.Seal(nil, iv, data, aad)[:len(data)]
			verifySealed := gcm.Seal(nil, iv, candPlain, aad)
			expectedTag := verifySealed[len(data) : len(data)+tagSize]
			if !hmac.Equal(expectedTag, tag) {
				return "", nil, false, "ERR_CRYPTO_INVALID_STATE", fmt.Errorf("Unsupported state or unable to authenticate data")
			}
			return "", candPlain, true, "", nil
		}
		fullCipher := make([]byte, len(data)+len(tag))
		copy(fullCipher, data)
		copy(fullCipher[len(data):], tag)
		plain, err := gcm.Open(nil, iv, fullCipher, aad)
		if err != nil {
			return "", nil, false, "ERR_CRYPTO_INVALID_STATE", fmt.Errorf("Unsupported state or unable to authenticate data")
		}
		return "", plain, true, "", nil

	case strings.HasSuffix(alg, "-cbc"):
		if len(iv) != aes.BlockSize {
			return "", nil, false, "ERR_CRYPTO_INVALID_IV", fmt.Errorf("Invalid initialization vector")
		}
		autoPad := true
		if req.AutoPad != nil {
			autoPad = *req.AutoPad
		}
		if !req.Decrypt {
			src := data
			if autoPad {
				padLen := aes.BlockSize - (len(src) % aes.BlockSize)
				padded := make([]byte, len(src)+padLen)
				copy(padded, src)
				for i := len(src); i < len(padded); i++ {
					padded[i] = byte(padLen)
				}
				src = padded
			} else if len(src)%aes.BlockSize != 0 {
				return "", nil, false, "ERR_CRYPTO_INVALID_STATE", fmt.Errorf("wrong final block length")
			}
			out := make([]byte, len(src))
			cipher.NewCBCEncrypter(block, iv).CryptBlocks(out, src)
			return "", out, true, "", nil
		}
		if len(data) == 0 || len(data)%aes.BlockSize != 0 {
			return "", nil, false, "ERR_CRYPTO_INVALID_STATE", fmt.Errorf("wrong final block length")
		}
		out := make([]byte, len(data))
		cipher.NewCBCDecrypter(block, iv).CryptBlocks(out, data)
		if autoPad {
			padLen := int(out[len(out)-1])
			if padLen <= 0 || padLen > aes.BlockSize || padLen > len(out) {
				return "", nil, false, "ERR_OSSL_BAD_DECRYPT", fmt.Errorf("bad decrypt")
			}
			for i := len(out) - padLen; i < len(out); i++ {
				if int(out[i]) != padLen {
					return "", nil, false, "ERR_OSSL_BAD_DECRYPT", fmt.Errorf("bad decrypt")
				}
			}
			out = out[:len(out)-padLen]
		}
		return "", out, true, "", nil

	case strings.HasSuffix(alg, "-ctr"):
		if len(iv) != aes.BlockSize {
			return "", nil, false, "ERR_CRYPTO_INVALID_IV", fmt.Errorf("Invalid initialization vector")
		}
		out := make([]byte, len(data))
		cipher.NewCTR(block, iv).XORKeyStream(out, data)
		return "", out, true, "", nil

	default:
		return "", nil, false, "ERR_CRYPTO_UNKNOWN_CIPHER", fmt.Errorf("Unknown cipher %s", req.Alg)
	}
}

func curveByName(namedCurve string) (elliptic.Curve, int, error) {
	switch strings.ToUpper(strings.TrimSpace(namedCurve)) {
	case "P-256", "PRIME256V1", "SECP256R1":
		return elliptic.P256(), 32, nil
	case "P-384", "SECP384R1":
		return elliptic.P384(), 48, nil
	case "P-521", "SECP521R1":
		return elliptic.P521(), 66, nil
	default:
		return nil, 0, fmt.Errorf("NotSupportedError: Unsupported namedCurve %q", namedCurve)
	}
}

func init() {
	crypto.RegisterHash(crypto.MD5, md5.New)
	crypto.RegisterHash(crypto.SHA1, sha1.New)
	crypto.RegisterHash(crypto.SHA224, sha256.New224)
	crypto.RegisterHash(crypto.SHA256, sha256.New)
	crypto.RegisterHash(crypto.SHA384, sha512.New384)
	crypto.RegisterHash(crypto.SHA512, sha512.New)
	crypto.RegisterHash(crypto.SHA512_224, sha512.New512_224)
	crypto.RegisterHash(crypto.SHA512_256, sha512.New512_256)
	crypto.RegisterHash(crypto.RIPEMD160, newRIPEMD160)
	crypto.RegisterHash(crypto.SHA3_224, newSHA3_224)
	crypto.RegisterHash(crypto.SHA3_256, newSHA3_256)
	crypto.RegisterHash(crypto.SHA3_384, newSHA3_384)
	crypto.RegisterHash(crypto.SHA3_512, newSHA3_512)
	crypto.RegisterHash(crypto.BLAKE2s_256, newBlake2s256)
	crypto.RegisterHash(crypto.BLAKE2b_512, newBlake2b512)
}

func cryptoHashByName(alg string) (crypto.Hash, func() hash.Hash, error) {
	norm := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(alg), "-", ""), "_", ""), "/", ""))
	switch norm {
	case "md5":
		return crypto.MD5, md5.New, nil
	case "ripemd160", "rmd160", "ripemd":
		return crypto.RIPEMD160, newRIPEMD160, nil
	case "sha1":
		return crypto.SHA1, sha1.New, nil
	case "sha224":
		return crypto.SHA224, sha256.New224, nil
	case "sha256", "":
		return crypto.SHA256, sha256.New, nil
	case "sha384":
		return crypto.SHA384, sha512.New384, nil
	case "sha512":
		return crypto.SHA512, sha512.New, nil
	case "sha512224":
		return crypto.SHA512_224, sha512.New512_224, nil
	case "sha512256":
		return crypto.SHA512_256, sha512.New512_256, nil
	case "sha3224":
		return crypto.SHA3_224, newSHA3_224, nil
	case "sha3256":
		return crypto.SHA3_256, newSHA3_256, nil
	case "sha3384":
		return crypto.SHA3_384, newSHA3_384, nil
	case "sha3512":
		return crypto.SHA3_512, newSHA3_512, nil
	case "blake2s256":
		return crypto.BLAKE2s_256, newBlake2s256, nil
	case "blake2b512":
		return crypto.BLAKE2b_512, newBlake2b512, nil
	default:
		return 0, nil, fmt.Errorf("NotSupportedError: Unsupported digest algorithm %q", alg)
	}
}

func mgf1XOR(out []byte, h hash.Hash, seed []byte) {
	var counter [4]byte
	var digest []byte
	done := 0
	for done < len(out) {
		h.Reset()
		_, _ = h.Write(seed)
		_, _ = h.Write(counter[:4])
		digest = h.Sum(digest[:0])
		for i := 0; i < len(digest) && done < len(out); i++ {
			out[done] ^= digest[i]
			done++
		}
		for i := 3; i >= 0; i-- {
			counter[i]++
			if counter[i] != 0 {
				break
			}
		}
	}
}

func rsaSignPSSZeroSalt(priv *rsa.PrivateKey, h hash.Hash, mHash []byte) ([]byte, error) {
	emBits := priv.N.BitLen() - 1
	emLen := (emBits + 7) / 8
	hLen := h.Size()
	if emLen < hLen+2 {
		return nil, rsa.ErrMessageTooLong
	}
	em := make([]byte, emLen)
	db := em[:emLen-hLen-1]
	h0 := em[emLen-hLen-1 : emLen-1]
	var prefix [8]byte
	h.Reset()
	_, _ = h.Write(prefix[:])
	_, _ = h.Write(mHash)
	_ = h.Sum(h0[:0])
	db[emLen-hLen-2] = 0x01
	mgf1XOR(db, h, h0)
	db[0] &= 0xFF >> (8*emLen - emBits)
	em[emLen-1] = 0xbc
	m := new(big.Int).SetBytes(em)
	c := new(big.Int).Exp(m, priv.D, priv.N)
	return padBigInt(c, (priv.N.BitLen()+7)/8), nil
}

func rsaVerifyPSSZeroSalt(pub *rsa.PublicKey, h hash.Hash, mHash []byte, sig []byte) error {
	k := (pub.N.BitLen() + 7) / 8
	if len(sig) != k {
		return rsa.ErrVerification
	}
	s := new(big.Int).SetBytes(sig)
	if s.Cmp(pub.N) >= 0 {
		return rsa.ErrVerification
	}
	m := new(big.Int).Exp(s, big.NewInt(int64(pub.E)), pub.N)
	emBits := pub.N.BitLen() - 1
	emLen := (emBits + 7) / 8
	if m.BitLen() > emLen*8 {
		return rsa.ErrVerification
	}
	em := padBigInt(m, emLen)
	hLen := h.Size()
	if emLen < hLen+2 || em[emLen-1] != 0xbc {
		return rsa.ErrVerification
	}
	db := em[:emLen-hLen-1]
	h0 := em[emLen-hLen-1 : emLen-1]
	bitMask := byte(0xFF >> (8*emLen - emBits))
	if em[0]&^bitMask != 0 {
		return rsa.ErrVerification
	}
	mgf1XOR(db, h, h0)
	db[0] &= bitMask
	for _, b := range db[:len(db)-1] {
		if b != 0 {
			return rsa.ErrVerification
		}
	}
	if db[len(db)-1] != 0x01 {
		return rsa.ErrVerification
	}
	var prefix [8]byte
	h.Reset()
	_, _ = h.Write(prefix[:])
	_, _ = h.Write(mHash)
	hPrime := h.Sum(nil)
	if !bytes.Equal(h0, hPrime) {
		return rsa.ErrVerification
	}
	return nil
}

func b64urlEncode(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

func b64urlDecode(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if b, err := base64.RawURLEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.URLEncoding.DecodeString(s)
}

func padBigInt(n *big.Int, size int) []byte {
	out := make([]byte, size)
	b := n.Bytes()
	if len(b) > size {
		copy(out, b[len(b)-size:])
	} else {
		copy(out[size-len(b):], b)
	}
	return out
}

func marshalUncompressedECPoint(curve elliptic.Curve, x, y *big.Int) []byte {
	byteLen := (curve.Params().BitSize + 7) / 8
	out := make([]byte, 1+2*byteLen)
	out[0] = 4
	copy(out[1:1+byteLen], padBigInt(x, byteLen))
	copy(out[1+byteLen:], padBigInt(y, byteLen))
	return out
}

func unmarshalUncompressedECPoint(curve elliptic.Curve, data []byte) (*big.Int, *big.Int, error) {
	byteLen := (curve.Params().BitSize + 7) / 8
	if len(data) != 1+2*byteLen || data[0] != 4 {
		return nil, nil, fmt.Errorf("DataError: invalid uncompressed EC public key")
	}
	x := new(big.Int).SetBytes(data[1 : 1+byteLen])
	y := new(big.Int).SetBytes(data[1+byteLen:])
	if !curve.IsOnCurve(x, y) {
		return nil, nil, fmt.Errorf("DataError: EC point is not on curve")
	}
	return x, y, nil
}

func buildECKeyFormats(priv *ecdsa.PrivateKey, pub *ecdsa.PublicKey, crv string) (map[string]any, error) {
	_, coordSize, err := curveByName(crv)
	if err != nil {
		return nil, err
	}
	if pub == nil && priv != nil {
		pub = &priv.PublicKey
	}
	spkiBytes, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return nil, err
	}
	rawPub := marshalUncompressedECPoint(pub.Curve, pub.X, pub.Y)
	jwkPub := map[string]any{
		"kty": "EC",
		"crv": crv,
		"x":   b64urlEncode(padBigInt(pub.X, coordSize)),
		"y":   b64urlEncode(padBigInt(pub.Y, coordSize)),
		"ext": true,
	}
	res := map[string]any{
		"spki":   base64.StdEncoding.EncodeToString(spkiBytes),
		"rawPub": base64.StdEncoding.EncodeToString(rawPub),
		"jwkPub": jwkPub,
	}
	if priv != nil {
		pkcs8Bytes, err := x509.MarshalPKCS8PrivateKey(priv)
		if err != nil {
			return nil, err
		}
		sec1Bytes, _ := x509.MarshalECPrivateKey(priv)
		jwkPriv := map[string]any{
			"kty": "EC",
			"crv": crv,
			"x":   b64urlEncode(padBigInt(pub.X, coordSize)),
			"y":   b64urlEncode(padBigInt(pub.Y, coordSize)),
			"d":   b64urlEncode(padBigInt(priv.D, coordSize)),
			"ext": true,
		}
		res["pkcs8"] = base64.StdEncoding.EncodeToString(pkcs8Bytes)
		if len(sec1Bytes) > 0 {
			res["sec1"] = base64.StdEncoding.EncodeToString(sec1Bytes)
		}
		res["jwkPriv"] = jwkPriv
	}
	res["keyType"] = "ec"
	res["namedCurve"] = crv
	return res, nil
}

func buildX25519KeyFormats(priv *ecdh.PrivateKey, pub *ecdh.PublicKey) (map[string]any, error) {
	if pub == nil && priv != nil {
		pub = priv.PublicKey()
	}
	spkiBytes, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return nil, err
	}
	rawPub := pub.Bytes()
	jwkPub := map[string]any{
		"kty": "OKP",
		"crv": "X25519",
		"x":   b64urlEncode(rawPub),
		"ext": true,
	}
	res := map[string]any{
		"keyType": "x25519",
		"spki":    base64.StdEncoding.EncodeToString(spkiBytes),
		"rawPub":  base64.StdEncoding.EncodeToString(rawPub),
		"jwkPub":  jwkPub,
	}
	if priv != nil {
		pkcs8Bytes, err := x509.MarshalPKCS8PrivateKey(priv)
		if err != nil {
			return nil, err
		}
		jwkPriv := map[string]any{
			"kty": "OKP",
			"crv": "X25519",
			"x":   b64urlEncode(rawPub),
			"d":   b64urlEncode(priv.Bytes()),
			"ext": true,
		}
		res["pkcs8"] = base64.StdEncoding.EncodeToString(pkcs8Bytes)
		res["jwkPriv"] = jwkPriv
	}
	return res, nil
}

func buildEd25519KeyFormats(priv ed25519.PrivateKey, pub ed25519.PublicKey) (map[string]any, error) {
	if len(pub) == 0 && len(priv) == ed25519.PrivateKeySize {
		pub = priv.Public().(ed25519.PublicKey)
	}
	spkiBytes, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return nil, err
	}
	jwkPub := map[string]any{
		"kty": "OKP",
		"crv": "Ed25519",
		"x":   b64urlEncode(pub),
		"ext": true,
	}
	res := map[string]any{
		"keyType": "ed25519",
		"spki":    base64.StdEncoding.EncodeToString(spkiBytes),
		"rawPub":  base64.StdEncoding.EncodeToString(pub),
		"jwkPub":  jwkPub,
	}
	if len(priv) == ed25519.PrivateKeySize {
		pkcs8Bytes, err := x509.MarshalPKCS8PrivateKey(priv)
		if err != nil {
			return nil, err
		}
		jwkPriv := map[string]any{
			"kty": "OKP",
			"crv": "Ed25519",
			"x":   b64urlEncode(pub),
			"d":   b64urlEncode(priv.Seed()),
			"ext": true,
		}
		res["pkcs8"] = base64.StdEncoding.EncodeToString(pkcs8Bytes)
		res["jwkPriv"] = jwkPriv
	}
	return res, nil
}

func buildRSAKeyFormats(priv *rsa.PrivateKey, pub *rsa.PublicKey) (map[string]any, error) {
	if pub == nil && priv != nil {
		pub = &priv.PublicKey
	}
	spkiBytes, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return nil, err
	}
	jwkPub := map[string]any{
		"kty": "RSA",
		"n":   b64urlEncode(pub.N.Bytes()),
		"e":   b64urlEncode(big.NewInt(int64(pub.E)).Bytes()),
		"ext": true,
	}
	pkcs1PubBytes := x509.MarshalPKCS1PublicKey(pub)
	res := map[string]any{
		"keyType":       "rsa",
		"spki":          base64.StdEncoding.EncodeToString(spkiBytes),
		"pkcs1Pub":      base64.StdEncoding.EncodeToString(pkcs1PubBytes),
		"jwkPub":        jwkPub,
		"modulusLength": pub.N.BitLen(),
	}
	if priv != nil {
		pkcs8Bytes, err := x509.MarshalPKCS8PrivateKey(priv)
		if err != nil {
			return nil, err
		}
		pkcs1PrivBytes := x509.MarshalPKCS1PrivateKey(priv)
		priv.Precompute()
		jwkPriv := map[string]any{
			"kty": "RSA",
			"n":   b64urlEncode(pub.N.Bytes()),
			"e":   b64urlEncode(big.NewInt(int64(pub.E)).Bytes()),
			"d":   b64urlEncode(priv.D.Bytes()),
			"ext": true,
		}
		if len(priv.Primes) >= 2 {
			jwkPriv["p"] = b64urlEncode(priv.Primes[0].Bytes())
			jwkPriv["q"] = b64urlEncode(priv.Primes[1].Bytes())
			if priv.Precomputed.Dp != nil {
				jwkPriv["dp"] = b64urlEncode(priv.Precomputed.Dp.Bytes())
			}
			if priv.Precomputed.Dq != nil {
				jwkPriv["dq"] = b64urlEncode(priv.Precomputed.Dq.Bytes())
			}
			if priv.Precomputed.Qinv != nil {
				jwkPriv["qi"] = b64urlEncode(priv.Precomputed.Qinv.Bytes())
			}
		}
		res["pkcs8"] = base64.StdEncoding.EncodeToString(pkcs8Bytes)
		res["pkcs1Priv"] = base64.StdEncoding.EncodeToString(pkcs1PrivBytes)
		res["jwkPriv"] = jwkPriv
	}
	return res, nil
}

func curveCanonicalName(c elliptic.Curve) string {
	switch c {
	case elliptic.P256():
		return "P-256"
	case elliptic.P384():
		return "P-384"
	case elliptic.P521():
		return "P-521"
	default:
		return "P-256"
	}
}

func parseAnyAsymmetricKey(raw []byte) (map[string]any, error) {
	der := raw
	if block, _ := pem.Decode(raw); block != nil {
		der = block.Bytes
	}
	if parsed, err := x509.ParsePKCS8PrivateKey(der); err == nil {
		switch k := parsed.(type) {
		case *rsa.PrivateKey:
			m, err := buildRSAKeyFormats(k, &k.PublicKey)
			if err == nil {
				m["type"] = "private"
			}
			return m, err
		case *ecdsa.PrivateKey:
			m, err := buildECKeyFormats(k, &k.PublicKey, curveCanonicalName(k.Curve))
			if err == nil {
				m["type"] = "private"
			}
			return m, err
		case ed25519.PrivateKey:
			m, err := buildEd25519KeyFormats(k, nil)
			if err == nil {
				m["type"] = "private"
			}
			return m, err
		case *ecdh.PrivateKey:
			if k.Curve() == ecdh.X25519() {
				m, err := buildX25519KeyFormats(k, nil)
				if err == nil {
					m["type"] = "private"
				}
				return m, err
			}
		}
	}
	if rsaPriv, err := x509.ParsePKCS1PrivateKey(der); err == nil {
		m, err := buildRSAKeyFormats(rsaPriv, &rsaPriv.PublicKey)
		if err == nil {
			m["type"] = "private"
		}
		return m, err
	}
	if ecPriv, err := x509.ParseECPrivateKey(der); err == nil {
		m, err := buildECKeyFormats(ecPriv, &ecPriv.PublicKey, curveCanonicalName(ecPriv.Curve))
		if err == nil {
			m["type"] = "private"
		}
		return m, err
	}
	if parsed, err := x509.ParsePKIXPublicKey(der); err == nil {
		switch k := parsed.(type) {
		case *rsa.PublicKey:
			m, err := buildRSAKeyFormats(nil, k)
			if err == nil {
				m["type"] = "public"
			}
			return m, err
		case *ecdsa.PublicKey:
			m, err := buildECKeyFormats(nil, k, curveCanonicalName(k.Curve))
			if err == nil {
				m["type"] = "public"
			}
			return m, err
		case ed25519.PublicKey:
			m, err := buildEd25519KeyFormats(nil, k)
			if err == nil {
				m["type"] = "public"
			}
			return m, err
		case *ecdh.PublicKey:
			if k.Curve() == ecdh.X25519() {
				m, err := buildX25519KeyFormats(nil, k)
				if err == nil {
					m["type"] = "public"
				}
				return m, err
			}
		}
	}
	if rsaPub, err := x509.ParsePKCS1PublicKey(der); err == nil {
		m, err := buildRSAKeyFormats(nil, rsaPub)
		if err == nil {
			m["type"] = "public"
		}
		return m, err
	}
	return nil, fmt.Errorf("ERR_OSSL_UNSUPPORTED: unsupported or invalid asymmetric key")
}

func (en *rtEntry) opCryptoWebCrypto(argsStr string, payload []byte) (string, []byte, bool, string, error) {
	var req struct {
		Op            string         `json:"op"`
		Alg           string         `json:"alg"`
		NamedCurve    string         `json:"namedCurve"`
		Hash          string         `json:"hash"`
		ModulusLength int            `json:"modulusLength"`
		Format        string         `json:"format"`
		JWK           map[string]any `json:"jwk"`
		KeyLen        int            `json:"keyLen"`
		SigLen        int            `json:"sigLen"`
		SaltLength    int            `json:"saltLength"`
		LabelLen      int            `json:"labelLen"`
		Safe          bool           `json:"safe"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	algUpper := strings.ToUpper(strings.TrimSpace(req.Alg))

	switch req.Op {
	case "generateKey":
		switch algUpper {
		case "ECDSA", "ECDH":
			crvName := strings.ToUpper(strings.TrimSpace(req.NamedCurve))
			if crvName == "" {
				crvName = "P-256"
			}
			curve, _, err := curveByName(crvName)
			if err != nil {
				return "", nil, false, "NotSupportedError", err
			}
			priv, err := ecdsa.GenerateKey(curve, rand.Reader)
			if err != nil {
				return "", nil, false, "OperationError", err
			}
			formats, err := buildECKeyFormats(priv, &priv.PublicKey, crvName)
			if err != nil {
				return "", nil, false, "OperationError", err
			}
			b, _ := json.Marshal(formats)
			return string(b), nil, false, "", nil

		case "ED25519", "NODE-ED25519":
			pub, priv, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				return "", nil, false, "OperationError", err
			}
			formats, err := buildEd25519KeyFormats(priv, pub)
			if err != nil {
				return "", nil, false, "OperationError", err
			}
			b, _ := json.Marshal(formats)
			return string(b), nil, false, "", nil

		case "X25519":
			priv, err := ecdh.X25519().GenerateKey(rand.Reader)
			if err != nil {
				return "", nil, false, "OperationError", err
			}
			formats, err := buildX25519KeyFormats(priv, priv.PublicKey())
			if err != nil {
				return "", nil, false, "OperationError", err
			}
			b, _ := json.Marshal(formats)
			return string(b), nil, false, "", nil

		case "RSASSA-PKCS1-V1_5", "RSA-PSS", "RSA-OAEP":
			bits := req.ModulusLength
			if bits == 0 {
				bits = 2048
			}
			if bits < 1024 || bits > 8192 {
				return "", nil, false, "OperationError", fmt.Errorf("OperationError: invalid RSA modulusLength %d", bits)
			}
			priv, err := rsa.GenerateKey(rand.Reader, bits)
			if err != nil {
				return "", nil, false, "OperationError", err
			}
			formats, err := buildRSAKeyFormats(priv, &priv.PublicKey)
			if err != nil {
				return "", nil, false, "OperationError", err
			}
			b, _ := json.Marshal(formats)
			return string(b), nil, false, "", nil

		default:
			return "", nil, false, "NotSupportedError", fmt.Errorf("NotSupportedError: Unrecognized algorithm %q", req.Alg)
		}

	case "importKey":
		format := strings.ToLower(strings.TrimSpace(req.Format))
		switch algUpper {
		case "ECDSA", "ECDH":
			crvName := strings.ToUpper(strings.TrimSpace(req.NamedCurve))
			if crvName == "" && req.JWK != nil {
				if c, ok := req.JWK["crv"].(string); ok {
					crvName = strings.ToUpper(c)
				}
			}
			if crvName == "" {
				crvName = "P-256"
			}
			curve, _, err := curveByName(crvName)
			if err != nil {
				return "", nil, false, "NotSupportedError", err
			}
			switch format {
			case "pkcs8":
				parsed, err := x509.ParsePKCS8PrivateKey(payload)
				if err != nil {
					return "", nil, false, "DataError", err
				}
				priv, ok := parsed.(*ecdsa.PrivateKey)
				if !ok {
					return "", nil, false, "DataError", fmt.Errorf("DataError: not an ECDSA private key")
				}
				formats, err := buildECKeyFormats(priv, &priv.PublicKey, crvName)
				if err != nil {
					return "", nil, false, "DataError", err
				}
				formats["type"] = "private"
				b, _ := json.Marshal(formats)
				return string(b), nil, false, "", nil
			case "spki":
				parsed, err := x509.ParsePKIXPublicKey(payload)
				if err != nil {
					return "", nil, false, "DataError", err
				}
				pub, ok := parsed.(*ecdsa.PublicKey)
				if !ok {
					return "", nil, false, "DataError", fmt.Errorf("DataError: not an ECDSA public key")
				}
				formats, err := buildECKeyFormats(nil, pub, crvName)
				if err != nil {
					return "", nil, false, "DataError", err
				}
				formats["type"] = "public"
				b, _ := json.Marshal(formats)
				return string(b), nil, false, "", nil
			case "raw":
				x, y, err := unmarshalUncompressedECPoint(curve, payload)
				if err != nil {
					return "", nil, false, "DataError", err
				}
				pub := &ecdsa.PublicKey{Curve: curve, X: x, Y: y}
				formats, err := buildECKeyFormats(nil, pub, crvName)
				if err != nil {
					return "", nil, false, "DataError", err
				}
				formats["type"] = "public"
				b, _ := json.Marshal(formats)
				return string(b), nil, false, "", nil
			case "jwk":
				xStr, _ := req.JWK["x"].(string)
				yStr, _ := req.JWK["y"].(string)
				dStr, _ := req.JWK["d"].(string)
				xb, xerr := b64urlDecode(xStr)
				yb, yerr := b64urlDecode(yStr)
				if xerr != nil || yerr != nil || len(xb) == 0 || len(yb) == 0 {
					return "", nil, false, "DataError", fmt.Errorf("DataError: invalid EC JWK coordinates")
				}
				pub := &ecdsa.PublicKey{
					Curve: curve,
					X:     new(big.Int).SetBytes(xb),
					Y:     new(big.Int).SetBytes(yb),
				}
				if dStr != "" {
					db, derr := b64urlDecode(dStr)
					if derr != nil || len(db) == 0 {
						return "", nil, false, "DataError", fmt.Errorf("DataError: invalid EC JWK private key")
					}
					priv := &ecdsa.PrivateKey{PublicKey: *pub, D: new(big.Int).SetBytes(db)}
					formats, err := buildECKeyFormats(priv, pub, crvName)
					if err != nil {
						return "", nil, false, "DataError", err
					}
					formats["type"] = "private"
					b, _ := json.Marshal(formats)
					return string(b), nil, false, "", nil
				}
				formats, err := buildECKeyFormats(nil, pub, crvName)
				if err != nil {
					return "", nil, false, "DataError", err
				}
				formats["type"] = "public"
				b, _ := json.Marshal(formats)
				return string(b), nil, false, "", nil
			default:
				return "", nil, false, "NotSupportedError", fmt.Errorf("NotSupportedError: Unsupported format %q", format)
			}

		case "ED25519", "NODE-ED25519":
			switch format {
			case "pkcs8":
				parsed, err := x509.ParsePKCS8PrivateKey(payload)
				if err != nil {
					return "", nil, false, "DataError", err
				}
				priv, ok := parsed.(ed25519.PrivateKey)
				if !ok {
					return "", nil, false, "DataError", fmt.Errorf("DataError: not an Ed25519 private key")
				}
				formats, err := buildEd25519KeyFormats(priv, nil)
				if err != nil {
					return "", nil, false, "DataError", err
				}
				formats["type"] = "private"
				b, _ := json.Marshal(formats)
				return string(b), nil, false, "", nil
			case "spki":
				parsed, err := x509.ParsePKIXPublicKey(payload)
				if err != nil {
					return "", nil, false, "DataError", err
				}
				pub, ok := parsed.(ed25519.PublicKey)
				if !ok {
					return "", nil, false, "DataError", fmt.Errorf("DataError: not an Ed25519 public key")
				}
				formats, err := buildEd25519KeyFormats(nil, pub)
				if err != nil {
					return "", nil, false, "DataError", err
				}
				formats["type"] = "public"
				b, _ := json.Marshal(formats)
				return string(b), nil, false, "", nil
			case "raw":
				if len(payload) != ed25519.PublicKeySize {
					return "", nil, false, "DataError", fmt.Errorf("DataError: invalid Ed25519 public key length")
				}
				pub := ed25519.PublicKey(append([]byte(nil), payload...))
				formats, err := buildEd25519KeyFormats(nil, pub)
				if err != nil {
					return "", nil, false, "DataError", err
				}
				formats["type"] = "public"
				b, _ := json.Marshal(formats)
				return string(b), nil, false, "", nil
			case "jwk":
				xStr, _ := req.JWK["x"].(string)
				dStr, _ := req.JWK["d"].(string)
				if dStr != "" {
					seed, err := b64urlDecode(dStr)
					if err != nil || len(seed) != ed25519.SeedSize {
						return "", nil, false, "DataError", fmt.Errorf("DataError: invalid Ed25519 JWK seed")
					}
					priv := ed25519.NewKeyFromSeed(seed)
					formats, err := buildEd25519KeyFormats(priv, nil)
					if err != nil {
						return "", nil, false, "DataError", err
					}
					formats["type"] = "private"
					b, _ := json.Marshal(formats)
					return string(b), nil, false, "", nil
				}
				xb, err := b64urlDecode(xStr)
				if err != nil || len(xb) != ed25519.PublicKeySize {
					return "", nil, false, "DataError", fmt.Errorf("DataError: invalid Ed25519 JWK public key")
				}
				formats, err := buildEd25519KeyFormats(nil, ed25519.PublicKey(xb))
				if err != nil {
					return "", nil, false, "DataError", err
				}
				formats["type"] = "public"
				b, _ := json.Marshal(formats)
				return string(b), nil, false, "", nil
			default:
				return "", nil, false, "NotSupportedError", fmt.Errorf("NotSupportedError: Unsupported format %q", format)
			}

		case "X25519":
			switch format {
			case "pkcs8":
				parsed, err := x509.ParsePKCS8PrivateKey(payload)
				if err != nil {
					return "", nil, false, "DataError", err
				}
				priv, ok := parsed.(*ecdh.PrivateKey)
				if !ok || priv.Curve() != ecdh.X25519() {
					return "", nil, false, "DataError", fmt.Errorf("DataError: not an X25519 private key")
				}
				formats, err := buildX25519KeyFormats(priv, priv.PublicKey())
				if err != nil {
					return "", nil, false, "DataError", err
				}
				formats["type"] = "private"
				b, _ := json.Marshal(formats)
				return string(b), nil, false, "", nil
			case "spki":
				parsed, err := x509.ParsePKIXPublicKey(payload)
				if err != nil {
					return "", nil, false, "DataError", err
				}
				pub, ok := parsed.(*ecdh.PublicKey)
				if !ok || pub.Curve() != ecdh.X25519() {
					return "", nil, false, "DataError", fmt.Errorf("DataError: not an X25519 public key")
				}
				formats, err := buildX25519KeyFormats(nil, pub)
				if err != nil {
					return "", nil, false, "DataError", err
				}
				formats["type"] = "public"
				b, _ := json.Marshal(formats)
				return string(b), nil, false, "", nil
			case "raw":
				pub, err := ecdh.X25519().NewPublicKey(payload)
				if err != nil {
					return "", nil, false, "DataError", err
				}
				formats, err := buildX25519KeyFormats(nil, pub)
				if err != nil {
					return "", nil, false, "DataError", err
				}
				formats["type"] = "public"
				b, _ := json.Marshal(formats)
				return string(b), nil, false, "", nil
			case "jwk":
				xStr, _ := req.JWK["x"].(string)
				dStr, _ := req.JWK["d"].(string)
				if dStr != "" {
					db, err := b64urlDecode(dStr)
					if err != nil {
						return "", nil, false, "DataError", fmt.Errorf("DataError: invalid X25519 JWK private key")
					}
					priv, err := ecdh.X25519().NewPrivateKey(db)
					if err != nil {
						return "", nil, false, "DataError", err
					}
					formats, err := buildX25519KeyFormats(priv, priv.PublicKey())
					if err != nil {
						return "", nil, false, "DataError", err
					}
					formats["type"] = "private"
					b, _ := json.Marshal(formats)
					return string(b), nil, false, "", nil
				}
				xb, err := b64urlDecode(xStr)
				if err != nil {
					return "", nil, false, "DataError", fmt.Errorf("DataError: invalid X25519 JWK public key")
				}
				pub, err := ecdh.X25519().NewPublicKey(xb)
				if err != nil {
					return "", nil, false, "DataError", err
				}
				formats, err := buildX25519KeyFormats(nil, pub)
				if err != nil {
					return "", nil, false, "DataError", err
				}
				formats["type"] = "public"
				b, _ := json.Marshal(formats)
				return string(b), nil, false, "", nil
			default:
				return "", nil, false, "NotSupportedError", fmt.Errorf("NotSupportedError: Unsupported format %q", format)
			}

		case "RSASSA-PKCS1-V1_5", "RSA-PSS", "RSA-OAEP":
			switch format {
			case "pkcs8":
				parsed, err := x509.ParsePKCS8PrivateKey(payload)
				if err != nil {
					if priv1, err1 := x509.ParsePKCS1PrivateKey(payload); err1 == nil {
						parsed = priv1
					} else {
						return "", nil, false, "DataError", err
					}
				}
				priv, ok := parsed.(*rsa.PrivateKey)
				if !ok {
					return "", nil, false, "DataError", fmt.Errorf("DataError: not an RSA private key")
				}
				formats, err := buildRSAKeyFormats(priv, &priv.PublicKey)
				if err != nil {
					return "", nil, false, "DataError", err
				}
				formats["type"] = "private"
				b, _ := json.Marshal(formats)
				return string(b), nil, false, "", nil
			case "spki":
				parsed, err := x509.ParsePKIXPublicKey(payload)
				if err != nil {
					if pub1, err1 := x509.ParsePKCS1PublicKey(payload); err1 == nil {
						parsed = pub1
					} else {
						return "", nil, false, "DataError", err
					}
				}
				pub, ok := parsed.(*rsa.PublicKey)
				if !ok {
					return "", nil, false, "DataError", fmt.Errorf("DataError: not an RSA public key")
				}
				formats, err := buildRSAKeyFormats(nil, pub)
				if err != nil {
					return "", nil, false, "DataError", err
				}
				formats["type"] = "public"
				b, _ := json.Marshal(formats)
				return string(b), nil, false, "", nil
			case "jwk":
				nStr, _ := req.JWK["n"].(string)
				eStr, _ := req.JWK["e"].(string)
				dStr, _ := req.JWK["d"].(string)
				nb, nerr := b64urlDecode(nStr)
				eb, eerr := b64urlDecode(eStr)
				if nerr != nil || eerr != nil || len(nb) == 0 || len(eb) == 0 {
					return "", nil, false, "DataError", fmt.Errorf("DataError: invalid RSA JWK")
				}
				eInt := int(new(big.Int).SetBytes(eb).Int64())
				pub := &rsa.PublicKey{N: new(big.Int).SetBytes(nb), E: eInt}
				if dStr != "" {
					db, derr := b64urlDecode(dStr)
					if derr != nil || len(db) == 0 {
						return "", nil, false, "DataError", fmt.Errorf("DataError: invalid RSA JWK private exponent")
					}
					priv := &rsa.PrivateKey{PublicKey: *pub, D: new(big.Int).SetBytes(db)}
					pStr, _ := req.JWK["p"].(string)
					qStr, _ := req.JWK["q"].(string)
					if pStr != "" && qStr != "" {
						pb, _ := b64urlDecode(pStr)
						qb, _ := b64urlDecode(qStr)
						if len(pb) > 0 && len(qb) > 0 {
							priv.Primes = []*big.Int{new(big.Int).SetBytes(pb), new(big.Int).SetBytes(qb)}
						}
					}
					formats, err := buildRSAKeyFormats(priv, pub)
					if err != nil {
						return "", nil, false, "DataError", err
					}
					formats["type"] = "private"
					b, _ := json.Marshal(formats)
					return string(b), nil, false, "", nil
				}
				formats, err := buildRSAKeyFormats(nil, pub)
				if err != nil {
					return "", nil, false, "DataError", err
				}
				formats["type"] = "public"
				b, _ := json.Marshal(formats)
				return string(b), nil, false, "", nil
			default:
				return "", nil, false, "NotSupportedError", fmt.Errorf("NotSupportedError: Unsupported format %q", format)
			}

		default:
			return "", nil, false, "NotSupportedError", fmt.Errorf("NotSupportedError: Unrecognized algorithm %q", req.Alg)
		}

	case "sign":
		if req.KeyLen <= 0 || req.KeyLen > len(payload) {
			return "", nil, false, "InvalidAccessError", fmt.Errorf("InvalidAccessError: missing private key")
		}
		keyBytes := payload[:req.KeyLen]
		data := payload[req.KeyLen:]
		parsed, err := x509.ParsePKCS8PrivateKey(keyBytes)
		if err != nil {
			return "", nil, false, "InvalidAccessError", err
		}
		switch algUpper {
		case "ECDSA":
			priv, ok := parsed.(*ecdsa.PrivateKey)
			if !ok {
				return "", nil, false, "InvalidAccessError", fmt.Errorf("InvalidAccessError: key is not ECDSA")
			}
			_, hfn, herr := cryptoHashByName(req.Hash)
			if herr != nil {
				return "", nil, false, "NotSupportedError", herr
			}
			h := hfn()
			_, _ = h.Write(data)
			digest := h.Sum(nil)
			if strings.EqualFold(req.Format, "der") {
				sig, serr := ecdsa.SignASN1(rand.Reader, priv, digest)
				if serr != nil {
					return "", nil, false, "OperationError", serr
				}
				return "", sig, true, "", nil
			}
			r, s, serr := ecdsa.Sign(rand.Reader, priv, digest)
			if serr != nil {
				return "", nil, false, "OperationError", serr
			}
			coordSize := (priv.Curve.Params().BitSize + 7) / 8
			sig := make([]byte, 2*coordSize)
			copy(sig[:coordSize], padBigInt(r, coordSize))
			copy(sig[coordSize:], padBigInt(s, coordSize))
			return "", sig, true, "", nil

		case "ED25519", "NODE-ED25519":
			priv, ok := parsed.(ed25519.PrivateKey)
			if !ok {
				return "", nil, false, "InvalidAccessError", fmt.Errorf("InvalidAccessError: key is not Ed25519")
			}
			sig := ed25519.Sign(priv, data)
			return "", sig, true, "", nil

		case "RSASSA-PKCS1-V1_5", "RSA-PSS":
			priv, ok := parsed.(*rsa.PrivateKey)
			if !ok {
				return "", nil, false, "InvalidAccessError", fmt.Errorf("InvalidAccessError: key is not RSA")
			}
			ch, hfn, herr := cryptoHashByName(req.Hash)
			if herr != nil {
				return "", nil, false, "NotSupportedError", herr
			}
			h := hfn()
			_, _ = h.Write(data)
			digest := h.Sum(nil)
			if algUpper == "RSA-PSS" {
				if req.SaltLength < -2 {
					return "", nil, false, "OperationError", fmt.Errorf("OperationError: invalid saltLength %d", req.SaltLength)
				}
				if req.SaltLength == 0 {
					sig, serr := rsaSignPSSZeroSalt(priv, hfn(), digest)
					if serr != nil {
						return "", nil, false, "OperationError", serr
					}
					return "", sig, true, "", nil
				}
				saltLen := req.SaltLength
				if saltLen == -2 {
					saltLen = rsa.PSSSaltLengthAuto
				} else if saltLen == -1 {
					saltLen = rsa.PSSSaltLengthEqualsHash
				}
				sig, serr := rsa.SignPSS(rand.Reader, priv, ch, digest, &rsa.PSSOptions{SaltLength: saltLen, Hash: ch})
				if serr != nil {
					return "", nil, false, "OperationError", serr
				}
				return "", sig, true, "", nil
			}
			sig, serr := rsa.SignPKCS1v15(rand.Reader, priv, ch, digest)
			if serr != nil {
				return "", nil, false, "OperationError", serr
			}
			return "", sig, true, "", nil

		default:
			return "", nil, false, "NotSupportedError", fmt.Errorf("NotSupportedError: Unrecognized sign algorithm %q", req.Alg)
		}

	case "verify":
		if req.KeyLen <= 0 || req.SigLen < 0 || req.KeyLen+req.SigLen > len(payload) {
			return "false", nil, false, "", nil
		}
		keyBytes := payload[:req.KeyLen]
		sig := payload[req.KeyLen : req.KeyLen+req.SigLen]
		data := payload[req.KeyLen+req.SigLen:]
		parsed, err := x509.ParsePKIXPublicKey(keyBytes)
		if err != nil {
			return "false", nil, false, "", nil
		}
		switch algUpper {
		case "ECDSA":
			pub, ok := parsed.(*ecdsa.PublicKey)
			if !ok {
				return "false", nil, false, "", nil
			}
			_, hfn, herr := cryptoHashByName(req.Hash)
			if herr != nil {
				return "", nil, false, "NotSupportedError", herr
			}
			h := hfn()
			_, _ = h.Write(data)
			digest := h.Sum(nil)
			if strings.EqualFold(req.Format, "der") {
				if ecdsa.VerifyASN1(pub, digest, sig) {
					return "true", nil, false, "", nil
				}
				return "false", nil, false, "", nil
			}
			coordSize := (pub.Curve.Params().BitSize + 7) / 8
			if len(sig) != 2*coordSize {
				return "false", nil, false, "", nil
			}
			r := new(big.Int).SetBytes(sig[:coordSize])
			s := new(big.Int).SetBytes(sig[coordSize:])
			if ecdsa.Verify(pub, digest, r, s) {
				return "true", nil, false, "", nil
			}
			return "false", nil, false, "", nil

		case "ED25519", "NODE-ED25519":
			pub, ok := parsed.(ed25519.PublicKey)
			if !ok || len(sig) != ed25519.SignatureSize {
				return "false", nil, false, "", nil
			}
			if ed25519.Verify(pub, data, sig) {
				return "true", nil, false, "", nil
			}
			return "false", nil, false, "", nil

		case "RSASSA-PKCS1-V1_5", "RSA-PSS":
			pub, ok := parsed.(*rsa.PublicKey)
			if !ok {
				return "false", nil, false, "", nil
			}
			ch, hfn, herr := cryptoHashByName(req.Hash)
			if herr != nil {
				return "", nil, false, "NotSupportedError", herr
			}
			h := hfn()
			_, _ = h.Write(data)
			digest := h.Sum(nil)
			if algUpper == "RSA-PSS" {
				if req.SaltLength < -2 {
					return "false", nil, false, "", nil
				}
				if req.SaltLength == 0 {
					if rsaVerifyPSSZeroSalt(pub, hfn(), digest, sig) == nil {
						return "true", nil, false, "", nil
					}
					return "false", nil, false, "", nil
				}
				saltLen := req.SaltLength
				if saltLen == -2 {
					saltLen = rsa.PSSSaltLengthAuto
				} else if saltLen == -1 {
					saltLen = rsa.PSSSaltLengthEqualsHash
				}
				if rsa.VerifyPSS(pub, ch, digest, sig, &rsa.PSSOptions{SaltLength: saltLen, Hash: ch}) == nil {
					return "true", nil, false, "", nil
				}
				return "false", nil, false, "", nil
			}
			if rsa.VerifyPKCS1v15(pub, ch, digest, sig) == nil {
				return "true", nil, false, "", nil
			}
			return "false", nil, false, "", nil

		default:
			return "", nil, false, "NotSupportedError", fmt.Errorf("NotSupportedError: Unrecognized verify algorithm %q", req.Alg)
		}

	case "encrypt":
		if algUpper != "RSA-OAEP" {
			return "", nil, false, "NotSupportedError", fmt.Errorf("NotSupportedError: Unrecognized encrypt algorithm %q", req.Alg)
		}
		if req.KeyLen <= 0 || req.LabelLen < 0 || req.KeyLen+req.LabelLen > len(payload) {
			return "", nil, false, "OperationError", fmt.Errorf("OperationError: invalid RSA-OAEP payload")
		}
		keyBytes := payload[:req.KeyLen]
		label := payload[req.KeyLen : req.KeyLen+req.LabelLen]
		data := payload[req.KeyLen+req.LabelLen:]
		parsed, err := x509.ParsePKIXPublicKey(keyBytes)
		if err != nil {
			return "", nil, false, "InvalidAccessError", err
		}
		pub, ok := parsed.(*rsa.PublicKey)
		if !ok {
			return "", nil, false, "InvalidAccessError", fmt.Errorf("InvalidAccessError: key is not RSA")
		}
		_, hfn, herr := cryptoHashByName(req.Hash)
		if herr != nil {
			return "", nil, false, "NotSupportedError", herr
		}
		ct, err := rsa.EncryptOAEP(hfn(), rand.Reader, pub, data, label)
		if err != nil {
			return "", nil, false, "OperationError", err
		}
		return "", ct, true, "", nil

	case "decrypt":
		if algUpper != "RSA-OAEP" {
			return "", nil, false, "NotSupportedError", fmt.Errorf("NotSupportedError: Unrecognized decrypt algorithm %q", req.Alg)
		}
		if req.KeyLen <= 0 || req.LabelLen < 0 || req.KeyLen+req.LabelLen > len(payload) {
			return "", nil, false, "OperationError", fmt.Errorf("OperationError: invalid RSA-OAEP payload")
		}
		keyBytes := payload[:req.KeyLen]
		label := payload[req.KeyLen : req.KeyLen+req.LabelLen]
		data := payload[req.KeyLen+req.LabelLen:]
		parsed, err := x509.ParsePKCS8PrivateKey(keyBytes)
		if err != nil {
			return "", nil, false, "InvalidAccessError", err
		}
		priv, ok := parsed.(*rsa.PrivateKey)
		if !ok {
			return "", nil, false, "InvalidAccessError", fmt.Errorf("InvalidAccessError: key is not RSA")
		}
		_, hfn, herr := cryptoHashByName(req.Hash)
		if herr != nil {
			return "", nil, false, "NotSupportedError", herr
		}
		pt, err := rsa.DecryptOAEP(hfn(), rand.Reader, priv, data, label)
		if err != nil {
			return "", nil, false, "OperationError", err
		}
		return "", pt, true, "", nil

	case "parseKey":
		m, err := parseAnyAsymmetricKey(payload)
		if err != nil {
			return "", nil, false, "ERR_OSSL_UNSUPPORTED", err
		}
		b, _ := json.Marshal(m)
		return string(b), nil, false, "", nil

	case "deriveBits":
		if req.KeyLen <= 0 || req.KeyLen > len(payload) {
			return "", nil, false, "OperationError", fmt.Errorf("OperationError: invalid deriveBits keys")
		}
		privBytes := payload[:req.KeyLen]
		pubBytes := payload[req.KeyLen:]
		parsedPriv, err := x509.ParsePKCS8PrivateKey(privBytes)
		if err != nil {
			return "", nil, false, "InvalidAccessError", err
		}
		parsedPub, err := x509.ParsePKIXPublicKey(pubBytes)
		if err != nil {
			return "", nil, false, "InvalidAccessError", err
		}
		switch p := parsedPriv.(type) {
		case *ecdsa.PrivateKey:
			pub, ok := parsedPub.(*ecdsa.PublicKey)
			if !ok {
				return "", nil, false, "InvalidAccessError", fmt.Errorf("InvalidAccessError: public key is not EC")
			}
			ecdhPriv, err := p.ECDH()
			if err != nil {
				return "", nil, false, "OperationError", err
			}
			ecdhPub, err := pub.ECDH()
			if err != nil {
				return "", nil, false, "OperationError", err
			}
			secret, err := ecdhPriv.ECDH(ecdhPub)
			if err != nil {
				return "", nil, false, "OperationError", err
			}
			return "", secret, true, "", nil
		case *ecdh.PrivateKey:
			pub, ok := parsedPub.(*ecdh.PublicKey)
			if !ok {
				return "", nil, false, "InvalidAccessError", fmt.Errorf("InvalidAccessError: public key is not X25519")
			}
			secret, err := p.ECDH(pub)
			if err != nil {
				return "", nil, false, "OperationError", err
			}
			return "", secret, true, "", nil
		default:
			return "", nil, false, "NotSupportedError", fmt.Errorf("NotSupportedError: key does not support deriveBits")
		}

	case "ecdhRaw":
		curve, coordSize, err := curveByName(req.NamedCurve)
		if err != nil {
			return "", nil, false, "ERR_CRYPTO_INVALID_CURVE", err
		}
		switch req.Format {
		case "generate":
			priv, err := ecdsa.GenerateKey(curve, rand.Reader)
			if err != nil {
				return "", nil, false, "OperationError", err
			}
			pubBytes := marshalUncompressedECPoint(curve, priv.X, priv.Y)
			privBytes := padBigInt(priv.D, coordSize)
			b, _ := json.Marshal(map[string]any{
				"priv": base64.StdEncoding.EncodeToString(privBytes),
				"pub":  base64.StdEncoding.EncodeToString(pubBytes),
			})
			return string(b), nil, false, "", nil
		case "fromPriv":
			x, y := curve.ScalarBaseMult(payload)
			pubBytes := marshalUncompressedECPoint(curve, x, y)
			return "", pubBytes, true, "", nil
		case "compute":
			if req.KeyLen <= 0 || req.KeyLen > len(payload) {
				return "", nil, false, "ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY", fmt.Errorf("invalid ECDH payload")
			}
			privBytes := payload[:req.KeyLen]
			otherPub := payload[req.KeyLen:]
			x, y, err := unmarshalUncompressedECPoint(curve, otherPub)
			if err != nil {
				return "", nil, false, "ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY", err
			}
			sx, _ := curve.ScalarMult(x, y, privBytes)
			return "", padBigInt(sx, coordSize), true, "", nil
		default:
			return "", nil, false, "EINVAL", fmt.Errorf("unknown ecdhRaw format")
		}

	case "dhCompute":
		// payload = [prime (KeyLen)] [priv (SigLen)] [otherPub (rest)]
		if req.KeyLen <= 0 || req.SigLen <= 0 || req.KeyLen+req.SigLen > len(payload) {
			return "", nil, false, "EINVAL", fmt.Errorf("invalid dhCompute payload")
		}
		p := new(big.Int).SetBytes(payload[:req.KeyLen])
		priv := new(big.Int).SetBytes(payload[req.KeyLen : req.KeyLen+req.SigLen])
		other := new(big.Int).SetBytes(payload[req.KeyLen+req.SigLen:])
		if p.Sign() <= 0 {
			return "", nil, false, "EINVAL", fmt.Errorf("invalid DH prime")
		}
		secret := new(big.Int).Exp(other, priv, p)
		return "", padBigInt(secret, (p.BitLen()+7)/8), true, "", nil

	case "generatePrime":
		bits := req.ModulusLength
		if bits < 2 || bits > 8192 {
			return "", nil, false, "ERR_OUT_OF_RANGE", fmt.Errorf("invalid prime bit length %d", bits)
		}
		if req.Safe {
			if bits < 3 {
				return "", nil, false, "ERR_OUT_OF_RANGE", fmt.Errorf("safe prime bit length must be >= 3")
			}
			for {
				if err := en.ctx.Err(); err != nil {
					return "", nil, false, "OperationError", err
				}
				q, err := rand.Prime(rand.Reader, bits-1)
				if err != nil {
					return "", nil, false, "OperationError", err
				}
				p := new(big.Int).Lsh(q, 1)
				p.Add(p, big.NewInt(1))
				if p.BitLen() == bits && p.ProbablyPrime(20) {
					return "", p.Bytes(), true, "", nil
				}
			}
		}
		p, err := rand.Prime(rand.Reader, bits)
		if err != nil {
			return "", nil, false, "OperationError", err
		}
		return "", p.Bytes(), true, "", nil

	case "checkPrime":
		if len(payload) == 0 {
			return "false", nil, false, "", nil
		}
		checks := req.SaltLength
		if checks <= 0 {
			checks = 20
		}
		n := new(big.Int).SetBytes(payload)
		if n.ProbablyPrime(checks) {
			return "true", nil, false, "", nil
		}
		return "false", nil, false, "", nil

	case "rsaPKCS1Encrypt":
		if req.KeyLen <= 0 || req.KeyLen > len(payload) {
			return "", nil, false, "OperationError", fmt.Errorf("OperationError: invalid RSA-PKCS1 payload")
		}
		parsed, err := x509.ParsePKIXPublicKey(payload[:req.KeyLen])
		if err != nil {
			return "", nil, false, "InvalidAccessError", err
		}
		pub, ok := parsed.(*rsa.PublicKey)
		if !ok {
			return "", nil, false, "InvalidAccessError", fmt.Errorf("InvalidAccessError: key is not RSA")
		}
		ct, err := rsa.EncryptPKCS1v15(rand.Reader, pub, payload[req.KeyLen:])
		if err != nil {
			return "", nil, false, "OperationError", err
		}
		return "", ct, true, "", nil

	case "rsaPKCS1Decrypt":
		if req.KeyLen <= 0 || req.KeyLen > len(payload) {
			return "", nil, false, "OperationError", fmt.Errorf("OperationError: invalid RSA-PKCS1 payload")
		}
		parsed, err := x509.ParsePKCS8PrivateKey(payload[:req.KeyLen])
		if err != nil {
			return "", nil, false, "InvalidAccessError", err
		}
		priv, ok := parsed.(*rsa.PrivateKey)
		if !ok {
			return "", nil, false, "InvalidAccessError", fmt.Errorf("InvalidAccessError: key is not RSA")
		}
		pt, err := rsa.DecryptPKCS1v15(rand.Reader, priv, payload[req.KeyLen:])
		if err != nil {
			return "", nil, false, "OperationError", err
		}
		return "", pt, true, "", nil

	case "rsaPrivEncrypt":
		if req.KeyLen <= 0 || req.KeyLen > len(payload) {
			return "", nil, false, "OperationError", fmt.Errorf("OperationError: invalid RSA privateEncrypt payload")
		}
		parsed, err := x509.ParsePKCS8PrivateKey(payload[:req.KeyLen])
		if err != nil {
			return "", nil, false, "InvalidAccessError", err
		}
		priv, ok := parsed.(*rsa.PrivateKey)
		if !ok {
			return "", nil, false, "InvalidAccessError", fmt.Errorf("InvalidAccessError: key is not RSA")
		}
		ct, err := rsa.SignPKCS1v15(rand.Reader, priv, 0, payload[req.KeyLen:])
		if err != nil {
			return "", nil, false, "OperationError", err
		}
		return "", ct, true, "", nil

	case "rsaPubDecrypt":
		if req.KeyLen <= 0 || req.KeyLen > len(payload) {
			return "", nil, false, "OperationError", fmt.Errorf("OperationError: invalid RSA publicDecrypt payload")
		}
		parsed, err := x509.ParsePKIXPublicKey(payload[:req.KeyLen])
		if err != nil {
			return "", nil, false, "InvalidAccessError", err
		}
		pub, ok := parsed.(*rsa.PublicKey)
		if !ok {
			return "", nil, false, "InvalidAccessError", fmt.Errorf("InvalidAccessError: key is not RSA")
		}
		c := new(big.Int).SetBytes(payload[req.KeyLen:])
		m := new(big.Int).Exp(c, big.NewInt(int64(pub.E)), pub.N)
		em := padBigInt(m, pub.Size())
		if len(em) < 11 || em[0] != 0 || em[1] != 1 {
			return "", nil, false, "OperationError", fmt.Errorf("OperationError: RSA publicDecrypt padding error")
		}
		sepIdx := -1
		for i := 2; i < len(em); i++ {
			if em[i] == 0 {
				sepIdx = i
				break
			}
			if em[i] != 0xff {
				return "", nil, false, "OperationError", fmt.Errorf("OperationError: RSA publicDecrypt invalid padding byte")
			}
		}
		if sepIdx < 10 {
			return "", nil, false, "OperationError", fmt.Errorf("OperationError: RSA publicDecrypt missing separator")
		}
		return "", em[sepIdx+1:], true, "", nil

	case "parseX509":
		raw := payload
		if block, _ := pem.Decode(payload); block != nil {
			raw = block.Bytes
		}
		cert, err := x509.ParseCertificate(raw)
		if err != nil {
			return "", nil, false, "ERR_OSSL_ASN1_NOT_ENOUGH_DATA", err
		}
		spki, _ := x509.MarshalPKIXPublicKey(cert.PublicKey)
		fp1 := sha1.Sum(cert.Raw)
		fp256 := sha256.Sum256(cert.Raw)
		fp512 := sha512.Sum512(cert.Raw)
		fmtColons := func(b []byte) string {
			parts := make([]string, len(b))
			for i, v := range b {
				parts[i] = fmt.Sprintf("%02X", v)
			}
			return strings.Join(parts, ":")
		}
		b, _ := json.Marshal(map[string]any{
			"subject":        cert.Subject.String(),
			"issuer":         cert.Issuer.String(),
			"validFrom":      cert.NotBefore.UTC().Format(time.RFC1123),
			"validTo":        cert.NotAfter.UTC().Format(time.RFC1123),
			"validFromDate":  cert.NotBefore.UTC().Format(time.RFC3339),
			"validToDate":    cert.NotAfter.UTC().Format(time.RFC3339),
			"serialNumber":   strings.ToUpper(cert.SerialNumber.Text(16)),
			"fingerprint":    fmtColons(fp1[:]),
			"fingerprint256": fmtColons(fp256[:]),
			"fingerprint512": fmtColons(fp512[:]),
			"ca":             cert.IsCA,
			"raw":            base64.StdEncoding.EncodeToString(cert.Raw),
			"spki":           base64.StdEncoding.EncodeToString(spki),
		})
		return string(b), nil, false, "", nil

	default:
		return "", nil, false, "NotSupportedError", fmt.Errorf("NotSupportedError: Unknown WebCrypto op %q", req.Op)
	}
}

// ---- Zlib ----

type zlibFlushWriter interface {
	Write(p []byte) (int, error)
	Flush() error
	Close() error
}

type zlibStreamState struct {
	buf     bytes.Buffer
	w       zlibFlushWriter
	emitted int64
	maxOut  int64
}

func (en *rtEntry) opZlibTransform(argsStr string, data []byte) (string, []byte, bool, string, error) {
	mode := argsStr
	level := flate.DefaultCompression
	maxOut := int64(maxHostBufferBytes)
	streamID := 0
	doFlush := false
	doFinish := false
	doCancel := false
	if strings.HasPrefix(strings.TrimSpace(argsStr), "{") {
		var req struct {
			Mode            string `json:"mode"`
			Level           *int   `json:"level"`
			MaxOutputLength *int64 `json:"maxOutputLength"`
			StreamID        int    `json:"streamId"`
			Flush           bool   `json:"flush"`
			Finish          bool   `json:"finish"`
			Cancel          bool   `json:"cancel"`
		}
		if err := json.Unmarshal([]byte(argsStr), &req); err == nil && req.Mode != "" {
			mode = req.Mode
			streamID = req.StreamID
			doFlush = req.Flush
			doFinish = req.Finish
			doCancel = req.Cancel
			if req.Level != nil {
				if *req.Level < -1 || *req.Level > 9 {
					return "", nil, false, "ERR_OUT_OF_RANGE", fmt.Errorf("ERR_OUT_OF_RANGE: The value of \"level\" is out of range. It must be >= -1 and <= 9. Received %d", *req.Level)
				}
				level = *req.Level
			}
			if req.MaxOutputLength != nil {
				if *req.MaxOutputLength < 1 {
					return "", nil, false, "ERR_OUT_OF_RANGE", fmt.Errorf("ERR_OUT_OF_RANGE: The value of \"maxOutputLength\" is out of range. It must be >= 1. Received %d", *req.MaxOutputLength)
				}
				if *req.MaxOutputLength < maxOut {
					maxOut = *req.MaxOutputLength
				}
			}
		}
	}
	if streamID > 0 && (mode == "gzip" || mode == "deflate" || mode == "deflateRaw") {
		en.zlibMu.Lock()
		defer en.zlibMu.Unlock()
		if en.zlibStreams == nil {
			en.zlibStreams = make(map[int]*zlibStreamState)
		}
		if doCancel {
			delete(en.zlibStreams, streamID)
			return "", nil, true, "", nil
		}
		st, ok := en.zlibStreams[streamID]
		if !ok {
			st = &zlibStreamState{maxOut: maxOut}
			var err error
			switch mode {
			case "gzip":
				st.w, err = gzip.NewWriterLevel(&st.buf, level)
			case "deflate":
				st.w, err = zlib.NewWriterLevel(&st.buf, level)
			case "deflateRaw":
				st.w, err = flate.NewWriter(&st.buf, level)
			}
			if err != nil {
				return "", nil, false, "Z_DATA_ERROR", err
			}
			en.zlibStreams[streamID] = st
		}
		if len(data) > 0 {
			if _, err := st.w.Write(data); err != nil {
				delete(en.zlibStreams, streamID)
				return "", nil, false, "Z_DATA_ERROR", err
			}
		}
		if doFlush && !doFinish {
			if err := st.w.Flush(); err != nil {
				delete(en.zlibStreams, streamID)
				return "", nil, false, "Z_DATA_ERROR", err
			}
		}
		if doFinish {
			err := st.w.Close()
			delete(en.zlibStreams, streamID)
			if err != nil {
				return "", nil, false, "Z_DATA_ERROR", err
			}
		}
		out := append([]byte(nil), st.buf.Bytes()...)
		st.buf.Reset()
		st.emitted += int64(len(out))
		if st.emitted > st.maxOut {
			delete(en.zlibStreams, streamID)
			return "", nil, false, "ERR_BUFFER_TOO_LARGE", fmt.Errorf("ERR_BUFFER_TOO_LARGE: Cannot create a Buffer larger than %d bytes", st.maxOut)
		}
		return "", out, true, "", nil
	}
	checkCap := func(out []byte) (string, []byte, bool, string, error) {
		if int64(len(out)) > maxOut {
			return "", nil, false, "ERR_BUFFER_TOO_LARGE", fmt.Errorf("ERR_BUFFER_TOO_LARGE: Cannot create a Buffer larger than %d bytes", maxOut)
		}
		return "", out, true, "", nil
	}
	switch mode {
	case "gzip":
		var buf bytes.Buffer
		w, err := gzip.NewWriterLevel(&buf, level)
		if err != nil {
			return "", nil, false, "Z_DATA_ERROR", err
		}
		if _, err := w.Write(data); err != nil {
			return "", nil, false, "Z_DATA_ERROR", err
		}
		if err := w.Close(); err != nil {
			return "", nil, false, "Z_DATA_ERROR", err
		}
		return checkCap(buf.Bytes())

	case "gunzip":
		r, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			return "", nil, false, "Z_DATA_ERROR", err
		}
		defer r.Close()
		out, err := readAllBounded(r, maxOut)
		if err != nil {
			if strings.HasPrefix(err.Error(), "ERR_OUT_OF_RANGE") {
				return "", nil, false, "ERR_BUFFER_TOO_LARGE", err
			}
			return "", nil, false, "Z_DATA_ERROR", err
		}
		return "", out, true, "", nil

	case "deflate":
		var buf bytes.Buffer
		w, err := zlib.NewWriterLevel(&buf, level)
		if err != nil {
			return "", nil, false, "Z_DATA_ERROR", err
		}
		if _, err := w.Write(data); err != nil {
			return "", nil, false, "Z_DATA_ERROR", err
		}
		if err := w.Close(); err != nil {
			return "", nil, false, "Z_DATA_ERROR", err
		}
		return checkCap(buf.Bytes())

	case "inflate":
		r, err := zlib.NewReader(bytes.NewReader(data))
		if err != nil {
			return "", nil, false, "Z_DATA_ERROR", err
		}
		defer r.Close()
		out, err := readAllBounded(r, maxOut)
		if err != nil {
			if strings.HasPrefix(err.Error(), "ERR_OUT_OF_RANGE") {
				return "", nil, false, "ERR_BUFFER_TOO_LARGE", err
			}
			return "", nil, false, "Z_DATA_ERROR", err
		}
		return "", out, true, "", nil

	case "deflateRaw":
		var buf bytes.Buffer
		w, err := flate.NewWriter(&buf, level)
		if err != nil {
			return "", nil, false, "Z_DATA_ERROR", err
		}
		if _, err := w.Write(data); err != nil {
			return "", nil, false, "Z_DATA_ERROR", err
		}
		if err := w.Close(); err != nil {
			return "", nil, false, "Z_DATA_ERROR", err
		}
		return checkCap(buf.Bytes())

	case "inflateRaw":
		r := flate.NewReader(bytes.NewReader(data))
		defer r.Close()
		out, err := readAllBounded(r, maxOut)
		if err != nil {
			if strings.HasPrefix(err.Error(), "ERR_OUT_OF_RANGE") {
				return "", nil, false, "ERR_BUFFER_TOO_LARGE", err
			}
			return "", nil, false, "Z_DATA_ERROR", err
		}
		return "", out, true, "", nil

	case "brotliCompress", "brotli_encode":
		out := brotliCompress(data)
		return checkCap(out)

	case "brotliDecompress", "brotli_decode":
		out, errCode, err := brotliDecompress(data, maxOut)
		if err != nil {
			return "", nil, false, errCode, err
		}
		return "", out, true, "", nil

	case "zstdCompress", "zstd_encode":
		out := zstdCompress(data)
		return checkCap(out)

	case "zstdDecompress", "zstd_decode":
		out, errCode, err := zstdDecompress(data, maxOut)
		if err != nil {
			return "", nil, false, errCode, err
		}
		return "", out, true, "", nil

	case "unzip":
		targetMode := "inflate"
		if len(data) >= 2 && data[0] == 0x1f && data[1] == 0x8b {
			targetMode = "gunzip"
		}
		if strings.HasPrefix(strings.TrimSpace(argsStr), "{") {
			return en.opZlibTransform(strings.Replace(argsStr, `"unzip"`, `"`+targetMode+`"`, 1), data)
		}
		return en.opZlibTransform(targetMode, data)

	default:
		return "", nil, false, "EINVAL", fmt.Errorf("unknown zlib mode %q", mode)
	}
}

// ---- OS & DNS ----

func (en *rtEntry) opOSNetworkInterfaces() (string, []byte, bool, string, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return "{}", nil, false, "", nil
	}
	res := make(map[string][]map[string]any)
	for _, iface := range ifaces {
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		mac := iface.HardwareAddr.String()
		if mac == "" {
			mac = "00:00:00:00:00:00"
		}
		internal := iface.Flags&net.FlagLoopback != 0
		var list []map[string]any
		for _, a := range addrs {
			ipNet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			family := "IPv4"
			if ipNet.IP.To4() == nil {
				family = "IPv6"
			}
			list = append(list, map[string]any{
				"address":  ipNet.IP.String(),
				"netmask":  net.IP(ipNet.Mask).String(),
				"family":   family,
				"mac":      mac,
				"internal": internal,
				"cidr":     ipNet.String(),
			})
		}
		if len(list) > 0 {
			res[iface.Name] = list
		}
	}
	b, _ := json.Marshal(res)
	return string(b), nil, false, "", nil
}

func (en *rtEntry) opOSUserInfo() (string, []byte, bool, string, error) {
	u, err := user.Current()
	home, _ := os.UserHomeDir()
	username := "user"
	uid := -1
	gid := -1
	if err == nil && u != nil {
		username = u.Username
		if u.HomeDir != "" {
			home = u.HomeDir
		}
		if v, e := strconv.Atoi(u.Uid); e == nil {
			uid = v
		}
		if v, e := strconv.Atoi(u.Gid); e == nil {
			gid = v
		}
	}
	b, _ := json.Marshal(map[string]any{
		"username": username,
		"uid":      uid,
		"gid":      gid,
		"homedir":  home,
		"shell":    en.shellPath,
	})
	return string(b), nil, false, "", nil
}

func (en *rtEntry) opDNSLookup(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		Hostname string `json:"hostname"`
		Family   int    `json:"family"`
		All      bool   `json:"all"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		req.Hostname = argsStr
	}
	if err := en.checkNetHost(req.Hostname); err != nil {
		return "", nil, false, "EACCES", err
	}
	ips, err := net.DefaultResolver.LookupIPAddr(en.ctx, req.Hostname)
	if err != nil {
		return "", nil, false, "ENOTFOUND", fmt.Errorf("getaddrinfo ENOTFOUND %s", req.Hostname)
	}
	type addrEntry struct {
		Address string `json:"address"`
		Family  int    `json:"family"`
	}
	var matches []addrEntry
	for _, ip := range ips {
		fam := 4
		if ip.IP.To4() == nil {
			fam = 6
		}
		if req.Family != 0 && req.Family != fam {
			continue
		}
		matches = append(matches, addrEntry{Address: ip.IP.String(), Family: fam})
	}
	if len(matches) == 0 {
		return "", nil, false, "ENOTFOUND", fmt.Errorf("getaddrinfo ENOTFOUND %s", req.Hostname)
	}
	if req.All {
		b, _ := json.Marshal(matches)
		return string(b), nil, false, "", nil
	}
	b, _ := json.Marshal(matches[0])
	return string(b), nil, false, "", nil
}

func (en *rtEntry) opDNSResolve(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		Hostname string `json:"hostname"`
		RRType   string `json:"rrtype"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		req.Hostname = argsStr
	}
	if err := en.checkNetHost(req.Hostname); err != nil {
		return "", nil, false, "EACCES", err
	}
	rr := strings.ToUpper(strings.TrimSpace(req.RRType))
	if rr == "" {
		rr = "A"
	}
	switch rr {
	case "A":
		ips, err := net.DefaultResolver.LookupIP(en.ctx, "ip4", req.Hostname)
		if err != nil || len(ips) == 0 {
			return "", nil, false, "ENOTFOUND", fmt.Errorf("queryA ENOTFOUND %s", req.Hostname)
		}
		out := make([]string, 0, len(ips))
		for _, ip := range ips {
			out = append(out, ip.String())
		}
		b, _ := json.Marshal(out)
		return string(b), nil, false, "", nil
	case "AAAA":
		ips, err := net.DefaultResolver.LookupIP(en.ctx, "ip6", req.Hostname)
		if err != nil || len(ips) == 0 {
			return "", nil, false, "ENOTFOUND", fmt.Errorf("queryAAAA ENOTFOUND %s", req.Hostname)
		}
		out := make([]string, 0, len(ips))
		for _, ip := range ips {
			out = append(out, ip.String())
		}
		b, _ := json.Marshal(out)
		return string(b), nil, false, "", nil
	case "CNAME":
		cname, err := net.DefaultResolver.LookupCNAME(en.ctx, req.Hostname)
		if err != nil {
			return "", nil, false, "ENOTFOUND", fmt.Errorf("queryCname ENOTFOUND %s", req.Hostname)
		}
		b, _ := json.Marshal([]string{strings.TrimSuffix(cname, ".")})
		return string(b), nil, false, "", nil
	case "TXT":
		txts, err := net.DefaultResolver.LookupTXT(en.ctx, req.Hostname)
		if err != nil {
			return "", nil, false, "ENOTFOUND", fmt.Errorf("queryTxt ENOTFOUND %s", req.Hostname)
		}
		out := make([][]string, 0, len(txts))
		for _, t := range txts {
			out = append(out, []string{t})
		}
		b, _ := json.Marshal(out)
		return string(b), nil, false, "", nil
	case "MX":
		mxs, err := net.DefaultResolver.LookupMX(en.ctx, req.Hostname)
		if err != nil {
			return "", nil, false, "ENOTFOUND", fmt.Errorf("queryMx ENOTFOUND %s", req.Hostname)
		}
		out := make([]map[string]any, 0, len(mxs))
		for _, m := range mxs {
			out = append(out, map[string]any{
				"exchange": strings.TrimSuffix(m.Host, "."),
				"priority": int(m.Pref),
			})
		}
		b, _ := json.Marshal(out)
		return string(b), nil, false, "", nil
	case "NS":
		nss, err := net.DefaultResolver.LookupNS(en.ctx, req.Hostname)
		if err != nil {
			return "", nil, false, "ENOTFOUND", fmt.Errorf("queryNs ENOTFOUND %s", req.Hostname)
		}
		out := make([]string, 0, len(nss))
		for _, ns := range nss {
			out = append(out, strings.TrimSuffix(ns.Host, "."))
		}
		b, _ := json.Marshal(out)
		return string(b), nil, false, "", nil
	case "SRV":
		_, srvs, err := net.DefaultResolver.LookupSRV(en.ctx, "", "", req.Hostname)
		if err != nil {
			return "", nil, false, "ENOTFOUND", fmt.Errorf("querySrv ENOTFOUND %s", req.Hostname)
		}
		out := make([]map[string]any, 0, len(srvs))
		for _, s := range srvs {
			out = append(out, map[string]any{
				"name":     strings.TrimSuffix(s.Target, "."),
				"port":     int(s.Port),
				"priority": int(s.Priority),
				"weight":   int(s.Weight),
			})
		}
		b, _ := json.Marshal(out)
		return string(b), nil, false, "", nil
	case "PTR":
		ptrs, err := net.DefaultResolver.LookupAddr(en.ctx, req.Hostname)
		if err != nil {
			return "", nil, false, "ENOTFOUND", fmt.Errorf("queryPtr ENOTFOUND %s", req.Hostname)
		}
		out := make([]string, 0, len(ptrs))
		for _, p := range ptrs {
			out = append(out, strings.TrimSuffix(p, "."))
		}
		b, _ := json.Marshal(out)
		return string(b), nil, false, "", nil
	case "SOA":
		nss, err := net.DefaultResolver.LookupNS(en.ctx, req.Hostname)
		nsName := "ns1." + strings.TrimSuffix(req.Hostname, ".")
		if err == nil && len(nss) > 0 {
			nsName = strings.TrimSuffix(nss[0].Host, ".")
		} else {
			if _, ierr := net.DefaultResolver.LookupIPAddr(en.ctx, req.Hostname); ierr != nil {
				return "", nil, false, "ENOTFOUND", fmt.Errorf("querySoa ENOTFOUND %s", req.Hostname)
			}
		}
		b, _ := json.Marshal(map[string]any{
			"nsname":     nsName,
			"hostmaster": "hostmaster." + strings.TrimSuffix(req.Hostname, "."),
			"serial":     1,
			"refresh":    3600,
			"retry":      600,
			"expire":     86400,
			"minttl":     60,
		})
		return string(b), nil, false, "", nil
	case "CAA":
		if _, ierr := net.DefaultResolver.LookupIPAddr(en.ctx, req.Hostname); ierr != nil {
			return "", nil, false, "ENOTFOUND", fmt.Errorf("queryCaa ENOTFOUND %s", req.Hostname)
		}
		return "[]", nil, false, "", nil
	case "NAPTR":
		if _, ierr := net.DefaultResolver.LookupIPAddr(en.ctx, req.Hostname); ierr != nil {
			return "", nil, false, "ENOTFOUND", fmt.Errorf("queryNaptr ENOTFOUND %s", req.Hostname)
		}
		return "[]", nil, false, "", nil
	case "ANY":
		var records []map[string]any
		if ips4, err := net.DefaultResolver.LookupIP(en.ctx, "ip4", req.Hostname); err == nil {
			for _, ip := range ips4 {
				records = append(records, map[string]any{"type": "A", "address": ip.String(), "ttl": 60})
			}
		}
		if ips6, err := net.DefaultResolver.LookupIP(en.ctx, "ip6", req.Hostname); err == nil {
			for _, ip := range ips6 {
				records = append(records, map[string]any{"type": "AAAA", "address": ip.String(), "ttl": 60})
			}
		}
		if txts, err := net.DefaultResolver.LookupTXT(en.ctx, req.Hostname); err == nil {
			for _, t := range txts {
				records = append(records, map[string]any{"type": "TXT", "entries": []string{t}})
			}
		}
		if mxs, err := net.DefaultResolver.LookupMX(en.ctx, req.Hostname); err == nil {
			for _, m := range mxs {
				records = append(records, map[string]any{"type": "MX", "exchange": strings.TrimSuffix(m.Host, "."), "priority": int(m.Pref)})
			}
		}
		if nss, err := net.DefaultResolver.LookupNS(en.ctx, req.Hostname); err == nil {
			for _, ns := range nss {
				records = append(records, map[string]any{"type": "NS", "value": strings.TrimSuffix(ns.Host, ".")})
			}
		}
		if len(records) == 0 {
			return "", nil, false, "ENOTFOUND", fmt.Errorf("queryAny ENOTFOUND %s", req.Hostname)
		}
		b, _ := json.Marshal(records)
		return string(b), nil, false, "", nil
	default:
		return "", nil, false, "EBADNAME", fmt.Errorf("Unknown record type: %s", rr)
	}
}

// ---- HTTP / Fetch / Server ----

type httpFetchReq struct {
	ID                 int32       `json:"id"`
	URL                string      `json:"url"`
	Method             string      `json:"method"`
	Headers            [][2]string `json:"headers"`
	Redirect           string      `json:"redirect"`
	TimeoutMs          int64       `json:"timeoutMs"`
	InsecureSkipVerify bool        `json:"insecureSkipVerify"`
	CA                 string      `json:"ca"`
	Cert               string      `json:"cert"`
	Key                string      `json:"key"`
	RawHTTP            bool        `json:"rawHttp"`
	StreamBody         bool        `json:"streamBody"`
}

var blockedFetchPorts = map[int]bool{
	1: true, 7: true, 9: true, 11: true, 13: true, 15: true, 17: true, 19: true,
	20: true, 21: true, 22: true, 23: true, 25: true, 37: true, 42: true, 43: true,
	53: true, 69: true, 77: true, 79: true, 87: true, 95: true, 101: true, 102: true,
	103: true, 104: true, 109: true, 110: true, 111: true, 113: true, 115: true, 117: true,
	119: true, 123: true, 135: true, 137: true, 139: true, 143: true, 161: true, 179: true,
	389: true, 427: true, 465: true, 512: true, 513: true, 514: true, 515: true, 526: true,
	530: true, 531: true, 532: true, 540: true, 548: true, 554: true, 556: true, 563: true,
	587: true, 601: true, 636: true, 989: true, 990: true, 993: true, 995: true, 1719: true,
	1720: true, 1723: true, 2049: true, 3659: true, 4045: true, 5060: true, 5061: true,
	6566: true, 6665: true, 6666: true, 6667: true, 6668: true, 6669: true, 6697: true,
	10080: true,
}

func isBlockedFetchPort(portStr string) bool {
	if portStr == "" {
		return false
	}
	p, err := strconv.Atoi(portStr)
	if err != nil {
		return false
	}
	if p >= 6000 && p <= 6063 {
		return true
	}
	return blockedFetchPorts[p]
}

type rawRespHeaderCapture struct {
	mu      sync.Mutex
	headers [][2]string
}

type rawRespHeaderConn struct {
	net.Conn
	cap     *rawRespHeaderCapture
	buf     []byte
	doneHdr bool
}

func (c *rawRespHeaderConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if n > 0 && !c.doneHdr && c.cap != nil {
		c.buf = append(c.buf, p[:n]...)
		if idx := bytes.Index(c.buf, []byte("\r\n\r\n")); idx >= 0 {
			c.doneHdr = true
			block := string(c.buf[:idx])
			c.buf = nil
			lines := strings.Split(block, "\r\n")
			var parsed [][2]string
			for i := 1; i < len(lines); i++ {
				line := lines[i]
				if colon := strings.IndexByte(line, ':'); colon > 0 {
					k := strings.TrimSpace(line[:colon])
					v := strings.TrimSpace(line[colon+1:])
					parsed = append(parsed, [2]string{k, v})
				}
			}
			c.cap.mu.Lock()
			c.cap.headers = parsed
			c.cap.mu.Unlock()
		} else if len(c.buf) > 65536 {
			c.doneHdr = true
			c.buf = nil
		}
	}
	return n, err
}

type errReader struct {
	err error
}

func (r *errReader) Read([]byte) (int, error) {
	return 0, r.err
}

func (en *rtEntry) streamHTTPFetch(ctx context.Context, id int32, req httpFetchReq, bodyReader io.Reader) {
	pushErr := func(err error) {
		errMeta, _ := json.Marshal(map[string]any{
			"phase": "error",
			"error": err.Error(),
		})
		en.pushEvent(rtAsyncEvent{id: id, kind: rtEventFetch, json: string(errMeta)})
	}

	rawURL := strings.TrimSpace(req.URL)
	if strings.HasPrefix(strings.ToLower(rawURL), "data:") {
		rest := rawURL[5:]
		commaIdx := strings.IndexByte(rest, ',')
		if commaIdx < 0 {
			pushErr(fmt.Errorf("TypeError: fetch failed: invalid data URL"))
			return
		}
		metaPart := rest[:commaIdx]
		dataPart := rest[commaIdx+1:]
		isBase64 := false
		parts := strings.Split(metaPart, ";")
		var cleanParts []string
		for _, p := range parts {
			if strings.EqualFold(strings.TrimSpace(p), "base64") {
				isBase64 = true
			} else if strings.TrimSpace(p) != "" {
				cleanParts = append(cleanParts, strings.TrimSpace(p))
			}
		}
		contentType := strings.Join(cleanParts, ";")
		if contentType == "" {
			contentType = "text/plain;charset=US-ASCII"
		}
		var payload []byte
		if isBase64 {
			unesc, uerr := url.PathUnescape(dataPart)
			if uerr != nil {
				unesc = dataPart
			}
			cleaned := strings.Map(func(r rune) rune {
				if r == ' ' || r == '\t' || r == '\r' || r == '\n' {
					return -1
				}
				return r
			}, unesc)
			dec, berr := base64.StdEncoding.DecodeString(cleaned)
			if berr != nil {
				dec, berr = base64.RawStdEncoding.DecodeString(strings.TrimRight(cleaned, "="))
				if berr != nil {
					pushErr(fmt.Errorf("TypeError: fetch failed: invalid base64 data URL"))
					return
				}
			}
			payload = dec
		} else {
			unesc, uerr := url.PathUnescape(dataPart)
			if uerr != nil {
				unesc = dataPart
			}
			payload = []byte(unesc)
		}
		meta, _ := json.Marshal(map[string]any{
			"phase":            "headers",
			"status":           200,
			"statusText":       "OK",
			"url":              rawURL,
			"redirected":       false,
			"httpVersion":      "1.1",
			"httpVersionMajor": 1,
			"httpVersionMinor": 1,
			"headers": [][2]string{
				{"content-type", contentType},
				{"content-length", strconv.Itoa(len(payload))},
			},
		})
		en.pushEvent(rtAsyncEvent{id: id, kind: rtEventFetch, json: string(meta)})
		if len(payload) > 0 {
			en.pushEvent(rtAsyncEvent{id: id, kind: rtEventFetch, json: `{"phase":"chunk"}`, bin: payload})
		}
		en.pushEvent(rtAsyncEvent{id: id, kind: rtEventFetch, json: `{"phase":"end"}`})
		return
	}

	method := req.Method
	if method == "" {
		method = "GET"
	}
	httpReq, err := http.NewRequestWithContext(ctx, method, req.URL, bodyReader)
	if err != nil {
		pushErr(err)
		return
	}
	if err := en.checkNetHost(httpReq.URL.Host); err != nil {
		pushErr(err)
		return
	}
	if !req.RawHTTP && isBlockedFetchPort(httpReq.URL.Port()) {
		pushErr(fmt.Errorf("TypeError: fetch failed: bad port"))
		return
	}
	hasUserAgent := false
	hasAcceptEncoding := false
	for _, kv := range req.Headers {
		k := kv[0]
		v := kv[1]
		if strings.EqualFold(k, "user-agent") {
			hasUserAgent = true
		} else if strings.EqualFold(k, "accept-encoding") {
			hasAcceptEncoding = true
		}
		if strings.EqualFold(k, "host") {
			httpReq.Host = v
		}
		if req.RawHTTP {
			httpReq.Header[k] = append(httpReq.Header[k], v)
		} else {
			httpReq.Header.Add(k, v)
		}
	}
	if req.RawHTTP && !hasUserAgent {
		httpReq.Header["User-Agent"] = []string{""}
	}
	if !req.RawHTTP && !hasAcceptEncoding {
		httpReq.Header.Set("Accept-Encoding", "gzip, deflate, br")
	}

	rawCap := &rawRespHeaderCapture{}
	var addrMu sync.Mutex
	var remoteAddrStr, localAddrStr string
	dialer := &net.Dialer{Timeout: 30 * time.Second}
	tr := &http.Transport{
		DisableKeepAlives:  true,
		DisableCompression: true,
		DialContext: func(dctx context.Context, network, addr string) (net.Conn, error) {
			c, derr := dialer.DialContext(dctx, network, addr)
			if derr != nil {
				return nil, derr
			}
			addrMu.Lock()
			if c.RemoteAddr() != nil {
				remoteAddrStr = c.RemoteAddr().String()
			}
			if c.LocalAddr() != nil {
				localAddrStr = c.LocalAddr().String()
			}
			addrMu.Unlock()
			if strings.EqualFold(httpReq.URL.Scheme, "http") {
				return &rawRespHeaderConn{Conn: c, cap: rawCap}, nil
			}
			return c, nil
		},
	}
	if req.CA != "" || req.Cert != "" || req.Key != "" || req.InsecureSkipVerify {
		tlsCfg := &tls.Config{InsecureSkipVerify: req.InsecureSkipVerify}
		if req.CA != "" {
			pool, _ := x509.SystemCertPool()
			if pool == nil {
				pool = x509.NewCertPool()
			}
			if !pool.AppendCertsFromPEM([]byte(req.CA)) {
				pushErr(fmt.Errorf("ERR_OSSL_PEM_NO_START_LINE: invalid CA certificate PEM"))
				return
			}
			tlsCfg.RootCAs = pool
		}
		if req.Cert != "" || req.Key != "" {
			pair, cerr := tls.X509KeyPair([]byte(req.Cert), []byte(req.Key))
			if cerr != nil {
				pushErr(fmt.Errorf("ERR_CRYPTO_INVALID_KEY: %v", cerr))
				return
			}
			tlsCfg.Certificates = []tls.Certificate{pair}
		}
		tr.TLSClientConfig = tlsCfg
	}
	client := &http.Client{Transport: tr}
	if req.TimeoutMs > 0 {
		client.Timeout = time.Duration(req.TimeoutMs) * time.Millisecond
	}
	redirectMode := req.Redirect
	if redirectMode == "" && req.RawHTTP {
		redirectMode = "manual"
	}
	redirected := false
	switch redirectMode {
	case "manual":
		client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		}
	case "error":
		client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
			return errors.New("redirect mode is set to error")
		}
	default:
		client.CheckRedirect = func(r *http.Request, via []*http.Request) error {
			if err := en.checkNetHost(r.URL.Host); err != nil {
				return err
			}
			if !req.RawHTTP && isBlockedFetchPort(r.URL.Port()) {
				return fmt.Errorf("TypeError: fetch failed: bad port")
			}
			if len(via) >= 20 {
				return errors.New("stopped after 20 redirects")
			}
			rawCap.mu.Lock()
			rawCap.headers = nil
			rawCap.mu.Unlock()
			redirected = true
			return nil
		}
	}

	resp, err := client.Do(httpReq)
	if err != nil {
		pushErr(err)
		return
	}
	defer resp.Body.Close()

	var rawHeaders [][2]string
	if resp.Request != nil && strings.EqualFold(resp.Request.URL.Scheme, "http") {
		rawCap.mu.Lock()
		rawHeaders = rawCap.headers
		rawCap.mu.Unlock()
	}

	var headers [][2]string
	if len(rawHeaders) > 0 {
		for _, kv := range rawHeaders {
			headers = append(headers, [2]string{strings.ToLower(kv[0]), kv[1]})
		}
	} else {
		for k, vals := range resp.Header {
			for _, v := range vals {
				headers = append(headers, [2]string{strings.ToLower(k), v})
				rawHeaders = append(rawHeaders, [2]string{k, v})
			}
		}
		if len(resp.TransferEncoding) > 0 && resp.Header.Get("Transfer-Encoding") == "" {
			te := strings.Join(resp.TransferEncoding, ", ")
			headers = append(headers, [2]string{"transfer-encoding", te})
			rawHeaders = append(rawHeaders, [2]string{"Transfer-Encoding", te})
		}
	}
	statusText := resp.Status
	if idx := strings.IndexByte(statusText, ' '); idx >= 0 {
		statusText = strings.TrimSpace(statusText[idx+1:])
	}
	protoMajor := resp.ProtoMajor
	protoMinor := resp.ProtoMinor
	if protoMajor == 0 {
		protoMajor = 1
		protoMinor = 1
	}
	addrMu.Lock()
	rHost, rPortStr, _ := net.SplitHostPort(remoteAddrStr)
	lHost, lPortStr, _ := net.SplitHostPort(localAddrStr)
	addrMu.Unlock()
	rPort, _ := strconv.Atoi(rPortStr)
	lPort, _ := strconv.Atoi(lPortStr)
	rFam := "IPv4"
	if strings.Contains(rHost, ":") {
		rFam = "IPv6"
	}
	meta, _ := json.Marshal(map[string]any{
		"phase":            "headers",
		"status":           resp.StatusCode,
		"statusText":       statusText,
		"url":              resp.Request.URL.String(),
		"redirected":       redirected,
		"httpVersion":      fmt.Sprintf("%d.%d", protoMajor, protoMinor),
		"httpVersionMajor": protoMajor,
		"httpVersionMinor": protoMinor,
		"headers":          headers,
		"rawHeaders":       rawHeaders,
		"remoteAddress":    rHost,
		"remotePort":       rPort,
		"remoteFamily":     rFam,
		"localAddress":     lHost,
		"localPort":        lPort,
	})
	en.pushEvent(rtAsyncEvent{id: id, kind: rtEventFetch, json: string(meta)})

	if strings.EqualFold(method, "HEAD") || resp.StatusCode == 204 || resp.StatusCode == 205 || resp.StatusCode == 304 {
		en.pushEvent(rtAsyncEvent{id: id, kind: rtEventFetch, json: `{"phase":"end"}`})
		return
	}

	bodyStream := io.Reader(resp.Body)
	if !req.RawHTTP && !strings.EqualFold(method, "HEAD") {
		switch strings.ToLower(strings.TrimSpace(resp.Header.Get("Content-Encoding"))) {
		case "gzip", "x-gzip":
			if gz, gerr := gzip.NewReader(resp.Body); gerr == nil {
				defer gz.Close()
				bodyStream = gz
			} else {
				bodyStream = &errReader{err: gerr}
			}
		case "deflate":
			br := bufio.NewReader(resp.Body)
			hdr, _ := br.Peek(2)
			isZlib := len(hdr) == 2 && (hdr[0]&0x0f) == 8 && (hdr[0]>>4) <= 7 && ((int(hdr[0])<<8|int(hdr[1]))%31) == 0
			if isZlib {
				if zr, zerr := zlib.NewReader(br); zerr == nil {
					defer zr.Close()
					bodyStream = zr
				} else {
					bodyStream = &errReader{err: zerr}
				}
			} else {
				fr := flate.NewReader(br)
				defer fr.Close()
				bodyStream = fr
			}
		case "br":
			rawBr, berr := readAllBounded(resp.Body, maxHostBufferBytes)
			if berr != nil {
				bodyStream = &errReader{err: berr}
			} else if dec, _, derr := brotliDecompress(rawBr, maxHostBufferBytes); derr == nil {
				bodyStream = bytes.NewReader(dec)
			} else {
				bodyStream = &errReader{err: derr}
			}
		}
	}

	en.fetchMu.Lock()
	cred := en.fetchCredits[id]
	en.fetchMu.Unlock()

	buf := make([]byte, 32*1024)
	for {
		if cred != nil {
			select {
			case <-cred:
			case <-ctx.Done():
				return
			}
		}
		n, rerr := bodyStream.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			en.pushEvent(rtAsyncEvent{id: id, kind: rtEventFetch, json: `{"phase":"chunk"}`, bin: chunk})
		}
		if rerr != nil {
			if errors.Is(rerr, io.EOF) {
				_, _ = io.Copy(io.Discard, resp.Body)
				if len(resp.Trailer) > 0 {
					trailers := make(map[string]string, len(resp.Trailer))
					var rawTrailers []string
					for k, vals := range resp.Trailer {
						lk := strings.ToLower(k)
						trailers[lk] = strings.Join(vals, ", ")
						for _, v := range vals {
							rawTrailers = append(rawTrailers, k, v)
						}
					}
					endMeta, _ := json.Marshal(map[string]any{
						"phase":       "end",
						"trailers":    trailers,
						"rawTrailers": rawTrailers,
					})
					en.pushEvent(rtAsyncEvent{id: id, kind: rtEventFetch, json: string(endMeta)})
					return
				}
				en.pushEvent(rtAsyncEvent{id: id, kind: rtEventFetch, json: `{"phase":"end"}`})
				return
			}
			pushErr(rerr)
			return
		}
	}
}

func (en *rtEntry) opHTTPFetchAsync(argsStr string, body []byte) (string, []byte, bool, string, error) {
	var req httpFetchReq
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	fetchCtx, cancel := context.WithCancel(en.ctx)
	id := req.ID
	cred := make(chan struct{}, 16)
	for range 2 {
		cred <- struct{}{}
	}
	var bodyReader io.Reader
	var bw *asyncByteWriter
	if req.StreamBody {
		pr, pw := io.Pipe()
		bw = newAsyncByteWriter(pw, func() { _ = pw.Close() })
		bw.onDrain = func() {
			en.pushEvent(rtAsyncEvent{id: id, kind: rtEventFetch, json: `{"phase":"write_drain"}`})
		}
		bodyReader = pr
	} else if len(body) > 0 {
		bodyCopy := make([]byte, len(body))
		copy(bodyCopy, body)
		bodyReader = bytes.NewReader(bodyCopy)
	}
	en.fetchMu.Lock()
	en.fetches[id] = cancel
	en.fetchCredits[id] = cred
	if bw != nil {
		en.fetchBodies[id] = bw
	}
	en.fetchMu.Unlock()

	if bw != nil && len(body) > 0 {
		_, _ = bw.Enqueue(body)
	}

	go func() {
		defer func() {
			en.fetchMu.Lock()
			delete(en.fetches, id)
			delete(en.fetchCredits, id)
			if w, ok := en.fetchBodies[id]; ok {
				delete(en.fetchBodies, id)
				w.Abort()
			}
			en.fetchMu.Unlock()
			cancel()
		}()
		en.streamHTTPFetch(fetchCtx, id, req, bodyReader)
	}()

	return "", nil, false, "", nil
}

func (en *rtEntry) opHTTPWriteFetchBody(argsStr string, chunk []byte) (string, []byte, bool, string, error) {
	var req struct {
		ID  int32 `json:"id"`
		EOF bool  `json:"eof"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	en.fetchMu.Lock()
	bw := en.fetchBodies[req.ID]
	if req.EOF {
		delete(en.fetchBodies, req.ID)
	}
	en.fetchMu.Unlock()
	if bw != nil {
		var ok = true
		if len(chunk) > 0 {
			var werr error
			ok, werr = bw.Enqueue(chunk)
			if werr != nil {
				return "", nil, false, "ERR_OUT_OF_RANGE", werr
			}
		}
		if req.EOF {
			bw.EnqueueClose()
		}
		if !ok {
			return "false", nil, false, "", nil
		}
	}
	return "true", nil, false, "", nil
}

func (en *rtEntry) opHTTPPullFetch(argsStr string) (string, []byte, bool, string, error) {
	id64, err := strconv.ParseInt(strings.TrimSpace(argsStr), 10, 32)
	if err != nil {
		return "", nil, false, "", nil
	}
	id := int32(id64)
	en.fetchMu.Lock()
	cred := en.fetchCredits[id]
	en.fetchMu.Unlock()
	if cred != nil {
		select {
		case cred <- struct{}{}:
		default:
		}
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) opHTTPAbortFetch(argsStr string) (string, []byte, bool, string, error) {
	id64, err := strconv.ParseInt(strings.TrimSpace(argsStr), 10, 32)
	if err != nil {
		return "", nil, false, "", nil
	}
	id := int32(id64)
	en.fetchMu.Lock()
	cancel := en.fetches[id]
	delete(en.fetches, id)
	delete(en.fetchCredits, id)
	bw := en.fetchBodies[id]
	delete(en.fetchBodies, id)
	en.fetchMu.Unlock()
	if bw != nil {
		bw.Abort()
	}
	if cancel != nil {
		cancel()
	}
	return "", nil, false, "", nil
}

type rtAsyncCallReq struct {
	ID   int32  `json:"id"`
	Op   string `json:"op"`
	Args string `json:"args"`
}

type rtAsyncCallResp struct {
	Str     string `json:"str,omitempty"`
	IsBin   bool   `json:"isBin,omitempty"`
	ErrCode string `json:"errCode,omitempty"`
	ErrMsg  string `json:"errMsg,omitempty"`
}

func (en *rtEntry) opAsyncCall(argsStr string, inBin []byte) (string, []byte, bool, string, error) {
	var req rtAsyncCallReq
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	var binCopy []byte
	if len(inBin) > 0 {
		binCopy = make([]byte, len(inBin))
		copy(binCopy, inBin)
	}
	go func() {
		outStr, outBin, isBin, errCode, err := en.handleHostCall(req.Op, req.Args, binCopy)
		var resp rtAsyncCallResp
		if err != nil {
			if errCode == "" {
				errCode = "Error"
			}
			resp.ErrCode = errCode
			resp.ErrMsg = err.Error()
		} else {
			resp.Str = outStr
			resp.IsBin = isBin
		}
		b, _ := json.Marshal(resp)
		en.pushEvent(rtAsyncEvent{
			id:   req.ID,
			kind: rtEventAsyncOp,
			json: string(b),
			bin:  outBin,
		})
	}()
	return "", nil, false, "", nil
}

func classifyListenError(addr string, err error) (string, error) {
	if err == nil {
		return "", nil
	}
	if errors.Is(err, os.ErrPermission) || errors.Is(err, syscall.EACCES) {
		return "EACCES", fmt.Errorf("EACCES: permission denied %s", addr)
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "address already in use") || strings.Contains(msg, "only one usage of each socket address"):
		return "EADDRINUSE", fmt.Errorf("EADDRINUSE: address already in use %s", addr)
	case strings.Contains(msg, "can't assign requested address") || strings.Contains(msg, "cannot assign requested address") || strings.Contains(msg, "not valid in its context"):
		return "EADDRNOTAVAIL", fmt.Errorf("EADDRNOTAVAIL: address not available %s", addr)
	case strings.Contains(msg, "permission denied") || strings.Contains(msg, "access is denied") || strings.Contains(msg, "forbidden by its access permissions"):
		return "EACCES", fmt.Errorf("EACCES: permission denied %s", addr)
	default:
		return "EINVAL", err
	}
}

type statusConnCtxKey struct{}

type statusRewriteConn struct {
	net.Conn
	mu                 sync.Mutex
	statusCode         int
	statusMsg          string
	rawRespHeaderNames map[string]string
	respHdrBuf         []byte
	reqHdrBuf          []byte
	rawReqHeaders      []string
	capturingReqHdr    bool
}

func (c *statusRewriteConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if n > 0 {
		c.mu.Lock()
		if c.capturingReqHdr && len(c.reqHdrBuf) < 65536 {
			c.reqHdrBuf = append(c.reqHdrBuf, p[:n]...)
			if idx := bytes.Index(c.reqHdrBuf, []byte("\r\n\r\n")); idx >= 0 {
				block := string(c.reqHdrBuf[:idx])
				c.reqHdrBuf = nil
				c.capturingReqHdr = false
				lines := strings.Split(block, "\r\n")
				var raw []string
				for i := 1; i < len(lines); i++ {
					line := lines[i]
					if colon := strings.IndexByte(line, ':'); colon > 0 {
						raw = append(raw, strings.TrimSpace(line[:colon]), strings.TrimSpace(line[colon+1:]))
					}
				}
				c.rawReqHeaders = raw
			}
		}
		c.mu.Unlock()
	}
	return n, err
}

func (c *statusRewriteConn) resetReqHdrCapture() {
	c.mu.Lock()
	c.reqHdrBuf = nil
	c.capturingReqHdr = true
	c.mu.Unlock()
}

func (c *statusRewriteConn) takeRawReqHeaders() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	res := c.rawReqHeaders
	c.rawReqHeaders = nil
	return res
}

func (c *statusRewriteConn) setCustomStatus(code int, msg string) {
	clean := strings.Map(func(r rune) rune {
		if r == '\r' || r == '\n' || r < 0x20 {
			return -1
		}
		return r
	}, msg)
	c.mu.Lock()
	c.statusCode = code
	c.statusMsg = clean
	c.mu.Unlock()
}

func (c *statusRewriteConn) setHeaderNames(names map[string]string) {
	c.mu.Lock()
	c.rawRespHeaderNames = names
	c.mu.Unlock()
}

func (c *statusRewriteConn) Write(p []byte) (int, error) {
	c.mu.Lock()
	msg := c.statusMsg
	code := c.statusCode
	hdrNames := c.rawRespHeaderNames
	if (msg != "" || len(hdrNames) > 0) && (len(c.respHdrBuf) > 0 || bytes.HasPrefix(p, []byte("HTTP/1.1 "))) {
		origLen := len(p)
		c.respHdrBuf = append(c.respHdrBuf, p...)
		hdrEnd := bytes.Index(c.respHdrBuf, []byte("\r\n\r\n"))
		if hdrEnd < 0 && len(c.respHdrBuf) < 256*1024 {
			c.mu.Unlock()
			return origLen, nil
		}
		buf := c.respHdrBuf
		c.respHdrBuf = nil
		c.statusMsg = ""
		c.rawRespHeaderNames = nil
		c.mu.Unlock()
		if hdrEnd > 0 {
			lines := strings.Split(string(buf[:hdrEnd]), "\r\n")
			if msg != "" && len(lines) > 0 {
				lines[0] = fmt.Sprintf("HTTP/1.1 %d %s", code, msg)
			}
			if len(hdrNames) > 0 {
				for i := 1; i < len(lines); i++ {
					if colon := strings.IndexByte(lines[i], ':'); colon > 0 {
						k := lines[i][:colon]
						if origK, ok := hdrNames[strings.ToLower(k)]; ok {
							lines[i] = origK + lines[i][colon:]
						}
					}
				}
			}
			newHdr := strings.Join(lines, "\r\n")
			rewritten := make([]byte, 0, len(newHdr)+(len(buf)-hdrEnd))
			rewritten = append(rewritten, newHdr...)
			rewritten = append(rewritten, buf[hdrEnd:]...)
			if _, err := c.Conn.Write(rewritten); err != nil {
				return 0, err
			}
			return origLen, nil
		}
		if _, err := c.Conn.Write(buf); err != nil {
			return 0, err
		}
		return origLen, nil
	}
	c.mu.Unlock()
	return c.Conn.Write(p)
}

type statusRewriteListener struct {
	net.Listener
}

func (l *statusRewriteListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &statusRewriteConn{Conn: c, capturingReqHdr: true}, nil
}

func (en *rtEntry) listenTCPHost(reqHost string, port int) (net.Listener, string, string, int, string, error) {
	portStr := strconv.Itoa(port)
	defaulted := reqHost == ""
	host := reqHost
	if defaulted {
		if en.checkNetHost(net.JoinHostPort("::", portStr)) == nil {
			host = "::"
		} else {
			host = "127.0.0.1"
		}
	}
	addr := net.JoinHostPort(host, portStr)
	if err := en.checkNetHost(addr); err != nil {
		return nil, "", "", 0, "EACCES", err
	}
	listenAddr := addr
	if host == "::" {
		listenAddr = ":" + portStr
	}
	rawLn, err := net.Listen("tcp", listenAddr)
	if err != nil && host == "::" {
		rawLn, err = net.Listen("tcp", addr)
	}
	if err != nil {
		code, cerr := classifyListenError(addr, err)
		return nil, "", "", 0, code, cerr
	}
	tcpAddr, _ := rawLn.Addr().(*net.TCPAddr)
	actualPort := port
	actualHost := host
	family := "IPv4"
	if tcpAddr != nil {
		actualPort = tcpAddr.Port
		actualHost = tcpAddr.IP.String()
		if host == "::" && tcpAddr.IP.IsUnspecified() {
			actualHost = "::"
			family = "IPv6"
		} else if tcpAddr.IP.To4() == nil {
			family = "IPv6"
		}
	}
	return rawLn, actualHost, family, actualPort, "", nil
}

func (en *rtEntry) opHTTPServerListen(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		ID   int32  `json:"id"`
		Port int    `json:"port"`
		Host string `json:"host"`
		TLS  bool   `json:"tls"`
		Key  string `json:"key"`
		Cert string `json:"cert"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	en.srvMu.Lock()
	_, alreadyListening := en.servers[req.ID]
	en.srvMu.Unlock()
	if alreadyListening {
		return "", nil, false, "ERR_SERVER_ALREADY_LISTEN", fmt.Errorf("ERR_SERVER_ALREADY_LISTEN: Listen method has been called more than once without closing.")
	}
	var tlsCfg *tls.Config
	if req.TLS || req.Key != "" || req.Cert != "" {
		if req.Key == "" || req.Cert == "" {
			return "", nil, false, "ERR_TLS_CERT_ALTNAME_INVALID", fmt.Errorf("https.createServer requires both key and cert PEM options")
		}
		cert, err := tls.X509KeyPair([]byte(req.Cert), []byte(req.Key))
		if err != nil {
			return "", nil, false, "ERR_CRYPTO_INVALID_KEY", err
		}
		tlsCfg = &tls.Config{Certificates: []tls.Certificate{cert}}
	}

	rawLn, actualHost, family, actualPort, errCode, lerr := en.listenTCPHost(req.Host, req.Port)
	if lerr != nil {
		return "", nil, false, errCode, lerr
	}
	ln := rawLn
	if tlsCfg != nil {
		ln = tls.NewListener(rawLn, tlsCfg)
	}
	ln = &statusRewriteListener{Listener: ln}

	srvID := req.ID
	hs := &rtHTTPServer{
		ln:    ln,
		reqs:  make(map[int32]*rtHTTPPendingReq),
		conns: make(map[net.Conn]http.ConnState),
	}
	mux := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		rc, _ := r.Context().Value(statusConnCtxKey{}).(*statusRewriteConn)
		var rawHeaders []string
		if rc != nil {
			rawHeaders = rc.takeRawReqHeaders()
		}
		if len(rawHeaders) == 0 {
			if r.Host != "" {
				rawHeaders = append(rawHeaders, "Host", r.Host)
			}
			for k, vals := range r.Header {
				for _, v := range vals {
					rawHeaders = append(rawHeaders, k, v)
				}
			}
		}

		reqID := en.nextReq.Add(1)
		readCred := make(chan struct{}, 16)
		readCred <- struct{}{}
		readCred <- struct{}{}
		pReq := &rtHTTPPendingReq{
			notify:      make(chan struct{}, 1),
			flushed:     make(chan struct{}),
			readCredits: readCred,
		}
		var flushOnce sync.Once
		closeFlushed := func() {
			flushOnce.Do(func() { close(pReq.flushed) })
		}
		defer closeFlushed()
		hs.reqsMu.Lock()
		hs.reqs[reqID] = pReq
		hs.reqsMu.Unlock()
		defer func() {
			hs.reqsMu.Lock()
			delete(hs.reqs, reqID)
			hs.reqsMu.Unlock()
			pReq.mu.Lock()
			wasClosed := pReq.closed
			pReq.closed = true
			pReq.mu.Unlock()
			if !wasClosed {
				abortMeta, _ := json.Marshal(map[string]any{
					"reqId":   reqID,
					"aborted": true,
				})
				en.pushEvent(rtAsyncEvent{id: srvID, kind: rtEventHTTPRequest, json: string(abortMeta)})
			}
		}()

		hdrs := make(map[string]any, len(r.Header)+1)
		for k, vals := range r.Header {
			lk := strings.ToLower(k)
			if lk == "set-cookie" {
				hdrs[lk] = vals
			} else if lk == "cookie" {
				hdrs[lk] = strings.Join(vals, "; ")
			} else {
				hdrs[lk] = strings.Join(vals, ", ")
			}
		}
		if r.Host != "" {
			if _, ok := hdrs["host"]; !ok {
				hdrs["host"] = r.Host
			}
		}
		if len(r.TransferEncoding) > 0 {
			if _, ok := hdrs["transfer-encoding"]; !ok {
				hdrs["transfer-encoding"] = strings.Join(r.TransferEncoding, ", ")
			}
		}
		protoMajor := r.ProtoMajor
		protoMinor := r.ProtoMinor
		if protoMajor == 0 {
			protoMajor = 1
			protoMinor = 1
		}
		hasBody := r.ContentLength != 0 && (r.ContentLength > 0 || len(r.TransferEncoding) > 0)
		rHost, rPortStr, _ := net.SplitHostPort(r.RemoteAddr)
		rPort, _ := strconv.Atoi(rPortStr)
		rFam := "IPv4"
		if strings.Contains(rHost, ":") {
			rFam = "IPv6"
		}
		lHost := actualHost
		lPort := actualPort
		if rc != nil && rc.Conn != nil && rc.Conn.LocalAddr() != nil {
			if lh, lpStr, lerr := net.SplitHostPort(rc.Conn.LocalAddr().String()); lerr == nil {
				lHost = lh
				if lp, perr := strconv.Atoi(lpStr); perr == nil {
					lPort = lp
				}
			}
		}
		meta, _ := json.Marshal(map[string]any{
			"phase":            "request",
			"reqId":            reqID,
			"method":           r.Method,
			"url":              r.URL.RequestURI(),
			"httpVersion":      fmt.Sprintf("%d.%d", protoMajor, protoMinor),
			"httpVersionMajor": protoMajor,
			"httpVersionMinor": protoMinor,
			"headers":          hdrs,
			"rawHeaders":       rawHeaders,
			"bodyComplete":     !hasBody,
			"remoteAddress":    rHost,
			"remotePort":       rPort,
			"remoteFamily":     rFam,
			"localAddress":     lHost,
			"localPort":        lPort,
		})
		en.pushEvent(rtAsyncEvent{id: srvID, kind: rtEventHTTPRequest, json: string(meta)})

		var bodyEOF atomic.Bool
		bodyDone := make(chan struct{})
		if hasBody {
			go func() {
				defer close(bodyDone)
				buf := make([]byte, 32*1024)
				total := 0
				for {
					select {
					case <-pReq.readCredits:
					case <-pReq.flushed:
						return
					case <-en.ctx.Done():
						return
					case <-r.Context().Done():
						return
					}
					n, berr := r.Body.Read(buf)
					if n > 0 {
						total += n
						if total > maxHostBufferBytes {
							_ = r.Body.Close()
							abortMeta, _ := json.Marshal(map[string]any{
								"reqId":   reqID,
								"aborted": true,
							})
							en.pushEvent(rtAsyncEvent{id: srvID, kind: rtEventHTTPRequest, json: string(abortMeta)})
							return
						}
						chunk := make([]byte, n)
						copy(chunk, buf[:n])
						bodyMeta, _ := json.Marshal(map[string]any{
							"phase": "body",
							"reqId": reqID,
						})
						en.pushEvent(rtAsyncEvent{id: srvID, kind: rtEventHTTPRequest, json: string(bodyMeta), bin: chunk})
					}
					if berr != nil {
						if errors.Is(berr, io.EOF) {
							bodyEOF.Store(true)
							endMap := map[string]any{
								"phase": "end",
								"reqId": reqID,
							}
							if len(r.Trailer) > 0 {
								trailers := make(map[string]string, len(r.Trailer))
								var rawTrailers []string
								for k, vals := range r.Trailer {
									lk := strings.ToLower(k)
									trailers[lk] = strings.Join(vals, ", ")
									for _, v := range vals {
										rawTrailers = append(rawTrailers, k, v)
									}
								}
								endMap["trailers"] = trailers
								endMap["rawTrailers"] = rawTrailers
							}
							endMeta, _ := json.Marshal(endMap)
							en.pushEvent(rtAsyncEvent{id: srvID, kind: rtEventHTTPRequest, json: string(endMeta)})
						} else {
							pReq.mu.Lock()
							closed := pReq.closed
							pReq.mu.Unlock()
							if !closed {
								abortMeta, _ := json.Marshal(map[string]any{
									"reqId":   reqID,
									"aborted": true,
								})
								en.pushEvent(rtAsyncEvent{id: srvID, kind: rtEventHTTPRequest, json: string(abortMeta)})
							}
						}
						return
					}
				}
			}()
		} else {
			close(bodyDone)
		}
		defer func() {
			closeFlushed()
			_ = r.Body.Close()
			<-bodyDone
			if rc != nil {
				rc.resetReqHdrCapture()
			}
		}()

		headersWritten := false
		flusher, _ := w.(http.Flusher)
		for {
			pReq.mu.Lock()
			var batch []rtHTTPResponse
			if len(pReq.queue) > 0 {
				batch = pReq.queue
				pReq.queue = nil
			}
			closed := pReq.closed
			pReq.mu.Unlock()

			for _, resp := range batch {
				if resp.Destroy {
					if rc != nil {
						_ = rc.Conn.Close()
					}
					return
				}
				if resp.WriteContinue {
					if !headersWritten && rc != nil {
						_, _ = rc.Conn.Write([]byte("HTTP/1.1 100 Continue\r\n\r\n"))
					}
					continue
				}
				if !headersWritten {
					headersWritten = true
					origHeaderNames := make(map[string]string, len(resp.Headers))
					for k, v := range resp.Headers {
						origHeaderNames[strings.ToLower(k)] = k
						switch vv := v.(type) {
						case string:
							w.Header().Set(k, vv)
						case []any:
							for _, item := range vv {
								w.Header().Add(k, fmt.Sprint(item))
							}
						case []string:
							for _, item := range vv {
								w.Header().Add(k, item)
							}
						}
					}
					if _, hasCT := w.Header()["Content-Type"]; !hasCT {
						w.Header()["Content-Type"] = nil
					}
					if len(resp.Trailers) > 0 && w.Header().Get("Trailer") == "" {
						var trNames []string
						for tk := range resp.Trailers {
							trNames = append(trNames, tk)
						}
						w.Header().Set("Trailer", strings.Join(trNames, ", "))
					}
					status := resp.Status
					if status == 0 {
						status = 200
					}
					if status < 100 || status > 999 {
						status = 500
					}
					if resp.Done && len(resp.Trailers) == 0 && w.Header().Get("Content-Length") == "" && w.Header().Get("Transfer-Encoding") == "" &&
						status != 204 && status != 304 && status >= 200 {
						if r.Method != "HEAD" || len(resp.Body) > 0 {
							w.Header().Set("Content-Length", strconv.Itoa(len(resp.Body)))
						}
					}
					if resp.Done && hasBody && !bodyEOF.Load() {
						w.Header().Set("Connection", "close")
					}
					if rc != nil {
						if len(origHeaderNames) > 0 {
							rc.setHeaderNames(origHeaderNames)
						}
						if resp.StatusMessage != "" && resp.StatusMessage != http.StatusText(status) {
							rc.setCustomStatus(status, resp.StatusMessage)
						}
					}
					w.WriteHeader(status)
					if resp.FlushHeaders && flusher != nil {
						flusher.Flush()
					}
				}
				if len(resp.Body) > 0 {
					if r.Method != "HEAD" {
						rem := resp.Body
						for len(rem) > 0 {
							chunk := rem
							if len(chunk) > 32*1024 {
								chunk = rem[:32*1024]
							}
							rem = rem[len(chunk):]
							if _, werr := w.Write(chunk); werr != nil {
								pReq.mu.Lock()
								alreadyClosed := pReq.closed
								pReq.closed = true
								pReq.mu.Unlock()
								if !alreadyClosed {
									abortMeta, _ := json.Marshal(map[string]any{
										"reqId":   reqID,
										"aborted": true,
									})
									en.pushEvent(rtAsyncEvent{id: srvID, kind: rtEventHTTPRequest, json: string(abortMeta)})
								}
								return
							}
							if flusher != nil {
								flusher.Flush()
							}
						}
					}
					pReq.mu.Lock()
					pReq.queuedBytes -= len(resp.Body)
					if pReq.queuedBytes < 0 {
						pReq.queuedBytes = 0
					}
					emitDrain := false
					if pReq.needDrain && pReq.queuedBytes < 64*1024 && !pReq.closed && !resp.Done {
						pReq.needDrain = false
						emitDrain = true
					}
					pReq.mu.Unlock()
					if emitDrain {
						drainMeta, _ := json.Marshal(map[string]any{
							"phase": "drain",
							"reqId": reqID,
						})
						en.pushEvent(rtAsyncEvent{id: srvID, kind: rtEventHTTPRequest, json: string(drainMeta)})
					}
				}
				if len(resp.Trailers) > 0 {
					declared := strings.ToLower(w.Header().Get("Trailer"))
					for tk, tv := range resp.Trailers {
						if strings.Contains(declared, strings.ToLower(tk)) {
							w.Header().Set(tk, tv)
						} else {
							w.Header().Set(http.TrailerPrefix+tk, tv)
						}
					}
				}
				if resp.Done {
					if flusher != nil {
						flusher.Flush()
					}
					closeFlushed()
					if hasBody && !bodyEOF.Load() {
						_ = r.Body.Close()
					}
					return
				}
			}
			if len(batch) > 0 && headersWritten && flusher != nil {
				flusher.Flush()
			}
			if closed {
				if !headersWritten && rc != nil {
					_ = rc.Conn.Close()
				}
				return
			}

			select {
			case <-pReq.notify:
			case <-en.ctx.Done():
				return
			case <-r.Context().Done():
				return
			}
		}
	})
	hs.srv = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 30 * time.Second,
		IdleTimeout:       120 * time.Second,
		ConnContext: func(ctx context.Context, c net.Conn) context.Context {
			return context.WithValue(ctx, statusConnCtxKey{}, c)
		},
		ConnState: func(c net.Conn, st http.ConnState) {
			hs.connsMu.Lock()
			switch st {
			case http.StateNew, http.StateActive, http.StateIdle:
				hs.conns[c] = st
			case http.StateClosed, http.StateHijacked:
				delete(hs.conns, c)
			}
			hs.connsMu.Unlock()
		},
	}

	en.srvMu.Lock()
	en.servers[srvID] = hs
	en.srvMu.Unlock()

	go func() {
		_ = hs.srv.Serve(ln)
	}()

	res, _ := json.Marshal(map[string]any{
		"port":    actualPort,
		"address": actualHost,
		"family":  family,
	})
	return string(res), nil, false, "", nil
}

func (en *rtEntry) opHTTPPullRequest(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		ServerID int32 `json:"serverId"`
		ReqID    int32 `json:"reqId"`
		N        int   `json:"n"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "", nil
	}
	if req.N <= 0 {
		req.N = 1
	}
	en.srvMu.Lock()
	hs := en.servers[req.ServerID]
	en.srvMu.Unlock()
	if hs == nil {
		return "", nil, false, "", nil
	}
	hs.reqsMu.Lock()
	pReq := hs.reqs[req.ReqID]
	hs.reqsMu.Unlock()
	if pReq != nil && pReq.readCredits != nil {
		for range req.N {
			select {
			case pReq.readCredits <- struct{}{}:
			default:
			}
		}
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) opHTTPServerRespond(argsStr string, body []byte) (string, []byte, bool, string, error) {
	var req struct {
		ServerID      int32             `json:"serverId"`
		ReqID         int32             `json:"reqId"`
		Status        int               `json:"status"`
		StatusMessage string            `json:"statusMessage"`
		Headers       map[string]any    `json:"headers"`
		Trailers      map[string]string `json:"trailers"`
		Done          *bool             `json:"done"`
		Destroy       bool              `json:"destroy"`
		WriteContinue bool              `json:"writeContinue"`
		FlushHeaders  bool              `json:"flushHeaders"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	if req.Status != 0 && (req.Status < 100 || req.Status > 999) {
		return "", nil, false, "ERR_HTTP_INVALID_STATUS_CODE", fmt.Errorf("ERR_HTTP_INVALID_STATUS_CODE: Invalid status code: %d", req.Status)
	}
	isDone := true
	if req.Done != nil {
		isDone = *req.Done
	}
	if req.Destroy {
		isDone = true
	}
	en.srvMu.Lock()
	hs := en.servers[req.ServerID]
	en.srvMu.Unlock()
	if hs == nil {
		return "", nil, false, "", nil
	}
	hs.reqsMu.Lock()
	pReq := hs.reqs[req.ReqID]
	if isDone {
		delete(hs.reqs, req.ReqID)
	}
	hs.reqsMu.Unlock()
	canContinue := true
	if pReq != nil {
		bodyCopy := make([]byte, len(body))
		copy(bodyCopy, body)
		pReq.mu.Lock()
		if !pReq.closed {
			pReq.queuedBytes += len(bodyCopy)
			if !isDone && pReq.queuedBytes >= 64*1024 {
				pReq.needDrain = true
				canContinue = false
			}
			pReq.queue = append(pReq.queue, rtHTTPResponse{
				Status:        req.Status,
				StatusMessage: req.StatusMessage,
				Headers:       req.Headers,
				Trailers:      req.Trailers,
				Body:          bodyCopy,
				Done:          isDone,
				Destroy:       req.Destroy,
				WriteContinue: req.WriteContinue,
				FlushHeaders:  req.FlushHeaders,
			})
			if isDone {
				pReq.closed = true
			}
			select {
			case pReq.notify <- struct{}{}:
			default:
			}
		}
		pReq.mu.Unlock()
		if isDone && pReq.flushed != nil {
			select {
			case <-pReq.flushed:
			case <-en.ctx.Done():
			case <-time.After(5 * time.Millisecond):
			}
		}
	}
	if !canContinue {
		return "false", nil, false, "", nil
	}
	return "true", nil, false, "", nil
}

func (en *rtEntry) opHTTPServerCloseConns(argsStr string) (string, []byte, bool, string, error) {
	var srvID int32
	idleOnly := false
	trimmed := strings.TrimSpace(argsStr)
	if strings.HasPrefix(trimmed, "{") {
		var req struct {
			ID       int32 `json:"id"`
			IdleOnly bool  `json:"idleOnly"`
		}
		if err := json.Unmarshal([]byte(trimmed), &req); err != nil {
			return "", nil, false, "", nil
		}
		srvID = req.ID
		idleOnly = req.IdleOnly
	} else {
		id64, err := strconv.ParseInt(trimmed, 10, 32)
		if err != nil {
			return "", nil, false, "", nil
		}
		srvID = int32(id64)
	}
	en.srvMu.Lock()
	hs := en.servers[srvID]
	en.srvMu.Unlock()
	if hs != nil {
		if !idleOnly {
			hs.reqsMu.Lock()
			for reqID, pReq := range hs.reqs {
				pReq.mu.Lock()
				pReq.closed = true
				select {
				case pReq.notify <- struct{}{}:
				default:
				}
				pReq.mu.Unlock()
				delete(hs.reqs, reqID)
			}
			hs.reqsMu.Unlock()
		}
		hs.connsMu.Lock()
		for c, st := range hs.conns {
			if idleOnly && st != http.StateIdle {
				continue
			}
			_ = c.Close()
			delete(hs.conns, c)
		}
		hs.connsMu.Unlock()
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) opHTTPServerStopAccept(argsStr string) (string, []byte, bool, string, error) {
	id64, err := strconv.ParseInt(strings.TrimSpace(argsStr), 10, 32)
	if err != nil {
		return "0", nil, false, "", nil
	}
	srvID := int32(id64)
	en.srvMu.Lock()
	hs := en.servers[srvID]
	en.srvMu.Unlock()
	pending := 0
	if hs != nil {
		hs.srv.SetKeepAlivesEnabled(false)
		_ = hs.ln.Close()
		hs.reqsMu.Lock()
		pending = len(hs.reqs)
		hs.reqsMu.Unlock()
	}
	return strconv.Itoa(pending), nil, false, "", nil
}

func (en *rtEntry) opHTTPServerClose(argsStr string) (string, []byte, bool, string, error) {
	id64, err := strconv.ParseInt(strings.TrimSpace(argsStr), 10, 32)
	if err != nil {
		return "", nil, false, "", nil
	}
	srvID := int32(id64)
	en.srvMu.Lock()
	hs := en.servers[srvID]
	delete(en.servers, srvID)
	en.srvMu.Unlock()
	if hs != nil {
		hs.srv.SetKeepAlivesEnabled(false)
		_ = hs.ln.Close()
		hs.reqsMu.Lock()
		for reqID, pReq := range hs.reqs {
			pReq.mu.Lock()
			pReq.closed = true
			select {
			case pReq.notify <- struct{}{}:
			default:
			}
			pReq.mu.Unlock()
			delete(hs.reqs, reqID)
		}
		hs.reqsMu.Unlock()
		shutCtx, cancel := context.WithTimeout(en.ctx, 100*time.Millisecond)
		_ = hs.srv.Shutdown(shutCtx)
		cancel()
		_ = hs.srv.Close()
		hs.connsMu.Lock()
		for c := range hs.conns {
			_ = c.Close()
			delete(hs.conns, c)
		}
		hs.connsMu.Unlock()
	}
	return "", nil, false, "", nil
}

// ---- TCP Net Server & Socket ----

func (en *rtEntry) newNetConnWriter(connID int32, conn net.Conn) *asyncByteWriter {
	nw := newCustomAsyncByteWriter(
		conn.Write,
		func() error {
			en.netMu.Lock()
			halfClose := en.netHalfClosed[connID] && !en.netRemoteEOF[connID]
			en.netMu.Unlock()
			if halfClose {
				if cw, ok := conn.(interface{ CloseWrite() error }); ok {
					return cw.CloseWrite()
				}
			}
			return conn.Close()
		},
		func() {
			_ = conn.SetWriteDeadline(time.Now())
			_ = conn.Close()
		},
	)
	nw.onDrain = func() {
		en.pushEvent(rtAsyncEvent{id: connID, kind: rtEventNetDrain})
	}
	return nw
}

func (en *rtEntry) pumpNetConn(connID int32, conn net.Conn) {
	en.netMu.Lock()
	credits := en.netReadCredits[connID]
	en.netMu.Unlock()
	buf := make([]byte, 32*1024)
	for {
		if credits != nil {
			select {
			case <-credits:
			case <-en.ctx.Done():
				return
			}
		}
		n, err := conn.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			en.pushEvent(rtAsyncEvent{id: connID, kind: rtEventNetData, bin: chunk})
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				en.netMu.Lock()
				alreadyHalfClosed := en.netHalfClosed[connID]
				var nw *asyncByteWriter
				delete(en.netReadCredits, connID)
				if alreadyHalfClosed {
					nw = en.netWriters[connID]
					delete(en.netWriters, connID)
					delete(en.netConns, connID)
					delete(en.netHalfClosed, connID)
					delete(en.netRemoteEOF, connID)
				} else {
					en.netRemoteEOF[connID] = true
				}
				en.netMu.Unlock()
				if alreadyHalfClosed {
					if nw != nil {
						nw.EnqueueClose()
						go func() {
							<-nw.done
							_ = conn.Close()
						}()
					} else {
						_ = conn.Close()
					}
				}
				en.pushEvent(rtAsyncEvent{id: connID, kind: rtEventNetClose, json: `{"eof":true}`})
				return
			}
			en.netMu.Lock()
			alreadyHalfClosed := en.netHalfClosed[connID]
			nw := en.netWriters[connID]
			delete(en.netWriters, connID)
			delete(en.netConns, connID)
			delete(en.netReadCredits, connID)
			delete(en.netHalfClosed, connID)
			delete(en.netRemoteEOF, connID)
			en.netMu.Unlock()
			if nw != nil {
				nw.Abort()
			}
			_ = conn.Close()
			meta := "{}"
			if !errors.Is(err, net.ErrClosed) && !(alreadyHalfClosed && strings.Contains(strings.ToLower(err.Error()), "connection reset by peer")) {
				b, _ := json.Marshal(map[string]any{"error": err.Error()})
				meta = string(b)
			}
			en.pushEvent(rtAsyncEvent{id: connID, kind: rtEventNetClose, json: meta})
			return
		}
	}
}

func (en *rtEntry) opNetListen(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		ID                 int32    `json:"id"`
		Port               int      `json:"port"`
		Host               string   `json:"host"`
		TLS                bool     `json:"tls"`
		Key                string   `json:"key"`
		Cert               string   `json:"cert"`
		CA                 string   `json:"ca"`
		RequestCert        bool     `json:"requestCert"`
		RejectUnauthorized *bool    `json:"rejectUnauthorized"`
		ALPNProtocols      []string `json:"ALPNProtocols"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	var tlsCfg *tls.Config
	if req.TLS {
		if req.Cert == "" || req.Key == "" {
			return "", nil, false, "ERR_TLS_CERT_ALTNAME_INVALID", fmt.Errorf("ERR_INVALID_ARG_VALUE: TLS server requires key and cert")
		}
		pair, cerr := tls.X509KeyPair([]byte(req.Cert), []byte(req.Key))
		if cerr != nil {
			return "", nil, false, "ERR_CRYPTO_INITIALIZATION_FAILED", cerr
		}
		rejectUnauth := true
		if req.RejectUnauthorized != nil {
			rejectUnauth = *req.RejectUnauthorized
		}
		clientAuth := tls.NoClientCert
		if req.RequestCert {
			if rejectUnauth {
				clientAuth = tls.RequireAndVerifyClientCert
			} else {
				clientAuth = tls.RequestClientCert
			}
		}
		var clientPool *x509.CertPool
		if req.CA != "" {
			clientPool = x509.NewCertPool()
			clientPool.AppendCertsFromPEM([]byte(req.CA))
		}
		tlsCfg = &tls.Config{
			Certificates: []tls.Certificate{pair},
			ClientAuth:   clientAuth,
			ClientCAs:    clientPool,
			NextProtos:   req.ALPNProtocols,
		}
	}
	en.netMu.Lock()
	_, alreadyListening := en.netListeners[req.ID]
	en.netMu.Unlock()
	if alreadyListening {
		return "", nil, false, "ERR_SERVER_ALREADY_LISTEN", fmt.Errorf("ERR_SERVER_ALREADY_LISTEN: Listen method has been called more than once without closing.")
	}
	ln, actualHost, family, actualPort, errCode, lerr := en.listenTCPHost(req.Host, req.Port)
	if lerr != nil {
		return "", nil, false, errCode, lerr
	}
	srvID := req.ID
	en.netMu.Lock()
	en.netListeners[srvID] = ln
	en.netMu.Unlock()

	go func() {
		for {
			rawConn, err := ln.Accept()
			if err != nil {
				en.netMu.Lock()
				_, stillListening := en.netListeners[srvID]
				en.netMu.Unlock()
				if !stillListening || errors.Is(err, net.ErrClosed) || en.ctx.Err() != nil {
					return
				}
				time.Sleep(10 * time.Millisecond)
				continue
			}
			go func(accepted net.Conn) {
				conn := accepted
				metaMap := map[string]any{}
				if tlsCfg != nil {
					tlsConn := tls.Server(accepted, tlsCfg.Clone())
					_ = tlsConn.SetDeadline(time.Now().Add(15 * time.Second))
					herr := tlsConn.Handshake()
					_ = tlsConn.SetDeadline(time.Time{})
					if herr != nil {
						_ = accepted.Close()
						return
					}
					conn = tlsConn
					st := tlsConn.ConnectionState()
					tlsVer := "TLSv1.3"
					switch st.Version {
					case tls.VersionTLS10:
						tlsVer = "TLSv1"
					case tls.VersionTLS11:
						tlsVer = "TLSv1.1"
					case tls.VersionTLS12:
						tlsVer = "TLSv1.2"
					case tls.VersionTLS13:
						tlsVer = "TLSv1.3"
					}
					authorized := len(st.PeerCertificates) > 0 || !req.RequestCert
					authErr := ""
					if req.RequestCert && len(st.PeerCertificates) > 0 && tlsCfg.ClientAuth == tls.RequestClientCert {
						vOpts := x509.VerifyOptions{
							Roots:         tlsCfg.ClientCAs,
							Intermediates: x509.NewCertPool(),
							KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
						}
						for _, ic := range st.PeerCertificates[1:] {
							vOpts.Intermediates.AddCert(ic)
						}
						if _, verr := st.PeerCertificates[0].Verify(vOpts); verr == nil {
							authorized = true
						} else {
							authorized = false
							authErr = verr.Error()
						}
					} else if req.RequestCert && len(st.PeerCertificates) == 0 {
						authorized = false
						authErr = "UNABLE_TO_GET_ISSUER_CERT"
					}
					metaMap["tls"] = true
					metaMap["authorized"] = authorized
					if authErr != "" {
						metaMap["authorizationError"] = authErr
					}
					if st.NegotiatedProtocol != "" {
						metaMap["alpnProtocol"] = st.NegotiatedProtocol
					} else {
						metaMap["alpnProtocol"] = false
					}
					metaMap["tlsVersion"] = tlsVer
					metaMap["cipher"] = map[string]any{
						"name":         tls.CipherSuiteName(st.CipherSuite),
						"standardName": tls.CipherSuiteName(st.CipherSuite),
						"version":      tlsVer,
					}
					if len(st.PeerCertificates) > 0 {
						pc := st.PeerCertificates[0]
						fp := sha256.Sum256(pc.Raw)
						var fpParts []string
						for _, b := range fp {
							fpParts = append(fpParts, fmt.Sprintf("%02X", b))
						}
						metaMap["peerCert"] = map[string]any{
							"subject":        map[string]any{"CN": pc.Subject.CommonName},
							"issuer":         map[string]any{"CN": pc.Issuer.CommonName},
							"valid_from":     pc.NotBefore.UTC().Format(time.RFC1123),
							"valid_to":       pc.NotAfter.UTC().Format(time.RFC1123),
							"serialNumber":   fmt.Sprintf("%X", pc.SerialNumber),
							"fingerprint256": strings.Join(fpParts, ":"),
							"raw":            base64.StdEncoding.EncodeToString(pc.Raw),
						}
					}
				}
				connID := int32(1_000_000_000) + en.nextReq.Add(1)
				nw := en.newNetConnWriter(connID, conn)
				en.netMu.Lock()
				en.netConns[connID] = conn
				en.netWriters[connID] = nw
				en.netReadCredits[connID] = makeStreamCredits()
				en.netMu.Unlock()
				rHost, rPortStr, _ := net.SplitHostPort(conn.RemoteAddr().String())
				rPort, _ := strconv.Atoi(rPortStr)
				lHost, lPortStr, _ := net.SplitHostPort(conn.LocalAddr().String())
				lPort, _ := strconv.Atoi(lPortStr)
				metaMap["connId"] = connID
				metaMap["remoteAddress"] = rHost
				metaMap["remotePort"] = rPort
				metaMap["localAddress"] = lHost
				metaMap["localPort"] = lPort
				meta, _ := json.Marshal(metaMap)
				en.pushEvent(rtAsyncEvent{id: srvID, kind: rtEventNetConnect, json: string(meta)})
				go en.pumpNetConn(connID, conn)
			}(rawConn)
		}
	}()

	res, _ := json.Marshal(map[string]any{
		"port":    actualPort,
		"address": actualHost,
		"family":  family,
	})
	return string(res), nil, false, "", nil
}

func (en *rtEntry) opNetCloseServer(argsStr string) (string, []byte, bool, string, error) {
	id64, err := strconv.ParseInt(strings.TrimSpace(argsStr), 10, 32)
	if err != nil {
		return "", nil, false, "", nil
	}
	srvID := int32(id64)
	en.netMu.Lock()
	ln := en.netListeners[srvID]
	delete(en.netListeners, srvID)
	en.netMu.Unlock()
	if ln != nil {
		_ = ln.Close()
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) opNetConnect(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		ID                 int32    `json:"id"`
		Port               int      `json:"port"`
		Host               string   `json:"host"`
		TLS                bool     `json:"tls"`
		Servername         string   `json:"servername"`
		RejectUnauthorized *bool    `json:"rejectUnauthorized"`
		CA                 string   `json:"ca"`
		Cert               string   `json:"cert"`
		Key                string   `json:"key"`
		ALPNProtocols      []string `json:"ALPNProtocols"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	host := req.Host
	if host == "" {
		host = "127.0.0.1"
	}
	connID := req.ID
	addr := net.JoinHostPort(host, strconv.Itoa(req.Port))
	if err := en.checkNetHost(addr); err != nil {
		go func() {
			b, _ := json.Marshal(map[string]any{"error": err.Error()})
			en.pushEvent(rtAsyncEvent{id: connID, kind: rtEventNetConnect, json: string(b)})
		}()
		return "", nil, false, "", nil
	}
	dialCtx, dialCancel := context.WithCancel(en.ctx)
	en.netMu.Lock()
	en.netDialCancel[connID] = dialCancel
	en.netMu.Unlock()
	go func() {
		defer dialCancel()
		var d net.Dialer
		rawConn, err := d.DialContext(dialCtx, "tcp", addr)
		en.netMu.Lock()
		_, stillDialing := en.netDialCancel[connID]
		if !req.TLS {
			delete(en.netDialCancel, connID)
		}
		if !stillDialing {
			delete(en.netDialCancel, connID)
			en.netMu.Unlock()
			if rawConn != nil {
				_ = rawConn.Close()
			}
			return
		}
		if err != nil {
			delete(en.netDialCancel, connID)
			en.netMu.Unlock()
			b, _ := json.Marshal(map[string]any{"error": err.Error()})
			en.pushEvent(rtAsyncEvent{id: connID, kind: rtEventNetConnect, json: string(b)})
			return
		}
		en.netMu.Unlock()

		conn := rawConn
		metaMap := map[string]any{}
		if req.TLS {
			rejectUnauth := true
			if req.RejectUnauthorized != nil {
				rejectUnauth = *req.RejectUnauthorized
			}
			sni := req.Servername
			if sni == "" {
				sni = host
			}
			var rootPool *x509.CertPool
			if req.CA != "" {
				rootPool, _ = x509.SystemCertPool()
				if rootPool == nil {
					rootPool = x509.NewCertPool()
				}
				rootPool.AppendCertsFromPEM([]byte(req.CA))
			}
			tlsCfg := &tls.Config{
				ServerName:         sni,
				InsecureSkipVerify: !rejectUnauth,
				RootCAs:            rootPool,
				NextProtos:         req.ALPNProtocols,
			}
			if req.Cert != "" && req.Key != "" {
				if pair, cerr := tls.X509KeyPair([]byte(req.Cert), []byte(req.Key)); cerr == nil {
					tlsCfg.Certificates = []tls.Certificate{pair}
				}
			}
			tlsConn := tls.Client(rawConn, tlsCfg)
			herr := tlsConn.HandshakeContext(dialCtx)
			en.netMu.Lock()
			_, stillTLS := en.netDialCancel[connID]
			delete(en.netDialCancel, connID)
			en.netMu.Unlock()
			if !stillTLS {
				_ = rawConn.Close()
				return
			}
			if herr != nil {
				_ = rawConn.Close()
				b, _ := json.Marshal(map[string]any{"error": herr.Error()})
				en.pushEvent(rtAsyncEvent{id: connID, kind: rtEventNetConnect, json: string(b)})
				return
			}
			conn = tlsConn
			st := tlsConn.ConnectionState()
			authorized := rejectUnauth
			authErr := ""
			if !rejectUnauth && len(st.PeerCertificates) > 0 {
				vOpts := x509.VerifyOptions{
					DNSName:       sni,
					Roots:         rootPool,
					Intermediates: x509.NewCertPool(),
				}
				for _, ic := range st.PeerCertificates[1:] {
					vOpts.Intermediates.AddCert(ic)
				}
				if _, verr := st.PeerCertificates[0].Verify(vOpts); verr == nil {
					authorized = true
				} else {
					authErr = verr.Error()
				}
			}
			tlsVer := "TLSv1.3"
			switch st.Version {
			case tls.VersionTLS10:
				tlsVer = "TLSv1"
			case tls.VersionTLS11:
				tlsVer = "TLSv1.1"
			case tls.VersionTLS12:
				tlsVer = "TLSv1.2"
			case tls.VersionTLS13:
				tlsVer = "TLSv1.3"
			}
			metaMap["tls"] = true
			metaMap["authorized"] = authorized
			if authErr != "" {
				metaMap["authorizationError"] = authErr
			}
			if st.NegotiatedProtocol != "" {
				metaMap["alpnProtocol"] = st.NegotiatedProtocol
			} else {
				metaMap["alpnProtocol"] = false
			}
			metaMap["tlsVersion"] = tlsVer
			metaMap["cipher"] = map[string]any{
				"name":         tls.CipherSuiteName(st.CipherSuite),
				"standardName": tls.CipherSuiteName(st.CipherSuite),
				"version":      tlsVer,
			}
			if len(st.PeerCertificates) > 0 {
				pc := st.PeerCertificates[0]
				fp := sha256.Sum256(pc.Raw)
				var fpParts []string
				for _, b := range fp {
					fpParts = append(fpParts, fmt.Sprintf("%02X", b))
				}
				metaMap["peerCert"] = map[string]any{
					"subject":        map[string]any{"CN": pc.Subject.CommonName},
					"issuer":         map[string]any{"CN": pc.Issuer.CommonName},
					"valid_from":     pc.NotBefore.UTC().Format(time.RFC1123),
					"valid_to":       pc.NotAfter.UTC().Format(time.RFC1123),
					"serialNumber":   fmt.Sprintf("%X", pc.SerialNumber),
					"fingerprint256": strings.Join(fpParts, ":"),
					"raw":            base64.StdEncoding.EncodeToString(pc.Raw),
				}
			}
		}

		en.netMu.Lock()
		nw := en.newNetConnWriter(connID, conn)
		en.netConns[connID] = conn
		en.netWriters[connID] = nw
		en.netReadCredits[connID] = makeStreamCredits()
		en.netMu.Unlock()
		rHost, rPortStr, _ := net.SplitHostPort(conn.RemoteAddr().String())
		rPort, _ := strconv.Atoi(rPortStr)
		lHost, lPortStr, _ := net.SplitHostPort(conn.LocalAddr().String())
		lPort, _ := strconv.Atoi(lPortStr)
		metaMap["remoteAddress"] = rHost
		metaMap["remotePort"] = rPort
		metaMap["localAddress"] = lHost
		metaMap["localPort"] = lPort
		meta, _ := json.Marshal(metaMap)
		en.pushEvent(rtAsyncEvent{id: connID, kind: rtEventNetConnect, json: string(meta)})
		en.pumpNetConn(connID, conn)
	}()
	return "", nil, false, "", nil
}

func (en *rtEntry) opNetWrite(argsStr string, data []byte) (string, []byte, bool, string, error) {
	if err := en.ctx.Err(); err != nil {
		return "", nil, false, "ECANCELED", err
	}
	id64, err := strconv.ParseInt(strings.TrimSpace(argsStr), 10, 32)
	if err != nil {
		return "", nil, false, "EINVAL", err
	}
	connID := int32(id64)
	en.netMu.Lock()
	nw := en.netWriters[connID]
	conn := en.netConns[connID]
	en.netMu.Unlock()
	if conn == nil || nw == nil {
		return "", nil, false, "EPIPE", fmt.Errorf("Socket is closed")
	}
	ok, werr := nw.Enqueue(data)
	if werr != nil {
		return "", nil, false, "EPIPE", werr
	}
	if !ok {
		return "false", nil, false, "", nil
	}
	return "true", nil, false, "", nil
}

func (en *rtEntry) opNetCloseConn(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		ID        int32 `json:"id"`
		HalfClose bool  `json:"halfClose"`
		Destroy   bool  `json:"destroy"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		id64, _ := strconv.ParseInt(strings.TrimSpace(argsStr), 10, 32)
		req.ID = int32(id64)
		req.Destroy = true
	}
	en.netMu.Lock()
	dialCancel, hasDial := en.netDialCancel[req.ID]
	if hasDial {
		delete(en.netDialCancel, req.ID)
	}
	conn := en.netConns[req.ID]
	nw := en.netWriters[req.ID]
	fullClose := req.Destroy || !req.HalfClose || en.netRemoteEOF[req.ID]
	if fullClose {
		if cred := en.netReadCredits[req.ID]; cred != nil {
			select {
			case cred <- struct{}{}:
			default:
			}
		}
		delete(en.netWriters, req.ID)
		delete(en.netConns, req.ID)
		delete(en.netReadCredits, req.ID)
		delete(en.netHalfClosed, req.ID)
		delete(en.netRemoteEOF, req.ID)
	} else {
		en.netHalfClosed[req.ID] = true
	}
	en.netMu.Unlock()
	if dialCancel != nil {
		dialCancel()
	}
	if req.Destroy {
		if nw != nil {
			nw.Abort()
		}
		if conn != nil {
			_ = conn.Close()
		}
		return "", nil, false, "", nil
	}
	if nw != nil {
		nw.EnqueueClose()
		if fullClose && conn != nil {
			go func() {
				<-nw.done
				_ = conn.Close()
			}()
		}
		return "", nil, false, "", nil
	}
	if conn != nil {
		if !fullClose {
			if cw, ok := conn.(interface{ CloseWrite() error }); ok {
				_ = cw.CloseWrite()
				return "", nil, false, "", nil
			}
		}
		_ = conn.Close()
	}
	return "", nil, false, "", nil
}

func (en *rtEntry) opNetPullConn(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		ID int32 `json:"id"`
		N  int   `json:"n"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		id64, perr := strconv.ParseInt(strings.TrimSpace(argsStr), 10, 32)
		if perr != nil {
			return "", nil, false, "", nil
		}
		req.ID = int32(id64)
		req.N = 1
	}
	if req.N <= 0 {
		req.N = 1
	}
	en.netMu.Lock()
	c := en.netReadCredits[req.ID]
	en.netMu.Unlock()
	if c != nil {
		for {
			select {
			case c <- struct{}{}:
			default:
				return "", nil, false, "", nil
			}
		}
	}
	return "", nil, false, "", nil
}

// ---- UDP Dgram ----

func (en *rtEntry) opDgramBind(argsStr string) (string, []byte, bool, string, error) {
	var req struct {
		ID      int32  `json:"id"`
		Type    string `json:"type"`
		Port    int    `json:"port"`
		Address string `json:"address"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	en.dgramMu.Lock()
	if existing, ok := en.dgramSocks[req.ID]; ok && existing != nil {
		en.dgramMu.Unlock()
		return "", nil, false, "ERR_SOCKET_ALREADY_BOUND", fmt.Errorf("ERR_SOCKET_ALREADY_BOUND: Socket is already bound")
	}
	en.dgramMu.Unlock()
	netType := "udp4"
	if strings.EqualFold(req.Type, "udp6") {
		netType = "udp6"
	}
	addr := strings.TrimSpace(req.Address)
	portStr := strconv.Itoa(req.Port)
	if addr == "" {
		if netType == "udp6" {
			if en.checkNetHost(net.JoinHostPort("::", portStr)) == nil {
				addr = "::"
			} else {
				addr = "::1"
			}
		} else {
			if en.checkNetHost(net.JoinHostPort("0.0.0.0", portStr)) == nil {
				addr = "0.0.0.0"
			} else {
				addr = "127.0.0.1"
			}
		}
	}
	hostPort := net.JoinHostPort(addr, portStr)
	if err := en.checkNetHost(hostPort); err != nil {
		return "", nil, false, "EACCES", err
	}
	udpAddr, err := net.ResolveUDPAddr(netType, hostPort)
	if err != nil {
		return "", nil, false, "EINVAL", err
	}
	conn, err := net.ListenUDP(netType, udpAddr)
	if err != nil {
		code, cerr := classifyListenError(hostPort, err)
		return "", nil, false, code, cerr
	}
	en.dgramMu.Lock()
	if old, ok := en.dgramSocks[req.ID]; ok && old != nil {
		en.dgramMu.Unlock()
		_ = conn.Close()
		return "", nil, false, "ERR_SOCKET_ALREADY_BOUND", fmt.Errorf("ERR_SOCKET_ALREADY_BOUND: Socket is already bound")
	}
	en.dgramSocks[req.ID] = conn
	en.dgramMu.Unlock()

	localAddr := conn.LocalAddr().(*net.UDPAddr)
	family := "IPv4"
	if localAddr.IP.To4() == nil {
		family = "IPv6"
	}
	id := req.ID
	go func() {
		buf := make([]byte, 65536)
		for {
			n, raddr, rerr := conn.ReadFromUDP(buf)
			if n > 0 && raddr != nil {
				rfam := "IPv4"
				if raddr.IP.To4() == nil {
					rfam = "IPv6"
				}
				rinfo, _ := json.Marshal(map[string]any{
					"address": raddr.IP.String(),
					"family":  rfam,
					"port":    raddr.Port,
					"size":    n,
				})
				pkt := make([]byte, n)
				copy(pkt, buf[:n])
				en.pushEvent(rtAsyncEvent{id: id, kind: rtEventDgramMessage, json: string(rinfo), bin: pkt})
			}
			if rerr != nil {
				return
			}
		}
	}()

	b, _ := json.Marshal(map[string]any{
		"address": localAddr.IP.String(),
		"family":  family,
		"port":    localAddr.Port,
	})
	return string(b), nil, false, "", nil
}

func (en *rtEntry) opDgramSend(argsStr string, payload []byte) (string, []byte, bool, string, error) {
	var req struct {
		ID      int32  `json:"id"`
		Type    string `json:"type"`
		Port    int    `json:"port"`
		Address string `json:"address"`
	}
	if err := json.Unmarshal([]byte(argsStr), &req); err != nil {
		return "", nil, false, "EINVAL", err
	}
	netType := "udp4"
	if strings.EqualFold(req.Type, "udp6") {
		netType = "udp6"
	}
	addr := strings.TrimSpace(req.Address)
	if addr == "" {
		if netType == "udp6" {
			addr = "::1"
		} else {
			addr = "127.0.0.1"
		}
	}
	hostPort := net.JoinHostPort(addr, strconv.Itoa(req.Port))
	if err := en.checkNetHost(hostPort); err != nil {
		return "", nil, false, "EACCES", err
	}
	targetAddr, err := net.ResolveUDPAddr(netType, hostPort)
	if err != nil {
		return "", nil, false, "EINVAL", err
	}
	en.dgramMu.Lock()
	conn := en.dgramSocks[req.ID]
	en.dgramMu.Unlock()
	if conn != nil {
		n, werr := conn.WriteToUDP(payload, targetAddr)
		if werr != nil {
			return "", nil, false, "EIO", werr
		}
		return strconv.Itoa(n), nil, false, "", nil
	}
	ephem, err := net.DialUDP(netType, nil, targetAddr)
	if err != nil {
		return "", nil, false, "EIO", err
	}
	defer ephem.Close()
	n, werr := ephem.Write(payload)
	if werr != nil {
		return "", nil, false, "EIO", werr
	}
	return strconv.Itoa(n), nil, false, "", nil
}

func (en *rtEntry) opDgramClose(argsStr string) (string, []byte, bool, string, error) {
	id64, err := strconv.ParseInt(strings.TrimSpace(argsStr), 10, 32)
	if err != nil {
		return "", nil, false, "", nil
	}
	id := int32(id64)
	en.dgramMu.Lock()
	conn := en.dgramSocks[id]
	delete(en.dgramSocks, id)
	en.dgramMu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
	return "", nil, false, "", nil
}
