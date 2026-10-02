part of 'blind_store_timeline_bridge.dart';

/// Retry forever with 1, 2, 4, 8, 16, then 30 minute delays.
/// Ciphertext and the capped schedule persist together per account and row.
class _RetrySchedule {
  const _RetrySchedule({this.attempts = 0, this.nextMs = 0, this.noticed = false, this.failure = BlindStoreRetryFailure.other});
  final int attempts;
  final int nextMs;
  final bool noticed;
  final BlindStoreRetryFailure failure;
  factory _RetrySchedule.fromJson(Map<String, Object?> value) {
    final attempts = value['retry_attempts'] ?? 0;
    final nextMs = value['retry_next_ms'] ?? 0;
    final noticed = value['retry_noticed'] ?? false;
    if (attempts is! int || attempts < 0 || attempts > 6 ||
        nextMs is! int || nextMs < 0 || noticed is! bool) {
      throw const FormatException('invalid retry schedule');
    }
    final kind = value['retry_failure'] ?? 'other';
    final failure = BlindStoreRetryFailure.values.firstWhere((f) => f.name == kind,
      orElse: () => throw const FormatException('invalid retry failure'));
    return _RetrySchedule(attempts: attempts, nextMs: nextMs, noticed: noticed, failure: failure);
  }
  bool ready(int nowMs) => failure != BlindStoreRetryFailure.unreadable && nowMs >= nextMs;
  _RetrySchedule afterFailure(int nowMs, BlindStoreRetryFailure failure) => _RetrySchedule(
    attempts: attempts < 6 ? attempts + 1 : 6,
    nextMs: nowMs + (60000 * (attempts < 5 ? (1 << attempts) : 30)), noticed: true, failure: failure,
  );
  Map<String, Object?> toJson() => {
    'retry_attempts': attempts, 'retry_next_ms': nextMs, 'retry_noticed': noticed, 'retry_failure': failure.name,
  };
}
