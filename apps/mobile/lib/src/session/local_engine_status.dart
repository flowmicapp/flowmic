// SPEC-REF:
//   docs/decisions/2026-08-06-owner-requirement-p8-engine-status-in-diagnostics.md
//   docs/decisions/2026-08-06-p-wave-choices-by-first-responsible.md (P-8 question 2/question 3)
//   docs/strategy/2026-08-07-p8-local-engine-status-design-and-handoff.md
//   apps/mobile/lib/src/session/pc_presence_probe.dart (the precedent that
//     "could not ask IS itself an answer")
//
// ── P-8 「最近一次使用的结果 + 时刻」("the result + time of the last use") —
//    **the copy the phone itself keeps** ─────────────────────────────────────
//
// owner's original wording: "add the local channel's STT engine and LLM
// connection info and status to the connection-diagnostics screen"; the
// ruling (question 2) defaults to showing "the result + time of the last
// use".
//
// 🔴 The premise this card was raised under was 「这个事实没有数据源，服务端哪儿都
// 没有存」("this fact has no data source — the server does not store it
// anywhere"). **That sentence is true, but it answers a different question.**
// The server genuinely does not **store** any last-used record (no column, no
// table, no settings row; `checked_at` lives only inside an in-memory Map in
// pool mode, and standalone never even constructs it) — but the server **has
// said** this, and **said it to this very phone**:
//
//   · producer `apps/server-core/src/stt/orchestrator-core.ts`, two emit lines:
//       `this.emit('engine-status', { provider: this.engine!.id, status: 'ready' });`
//       `this.emit('engine-status', { provider: … ?? 'unknown', status: 'failed' });`
//   · bridge `apps/server-core/src/engine/stt-session.ts`:
//       `o.on('engine-status', (e: OStatus) => this.deps.emitter.emit('stt:engine-status', {`
//   · recipient `apps/server-core/src/socket/handlers/audio.handler.ts`'s
//     `resolveSocket`, whose both branches resolve to **the socket that sent
//     `audio:start`** — that is, **this very phone**:
//       `? (): Pick<Socket, 'emit'> | null => (state as AudioSessionEntry).socket`
//       `: (): Socket => socket,`
//   (quoting the code verbatim rather than line numbers: server-core has a
//   parallel window editing it right now, so line numbers drift but these
//   strings do not.)
//
// ⇒ So "the result of the last use" **needs no new route, no new protocol
// field, and no server-side storage of any kind**: `stt:engine-status` is one
// that was **already in** the 54-event whitelist; this file is only the first
// to write it down. The time used is **the instant this phone received it**,
// so it also owes no clock reconciliation.
//
// ── 🔴 Three questions this class deliberately does NOT answer ───────────────
// ① **Endpoint / model ID / preset name**: not on the frame — `SttEngineStatusSchema`
//    only has `{provider, status, retry_count?}`. Getting them would need a
//    new authenticated HTTP route; the design and handoff are in the handoff
//    document above, **not implemented this round**.
// ② **The AI-organize (LLM) half**: `compose:done` / `compose:error` frames
//    **carry no engine-identity field at all** (`{output_text, task?}` /
//    `{code, message}`) ⇒ the phone side has nothing to remember from. This is
//    a genuine blank, not something omitted; the card is registered in the
//    handoff document §5.
// ③ **"Can the engine actually produce text"**: the producer of `ready` only
//    proves **the connection came up**. This repo has already paid for this
//    once — `apps/server-core/src/stt/pool-health.ts`'s file header records,
//    verbatim, that a handshake-style probe still reports OK for an account
//    that "connects fine but cannot produce text". ⇒ this class's vocabulary
//    states `ready` as **"connected", not "healthy"/"usable"**, and the copy
//    side is pinned the same way (engine_status_strings.dart).
//
// ── 🔴 The identity triple: the shape "never allow crosstalk" takes on this
//    face ───────────────────────────────────────────────────────────────────
// An observation belongs to the engine behind **a particular channel, a
// particular endpoint, a particular PC**. Painting A's observation into B's
// diagnostics is the same mistake as queue crosstalk — it just looks like a
// harmless status line. So [readFor] is an **exact-match comparison**, not a
// plain read: if any one of the three does not match, treat it as no
// observation at all.
// ⚠️ The direction is **deliberately conservative**: better to under-display
// once (the user says one more sentence and it reappears) than to display a
// wrong one.
class LocalEngineObservation {
  const LocalEngineObservation({
    required this.provider,
    required this.outcome,
    required this.atUtc,
    required this.channelIsLan,
    required this.endpoint,
    required this.pcId,
  });

  /// The engine's self-reported name (`provider`). When the server cannot get
  /// one it fills in `'unknown'` itself, and we accept it as-is — **that too
  /// is an honest statement** ("I did not say who I am"); this layer must not
  /// invent a nicer-looking one on its behalf.
  final String provider;

  final LocalEngineOutcome outcome;

  /// **The instant this phone received that frame** (UTC). Not the server's
  /// instant: the frame carries no timestamp, and the only thing we have
  /// genuinely measured is receipt time. The copy side must say this "on what
  /// grounds" out loud.
  final DateTime atUtc;

  /// Whether [ServerChannel] was `lan` at the moment of observation. Stored as
  /// a bool rather than that enum so this file need not depend on the
  /// signaling layer — **and so a cloud-leg observation can never impersonate
  /// a local one at the type level**.
  final bool channelIsLan;

  /// The dial endpoint at the moment of observation (`session.reconnect.url`).
  /// It is exactly this value the diagnostics sheet displays, so the two sides
  /// share the same source — "the endpoint shown" and "who this observation
  /// belongs to" cannot disagree.
  final String endpoint;

  /// The PC paired at the moment of observation (`session.pcId`). May be null
  /// (a QR-code pairing may have none), but null only equals null — see
  /// [LocalEngineStatusStore.readFor].
  final String? pcId;
}

/// The engine's self-reported three-way state. **This is connection state,
/// not usability state** (see file header ③).
enum LocalEngineOutcome { ready, reconnecting, failed }

/// 「上一次转录开始时，这台电脑上的转写引擎自己说了什么」("what the transcription
/// engine on that computer itself said, the last time transcription started").
///
/// Deliberately **not** a `ValueNotifier`: the only reader is an on-demand
/// modal sheet, which only needs to read it once at build time. No listener
/// means no dispose debt — 0.2.51's "`_pcBusy` that was never disposed" is
/// exactly the cautionary counter-example, and the cheapest fix is never
/// incurring that debt in the first place.
class LocalEngineStatusStore {
  LocalEngineObservation? _last;

  /// Production entry point: the raw payload of one `stt:engine-status` frame.
  ///
  /// 🔴 **Off-contract means the WHOLE frame is dropped, never half-accepted**:
  /// if `status` is not one of the three states, that means this frame is not
  /// what we think it is, and recording `provider` alone at that point would
  /// manufacture an observation that "has a name but no verdict" —
  /// indistinguishable at the type level from a real observation. This is the
  /// same cut as pc_presence_probe's rule: "a missing field / wrong type ⇒
  /// unknown, never backfilled with something that merely looks plausible."
  void observeFrame(
    Map<String, Object?> data, {
    required bool channelIsLan,
    required String endpoint,
    required String? pcId,
    DateTime? nowUtc,
  }) {
    final Object? rawProvider = data['provider'];
    final Object? rawStatus = data['status'];
    if (rawProvider is! String || rawProvider.isEmpty) return;
    final LocalEngineOutcome? outcome = switch (rawStatus) {
      'ready' => LocalEngineOutcome.ready,
      'reconnecting' => LocalEngineOutcome.reconnecting,
      'failed' => LocalEngineOutcome.failed,
      _ => null,
    };
    if (outcome == null) return;
    _last = LocalEngineObservation(
      provider: rawProvider,
      outcome: outcome,
      atUtc: (nowUtc ?? DateTime.now()).toUtc(),
      channelIsLan: channelIsLan,
      endpoint: endpoint,
      pcId: pcId,
    );
  }

  /// 「**现在这一屏**能不能引用上一次那条观测」("can **this current screen**
  /// cite the last observation").
  ///
  /// Only counts when the identity triple matches exactly (file header). Also,
  /// when [channelIsLan] is false, returns `null` outright: the owner scoped
  /// P-8 to **the local channel only**, and a cloud-leg observation is a true
  /// statement about **someone else's engine** — placed here it would become a
  /// false one.
  LocalEngineObservation? readFor({
    required bool channelIsLan,
    required String endpoint,
    required String? pcId,
  }) {
    final LocalEngineObservation? o = _last;
    if (o == null) return null;
    if (!channelIsLan || !o.channelIsLan) return null;
    if (endpoint.isEmpty || o.endpoint != endpoint) return null;
    if (o.pcId != pcId) return null;
    return o;
  }
}
