# 0039 FINAL_GOAL を Monaco で編集する

日付: 2026-11-06

## 状況

FINAL_GOAL の入力欄は `routes/page.tsx` の `textarea` で、行番号も折り返しの制御も無い。本文は見出しと箇条書きを持つ Markdown で、長くなる。

## 決定

- 依存に `monaco-editor` を足し、入力欄を Monaco のエディタに替える。SSR では読み込まず、`onMount` で動的 import する。
- 設定: 言語 `markdown`、行番号あり、折り返しあり、ミニマップなし、高さ 40vh。
- `Cmd`/`Ctrl` + `S` で保存する。保存は今の `/api/goal`（text と版）を使う。
- 版が古いときは 409 を返し、「最新を読み込む」「このまま上書きする」を出す（ADR 0018）。
- dirty でないときは、他の書き手の書き換えをそのまま表示に映す。

## 結果

- 本文の行番号と折り返しが見える。キーボードで保存できる。
- `monaco-editor` の分だけ画面の JavaScript が増える。SSR の HTML は変わらない。
- 補完・定義ジャンプ・LSP は使わない。
