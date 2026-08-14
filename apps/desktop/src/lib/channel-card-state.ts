// REQ-12-14 — the GLANCE layer of the two devices-page channel cards.
//
// WHY A SEPARATE FILE. lib/channel.ts owns `deriveLanCard` / `deriveCloudCard`,
// and REQ-12-14's execution card forbids drifting their semantics («zero
// protocol [changes]…keep the fact source honest, change only the
// presentation», 零协议…事实源保持诚实，只改呈现). The cheapest way to keep a visual round from
// touching them is not to open that file at all: everything here is a pure
// RENDERING of what those two already decided, and its only input is the
// `ChannelCard.dot` they return.
//
// WHY A WORD NEXT TO THE DOT AT ALL. owner's acceptance line is "on/off status
// should not depend on reading a long sentence" (通断状态不靠读长句). The card's existing status line is a sentence — "local service
// ready · connected directly on the same Wi-Fi" (本地服务就绪 · 同一Wi-Fi 直连), "not signed in · available after pasting the
// Cloud Key from the console" (未登录 · 粘贴控制台的 Cloud Key 后可用) — which is the right
// thing to read second and the wrong thing to read first. The dot alone answers
// "whether it's connected or not" (通不通) in colour only, and owner 2026-08-01's standing rule is colour + icon/text
// combination, cannot rely on colour alone (颜色+图标/文字组合，不能只靠颜色). So the pill is dot + word.
//
// 🔴 THE WORD IS NOT A NEW STATUS. Inventing a fifth state here would be exactly
// the failure this repo keeps paying for (a status word with no source behind
// it). The four words below map ONE-TO-ONE onto the four meanings `ChannelCard.dot`
// already documents in lib/channel.ts, quoted verbatim:
//
//   g — «its socket is up»                        → 已就绪   / Ready
//   y — «coming up»                               → 连接中…  / Connecting…
//   r — «loudly broken»                           → 不可用   / Unavailable
//   o — «not resident at all (e.g. cloud with no key)» → 未运行 / Not running
//
// ⚠️ The word is deliberately GENERIC where the dot is generic. `o` covers both
// "local service hasn't started" and "cloud has no key"; a word that named either one would be a
// lie on the other card, and the card's own status line right underneath already
// says which. The rule for a future editor: the pill may never say something the
// dot does not know. If you want a more specific word, the specificity has to
// come from the derivation that produced the dot, not from here.
//
// ⚠️ `y` REUSES the existing `dev_chan_connecting` rather than adding a fifth
// string that says the same thing. Two strings for one state is how they drift.

import { S } from './strings';
import type { Dot } from './channel';

/** The short word shown in a channel card's state pill. Pure function of the
 *  dot — see the 🔴 block above for the one-to-one mapping and why it may not
 *  grow a fifth entry. */
export function channelStateWord(dot: Dot): string {
  switch (dot) {
    case 'g':
      return S.dev_chan_state_ready;
    case 'y':
      return S.dev_chan_connecting;
    case 'r':
      return S.dev_chan_state_down;
    case 'o':
    default:
      return S.dev_chan_state_off;
  }
}

export interface ChannelGroupSummary {
  /** How many of the given channels are up right now. */
  ready: number;
  /** How many channels the shell is holding — derived from the input, never the
   *  literal 2. The devices page renders a fixed pair today; a summary that
   *  hard-coded「/2」would keep saying 2 on the day a third card appears, and
   *  nothing would grep as broken. */
  total: number;
  /** The rendered "{n}/{m} ready" (条就绪) line. */
  label: string;
}

/** REQ-12-10b — the same-machine shell's one-line summary.
 *
 *  The judgement it renders is the CARDS' OWN: `dot === 'g'` is the verdict
 *  `deriveLanCard` / `deriveCloudCard` already published for that channel, so
 *  the shell cannot disagree with the card sitting under it. It deliberately
 *  does NOT re-derive readiness from `connByChannel` — that would be a second
 *  answer to "is this channel connected or not", which is this repo's number-one defect shape. */
export function summariseChannelGroup(dots: Dot[]): ChannelGroupSummary {
  const ready = dots.filter((d) => d === 'g').length;
  const total = dots.length;
  return {
    ready,
    total,
    label: S.dev_chan_group_ready.replace('{n}', String(ready)).replace('{m}', String(total)),
  };
}
