package main

import (
	"sync"
	"sync/atomic"
	"time"
)

// Mailbox capacities. Bounded by design: an unbounded mailbox hides
// backpressure until OOM kills the whole process. Control lanes are small
// but ALWAYS accepted — control must never queue behind data floods.
//
// Single source of truth: tuning.go (env-overridable, F4). These vars are
// bound once at startup; call sites use them directly.
var (
	inboxCap     = tuneInboxCap
	controlCap   = tuneControlCap
	outboxCap    = tuneOutboxCap
	replyTimeout = tuneReplyTimeout
)

// Envelope is the single unit crossing actor boundaries. Payload is one of
// the message types in protocol.go. Reply is nil for fire-and-forget.
type Envelope struct {
	SessionID string
	Payload   any
	Reply     chan any
	// Epoch is the sender's spawn incarnation (0 = pre-epoch caller:
	// always accepted). The actor drops worker mail with a mismatched
	// epoch — a late finish from an orphaned incarnation must never
	// commit into the respawned actor's turn (report item 1).
	Epoch int
}

// replyWithTimeout sends env to inbox and waits for the reply (or timeout).
// Returns (nil, false) on timeout or when the actor is gone.
// Canonical pattern (F5): use this for plain request/reply round-trips.
// Call sites with extra select arms (done channels, fallbacks) stay inline
// and say why — grep shows subscribeFinish/cancelJob keep
// theirs for the <-done arm.
func replyWithTimeout(inbox chan<- Envelope, env Envelope) (any, bool) {
	if env.Reply == nil {
		env.Reply = make(chan any, 1)
	}
	select {
	case inbox <- env:
	default:
		return nil, false // mailbox full: honest backpressure
	}
	select {
	case r := <-env.Reply:
		return r, true
	case <-time.After(replyTimeout):
		return nil, false
	}
}

// fireAndForget delivers env, applying the per-class drop policy when the
// mailbox is full. Control messages must use the control lane instead.
// Used by heartbeat paths and best-effort emits; plain sends stay explicit.
func fireAndForget(inbox chan<- Envelope, env Envelope, onDrop func()) {
	select {
	case inbox <- env:
	default:
		if onDrop != nil {
			onDrop()
		}
	}
}

// configCell is copy-on-write global config. Readers load lock-free;
// writers build a new value and swap the pointer. No actor, no watchdog:
// a pointer swap cannot wedge.
//
// Writers additionally serialize their read-modify-save-store sequence on
// mu (audit bug 75): concurrent onUpdateConfig/rememberSelection/setAutoUpdate
// used to interleave and silently drop each other's fields (the later store
// won). Readers stay lock-free — only writers take mu.
type configCell struct {
	ptr atomic.Pointer[DaemonConfig]
	mu  sync.Mutex
}

func (c *configCell) load() *DaemonConfig { return c.ptr.Load() }

func (c *configCell) store(cfg *DaemonConfig) { c.ptr.Store(cfg) }

// writeLock serializes one config read-modify-save-store sequence. Callers
// hold it across load → mutate → saveDaemonConfig → store so two writers can
// never interleave; the atomic pointer swap alone cannot prevent a lost
// update (each writer copies the OLD value and overwrites the other's save).
func (c *configCell) writeLock() *sync.Mutex { return &c.mu }
