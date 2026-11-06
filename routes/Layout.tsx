export function Layout({ title, children }) {
  return (
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <link rel="stylesheet" href="/style.css" />
      </head>
      <body>{children}</body>
    </html>
  )
}
