// 対話の状態。論点エージェントが書き、画面が読む。変わるたびにファイルへ保存し、再起動の後に続きから始める
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Message } from '@earendil-works/pi-ai'
import type { Dialog, Entry, Question, Topic } from '../shared/dialog.ts'
import { diffLines } from '../shared/diff.ts'

// seen は論点ごとの、エージェントが既に知っている本文の版
type Saved = { dialog: Dialog; transcripts: Record<string, Message[]>; seen: Record<string, number> }

const EMPTY: Dialog = {
  topics: [],
  queue: [],
  questions: [],
  entries: [],
  started: false,
  goal: { text: '', version: 0 },
  edits: [],
}

function load(file: string | undefined): Saved {
  try {
    const saved = JSON.parse(readFileSync(file ?? '', 'utf8'))
    return { dialog: { ...EMPTY, ...saved.dialog }, transcripts: saved.transcripts, seen: saved.seen ?? {} }
  } catch {
    return { dialog: { ...EMPTY }, transcripts: {}, seen: {} }
  }
}

// file を渡さなければ保存しない。goalFile を渡すと、本文をそのファイル（対象のリポジトリの FINAL_GOAL.md）と同期する
export function createStore(file?: string, goalFile?: string) {
  const { dialog, transcripts, seen } = load(file)
  const waiting = new Map<string, (answer: string) => void>()
  const listeners = new Set<(dialog: Dialog) => void>()
  const changed = () => {
    if (file) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ dialog, transcripts, seen }))
    }
    for (const listener of listeners) listener(dialog)
  }

  // 読んだ版の番号が今の版と違えば断る（ADR 0018）。断ったときは最新の本文を返す
  function editGoal(text: string, base: number, author: string, reason: string) {
    const { goal } = dialog
    if (base !== goal.version) return { ok: false as const, ...goal }
    if (text === goal.text) return { ok: true as const, ...goal }
    const version = goal.version + 1
    const edit = { id: `v${version}`, author, reason, version, diff: diffLines(goal.text, text), before: goal.text }
    dialog.goal = { text, version }
    dialog.edits = [...dialog.edits, edit]
    if (goalFile) writeFileSync(goalFile, text)
    changed()
    return { ok: true as const, ...dialog.goal }
  }

  // 画面の外で FINAL_GOAL.md が書き換えられていたら、利用者の書き換えとして取り込む
  if (goalFile && existsSync(goalFile)) {
    const text = readFileSync(goalFile, 'utf8')
    if (text !== dialog.goal.text) editGoal(text, dialog.goal.version, 'user', 'FINAL_GOAL.md を直接書き換えた')
  }

  return {
    snapshot: () => dialog,
    editGoal,
    // ある書き換えの前の版に戻す。戻すことも1回の書き換えとして履歴に残す
    revert(editId: string) {
      const edit = dialog.edits.find((e) => e.id === editId)
      if (!edit) return { ok: false as const, ...dialog.goal }
      return editGoal(edit.before, dialog.goal.version, 'user', `${editId} の前の版に戻した`)
    },
    // since の版より後に、author 以外が入れた書き換え
    editsSince: (since: number, author: string) => dialog.edits.filter((e) => e.version > since && e.author !== author),
    subscribe(listener: (dialog: Dialog) => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    hasTopic: (id: string) => dialog.topics.some((t) => t.id === id),
    addTopic(topic: Topic) {
      dialog.topics = [...dialog.topics, topic]
      changed()
    },
    setTopic(id: string, patch: Partial<Topic>) {
      dialog.topics = dialog.topics.map((t) => (t.id === id ? { ...t, ...patch } : t))
      changed()
    },
    // 質問を待ち行列に入れ、利用者の答えを待つ。同じ key の質問が既にあれば、出し直さずにその答えを待つ
    ask(question: Omit<Question, 'id' | 'answer' | 'held'>) {
      const existing = dialog.questions.find((q) => q.key === question.key)
      if (existing?.answer) return Promise.resolve(existing.answer)
      const id = existing?.id ?? `q${dialog.questions.length + 1}`
      if (!existing) {
        dialog.questions = [...dialog.questions, { ...question, id, answer: '', held: false }]
        dialog.queue = [...dialog.queue, id]
        changed()
      }
      return new Promise<string>((resolve) => waiting.set(id, resolve))
    },
    answer(id: string, text: string) {
      const resolve = waiting.get(id)
      if (!resolve || !text.trim()) return false
      waiting.delete(id)
      dialog.questions = dialog.questions.map((q) => (q.id === id ? { ...q, answer: text } : q))
      dialog.queue = dialog.queue.filter((q) => q !== id)
      changed()
      resolve(text)
      return true
    },
    record(entry: Omit<Entry, 'id'>) {
      dialog.entries = [...dialog.entries, { ...entry, id: `e${dialog.entries.length + 1}` }]
      changed()
    },
    transcript: (topicId: string) => transcripts[topicId],
    seen: (topicId: string) => seen[topicId] ?? 0,
    setSeen(topicId: string, version: number) {
      seen[topicId] = version
    },
    saveTranscript(topicId: string, messages: Message[]) {
      transcripts[topicId] = messages
      changed()
    },
  }
}

export type Store = ReturnType<typeof createStore>
