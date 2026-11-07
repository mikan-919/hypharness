// モジュールごとのプロンプトの Pareto の候補（最終目的の 6 の 8）。~/.hyph/evo/prompts/<module>.json に置く。
// ルートは環境変数 HYPH_EVO で差し替える
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Module, PromptCandidate } from '../../shared/evolve.ts'
import { evoPaths } from './store.ts'

const fileOf = (module: Module, root?: string) => join(evoPaths(root).prompts, `${module}.json`)

// ファイルが無ければ空の配列を返す
export function readPrompts(module: Module, root?: string): PromptCandidate[] {
  const file = fileOf(module, root)
  if (!existsSync(file)) return []
  return JSON.parse(readFileSync(file, 'utf8')) as PromptCandidate[]
}

export function writePrompts(module: Module, list: PromptCandidate[], root?: string): void {
  mkdirSync(evoPaths(root).prompts, { recursive: true })
  writeFileSync(fileOf(module, root), `${JSON.stringify(list, null, 2)}\n`)
}
