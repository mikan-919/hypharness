import { expect, test } from 'bun:test'
import type { Message } from '@earendil-works/pi-ai'
import { applyEdits, checkEdits, compact, openMemory } from './memory'

test('原文は日本語の3文字以上でも2文字でも検索でき、番号で本文に戻せる', () => {
  const m = openMemory()
  const a = m.add('sh', '字句解析の位置がずれる')
  m.add('sh', 'cargo test: ok')
  expect(m.search('解析の').map((h) => h.id)).toEqual([a])
  expect(m.search('位置').map((h) => h.id)).toEqual([a])
  expect(m.search('"ok')).toEqual([])
  expect(m.get(a)?.text).toBe('字句解析の位置がずれる')
})

test('記憶は原文に含まれる引用がないと残せず、ほぼ同じ要旨は統合し、参照をたどって想起する', () => {
  const m = openMemory()
  const raw = m.add('sh', 'error: cargo test は src/c.rs の alloc で失敗')
  expect(() =>
    m.remember({
      scope: 'shared',
      gist: 'C 版の alloc',
      summary: 's',
      quotes: [{ raw, text: '存在しない文' }],
    }),
  ).toThrow('引用が原文')
  const a = m.remember({
    scope: 'shared',
    gist: 'C 版のテストは src/c.rs の alloc で落ちる',
    summary: 'alloc を先に読む',
    quotes: [{ raw, text: 'src/c.rs の alloc' }],
  })
  const b = m.remember({
    scope: 'shared',
    gist: 'C 版のテストは src/c.rs の alloc で落ちる。',
    summary: 'GC を確かめる',
    quotes: [{ raw, text: 'cargo test' }],
  })
  expect(b).toEqual({ id: a.id, merged: true })
  expect(m.entry(a.id)?.summary).toBe('alloc を先に読む\nGC を確かめる')
  const c = m.remember({
    scope: 'self',
    gist: '失敗したら最初に差分の範囲を狭める',
    summary: '方針',
    quotes: [{ raw, text: 'error' }],
    links: [{ to: a.id, kind: 'cause' }],
  })
  // 「alloc」で当たるのは a だけだが、参照でつながる c も想起する
  expect(m.entries('alloc').map((e) => e.id)).toEqual([a.id, c.id])
})

test('課題の失敗に3回関わった記憶は外し、安く成功した記憶は評価を上げる', () => {
  const m = openMemory()
  const raw = m.add('sh', 'ok')
  const quotes = [{ raw, text: 'ok' }]
  const bad = m.remember({
    scope: 'self',
    gist: '悪い方針',
    summary: 's',
    quotes,
  })
  const good = m.remember({
    scope: 'self',
    gist: '良い方針',
    summary: 's',
    quotes,
  })
  m.judge([good.id], true, true)
  expect(m.entry(good.id)?.score).toBe(1)
  m.judge([good.id], true, false)
  expect(m.entry(good.id)?.score).toBe(1)
  for (let i = 0; i < 2; i++) expect(m.judge([bad.id], false, true)).toBe(0)
  expect(m.judge([bad.id], false, true)).toBe(1)
  expect(m.entry(bad.id)).toBeNull()
  expect(m.entries('方針').map((e) => e.id)).toEqual([good.id])
})

const result = (id: string, text: string): Message => ({
  role: 'toolResult',
  toolCallId: id,
  toolName: 'sh',
  content: [{ type: 'text', text }],
  isError: false,
  timestamp: 0,
})

test('圧縮は直近の結果を残し、古い結果だけを原文の番号つきの参照に置き換える', () => {
  const messages = [result('a', '古い出力'), result('b', '新しい出力')]
  const refs = new Map([
    ['a', 1],
    ['b', 2],
  ])
  expect(compact(messages, refs, 1)).toBe(1)
  expect(JSON.stringify(messages[0])).toContain('原文 #1')
  expect(JSON.stringify(messages[1])).toContain('新しい出力')
  // 置き換えた結果は2度置き換えない
  expect(compact(messages, refs, 1)).toBe(0)
})

test('文脈の編集は、原文のない結果を消す提案と不正な提案を断り、受け付けた編集をまとめて反映する', () => {
  const messages = [result('a', '原文あり'), result('b', '原文なし')]
  const refs = new Map([['a', 1]])
  const notes = new Map<string, string>()
  expect(() =>
    checkEdits([{ op: 'drop', call: 'b' }], messages, refs, notes),
  ).toThrow('戻せません')
  expect(() =>
    checkEdits([{ op: 'unnote', key: 'x' }], messages, refs, notes),
  ).toThrow('ありません')
  expect(() => checkEdits({}, messages, refs, notes)).toThrow('配列')
  const edits = checkEdits(
    [
      { op: 'drop', call: 'a' },
      { op: 'note', key: '方針', text: '先に lexer を読む' },
      { op: 'note', key: '残り', text: 'C 版' },
    ],
    messages,
    refs,
    notes,
  )
  applyEdits(edits, messages, refs, notes)
  expect(JSON.stringify(messages[0])).toContain('原文 #1')
  applyEdits(
    checkEdits([{ op: 'move', key: '残り', to: 0 }], messages, refs, notes),
    messages,
    refs,
    notes,
  )
  expect([...notes.keys()]).toEqual(['残り', '方針'])
})
