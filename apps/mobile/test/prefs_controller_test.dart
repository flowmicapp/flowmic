// 2026-09-03 (WP-B2) — the three phone-owned switches beside the card: AI
// polish (+ strength), two-pass refine, the scenario-inference consent.
//
// Same two-sentence contract as scenario_card_controller_test.dart, pinned on
// its own controller so a regression in one cannot hide behind the other:
//   ① every edit applies and persists locally, immediately;
//   ② a NEVER-SET row stays null and is therefore absent from the bundle the
//      transcription request carries — the server applies ITS default, which is
//      a decision this phone cannot make (prefs_controller.dart's header);
//   ③ nothing here touches a wire: the rows are READ by
//      settings/phone_prefs_payload.dart when `audio:start` / `compose:start`
//      is built (pinned in phone_prefs_payload_test.dart).
// Plus the shape pins the server's readers depend on: `strength` is one of the
// protocol's two names, and the consent row always says `granted_for:
// 'external'` (design D8).
//
// The push-era cases (「every edit pushes」, 「every admission re-pushes」,
// 「offline ⇒ pending」) are DELETED, not ported — the server refuses those
// writes now, and re-asserting a deleted mechanism is how a deletion gets
// quietly undone.
//
// ── REVERSE CONTROL (executed 2026-09-03) ──────────────────────────────────
// Recorded in phone_prefs_payload_test.dart's header, which owns the
// 「no settings writer left」 assertion for the whole app.

import 'package:flowmic/src/settings/prefs_controller.dart';
import 'package:flutter_test/flutter_test.dart';

({PrefsController ctrl, InMemoryPrefsStore store}) _wire({
  PhonePrefs stored = PhonePrefs.empty,
}) {
  final InMemoryPrefsStore store = InMemoryPrefsStore(stored);
  return (ctrl: PrefsController(store: store), store: store);
}

void main() {
  // ── ② never-set is a real state ───────────────────────────────────────────
  test('untouched switches show the product default and are held as null', () async {
    final w = _wire();
    await w.ctrl.load();
    expect(w.ctrl.polishEnabled, isTrue);
    expect(w.ctrl.polishStrength, PolishStrength.strict);
    expect(w.ctrl.refineEnabled, isFalse);
    expect(w.ctrl.inferenceGranted, isFalse);
    expect(w.ctrl.prefs.polish, isNull);
    expect(w.ctrl.prefs.refine, isNull);
    expect(w.ctrl.prefs.inference, isNull,
        reason: 'a never-set row is not a value; the bundle omits it and the '
            'server applies its own default');
    w.ctrl.dispose();
  });

  // ── ① each edit applies, persists, and has the exact wire shape ───────────
  test('turning polish off holds stt.polish {enabled:false, strength:strict} and persists it', () async {
    final w = _wire();
    w.ctrl.setPolishEnabled(false);
    expect(w.ctrl.prefs.polish!.toJson(),
        <String, Object?>{'enabled': false, 'strength': 'strict'});
    expect((await w.store.load()).polish, const PolishPrefs(enabled: false));
    w.ctrl.dispose();
  });

  test("choosing smooth holds the protocol's wire name and keeps the switch state", () async {
    final w = _wire();
    w.ctrl.setPolishStrength(PolishStrength.smooth);
    expect(w.ctrl.prefs.polish!.toJson(),
        <String, Object?>{'enabled': true, 'strength': 'smooth'});
    expect(PolishStrength.strict.name, 'strict', reason: 'name IS the wire value (stt-polish.ts)');
    expect(PolishStrength.smooth.name, 'smooth');
    w.ctrl.dispose();
  });

  test('turning refine on holds stt.refine {enabled:true} — and leaves the others unset', () async {
    final w = _wire();
    w.ctrl.setRefineEnabled(true);
    expect(w.ctrl.prefs.refine!.toJson(), <String, Object?>{'enabled': true});
    expect(w.ctrl.prefs.polish, isNull);
    expect(w.ctrl.prefs.inference, isNull);
    w.ctrl.dispose();
  });

  test('the consent switch holds a ScenarioConsentRow with granted_for external (D8), both ways', () async {
    final w = _wire();
    w.ctrl.setInferenceGranted(true);
    expect(w.ctrl.prefs.inference!.toJson(),
        <String, Object?>{'granted': true, 'granted_for': 'external'});
    w.ctrl.setInferenceGranted(false);
    expect(w.ctrl.prefs.inference!.toJson(),
        <String, Object?>{'granted': false, 'granted_for': 'external'},
        reason: 'revoking is an explicit row too — the server must hear NO, not silence');
    w.ctrl.dispose();
  });

  test('a no-op edit (same value) writes nothing new', () async {
    final w = _wire(stored: const PhonePrefs(refine: RefinePrefs(enabled: true)));
    await w.ctrl.load();
    w.ctrl.setRefineEnabled(true);
    expect(w.ctrl.prefs.refine, const RefinePrefs(enabled: true));
    w.ctrl.dispose();
  });

  test('adopt() (the settings restore path) replaces all three rows and persists them', () async {
    final w = _wire();
    w.ctrl.adopt(const PhonePrefs(
      polish: PolishPrefs(enabled: false),
      refine: RefinePrefs(enabled: true),
    ));
    expect(w.ctrl.polishEnabled, isFalse);
    expect(w.ctrl.refineEnabled, isTrue);
    expect((await w.store.load()).refine, const RefinePrefs(enabled: true));
    w.ctrl.dispose();
  });

  // ── the store round-trips exactly the wire shapes ─────────────────────────
  test('PolishPrefs / RefinePrefs / InferenceConsentPrefs parse their own JSON and refuse garbage', () {
    expect(PolishPrefs.tryFromJson(<String, Object?>{'enabled': true, 'strength': 'smooth'}),
        const PolishPrefs(enabled: true, strength: PolishStrength.smooth));
    expect(PolishPrefs.tryFromJson(<String, Object?>{'enabled': true}),
        const PolishPrefs(enabled: true), reason: 'absent strength reads as strict (protocol default)');
    expect(PolishPrefs.tryFromJson(<String, Object?>{'enabled': 'yes'}), isNull);
    expect(RefinePrefs.tryFromJson(<String, Object?>{'enabled': false}), const RefinePrefs(enabled: false));
    expect(RefinePrefs.tryFromJson('nope'), isNull);
    expect(InferenceConsentPrefs.tryFromJson(<String, Object?>{'granted': true, 'granted_for': 'local'}),
        const InferenceConsentPrefs(granted: true));
    expect(InferenceConsentPrefs.tryFromJson(<String, Object?>{'granted_for': 'external'}), isNull);
  });
}
