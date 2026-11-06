import {
  Background,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from '@xyflow/react'
import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import type { Graph, Step } from './graph'

type Live = {
  file: string
  task: number
  generation: number
  statement: string
}
type Run = {
  id: number
  task: number
  ok: number
  cost: number
  commit: string
  split: string
  statement: string
}
type Runs = { live: Live[]; sessions: { session: string; runs: Run[] }[] }

const LANE_WIDTH = 360
const ROW_HEIGHT = 110

function StepNode({ data }: NodeProps<Node<{ step: Step }>>) {
  const s = data.step
  return (
    <div className={`step ${s.error ? 'error' : s.kind}`}>
      <Handle type='target' position={Position.Top} />
      <b>{s.title}</b>
      <span>{s.text}</span>
      <Handle type='source' position={Position.Bottom} />
      {/* 委任は右へ、子からの戻りは左へ出す */}
      <Handle type='source' position={Position.Right} id='out' />
      <Handle type='target' position={Position.Left} id='in' />
      <Handle type='source' position={Position.Left} id='back' />
      <Handle type='target' position={Position.Right} id='return' />
    </div>
  )
}
const nodeTypes = { step: StepNode }

// 列は会話ごと。子の会話は、親の delegate と同じ高さから始める
function layout(g: Graph) {
  const start = new Map<number, number>()
  const row = new Map<string, number>()
  const counts = new Map<number, number>()
  for (const s of g.steps) {
    const offset = start.get(s.lane) ?? 0
    const n = counts.get(s.lane) ?? 0
    row.set(s.id, offset + n)
    counts.set(s.lane, n + 1)
    for (const e of g.edges) {
      if (e.from === s.id && e.kind === 'delegate') {
        const child = g.steps.find((t) => t.id === e.to)
        if (child) start.set(child.lane, offset + n)
      }
    }
  }
  const nodes: Node<{ step: Step }>[] = g.steps.map((s) => ({
    id: s.id,
    type: 'step',
    position: { x: s.lane * LANE_WIDTH, y: (row.get(s.id) ?? 0) * ROW_HEIGHT },
    data: { step: s },
  }))
  const edges: Edge[] = g.edges.map((e, i) => ({
    id: `${i}`,
    source: e.from,
    target: e.to,
    animated: e.kind !== 'next',
    sourceHandle:
      e.kind === 'delegate' ? 'out' : e.kind === 'return' ? 'back' : undefined,
    targetHandle:
      e.kind === 'delegate' ? 'in' : e.kind === 'return' ? 'return' : undefined,
    label:
      e.kind === 'delegate' ? '委任' : e.kind === 'return' ? '要約' : undefined,
    markerEnd: { type: MarkerType.ArrowClosed },
  }))
  return { nodes, edges }
}

function App() {
  const [runs, setRuns] = useState<Runs>({ live: [], sessions: [] })
  const [query, setQuery] = useState('')
  const [graph, setGraph] = useState<Graph | null>(null)
  const [selected, setSelected] = useState<Step | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/runs')
      .then((r) => r.json() as Promise<Runs>)
      .then(setRuns)
      .catch((e) => setError(String(e)))
  }, [])
  // 実際のタスクは実行中も記録が増えるため、選んでいる間は5秒ごとに読み直す
  useEffect(() => {
    if (!query) return
    const load = () =>
      fetch(`/api/graph?${query}`)
        .then(async (r) => {
          const body = (await r.json()) as Graph & { error?: string }
          if (!r.ok) throw new Error(body.error)
          setGraph(body)
          setError('')
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
    load()
    if (!query.startsWith('live=')) return
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [query])
  const flow = useMemo(() => (graph ? layout(graph) : null), [graph])
  const choose = (q: string) => {
    setQuery(q)
    setSelected(null)
  }

  return (
    <>
      <aside>
        <h2>実際のタスク</h2>
        {runs.live.map((l) => {
          const q = `live=${encodeURIComponent(l.file)}`
          return (
            <button
              key={l.file}
              type='button'
              className={query === q ? 'on' : ''}
              onClick={() => choose(q)}
            >
              #{l.task}（世代 {l.generation}） {l.statement.slice(0, 40)}
            </button>
          )
        })}
        {runs.sessions.map((s) => (
          <div key={s.session}>
            <h2>計測: {s.session}</h2>
            {s.runs.map((r) => {
              const q = `session=${s.session}&run=${r.id}`
              return (
                <button
                  key={r.id}
                  type='button'
                  className={query === q ? 'on' : ''}
                  onClick={() => choose(q)}
                >
                  {r.ok ? '○' : '×'} 試行 {r.id} {r.split} 課題 {r.task}（
                  {r.commit.slice(0, 7)}、${r.cost.toFixed(4)}）
                </button>
              )
            })}
          </div>
        ))}
      </aside>
      <div>
        {error && <p style={{ padding: 12 }}>{error}</p>}
        {flow ? (
          <ReactFlow
            nodes={flow.nodes}
            edges={flow.edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, n) => setSelected((n.data as { step: Step }).step)}
            fitView
            minZoom={0.05}
          >
            <Background />
            <Controls />
          </ReactFlow>
        ) : (
          <p style={{ padding: 12 }}>左から実行を選んでください。</p>
        )}
      </div>
      <div className='detail'>
        {selected ? (
          <>
            <b>{selected.title}</b>
            <pre>{selected.text}</pre>
          </>
        ) : (
          <p>図の箱を選ぶと全文が出ます。</p>
        )}
      </div>
    </>
  )
}

createRoot(document.getElementById('app') as HTMLElement).render(<App />)
