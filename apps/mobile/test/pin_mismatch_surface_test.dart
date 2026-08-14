// 🔴 Card fix-024 (ledger W8-1) — the source is a real-device measured run, not
// deduction.
//
// 2026-08-10, dev-pc-a + LENOVO TB335ZC: after swapping the PC's LAN certificate,
// the tablet tapped the instance to connect — **no navigation, no banner, no
// error code, no change of any kind**, zero TCP on the PC side; the only truth
// lived in `adb logcat` (`CERTIFICATE_VERIFY_FAILED`). The person who ran the
// measured case themselves needed logcat to tell "the tap did nothing" from
// "it was refused", and the user has no logcat.
//
// 🔴 Severity comes from it being **fixable**: scan the QR once more and it is
// fine ⇒ silence turns a solvable problem into an unsolvable one.
// This is the same shape, word for word, as the reason W3 gave
// `INJECT_NO_ACCESSIBILITY`.
//
// ── What this file measures, and what it does not ──────────────────────────
//
// 🔴 **It measures "what the user saw after the refusal", not "whether anyone
// compared fingerprints".** What drives it is a transport stand-in that
// **says it hit a fingerprint mismatch** ([_DeadTransport], same shape as
// lan_tls_pin_test.dart), so it has **zero proving power** over the pinning
// mechanism itself.
// ⚠️ In-place correction (card C1): this paragraph originally wrote "a real
// handshake is unobservable in a unit test" — **that sentence is stale**.
// lan_pin_real_handshake_test.dart now drives a real handshake with a real
// `SecureServerSocket` (identity minted at runtime by server-core's own
// generator) and proves the real engine judges a refused pin handshake as
// `lastDialPinMismatch == true`. What the setter-only approach blocked was
// only "reading back an already-installed callback", not "triggering it
// against a real TLS peer". **What still requires a real device** narrows to:
// the Android-platform half + this page actually painting (ledger D2LAN-B3
// already records one certificate-rotation reverse control: delete pem ⇒ new
// fingerprint ⇒ tablet refuses ⇒ restore ⇒ reconnects immediately, both red
// and green were seen — but the UI stayed silent, which is this card).
//
// 🔴 **Assertions land on the rendered result, not on `Text.data`** (the 0.2.53
// rule, see the `inject_verdict_note_test.dart` file header): that edition had
// 1259 tests all green while the screen showed three letters, because the test
// **knew it would be clipped and then asserted around the clip**. What is
// measured here is the painted paragraph: it really wrapped (positive control),
// did not overflow maxLines, the box did not run out of the viewport, and there
// was no layout-overflow exception.
// ⚠️ `flutter_test` uses the Ahem placeholder font; every glyph is a full-em
// square, much wider than a real font ⇒ this direction is **conservative**:
// unclipped under Ahem ⇒ unclipped on a real device, **the converse does not
// hold**. Do not use this file to argue "this sentence happens to fit on a
// real device".
//
// ── Reverse control (measured red, 2026-08-10 this round) ──────────────────
//
// Disable the `_isPinMismatch` branch in `connections_page.dart` (＝ let a
// fingerprint mismatch degrade into the same toast as any other failure, i.e.
// the "two things synthesized into one" this card is here to fix), and this
// file goes **7 red** (`00:03 +0 -7: Some tests failed.`). The first case's
// original text, verbatim:
//
//   🔴 指纹不符有自己的一句话；够不着仍是老那一句 —— 两者同屏、必须不同
//   Expected: exactly one matching candidate
//     Actual: _KeyWidgetFinder:<Found 0 widgets with key
//             [<'connections.pinMismatch'>]: []>
//      Which: means none were found but one was expected
//   点了实例、被拒了，而屏幕上什么都没有
//
// 🔴 **That reason sentence is ledger W8-1's original wording** — what the
// reverse control reproduced is not "an assertion hung", it is **the defect
// itself**. Restored (`grep REVERSE-CONTROL apps/mobile/lib` = 0,
// `grep 'false &&' connections_page.dart` = 0), 7/7 green again.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/session/endpoint_candidates.dart'
    show kCandidateFailurePrefix;
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/ui/connections_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/locale_terms.dart';

/// The computer that **changed identity** (fingerprint mismatch), and the
/// computer that is **simply unreachable**.
/// Two rows on one screen, one code path; the difference can only come from
/// the **reason** for the failure.
const String kMismatchPc = 'Studio PC';
const String kDeadPc = 'Attic PC';
const String kMismatchEndpoint = 'https://192.168.1.5:41879';
const String kDeadEndpoint = 'https://192.168.1.9:41879';
const String kPin = 'cpANgBlmqH9jzAwdAgGKfHOi';

const ValueKey<String> kNotice = ValueKey<String>('connections.pinMismatch');
const ValueKey<String> kNoticeText =
    ValueKey<String>('connections.pinMismatch.text');

/// The word in every "unreachable" copy that points the user at the network.
/// The identity-mismatch face must not contain it.
///
/// Same origin as `_networkWord` in lan_tls_pin_test.dart — **from the
/// nine-locale expansion (2026-08-14) it is literally the same symbol**
/// (`support/locale_terms.dart`), no longer a comment declaring they share
/// an origin. The split of labour is unchanged: that side asserts the
/// string; this side asserts the paragraph that was actually painted.
String _networkWord(AppLocale locale) => networkWord(locale);

/// A connection that can never complete a dial, and **can say why**.
/// Fingerprint mismatch happens only on [kMismatchEndpoint]: a stand-in that
/// treats everything as a pin mismatch would make "the two sentences differ"
/// a fact it invented, not a fact the product delivered.
class _DeadTransport extends FakeSocketTransport {
  @override
  Future<void> connect({
    required String url,
    String? token,
    String? jwt,
    String? pinFingerprint,
  }) async {
    connectCalls++;
    lastConnectUrl = url;
    lastConnectToken = token;
    lastConnectPin = pinFingerprint;
    final bool mismatch = url.contains('192.168.1.5');
    lastDialPinMismatch = mismatch;
    throw SocketHandshakeException(
      mismatch ? 'HandshakeException: CERTIFICATE_VERIFY_FAILED' : 'timed out',
    );
  }
}

class _Rig {
  _Rig(this.widget, this.transport);
  final Widget widget;
  final _DeadTransport transport;
}

MobileSession _pinnedPairing({
  required String token,
  required String pcName,
  required String endpoint,
  required String instanceId,
}) => MobileSession(
  token: token,
  endpoint: endpoint,
  channel: 'standalone',
  pcName: pcName,
  pairingId: 'pair-$instanceId',
  pcInstanceId: instanceId,
  // A pairing made by scanning the PC's QR — i.e. one that HAS a key to check.
  lanTlsFp: kPin,
  lanTlsFpSource: LanPinSource.qr,
);

Future<_Rig> _rig({AppLocale locale = AppLocale.zh}) async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  final AppSettingsController appSettings = AppSettingsController(prefs: prefs);
  await appSettings.load();
  appSettings.chooseLocale(locale);

  final InMemoryTokenStorage storage = InMemoryTokenStorage();
  await storage.addOrUpdatePairing(
    _pinnedPairing(
      token: 'tok-mismatch-000000000000000000',
      pcName: kMismatchPc,
      endpoint: kMismatchEndpoint,
      instanceId: 'pc-inst-mismatch-00',
    ),
  );
  await storage.addOrUpdatePairing(
    _pinnedPairing(
      token: 'tok-dead-00000000000000000000000',
      pcName: kDeadPc,
      endpoint: kDeadEndpoint,
      instanceId: 'pc-inst-dead-000000',
    ),
  );

  final _DeadTransport t = _DeadTransport();
  final PttSession session = PttSession(
    transport: t,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
    tokenStorage: storage,
    retireTransport: () => FakeSocketTransport(),
  )..candidateProbeTimeout = const Duration(milliseconds: 20);
  // 🔴 Both rows are **reachable**. This is the file's positive control: the
  // reachability probe does not pin (lan_pinning.dart explains why — it is an
  // address picker, not a gate), so the two rows' reachability faces are
  // identical ⇒ any difference that appears on screen can only come from the
  // verdict at dial time, never from "one is online and one is offline".
  session.healthReader = (Uri url, Duration timeout) async =>
      const HealthReading(ok: true, channel: ServerChannel.lan);

  final LoginController login = newTestLogin(transport: session.transport);
  final ConnectionsController connections = ConnectionsController(
    session: session,
    login: login,
    healthReader: (Uri u, Duration d) async =>
        const HealthReading(ok: true, channel: ServerChannel.lan),
    presenceReader: (Uri u, String token, Duration d) async =>
        PcPresenceReading.unknown,
  );

  return _Rig(
    MaterialApp(
      home: ConnectionsPage(
        connections: connections,
        appSettings: appSettings,
        login: login,
        destination: DestinationController(),
        chatPageBuilder: () => const Scaffold(body: Text('CHAT')),
        settingsPageBuilder: () => const Scaffold(body: Text('SETTINGS')),
        historyPageBuilder: () => const Scaffold(body: Text('HISTORY')),
      ),
    ),
    t,
  );
}

/// How many lines this text **really** occupies after layout — asking the
/// already-painted paragraph (dedupe each glyph box's `top`), not re-laying
/// it out with a painter.
int _renderedLineCount(RenderParagraph p, int length) => p
    .getBoxesForSelection(
      TextSelection(baseOffset: 0, extentOffset: length),
    )
    .map((TextBox b) => b.top.round())
    .toSet()
    .length;

/// How wide this text would be on one line **with no constraint**. Compare
/// with the actual box to know whether it was forced to wrap.
double _intrinsicWidth(Text t) {
  final TextPainter p = TextPainter(
    text: TextSpan(text: t.data, style: t.style),
    textDirection: TextDirection.ltr,
    maxLines: 1,
  )..layout();
  return p.width;
}

void main() {
  // ── ① Two sentences, same screen, must differ ────────────────────────────
  testWidgets(
    '🔴 fingerprint mismatch has its own sentence; unreachable is still the old one — both on screen, must differ',
    (WidgetTester tester) async {
      // 411dp = the narrowest mainstream phone, and the width the 0.2.53 card
      // already measured.
      await tester.binding.setSurfaceSize(const Size(411, 890));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final _Rig rig = await _rig();
      await tester.pumpWidget(rig.widget);
      await tester.pumpAndSettle();

      // Nothing before the tap — "it only appears after the tap" is exactly
      // this defect's shape (tapped, no reaction).
      expect(find.byKey(kNotice), findsNothing);

      // ── Fingerprint mismatch ────────────────────────────────────────────
      await tester.tap(find.text(kMismatchPc));
      await tester.pumpAndSettle();

      // This trip really dialed **with the key**: without this line, the
      // sentence below might be labelling a completely unrelated failure.
      expect(rig.transport.lastConnectUrl, kMismatchEndpoint);
      expect(rig.transport.lastConnectPin, kPin);

      final Finder notice = find.byKey(kNotice);
      expect(notice, findsOneWidget, reason: 'tapped the instance, was refused, and the screen showed nothing');
      final String mismatchCopy = tester.widget<Text>(find.byKey(kNoticeText)).data!;

      // 🔴 One fact, one face: must not also pop a toast. Two faces would
      // teach the user "the persistent one can be ignored".
      expect(
        find.byType(SnackBar),
        findsNothing,
        reason: 'the same fact was said twice',
      );
      // Refused is refused — must never walk into the transcription page.
      expect(find.text('CHAT'), findsNothing);

      // ── Unreachable (the other row, same page, same code path) ──────────
      await tester.tap(find.text(kDeadPc));
      await tester.pumpAndSettle();

      final Finder snack = find.byType(SnackBar);
      expect(snack, findsOneWidget, reason: 'the unreachable face lost the sentence it originally had');
      final String deadCopy = tester
          .widget<Text>(find.descendant(of: snack, matching: find.byType(Text)))
          .data!;

      // 🔴 This card's core assertion: **two sentences on the same screen, and
      // they are not the same sentence**. The day someone synthesizes them
      // into one ("cannot connect" eats "identity mismatch"), this line goes
      // red on the spot.
      expect(find.byKey(kNotice), findsOneWidget,
          reason: 'the other row\'s failure wiped this row\'s diagnosis');
      expect(mismatchCopy, isNot(deadCopy));

      // 🔴 And they point at **opposite actions**: one goes check the network,
      // the other goes re-pair. Asserting "they differ" is not enough — two
      // different pieces of nonsense also differ.
      expect(
        deadCopy.contains(_networkWord(AppLocale.zh)),
        isTrue,
        reason: 'the unreachable face lost the "network" action',
      );
      expect(
        mismatchCopy.contains(_networkWord(AppLocale.zh)),
        isFalse,
        reason: 'identity mismatch is still sending the user to check a network that is not broken',
      );
      // The only useful action must be said out loud.
      expect(mismatchCopy, contains('重新扫码'));
    },
  );

  // ── ② 🔴 Must never grow a "connect anyway" ──────────────────────────────
  testWidgets('🔴 this card has nothing tappable on it — no "connect anyway" landing', (
    WidgetTester tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(411, 890));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final _Rig rig = await _rig();
    await tester.pumpWidget(rig.widget);
    await tester.pumpAndSettle();
    await tester.tap(find.text(kMismatchPc));
    await tester.pumpAndSettle();

    final Finder notice = find.byKey(kNotice);
    expect(notice, findsOneWidget);

    // 🔴 Fingerprint mismatch is the **only signal that pinning is working**;
    // giving it a "connect anyway" turns a working defence into a dialog
    // everyone taps through. What is asserted here is not that those four
    // characters are absent from the copy (that is wording, it drifts), but
    // that **structurally this card has nothing tappable** ⇒ anyone who wants
    // to add that button must first make this test go red.
    expect(
      find.descendant(
        of: notice,
        matching: find.byWidgetPredicate(
          (Widget w) =>
              w is InkWell ||
              w is InkResponse ||
              w is GestureDetector ||
              w is ButtonStyleButton ||
              w is MaterialButton,
        ),
      ),
      findsNothing,
      reason: 'something tappable grew on this card',
    );

    // The converse must also be true: this refused connection did **not**
    // dial a second time on its own.
    expect(rig.transport.connectCalls, 1);
  });

  // ── ③ Measurement: assert the painted paragraph, not Text.data ───────────
  testWidgets('🔴 the whole sentence is readable at 411dp — assertions land on the rendered result', (
    WidgetTester tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(411, 890));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final _Rig rig = await _rig();
    await tester.pumpWidget(rig.widget);
    await tester.pumpAndSettle();
    await tester.tap(find.text(kMismatchPc));
    await tester.pumpAndSettle();

    final Finder text = find.byKey(kNoticeText);
    expect(text, findsOneWidget);
    final RenderParagraph p = tester.renderObject<RenderParagraph>(text);

    // Positive control: this sentence **really** is too long for one line —
    // otherwise "was not clipped" proves nothing.
    expect(
      _intrinsicWidth(tester.widget<Text>(text)),
      greaterThan(tester.getSize(text).width),
      reason: 'the sample is too short; this test is blind to the regression',
    );
    expect(
      _renderedLineCount(p, tester.widget<Text>(text).data!.length),
      greaterThan(1),
      reason: 'it did not wrap ⇒ this screen has no layout pressure at all, '
          'measuring equals not measuring',
    );

    // Negative assertion: after wrapping it fits, no maxLines overflow. Today
    // this Text has no maxLines, so this line is a **regression gate**: the
    // day someone adds `maxLines`/`ellipsis` (the 0.2.53 shape), it goes red
    // on the spot.
    expect(p.didExceedMaxLines, isFalse, reason: 'this sentence was eaten by an ellipsis');

    // The whole card is in the viewport, no horizontal overflow (a wrong
    // Row+Expanded would run out).
    final Rect box = tester.getRect(find.byKey(kNotice));
    expect(box.left, greaterThanOrEqualTo(0.0));
    expect(box.right, lessThanOrEqualTo(411.0));
    expect(
      tester.takeException(),
      isNull,
      reason: 'this screen threw a layout exception (most likely overflow)',
    );

    // What the user reads is human language, not our internal identifier.
    expect(find.textContaining(kCandidateFailurePrefix), findsNothing);
  });

  // ── ④ Four locales, one case per locale ──────────────────────────────────
  //
  // ⚠️ Four independent `testWidgets` rather than looping four times inside
  // one case is **what measurement forced**: pumping four new trees in a row
  // inside one case, `pumpAndSettle` timed out from the second locale on —
  // the previous round's controllers (probes, refresh) were still alive, the
  // page never "settled". That looped writing measures "can four trees be
  // stuffed into one test", not "what each locale says". Four cases also
  // name which locale is red.
  for (final AppLocale locale in AppLocale.values) {
    testWidgets('four locales · ${locale.name}: can say this sentence, and does not send the user to check the network', (
      WidgetTester tester,
    ) async {
      // 600dp (not 411): Ahem is a full-em square; the longest locale on a
      // narrow screen would push the ListView past its height, which is
      // unrelated to the question this case asks. This case asks about
      // **copy**; ③ is the one that asks about layout.
      await tester.binding.setSurfaceSize(const Size(600, 1200));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      final _Rig rig = await _rig(locale: locale);
      await tester.pumpWidget(rig.widget);
      await tester.pumpAndSettle();
      await tester.tap(find.text(kMismatchPc));
      await tester.pumpAndSettle();

      final Finder text = find.byKey(kNoticeText);
      expect(text, findsOneWidget, reason: '$locale is missing this sentence');
      final String copy = tester.widget<Text>(text).data!;
      expect(copy, isNotEmpty, reason: '$locale empty sentence');
      expect(
        copy,
        isNot(AppStrings.of(locale).pairError(null)),
        reason: '$locale: fingerprint mismatch is still saying the generic 「配对失败」',
      );
      expect(
        copy.contains(_networkWord(locale)),
        isFalse,
        reason: '$locale: identity mismatch is still sending the user to check the network',
      );
      // Reverse control, per locale: in the same locale, the "unreachable"
      // sentence **must** still carry "network". Without it, the isFalse
      // above might only be true because this locale's copy walked off
      // entirely.
      expect(
        AppStrings.of(locale).pairError(null).contains(_networkWord(locale)),
        isTrue,
        reason: '$locale: the unreachable face itself lost "network", so the assertion above loses its meaning',
      );
    });
  }
}
