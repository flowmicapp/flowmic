// SPEC-REF:
//   docs/ui-design/REDESIGN-PLAN.md §3 P-3 (ONE banner slot — new sources join
//     the queue, they do not invent a second surface)
//   card U2 — see ptt/mic_permission.dart for the whole argument.
//
// Face → banner mapping for the mic-permission flow. Lives in its OWN file so
// chat_banner_sources.dart only gains the one adapter call: every decision
// (severity, wording key, which action) is here and unit-testable through
// BannerQueue without a widget.
//
// LIFECYCLE (banner_queue.dart's contract): EVENT-type. The refused press is
// over, the FSM is back in IDLE and the user is not trapped (text compose and
// favorites still deliver) — so every face is dismissible, and the NEXT refused
// press re-raises it through `gateForPtt` (藏不是丢 — "hidden, not dropped"). It
// is pushed AFTER
// `buildChatBanners`'s entries, so an equally-blocking live link-drop keeps the
// slot (same FIFO reasoning as sttStall) and the mic notice waits behind
// 「还有 N 条」 ("N still remaining").

import 'dart:async';

import '../ptt/mic_permission.dart';
import '../settings/app_strings.dart';
import 'banner_queue.dart';

/// Push the mic-permission banner for [flow]'s current face, if any.
///
/// Severity ruling:
///   · rationale → **info**: nothing failed yet — it explains and offers the
///     request. Painting the first-ever contact red would report a fault that
///     has not happened.
///   · denied / permanentlyDenied / captureStartFailed → **blocking**: the user
///     held the talk bar and the product's core action did not happen — the
///     same P-2 red ruling as sttStall, and each carries its fix (re-request /
///     go to system settings / retry-restart).
void pushMicPermissionBanner(
  BannerQueue queue, {
  required MicPermissionFlow flow,
  required AppStrings strings,
}) {
  switch (flow.face.value) {
    case MicFlowFace.none:
      return;
    case MicFlowFace.rationale:
      queue.push(
        BannerItem(
          id: BannerIds.micPermission,
          severity: BannerSeverity.info,
          message: strings.micRationale,
          actionLabel: strings.micAllowAction,
          // The REAL OS request is born here — on the rendered rationale's own
          // button, never cold in mid-gesture (U2 ①).
          onAction: () => unawaited(flow.requestFromSurface()),
          onDismiss: flow.dismiss,
          dismissible: true,
        ),
      );
    case MicFlowFace.denied:
      queue.push(
        BannerItem(
          id: BannerIds.micPermission,
          severity: BannerSeverity.blocking,
          message: strings.micDenied,
          actionLabel: strings.micAllowAction,
          onAction: () => unawaited(flow.requestFromSurface()),
          onDismiss: flow.dismiss,
          dismissible: true,
        ),
      );
    case MicFlowFace.permanentlyDenied:
      queue.push(
        BannerItem(
          id: BannerIds.micPermission,
          severity: BannerSeverity.blocking,
          message: strings.micPermanentlyDenied,
          actionLabel: strings.micOpenSettingsAction,
          // U2 ③ — the `openAppSettings` way out of 「不再询问」 ("don't ask again").
          onAction: () => unawaited(flow.openSystemSettings()),
          onDismiss: flow.dismiss,
          dismissible: true,
        ),
      );
    case MicFlowFace.captureStartFailed:
      queue.push(
        BannerItem(
          id: BannerIds.micPermission,
          severity: BannerSeverity.blocking,
          message: strings.micCaptureStartFailed,
          dismissible: true,
          onAction: flow.dismiss,
        ),
      );
  }
}
