// Card CR-9 — the continuous-recording entry's DECISION, in isolation.
//
// SPEC-REF:
//   apps/mobile/lib/src/audio/continuous_offer.dart
//   docs/ui-design/2026-08-29-continuous-recording-demo.html (A-1 / A-2 / A-3,
//     B-1 / B-2)
//   task unit §6 C1c (「balance < ceiling ⇒ say it will stop early」) and C6
//     (「unavailable ⇒ AND a reason」)
//
// ⚠️ WHAT THIS FILE CANNOT PROVE, so that nobody reads it as more than it is:
// C6 says the reason must be asserted on the RENDERED result (the 0.2.53 law —
// a sentence the user cannot read is a sentence that was not printed). This file
// proves the decision only. The rendering is a separate file with a separate
// finder, and neither one covers for the other.

import 'package:flowmic/src/audio/continuous_offer.dart';
import 'package:flowmic/src/auth/cloud_summary.dart';
import 'package:flowmic/src/session/instance_probe.dart' show ServerChannel;
import 'package:flowmic/src/signaling/wire_payloads.dart' show FlowMode;
import 'package:flutter_test/flutter_test.dart';

/// A summary with both meters and a ceiling — the ordinary paid account.
CloudSummary _summary({
  double usedMin = 88,
  double limitMin = 900,
  int? cap = 30,
}) => CloudSummary(
  minutes: CloudMeter(used: usedMin, limit: limitMin),
  tokens: const CloudMeter(used: 1, limit: 20000000),
  continuousMinutes: cap,
);

ContinuousOffer _offer({
  bool recordOnly = true,
  FlowMode mode = FlowMode.realtime,
  bool linkUp = true,
  // Every existing case in this file describes a phone that IS signed in —
  // the sign-in gate is its own group below (「owner ruling 2026-09-02」).
  bool signedIn = true,
  CloudSummary? summary,
  // A 4xx answers with no body worth parsing, so 「refused」 means there is no
  // summary at all — and `summary: null` cannot say that here, because null
  // falls back to the default. An explicit flag is the only way to ask for it.
  bool noSummary = false,
  CloudSummaryRefusal? refusal,
  ServerChannel? channel,
}) => continuousOffer(
  recordOnly: recordOnly,
  mode: mode,
  linkUp: linkUp,
  signedIn: signedIn,
  summary: noSummary ? null : (summary ?? _summary()),
  refusal: refusal,
  channel: channel,
);

void main() {
  group('🔴 A-3 — a paired dock gets nothing, and 「nothing」 means absent', () {
    test('inject destination: not visible, whatever else is true', () {
      // Ruling ⑧ asks for 零 diff on the paired dock: not a dimmed entry, not an
      // explained one — no entry. The place the user learns this feature exists
      // is light-record's own empty state, not a hint bolted to the keyboard.
      for (final FlowMode mode in FlowMode.values) {
        for (final bool linkUp in <bool>[true, false]) {
          final ContinuousOffer o = _offer(
            recordOnly: false,
            mode: mode,
            linkUp: linkUp,
          );
          expect(o.visible, isFalse, reason: '$mode linkUp=$linkUp');
          expect(o.enabled, isFalse);
          expect(o.reason, isNull);
        }
      }
    });

    test('destination outranks even a perfectly good account', () {
      expect(_offer(recordOnly: false, summary: _summary()).visible, isFalse);
    });
  });

  group('A-1 — the ordinary available entry', () {
    test('record-only + realtime + link + a readable account', () {
      final ContinuousOffer o = _offer(summary: _summary(usedMin: 88, limitMin: 900));
      expect(o.visible, isTrue);
      expect(o.enabled, isTrue);
      expect(o.reason, isNull);
      expect(o.capMinutes, 30);
      expect(o.remainingMinutes, 812);
      expect(o.boundedByBalance, isFalse);
      expect(o.minutesAvailable, 30);
    });
  });

  group('A-2 — translate / organize: visible, disabled, and TOLD why', () {
    for (final FlowMode mode in <FlowMode>[FlowMode.translate, FlowMode.organize]) {
      test('$mode is refused with a sentence rather than hidden', () {
        final ContinuousOffer o = _offer(mode: mode);
        expect(o.visible, isTrue,
            reason: 'hiding it teaches the user the feature does not exist; '
                'this block is one tap away on the same screen');
        expect(o.enabled, isFalse);
        expect(o.reason, ContinuousBlock.modeNotRealtime);
      });
    }
  });

  group('🔴 the link gates without explaining', () {
    test('link down: disabled, and NO reason of its own', () {
      // The A8 precedent in this exact dock: the compose band one centimetre up
      // already says 未连接, and `compose_band.dart` refuses to print a third
      // copy. A `linkDown` member here would put two voices on one screen.
      final ContinuousOffer o = _offer(linkUp: false);
      expect(o.visible, isTrue);
      expect(o.enabled, isFalse);
      expect(o.reason, isNull);
    });

    test('🔴 link down AND translate: the MODE is still named', () {
      // The whole reason `enabled` and `reason` are two fields. A single ranked
      // enum would answer 「link」 here, the user would reconnect, press again,
      // and be refused a second time by something we already knew.
      final ContinuousOffer o = _offer(linkUp: false, mode: FlowMode.translate);
      expect(o.enabled, isFalse);
      expect(o.reason, ContinuousBlock.modeNotRealtime);
    });

    test('link down does not hide the ceiling either', () {
      // 「最多 30 分钟」 is a property of the plan, not of this moment.
      expect(_offer(linkUp: false).capMinutes, 30);
    });
  });

  group('🔴 the ceiling is a precondition — no number, no recording', () {
    test('a summary without continuous_minutes refuses, with a reason', () {
      final ContinuousOffer o = _offer(summary: _summary(cap: null));
      expect(o.visible, isTrue);
      expect(o.enabled, isFalse);
      expect(o.reason, ContinuousBlock.ceilingUnknown);
      expect(o.capMinutes, isNull);
      expect(o.minutesAvailable, isNull,
          reason: 'a sitting whose length we cannot state must not be started; '
              'the retained-audio budget was sized against a known worst case');
    });

    test('no summary at all refuses the same way', () {
      final ContinuousOffer o = continuousOffer(
        recordOnly: true,
        mode: FlowMode.realtime,
        linkUp: true,
        signedIn: true,
        summary: null,
      );
      expect(o.enabled, isFalse);
      expect(o.reason, ContinuousBlock.ceilingUnknown);
      expect(o.remainingMinutes, isNull);
    });
  });

  group('🔴 §5-2 — one number unreadable does not fabricate the other', () {
    test('ceiling known, balance meter absent ⇒ still offered, and the balance '
        'is simply not there', () {
      // 「读不到就不画」: the sub-line says 「最多 30 分」 and stops. It may not say
      // 0 (「you have none left」 — a claim we do not have) and may not blur the
      // two numbers into one vaguer sentence.
      final ContinuousOffer o = _offer(
        summary: const CloudSummary(minutes: null, tokens: null, continuousMinutes: 30),
      );
      expect(o.enabled, isTrue);
      expect(o.capMinutes, 30);
      expect(o.remainingMinutes, isNull);
      expect(o.boundedByBalance, isFalse,
          reason: 'a balance we could not read cannot bound anything');
      expect(o.minutesAvailable, 30);
    });
  });

  group('B-2 — balance below the ceiling is the free tier\'s normal second '
      'recording', () {
    test('it is flagged, and the shorter number is the one that applies', () {
      // FREE: 20 minutes a month, 10 a sitting. After one full sitting there are
      // 6 left — the demo's own B-2 numbers.
      final ContinuousOffer o = _offer(
        summary: _summary(usedMin: 14, limitMin: 20, cap: 10),
      );
      expect(o.enabled, isTrue, reason: 'it may still be started — it will just '
          'end sooner, and the sheet says so before the press');
      expect(o.capMinutes, 10);
      expect(o.remainingMinutes, 6);
      expect(o.boundedByBalance, isTrue);
      expect(o.minutesAvailable, 6,
          reason: 'the user is told 「about 6 minutes」 rather than left to '
              'subtract two numbers and find out afterwards');
    });

    test('exactly equal is NOT bounded by the balance', () {
      // A boundary worth pinning: at 10 and 10 the sitting ends on the ceiling,
      // and the ceiling's stop sentence is the one that says 「record another」.
      final ContinuousOffer o = _offer(
        summary: _summary(usedMin: 10, limitMin: 20, cap: 10),
      );
      expect(o.remainingMinutes, 10);
      expect(o.boundedByBalance, isFalse);
      expect(o.minutesAvailable, 10);
    });
  });

  group('🔴 the month is spent — a different sentence, because a different act',
      () {
    test('zero left refuses with quotaSpent, not with the ceiling reason', () {
      final ContinuousOffer o = _offer(summary: _summary(usedMin: 20, limitMin: 20, cap: 10));
      expect(o.enabled, isFalse);
      expect(o.reason, ContinuousBlock.quotaSpent,
          reason: 'pressing again helps after a ceiling and does not help here '
              '— W8-4 is the account this repo already paid for merging them');
      expect(o.remainingMinutes, 0);
    });

    test('an overrun (negative balance) reads as spent, not as a hole', () {
      // Usage settles AFTER a session, so a real account can go past its limit.
      final ContinuousOffer o = _offer(summary: _summary(usedMin: 22.5, limitMin: 20, cap: 10));
      expect(o.remainingMinutes, 0);
      expect(o.reason, ContinuousBlock.quotaSpent);
    });
  });

  group('🔴 minutes are FLOORED, never rounded', () {
    test('0.6 of a minute left is 0 minutes, and 0 is spent', () {
      // Rounding would print 「1 minute」 for a minute the user does not have,
      // and the sentence built on it would be wrong in the direction that
      // surprises them.
      final ContinuousOffer o = _offer(summary: _summary(usedMin: 19.4, limitMin: 20, cap: 10));
      expect(o.remainingMinutes, 0);
      expect(o.reason, ContinuousBlock.quotaSpent);
    });

    test('5.9 left is 5', () {
      final ContinuousOffer o = _offer(summary: _summary(usedMin: 14.1, limitMin: 20, cap: 10));
      expect(o.remainingMinutes, 5);
      expect(o.minutesAvailable, 5);
    });
  });

  group('🔴 WP-9 — a LAN channel is never judged by the cloud month balance', () {
    test('LAN + a spent-looking cloud balance still enables, using the ceiling alone', () {
      // findings-crossend-quota.md #2: this used to be `_summary(usedMin: 20,
      // limitMin: 20)` unconditionally treated as THIS recording's meter, so a
      // phone whose ONLY cloud login happened to be at its monthly cap would
      // see every LAN recording refused as "quota spent" — a statement about a
      // month LAN never draws from at all.
      final ContinuousOffer o = _offer(
        channel: ServerChannel.lan,
        summary: _summary(usedMin: 20, limitMin: 20, cap: 10),
      );
      expect(o.enabled, isTrue);
      expect(o.reason, isNull);
      expect(o.remainingMinutes, isNull, reason: 'LAN has no month balance to report');
      expect(o.boundedByBalance, isFalse);
      expect(o.minutesAvailable, 10);
    });

    test('cloudRelay (unchanged) still enforces the balance', () {
      final ContinuousOffer o = _offer(
        channel: ServerChannel.cloudRelay,
        summary: _summary(usedMin: 20, limitMin: 20, cap: 10),
      );
      expect(o.enabled, isFalse);
      expect(o.reason, ContinuousBlock.quotaSpent);
    });

    test('null channel (unknown / pre-existing callers) keeps today\'s behaviour', () {
      final ContinuousOffer o = _offer(summary: _summary(usedMin: 20, limitMin: 20, cap: 10));
      expect(o.reason, ContinuousBlock.quotaSpent);
    });
  });

  test('🔴 a disabled entry still carries the numbers it can prove', () {
    // Otherwise a user in translate mode would never learn the ceiling exists,
    // and a disabled control would say LESS about the product than an enabled
    // one — the sub-line is where the feature introduces itself.
    for (final ContinuousOffer o in <ContinuousOffer>[
      _offer(mode: FlowMode.organize),
      _offer(linkUp: false),
      _offer(summary: _summary(usedMin: 20, limitMin: 20)),
    ]) {
      expect(o.visible, isTrue);
      expect(o.enabled, isFalse);
      expect(o.capMinutes, isNotNull, reason: '${o.reason}');
    }
  });

  group('🔴 owner ruling 2026-09-02 — long recording requires a cloud sign-in',
      () {
    test('signed out: unavailable with the sign-in reason, not the retry one',
        () {
      final ContinuousOffer o = _offer(signedIn: false);
      expect(o.visible, isTrue,
          reason: 'refused-with-a-reason, never hidden — the same C6 rule '
              'every other block obeys');
      expect(o.enabled, isFalse);
      expect(o.reason, ContinuousBlock.notSignedIn);
    });

    test('🔴 REVERSE CONTROL: before this ruling, a signed-out phone with no '
        'summary read as `ceilingUnknown` — the generic "try again" sentence '
        '— because nothing here could tell "not signed in" from "signed in, '
        'and the server did not answer". This pins the CURRENT, distinct '
        'answer; flipping `signedIn` back to being ignored (or defaulting the '
        'gate to `ceilingUnknown` first) makes this red.', () {
      final ContinuousOffer o = _offer(signedIn: false, summary: null);
      expect(o.reason, ContinuousBlock.notSignedIn);
      expect(o.reason, isNot(ContinuousBlock.ceilingUnknown));
    });

    test('signed out outranks the mode gate — the sign-in fact blocks first',
        () {
      final ContinuousOffer o = _offer(signedIn: false, mode: FlowMode.translate);
      expect(o.reason, ContinuousBlock.notSignedIn,
          reason: 'a signed-out phone has no account to check the mode '
              'against; naming the mode first would answer a question one '
              'step ahead of the one that actually blocks it');
    });

    test('signed out outranks a perfectly readable ceiling', () {
      final ContinuousOffer o = _offer(
        signedIn: false,
        summary: _summary(cap: 30, usedMin: 5, limitMin: 900),
      );
      expect(o.reason, ContinuousBlock.notSignedIn);
    });

    test('signed in + LAN: the ceiling is the account plan’s '
        'continuous_minutes, same as on the cloud channel', () {
      final ContinuousOffer o = _offer(
        signedIn: true,
        channel: ServerChannel.lan,
        summary: _summary(cap: 30, usedMin: 5, limitMin: 900),
      );
      expect(o.enabled, isTrue);
      expect(o.reason, isNull);
      expect(o.capMinutes, 30,
          reason: 'LAN reads the SAME plan ceiling as any other channel — '
              'only the monthly BALANCE question is exempted (WP-9), never '
              'the ceiling itself');
    });

    test('signed in + LAN + a spent-looking month balance: still offered, '
        'using the ceiling alone', () {
      // The WP-9 group above already pins this without `signedIn` in the
      // picture (it defaults true); restated here, explicitly, as the second
      // half of the owner's 2026-09-02 ruling.
      final ContinuousOffer o = _offer(
        signedIn: true,
        channel: ServerChannel.lan,
        summary: _summary(cap: 10, usedMin: 20, limitMin: 20),
      );
      expect(o.enabled, isTrue);
      expect(o.reason, isNull);
      expect(o.remainingMinutes, isNull,
          reason: 'LAN never draws from the cloud month at all');
      expect(o.minutesAvailable, 10);
    });
  });

  // ── R3F-2 ──────────────────────────────────────────────────────────────────
  //
  // Device round three (2026-09-06): an unverified account past the 3-day grace
  // gets 403 EMAIL_NOT_VERIFIED from the ceiling read, and the row said
  // 「Account limit unavailable — try again」 forever.
  group('🔴 a NAMED refusal is not the same block as an unreadable ceiling', () {
    test('each named refusal gets its own block', () {
      expect(
        _offer(noSummary: true, refusal: CloudSummaryRefusal.emailNotVerified).reason,
        ContinuousBlock.emailNotVerified,
      );
      expect(
        _offer(noSummary: true, refusal: CloudSummaryRefusal.accountRestricted).reason,
        ContinuousBlock.accountRestricted,
      );
      expect(
        _offer(noSummary: true, refusal: CloudSummaryRefusal.authExpired).reason,
        ContinuousBlock.sessionExpired,
      );
    });

    test('🔴 the unnamed miss KEEPS ceilingUnknown', () {
      // The negative control. Without it 「tell the two apart」 could have been
      // implemented as 「rename the one sentence」, and every assertion above
      // would still be green.
      expect(
        _offer(noSummary: true, refusal: null).reason,
        ContinuousBlock.ceilingUnknown,
      );
    });

    test('a named refusal outranks the mode, and survives a cached ceiling', () {
      // Outranks the mode for `notSignedIn`'s own reason: telling a barred
      // account 「realtime mode only」 answers a question one step ahead of the
      // one that blocks it.
      expect(
        _offer(
          mode: FlowMode.translate,
          noSummary: true,
          refusal: CloudSummaryRefusal.emailNotVerified,
        ).reason,
        ContinuousBlock.emailNotVerified,
      );
      // A ceiling read earlier in the session does not make the account any
      // less barred — this is why the check sits above `cap == null` and not
      // inside it.
      final ContinuousOffer stale = _offer(
        refusal: CloudSummaryRefusal.emailNotVerified,
      );
      expect(stale.reason, ContinuousBlock.emailNotVerified);
      expect(stale.enabled, isFalse);
    });

    test('signing out still outranks every refusal', () {
      expect(
        _offer(
          signedIn: false,
          noSummary: true,
          refusal: CloudSummaryRefusal.authExpired,
        ).reason,
        ContinuousBlock.notSignedIn,
      );
    });
  });
}
