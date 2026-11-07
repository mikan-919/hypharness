import { derived, onMount, render, signal } from 'irisout'
import { Layout } from './Layout.tsx'
import type { Dialog, Evolution, TaskUsage, Usage } from '../shared/dialog.ts'
import { mountMonaco } from 'hyph-monaco'

const stateLabel = {
  researching: '調査中',
  asking: '質問待ち',
  ready: '開始可',
  blocked: '詰まり',
}

const kindLabel = { fact: '事実', fail: '失敗', done: '完了' }

const taskLabel = { solving: '解いている', checking: '検査中', committed: '統合ブランチに積んだ', held: '保留' }

const agentLabel = { decompose: '分解役', solve: '解答役', host: '固定部', evolve: '自己改良' }

const tabLabel = { tasks: '課題', activity: '活動', evolution: '進化', context: '共有文脈', history: '履歴' }

// ループの段階。上から順に、今の段階を1つだけ強調する
const stages = [
  { n: 1, label: '目的を詰める' },
  { n: 2, label: '開始の合図' },
  { n: 3, label: '課題を解く' },
  { n: 4, label: '統合' },
  { n: 5, label: '自己改良の1周' },
]

// 自己改良の1周の補足。まだ始まっていなければ空
function evolutionNote(e: Evolution | null) {
  return e ? `第 ${e.round} 周（${e.stage}）` : ''
}

// 課題ごとの記録の1行。キャッシュの割合は、入力のうちキャッシュから読んだ分
function usageLine(u: TaskUsage | undefined) {
  if (!u) return ''
  const cached = u.input + u.cacheRead > 0 ? Math.round((u.cacheRead / (u.input + u.cacheRead)) * 100) : 0
  return `呼び出し ${u.calls} 回・入力 ${u.input + u.cacheRead}（キャッシュ ${cached}%）・出力 ${u.output}・最大の文脈 ${u.maxPrompt}・edit_context ${u.edits} 回・作り直し ${u.rebuilds} 回・$${u.costUsd.toFixed(4)}`
}

// 進化タブに並べる行。候補ごとの入れ子を避け、1段の並びにする
function evolutionRowList(e: Evolution | null) {
  if (!e) return []
  const rows: { key: string; text: string; kind: string }[] = [
    { key: 'round', text: `第 ${e.round} 周`, kind: '' },
    { key: 'summary', text: `段階 ${e.stage}・費用 $${e.spent.toFixed(4)}`, kind: 'hint' },
  ]
  for (const candidate of e.candidates) {
    rows.push({ key: `${candidate.id}-id`, text: `# ${candidate.id}`, kind: 'candidate' })
    rows.push({ key: `${candidate.id}-module`, text: candidate.module, kind: 'hint' })
    candidate.changes.forEach((change, i) => {
      rows.push({ key: `${candidate.id}-change-${i}`, text: change, kind: 'change' })
    })
    rows.push({ key: `${candidate.id}-score`, text: `score ${candidate.score}`, kind: 'hint' })
    if (candidate.note) rows.push({ key: `${candidate.id}-note`, text: candidate.note, kind: 'note' })
    if (candidate.commit)
      rows.push({ key: `${candidate.id}-commit`, text: `コミット ${candidate.commit.slice(0, 8)}`, kind: 'hint' })
  }
  return rows
}

export function DialogPage({ topics, queue, questions, entries, started, goal, edits, tasks, activity, live, halted, stopping, finished, evolution }: Dialog) {
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
  // 保存の成功の表示。保存を始めたら空にし、200 の応答で版を入れる
  const saved = signal('')
  const isStarted = signal(started)
  const taskList = signal(tasks)
  const activityList = signal(activity)
  const liveText = signal(live)
  const haltedReason = signal(halted)
  const finishedReason = signal(finished)
  const isStopping = signal(stopping)
  const evolutionNow = signal<Evolution | null>(evolution)
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
  // 今の段階の番号（1 始まり）。止まっていないときにだけ使う
  const stage = derived(() =>
    !isStarted() ? (majority() ? 2 : 1) : !finishedReason() ? 3 : evolutionNow() ? 5 : 4,
  )
  // 今の段階の補足
  const stageNote = derived(() =>
    stage() === 1
      ? `開始可 ${readyCount()} / ${topicList().length}`
      : stage() === 2
        ? '論点の過半数が開始可になった'
        : stage() === 3
          ? isStopping() ? '今の課題を終えたら止める' : '分解役と解答役が課題を進めている'
          : stage() === 4
            ? finishedReason()
            : evolutionNote(evolutionNow()),
  )
  const startHint = derived(() =>
    isStarted()
      ? '分解役と解答役が課題を進めている'
      : majority()
        ? '過半数の論点が開始可になった。押すと課題を進め始める'
        : '論点の過半数が開始可になると押せる',
  )
  const evolutionRows = derived(() => evolutionRowList(evolutionNow()))
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
          {haltedReason() !== '' && (
            <div class="stage halted">
              <span class="number">!</span>
              <span class="name">止まり</span>
              <span class="note">{haltedReason()}</span>
            </div>
          )}
          {haltedReason() === '' && (
            <div class="stages">
              {stages.map((s) => (
                <div key={s.label} class={`stage ${stage() === s.n ? 'current' : ''}`}>
                  <span class="number">{s.n}</span>
                  <span class="name">{s.label}</span>
                  <span class="note">{stage() === s.n ? stageNote() : ''}</span>
                </div>
              ))}
            </div>
          )}
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
          {finishedReason() && <p class="finished">{`最終目的を満たしたため、流れを終えました: ${finishedReason()}`}</p>}
          {failure() && <p class="conflict">{failure()}</p>}
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
            {saved() && <p class="hint">{saved()}</p>}
          </form>
          {items().length > 0 && (
            <div class="queue">
              {items().map((q) => (
                <span key={q.id} class={`chip ${pending()[0] === q.id ? 'head' : ''} ${q.answer !== '' ? 'answered' : ''}`}>
                  {q.id}
                </span>
              ))}
            </div>
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
          {!head() && <p class="hint">質問はありません</p>}
        </main>

        <aside class="context">
          <div class="totals">
            <span>{`${totalCost()}`}</span>
            <span>{`出力 ${totalOutput()} トークン`}</span>
          </div>
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
            {tab() === 'tasks' && (
              <div>
                <h2>課題</h2>
                {taskList().length === 0 && <p class="hint">まだ課題がありません</p>}
                {taskList().map((task) => (
                  <div key={task.id} class={`task ${task.state}`}>
                    <strong>{task.id}</strong>
                    <span class="state">{taskLabel[task.state]}</span>
                    <p>{task.statement.split('\n')[0]}</p>
                    <p class="hint">{`試行 ${task.attempts} 回・コミット ${task.commit.slice(0, 8)}・費用 ${task.spent} ドル`}</p>
                    {task.state === 'held' && <p class="reason">{`${task.reason}（使った費用 ${task.spent} ドル）`}</p>}
                    {task.state === 'committed' && task.diff && <pre class="diff">{task.diff}</pre>}
                    {task.usage && <p class="hint">{usageLine(task.usage)}</p>}
                  </div>
                ))}
              </div>
            )}
            {tab() === 'activity' && (
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
              </div>
            )}
            {tab() === 'evolution' && (
              <div>
                <h2>自己改良</h2>
                {!evolutionNow() && <p class="hint">まだ自己改良の周がありません</p>}
                {evolutionNow() && (
                  <div>
                    {evolutionRows().map((row) => (
                      <p key={row.key} class={row.kind}>
                        {row.text}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}
            {tab() === 'context' && (
              <div>
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
      void mountMonaco(element, draft(), (text) => {
        draft(text)
        // 本文が変わったら、保存の成功の表示を消す
        saved('')
      }).then(
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
      finishedReason(next.finished ?? '')
      isStopping(next.stopping)
      evolutionNow(next.evolution ?? null)
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
    saved('')
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
    if (response.ok) saved(`保存した（版 ${body.version}）`)
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
