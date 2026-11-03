import { bindings, defineConfig, exports } from 'cf/config'
import * as entrypoint from './src/index.tsx' with { type: 'cf-worker' }

export default defineConfig({
  worker: {
    name: 'hypharness',
    compatibilityDate: '2026-10-23',
    entrypoint,
    env: {
      ACCOUNTS: bindings.durableObject({
        worker: 'hypharness',
        exportName: 'Accounts',
      }),
      RELAY: bindings.durableObject({
        worker: 'hypharness',
        exportName: 'Relay',
      }),
      // 暗号化した作業領域のチェックポイント。中継は鍵を持たず、復号できない
      CHECKPOINTS: bindings.r2({ name: 'hypharness-checkpoints' }),
    },
    exports: {
      Accounts: exports.durableObject({ storage: 'sqlite' }),
      Relay: exports.durableObject({ storage: 'sqlite' }),
    },
  },
})
