import type { Database } from 'bun:sqlite'
import { mkdir, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { type Tool, Type } from '@earendil-works/pi-ai'

// ツールの出力はモデルの文脈に入るため、長い結果は切る
const OUTPUT_LIMIT = 4000

const sql = Type.Object({
  sql: Type.String({ description: '実行する SQL。1回に1文だけ' }),
})

export const toolDefinitions: Tool[] = [
  {
    name: 'own_db_query',
    description:
      'このエージェント専用の SQLite（固有 DB）に SQL を実行する。会話の記憶は memories(id, role, content, created_at) にあり、全文検索用に memories_fts（trigram）がある。自分用の表を作ってもよい',
    parameters: sql,
  },
  {
    name: 'shared_db_query',
    description:
      '全エージェントで共有する SQLite（共有 DB）に SQL を実行する。ほかのエージェントと情報を受け渡すときに使う。表の作り方は自由',
    parameters: sql,
  },
  {
    name: 'file_list',
    description: '作業用ディレクトリのファイルを一覧する',
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: '作業用ディレクトリからの相対パス' }),
      ),
    }),
  },
  {
    name: 'file_read',
    description: '作業用ディレクトリのファイルを読む',
    parameters: Type.Object({
      path: Type.String({ description: '作業用ディレクトリからの相対パス' }),
    }),
  },
  {
    name: 'file_write',
    description:
      '作業用ディレクトリにファイルを書く。既存のファイルは上書きする',
    parameters: Type.Object({
      path: Type.String({ description: '作業用ディレクトリからの相対パス' }),
      content: Type.String(),
    }),
  },
]

export type Toolbox = {
  definitions: Tool[]
  run: (name: string, args: Record<string, unknown>) => Promise<string>
}
export type RoleTool = {
  definition: Tool
  run: (args: Record<string, unknown>) => string | Promise<string>
}

// 役割ごとのツールを足す。足したツールにない名前は元のツールに回す
export function withTools(base: Toolbox, extra: RoleTool[]): Toolbox {
  return {
    definitions: [...base.definitions, ...extra.map((t) => t.definition)],
    run: async (name, args) => {
      const tool = extra.find((t) => t.definition.name === name)
      return tool ? tool.run(args) : base.run(name, args)
    },
  }
}

// 失敗は例外で返す。呼び出し側がエラーの結果としてモデルに渡し、モデルが直せるようにする
export function createToolbox(
  own: Database,
  shared: Database,
  files: string,
): Toolbox {
  const query = (db: Database, statement: unknown) => {
    if (typeof statement !== 'string') throw new Error('sql は文字列です')
    const rows = db.query(statement).all()
    return rows.length ? JSON.stringify(rows) : '結果の行はありません'
  }

  // 作業用ディレクトリの外（.. や絶対パス）を指すパスは拒否する
  const inside = (path: unknown) => {
    if (typeof path !== 'string') throw new Error('path は文字列です')
    const full = resolve(files, path)
    const rel = relative(files, full)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`作業用ディレクトリの外は扱えません: ${path}`)
    }
    return full
  }

  const run = async (name: string, args: Record<string, unknown>) => {
    switch (name) {
      case 'own_db_query':
        return query(own, args.sql)
      case 'shared_db_query':
        return query(shared, args.sql)
      case 'file_list': {
        const entries = await readdir(inside(args.path ?? '.'), {
          withFileTypes: true,
        })
        return (
          entries
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
            .join('\n') || 'ファイルはありません'
        )
      }
      case 'file_read':
        return Bun.file(inside(args.path)).text()
      case 'file_write': {
        if (typeof args.content !== 'string') {
          throw new Error('content は文字列です')
        }
        const full = inside(args.path)
        await mkdir(dirname(full), { recursive: true })
        await Bun.write(full, args.content)
        return `${args.path} に書きました`
      }
      default:
        throw new Error(`未知のツールです: ${name}`)
    }
  }

  return {
    definitions: toolDefinitions,
    async run(name, args) {
      const output = await run(name, args)
      return output.length > OUTPUT_LIMIT
        ? `${output.slice(0, OUTPUT_LIMIT)}\n（${output.length}文字のうち先頭${OUTPUT_LIMIT}文字）`
        : output
    },
  }
}
