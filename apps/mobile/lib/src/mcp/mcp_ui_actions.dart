// Shared visible confirmations and safe failure reporting for MCP screens.
import 'package:flutter/material.dart';
import '../settings/app_strings.dart';
import 'mcp_channel.dart';
import 'mcp_copy.dart';
import 'mcp_service.dart';
import 'mcp_transport.dart';
import 'mcp_submission_store.dart';

Future<bool> mcpConfirm(BuildContext context, AppStrings s, String message, String action, {List<Widget> details = const <Widget>[]}) async =>
  await showDialog<bool>(context: context, builder: (BuildContext dialog) => AlertDialog(
    content: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[...details, Text(message)])), actions: <Widget>[
      TextButton(onPressed: () => Navigator.pop(dialog, false), child: Text(s.cancel)),
      TextButton(key: const ValueKey<String>('mcp.confirm'), onPressed: () => Navigator.pop(dialog, true), child: Text(action)),
    ])) == true;

Future<void> mcpAction(BuildContext context, AppStrings s, Future<void> Function() action) async {
  try { await action(); }
  on Object catch (e) {
    final McpText label = e is StateError && e.message == 'content_not_ready' ? McpText.contentNotReady :
      e is StateError && e.message == 'sending' ? McpText.sending :
      e is StateError && e.message == 'confirmation_changed' ? McpText.unknownRetryWarning :
      e is StateError && e.message == 'local_mapping' ? McpText.mapping :
      e is StateError && <String>{'manual_unavailable', 'test_required'}.contains(e.message) ? McpText.rejected : McpText.storageUnavailable;
    if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(s.mcp(label))));
  }
}

Future<void> mcpManual(BuildContext context, AppStrings s, McpService service, McpChannel channel, String entryId, {VoidCallback? onSubmitted}) async {
  await mcpAction(context, s, () async {
    final List<Map<String, Object?>> jobs = await service.store!.submissions(channel.id);
    final List<Map<String, Object?>> previous = jobs.where((Map<String, Object?> j) => j['entry_id'] == entryId).toList();
    final bool duplicate = previous.any((Map<String, Object?> j) => <String>{'sent', 'unknown', 'sending'}.contains(j['state']) || j['last_error'] == 'remote_tool');
    if (!context.mounted) return;
    final String disclosure = s.mcp(McpText.manualDisclosure, host: channel.hostHint, tool: channel.tool);
    if (!await mcpConfirm(context, s, duplicate ? '$disclosure\n\n${s.mcp(McpText.unknownRetryWarning)}' : disclosure, s.mcp(McpText.manual),
      details: <Widget>[Text(channel.name), Text(channel.hostHint), Text(channel.tool)])) {
      return;
    }
    // Re-read the generation after the dialog. A background configuration import
    // must never redirect the user's confirmation to a different recipient.
    if (!service.channels.any((McpChannel c) => c.id == channel.id && c.generation == channel.generation && c.canSend)) {
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(s.mcp(McpText.testFailed))));
      return;
    }
    await service.manual(entryId, channel.id, generation: channel.generation,
      expectedRevision: mcpJobRevision(previous.isEmpty ? null : previous.single));
    onSubmitted?.call();
  });
}

String mcpReplyLabel(AppStrings s, McpReply reply) {
  if (reply.reason == 'local_mapping' && (reply.field == null || reply.field!.isEmpty)) return s.mcp(McpText.mapping);
  return s.mcp(replyText(reply), field: reply.field ?? '');
}

String mcpError(AppStrings s, String reason, {String field = ''}) =>
  mcpReplyLabel(s, McpReply(McpEvidence.notExecuted, reason, field: field));
