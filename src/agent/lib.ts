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
