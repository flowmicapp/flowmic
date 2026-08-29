// Test doubles for the three platform seams of the browser sign-in round trip
// (lib/src/auth/deep_link_source.dart). Every test of that flow drives these —
// no test in this repo touches app_links, url_launcher or SharedPreferences for
// it, which is the whole reason the seams exist.

import 'dart:async';

import 'package:flowmic/src/auth/deep_link_source.dart';

/// A link source a test drives by hand: [push] delivers a warm callback,
/// [initial] is what a cold start was launched with.
class FakeBrowserLoginLinks implements BrowserLoginLinks {
  FakeBrowserLoginLinks({this.initial});

  final StreamController<Uri> _ctl = StreamController<Uri>.broadcast(sync: true);

  /// The URL this "process" was launched with, or null.
  Uri? initial;

  /// How many times [initialLink] was asked. Pins the de-duplication.
  int initialReads = 0;

  @override
  Stream<Uri> get stream => _ctl.stream;

  @override
  Future<Uri?> initialLink() async {
    initialReads++;
    return initial;
  }

  /// Deliver a callback to a running app.
  void push(Uri link) => _ctl.add(link);

  Future<void> close() => _ctl.close();
}

/// An opener that records what it was asked to open and answers what the test
/// told it to. [succeeds] false is 「the OS would not open a browser」 — the
/// BROWSER_LOGIN_OPEN_FAILED branch.
class FakeBrowserOpener {
  FakeBrowserOpener({this.succeeds = true});

  bool succeeds;
  final List<Uri> opened = <Uri>[];

  Future<bool> call(Uri url) async {
    opened.add(url);
    return succeeds;
  }
}
