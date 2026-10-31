import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { type Tool, Type } from '@earendil-works/pi-ai'

// ツールの出力はモデルの文脈に入るため、長い結果は切る
const OUTPUT_LIMIT = 4000
const COMMAND_TIMEOUT_MS = 60_000

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
  {
    name: 'run_command',
    description:
      '隔離環境でシェルのコマンドを実行する。作業用ディレクトリが /work にあり、書き込めるのはそこだけ。ネットワークは使えない（Web の情報は web_search で調べる）。Python は無いため、コードは bun（TypeScript と JavaScript をそのまま実行できる）で書く。基本的なコマンドもある。60秒で止める。小さな実験や検証のコードを書いて動かすときに使う',
    parameters: Type.Object({
      command: Type.String({ description: 'sh -c で実行するコマンド' }),
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
      case 'run_command': {
        if (typeof args.command !== 'string') {
          throw new Error('command は文字列です')
        }
        const child = Bun.spawn(sandbox(files, args.command), {
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: COMMAND_TIMEOUT_MS,
        })
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        return `終了コード ${code}${child.signalCode ? `（${child.signalCode} で停止）` : ''}\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`
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

// bubblewrap で、システムを読み取り専用、作業用ディレクトリだけを書き込み可にした隔離環境を作る。
// ネットワークを含む名前空間をすべて分け、環境変数を消すため、~/.hyph の認証情報や手元のサービスには届かない
function sandbox(work: string, command: string) {
  const bwrap = Bun.which('bwrap')
  if (!bwrap) throw new Error('run_command には bubblewrap（bwrap）が必要です')
  const system = [
    '/nix/store',
    '/run/current-system/sw',
    '/usr',
    '/bin',
    '/lib',
    '/lib64',
  ]
    .filter(existsSync)
    .flatMap((path) => ['--ro-bind', path, path])
  return [
    bwrap,
    '--unshare-all',
    '--die-with-parent',
    '--clearenv',
    ...system,
    // 実行中の bun を、隔離環境の中では bun という名前で使えるようにする
    '--ro-bind',
    process.execPath,
    '/opt/bin/bun',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--bind',
    work,
    '/work',
    '--chdir',
    '/work',
    '--setenv',
    'PATH',
    '/opt/bin:/run/current-system/sw/bin:/usr/bin:/bin',
    '--setenv',
    'HOME',
    '/tmp',
    '--',
    'sh',
    '-c',
    command,
  ]
}
