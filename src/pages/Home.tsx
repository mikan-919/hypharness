import { router } from '@inertiajs/react'
import { type FormEvent, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { post } from '@/lib/api'
import type { PageProps } from '../pages.gen'
import type { HistoryEvent } from '../queue'

// ponytail: 状態は3秒ごとに取り直す。ノードやタスクが増えて重くなったら、中継から変更を送る
const POLL_MS = 3000

export default function Home({ user, status }: PageProps<'Home'>) {
  useEffect(() => {
    const timer = setInterval(
      () => router.reload({ only: ['status'] }),
      POLL_MS,
    )
    return () => clearInterval(timer)
  }, [])

  const logout = async () => {
    await post('/auth/logout')
    router.visit('/login')
  }
  const reset = async () => {
    if (
      !confirm(
        'タスク・履歴・費用・進化の記録・チェックポイントをすべて消します。元に戻せません',
      )
    )
      return
    try {
      await post('/reset')
      router.reload()
    } catch (e) {
      alert(`消せませんでした: ${e instanceof Error ? e.message : e}`)
    }
  }
  const names = new Map(status.nodes.map((n) => [n.id, n.name]))

  return (
    <main className='mx-auto flex max-w-3xl flex-col gap-8 p-4 sm:p-8'>
      <header className='flex items-center justify-between'>
        <h1 className='text-2xl font-bold'>{user.name}</h1>
        <div className='flex gap-2'>
          <Button variant='outline' onClick={reset}>
            記録を消す
          </Button>
          <Button variant='outline' onClick={logout}>
            ログアウト
          </Button>
        </div>
      </header>
      <section className='flex flex-col gap-2 text-sm'>
        <h2 className='text-lg font-bold'>ノード</h2>
        {status.nodes.length ? (
          <ul className='list-disc pl-5'>
            {status.nodes.map((n) => (
              <li key={n.id}>{n.name}</li>
            ))}
          </ul>
        ) : (
          <p>
            接続中のノードはありません。手元で bun run node
            を実行し、表示されたコードを入力してください。
          </p>
        )}
        <Pairing />
      </section>
      <Ledger rows={status.ledger} />
      <Evolution sessions={status.evolution} />
      <section className='flex flex-col gap-2 text-sm'>
        <h2 className='text-lg font-bold'>タスク</h2>
        <NewTask />
        <div className='overflow-x-auto'>
          {/* 課題文以外の列は折り返さない。長い課題文が他の列を押し縮めないよう、課題文は3行で切り、全文は title で見せる */}
          <table className='w-full text-left [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap'>
            <thead>
              <tr>
                <th>番号</th>
                <th>課題文</th>
                <th>状態</th>
                <th>ノード</th>
                <th>世代</th>
                <th>版</th>
                <th>成否</th>
              </tr>
            </thead>
            <tbody>
              {status.tasks.map((t) => (
                <tr key={t.id} className='align-top'>
                  <td>
                    <History id={t.id} />
                  </td>
                  <td className='w-full min-w-48 whitespace-normal!'>
                    <span
                      className='line-clamp-3 break-words whitespace-pre-wrap'
                      title={t.kind === 'trial' ? undefined : t.statement}
                    >
                      {t.kind === 'trial'
                        ? '（計測の試行。中身は暗号化してノードだけが読む）'
                        : t.statement}
                    </span>
                    {t.check_command && (
                      <span className='block font-mono text-muted-foreground'>
                        判定: {t.check_command}
                      </span>
                    )}
                  </td>
                  <td>{t.state}</td>
                  <td>{t.node ? (names.get(t.node) ?? '切断中') : ''}</td>
                  <td>{t.generation}</td>
                  <td className='font-mono'>{t.version?.slice(0, 7) ?? ''}</td>
                  <td>
                    {t.ok === null ? '' : t.ok ? '成功' : '失敗'}
                    {t.code !== null &&
                      t.code !== 0 &&
                      `（終了コード ${t.code}）`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  )
}

function Pairing() {
  const [code, setCode] = useState('')
  const [notice, setNotice] = useState('')

  const approve = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await post('/node/pairings/approve', { code })
      setCode('')
      setNotice('承認しました。ノードが接続するまで数秒かかります。')
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      <form className='flex gap-2' onSubmit={approve}>
        <Input
          aria-label='ノードのコード'
          placeholder='ノードのコード'
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
        />
        <Button type='submit' variant='outline'>
          承認
        </Button>
      </form>
      {notice && <p>{notice}</p>}
    </>
  )
}

function NewTask() {
  const [statement, setStatement] = useState('')
  const [check, setCheck] = useState('')
  const [error, setError] = useState('')

  const add = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      await post('/tasks', { statement, check })
      setStatement('')
      setCheck('')
      router.reload({ only: ['status'] })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      <form className='flex flex-col gap-2' onSubmit={add}>
        <textarea
          aria-label='課題文'
          placeholder='エージェントに解かせる課題文'
          className='min-h-24 rounded-md border bg-transparent p-2'
          value={statement}
          onChange={(e) => setStatement(e.target.value)}
          required
        />
        <div className='flex gap-2'>
          <Input
            aria-label='判定コマンド'
            placeholder='判定コマンド（任意。終了コード 0 で成功）'
            className='font-mono'
            value={check}
            onChange={(e) => setCheck(e.target.value)}
          />
          <Button type='submit'>追加</Button>
        </div>
      </form>
      {error && <p className='text-destructive'>{error}</p>}
    </>
  )
}

// 番号を押すと、そのタスクの実行履歴（割り当て・期限切れ・報告）を開く
function History({ id }: { id: number }) {
  const [events, setEvents] = useState<HistoryEvent[] | null>(null)
  const [error, setError] = useState('')

  const load = async () => {
    setError('')
    try {
      const response = await fetch(`/tasks/${id}/history`)
      const json = (await response.json()) as HistoryEvent[] & {
        error?: string
      }
      if (!response.ok) throw new Error(json.error ?? `${response.status}`)
      setEvents(json)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <details onToggle={(e) => e.currentTarget.open && load()}>
      <summary className='cursor-pointer'>{id}</summary>
      {error && <p className='text-destructive'>{error}</p>}
      <ul>
        {events?.map((e) => (
          <li key={`${e.at}-${e.kind}`}>
            {new Date(e.at).toLocaleTimeString('ja-JP')} {e.kind} 世代
            {e.generation}
            {e.code !== null && ` 終了コード ${e.code}`}
          </li>
        ))}
      </ul>
    </details>
  )
}

const KIND_NAMES = {
  task: '目的遂行',
  local: '局所改善',
  self: '自己改善',
  verify: '検証',
} as const
const dollars = (x: number | null) =>
  x === null ? '上限なし' : `$${x.toFixed(4)}`

// 期（日）ごとの予算・使用額・改善量。ノードが1分ごとに送る
function Ledger({ rows }: { rows: PageProps<'Home'>['status']['ledger'] }) {
  return (
    <section className='flex flex-col gap-2 text-sm'>
      <h2 className='text-lg font-bold'>資源配分</h2>
      {rows.length ? (
        <div className='overflow-x-auto'>
          <table className='w-full text-left'>
            <thead>
              <tr>
                <th>期</th>
                <th>区分</th>
                <th>予算</th>
                <th>使用額</th>
                <th>改善量（成功率）</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.period}-${r.kind}`}>
                  <td>{r.period}</td>
                  <td>{KIND_NAMES[r.kind]}</td>
                  <td>{dollars(r.budget)}</td>
                  <td>{dollars(r.spent)}</td>
                  <td>{r.improvement ? `+${r.improvement.toFixed(3)}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>ノードからの内訳はまだありません。</p>
      )}
    </section>
  )
}

const STATUS_NAMES: Record<string, string> = {
  base: '最初の基準版',
  adopted: '採用',
  measured: '計測済み',
  rejected: '不採用',
  pending: '承認待ち',
  requested: '承認済み（ノードの処理待ち）',
  approved: 'PR 作成済み',
}

// オフライン RSI の系統と、固定部の変更の提案。提案は承認すると、そのセッションのノードが hypharness に PR を作る
function Evolution({
  sessions,
}: {
  sessions: PageProps<'Home'>['status']['evolution']
}) {
  const [error, setError] = useState('')
  const approve = async (session: string, id: number) => {
    setError('')
    try {
      await post('/proposals/approve', { session, id })
      router.reload({ only: ['status'] })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <section className='flex flex-col gap-2 text-sm'>
      <h2 className='text-lg font-bold'>進化</h2>
      {error && <p className='text-destructive'>{error}</p>}
      {sessions.length ? (
        sessions.map((e) => (
          <div key={e.session} className='flex flex-col gap-2'>
            <h3 className='font-bold'>
              {e.session}（{new Date(e.at).toLocaleTimeString('ja-JP')} 時点）
            </h3>
            <div className='overflow-x-auto'>
              <table className='w-full text-left'>
                <thead>
                  <tr>
                    <th>候補</th>
                    <th>親</th>
                    <th>状態</th>
                    <th>検証用の成功率</th>
                  </tr>
                </thead>
                <tbody>
                  {e.lineage.map((c) => (
                    <tr key={c.commit} className='font-mono'>
                      <td>{c.commit.slice(0, 7)}</td>
                      <td>{c.parent?.slice(0, 7) ?? ''}</td>
                      <td className='font-sans'>
                        {STATUS_NAMES[c.status] ?? c.status}
                      </td>
                      <td>{c.val === null ? '' : c.val.toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {e.proposals.length > 0 && (
              <ul className='flex flex-col gap-1'>
                {e.proposals.map((p) => (
                  <li key={p.id} className='flex flex-wrap items-center gap-2'>
                    <span>
                      提案 #{p.id}（候補 {p.parent.slice(0, 7)}、{p.lines} 行）:{' '}
                      <span className='font-mono'>{p.files.join(', ')}</span>{' '}
                      {STATUS_NAMES[p.status]}
                    </span>
                    {p.status === 'pending' && (
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={() => approve(e.session, p.id)}
                      >
                        承認して PR にする
                      </Button>
                    )}
                    {p.pr && (
                      <a className='underline' href={p.pr}>
                        PR
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))
      ) : (
        <p>ノードからの系統はまだありません。</p>
      )}
    </section>
  )
}
