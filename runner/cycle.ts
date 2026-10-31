import { Type } from '@earendil-works/pi-ai'
import type { openAgent } from './agent'
import type { Economy } from './economy'
import type { RoleTool, Toolbox } from './tools'

type Agent = ReturnType<typeof openAgent>
export type CycleDeps = {
  economy: Economy
  // 役割のツールを足したうえで、エージェントに依頼して回答を得る
  ask: (name: string, prompt: string, tools: RoleTool[]) => Promise<string>
  agent: (name: string) => { agent: Agent; toolbox: Toolbox }
  readFile: (path: string) => Promise<string | null>
  log: (line: string) => void
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

// 1期分を回す。company → 会議 → worker → 市場 → 精算 → investor の順に進める
export async function runCycle({
  economy: e,
  ask,
  agent,
  readFile,
  log,
}: CycleDeps) {
  const goal = e.goal()
  if (!goal) throw new Error('先に目的を設定してください')
  const cycle = e.nextCycle()
  log(`第${cycle}期を始めます`)
  const others = () =>
    e
      .companies()
      .map(
        (c) =>
          `- ${c.id}: ${c.name}（設計思想: ${c.philosophy || '未設定'}、価値 ${c.value.toFixed(1)}）`,
      )
      .join('\n')

  // company: 資本に合わせて worker を揃え、設計思想に沿って仕事を出す
  for (const c of e.companies()) {
    const workers = e.staff(c.id)
    log(`${c.name}: worker ${workers.length}人（${workers.join(', ')}）`)
    if (!workers.length) continue
    const ideas = e
      .recentIdeas(c.id)
      .map((i) => `- ${i.title}（${i.worker}、評価 ${i.score ?? '未評価'}）`)
      .join('\n')
    await ask(
      `company-${c.id}`,
      `あなたは会社「${c.name}」の経営者です。
利用者の目的: ${goal}
設計思想: ${c.philosophy || '未設定。set_philosophy で決めてください'}
資本: ${c.capital.toFixed(1)}、価値: ${c.value.toFixed(1)}
所属する worker: ${workers.join(', ')}
最近のアイデアと市場の評価:
${ideas || '（まだありません）'}

設計思想に沿って、各 worker に今期の仕事を assign_task で1つずつ出してください。`,
      [
        {
          definition: {
            name: 'set_philosophy',
            description: '会社の設計思想を決める',
            parameters: Type.Object({ philosophy: Type.String() }),
          },
          run: (args) => {
            e.setPhilosophy(c.id, text(args.philosophy, 'philosophy'))
            return '設計思想を更新しました'
          },
        },
        {
          definition: {
            name: 'assign_task',
            description: '所属する worker に今期の仕事を出す',
            parameters: Type.Object({
              worker: Type.String(),
              body: Type.String({ description: '仕事の内容' }),
            }),
          },
          run: (args) => {
            e.assignTask(
              c.id,
              text(args.worker, 'worker'),
              text(args.body, 'body'),
              cycle,
            )
            return `${args.worker} に仕事を出しました`
          },
        },
      ],
    )
  }

  // 会議: 会社ごとに worker が順に1回ずつ発言する
  for (const c of e.companies()) {
    const workers = e.workersOf(c.id)
    if (workers.length < 2) continue
    const transcript: string[] = []
    for (const w of workers) {
      const reply = await ask(
        w,
        `会社「${c.name}」の会議です（設計思想: ${c.philosophy || '未設定'}）。
議題: 今期の仕事の進め方と、互いの仕事の分担
これまでの発言:
${transcript.join('\n') || '（あなたが最初です）'}

あなた（${w}）の意見を短く述べてください。`,
        [],
      )
      transcript.push(`${w}: ${reply}`)
    }
    e.saveMeeting(c.id, cycle, transcript.join('\n'))
    log(`${c.name}: 会議をしました`)
  }

  // worker: 仕事をして、成果をアイデアとファイルに残す
  for (const c of e.companies()) {
    for (const w of e.workersOf(c.id)) {
      const task = e.taskOf(w, cycle)
      if (!task) continue
      const proposals = e
        .pendingProposals(w)
        .map((p) => `- 提案 ${p.id}（${p.from_worker} から）: ${p.content}`)
        .join('\n')
      const reply = await ask(
        w,
        `あなたは worker「${w}」で、会社「${c.name}」（id ${c.id}）に所属しています。
利用者の目的: ${goal}
会社の設計思想: ${c.philosophy || '未設定'}
今期の仕事: ${task.body}
あなた宛ての記憶の提案:
${proposals || '（ありません）'}
会社の一覧:
${others()}

成果は post_idea で登録し、詳しい内容は file_write でファイルに書いてください。
ほかの worker に覚えておいてほしいことは propose_memory で提案できます。届いた提案は decide_proposal で採否を決めてください。
ほかの会社との合併や、会社の分裂に賛成なら vote で投票できます。`,
        [
          {
            definition: {
              name: 'post_idea',
              description: '成果をアイデアとして登録する。市場が評価する',
              parameters: Type.Object({
                title: Type.String(),
                body: Type.String(),
                file: Type.Optional(
                  Type.String({
                    description: '詳しい内容を書いたファイルのパス',
                  }),
                ),
              }),
            },
            run: (args) => {
              e.postIdea(
                w,
                {
                  title: text(args.title, 'title'),
                  body: text(args.body, 'body'),
                  file: typeof args.file === 'string' ? args.file : undefined,
                },
                cycle,
              )
              return 'アイデアを登録しました'
            },
          },
          {
            definition: {
              name: 'propose_memory',
              description:
                'ほかの worker の記憶に残してほしい内容を提案する。相手が採否を決める',
              parameters: Type.Object({
                to: Type.String({ description: '相手の worker 名' }),
                content: Type.String(),
              }),
            },
            run: (args) => {
              e.propose(w, text(args.to, 'to'), text(args.content, 'content'))
              return `${args.to} に提案しました`
            },
          },
          {
            definition: {
              name: 'decide_proposal',
              description:
                '自分宛ての記憶の提案を採用するか決める。採用すると自分の記憶に入る',
              parameters: Type.Object({
                id: Type.Number(),
                accept: Type.Boolean(),
              }),
            },
            run: (args) => {
              const accept = args.accept === true
              const proposal = e.decideProposal(
                w,
                number(args.id, 'id'),
                accept,
              )
              if (accept) {
                agent(w).agent.remember(
                  'assistant',
                  `（${proposal.from_worker} からの提案を採用）${proposal.content}`,
                )
              }
              return accept ? '採用しました' : '却下しました'
            },
          },
          {
            definition: {
              name: 'vote',
              description:
                '合併（merge、target に相手の会社 id）か、分裂（split、philosophy に新しい会社の設計思想）に投票する。期末に集計する',
              parameters: Type.Object({
                kind: Type.Union([
                  Type.Literal('merge'),
                  Type.Literal('split'),
                ]),
                target: Type.Optional(Type.Number()),
                philosophy: Type.Optional(Type.String()),
              }),
            },
            run: (args) => {
              if (args.kind !== 'merge' && args.kind !== 'split') {
                throw new Error('kind は merge か split です')
              }
              e.vote(w, {
                kind: args.kind,
                target:
                  typeof args.target === 'number' ? args.target : undefined,
                philosophy:
                  typeof args.philosophy === 'string'
                    ? args.philosophy
                    : undefined,
              })
              return '投票しました'
            },
          },
        ],
      )
      e.finishTask(task.id, reply)
      log(`${w}: 仕事を終えました`)
    }
  }

  // 市場: 今期のアイデアを目的に照らして採点する
  const ideas = e.ideas(cycle)
  if (ideas.length) {
    const listing = await Promise.all(
      ideas.map(async (i) => {
        const file = i.file ? await readFile(i.file) : null
        return `- id ${i.id}（会社 ${i.company_id}、${i.worker}）${i.title}: ${i.body}${file ? `\n  ファイルの内容: ${file.slice(0, 1000)}` : ''}`
      }),
    )
    await ask(
      'market',
      `あなたは市場です。利用者の目的に照らして、今期のアイデアの価値を見極めてください。
利用者の目的: ${goal}
今期のアイデア:
${listing.join('\n')}

すべてのアイデアを score_idea で 0〜10 点で採点してください。目的への寄与、具体性、新しさを見てください。`,
      [
        {
          definition: {
            name: 'score_idea',
            description: 'アイデアを 0〜10 点で採点する',
            parameters: Type.Object({
              id: Type.Number(),
              score: Type.Number(),
              reason: Type.String(),
            }),
          },
          run: (args) => {
            e.scoreIdea(
              number(args.id, 'id'),
              number(args.score, 'score'),
              text(args.reason, 'reason'),
            )
            return '採点しました'
          },
        },
      ],
    )
    log(`市場: ${ideas.length}件のアイデアを採点しました`)
  }

  e.settle(cycle)
  log('精算しました')

  // investor: 価値を見て、次の期に向けて投資する
  for (const inv of e.investors()) {
    const stakes = e
      .stakesOf(inv.name)
      .map((s) => `- 会社 ${s.company_id}: ${s.amount.toFixed(1)}`)
      .join('\n')
    const companies = e
      .companies()
      .map(
        (c) =>
          `- ${c.id}: ${c.name}（設計思想: ${c.philosophy || '未設定'}、価値 ${c.value.toFixed(1)}、資本 ${c.capital.toFixed(1)}、worker ${e.workersOf(c.id).length}人）`,
      )
      .join('\n')
    await ask(
      inv.name,
      `あなたは投資家「${inv.name}」です。会社は資本が多いほど worker を雇え、市場の評価が売上になり、売上の半分が出資額に応じて配当されます。
利用者の目的: ${goal}
手元の資金: ${inv.cash.toFixed(1)}
これまでの出資:
${stakes || '（ありません）'}
会社の一覧:
${companies || '（ありません）'}

伸びると考える会社に invest で投資してください。投資しない判断もできます。`,
      [
        {
          definition: {
            name: 'invest',
            description: '会社に投資する。手元の資金が会社の資本になる',
            parameters: Type.Object({
              company_id: Type.Number(),
              amount: Type.Number(),
            }),
          },
          run: (args) => {
            e.invest(
              inv.name,
              number(args.company_id, 'company_id'),
              number(args.amount, 'amount'),
            )
            return '投資しました'
          },
        },
      ],
    )
  }
  log(`第${cycle}期を終えました`)
}
