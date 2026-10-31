// trigram トークナイザー向けに、本文の3文字ずつの断片を OR でつないだ検索式を作る
// 記号と空白は FTS5 の構文と衝突するため除く
export function ftsQuery(text: string, limit = 64) {
  const chars = [...text.replace(/[\s\p{P}\p{S}]+/gu, '')]
  const grams = new Set<string>()
  for (let i = 0; i + 3 <= chars.length && grams.size < limit; i++) {
    grams.add(chars.slice(i, i + 3).join(''))
  }
  return [...grams].map((gram) => `"${gram}"`).join(' OR ')
}

// Responses API のストリーム（SSE）から出力テキストを組み立てる
export function readOutputText(sse: string) {
  let text = ''
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const data = line.slice(6)
    if (data === '[DONE]') continue
    const event = JSON.parse(data)
    if (event.type === 'response.output_text.delta') text += event.delta
    if (event.type === 'response.failed' || event.type === 'error') {
      throw new Error(`モデルの応答が失敗しました: ${data}`)
    }
  }
  return text
}

// アクセストークン（JWT）の本文から ChatGPT のアカウント ID を取り出す
export function accountIdFromToken(token: string): string {
  const payload = token.split('.')[1]
  if (!payload) throw new Error('アクセストークンの形式が不正です')
  const json = atob(payload.replaceAll('-', '+').replaceAll('_', '/'))
  const id = JSON.parse(json)['https://api.openai.com/auth']?.chatgpt_account_id
  if (typeof id !== 'string') {
    throw new Error('アクセストークンにアカウント ID がありません')
  }
  return id
}
