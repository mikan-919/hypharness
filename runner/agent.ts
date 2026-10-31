import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import type {
  AssistantMessage,
  Context,
  Message as PiMessage,
  ToolCall,
} from '@earendil-works/pi-ai'
import type { createModels } from '@earendil-works/pi-ai/models'
import { type Toolbox, toolDefinitions } from './tools'

const INSTRUCTIONS =
  'あなたは利用者と対話するエージェントです。日本語で簡潔に答えてください。必要に応じて、ツールで固有 DB・共有 DB・作業用ディレクトリのファイルを使ってください。'
const MAX_STEPS = 8
const RECENT = 10
const RECALL = 5

export type Message = { role: 'user' | 'assistant'; content: string }
type Memory = Message & { id: number; created_at: number }

// trigram トークナイザー向けに、本文の3文字ずつの断片を OR でつないだ検索式を作る
// 記号と空白は FTS5 の構文と衝突するため除く
export function ftsQuery(text: string, limit = 64) {
  const chars = [...text.replace(/[\s\p{P}\p{S}]+/gu, '')]
  const grams = new Set<string>()
  for (let i = 0; i + 3 <= chars.length && grams.size < limit; i++) {
    grams.add(chars.slice(i, i + 3).join(''))
  }
  return [...grams].map((gram) => `"${gram}"`).join(' OR ')
}

// 1体のエージェントの記憶。エージェントごとに SQLite のファイルを分け、記憶が混ざらないようにする
export function openAgent(dir: string, name: string) {
  // 名前はファイル名になるため、ディレクトリの外を指せない文字に限る
  if (!/^[\w-]{1,32}$/.test(name)) {
    throw new Error(`エージェント名が不正です: ${name}`)
  }
  const db = new Database(join(dir, `${name}.sqlite`), { strict: true })
  db.run('PRAGMA journal_mode = WAL')
  db.run(`CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`)
  // 日本語は単語の区切りがないため、3文字単位で索引する trigram を使う
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
    USING fts5(content, content='memories', content_rowid='id', tokenize='trigram')`)

  const insert = db.transaction((role: Message['role'], content: string) => {
    const { id } = db
      .query<{ id: number }, [string, string, number]>(
        'INSERT INTO memories (role, content, created_at) VALUES (?, ?, ?) RETURNING id',
      )
      .get(role, content, Date.now()) as { id: number }
    db.query('INSERT INTO memories_fts (rowid, content) VALUES (?, ?)').run(
      id,
      content,
    )
  })

  return {
    db,
    // モデルに渡す指示と会話を組み立てる。直近の記憶はそのまま渡し、それより古い記憶から全文検索で引く
    context(message: string) {
      const recent = db
        .query<Memory, [number]>(
          'SELECT * FROM memories ORDER BY id DESC LIMIT ?',
        )
        .all(RECENT)
        .reverse()
      const query = ftsQuery(message)
      const recalled =
        recent.length && query
          ? db
              .query<Memory, [string, number, number]>(
                `SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid
                  WHERE memories_fts MATCH ? AND m.id < ?
                  ORDER BY bm25(memories_fts) LIMIT ?`,
              )
              .all(query, recent[0].id, RECALL)
          : []
      const instructions = recalled.length
        ? `${INSTRUCTIONS}\n\n関連する過去の記憶:\n${recalled.map((m) => `- [${m.role}] ${m.content}`).join('\n')}`
        : INSTRUCTIONS
      const messages: Message[] = [
        ...recent.map(({ role, content }) => ({ role, content })),
        { role: 'user', content: message },
      ]
      return { instructions, messages }
    },

    remember(role: Message['role'], content: string) {
      insert(role, content)
    },
  }
}

type Models = ReturnType<typeof createModels>
type Model = Parameters<Models['stream']>[0]

// ツールを呼びながら回答を作る。本文の差分は届いたそばから onDelta に渡し、回答がそろってから記憶に残す
export async function respond({
  models,
  model,
  agent,
  toolbox,
  message,
  onDelta,
}: {
  models: Models
  model: Model
  agent: ReturnType<typeof openAgent>
  toolbox: Toolbox
  message: string
  onDelta: (delta: string) => void
}) {
  const { instructions, messages } = agent.context(message)
  const context: Context = {
    systemPrompt: instructions,
    messages: messages.map((m) => toPiMessage(m, model)),
    tools: toolDefinitions,
  }
  let text = ''
  for (let step = 0; step < MAX_STEPS; step++) {
    const events = models.stream(model, context)
    for await (const event of events) {
      if (event.type === 'text_delta') {
        text += event.delta
        onDelta(event.delta)
      }
      if (event.type === 'error') {
        throw new Error(event.error.errorMessage ?? event.reason)
      }
    }
    const reply = await events.result()
    context.messages.push(reply)
    const calls = reply.content.filter(
      (block): block is ToolCall => block.type === 'toolCall',
    )
    if (!calls.length) {
      agent.remember('user', message)
      agent.remember('assistant', text)
      return text
    }
    for (const call of calls) {
      // ツールの失敗はエラーの結果としてモデルに返し、モデルに直させる
      let output: string
      let isError = false
      try {
        output = await toolbox.run(call.name, call.arguments)
      } catch (e) {
        output = e instanceof Error ? e.message : String(e)
        isError = true
      }
      context.messages.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: output }],
        isError,
        timestamp: Date.now(),
      })
    }
  }
  throw new Error(`ツールの呼び出しが ${MAX_STEPS} 回を超えました`)
}

// 記憶には応答の本文だけを残しているため、本文だけの応答として渡す
function toPiMessage(
  message: Message,
  model: { api: AssistantMessage['api']; provider: string; id: string },
): PiMessage {
  if (message.role === 'user') {
    return { role: 'user', content: message.content, timestamp: Date.now() }
  }
  return {
    role: 'assistant',
    content: [{ type: 'text', text: message.content }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}
