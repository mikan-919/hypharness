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

const taskLabel = { solving: '解いている', checking: '検査中', committed: '積んだ', held: '保留' }

const agentLabel = { decompose: '分解役', solve: '解答役', host: '固定部', evolve: '自己改良' }

const tabLabel = { activity: '活動', tasks: '課題', evolution: '進化', context: '共有文脈', history: '履歴' }

// ループの段階。上から順に、今の段階を1つだけ強調する
const stages = [
  { n: 1, label: '目的を詰める' },
  { n: 2, label: '開始の合図' },
  { n: 3, label: '課題を解く' },
  { n: 4, label: '統合' },
  { n: 5, label: '自己改良の1周' },
]

const evolutionStageLabel = { proposing: '変更案を作っている', validating: '候補を検査している', done: '終えた' }

// タブの見出しに件数を添える。
// ponytail: irisout 0.3.7 は derived(() => ({ ... })) の括弧を落とすため、オブジェクトを返す derived を使わずに関数にする
function tabTitle(name: keyof typeof tabLabel, tasks: number, entries: number, edits: number) {
  const count = name === 'tasks' ? tasks : name === 'context' ? entries : name === 'history' ? edits : -1
  return count < 0 ? tabLabel[name] : `${tabLabel[name]} ${count}`
}

// 長い理由の見出し。最初の文か、80 文字まで
function headline(text: string) {
  const first = text.split(/\n|。/)[0]
  return first.length > 80 ? `${first.slice(0, 80)}…` : first
}

// 動きの時刻（時:分:秒）
function clock(at: number) {
  return new Date(at).toLocaleTimeString('ja-JP', { hour12: false })
}

// 自己改良の1周の補足。まだ始まっていなければ空
function evolutionNote(e: Evolution | null) {
  return e ? `第 ${e.round} 周・${evolutionStageLabel[e.stage]}` : ''
}

// 課題ごとの記録の1行。キャッシュの割合は、入力のうちキャッシュから読んだ分
function usageLine(u: TaskUsage | undefined) {
  if (!u) return ''
  const cached = u.input + u.cacheRead > 0 ? Math.round((u.cacheRead / (u.input + u.cacheRead)) * 100) : 0
  const n = (value: number) => value.toLocaleString('ja-JP')
  return `呼び出し ${u.calls} 回・入力 ${n(u.input + u.cacheRead)}（キャッシュ ${cached}%）・出力 ${n(u.output)}・最大の文脈 ${n(u.maxPrompt)}・edit_context ${u.edits} 回・作り直し ${u.rebuilds} 回・$${u.costUsd.toFixed(4)}`
}

// 進化タブに並べる行。候補ごとの入れ子を避け、1段の並びにする
function evolutionRowList(e: Evolution | null) {
  if (!e) return []
  const rows: { key: string; text: string; kind: string }[] = []
  for (const candidate of e.candidates) {
    const verdict = candidate.commit ? `積んだ ${candidate.commit.slice(0, 8)}` : candidate.score === 1 ? '検査に通った' : '採用しなかった'
    rows.push({ key: `${candidate.id}-id`, text: `${candidate.id}・${candidate.module}・${verdict}`, kind: `candidate ${candidate.commit ? 'adopted' : 'rejected'}` })
    candidate.changes.forEach((change, i) => {
      rows.push({ key: `${candidate.id}-change-${i}`, text: change, kind: 'change' })
    })
    if (candidate.note) rows.push({ key: `${candidate.id}-note`, text: candidate.note, kind: 'note' })
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
  const tab = signal<keyof typeof tabLabel>('activity')
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
  const newestTasks = derived(() => [...taskList()].reverse())
  const newestEntries = derived(() => [...entryList()].reverse())
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
  const dirty = derived(() => draft() !== savedText())
  // 自己改良の1周が動いているか
  const evolving = derived(() => isStarted() && finishedReason() !== '' && evolutionNow() !== null && evolutionNow().stage !== 'done')
  // 今の段階の番号（1 始まり）。止まっていないときにだけ使う
  const stage = derived(() =>
    evolving() ? 5 : isStarted() ? 3 : majority() ? 2 : 1,
  )
  // 今の段階の補足
  const stageNote = derived(() =>
    stage() === 1
      ? `開始可 ${readyCount()} / ${topicList().length}`
      : stage() === 2
        ? '押すと課題を進め始める'
        : stage() === 3
          ? isStopping() ? '今の課題を終えたら止める' : `課題 ${taskList().length} 件目まで進んだ`
          : evolutionNote(evolutionNow()),
  )
  const evolutionRows = derived(() => evolutionRowList(evolutionNow()))
  const totalOutput = derived(() => Object.values(usage()).reduce((sum, u) => sum + u.output, 0))
  const totalCost = derived(() =>
    Object.values(usage())
      .reduce((sum, u) => sum + u.costUsd, 0)
      .toFixed(4),
  )
  const unanswered = derived(() => pending().length)

  render(
    <Layout title="hypharness">
      <div class="shell">
        <aside class="threads">
          <div class="brand">hypharness</div>
          {haltedReason() !== '' && (
            <div class="stage halted">
              <span class="number">!</span>
              <span class="name">止まった</span>
              <span class="note">{headline(haltedReason())}</span>
            </div>
          )}
          {haltedReason() === '' && (
            <ol class="stages">
              {stages.map((s) => (
                <li key={s.label} class={`stage ${stage() === s.n ? 'current' : stage() > s.n ? 'past' : ''}`}>
                  <span class="number">{stage() > s.n ? '✓' : s.n}</span>
                  <span class="name">{s.label}</span>
                  <span class="note">{stage() === s.n ? stageNote() : ''}</span>
                </li>
              ))}
            </ol>
          )}
          <div class="start">
            <button type="button" class="primary" disabled={isStarted() || !majority()} onClick={start}>
              {isStarted() ? '流れが動いている' : '開始の合図'}
            </button>
            {isStarted() && (
              <button type="button" class="stop" disabled={isStopping()} onClick={stop}>
                {isStopping() ? '今の課題を終えたら止める' : '止める'}
              </button>
            )}
            <p class="hint">{`開始のツール ${readyCount()} / ${topicList().length}`}</p>
          </div>
          <h2>論点</h2>
          {topicList().map((topic) => (
            <div key={topic.id} class={`thread ${topic.state}`}>
              <span class="dot" />
              <span class="name">{topic.title}</span>
              <span class="state">{stateLabel[topic.state]}</span>
              <span class="tokens">{`出力 ${usage()[topic.id]?.output ?? 0}`}</span>
            </div>
          ))}
        </aside>

        <main class="conversation">
          {haltedReason() && (
            <details class="banner fail">
              <summary>{`流れが止まった: ${headline(haltedReason())}`}</summary>
              <p>{haltedReason()}</p>
            </details>
          )}
          {finishedReason() && !haltedReason() && (
            <details class="banner done">
              <summary>{`前回の流れは最終目的を満たして終えた: ${headline(finishedReason())}`}</summary>
              <p>{finishedReason()}</p>
            </details>
          )}
          {failure() && <p class="banner fail">{failure()}</p>}
          <form class="goal" onSubmit={save}>
            <div class="goal-head">
              <h1>FINAL_GOAL.md</h1>
              <span class="hint">{`版 ${savedVersion()}`}</span>
              {dirty() && <span class="badge wait">未保存</span>}
              {saved() && !dirty() && <span class="badge done">{saved()}</span>}
              <button type="submit" class="primary" disabled={sending() || !dirty() || conflict()}>
                保存
              </button>
            </div>
            {conflict() && (
              <p class="banner fail">
                保存の前に本文が書き換えられました。
                <button type="button" onClick={loadLatest}>
                  最新を読み込む
                </button>
                <button type="button" onClick={overwrite}>
                  このまま上書きする
                </button>
              </p>
            )}
            <div class="editor" />
          </form>
          {head() && (
            <article class="question">
              <div class="question-head">
                <span class="badge wait">質問</span>
                {unanswered() > 1 && <span class="hint">{`ほかに ${unanswered() - 1} 件が待っている`}</span>}
              </div>
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
              {head().recommendation && <p class="recommendation">{head().recommendation}</p>}
              <form class="reply" onSubmit={answer}>
                <textarea
                  value={reply()}
                  onInput={updateReply}
                  placeholder={picked() ? '補足があれば書く' : '選択肢を選ぶか、答えを書く'}
                />
                <div class="reply-foot">
                  <span class="hint">
                    {picked()
                      ? '欄に書いた補足は、選んだ選択肢と一緒に送る'
                      : '選択肢を選ばずに送ると、欄に書いた文がそのまま答えになる'}
                  </span>
                  <button type="submit" class="primary" disabled={sending()}>
                    {picked() ? `「${picked()}」で答える` : '書いた答えを送る'}
                  </button>
                </div>
              </form>
            </article>
          )}
        </main>

        <aside class="context">
          <div class="totals">
            <div>
              <span class="value">{`$${totalCost()}`}</span>
              <span class="hint">費用</span>
            </div>
            <div>
              <span class="value">{totalOutput()}</span>
              <span class="hint">出力トークン</span>
            </div>
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
                {tabTitle(name, taskList().length, entryList().length, editList().length)}
              </button>
            ))}
          </div>
          <div class="tab-body">
            {tab() === 'activity' && (
              <div>
                {writing().map((w) => (
                  <div key={w.agent} class="activity live">
                    <div class="activity-head">
                      <strong>{agentLabel[w.agent] ?? topicList().find((t) => t.id === w.agent)?.title ?? w.agent}</strong>
                      <span class="hint">書いている</span>
                    </div>
                    <p>{w.text}</p>
                  </div>
                ))}
                {recent().length === 0 && writing().length === 0 && <p class="hint">まだ動きがありません</p>}
                {recent().map((a) => (
                  <div key={a.id} class={`activity ${a.kind}`}>
                    <div class="activity-head">
                      <strong>{agentLabel[a.agent] ?? topicList().find((t) => t.id === a.agent)?.title ?? a.agent}</strong>
                      <span class="hint">{clock(a.at)}</span>
                    </div>
                    <p>{a.text}</p>
                  </div>
                ))}
              </div>
            )}
            {tab() === 'tasks' && (
              <div>
                {taskList().length === 0 && <p class="hint">まだ課題がありません</p>}
                {newestTasks().map((task) => (
                  <details key={task.id} class={`task ${task.state}`}>
                    <summary>
                      <span class="task-id">{task.id}</span>
                      <span class="task-title">{task.statement.split('\n')[0]}</span>
                      <span class={`badge ${task.state}`}>{taskLabel[task.state]}</span>
                    </summary>
                    <p class="hint">
                      {`試行 ${task.attempts} 回${task.commit ? `・コミット ${task.commit.slice(0, 8)}` : ''}${task.usage ? `・$${task.usage.costUsd.toFixed(4)}` : ''}`}
                    </p>
                    {task.state === 'held' && <p class="reason">{task.reason}</p>}
                    {task.usage && <p class="hint">{usageLine(task.usage)}</p>}
                    {task.state === 'committed' && task.diff && <pre class="diff">{task.diff}</pre>}
                  </details>
                ))}
              </div>
            )}
            {tab() === 'evolution' && (
              <div>
                {!evolutionNow() && <p class="hint">まだ自己改良の周がありません</p>}
                {evolutionNow() && (
                  <p class="evolution-head">
                    {`第 ${evolutionNow().round} 周・${evolutionStageLabel[evolutionNow().stage]}・$${evolutionNow().spent.toFixed(4)}`}
                  </p>
                )}
                {evolutionRows().map((row) => (
                  <p key={row.key} class={row.kind}>
                    {row.text}
                  </p>
                ))}
              </div>
            )}
            {tab() === 'context' && (
              <div>
                {entryList().length === 0 && <p class="hint">まだ共有文脈がありません</p>}
                {newestEntries().map((entry) => (
                  <div key={entry.id} class={`entry ${entry.kind}`}>
                    <span class={`badge ${entry.kind}`}>{kindLabel[entry.kind]}</span>
                    <p>{entry.text}</p>
                    <small>{entry.evidence}</small>
                  </div>
                ))}
              </div>
            )}
            {tab() === 'history' && (
              <div>
                {history().map((edit) => (
                  <details key={edit.id} class={`edit ${edit.author === 'user' ? 'user' : 'agent'}`}>
                    <summary>
                      <strong>
                        {edit.author === 'user' ? '利用者' : (topicList().find((t) => t.id === edit.author)?.title ?? edit.author)}
                      </strong>
                      <span class="hint">{`版 ${edit.version}`}</span>
                      <span class="edit-reason">{edit.reason}</span>
                    </summary>
                    <pre class="diff">
                      {edit.diff
                        .filter((l) => l.op !== ' ')
                        .map((l) => `${l.op} ${l.line}`)
                        .join('\n')}
                    </pre>
                    <button type="button" data-id={edit.id} onClick={revert}>
                      この版の前に戻す
                    </button>
                  </details>
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
