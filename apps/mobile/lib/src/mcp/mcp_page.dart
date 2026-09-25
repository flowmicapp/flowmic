// Production screen shared by settings and the existing timeline context menu.
// Consent is a distinct action after read-only testing; simply opening or saving
// this screen never authorizes a write. Only the host is shown in summaries.
import 'package:flutter/material.dart';

import '../settings/app_settings.dart';
import '../settings/app_strings.dart';
import 'mcp_channel.dart';
import 'mcp_channel_page.dart';
import 'mcp_copy.dart';
import 'mcp_service.dart';
import 'mcp_ui_actions.dart';

class McpPage extends StatelessWidget {
  const McpPage({super.key, required this.service, required this.settings, this.entryId});
  final McpService service;
  final AppSettingsController settings;
  final String? entryId;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge(<Listenable>[service, settings]),
    builder: (BuildContext context, _) {
      final AppStrings s = AppStrings.of(settings.locale);
      return Scaffold(appBar: AppBar(title: Text(s.mcp(McpText.title))),
        body: ListView(padding: const EdgeInsets.all(16), children: <Widget>[
          Text(s.mcp(McpText.scope)), const SizedBox(height: 8),
          Text(s.mcp(McpText.noRemoteDelete)), const SizedBox(height: 16),
          if (!service.available) Text(s.mcp(McpText.storageUnavailable)),
          if (service.channels.isEmpty) Text(s.mcp(McpText.unconfigured)),
          for (final McpChannel channel in service.channels) Card(child: Padding(
            padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: <Widget>[
              Text(channel.name, style: Theme.of(context).textTheme.titleMedium),
              Text(channel.hostHint), Text(channel.tool),
              Text(s.mcp(channelText(channel.state)), key: ValueKey<String>('mcp.state.${channel.id}')),
              if (channel.expiredCount > 0) Text(s.mcp(McpText.expired, count: channel.expiredCount)),
              if (channel.lastSuccessAt != null) ...<Widget>[
                Wrap(spacing: 8, children: <Widget>[
                  Text(s.mcp(McpText.lastCallSuccess), key: const ValueKey<String>('mcp.last-call-caption')),
                  Text(DateTime.fromMillisecondsSinceEpoch(channel.lastSuccessAt!).toLocal().toString(), key: const ValueKey<String>('mcp.last-call-time')),
                ]),
              ],
              Wrap(spacing: 8, children: <Widget>[
                TextButton(key: ValueKey<String>('mcp.edit.${channel.id}'),
                  onPressed: service.available ? () => _edit(context, channel) : null,
                  child: Text(s.entryEdit)),
                TextButton(onPressed: () async {
                  if (!await mcpConfirm(context, s, s.mcp(McpText.deleteDisclosure), s.confirmDelete)) return;
                  if (context.mounted) await mcpAction(context, s, () => service.remove(channel.id));
                }, child: Text(s.confirmDelete)),
                if (entryId != null) TextButton(key: ValueKey<String>('mcp.manual.${channel.id}'),
                  onPressed: channel.canSend && service.available ? () => mcpManual(context, s, service, channel, entryId!,
                    onSubmitted: () { if (context.mounted) _edit(context, channel); }) : null,
                  child: Text(s.mcp(McpText.manual))),
              ]),
            ]))),
          if (service.channels.length < 3) Align(alignment: Alignment.centerLeft,
            child: FilledButton(key: const ValueKey<String>('mcp.add'),
              onPressed: service.available ? () => _edit(context, null) : null, child: Text(s.add))),
        ]));
    },
  );
  Future<void> _edit(BuildContext context, McpChannel? channel) => Navigator.of(context).push<void>(MaterialPageRoute<void>(
    builder: (_) => McpChannelPage(service: service, settings: settings, channel: channel)));
}
