import { expect, test } from 'bun:test'
import { parseSummary, repoName } from './pr'

test('GitHub のリモートの URL から owner/name を取り出す', () => {
  expect(repoName('https://github.com/mikan-919/hibana.git')).toBe(
    'mikan-919/hibana',
  )
  expect(repoName('git@github.com:mikan-919/hibana')).toBe('mikan-919/hibana')
  expect(() => repoName('/home/x/repo')).toThrow(
    'GitHub のリポジトリではありません',
  )
})

test('要約の1行目を題、残りを本文にする', () => {
  expect(parseSummary('**Add x**\n- a\n- b\n')).toEqual({
    title: 'Add x',
    body: '- a\n- b',
  })
  expect(() => parseSummary('  \n')).toThrow('要約が空です')
})
