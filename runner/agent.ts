import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import {
  type AssistantMessage,
  type Context,
  type Message as PiMessage,
  type Tool,
  type ToolCall,
  Type,
} from '@earendil-works/pi-ai'
import type { createModels } from '@earendil-works/pi-ai/models'
import type { Toolbox } from './tools'

const INSTRUCTIONS =
  'あなたは利用者と対話するエージェントです。日本語で簡潔に答えてください。必要に応じて、ツールで固有 DB・共有 DB・作業用ディレクトリのファイル・隔離環境でのコマンド実行を使ってください。Web の情報は web_search で調べられます。run_command の隔離環境からはネットワークに出られないため、Web には web_search を使ってください。ツールの結果の末尾には [step 番号｜コンテキスト約N文字] が付きます。読み終えた長い結果や行き止まりになった試行は、rewrite_context で後の判断に必要な事実と出典だけのメモに置き換え、コンテキストを短く保ってください。'
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

export type Models = ReturnType<typeof createModels>
export type Model = Parameters<Models['stream']>[0]
// openai-responses の reasoningEffort に渡せる値
export const REASONING = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const
export type Reasoning = (typeof REASONING)[number]
// ponytail: 1回の検索で返す抜粋は合計1万文字まで。足りなければ増やす
const SEARCH_CHARS = 10_000

// 1回の応答のうち、ツールを呼んだ1手（モデルの応答とツールの結果）。メモに置き換えた手は from〜to をまとめて持つ
export type Step = { from: number; to: number; messages: PiMessage[] }

// コンテキストのおおよその文字数。モデルが書き換えるかを判断する目安として見せる
const size = (messages: PiMessage[]) =>
  messages.reduce(
    (n, m) =>
      n +
      (typeof m.content === 'string'
        ? m.content.length
        : JSON.stringify(m.content).length),
    0,
  )

// CLM（Context Language Models, arXiv 2609.37725）にならい、モデルが作業中のコンテキストを書き換える。
// step from〜to を丸ごと1つのメモに置き換える。ツールの呼び出しと結果の組を壊さないよう、手の途中では切らない
export function rewriteSteps(
  steps: Step[],
  from: unknown,
  to: unknown,
  note: unknown,
  chars = 0,
): Step[] {
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    throw new Error('from と to に step の番号を指定してください')
  }
  const [a, b] = [from as number, to as number]
  if (typeof note !== 'string' || !note.trim()) {
    throw new Error('note に置き換え後のメモを指定してください')
  }
  const inside = steps.filter((s) => s.from >= a && s.to <= b)
  if (
    a > b ||
    !inside.length ||
    steps.some((s) => s.from <= b && s.to >= a && !inside.includes(s))
  ) {
    const ranges = steps
      .map((s) => (s.from === s.to ? `${s.from}` : `${s.from}〜${s.to}`))
      .join(', ')
    throw new Error(
      `step ${a}〜${b} は手の区切りに合いません。今ある step: ${ranges}`,
    )
  }
  const merged: Step = {
    from: inside[0].from,
    to: inside[inside.length - 1].to,
    messages: [
      {
        role: 'user',
        content: `[step ${inside[0].from}〜${inside[inside.length - 1].to} を自分で置き換えたメモ｜置き換え前のコンテキスト約${chars}文字]\n${note}`,
        timestamp: Date.now(),
      },
    ],
  }
  const at = steps.indexOf(inside[0])
  return [...steps.slice(0, at), merged, ...steps.slice(at + inside.length)]
}

// ツールを呼びながら回答を作る。本文の差分は届いたそばから onDelta に渡し、回答がそろってから記憶に残す
export async function respond({
  models,
  model,
  agent,
  toolbox,
  message,
  onDelta,
  onTool,
  onContext,
  reasoning,
  loop = false,
}: {
  models: Models
  model: Model
  agent: ReturnType<typeof openAgent>
  toolbox: Toolbox
  message: string
  onDelta: (delta: string) => void
  // ツールを呼ぶ直前に呼ぶ。進み具合を外に見せるために使う
  onTool?: (name: string, args: Record<string, unknown>) => void
  // モデルを呼ぶ直前に、渡すコンテキストのおおよその文字数を知らせる
  onContext?: (chars: number) => void
  // 未指定ならモデルの既定に任せる
  reasoning?: Reasoning
  // ループからの依頼。依頼文に状況がすべて入っているため、記憶から履歴を足さず、依頼文も記憶に残さない
  loop?: boolean
}) {
  const { instructions, messages } = loop
    ? {
        instructions: INSTRUCTIONS,
        messages: [{ role: 'user' as const, content: message }],
      }
    : agent.context(message)
  const context: Context = {
    systemPrompt: instructions,
    messages: messages.map((m) => toPiMessage(m, model)),
    tools: [...toolbox.definitions, webSearchTool, rewriteContextTool],
  }
  // 依頼文と履歴は書き換えさせず、ツールを呼んだ手だけを書き換えの対象にする
  const head = context.messages
  let steps: Step[] = []
  let text = ''
  for (let step = 1; step <= MAX_STEPS; step++) {
    onContext?.(size(context.messages))
    const events = models.stream(
      model,
      context,
      reasoning ? { reasoningEffort: reasoning } : undefined,
    )
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
    const calls = reply.content.filter(
      (block): block is ToolCall => block.type === 'toolCall',
    )
    if (!calls.length) {
      if (!loop) agent.remember('user', message)
      agent.remember('assistant', text)
      return text
    }
    const chars = size(context.messages) + size([reply])
    // 書き換えはこの手のツールをすべて終えてから、次にモデルを呼ぶ前に反映する。
    // 受け付けるかは、この手を足した後の区切りで先に確かめる
    let draft: Step[] = [...steps, { from: step, to: step, messages: [] }]
    const rewrites: Record<string, unknown>[] = []
    const results: PiMessage[] = []
    for (const call of calls) {
      // ツールの失敗はエラーの結果としてモデルに返し、モデルに直させる
      let output: string
      let isError = false
      try {
        onTool?.(call.name, call.arguments)
        if (call.name === rewriteContextTool.name) {
          const { from, to, note } = call.arguments
          draft = rewriteSteps(draft, from, to, note, chars)
          rewrites.push(call.arguments)
          output = `step ${from}〜${to} をメモに置き換えます。次の手から反映します`
        } else {
          output =
            call.name === webSearchTool.name
              ? await webSearch(call.arguments, model.id)
              : await toolbox.run(call.name, call.arguments)
        }
      } catch (e) {
        output = e instanceof Error ? e.message : String(e)
        isError = true
      }
      results.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: output }],
        isError,
        timestamp: Date.now(),
      })
    }
    const last = results[results.length - 1]
    if (last.role === 'toolResult') {
      last.content.push({
        type: 'text',
        text: `[step ${step}｜コンテキスト約${chars + size(results)}文字]`,
      })
    }
    steps.push({ from: step, to: step, messages: [reply, ...results] })
    for (const { from, to, note } of rewrites) {
      steps = rewriteSteps(steps, from, to, note, chars)
    }
    context.messages = [...head, ...steps.flatMap((s) => s.messages)]
  }
  throw new Error(`ツールの呼び出しが ${MAX_STEPS} 回を超えました`)
}

const webSearchTool: Tool = {
  name: 'web_search',
  description:
    'Web を検索し、関係するページの URL・タイトル・公開日・抜粋を返す。objective に調べたい目的を文章で、search_queries に3〜6語の検索語を1〜5個渡す',
  parameters: Type.Object({
    objective: Type.String({
      description: '調べたい目的。それだけで意味が通る文章にする',
    }),
    search_queries: Type.Array(Type.String(), {
      minItems: 1,
      maxItems: 5,
      description: '3〜6語の検索語。2〜3個がよい',
    }),
  }),
}

const rewriteContextTool: Tool = {
  name: 'rewrite_context',
  description:
    '今の作業のコンテキストのうち、step from から to までを note のメモに置き換える。置き換えた元の内容は消え、戻せない。依頼文と、ツールを呼ぶ前の履歴は置き換えられない',
  parameters: Type.Object({
    from: Type.Integer(),
    to: Type.Integer(),
    note: Type.String({
      description: '後の判断に必要な事実・決めたこと・出典',
    }),
  }),
}

// Parallel の Search API（https://docs.parallel.ai/api-reference/search/search）で調べ、
// 結果をツールの結果として返す。API キーは .env などの PARALLEL_API_KEY から読む
export async function webSearch(
  args: Record<string, unknown>,
  clientModel: string,
) {
  const key = process.env.PARALLEL_API_KEY
  if (!key) throw new Error('PARALLEL_API_KEY が設定されていません')
  const { objective, search_queries } = args
  if (typeof objective !== 'string' || !objective.trim()) {
    throw new Error('objective に調べたい目的を指定してください')
  }
  if (
    !Array.isArray(search_queries) ||
    !search_queries.length ||
    search_queries.length > 5 ||
    !search_queries.every((q) => typeof q === 'string' && q.trim())
  ) {
    throw new Error('search_queries に検索語の文字列を1〜5個指定してください')
  }
  const response = await fetch('https://api.parallel.ai/v1/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({
      objective,
      search_queries,
      max_chars_total: SEARCH_CHARS,
      client_model: clientModel,
    }),
  })
  if (!response.ok) {
    throw new Error(
      `Parallel の検索に失敗しました (${response.status}): ${await response.text()}`,
    )
  }
  const { results } = (await response.json()) as {
    results: {
      url: string
      title?: string | null
      publish_date?: string | null
      excerpts: string[]
    }[]
  }
  if (!results.length) return '見つかりませんでした'
  return results
    .map(
      (r) =>
        `## ${r.title ?? r.url}\n${r.url}${r.publish_date ? `（${r.publish_date}）` : ''}\n${r.excerpts.join('\n')}`,
    )
    .join('\n\n')
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
