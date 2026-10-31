import { Database } from 'bun:sqlite'
import { join } from 'node:path'

const INSTRUCTIONS =
  'あなたは利用者と対話するエージェントです。日本語で簡潔に答えてください。'
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
