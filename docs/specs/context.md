# context

文脈管理が受け持つ振る舞い（ADR 0031）。

- 作業文脈は、課題の作業ツリー（論点エージェントは対象のリポジトリと論点）ごとに分ける。状態は `~/.hyph/ctx/` に置き、子プロセスをまたいで残す。
- CLM: モデルが `edit_context` を呼ぶと、ここまでの会話（最初の指示を除く）を、モデルが書いた `content` に置き換える。次の呼び出しから、置き換えた会話の代わりに `content` を1通だけ渡す。いつ、何を残すかはモデルが決め、ハーネスはターンの数で縮めない。
- LCM: 原文は会話（論点エージェントは対話の記録）に消さずに残す。`recall` は、置き換えて見えなくなった会話の原文を語で探して返す。
- モデルが縮めないまま、モデルに渡した文脈のトークン数（応答の usage の入力・キャッシュの読み書きの合計）が `compactAtTokens` を超えたら、直近 `contextKeep` 件より前の会話を、1件 500 文字で切って並べた要約に置き換える。
- モデルに渡す会話を作り直すのは、`edit_context` を呼んだときと、しきい値を超えたときだけにする。その間は前の呼び出しの会話を先頭にそのまま足し、キャッシュが効くようにする。
- 文脈がしきい値の半分を超えたら、最後のツールの結果に文脈の大きさを書き添える。

`harness/settings.ts` の `AGENT_DIET`（`contextKeep`・`compactAtTokens`）と `COMPRESSION_GUIDE` は、ハーネスの改良（自己改良の周）の変更の対象にする。

コード: `harness/ctx.ts` の全体（`workingContext`・`promptTokens`・`messageText`）と、`harness/agent.ts` の `EDIT_CONTEXT_TOOL`・`RECALL_TOOL`・`contextTool`・`noteSize` と、`runAgent` と `harness/topic.ts` の `runTopic` の中でそれらを呼ぶ箇所。
