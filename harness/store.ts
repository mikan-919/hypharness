// 対話の状態。論点エージェントが書き、画面が読む
import type { Dialog, Entry, Question, Topic } from '../shared/dialog.ts'

export function createStore() {
  const dialog: Dialog = { topics: [], queue: [], questions: [], entries: [], started: false }
  const waiting = new Map<string, (answer: string) => void>()
  const listeners = new Set<(dialog: Dialog) => void>()
  const changed = () => {
    for (const listener of listeners) listener(dialog)
  }

  return {
    snapshot: () => dialog,
    subscribe(listener: (dialog: Dialog) => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    addTopic(topic: Topic) {
      dialog.topics = [...dialog.topics, topic]
      changed()
    },
    setTopic(id: string, patch: Partial<Topic>) {
      dialog.topics = dialog.topics.map((t) => (t.id === id ? { ...t, ...patch } : t))
      changed()
    },
    // 質問を待ち行列に入れ、利用者の答えを待つ
    ask(question: Omit<Question, 'id' | 'answer' | 'held'>) {
      const id = `q${dialog.questions.length + 1}`
      dialog.questions = [...dialog.questions, { ...question, id, answer: '', held: false }]
      dialog.queue = [...dialog.queue, id]
      changed()
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
  }
}

export type Store = ReturnType<typeof createStore>
