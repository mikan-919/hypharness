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
  // runner/loop.ts の Activity
  agents: {
    name: string
    state: '待機' | '順番待ち' | '実行中' | '失敗' | '停止'
    since: number
    label: string
    detail: string
    tools: number
  }[]
  log: string[]
  companies: {
    id: number
    name: string
    philosophy: string
    capital: number
    value: number
    workers: string[]
    tasks: {
      id: number
      worker: string | null
      body: string
      result: string | null
    }[]
    board: { id: number; from_agent: string; content: string }[]
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
  sharedContext: { label: string; gist: string; source: string }[]
}

export default function Economy(props: PageProps<'Economy'>) {
  const [status, setStatus] = useState(props.status as Status | null)
  const [goal, setGoal] = useState(status?.goal ?? '')
  const [error, setError] = useState('')

  // ループを回しているあいだと、止めたあとに動き終えていないエージェントがいるあいだは、進み具合を取りに行く
  const busy =
    status?.running ||
    status?.agents.some((a) => a.state === '実行中' || a.state === '順番待ち')
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(async () => {
      const response = await fetch('/economy/status')
      if (response.ok) setStatus((await response.json()) as Status)
    }, 3000)
    return () => clearInterval(timer)
  }, [busy])

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

      <section className='flex flex-col gap-2 text-sm'>
        <h2 className='font-bold'>エージェント</h2>
        {status.agents.length === 0 && <p>（まだ動いていません）</p>}
        {status.agents.map((a) => (
          <div key={a.name} className='flex gap-3'>
            <span className='w-28 shrink-0 font-bold'>{a.name}</span>
            <span
              className={`w-28 shrink-0 ${a.state === '失敗' ? 'text-destructive' : ''}`}
            >
              {a.state}（{elapsed(a.since)}）
            </span>
            <span className='min-w-0 break-words'>
              {(a.state === '実行中' || a.state === '順番待ち') && a.label && (
                <span className='font-bold'>{a.label}: </span>
              )}
              {a.state === '実行中' && `ツール ${a.tools}回、直近 `}
              {a.detail}
            </span>
          </div>
        ))}
      </section>

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
            <p>
              仕事: 未着手{' '}
              {c.tasks.filter((t) => !t.worker && !t.result).length}
              件、作業中 {c.tasks.filter((t) => t.worker && !t.result).length}
              件、完了 {c.tasks.filter((t) => t.result).length}
              件（新しい20件のうち）
            </p>
            {c.board.length > 0 && (
              <details>
                <summary>掲示板（{c.board.length}件）</summary>
                {c.board.map((b) => (
                  <p key={b.id} className='whitespace-pre-wrap'>
                    {b.from_agent}: {b.content}
                  </p>
                ))}
              </details>
            )}
            {c.tasks.length > 0 && (
              <details>
                <summary>仕事の一覧</summary>
                <ul className='list-disc pl-5'>
                  {c.tasks.map((t) => (
                    <li key={t.id} className='whitespace-pre-wrap'>
                      [
                      {t.result
                        ? `完了 ${t.worker}`
                        : t.worker
                          ? `作業中 ${t.worker}`
                          : '未着手'}
                      ] {t.id}: {t.body}
                      {t.result && `\n→ ${t.result}`}
                    </li>
                  ))}
                </ul>
              </details>
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
        <h2 className='font-bold'>共有コンテキスト</h2>
        {status.sharedContext.map((c) => (
          <p key={c.label}>
            [{c.label}] {c.gist}（{c.source}）
          </p>
        ))}
      </section>

      <section className='flex flex-col gap-1 text-sm'>
        <h2 className='font-bold'>worker 同士のメッセージ（質問・依頼）</h2>
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

// 状態が変わってからの時間。ポーリングで描き直すたびに更新される
function elapsed(since: number) {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000))
  return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分`
}
