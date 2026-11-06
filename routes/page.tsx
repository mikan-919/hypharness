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
  const topicList = signal(topics)
  const items = signal(questions)
  const pending = signal(queue)
  const entryList = signal(entries)
  const selected = signal('')
  const draft = signal('')
  const sending = signal(false)
  const isStarted = signal(started)
  const usage = signal<Record<string, Usage>>({})
  const head = derived(() => pending()[0] ?? '')
  const current = derived(() => items().find((q) => q.id === (selected() || head())))
  const readyCount = derived(() => topicList().filter((t) => t.ready).length)
  const majority = derived(() => readyCount() * 2 > topicList().length)
  const totalOutput = derived(() => Object.values(usage()).reduce((sum, u) => sum + u.output, 0))
  const totalCost = derived(() =>
    Object.values(usage())
      .reduce((sum, u) => sum + u.costUsd, 0)
      .toFixed(4),
  )

  render(
    <Layout title="hypharness">
      <div class="shell">
        <aside class="threads">
          <h2>論点</h2>
          {topicList().map((topic) => (
            <div key={topic.id} class={`thread ${topic.state}`}>
              <span class="avatar">{topic.title.slice(0, 1)}</span>
              <span class="name">{topic.title}</span>
              <span class="state">{stateLabel[topic.state]}</span>
              <span class="tokens">{usage()[topic.id]?.output ?? 0}</span>
            </div>
          ))}
          <div class="start">
            <p>
              開始のツール {readyCount()} / {topicList().length}
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
                class={`chip ${q.id === head() ? 'head' : ''} ${q.answer ? 'answered' : ''}`}
                data-id={q.id}
                onClick={select}
              >
                {q.id}
              </button>
            ))}
          </nav>
          {current() ? (
            <article class={`question ${current().id === head() ? 'head' : ''}`}>
              <h1>{current().text}</h1>
              <ul class="options">
                {current().options.map((option) => (
                  <li key={option.label} class={option.recommended ? 'recommended' : ''}>
                    <strong>{option.label}</strong>
                    <span>{option.description}</span>
                  </li>
                ))}
              </ul>
              <p class="recommendation">{current().recommendation}</p>
              {current().answer ? (
                <p class="answer">答え: {current().answer}</p>
              ) : (
                <form class="reply" onSubmit={answer}>
                  <textarea value={draft()} onInput={updateDraft} placeholder="答えを書く" />
                  <button type="submit" disabled={sending()}>
                    送る
                  </button>
                </form>
              )}
            </article>
          ) : (
            <p class="hint">論点エージェントが調べています。</p>
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
          {entryList().map((entry) => (
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
    const usageSource = new EventSource('/api/usage')
    usageSource.onmessage = (event) => {
      const u = JSON.parse(event.data)
      usage((prev) => {
        const old = prev[u.topicId] ?? { topicId: u.topicId, input: 0, output: 0, cacheRead: 0, costUsd: 0 }
        return {
          ...prev,
          [u.topicId]: {
            topicId: u.topicId,
            input: old.input + u.input,
            output: old.output + u.output,
            cacheRead: old.cacheRead + u.cacheRead,
            costUsd: old.costUsd + u.costUsd,
          },
        }
      })
    }
    const dialogSource = new EventSource('/api/dialog')
    dialogSource.onmessage = (event) => {
      const next = JSON.parse(event.data)
      topicList(next.topics)
      items(next.questions)
      pending(next.queue)
      entryList(next.entries)
      isStarted(next.started)
    }
    return () => {
      usageSource.close()
      dialogSource.close()
    }
  })

  function select(event) {
    selected(event.currentTarget.dataset.id)
  }

  function updateDraft(event) {
    draft(event.currentTarget.value)
  }

  async function answer(event) {
    event.preventDefault()
    sending(true)
    const response = await fetch('/api/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: current().id, text: draft() }),
    })
    sending(false)
    // 答えた後は待ち行列の先頭を表示する。断られたら書いた答えを残す
    draft(response.ok ? '' : draft())
    selected(response.ok ? '' : selected())
  }

  // ponytail: 開始の合図は表示を変えるだけ。分解役ができたら固定部へ送る
  function start() {
    isStarted(true)
  }
}
