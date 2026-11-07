// 対話の画面に流すデータの形。ハーネスが画面へ渡す（ADR 0016）。
import type { DiffLine } from './diff.ts'
import type { Candidate } from './evolve.ts'

export type TopicState = 'researching' | 'asking' | 'ready' | 'blocked'

export type Topic = {
  id: string
  title: string
  state: TopicState
  // 開始のツールを呼んだか（ADR 0012）
  ready: boolean
}

export type Option = {
  label: string
  description: string
  recommended: boolean
}

export type Question = {
  id: string
  topicId: string
  text: string
  options: Option[]
  recommendation: string
  // 利用者の答え。未回答なら空文字
  answer: string
  // 依存する論点の決定待ちで保留している答えか
  held: boolean
  // 質問を出したツールの呼び出しの id。再起動の後、同じ呼び出しの質問を出し直さないために使う
  key: string
}

export type EntryKind = 'fact' | 'fail' | 'done'

// 共有文脈の項目。追記だけで、書いた後は変えない
export type Entry = {
  id: string
  topicId: string
  kind: EntryKind
  text: string
  evidence: string
}

// FINAL_GOAL.md の書き換え1回分（ADR 0018）。author は 'user' か論点の id
export type Edit = {
  id: string
  author: string
  reason: string
  // この書き換えで本文がなった版
  version: number
  diff: DiffLine[]
  // この書き換えの前の本文。履歴から戻すときに使う
  before: string
}

// 自己改良の1周の進み。stage は提案づくり（proposing）、候補の採否（validating）、終えた（done）
export type Evolution = {
  round: number
  stage: 'proposing' | 'validating' | 'done'
  // この周で使った費用（ドル）
  spent: number
  candidates: Candidate[]
}

export type Dialog = {
  topics: Topic[]
  // 質問の待ち行列。先頭が利用者に出す質問
  queue: string[]
  questions: Question[]
  entries: Entry[]
  // 開始の合図の後の流れが動いているか（ADR 0021）
  started: boolean
  goal: { text: string; version: number }
  edits: Edit[]
  tasks: Task[]
  activity: Activity[]
  // エージェントごとの、書いている途中の文
  live: Record<string, string>
  // 流れを止めた理由。動いているときや止まっていないときは空
  halted: string
  // 利用者が止めるボタンを押した。今の課題を終えたら止める
  stopping: boolean
  // 分解役が最終目的を満たしたと判断して流れを終えた理由。動き出したら空にする
  finished: string
  // 自己改良の1周の進み。回していないときは null
  evolution: Evolution   // 今の流れを始めたときの課題と共有文脈の件数。自己改良の弱点をこの流れの分に絞るのに使い、再起動の後も引き継ぐ
  from: { tasks: number; entries: number }
| null
}

export type TaskState = 'solving' | 'checking' | 'committed' | 'held'

// 分解役が作った課題1つ分
export type Task = {
  id: string
  statement: string
  state: TaskState
  attempts: number
  // 統合ブランチに積んだコミット
  commit: string
  // 保留にした理由。保留でなければ空文字
  reason: string
  // この課題で使った費用（ドル）
  spent: number
  // 積んだコミットの差分。積んでいなければ空文字
  diff: string
  // 中継が数えた、この課題のモデルの呼び出し（分解役と解答役）
  usage?: TaskUsage
}

// 課題ごとのモデルの呼び出しの記録（ADR 0031 のしきい値を調整する材料）。
// maxPrompt は1回の呼び出しでモデルに渡した文脈の最大のトークン数、edits は edit_context の呼び出しの回数、
// rebuilds はモデルに渡す会話が前の呼び出しより短くなった回数（edit_context としきい値で縮めた分）
export type TaskUsage = {
  calls: number
  input: number
  cacheRead: number
  output: number
  maxPrompt: number
  edits: number
  rebuilds: number
  costUsd: number
}

// エージェントの動き1つ分。agent は論点の id か 'decompose'・'solve'
export type Activity = {
  id: string
  agent: string
  kind: 'tool' | 'result' | 'text' | 'check' | 'commit' | 'fail'
  text: string
  at: number
}

// 中継が SSE で配信するトークン数（ADR 0016）。ハーネスを経由しない
export type Usage = {
  topicId: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
}
