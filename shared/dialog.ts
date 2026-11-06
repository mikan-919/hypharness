// 対話の画面に流すデータの形。ハーネスが画面へ渡す（ADR 0016）。

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

export type Dialog = {
  topics: Topic[]
  // 質問の待ち行列。先頭が利用者に出す質問
  queue: string[]
  questions: Question[]
  entries: Entry[]
  started: boolean
}

// 中継が SSE で配信するトークン数（ADR 0016）。ハーネスを経由しない
export type Usage = {
  topicId: string
  input: number
  output: number
  cacheRead: number
  costUsd: number
}
