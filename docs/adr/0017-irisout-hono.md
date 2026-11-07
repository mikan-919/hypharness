# 0017 画面は irisout と Hono で描く

日付: 2026-11-06

## 決定

画面は irisout で描き、サーバーは Hono で書く。経路は `irisout/hono` の `createFileRouter()` と `irisout/hono/vite` で Hono に登録する。

## 理由

- irisout は、テキストや属性の更新先をコンパイル時に決め、仮想 DOM を使わない。ストリーミング中のトークン数のように、細かい間隔で何度も更新される値に合う。
- irisout は Hono との連携を持つ。中継のトークン数の配信（SSE）も Hono で書ける。
- 利用者のフレームワークを実際のアプリで使い、irisout の対応範囲の不足や診断の改善点を見つけられる。

## 結果

- irisout は React 互換ではなく、React Flow などの React のライブラリは使えない。共有文脈や委任の図は自分で描く。
