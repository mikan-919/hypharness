# completion

完了判定が受け持つ振る舞い。

- どのツールの呼び出しで会話を終えるかを決める。分解役は `submit_task` で課題文を、`finish` で完了の理由を返す。解答役は `done` で要約を返し、`give_up` で諦めた理由を例外にする。
- 検査に落ちた試行の出力を、次の試行の `done` の結果として返してから会話を続ける。
- 1回で終わらなかった実行の扱い（検査に落ちたときの差し戻しと保留）は固定部が持つ。

コード: `harness/roles.ts` の `decompose` と `solve` の `stop` と `answerPending`、`harness/agent.ts` の `stop` を呼ぶ箇所と `answerPending`。
