// owner 2026-07-30 ② the devices page becomes an information panel — the source-literal guard.
//
// Why literals rather than a render: DevicesPage.vue's channel cards are driven by
// `onMounted` (pairing snapshot + cloud status + sidecar state over the Tauri bridge),
// and SSR does not run `onMounted` — a rendered tree would only ever show the empty
// pre-fetch state, which proves nothing about the panel. The DECISIONS are covered
// where they live (lib/channel.test.ts for the two cards, lib/pairing-bridge.test.ts
// for the addresses actually arriving), so what is left to pin is that the page no
// longer offers the deleted SETTING and really iterates every address. Same culture as
// mode-badge.test.ts / prefs-appearance.test.ts's anchor blocks.
//
// These assertions are deliberately negative-heavy: this card's work was mostly a
// DELETION, and a deletion is the one kind of change a positive test cannot notice.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { S } from '../lib/strings';

const SRC = readFileSync(fileURLToPath(new URL('./DevicesPage.vue', import.meta.url)), 'utf8');

/** The `<style scoped src="./devices-page.css">` sibling — split out of
 *  DevicesPage.vue when card F5+U11 (the LAN card firewall-honesty line) pushed
 *  that file past the 800-line cap (a pure move, same precedent as
 *  components/PairingModal.vue). The assertions below that pin CSS RULE bodies
 *  read this file now; SRC no longer contains a <style> block at all. */
const CSS = readFileSync(fileURLToPath(new URL('./devices-page.css', import.meta.url)), 'utf8');

/** SRC with comment bodies blanked (newlines kept).
 *
 *  🔴 Added 2026-08-02 after this file went red against CORRECT code for the third time
 *  in one round: the assertion "must not have hard-coded-both-channels phrasing like
 *  `connByChannel.lan?.mobiles`" matched the COMMENT that names it as the anti-pattern. The prose is the audit
 *  trail — the same reason paired-list.test.ts's rule below matches `\.chip\.chan-lan\s*\{`
 *  rather than the bare class name — so the fix belongs in the probe, not in the code.
 *
 *  Used ONLY by the assertions written for it. The pre-existing negatives above are left
 *  reading raw SRC deliberately: quietly widening what an old test can see is how a test
 *  stops proving what its name says, and none of them is currently wrong. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(
  /^[ \t]*(?:\/\/|<!--).*$/gm,
  '',
);

describe('the device page no longer sets the channel (owner ②)', () => {
  it('there is no switch verb, no bridge binding and no "advanced" fold left', () => {
    for (const gone of ['doSwitch', 'switchChannel', 'channel_switch', 'lanAdvOpen', 'cloudAdvOpen', 'chan-adv']) {
      expect(SRC, `${gone} must be gone with the setting it served`).not.toContain(gone);
    }
  });

  it('neither card claims to be the chosen one', () => {
    // The "primary channel" chip and the `.chan.on` highlight both rendered a ROLE the user was
    // asked to pick.
    expect(SRC).not.toContain('lanCard.active');
    expect(SRC).not.toContain('cloudCard.active');
    expect(SRC).not.toContain('chip in-use');
  });

  it('the strings that only existed for that setting are gone from the catalogue', () => {
    // Deleted from all four locales, so a reader cannot find copy for a control that
    // no longer exists. locale-parity guards the four key sets against each other; this
    // guards them against the DEAD key.
    const keys = Object.keys(S);
    expect(keys).not.toContain('dev_chan_use');
    expect(keys).not.toContain('dev_chan_advanced');
    expect(keys).not.toContain('dev_chan_inactive');
    // 🔴 owner 2026-08-02 UI batch 1 ①: this line used to read `toContain('dev_chan_in_use')`
    // — the last two "primary channel" surfaces (this page's diagnostics sibling and the pairing
    // modal's tab dot) were retired in the same round, so the key has zero producers and
    // goes with them. See 2026-08-02-primary-channel-ui-retired-mechanism-inventory.md
    // for why the MECHANISM is untouched: removing the UI badge ≠ deleting the mechanism.
    expect(keys).not.toContain('dev_chan_in_use');
  });

  it('the page no longer hands the modal a channel ROLE it cannot act on', () => {
    // The `:active-channel` binding died with the modal's dot. `activeChannel` itself
    // stays — it decides which tab the modal OPENS on, which is a real behaviour.
    expect(SRC).not.toContain(':active-channel=');
    expect(SRC).toContain('initialPairTab(activeChannel.value');
  });
});

describe('the LAN card lists every listening address (owner ②)', () => {
  it('the list is rendered from lan_candidates with NO count gate', () => {
    // "when there are several, list ALL of them": the old markup only drew a
    // <select> when there were ≥2, so a single address was invisible and the
    // others hid behind a dropdown. An address the
    // phone needs but nobody can read off the screen is a silent failure.
    expect(SRC).toContain('v-if="lanCandidates.length > 0"');
    expect(SRC).toContain('v-for="c in lanCandidates"');
    expect(SRC).not.toContain('lanCandidates.length > 1');
    expect(SRC).not.toContain('<select class="lanpick-s mono"');
    // The section says what these addresses ARE, and marks the one the QR carries.
    expect(SRC).toContain('S.dev_lan_listen');
    expect(SRC).toContain('S.dev_lan_in_qr');
    // GA-21's non-RFC1918 label is kept: labelled, never demoted or hidden.
    expect(SRC).toContain('S.dev_lan_nonstandard');
  });

  it('picking an address still works — it is a NIC choice, not a channel choice', () => {
    // The one control that survives on this card. It answers "which address of
    // this machine does the phone dial," which is a fact about this machine's
    // NICs; owner ② deleted the control that answered "which channel," a
    // different question with a different answer.
    expect(SRC).toContain('@click="pickHost(c.address)"');
  });
});

// ── owner 2026-08-02 UI batch 1 ⑤: the candidate list folds, and ②'s red line must not be folded away ─────────────
//
// The whole risk of this change is that it reads as walking owner ② back. It does not,
// and the distinction is worth a test rather than only a comment: what ② forbade is the
// address IN USE being invisible; what this folds is the OTHER candidates.
describe('the listen-address fold keeps owner ②’s red line intact', () => {
  it('the fold starts CLOSED and is session-local, not a setting', () => {
    expect(SRC).toContain('const lanIpsOpen = ref(false)');
    // A persisted fold would be a settings key with no settings surface — the device
    // page is an information panel (owner 2026-07-30 ②).
    expect(SRC).not.toMatch(/lanIpsOpen[\s\S]{0,120}(localKv|saveSelectedHost|settings\.)/);
  });

  it('the address the QR actually carries is OUTSIDE the fold', () => {
    // `.addr` renders `lanEndpointLabel`, which is `applySelectedHost(...)` — the exact
    // host the pairing QR is built from. If a later edit moves this line inside the
    // `v-if="lanIpsOpen"` block, the card goes back to having no readable address by
    // default, which is the 0.2.x defect owner ② was fixing.
    const addrLine = SRC.match(/<span v-if="lanEndpointLabel !== '—'".*$/m)?.[0] ?? '';
    expect(addrLine, 'the .addr pill must still be rendered').toContain('lanEndpointLabel');
    const foldStart = SRC.indexOf('v-if="lanIpsOpen"');
    expect(foldStart).toBeGreaterThan(0);
    expect(SRC.indexOf(addrLine)).toBeLessThan(foldStart);
  });

  it('the toggle reuses the page’s existing fold language, not a second one', () => {
    expect(SRC).toContain('S.dev_lan_edit');
    expect(SRC).toContain('S.dev_fold_less');
    // Same `.fold-toggle` + `.diag-chev` the cloud account fold uses.
    expect(SRC).toMatch(/class="fold-toggle"[^>]*@click="lanIpsOpen = !lanIpsOpen"/);
  });

  it('🔴 the paired table re-reads when ANY channel’s phone count moves (owner ②)', () => {
    // The real defect behind "offline" + "last active: just now": the watch that calls `loadPaired()`
    // used to read `conn.mobiles`, and `conn` is BY CONSTRUCTION the primary channel's
    // snapshot (store.ts skips `primary === false`). A phone joining or leaving the
    // NON-primary channel therefore moved nothing in the watcher's dependency set, so
    // the online dots for that channel froze at whatever the previous read said.
    expect(CODE).toContain('const perChannelMobiles = computed(');
    expect(CODE).toContain('perChannelMobiles.value');
    // …and the primary-only count is GONE from the source, not merely joined by the
    // new one: two values answering "how many phones" is how they drift apart.
    expect(CODE).not.toMatch(/\[conn\.connected, conn\.registered, conn\.mobiles/);
    // The digest must ENUMERATE the reactive map rather than name two channels, so a
    // third channel could not be missed with no symbol to grep for.
    //
    // ⚠️ Scoped to the digest's own body on purpose. The first draft of this assertion
    // was a file-wide "never `connByChannel.lan?.mobiles` near `.cloud?.mobiles`" and it
    // went red on CORRECT, pre-existing code: `lanMobiles` / `cloudMobiles` do name the
    // two channels, legitimately — they feed the two FIXED cards' "N phone(s) connected"
    // lines, where "which two channels" is the layout itself. A guard that forbids a
    // shape the file is right to contain teaches the next person to delete the guard.
    const digest = CODE.match(/const perChannelMobiles = computed\(([\s\S]*?)\n\);/)?.[1] ?? '';
    expect(digest, 'perChannelMobiles must be findable').not.toBe('');
    expect(digest).toContain('Object.keys(connByChannel)');
    expect(digest).not.toContain('connByChannel.lan');
    expect(digest).not.toContain('connByChannel.cloud');
  });

  it('equal height is still `stretch`, not a hand-tuned min-height', () => {
    // owner ⑤'s second half. The cards were ALREADY equal height; what was wrong was
    // the height itself (the address list). A min-height here would freeze a number
    // that has no reason to be right on the next screen size.
    expect(CSS).toMatch(/\.channels\s*\{[^}]*align-items:\s*stretch/);
    expect(CSS).not.toMatch(/\.chan\s*\{[^}]*min-height/);
  });
});

// C-8 (owner 2026-08-01 unified channel visual identity, closing round): the two channel headings used to
// be plain text next to a health dot — no colour, no icon, only the fixed card
// position (LAN always first) and the fixed heading text told them apart. Full
// SSR render was ruled out above for the SAME reason it always was here (onMounted
// pre-fetch state proves nothing about fetched content) — but this addition does
// not need fetched content: CHANNEL_VISUAL is a static icon reference, so the
// source-literal anchor already used across this file is the right tool.
//
// C-8's judgement call, documented at the template call site too: these two cards
// keep the icon TINTED with the channel ink token but WITHOUT the `.chan-badge`
// background pill other consumers (PairedList/PairingModal/ConnDiagPage) use — a
// health dot (g/y/r/o, this page's PRIMARY signal) already sits right beside the
// heading, and stacking a second coloured pill next to it would compete with that
// signal rather than add information the fixed card position + fixed heading text
// do not already carry. It is still "colour + icon" (ink-coloured, real-shape icon),
// just without the `-soft` fill.
// 🔴 UPDATED by REQ-12-14 (2026-08-12) — and the two halves changed for DIFFERENT
// reasons, which is why they are not rewritten as one:
//   · the ICON assertion used to read `CHANNEL_VISUAL.lan.iconPath` out of THIS
//     page. The heading row moved into components/ChannelCardHead.vue (one head,
//     both cards, so the pair cannot drift), so a page-source probe would now be
//     asserting about a file that legitimately no longer contains it. It is
//     replaced by a delegation probe here + the real thing in
//     channel-visual-one-definition.test.ts and the SSR render in
//     components/channel-card-head.test.ts.
//   · the TINT assertion still measures presentation, and still measures「the
//     colour comes from the one definition」— only the selector and the file
//     changed (`.chan-ic.*` in devices-page.css → `.chan-tile.*` in the head
//     component), because scoped CSS has to travel with the markup it styles.
const HEAD = readFileSync(
  fileURLToPath(new URL('./components/ChannelCardHead.vue', import.meta.url)),
  'utf8',
);

describe('the channel headings carry the channel icon (owner 2026-08-01, C-8)', () => {
  it('the page hands BOTH cards to the one head component (delegation, not deletion)', () => {
    expect(SRC).toContain('<ChannelCardHead channel="lan"');
    expect(SRC).toContain('<ChannelCardHead channel="cloud"');
    // The head pulls the icon from CHANNEL_VISUAL keyed by the channel prop, so
    // the two cards CANNOT be pointed at the same silhouette by an edit here —
    // which is what the old whitespace-sensitive negative was reaching for.
    expect(HEAD).toContain('CHANNEL_VISUAL[channel].css');
    expect(HEAD).toContain('v-html="CHANNEL_VISUAL[channel].iconPath"');
  });

  it('the icon is tinted from the ONE definition (tokens.css var), not a private hex', () => {
    expect(HEAD).toMatch(/\.chan-tile\.lan\s*\{[^}]*var\(--channel-lan-ink\)/);
    expect(HEAD).toMatch(/\.chan-tile\.cloud\s*\{[^}]*var\(--channel-cloud-ink\)/);
    expect(HEAD).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    // The page's own stylesheet must stay literal-free too — REQ-12-14 added a
    // rail and a wash there, both driven by the same `--channel-*` pair.
    expect(CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('deliberately does NOT reuse the `.chan-badge` pill here (judgement, not an oversight)', () => {
    // The negative half of the call: if a future edit "helpfully" adds the
    // background pill next to the health dot, this is the anchor that should be
    // revisited (and the code comment above the h3 explains why it was skipped).
    expect(SRC).not.toContain('class="chan-badge"');
  });
});

describe('the cloud card shows the relay and the login state (owner ②)', () => {
  it('the domain is always on the card', () => {
    expect(SRC).toContain('{{ cloudEndpointLabel }}');
  });

  it('signed in ⇒ the account details are FOLDED by default', () => {
    expect(SRC).toContain('const cloudDetailOpen = ref(false)');
    expect(SRC).toContain('v-if="cloud.key_set && (cloudDetailOpen || cloudCard.loud)"');
  });

  it('signed out ⇒ the KEY form and its reason are shown, not a fold', () => {
    // Reusing the EXISTING readiness copy rather than a second judgment: the status
    // line comes from deriveCloudCard (`dev_chan_cloud_no_key` /
    // `dev_chan_cloud_signed_out` + cloudLoudReason), and the form appears on the one
    // condition that means "no key."
    expect(SRC).toContain('v-if="!cloud.key_set"');
    expect(SRC).toContain('S.cloud_key_label');
    expect(SRC).toContain('S.cloud_endpoint_label');
    expect(Object.keys(S)).toContain('dev_chan_cloud_no_key');
  });
});

describe('U11: the LAN card explains the node.exe firewall prompt honestly', () => {
  it('the note is wired into the LAN card (loopback-healthy ≠ reachable-from-elsewhere)', () => {
    // Positive: the production template really references the string (anti-façade —
    // a key that exists in the catalogue but is never read would pass every unit
    // test on cloud-account.ts/channel.ts and still leave the user staring at
    // "local service ready" with no idea why their phone can't connect).
    expect(SRC).toContain('S.sidecar_firewall_note');
    // Negative: this is NOT an error-only message. Gating it behind sidecarFailed
    // alone would silently un-fix the bug this card exists for — the loopback
    // probe is GREEN when the LAN channel is actually unreachable from other
    // machines. REQ-12-11 may fold the note, but the healthy path must still
    // mount it (`lanServiceOpen || …`), never `v-if="sidecarFailed"` alone.
    expect(SRC).not.toMatch(/v-if="sidecarFailed"[^>]*>\s*\{\{\s*S\.sidecar_firewall_note/);
    expect(SRC).toMatch(/lanServiceOpen\s*\|\|\s*sidecarFailed/);
  });

  it('the string names the real process (node.exe, not FlowMic) and the real stakes (other devices, not just this one)', () => {
    const note = S.sidecar_firewall_note;
    // Windows' prompt shows the binary name, not the product name — telling the user
    // to expect "FlowMic" would send them looking for a prompt that never appears.
    expect(note).toContain('node.exe');
  });
});

// REQ-12-11 — resting faces of the two channel cards should be the same density.
// Stretch already equalises height; the imbalance was LAN's always-on firewall wall.
describe('REQ-12-11: LAN local-service body folds by default (equal resting face)', () => {
  it('starts CLOSED and is session-local, not a settings key', () => {
    expect(SRC).toContain('const lanServiceOpen = ref(false)');
    expect(SRC).not.toMatch(/lanServiceOpen[\s\S]{0,120}(localKv|saveSelectedHost|settings\.)/);
  });

  it('failure / loud force the body open (same shape as the cloud account fold)', () => {
    expect(SRC).toContain('v-if="lanServiceOpen || sidecarFailed || lanCard.loud"');
    // Healthy resting path: fold toggle, not the loud inline strip.
    expect(SRC).toContain('v-if="!sidecarFailed && !lanCard.loud"');
    expect(SRC).toMatch(/class="fold-toggle"[^>]*@click="lanServiceOpen = !lanServiceOpen"/);
  });

  it('equal height is still stretch (not revisited via min-height)', () => {
    expect(CSS).toMatch(/\.channels\s*\{[^}]*align-items:\s*stretch/);
    expect(CSS).not.toMatch(/\.chan\s*\{[^}]*min-height/);
  });
});

// ── REQ-12-14 (visual refactor) + REQ-12-10b (same-machine shell) ─────────────
//
// What these can and cannot prove is worth stating, because "looks nice" is not
// testable and pretending otherwise produces green tests about nothing. They pin the
// STRUCTURAL commitments the two cards were redesigned around — the ones a later
// edit could undo without anybody noticing:
//   ① the two cards are still TWO cards inside a shell (the ruling's red line);
//   ② the shell's summary is the cards' own verdict, not a second derivation;
//   ③ identity colour still comes only from the `--channel-*` pair;
//   ④ the "This PC" card no longer wears `.chan`, so it cannot inherit channel chrome.
// Everything about how it LOOKS is device-unproven by construction — CSS is
// invisible to vitest (devices-page.css's own header says so) and this page
// cannot be rendered at all. That half is owner's / the device line's one-look.
describe('REQ-12-10b: the two channel cards sit in a same-machine shell, still TWO cards', () => {
  it('🔴 the shell wraps the pair — it does not merge them', () => {
    // The ruling: "the two clickable cards must not be merged into one (the
    // shell can be pretty, but the channel identity stays two cards)."
    // Two independent `.card chan` roots, one per channel, is the whole check.
    expect(SRC).toContain('class="chan-group"');
    expect(SRC).toContain('class="card chan ch-lan"');
    expect(SRC).toContain('class="card chan ch-cloud"');
    // The shell may not become a control: a click handler on it would make the
    // pair read as one target, which is the merge wearing different markup.
    const shell = SRC.match(/<section class="chan-group">([\s\S]*?)<div class="channels">/)?.[1] ?? '';
    expect(shell, 'the shell head must be findable').not.toBe('');
    expect(shell).not.toMatch(/@click|role="button"/);
  });

  it('the shell states the relation, and its count is the CARDS’ own verdict', () => {
    expect(SRC).toContain('S.dev_chan_group_title');
    expect(SRC).toContain('S.dev_chan_group_hint');
    expect(Object.keys(S)).toContain('dev_chan_group_ready');
    // 🔴 The anti-drift half: the summary must quote `lanCard.dot` / `cloudCard.dot`
    // and nothing else. A shell that asked `connByChannel` again could print
    // "2/2 ready" over a card whose own pill reads "unavailable" — one question,
    // two answers, this repo's number-one defect shape.
    const summary = CODE.match(/const channelSummary = computed\(([\s\S]*?)\n\);/)?.[1] ?? '';
    expect(summary, 'channelSummary must be findable').not.toBe('');
    expect(summary).toContain('lanCard.value.dot');
    expect(summary).toContain('cloudCard.value.dot');
    expect(summary).not.toContain('connByChannel');
  });

  it('the shell is ground, not a third card — and does not re-open the equal-height fix', () => {
    // A `.card` here would put three cards on screen and make the pair look like
    // children of a peer. It is a recessed surface instead.
    expect(CSS).toMatch(/\.chan-group\s*\{[^}]*background:\s*var\(--surface-2\)/);
    expect(CSS).toMatch(/\.channels\s*\{[^}]*align-items:\s*stretch/);
    expect(CSS).not.toMatch(/\.chan\s*\{[^}]*min-height/);
  });
});

describe('REQ-12-14: the channel cards carry identity chrome — and only they do', () => {
  it('each card binds the channel token pair; both rail and wash read those locals', () => {
    // One rule serving two cards with a single substitution — that is what "two
    // faces of one system" means in CSS, and it is why neither card can be
    // restyled alone by accident.
    expect(CSS).toMatch(/\.chan\.ch-lan\s*\{[^}]*--chan-ink:\s*var\(--channel-lan-ink\)/);
    expect(CSS).toMatch(/\.chan\.ch-cloud\s*\{[^}]*--chan-ink:\s*var\(--channel-cloud-ink\)/);
    expect(CSS).toMatch(/\.chan::before\s*\{[^}]*var\(--chan-ink\)/);
    expect(CSS).toMatch(/\.chan\s*\{\s*background:\s*linear-gradient\([^}]*var\(--chan-soft\)/);
  });

  it('🔴 the "This PC" card no longer wears `.chan` — it cannot answer either channel question', () => {
    // The reason the split happened at all. `.chan` now means "I am a channel,
    // here is which one and whether it is up"; the "This PC" card is neither.
    expect(SRC).not.toContain('card chan self');
    expect(SRC).toContain('<SelfPcCard');
    expect(CSS).not.toMatch(/\.chan\.self\s*\{/);
    // …and the rules really travelled with it rather than being dropped (a card
    // silently losing its layout is exactly what a pure-looking move can do).
    const SELF = readFileSync(
      fileURLToPath(new URL('./components/SelfPcCard.vue', import.meta.url)),
      'utf8',
    );
    expect(SELF).toMatch(/\.self-card\s*\{[^}]*flex-direction:\s*row/);
    expect(SELF).toContain('.self-name-row');
    expect(SELF).toContain('.rename-input');
    // The rename is still the ONE surface that can change the name, and its
    // refusal is still loud — the move must not have quietly dropped either.
    expect(SELF).toContain('renamePc(next)');
    expect(SELF).toContain('S.dev_rename_failed');
  });
});
