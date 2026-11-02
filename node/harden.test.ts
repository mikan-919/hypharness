import { expect, test } from 'bun:test'
import { inBand, type Rate, stable } from './harden'

test('基準版の解けた割合が20〜80%の課題だけを加える', () => {
  expect([0, 0.25, 0.5, 0.75, 1].map(inBand)).toEqual([
    false,
    true,
    true,
    true,
    false,
  ])
})

test('3回以上の計測ですべて解いた課題だけを外し、新しい課題がなければ外さない', () => {
  const rates = new Map<number, Rate>([
    [1, { rate: 1, n: 5 }],
    [2, { rate: 1, n: 2 }],
    [3, { rate: 0.8, n: 5 }],
  ])
  expect(stable(rates, 1)).toEqual([1])
  expect(stable(rates, 0)).toEqual([])
})
