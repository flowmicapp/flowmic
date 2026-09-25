// A result is evidence about one configuration generation and one frozen
// payload. Never label an old generation as success for today's recipient.
import 'package:flutter/material.dart';

import '../settings/app_strings.dart';
import '../timeline/timeline_entry.dart';
import 'mcp_channel.dart';
import 'mcp_copy.dart';
import 'mcp_mapping.dart';
import 'mcp_secrets.dart';
import 'mcp_service.dart';
import 'mcp_submission_store.dart';
import 'mcp_ui_actions.dart';

class McpHistoryRow extends StatelessWidget {
  const McpHistoryRow({super.key, required this.service, required this.channel, required this.job, required this.strings});
  final McpService service;
  final McpChannel channel;
  final Map<String, Object?> job;
  final AppStrings strings;
  Future<({TimelineEntry? entry, bool changed})> _read() async {
    final TimelineEntry? entry = await service.readEntry(job['entry_id']! as String);
    bool changed = false;
    if (entry != null && job['payload_hash'] != null && job['generation'] == channel.generation) {
      final McpSecrets? secrets = await service.secrets.read(channel.id, channel.generation);
      if (secrets != null) {
        try { changed = mcpPayloadHash(McpMapping(channel.inputSchema, channel.mapping).arguments(entry, secrets: secrets.fixed)) != job['payload_hash']; }
        on McpMappingError { changed = true; }
      }
    }
    return (entry: entry, changed: changed);
  }
  @override
  Widget build(BuildContext context) => FutureBuilder<({TimelineEntry? entry, bool changed})>(
    future: _read(), builder: (BuildContext context, AsyncSnapshot<({TimelineEntry? entry, bool changed})> snapshot) {
      final McpText state = job['ready'] != 1 ? McpText.contentNotReady : switch (job['state']) {
        'pending' => McpText.pending, 'sending' => McpText.sending, 'sent' => McpText.toolResult,
        'unknown' => McpText.unknown, 'retrying' => McpText.retrying, _ => McpText.rejected,
      };
      final McpText? error = switch (job['last_error']) {
        'local_mapping' => McpText.mapping, 'remote_tool' => McpText.remoteRejected,
        'retry_exhausted' => McpText.retryExhausted, _ => null,
      };
      return Card(child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: <Widget>[
        if (snapshot.hasError) Text(strings.mcp(McpText.storageUnavailable)),
        if (snapshot.data?.entry != null) Text(snapshot.data!.entry!.outputText, maxLines: 3, overflow: TextOverflow.ellipsis),
        Text(DateTime.fromMillisecondsSinceEpoch(job['created_at']! as int).toLocal().toString()),
        if (job['generation'] != channel.generation) Text(strings.mcp(McpText.previousConfiguration)),
        Text(strings.mcp(state)),
        if (error != null) Text(strings.mcp(error)),
        if (snapshot.data?.changed == true) Text(strings.mcp(McpText.localChanged)),
        if (job['state'] != 'sending' && job['ready'] == 1) TextButton(
          onPressed: channel.canSend && snapshot.data?.entry != null && service.available
            ? () => mcpManual(context, strings, service, channel, job['entry_id']! as String) : null,
          child: Text(strings.mcp(job['state'] == 'sent' ? McpText.manual : McpText.retry))),
      ])));
    },
  );
}
