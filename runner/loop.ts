import { Type } from '@earendil-works/pi-ai'
import type { openAgent } from './agent'
import type { Contexts } from './context'
import type { Economy } from './economy'
import type { RoleTool } from './tools'

const IDLE_MS = 5_000
const ERROR_MS = 30_000
const SETTLE_MS = 10 * 60_000
// ponytail: 同時に呼ぶモデルは20まで。利用枠の上限に当たるなら減らす
const CONCURRENCY = 20

// エージェントが今やること。key が前回動いたときと同じなら、状況が変わっていないので動かない
export type Turn = {
  key: string
  // 画面とログに出す、今回やることの説明
  label: string
  prompt: string
  tools: RoleTool[]
  // 動き終えたあとの後始末（読んだメッセージに印を付けるなど）
  done?: () => void
}

type Agent = ReturnType<typeof openAgent>
export type LoopDeps = {
  economy: Economy
  // 役割のツールを足したうえで、エージェントに依頼して回答を得る
  ask: (
    name: string,
    prompt: string,
    tools: RoleTool[],
    onTool: (tool: string, args: Record<string, unknown>) => void,
    onContext: (chars: number) => void,
  ) => Promise<string>
  agent: (name: string) => { agent: Agent }
  contexts: Contexts
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

const boardLines = (e: Economy, companyId: number) =>
  e
    .board(companyId)
    .map((b) => `- ${b.from_agent}: ${b.content}`)
    .join('\n') || '（まだありません）'

// 各エージェントの「今やること」を状況から組み立てる。やることがなければ null を返し、モデルを呼ばない
type TurnDeps = Pick<
  LoopDeps,
  'economy' | 'agent' | 'readFile' | 'contexts'
> & {
  // そのエージェントが今モデルを呼んでいる途中か
  busy?: (name: string) => boolean
}

// 役割ごとの turn に、2層のコンテキストとそのツールを足す
export async function turnFor(name: string, d: TurnDeps): Promise<Turn | null> {
  const turn = await roleTurn(name, d)
  if (!turn) return null
  const db = d.agent(name).agent.db
  const e = d.economy
  return {
    ...turn,
    prompt: `${turn.prompt}

${d.contexts.prompt(db)}
わかったことや判断の根拠は context_add でコンテキストに残してください。自分用のエントリーは give_context でほかの worker に渡せます。`,
    tools: [
      ...turn.tools,
      ...d.contexts.tools(
        name,
        db,
        async (path) => {
          const content = await d.readFile(path)
          if (content === null) throw new Error(`${path} を読めません`)
          return content
        },
        // 渡せる相手は、稼働中の会社にいる worker
        (to) => {
          const companyId = e.workerCompany(to)
          return companyId !== null && e.company(companyId) !== null
        },
      ),
    ],
  }
}

async function roleTurn(
  name: string,
  { economy: e, readFile, contexts, busy }: TurnDeps,
): Promise<Turn | null> {
  const goal = e.goal()
  const cycle = e.cycle()

  if (name === 'market') {
    const ideas = e.unscoredIdeas()
    if (!ideas.length) return null
    const listing = await Promise.all(
      ideas.map(async (i) => {
        // 根拠のエントリーがあれば、その Summary（引用付き）を見せる
        const entry = i.entry ? contexts.sharedEntry(i.entry) : null
        const file = !entry && i.file ? await readFile(i.file) : null
        const evidence = entry
          ? `\n  根拠 [${entry.label}]: ${entry.summary}`
          : file
            ? `\n  ファイルの内容: ${file.slice(0, 1000)}`
            : '\n  根拠: なし'
        return `- id ${i.id}（会社 ${i.company_id}、${i.worker}）${i.title}: ${i.body}${evidence}`
      }),
    )
    const scored = e
      .latestIdeas(40)
      .filter((i) => i.score !== null)
      .slice(0, 15)
      .map((i) => `- ${i.score}点: ${i.title}（会社 ${i.company_id}）`)
      .join('\n')
    const distribution = e
      .scoreSummary()
      .map((s) => `${s.score}点×${s.n}`)
      .join('、')
    return {
      key: ideas.map((i) => i.id).join(','),
      label: `未採点のアイデア ${ideas.length}件を採点`,
      prompt: `あなたは市場です。利用者の目的に照らして、アイデアの価値を見極めてください。採点は会社の売上になり、投資家の判断材料になります。差をつけないと良い会社が育ちません。
利用者の目的: ${goal}

採点の基準（相対評価）:
- 5点: これまでのアイデアの平均的な水準
- 8点以上: 目的に直接効き、具体的で、既存のアイデアにない新しさがある。全体の1〜2割だけに付ける
- 3点以下: 抽象的、根拠がない、または既存のアイデアの言い換え
- 既存のアイデアとほぼ同じ内容は、そのぶん3点以上減点する
- 根拠のエントリーが無いアイデアは、具体性を低く見る
- 新しさは、根拠に近い先行研究の URL と、それとの違いが書かれている場合だけ認める。調べた形跡の無い「新規」「未確認」の主張は加点しない。必要なら Web 検索で先行研究を確かめる
- 実験のコードと結果（run_command の出力など）があるアイデアは、設計だけのアイデアより具体性を高く見る
これまでの採点の分布: ${distribution || 'まだありません'}
比較用の、最近の採点済みアイデア:
${scored || '（まだありません）'}

未採点のアイデア:
${listing.join('\n')}

すべてのアイデアを score_idea で 0〜10 の整数で採点してください。`,
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
    // 最初の精算までは会社の価値が分からないため、投資の判断をしない
    if (cycle <= 1 || investor.cash < 1) return null
    const stakes = e
      .stakesOf(name)
      .map((s) => `- 会社 ${s.company_id}: ${s.amount.toFixed(1)}`)
      .join('\n')
    // 期ごとに1回、精算の結果を見て判断する
    return {
      key: `cycle-${cycle}`,
      label: `第${cycle}期の投資を判断`,
      prompt: `あなたは投資家「${name}」です。会社は資本が多いほど worker を雇え、市場の評価が売上になり、売上の半分が出資額に応じて配当されます。
利用者の目的: ${goal}
第${cycle}期です。手元の資金: ${investor.cash.toFixed(1)}
これまでの出資:
${stakes || '（ありません）'}
会社の一覧:
${companyList(e) || '（ありません）'}

伸びると考える会社に invest で投資してください。1期に使えるのは期の初めの資金の30%までです。価値の差を見て配分し、投資しない判断もできます。`,
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
    // 設計思想は id の小さい会社から順に決め、先に決まった他社の思想と重ならないようにする
    if (
      !c.philosophy &&
      e.companies().some((o) => o.id < c.id && !o.philosophy)
    ) {
      return null
    }
    const ideas = e
      .recentIdeas(c.id)
      .map((i) => `- ${i.title}（${i.worker}、評価 ${i.score ?? '未評価'}）`)
      .join('\n')
    return {
      key: `${cycle}|${needed}|${pool.length}|${c.philosophy}`,
      label: c.philosophy
        ? `タスクプールに仕事を足す（手の空いた worker ${needed}人）`
        : '設計思想を決める',
      prompt: `あなたは会社「${c.name}」の経営者です。
利用者の目的: ${goal}
設計思想: ${c.philosophy || '未設定。set_philosophy で決めてください'}
資本: ${c.capital.toFixed(1)}、価値: ${c.value.toFixed(1)}
所属する worker: ${workers.join(', ')}
タスクプールにある、まだ誰も引き受けていない仕事:
${pool.map((t) => `- ${t.body}`).join('\n') || '（ありません）'}
最近のアイデアと市場の評価:
${ideas || '（まだありません）'}
会社の掲示板:
${boardLines(e, c.id)}
会社の一覧（他社の設計思想と重ならない方向を選ぶ）:
${companyList(e)}

設計思想は、他社と違う問いや手法の方向にしてください。設計思想に沿って、会社のタスクプールに add_task で仕事を足してください。評価の高い方向を伸ばし、既存のアイデアと重ならない仕事にしてください。worker は自分でプールから仕事を選びます。手の空いている worker は ${Math.max(needed, 0)} 人です。`,
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
  // 会社が仕事を足している途中に起きると、最初の1件に全員が集まるため、足し終えるまで待つ
  if (!task && busy?.(`company-${c.id}`)) return null
  const pool = task ? [] : e.pool(c.id)
  const messages = e.unread(name)
  const gifts = contexts.pendingGifts(name)
  if (!task && !pool.length && !messages.length && !gifts.length) {
    return null
  }
  // send_message を1回の turn で1通に限る
  let sent = false
  return {
    key: [
      cycle,
      task?.id,
      pool.map((t) => t.id).join(','),
      messages.map((m) => m.id).join(','),
      gifts.map((g) => g.id).join(','),
    ].join('|'),
    label: [
      task ? `仕事 ${task.id}: ${task.body.slice(0, 40)}` : '仕事を選ぶ',
      messages.length ? `メッセージ ${messages.length}件` : '',
      gifts.length ? `受け取ったエントリー ${gifts.length}件` : '',
    ]
      .filter(Boolean)
      .join('、'),
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
受け取ったエントリー（decide_gift で自分用コンテキストに入れるか決める）:
${gifts.map((g) => `- id ${g.id}（${g.from_agent} から）: ${g.gist}`).join('\n') || '（ありません）'}
会社の掲示板:
${boardLines(e, c.id)}
全社の最近のアイデア（重なる案は出さない）:
${
  e
    .latestIdeas(15)
    .map(
      (i) =>
        `- ${i.title}（会社 ${i.company_id}、評価 ${i.score ?? '未評価'}）`,
    )
    .join('\n') || '（まだありません）'
}
会社の一覧:
${companyList(e)}

アイデアを出す前に、Web 検索で近い先行研究を調べてください。根拠のエントリーには、近い研究の URL と、それとの違いを書いてください（URL が無いと post_idea は受け付けません）。既にある手法なら、別の案に切り替えてください。
検証できる部分は、run_command（ネットワークの無い隔離環境。/work が作業用ディレクトリ）で小さな実験のコードを書いて実行し、その結果も根拠に含めてください。
成果は context_add（scope: shared）で共有コンテキストに残し、そのラベル（S…）を entry に付けて post_idea で市場に出してください。長い内容は file_write でファイルに書き、context_add の file で指せます。
共有 DB は、ほかのエージェントとの調整用のデータにだけ使い、成果を置かないでください。
進捗の報告、訂正、見つけた先行研究など、同僚に知らせたい内容は post_board と context_add に書いてください（誰も起こしません）。send_message は、返事が必要な質問や依頼を特定の同僚に送るときだけ使ってください（相手を起こします）。1回に送れるのは1通までです。
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
        '成果をアイデアとして登録する。市場が根拠のエントリーとあわせて評価する',
        Type.Object({
          title: Type.String(),
          body: Type.String(),
          entry: Type.String({
            description: '根拠になる共有コンテキストのラベル（S…）',
          }),
        }),
        async (args) => {
          const entry = text(args.entry, 'entry')
          const found = contexts.sharedEntry(entry)
          if (!found) {
            throw new Error(
              `${entry} は共有コンテキストにありません。先に context_add（scope: shared）で残してください`,
            )
          }
          const raw = found.raw.startsWith('file:')
            ? await readFile(found.raw.slice('file:'.length))
            : found.raw
          if (!/https?:\/\//.test(`${found.summary}\n${raw ?? ''}`)) {
            throw new Error(
              `${entry} に先行研究の URL がありません。Web 検索で近い研究を調べ、URL と違いを書いたエントリーを付けてください`,
            )
          }
          e.postIdea(name, {
            title: text(args.title, 'title'),
            body: text(args.body, 'body'),
            entry,
          })
          return 'アイデアを登録しました'
        },
      ),
      tool(
        'post_board',
        '会社の掲示板に進捗を書く。誰も起こさず、同僚が次に動くときに読む',
        Type.Object({ content: Type.String() }),
        (args) => {
          e.postBoard(name, text(args.content, 'content'))
          return '掲示板に書きました'
        },
      ),
      tool(
        'send_message',
        '同僚1人にメッセージを送る。相手を起こすので、質問や依頼にだけ使う',
        Type.Object({ to: Type.String(), content: Type.String() }),
        (args) => {
          // 同じ知らせを同僚全員に送って起こし合うのを防ぐ
          if (sent) {
            throw new Error(
              'send_message は1回に1通までです。知らせたい内容は post_board に書いてください',
            )
          }
          sent = true
          e.sendMessage(
            name,
            text(args.to, 'to'),
            text(args.content, 'content'),
          )
          return '送りました'
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

// エージェントの今の状態。画面に出して、どこまで進んだか、どこで止まったかを分かるようにする
export type Activity = {
  name: string
  state: '待機' | '順番待ち' | '実行中' | '失敗' | '停止'
  since: number
  // 実行中は今回やることと直近のツール、待機中は前回の結果、失敗はエラー
  label: string
  detail: string
  tools: number
  // 今の依頼（終えたあとは前回の依頼）で、モデルを呼ぶたびのコンテキストの文字数
  context: number[]
}

// ツールの引数から、ログに出す要点を取り出す
const brief = (args: Record<string, unknown>) => {
  const value =
    [
      'title',
      'command',
      'path',
      'label',
      'labels',
      'gist',
      'body',
      'content',
      'result',
    ]
      .map((k) => args[k])
      .find((v) => v !== undefined) ?? args
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const line = text.replace(/\s+/g, ' ')
  return line.length > 80 ? `${line.slice(0, 80)}…` : line
}

// 各エージェントのループを並行に回す。顔ぶれの変化に合わせてループを足し、一定時間ごとに精算する
export function startLoops(d: LoopDeps) {
  const idle = d.idleMs ?? IDLE_MS
  const settleMs = d.settleMs ?? SETTLE_MS
  let stopped = false
  const running = new Map<string, Promise<void>>()
  const lastKey = new Map<string, string>()
  const activity = new Map<string, Activity>()
  const set = (name: string, change: Partial<Activity>) => {
    const current = activity.get(name) ?? {
      name,
      state: '待機',
      since: Date.now(),
      label: '',
      detail: '',
      tools: 0,
      context: [],
    }
    activity.set(name, {
      ...current,
      ...(change.state && change.state !== current.state
        ? { since: Date.now() }
        : {}),
      ...change,
    })
  }
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

  const busy = (name: string) => {
    const state = activity.get(name)?.state
    return state === '実行中' || state === '順番待ち'
  }
  const loop = async (name: string) => {
    while (!stopped && members(d.economy).includes(name)) {
      const turn = await turnFor(name, { ...d, busy })
      if (!turn || turn.key === lastKey.get(name)) {
        if (!activity.has(name)) set(name, { detail: 'やることがありません' })
        await sleep(idle)
        continue
      }
      const started = Date.now()
      let tools = 0
      // ponytail: 直近200回分だけ残す。長い依頼の全体を見たくなったら間引いて残す
      const context: number[] = []
      set(name, {
        state: '順番待ち',
        label: turn.label,
        detail: '',
        tools,
        context,
      })
      try {
        await slot(() => {
          set(name, { state: '実行中', detail: '考えています' })
          d.log(`${name}: 始めました（${turn.label}）`)
          return d.ask(
            name,
            turn.prompt,
            turn.tools,
            (tool, args) => {
              const line = `${tool} ${brief(args)}`
              set(name, { detail: line, tools: ++tools })
              d.log(`${name}: ${line}`)
            },
            (chars) => {
              context.push(chars)
              set(name, { context: context.slice(-200) })
            },
          )
        })
        turn.done?.()
        lastKey.set(name, turn.key)
        const seconds = Math.round((Date.now() - started) / 1000)
        set(name, {
          state: '待機',
          detail: `前回: ${turn.label}（${seconds}秒、ツール ${tools}回）を終えました`,
        })
        d.log(`${name}: 終えました（${seconds}秒、ツール ${tools}回）`)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        set(name, { state: '失敗', detail: message })
        d.log(`${name}: 失敗しました（${turn.label}）: ${message}`)
        await sleep(ERROR_MS)
      }
    }
    set(name, {
      state: '停止',
      detail: members(d.economy).includes(name)
        ? (activity.get(name)?.detail ?? '')
        : '経済から外れました',
    })
    running.delete(name)
  }

  const supervise = () => {
    for (const name of members(d.economy)) {
      if (!running.has(name)) running.set(name, loop(name))
    }
  }
  // 次の精算の時刻は DB に置き、停止や再起動をまたいでも引き継ぐ。止めていた間に過ぎていれば、すぐに精算する
  if (!d.economy.nextSettleAt())
    d.economy.setNextSettleAt(Date.now() + settleMs)
  const tick = () => {
    if (Date.now() >= d.economy.nextSettleAt()) {
      d.economy.settle()
      d.economy.setNextSettleAt(Date.now() + settleMs)
      d.log(`精算しました。第${d.economy.cycle()}期に入ります`)
    }
    supervise()
  }
  const supervisor = setInterval(tick, idle)
  supervise()
  d.log(`ループを始めました（第${d.economy.cycle()}期）`)

  return {
    nextSettleAt: () => d.economy.nextSettleAt(),
    activity: () => [...activity.values()],
    // 動いている途中のエージェントは、今の依頼を終えてから止まる
    async stop() {
      stopped = true
      clearInterval(supervisor)
      await Promise.all(running.values())
      d.log('ループを止めました')
    },
  }
}
