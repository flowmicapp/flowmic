// 0.3.0 P1 — the home-screen entry to 「where do my words go」.
//
// WHY IT IS ITS OWN FILE. connections_page.dart crossed the 800-line cap when
// this row was added inline. The repo's precedent (0.2.52 §5) is a structural
// split, never deleting the reasoning to fit: the row moved out VERBATIM and
// took its own justification with it.
//
// WHY THE ROW LOOKS LIKE THIS. It is a full row with a subtitle rather than a
// bare link, because the subtitle IS the one-line answer — a user who never taps
// still learns the shape of the path (capture → recognition → optional model
// processing → typed into the PC).
//
// WHY IT LIVES ON THE HOME SCREEN. The connections page is the first screen a
// new install shows, before any pairing exists and therefore before the user has
// said a word. A disclosure first reachable from inside the chat screen would
// only ever be met after the audio had already gone somewhere.
//
// The page is constructed here rather than injected as a builder (the pattern
// the history/settings entries use) because it needs nothing the caller does not
// already hold — a builder parameter would mean threading it through main.dart
// for no added seam.

import 'package:flutter/material.dart';

import '../settings/app_settings.dart';
import '../settings/app_strings.dart';
import 'data_flow_disclosure_page.dart';
import 'tokens.dart';

class DataFlowDisclosureEntry extends StatelessWidget {
  const DataFlowDisclosureEntry({super.key, required this.appSettings});

  final AppSettingsController appSettings;

  @override
  Widget build(BuildContext context) {
    final AppStrings s = AppStrings.of(appSettings.locale);
    return InkWell(
      key: const ValueKey<String>('connections.disclosure'),
      onTap: () => Navigator.of(context).push<void>(
        MaterialPageRoute<void>(
          builder: (_) => DataFlowDisclosurePage(appSettings: appSettings),
        ),
      ),
      borderRadius: BorderRadius.circular(12),
      child: Container(
        padding: const EdgeInsets.fromLTRB(12, 11, 10, 11),
        decoration: BoxDecoration(
          color: FlowMicColors.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: FlowMicColors.line),
        ),
        child: Row(
          children: <Widget>[
            Icon(Icons.privacy_tip_outlined, size: 16, color: FlowMicColors.t2),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    s.discEntry,
                    style: TextStyle(
                      color: FlowMicColors.t1,
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    s.discEntrySub,
                    style: TextStyle(color: FlowMicColors.t3, fontSize: 11.5, height: 1.45),
                  ),
                ],
              ),
            ),
            Icon(Icons.chevron_right, size: 18, color: FlowMicColors.t3),
          ],
        ),
      ),
    );
  }
}
