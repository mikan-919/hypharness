// 対話の画面に流すデータの形。ハーネスが画面へ渡す（ADR 0016）。
import type { DiffLine } from './diff.ts'

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
  costUsd: number
}
