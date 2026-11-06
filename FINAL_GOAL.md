# 検索ツールを Parallel で実装する

論点エージェントに Web 検索のツール `web_search` を渡す。検索は Parallel の Search API を使う。

## ツールの形

- 名前: `web_search`
- 説明: リポジトリに無い情報（外部の文献、API の仕様、既存の実装例）を Web で調べる
- 引数:
  - `objective`（必須）: 調べたいことを1つの文で書く
  - `max_results`（省略可、既定 5、1〜20）: 返す結果の件数
- 戻り値: 結果ごとに `title`・`url`・`excerpts`（抜粋を改行で連結）を並べたテキスト。結果が0件なら「結果なし」
- 戻り値は全体で 8,000 文字まで。超えたら後ろを切る

## 呼び出し

- `POST https://api.parallel.ai/v1beta/search` に、ヘッダー `x-api-key: <PARALLEL_API_KEY>`、本文 `{ objective, max_results, mode: "fast" }` を送る
- 応答の `results[].title`・`results[].url`・`results[].excerpts[]` を使う
- タイムアウトは 30 秒
- モードは常にFastで行う。`mode` は `"fast"` を固定で送り、ツールの引数では変えさせない

## 渡す条件

- 環境変数 `PARALLEL_API_KEY` があるときだけ `TOOLS` に `web_search` を加える。無いときは今までと同じツールの一覧
- 論点エージェントのシステムプロンプトに、外部の情報を調べるときは `web_search` を使い、使った結果は根拠として `record` の `evidence` に URL を書くと足す

## 失敗したとき

- HTTP エラー、タイムアウト、応答の形が違うときは、ツールの結果を isError にして理由の文を返す。対話は止めない
- 失敗は `record` の `fail` に残す
- 失敗した検索の費用は数えない

## 検証

- `PARALLEL_API_KEY` があるときだけ `TOOLS` に `web_search` が入る
- 送る本文に `mode: "fast"` が入る
- 検索の応答（JSON）を、`title`・`url`・`excerpts` を持つテキストに変換する
- HTTP 500 の応答が isError の結果になる
- 8,000 文字を超える応答が切られる
- 検索が成功すると、その課題の費用が $0.005 増える
- 検索の費用を足した結果、上限に達すると中継が停止する
- 検索の呼び出しは fetch を差し替えて確かめ、実際の API は呼ばない

## 費用

- 検索1回の費用を $0.005 とし、その検索を行った課題（`taskId`）の費用に足す
- 中継にモデル以外の費用を受け取る口を足し、モデルの利用料と同じ上限（`TASK_LIMIT_USD`）で数える。上限に達したら中継が止める
- この額は見積もりで、Parallel の請求額とは一致しない

## やらないこと

- 検索結果のページ本文の取得（extract）はしない
- 検索結果の要約をモデルに作らせない
- 検索の回数に別の上限を設けない
