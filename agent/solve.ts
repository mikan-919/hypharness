// 進化対象のエージェント。候補ごとのこのディレクトリが、隔離環境の /agent に読み取り専用で置かれる。
// 隔離環境には依存パッケージがないため、型以外は import しない。モデルは /model.sock の中継を通してだけ呼べる
import type {
  AssistantMessage,
  Context,
  Tool,
  ToolCall,
  ToolResultMessage,
} from '@earendil-works/pi-ai'

const INSTRUCTIONS =
  'あなたは課題を解くエージェントです。作業用ディレクトリ /work で、sh ツールでコマンドを実行して課題を解いてください。ネットワークには接続できません。解き終えたら finish を呼んでください。'
// ponytail: 1課題でモデルを呼ぶのは30回まで。足りない課題が多ければ増やす
const MAX_STEPS = 30
const OUTPUT_LIMIT = 4000
const COMMAND_TIMEOUT_MS = 60_000

const tools = [
  {
    name: 'sh',
    description:
      '/work で sh -c を実行し、終了コードと出力（標準出力と標準エラー）を返す',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'finish',
    description: '課題を解き終えたときに呼ぶ',
    parameters: { type: 'object', properties: {} },
  },
] as unknown as Tool[]

async function sh(command: unknown) {
  if (typeof command !== 'string') throw new Error('command は文字列です')
  const child = Bun.spawn(['sh', '-c', `exec 2>&1\n${command}`], {
    cwd: '/work',
    stdout: 'pipe',
    timeout: COMMAND_TIMEOUT_MS,
  })
  const [output, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ])
  const shown =
    output.length > OUTPUT_LIMIT
      ? `${output.slice(0, OUTPUT_LIMIT)}\n（${output.length}文字のうち先頭${OUTPUT_LIMIT}文字）`
      : output
  return `終了コード ${code}\n${shown}`
}

const context: Context = {
  systemPrompt: INSTRUCTIONS,
  messages: [
    {
      role: 'user',
      content: await Bun.file('/task.md').text(),
      timestamp: Date.now(),
    },
  ],
  tools,
}

for (let step = 1; step <= MAX_STEPS; step++) {
  const response = await fetch('http://model/', {
    method: 'POST',
    unix: '/model.sock',
    body: JSON.stringify(context),
  })
  if (!response.ok) {
    console.error(
      `モデルを呼べません (${response.status}): ${await response.text()}`,
    )
    process.exit(1)
  }
  const reply = (await response.json()) as AssistantMessage
  if (reply.stopReason === 'error') {
    console.error(`モデルの応答が失敗しました: ${reply.errorMessage}`)
    process.exit(1)
  }
  context.messages.push(reply)
  const calls = reply.content.filter(
    (block): block is ToolCall => block.type === 'toolCall',
  )
  // ツールを呼ばずに答えたときも終える。解けたかは判定コマンドが決める
  if (!calls.length || calls.some((c) => c.name === 'finish')) process.exit(0)
  for (const call of calls) {
    let text: string
    let isError = false
    try {
      if (call.name !== 'sh') throw new Error(`未知のツールです: ${call.name}`)
      text = await sh(call.arguments.command)
    } catch (e) {
      text = e instanceof Error ? e.message : String(e)
      isError = true
    }
    const result: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: 'text', text }],
      isError,
      timestamp: Date.now(),
    }
    context.messages.push(result)
  }
}
console.error(`モデルの呼び出しが ${MAX_STEPS} 回を超えました`)
process.exit(1)
