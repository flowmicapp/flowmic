<script setup lang="ts">
// 0.3.0 P1 — the in-product answer to "where did what you said go."
//
// WHY THIS EXISTS. Before this card, the ONLY surface in either end that
// explained what leaves the device was the scenario-inference consent panel —
// and that panel covers one optional feature (the focused executable's
// basename). The core path (audio → recognition → optional language-model
// processing → injection into the PC) had no in-product description at all, and
// `soniox` / `deepseek` appeared ZERO times in either end's source.
//
// WHAT THIS IS NOT. It is not a second source of truth. The five steps are the
// product-side summary of what THIS machine does; the shard
// `lib/strings/disclosure.ts` carries the code coordinate for each factual
// claim. A summary that drifts from the mechanism is worse than no summary.
//
// 🔴 WP3 C16 (owner 2026-08-17: a simple DIAGRAM plus short captions — no long
// text; the fine print lives on the web). The five steps became five nodes on
// one vertical rail, drawn with markup and tokens — never a raster image: an
// image cannot be localised and a screen reader cannot read it. Two claim
// families moved behind the website links rather than being deleted (the
// engine-selection order; the FLOWMIC_LAN_TLS fine print — the privacy policy
// carries both in full), and `disc_more_on_site` is the on-screen pointer.
//
// 🔴 LEGAL TEXTS ARE LIVE LINKS (owner 2026-08-14). Privacy and terms open
// https://flowmic.app/privacy and /terms in the system browser — the same
// `openExternalUrl` door PairingModal and UpdateBlock also go through — the
// `<a target=_blank>` this line used to describe never opened anything.
// State-aware sentences (which engine, LAN pin, polish switch) STAY here:
// the website cannot know this machine's configuration.
import { ref } from 'vue';
import { S } from '../../lib/strings';
import { DISCLOSURE_PRIVACY_URL, DISCLOSURE_TERMS_URL } from '../../lib/strings/disclosure';
import { openExternalUrl } from '../../lib/bridge-os';

// 🔴 0.3.24 — these two were `<a target=_blank>` and opened NOTHING. Not
// "sometimes", not "slowly": a WebView2 window declared in tauri.conf.json drops
// every new-window request (src-tauri/src/shell/external_open.rs has the measured
// chain). So the product's ONLY in-app route to the privacy policy and the terms
// has been dead for as long as this page has existed — on a page whose whole job
// is telling the user what happens to their data.
//
// They stay anchors (right cursor, right semantics, right for a screen reader)
// with the navigation intercepted: `href` remains the truth about where they go.
const openFailedUrl = ref<string | null>(null);
async function openLegal(url: string): Promise<void> {
  openFailedUrl.value = null;
  const r = await openExternalUrl(url);
  if (!r.ok) openFailedUrl.value = url;
}
</script>

<template>
  <div class="disc">
    <p class="hint">{{ S.disc_lead }}</p>

    <div class="card pad">
      <div class="disc-node">
        <div class="disc-rail" aria-hidden="true">
          <span class="disc-dot">🎙</span>
          <span class="disc-line" />
        </div>
        <div class="disc-node-body">
          <div class="disc-h">{{ S.disc_s1_title }}</div>
          <div class="disc-b">{{ S.disc_s1_body }}</div>
        </div>
      </div>

      <div class="disc-node">
        <div class="disc-rail" aria-hidden="true">
          <span class="disc-dot">〰</span>
          <span class="disc-line" />
        </div>
        <div class="disc-node-body">
          <div class="disc-h">{{ S.disc_s2_title }}</div>
          <div class="disc-b">{{ S.disc_s2_body }}</div>
          <div class="disc-b sub-item">{{ S.disc_s2_cloud }}</div>
          <div class="disc-b sub-item">{{ S.disc_s2_byok }}</div>
          <div class="disc-b sub-item">{{ S.disc_s2_local }}</div>
        </div>
      </div>

      <div class="disc-node">
        <div class="disc-rail" aria-hidden="true">
          <span class="disc-dot">✨</span>
          <span class="disc-line" />
        </div>
        <div class="disc-node-body">
          <div class="disc-h">{{ S.disc_s3_title }}</div>
          <div class="disc-b">{{ S.disc_s3_body }}</div>
        </div>
      </div>

      <div class="disc-node">
        <div class="disc-rail" aria-hidden="true">
          <span class="disc-dot">🖥</span>
          <span class="disc-line" />
        </div>
        <div class="disc-node-body">
          <div class="disc-h">{{ S.disc_s4_title }}</div>
          <div class="disc-b">{{ S.disc_s4_body }}</div>
          <!-- State-aware: encryption depends on how THIS pairing was made.
               The website cannot answer that, so these claims stay here. -->
          <div class="disc-b warn" role="note">{{ S.disc_s4_lan_plain }}</div>
        </div>
      </div>

      <div class="disc-node last">
        <div class="disc-rail" aria-hidden="true">
          <span class="disc-dot">🗂</span>
        </div>
        <div class="disc-node-body">
          <div class="disc-h">{{ S.disc_s5_title }}</div>
          <div class="disc-b">{{ S.disc_s5_body }}</div>
        </div>
      </div>
    </div>

    <p class="hint scope">{{ S.disc_more_on_site }}</p>

    <div class="card pad legal">
      <div class="disc-h">{{ S.disc_legal_title }}</div>
      <p class="legal-links">
        <a
          class="legal-link"
          :href="DISCLOSURE_PRIVACY_URL"
          rel="noopener noreferrer"
          @click.prevent="openLegal(DISCLOSURE_PRIVACY_URL)"
        >{{ S.disc_legal_privacy }}</a>
        <span class="legal-sep" aria-hidden="true">·</span>
        <a
          class="legal-link"
          :href="DISCLOSURE_TERMS_URL"
          rel="noopener noreferrer"
          @click.prevent="openLegal(DISCLOSURE_TERMS_URL)"
        >{{ S.disc_legal_terms }}</a>
      </p>
      <!-- The OS refused the address: say it, and leave the address on screen.
           Silence here would be the very defect this change removes. -->
      <p v-if="openFailedUrl" class="legal-open-failed" role="alert">
        {{ S.ext_open_failed }}<br /><span class="mono">{{ openFailedUrl }}</span>
      </p>
    </div>

    <p class="hint scope">{{ S.disc_scope_note }}</p>
  </div>
</template>

<style scoped>
.legal-open-failed { margin-top: 8px; font-size: 12px; line-height: 1.6; color: var(--amber-ink); }
.legal-open-failed .mono { word-break: break-all; }
.disc { max-width: 760px; }
.hint { font-size: 12.5px; color: var(--t3); line-height: 1.7; margin: 0 0 12px; }
.hint.scope { margin: 10px 2px 0; }
.card.pad { padding: 14px 16px; }
/* One node = rail cell (dot + connector) beside the caption. The rail is what
   makes the five steps read as ONE path rather than five paragraphs. */
.disc-node { display: flex; align-items: stretch; }
.disc-node-body { flex: 1; min-width: 0; padding-bottom: 14px; }
.disc-node.last .disc-node-body { padding-bottom: 0; }
.disc-rail { display: flex; flex-direction: column; align-items: center; width: 30px; margin-right: 10px; flex-shrink: 0; }
.disc-dot {
  width: 24px; height: 24px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: var(--surface-inset); font-size: 12px; line-height: 1;
}
.disc-line { flex: 1; width: 2px; background: var(--line-soft); margin-top: 2px; }
.disc-h { font-size: 13px; font-weight: 600; color: var(--t1); margin: 3px 0 5px; }
.disc-b { font-size: 12.5px; line-height: 1.7; color: var(--t2); }
.disc-b.sub-item { margin-top: 5px; padding-left: 4px; color: var(--t3); font-size: 12px; }
.disc-b.warn { margin-top: 7px; color: var(--amber-ink); font-size: 12px; }
.legal { margin-top: 12px; }
.legal-links { margin: 6px 0 0; font-size: 12.5px; line-height: 1.75; }
/* `--brand-ink` is the token for brand colour used as TEXT on a surface
   (tokens.css:13), which is exactly what a link is. The first cut reached for a
   `--accent` that does not exist in this design system; the fallback made it
   render acceptably, so only the css-var-defined gate noticed. */
.legal-link { color: var(--brand-ink); }
.legal-sep { margin: 0 8px; color: var(--t3); }
</style>
