import type { PageProps } from '../pages.gen'

export default function Home({ message }: PageProps<'Home'>) {
  return <h1>{message}</h1>
}
