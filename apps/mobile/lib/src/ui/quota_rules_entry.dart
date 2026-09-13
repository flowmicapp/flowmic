// Card WB-5a — the connections-list entry to 「who pays for transcription」.
//
// WHY IT EXISTS AT ALL, AND WHAT IT REPLACED. Until 2026-09-12 this fact was a
// standing banner over the transcript (`BannerIds.farEndPaysQuota`, raised
// whenever the latest `billing:budget` frame said `payer:'far_end'`). Owner
// removed it (the 09-12 batch ruling, item 5) and asked for a guide here
// instead. That is a change of PLACE and of SCOPE, and the second half is the
// interesting one: a frame-keyed line could only ever answer 「who is paying for
// THIS recording」, and only for the one case the frame named — its own
// documentation recorded that it said 「the computer you are connected to」 to a
// reader who was speaking into somebody else's web page, because the wire
// carries no room kind the phone can read. A guide is keyed on nothing, so it
// can state every case without claiming which one is happening now.
//
// WHY IT LIVES ON THIS SCREEN. The connections page is the first screen a new
// install shows — before any pairing exists, and therefore before the first
// word is spoken. Same placement, and the same reason, as the data-flow
// disclosure row directly below it: an explanation first reachable from inside
// the recording screen is met after the thing it explains has happened.
//
// WHY IT IS ITS OWN FILE. `connections_page.dart` is at the 800-line cap, and
// this repo's precedent (0.2.52 §5) is a structural split rather than deleting
// the reasoning to fit. The row and its justification moved out together.
//
// WHY THE ROW CARRIES A SUBTITLE rather than being a bare link: the subtitle IS
// the one-line answer, so a reader who never taps still learns the shape of the
// rule. The disclosure row beside it is built the same way for the same reason.
//
// THE COPY IS NOT OWNED HERE. Every sentence lives in
// `settings/strings/metering_strings.dart` with its reasoning, in nine
// languages; this file only lays it out.

import 'package:flutter/material.dart';

import '../settings/app_settings.dart';
import '../settings/app_strings.dart';
import 'quota_rules_page.dart';
import 'tokens.dart';

class QuotaRulesEntry extends StatelessWidget {
  const QuotaRulesEntry({super.key, required this.appSettings});

  final AppSettingsController appSettings;

  @override
  Widget build(BuildContext context) {
    final AppStrings s = AppStrings.of(appSettings.locale);
    return Padding(
      // The gap to the disclosure row below is owned HERE, not spelled in the
      // page's list. Not a style preference: `connections_page.dart` is at the
      // 800-line cap (verify:lint file-size, SRC_MAX 800), so this row costs
      // that file one line instead of two. Measurable, and it moves back the
      // day that file is split.
      padding: const EdgeInsets.only(bottom: 10),
      child: InkWell(
        key: const ValueKey<String>('connections.quotaRules'),
        onTap: () => Navigator.of(context).push<void>(
          MaterialPageRoute<void>(
            builder: (_) => QuotaRulesPage(appSettings: appSettings),
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
              Icon(Icons.timer_outlined, size: 16, color: FlowMicColors.t2),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      s.quotaRulesTitle,
                      style: TextStyle(
                        color: FlowMicColors.t1,
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      s.quotaRulesSub,
                      style: TextStyle(
                        color: FlowMicColors.t3,
                        fontSize: 11.5,
                        height: 1.45,
                      ),
                    ),
                  ],
                ),
              ),
              Icon(Icons.chevron_right, size: 18, color: FlowMicColors.t3),
            ],
          ),
        ),
      ),
    );
  }
}
