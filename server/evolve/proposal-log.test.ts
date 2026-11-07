import { expect, test } from 'bun:test'
import type { AssistantMessageEvent, Context } from '@earendil-works/pi-ai'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Dialog } from '../../shared/dialog.ts'
import type { Candidate } from '../../shared/evolve.ts'
import type { Stream } from '../relay.ts'
import { runEvolve, type EvolveProgress } from './run.ts'
import { archiveCandidate, listArchive, listCandidates, readCode, writeCandidate } from './store.ts'

const emptyDialog = (): Dialog => ({
  topics: [],
  queue: [],
  questions: [],
  entries: [{ id: 'e1', topicId: 't1', kind: 'fail', text: 'weakness sent to proposer', evidence: '' }],
  started: false,
  goal: { text: '', version: 0 },
  edits: [],
  tasks: [],
  activity: [],
  live: {},
  halted: '',
  stopping: false,
  finished: '',
  evolution: null,
  from: { tasks: 0, entries: 0 },
})

test('提案役に送った材料と応答本文を候補、archive、進捗報告に保存する', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hyph-proposal-log-'))
  const prior: Candidate = {
    id: '0-1',
    round: 0,
    module: 'context',
    changes: ['既存の変更'],
    score: 1,
    note: '既存の候補',
    cost: 0.25,
  }
  writeCandidate(prior, root)
  archiveCandidate(prior.id, root)

  const contexts: Context[] = []
  const responses: string[] = []
  const stream: Stream = async function* (context) {
    contexts.push(context)
    const response = `{\n  "changes": ["change ${responses.length}"],\n  "note": "note ${responses.length}"\n}`
    responses.push(response)
    yield {
      type: 'done',
      reason: 'stop',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: response }],
        usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
        stopReason: 'stop',
      },
    } as unknown as AssistantMessageEvent
  }
  const progress: EvolveProgress[] = []

  const result = await runEvolve({
    root,
    harness: process.cwd(),
    dialog: emptyDialog(),
    stream,
    check: (candidate) => (candidate.id === '1-1' ? 1 : 0),
    spent: () => 0,
    limitUsd: 100,
    onProgress: (event) => progress.push(event),
  })

  expect(contexts).toHaveLength(5)
  expect(contexts.every((context) => context.messages.length === 1 && context.tools.length === 0)).toBe(true)
  expect(responses).toHaveLength(5)

  const sentMaterial = String(contexts[0].messages[0].content)
  expect(typeof sentMaterial).toBe('string')
  const material = JSON.parse(String(sentMaterial))
  expect(material.weaknesses).toEqual(['weakness sent to proposer'])
  expect(material.archive).toEqual([
    { id: '0-1', module: 'context', changes: ['既存の変更'], score: 1, cost: 0.25, note: '既存の候補' },
  ])
  expect(material.code).toEqual([{ id: '0-1', text: readCode('0-1', root) }])
  expect(material.code[0].text).toContain('既存の変更')

  const savedArchive = listArchive(root)
  expect(savedArchive).toHaveLength(2)
  expect(savedArchive[0].id).toBe('0-1')
  const adopted = savedArchive.find((candidate) => candidate.id === '1-1')!
  expect(adopted.proposalMaterial).toBe(sentMaterial)
  expect(adopted.proposalResponse).toBe(responses[0])
  expect(adopted.changes).toEqual(['change 0'])
  expect(adopted.note).toBe('note 0')

  const savedCandidates = listCandidates(root)
  expect(savedCandidates).toHaveLength(4)
  expect(savedCandidates.every((candidate) => typeof candidate.proposalMaterial === 'string')).toBe(true)
  expect(savedCandidates.every((candidate) => typeof candidate.proposalResponse === 'string')).toBe(true)
  expect(savedCandidates[0].proposalMaterial).toBe(String(contexts[1].messages[0].content))
  expect(savedCandidates[0].proposalResponse).toBe(responses[1])

  const finalProgress = progress.at(-1)!
  expect(finalProgress.stage).toBe('done')
  expect(finalProgress.candidates.map((candidate) => [candidate.proposalMaterial, candidate.proposalResponse])).toEqual(
    result.candidates.map((candidate) => [candidate.proposalMaterial, candidate.proposalResponse]),
  )
  expect(finalProgress.candidates[0].proposalMaterial).toBe(sentMaterial)
  expect(finalProgress.candidates[0].proposalResponse).toBe(responses[0])
})
