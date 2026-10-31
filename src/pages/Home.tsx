import { Button } from '@/components/ui/button'
import type { PageProps } from '../pages.gen'

export default function Home({ message }: PageProps<'Home'>) {
  return (
    <main className='p-8'>
      <h1 className='text-2xl font-bold'>{message}</h1>
      <Button className='mt-4'>shadcn/ui</Button>
    </main>
  )
}
