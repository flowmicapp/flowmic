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
  },
});
