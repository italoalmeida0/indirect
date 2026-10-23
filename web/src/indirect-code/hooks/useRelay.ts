import { batch, createSignal, onCleanup } from "solid-js";
import { createRelayInbox } from "../relayInbox";
import { currentSession } from "../../api";
import type { DaemonCommand } from "../daemon-protocol";

/** Daemon socket + reconnect with backoff (extracted from
 * RemoteCodePage without behavioral changes).
 *
 * The hook is agnostic regarding the protocol: `send` only stamps the hostId, and
 * lifecycle events (open/close/message) are delegated to the page,
 * which composes the remaining domains. */

export type RelayState = "connecting" | "connected" | "disconnected";

export function createRelay(opts: {
  getHostId: () => string;
  /** Decoded message from relay (page handles parse + batch + dispatch). */
  onMessage: (data: unknown) => void;
  /** Socket open and ready: page syncs (models, mirror, session). */
  onOpen: (hostId: string) => void;
  /** Closed socket (non-dispose): page cleans up per-connection state. */
  onClose: () => void;
  /** Before reconnecting: refreshes auth/hosts (token may have expired). */
  ensureAuth: () => Promise<void>;
  isActiveHost: (hostId: string) => boolean;
}) {
  let ws: WebSocket | null = null;
  const [connectionState, setConnectionState] = createSignal<RelayState>("disconnected");
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let disposed = false;

  const inbox = createRelayInbox({
    apply: (messages) => batch(() => {
      for (const message of messages) {
        try { opts.onMessage(message); }
        catch (err) { console.error("Indirect Code message error:", err); }
      }
    }),
    schedule: (flush) => setTimeout(flush, document.hidden ? 250 : 32),
    cancel: (timer) => clearTimeout(timer),
  });
  const onVisibility = () => { if (!document.hidden) inbox.flush(); };
  document.addEventListener("visibilitychange", onVisibility);

  const onOnline = () => {
    if (disposed) return;
    clearTimeout(reconnectTimer);
    reconnectAttempt = 0;
    const currentHost = opts.getHostId();
    if (currentHost) {
      connect(currentHost);
    }
  };
  const onOffline = () => {
    if (disposed) return;
    clearTimeout(reconnectTimer);
    setConnectionState("disconnected");
  };
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);

  onCleanup(() => {
    inbox.clear();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  });

  function wsOpen() {
    connectionState();
    try {
      return !!ws && (ws as WebSocket).readyState === WebSocket.OPEN;
    } catch {
      return false;
    }
  }

  function isDisposed() {
    return disposed;
  }

  function send(payload: DaemonCommand) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (!payload.hostId && opts.getHostId()) {
        payload.hostId = opts.getHostId();
      }
      ws.send(JSON.stringify(payload));
    }
  }

  function connect(hostId: string) {
    inbox.clear();
    clearTimeout(reconnectTimer);
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    if (disposed || !hostId) { setConnectionState("disconnected"); return; }
    const session = currentSession();
    if (!session) return;
    setConnectionState("connecting");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${proto}//${location.host}/api/indirect-code/ws?token=${encodeURIComponent(session.accessToken)}`);
    ws = socket;
    socket.onopen = () => {
      if (socket !== ws || disposed) return;
      reconnectAttempt = 0;
      setConnectionState("connected");
      opts.onOpen(hostId);
    };
    socket.onmessage = (ev) => {
      if (socket !== ws || disposed) return;
      try {
        inbox.push(JSON.parse(ev.data));
      } catch (err) {
        console.error("Indirect Code message error:", err);
      }
    };
    socket.onclose = () => {
      if (socket !== ws || disposed) return;
      inbox.flush();
      setConnectionState("disconnected");
      opts.onClose();
      const delay = Math.min(1000 * 2 ** reconnectAttempt++, 15000);
      reconnectTimer = setTimeout(() => {
        void (async () => {
          try {
            // An authenticated request refreshes an expired dashboard token first.
            await opts.ensureAuth();
          } catch (err) {
            // A transient refresh failure must not kill the reconnect loop:
            // this timer is the ONLY reconnect path, so an unhandled rejection
            // here left the relay disconnected until a page reload. The
            // connection is attempted regardless — the next attempt retries
            // the auth refresh (and the backoff keeps the loop alive).
            console.error("Indirect Code auth refresh failed:", err);
          }
          try {
            if (!disposed && opts.isActiveHost(hostId)) connect(hostId);
          } catch (err) {
            console.error("Indirect Code reconnect failed:", err);
          }
        })();
      }, delay);
    };
  }

  /** Host switch: resets backoff before reconnecting (as the effect did). */
  function resetBackoff() {
    reconnectAttempt = 0;
  }

  /** Disconnects without reconnecting (host switch): next connect() starts fresh. */
  function shutdown() {
    inbox.clear();
    clearTimeout(reconnectTimer);
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
  }

  onCleanup(() => {
    disposed = true;
    clearTimeout(reconnectTimer);
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
  });

  return { connectionState, setConnectionState, wsOpen, isDisposed, send, connect, shutdown, resetBackoff };
}

export type Relay = ReturnType<typeof createRelay>;
