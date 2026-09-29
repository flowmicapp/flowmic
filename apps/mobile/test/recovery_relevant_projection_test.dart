import 'dart:convert';

import 'package:flowmic/src/audio/recording_account.dart'
    show kConfigSnapshotAccount;
import 'package:flowmic/src/audio/retained_audio_manifest.dart';
import 'package:flowmic/src/session/recovery_relevant_projection.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'an account-only change alters the recovery revalidation projection',
    () {
      const JournalByteRange sendRange = JournalByteRange(0, 32000);
      const RecordingManifest before = RecordingManifest(
        recordingId: 'same-recording',
        configSnapshot: <String, Object?>{kConfigSnapshotAccount: 'account-a'},
      );
      final RecordingManifest after = before.copyWith(
        configSnapshot: <String, Object?>{
          ...before.configSnapshot,
          kConfigSnapshotAccount: 'account-b',
        },
      );

      final String beforeProjection = recoveryRelevantProjection(
        before,
        sendRange,
      );
      final String afterProjection = recoveryRelevantProjection(
        after,
        sendRange,
      );
      final Map<String, Object?> beforeFields =
          jsonDecode(beforeProjection) as Map<String, Object?>;
      final Map<String, Object?> afterFields =
          jsonDecode(afterProjection) as Map<String, Object?>;
      final List<String> changedFields = beforeFields.keys
          .where(
            (key) =>
                jsonEncode(beforeFields[key]) != jsonEncode(afterFields[key]),
          )
          .toList();

      expect(changedFields, ['account']);
      expect(afterProjection, isNot(beforeProjection));
    },
  );
}
