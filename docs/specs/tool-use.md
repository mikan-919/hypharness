# tool-use

ツールの使用が受け持つ振る舞い。

- どの役割にどのツールを渡すかを決める（読み取り、`recall`、`write_file`、`run`、`done`、`give_up`、`submit_task`、`finish`、`web_fetch`、`edit_context`）。
- ツールの引数の形（必須と任意）を決め、呼び出しの引数を読む。
- ツールを実行し、結果を会話に返す。作業ツリーの外を指すパスの拒否と、隔離環境でのコマンドの実行を含む。

コード: `harness/agent.ts` の `object`・`inside`・`listFiles`・`readFile`・`READ_TOOLS`・`RECALL_TOOL`・`recall`、`harness/roles.ts` の `DECOMPOSE_TOOLS`・`SOLVE_TOOLS` と各 `run` の分岐、`harness/topic.ts` の `TOOLS`、`harness/fetch.ts` の `webFetch`、`harness/sandbox.ts`。
