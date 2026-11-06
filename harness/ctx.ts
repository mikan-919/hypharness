// エージェントの会話の置き場。エージェントごとの SQLite に、モデルへ渡したメッセージを追記だけする
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@earendil-works/pi-ai'

// 保存先のルート。テストは HYPH_CTX_DIR で差し替える
export const root = () => process.env.HYPH_CTX_DIR || join(homedir(), '.hyph', 'ctx')

// エージェントの id ごとに1つのファイルを開き、追記と読み出しを返す
export function ctx(agent: string) {
  const dir = root()
  mkdirSync(dir, { recursive: true })
  const db = new Database(join(dir, `${agent}.sqlite`))
  db.run('CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL)')
  return {
    append(message: Message) {
      db.query('INSERT INTO messages(message) VALUES (?)').run(JSON.stringify(message))
    },
    messages(): Message[] {
      const rows = db.query('SELECT message FROM messages ORDER BY seq').all() as { message: string }[]
      return rows.map((row) => JSON.parse(row.message) as Message)
    },
  }
}
