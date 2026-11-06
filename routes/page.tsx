import { derived, onMount, render, signal } from 'irisout'
import { Layout } from './Layout.tsx'
import type { Dialog, Usage } from '../shared/dialog.ts'

const stateLabel = {
  researching: '調査中',
  asking: '質問待ち',
  ready: '開始可',
  blocked: '詰まり',
}

const kindLabel = { fact: '事実', fail: '失敗', done: '完了' }

export function DialogPage({ topics, queue, questions, entries, started }: Dialog) {
  const items = signal(questions)
  const pending = signal(queue)
  const selected = signal(queue[0] ?? '')
  const draft = signal('')
  const isStarted = signal(started)
  const usage = signal<Record<string, Usage>>({})
  const head = derived(() => items().find((q) => q.id === pending()[0]))
  const current = derived(() => items().find((q) => q.id === selected()))
  const readyCount = derived(() => topics.filter((t) => t.ready).length)
  const majority = derived(() => readyCount() * 2 > topics.length)
  const totalOutput = derived(() =>
    Object.values(usage()).reduce((sum, u) => sum + u.output, 0),
  )
  const totalCost = derived(() =>
    Object.values(usage()).reduce((sum, u) => sum + u.costUsd, 0).toFixed(4),
  )

  render(
    <Layout title="hypharness">
      <div class="shell">
        <aside class="threads">
          <h2>論点</h2>
          {topics.map((topic) => (
            <div key={topic.id} class={`thread ${topic.state}`}>
              <span class="avatar">{topic.title.slice(0, 1)}</span>
              <span class="name">{topic.title}</span>
              <span class="state">{stateLabel[topic.state]}</span>
              <span class="tokens">{usage()[topic.id]?.output ?? 0}</span>
            </div>
          ))}
          <div class="start">
            <p>
              開始のツール {readyCount()} / {topics.length}
            </p>
            <button type="button" disabled={isStarted()} onClick={start}>
              {isStarted() ? '開始の合図を出した' : '開始の合図'}
            </button>
            <p class="hint">{majority() ? '過半数に届いている' : '過半数に届いていない'}</p>
          </div>
        </aside>

        <main class="conversation">
          <nav class="queue">
            {items().map((q) => (
              <button
                key={q.id}
                type="button"
                class={`chip ${q.id === pending()[0] ? 'head' : ''} ${q.answer ? 'answered' : ''}`}
                data-id={q.id}
                onClick={select}
              >
                {q.id}
              </button>
            ))}
          </nav>
          {current() && (
            <article class={`question ${current().id === head()?.id ? 'head' : ''}`}>
              <h1>{current().text}</h1>
              <ul class="options">
                {current().options.map((option) => (
                  <li key={option.label} class={option.recommended ? 'recommended' : ''}>
                    <strong>{option.label}</strong>
                    <span>{option.description}</span>
                  </li>
                ))}
              </ul>
              <p class="recommendation">推奨の理由: {current().recommendation}</p>
              {current().answer ? (
                <p class="answer">
                  {current().held ? '保留中の答え: ' : '答え: '}
                  {current().answer}
                </p>
              ) : (
                <form class="reply" onSubmit={answer}>
                  <textarea value={draft()} onInput={updateDraft} placeholder="答えを書く" />
                  <button type="submit">送る</button>
                </form>
              )}
            </article>
          )}
        </main>

        <aside class="context">
          <section class="metrics">
            <h2>トークン</h2>
            <p class="big">{totalOutput()}</p>
            <p>出力の合計（ストリーミング中）</p>
            <p>${totalCost()}</p>
          </section>
          <h2>共有文脈</h2>
          {entries.map((entry) => (
            <div key={entry.id} class={`entry ${entry.kind}`}>
              <span class="kind">{kindLabel[entry.kind]}</span>
              <p>{entry.text}</p>
              <small>{entry.evidence}</small>
            </div>
          ))}
        </aside>
      </div>
    </Layout>,
  )

  onMount(() => {
    const source = new EventSource('/api/usage')
    source.onmessage = (event) => {
      const u = JSON.parse(event.data)
      usage((prev) => {
        const old = prev[u.topicId] ?? { input: 0, output: 0, cacheRead: 0, costUsd: 0 }
        return {
          ...prev,
          [u.topicId]: {
            input: old.input + u.input,
            output: old.output + u.output,
            cacheRead: old.cacheRead + u.cacheRead,
            costUsd: old.costUsd + u.costUsd,
          },
        }
      })
    }
    return () => source.close()
  })

  function select(event) {
    selected(event.currentTarget.dataset.id)
  }

  function updateDraft(event) {
    draft(event.currentTarget.value)
  }

  // ponytail: 答えは画面の中だけに残す。ハーネスへの送信は論点エージェントができてから
  function answer(event) {
    event.preventDefault()
    const id = selected()
    const text = draft()
    const isHead = id === pending()[0]
    items((prev) => prev.map((q) => (q.id === id ? { ...q, answer: text, held: !isHead } : q)))
    pending((prev) => prev.filter((q) => q !== id))
    draft('')
  }

  function start() {
    isStarted(true)
  }
}
