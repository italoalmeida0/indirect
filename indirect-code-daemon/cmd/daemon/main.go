package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"indirect/indirect-code-daemon/packages/runner"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"indirect/indirect-code-daemon/packages/agent/tools"
	"indirect/indirect-code-daemon/packages/qjs"
	"indirect/indirect-code-daemon/packages/unishcli"

	"github.com/gorilla/websocket"
)

// Version is set at build time via -ldflags "-X main.Version=...".
var Version = "v2-dev"

var errDaemonRevoked = errors.New("daemon revoked")

// link is the single gateway socket: one read loop (dispatch), writes
// serialized by the ws actor. Reconnect loop with backoff; revoked token
// exits instead of ghost-spinning.
type link struct {
	server *wsServer
	cfg    *configCell

	mu   sync.Mutex
	conn *websocket.Conn
}

// Multi-call binary: ONE artifact, two roles.
//   - boot (default)  — bootMain(): checkup/migrate/verify, then
//     self-spawns the worker and supervises it. No downloads at boot.
//   - worker          — daemonMain(): the daemon itself.
//
// Routing is explicit: the worker role is selected by its own flags
// (--worker / the update handoff flags / --slot). Everything else is
// boot. No legacy shapes: an invocation that mixes roles fails loudly.
func main() {
	if ok, code := unishcli.MaybeRunArgs(os.Args); ok {
		os.Exit(code)
	}
	if len(os.Args) > 1 && os.Args[1] == "--js" {
		os.Exit(jsMain(os.Args[2:]))
	}
	// Runner role first: it is spec-driven (stdin) and flag-agnostic.
	for _, a := range os.Args[1:] {
		if a == "--" {
			break
		}
		if a == "--runner-command" {
			os.Exit(runner.CommandMain())
		}
		if a == "--runner" {
			runnerMain()
			return
		}
	}
	if workerMode(os.Args[1:]) {
		daemonMain()
		return
	}
	bootMain()
}

func jsMain(args []string) int {
	var (
		code       string
		filename   string
		scriptArgs []string
		omitArgv1  bool
		stdin      io.Reader = os.Stdin
	)

	policyRT, baseOpts, jailErr := tools.PolicyRuntimeFromProcessEnv()
	if jailErr != nil {
		fmt.Fprintf(os.Stderr, "js error initializing jail: %v\n", jailErr)
		return 1
	}

	stripLeadingDashDash := func(s []string) []string {
		if len(s) > 0 && s[0] == "--" {
			return s[1:]
		}
		return s
	}

	if len(args) > 0 && args[0] == "--" {
		args = args[1:]
		// After `--`, if no token remains or the next token is `-`, read and execute stdin.
		if len(args) == 0 || args[0] == "-" {
			raw, err := io.ReadAll(os.Stdin)
			if err != nil {
				fmt.Fprintf(os.Stderr, "js error reading stdin: %v\n", err)
				return 1
			}
			code = string(raw)
			stdin = nil
			if len(args) == 0 {
				filename = "<stdin>"
				omitArgv1 = true
			} else {
				filename = "-"
				scriptArgs = args[1:]
			}
		} else {
			filePath := args[0]
			absPath, err := filepath.Abs(filePath)
			if err != nil {
				absPath = filePath
			}
			if cerr := tools.CheckScriptFileRead(context.Background(), policyRT, baseOpts, absPath); cerr != nil {
				fmt.Fprintf(os.Stderr, "js error reading %s: %v\n", filePath, cerr)
				return 1
			}
			raw, err := os.ReadFile(absPath)
			if err != nil {
				fmt.Fprintf(os.Stderr, "js error reading %s: %v\n", filePath, err)
				return 1
			}
			code = string(raw)
			filename = absPath
			scriptArgs = args[1:]
		}
	} else if len(args) == 0 || args[0] == "-" {
		raw, err := io.ReadAll(os.Stdin)
		if err != nil {
			fmt.Fprintf(os.Stderr, "js error reading stdin: %v\n", err)
			return 1
		}
		code = string(raw)
		stdin = nil
		if len(args) == 0 {
			filename = "<stdin>"
			omitArgv1 = true
		} else {
			filename = "-"
			scriptArgs = args[1:]
		}
	} else if args[0] == "-e" || args[0] == "--eval" || args[0] == "-p" || args[0] == "--print" {
		isPrint := args[0] == "-p" || args[0] == "--print"
		if len(args) < 2 {
			fmt.Fprintf(os.Stderr, "js error: %s requires a code argument\n", args[0])
			return 1
		}
		code = args[1]
		if isPrint {
			quoted, _ := json.Marshal(code)
			code = fmt.Sprintf(`{
  let __qjs_p_val;
  const __qjs_p_src = %s;
  try {
    __qjs_p_val = eval(__qjs_p_src);
  } catch (__qjs_p_err) {
    if (__qjs_p_err instanceof SyntaxError && /\bawait\b/.test(__qjs_p_src)) {
      const __AF = Object.getPrototypeOf(async function(){}).constructor;
      if (typeof require !== "undefined" && typeof __dirname !== "undefined") {
        __qjs_p_val = (new __AF("exports", "require", "module", "__filename", "__dirname", "return (\n" + __qjs_p_src + "\n)"))(exports, require, module, __filename, __dirname);
      } else {
        __qjs_p_val = (new __AF("return (\n" + __qjs_p_src + "\n)"))();
      }
    } else {
      throw __qjs_p_err;
    }
  }
  Promise.resolve(__qjs_p_val).then((__v) => console.log(__v));
}`, string(quoted))
		}
		filename = "<eval>"
		omitArgv1 = true
		scriptArgs = stripLeadingDashDash(args[2:])
	} else if args[0] == "-v" || args[0] == "--version" {
		fmt.Println("v22.0.0")
		return 0
	} else if strings.HasPrefix(args[0], "-") {
		fmt.Fprintf(os.Stderr, "%s: bad option: %s\n", os.Args[0], args[0])
		return 9
	} else {
		filePath := args[0]
		absPath, err := filepath.Abs(filePath)
		if err != nil {
			absPath = filePath
		}
		if cerr := tools.CheckScriptFileRead(context.Background(), policyRT, baseOpts, absPath); cerr != nil {
			fmt.Fprintf(os.Stderr, "js error reading %s: %v\n", filePath, cerr)
			return 1
		}
		raw, err := os.ReadFile(absPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "js error reading %s: %v\n", filePath, err)
			return 1
		}
		code = string(raw)
		filename = absPath
		scriptArgs = args[1:]
	}

	cwd, _ := os.Getwd()
	exe, _ := os.Executable()
	shPath := os.Getenv("__INDIRECT_SHELL_PATH")
	shFlag := os.Getenv("__INDIRECT_SHELL_FLAG")
	_ = os.Unsetenv("__INDIRECT_SHELL_PATH")
	_ = os.Unsetenv("__INDIRECT_SHELL_FLAG")
	if shPath == "" {
		shPath, shFlag = tools.ShellForTests()
	}
	if shPath == "" && exe != "" {
		shPath = exe
		shFlag = "--sh-c"
	}
	if shPath != "" && shFlag == "" {
		shFlag = "-c"
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sigc := make(chan os.Signal, 2)
	signal.Notify(sigc, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(sigc)
	var sigCode atomic.Int32
	go func() {
		select {
		case s := <-sigc:
			if s == syscall.SIGINT {
				sigCode.Store(130)
			} else {
				sigCode.Store(143)
			}
			cancel()
		case <-ctx.Done():
		}
	}()

	opts := baseOpts
	opts.Code = code
	opts.Filename = filename
	opts.CWD = cwd
	opts.Args = scriptArgs
	opts.OmitArgv1 = omitArgv1
	opts.Stdin = stdin
	opts.Stdout = os.Stdout
	opts.Stderr = os.Stderr
	opts.ExecPath = exe
	opts.ShellPath = shPath
	opts.ShellFlag = shFlag
	if policyRT != nil {
		opts = policyRT.QJSOptions(opts)
	}

	exitCode, err := qjs.RunScript(ctx, opts)
	if sc := int(sigCode.Load()); sc != 0 {
		return sc
	}
	if err != nil && exitCode == 0 {
		return 1
	}
	return exitCode
}

func workerMode(args []string) bool {
	for _, a := range args {
		if a == "--" {
			break
		}
		if a == "--worker" || a == "--update-start" || a == "--update-end" || a == "--slot" {
			return true
		}
	}
	return false
}

func daemonMain() {
	captureParentHealth()
	var (
		connectFlag = flag.String("connect", "", "Pairing connect URL (e.g. https://.../api/indirect-code/connect/<token>)")
		nameFlag    = flag.String("name", "", "Host display name")
		configFlag  = flag.String("config", "", "Path to config.json")
		dataDirFlag = flag.String("data-dir", "", "Path to daemon data directory")
		stopFlag    = flag.Bool("stop", false, "Stop the background daemon (reads daemon.pid) and exit")
		versionFlag = flag.Bool("version", false, "Print daemon version and exit")

		// Brutal update protocol (see update_flow.go): --update-start is the
		// naive updater (zero sessions; SIGKILLs the old daemon, copies the
		// slot, runs the new app), --update-end is the promoted daemon
		// (local-first promote: hello relay, kill waiter, flip active).
		updateStartFlag = flag.Bool("update-start", false, "Brutal update: kill the old daemon, own the host in update state, copy slot, run the new app")
		updateEndFlag   = flag.Bool("update-end", false, "Brutal update: boot the new daemon, promote local-first (hello relay, kill waiter, flip active, clean old slot)")
		rootDirFlag     = flag.String("root-dir", "", "Update slots root (<root> holding slots/)")
		fromSlotFlag    = flag.String("from-slot", "", "Update source slot (a|b)")
		toSlotFlag      = flag.String("to-slot", "", "Update target slot (a|b)")
		expectVerFlag   = flag.String("expect-version", "", "Update target version")
		expectSHAFlag   = flag.String("expect-sha256", "", "Expected SHA-256 of verified new app binary (--update-start only)")
		parentPidFlag   = flag.Int("parent-pid", 0, "PID of the daemon waiting to be killed")
		appFlag         = flag.String("app-path", "", "Verified new app binary (--update-start only)")
		slotFlag        = flag.String("slot", "", "Active slot id (a|b), informational: passed by the boot role; dataDir already points at the slot")
	)
	// Registered so flag.Parse accepts the multi-call routing flag.
	flag.Bool("worker", false, "internal: worker role (multi-call binary routing)")
	flag.Parse()
	// Version adoption: releases stamp main.Version (build-indirect-all),
	// the chaos/e2e harnesses stamp main.daemonVersion directly to build
	// distinct old/new binaries. Adopt the release stamp only when the
	// harness did not set one; dev builds keep "dev" (never self-update).
	if daemonVersion == "dev" && Version != "" && !strings.Contains(strings.ToLower(Version), "dev") {
		daemonVersion = Version
	}
	if *versionFlag {
		fmt.Println("indirect-code daemon", daemonVersion)
		os.Exit(0)
	}
	dataDir := *dataDirFlag
	if dataDir == "" {
		dataDir = defaultDataDir()
	}
	configPath := *configFlag
	if configPath == "" {
		configPath = filepath.Join(dataDir, "config.json")
	}
	if *updateStartFlag {
		os.Exit(runUpdateStart(dataDir, configPath, updateStartParams{
			root:          *rootDirFlag,
			fromSlot:      *fromSlotFlag,
			toSlot:        *toSlotFlag,
			expectVersion: *expectVerFlag,
			expectSHA256:  *expectSHAFlag,
			appPath:       *appFlag,
			parentPid:     *parentPidFlag,
		}))
	}
	if *updateEndFlag {
		updateEndInfo = &updateEndParams{
			root:          *rootDirFlag,
			fromSlot:      *fromSlotFlag,
			expectVersion: *expectVerFlag,
			parentPid:     *parentPidFlag,
			slot:          *slotFlag,
		}
	}
	if *stopFlag {
		if err := stopDaemonFromPidFile(dataDir); err != nil {
			fmt.Printf("Stop failed: %v.\n", err)
			os.Exit(1)
		}
		os.Exit(0)
	}

	if traceEnabled {
		setTraceDir(dataDir)
		fmt.Println("[TRACE] dev tracing to", dataDir+"/trace")
	}
	root := newRoot(dataDir)
	root.configPath = configPath
	if *connectFlag != "" {
		_ = root.loadConfig()
		fmt.Println("Pairing ...")
		if err := root.performPairing(*connectFlag, *nameFlag); err != nil {
			fmt.Printf("Error: pairing failed (%v).\n", err)
			os.Exit(1)
		}
	} else if err := root.loadConfig(); err != nil || root.cfg.load() == nil {
		fmt.Println("No pairing found. In the gateway dashboard (#/code), click 'Connect Host'")
		fmt.Println("and paste the connection URL below:")
		fmt.Print("\nConnection URL: ")
		var pairURL string
		// A declared, bounded setup wait is not a stalled actor.
		sendParentHealth(workerHealthReport{PairingWait: true})
		scanner := bufio.NewScanner(os.Stdin)
		if scanner.Scan() {
			pairURL = strings.TrimSpace(scanner.Text())
		}
		if pairURL == "" {
			fmt.Println("Error: connection URL is required.")
			os.Exit(1)
		}
		if err := root.performPairing(pairURL, *nameFlag); err != nil {
			fmt.Printf("Error: pairing failed (%v).\n", err)
			os.Exit(1)
		}
	} else {
		if cfg := root.cfg.load(); cfg != nil {
			fmt.Printf("Ready - host '%s' connected.\n", cfg.Name)
		}
	}

	// Builtin skills (builtin_skills/*.js) are embedded in the binary and
	// merged in RAM at load: they never touch the machine's skills
	// directory, and their names are reserved — a user skill with the
	// same name is ignored (builtins cannot be overridden). The directory
	// is watched after the actors boot (startSkillWatcher).
	skillRegistry().initFrom(dataDir)

	// Crash debris: sweep stale tmp files; boot() in the supervisor flips
	// stale running sessions back to idle (WAL sessions resume on route).
	st := newDiskStore(dataDir)
	if n := sweepTmpOrphans(filepath.Join(dataDir, "sessions"), time.Hour); n > 0 {
		fmt.Printf("Cleaned %d leftover temp file(s).\n", n)
	}
	sweepTmpOrphans(dataDir, time.Hour)
	_ = st

	root.bootActors()
	// Skill files are hand-edited: watch the directory so changes apply
	// without a restart (reload + "config" ping to the clients).
	root.startSkillWatcher()
	root.writePidFile()

	// Brutal update protocol boot hooks (v1.0.28 semantics): a promoted
	// --update-end daemon commits slots/active BEFORE announcing anything
	// (local-first, right after recovery, before the WS loop), then every
	// normal boot clears stale update signals.
	upd := attachUpdateHost(root)
	upd.sharedDir = filepath.Join(root.rootDir(), "external")
	upd.emitLive = func(ev any) { root.server.emit(ev) }
	root.server.updates = upd
	if err := doUpdateEndPromote(upd); err != nil {
		fmt.Printf("[UPDATE-END] promote: %v\n", err)
	}
	// The hello socket's job is done: the link loop owns the long-lived
	// connection from here (v1 replaced it in the same single-conn model).
	upd.closeWS()
	// Stale update signals from a crashed update must never gate a fresh
	// boot: the waiter/updater own the fail/done files, a normal boot
	// never reads them.
	_ = os.Remove(updateFailPath(root.rootDir()))
	_ = os.Remove(updateDonePath(root.rootDir()))
	// Self-update: check on start and every 10min (reconnect checks run
	// from the link loop). Stops with the process.
	updateStop := make(chan struct{})
	defer close(updateStop)
	go upd.startUpdateLoop(updateStop)

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigChan
		root.shutdown("interrupted")
	}()

	lk := &link{server: root.server, cfg: &root.cfg}
	backoff := 1 * time.Second
	for {
		err := lk.connectLoop(context.Background())
		if err != nil {
			if errors.Is(err, errDaemonRevoked) {
				root.removePidFile()
				os.Exit(0)
			}
			fmt.Printf("[DISCONNECTED] %v. Retrying in %v...\n", err, backoff)
		}
		time.Sleep(backoff)
		backoff *= 2
		if backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
	}
}

// gatewayHTTPBaseURL normalizes a configured gateway URL (http, https, ws, wss)
// into an HTTP(S) base URL without trailing slash, preserving TLS for both
// https:// and wss://.
func gatewayHTTPBaseURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", err
	}
	if u.Host == "" {
		return "", fmt.Errorf("gateway URL missing host")
	}
	switch strings.ToLower(u.Scheme) {
	case "https", "wss":
		u.Scheme = "https"
	case "http", "ws":
		u.Scheme = "http"
	default:
		return "", fmt.Errorf("unsupported gateway URL scheme %q", u.Scheme)
	}
	u.RawQuery = ""
	u.Fragment = ""
	return strings.TrimRight(u.String(), "/"), nil
}

func gatewayAPIBase(raw string) string {
	if base, err := gatewayHTTPBaseURL(raw); err == nil {
		return base + "/anthropic/v1"
	}
	return strings.TrimRight(raw, "/") + "/anthropic/v1"
}

// gatewayWSURL builds the daemon WebSocket endpoint for rawGatewayURL without
// placing the daemon token in the query string (auth travels via the
// Authorization: Bearer header). Both https:// and wss:// map to wss://.
func gatewayWSURL(rawGatewayURL, extra string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(rawGatewayURL))
	if err != nil {
		return "", err
	}
	if u.Host == "" {
		return "", fmt.Errorf("gateway URL missing host")
	}
	var scheme string
	switch strings.ToLower(u.Scheme) {
	case "https", "wss":
		scheme = "wss"
	case "http", "ws":
		scheme = "ws"
	default:
		return "", fmt.Errorf("unsupported gateway URL scheme %q", u.Scheme)
	}
	basePath := strings.TrimRight(u.Path, "/")
	endpoint := fmt.Sprintf("%s://%s%s/api/indirect-code/daemon/ws", scheme, u.Host, basePath)
	if q := strings.TrimLeft(strings.TrimSpace(extra), "?&"); q != "" {
		endpoint += "?" + q
	}
	return endpoint, nil
}

func daemonAuthHeader(token string) http.Header {
	if token == "" {
		return nil
	}
	return http.Header{"Authorization": {"Bearer " + token}}
}

func isLoopbackHost(host string) bool {
	h := strings.ToLower(strings.Trim(strings.TrimSpace(host), "[]"))
	if h == "" {
		return false
	}
	if h == "localhost" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

func normalizedOrigin(raw string) (string, string, string, bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return "", "", "", false
	}
	var scheme, defPort string
	switch strings.ToLower(u.Scheme) {
	case "https", "wss":
		scheme = "https"
		defPort = "443"
	case "http", "ws":
		scheme = "http"
		defPort = "80"
	default:
		return "", "", "", false
	}
	host := strings.ToLower(strings.Trim(u.Hostname(), "[]"))
	if host == "" {
		return "", "", "", false
	}
	port := u.Port()
	if port == "" {
		port = defPort
	}
	return scheme, host, port, true
}

func sameNormalizedOrigin(a, b string) bool {
	sa, ha, pa, oka := normalizedOrigin(a)
	sb, hb, pb, okb := normalizedOrigin(b)
	return oka && okb && sa == sb && ha == hb && pa == pb
}

func (l *link) wsURL(extra string) (string, error) {
	cfg := l.cfg.load()
	if cfg == nil {
		return "", fmt.Errorf("no config")
	}
	return gatewayWSURL(cfg.GatewayURL, extra)
}

func (l *link) connectLoop(ctx context.Context) error {
	cfg := l.cfg.load()
	if cfg == nil {
		return fmt.Errorf("no config")
	}
	wsURL, err := l.wsURL("")
	if err != nil {
		return err
	}
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second, EnableCompression: true}
	var stopDialClose func() bool
	dialer.NetDialContext = func(dialCtx context.Context, network, addr string) (net.Conn, error) {
		conn, err := (&net.Dialer{}).DialContext(dialCtx, network, addr)
		if err == nil {
			stopDialClose = context.AfterFunc(ctx, func() { _ = conn.Close() })
		}
		return conn, err
	}
	defer func() {
		if stopDialClose != nil {
			stopDialClose()
		}
	}()
	conn, resp, err := dialer.DialContext(ctx, wsURL, daemonAuthHeader(cfg.DaemonToken))
	if err != nil {
		if isRevokedDialError(resp, err) {
			fmt.Println("[REVOKED] This host was removed from the gateway. Exiting (re-pair to reconnect).")
			return errDaemonRevoked
		}
		return err
	}
	l.setConn(conn)
	fmt.Printf("[CONNECTED] Connected to gateway at %s\n", l.cfg.load().GatewayURL)
	// Fresh (re)connect: re-check for updates + push state to clients
	// (v1 parity: checks run on start, every 10min and on reconnect).
	if l.server != nil && l.server.updates != nil {
		go l.server.updates.checkForUpdates("reconnect")
	}
	if l.server != nil {
		l.server.notifyChange("config")
	}
	defer func() {
		_ = conn.Close()
		l.clearConn(conn)
	}()

	ticker := time.NewTicker(15 * time.Second)
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-ticker.C:
				if err := conn.WriteControl(websocket.PingMessage, []byte("ping"), time.Now().Add(5*time.Second)); err != nil {
					conn.Close()
					return
				}
			case <-done:
				return
			}
		}
	}()
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			close(done)
			ticker.Stop()
			return err
		}
		l.server.dispatch(msg)
	}
}

func (l *link) setConn(conn *websocket.Conn) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.conn != nil {
		_ = l.conn.Close()
	}
	l.conn = conn
	// Outbound path: ws actor emits call this send.
	l.server.ws.control <- wsReplaceMsg{Send: func(msg any) error {
		l.mu.Lock()
		c := l.conn
		l.mu.Unlock()
		if c == nil {
			return fmt.Errorf("websocket not connected")
		}
		_ = c.SetWriteDeadline(time.Now().Add(5 * time.Second))
		err := c.WriteJSON(msg)
		_ = c.SetWriteDeadline(time.Time{})
		return err
	}, OnWriteError: func(error) {
		// V2-002: a socket that fails writes is dead — drop it now so the
		// client reconnects and resyncs instead of listening to a half-dead
		// connection. The actor loop keeps running.
		l.dropConn()
	}}
}

// dropConn invalidates the current connection (write error path, V2-002).
func (l *link) dropConn() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.conn != nil {
		_ = l.conn.Close()
		l.conn = nil
	}
}

func (l *link) clearConn(conn *websocket.Conn) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.conn == conn {
		l.conn = nil
	}
}

func isRevokedDialError(resp *http.Response, err error) bool {
	if resp != nil && (resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden) {
		return true
	}
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "401") || strings.Contains(msg, "403") || strings.Contains(msg, "revoked")
}

// ---- root runtime plumbing (config/pair/pid, mirrors v1) ----

func (r *root) rootDir() string {
	if filepath.Base(filepath.Dir(r.dataDir)) == "slots" {
		return filepath.Dir(filepath.Dir(r.dataDir))
	}
	return r.dataDir
}

func (r *root) loadConfig() error {
	cfg, err := loadDaemonConfig(r.configPathDir())
	if err != nil {
		return err
	}
	r.cfg.store(cfg)
	return nil
}

func (r *root) configPathDir() string {
	if r.configPath != "" {
		return filepath.Dir(r.configPath)
	}
	return r.dataDir
}

func (r *root) performPairing(connectURL, hostName string) error {
	u, err := url.Parse(strings.TrimSpace(connectURL))
	if err != nil {
		return fmt.Errorf("invalid URL: %w", err)
	}
	scheme := strings.ToLower(u.Scheme)
	if u.Host == "" || u.Hostname() == "" {
		return fmt.Errorf("invalid pairing URL: missing host")
	}
	if scheme != "https" && !(scheme == "http" && isLoopbackHost(u.Hostname())) {
		return fmt.Errorf("refusing insecure pairing URL %q: must use https (http is only allowed for loopback hosts)", u.Scheme+"://"+u.Host)
	}
	hostname, _ := os.Hostname()
	if hostName == "" {
		hostName = hostname
	}
	pairReq := map[string]string{"name": hostName, "hostname": hostname, "os": runtime.GOOS, "arch": runtime.GOARCH}
	if cfg := r.cfg.load(); cfg != nil && cfg.HostID != "" && cfg.DaemonToken != "" && sameNormalizedOrigin(u.String(), cfg.GatewayURL) {
		pairReq["hostId"] = cfg.HostID
		pairReq["daemonToken"] = cfg.DaemonToken
	}
	reqBody, _ := json.Marshal(pairReq)
	req, err := http.NewRequest(http.MethodPost, u.String(), bytes.NewReader(reqBody))
	if err != nil {
		return fmt.Errorf("invalid pairing request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{
		Timeout: 30 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return errors.New("pairing redirects are not allowed")
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("pairing request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("pairing failed (status %d): %s", resp.StatusCode, string(b))
	}
	var result struct {
		Success     bool   `json:"success"`
		HostID      string `json:"hostId"`
		DaemonToken string `json:"daemonToken"`
		APIKey      string `json:"apiKey"`
		GatewayURL  string `json:"gatewayUrl"`
		Reused      bool   `json:"reused"`
		Error       string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("failed to decode response: %w", err)
	}
	if !result.Success {
		return fmt.Errorf("pairing unsuccessful: %s", result.Error)
	}
	cfg := r.cfg.load()
	if cfg == nil {
		cfg = defaultConfig()
	} else {
		cp := *cfg
		cfg = &cp
	}
	cfg.GatewayURL = result.GatewayURL
	cfg.DaemonToken = result.DaemonToken
	cfg.APIKey = result.APIKey
	cfg.HostID = result.HostID
	cfg.Name = hostName
	r.cfg.store(cfg)
	if err := saveDaemonConfig(r.configPathDir(), cfg); err != nil {
		return fmt.Errorf("failed to save config: %w", err)
	}
	fmt.Printf("Paired - host %s ready.\n", result.HostID)
	if result.Reused {
		fmt.Println("Reused existing host registration.")
	}
	return nil
}

func stopDaemonFromPidFile(dataDir string) error {
	data, err := os.ReadFile(filepath.Join(dataDir, "daemon.pid"))
	if err != nil {
		return fmt.Errorf("no running daemon found: %w", err)
	}
	var pid int
	if _, err := fmt.Sscanf(strings.TrimSpace(string(data)), "%d", &pid); err != nil || pid <= 0 {
		return fmt.Errorf("invalid pid file")
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return proc.Signal(syscall.SIGTERM)
}

func (r *root) writePidFile() {
	_ = os.WriteFile(filepath.Join(r.dataDir, "daemon.pid"), []byte(fmt.Sprintf("%d", os.Getpid())), 0o600)
}

func (r *root) removePidFile() {
	_ = os.Remove(filepath.Join(r.dataDir, "daemon.pid"))
}

func (r *root) shutdown(reason string) {
	fmt.Println("[SHUTDOWN]", reason)
	r.stopSkillWatcher()
	r.stopMaintenance()
	// Ordered, awaited shutdown: session commits (commitWAL per resident)
	// complete BEFORE the process exits. Each stage has a deadline; a
	// wedged actor delays exit but never skips the commit attempt.
	r.projects.control <- shutdownMsg{}
	r.bgSup.control <- shutdownMsg{}
	r.sessionSup.control <- shutdownMsg{}
	waitActors("sessions", 45*time.Second, r.sessionSupDone())
	// WS last: completion snapshots must still flush to the socket.
	r.ws.control <- shutdownMsg{}
	r.waitWG(5 * time.Second)
	r.removePidFile()
	os.Exit(0)
}

// sessionSupDone collects resident Done channels at call time.
func (r *root) sessionSupDone() []<-chan struct{} {
	if r.sessionSup == nil {
		return nil
	}
	r.sessionSup.mu.Lock()
	defer r.sessionSup.mu.Unlock()
	out := make([]<-chan struct{}, 0, len(r.sessionSup.resident))
	for _, ent := range r.sessionSup.resident {
		if ent.handle.done != nil {
			out = append(out, ent.handle.done)
		}
	}
	return out
}

func waitActors(what string, timeout time.Duration, dones []<-chan struct{}) {
	if len(dones) == 0 {
		return
	}
	deadline := time.After(timeout)
	for _, d := range dones {
		select {
		case <-d:
		case <-deadline:
			fmt.Printf("[WARN] shutdown: %s commit timed out\n", what)
			return
		}
	}
}

// waitWG waits for the actor WaitGroup (supervisors themselves).
func (r *root) waitWG(timeout time.Duration) {
	done := make(chan struct{})
	go func() { r.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(timeout):
		fmt.Printf("[WARN] shutdown: actor loop exit timed out\n")
	}
}
