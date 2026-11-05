// 永続記憶（LCM + DeLM）と作業文脈の圧縮（TokenPilot）。隔離環境で動くため、bun の組み込みだけを使う
import { Database } from 'bun:sqlite'
import type { Message } from '@earendil-works/pi-ai'

export type Scope = 'self' | 'shared'
export type Entry = {
  id: number
  scope: Scope
  gist: string
  summary: string
  score: number
}
// 参照関係: task は同じ課題で作った、cause は原因と結果、depend は前提
export type LinkKind = 'task' | 'cause' | 'depend'

// ponytail: 重複とみなす要旨の3文字組の一致率。誤って統合する例が出たら上げる
const DUPLICATE = 0.6
// 評価が下がった記憶は消す。採用された方針が3回続けて失敗に関わったら外す
const DROP_SCORE = -3

const trigrams = (s: string) => {
  const t = new Set<string>()
  for (let i = 0; i + 3 <= s.length; i++) t.add(s.slice(i, i + 3))
  return t
}
export const similarity = (a: string, b: string) => {
  const x = trigrams(a)
  const y = trigrams(b)
  if (!x.size || !y.size) return a === b ? 1 : 0
  let both = 0
  for (const t of x) if (y.has(t)) both++
  return both / (x.size + y.size - both)
}
// FTS5 の照合式で、利用者の文字列を1つの語句として扱う
const phrase = (q: string) => `"${q.replaceAll('"', '""')}"`

// 会話とコマンドの出力（原文）を追記だけで残し、原文から根拠を引用した記憶を持つ。
// 日本語は単語の区切りがないため、FTS5 の trigram（3文字単位）で索引する。path を /state に置くと、課題をまたいで残る
export function openMemory(path = ':memory:') {
  const db = new Database(path)
  db.run('PRAGMA journal_mode = WAL')
  db.run(
    `CREATE TABLE IF NOT EXISTS raw (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, task TEXT NOT NULL DEFAULT '')`,
  )
  db.run(`CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, scope TEXT NOT NULL, gist TEXT NOT NULL,
    summary TEXT NOT NULL, score INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL)`)
  db.run(
    "CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(gist, summary, content='entries', content_rowid='id', tokenize='trigram')",
  )
  // 記憶の根拠になった原文
  db.run(
    'CREATE TABLE IF NOT EXISTS sources (entry INTEGER NOT NULL, raw INTEGER NOT NULL, PRIMARY KEY (entry, raw))',
  )
  db.run(
    'CREATE TABLE IF NOT EXISTS links (src INTEGER NOT NULL, dst INTEGER NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (src, dst, kind))',
  )
  const index = (id: number, gist: string, summary: string) =>
    db
      .query('INSERT INTO entries_fts (rowid, gist, summary) VALUES (?, ?, ?)')
      .run(id, gist, summary)
  const unindex = (e: { id: number; gist: string; summary: string }) =>
    db
      .query(
        "INSERT INTO entries_fts (entries_fts, rowid, gist, summary) VALUES ('delete', ?, ?, ?)",
      )
      .run(e.id, e.gist, e.summary)
  const entry = (id: number) =>
    db
      .query<Entry, [number]>(
        'SELECT id, scope, gist, summary, score FROM entries WHERE id = ?',
      )
      .get(id)

  const memory = {
    add(kind: string, text: string, task = '') {
      const id = Number(
        db
          .query('INSERT INTO raw (kind, text, task) VALUES (?, ?, ?)')
          .run(kind, text, task).lastInsertRowid,
      )
      return id
    },
    get(id: number) {
      return db
        .query<{ kind: string; text: string }, [number]>(
          'SELECT kind, text FROM raw WHERE id = ?',
        )
        .get(id)
    },
    // 記憶を Gist（1行の要旨）・Summary（要約）・Raw（原文の番号）の3段で残す。Summary の根拠として、原文に
    // そのまま含まれる引用を1つ以上求め、機械で確かめる。要旨がほぼ同じ記憶があれば、新しく作らずにそこへ統合する
    remember(input: {
      scope: Scope
      gist: string
      summary: string
      quotes: { raw: number; text: string }[]
      links?: { to: number; kind: LinkKind }[]
    }) {
      if (input.scope !== 'self' && input.scope !== 'shared') {
        throw new Error('scope は self か shared です')
      }
      if (!input.gist.trim() || !input.summary.trim()) {
        throw new Error('gist と summary は空にできません')
      }
      if (!input.quotes.length) throw new Error('原文からの引用が要ります')
      for (const q of input.quotes) {
        const source = memory.get(q.raw)
        if (!source) throw new Error(`原文 #${q.raw} はありません`)
        if (!q.text.trim() || !source.text.includes(q.text)) {
          throw new Error(`引用が原文 #${q.raw} に含まれていません: ${q.text}`)
        }
      }
      const same = memory
        .entries(input.gist, 10)
        .find(
          (e) =>
            e.scope === input.scope &&
            similarity(e.gist, input.gist) >= DUPLICATE,
        )
      let id: number
      if (same) {
        id = same.id
        const summary = same.summary.includes(input.summary)
          ? same.summary
          : `${same.summary}\n${input.summary}`
        unindex(same)
        db.query('UPDATE entries SET summary = ? WHERE id = ?').run(summary, id)
        index(id, same.gist, summary)
      } else {
        id = Number(
          db
            .query(
              'INSERT INTO entries (scope, gist, summary, created) VALUES (?, ?, ?, ?)',
            )
            .run(input.scope, input.gist, input.summary, Date.now())
            .lastInsertRowid,
        )
        index(id, input.gist, input.summary)
      }
      for (const q of input.quotes) {
        db.query('INSERT OR IGNORE INTO sources VALUES (?, ?)').run(id, q.raw)
      }
      for (const l of input.links ?? []) memory.link(id, l.to, l.kind)
      return { id, merged: Boolean(same) }
    },
    link(src: number, dst: number, kind: LinkKind) {
      if (!['task', 'cause', 'depend'].includes(kind)) {
        throw new Error(`参照の種類が不正です: ${kind}`)
      }
      if (src === dst || !entry(src) || !entry(dst)) return
      db.query('INSERT OR IGNORE INTO links VALUES (?, ?, ?)').run(
        src,
        dst,
        kind,
      )
    },
    // 関連する記憶を選ぶ。全文検索の一致の順位に、参照関係の多さ（つながりの多い記憶ほど他の記憶の前提になっている）と、
    // 実際の課題の成否で付けた評価を足して並べる。検索で当たった記憶から参照をたどった記憶も候補に入れる
    entries(query: string, limit = 5): Entry[] {
      const hits =
        query.length >= 3
          ? db
              .query<{ id: number; rank: number }, [string]>(
                'SELECT rowid AS id, rank FROM entries_fts WHERE entries_fts MATCH ? ORDER BY rank LIMIT 50',
              )
              // 語句の完全一致ではなく3文字組の OR で引き、一致の多い順に並べる。課題文のような長い文や、
              // 句読点だけ違う要旨（重複の検出）でも当たるようにするため
              .all([...trigrams(query)].slice(0, 200).map(phrase).join(' OR '))
          : db
              .query<{ id: number; rank: number }, [string, string]>(
                'SELECT id, 0 AS rank FROM entries WHERE instr(gist, ?) > 0 OR instr(summary, ?) > 0 ORDER BY id DESC LIMIT 50',
              )
              .all(query, query)
      const scores = new Map<number, number>()
      hits.forEach((h, i) => {
        scores.set(h.id, (scores.get(h.id) ?? 0) + (hits.length - i))
      })
      for (const id of [...scores.keys()]) {
        for (const n of db
          .query<{ id: number }, [number, number]>(
            'SELECT dst AS id FROM links WHERE src = ? UNION SELECT src FROM links WHERE dst = ?',
          )
          .all(id, id)) {
          scores.set(n.id, (scores.get(n.id) ?? 0) + 1)
        }
      }
      const found = [...scores]
        .map(([id, s]) => ({ e: entry(id), s }))
        .filter((x): x is { e: Entry; s: number } => Boolean(x.e))
        .map(({ e, s }) => ({ e, s: s + e.score * 2 }))
      found.sort((a, b) => b.s - a.s)
      return found.slice(0, limit).map((x) => x.e)
    },
    // 課題の成否を、その課題で使った記憶と作った記憶の評価に反映する（オンライン RSI の局所検証）。
    // 成功で上げ、失敗で下げる。費用が基準より高かった成功は上げない。評価が下がりきった記憶は棄却する
    judge(ids: number[], ok: boolean, cheap: boolean) {
      const delta = ok ? (cheap ? 1 : 0) : -1
      for (const id of new Set(ids)) {
        db.query(
          'UPDATE entries SET score = score + ?, used = used + 1 WHERE id = ?',
        ).run(delta, id)
      }
      const dropped = db
        .query<Entry, [number]>(
          'SELECT id, scope, gist, summary, score FROM entries WHERE score <= ?',
        )
        .all(DROP_SCORE)
      for (const e of dropped) {
        unindex(e)
        db.query('DELETE FROM entries WHERE id = ?').run(e.id)
        db.query('DELETE FROM sources WHERE entry = ?').run(e.id)
        db.query('DELETE FROM links WHERE src = ? OR dst = ?').run(e.id, e.id)
      }
      return dropped.length
    },
    entry,
  }
  return memory
}
export type Memory = ReturnType<typeof openMemory>

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
    if (stub(m, refs)) changed++
  }
  return changed
}

// 1つのツールの結果を、原文の番号つきの参照に置き換える。原文に保存していない結果は置き換えない（原文の保護）
function stub(m: Message, refs: Map<string, number>) {
  if (m.role !== 'toolResult') return false
  const id = refs.get(m.toolCallId)
  if (id === undefined) return false
  const text = m.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
  m.content = [
    {
      type: 'text',
      text: `（出力は原文 #${id} に保存済み。expand で戻せる。先頭: ${text.slice(0, 200)}）`,
    },
  ]
  refs.delete(m.toolCallId)
  return true
}
