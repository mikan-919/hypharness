import { DurableObject } from 'cloudflare:workers'
import { type Codex, complete, type Message } from './codex'
import { ftsQuery } from './lib'

export { Codex } from './codex'

const INSTRUCTIONS =
  'あなたは利用者と対話するエージェントです。日本語で簡潔に答えてください。'
const RECENT = 10
const RECALL = 5

type Memory = Message & { id: number; created_at: number }

// 1つのインスタンスが1体のエージェント。記憶はインスタンス専用の SQLite に置くため、エージェント間で混ざらない
export class Agent extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    )
    // 日本語は単語の区切りがないため、3文字単位で索引する trigram を使う
    ctx.storage.sql.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
        USING fts5(content, content='memories', content_rowid='id', tokenize='trigram')`,
    )
  }

  // userId は記憶の持ち主のアカウントで、そのアカウントの Codex でモデルを呼ぶ
  async chat(userId: string, message: string) {
    const sql = this.ctx.storage.sql
    const recent = sql
      .exec<Memory>('SELECT * FROM memories ORDER BY id DESC LIMIT ?', RECENT)
      .toArray()
      .reverse()
    // 直近の記憶は文脈にそのまま入るため、それより古い記憶から全文検索で引く
    const query = ftsQuery(message)
    const recalled =
      recent.length && query
        ? sql
            .exec<Memory>(
              `SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid
                WHERE memories_fts MATCH ? AND m.id < ?
                ORDER BY bm25(memories_fts) LIMIT ?`,
              query,
              recent[0].id,
              RECALL,
            )
            .toArray()
        : []

    const instructions = recalled.length
      ? `${INSTRUCTIONS}\n\n関連する過去の記憶:\n${recalled.map((m) => `- [${m.role}] ${m.content}`).join('\n')}`
      : INSTRUCTIONS
    const codex = (this.env.CODEX as DurableObjectNamespace<Codex>).getByName(
      userId,
    )
    const reply = await complete(codex, instructions, [
      ...recent.map(({ role, content }) => ({ role, content })),
      { role: 'user', content: message },
    ])

    this.remember('user', message)
    this.remember('assistant', reply)
    return reply
  }

  memories() {
    return this.ctx.storage.sql
      .exec<Memory>('SELECT * FROM memories ORDER BY id DESC LIMIT 100')
      .toArray()
  }

  private remember(role: Message['role'], content: string) {
    const { id } = this.ctx.storage.sql
      .exec<{ id: number }>(
        'INSERT INTO memories (role, content, created_at) VALUES (?, ?, ?) RETURNING id',
        role,
        content,
        Date.now(),
      )
      .one()
    this.ctx.storage.sql.exec(
      'INSERT INTO memories_fts (rowid, content) VALUES (?, ?)',
      id,
      content,
    )
  }
}
