import { expect, test } from 'bun:test'
import type { Message } from '@earendil-works/pi-ai'
import { compact, openRaw } from './memory'

test('原文は日本語の3文字以上でも2文字でも検索でき、番号で本文に戻せる', () => {
  const raw = openRaw()
  const a = raw.add('sh', '字句解析の位置がずれる')
  raw.add('sh', 'cargo test: ok')
  expect(raw.search('解析の').map((h) => h.id)).toEqual([a])
  expect(raw.search('位置').map((h) => h.id)).toEqual([a])
  expect(raw.search('"ok')).toEqual([])
  expect(raw.get(a)?.text).toBe('字句解析の位置がずれる')
})

test('圧縮は直近の結果を残し、古い結果だけを原文の番号つきの参照に置き換える', () => {
  const result = (id: string, text: string): Message => ({
    role: 'toolResult',
    toolCallId: id,
    toolName: 'sh',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 0,
  })
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
