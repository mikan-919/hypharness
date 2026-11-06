import { derived, onMount, render, signal } from 'irisout'
import { Layout } from './Layout.tsx'
import type { Dialog, Usage } from '../shared/dialog.ts'
import { mountMonaco } from 'hyph-monaco'

const stateLabel = {
  researching: '調査中',
  asking: '質問待ち',
  ready: '開始可',
  blocked: '詰まり',
}

const kindLabel = { fact: '事実', fail: '失敗', done: '完了' }

const taskLabel = { solving: '解いている', checking: '検査中', committed: '統合ブランチに積んだ', held: '保留' }

const agentLabel = { decompose: '分解役', solve: '解答役', host: '固定部' }

const tabLabel = { context: '共有文脈', history: '書き換えの履歴', cost: '費用' }

export function DialogPage({ topics, queue, questions, entries, started, goal, edits, tasks, activity, live, halted, stopping }: Dialog) {
  const topicList = signal(topics)
  const items = signal(questions)
  const pending = signal(queue)
  const entryList = signal(entries)
  const editList = signal(edits)
  // 右列で選んでいるタブ。通知が届いても変えない
  const tab = signal<keyof typeof tabLabel>('context')
  // 保存済みの本文と版。保存の要求にはこの版を渡す
  const savedText = signal(goal.text)
  const savedVersion = signal(goal.version)
  const draft = signal(goal.text)
  // Monaco のエディタ。クライアントの onMount が走った後にだけ入る
  const editor = signal<{ setValue(value: string): void; getValue(): string; dispose(): void } | null>(null)
  const conflict = signal(false)
  const failure = signal('')
  const reply = signal('')
  const picked = signal('')
  const sending = signal(false)
  const isStarted = signal(started)
  const taskList = signal(tasks)
  const activityList = signal(activity)
  const liveText = signal(live)
  const haltedReason = signal(halted)
  const isStopping = signal(stopping)
  const recent = derived(() => [...activityList()].reverse().slice(0, 60))
  const writing = derived(() =>
    Object.entries(liveText())
      .filter((entry) => entry[1])
      .map((entry) => ({ agent: entry[0], text: entry[1].slice(-240) })),
  )
  const usage = signal<Record<string, Usage>>({})
  const head = derived(() => items().find((q) => q.id === pending()[0]))
  const history = derived(() => [...editList()].reverse())
  const readyCount = derived(() => topicList().filter((t) => t.ready).length)
  const majority = derived(() => readyCount() * 2 > topicList().length)
  const startHint = derived(() =>
    isStarted()
      ? '分解役と解答役が課題を進めている'
      : majority()
        ? '過半数の論点が開始可になった。押すと課題を進め始める'
        : '論点の過半数が開始可になると押せる',
  )
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
            <button type="button" disabled={isStarted() || !majority()} onClick={start}>
              {isStarted() ? '流れが動いている' : '開始の合図'}
            </button>
            <p class="hint">{startHint()}</p>
            {isStarted() && (
              <button type="button" class="stop" disabled={isStopping()} onClick={stop}>
                {isStopping() ? '今の課題を終えたら止める' : '止める'}
              </button>
            )}
          </div>
        </aside>

        <main class="conversation">
          {haltedReason() && <p class="conflict">{`流れが止まりました: ${haltedReason()}`}</p>}
          {failure() && <p class="conflict">{failure()}</p>}
          {taskList().length > 0 && (
            <section class="tasks">
              <h2>課題</h2>
              {taskList().map((task) => (
                <div key={task.id} class={`task ${task.state}`}>
                  <strong>{task.id}</strong>
                  <span class="state">
                    {`${taskLabel[task.state]}${task.attempts > 1 ? `（${task.attempts} 回目）` : ''} ${task.commit.slice(0, 8)}`}
                  </span>
                  <p>{task.statement.split('\n')[0]}</p>
                  {task.state === 'held' && <p class="reason">{`${task.reason}（使った費用 ${task.spent} ドル）`}</p>}
                  {task.state === 'committed' && task.diff && <pre class="diff">{task.diff}</pre>}
                </div>
              ))}
            </section>
          )}
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
            <span class="hint">版 {savedVersion()}</span>
          </div>
          <form class="goal" onSubmit={save}>
            <div class="editor" />
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
              <button type="submit" disabled={sending() || draft() === savedText()}>
                保存
              </button>
            )}
          </form>
        </main>

        <aside class="context">
          <div class="tabs">
            {(Object.keys(tabLabel) as (keyof typeof tabLabel)[]).map((name) => (
              <button
                key={name}
                type="button"
                class={`tab ${tab() === name ? 'current' : ''}`}
                data-tab={name}
                onClick={pickTab}
              >
                {tabLabel[name]}
              </button>
            ))}
          </div>
          <div class="tab-body">
            {tab() === 'context' && (
              <div>
                <h2>動き</h2>
                {writing().map((w) => (
                  <div key={w.agent} class="activity live">
                    <strong>{`${agentLabel[w.agent] ?? topicList().find((t) => t.id === w.agent)?.title ?? w.agent} が書いている`}</strong>
                    <p>{w.text}</p>
                  </div>
                ))}
                {recent().map((a) => (
                  <div key={a.id} class={`activity ${a.kind}`}>
                    <strong>{agentLabel[a.agent] ?? topicList().find((t) => t.id === a.agent)?.title ?? a.agent}</strong>
                    <p>{a.text}</p>
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
              </div>
            )}
            {tab() === 'history' && (
              <div>
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
              </div>
            )}
            {tab() === 'cost' && (
              <section class="metrics">
                <h2>トークン</h2>
                <p class="big">{totalOutput()}</p>
                <p>出力の合計（ストリーミング中）</p>
                <p>${totalCost()}</p>
              </section>
            )}
          </div>
        </aside>
      </div>
    </Layout>,
  )

  // エディタの表示だけを差し替える。didChangeModelContent からの draft の更新と往復しても値は同じになる
  function showInEditor(text: string) {
    const current = editor()
    if (!current || current.getValue() === text) return
    current.setValue(text)
  }

  onMount(() => {
    // Monaco はクライアントでだけ読む。SSR の描画では monaco-editor を import しない
    const element = document.querySelector('.goal .editor') as HTMLElement | null
    if (element) {
      void mountMonaco(element, draft(), (text) => draft(text)).then(
        (created) => {
          editor(created)
          // 読み込みの間に届いた本文を映す
          showInEditor(draft())
        },
        () => failure('エディタを読み込めませんでした'),
      )
    }
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
      taskList(next.tasks)
      activityList(next.activity)
      liveText(next.live)
      haltedReason(next.halted)
      isStopping(next.stopping)
      // 書きかけでなければ、他の書き手の書き換えをそのまま映す。書きかけなら入力中の本文を変えない。
      // 保存の応答を待つ間に届いた古い版は映さない（保存済みの版を巻き戻さない）
      if (draft() === savedText() && next.goal.version >= savedVersion()) {
        draft(next.goal.text)
        savedText(next.goal.text)
        savedVersion(next.goal.version)
        showInEditor(next.goal.text)
      }
    }
    return () => {
      usageSource.close()
      dialogSource.close()
      editor()?.dispose()
      editor(null)
    }
  })

  function pickTab(event) {
    tab(event.currentTarget.dataset.tab)
  }

  function updateReply(event) {
    reply(event.currentTarget.value)
  }

  async function send() {
    sending(true)
    const response = await fetch('/api/goal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: draft(), version: savedVersion() }),
      // 通信が失敗しても送信中の印を解除する（開発サーバーの再起動と重なると fetch が失敗する）
    }).catch(() => Response.json({ error: 'サーバーにつながりません。少し待ってからもう一度送ってください' }, { status: 503 }))
    const body = await response.json().catch(() => ({}))
    sending(false)
    // 200 と 409 のどちらでも、応答の本文と版を保存済みの値にする
    if (response.ok || response.status === 409) {
      savedText(body.text)
      savedVersion(body.version)
    }
    conflict(response.status === 409)
    failure(response.ok || response.status === 409 ? '' : `保存できませんでした（${response.status}）`)
  }

  async function save(event) {
    event.preventDefault()
    // 本文はエディタが draft に写している。応答の反映は send の後（await の後）に走る
    await send()
  }

  async function overwrite() {
    // 競合の応答で受け取った版のまま、入力中の本文で送り直す
    await send()
  }

  function loadLatest() {
    draft(savedText())
    showInEditor(savedText())
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

  async function stop() {
    const response = await fetch('/api/stop', { method: 'POST' }).catch(() =>
      Response.json({ error: 'サーバーにつながりません' }, { status: 503 }),
    )
    failure(response.ok ? '' : `止められませんでした: ${(await response.json().catch(() => ({}))).error ?? response.status}`)
  }

  async function start() {
    const response = await fetch('/api/start', { method: 'POST' }).catch(() =>
      Response.json({ error: 'サーバーにつながりません' }, { status: 503 }),
    )
    failure(response.ok ? '' : `開始できませんでした: ${(await response.json().catch(() => ({}))).error ?? response.status}`)
  }
}
