/// <reference types="vite/client" />

// SFC module shim so `import X from './X.vue'` type-checks under vue-tsc / tsc.
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
