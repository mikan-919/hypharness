import { Link, router } from '@inertiajs/react'
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
        <div className='flex items-center gap-3'>
          <Link href='/economy' className='text-sm underline'>
            経済
          </Link>
          <Button variant='outline' onClick={logout}>
            ログアウト
          </Button>
        </div>
      </header>
      <RunnerSetup connected={runnerConnected} />
      <Chat />
    </main>
  )
}

function RunnerSetup({ connected }: { connected: boolean }) {
  const [code, setCode] = useState('')
  const [notice, setNotice] = useState('')

  const approve = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await post('/runner/pairings/approve', { code })
      setCode('')
      setNotice('承認しました。ランナーが接続するまで数秒かかります。')
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section className='flex flex-col gap-2 text-sm'>
      <p>
        {connected
          ? 'ランナーが接続中です。'
          : 'ランナーが未接続のため、エージェントは応答できません。手元で bun run runner を実行し、表示されたコードを入力してください。'}
      </p>
      <form className='flex gap-2' onSubmit={approve}>
        <Input
          aria-label='ランナーのコード'
          placeholder='ランナーのコード'
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
        />
        <Button type='submit' variant='outline'>
          承認
        </Button>
      </form>
      {notice && <p>{notice}</p>}
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
    setLines((prev) => [
      ...prev,
      { role: 'user', content: message },
      { role: 'assistant', content: '' },
    ])
    // 届いた差分を最後の応答に追記する
    const append = (delta: string) =>
      setLines((prev) => [
        ...prev.slice(0, -1),
        { role: 'assistant', content: prev[prev.length - 1].content + delta },
      ])
    try {
      const response = await fetch(
        `/agents/${encodeURIComponent(agent)}/chat`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message }),
        },
      )
      if (!response.ok || !response.body) {
        const json = (await response.json()) as { error?: string }
        throw new Error(json.error ?? `${response.status}`)
      }
      setMessage('')
      // 応答は1行に1つの JSON で届く。行の途中で区切られた分は次の読み込みとつなげる
      const reader = response.body
        .pipeThrough(new TextDecoderStream())
        .getReader()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += value
        const parts = buffer.split('\n')
        buffer = parts.pop() ?? ''
        for (const part of parts) {
          const event = JSON.parse(part) as { delta?: string; error?: string }
          if (event.error) throw new Error(event.error)
          if (event.delta) append(event.delta)
        }
      }
    } catch (e) {
      // 本文が届く前に失敗した場合は、空の応答を残さない
      setLines((prev) =>
        prev.at(-1)?.content === '' ? prev.slice(0, -1) : prev,
      )
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
