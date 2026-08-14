// R6 T-3b ②③④ acceptance (widget half) — the 「+」 panel, the Favorites list and
// the AI action row's visible contract.
//
// SPEC-REF: docs/ui-design/REDESIGN-PLAN.md §6.1 (「+」面板), §6.2 ④⑤,
//   §6.2-6 (云端实例: 无 PC ⇒ 不给注入类操作); §2 F-5.
//
// The headline assertion is the anti-façade one: the panel contains ONLY what
// the app actually implements. It was written for T-3b, when that meant 常用
// alone and 相册图片/截图附件 had to be ABSENT.
//
// **R6 T-4 flipped half of it, deliberately.** 相册图片 is now implemented, so
// the assertion is INVERTED rather than deleted: the tile must be present AND
// wired to a real send, and the demo's remaining unimplemented tile (截图附件)
// must still be absent. The sentinel keeps its job — it just guards a new
// truth. A tile that does nothing when tapped is still the failure mode this
// project keeps re-learning, which is why the tests below check the CALLBACK
// fires and the inert states state their reason, not merely that text is drawn.
//
// Fake callbacks + a real FavoritesStore over InMemoryLocalPrefs; no
// PttSession, no socket (driving the real async PTT chain inside testWidgets'
// FakeAsync zone deadlocks).

import 'package:flowmic/src/favorites/favorites_store.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show ComposeTask;
import 'package:flowmic/src/ui/ai_action_row.dart';
import 'package:flowmic/src/session/image_send_controller.dart'
    show ImageOriginalBlock;
import 'package:flowmic/src/ui/plus_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const AppStrings _zh = AppStringsZh();
const AppStrings _en = AppStringsEn();

Future<FavoritesStore> _seeded(List<String> items) async {
  final FavoritesStore f = FavoritesStore(prefs: InMemoryLocalPrefs());
  for (final String item in items.reversed) {
    await f.add(item);
  }
  return f;
}

Widget _panel(
  FavoritesStore favorites, {
  String buffer = '',
  bool noPcTarget = false,
  void Function(String)? onSend,
  void Function(String)? onFeedback,
  Future<void> Function(bool original)? onPickImage,
  bool imageSending = false,
  ImageOriginalBlock? originalBlock,
  bool aiComposing = false,
  AppStrings strings = _zh,
}) => MaterialApp(
  home: Scaffold(
    body: PlusPanel(
      favorites: favorites,
      strings: strings,
      buffer: buffer,
      noPcTarget: noPcTarget,
      onSend: onSend ?? (_) {},
      onFeedback: onFeedback ?? (_) {},
      onPickImage: onPickImage,
      imageSending: imageSending,
      originalBlock: originalBlock,
      aiComposing: aiComposing,
    ),
  ),
);

void main() {
  testWidgets('anti-façade (T-4 inverted): 相册图片 is present AND wired, while the '
      'still-unimplemented 截图附件 stays absent', (WidgetTester tester) async {
    final FavoritesStore f = await _seeded(<String>['收到，我稍后回复你']);
    int picks = 0;
    await tester.pumpWidget(
      _panel(f, onPickImage: (bool _) async => picks++),
    );

    expect(find.text(_zh.favorites), findsOneWidget);
    expect(find.text(_zh.imageTile), findsOneWidget);

    // The tile is not decoration: tapping it runs the real send path.
    await tester.tap(find.byKey(const ValueKey<String>('plus.image.pick')));
    await tester.pumpAndSettle();
    expect(picks, 1, reason: 'the tile must actually deliver, not merely exist');

    // 截图附件 has no implementation, so it is still absent rather than dead.
    for (final String absent in <String>['截图', '截图附件', '附件']) {
      expect(
        find.textContaining(absent),
        findsNothing,
        reason: 'a dead 「$absent」 tile is exactly the façade the card forbids',
      );
    }
  });

  // ── Original-image tick box (owner 2026-08-01) ─────────────────────────────
  //
  // Anti-façade, the widget half: the value the tile SENDS is what the box shows.
  // The controller half (that the value reaches the plugin, and that an
  // over-budget original is refused rather than silently shrunk) is pinned in
  // image_original_option_test.dart.

  testWidgets('原图 defaults to UNTICKED, and an untouched tap sends false',
      (WidgetTester tester) async {
    final FavoritesStore f = await _seeded(<String>[]);
    final List<bool> sent = <bool>[];
    await tester.pumpWidget(
      _panel(f, onPickImage: (bool o) async => sent.add(o)),
    );
    expect(find.text(_zh.imageOriginal), findsOneWidget,
        reason: 'the option must be visible where the decision is made');
    expect(find.byIcon(Icons.check_box_outline_blank), findsOneWidget);
    expect(find.byIcon(Icons.check_box_outlined), findsNothing);

    await tester.tap(find.byKey(const ValueKey<String>('plus.image.pick')));
    await tester.pumpAndSettle();
    expect(sent, <bool>[false], reason: 'owner: 默认不勾');
  });

  testWidgets('ticking 原图 is what actually travels — the control is not decor',
      (WidgetTester tester) async {
    final FavoritesStore f = await _seeded(<String>[]);
    final List<bool> sent = <bool>[];
    await tester.pumpWidget(
      _panel(f, onPickImage: (bool o) async => sent.add(o)),
    );
    await tester.tap(find.byKey(const ValueKey<String>('plus.image.original')));
    await tester.pumpAndSettle();
    expect(find.byIcon(Icons.check_box_outlined), findsOneWidget,
        reason: 'the box must SHOW the state it is about to send');

    await tester.tap(find.byKey(const ValueKey<String>('plus.image.pick')));
    await tester.pumpAndSettle();
    expect(sent, <bool>[true],
        reason: 'a control that changes nothing is worse than no control');
  });

  testWidgets('tapping 原图 sets the option and does NOT open the picker',
      (WidgetTester tester) async {
    // The two tap targets are separate on purpose: a tick that also fired the
    // send would open the picker with the PREVIOUS value.
    final FavoritesStore f = await _seeded(<String>[]);
    final List<bool> sent = <bool>[];
    await tester.pumpWidget(
      _panel(f, onPickImage: (bool o) async => sent.add(o)),
    );
    await tester.tap(find.byKey(const ValueKey<String>('plus.image.original')));
    await tester.pumpAndSettle();
    expect(sent, isEmpty);
  });

  testWidgets('原图 explains itself, and never promises 「更清楚」',
      (WidgetTester tester) async {
    final FavoritesStore f = await _seeded(<String>[]);
    await tester.pumpWidget(
      _panel(f, onPickImage: (bool _) async {}),
    );
    expect(find.text(_zh.imageOriginalHint), findsOneWidget,
        reason: 'the two facts the user can act on: untouched, and refusable');
  });

  testWidgets('while a send is in flight the tick is inert too',
      (WidgetTester tester) async {
    final FavoritesStore f = await _seeded(<String>[]);
    await tester.pumpWidget(
      _panel(f, imageSending: true, onPickImage: (bool _) async {}),
    );
    await tester.tap(find.byKey(const ValueKey<String>('plus.image.original')));
    await tester.pump();
    expect(find.byIcon(Icons.check_box_outlined), findsNothing,
        reason: 'changing the option mid-send would describe the WRONG send');
  });

  // ── owner 2026-08-01: 原图 is LAN-only ───────────────────────────────────────
  //
  // 🔴 R8 has two halves and this group pins both: the box must not be present
  // when it cannot work (half one), AND its disappearance must not be silent
  // (half two — the B3-9 precedent, owner's 「都不存在就提醒」).

  testWidgets('cloud channel: the 原图 box is GONE and its reason stands in its place',
      (WidgetTester tester) async {
    final FavoritesStore f = await _seeded(<String>[]);
    final List<bool> sent = <bool>[];
    await tester.pumpWidget(_panel(
      f,
      onPickImage: (bool o) async => sent.add(o),
      originalBlock: ImageOriginalBlock.cloudChannel,
    ));
    expect(find.byKey(const ValueKey<String>('plus.image.original')),
        findsNothing,
        reason: 'a box that cannot be honoured is the control R8 forbids');
    expect(find.byIcon(Icons.check_box_outline_blank), findsNothing);
    expect(find.byKey(const ValueKey<String>('plus.image.original.blocked')),
        findsOneWidget,
        reason: 'silent disappearance reads as 「the feature is gone」');
    expect(
      find.text(_zh.imageOriginalUnavailable(ImageOriginalBlock.cloudChannel)),
      findsOneWidget,
    );
    // The tile itself still works — only the option is withheld.
    await tester.tap(find.byKey(const ValueKey<String>('plus.image.pick')));
    await tester.pumpAndSettle();
    expect(sent, <bool>[false]);
  });

  testWidgets('channel unconfirmed: a DIFFERENT sentence — the app must not assert 「你在云端」',
      (WidgetTester tester) async {
    final FavoritesStore f = await _seeded(<String>[]);
    await tester.pumpWidget(_panel(
      f,
      onPickImage: (bool _) async {},
      originalBlock: ImageOriginalBlock.channelUnknown,
    ));
    final String unknown =
        _zh.imageOriginalUnavailable(ImageOriginalBlock.channelUnknown);
    final String cloud =
        _zh.imageOriginalUnavailable(ImageOriginalBlock.cloudChannel);
    expect(find.text(unknown), findsOneWidget);
    expect(find.text(cloud), findsNothing);
    expect(unknown, isNot(cloud),
        reason: 'two states, two actions (switch networks vs wait)');
  });

  testWidgets('LAN: the box is back and the explanation is not shown',
      (WidgetTester tester) async {
    final FavoritesStore f = await _seeded(<String>[]);
    await tester.pumpWidget(
      _panel(f, onPickImage: (bool _) async {}), // originalBlock: null = LAN
    );
    expect(find.byKey(const ValueKey<String>('plus.image.original')),
        findsOneWidget);
    expect(find.byKey(const ValueKey<String>('plus.image.original.blocked')),
        findsNothing);
  });

  testWidgets('neither explanation ever claims the cloud rejected anything',
      (WidgetTester tester) async {
    // 🔴 The wording IS the contract: nothing on the relay checks this (RV-87).
    // A sentence implying otherwise would be saying a thing that was not done was done.
    for (final AppStrings s in <AppStrings>[_zh, _en]) {
      for (final ImageOriginalBlock b in ImageOriginalBlock.values) {
        final String text = s.imageOriginalUnavailable(b);
        for (final String forbidden in <String>[
          '拒收', '拒绝', '服务器不', '云端限制', '不允许',
          'rejected', 'refused', 'blocked by', 'not allowed',
        ]) {
          expect(text.toLowerCase().contains(forbidden.toLowerCase()), isFalse,
              reason: '「$forbidden」 in 「$text」 claims an enforcement that does '
                  'not exist — the phone simply does not offer this here');
        }
      }
    }
  });

  testWidgets('a panel given no image callback draws no image tile at all',
      (WidgetTester tester) async {
    final FavoritesStore f = await _seeded(<String>['甲句']);
    await tester.pumpWidget(_panel(f)); // onPickImage omitted
    expect(
      find.text(_zh.imageTile),
      findsNothing,
      reason: 'the panel never renders an action it was given no way to perform',
    );
    expect(find.byKey(const ValueKey<String>('plus.image.pick')), findsNothing);
    expect(find.byKey(const ValueKey<String>('plus.image.original')),
        findsNothing,
        reason: 'no send ⇒ no option about the send');
  });

  testWidgets('cloud notes: 相册图片 is LIVE with the local-save sub-line '
      '(not the old withhold)', (WidgetTester tester) async {
    // owner 2026-07-31: local noted save; must NOT promise a PC paste.
    final FavoritesStore f = await _seeded(<String>[]);
    int picks = 0;
    await tester.pumpWidget(
      _panel(f, noPcTarget: true, onPickImage: (bool _) async => picks++),
    );
    expect(find.text(_zh.imageTileSubLocal), findsOneWidget);
    expect(find.text(_zh.imageTileSub), findsNothing);
    expect(find.text(_zh.imageNoPcTarget), findsNothing);
    await tester.tap(find.byKey(const ValueKey<String>('plus.image.pick')));
    await tester.pumpAndSettle();
    expect(picks, 1, reason: 'cloud notes can attach a photo locally');
  });

  testWidgets('while a picture is going out the tile shows real progress and a '
      'second tap cannot race the first', (WidgetTester tester) async {
    final FavoritesStore f = await _seeded(<String>[]);
    int picks = 0;
    await tester.pumpWidget(
      _panel(f, imageSending: true, onPickImage: (bool _) async => picks++),
    );
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.text(_zh.imageSending), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey<String>('plus.image.pick')));
    // pump(), not pumpAndSettle(): the progress ring animates forever, which is
    // the point — it is REAL progress, not a frame that resolves itself.
    await tester.pump();
    expect(picks, 0);
  });

  testWidgets('tap-to-send: tapping a phrase closes the panel and delivers THAT text',
      (WidgetTester tester) async {
    final FavoritesStore f = await _seeded(<String>['甲句', '乙句']);
    final List<String> sent = <String>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (BuildContext context) => ElevatedButton(
              onPressed: () => showPlusPanel(
                context,
                favorites: f,
                strings: _zh,
                buffer: '',
                noPcTarget: false,
                onSend: sent.add,
                onFeedback: (_) {},
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('甲句'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey<String>('plus.fav.send.乙句')));
    await tester.pumpAndSettle();
    expect(sent, <String>['乙句']);
    expect(find.text('甲句'), findsNothing, reason: 'the sheet closed');
  });

  testWidgets('§6.2-6 cloud instance: the injection-type action is withheld AND '
      'the reason is on screen (not discovered by tapping something dead)',
      (WidgetTester tester) async {
    final FavoritesStore f = await _seeded(<String>['甲句']);
    final List<String> sent = <String>[];
    await tester.pumpWidget(_panel(f, noPcTarget: true, onSend: sent.add));

    expect(find.text(_zh.favoritesNoPcTarget), findsOneWidget);
    expect(find.text(_zh.favoritesTapToSend), findsNothing);
    await tester.tap(find.byKey(const ValueKey<String>('plus.fav.send.甲句')));
    await tester.pumpAndSettle();
    expect(sent, isEmpty);
  });

  testWidgets('save-current-buffer is live only with buffer text, and always reports its '
      'outcome (never a silent no-op)', (WidgetTester tester) async {
    final FavoritesStore f = await _seeded(<String>[]);
    final List<String> feedback = <String>[];

    await tester.pumpWidget(_panel(f, onFeedback: feedback.add));
    await tester.tap(find.byKey(const ValueKey<String>('plus.fav.save')));
    await tester.pumpAndSettle();
    expect(f.isEmpty, isTrue, reason: 'nothing to save from an empty box');
    expect(feedback, isEmpty);

    await tester.pumpWidget(
      _panel(f, buffer: '要存的短语', onFeedback: feedback.add),
    );
    await tester.tap(find.byKey(const ValueKey<String>('plus.fav.save')));
    await tester.pumpAndSettle();
    expect(f.items, <String>['要存的短语']);
    expect(feedback, <String>[_zh.favoriteAddResult(FavoriteAddOutcome.added)]);
  });

  // ── W2.5-E: save-current-buffer must not bank a half-streamed AI result ────
  //
  // The hole this pins: `_saveButton` used to gate on `buffer.trim().isNotEmpty`
  // alone, so mid-compose (when `ai_compose_controller.dart` is streaming
  // `compose:chunk` deltas straight into that buffer) a partial model output
  // could be saved PERMANENTLY. Tapping it later runs
  // `ChatController.sendFavorite` → `ManualDelivery.deliverText`, which carries
  // no compose term — so nothing downstream would ever catch it.
  //
  // 🔴 Scope, stated so nobody "completes" it later: this fixes the SAVE half
  // only. Delivering a favourite without compose validation is correct — a
  // favourite is the user's own phrase, not model output. The tests below
  // therefore assert the store, not the send path.

  testWidgets('W2.5-E: while AI is streaming into the buffer, save-current-buffer is '
      'inert AND says why (not a silently greyed button)',
      (WidgetTester tester) async {
    final FavoritesStore f = await _seeded(<String>[]);
    final List<String> feedback = <String>[];
    await tester.pumpWidget(_panel(
      f,
      buffer: '模型才写了一半的句',
      aiComposing: true,
      onFeedback: feedback.add,
    ));

    await tester.tap(find.byKey(const ValueKey<String>('plus.fav.save')));
    await tester.pumpAndSettle();
    expect(f.isEmpty, isTrue,
        reason: 'a partial compose result must not become a permanent phrase');
    expect(feedback, isEmpty, reason: 'the tap did not reach favorites.add');

    // Half two of anti-façade: withheld is not enough, the cause must be legible.
    expect(find.byKey(const ValueKey<String>('plus.fav.save.blocked')),
        findsOneWidget);
    expect(find.text(_zh.favoritesSaveBlockedAiComposing), findsOneWidget,
        reason: 'a disabled control whose reason is only discoverable by '
            'tapping it is the affordance this panel already refuses');
  });

  testWidgets('W2.5-E positive control: the same buffer saves fine once the run is over, '
      'and the reason line is gone', (WidgetTester tester) async {
    final FavoritesStore f = await _seeded(<String>[]);
    final List<String> feedback = <String>[];
    await tester.pumpWidget(_panel(
      f,
      buffer: '模型才写了一半的句',
      onFeedback: feedback.add,
    ));
    expect(find.byKey(const ValueKey<String>('plus.fav.save.blocked')),
        findsNothing,
        reason: 'the line must track the run, not stand there forever');

    await tester.tap(find.byKey(const ValueKey<String>('plus.fav.save')));
    await tester.pumpAndSettle();
    expect(f.items, <String>['模型才写了一半的句'],
        reason: 'without a live run the criterion must not block anything');
    expect(feedback, <String>[_zh.favoriteAddResult(FavoriteAddOutcome.added)]);
  });

  testWidgets('W2.5-E reverse control (scope): the criterion touches the SAVE half only '
      '— tap-to-send still delivers mid-compose', (WidgetTester tester) async {
    final FavoritesStore f = await _seeded(<String>['我自己写的短语']);
    final List<String> sent = <String>[];
    await tester.pumpWidget(
      _panel(f, aiComposing: true, buffer: '半截结果', onSend: sent.add),
    );
    await tester.tap(
      find.byKey(const ValueKey<String>('plus.fav.send.我自己写的短语')),
    );
    await tester.pumpAndSettle();
    expect(sent, <String>['我自己写的短语'],
        reason: 'a favourite is the user\'s own phrase; gating its delivery on '
            'an unrelated AI run answers a question the send path never asked');
  });

  testWidgets('W2.5-E: the blocked reason exists in every shipped language',
      (WidgetTester tester) async {
    // Four languages, and the assertion is that each one RENDERS — an entry
    // present in AppStrings but absent from the widget tree is the failure this
    // repo has shipped before.
    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings(locale);
      final FavoritesStore f = await _seeded(<String>[]);
      await tester.pumpWidget(_panel(
        f,
        buffer: 'x',
        aiComposing: true,
        strings: s,
      ));
      expect(find.text(s.favoritesSaveBlockedAiComposing), findsOneWidget,
          reason: 'missing copy for $locale');
    }
  });

  // owner 2026-07-27:「所有删除…都要二次确认」. The ✕ is 14px and sits beside a
  // tappable phrase, so it now asks first.
  testWidgets('removing a phrase asks first, then removes it in place',
      (WidgetTester tester) async {
    final FavoritesStore f = await _seeded(<String>['甲句', '乙句']);
    await tester.pumpWidget(_panel(f));
    await tester.tap(find.byKey(const ValueKey<String>('plus.fav.remove.甲句')));
    await tester.pumpAndSettle();
    // Nothing is gone yet — the confirm is on screen.
    expect(f.items, <String>['甲句', '乙句']);
    await tester.tap(find.text(_zh.confirmDelete));
    await tester.pumpAndSettle();
    expect(f.items, <String>['乙句']);
    expect(find.text('甲句'), findsNothing);
  });

  testWidgets('cancelling the confirm keeps the phrase', (WidgetTester tester) async {
    final FavoritesStore f = await _seeded(<String>['甲句', '乙句']);
    await tester.pumpWidget(_panel(f));
    await tester.tap(find.byKey(const ValueKey<String>('plus.fav.remove.甲句')));
    await tester.pumpAndSettle();
    await tester.tap(find.text(_zh.cancel));
    await tester.pumpAndSettle();
    expect(f.items, <String>['甲句', '乙句'], reason: 'cancel must not delete');
  });

  testWidgets('empty state explains how to fill it rather than showing a blank '
      'sheet', (WidgetTester tester) async {
    final FavoritesStore f = await _seeded(<String>[]);
    await tester.pumpWidget(_panel(f));
    expect(find.text(_zh.favoritesEmpty), findsOneWidget);
    expect(find.text(_zh.favoritesEmptyHint), findsOneWidget);
  });

  testWidgets('panel copy is bilingual (no zh leakage in EN)',
      (WidgetTester tester) async {
    final FavoritesStore f = await _seeded(<String>[]);
    await tester.pumpWidget(
      _panel(f, strings: _en, onPickImage: (bool _) async {}),
    );
    expect(find.text('Favorites'), findsOneWidget);
    expect(find.text('常用'), findsNothing);
    expect(find.text(_en.imageTile), findsOneWidget);
    expect(find.text('相册图片'), findsNothing);
  });

  // ── AI action row (④) ────────────────────────────────────────────────────
  testWidgets('the AI row shows exactly the three locked tasks and states that '
      'it never injects', (WidgetTester tester) async {
    final List<ComposeTask> tapped = <ComposeTask>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AiActionRow(
            strings: _zh,
            enabled: true,
            runningTask: null,
            onTask: tapped.add,
          ),
        ),
      ),
    );
    expect(find.text('润色'), findsOneWidget);
    expect(find.text('整理'), findsOneWidget);
    expect(find.text('翻译'), findsOneWidget);
    expect(find.text(_zh.aiRowNote), findsOneWidget);
    // Three modes are locked — there is no fourth pill.
    expect(find.byType(InkWell), findsNWidgets(3));

    await tester.tap(find.byKey(const ValueKey<String>('ai.task.organize')));
    expect(tapped, <ComposeTask>[ComposeTask.organize]);
  });

  testWidgets('while a task runs the row is inert and shows real progress, not '
      'a live-looking button', (WidgetTester tester) async {
    final List<ComposeTask> tapped = <ComposeTask>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AiActionRow(
            strings: _zh,
            enabled: false,
            runningTask: ComposeTask.draftPolish,
            onTask: tapped.add,
          ),
        ),
      ),
    );
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.text(_zh.aiRunning(ComposeTask.draftPolish)), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey<String>('ai.task.translate')));
    await tester.pump();
    expect(tapped, isEmpty, reason: 'no second run may race the first');
  });

  testWidgets('a disabled row does nothing on tap — and every pill is disabled, '
      'not just some', (WidgetTester tester) async {
    final List<ComposeTask> tapped = <ComposeTask>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AiActionRow(
            strings: _zh,
            enabled: false,
            runningTask: null,
            onTask: tapped.add,
          ),
        ),
      ),
    );
    for (final ComposeTask task in kAiComposeTasks) {
      await tester.tap(find.byKey(ValueKey<String>('ai.task.${task.wire}')));
    }
    await tester.pump();
    expect(tapped, isEmpty);
  });
}
