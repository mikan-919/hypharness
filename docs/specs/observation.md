# observation

観察管理が受け持つ振る舞い。

- ツールの結果を、モデルへ渡す前に決まった規則で縮める。連続する同じ行を1行にし、連続する空行を1行に詰め、20,000 文字を超える分を後ろから切り、切ったことと元の文字数を書き添える。
- ツールの実行が例外になったときは、その本文も同じ規則で縮め、`isError` の結果として会話に返す。
- 縮めた本文だけを保持し、元の本文は別に持たない。

`harness/settings.ts` の `AGENT_DIET`（`toolResultMaxChars`・`collapseRepeatedLines`・`collapseBlankLines`）と `COMPRESSION_GUIDE` は、ハーネスの改良（自己改良の周）の変更の対象にする。

コード: `harness/agent.ts` の `shrinkToolResult` と、`runAgent` の中でツールの結果と例外をこれに通す箇所。
