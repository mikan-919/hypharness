import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { checkSummary, openContexts } from './context'
import type { RoleTool } from './tools'

const RAW =
  '猫の写真を自動で整理するアプリを作る。撮影日と場所でアルバムを分ける。'

test('checkSummary は原文にない引用や引用のない行を拒否する', () => {
  expect(checkSummary('- 整理する「猫の写真を自動で整理」', RAW)).toEqual([])
  expect(
    checkSummary('- 「撮影日と場所で」分ける\n- 根拠なし', RAW),
  ).toHaveLength(1)
  expect(checkSummary('- 「犬の写真を整理」', RAW)).toHaveLength(1)
  expect(checkSummary('- 「猫の」', RAW)).toHaveLength(1)
  expect(checkSummary('箇条書きでない', RAW)).toHaveLength(1)
})

test('自分用と共有に足し、展開し、ほかのエージェントに渡して広める', async () => {
  const contexts = openContexts(new Database(':memory:'))
  const alice = new Database(':memory:')
  const bob = new Database(':memory:')
  const files: Record<string, string> = { 'plan.md': RAW }
  const readFile = async (path: string) => {
    if (!(path in files)) throw new Error('ない')
    return files[path]
  }
  const toolsOf = (name: string, db: Database) =>
    contexts.tools(name, db, readFile, (to) => ['alice', 'bob'].includes(to))
  const use = (
    tools: RoleTool[],
    name: string,
    args: Record<string, unknown>,
  ) => tools.find((t) => t.definition.name === name)?.run(args)
  const a = toolsOf('alice', alice)
  const b = toolsOf('bob', bob)

  const summary = '- 「撮影日と場所でアルバムを分ける」'
  expect(
    await use(a, 'context_add', {
      scope: 'own',
      gist: '分け方',
      summary,
      file: 'plan.md',
    }),
  ).toBe('O1 として足しました')
  await expect(
    use(a, 'context_add', {
      scope: 'own',
      gist: 'x',
      summary: '- 「存在しない文」',
      raw: RAW,
    }),
  ).rejects.toThrow('引用が原文に見つからない')
  await expect(
    use(a, 'context_add', {
      scope: 'own',
      gist: 'あ'.repeat(201),
      summary,
      raw: RAW,
    }),
  ).rejects.toThrow('200 文字')

  expect(await use(a, 'unfold', { labels: ['O1'] })).toContain(summary)
  expect(await use(a, 'deep_unfold', { labels: ['O1'] })).toContain(RAW)
  // 自分用コンテキストはほかのエージェントからは見えない
  expect(contexts.prompt(bob)).not.toContain('分け方')

  expect(await use(a, 'give_context', { to: 'bob', label: 'O1' })).toBe(
    'bob に渡しました',
  )
  expect(() => use(a, 'give_context', { to: 'carol', label: 'O1' })).toThrow()
  const [gift] = contexts.pendingGifts('bob')
  expect(gift).toMatchObject({ from_agent: 'alice', gist: '分け方' })
  expect(await use(b, 'decide_gift', { id: gift.id, accept: true })).toContain(
    'O1 として受け取りました',
  )
  expect(contexts.prompt(bob)).toContain('[O1] 分け方')
  expect(contexts.pendingGifts('bob')).toEqual([])

  expect(await use(b, 'context_share', { label: 'O1' })).toBe(
    'S1 として共有しました',
  )
  expect(contexts.prompt(alice)).toContain('[S1] 分け方')
  expect(await use(a, 'deep_unfold', { labels: ['S1'] })).toContain(RAW)
})
