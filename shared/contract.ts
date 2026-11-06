// 固定部（server/）と改良の対象（harness/）の約束（ADR 0022）。改良の対象は子プロセスとして版ごとに動き、
// 対話の状態にはこの AgentStore の操作だけで触れる。ここを変える改良は、利用者がマージして起動し直したときだけ効く
import type { Message } from '@earendil-works/pi-ai'
import type { Activity, Dialog, Edit, Entry, Question, Topic } from './dialog.ts'

type MaybePromise<T> = T | Promise<T>

export type GoalResult = { ok: boolean; text: string; version: number }

export type AgentStore = {
  // 値を返さない操作。子プロセスからは順に送り、待たない
  act(agent: string, kind: Activity['kind'], text: string): void
  setLive(agent: string, text: string): void
  record(entry: Omit<Entry, 'id'>): void
  setTopic(id: string, patch: Partial<Topic>): void
  setSeen(topicId: string, version: number): void
  saveTranscript(topicId: string, messages: Message[]): void
  // 値を返す操作
  snapshot(): MaybePromise<Dialog>
  ask(question: Omit<Question, 'id' | 'answer' | 'held'>): Promise<string>
  editGoal(text: string, base: number, author: string, reason: string): MaybePromise<GoalResult>
  transcript(topicId: string): MaybePromise<Message[] | undefined>
  seen(topicId: string): MaybePromise<number>
  editsSince(since: number, author: string): MaybePromise<Edit[]>
}

// 中継が費用の上限に達してモデルの呼び出しを断った（ADR 0011、0012）
export class CostLimitError extends Error {}

// 子プロセスに渡す仕事。tree は課題の作業ツリー、messages は前の試行までの解答役の会話
export type Job =
  | { role: 'topic'; topicId: string; repo: string }
  | { role: 'decompose'; taskId: string; tree: string }
  | { role: 'solve'; taskId: string; tree: string; statement: string; messages: Message[]; failure: string }

export type DecomposeResult = { statement: string } | { finish: string }
export type SolveResult = { summary: string; messages: Message[] }

// 子プロセスは、最後の行に結果か、エージェントとしての誤りを書く。どちらもない終わり方は、版が壊れているとみなす
export const RESULT = 'HYPH_RESULT '
export const ERROR = 'HYPH_ERROR '
export type WorkerError = { message: string; cost: boolean }
