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

// 1つの変更案。round は周の番号、score は回帰テストの報酬（0 か 1）
export type Candidate = {
  id: string
  round: number
  module: Module
  changes: string[]
  score: 0 | 1
  note: string
}
