# Hypharness

手元の GPU 1枚で、複数の研究エージェントに LLM のアーキテクチャと学習法の研究を自動で進めさせるハーネス。研究エージェントは指揮役を持たず、DeLM 式の共有の文脈（追記だけのログ）で協調する。設計は [docs/architecture.md](docs/architecture.md) にある。

## 必要なもの

- NVIDIA の GPU が見える WSL2（`/dev/dxg` と `/usr/lib/wsl`）
- bubblewrap（`bwrap`）とユーザーの systemd（`systemd-run --user`）
- Go と uv。`nix develop` で入る
- ChatGPT のサブスクリプション

## 使う

リポジトリの直下で実行する。状態はすべて `~/.hyph` に置く。

```sh
nix develop
go run . login         # ChatGPT でサインインする（~/.hyph/auth.json）
go run . setup         # Python の環境と学習データ（FineWeb-edu の1シャード、約2GB）を用意する
go run . baseline 3    # 基準の train.py を3回学習させ、val bpb のばらつきを測る
go run . lab 10        # 研究エージェントを10体動かす。Ctrl-C で止める
```

モデルは `MODEL`（既定 `gpt-6-luna`）、推論の深さは `REASONING`（既定 `medium`）で選ぶ。

## 置き場

| 場所 | 中身 |
| --- | --- |
| `~/.hyph/lab/best/train.py` | 今の最良の学習スクリプト |
| `~/.hyph/lab/best.json`、`noise.json` | 最良の val bpb、基準のばらつき |
| `~/.hyph/lab/runs.jsonl`、`runs/<番号>/` | 実験ノートと、各実験のスクリプトと出力 |
| `~/.hyph/lab/context.jsonl` | 共有の文脈 |
| `~/.hyph/lab/agents/<番号>/` | 研究エージェントの作業用ディレクトリとログ |
