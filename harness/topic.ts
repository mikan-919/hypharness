// 論点エージェント。中継を通してモデルを呼び、利用者に1問ずつ聞いて最終目的を詰める（ADR 0003、0012）
import { readdir } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import type { AssistantMessage, Context, Message, Tool, ToolCall } from '@earendil-works/pi-ai'
import type { Store } from './store.ts'

export type Call = (body: { topicId: string; taskId: string; context: Context }) => Promise<AssistantMessage>

// 中継の Unix ソケットを呼び、流れてくるイベントの最後（done か error）の応答を返す
export const relayCall =
  (socket: string): Call =>
  async (body) => {
    const response = await fetch('http://relay/', { unix: socket, method: 'POST', body: JSON.stringify(body) })
    if (!response.ok) throw new Error(((await response.json()) as { error: string }).error)
    const last = JSON.parse((await response.text()).trim().split('\n').at(-1) ?? '{}')
    if (last.type === 'error') throw new Error(last.error.errorMessage ?? 'モデルの呼び出しに失敗しました')
    return last.message
  }

const SYSTEM = `あなたは hypharness の論点エージェントです。利用者と対話して、利用者が作りたいもの（最終目的）を、課題に分けられるところまで具体的にします。

- 利用者への質問は ask ツールで1度に1問だけ出す。選択肢を2〜4個付け、推奨する1つを示し、推奨の理由を書く。
- リポジトリを読めば答えが分かることは、list_files と read_file で調べ、利用者に聞かない。
- 決まったことは record ツールで kind を done にして残す。根拠（利用者の答えか、ファイルの場所）を evidence に書く。調べて分かった事実は fact、捨てた案は fail で残す。
- 最終目的が課題に分けられるところまで決まったら ready を呼んで終える。
- 日本語で書く。修飾表現を使わず、事実を書く。`

const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required })

const TOOLS = [
  {
    name: 'ask',
    description: '利用者に1問聞き、答えを受け取る',
    parameters: object(
      {
        text: { type: 'string' },
        options: {
          type: 'array',
          items: object(
            { label: { type: 'string' }, description: { type: 'string' }, recommended: { type: 'boolean' } },
            ['label', 'description', 'recommended'],
          ),
        },
        recommendation: { type: 'string', description: '推奨の理由' },
      },
      ['text', 'options', 'recommendation'],
    ),
  },
  {
    name: 'record',
    description: '共有文脈に項目を追記する',
    parameters: object(
      { kind: { type: 'string', enum: ['fact', 'fail', 'done'] }, text: { type: 'string' }, evidence: { type: 'string' } },
      ['kind', 'text', 'evidence'],
    ),
  },
  {
    name: 'list_files',
    description: 'リポジトリのディレクトリの中身を返す',
    parameters: object({ path: { type: 'string', description: 'リポジトリの根からの相対パス' } }, ['path']),
  },
  {
    name: 'read_file',
    description: 'リポジトリのファイルを読む',
    parameters: object({ path: { type: 'string', description: 'リポジトリの根からの相対パス' } }, ['path']),
  },
  { name: 'ready', description: '最終目的が課題に分けられるところまで決まったときに呼ぶ', parameters: object({}, []) },
] as Tool[]

// ponytail: 1ファイルは先頭の 20,000 文字まで。長いファイルを読む必要が出たら範囲の指定を足す
const MAX_FILE = 20_000

// リポジトリの外を読ませない
function inside(repo: string, path: unknown) {
  const full = resolve(repo, String(path ?? '.'))
  if (relative(repo, full).startsWith('..')) throw new Error(`リポジトリの外です: ${path}`)
  return full
}

async function run(store: Store, topicId: string, repo: string, call: ToolCall) {
  const a = call.arguments as Record<string, any>
  if (call.name === 'ask') {
    const answer = await store.ask({ topicId, text: a.text, options: a.options ?? [], recommendation: a.recommendation })
    return `利用者の答え: ${answer}`
  }
  if (call.name === 'record') {
    store.record({ topicId, kind: a.kind, text: a.text, evidence: a.evidence })
    return '追記した'
  }
  if (call.name === 'list_files') {
    const entries = await readdir(inside(repo, a.path), { withFileTypes: true })
    return entries
      .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .join('\n')
  }
  if (call.name === 'read_file') return (await Bun.file(inside(repo, a.path)).text()).slice(0, MAX_FILE)
  throw new Error(`未知のツールです: ${call.name}`)
}

export async function runTopic(store: Store, call: Call, topicId: string, repo: string, goal: string) {
  const messages: Message[] = [{ role: 'user', content: `最終目的の出発点: ${goal}`, timestamp: Date.now() }]
  store.setTopic(topicId, { state: 'researching' })
  try {
    while (true) {
      // ponytail: 対話は1つの課題として費用の上限を受ける。論点が増えたら論点ごとに分ける
      const reply = await call({ topicId, taskId: 'dialog', context: { systemPrompt: SYSTEM, messages, tools: TOOLS } })
      messages.push(reply)
      const calls = reply.content.filter((c): c is ToolCall => c.type === 'toolCall')
      if (calls.length === 0) {
        messages.push({ role: 'user', content: 'ツールで質問するか、ready を呼んでください。', timestamp: Date.now() })
        continue
      }
      for (const toolCall of calls) {
        if (toolCall.name === 'ready') {
          store.setTopic(topicId, { state: 'ready', ready: true })
          return
        }
        if (toolCall.name === 'ask') store.setTopic(topicId, { state: 'asking' })
        const result = await run(store, topicId, repo, toolCall).then(
          (text) => ({ text, isError: false }),
          (e: Error) => ({ text: e.message, isError: true }),
        )
        store.setTopic(topicId, { state: 'researching' })
        messages.push({
          role: 'toolResult',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: 'text', text: result.text }],
          isError: result.isError,
          timestamp: Date.now(),
        })
      }
    }
  } catch (e) {
    store.record({ topicId, kind: 'fail', text: (e as Error).message, evidence: '中継' })
    store.setTopic(topicId, { state: 'blocked' })
  }
}
