// App-root dependency, shared by settings and the existing record menu. Missing
// wiring throws rather than rendering an optional feature backed by nothing.
import 'package:flutter/widgets.dart';

import '../settings/app_settings.dart';
import 'mcp_service.dart';

class McpScope extends InheritedWidget {
  const McpScope({super.key, required this.service, required this.settings, required super.child});
  final McpService service;
  final AppSettingsController settings;
  static McpScope of(BuildContext context) {
    final McpScope? value = context.dependOnInheritedWidgetOfExactType<McpScope>();
    if (value == null) throw StateError('McpScope is required at the application root');
    return value;
  }
  @override
  bool updateShouldNotify(McpScope oldWidget) => service != oldWidget.service || settings != oldWidget.settings;
}
