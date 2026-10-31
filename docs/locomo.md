# LoCoMo-Plus ベンチマーク

[LoCoMo-Plus](https://github.com/xjtuleeyf/Locomo-Plus) は、長期にわたる会話の記憶を測る評価です。LoCoMo の5分類（single-hop、multi-hop、temporal、common-sense、adversarial）の質問に、会話の前のほうにある暗黙の手がかりを後の発言に結び付けられるかを問う Cognitive 分類を加えた、全2,387問からなります。hypharness の `locomo` コマンドは、同じ問題をモデルへの1回の呼び出し（direct）とハーネスの各モード（single、fixed、dynamic）で解かせ、LLM で採点して比べます。

## 実行

```bash
# 分類ごとに2問ずつ、direct と market で解く（既定の設定）
bun run src/index.ts locomo

# 方式と分類を選ぶ
bun run src/index.ts locomo --arms direct,market,market-memory --per-category 2 --calls 40
bun run src/index.ts locomo --arms direct --categories Cognitive,adversarial --per-category 10

# 全問を、direct は8並列、ハーネスは4問並列で解く
bun run src/index.ts locomo --arms direct,market --per-category all --concurrency 8 --harness-concurrency 4 --out .hyph/locomo-full

# 中断した実行を同じ出力先で続ける
bun run src/index.ts locomo --out .hyph/locomo-full --arms direct,market --per-category all
```

再開するときは、最初と同じ `--arms`、`--per-category`、`--categories`、`--seed` を指定してください。出力先の記録は問題 ID で照合され、済んだ問題は飛ばされます。

| オプション | 意味 | 既定値 |
| --- | --- | --- |
| `--arms` | 比較する方式。`direct` は参照実装と同じく会話全体と質問を1回の呼び出しで渡す。`market` はハーネスを1問ごとに実行し、会話をファイルで読む。`market-memory` は会話を DeLM の知識として読む | `direct,market` |
| `--per-category N` | 分類ごとの問題数。`all` で全問 | `2` |
| `--categories` | 対象の分類（`multi-hop`、`temporal`、`common-sense`、`single-hop`、`adversarial`、`Cognitive`） | すべて |
| `--seed N` | 問題の選び方を決める乱数の種。同じ種なら全方式が同じ問題を解く | `1` |
| `--calls N` | ハーネス方式の1問あたりのモデル呼び出し上限 | `40` |
| `--concurrency N` | `direct` の同時実行数 | `2` |
| `--harness-concurrency N` | ハーネス方式で同時に解く問題数。問題ごとに別のセッションで動く | `1` |
| `--judge-model ID` | 採点に使うモデル | `OPENAI_MODEL` |
| `--out DIR` | 出力先 | `.hyph/locomo-<時刻>` |

## データと問題の組み立て

データは参照実装のリポジトリの固定したコミット（`059f4e3`）から `locomo10.json` と `locomo_plus.json` を取得し、`<--dir>/locomo-data/` に保存します。sha256 は `report.json` に記録されます。リポジトリにライセンスの記載がないため、データはこのリポジトリに含めていません。

問題の組み立て（会話の整形、根拠の文、手がかりと発言の挿入位置）と採点（分類ごとの判定文、correct=1・partial=0.5・wrong=0、判定結果の読み取り）は参照実装を移植しています。参照実装と同じく、時刻が重なって会話を組み立てられない Cognitive の33問は、モデルを呼ばずに `(no input_prompt)` として採点します。参照実装の Python と出力が一致するかは、実行して確かめていません。

ハーネス方式では、会話を1回で読める大きさ（3,000文字以下）のファイルに分けて作業ディレクトリの `conversation/` に置き、目的として指示と質問を渡します。エージェントは `file_search` と `file_read` で必要な箇所を探し、答えを `answer.txt` に書きます。各問題のセッションは `<出力先>/<方式>/<問題ID>/` に残るため、ダッシュボードの `--dir` に出力先を指定すると経過を確認できます。

## 出力

予測と採点は1問ごとに1行で追記されます。モデル提供元のエラーは予測や採点として記録せず、3回続くと中断します。

| ファイル | 内容 |
| --- | --- |
| `predictions.jsonl` | 方式・問題ごとの予測、終わり方（`answered`、`no-input`、ハーネスの `done`・`budget` など）、呼び出し回数とトークン数、時間 |
| `judgments.jsonl` | 判定ラベル、理由、点数、判定結果を文字列の一致で読み取ったかどうか |
| `report.json` | データの出典とハッシュ値、問題 ID の一覧、方式ごとの平均点・分類別の平均点・使用量・採点の使用量。全問が終わったときに書かれる |

## 比較するときの注意

- 論文は主要な結果の採点に使ったモデルを明記していません（人手との一致を調べた実験では gemini-2.5-flash、リポジトリの使用例では gpt-4o-mini）。別のモデルで採点した点数とは直接比較できません。
- 参照実装は予測で temperature 0.3、採点で 0 を指定しますが、ChatGPT でサインインしている場合、pi-ai は temperature を送りません。
- 参照実装のコードは Cognitive の問題にだけ記憶を意識させる指示を付けます。論文本文は課題の種類を明かさないと書いており、この点で論文と条件が異なる可能性があります。

## 測定例

2026年10月30日に、`gpt-6-luna`（`REASONING=low`）で回答と採点の両方を行った結果です。点数は100点満点に換算しています。

| 分類 | 問題数 | direct |
| --- | --- | --- |
| single-hop | 841 | 82.46 |
| multi-hop | 282 | 59.57 |
| temporal | 321 | 62.31 |
| common-sense | 96 | 53.65 |
| adversarial | 446 | 22.87 |
| Cognitive | 401 | 48.88 |
| 全体 | 2,387 | 59.11 |

次の dynamic は、組織を market に統一する前にあった組織（エージェントが増減を判断する）での測定です。multi-hop の186問で止めました。同じ186問での比較は次のとおりです。

| 項目 | direct | dynamic |
| --- | --- | --- |
| 平均点 | 58.06 | 55.91 |
| モデル呼び出し | 186 | 3,932 |
| トークン | 約400万 | 約1,807万 |
| 1問あたりの時間 | 約3.7秒 | 約86秒 |

1問ごとに新しいセッションを作るため、ハーネスの記憶や組織の変更は問題をまたいで働きません。この設定で dynamic は、direct より点数が低く、呼び出しが多い結果でした。
