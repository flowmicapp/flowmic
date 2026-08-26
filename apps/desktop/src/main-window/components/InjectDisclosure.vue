<script setup lang="ts">
// 「注入与输入」 — the standing disclosure that injecting text borrows the
// clipboard. 2026-08-26.
//
// WHY IT EXISTS: on this day the clipboard became the DEFAULT road for injected
// text (`src-tauri/src/inject/text_route.rs::route_text`). Until then, taking
// over the clipboard hit a minority of sentences; now it hits nearly all of
// them. Owner's ruling was that the user has to be told, somewhere they can act
// on it — back something up — rather than discover their clipboard changing
// under them.
//
// IT IS A DISCLOSURE, NOT A WARNING THAT FIRES. This repo has the receipt for
// the difference: `dropped_unrendered` fired 36/36 times, and an alert that
// always fires is not an alert. What can genuinely go wrong is answered by
// `ClipboardSnapshot::unrecoverable()`, which is deliberately NOT the same
// question as 「a format was skipped」 — a bitmap is skipped every time and is
// never lost, because Windows regenerates it from the DIB.
//
// IT HAS NO TOGGLE, and that is a decision rather than an omission: the only
// alternative road is typed keystrokes, which is the one that silently loses
// characters (measured twice: WeChat 2026-08-21, Cursor 2026-08-26). Offering a
// switch would be offering the user a choice between 「a side effect you can
// see」 and 「a defect you cannot」.
//
// A SEPARATE COMPONENT rather than markup inside SettingsPage.vue, for the same
// reason DataFlowDisclosure.vue is: SettingsPage cannot be mounted in a test
// without the whole bridge, and copy that is only ever asserted by reading the
// catalogue is the façade shape this repo keeps catching. This one renders.
//
// ⚠️ The <section id="set-inject"> WRAPPER stays in SettingsPage.vue and is not
// duplicated here. It looked tidier inside this file for about ten minutes, and
// then timeline-data-group.test.ts went red on 「set-inject section does not
// exist」 — that test enforces 「every nav item has a section, and SECS order
// matches DOM order」 by reading SettingsPage.vue's source, and a section id
// that moved into a child is invisible to it. The nav item and the anchor it
// scrolls to have to be greppable in the same file.
import { S } from '../../lib/strings';
</script>

<template>
  <div class="card pad">
    <div class="prefs-label">{{ S.set_inject_clip_title }}</div>
    <p class="hint" style="margin-top:6px">{{ S.set_inject_clip_body }}</p>
    <p class="hint" style="margin-top:8px">{{ S.set_inject_clip_backup }}</p>
  </div>
</template>
