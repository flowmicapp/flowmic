// verify/lint/flutter-template-icons.mjs
// No Flutter-template icon or launch asset may survive in the mobile app.
//
// -- WHAT THIS DEFENDS AGAINST -----------------------------------------------
// `flutter create` seeds every icon and launch slot with Flutter's own artwork.
// Replacing the home-screen icon is the visible half of rebranding; the launch
// slot is the invisible half, and nothing in any build, analyzer or test run
// looks at either. A leftover there is not cosmetic: on iOS the launch screen
// is what the OS snapshots for the app-switcher card and for the
// shrink-to-home / minimise transition, and on Android the same role belongs to
// the launcher icon plus `launch_background`. So the product can carry a
// correct home-screen icon and still flash a foreign mark every time the user
// puts it away -- which is what the owner reported from an iPad on 2026-09-04
// ("when I minimise the app the transition shows the FLUTTER icon").
//
// Measured on that report: apps/mobile carried three byte-identical copies of
// the template LaunchImage placeholder plus the template README.md.
//
// -- HOW IT JUDGES -----------------------------------------------------------
// Byte identity against an embedded sha256 table, not resemblance. Resemblance
// is not decidable here and pretending otherwise would make the gate lie about
// its own reach. A hand-redrawn Flutter logo passes this gate; that is stated
// out loud so nobody reads "green" as "no Flutter artwork anywhere".
//
// The table came from Flutter 3.41.8 (stable, framework 02085feb3f5d) -- i.e.
// `flutter_tools/templates/**` plus the `flutter_template_images` 5.0.0 package
// whose bytes fill in the zero-byte `.img.tmpl` placeholders. It is EMBEDDED on
// purpose: the gate must return the same verdict on a machine with no Flutter
// SDK (CI, a release runner) as on a dev box, and must not silently re-baseline
// itself against whatever SDK happens to be installed. Adding a newer SDK's
// hashes is an append, never a replace: an asset seeded by an older SDK is
// still a leftover today.
//
// -- WHAT IT CANNOT SEE (stated, not implied) --------------------------------
// * Re-encoded or resized template artwork (different bytes, same picture).
// * Anything outside apps/mobile/{ios,android,macos} -- the desktop Tauri icons
//   have their own source of truth and never passed through `flutter create`.
// * Whether the replacement artwork is CORRECT. It only proves it is not the
//   template's. The one judge for "does it look right" is a human eye on a
//   device, and this gate does not stand in for that.

import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';

import { ROOT, walk, rel, exists } from './_util.mjs';
import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

// `node verify/lint/flutter-template-icons.mjs` would evaluate this module and
// exit 0 without checking anything -- a silence indistinguishable from a pass.
refuseDirectRun(import.meta.url, 'pnpm verify:lint');

export const name = 'flutter-template-icons';

// sha256 -> the template path the bytes came from. Flutter 3.41.8 stable
// (framework 02085feb3f5d8a8156e5e28512b9d99351d510c0) plus
// flutter_template_images 5.0.0. Hashed 2026-09-04 on dev-pc-a.
const TEMPLATE_ASSETS = new Map([
  ['0a91c6c1bf242e54ee179e34629e9ef3e8a6d286c0fce01e302280a8be9277e6', 'template_images/app/macos.tmpl/.../app_icon_512.png'],
  ['15591f03f31313af6fd644ed0512106cc04365130b8b73244f1cfa6dddfb4400', 'template_images/app/macos.tmpl/.../app_icon_128.png'],
  ['19be171481dc71a0b2803ebcd01dd8b0c5fd5778dee34c0a3cabc948c225f24e', 'template_images/app/ios.tmpl/.../Icon-App-40x40@3x.png'],
  ['23c13d463f5dca5c1f14a14934003601c29f1218fd461016d8a22cef579a665f', 'flutter_tools/module/ios/.../Icon-App-76x76@1x.png'],
  ['285442f69a06b45d9d79df80321815b546473548a37b78819b68959c7b8ed237', 'flutter_tools/module/ios/.../Icon-App-29x29@1x.png'],
  ['2ab64af8ac727ea99c6ab9eaff847f46fbf2a9a0a78a0abcbf3180f3851645b4', 'flutter_tools/module/ios/.../Icon-App-29x29@2x.png'],
  ['3c34e1f298d0c9ea3455d46db6b7759c8211a49e9ec6e44b635fc5c87dfb4180', 'flutter_tools/app/android.tmpl/.../mipmap-xxxhdpi/ic_launcher.png'],
  ['3db08cb79e7b01b9e81f956e3a0ae10148d0fafde3ea7aa70048df905aa52cfd', 'flutter_tools/module/ios/.../Icon-App-60x60@3x.png'],
  ['416efd77cde932d42ef34168da24dd428a495b1f4f34bbbd125a18d2add186a2', 'template_images/app/macos.tmpl/.../app_icon_256.png'],
  ['41c7d42f6e61f8fe7f30b1ffa2256aecbc9682be06d18c4a3062043e1a2e547c', 'template_images/app/ios.tmpl/.../Icon-App-76x76@2x.png'],
  ['4209a49e44a92ec40a327d3455eb1b1c153ee83d75de1c2be0a12ab18b2ff9de', 'template_images/app/ios.tmpl/.../Icon-App-60x60@3x.png'],
  ['4d470bf22d5c17d84edc5f82516d1ba8a1c09559cd761cefb792f86d9f52b540', 'flutter_tools/app/android.tmpl/.../mipmap-xxhdpi/ic_launcher.png'],
  ['5925dab509451f9ecbb12ce8a625f9d4c104718ee20caff8b1b51032d1cd8946', 'flutter_tools/module/ios/.../Icon-App-20x20@1x.png'],
  ['5d7e5bdf01b93802bc973345b3a78c038907147625035952a08a115a563b7f81', 'template_images/app/ios.tmpl/.../Icon-App-83.5x83.5@2x.png'],
  ['5dee24dc104ac76dc162e42ae0beb163d426bf365562ee28ba7b3ad368559a60', 'template_images/app/ios.tmpl/.../Icon-App-29x29@1x.png'],
  ['6232e5815af17e25e0268b2fec7aea9e068cc92ec709e9605c2b31df4ff2a313', 'template_images/app/macos.tmpl/.../app_icon_1024.png'],
  ['6a7c8f0d703e3682108f9662f813302236240d3f8f638bb391e32bfb96055fef', 'flutter_tools/app/android.tmpl/.../mipmap-hdpi/ic_launcher.png'],
  ['6ad229623498e5f1277800db3ab7cb11faf85eb2569e1213f7d8e55003c07b42', 'template_images/app/macos.tmpl/.../app_icon_64.png'],
  ['6aee06cdcab6b2aef74b1734c4778f4421d2da100b0ff9e52b21b55240202929', 'template_images/app/web/icons/Icon-maskable-512.png'],
  ['6db7726530d71d3f52cb59793eb691313baa04796e129e1e043c0a58a1bffd2f', 'flutter_tools/module/ios/.../Icon-App-76x76@2x.png'],
  ['7770183009e914112de7d8ef1d235a6a30c5834424858e0d2f8253f6b8d31926', 'template_images/app/ios.tmpl/.../Icon-App-1024x1024@1x.png'],
  ['7c61c42fc7b657d9cf314d32a4ec458f0647c3aaf360be1b9377857266ec2499', 'template_images/app/ios.tmpl/.../Icon-App-40x40@2x.png'],
  ['809abfe75c440770c13c4e2e46d09603c22053e9d4e0e2275dcb9c1dcfbb2c75', 'flutter_tools/module/ios/.../Icon-App-40x40@3x.png'],
  ['836c918cb613249eba0483a6b02fa3df3c1c0a89a315ee4d3b88509b83c7ab73', 'template_images/app/ios.tmpl/.../Icon-App-76x76@1x.png'],
  ['853ac958e2416fe2540f6f61165283a3618b71a7ba5f85f65ac41c2158dfcd21', 'flutter_tools/app/ios.tmpl/.../LaunchImage.imageset/README.md'],
  ['93ae7d494fad0fb30cbf3ae746a39c4bc7a0f8bbf87fbb587a3f3c01f3c5ce20', 'template_images/app/ios.tmpl/.../LaunchImage.imageset/LaunchImage.png'],
  ['9dca09f4e5ed5684d3c4dff41f4e8b7cb864b438172d72be069315fa362930f9', 'flutter_tools/module/ios/.../Icon-App-29x29@3x.png'],
  ['a9b21eb6f4271385655a8771f76e29eef8c1107d7879cbcfc567e6619d1f716a', 'template_images/app/ios.tmpl/.../Icon-App-29x29@2x.png'],
  ['ae8c4458e41f1e28b1e851ed87d3268d4a0351ceea427fa2a84cc94ddfb6d4c5', 'template_images/app/macos.tmpl/.../app_icon_32.png'],
  ['b9ad02cf6576a04d1b6806ac02a2431481b448dd0c2e505ce25842d1f7c4730b', 'template_images/app/ios.tmpl/.../Icon-App-20x20@2x.png'],
  ['bf97f9d3233f33e1389b09f7b8add53741300cb834d6c7a5ca32cbed363a4fb2', 'flutter_tools/module/ios/.../Icon-App-20x20@3x.png'],
  ['c4d9a284c12301d0f50e248ec53ed51a19a10147b774b23308399250b0d44c55', 'flutter_tools/module/ios/.../Icon-App-20x20@2x.png'],
  ['c6e6d3b215ae744a9c391f4c4d44157eff5e739d6ad6c39f9bfa5df66dddd267', 'template_images/app/ios.tmpl/.../Icon-App-20x20@3x.png'],
  ['c7c0c0189145e4e32a401c61c9bdc615754b0264e7afae24e834bb81049eaf81', 'flutter_tools/app/android.tmpl/.../mipmap-mdpi/ic_launcher.png'],
  ['cab10a0d391ec5bc09ef50ce49e8ad401cee7ef03707ec0923a222c5c2b3d212', 'template_images/app/ios.tmpl/.../Icon-App-20x20@1x.png'],
  ['cc6928b5adfc00dbf526192e2705dd9af641cdf20ab4c6c7ca7cd4936dca59f0', 'template_images/app/macos.tmpl/.../app_icon_16.png'],
  ['cee565f5e62116569b64980b209fd5ca4b3d3739011f5343250b33a1a2c6eb65', 'flutter_tools/module/ios/.../Icon-App-83.5x83.5@2x.png'],
  ['d2c842e22a9f4ec9d996b23373a905c88d9a203b220c5c151885ad621f974b5c', 'template_images/app/web/icons/Icon-maskable-192.png'],
  ['d5ad04de321ef37cacc5a7b960afcce71bdcb96fa020c48249c1545dd1a0f497', 'flutter_tools/module/ios/.../Icon-App-40x40@2x.png'],
  ['e14aa40904929bf313fded22cf7e7ffcbf1d1aac4263b5ef1be8bfce650397aa', 'flutter_tools/app/android.tmpl/.../mipmap-xhdpi/ic_launcher.png'],
  ['e677d701ffe4af7bc2935098d6b3984cc9ab7ace573e6900955a5535b12410cf', 'template_images/app/ios.tmpl/.../Icon-App-29x29@3x.png'],
]);

// Native platform directories flutter create seeds. macos is listed although
// apps/mobile has no macos/ today: `flutter create --platforms=macos` later
// would seed it, and a gate that only knows the directories that already exist
// is a gate that goes quiet exactly when the risk comes back.
const PLATFORM_DIRS = ['ios', 'android', 'macos'];

// Below this the walk found so few images that "no leftovers" is far more
// likely to mean "the scan went blind" (moved directory, changed layout) than
// "the app is clean". Android alone ships 15 mipmap PNGs and iOS 15 app icons,
// so 20 is a floor, not a target.
const MIN_IMAGES_SCANNED = 20;

const LAUNCH_README = path.join(
  'ios',
  'Runner',
  'Assets.xcassets',
  'LaunchImage.imageset',
  'README.md'
);

async function sha256(abs) {
  return createHash('sha256').update(await fsp.readFile(abs)).digest('hex');
}

/**
 * @param {string} root repo root; the drill points it at a fixture instead.
 */
export default async function run(root = ROOT) {
  const mobile = path.join(root, 'apps', 'mobile');
  const failures = [];
  let scanned = 0;

  for (const platform of PLATFORM_DIRS) {
    const dir = path.join(mobile, platform);
    if (!(await exists(dir))) continue;
    for (const abs of await walk(dir)) {
      if (!/\.png$/i.test(abs)) continue;
      scanned += 1;
      const hash = await sha256(abs);
      const origin = TEMPLATE_ASSETS.get(hash);
      if (origin) {
        failures.push(
          `${rel(abs)} is byte-identical to the Flutter template asset ${origin} ` +
            `(sha256 ${hash.slice(0, 16)}) -- the OS uses these slots for the ` +
            `app-switcher snapshot and the minimise animation, so a leftover here shows ` +
            `Flutter's mark to the user while the home-screen icon looks right. ` +
            `Regenerate it from the FlowMic brand sources`
        );
      }
    }
  }

  // Control assertion. Zero images means the walk stopped seeing this tree, not
  // that the tree became clean -- and those two states must never share a
  // verdict (UP-7: a scanner reporting clean while it is blind).
  if (scanned < MIN_IMAGES_SCANNED) {
    return {
      status: 'FAIL',
      detail:
        `scanned only ${scanned} PNG(s) under apps/mobile/{${PLATFORM_DIRS.join(',')}} ` +
        `(expected at least ${MIN_IMAGES_SCANNED}) -- the scan is blind, which is not ` +
        `the same as clean`,
    };
  }

  // The template README ships inside LaunchImage.imageset and tells the reader
  // how to replace the placeholders. Its presence is the cheapest possible
  // proof that nobody ever did -- and unlike the PNGs it survives any
  // re-encoding, so it is checked by path, not by hash.
  const readme = path.join(mobile, LAUNCH_README);
  if (await exists(readme)) {
    failures.push(
      `${rel(readme)} still exists -- that file only ever comes from ` +
        `flutter create; its presence means the LaunchImage placeholders were never ` +
        `replaced with brand artwork. Delete it once they are`
    );
  }

  if (failures.length > 0) {
    return { status: 'FAIL', detail: failures.join('; ') };
  }
  return {
    status: 'PASS',
    detail:
      `${scanned} mobile icon/launch PNG(s), none byte-identical to the ` +
      `${TEMPLATE_ASSETS.size} known Flutter 3.41.8 template assets; ` +
      `no template LaunchImage README`,
  };
}
