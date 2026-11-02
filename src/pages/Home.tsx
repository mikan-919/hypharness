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
  const names = new Map(status.nodes.map((n) => [n.id, n.name]))

  return (
    <main className='mx-auto flex max-w-3xl flex-col gap-8 p-4 sm:p-8'>
      <header className='flex items-center justify-between'>
        <h1 className='text-2xl font-bold'>{user.name}</h1>
        <Button variant='outline' onClick={logout}>
          ログアウト
        </Button>
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
      <section className='flex flex-col gap-2 text-sm'>
        <h2 className='text-lg font-bold'>タスク</h2>
        <NewTask />
        <div className='overflow-x-auto'>
          <table className='w-full text-left'>
            <thead>
              <tr>
                <th>番号</th>
                <th>コマンド</th>
                <th>状態</th>
                <th>ノード</th>
                <th>世代</th>
                <th>終了コード</th>
              </tr>
            </thead>
            <tbody>
              {status.tasks.map((t) => (
                <tr key={t.id} className='align-top'>
                  <td>
                    <History id={t.id} />
                  </td>
                  <td className='font-mono break-all'>{t.command}</td>
                  <td>{t.state}</td>
                  <td>{t.node ? (names.get(t.node) ?? '切断中') : ''}</td>
                  <td>{t.generation}</td>
                  <td>{t.code ?? ''}</td>
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
  const [command, setCommand] = useState('')
  const [error, setError] = useState('')

  const add = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      await post('/tasks', { command })
      setCommand('')
      router.reload({ only: ['status'] })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      <form className='flex gap-2' onSubmit={add}>
        <Input
          aria-label='コマンド'
          placeholder='隔離環境で実行するコマンド'
          className='font-mono'
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          required
        />
        <Button type='submit'>追加</Button>
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
