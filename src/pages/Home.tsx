import { router } from '@inertiajs/react'
import { type FormEvent, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { post } from '@/lib/api'
import type { PageProps } from '../pages.gen'

export default function Home({ user, codexConnected }: PageProps<'Home'>) {
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
      {codexConnected ? <Chat /> : <ConnectCodex />}
    </main>
  )
}

type Device = { userCode: string; verificationUrl: string; interval: number }

function ConnectCodex() {
  const [device, setDevice] = useState<Device>()
  const [error, setError] = useState('')

  // 利用者がコードを入力するまで、指定された間隔で確認する
  useEffect(() => {
    if (!device) return
    const timer = setInterval(async () => {
      try {
        const { status } = await post<{ status: string }>('/codex/device/poll')
        if (status === 'connected') router.reload()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setDevice(undefined)
      }
    }, device.interval * 1000)
    return () => clearInterval(timer)
  }, [device])

  const start = async () => {
    setError('')
    try {
      setDevice(await post<Device>('/codex/device'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section className='flex flex-col gap-3'>
      {device ? (
        <p>
          <a
            className='underline'
            href={device.verificationUrl}
            target='_blank'
            rel='noreferrer'
          >
            {device.verificationUrl}
          </a>
          {' で次のコードを入力してください: '}
          <code className='font-bold'>{device.userCode}</code>
        </p>
      ) : (
        <Button onClick={start}>Codex を接続</Button>
      )}
      {error && <p className='text-destructive text-sm'>{error}</p>}
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
