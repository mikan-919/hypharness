// 改良の候補とアーカイブの置き場（最終目的の 6 の 3）。~/.hyph/evo/ の下に候補を JSON で置く。
// ルートは環境変数 HYPH_EVO で差し替える
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Candidate } from '../../shared/evolve.ts'

// 置き場のルート。テストは HYPH_EVO で差し替える
const defaultRoot = () => process.env.HYPH_EVO || join(homedir(), '.hyph', 'evo')

export function evoPaths(root = defaultRoot()) {
  return { candidates: join(root, 'candidates'), archive: join(root, 'archive') }
}

const ensure = (dir: string) => mkdirSync(dir, { recursive: true })

const fileOf = (dir: string, id: string) => join(dir, `${id}.json`)

// 候補を candidates/<id>.json に書く
export function writeCandidate(c: Candidate, root = defaultRoot()): void {
  const { candidates } = evoPaths(root)
  ensure(candidates)
  writeFileSync(fileOf(candidates, c.id), `${JSON.stringify(c, null, 2)}\n`)
}

export function readCandidate(id: string, root = defaultRoot()): Candidate {
  return JSON.parse(readFileSync(fileOf(evoPaths(root).candidates, id), 'utf8')) as Candidate
}

// id の昇順。文字列の比較で並べる
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const listOf = (dir: string): Candidate[] => {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort(byId)
    .map((id) => JSON.parse(readFileSync(fileOf(dir, id), 'utf8')) as Candidate)
}

export function listCandidates(root = defaultRoot()): Candidate[] {
  return listOf(evoPaths(root).candidates)
}

// 候補を archive/<id>.json に写し、candidates/<id>.json を消す
export function archiveCandidate(id: string, root = defaultRoot()): void {
  const paths = evoPaths(root)
  ensure(paths.archive)
  renameSync(fileOf(paths.candidates, id), fileOf(paths.archive, id))
}

export function listArchive(root = defaultRoot()): Candidate[] {
  return listOf(evoPaths(root).archive)
}
