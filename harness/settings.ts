// ハーネスの改良（自己改良の周）で変える設定と、圧縮の指針。
// ここに置いた値と本文は、server/evolve の変更の対象になる

// 観察管理と文脈管理の縮める規則の値
export const AGENT_DIET = {
  // ツール結果を文脈に入れる前の長さの上限（文字）
  toolResultMaxChars: 10_000,
  // 連続する同じ行を1行にするか
  collapseRepeatedLines: true,
  // 連続する空行を1行にするか
  collapseBlankLines: true,
  // 文脈ファイルに入れる、生のまま残す直近のメッセージの件数
  contextKeep: 8,
  // 要約ノードを作る間隔（ターン）
  summaryEvery: 4,
}

// 圧縮の指針の本文
export const COMPRESSION_GUIDE =
  '圧縮では、確定した決定、失敗の理由、未解決の点、課題文との対応を残す。生のツール出力の繰り返し、解決済みの議論、同じ内容の再掲は捨てる。'
