# Hypharness

画面と中継を Cloudflare に置き、タスクを手元のノードで実行するハーネス。全体の設計と段階は [docs/architecture.md](docs/architecture.md) にある。

## 構成

| 場所    | 役割                                                                                                                                |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `src/`  | Cloudflare Workers で動く画面と中継。パスキーでログインし、ノードのペアリング、タスクの待ち行列、実行権（期限45秒と世代番号）を持つ |
| `node/` | 手元で動くノード。中継に WebSocket で接続し、割り当てられたタスクのコマンドを bubblewrap の隔離環境で実行する                       |

## 使う

```sh
bun install
bun run dev        # 画面と中継を http://localhost:5173 で動かす
bun run node       # ノードを起動する。別の URL に接続するときは bun run node <URL>
```

初回はノードがコードを表示するので、画面にログインしてホームで入力する。トークンは `~/.hyph/node.json` に保存し、次回から自動で接続する。タスクの出力は中継に送らず、`~/.hyph/logs/<タスク番号>-<世代>.log` に残す。中継に送るのは終了コードだけである。ノードの実行には bubblewrap（`bwrap`）が必要。

## 開発する

```sh
bun run typecheck
bun test
bun run lint
```
