// NR-279 (A2; owner 2026-10-19 reopens ruling ⑩) — faces that exist as their
// own presentation STATE but still borrow another face's word, because their
// own nine-language word has not been written yet (Gemini, later card).
//
// The 「every face has its own word」 tests (delivery_terminology_test,
// inject_state_narrowing_test, outbox_ui_surface_test) skip exactly these, and
// row_no_result_note_test.dart pins what each one borrows TODAY. The card that
// lands the new word swaps the pill key in status_badge.dart
// `deliveryFaceMeta` (`noAnswerYet` arm), empties this set, and updates that
// pin — then the distinctness tests cover the face again.
//
// Deliberately in test/support and not in lib/: nothing in the product needs
// to know a word is pending.
//
// LOUD, NOT SILENT (NR-279 review S3): test/pending_wording_release_guard_test.dart
// fails while this set is non-empty once pubspec.yaml reaches 0.3.116.

import 'package:flowmic/src/ui/status_badge.dart' show DeliveryFace;

// NR-280 (2026-10-19): `noAnswerYet` has its own word (`statusNoAnswerYet`),
// so the set is empty and the distinctness tests cover every face again.
const Set<DeliveryFace> kFacesAwaitingOwnWording = <DeliveryFace>{};

/// [DeliveryFace.values] minus the faces above — what the distinctness tests
/// iterate.
Iterable<DeliveryFace> get facesWithOwnWording => DeliveryFace.values
    .where((DeliveryFace f) => !kFacesAwaitingOwnWording.contains(f));
