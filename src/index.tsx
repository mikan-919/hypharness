import { inertia } from '@hono/inertia'
import { Hono } from 'hono'
import { rootView } from './renderer'

const app = new Hono()

app.use(inertia({ rootView }))

const routes = app.get('/', (c) =>
  c.render('Home', { message: 'Hello, Inertia' }),
)

export default routes
