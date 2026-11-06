// 失敗したテストから仕様を直す（最終目的の 6 の 9、SpecForge）。
// 失敗の一覧から、モジュールと失敗の種類ごとに docs/specs/<モジュール>.md を直す候補を作る。
// 仕様の文はモデルに書かせず、決まった規則で作る
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MODULES, type Candidate, type Module } from '../../shared/evolve.ts'

// 失敗したテスト1件。test はテスト名、module は対象のモジュール、kind は失敗の種類
export type Failure = { test: string; module: Module; kind: string }

// 失敗の一覧の型の別名
export type TestFailure = Failure

// 仕様の候補。どの種類の失敗から作ったかと、まとめたテスト名を持つ
export type SpecCandidate = Candidate & { kind: string; tests: string[] }

// モジュールの依存。呼ぶ側 -> 呼ばれる側（callee）
export const MODULE_DEPENDENCIES: Record<Module, Module[]> = {
  'agent-loop': ['tool-use', 'observation', 'context', 'completion'],
  'tool-use': [],
  observation: [],
  context: [],
  completion: [],
}

// 呼ばれる側からの深さ。callee が無ければ 0、あれば callee の最大 + 1
const depthOf = (module: Module): number => {
  const callees = MODULE_DEPENDENCIES[module]
  if (callees.length === 0) return 0
  return 1 + Math.max(...callees.map((callee) => depthOf(callee)))
}

// 候補を並べるモジュールの順。深さの昇順、同じ深さは MODULES の順
export function specOrder(): Module[] {
  return [...MODULES].sort((a, b) => {
    const da = depthOf(a)
    const db = depthOf(b)
    if (da !== db) return da - db
    return MODULES.indexOf(a) - MODULES.indexOf(b)
  })
}

// 失敗の種類に対応する1行。テスト名を全部入れる
const bulletOf = (kind: string, tests: string[]): string =>
  `- ${kind} の失敗を防ぐ（テスト: ${tests.join('、')}）。`

// 失敗の一覧から、モジュール・種類ごとに1つの候補を作る。並びは callee 先
export function specCandidates(failures: Failure[], round = 0): SpecCandidate[] {
  const groups = new Map<string, { module: Module; kind: string; tests: string[] }>()
  for (const failure of failures) {
    const key = `${failure.module}\u0000${failure.kind}`
    const group = groups.get(key)
    if (group) {
      group.tests.push(failure.test)
    } else {
      groups.set(key, { module: failure.module, kind: failure.kind, tests: [failure.test] })
    }
  }
  const order = specOrder()
  const out: SpecCandidate[] = []
  for (const module of order) {
    for (const group of groups.values()) {
      if (group.module !== module) continue
      out.push({
        id: `${round}-spec-${out.length + 1}`,
        round,
        module: group.module,
        kind: group.kind,
        tests: [...group.tests],
        changes: [bulletOf(group.kind, group.tests)],
        score: 0,
        note: group.kind,
        cost: 0,
      })
    }
  }
  return out
}

// 候補が直す失敗の種類。kind が無ければ changes の文、次に note から読む
const kindOf = (candidate: Candidate): string => {
  const spec = candidate as Partial<SpecCandidate>
  if (typeof spec.kind === 'string') return spec.kind
  for (const change of candidate.changes) {
    const matched = change.match(/- (.+) の失敗を防ぐ/)
    if (matched) return matched[1]
  }
  return candidate.note
}

// <root>/docs/specs/<モジュール>.md を直す。「コード:」の行より上の箇条書きのうち、
// 失敗の種類に対応する1行を置き換える。無ければ箇条書きの末尾に足す。
// ファイルが無ければ作らずに false を返す
export function applySpec(candidate: Candidate, root = process.cwd()): boolean {
  const file = join(root, 'docs/specs', `${candidate.module}.md`)
  if (!existsSync(file)) return false
  const kind = kindOf(candidate)
  const lines = readFileSync(file, 'utf8').split('\n')

  for (const change of candidate.changes) {
    const codeIndex = lines.findIndex((line) => line.startsWith('コード:'))
    const end = codeIndex === -1 ? lines.length : codeIndex
    // 「コード:」の行より上で、種類を含む箇条書きを探して置き換える
    let replaced = false
    for (let i = 0; i < end; i++) {
      if (lines[i].startsWith('- ') && kind !== '' && lines[i].includes(kind)) {
        lines[i] = change
        replaced = true
        break
      }
    }
    if (replaced) continue
    // 最後の箇条書きの後ろに足す
    let last = -1
    for (let i = 0; i < end; i++) {
      if (lines[i].startsWith('- ')) last = i
    }
    lines.splice(last === -1 ? end : last + 1, 0, change)
  }

  writeFileSync(file, lines.join('\n'))
  return true
}
