import { Link } from '@inertiajs/react'
import { type FormEvent, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { post } from '@/lib/api'
import type { PageProps } from '../pages.gen'

// ランナーの runner/index.ts の status() が返す形
type Status = {
  goal: string
  cycle: number
  running: boolean
  nextSettleAt: number | null
  log: string[]
  companies: {
    id: number
    name: string
    philosophy: string
    capital: number
    value: number
    workers: string[]
    pool: { id: number; body: string }[]
  }[]
  investors: { name: string; cash: number }[]
  ideas: {
    id: number
    company_id: number
    worker: string
    title: string
    body: string
    file: string | null
    score: number | null
    cycle: number
  }[]
  messages: {
    id: number
    from_agent: string
    to_agent: string
    content: string
  }[]
}

export default function Economy(props: PageProps<'Economy'>) {
  const [status, setStatus] = useState(props.status as Status | null)
  const [goal, setGoal] = useState(status?.goal ?? '')
  const [error, setError] = useState('')

  // ループを回しているあいだは、進み具合を取りに行く
  useEffect(() => {
    if (!status?.running) return
    const timer = setInterval(async () => {
      const response = await fetch('/economy/status')
      if (response.ok) setStatus((await response.json()) as Status)
    }, 3000)
    return () => clearInterval(timer)
  }, [status?.running])

  const run = (task: () => Promise<Status>) => async () => {
    setError('')
    try {
      setStatus(await task())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const saveGoal = (e: FormEvent) => {
    e.preventDefault()
    run(() => post<Status>('/economy/goal', { goal }))()
  }

  if (!status) {
    return (
      <main className='mx-auto flex max-w-3xl flex-col gap-4 p-8'>
        <Link href='/' className='text-sm underline'>
          ホームへ
        </Link>
        <p>ランナーが未接続です。手元で bun run runner を実行してください。</p>
      </main>
    )
  }

  return (
    <main className='mx-auto flex max-w-3xl flex-col gap-6 p-8'>
      <header className='flex items-center justify-between'>
        <h1 className='text-2xl font-bold'>
          経済（第{status.cycle}期{status.running ? '、稼働中' : ''}）
        </h1>
        <Link href='/' className='text-sm underline'>
          ホームへ
        </Link>
      </header>

      <form className='flex gap-2' onSubmit={saveGoal}>
        <Input
          aria-label='目的'
          placeholder='目的'
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          required
        />
        <Button type='submit' variant='outline'>
          目的を設定
        </Button>
      </form>
      <div className='flex items-center gap-3'>
        {status.running ? (
          <Button
            variant='outline'
            onClick={run(() => post<Status>('/economy/stop'))}
          >
            停止
          </Button>
        ) : (
          <Button
            onClick={run(() => post<Status>('/economy/start'))}
            disabled={!status.goal}
          >
            開始
          </Button>
        )}
        {status.nextSettleAt && (
          <p className='text-sm'>
            次の精算:{' '}
            {new Date(status.nextSettleAt).toLocaleTimeString('ja-JP')}
          </p>
        )}
      </div>
      {error && <p className='text-destructive text-sm'>{error}</p>}

      <section className='flex flex-col gap-2'>
        <h2 className='font-bold'>会社</h2>
        {status.companies.map((c) => (
          <div key={c.id} className='rounded-lg bg-muted p-3 text-sm'>
            <p className='font-bold'>
              {c.id}: {c.name}（価値 {c.value.toFixed(1)}、資本{' '}
              {c.capital.toFixed(1)}）
            </p>
            <p>設計思想: {c.philosophy || '未設定'}</p>
            <p>worker: {c.workers.join(', ') || 'なし'}</p>
            <p>タスクプール（未着手 {c.pool.length}件）</p>
            {c.pool.length > 0 && (
              <ul className='list-disc pl-5'>
                {c.pool.map((t) => (
                  <li key={t.id}>{t.body}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </section>

      <section className='flex flex-col gap-1 text-sm'>
        <h2 className='font-bold'>投資家</h2>
        {status.investors.map((i) => (
          <p key={i.name}>
            {i.name}: 資金 {i.cash.toFixed(1)}
          </p>
        ))}
      </section>

      <section className='flex flex-col gap-2 text-sm'>
        <h2 className='font-bold'>最近のアイデア</h2>
        {status.ideas.map((i) => (
          <div key={i.id}>
            <p className='font-bold'>
              {i.title}（第{i.cycle}期、会社 {i.company_id}、{i.worker}、評価{' '}
              {i.score ?? '未評価'}）
            </p>
            <p className='whitespace-pre-wrap'>{i.body}</p>
            {i.file && <p>ファイル: {i.file}</p>}
          </div>
        ))}
      </section>

      <section className='flex flex-col gap-1 text-sm'>
        <h2 className='font-bold'>worker 同士のメッセージ</h2>
        {status.messages.map((m) => (
          <p key={m.id} className='whitespace-pre-wrap'>
            {m.from_agent} → {m.to_agent}: {m.content}
          </p>
        ))}
      </section>

      <section className='flex flex-col gap-1 text-sm'>
        <h2 className='font-bold'>ログ</h2>
        <pre className='overflow-x-auto rounded-lg bg-muted p-3 text-xs'>
          {status.log.join('\n') || '（まだありません）'}
        </pre>
      </section>
    </main>
  )
}
