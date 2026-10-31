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
      AGENT: bindings.durableObject({
        worker: 'hypharness',
        exportName: 'Agent',
      }),
      CODEX: bindings.durableObject({
        worker: 'hypharness',
        exportName: 'Codex',
      }),
    },
    exports: {
      Accounts: exports.durableObject({ storage: 'sqlite' }),
      Agent: exports.durableObject({ storage: 'sqlite' }),
      Codex: exports.durableObject({ storage: 'sqlite' }),
    },
  },
})
