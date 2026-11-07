// 作業文脈（ADR 0031）。
// CLM: モデルが edit_context で、これまでの会話を自分で書いた作業文脈に置き換える。いつ、何を残すかはモデルが決める。
// LCM: 原文は messages（論点エージェントは対話の記録）に消さずに残し、recall で引ける。モデルが縮めないまま
// 文脈がしきい値を超えたときだけ、決まった手順で古い会話を要約に置き換える。
// モデルに渡す会話を作り直すのは、この2つのときだけ。その間は会話の先頭が変わらず、キャッシュが効く
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import { AGENT_DIET } from './settings.ts'

// 保存先のルート。テストは HYPH_CTX_DIR で差し替える
export const root = () => process.env.HYPH_CTX_DIR || join(homedir(), '.hyph', 'ctx')

// しきい値で縮めるとき、1件のメッセージから要約に入れる文字数
const MAX_PART = 500
// recall で返す1件の文字数
const MAX_RECALL = 4_000

// 返ってきた応答から、その呼び出しでモデルに渡した文脈のトークン数を取る
export const promptTokens = (reply: AssistantMessage) =>
  (reply.usage?.input ?? 0) + (reply.usage?.cacheRead ?? 0) + (reply.usage?.cacheWrite ?? 0)

// メッセージの本文。ツールの呼び出しは名前と引数を入れる
export function messageText(message: Message): string {
  const content = message.content
  if (typeof content === 'string') return content
  return content
    .map((part) =>
      part.type === 'text' ? part.text : part.type === 'toolCall' ? `${part.name} ${JSON.stringify(part.arguments)}` : '',
    )
    .filter(Boolean)
    .join('\n')
}

// cut: messages のこの位置より前（先頭の指示を除く）を content に置き換えてモデルに渡す
type State = { cut: number; content: string }

// key ごとの作業文脈。key は課題の作業ツリーや論点ごとに分ける。状態は子プロセスをまたいで残すためファイルに置く
export function workingContext(key: string) {
  const file = join(root(), `${Bun.hash(key).toString(36)}.json`)
  // 会話より先を指す状態は、別の会話（再起動の後に前の試行からやり直した会話など）のもので、捨てる
  const load = (length = Infinity): State => {
    try {
      const state = JSON.parse(readFileSync(file, 'utf8')) as State
      return state.cut > length ? { cut: 0, content: '' } : state
    } catch {
      return { cut: 0, content: '' }
    }
  }
  const save = (state: State) => {
    mkdirSync(root(), { recursive: true })
    writeFileSync(file, JSON.stringify(state))
  }
  return {
    // モデルに渡す会話。先頭の指示はそのまま、cut より前の会話を作業文脈1通に置き換える
    view(messages: Message[]): Message[] {
      let { cut, content } = load(messages.length)
      if (!cut) return messages
      // ツールの結果から始めると、呼び出しのない結果になって API が受け付けない。edit_context の結果もここで落ちる
      while (messages[cut]?.role === 'toolResult') cut++
      const note = `作業文脈（ここまでの会話を置き換えたもの。原文は recall で引ける）:\n\n${content}`
      return [messages[0], { role: 'user', content: note, timestamp: 0 }, ...messages.slice(cut)]
    },
    // CLM: ここまでの会話を、モデルが書いた content に置き換える。同じ応答のツールの結果も置き換えに含める
    replace(messages: Message[], content: string) {
      save({ cut: messages.length, content })
    },
    // LCM: 文脈がしきい値を超えていたら、直近 contextKeep 件より前の会話を、決まった手順の要約で作業文脈に足す。
    // ponytail: 直近の件数だけでしきい値を超えるほど大きいと、毎回縮めてキャッシュが外れる。起きたら件数を文脈の量で決める
    compact(messages: Message[], tokens: number) {
      if (tokens <= AGENT_DIET.compactAtTokens) return false
      const state = load(messages.length)
      const from = Math.max(state.cut, 1)
      let cut = Math.max(from, messages.length - AGENT_DIET.contextKeep)
      // ツールの結果から始めると、呼び出しのない結果になって API が受け付けない
      while (cut < messages.length && messages[cut].role === 'toolResult') cut++
      if (cut <= from) return false
      const summary = messages
        .slice(from, cut)
        .map((m) => `${m.role}: ${messageText(m).slice(0, MAX_PART)}`)
        .join('\n')
      // 作業文脈自体がしきい値に近づかないよう、古い側から切る。切った分も原文は recall で引ける
      const content = [state.content, summary].filter(Boolean).join('\n\n').slice(-AGENT_DIET.compactAtTokens / 4)
      save({ cut, content })
      return true
    },
    // 置き換えた会話の原文を語で探す
    recall(messages: Message[], query: string, max = 5) {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean)
      const hidden = messages.slice(1, load().cut)
      const found = hidden
        .map((m, i) => ({ i: i + 1, role: m.role, text: messageText(m) }))
        .filter((m) => words.some((w) => m.text.toLowerCase().includes(w)))
        .slice(0, max)
      if (words.length === 0 || found.length === 0) return '一致する会話はありません。'
      return found.map((m) => `メッセージ ${m.i}（${m.role}）:\n${m.text.slice(0, MAX_RECALL)}`).join('\n\n')
    },
  }
}
