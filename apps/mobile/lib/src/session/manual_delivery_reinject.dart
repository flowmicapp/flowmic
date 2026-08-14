// 800-line cap: `reInject`'s body moved VERBATIM out of manual_delivery.dart,
// the same `part` split chat_controller.dart uses for its own hosts. Every line
// of the argument below is unchanged; only the receiver is now explicit ([d]),
// which the chat_controller parts already established as the convention.

part of 'manual_delivery.dart';

/// Backfill delivery — re-deliver an existing row to the PC's current focus (RV-02).
///
/// The FOURTH delivery path, and until this card the only one that answered
/// 「did it go out」 with silence. Three lies lived in its nine lines:
///   • NO watchdog — `markReinjecting` flipped the row to ⏳ and nothing ever
///     came back to move it, so a backfill delivery the PC never answered
///     stayed 「delivering」
///     for the rest of the session. The other three paths were given this
///     timer in 0.2.8; this one was simply forgotten.
///   • the emit failure was swallowed by TimelineSyncGate's best-effort
///     `_safeEmit` — the right disposition for a create (the row is safe on
///     disk), a lie for a DELIVERY the user is watching.
///   • an unsynced row was stamped `markSynced` the instant the create was
///     handed over, before any ack — a claim of a landing from 「the emit
///     didn't throw」.
///     (Moot as of 0.2.27: there is no server copy to claim anything about.)
///
/// FOUR production entry points reach here (the inline resend beside the ✗ /
/// long-press backfill delivery /
/// resend after edit / the failure banner's resend), all of them through
/// ChatController.reInject —
/// so fixing it here fixes all four. The banner's resend calls it ONCE PER
/// ROW:
/// N deliveries in flight at the same instant, which is exactly why the claim
/// registry is per-delivery ([_InFlightSend]) rather than one slot.
///
/// 0.2.27 — IT NOW CARRIES ITS OWN TEXT. It used to emit `history:inject{id}`
/// and let the server look the row up and forward `output_text`; the server does
/// not hold the row any more (owner's architecture ruling), so the OWNER supplies the words.
/// The frame was `inject:request{text, source:'history', entry_id}` — byte-for-
/// byte what history.handler.ts used to emit on the phone's behalf. No protocol
/// field was added for it: `source:'history'` and `entry_id` were both there.
///
/// 0.2.31 (RV-74 / RV-72 prerequisite) — it now also carries `request_id` and `mode`.
/// `entry_id` is UNCHANGED and still the key the verdict comes back on (A-58):
/// `InjectResult.correlationId` prefers `entry_id` over `request_id`, so the
/// claim registry below is untouched by the addition.
///
/// Deliberately still synchronous, unlike ➤/picture: all four call sites fire and
/// forget, and the proof of delivery is the PC's own inject:result, which is
/// what the watchdog insists on. (RV-37 「backfill delivery lacks a pre-send
/// liveness probe」 is a real gap and is
/// deliberately NOT closed here — it belongs with window B's outbox, which is
/// the same scenario.)
Future<ComposeSendFailure?> runReInject(
  ManualDelivery d,
  TimelineEntry entry,
) async {
  // Red line: a cloud-instance record (origin:'cloud') never injects and never
  // joins room sync — there is no PC focus target. The context menu still
  // offers backfill delivery for uniformity, but it is structurally inert for cloud.
  if (entry.origin == 'cloud') return null;
  // R6 T-4: an image row cannot be re-injected THROUGH THIS PATH. This path
  // re-sends the stored row's TEXT, which for a picture is its descriptor
  // (`🖼 PNG · 214 KB`) — typing those characters into the user's document and
  // calling it a delivery would be a fabricated success (red line F2). The guard
  // holds even if some future caller forgets.
  //
  // ⚠️⚠️ Correction (窗口B3-2b) — THE GUARD STAYS, ITS SECOND REASON DID NOT. This
  // comment used to continue: 「The bytes are not retained, so there is
  // genuinely nothing to re-send. The menu already withholds the action」.
  // Kept verbatim rather than rewritten (anti-façade ④): the bytes ARE retained
  // now — 窗口B3-2a parks the compressed copy in `OutboxBlobStore` until the
  // delivery succeeds — so 「nothing to re-send」 went false inside two windows,
  // and a reader who stopped at that sentence would conclude picture resend is
  // impossible when it is merely NOT THIS FUNCTION'S JOB.
  //
  // ⇒ A picture resend is `outboxResendImage` (chat_outbox_host.dart): the SAME
  // queued delivery tried again, under its own frozen `request_id` and
  // `created_at`. Minting a new delivery here — which is exactly what this
  // function does — would paste the picture twice when the first attempt landed
  // late. Two different actions, and the row's button dispatches between them
  // (`ChatController.resendEntry`).
  if (entry.isImage) return null;
  // The link is KNOWN down — the same gate ➤ and picture judge themselves by. The
  // frame cannot leave, so the row says so NOW rather than going to ⏳ and
  // waiting 20 s for the deadline to discover what the client already knows.
  if (!d._host.canCompose) {
    diag('reinject.link_down', <String, Object?>{'entry_id': entry.id});
    return d.failSettled(
      <String>[entry.id],
      ComposeSendFailure.notConnected,
      code: 'LINK_DOWN',
    );
  }
  // The row is GONE (deleted since the caller captured it — the banner's resend
  // can hold ids for as long as the banner is up). Nothing to re-deliver; and
  // emitting anyway would let the verdict fall back onto `lastAwaitingInject`
  // and write this delivery's truth onto somebody else's row.
  if (d._host.store.findById(entry.id) == null) return null;
  // An INVARIANT guard, in the same 「structurally inert」 shape as the cloud and
  // image gates above: no banner, no ✗, nothing claimed — because nothing
  // happened. It needs both `output_text` AND `source_text` empty, which no
  // build path can produce (every one requires non-empty text, and clearing a
  // row's face falls back to the immutable original — which is also exactly
  // what the row SHOWS, so it is the honest thing to deliver).
  //
  // It is here because 0.2.27 is the first version where this device can SEE
  // the case: the server used to supply the text, so an empty one went out as
  // `text:''`, the PC answered ok:true, and the row settled ✓ injected with
  // nothing typed anywhere. A fabricated success (red line F2) must not be one
  // future refactor away.
  final String text = entry.displayText;
  if (text.trim().isEmpty) {
    diag('reinject.empty_text', <String, Object?>{'entry_id': entry.id});
    return null;
  }
  // Back to ⏳ while the PC's verdict is outstanding; delivery stays immutable.
  d._host.store.markReinjecting(entry.id);
  // ── RV-72/RV-29 prerequisite: backfill delivery now mints its OWN `request_id` ──────────────────
  //
  // WHY IT DID NOT, AND WHY THAT REASONING DOES NOT HOLD. The comment here used
  // to read: 「Minting one would add a second key for one delivery, and the
  // desktop's INJ-3 dedup would then treat two deliberate backfill deliveries of
  // the same row as
  // two different sends — which they are.」 Both halves are wrong, and the second
  // one argues for the opposite of what it concluded:
  //   · INJ-3 never sees this frame at all. `source:'history'` is on the desktop
  //     deduper's bypass list (src-tauri/src/socket/dedup.rs `is_bypass_source`),
  //     which returns Proceed before `request_id` is ever read and never caches a
  //     result. Adding the key changes nothing there — verified, not assumed.
  //
  // ⚠️⚠️ Correction (窗口B3-2a, 2026-07-31) — THE BULLET DIRECTLY ABOVE IS NOW FALSE,
  // ALL THREE CLAUSES OF IT. Kept verbatim rather than rewritten, because
  // anti-façade ④ is the rule that caught it: 「the sentence in a comment
  // that defends a design is itself an assertion that can be falsified by
  // grep」 — and this one carried the words 「verified, not
  // assumed」, which is exactly the phrasing that stops the next reader from
  // checking. It was true when written and went false inside the same window,
  // which is the whole hazard: a comment does not get re-verified when the code
  // it describes is fixed somewhere else.
  //
  // WHAT RV-29 ACTUALLY LANDED (re-grepped for this card, in the source, today):
  //   · `is_bypass_source` NO LONGER EXISTS. It was renamed to
  //     `skips_the_inj1_byte_window` (dedup.rs) precisely because the old name
  //     answered 「exempt?」 without saying FROM WHAT, and that ambiguity is what
  //     let the early-return grow in front of the request_id lookup.
  //   · `classify()` now does the INJ-3 `request_id` lookup **FIRST, for every
  //     source**, ahead of any source test. `source:'history'` is exempt from the
  //     INJ-1 BYTE WINDOW and from nothing else.
  //   · `record()` caches the result under the id **for every source**.
  // ⇒ INJ-3 sees this frame, reads this id, and will replay the cached verdict
  //   for a repeat of it. That is not a reason NOT to mint — it is the mechanism
  //   that makes the queue's retry idempotent, and it is why 窗口B3-2a's outbox
  //   re-sends under the id minted at ENQUEUE instead of a fresh one per attempt.
  // ⚠️ Two stale references to the old name survive in comments inside
  //   src-tauri/src/socket/wire.rs (comments only, no such symbol — grep the old
  //   name there if you need them). Reported, deliberately not touched: 卡 stop
  //   line 「do not touch apps/desktop」.
  //   🔴 The line numbers have been deliberately removed (the original text
  //   was `:374` and `:725`, changed 2026-08-07 W5a): those two coordinates
  //   originally pointed at a comment saying 「this symbol doesn't exist」,
  //   **they were never going to anchor to anything by nature**, and W9's
  //   IJ-01 is currently editing this file
  //   ⇒ keeping the line numbers would only postpone the next detonation to
  //   its next edit.
  //   · 「which they are」 — two deliberate backfill deliveries ARE two
  //     different sends, so being
  //     told apart is the CORRECT outcome, not the hazard the sentence treats it
  //     as. What actually had no key was the delivery: a re-inject was
  //     indistinguishable from every other re-inject of the same row.
  //
  // WHY IT MUST NOW. owner 2026-07-31 (docs/decisions/2026-07-31-owner-b2-outbox-
  // rulings.md ②) ruled 「one resend = one new row on the PC」, whose
  // implementation splits the two
  // questions `entry_id` answers today: `request_id` becomes 「this delivery」
  // (the PC
  // row address + the idempotency key a B2 drain retries under) and `entry_id`
  // falls back to pure A-58 correlation. A path that mints no delivery id cannot
  // participate in either. The queue also demands it directly: 「a network
  // retry of the same delivery = the same request_id = the same row」 needs
  // an id to exist before the retry does.
  //
  // ⚠️ THE OTHER HALF, AND ITS HISTORY (kept as a correction, not rewritten —
  // anti-façade ④: a comment arguing for a design is itself a greppable claim,
  // and this one went false within the same window). When this line was first
  // written it said 「the PC still addresses the row by entry_id (row_id()
  // checks it FIRST), so a backfill delivery still upserts the ORIGINAL row;
  // flipping
  // row_id() is a desktop card, deliberately not done here」. That desktop
  // card has since landed: `row_id()` now reads `request_id` FIRST
  // (src-tauri/src/socket/row_transit.rs), and the PC hands the address it
  // minted back on the bridge copy of the verdict (`row_id`) instead of the
  // frontend re-deriving it — so `entry_id` really is pure A-58 correlation
  // on both ends now. ⇒ A backfill delivery from here DOES add a new PC row.
  // Anything that
  // stops minting this id silently re-breaks RV-72.
  // Held in a local so the forensic line below can NAME it: a delivery id that
  // never reaches the log cannot be used to answer 「what actually happened to
  // this delivery」, which
  // is most of the reason it exists.
  final String requestId = d.mintRequestId('r');

  // 🔴 Persist to disk before sending (§3.1). async, NOT `unawaited`:
  // fire-and-forget weakens
  // 「enqueue completion precedes sending」 into 「enqueue START precedes
  // sending」, and that completed write is the
  // only thing this queue sells (all four call sites were already
  // fire-and-forget). Snapshot built synchronously above. RV-37 「backfill
  // delivery lacks a pre-send
  // liveness probe」 stays open. `resentAt` is now(), not `entry.createdAt` —
  // see the emit's
  // own `createdAt` note below. Pinned: outbox_stations_test 「backfill
  // delivery persists to disk before sending」.
  final DateTime resentAt = DateTime.now().toUtc();
  await d._host.outbox.enqueueText(
    requestId: requestId,
    entryId: entry.id,
    // Backfill delivery is ABOUT this row (RV-72 mints a NEW PC row) ⇒ the frame names it.
    wireEntryId: entry.id,
    source: InjectSource.history.name,
    text: text,
    mode: entry.mode.name,
    createdAt: resentAt,
    sourceText: entry.showsSourceLine ? entry.sourceText : null,
    deviceLabel: cachedDeviceLabel(),
    // The utterance's own duration — a backfill delivery re-delivers the same
    // words, and they
    // took the same time to say. Null stays null (typed rows).
    durationMs: entry.durationMs,
  );

  final bool ok = d._gate.emitInject(
    InjectRequestPayload(
      text: text,
      source: InjectSource.history,
      // 🔴 L8 (owner 2026-08-02) — 「manual user action, unconditionally
      // counted as expected」. All four entry points
      // that reach here are a PRESS (the inline resend beside the ✗ /
      // long-press backfill delivery / resend after edit /
      // the failure banner's resend), which is the SECOND row of owner's
      // ruling table
      // (「allow injection」). ⚠️ Note this is the one place where `source`
      // and this field
      // would give opposite answers: `source:'history'` looks like the archetypal
      // backfill delivery and is exactly the frame that MUST inject, because
      // a human just asked
      // for it. That is why the two are separate fields.
      injectOrigin: InjectOrigin.live,
      requestId: requestId,
      entryId: entry.id,
      // RV-74: the row already exists and knows what it is, so its own snapshot
      // is the answer — a backfill delivery must not re-file a translate row
      // under realtime on the PC
      // just because the mode chip has moved since. (`d._host.mode` would say
      // 「what is selected right now」, a different question entirely.)
      mode: entry.mode,
      durationMs: entry.durationMs,
      // 卡 M row-transit fields. ⚠️ TWO EVENTS, ONE FIELD. This used to read
      // 「backfill delivery
      // is the ONE path where `createdAt` genuinely can be days old (window B2's
      // queued-offline scenario this field exists for)」 — which folded an
      // active resend
      // into B2's queue drain. They are different events:
      //   · The FIRST delivery, INCLUDING a B2 drain of a never-delivered
      //     utterance, records
      //     the SPEAKING (owner:「no matter how long it takes, everything
      //     must be delivered」) ⇒ `entry.createdAt`,
      //     which is what the other three call sites stamp and must keep stamping.
      //     窗口B2 must NOT copy this line: a drain is a FIRST delivery.
      //   · Backfill delivery records THIS re-delivery, which happened now.
      //     RV-72 made it a NEW
      //     PC row (`row_id` = `req:{request_id}`) and owner 2026-07-31 real
      //     device: 「a resend
      //     must be recorded by the time of the resend」 — stamping the old
      //     instant sorts that new row back
      //     under rows it postdates (desktop: created_at desc, and created_at is
      //     FROZEN there, so nothing downstream can repair it).
      // Nothing is lost: the original row still carries the spoken time on both
      // timelines (that is what starting a new row buys), and this phone's
      // row is untouched.
      createdAt: resentAt,
      sourceText: entry.showsSourceLine ? entry.sourceText : null,
      // R6 T-4 (above, `entry.isImage` guard): an image row never reaches this
      // line, so entryType/thumbB64 stay omitted — a re-inject is always a
      // plain transcript resend.
      deviceLabel: cachedDeviceLabel(),
      targetPcId: d._host.targetPcId,
    ),
  );
  diag('emit.reinject', <String, Object?>{
    'entry_id': entry.id,
    'request_id': requestId,
    'mode': entry.mode.name,
    'text_chars': text.length,
    'handed_to_socket': ok,
  });
  // The frame never left the device: the row goes back to ✗ with a named
  // reason instead of pretending a delivery is in flight.
  if (!ok) {
    return d.failSettled(<String>[entry.id], ComposeSendFailure.wireFailed);
  }
  // The claim stays keyed on the ENTRY id now that the frame also carries a
  // request_id, because that is the key the answer will really arrive under:
  // the PC echoes BOTH verbatim (A-58) and `InjectResult.correlationId` prefers
  // `entry_id`. So this is not a second claim mechanism — the registry is
  // unchanged, and `_armResultWatch` still supersedes by `covered`, which is
  // what makes a re-inject of the same row take over its predecessor's claim.
  d._armResultWatch(entry.id, <String>[entry.id]);
  d._host.deliveryNotify();
  return null;
}
