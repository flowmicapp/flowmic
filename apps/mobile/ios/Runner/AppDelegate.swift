import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    // 0.3.28 — the device-identity channel (`DeviceInfo.swift`). Registered
    // here, beside the generated plugins, because this is the one place that
    // runs before Dart's `deviceLabel()` warms its cache at app start.
    //
    // 🔴 The registrar is asked for a messenger rather than reaching for
    // `window?.rootViewController as? FlutterViewController`: this target uses
    // a `SceneDelegate`, so the root view controller is owned by a scene and is
    // not there yet at this point. Going through the plugin registry is the
    // path that does not depend on when the UI exists.
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "FlowMicDeviceInfo") {
      DeviceInfo.register(messenger: registrar.messenger())
    }
    // Card CR-2 — the screen-wake channel (`ScreenWake.swift`), registered the
    // same way and for the same reason: this target uses a SceneDelegate, so
    // there is no root view controller to reach for at this point. Its Android
    // twin needs the Activity for a window flag; here the API is on
    // UIApplication, so a messenger is all it takes.
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "FlowMicScreenWake") {
      ScreenWake.register(messenger: registrar.messenger())
    }
  }
}
