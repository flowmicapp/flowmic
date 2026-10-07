# flowmic

Use Flutter **3.44.0** for local verification, CI, and release builds. Put the
selected SDK's `bin` directory first on the current shell's `PATH`, then run
`flutter pub get` in this directory. Shared SDK upgrades are scheduled by MAIN.

iOS keeps its existing CocoaPods integration through the project-local
`flutter.config.enable-swift-package-manager: false` setting in `pubspec.yaml`.
`record_darwin` and `flutter_secure_storage` do not yet support Swift Package
Manager; switching their integration is a separate migration.

FlowMic mobile — speak on your phone, type on your PC.

## Getting Started

This project is a starting point for a Flutter application.

A few resources to get you started if this is your first Flutter project:

- [Learn Flutter](https://docs.flutter.dev/get-started/learn-flutter)
- [Write your first Flutter app](https://docs.flutter.dev/get-started/codelab)
- [Flutter learning resources](https://docs.flutter.dev/reference/learning-resources)

For help getting started with Flutter development, view the
[online documentation](https://docs.flutter.dev/), which offers tutorials,
samples, guidance on mobile development, and a full API reference.
