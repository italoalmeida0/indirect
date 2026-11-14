package runner

import (
	"context"
	"fmt"
	"net"
	"time"

	"indirect/indirect-code-daemon/packages/agent/tools"
)

// Dial connects to a runner's IPC endpoint and performs the parent side
// of the handshake (hello{token, proto, logCursor}).
func Dial(st *State, logCursor int64, timeout time.Duration) (*Conn, net.Conn, error) {
	if st.Transport.Port == 0 {
		return nil, nil, fmt.Errorf("runner: no transport (file-only mode)")
	}
	addr := net.JoinHostPort(st.Transport.Host, fmt.Sprint(st.Transport.Port))
	raw, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return nil, nil, err
	}
	c := NewConn(raw)
	if err := c.Send(Hello{Type: VerbHello, Proto: ProtoVersion, Token: st.Transport.Token, LogCursor: logCursor}); err != nil {
		raw.Close()
		return nil, nil, err
	}
	return c, raw, nil
}

// DialKill is the fast-path cancellation: connect + kill verb. It is
// ALWAYS best-effort — callers guarantee the kill via process signal.
func DialKill(st *State, reason string, timeout time.Duration) error {
	c, raw, err := Dial(st, 0, timeout)
	if err != nil {
		return err
	}
	defer raw.Close()
	return c.Send(Kill{Type: VerbKill, Reason: reason})
}

// AttachApprovalHandler waits briefly for the runner's loopback transport in
// state.json, attaches with Role=="daemon", and serves mid-execution approval
// prompts until ctx is cancelled (e.g. foreground->background transition) or
// the runner finishes.
func AttachApprovalHandler(
	ctx context.Context,
	root string,
	jobID string,
	pollTimeout time.Duration,
	onAsk tools.MidExecApprover,
) error {
	if ctx == nil || onAsk == nil || root == "" || jobID == "" {
		return nil
	}
	if pollTimeout <= 0 {
		pollTimeout = 3 * time.Second
	}
	statePath := StatePath(root, jobID)
	deadline := time.Now().Add(pollTimeout)
	var st *State
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if cur, err := ReadState(statePath); err == nil {
			if cur.Terminal() {
				return nil
			}
			if cur.Transport.Port != 0 && cur.Transport.Token != "" {
				st = cur
				break
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("runner: transport not ready within %s", pollTimeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(12 * time.Millisecond):
		}
	}
	return ServeApprovalTransport(ctx, st.Transport, onAsk)
}

// ServeApprovalTransport connects to an active runner Transport as Role=="daemon"
// and dispatches AskApproval frames to onAsk until ctx ends or the runner closes.
func ServeApprovalTransport(
	ctx context.Context,
	tr Transport,
	onAsk tools.MidExecApprover,
) error {
	if tr.Port == 0 || tr.Token == "" || onAsk == nil {
		return nil
	}
	addr := net.JoinHostPort(tr.Host, fmt.Sprint(tr.Port))
	var d net.Dialer
	d.Timeout = 2 * time.Second
	raw, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return err
	}
	connDone := make(chan struct{})
	defer close(connDone)
	go func() {
		select {
		case <-ctx.Done():
			_ = raw.Close()
		case <-connDone:
		}
	}()
	defer raw.Close()

	_ = raw.SetDeadline(time.Now().Add(5 * time.Second))
	c := NewConn(raw)
	if err := c.Send(Hello{
		Type:  VerbHello,
		Proto: ProtoVersion,
		Role:  "daemon",
		Token: tr.Token,
	}); err != nil {
		return err
	}
	msg, err := c.Recv()
	if err != nil {
		return err
	}
	if _, ok := msg.(*Hello); !ok {
		return fmt.Errorf("runner: unexpected daemon handshake reply")
	}
	_ = raw.SetDeadline(time.Time{})

	// Keep the daemon approval attachment alive with periodic pings so the runner
	// detects parent crashes promptly while staying open across multi-minute human waits.
	go func() {
		tk := time.NewTicker(pingEvery)
		defer tk.Stop()
		for {
			select {
			case <-connDone:
				return
			case <-ctx.Done():
				return
			case <-tk.C:
				_ = c.Send(Ping{Type: VerbPing})
			}
		}
	}()

	for {
		m, err := c.Recv()
		if err != nil {
			return nil
		}
		switch v := m.(type) {
		case *AskApproval:
			resp, askErr := onAsk(ctx, v.Req)
			if askErr != nil || resp.Decision == "" {
				resp = tools.MidExecApprovalResp{Decision: "deny"}
			}
			_ = c.Send(ApprovalReply{
				Type:  VerbApprovalReply,
				ReqID: v.ReqID,
				Resp:  resp,
			})
		case *Done:
			return nil
		}
	}
}
