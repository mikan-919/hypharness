# agent-loop

エージェントループが受け持つ振る舞い。

- モデルを呼び、返ってきたツールの呼び出しを順に実行し、結果を会話に足して次のターンへ進む。
- ツールの呼び出しが無い応答で、そのターンを終える。
- `stop` が値を返したツールの呼び出しで、ループを終えてその値を結果にする。
- ターンのたびに保存のための記録を残し、ツールの呼び出しの結果に `toolCallId` を対応させる。

コード: `harness/agent.ts` の `runAgent`、`harness/roles.ts` の `decompose` と `solve` の `messages`・`tools`・`run`・`stop`。
