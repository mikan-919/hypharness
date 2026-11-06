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

export function DialogPage({ topics, queue, questions, entries, started, goal, edits }: Dialog) {
  const topicList = signal(topics)
  const items = signal(questions)
  const pending = signal(queue)
  const entryList = signal(entries)
  const editList = signal(edits)
  const goalText = signal(goal.text)
  const goalVersion = signal(goal.version)
  const draft = signal(goal.text)
  const dirty = signal(false)
  const conflict = signal(false)
  const failure = signal('')
  const reply = signal('')
  const picked = signal('')
  const sending = signal(false)
  const isStarted = signal(started)
  const usage = signal<Record<string, Usage>>({})
  const head = derived(() => items().find((q) => q.id === pending()[0]))
  const history = derived(() => [...editList()].reverse())
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
          {failure() && <p class="conflict">{failure()}</p>}
          {head() && (
            <article class="question head">
              <h2>{head().text}</h2>
              <ul class="options">
                {head().options.map((option) => (
                  <li key={option.label}>
                    <button
                      type="button"
                      class={`option ${option.recommended ? 'recommended' : ''} ${option.label === picked() ? 'picked' : ''}`}
                      data-label={option.label}
                      disabled={sending()}
                      onClick={choose}
                    >
                      <strong>
                        {option.label === picked() ? '✓ ' : ''}
                        {option.recommended ? `${option.label}（推奨）` : option.label}
                      </strong>
                      <span>{option.description}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <p class="recommendation">{head().recommendation}</p>
              <form class="reply" onSubmit={answer}>
                <textarea
                  value={reply()}
                  onInput={updateReply}
                  placeholder={picked() ? '補足があれば書く' : '選択肢を選ぶか、答えを書く'}
                />
                <button type="submit" disabled={sending()}>
                  {picked() ? `「${picked()}」で答える` : '書いた答えを送る'}
                </button>
                <p class="hint">
                  {picked()
                    ? '欄に書いた補足は、選んだ選択肢と一緒に送る'
                    : '選択肢を選ばずに送ると、欄に書いた文がそのまま答えになる'}
                </p>
              </form>
            </article>
          )}
          <div class="goal-head">
            <h1>FINAL_GOAL.md</h1>
            <span class="hint">版 {goalVersion()}</span>
          </div>
          <form class="goal" onSubmit={save}>
            <textarea
              value={draft()}
              onInput={updateDraft}
              placeholder="作りたいものを書く。論点エージェントがこの本文を一緒に書き換える"
            />
            {conflict() ? (
              <p class="conflict">
                保存の前に本文が書き換えられました。
                <button type="button" onClick={loadLatest}>
                  最新を読み込む
                </button>
                <button type="button" onClick={overwrite}>
                  このまま上書きする
                </button>
              </p>
            ) : (
              <button type="submit" disabled={sending()}>
                保存
              </button>
            )}
          </form>
        </main>

        <aside class="context">
          <section class="metrics">
            <h2>トークン</h2>
            <p class="big">{totalOutput()}</p>
            <p>出力の合計（ストリーミング中）</p>
            <p>${totalCost()}</p>
          </section>
          <h2>書き換えの履歴</h2>
          {history().map((edit) => (
            <div key={edit.id} class={`edit ${edit.author === 'user' ? 'user' : 'agent'}`}>
              <div class="edit-head">
                <strong>
                  {edit.author === 'user' ? '利用者' : (topicList().find((t) => t.id === edit.author)?.title ?? edit.author)}
                </strong>
                <span class="hint">版 {edit.version}</span>
                <button type="button" data-id={edit.id} onClick={revert}>
                  この前に戻す
                </button>
              </div>
              <p>{edit.reason}</p>
              <pre class="diff">
                {edit.diff
                  .filter((l) => l.op !== ' ')
                  .map((l) => `${l.op} ${l.line}`)
                  .join('\n')}
              </pre>
            </div>
          ))}
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
    // 中継が論点ごとの合計を送ってくる
    usageSource.onmessage = (event) => usage(JSON.parse(event.data))
    const dialogSource = new EventSource('/api/dialog')
    dialogSource.onmessage = (event) => {
      const next = JSON.parse(event.data)
      topicList(next.topics)
      items(next.questions)
      pending(next.queue)
      entryList(next.entries)
      editList(next.edits)
      isStarted(next.started)
      goalText(next.goal.text)
      goalVersion(next.goal.version)
      // 書きかけでなければ、他の書き手の書き換えをそのまま映す
      draft(dirty() ? draft() : next.goal.text)
    }
    return () => {
      usageSource.close()
      dialogSource.close()
    }
  })

  function updateDraft(event) {
    draft(event.currentTarget.value)
    dirty(event.currentTarget.value !== goalText())
  }

  function updateReply(event) {
    reply(event.currentTarget.value)
  }

  async function send(version) {
    sending(true)
    const response = await fetch('/api/goal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: draft(), version }),
      // 通信が失敗しても送信中の印を解除する（開発サーバーの再起動と重なると fetch が失敗する）
    }).catch(() => Response.json({ error: 'サーバーにつながりません。少し待ってからもう一度送ってください' }, { status: 503 }))
    sending(false)
    conflict(response.status === 409)
    failure(response.ok || response.status === 409 ? '' : `保存できませんでした（${response.status}）`)
    dirty(response.ok ? false : dirty())
  }

  function save(event) {
    event.preventDefault()
    draft(event.currentTarget.querySelector('textarea').value)
    send(goalVersion())
  }

  function overwrite() {
    send(goalVersion())
  }

  function loadLatest() {
    draft(goalText())
    dirty(false)
    conflict(false)
  }

  async function revert(event) {
    await fetch('/api/revert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: event.currentTarget.dataset.id }),
    })
  }

  // 欄の文字は送るときに欄から読む。日本語入力の途中の値が状態に届かないブラウザーがあるため
  function answer(event) {
    event.preventDefault()
    const note = event.currentTarget.querySelector('textarea').value.trim()
    sendAnswer(picked() && note ? `${picked()}（${note}）` : picked() || note)
  }

  // 選択肢を押したら選んだ状態にする。もう一度押すと外す。送るのは送るボタンで
  function choose(event) {
    const label = event.currentTarget.dataset.label
    picked(picked() === label ? '' : label)
  }

  async function sendAnswer(text) {
    sending(true)
    const response = await fetch('/api/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: head().id, text }),
      // 通信が失敗しても送信中の印を解除する（開発サーバーの再起動と重なると fetch が失敗する）
    }).catch(() => Response.json({ error: 'サーバーにつながりません。少し待ってからもう一度送ってください' }, { status: 503 }))
    sending(false)
    reply(response.ok ? '' : reply())
    picked(response.ok ? '' : picked())
    failure(response.ok ? '' : `送れませんでした: ${(await response.json().catch(() => ({}))).error ?? response.status}`)
  }

  // ponytail: 開始の合図は表示を変えるだけ。分解役ができたら固定部へ送る
  function start() {
    isStarted(true)
  }
}
