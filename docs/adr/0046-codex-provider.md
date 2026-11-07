# 0046 モデルの提供元に Codex（ChatGPT のサインイン）を選べるようにする

日付: 2026-11-07

## 状況

旧実装は `PROVIDER=codex` で、ChatGPT のサブスクリプションでサインインした OpenAI を呼べた。作り直し（ADR 0008）では提供元を DeepInfra だけにし、Codex は使うときに足すとしていた。pi-ai 1.5.0 の `openai` の提供元は、API キーのほかに ChatGPT のサインイン（OAuth）を受け付け、サインインの情報では Responses API を呼べる。

## 決定

- `PROVIDER=codex` で、pi-ai の `openai` の提供元をサインインの情報で使う。モデルは `CODEX_MODEL`（既定 `gpt-6-luna`）。
- サインインの情報は、旧実装と同じ `~/.hyph/auth.json` に置く。利用者が `~/.hyph` で `bunx @earendil-works/pi-ai login openai` を実行して作る。refresh token は更新のたびに入れ替わるため、書き込みは直列にし、ファイルの権限は 0600 にする。
- サインインしていないときは、最初の呼び出しで、サインインの手順を書いた誤りにする。
- 中継が決める会話ごとのセッション id（ADR 0044）を `sessionId` として渡す。OpenAI のプロンプトのキャッシュの鍵になる。`User-Agent` は `hypharness/0.1`。

## 結果

- 費用は pi-ai の目録の API の単価で数える。サブスクリプションの利用は従量の請求にならないが、課題ごとの費用の上限（ADR 0011）は、この見積もりで止める。
- 文脈の上限は 272,000 トークンで、DeepSeek V4.1 Flash より小さい。作業文脈のしきい値（ADR 0031、10万トークン）より大きいので、縮める前に上限に当たることはない。
