// 作業領域のチェックポイントを暗号化する。鍵は利用者のノードだけが持ち、中継には復号できないデータとハッシュしか渡さない
import { chmod, rename } from 'node:fs/promises'

const IV_BYTES = 12

export async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Buffer.from(digest).toString('hex')
}

// 鍵がなければ作る。別のノードで再開するには、利用者がこのファイルを同じ場所に複製する
export async function loadKey(path: string) {
  if (!(await Bun.file(path).exists())) {
    const temporary = `${path}.tmp`
    await Bun.write(
      temporary,
      Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
        'base64',
      ),
    )
    await chmod(temporary, 0o600)
    await rename(temporary, path)
    console.log(
      `チェックポイントの鍵を ${path} に作りました。別のノードで再開するには、このファイルを同じ場所に複製してください`,
    )
  }
  const raw = Buffer.from((await Bun.file(path).text()).trim(), 'base64')
  if (raw.length !== 32) throw new Error(`${path} の鍵が32バイトではありません`)
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ])
}

// AES-GCM で暗号化する。label（タスクの番号）を認証付きデータにし、別のタスクのチェックポイントとの差し替えを拒む
export async function seal(
  key: CryptoKey,
  label: string,
  data: Uint8Array<ArrayBuffer>,
) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(label) },
    key,
    data,
  )
  const blob = new Uint8Array(IV_BYTES + sealed.byteLength)
  blob.set(iv)
  blob.set(new Uint8Array(sealed), IV_BYTES)
  return blob
}

// 改ざんや鍵・label の違いがあれば例外を投げる
export async function unseal(
  key: CryptoKey,
  label: string,
  blob: Uint8Array<ArrayBuffer>,
) {
  const opened = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: blob.subarray(0, IV_BYTES),
      additionalData: new TextEncoder().encode(label),
    },
    key,
    blob.subarray(IV_BYTES),
  )
  return new Uint8Array(opened)
}

// 作業領域を tar にまとめる。エージェントが書き込み中のファイルがあると tar は終了コード 1 で警告するが、
// 次の間隔で取り直すため、まとめた分を使う
export async function pack(dir: string) {
  const result = await Bun.$`tar -C ${dir} -cf - .`.quiet().nothrow()
  if (result.exitCode > 1) {
    throw new Error(`作業領域をまとめられません: ${result.stderr.toString()}`)
  }
  return new Uint8Array(result.stdout)
}

export async function unpack(dir: string, data: Uint8Array) {
  const result =
    await Bun.$`tar -C ${dir} --no-same-owner -xf - < ${new Response(data)}`
      .quiet()
      .nothrow()
  if (result.exitCode !== 0) {
    throw new Error(`作業領域を戻せません: ${result.stderr.toString()}`)
  }
}
