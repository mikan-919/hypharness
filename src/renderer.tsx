import { type PageObject, type RootView, serializePage } from '@hono/inertia'
import { renderToString } from 'react-dom/server'
import { Link, Script, ViteClient } from 'vite-ssr-components/react'

const Document = ({ page }: { page: PageObject }) => (
  <html lang='ja'>
    <head>
      <ViteClient />
      <Script src='/src/client.tsx' />
      <Link href='/src/style.css' rel='stylesheet' />
    </head>
    <body>
      <script
        data-page='app'
        type='application/json'
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serializePage が / をエスケープし </script> による脱出を防ぐ
        dangerouslySetInnerHTML={{ __html: serializePage(page) }}
      />
      <div id='app' />
    </body>
  </html>
)

export const rootView: RootView = (page) =>
  `<!DOCTYPE html>${renderToString(<Document page={page} />)}`
