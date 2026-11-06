// web_fetch の取得。http・https だけを、内部の宛先を避けて取り、text/* の本文を返す
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

// 1 回の取得のタイムアウト（ミリ秒）
const TIMEOUT = 20_000
// 追うリダイレクトの回数
const MAX_REDIRECTS = 3
// 応答の大きさの上限（バイト）
const MAX_BYTES = 5_000_000
// max_chars の既定と上限
const DEFAULT_CHARS = 20_000
const MAX_CHARS = 50_000
// 同じ URL の応答をメモリに持つ時間（ミリ秒）
const TTL = 3_600_000

// テストで外部へ出ないよう、取得・名前解決・時計を差し替えられるようにする
export const deps: {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  lookup: (host: string) => Promise<string[]>
  now: () => number
} = {
  fetch: (url, init) => globalThis.fetch(url, init),
  lookup: async (host: string) => (await lookup(host, { all: true })).map((r) => r.address),
  now: () => Date.now(),
}

const cache = new Map<string, { text: string; at: number }>()

const REDIRECTS = new Set([301, 302, 303, 307, 308])

const parseHttp = (raw: string) => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`URL を読めません: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`http: と https: の URL だけを取得できます: ${url.protocol}`)
  }
  return url
}

// 内部を指す宛先か。127.0.0.0/8・10.0.0.0/8・172.16.0.0/12・192.168.0.0/16・169.254.0.0/16・::1・fc00::/7
const blocked = (raw: string) => {
  const address = raw.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  const v4 = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  const parts = v4.split('.')
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
    const [a, b] = parts.map(Number)
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  if (address === '::1' || address === '0:0:0:0:0:0:0:1') return true
  const first = address.split(':')[0]
  return /^f[cd][0-9a-f]{0,2}$/.test(first)
}

// ホスト名を解決し、どの宛先も内部を指していないことを確かめる
async function checkHost(url: URL) {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  let addresses: string[]
  if (isIP(host)) {
    addresses = [host]
  } else {
    try {
      addresses = await deps.lookup(host)
    } catch (e) {
      throw new Error(`ホストを解決できませんでした: ${host}（${(e as Error).message}）`)
    }
  }
  if (addresses.length === 0) throw new Error(`ホストを解決できませんでした: ${host}`)
  for (const address of addresses) {
    if (blocked(address)) throw new Error(`内部を指す宛先には取得しません: ${host}（${address}）`)
  }
}

async function send(url: URL) {
  try {
    return await deps.fetch(url.href, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT),
    })
  } catch (e) {
    const error = e as Error
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error(`取得がタイムアウトしました: ${url.href}`)
    throw new Error(`取得できませんでした: ${error.message}`)
  }
}

// script・style の中身とタグを除き、連続する空白を1つに詰める
const toText = (body: string) =>
  body
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

async function readText(response: Response) {
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!type.startsWith('text/')) throw new Error(`対応していない Content-Type です: ${type || '不明'}`)
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > MAX_BYTES) throw new Error(`応答が大きすぎます: ${length} バイト`)
  const body = await response.text()
  if (body.length > MAX_BYTES) throw new Error(`応答が大きすぎます: ${body.length} 文字`)
  return toText(body)
}

async function download(start: URL) {
  let url = start
  for (let hop = 0; ; hop++) {
    await checkHost(url)
    const response = await send(url)
    if (REDIRECTS.has(response.status)) {
      const location = response.headers.get('location')
      if (!location) throw new Error(`HTTP ${response.status} に Location がありません`)
      if (hop >= MAX_REDIRECTS) throw new Error(`リダイレクトが ${MAX_REDIRECTS} 回を超えました`)
      url = parseHttp(new URL(location, url).href)
      continue
    }
    if (!response.ok) throw new Error(`取得に失敗しました（HTTP ${response.status}）`)
    return await readText(response)
  }
}

// url を取得し、本文を maxChars 文字で切って返す。同じ url の応答は TTL のあいだ持つ
export async function webFetch(url: string, maxChars?: number): Promise<string> {
  const asked = Number(maxChars ?? DEFAULT_CHARS)
  const limit = Number.isFinite(asked) ? Math.min(MAX_CHARS, Math.max(0, Math.round(asked))) : DEFAULT_CHARS
  const target = parseHttp(String(url ?? ''))
  const hit = cache.get(target.href)
  if (hit && deps.now() - hit.at < TTL) return hit.text.slice(0, limit)
  const text = await download(target)
  cache.set(target.href, { text, at: deps.now() })
  return text.slice(0, limit)
}
