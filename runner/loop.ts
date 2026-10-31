import { Type } from '@earendil-works/pi-ai'
import type { openAgent } from './agent'
import type { Economy } from './economy'
import type { RoleTool } from './tools'

const IDLE_MS = 5_000
const ERROR_MS = 30_000
const SETTLE_MS = 10 * 60_000
// ponytail: 同時に呼ぶモデルは3つまで。利用枠に余裕があれば増やす
const CONCURRENCY = 3

// エージェントが今やること。key が前回動いたときと同じなら、状況が変わっていないので動かない
export type Turn = {
  key: string
  prompt: string
  tools: RoleTool[]
  // 動き終えたあとの後始末（読んだメッセージに印を付けるなど）
  done?: () => void
}

type Agent = ReturnType<typeof openAgent>
export type LoopDeps = {
  economy: Economy
  // 役割のツールを足したうえで、エージェントに依頼して回答を得る
  ask: (name: string, prompt: string, tools: RoleTool[]) => Promise<string>
  agent: (name: string) => { agent: Agent }
  readFile: (path: string) => Promise<string | null>
  log: (line: string) => void
  idleMs?: number
  settleMs?: number
}

const text = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} に文字列を指定してください`)
  }
  return value
}
const number = (value: unknown, name: string) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} に数値を指定してください`)
  }
  return value
}
const tool = (
  name: string,
  description: string,
  parameters: RoleTool['definition']['parameters'],
  run: RoleTool['run'],
): RoleTool => ({ definition: { name, description, parameters }, run })

// ループに参加するエージェント。資本が尽きた会社や解雇された worker は外れる
export function members(e: Economy) {
  return [
    'market',
    ...e.investors().map((i) => i.name),
    ...e.companies().flatMap((c) => {
      const workers = e.workersOf(c.id)
      return workers.length ? [`company-${c.id}`, ...workers] : []
    }),
  ]
}

const companyList = (e: Economy) =>
  e
    .companies()
    .map(
      (c) =>
        `- ${c.id}: ${c.name}（設計思想: ${c.philosophy || '未設定'}、価値 ${c.value.toFixed(1)}、資本 ${c.capital.toFixed(1)}、worker ${e.workersOf(c.id).length}人）`,
    )
    .join('\n')

// 各エージェントの「今やること」を状況から組み立てる。やることがなければ null を返し、モデルを呼ばない
export async function turnFor(
  name: string,
  {
    economy: e,
    agent,
    readFile,
  }: Pick<LoopDeps, 'economy' | 'agent' | 'readFile'>,
): Promise<Turn | null> {
  const goal = e.goal()
  const cycle = e.cycle()

  if (name === 'market') {
    const ideas = e.unscoredIdeas()
    if (!ideas.length) return null
    const listing = await Promise.all(
      ideas.map(async (i) => {
        const file = i.file ? await readFile(i.file) : null
        return `- id ${i.id}（会社 ${i.company_id}、${i.worker}）${i.title}: ${i.body}${file ? `\n  ファイルの内容: ${file.slice(0, 1000)}` : ''}`
      }),
    )
    return {
      key: ideas.map((i) => i.id).join(','),
      prompt: `あなたは市場です。利用者の目的に照らして、アイデアの価値を見極めてください。
利用者の目的: ${goal}
未採点のアイデア:
${listing.join('\n')}

すべてのアイデアを score_idea で 0〜10 点で採点してください。目的への寄与、具体性、新しさを見てください。`,
      tools: [
        tool(
          'score_idea',
          'アイデアを 0〜10 点で採点する',
          Type.Object({
            id: Type.Number(),
            score: Type.Number(),
            reason: Type.String(),
          }),
          (args) => {
            e.scoreIdea(
              number(args.id, 'id'),
              number(args.score, 'score'),
              text(args.reason, 'reason'),
            )
            return '採点しました'
          },
        ),
      ],
    }
  }

  const investor = e.investors().find((i) => i.name === name)
  if (investor) {
    if (investor.cash < 1) return null
    const stakes = e
      .stakesOf(name)
      .map((s) => `- 会社 ${s.company_id}: ${s.amount.toFixed(1)}`)
      .join('\n')
    // 期ごとに1回、精算の結果を見て判断する
    return {
      key: `cycle-${cycle}`,
      prompt: `あなたは投資家「${name}」です。会社は資本が多いほど worker を雇え、市場の評価が売上になり、売上の半分が出資額に応じて配当されます。
利用者の目的: ${goal}
第${cycle}期です。手元の資金: ${investor.cash.toFixed(1)}
これまでの出資:
${stakes || '（ありません）'}
会社の一覧:
${companyList(e) || '（ありません）'}

伸びると考える会社に invest で投資してください。投資しない判断もできます。`,
      tools: [
        tool(
          'invest',
          '会社に投資する。手元の資金が会社の資本になる',
          Type.Object({ company_id: Type.Number(), amount: Type.Number() }),
          (args) => {
            e.invest(
              name,
              number(args.company_id, 'company_id'),
              number(args.amount, 'amount'),
            )
            return '投資しました'
          },
        ),
      ],
    }
  }

  if (name.startsWith('company-')) {
    const c = e.company(Number(name.slice('company-'.length)))
    if (!c) return null
    const workers = e.workersOf(c.id)
    const pool = e.pool(c.id)
    // 仕事を持たない worker の数だけ、プールに仕事があればよい
    const needed = workers.filter((w) => !e.openTask(w)).length - pool.length
    if (needed <= 0 && c.philosophy) return null
    const ideas = e
      .recentIdeas(c.id)
      .map((i) => `- ${i.title}（${i.worker}、評価 ${i.score ?? '未評価'}）`)
      .join('\n')
    return {
      key: `${cycle}|${needed}|${pool.length}|${c.philosophy}`,
      prompt: `あなたは会社「${c.name}」の経営者です。
利用者の目的: ${goal}
設計思想: ${c.philosophy || '未設定。set_philosophy で決めてください'}
資本: ${c.capital.toFixed(1)}、価値: ${c.value.toFixed(1)}
所属する worker: ${workers.join(', ')}
タスクプールにある、まだ誰も引き受けていない仕事:
${pool.map((t) => `- ${t.body}`).join('\n') || '（ありません）'}
最近のアイデアと市場の評価:
${ideas || '（まだありません）'}

設計思想に沿って、会社のタスクプールに add_task で仕事を足してください。worker は自分でプールから仕事を選びます。手の空いている worker は ${Math.max(needed, 0)} 人です。`,
      tools: [
        tool(
          'set_philosophy',
          '会社の設計思想を決める',
          Type.Object({ philosophy: Type.String() }),
          (args) => {
            e.setPhilosophy(c.id, text(args.philosophy, 'philosophy'))
            return '設計思想を更新しました'
          },
        ),
        tool(
          'add_task',
          '会社のタスクプールに仕事を足す',
          Type.Object({ body: Type.String({ description: '仕事の内容' }) }),
          (args) => {
            e.addTask(c.id, text(args.body, 'body'))
            return 'タスクプールに足しました'
          },
        ),
      ],
    }
  }

  // worker
  const companyId = e.workerCompany(name)
  const c = companyId === null ? null : e.company(companyId)
  if (!c) return null
  const task = e.openTask(name)
  const pool = task ? [] : e.pool(c.id)
  const messages = e.unread(name)
  const proposals = e.pendingProposals(name)
  if (!task && !pool.length && !messages.length && !proposals.length) {
    return null
  }
  return {
    key: [
      cycle,
      task?.id,
      pool.map((t) => t.id).join(','),
      messages.map((m) => m.id).join(','),
      proposals.map((p) => p.id).join(','),
    ].join('|'),
    prompt: `あなたは worker「${name}」で、会社「${c.name}」（id ${c.id}）に所属しています。
利用者の目的: ${goal}
会社の設計思想: ${c.philosophy || '未設定'}
同僚: ${
      e
        .workersOf(c.id)
        .filter((w) => w !== name)
        .join(', ') || 'なし'
    }
${
  task
    ? `引き受けている仕事（id ${task.id}）: ${task.body}\n終えたら finish_task で結果を報告してください。`
    : `会社のタスクプール:\n${pool.map((t) => `- id ${t.id}: ${t.body}`).join('\n') || '（ありません）'}\nやる仕事を claim_task で1つ引き受けてください。`
}
届いたメッセージ:
${messages.map((m) => `- ${m.from_agent}: ${m.content}`).join('\n') || '（ありません）'}
あなた宛ての記憶の提案:
${proposals.map((p) => `- 提案 ${p.id}（${p.from_worker} から）: ${p.content}`).join('\n') || '（ありません）'}
会社の一覧:
${companyList(e)}

成果は post_idea で登録し、詳しい内容は file_write でファイルに書いてください。
同僚との相談は send_message で行えます（to に all で全員）。
ほかの worker に覚えておいてほしいことは propose_memory で提案できます。届いた提案は decide_proposal で採否を決めてください。
ほかの会社との合併や、会社の分裂に賛成なら vote で投票できます。`,
    done: () => e.markRead(messages.map((m) => m.id)),
    tools: [
      tool(
        'claim_task',
        '自分の会社のタスクプールから仕事を引き受ける',
        Type.Object({ id: Type.Number() }),
        (args) => {
          e.claimTask(name, number(args.id, 'id'))
          return '引き受けました'
        },
      ),
      tool(
        'finish_task',
        '引き受けている仕事を終え、結果を報告する',
        Type.Object({ result: Type.String() }),
        (args) => {
          e.finishTask(name, text(args.result, 'result'))
          return '報告しました'
        },
      ),
      tool(
        'post_idea',
        '成果をアイデアとして登録する。市場が評価する',
        Type.Object({
          title: Type.String(),
          body: Type.String(),
          file: Type.Optional(
            Type.String({ description: '詳しい内容を書いたファイルのパス' }),
          ),
        }),
        (args) => {
          e.postIdea(name, {
            title: text(args.title, 'title'),
            body: text(args.body, 'body'),
            file: typeof args.file === 'string' ? args.file : undefined,
          })
          return 'アイデアを登録しました'
        },
      ),
      tool(
        'send_message',
        'worker にメッセージを送る。to に all を指定すると同じ会社の全員に送る',
        Type.Object({ to: Type.String(), content: Type.String() }),
        (args) => {
          e.sendMessage(
            name,
            text(args.to, 'to'),
            text(args.content, 'content'),
          )
          return '送りました'
        },
      ),
      tool(
        'propose_memory',
        'ほかの worker の記憶に残してほしい内容を提案する。相手が採否を決める',
        Type.Object({
          to: Type.String({ description: '相手の worker 名' }),
          content: Type.String(),
        }),
        (args) => {
          e.propose(name, text(args.to, 'to'), text(args.content, 'content'))
          return `${args.to} に提案しました`
        },
      ),
      tool(
        'decide_proposal',
        '自分宛ての記憶の提案を採用するか決める。採用すると自分の記憶に入る',
        Type.Object({ id: Type.Number(), accept: Type.Boolean() }),
        (args) => {
          const accept = args.accept === true
          const proposal = e.decideProposal(name, number(args.id, 'id'), accept)
          if (accept) {
            agent(name).agent.remember(
              'assistant',
              `（${proposal.from_worker} からの提案を採用）${proposal.content}`,
            )
          }
          return accept ? '採用しました' : '却下しました'
        },
      ),
      tool(
        'vote',
        '合併（merge、target に相手の会社 id）か、分裂（split、philosophy に新しい会社の設計思想）に投票する。精算のときに集計する',
        Type.Object({
          kind: Type.Union([Type.Literal('merge'), Type.Literal('split')]),
          target: Type.Optional(Type.Number()),
          philosophy: Type.Optional(Type.String()),
        }),
        (args) => {
          if (args.kind !== 'merge' && args.kind !== 'split') {
            throw new Error('kind は merge か split です')
          }
          e.vote(name, {
            kind: args.kind,
            target: typeof args.target === 'number' ? args.target : undefined,
            philosophy:
              typeof args.philosophy === 'string' ? args.philosophy : undefined,
          })
          return '投票しました'
        },
      ),
    ],
  }
}

// 各エージェントのループを並行に回す。顔ぶれの変化に合わせてループを足し、一定時間ごとに精算する
export function startLoops(d: LoopDeps) {
  const idle = d.idleMs ?? IDLE_MS
  const settleMs = d.settleMs ?? SETTLE_MS
  let stopped = false
  const running = new Map<string, Promise<void>>()
  const lastKey = new Map<string, string>()
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  // モデルを同時に呼ぶ数を抑える
  let active = 0
  const waiting: (() => void)[] = []
  const slot = async <T>(task: () => Promise<T>) => {
    while (active >= CONCURRENCY) {
      await new Promise<void>((r) => waiting.push(r))
    }
    active++
    try {
      return await task()
    } finally {
      active--
      waiting.shift()?.()
    }
  }

  const loop = async (name: string) => {
    while (!stopped && members(d.economy).includes(name)) {
      const turn = await turnFor(name, d)
      if (!turn || turn.key === lastKey.get(name)) {
        await sleep(idle)
        continue
      }
      try {
        await slot(() => d.ask(name, turn.prompt, turn.tools))
        turn.done?.()
        lastKey.set(name, turn.key)
        d.log(`${name}: 動きました`)
      } catch (e) {
        d.log(`${name}: 失敗しました: ${e instanceof Error ? e.message : e}`)
        await sleep(ERROR_MS)
      }
    }
    running.delete(name)
  }

  const supervise = () => {
    for (const name of members(d.economy)) {
      if (!running.has(name)) running.set(name, loop(name))
    }
  }
  let nextSettleAt = Date.now() + settleMs
  const supervisor = setInterval(supervise, idle)
  const settler = setInterval(() => {
    d.economy.settle()
    nextSettleAt = Date.now() + settleMs
    d.log(`精算しました。第${d.economy.cycle()}期に入ります`)
    supervise()
  }, settleMs)
  supervise()
  d.log(`ループを始めました（第${d.economy.cycle()}期）`)

  return {
    nextSettleAt: () => nextSettleAt,
    // 動いている途中のエージェントは、今の依頼を終えてから止まる
    async stop() {
      stopped = true
      clearInterval(supervisor)
      clearInterval(settler)
      await Promise.all(running.values())
      d.log('ループを止めました')
    },
  }
}
