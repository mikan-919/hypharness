import { expect, test } from 'bun:test'
import { accountIdFromToken, ftsQuery, readOutputText } from './lib'

test('ftsQuery は記号を除いた3文字ずつの断片を OR でつなぐ', () => {
  expect(ftsQuery('犬を "飼う"。')).toBe('"犬を飼" OR "を飼う"')
  expect(ftsQuery('犬')).toBe('')
})

test('readOutputText は差分を連結し、失敗イベントで例外を投げる', () => {
  const sse = [
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"こん"}',
    '',
    'data: {"type":"response.output_text.delta","delta":"にちは"}',
    'data: {"type":"response.completed","response":{}}',
  ].join('\n')
  expect(readOutputText(sse)).toBe('こんにちは')
  expect(() => readOutputText('data: {"type":"response.failed"}')).toThrow()
})

test('accountIdFromToken は base64url の JWT からアカウント ID を取り出す', () => {
  const payload = btoa(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acc-?>' },
    }),
  )
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
  expect(accountIdFromToken(`h.${payload}.s`)).toBe('acc-?>')
  expect(() => accountIdFromToken('h.e30.s')).toThrow()
})
