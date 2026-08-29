// Card CR-3 — the offline-recording banner: severity, precedence, lifecycle.
//
// SPEC-REF:
//   apps/mobile/lib/src/ui/banner_queue.dart (`_linkBanner`'s CR-3 arm)
//   apps/mobile/lib/src/ptt/ptt_link_loss.dart (`continuousCapturingOffline`,
//     the fact this face is licensed by)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-b
//
// The wording ban lives in `link_loss_copy_guard_test.dart` (this string was
// added to that table rather than given a second one). What is asserted HERE is
// everything about the banner that is not its words.

import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/ui/banner_queue.dart';
import 'package:flutter_test/flutter_test.dart';

BannerQueue _build({
  required ConnectionState connection,
  bool continuousOffline = false,
  bool albumAway = false,
  bool ladderReconnecting = false,
}) =>
    buildChatBanners(
      connection: connection,
      autoStopped: false,
      albumAway: albumAway,
      ladderReconnecting: ladderReconnecting,
      strings: AppStrings(AppLocale.en),
      continuousOffline: continuousOffline,
    );

void main() {
  final AppStrings en = AppStrings(AppLocale.en);

  test('🔴 it is DEGRADED, not blocking — the user is not blocked, they are '
      'recording', () {
    // `blocking` means 「the user cannot proceed」. Here they are proceeding: a
    // long recording is running and being kept. Rendering this as the same
    // severity as a dead link would make the one thing that is still WORKING
    // look like the thing that stopped.
    final BannerItem top = _build(
      connection: ConnectionState.disconnected,
      continuousOffline: true,
    ).top!;
    expect(top.severity, BannerSeverity.degraded);
    expect(top.message, en.bannerContinuousOffline);
  });

  test('🔴 it REPLACES the ordinary link banner rather than stacking with it',
      () {
    // Same id ⇒ one slot, one sentence. Two banners about one dead link would
    // be two answers to one question, and the slot shows only the top one — so
    // which answer the user got would depend on push order.
    final BannerQueue q = _build(
      connection: ConnectionState.disconnected,
      continuousOffline: true,
    );
    expect(q.all.where((BannerItem b) => b.id == BannerIds.link), hasLength(1));
    expect(q.top!.message, isNot(en.bannerLinkDown));
  });

  test('🔴 it outranks the album and ladder postures', () {
    // Both of those are true and both answer a question the user did not ask.
    // Mid-recording, 「your words are still being captured」 is the fact with
    // the highest cost of being wrong about.
    for (final Map<String, bool> posture in <Map<String, bool>>[
      <String, bool>{'albumAway': true, 'ladder': false},
      <String, bool>{'albumAway': false, 'ladder': true},
      <String, bool>{'albumAway': true, 'ladder': true},
    ]) {
      final BannerItem top = _build(
        connection: ConnectionState.reconnecting,
        continuousOffline: true,
        albumAway: posture['albumAway']!,
        ladderReconnecting: posture['ladder']!,
      ).top!;
      expect(top.message, en.bannerContinuousOffline, reason: '$posture');
    }
  });

  test('no action button — a tap could not help and would imply it should',
      () {
    final BannerItem top = _build(
      connection: ConnectionState.disconnected,
      continuousOffline: true,
    ).top!;
    expect(top.actionLabel, isNull);
    expect(top.onAction, isNull);
  });

  test('🔴 STATE-type: it is gone the moment the link is back, on no timer',
      () {
    // The lifecycle contract at the top of banner_queue.dart. `connected`
    // returns null from the whole link arm, so nothing has to remember to take
    // this down — which is why the flag is read fresh on every build rather
    // than latched.
    expect(
      _build(
        connection: ConnectionState.connected,
        continuousOffline: true,
      ).all.where((BannerItem b) => b.id == BannerIds.link),
      isEmpty,
    );
  });

  test('🔴 REVERSE CONTROL: with the flag false the old banner is unchanged',
      () {
    // Ordinary push-to-talk must render exactly what it did before this card.
    // If this were not asserted, a bug that left `continuousOffline` true would
    // look identical to a correct implementation in every test above.
    for (final ConnectionState c in <ConnectionState>[
      ConnectionState.disconnected,
      ConnectionState.reconnecting,
    ]) {
      final BannerItem top = _build(connection: c).top!;
      expect(top.message, isNot(en.bannerContinuousOffline), reason: '$c');
    }
    expect(_build(connection: ConnectionState.disconnected).top!.message,
        en.bannerLinkDown);
    expect(
      _build(connection: ConnectionState.disconnected, albumAway: true)
          .top!
          .message,
      en.bannerAlbumAway,
    );
  });
}
