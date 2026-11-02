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
    },
    exports: {
      Accounts: exports.durableObject({ storage: 'sqlite' }),
      Relay: exports.durableObject({ storage: 'sqlite' }),
    },
  },
})
