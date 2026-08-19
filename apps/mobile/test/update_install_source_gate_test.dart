// Gate ② — 「a store delivered this copy, so the store updates it」.
//
// The debt this closes was written down in `lib/src/update/self_update_flag.dart`
// long before it was paid: gate ① is a build-time define a human can forget,
// and the runtime criterion is the one that cannot be. Play's Device and
// Network Abuse policy forbids a store-delivered app from installing an APK to
// update itself, so this gate has to hold even if someone builds the store
// artifact with the wrong flags.
//
// 🔴 THE DIRECTION UNDER TEST IS THE ONE THAT COSTS US THE FEATURE. A gate
// built as 「suppress unless this looks like a sideload」 kills self-update on
// the exact channel it exists to serve, silently, on other people's phones —
// gate ①'s header says so in as many words. Hence the allow-list, and hence the
// four negative cases below: unknown installer, empty, null, and a probe that
// throws must all leave the feature ON.
//
// SPEC-REF:
//   apps/mobile/lib/src/update/install_source.dart
//   docs/strategy/2026-08-19-store-review-approval-playbook.md §2-1

import 'package:flowmic/src/update/install_source.dart';
import 'package:flowmic/src/update/update_check.dart';
import 'package:flowmic/src/update/update_controller.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/update_fakes.dart';

void main() {
  group('installedFromStore — the criterion itself', () {
    test('the two store installers are recognised', () async {
      for (final String pkg in kStoreInstallerPackages) {
        expect(await installedFromStore(probe: () async => pkg), isTrue,
            reason: '$pkg is a store');
      }
    });

    test('case and padding do not smuggle a store past the check', () async {
      expect(
        await installedFromStore(probe: () async => '  COM.Android.Vending '),
        isTrue,
      );
    });

    test('🔴 anything unknown is NOT a store — the feature stays on', () async {
      // Every one of these is a real sideload shape: a browser, the system
      // package installer, a file manager, an OEM store we do not ship to, and
      // the plain "nobody recorded it" answer.
      for (final String? installer in <String?>[
        'com.android.chrome',
        'com.google.android.packageinstaller',
        'com.android.packageinstaller',
        'com.mi.android.globalFileexplorer',
        'com.huawei.appmarket',
        '',
        '   ',
        null,
      ]) {
        expect(await installedFromStore(probe: () async => installer), isFalse,
            reason: '$installer must not disable self-update');
      }
    });

    test('a probe that throws answers 「unknown」, never 「store」', () async {
      // Our own plumbing failing must not read as a policy fact. The opposite
      // choice would turn a bug in this file into a silent capability loss on
      // every phone at once.
      expect(
        await installedFromStore(probe: () async => throw StateError('boom')),
        isFalse,
      );
    });
  });

  group('UpdateController wiring — one answer, not two', () {
    test('a store install shuts the self-install path after load', () async {
      final UpdateController c = newTestUpdateController(
        selfUpdateEnabled: true,
        storeProbe: () async => true,
        checker: ({required String? currentVersion}) async =>
            throw StateError('a store build must not check'),
      );
      // Before load the question has not been asked, and an unasked question
      // must not read as 「yes, a store」.
      expect(c.installedFromAppStore, isFalse);
      expect(c.selfUpdateUsable, isTrue);

      await c.load();

      expect(c.installedFromAppStore, isTrue);
      expect(c.selfUpdateUsable, isFalse);
      expect(c.canInstall, isFalse);
      // The checker above throws if it is ever reached: these two must return
      // without touching the network at all.
      await c.maybeAutoCheck();
      await c.checkNow();
      c.dispose();
    });

    test('a sideloaded install keeps it — the positive control', () async {
      bool checked = false;
      final UpdateController c = newTestUpdateController(
        selfUpdateEnabled: true,
        storeProbe: () async => false,
        checker: ({required String? currentVersion}) async {
          checked = true;
          return const UpdateCheckResult(UpdateCheckOutcome.upToDate);
        },
      );
      await c.load();

      expect(c.installedFromAppStore, isFalse);
      expect(c.selfUpdateUsable, isTrue);
      await c.checkNow();
      expect(checked, isTrue,
          reason: 'without this the first test could pass on a broken checker');
      c.dispose();
    });

    test('gate ① still wins on its own — the two are not one flag', () async {
      final UpdateController c = newTestUpdateController(
        selfUpdateEnabled: false,
        storeProbe: () async => false,
        checker: ({required String? currentVersion}) async =>
            throw StateError('a build without the feature must not check'),
      );
      await c.maybeAutoCheck();
      expect(c.selfUpdateUsable, isFalse);
      expect(c.installedFromAppStore, isFalse,
          reason: 'the two facts stay separate: the card says a different '
              'sentence for each');
      c.dispose();
    });
  });
}

