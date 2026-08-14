import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

// WP-R2-2 pure-logic unit tests (visibility FSM / capsule morph / settings
// debounce+durable queue / generation counter / drift anchors). These import
// only lib/*.ts modules — no Tauri, no DOM — so the node environment is enough
// and there is no need for a jsdom shim.
// V2-07.8a added the vue plugin: locale/theme 组件级测试（任务自查 ⑦-①）要
// 真的编译并挂载 SFC（PrefsAppearance）——但挂载走的是自定义渲染器
// (createRenderer 虚拟 nodeOps), 不是 DOM，所以 environment 仍然是 node。
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // .vue files stay on the default SSR transform — prefs-appearance.test.ts
    // 组件级测试 actually RENDERS them through vue/server-renderer
    // (renderToString), so the SSR compile shape is used, not fought.
    //
    // 20s, not vitest's 5s default — a CI measurement, not taste. On GitHub's
    // windows-latest the suite hit the 5s ceiling twice within one hour on
    // 2026-08-15 (runs 31843244310 and 31850424914), different individual
    // tests each time, all inside timeline-store/update-block — while the
    // same bytes pass in well under a second locally (88/88 in 14.6s
    // total). That is I/O-starved-runner jitter, not a hang; rerunning until
    // green would launder the signal instead of fixing the margin. A truly
    // hung test still fails — it just takes 20s to say so.
    testTimeout: 20_000,
  },
});
