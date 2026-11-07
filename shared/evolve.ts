// 改良の対象のモジュール（ADR 0022、最終目的の 6）。ハーネスの振る舞いを5つに分け、候補はモジュールごとに作る。
// モジュールごとの仕様は docs/specs/<値>.md に置く。値とファイル名は一致させる
export const MODULES = ['agent-loop', 'tool-use', 'observation', 'context', 'completion'] as const

export type Module = (typeof MODULES)[number]

// モジュールごとの1行の説明
export const MODULE_SUMMARY: Record<Module, string> = {
  'agent-loop': 'モデルを呼び、ツールを回して、1つのターンを進める',
  'tool-use': 'ツールの一覧と引数の解釈、実行の仕方',
  observation: 'ツールの結果を縮めて、モデルに見せる',
  context: '会話の保存と要約、文脈ファイル、recall と edit_context',
  completion: '課題を終えたか諦めたかの判定と、その結果の返し方',
}

// 1つの変更案。round は周の番号、score は回帰テストの報酬（0 か 1）、cost は検証に使った費用（ドル）。
// holdout は採用した候補を提案に使わなかった課題で測った結果（0 か 1）。未測定は undefined。
// parent は出発点にした候補の id、diff は統合ブランチの先端から当てたコードの差分（出発点の分を含む）、
// commit は採用して統合ブランチに積んだコミット。proposalMaterial と proposalResponse は提案役への入力 JSON と応答本文。
export type Candidate = {
  id: string
  round: number
  module: Module
  changes: string[]
  score: 0 | 1
  note: string
  cost: number
  holdout?: 0 | 1
  parent?: string
  diff?: string
  commit?: string
  // 検査コマンドの標準出力と標準エラー。未記録は undefined
  checkOutput?: { stdout: string; stderr: string }
  // 提案役に実際に渡した材料 JSON と、返した本文。古い候補では未記録
  proposalMaterial?: string
  proposalResponse?: string
}

// モジュールごとのプロンプトの候補（最終目的の 6 の 8）。
// passes は課題 id ごとの通過（0 か 1）、cost は通過を測るのに使った費用（ドル）
export type PromptCandidate = {
  module: Module
  text: string
  passes: Record<string, 0 | 1>
  cost: number
}

// 通過数の合計
const totalPasses = (prompt: PromptCandidate) =>
  Object.values(prompt.passes).reduce((sum, value) => sum + value, 0)

// a が b を全課題で同等以上かつ1つ以上で上回るか。課題の無い候補は上回らない
export function dominates(a: PromptCandidate, b: PromptCandidate): boolean {
  const keys = new Set([...Object.keys(a.passes), ...Object.keys(b.passes)])
  let better = false
  for (const key of keys) {
    const x = a.passes[key] ?? 0
    const y = b.passes[key] ?? 0
    if (x < y) return false
    if (x > y) better = true
  }
  return better
}

// 同じ text の候補を1つにし、ほかの候補に全課題で同等以上かつ1つ以上で上回られる候補を落とす
export function paretoPrompts(list: PromptCandidate[]): PromptCandidate[] {
  const seen = new Set<string>()
  const unique = list.filter((prompt) => {
    if (seen.has(prompt.text)) return false
    seen.add(prompt.text)
    return true
  })
  return unique.filter((prompt) => !unique.some((other) => other !== prompt && dominates(other, prompt)))
}

// 通過数の合計の降順、同じなら cost の昇順、同じなら text の昇順
export function rankPrompts(list: PromptCandidate[]): PromptCandidate[] {
  return [...list].sort((a, b) => {
    const pa = totalPasses(a)
    const pb = totalPasses(b)
    if (pa !== pb) return pb - pa
    if (a.cost !== b.cost) return a.cost - b.cost
    return a.text < b.text ? -1 : a.text > b.text ? 1 : 0
  })
}
