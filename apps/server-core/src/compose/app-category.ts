// SPEC-REF:
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.1 (scenario source ②:
//     application scenario — inject_target.process_name → built-in category
//     map: VSCode/terminal→coding; Outlook→email; WeChat→chat. App NAME only,
//     never screen contents — the privacy contrast with Wispr's screen-reading)
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.5 (focus:state.process_name is the
//     desktop FocusTarget.app_name VERBATIM — executable basename, extension
//     already stripped: canonical 'explorer', never 'explorer.exe')
//
// Source ② of the three-source scenario context. Pure, deterministic map from a
// focus process basename to one of a small closed set of application categories,
// then to a short English descriptor rendered into the (delimited, non-
// instruction) scenario block. Only the app name is consulted — no window title,
// no screen contents. An unmapped process yields `undefined` (contributes
// nothing to the prompt), never a guess.
//
// WIRED (WP-R4-4): server-core now tracks the PC's latest focus:state
// process_name per room (RoomStore.setFocusProcess, populated from the
// focus:state relay; cleared on PC disconnect / room switch). compose.handler
// reads it (RoomStore.getFocusProcess) and fills ComposeStartArgs.processName,
// which resolveScenarioContext threads into this map — so the app-scenario
// descriptor is live in production compose prompts, not just unit-tested.

export type AppCategory = 'coding' | 'email' | 'chat';

// Basenames are matched case-insensitively. Values are the desktop
// FocusTarget.app_name form (extension already stripped upstream).
const CATEGORY_BY_PROCESS: Readonly<Record<string, AppCategory>> = {
  // coding — editors / IDEs
  code: 'coding', 'code - insiders': 'coding', cursor: 'coding', devenv: 'coding',
  idea64: 'coding', idea: 'coding', pycharm64: 'coding', pycharm: 'coding',
  webstorm64: 'coding', webstorm: 'coding', goland64: 'coding', goland: 'coding',
  clion64: 'coding', rider64: 'coding', 'sublime_text': 'coding', atom: 'coding',
  rustrover64: 'coding', zed: 'coding', neovide: 'coding', gvim: 'coding',
  // coding — terminals
  windowsterminal: 'coding', wt: 'coding', powershell: 'coding', pwsh: 'coding',
  cmd: 'coding', conhost: 'coding', alacritty: 'coding', wezterm: 'coding',
  wezterm_gui: 'coding', hyper: 'coding', mintty: 'coding', kitty: 'coding',
  // email
  outlook: 'email', hxoutlook: 'email', thunderbird: 'email', mailspring: 'email',
  em_client: 'email', emclient: 'email', 'em client': 'email',
  // chat / IM
  wechat: 'chat', weixin: 'chat', telegram: 'chat', 'telegram desktop': 'chat',
  slack: 'chat', discord: 'chat', qq: 'chat', tim: 'chat', dingtalk: 'chat',
  feishu: 'chat', lark: 'chat', whatsapp: 'chat', signal: 'chat', element: 'chat',
};

const DESCRIPTOR_BY_CATEGORY: Readonly<Record<AppCategory, string>> = {
  coding: 'writing code or technical content (a code editor or terminal is focused)',
  email: 'composing an email',
  chat: 'writing a chat / instant message',
};

/** Map a focus process basename to a category, or undefined when unmapped. */
export function appCategoryFor(processName: string | undefined): AppCategory | undefined {
  if (!processName) return undefined;
  return CATEGORY_BY_PROCESS[processName.trim().toLowerCase()];
}

/** The prompt-facing descriptor for a process, or undefined when unmapped. */
export function appCategoryDescriptor(processName: string | undefined): string | undefined {
  const cat = appCategoryFor(processName);
  return cat ? DESCRIPTOR_BY_CATEGORY[cat] : undefined;
}
