// エージェントの会話の置き場。エージェントごとの SQLite に、モデルへ渡したメッセージを追記だけする
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Message, TextContent } from '@earendil-works/pi-ai'

// 保存先のルート。テストは HYPH_CTX_DIR で差し替える
export const root = () => process.env.HYPH_CTX_DIR || join(homedir(), '.hyph', 'ctx')

// メッセージの本文。文字列の content と、text の部分を順につなぐ
export function messageText(message: Message): string {
  const content = message.content
  if (typeof content === 'string') return content
  return content
    .filter((part): part is TextContent => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

// 検索の結果。message は本文と id と、そのメッセージを含む要約ノードの id を持つ
export type SearchResult = {
  messages: { id: number; text: string; summaries: number[] }[]
  summaries: { id: number; text: string }[]
}

export type Summary = { id: number; text: string; messageIds: number[] }

// 要約ノードの本文に入れる、1件のメッセージの本文の上限
const MAX_SUMMARY_PART = 500

// 文脈ファイルに入れる、生のまま残す直近のメッセージの件数
const CONTEXT_KEEP = 8

// エージェントの id ごとに1つのファイルを開き、追記と読み出しを返す
export function ctx(agent: string) {
  const dir = root()
  mkdirSync(dir, { recursive: true })
  const db = new Database(join(dir, `${agent}.sqlite`))
  // モデルが edit_context で書き換える文脈ファイル
  const filePath = join(dir, `${agent}.md`)
  db.run('CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL)')
  db.run(
    'CREATE TABLE IF NOT EXISTS summaries(id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, message_ids TEXT NOT NULL)',
  )
  const messagesWithIds = (): { id: number; message: Message }[] => {
    const rows = db.query('SELECT seq, message FROM messages ORDER BY seq').all() as { seq: number; message: string }[]
    return rows.map((row) => ({ id: row.seq, message: JSON.parse(row.message) as Message }))
  }
  const summaries = (): Summary[] => {
    const rows = db.query('SELECT id, text, message_ids FROM summaries ORDER BY id').all() as {
      id: number
      text: string
      message_ids: string
    }[]
    return rows.map((row) => ({ id: row.id, text: row.text, messageIds: JSON.parse(row.message_ids) as number[] }))
  }
  // 要約ノードを1件足し、その id を返す。元のメッセージは消さない
  const addSummary = (text: string, messageIds: number[]) => {
    const row = db
      .query('INSERT INTO summaries(text, message_ids) VALUES (?, ?) RETURNING id')
      .get(text, JSON.stringify(messageIds)) as { id: number }
    return row.id
  }
  // 文脈ファイルを組み立てて書き、そのパスを返す。中身は直近の生メッセージ（keep 件）と要約ノードの全部。
  // 最初の課題文（messages の先頭）は入れない
  const buildContextFile = (keep = CONTEXT_KEEP) => {
    const blocks: string[] = []
    for (const summary of summaries()) blocks.push(`## 要約 ${summary.id}\n\n${summary.text}`)
    const raw = messagesWithIds().slice(1).slice(-Math.max(0, Math.floor(keep)))
    for (const { id, message } of raw) blocks.push(`## 生 ${id}\n\n${messageText(message)}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(filePath, blocks.length > 0 ? `${blocks.join('\n\n')}\n` : '')
    return filePath
  }
  return {
    buildContextFile,
    append(message: Message) {
      db.query('INSERT INTO messages(message) VALUES (?)').run(JSON.stringify(message))
    },
    messages(): Message[] {
      const rows = db.query('SELECT message FROM messages ORDER BY seq').all() as { message: string }[]
      return rows.map((row) => JSON.parse(row.message) as Message)
    },
    // メッセージを id 付きで返す。id は messages 表の seq
    messagesWithIds,
    // 要約ノードを全部返す
    summaries,
    // 要約ノードを1件足し、その id を返す。元のメッセージは消さない
    addSummary,
    // まだどの要約ノードにも入っていないメッセージのうち、直近 keep 件より前のものを1つの要約ノードにまとめる。
    // まとめる対象が無ければ何も足さず undefined を返す。本文は1件あたり 500 文字で切って順につなぐ
    summarizeOld(keep = 8) {
      const all = messagesWithIds()
      const claimed = new Set(summaries().flatMap((s) => s.messageIds))
      const older = all.slice(0, Math.max(0, all.length - keep)).filter((m) => !claimed.has(m.id))
      if (older.length === 0) return undefined
      const text = older.map((m) => messageText(m.message).slice(0, MAX_SUMMARY_PART)).join('\n')
      return addSummary(
        text,
        older.map((m) => m.id),
      )
    },
    // 要約ノードを id で引く
    summary(id: number): Summary | undefined {
      return summaries().find((s) => s.id === id)
    },
    // メッセージの本文と要約ノードの本文を語で照合する。max_results は合わせて返す件数の上限（既定 5）
    search(query: string, maxResults = 5): SearchResult {
      const words = query
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 0)
      const limit = Number.isFinite(maxResults) && maxResults > 0 ? Math.floor(maxResults) : 0
      const found: SearchResult = { messages: [], summaries: [] }
      if (words.length === 0 || limit === 0) return found
      const hit = (text: string) => words.some((word) => text.toLowerCase().includes(word))
      const all = summaries()
      for (const { id, message } of messagesWithIds()) {
        if (found.messages.length + found.summaries.length >= limit) return found
        const text = messageText(message)
        if (!hit(text)) continue
        found.messages.push({
          id,
          text,
          summaries: all.filter((s) => s.messageIds.includes(id)).map((s) => s.id),
        })
      }
      for (const summary of all) {
        if (found.messages.length + found.summaries.length >= limit) return found
        if (hit(summary.text)) found.summaries.push({ id: summary.id, text: summary.text })
      }
      return found
    },
  }
}

// 文脈ファイルを読み、old が1回だけ現れるときその1箇所を next に置き換え、置き換えた後の本文を
// 新しい要約ノードとして保存し、文脈ファイルも書き直す。変えられないときは理由を返す。元のメッセージは消さない
export function editContext(agent: string, old: string, next: string) {
  const store = ctx(agent)
  if (next === '') return 'new が空文字のため、文脈ファイルを変えませんでした。空にする編集はできません。'
  if (old === '') return 'old が空文字のため、文脈ファイルを変えませんでした。'
  const path = join(root(), `${agent}.md`)
  if (!existsSync(path)) store.buildContextFile()
  const text = readFileSync(path, 'utf8')
  const first = text.indexOf(old)
  if (first < 0) return `old が文脈ファイルに1回も現れないため、変えませんでした: ${old}`
  if (text.indexOf(old, first + old.length) >= 0) {
    return `old が文脈ファイルに2回以上現れるため、変えませんでした: ${old}`
  }
  const edited = text.slice(0, first) + next + text.slice(first + old.length)
  const id = store.addSummary(edited, [])
  writeFileSync(path, edited)
  return `要約ノード ${id} として保存し、文脈ファイルを書き換えました。`
}
