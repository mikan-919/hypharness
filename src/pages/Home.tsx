import { router } from '@inertiajs/react'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { post } from '@/lib/api'
import type { PageProps } from '../pages.gen'

export default function Home({ user, runnerConnected }: PageProps<'Home'>) {
  const logout = async () => {
    await post('/auth/logout')
    router.visit('/login')
  }

  return (
    <main className='mx-auto flex max-w-2xl flex-col gap-6 p-8'>
      <header className='flex items-center justify-between'>
        <h1 className='text-2xl font-bold'>{user.name}</h1>
        <Button variant='outline' onClick={logout}>
          ログアウト
        </Button>
      </header>
      <RunnerSetup connected={runnerConnected} />
      <Chat />
    </main>
  )
}

function RunnerSetup({ connected }: { connected: boolean }) {
  const [token, setToken] = useState('')

  const issue = async () => {
    setToken((await post<{ token: string }>('/runner/token')).token)
  }

  return (
    <section className='flex flex-col gap-2 text-sm'>
      <p>
        {connected
          ? 'ランナーが接続中です。'
          : 'ランナーが未接続のため、エージェントは応答できません。'}
      </p>
      {token ? (
        <pre className='overflow-x-auto rounded-lg bg-muted p-3'>
          {`bun run runner login\nbun run runner setup ${location.origin} ${token}\nbun run runner`}
        </pre>
      ) : (
        <Button variant='outline' onClick={issue}>
          ランナー用トークンを発行
        </Button>
      )}
    </section>
  )
}

type Line = { role: 'user' | 'assistant'; content: string }

function Chat() {
  const [agent, setAgent] = useState('default')
  const [message, setMessage] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  const send = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setSending(true)
    setLines((prev) => [...prev, { role: 'user', content: message }])
    try {
      const { reply } = await post<{ reply: string }>(
        `/agents/${encodeURIComponent(agent)}/chat`,
        { message },
      )
      setLines((prev) => [...prev, { role: 'assistant', content: reply }])
      setMessage('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  return (
    <section className='flex flex-col gap-3'>
      <Input
        aria-label='エージェント名'
        value={agent}
        onChange={(e) => {
          setAgent(e.target.value)
          setLines([])
        }}
      />
      <ul className='flex flex-col gap-2'>
        {lines.map((line, i) => (
          // 表示用の一時的な履歴で、並べ替えや削除はしない
          // biome-ignore lint/suspicious/noArrayIndexKey: 追記のみの一覧
          <li key={i} className={line.role === 'user' ? 'text-right' : ''}>
            <span className='inline-block whitespace-pre-wrap rounded-lg bg-muted px-3 py-2'>
              {line.content}
            </span>
          </li>
        ))}
      </ul>
      <form className='flex gap-2' onSubmit={send}>
        <Input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          required
        />
        <Button type='submit' disabled={sending}>
          送信
        </Button>
      </form>
      {error && <p className='text-destructive text-sm'>{error}</p>}
    </section>
  )
}
