// 原文保存（LCM）と作業文脈の圧縮（CLM + TokenPilot）。隔離環境で動くため、bun の組み込みだけを使う
import { Database } from 'bun:sqlite'
import type { Message } from '@earendil-works/pi-ai'

// 会話とコマンドの出力を、追記だけで残す。日本語は単語の区切りがないため、FTS5 の trigram（3文字単位）で索引する
export function openRaw(path = ':memory:') {
  const db = new Database(path)
  db.run(
    'CREATE TABLE raw (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL)',
  )
  db.run(
    "CREATE VIRTUAL TABLE raw_fts USING fts5(text, content='raw', content_rowid='id', tokenize='trigram')",
  )
  return {
    add(kind: string, text: string) {
      const id = Number(
        db.query('INSERT INTO raw (kind, text) VALUES (?, ?)').run(kind, text)
          .lastInsertRowid,
      )
      db.query('INSERT INTO raw_fts (rowid, text) VALUES (?, ?)').run(id, text)
      return id
    },
    get(id: number) {
      return db
        .query<{ kind: string; text: string }, [number]>(
          'SELECT kind, text FROM raw WHERE id = ?',
        )
        .get(id)
    },
    // trigram は3文字未満の語を索引で引けないため、そのときは部分一致で探す
    search(query: string, limit = 5) {
      const rows =
        query.length >= 3
          ? db
              .query<
                { id: number; kind: string; text: string },
                [string, number]
              >(
                'SELECT r.id, r.kind, r.text FROM raw_fts f JOIN raw r ON r.id = f.rowid WHERE raw_fts MATCH ? ORDER BY r.id DESC LIMIT ?',
              )
              .all(`"${query.replaceAll('"', '""')}"`, limit)
          : db
              .query<
                { id: number; kind: string; text: string },
                [string, number]
              >(
                'SELECT id, kind, text FROM raw WHERE instr(text, ?) > 0 ORDER BY id DESC LIMIT ?',
              )
              .all(query, limit)
      return rows.map(({ id, kind, text }) => {
        const at = Math.max(0, text.indexOf(query) - 150)
        return { id, kind, excerpt: text.slice(at, at + 400) }
      })
    },
  }
}

// 入力のトークン量が予算を超えたら、直近 keep 件を除くツールの結果を、原文の番号つきの短い参照に置き換える。
// 置き換えると接頭辞キャッシュが置き換えた位置から外れるため、少しずつではなく、超えたときにまとめて置き換える。
// ツールの呼び出しと結果の対応は残す（結果を消すと API が呼び出しに対応する結果がないと断る）
export function compact(
  messages: Message[],
  refs: Map<string, number>,
  keep: number,
) {
  const results = messages.filter((m) => m.role === 'toolResult')
  let changed = 0
  for (const m of results.slice(0, Math.max(0, results.length - keep))) {
    const id = refs.get(m.toolCallId)
    if (id === undefined) continue
    const text = m.content
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('')
    m.content = [
      {
        type: 'text',
        text: `（出力は原文 #${id} に保存済み。expand で戻せる。先頭: ${text.slice(0, 200)}）`,
      },
    ]
    refs.delete(m.toolCallId)
    changed++
  }
  return changed
}
