import { onMount, render, signal } from 'irisout'
import { Layout } from '../Layout.tsx'
import type { Dialog, Task, TaskUsage, Usage } from '../../shared/dialog.ts'
import { AGENT_DIET } from '../../harness/settings.ts'

const taskLabel = { solving: '解いている', checking: '検査中', committed: '積んだ', held: '保留' }

const agentLabel = { decompose: '分解役', solve: '解答役', host: '固定部', evolve: '自己改良' }

const n = (value: number) => Math.round(value).toLocaleString('ja-JP')

// 入力のうちキャッシュから読んだ割合（%）
function cacheRate(input: number, cacheRead: number) {
  return input + cacheRead > 0 ? Math.round((cacheRead / (input + cacheRead)) * 100) : 0
}

// 課題の記録の合計。記録の無い課題は数えない
function sum(tasks: Task[]): TaskUsage {
  const total = { calls: 0, input: 0, cacheRead: 0, output: 0, maxPrompt: 0, edits: 0, rebuilds: 0, costUsd: 0 }
  for (const { usage } of tasks) {
    if (!usage) continue
    for (const key of ['calls', 'input', 'cacheRead', 'output', 'edits', 'rebuilds', 'costUsd'] as const) total[key] += usage[key]
    total.maxPrompt = Math.max(total.maxPrompt, usage.maxPrompt)
  }
  return total
}

// 上に並べる数。irisout#7 のため、オブジェクトを返す derived を使わずに関数にする
function cards(tasks: Task[], totals: Record<string, Usage>) {
  const all = sum(tasks)
  const committed = tasks.filter((t) => t.state === 'committed').length
  const held = tasks.filter((t) => t.state === 'held').length
  const usages = Object.values(totals)
  const cost = usages.reduce((s, u) => s + u.costUsd, 0)
  const input = usages.reduce((s, u) => s + u.input, 0)
  const cacheRead = usages.reduce((s, u) => s + u.cacheRead, 0)
  const used = usages.reduce((s, u) => s + u.input + u.cacheRead + (u.cacheWrite ?? 0) + u.output, 0)
  return [
    { label: '費用', value: `$${cost.toFixed(4)}` },
    { label: '総利用トークン', value: n(used) },
    { label: 'キャッシュの割合', value: `${cacheRate(input, cacheRead)}%` },
    { label: '課題', value: `${committed} 積んだ / ${held} 保留 / ${tasks.length} 件` },
    { label: '積んだ割合', value: committed + held > 0 ? `${Math.round((committed / (committed + held)) * 100)}%` : '—' },
    { label: '積んだ課題1件の費用', value: committed > 0 ? `$${(tasks.filter((t) => t.state === 'committed').reduce((s, t) => s + t.spent, 0) / committed).toFixed(4)}` : '—' },
    { label: `最大の文脈（しきい値 ${n(AGENT_DIET.compactAtTokens)}）`, value: n(all.maxPrompt) },
    { label: 'edit_context・作り直し', value: `${all.edits} 回・${all.rebuilds} 回` },
  ]
}

export function MetricsPage({ tasks, topics }: Dialog) {
  const taskList = signal(tasks)
  const topicList = signal(topics)
  const usage = signal<Record<string, Usage>>({})

  render(
    <Layout title="hypharness のメトリクス">
      <div class="metrics">
        <header class="metrics-head">
          <a class="brand" href="/">hypharness</a>
          <span class="hint">メトリクス。費用・トークン・エージェントごとの値は今の起動で数えた分で、再起動すると 0 に戻る</span>
        </header>
        <section class="totals metric-cards">
          {cards(taskList(), usage()).map((card) => (
            <div key={card.label}>
              <span class="value">{card.value}</span>
              <span class="hint">{card.label}</span>
            </div>
          ))}
        </section>

        <h2>課題ごと</h2>
        {taskList().length === 0 && <p class="hint">まだ課題がありません</p>}
        {taskList().length > 0 && (
          <div class="table-wrap">
            <table class="metric-table">
              <thead>
                <tr>
                  <th>課題</th>
                  <th>状態</th>
                  <th>試行</th>
                  <th>呼び出し</th>
                  <th>入力</th>
                  <th>キャッシュ</th>
                  <th>出力</th>
                  <th>最大の文脈（しきい値との比）</th>
                  <th>edit_context</th>
                  <th>作り直し</th>
                  <th>費用</th>
                </tr>
              </thead>
              <tbody>
                {[...taskList()].reverse().map((t) => (
                  <tr key={t.id}>
                    <td class="statement" title={t.statement}>{`${t.id} ${t.statement.split('\n')[0].slice(0, 60)}`}</td>
                    <td><span class={`badge ${t.state}`}>{taskLabel[t.state]}</span></td>
                    <td>{t.attempts}</td>
                    <td>{t.usage ? t.usage.calls : '—'}</td>
                    <td>{t.usage ? n(t.usage.input + t.usage.cacheRead) : '—'}</td>
                    <td>{t.usage ? `${cacheRate(t.usage.input, t.usage.cacheRead)}%` : '—'}</td>
                    <td>{t.usage ? n(t.usage.output) : '—'}</td>
                    <td>
                      {t.usage && (
                        <span class="prompt">
                          <meter min={0} max={AGENT_DIET.compactAtTokens} high={AGENT_DIET.compactAtTokens * 0.8} value={t.usage.maxPrompt} />
                          <span>{n(t.usage.maxPrompt)}</span>
                        </span>
                      )}
                    </td>
                    <td>{t.usage ? t.usage.edits : '—'}</td>
                    <td>{t.usage ? t.usage.rebuilds : '—'}</td>
                    <td>{`$${t.spent.toFixed(4)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h2>エージェントごと</h2>
        {Object.keys(usage()).length === 0 && <p class="hint">まだモデルを呼んでいません</p>}
        {Object.keys(usage()).length > 0 && (
          <div class="table-wrap">
            <table class="metric-table">
              <thead>
                <tr>
                  <th>エージェント</th>
                  <th>入力</th>
                  <th>キャッシュの読み出し</th>
                  <th>キャッシュの書き込み</th>
                  <th>キャッシュの割合</th>
                  <th>出力</th>
                  <th>費用</th>
                </tr>
              </thead>
              <tbody>
                {Object.values(usage()).map((u) => (
                  <tr key={u.topicId}>
                    <td>{agentLabel[u.topicId] ?? topicList().find((t) => t.id === u.topicId)?.title ?? u.topicId}</td>
                    <td>{n(u.input)}</td>
                    <td>{n(u.cacheRead)}</td>
                    <td>{n(u.cacheWrite ?? 0)}</td>
                    <td>{`${cacheRate(u.input, u.cacheRead)}%`}</td>
                    <td>{n(u.output)}</td>
                    <td>{`$${u.costUsd.toFixed(4)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Layout>,
  )

  onMount(() => {
    const usageSource = new EventSource('/api/usage')
    usageSource.onmessage = (event) => usage(JSON.parse(event.data))
    const dialogSource = new EventSource('/api/dialog')
    dialogSource.onmessage = (event) => {
      const next = JSON.parse(event.data)
      taskList(next.tasks)
      topicList(next.topics)
    }
    return () => {
      usageSource.close()
      dialogSource.close()
    }
  })
}
