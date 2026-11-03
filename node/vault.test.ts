import { expect, test } from 'bun:test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadKey, pack, seal, unpack, unseal } from './vault'

test('作業領域は暗号化して戻せ、改ざん・別のタスク・別の鍵では戻せない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hyph-test-'))
  const key = await loadKey(join(dir, 'a.key'))
  const other = await loadKey(join(dir, 'b.key'))
  // 2回目は作らずに同じ鍵を読む
  const again = await loadKey(join(dir, 'a.key'))

  const work = join(dir, 'work')
  await mkdir(join(work, 'src'), { recursive: true })
  await Bun.write(join(work, 'a.txt'), '1\n')
  await Bun.write(join(work, 'src/b.bin'), new Uint8Array([0, 255, 7]))
  const blob = await seal(key, '5', await pack(work))

  const restored = join(dir, 'restored')
  await mkdir(restored)
  await unpack(restored, await unseal(again, '5', blob))
  expect(await Bun.file(join(restored, 'a.txt')).text()).toBe('1\n')
  expect([...(await Bun.file(join(restored, 'src/b.bin')).bytes())]).toEqual([
    0, 255, 7,
  ])

  const tampered = new Uint8Array(blob)
  tampered[tampered.length - 1] ^= 1
  await expect(unseal(key, '5', tampered)).rejects.toThrow()
  await expect(unseal(key, '6', blob)).rejects.toThrow()
  await expect(unseal(other, '5', blob)).rejects.toThrow()
})
