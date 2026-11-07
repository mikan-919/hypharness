// 改良の候補とアーカイブの置き場（最終目的の 6 の 3）。~/.hyph/evo/ の下に候補を JSON で置く。
// 候補のコードは code/<id>.md に置く。ルートは環境変数 HYPH_EVO で差し替える
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Candidate } from '../../shared/evolve.ts'

// 置き場のルート。テストは HYPH_EVO で差し替える
const defaultRoot = () => process.env.HYPH_EVO || join(homedir(), '.hyph', 'evo')

export function evoPaths(root = defaultRoot()) {
  return {
    candidates: join(root, 'candidates'),
    archive: join(root, 'archive'),
    prompts: join(root, 'prompts'),
    code: join(root, 'code'),
  }
}

const ensure = (dir: string) => mkdirSync(dir, { recursive: true })

const fileOf = (dir: string, id: string) => join(dir, `${id}.json`)

const codeOf = (dir: string, id: string) => join(dir, `${id}.md`)

// 費用の無い古い候補は 0 として読む
const parse = (text: string): Candidate => {
  const c = JSON.parse(text) as Candidate
  return { ...c, cost: typeof c.cost === 'number' ? c.cost : 0 }
}

// 候補のコードの本文。# <id>、module、round、changes と変更の行を並べる
const codeText = (c: Candidate): string =>
  [
    `# ${c.id}`,
    `module: ${c.module}`,
    `round: ${c.round}`,
    'changes:',
    ...c.changes.map((change) => `- ${change}`),
    '',
  ].join('\n')

// 候補を candidates/<id>.json に書き、コードを code/<id>.md に書く
export function writeCandidate(c: Candidate, root = defaultRoot()): void {
  const paths = evoPaths(root)
  ensure(paths.candidates)
  ensure(paths.code)
  writeFileSync(fileOf(paths.candidates, c.id), `${JSON.stringify(c, null, 2)}\n`)
  writeFileSync(codeOf(paths.code, c.id), codeText(c))
}

export function readCandidate(id: string, root = defaultRoot()): Candidate {
  return parse(readFileSync(fileOf(evoPaths(root).candidates, id), 'utf8'))
}

// 候補のコードの本文。ファイルが無ければ空文字
export function readCode(id: string, root = defaultRoot()): string {
  const file = codeOf(evoPaths(root).code, id)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

// id の昇順。文字列の比較で並べる
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const listOf = (dir: string): Candidate[] => {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort(byId)
    .map((id) => parse(readFileSync(fileOf(dir, id), 'utf8')))
}

export function listCandidates(root = defaultRoot()): Candidate[] {
  return listOf(evoPaths(root).candidates)
}

// 候補を archive/<id>.json に写し、candidates/<id>.json を消す。code/<id>.md は動かさない
export function archiveCandidate(id: string, root = defaultRoot()): void {
  const paths = evoPaths(root)
  ensure(paths.archive)
  renameSync(fileOf(paths.candidates, id), fileOf(paths.archive, id))
}

export function listArchive(root = defaultRoot()): Candidate[] {
  return listOf(evoPaths(root).archive)
}
