import { renderToString } from 'react-dom/server'
import { Link, Script, ViteClient } from 'vite-ssr-components/react'
import { serializePage, type PageObject, type RootView } from '@hono/inertia'

const Document = ({ page }: { page: PageObject }) => (
  <html>
    <head>
      <ViteClient />
      <Script src="/src/client.tsx" />
      <Link href="/src/style.css" rel="stylesheet" />
    </head>
    <body>
      <script
        data-page="app"
        type="application/json"
        dangerouslySetInnerHTML={{ __html: serializePage(page) }}
      />
      <div id="app" />
    </body>
  </html>
)

export const rootView: RootView = (page) => '<!DOCTYPE html>' + renderToString(<Document page={page} />)
