// Production configuration and per-record evidence, driven by the real service.
// No optimistic sent state: rows are read back from its durable ledger.
import 'package:flutter/material.dart';

import '../settings/app_settings.dart';
import '../settings/app_strings.dart';
import 'mcp_channel.dart';
import 'mcp_copy.dart';
import 'mcp_editor.dart';
import 'mcp_field_editor.dart';
import 'mcp_history_row.dart';
import 'mcp_mapping.dart';
import 'mcp_service.dart';
import 'mcp_ui_actions.dart';

class McpChannelPage extends StatefulWidget {
  const McpChannelPage({super.key, required this.service, required this.settings, required this.channel});
  final McpService service;
  final AppSettingsController settings;
  final McpChannel? channel;
  @override
  State<McpChannelPage> createState() => _McpChannelPageState();
}

class _McpChannelPageState extends State<McpChannelPage> {
  late final McpEditor editor = McpEditor(widget.service, widget.channel);
  final TextEditingController _endpoint = TextEditingController();
  final TextEditingController _token = TextEditingController();
  final TextEditingController _name = TextEditingController();
  Future<List<Map<String, Object?>>>? _history;
  bool _leaving = false;
  @override
  void initState() {
    super.initState();
    widget.service.addListener(_refreshHistory);
    editor.load().then((_) {
      if (!mounted) return;
      _endpoint.text = editor.endpoint; _token.text = editor.token; _name.text = editor.name;
      _refreshHistory(); setState(() {});
    });
    _refreshHistory();
  }
  void _refreshHistory() {
    final String? id = editor.channel?.id;
    if (mounted) setState(() { _history = id == null ? null : widget.service.store!.submissions(id); });
  }
  @override
  void dispose() {
    widget.service.removeListener(_refreshHistory);
    editor.dispose(); _endpoint.dispose(); _token.dispose(); _name.dispose(); super.dispose();
  }
  McpChannel? get current {
    final List<McpChannel> matches = widget.service.channels.where((McpChannel c) => c.id == editor.channel?.id).toList();
    return matches.isEmpty ? null : matches.single;
  }
  Future<void> _leave() async {
    await editor.flush();
    if (!mounted) return;
    if (editor.error != null) {
      // Invalid input was never applied. Do not silently discard it on Back.
      final AppStrings s = AppStrings.of(widget.settings.locale);
      if (!await mcpConfirm(context, s, s.mcp(McpText.discardInvalid), s.discardUnsentAction)) return;
      if (!mounted) return;
    }
    setState(() => _leaving = true);
    WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted) Navigator.of(context).pop(); });
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge(<Listenable>[editor, widget.service, widget.settings]),
    builder: (BuildContext context, _) {
      final AppStrings s = AppStrings.of(widget.settings.locale);
      final McpChannel? channel = current;
      return PopScope(canPop: _leaving,
        onPopInvokedWithResult: (bool didPop, Object? _) { if (!didPop) _leave(); },
        child: Scaffold(appBar: AppBar(title: Text(s.mcp(McpText.title)),
          leading: BackButton(onPressed: _leave)),
          body: !editor.loaded ? const Center(child: CircularProgressIndicator()) : FutureBuilder<List<Map<String, Object?>>>(
            future: _history,
            builder: (BuildContext context, AsyncSnapshot<List<Map<String, Object?>>> snapshot) => ListView.builder(
              padding: const EdgeInsets.all(16), itemCount: 1 + (channel == null ? 0 : snapshot.data?.length ?? 0),
              itemBuilder: (BuildContext context, int index) {
                if (index > 0) {
                  return McpHistoryRow(key: ValueKey<String>('mcp.job.${snapshot.data![index - 1]['entry_id']}'),
                  service: widget.service, channel: channel!, job: snapshot.data![index - 1], strings: s);
                }
                return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: <Widget>[
                  if (!widget.service.available || snapshot.hasError) Text(s.mcp(McpText.storageUnavailable)),
                  if (channel != null) Text(s.mcp(channelText(channel.state))),
                  if (editor.restored) Text(s.mcp(McpText.restoreNeedsCredential)),
                  TextField(controller: _name, maxLength: 128, decoration: InputDecoration(labelText: s.renameAliasTitle),
                    onChanged: (String value) { editor.name = value; editor.changed(); }),
                  TextField(key: const ValueKey<String>('mcp.endpoint'), controller: _endpoint,
                    obscureText: true, enableSuggestions: false, autocorrect: false, keyboardType: TextInputType.url,
                    decoration: InputDecoration(labelText: s.mcp(McpText.endpoint)),
                    onChanged: (String value) { editor.endpoint = value; editor.changed(); }),
                  DropdownButtonFormField<bool>(key: const ValueKey<String>('mcp.auth'), initialValue: editor.bearer,
                    isExpanded: true, items: <DropdownMenuItem<bool>>[
                      DropdownMenuItem<bool>(value: false, child: Text(s.mcp(McpText.authNone))),
                      DropdownMenuItem<bool>(value: true, child: Text(s.mcp(McpText.authBearer))),
                    ], onChanged: (bool? value) { editor.bearer = value ?? false; editor.changed(); }),
                  if (editor.bearer) TextField(key: const ValueKey<String>('mcp.token'), controller: _token,
                    obscureText: true, enableSuggestions: false, autocorrect: false,
                    decoration: InputDecoration(labelText: s.mcp(McpText.credential)),
                    onChanged: (String value) { editor.token = value; editor.changed(); }),
                  if (editor.error != null) Text(mcpError(s, editor.error!, field: editor.errorField), key: const ValueKey<String>('mcp.error')),
                  if (editor.tested != null) Text(mcpReplyLabel(s, editor.tested!), key: const ValueKey<String>('mcp.test-result')),
                  if (editor.tools.isEmpty && editor.tested?.succeeded == true) Text(s.mcp(McpText.noTools)),
                  TextButton(key: const ValueKey<String>('mcp.test'), onPressed: editor.busy || !widget.service.available ? null : editor.discover,
                    child: Text(s.mcp(McpText.test))),
                  if (editor.busy) const LinearProgressIndicator(),
                  if (editor.tools.isNotEmpty) ...<Widget>[
                    Text(s.mcp(McpText.chooseTool), key: const ValueKey<String>('mcp.tool-heading')),
                    DropdownButtonFormField<String>(
                    key: ValueKey<String>('mcp.tool.${editor.tools.map((Map<String, Object?> t) => t['name']).join('|')}'),
                    initialValue: editor.tools.any((Map<String, Object?> t) => t['name'] == editor.tool) ? editor.tool : null,
                    isExpanded: true,
                    items: <DropdownMenuItem<String>>[for (final Map<String, Object?> t in editor.tools)
                      DropdownMenuItem<String>(value: t['name']! as String, child: Text(t['name']! as String))],
                    onChanged: (String? name) { if (name != null) editor.selectTool(editor.tools.firstWhere((Map<String, Object?> t) => t['name'] == name)); }),
                    Text(s.mcp(McpText.chooseToolHint), key: const ValueKey<String>('mcp.tool-hint')),
                  ],
                  if (editor.tool.isNotEmpty) ...<Widget>[
                    Text(editor.tool), Text(s.mcp(McpText.mapping)), ..._fields(s),
                  ],
                  if (channel != null) ...<Widget>[
                    if (channel.expiredCount > 0) Text(s.mcp(McpText.expired, count: channel.expiredCount)),
                    if (channel.canSend) TextButton(onPressed: () => mcpAction(context, s, () => widget.service.pause(channel.id)), child: Text(s.mcp(McpText.pause)))
                    else FilledButton(key: const ValueKey<String>('mcp.enable'),
                      onPressed: editor.busy || editor.dirty || channel.testedGeneration != channel.generation || !widget.service.available ? null : () async {
                        if (!await mcpConfirm(context, s, s.mcp(McpText.enableDisclosure, host: channel.hostHint, tool: channel.tool), s.mcp(McpText.enable))) return;
                        if (current?.generation != channel.generation) {
                          if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(s.mcp(McpText.testFailed))));
                          return;
                        }
                        if (context.mounted) await mcpAction(context, s, () => widget.service.enable(channel.id));
                      }, child: Text(s.mcp(McpText.enable))),
                  ],
                ]);
              },
            ),
          ),
        ));
    },
  );

  List<Widget> _fields(AppStrings s) {
    try {
      final McpMapping mapping = McpMapping(editor.schema, const <String, Object?>{}, requireComplete: false);
      return <Widget>[for (final McpField field in mapping.fields)
        if (!editor.bindings.keys.any((String parent) => field.path.startsWith('$parent/'))) McpFieldEditor(
        key: ValueKey<String>('${editor.tool}.${field.path}'), editor: editor, field: field, strings: s)];
    } on Object { return <Widget>[Text(s.mcp(McpText.schemaUnsupported))]; }
  }
}
