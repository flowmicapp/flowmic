// UP-2b —— download → verify sha256 → hand to the system installer.
//
// ── 🔴 The one thing this file really has to pin ───────────────────────────
//
// `update-routes.ts`'s file header splits the hash gate into three, and
// writes character for character that **only gate ③ really protects the
// user**: "after the client finishes downloading it must compute again
// itself; on mismatch delete the package + fail loudly".
// ⇒ This file's core assertion is not "a hash mismatch reports an error",
//    it is that **two things hold at once**:
//   ① that file is **really gone from disk**;
//   ② the installer was **not called even once**.
// Missing either of ①②, the gate is only a sentence. **② is easier to miss
// than ①, so every cell counts call times.**
//
// ── ⚠️ What is used here is a real filesystem, not a fake ──────────────────
//
// `flutter test` runs on the host VM ⇒ `dart:io` is real. So the "was it
// deleted" assertion asks the disk, not a stand-in we wrote answering
// itself. The only thing swapped is **where the bytes come from**
// (`UpdateByteSource`), which is the only thing that must be replaced when
// there is no network.
//
// ⚠️ This file cannot prove a real device: `FileProvider` /
// `canRequestPackageInstalls()` / the system package installer have not
// been run even once. What it proves is **the criterion itself** (length,
// hash, deletion, called or not).

import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/update/update_check.dart';
import 'package:flowmic/src/update/update_controller.dart';
import 'package:flowmic/src/update/update_download.dart';
import 'package:flowmic/src/update/update_installer.dart';
import 'package:flowmic/src/update/update_manifest.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/update_fakes.dart';

/// Bytes of an "install package". Long enough to be fed to the hasher in
/// several chunks.
final Uint8List kApkBytes = Uint8List.fromList(
  List<int>.generate(9973, (int i) => (i * 31 + 7) % 251),
);

/// sha256 corresponding to [kApkBytes] byte for byte. **The test computes it
/// independently** — production's copy is a streaming incremental compute;
// the two paths do not walk the same stretch of code.
final String kApkSha = sha256.convert(kApkBytes).toString();

/// A hash that is well-formed but **does not correspond** to [kApkBytes].
const String kWrongSha =
    'deadbeef00000000000000000000000000000000000000000000000000000000';

UpdateArtifact artifactFor(
  Uint8List bytes, {
  String? sha,
  int? size,
  String filename = 'FlowMic-9.9.9-release.apk',
}) => UpdateArtifact(
  kind: 'apk',
  locale: null,
  filename: filename,
  url: 'http://100.64.7.68/dl/flowmic/release/$filename',
  sha256: sha ?? sha256.convert(bytes).toString(),
  size: size ?? bytes.length,
);

/// A byte source that yields [bytes] in chunks. Chunking is deliberate: if
/// it were given all at once, the question "did the incremental hasher feed
/// every chunk in" would never have been asked.
UpdateByteSource sourceOf(List<int> bytes, {int status = 200, int chunk = 1000}) =>
    (Uri _) async {
      Stream<List<int>> body() async* {
        for (int i = 0; i < bytes.length; i += chunk) {
          yield bytes.sublist(i, (i + chunk).clamp(0, bytes.length));
        }
      }

      return (status: status, bytes: body());
    };

void main() {
  late Directory tmp;
  late Directory into;

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('flowmic-up2b-');
    into = Directory('${tmp.path}${Platform.pathSeparator}update');
  });

  tearDown(() async {
    if (await tmp.exists()) await tmp.delete(recursive: true);
  });

  group('download + verify —— what actually remains on disk', () {
    test('hash matches ⇒ verified, file is on disk, bytes identical character for character', () async {
      final UpdateArtifact a = artifactFor(kApkBytes);
      final UpdateDownloadResult r = await downloadAndVerify(
        artifact: a,
        into: into,
        open: sourceOf(kApkBytes),
      );

      expect(r.outcome, UpdateDownloadOutcome.verified);
      expect(r.file, isNotNull);
      expect(await r.file!.exists(), isTrue);
      // "the file is there" is not "the file is right" — a truncated file
      // "exists" just as brazenly (the bundled node.exe gate paid that
      // tuition).
      expect(await r.file!.readAsBytes(), equals(kApkBytes));
    });

    test(
      '🔴 hash mismatch ⇒ hashMismatch, **the file was deleted**, and result.file is null',
      () async {
        final UpdateArtifact a = artifactFor(kApkBytes, sha: kWrongSha);
        final UpdateDownloadResult r = await downloadAndVerify(
          artifact: a,
          into: into,
          open: sourceOf(kApkBytes),
        );

        // ⚠️ **Assertion order is deliberate.** If the `outcome` line is
        // put first, a broken gate explodes there first and the two below
        // **never run** — so "was the file deleted", the most important
        // thing, is never actually measured once in the reverse control.
        // So the disk line comes first.
        //
        // ① Disk layer: it is **really** gone. This is the one people most
        // easily only write in a comment.
        final File landed = File(
          '${into.path}${Platform.pathSeparator}${a.filename}',
        );
        expect(
          await landed.exists(),
          isFalse,
          reason: 'an unverified install package is still sitting on disk ⇒ it will sooner or later be handed out by someone',
        );
        // ② Type layer: that file cannot be obtained.
        expect(
          r.file,
          isNull,
          reason: 'if the failure arm still carries a File, a downstream "install it while we\'re here" can be written',
        );
        expect(r.outcome, UpdateDownloadOutcome.hashMismatch);
        expect(r.detail, contains(kWrongSha));
      },
    );

    test('truncated (a stretch missing) ⇒ sizeMismatch, file deleted', () async {
      final UpdateArtifact a = artifactFor(kApkBytes); // declared length is the full one
      final UpdateDownloadResult r = await downloadAndVerify(
        artifact: a,
        into: into,
        open: sourceOf(kApkBytes.sublist(0, 4096)), // only gave a stretch
      );

      expect(r.outcome, UpdateDownloadOutcome.sizeMismatch);
      expect(r.file, isNull);
      expect(
        await File('${into.path}${Platform.pathSeparator}${a.filename}').exists(),
        isFalse,
      );
      expect(r.detail, contains('got=4096'));
    });

    test('one stretch extra ⇒ also sizeMismatch (not "extra is fine")', () async {
      final UpdateArtifact a = artifactFor(kApkBytes);
      final UpdateDownloadResult r = await downloadAndVerify(
        artifact: a,
        into: into,
        open: sourceOf(<int>[...kApkBytes, 1, 2, 3]),
      );
      expect(r.outcome, UpdateDownloadOutcome.sizeMismatch);
      expect(r.file, isNull);
    });

    test(
      '🔴 order criterion: a download that is both short and a different hash reports sizeMismatch, not hashMismatch',
      () async {
        // These two sentences point at opposite actions ("retry" vs "do not
        // install"). An implementation that compares the hash first would
        // here say "your network dropped" as "the package you got is not
        // the one we shipped" — a scary falsehood.
        final UpdateArtifact a = artifactFor(kApkBytes, sha: kWrongSha);
        final UpdateDownloadResult r = await downloadAndVerify(
          artifact: a,
          into: into,
          open: sourceOf(kApkBytes.sublist(0, 100)),
        );
        expect(r.outcome, UpdateDownloadOutcome.sizeMismatch);
      },
    );

    test('non-200 ⇒ serverRefused, and not one byte landed on disk', () async {
      final UpdateArtifact a = artifactFor(kApkBytes);
      final UpdateDownloadResult r = await downloadAndVerify(
        artifact: a,
        into: into,
        open: sourceOf(kApkBytes, status: 404),
      );
      expect(r.outcome, UpdateDownloadOutcome.serverRefused);
      expect(r.detail, 'http_404');
      expect(
        await File('${into.path}${Platform.pathSeparator}${a.filename}').exists(),
        isFalse,
      );
    });

    test('cannot connect (opener throws) ⇒ unreachable', () async {
      final UpdateDownloadResult r = await downloadAndVerify(
        artifact: artifactFor(kApkBytes),
        into: into,
        open: (Uri _) async => throw const SocketException('no route to host'),
      );
      expect(r.outcome, UpdateDownloadOutcome.unreachable);
      expect(r.detail, contains('no route to host'));
    });

    test('cut off halfway ⇒ unreachable, the half file is deleted', () async {
      final UpdateArtifact a = artifactFor(kApkBytes);
      final UpdateDownloadResult r = await downloadAndVerify(
        artifact: a,
        into: into,
        open: (Uri _) async {
          Stream<List<int>> body() async* {
            yield kApkBytes.sublist(0, 512);
            throw const SocketException('connection reset');
          }

          return (status: 200, bytes: body());
        },
      );
      expect(r.outcome, UpdateDownloadOutcome.unreachable);
      expect(
        await File('${into.path}${Platform.pathSeparator}${a.filename}').exists(),
        isFalse,
        reason: 'a half file left on disk, next time someone will treat it as "already downloaded"',
      );
    });

    test(
      'cannot write ⇒ cannotWrite (the directory really cannot be created, not a failure a stand-in simulated)',
      () async {
        // Put a **file** on the parent path, so create(recursive:true) fails
        // on the real filesystem.
        final File blocker = File('${tmp.path}${Platform.pathSeparator}blocker');
        await blocker.writeAsString('not a directory');
        final UpdateDownloadResult r = await downloadAndVerify(
          artifact: artifactFor(kApkBytes),
          into: Directory('${blocker.path}${Platform.pathSeparator}update'),
          open: sourceOf(kApkBytes),
        );
        expect(r.outcome, UpdateDownloadOutcome.cannotWrite);
        expect(r.detail, startsWith('prepare_dir:'));
      },
    );

    test('what came up the stream is a disk error ⇒ cannotWrite, not unreachable', () async {
      // ⚠️ Branch-mapping test: what it proves is "a FileSystemException
      // will not be spoken as a network problem", **not** "what happens when
      // the disk is really full" — that cannot be manufactured on this
      // machine, written here plainly rather than pretended to have been
      // measured.
      final UpdateDownloadResult r = await downloadAndVerify(
        artifact: artifactFor(kApkBytes),
        into: into,
        open: (Uri _) async {
          Stream<List<int>> body() async* {
            yield kApkBytes.sublist(0, 16);
            throw const FileSystemException('No space left on device');
          }

          return (status: 200, bytes: body());
        },
      );
      expect(r.outcome, UpdateDownloadOutcome.cannotWrite);
    });

    test('a leftover half file from last time is cleared, not "continued" after', () async {
      final UpdateArtifact a = artifactFor(kApkBytes);
      await into.create(recursive: true);
      final File stale = File(
        '${into.path}${Platform.pathSeparator}${a.filename}',
      );
      await stale.writeAsBytes(<int>[9, 9, 9, 9, 9, 9, 9, 9]);

      final UpdateDownloadResult r = await downloadAndVerify(
        artifact: a,
        into: into,
        open: sourceOf(kApkBytes),
      );
      // If not cleared the length would be 8 + 9973 ⇒ sizeMismatch.
      expect(r.outcome, UpdateDownloadOutcome.verified);
      expect(await r.file!.readAsBytes(), equals(kApkBytes));
    });

    // ── Reuse an already-downloaded package (owner 2026-08-13) ─────────────
    //
    // Symptom: the first tap of install has to go into Settings to authorize
    // 「安装未知应用」; after returning from authorization, tapping again previously
    // re-downloaded 78 MB from scratch. Change: if disk already has a
    // **fully verifiable** same-named package, use it, do not re-download.
    // 🔴 But reuse must pass the same hash gate — a swapped package "exists"
    // just as brazenly as a good one.

    test(
      '🔴 disk already has a verifiable package ⇒ verified, and the byte source was not called even once (no re-download)',
      () async {
        final UpdateArtifact a = artifactFor(kApkBytes);
        // First put the "already downloaded and verified" package at the
        // destination.
        await into.create(recursive: true);
        final File already = File(
          '${into.path}${Platform.pathSeparator}${a.filename}',
        );
        await already.writeAsBytes(kApkBytes);

        int opens = 0;
        final UpdateDownloadResult r = await downloadAndVerify(
          artifact: a,
          into: into,
          open: (Uri u) async {
            opens += 1; // once called, it is a re-download — this test's reverse control is right here
            return sourceOf(kApkBytes)(u);
          },
        );

        expect(r.outcome, UpdateDownloadOutcome.verified);
        expect(r.file, isNotNull);
        expect(await r.file!.readAsBytes(), equals(kApkBytes));
        expect(
          opens,
          0,
          reason: 'disk already had a verifiable package, yet the download source was opened again ⇒ 78 MB was downloaded a second time for nothing',
        );
      },
    );

    test(
      '🔴 reverse control: the copy on disk was **swapped** (length right, hash wrong) ⇒ do not reuse, re-download once to get the good package back',
      () async {
        final UpdateArtifact a = artifactFor(kApkBytes);
        await into.create(recursive: true);
        // Same length as the manifest, different content ⇒ hash mismatch. An
        // implementation that only recognizes "the file is there" would hand
        // it out to install.
        final Uint8List tampered = Uint8List.fromList(
          List<int>.generate(kApkBytes.length, (int i) => (i * 17 + 3) % 251),
        );
        expect(tampered.length, kApkBytes.length); // same length, force the hash to distinguish
        expect(sha256.convert(tampered).toString(), isNot(kApkSha));
        await File(
          '${into.path}${Platform.pathSeparator}${a.filename}',
        ).writeAsBytes(tampered);

        int opens = 0;
        final UpdateDownloadResult r = await downloadAndVerify(
          artifact: a,
          into: into,
          open: (Uri u) async {
            opens += 1;
            return sourceOf(kApkBytes)(u); // what the re-download gets is the real package
          },
        );

        expect(
          opens,
          1,
          reason: 'a swapped package was reused on "the file is there" alone ⇒ what the user installed is not the official-site copy',
        );
        expect(r.outcome, UpdateDownloadOutcome.verified);
        expect(await r.file!.readAsBytes(), equals(kApkBytes)); // it is the re-downloaded good package
      },
    );

    test('the copy on disk has the wrong length (truncated) ⇒ do not reuse, re-download', () async {
      final UpdateArtifact a = artifactFor(kApkBytes);
      await into.create(recursive: true);
      await File(
        '${into.path}${Platform.pathSeparator}${a.filename}',
      ).writeAsBytes(kApkBytes.sublist(0, 4096)); // a stretch short

      int opens = 0;
      final UpdateDownloadResult r = await downloadAndVerify(
        artifact: a,
        into: into,
        open: (Uri u) async {
          opens += 1;
          return sourceOf(kApkBytes)(u);
        },
      );
      expect(opens, 1, reason: 'a truncated half package must not be treated as "already downloaded"');
      expect(r.outcome, UpdateDownloadOutcome.verified);
      expect(await r.file!.readAsBytes(), equals(kApkBytes));
    });

    test('progress is monotonically increasing, and the last time equals the size in the manifest', () async {
      final UpdateArtifact a = artifactFor(kApkBytes);
      final List<int> seen = <int>[];
      int? total;
      await downloadAndVerify(
        artifact: a,
        into: into,
        open: sourceOf(kApkBytes, chunk: 700),
        onProgress: (int received, int? t) {
          seen.add(received);
          total = t;
        },
      );
      expect(seen, isNotEmpty);
      expect(seen.last, a.size);
      expect(total, a.size, reason: 'the total\'s criterion must be the size in the manifest, not the length the server claims');
      for (int i = 1; i < seen.length; i++) {
        expect(seen[i], greaterThan(seen[i - 1]));
      }
    });
  });

  group('🔴 unverified bytes, the installer must not see even once', () {
    test(
      'hash mismatch ⇒ installer call count = 0, and installOutcome stays null',
      () async {
        final _SpyInstaller spy = _SpyInstaller();
        final UpdateController c = await _rigWithArtifact(
          downloader: _downloaderOver(sourceOf(kApkBytes), into, sha: kWrongSha),
          installer: spy.run,
        );
        addTearDown(c.dispose);

        await c.downloadAndInstall();

        // ⚠️ Order as above: **call count first**. If `downloadOutcome` is
        // put in front, a broken gate explodes there first, and "how many
        // times was the installer actually called" is never measured once
        // in the reverse control — which is the entire reason this group
        // exists.
        expect(
          spy.calls,
          0,
          reason: 'deleted the file but still called the installer ⇒ the gate is only a sentence',
        );
        expect(
          c.installOutcome,
          isNull,
          reason: 'the install stretch did not happen this time at all, so the UI must not say its words',
        );
        expect(c.downloadOutcome, UpdateDownloadOutcome.hashMismatch);
        expect(c.installBusy, isFalse);
      },
    );

    test('hash matches ⇒ the installer is called exactly once, argument is that verified file', () async {
      final _SpyInstaller spy = _SpyInstaller();
      final UpdateController c = await _rigWithArtifact(
        downloader: _downloaderOver(sourceOf(kApkBytes), into),
        installer: spy.run,
      );
      addTearDown(c.dispose);

      await c.downloadAndInstall();

      expect(c.downloadOutcome, UpdateDownloadOutcome.verified);
      expect(spy.calls, 1);
      expect(spy.paths.single, endsWith('FlowMic-9.9.9-release.apk'));
      expect(await File(spy.paths.single).readAsBytes(), equals(kApkBytes));
      expect(c.installOutcome, UpdateInstallOutcome.handedToInstaller);
    });

    // Exhaustive: **every** failure cell must be zero calls. Spot-checking
    // two cells, nobody knows if the third was wired wrong.
    for (final UpdateDownloadOutcome bad in UpdateDownloadOutcome.values) {
      if (bad == UpdateDownloadOutcome.verified) continue;
      test('$bad ⇒ installer call count = 0', () async {
        final _SpyInstaller spy = _SpyInstaller();
        final UpdateController c = await _rigWithArtifact(
          downloader:
              (UpdateArtifact a, {UpdateDownloadProgress? onProgress}) async =>
                  UpdateDownloadResult(bad, detail: 'forced'),
          installer: spy.run,
        );
        addTearDown(c.dispose);
        await c.downloadAndInstall();
        expect(spy.calls, 0);
        expect(c.downloadOutcome, bad);
        expect(c.installOutcome, isNull);
      });
    }

    test('downloader throws ⇒ named as unreachable, never collapses into "probably downloaded"', () async {
      final _SpyInstaller spy = _SpyInstaller();
      final UpdateController c = await _rigWithArtifact(
        downloader: (UpdateArtifact a, {UpdateDownloadProgress? onProgress}) =>
            throw StateError('boom'),
        installer: spy.run,
      );
      addTearDown(c.dispose);
      await c.downloadAndInstall();
      expect(c.downloadOutcome, UpdateDownloadOutcome.unreachable);
      expect(spy.calls, 0);
    });

    test('this version in the manifest is not apk ⇒ canInstall is false, pressing it nothing happens', () async {
      final _SpyInstaller spy = _SpyInstaller();
      bool downloaded = false;
      final UpdateController c = await _rigWithArtifact(
        installable: null,
        downloader: (UpdateArtifact a, {UpdateDownloadProgress? onProgress}) async {
          downloaded = true;
          return const UpdateDownloadResult(UpdateDownloadOutcome.verified);
        },
        installer: spy.run,
      );
      addTearDown(c.dispose);
      expect(c.canInstall, isFalse);
      await c.downloadAndInstall();
      expect(downloaded, isFalse);
      expect(spy.calls, 0);
    });

    test('check once more ⇒ both stretches of conclusion are cleared (an old package\'s answer must not answer a new package\'s question)', () async {
      final UpdateController c = await _rigWithArtifact(
        downloader: _downloaderOver(sourceOf(kApkBytes), into, sha: kWrongSha),
        installer: (String _) async =>
            const UpdateInstallResult(UpdateInstallOutcome.handedToInstaller),
      );
      addTearDown(c.dispose);
      await c.downloadAndInstall();
      expect(c.downloadOutcome, UpdateDownloadOutcome.hashMismatch);

      await c.checkNow();
      expect(c.downloadOutcome, isNull);
      expect(c.installOutcome, isNull);
    });
  });

  group('install stretch —— what the platform answers, we say', () {
    test('handed_off ⇒ handedToInstaller (🔴 not "already installed")', () async {
      final UpdateInstallResult r = await handOffToInstaller(
        '/tmp/x.apk',
        port: _FakePort(answer: kInstallHandedOff),
      );
      expect(r.outcome, UpdateInstallOutcome.handedToInstaller);
    });

    test('permission_required ⇒ its own cell (the one the user can fix themselves)', () async {
      final UpdateInstallResult r = await handOffToInstaller(
        '/tmp/x.apk',
        port: _FakePort(answer: kInstallPermissionRequired),
      );
      expect(r.outcome, UpdateInstallOutcome.permissionRequired);
    });

    test('answered a string we do not recognize ⇒ refused, **must not be treated as success**', () async {
      final UpdateInstallResult r = await handOffToInstaller(
        '/tmp/x.apk',
        port: _FakePort(answer: 'ok'),
      );
      expect(r.outcome, UpdateInstallOutcome.refused);
      expect(r.detail, 'unknown_answer:ok');
    });

    test('answered null (a channel that did nothing) ⇒ refused', () async {
      final UpdateInstallResult r = await handOffToInstaller(
        '/tmp/x.apk',
        port: _FakePort(answer: null),
      );
      expect(r.outcome, UpdateInstallOutcome.refused);
    });

    test('PlatformException ⇒ refused, and carries the platform\'s original words', () async {
      final UpdateInstallResult r = await handOffToInstaller(
        '/tmp/x.apk',
        port: _FakePort(
          error: PlatformException(code: 'NO_FILE', message: 'not a file'),
        ),
      );
      expect(r.outcome, UpdateInstallOutcome.refused);
      expect(r.detail, 'NO_FILE:not a file');
    });

    test('MissingPluginException ⇒ unsupportedPlatform (kept separate from refused)', () async {
      final UpdateInstallResult r = await handOffToInstaller(
        '/tmp/x.apk',
        port: _FakePort(error: MissingPluginException('no channel')),
      );
      expect(r.outcome, UpdateInstallOutcome.unsupportedPlatform);
    });
  });

  group('🔴 four locales —— every failure cell has its own sentence, no two cells share', () {
    test('the twelve new sentences: each of the four locales is its own, and not one is empty', () {
      final List<String Function(AppStrings)> keys = <String Function(AppStrings)>[
        (AppStrings s) => s.updateDownloadAndInstall,
        (AppStrings s) => s.updateDownloading('42%'),
        (AppStrings s) => s.updateVerifying,
        (AppStrings s) => s.updateDownloadHashMismatch,
        (AppStrings s) => s.updateDownloadSizeMismatch,
        (AppStrings s) => s.updateDownloadServerRefused,
        (AppStrings s) => s.updateDownloadUnreachable,
        (AppStrings s) => s.updateDownloadCannotWrite,
        (AppStrings s) => s.updateHandedToInstaller,
        (AppStrings s) => s.updateInstallPermissionRequired,
        (AppStrings s) => s.updateInstallRefused,
        (AppStrings s) => s.updateInstallUnsupported,
      ];
      for (final String Function(AppStrings) key in keys) {
        final Set<String> seen = <String>{};
        for (final AppLocale l in AppLocale.values) {
          final String v = key(AppStrings.of(l));
          expect(v, isNotEmpty);
          expect(seen.add(v), isTrue, reason: '$l used the same sentence as the previous locale: $v');
        }
      }
    });

    test('🔴 six download-stretch cells + four install-stretch cells, ten sentences pairwise distinct', () {
      // Merge any two sentences and this goes red on the spot. The type-
      // level shape of "failures each say their own".
      final AppStrings s = AppStrings.of(AppLocale.zh);
      final Set<String> seen = <String>{};
      final List<String> all = <String>[
        s.updateDownloadHashMismatch,
        s.updateDownloadSizeMismatch,
        s.updateDownloadServerRefused,
        s.updateDownloadUnreachable,
        s.updateDownloadCannotWrite,
        s.updateVerifying,
        s.updateHandedToInstaller,
        s.updateInstallPermissionRequired,
        s.updateInstallRefused,
        s.updateInstallUnsupported,
      ];
      for (final String one in all) {
        expect(seen.add(one), isTrue, reason: 'shared the same sentence with another cell: $one');
      }
      // 🔴 And the download-stretch sentence must not collide with the
      // "cannot reach the official site" sentence — they are two machines.
      expect(s.updateDownloadUnreachable, isNot(s.updateUnreachable));
    });

    test('🔴 the "handed to the system installer" sentence must not say "already installed / already updated"', () {
      // There is no silent install on Android. Saying already-installed is
      // saying a thing that was not done as if it was done.
      for (final AppLocale l in AppLocale.values) {
        final String v = AppStrings.of(l).updateHandedToInstaller;
        for (final String banned in <String>[
          '已安装',
          '已更新',
          'has been installed',
          'is installed',
          'インストールしました',
          '설치했습니다',
          '설치를 마쳤습니다',
        ]) {
          expect(
            v.contains(banned),
            isFalse,
            reason: '$l\'s sentence said 「$banned」, and we only handed it off: $v',
          );
        }
      }
    });
  });
}

// ── Fixture ────────────────────────────────────────────────────────────────

/// An installer that counts calls. **The count is the most important quantity
/// in this file** — a test that only asserts "is the outcome right" is green
/// on "also called it once while we were here".
class _SpyInstaller {
  int calls = 0;
  final List<String> paths = <String>[];

  Future<UpdateInstallResult> run(String path) async {
    calls++;
    paths.add(path);
    return const UpdateInstallResult(UpdateInstallOutcome.handedToInstaller);
  }
}

class _FakePort implements UpdateInstallerPort {
  _FakePort({this.answer, this.error});
  final String? answer;
  final Object? error;

  @override
  Future<String?> installApk(String apkPath) async {
    final Object? e = error;
    if (e != null) throw e;
    return answer;
  }
}

/// A downloader that wires the **real downloadAndVerify** into the controller.
/// The only thing swapped is where the bytes come from; the length criterion,
/// the hash criterion, and file deletion all walk the production path.
UpdateDownloader _downloaderOver(
  UpdateByteSource source,
  Directory into, {
  String? sha,
}) =>
    (UpdateArtifact a, {UpdateDownloadProgress? onProgress}) => downloadAndVerify(
      artifact: sha == null ? a : artifactFor(kApkBytes, sha: sha),
      into: into,
      open: source,
      onProgress: onProgress,
    );

/// A controller that has already discovered "there is a new version".
Future<UpdateController> _rigWithArtifact({
  UpdateDownloader? downloader,
  UpdateInstallRunner? installer,
  UpdateArtifact? installable = _sentinel,
}) async {
  final UpdateArtifact? art =
      identical(installable, _sentinel) ? artifactFor(kApkBytes) : installable;
  final UpdateController c = newTestUpdateController(
    downloader: downloader,
    installer: installer,
    checker: (({required String? currentVersion}) async => UpdateCheckResult(
          UpdateCheckOutcome.updateAvailable,
          latestVersion: '9.9.9',
          installable: art,
          downloadUrl: art?.url ?? 'http://100.64.7.68/dl/flowmic/x.zip',
          comparedAt: DateTime.utc(2026, 8, 8, 9, 12),
        )),
  );
  await c.load();
  await c.checkNow();
  return c;
}

/// `null` is a **meaningful value** of `installable` ("this version shipped
/// is not apk"), so the default cannot use null to mean "not passed".
const UpdateArtifact _sentinel = UpdateArtifact(
  kind: 'sentinel',
  locale: null,
  filename: 'sentinel',
  url: 'http://example.invalid/s',
  sha256: kWrongSha,
  size: 1,
);
