import type { Database } from 'bun:sqlite'
import { Type } from '@earendil-works/pi-ai'
import type { RoleTool } from './tools'

const GIST_LIMIT = 200
const QUOTE_MIN = 5
// ponytail: プロンプトに入れる Gist は新しい順に50件まで。増えたら要約や選別を考える
const LISTED = 50

// 1件のエントリーは3段で持つ。プロンプトには Gist だけを入れ、Summary と Raw は必要なときに展開する
export type Entry = {
  label: string
  gist: string
  summary: string
  raw: string
  source: string
}
type Input = { gist: unknown; summary: unknown; raw?: unknown; file?: unknown }

const ENTRY_COLUMNS = `gist TEXT NOT NULL,
  summary TEXT NOT NULL,
  raw TEXT NOT NULL,
  source TEXT NOT NULL`

// Summary の各行（- で始まる）が、Raw にそのまま含まれる引用「…」を持つか確かめる。
// 引用で根拠を示させることで、要約が原文から離れた主張を混ぜていないかを機械的に確かめられる
export function checkSummary(summary: string, raw: string) {
  const normalize = (s: string) => s.replace(/\s+/g, ' ')
  const source = normalize(raw)
  const bullets = summary
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('-'))
  if (!bullets.length) return ['Summary は「- 」で始まる箇条書きにしてください']
  return bullets.flatMap((bullet) => {
    const quotes = [...bullet.matchAll(/「([^」]+)」/g)].map((m) => m[1])
    if (!quotes.length) return [`引用「…」がありません: ${bullet}`]
    return quotes
      .filter((q) => q.length < QUOTE_MIN || !source.includes(normalize(q)))
      .map(
        (q) => `引用が原文に見つからないか、${QUOTE_MIN}文字未満です: 「${q}」`,
      )
  })
}

// 共有コンテキストと、受け渡し中のエントリーを経済の DB に、自分用コンテキストを固有 DB に置く
export function openContexts(shared: Database) {
  shared.run(`CREATE TABLE IF NOT EXISTS shared_entries (
      id INTEGER PRIMARY KEY,
      ${ENTRY_COLUMNS}
    );
    CREATE TABLE IF NOT EXISTS gifts (
      id INTEGER PRIMARY KEY,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      ${ENTRY_COLUMNS},
      status TEXT NOT NULL DEFAULT 'pending'
    );`)
  const own = (db: Database) => {
    db.run(`CREATE TABLE IF NOT EXISTS context_entries (
      id INTEGER PRIMARY KEY,
      ${ENTRY_COLUMNS}
    )`)
    return db
  }
  const list = (db: Database, table: string, prefix: string) =>
    db
      .query<Omit<Entry, 'label'> & { id: number }, [number]>(
        `SELECT * FROM ${table} ORDER BY id DESC LIMIT ?`,
      )
      .all(LISTED)
      .reverse()
      .map(({ id, ...e }) => ({ label: `${prefix}${id}`, ...e }))
  const insert = (db: Database, table: string, e: Omit<Entry, 'label'>) =>
    db
      .query<{ id: number }, [string, string, string, string]>(
        `INSERT INTO ${table} (gist, summary, raw, source) VALUES (?, ?, ?, ?) RETURNING id`,
      )
      .get(e.gist, e.summary, e.raw, e.source)?.id as number

  // ラベルの S は共有、O は自分用。どちらも同じ展開のツールで読める
  const find = (ownDb: Database, label: string) => {
    const match = /^([SO])(\d+)$/.exec(label)
    if (!match) return null
    const [db, table] =
      match[1] === 'S'
        ? [shared, 'shared_entries']
        : [own(ownDb), 'context_entries']
    const row = db
      .query<Omit<Entry, 'label'>, [number]>(
        `SELECT gist, summary, raw, source FROM ${table} WHERE id = ?`,
      )
      .get(Number(match[2]))
    return row ? { label, ...row } : null
  }

  return {
    sharedEntries: () => list(shared, 'shared_entries', 'S'),
    sharedEntry: (label: string) =>
      /^S\d+$/.test(label) ? find(shared, label) : null,
    ownEntries: (ownDb: Database) => list(own(ownDb), 'context_entries', 'O'),
    pendingGifts: (agent: string) =>
      shared
        .query<{ id: number; from_agent: string; gist: string }, [string]>(
          "SELECT id, from_agent, gist FROM gifts WHERE to_agent = ? AND status = 'pending' ORDER BY id",
        )
        .all(agent),

    // プロンプトに入れる2層のコンテキスト。どちらも Gist だけを並べる
    prompt(ownDb: Database) {
      const lines = (entries: Entry[]) =>
        entries.map((e) => `- [${e.label}] ${e.gist}`).join('\n') ||
        '（ありません）'
      return `共有コンテキスト（全員が読む。詳細は unfold、原文は deep_unfold）:
${lines(this.sharedEntries())}
自分用コンテキスト（あなただけが読む）:
${lines(this.ownEntries(ownDb))}`
    },

    // agent はツールを使うエージェントの名前、canGive は受け渡しの相手として正しいかを確かめる
    tools(
      agent: string,
      ownDb: Database,
      readFile: (path: string) => Promise<string>,
      canGive: (to: string) => boolean,
    ): RoleTool[] {
      const entry = async (input: Input): Promise<Omit<Entry, 'label'>> => {
        if (typeof input.gist !== 'string' || !input.gist.trim()) {
          throw new Error('gist に文字列を指定してください')
        }
        if (input.gist.length > GIST_LIMIT) {
          throw new Error(`gist は ${GIST_LIMIT} 文字以内にしてください`)
        }
        if (typeof input.summary !== 'string') {
          throw new Error('summary に文字列を指定してください')
        }
        const file = typeof input.file === 'string' ? input.file : null
        const raw = file
          ? await readFile(file)
          : typeof input.raw === 'string'
            ? input.raw
            : ''
        if (!raw.trim()) throw new Error('raw か file で原文を指定してください')
        const errors = checkSummary(input.summary, raw)
        if (errors.length) throw new Error(errors.join('\n'))
        return {
          gist: input.gist,
          summary: input.summary,
          // ファイルは原文のパスだけを持ち、展開のときに読み直す
          raw: file ? `file:${file}` : raw,
          source: agent,
        }
      }
      const resolve = (label: unknown) => {
        if (typeof label !== 'string')
          throw new Error('labels は文字列の配列です')
        const found = find(ownDb, label)
        // 他人の自分用コンテキストは読めない。O のラベルは自分の固有 DB だけを探す
        if (!found) throw new Error(`${label} というエントリーはありません`)
        return found
      }
      const labels = (value: unknown) => {
        if (!Array.isArray(value) || !value.length) {
          throw new Error('labels にラベルの配列を指定してください')
        }
        return value.map(resolve)
      }
      const rawOf = async (e: Entry) =>
        e.raw.startsWith('file:')
          ? readFile(e.raw.slice('file:'.length))
          : e.raw

      return [
        {
          definition: {
            name: 'context_add',
            description: `コンテキストにエントリーを足す。gist は${GIST_LIMIT}文字以内の要約、summary は「- 」で始まる箇条書きで、各行に原文からそのまま写した${QUOTE_MIN}文字以上の引用「…」を含める。原文は raw に書くか、file でファイルを指す。scope が shared なら全員に、own なら自分だけに見える`,
            parameters: Type.Object({
              scope: Type.Union([Type.Literal('own'), Type.Literal('shared')]),
              gist: Type.String(),
              summary: Type.String(),
              raw: Type.Optional(Type.String()),
              file: Type.Optional(Type.String()),
            }),
          },
          run: async (args) => {
            const e = await entry(args as Input)
            const label =
              args.scope === 'shared'
                ? `S${insert(shared, 'shared_entries', e)}`
                : `O${insert(own(ownDb), 'context_entries', e)}`
            return `${label} として足しました`
          },
        },
        {
          definition: {
            name: 'context_share',
            description:
              '自分用コンテキストのエントリーを共有コンテキストに出す',
            parameters: Type.Object({ label: Type.String() }),
          },
          run: (args) => {
            const e = resolve(args.label)
            if (!e.label.startsWith('O')) {
              throw new Error(
                '自分用コンテキストのラベル（O…）を指定してください',
              )
            }
            return `S${insert(shared, 'shared_entries', e)} として共有しました`
          },
        },
        {
          definition: {
            name: 'unfold',
            description: 'エントリーの Summary（引用付きの箇条書き）を読む',
            parameters: Type.Object({ labels: Type.Array(Type.String()) }),
          },
          run: (args) =>
            labels(args.labels)
              .map((e) => `[${e.label}] ${e.gist}\n${e.summary}`)
              .join('\n\n'),
        },
        {
          definition: {
            name: 'deep_unfold',
            description: 'エントリーの原文（Raw）を読む',
            parameters: Type.Object({ labels: Type.Array(Type.String()) }),
          },
          run: async (args) => {
            const parts = await Promise.all(
              labels(args.labels).map(
                async (e) => `[${e.label}]\n${await rawOf(e)}`,
              ),
            )
            return parts.join('\n\n')
          },
        },
        {
          definition: {
            name: 'give_context',
            description:
              '自分用コンテキストのエントリーをほかのエージェントに渡す。相手が受け取るか決める',
            parameters: Type.Object({
              to: Type.String(),
              label: Type.String(),
            }),
          },
          run: (args) => {
            const e = resolve(args.label)
            if (
              typeof args.to !== 'string' ||
              !canGive(args.to) ||
              args.to === agent
            ) {
              throw new Error(`${args.to} には渡せません`)
            }
            shared
              .query(
                'INSERT INTO gifts (from_agent, to_agent, gist, summary, raw, source) VALUES (?, ?, ?, ?, ?, ?)',
              )
              .run(agent, args.to, e.gist, e.summary, e.raw, e.source)
            return `${args.to} に渡しました`
          },
        },
        {
          definition: {
            name: 'decide_gift',
            description:
              '受け取ったエントリーを自分用コンテキストに入れるか決める',
            parameters: Type.Object({
              id: Type.Number(),
              accept: Type.Boolean(),
            }),
          },
          run: (args) => {
            if (typeof args.id !== 'number') {
              throw new Error('id に数値を指定してください')
            }
            const gift = shared
              .query<
                Omit<Entry, 'label'> & { from_agent: string },
                [number, string]
              >(
                "SELECT from_agent, gist, summary, raw, source FROM gifts WHERE id = ? AND to_agent = ? AND status = 'pending'",
              )
              .get(args.id, agent)
            if (!gift)
              throw new Error(`受け取ったエントリー ${args.id} はありません`)
            const accept = args.accept === true
            shared
              .query('UPDATE gifts SET status = ? WHERE id = ?')
              .run(accept ? 'accepted' : 'rejected', args.id)
            if (!accept) return '受け取りませんでした'
            const { from_agent, ...e } = gift
            const id = insert(own(ownDb), 'context_entries', e)
            return `O${id} として受け取りました（${from_agent} から）`
          },
        },
      ]
    },
  }
}

export type Contexts = ReturnType<typeof openContexts>
