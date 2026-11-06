// 見本のデータ。作り直しの設計を詰めた最初の対話（2026-11-06）から取った
import type { Dialog } from './dialog.ts'

export const fixture: Dialog = {
  started: false,
  topics: [
    { id: 'scope', title: '構成', state: 'ready', ready: true },
    { id: 'reward', title: '報酬', state: 'ready', ready: true },
    { id: 'plan', title: '方針', state: 'ready', ready: true },
    { id: 'budget', title: '費用', state: 'ready', ready: true },
    { id: 'ui', title: '画面', state: 'asking', ready: false },
    { id: 'fixed', title: '固定部', state: 'researching', ready: false },
  ],
  queue: ['q41', 'q36b'],
  questions: [
    {
      id: 'q1',
      topicId: 'scope',
      text: '今回詰めたい計画はどれですか。',
      options: [
        { label: '作り直す', description: 'hypharness を一から作り直す', recommended: true },
        { label: '部分的な再設計', description: '中継だけ、RSI ループだけなど', recommended: false },
        { label: '別のもの', description: 'hypharness とは別', recommended: false },
      ],
      recommendation: '全削除のブランチを切っているので、作り直しが前提と読んだ。',
      answer: 'A',
      held: false,
    },
    {
      id: 'q10',
      topicId: 'reward',
      text: '報酬の基本を、検証生成 AI にしますか。',
      options: [
        { label: '検証生成 AI', description: '方針からテストを書き、実行して判定する', recommended: true },
        { label: '判定 AI', description: '回答を読んで点を付ける', recommended: false },
      ],
      recommendation: '判定は実行の結果で決まり、解答役は説得で点を上げられない。',
      answer: '課題文から元の状態でテストが通るものを作るプロンプト自体が悪い',
      held: false,
    },
    {
      id: 'q41',
      topicId: 'ui',
      text: '画面を何で描きますか。',
      options: [
        { label: 'irisout', description: '更新先をコンパイル時に決める JSX コンパイラ', recommended: true },
        { label: 'React', description: '旧実装と同じ', recommended: false },
        { label: 'なし', description: '素の TypeScript と DOM', recommended: false },
      ],
      recommendation: 'ストリーミング中のトークン数のように細かく更新される値に合う。',
      answer: '',
      held: false,
    },
    {
      id: 'q36b',
      topicId: 'fixed',
      text: '観察の期間内にマージがなかった期間を、取り消しの判定から外しますか。',
      options: [
        { label: '外す', description: 'どの版も悪く見えることを避ける', recommended: true },
        { label: '外さない', description: '期間をそのまま数える', recommended: false },
      ],
      recommendation: '利用者が何もマージしない期間は、版の良し悪しと関係がない。',
      answer: '',
      held: false,
    },
  ],
  entries: [
    {
      id: 'e1',
      topicId: 'scope',
      kind: 'fact',
      text: '旧実装は中継・画面・ペアリング・実行権に費用と保守を払っていた',
      evidence: 'docs/adr/0001-local-only.md',
    },
    {
      id: 'e2',
      topicId: 'reward',
      kind: 'fail',
      text: '元の状態で通るテストを後から捨てるのは症状への対処で、生成の側を直す',
      evidence: '利用者の答え（質問10）',
    },
    {
      id: 'e3',
      topicId: 'plan',
      kind: 'done',
      text: '方針は DeLM の中で1つに収束させる',
      evidence: 'docs/adr/0009-plan-converges-in-delm.md',
    },
    {
      id: 'e4',
      topicId: 'ui',
      kind: 'fact',
      text: 'irisout は Hono のファイル経路と連携する',
      evidence: 'irisout/docs/hono-file-routing.md',
    },
  ],
}
