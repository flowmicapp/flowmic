// SPEC-REF:
//   apps/mobile/lib/src/audio/retained_audio_store.dart (RetainedAudioStore)
//   apps/mobile/android/app/src/main/res/xml/flowmic_update_paths.xml
//   apps/mobile/android/app/src/main/res/xml/flowmic_clipboard_paths.xml
//
// The production directory for retained audio, kept in its own file so
// [RetainedAudioStore] itself never imports path_provider. That split is the
// same one update_card_widget_test.dart records the cost of: a class that
// reaches for a platform channel by default cannot be unit-tested without one.
// The store takes a plain [Directory]; only this factory knows where it lives.
//
// 🔴 J8 BOUNDARY — WHY THIS DIRECTORY AND NOT ANOTHER.
// getApplicationSupportDirectory() is Context.getFilesDir() on Android, and the
// app declares exactly two FileProvider roots:
//   - `<files-path  path="update/"   />` (flowmic_update_paths.xml)
//   - `<cache-path  path="clipboard/"/>` (flowmic_clipboard_paths.xml)
// `retained_audio/` is a SIBLING of `update/`, not a child, and is not under the
// cache dir at all. FileProvider.getUriForFile throws IllegalArgumentException
// for any file outside every declared root, so no content:// URI can be minted
// for these bytes even by code that tried. The boundary is enforced by the
// platform rather than by reviewer vigilance — which matters, because the thing
// being prevented (this layer growing into the deferred FB-2 voice archive) is
// exactly the kind of drift a reviewer stops noticing.

import 'dart:io';

import 'package:path_provider/path_provider.dart';

import 'retained_audio_store.dart';

/// Open the production retained-audio store. The directory is created on first
/// use and seeded so [RetainedAudioStore.retainedBytes] is accurate before the
/// first append (an app that was killed mid-outage may have left files behind).
///
/// The caller should also run [RetainedAudioStore.sweep] once after opening, so
/// orphaned audio from a session that can never be resumed ages out — and is
/// announced on the way out rather than vanishing.
Future<RetainedAudioStore> openRetainedAudioStore() async {
  final Directory base = await getApplicationSupportDirectory();
  final Directory dir = Directory(
    '${base.path}${Platform.pathSeparator}${RetainedAudioStore.dirName}',
  );
  final RetainedAudioStore store = RetainedAudioStore(dir: dir);
  await store.open();
  return store;
}
