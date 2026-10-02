// Timeline failures use separate truthful sentences for local and recovered rows.
part of 'banner_queue.dart';
void _pushTimelineFailures(BannerQueue queue, AppStrings strings, {
  required bool recovery, required bool write, required bool delete, required bool recoveryPersistent,
  void Function()? dismissRecovery, void Function()? dismissWrite, void Function()? dismissDelete,
}) {
  if (recovery) {
    queue.push(BannerItem(id: BannerIds.timelineRecoveryFailure,
      severity: BannerSeverity.degraded, message: strings.timelineRecoveryFailed,
      dismissible: !recoveryPersistent, onAction: dismissRecovery));
  }
  if (delete) {
    queue.push(BannerItem(
      id: BannerIds.timelineDeleteFailure,
      severity: BannerSeverity.degraded,
      message: strings.selectionDeleteFailed,
      dismissible: true, onAction: dismissDelete,
    ));
  }
  if (write) {
    queue.push(
      BannerItem(
        id: BannerIds.timelineWriteFailure,
        severity: BannerSeverity.degraded,
        message: strings.timelineLocalSaveFailed,
        dismissible: true,
        onAction: dismissWrite,
      ),
    );
  }
}
