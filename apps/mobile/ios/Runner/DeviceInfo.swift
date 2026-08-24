import Flutter
import Foundation
import Security
import UIKit

/// The iOS half of the device-identity channel — the mirror of
/// `android/app/src/main/kotlin/app/flowmic/android/DeviceInfo.kt`, and until
/// 0.3.28 **it did not exist at all**.
///
/// owner 2026-08-23: 「iOS/Mac 上要能检测到当前操作系统的类型，在命名时如果获取不到
/// 机器标识或 ID 以机器系统类型来命名」 ("on iOS/Mac we must be able to detect the
/// current OS type, and when no machine identifier or ID can be obtained, name
/// it by the machine's system type").
///
/// ── WHAT ITS ABSENCE COST, MEASURED ─────────────────────────────────────────
///
/// `MethodChannelDeviceInfo.read()` catches the missing channel and answers an
/// all-null `DeviceIdentity` — a deliberate, correct degradation that has been
/// quietly firing on every iPhone since the iOS target existed. Downstream that
/// is not one missing feature, it is three:
///
///   1. `buildDeviceLabel` returns the bare `Phone`, so the SERVER mints
///      `Phone-<4>` — and those 4 hex come from the PAIRING uuid, so **the same
///      handset gets a different name every time it re-pairs**. That is the
///      exact defect `device_label.dart`'s header records as fixed for Android
///      in 0.1.10; it was never fixed here because here there was nothing to
///      fix it in.
///   2. `deviceUid(nil)` is null, so `mobile_device_uid` never goes on the
///      wire, so the server falls back to matching phones **by name** — and by
///      (1) the name is the one value that is not stable. ⇒ the LAN pairing and
///      the cloud pairing of one iPhone can never be recognised as one phone.
///   3. An iPhone and an iPad in the same list are both `Phone-xxxx`.
///
/// ── WHAT THIS FILE DOES NOT DO ──────────────────────────────────────────────
///
/// It returns the raw parts and nothing else. Every naming decision (brand
/// de-duplication, cleaning, capping, hashing) stays in Dart's
/// `device_label.dart` so the rules are unit-tested without a handset. Same
/// division as the Kotlin file, deliberately.
enum DeviceInfo {
  /// Must match `MethodChannelDeviceInfo.channel` on the Dart side.
  ///
  /// 🔴 P0-PKG: the namespace is owned by `scripts/package-ids.mjs`
  /// (`METHOD_CHANNEL_NAMESPACE`). Swift cannot import it, so
  /// `verify/lint/package-id-family.mjs` reads this literal and compares — the
  /// same treatment the Kotlin side gets, added in the same round as this file.
  static let CHANNEL = "app.flowmic/device_info"

  static func register(messenger: FlutterBinaryMessenger) {
    // Owner 2026-08-24: the seed must not outlive a deletion. Anything the
    // 0.3.28 build put in the Keychain would, so it is taken out here — at
    // app start, unconditionally, before anything can read a seed.
    reapLegacyKeychainSeed()
    let channel = FlutterMethodChannel(name: CHANNEL, binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      guard call.method == "identity" else {
        result(FlutterMethodNotImplemented)
        return
      }
      result([
        // 🔴 nil, not "Apple". `cleanModel` prepends the brand only when the
        // model does not already carry it, and its own comment gives the
        // reason: 「Xiaomi Xiaomi 13」 is just wrong. EVERY Apple hardware
        // identifier already begins with the product line (`iPhone14,5`,
        // `iPad13,4`), and so does the `UIDevice.model` fallback below, so a
        // brand here would produce 「Apple iPhone14,5」 — the same redundancy
        // that rule exists to prevent. Passing "Apple" is a one-line change if
        // that is ever wanted; it is a naming preference, not a correctness
        // question.
        "manufacturer": nil as String?,
        "model": hardwareModel(),
        "seed": stableSeed(),
      ])
    }
  }

  // ── model ──────────────────────────────────────────────────────────────────

  /// `iPhone14,5` / `iPad13,4` — Apple's own hardware identifier.
  ///
  /// 🔴 DELIBERATELY NOT MAPPED TO A MARKETING NAME (`iPhone14,5` →
  /// 「iPhone 13」). Such a table expires every time Apple ships a model, and it
  /// expires SILENTLY: the new handset falls out of the table and the user gets
  /// a worse name, with no layer reporting anything. `iPhone14,5` is ugly and
  /// permanently true, and it still tells two different iPhone generations
  /// apart, which is the whole job.
  ///
  /// ⚠️ `UIDevice.current.name` is NOT used and must not be: since iOS 16 it
  /// returns the model name rather than the user's chosen device name unless
  /// the app holds `com.apple.developer.device-information.user-assigned-device-name`.
  /// Reading it would hand us a string that LOOKS like the user's own name for
  /// their phone and is not — the most expensive kind of wrong value.
  private static func hardwareModel() -> String? {
    var info = utsname()
    uname(&info)
    // ⚠️ `withUnsafeBytes(of:)` over a COPY, not `withUnsafePointer(to: &…)`
    // with `MemoryLayout.size(ofValue: info.machine)` read inside the closure:
    // that shape reads `info.machine` while it is already exclusively borrowed
    // and Swift refuses it — "overlapping accesses to 'info.machine', but
    // modification requires exclusive access" [measured: that exact error, on
    // the Mac mini, Xcode 26.6, on the first version of this file].
    // `machine` is a fixed-size C tuple, so the bytes run to the first NUL.
    let raw = withUnsafeBytes(of: info.machine) { buf -> String in
      String(decoding: buf.prefix(while: { $0 != 0 }), as: UTF8.self)
    }
    let machine = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    // A simulator answers the host architecture (`arm64` / `x86_64`), which
    // names no device at all. Anything that does not start with a known Apple
    // product line falls through to `UIDevice.model`, which answers the DEVICE
    // CLASS (`iPhone` / `iPad`) — worse resolution, still a true sentence, and
    // still enough to keep an iPad from looking like an iPhone.
    let productLines = ["iPhone", "iPad", "iPod", "Watch", "Mac", "RealityDevice"]
    if !machine.isEmpty && productLines.contains(where: { machine.hasPrefix($0) }) {
      return machine
    }
    let deviceClass = UIDevice.current.model.trimmingCharacters(in: .whitespacesAndNewlines)
    return deviceClass.isEmpty ? nil : deviceClass
  }

  // ── seed ───────────────────────────────────────────────────────────────────

  /// The UserDefaults key the minted seed lives under.
  ///
  /// 🔴 UserDefaults, NOT the Keychain — owner 2026-08-24: 「改成卸载即清」
  /// ("change it so uninstalling clears it"). The app container, and therefore
  /// this value, is destroyed by the OS when the app is deleted. That is the
  /// whole point, and it is the reason the Keychain rung that shipped in 0.3.28
  /// is gone rather than merely defended.
  private static let seedDefaultsKey = "app.flowmic.ios.device-seed-v1"

  /// The 0.3.28 Keychain slot, kept ONLY so it can be deleted. See `reapLegacyKeychainSeed`.
  private static let legacyKeychainService = "app.flowmic.ios.device-seed"
  private static let legacyKeychainAccount = "device-seed-v1"

  /// 🔴 **THE HONEST NAME FOR WHAT WE DELIVER IS 「a reinstall does not inherit
  /// the old identity」, NOT 「uninstalling clears it」.**
  ///
  /// iOS hands no app a hook that runs at deletion time — nothing of ours
  /// executes, so nothing of ours can erase anything at that moment. What is
  /// actually true is stronger than a promise and weaker than the words: the
  /// SYSTEM destroys the app container on delete, so the value is gone without
  /// us doing anything, and a reinstall starts from nothing. R11 applies to a
  /// sentence in a source comment exactly as it applies to one on screen: it
  /// has to be able to answer 「凭什么这么说」 ("on what evidence").
  ///
  /// Ladder, and each rung exists because the one above it genuinely fails:
  ///   ① `identifierForVendor` — the documented answer and the right first
  ///      choice. It is **nil** when the app runs in the background before the
  ///      device's first unlock after a restart, and it is reset when the last
  ///      app from this vendor is deleted.
  ///   ② a UUID minted once into UserDefaults.
  ///   ③ nil.
  ///
  /// ⚠️ **WHAT RUNG ② IS WORTH NOW, STATED HONESTLY.** In 0.3.28 it was a
  /// Keychain item and its justification was, verbatim, 「Keychain items survive
  /// app deletion, which is what makes this rung stronger than ① rather than
  /// merely a copy of it」. That sentence was true, and owner has now ruled the
  /// property it described out of the product — so the justification is gone
  /// with it, and this rung is NOT as strong as the one it replaces. It still
  /// earns its place: `identifierForVendor` is documented as possibly nil, and
  /// ② keeps one launch's answer from differing from the next's. It does NOT
  /// survive deletion, and no comment here will claim it does.
  ///
  /// 🔴 ③ RETURNS NIL AND MUST NOT RETURN A CONSTANT. `device_label.dart`
  /// spells out why: a fixed fallback would be identical on every device that
  /// also reported nothing, and the server would merge strangers into one row.
  private static func stableSeed() -> String? {
    if let idfv = UIDevice.current.identifierForVendor?.uuidString, !idfv.isEmpty {
      return idfv
    }
    let defaults = UserDefaults.standard
    if let existing = defaults.string(forKey: seedDefaultsKey), !existing.isEmpty {
      return existing
    }
    let minted = UUID().uuidString
    defaults.set(minted, forKey: seedDefaultsKey)
    return minted
  }

  /// Deletes the Keychain item 0.3.28 would have minted.
  ///
  /// 🔴 **STOPPING is not the same as CLEARING.** Removing the Keychain code
  /// would leave every device that had already minted one holding it forever —
  /// a Keychain item outlives the app that wrote it, which is precisely why it
  /// was chosen and precisely why it now has to be taken back out by hand.
  ///
  /// ⚠️ [measured 2026-08-24] the population this reaps is expected to be
  /// **empty**: 0.3.28 built artifacts for nothing and was never installed on
  /// any device, so no copy of that code has ever run. This is written for the
  /// case where that expectation is wrong — a developer build, a simulator, a
  /// device someone sideloaded — because the cost of being wrong in the other
  /// direction is an identity that outlives the deletion owner asked to make
  /// final.
  ///
  /// `errSecItemNotFound` is the expected answer and is not a failure. It is
  /// called once per process from `register`, needs no state of its own, and is
  /// idempotent — a stored 「already reaped」 flag would be one more thing that
  /// can be wrong, and would itself survive into the next install.
  private static func reapLegacyKeychainSeed() {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: legacyKeychainService,
      kSecAttrAccount as String: legacyKeychainAccount,
    ]
    SecItemDelete(query as CFDictionary)
  }
}
