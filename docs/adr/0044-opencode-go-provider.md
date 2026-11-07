# 0044 モデルの提供元に OpenCode Go を選べるようにする

日付: 2026-11-07

## 状況

モデルは DeepInfra の DeepSeek V4.1 Flash だけから呼んでいた（ADR 0008）。OpenCode Go は月額の定額で、同じ DeepSeek V4.1 Flash を含む複数のモデルを、OpenAI Chat Completions などの形の API で呼べる。公式の資料（https://dev.opencode.ai/docs/console/go/）は、OpenCode 以外のコーディングエージェントからの直接の呼び出しを想定しており、次の条件を挙げている。

- 通常のコーディングエージェントに相当する要求を送る。
- `User-Agent` に、汎用の SDK や HTTP ライブラリーの名前ではなく、自分のクライアントの識別子を入れる。
- 会話ごとに固定したセッション id を `x-opencode-session` に入れる。経路の選択とプロンプトのキャッシュに使われる。

一般的なチャットや、大量の汎用の文章生成・分類は想定の外で、利用は監視される。

## 決定

- 環境変数 `PROVIDER` で提供元を選ぶ。`deepinfra`（既定）か `opencode-go`。
- OpenCode Go は、pi-ai の `opencode-go` の提供元をそのまま使う。鍵は `OPENCODE_API_KEY`、モデルは `OPENCODE_MODEL`（既定 `deepseek-v4.1-flash`）。
- `User-Agent` は `hypharness/0.1` にする。
- セッション id は中継が決める。値は `hypharness-<起動ごとの接頭辞>-<論点>-<課題>` で、論点エージェント・分解役・解答役のそれぞれの課題の会話ごとに固定になる。pi-ai がこれを `x-opencode-session` として送る。
- 1回の応答の出力の上限は 32,768 トークンにする。目録の上限（384,000）のまま送らない。

## 結果

- hypharness が送るのは、課題を分け、コードを読んで書き、検査する、コーディングエージェントの要求だけなので、利用条件の範囲に入る。
- 費用は pi-ai の目録の単価で数える。OpenCode Go の平日の時間帯の2倍の係数と、定額の枠（5時間・週・月）は数えていない。
- DeepSeek V4.1 Flash と V4 Pro は、OpenCode の Console の Settings › Privacy で Regions を Global にするまで呼べない。
