# FixWireQueue — progress notes (bugs 19, 42, 49 + 33 daemon half)

Owned files: `cmd/daemon/ws_server.go`, `turn_queue.go`, `turn_attachments.go`,
`protocol.go`, `sessions_admin.go` + new `cmd/daemon/wire_queue_regression_test.go`.
NOT touched (other agents): session_actor.go, supervisor.go, store_*.go, boot.go, packages/**.

## Bug 19 — queue_add/queue_update drop `yolo` on the wire
- Fix: `ws_server.go:541-549` (queue_add) and `ws_server.go:558-577` (queue_update)
  decode `YOLO bool json:"yolo"` and pass `YOLO: req.YOLO` into `queueOpMsg` (actor
  consumes it on "add"; session_actor NOT edited).
- Note: `queueOpMsg.YOLO` is ignored by onQueueOp's "update" branch today. If update
  ever honors it, it must be tri-state — a defaulted `false` must never clobber the
  stored flag (the web sends no yolo on queue_update).
- Test: `TestQueueAddWireCarriesYOLO` (ws dispatch, queue_add yolo=true → echoed item
  keeps yolo). Fails before, passes after.

## Bug 33 (daemon half) — queue_update attachmentIds contract
- Contract (documented at `protocol.go:31-42` (queueOpMsg), `ws_server.go:558-565`
  (wire comment), `turn_queue.go:16-18` (queue doc)):
  - `attachmentIds` omitted/null = attachments UNCHANGED (partial update);
  - `attachmentIds: []` = cleared; `[ids]` = replaced (full-item update).
  - Full-item update also applies `text` (`""` clears it); partial update applies
    `text` only when non-empty. Text-only edit => OMIT `attachmentIds`; clearing the
    text => send the full attachment list (`[]` for none).
- Fix: `queue_update` request decodes `AttachmentIDs *[]string` (mirrors
  `edit_message`'s established pattern) and converts explicitly, so omitted != empty
  at the wire boundary. Behavior of the JSON decode itself was already tri-state; the
  change makes it explicit + documented + test-locked.
- Test: `TestQueueUpdateAttachmentIdsContract` (contract lock at the wire).
- Web alignment needed (for the web agent):
  1. daemon-protocol.ts:39 `queue_update` type: `attachmentIds?: string[]` (optional);
     useQueue.ts `updateQueued`/`saveEdit` must OMIT the field for a text-only edit
     (today it always sends an array -> daemon full-replaces -> attachments missing
     from the draft are silently dropped).
  2. useQueue.ts `beginEdit` must preload ALL `item.attachmentIds` (the item's own
     list; `noteSessionFiles` only supplies metadata).
- session_actor note (FixDaemonActor): clearing text while preserving attachments
  requires resending the attachment list today (empty text + omitted ids is a no-op).
  A `Text *string`/`YOLO *bool` tri-state in queueOpMsg "update" would remove the
  coupling; not needed for the web fix above.

## Bug 42 — onQueueSendNow loses sendNow on startTurn failure (idle branch)
- Fix: `turn_attachments.go:231-239` idle error path sets `a.sendNow = true` before
  returning (mirrors the running branch at :246), so the next finishTurn promotes
  the item first.
- Test: `TestQueueSendNowKeepsIntentOnStartFailure` (idle actor + persistErr ->
  sendNow==true + item back in queue). Fails before, passes after.

## Bug 49 — dashboard bg_cancel has no ownership check
- Fix: `ws_server.go:735-773` — bg_cancel request carries `sessionId`; before
  cancelling, query the job's owner via `bgQueryMsg` (same as
  `bgSupervisor.cancelJob`) and refuse when `sessionId` is empty or != owner
  ("fail closed", mirrors `owner == "" || owner != caller`). Refusals answer with
  an `error` event (`ws_server.go:747` sessionId-less, `ws_server.go:768`
  foreign/unknown).
- Test: `TestBGCancelRefusesForeignAndUnnamedJobs` (sA cannot cancel sB's job;
  session-less frame refused; owner still cancels). Fails before, passes after.
- Web alignment needed: daemon-protocol.ts:43 `bg_cancel` = `{ type: "bg_cancel";
  jobId: string; sessionId: string }`; useBackground.ts `stop()` must send
  `sessionId: opts.getSessionId()` (daemon refuses otherwise).
