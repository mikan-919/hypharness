import { css } from './style.ts'

// ponytail: irisout 0.3.7 の SSR は空要素（meta・link）に閉じタグを付け、Vite の HTML 解析が失敗する。
// 空要素を置かず、文字コードは Hono の応答ヘッダーに任せ、CSS は埋め込む。irisout が直ったら meta と link に戻す
export function Layout({ title, children }) {
  return (
    <html lang="ja">
      <head>
        <title>{title}</title>
        <style>{css}</style>
      </head>
      <body>{children}</body>
    </html>
  )
}
