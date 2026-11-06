// 対話の状態。論点エージェントが書き、画面が読む。変わるたびにファイルへ保存し、再起動の後に続きから始める
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Message } from '@earendil-works/pi-ai'
import type { Dialog, Entry, Question, Topic } from '../shared/dialog.ts'

type Saved = { dialog: Dialog; transcripts: Record<string, Message[]> }

function load(file: string | undefined): Saved {
  try {
    return JSON.parse(readFileSync(file ?? '', 'utf8'))
  } catch {
    return { dialog: { topics: [], queue: [], questions: [], entries: [], started: false }, transcripts: {} }
  }
}

// file を渡さなければ保存しない
export function createStore(file?: string) {
  const { dialog, transcripts } = load(file)
  const waiting = new Map<string, (answer: string) => void>()
  const listeners = new Set<(dialog: Dialog) => void>()
  const changed = () => {
    if (file) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ dialog, transcripts }))
    }
    for (const listener of listeners) listener(dialog)
  }

  return {
    snapshot: () => dialog,
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
    saveTranscript(topicId: string, messages: Message[]) {
      transcripts[topicId] = messages
      changed()
    },
  }
}

export type Store = ReturnType<typeof createStore>
