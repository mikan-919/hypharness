import { Link } from '@inertiajs/react'
import { type FormEvent, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { post } from '@/lib/api'
import type { PageProps } from '../pages.gen'

type AgentState = '待機' | '順番待ち' | '実行中' | '失敗' | '停止'
// runner/loop.ts の Activity
type Agent = {
  name: string
  state: AgentState
  since: number
  label: string
  detail: string
  tools: number
}
// ランナーの runner/index.ts の status() が返す形
type Status = {
  goal: string
  cycle: number
  running: boolean
  nextSettleAt: number | null
  agents: Agent[]
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
  stakes: { investor: string; company_id: number; amount: number }[]
  history: { cycle: number; kind: string; name: string; amount: number }[]
  ideaStats: { cycle: number; ideas: number; avg: number | null }[]
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

// 系列の色は登録順に固定で割り当てる（dataviz の既定パレット）
// ponytail: 9系列目以降は灰色。会社が増えて見分けにくくなったら系列を絞る
const SERIES = [
  '#2a78d6',
  '#eb6834',
  '#1baf7a',
  '#eda100',
  '#e87ba4',
  '#008300',
  '#6250d6',
  '#e34948',
]
const seriesColor = (i: number) => SERIES[i] ?? '#8a8985'
const ROLE_COLOR = {
  市場: '#6250d6',
  投資家: '#eb6834',
  経営: '#2a78d6',
  worker: '#1baf7a',
} as const
type Role = keyof typeof ROLE_COLOR
const STATE_COLOR: Record<AgentState, string> = {
  実行中: '#008300',
  順番待ち: '#eda100',
  失敗: '#e34948',
  待機: '#8a8985',
  停止: '#c3c2b7',
}
const STATE_ORDER: AgentState[] = ['実行中', '失敗', '順番待ち', '待機', '停止']

// runner/loop.ts の members() の名前から役割と所属を読み取る
const roleOf = (name: string): Role =>
  name === 'market'
    ? '市場'
    : name.startsWith('investor-')
      ? '投資家'
      : name.startsWith('company-')
        ? '経営'
        : 'worker'
const companyOf = (status: Status, name: string) =>
  name.startsWith('company-')
    ? status.companies.find((c) => `company-${c.id}` === name)
    : status.companies.find((c) => c.workers.includes(name))
const initials = (name: string) =>
  name === 'market'
    ? 'M'
    : `${name[0].toUpperCase()}${name.match(/\d+$/)?.[0] ?? ''}`

type Tab = 'agents' | 'graph' | 'metrics' | 'detail'
const TABS: [Tab, string][] = [
  ['agents', 'エージェント'],
  ['graph', '関係図'],
  ['metrics', 'メトリクス'],
  ['detail', '会社・ログ'],
]

export default function Economy(props: PageProps<'Economy'>) {
  const [status, setStatus] = useState(props.status as Status | null)
  const [goal, setGoal] = useState(status?.goal ?? '')
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('agents')
  const [selected, setSelected] = useState<string | null>(null)

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
    <main className='mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:px-8'>
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

      <Tiles status={status} />

      <nav className='flex gap-1 border-b'>
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type='button'
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === key ? 'border-foreground font-bold' : 'border-transparent text-muted-foreground'}`}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'agents' && (
        <Agents status={status} selected={selected} onSelect={setSelected} />
      )}
      {tab === 'graph' && (
        <>
          <Graph status={status} selected={selected} onSelect={setSelected} />
          {selected && <AgentDetail status={status} name={selected} />}
        </>
      )}
      {tab === 'metrics' && <Metrics status={status} />}
      {tab === 'detail' && <Detail status={status} />}
    </main>
  )
}

function Tiles({ status }: { status: Status }) {
  const count = (state: AgentState) =>
    status.agents.filter((a) => a.state === state).length
  const tasks = status.companies.flatMap((c) => c.tasks)
  const scored = status.ideas.filter((i) => i.score !== null)
  const tiles: [string, string, string?][] = [
    [
      'エージェント',
      `${status.agents.length}`,
      `実行中 ${count('実行中')}・待ち ${count('順番待ち')}・失敗 ${count('失敗')}`,
    ],
    ['会社', `${status.companies.length}`],
    [
      '会社の資本の合計',
      sum(status.companies.map((c) => c.capital)).toFixed(1),
    ],
    ['投資家の資金の合計', sum(status.investors.map((i) => i.cash)).toFixed(1)],
    [
      'アイデアの平均評価',
      scored.length
        ? (sum(scored.map((i) => i.score ?? 0)) / scored.length).toFixed(1)
        : '—',
      `新しい${status.ideas.length}件のうち採点済み ${scored.length}件`,
    ],
    [
      '仕事',
      `${tasks.filter((t) => t.result).length} / ${tasks.length}`,
      `完了 / 全体（会社ごとに新しい20件）`,
    ],
  ]
  return (
    <section className='grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6'>
      {tiles.map(([label, value, note]) => (
        <div key={label} className='rounded-lg border p-3'>
          <p className='text-xs text-muted-foreground'>{label}</p>
          <p className='text-2xl font-bold tabular-nums'>{value}</p>
          {note && <p className='text-xs text-muted-foreground'>{note}</p>}
        </div>
      ))}
    </section>
  )
}

function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  return (
    <span
      className='flex shrink-0 items-center justify-center rounded-full font-bold text-white'
      style={{
        width: size,
        height: size,
        background: ROLE_COLOR[roleOf(name)],
        fontSize: size / 3,
      }}
    >
      {initials(name)}
    </span>
  )
}

function StateBadge({ agent }: { agent: Agent }) {
  return (
    <span className='inline-flex items-center gap-1.5 text-xs'>
      <span
        className={`size-2 rounded-full ${agent.state === '実行中' ? 'animate-pulse' : ''}`}
        style={{ background: STATE_COLOR[agent.state] }}
      />
      {agent.state}（{elapsed(agent.since)}）
    </span>
  )
}

function Agents({
  status,
  selected,
  onSelect,
}: {
  status: Status
  selected: string | null
  onSelect: (name: string | null) => void
}) {
  if (status.agents.length === 0) {
    return <p className='text-sm'>（まだ動いていません）</p>
  }
  const agents = [...status.agents].sort(
    (a, b) =>
      STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) ||
      a.name.localeCompare(b.name, 'ja', { numeric: true }),
  )
  return (
    <div className='flex flex-col gap-4'>
      <section className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3'>
        {agents.map((a) => {
          const company = companyOf(status, a.name)
          return (
            <button
              key={a.name}
              type='button'
              onClick={() => onSelect(selected === a.name ? null : a.name)}
              className={`flex min-w-0 flex-col gap-2 rounded-xl border p-4 text-left text-sm transition-colors hover:bg-muted ${selected === a.name ? 'ring-2 ring-foreground' : ''} ${a.state === '失敗' ? 'border-destructive' : ''}`}
            >
              <div className='flex items-center gap-3'>
                <Avatar name={a.name} />
                <div className='min-w-0'>
                  <p className='truncate font-bold'>{a.name}</p>
                  <p className='truncate text-xs text-muted-foreground'>
                    {roleOf(a.name)}
                    {company && `・${company.name}`}
                  </p>
                </div>
                <span className='ml-auto'>
                  <StateBadge agent={a} />
                </span>
              </div>
              {a.label && (a.state === '実行中' || a.state === '順番待ち') && (
                <p className='font-bold'>{a.label}</p>
              )}
              <p
                className={`line-clamp-3 break-words ${a.state === '失敗' ? 'text-destructive' : 'text-muted-foreground'}`}
              >
                {a.detail || '—'}
              </p>
              {a.state === '実行中' && (
                <p className='text-xs text-muted-foreground'>
                  ツール {a.tools}回
                </p>
              )}
            </button>
          )
        })}
      </section>
      {selected && <AgentDetail status={status} name={selected} />}
    </div>
  )
}

// 選んだエージェントの、やり取り・アイデア・仕事
function AgentDetail({ status, name }: { status: Status; name: string }) {
  const agent = status.agents.find((a) => a.name === name)
  const messages = status.messages.filter(
    (m) => m.from_agent === name || m.to_agent === name,
  )
  const ideas = status.ideas.filter((i) => i.worker === name)
  const tasks = status.companies
    .flatMap((c) => c.tasks)
    .filter((t) => t.worker === name)
  const cash = status.investors.find((i) => i.name === name)?.cash
  const stakes = status.stakes.filter((s) => s.investor === name)
  return (
    <section className='flex flex-col gap-3 rounded-xl border p-4 text-sm'>
      <div className='flex items-center gap-3'>
        <Avatar name={name} size={48} />
        <div>
          <p className='text-lg font-bold'>{name}</p>
          {agent && <StateBadge agent={agent} />}
        </div>
      </div>
      {agent?.detail && (
        <p className='whitespace-pre-wrap break-words'>{agent.detail}</p>
      )}
      {cash !== undefined && (
        <p>
          資金 {cash.toFixed(1)}、出資:{' '}
          {stakes
            .map((s) => `会社 ${s.company_id} に ${s.amount.toFixed(1)}`)
            .join('、') || 'なし'}
        </p>
      )}
      {tasks.length > 0 && (
        <div>
          <h3 className='font-bold'>仕事</h3>
          <ul className='list-disc pl-5'>
            {tasks.map((t) => (
              <li key={t.id} className='whitespace-pre-wrap'>
                [{t.result ? '完了' : '作業中'}] {t.id}: {t.body}
              </li>
            ))}
          </ul>
        </div>
      )}
      {ideas.length > 0 && (
        <div>
          <h3 className='font-bold'>アイデア</h3>
          {ideas.map((i) => (
            <p key={i.id}>
              {i.title}（第{i.cycle}期、評価 {i.score ?? '未評価'}）
            </p>
          ))}
        </div>
      )}
      <div>
        <h3 className='font-bold'>メッセージ（直近30件のうち）</h3>
        {messages.length === 0 && <p>なし</p>}
        {messages.map((m) => (
          <p key={m.id} className='whitespace-pre-wrap break-words'>
            {m.from_agent} → {m.to_agent}: {m.content}
          </p>
        ))}
      </div>
    </section>
  )
}

type Node = {
  id: string
  label: string
  x: number
  y: number
  r: number
  color: string
  agent?: Agent
}
type Edge = {
  from: string
  to: string
  kind: '所属' | '出資' | '採点' | 'メッセージ'
  width: number
  note: string
}
const EDGE_STYLE = {
  所属: { stroke: '#c3c2b7', dash: undefined },
  出資: { stroke: '#eb6834', dash: undefined },
  採点: { stroke: '#6250d6', dash: '4 4' },
  メッセージ: { stroke: '#2a78d6', dash: '2 3' },
}
const W = 900
const H = 640

// 会社を楕円上に並べ、所属するエージェントをその周りに、投資家を上端に、所属のない worker を下端に置く
function layout(status: Status) {
  const nodes: Node[] = []
  const edges: Edge[] = []
  const activity = new Map(status.agents.map((a) => [a.name, a]))
  const agentNode = (name: string, x: number, y: number) =>
    nodes.push({
      id: name,
      label: name,
      x,
      y,
      r: 14,
      color: ROLE_COLOR[roleOf(name)],
      agent: activity.get(name),
    })
  const cx = W / 2
  const cy = H / 2 + 20
  agentNode('market', cx, cy)
  status.companies.forEach((c, i) => {
    // 左端から時計回りに並べ、会社が2つのときに横長の領域を左右に使う
    const angle = (i / status.companies.length) * 2 * Math.PI + Math.PI
    const x = cx + Math.cos(angle) * 270
    const y = cy + Math.sin(angle) * 170
    const id = `c:${c.id}`
    nodes.push({
      id,
      label: `${c.id}: ${c.name}`,
      x,
      y,
      r: 18 + Math.min(14, Math.sqrt(Math.max(0, c.capital))),
      color: '#52514e',
    })
    edges.push({ from: 'market', to: id, kind: '採点', width: 1, note: '' })
    const members = [`company-${c.id}`, ...c.workers]
    members.forEach((name, j) => {
      const a = angle + (j / members.length) * 2 * Math.PI
      agentNode(name, x + Math.cos(a) * 80, y + Math.sin(a) * 80)
      edges.push({ from: name, to: id, kind: '所属', width: 1.5, note: '' })
    })
  })
  status.investors.forEach((inv, i) => {
    agentNode(inv.name, ((i + 1) / (status.investors.length + 1)) * W, 30)
  })
  const placed = new Set(nodes.map((n) => n.id))
  const free = status.agents.filter((a) => !placed.has(a.name))
  free.forEach((a, i) => {
    agentNode(a.name, ((i + 1) / (free.length + 1)) * W, H - 30)
  })
  for (const s of status.stakes) {
    edges.push({
      from: s.investor,
      to: `c:${s.company_id}`,
      kind: '出資',
      width: 1 + Math.min(6, s.amount / 10),
      note: s.amount.toFixed(1),
    })
  }
  const counts = new Map<string, number>()
  for (const m of status.messages) {
    const key = `${m.from_agent}\n${m.to_agent}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const [key, n] of counts) {
    const [from, to] = key.split('\n')
    edges.push({
      from,
      to,
      kind: 'メッセージ',
      width: 1 + Math.min(4, n),
      note: `${n}件`,
    })
  }
  const byId = new Map(nodes.map((n) => [n.id, n]))
  return {
    nodes,
    byId,
    edges: edges.filter((e) => byId.has(e.from) && byId.has(e.to)),
  }
}

function Graph({
  status,
  selected,
  onSelect,
}: {
  status: Status
  selected: string | null
  onSelect: (name: string | null) => void
}) {
  const [hover, setHover] = useState<string | null>(null)
  const { nodes, byId, edges } = layout(status)
  const focus = hover ?? selected
  const touches = (e: Edge) => !focus || e.from === focus || e.to === focus
  const near = new Set(
    edges.filter((e) => focus && touches(e)).flatMap((e) => [e.from, e.to]),
  )
  return (
    <section className='flex flex-col gap-2'>
      <div className='flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground'>
        {Object.entries(ROLE_COLOR).map(([role, color]) => (
          <span key={role} className='inline-flex items-center gap-1'>
            <span
              className='size-3 rounded-full'
              style={{ background: color }}
            />
            {role}
          </span>
        ))}
        <span className='inline-flex items-center gap-1'>
          <span className='size-3 rounded-full bg-[#52514e]' />
          会社（大きさは資本）
        </span>
        {Object.entries(EDGE_STYLE).map(([kind, s]) => (
          <span key={kind} className='inline-flex items-center gap-1'>
            <svg width='20' height='6' aria-hidden='true'>
              <line
                x1='0'
                y1='3'
                x2='20'
                y2='3'
                stroke={s.stroke}
                strokeWidth='2'
                strokeDasharray={s.dash}
              />
            </svg>
            {kind}
          </span>
        ))}
        <span>外周の色は状態（緑: 実行中、黄: 順番待ち、赤: 失敗）</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className='w-full rounded-xl border bg-card'
        role='img'
        aria-label='会社・エージェント・投資家の関係図'
      >
        <defs>
          <marker
            id='arrow'
            viewBox='0 0 10 10'
            refX='10'
            refY='5'
            markerWidth='5'
            markerHeight='5'
            orient='auto-start-reverse'
          >
            <path d='M0,0 L10,5 L0,10 z' fill={EDGE_STYLE.メッセージ.stroke} />
          </marker>
        </defs>
        {edges.map((e) => {
          const a = byId.get(e.from) as Node
          const b = byId.get(e.to) as Node
          const s = EDGE_STYLE[e.kind]
          // メッセージは曲線にして、向きが逆の2本や直線の辺と重ならないようにする
          const curve = e.kind === 'メッセージ' ? 0.2 : 0
          const mx = (a.x + b.x) / 2 - (b.y - a.y) * curve
          const my = (a.y + b.y) / 2 + (b.x - a.x) * curve
          const len = Math.hypot(b.x - mx, b.y - my) || 1
          const ex = b.x - ((b.x - mx) / len) * (b.r + 3)
          const ey = b.y - ((b.y - my) / len) * (b.r + 3)
          return (
            <path
              key={`${e.kind}:${e.from}:${e.to}`}
              d={`M${a.x},${a.y} Q${mx},${my} ${ex},${ey}`}
              fill='none'
              stroke={s.stroke}
              strokeWidth={e.width}
              strokeDasharray={s.dash}
              markerEnd={e.kind === 'メッセージ' ? 'url(#arrow)' : undefined}
              opacity={touches(e) ? 0.9 : 0.1}
            >
              <title>
                {e.from} → {e.to}: {e.kind} {e.note}
              </title>
            </path>
          )
        })}
        {nodes.map((n) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: 同じ内容をエージェントの一覧からも選べる
          <g
            key={n.id}
            transform={`translate(${n.x},${n.y})`}
            opacity={!focus || focus === n.id || near.has(n.id) ? 1 : 0.25}
            onMouseEnter={() => setHover(n.id)}
            onMouseLeave={() => setHover(null)}
            onClick={() => n.agent && onSelect(selected === n.id ? null : n.id)}
            className={n.agent ? 'cursor-pointer' : undefined}
          >
            <title>
              {n.label}
              {n.agent &&
                `\n${n.agent.state}（${elapsed(n.agent.since)}）\n${n.agent.detail}`}
            </title>
            {n.agent && (
              <circle
                r={n.r + 4}
                fill='none'
                stroke={STATE_COLOR[n.agent.state]}
                strokeWidth='3'
                className={n.agent.state === '実行中' ? 'animate-pulse' : ''}
              />
            )}
            <circle
              r={n.r}
              fill={n.color}
              stroke='var(--card)'
              strokeWidth='2'
            />
            <text
              y='4'
              textAnchor='middle'
              fontSize='10'
              fontWeight='bold'
              fill='white'
            >
              {n.id.startsWith('c:') ? n.id.slice(2) : initials(n.id)}
            </text>
            <text
              y={n.r + 16}
              textAnchor='middle'
              fontSize='11'
              fill='var(--muted-foreground)'
              stroke='var(--card)'
              strokeWidth='3'
              paintOrder='stroke'
            >
              {n.label}
            </text>
          </g>
        ))}
      </svg>
      <p className='text-xs text-muted-foreground'>
        メッセージは直近30件。エージェントを押すと詳細を出します。
      </p>
    </section>
  )
}

type Series = { name: string; points: { x: number; y: number }[] }

// 精算ごとの推移。系列が多いときも1本の縦軸に収める
function LineChart({ title, series }: { title: string; series: Series[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort(
    (a, b) => a - b,
  )
  const ys = series.flatMap((s) => s.points.map((p) => p.y))
  if (!xs.length) {
    return (
      <figure className='rounded-xl border p-4 text-sm'>
        <figcaption className='font-bold'>{title}</figcaption>
        <p className='text-muted-foreground'>精算のあとに記録されます</p>
      </figure>
    )
  }
  const w = 480
  const h = 220
  const pad = { l: 44, r: 12, t: 12, b: 28 }
  const minY = Math.min(0, ...ys)
  const maxY = Math.max(1, ...ys) * 1.1
  const x = (v: number) =>
    xs.length === 1
      ? (pad.l + w - pad.r) / 2
      : pad.l +
        ((v - xs[0]) / (xs[xs.length - 1] - xs[0])) * (w - pad.l - pad.r)
  const y = (v: number) =>
    h - pad.b - ((v - minY) / (maxY - minY)) * (h - pad.t - pad.b)
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => minY + (maxY - minY) * t)
  const nearest = (clientX: number, rect: DOMRect) => {
    const vx = ((clientX - rect.left) / rect.width) * w
    return xs.reduce((best, v) =>
      Math.abs(x(v) - vx) < Math.abs(x(best) - vx) ? v : best,
    )
  }
  return (
    <figure className='flex flex-col gap-2 rounded-xl border p-4 text-sm'>
      <figcaption className='font-bold'>{title}</figcaption>
      {series.length > 1 && (
        <div className='flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground'>
          {series.map((s, i) => (
            <span key={s.name} className='inline-flex items-center gap-1'>
              <span
                className='h-0.5 w-3 rounded'
                style={{ background: seriesColor(i) }}
              />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <div className='relative'>
        <svg
          viewBox={`0 0 ${w} ${h}`}
          className='w-full'
          role='img'
          aria-label={title}
          onMouseMove={(e) =>
            setHover(
              nearest(e.clientX, e.currentTarget.getBoundingClientRect()),
            )
          }
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={pad.l}
                x2={w - pad.r}
                y1={y(t)}
                y2={y(t)}
                stroke='var(--border)'
              />
              <text
                x={pad.l - 6}
                y={y(t) + 4}
                textAnchor='end'
                fontSize='10'
                fill='var(--muted-foreground)'
              >
                {t.toFixed(t >= 100 ? 0 : 1)}
              </text>
            </g>
          ))}
          {xs.map((v) => (
            <text
              key={v}
              x={x(v)}
              y={h - 8}
              textAnchor='middle'
              fontSize='10'
              fill='var(--muted-foreground)'
            >
              第{v}期
            </text>
          ))}
          {hover !== null && (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={pad.t}
              y2={h - pad.b}
              stroke='var(--muted-foreground)'
            />
          )}
          {series.map((s, i) => (
            <g key={s.name}>
              <polyline
                points={s.points.map((p) => `${x(p.x)},${y(p.y)}`).join(' ')}
                fill='none'
                stroke={seriesColor(i)}
                strokeWidth='2'
                strokeLinejoin='round'
              />
              {s.points.map((p) => (
                <circle
                  key={p.x}
                  cx={x(p.x)}
                  cy={y(p.y)}
                  r={p.x === hover ? 5 : 3}
                  fill={seriesColor(i)}
                  stroke='var(--card)'
                  strokeWidth='2'
                />
              ))}
            </g>
          ))}
        </svg>
        {hover !== null && (
          <div
            className='pointer-events-none absolute top-0 rounded-md border bg-popover p-2 text-xs shadow'
            style={
              x(hover) > w / 2
                ? { right: `${100 - (x(hover) / w) * 100 + 2}%` }
                : { left: `${(x(hover) / w) * 100 + 2}%` }
            }
          >
            <p className='font-bold'>第{hover}期</p>
            {series.map((s, i) => {
              const p = s.points.find((p) => p.x === hover)
              return (
                p && (
                  <p key={s.name} className='flex items-center gap-1'>
                    <span
                      className='size-2 rounded-full'
                      style={{ background: seriesColor(i) }}
                    />
                    {s.name}: {p.y.toFixed(1)}
                  </p>
                )
              )
            })}
          </div>
        )}
      </div>
    </figure>
  )
}

function Metrics({ status }: { status: Status }) {
  const of = (kind: string) => {
    const series = new Map<string, Series>()
    for (const h of status.history.filter((h) => h.kind === kind)) {
      const s = series.get(h.name) ?? { name: h.name, points: [] }
      s.points.push({ x: h.cycle, y: h.amount })
      series.set(h.name, s)
    }
    return [...series.values()]
  }
  return (
    <section className='flex flex-col gap-4'>
      <div className='grid gap-4 lg:grid-cols-2'>
        <LineChart title='会社の資本（精算後）' series={of('capital')} />
        <LineChart title='会社の価値（精算後）' series={of('value')} />
        <LineChart title='投資家の資金（精算後）' series={of('cash')} />
        <LineChart
          title='アイデアの平均評価（期ごと）'
          series={[
            {
              name: '平均評価',
              points: status.ideaStats
                .filter((s) => s.avg !== null)
                .map((s) => ({ x: s.cycle, y: s.avg ?? 0 })),
            },
          ]}
        />
        <LineChart
          title='アイデアの数（期ごと）'
          series={[
            {
              name: 'アイデア',
              points: status.ideaStats.map((s) => ({ x: s.cycle, y: s.ideas })),
            },
          ]}
        />
      </div>
      <table className='w-full text-left text-sm'>
        <caption className='mb-2 text-left font-bold'>会社の現在値</caption>
        <thead className='text-xs text-muted-foreground'>
          <tr>
            <th className='py-1'>会社</th>
            <th>資本</th>
            <th>価値</th>
            <th>worker</th>
            <th>仕事 未着手 / 作業中 / 完了</th>
          </tr>
        </thead>
        <tbody className='tabular-nums'>
          {status.companies.map((c) => (
            <tr key={c.id} className='border-t'>
              <td className='py-1'>
                {c.id}: {c.name}
              </td>
              <td>{c.capital.toFixed(1)}</td>
              <td>{c.value.toFixed(1)}</td>
              <td>{c.workers.length}</td>
              <td>
                {c.tasks.filter((t) => !t.worker && !t.result).length} /{' '}
                {c.tasks.filter((t) => t.worker && !t.result).length} /{' '}
                {c.tasks.filter((t) => t.result).length}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function Detail({ status }: { status: Status }) {
  return (
    <div className='flex flex-col gap-6'>
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
    </div>
  )
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

// 状態が変わってからの時間。ポーリングで描き直すたびに更新される
function elapsed(since: number) {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000))
  return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分`
}
