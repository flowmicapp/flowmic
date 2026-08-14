package app.flowmic.android

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    // owner 2026-07-27 image copy: the one native channel this app owns. Everything
    // else goes through a pub plugin; putting an IMAGE on the clipboard has no
    // Flutter API at all, so it gets 80 lines of Kotlin instead of a dependency.
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, ImageClipboard.CHANNEL)
            .setMethodCallHandler { call, result ->
                ImageClipboard.handle(applicationContext, call, result)
            }
        // owner 2026-07-27 phone naming: Build.MODEL + ANDROID_ID. Also no plugin —
        // Dart owns every naming rule, this just reads three fields.
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, DeviceInfo.CHANNEL)
            .setMethodCallHandler { call, result ->
                DeviceInfo.handle(applicationContext, call, result)
            }
        // Card UP-2b in-app update: handing a verified .apk to the system package
        // installer needs a FileProvider URI + ACTION_VIEW, neither of which
        // Flutter exposes. Same shape as the two above — Dart owns every
        // decision (what to download, whether the hash matched); this only
        // performs the hand-off and names what the OS said.
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, UpdateInstaller.CHANNEL)
            .setMethodCallHandler { call, result ->
                UpdateInstaller.handle(applicationContext, call, result)
            }
    }
}
