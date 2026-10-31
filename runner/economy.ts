import { Database } from 'bun:sqlite'

// ponytail: 経済の定数は仮の値。ループを回して偏りが出たら調整する
export const WORKER_COST = 10
export const MAX_WORKERS = 5
export const REVENUE_RATE = 3
const FOUNDING_CAPITAL = 30
const INVESTOR_CASH = 100
const INITIAL_COMPANIES = 2
const INITIAL_INVESTORS = 2

export type Company = {
  id: number
  name: string
  philosophy: string
  capital: number
  value: number
}
export type Idea = {
  id: number
  company_id: number
  worker: string
  title: string
  body: string
  file: string | null
  score: number | null
  cycle: number
}

// 経済の状態。資本や価値をエージェントが書き換えられないよう、エージェントの SQL ツールからは触れない
export function openEconomy(path: string) {
  const db = new Database(path, { strict: true })
  db.run('PRAGMA journal_mode = WAL')
  db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      philosophy TEXT NOT NULL DEFAULT '',
      capital REAL NOT NULL,
      value REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS workers (
      name TEXT PRIMARY KEY,
      company_id INTEGER REFERENCES companies(id)
    );
    CREATE TABLE IF NOT EXISTS investors (name TEXT PRIMARY KEY, cash REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS stakes (
      investor TEXT NOT NULL REFERENCES investors(name),
      company_id INTEGER NOT NULL REFERENCES companies(id),
      amount REAL NOT NULL,
      PRIMARY KEY (investor, company_id)
    );
    CREATE TABLE IF NOT EXISTS ideas (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      worker TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      file TEXT,
      score REAL,
      reason TEXT,
      cycle INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      worker TEXT NOT NULL,
      body TEXT NOT NULL,
      result TEXT,
      cycle INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proposals (
      id INTEGER PRIMARY KEY,
      from_worker TEXT NOT NULL,
      to_worker TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS votes (
      worker TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      target INTEGER,
      philosophy TEXT
    );
    CREATE TABLE IF NOT EXISTS meetings (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL,
      cycle INTEGER NOT NULL,
      transcript TEXT NOT NULL
    );`)

  const meta = (key: string) =>
    db
      .query<{ value: string }, [string]>(
        'SELECT value FROM meta WHERE key = ?',
      )
      .get(key)?.value
  const setMeta = (key: string, value: string) =>
    db
      .query(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value)
  const companies = () =>
    db
      .query<Company, []>(
        'SELECT id, name, philosophy, capital, value FROM companies WHERE active = 1 ORDER BY id',
      )
      .all()
  const company = (id: number) =>
    db
      .query<Company, [number]>(
        'SELECT id, name, philosophy, capital, value FROM companies WHERE id = ? AND active = 1',
      )
      .get(id)
  const workersOf = (companyId: number) =>
    db
      .query<{ name: string }, [number]>(
        'SELECT name FROM workers WHERE company_id = ? ORDER BY name',
      )
      .all(companyId)
      .map((w) => w.name)
  const workerCompany = (name: string) =>
    db
      .query<{ company_id: number | null }, [string]>(
        'SELECT company_id FROM workers WHERE name = ?',
      )
      .get(name)?.company_id ?? null

  const found = (name: string, capital: number, philosophy = '') =>
    db
      .query<{ id: number }, [string, string, number]>(
        'INSERT INTO companies (name, philosophy, capital) VALUES (?, ?, ?) RETURNING id',
      )
      .get(name, philosophy, capital)?.id as number

  const dissolve = (id: number) => {
    db.query('UPDATE companies SET active = 0 WHERE id = ?').run(id)
    db.query('UPDATE workers SET company_id = NULL WHERE company_id = ?').run(
      id,
    )
  }

  return {
    db,
    cycle: () => Number(meta('cycle') ?? 0),
    goal: () => meta('goal') ?? '',
    companies,
    company,
    workersOf,
    workerCompany,
    investors: () =>
      db
        .query<{ name: string; cash: number }, []>(
          'SELECT name, cash FROM investors ORDER BY name',
        )
        .all(),
    stakesOf: (investor: string) =>
      db
        .query<{ company_id: number; amount: number }, [string]>(
          'SELECT company_id, amount FROM stakes WHERE investor = ?',
        )
        .all(investor),
    ideas: (cycle: number) =>
      db
        .query<Idea, [number]>(
          'SELECT * FROM ideas WHERE cycle = ? ORDER BY id',
        )
        .all(cycle),
    recentIdeas: (companyId: number, limit = 10) =>
      db
        .query<Idea, [number, number]>(
          'SELECT * FROM ideas WHERE company_id = ? ORDER BY id DESC LIMIT ?',
        )
        .all(companyId, limit),
    taskOf: (worker: string, cycle: number) =>
      db
        .query<{ id: number; body: string }, [string, number]>(
          'SELECT id, body FROM tasks WHERE worker = ? AND cycle = ? AND result IS NULL ORDER BY id LIMIT 1',
        )
        .get(worker, cycle),
    pendingProposals: (worker: string) =>
      db
        .query<{ id: number; from_worker: string; content: string }, [string]>(
          "SELECT id, from_worker, content FROM proposals WHERE to_worker = ? AND status = 'pending'",
        )
        .all(worker),
    latestIdeas: (limit = 20) =>
      db
        .query<Idea, [number]>('SELECT * FROM ideas ORDER BY id DESC LIMIT ?')
        .all(limit),
    latestMeetings: () =>
      db
        .query<{ company_id: number; cycle: number; transcript: string }, []>(
          'SELECT company_id, cycle, transcript FROM meetings WHERE cycle = (SELECT MAX(cycle) FROM meetings)',
        )
        .all(),

    // 目的を設定する。初回は会社と投資家を用意する
    setGoal(goal: string) {
      db.transaction(() => {
        setMeta('goal', goal)
        if (companies().length) return
        for (let i = 1; i <= INITIAL_COMPANIES; i++) {
          found(`会社${i}`, FOUNDING_CAPITAL)
        }
        for (let i = 1; i <= INITIAL_INVESTORS; i++) {
          db.query('INSERT INTO investors (name, cash) VALUES (?, ?)').run(
            `investor-${i}`,
            INVESTOR_CASH,
          )
        }
      })()
    },

    nextCycle() {
      const next = Number(meta('cycle') ?? 0) + 1
      setMeta('cycle', String(next))
      db.run('DELETE FROM votes')
      return next
    },

    // 資本で賄える数に worker を合わせる。採用は所属のない worker から優先し、記憶を引き継ぐ
    staff(companyId: number) {
      const target = Math.min(
        MAX_WORKERS,
        Math.max(
          0,
          Math.floor((company(companyId)?.capital ?? 0) / WORKER_COST),
        ),
      )
      const current = workersOf(companyId)
      for (const name of current.slice(target)) {
        db.query('UPDATE workers SET company_id = NULL WHERE name = ?').run(
          name,
        )
      }
      for (let n = current.length; n < target; n++) {
        const free = db
          .query<{ name: string }, []>(
            'SELECT name FROM workers WHERE company_id IS NULL ORDER BY name LIMIT 1',
          )
          .get()
        const name =
          free?.name ??
          `worker-${(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM workers').get()?.n ?? 0) + 1}`
        db.query(
          'INSERT INTO workers (name, company_id) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET company_id = excluded.company_id',
        ).run(name, companyId)
      }
      return workersOf(companyId)
    },

    setPhilosophy(companyId: number, philosophy: string) {
      db.query('UPDATE companies SET philosophy = ? WHERE id = ?').run(
        philosophy,
        companyId,
      )
    },
    assignTask(companyId: number, worker: string, body: string, cycle: number) {
      if (workerCompany(worker) !== companyId) {
        throw new Error(`${worker} はこの会社の worker ではありません`)
      }
      db.query(
        'INSERT INTO tasks (company_id, worker, body, cycle) VALUES (?, ?, ?, ?)',
      ).run(companyId, worker, body, cycle)
    },
    finishTask(id: number, result: string) {
      db.query('UPDATE tasks SET result = ? WHERE id = ?').run(result, id)
    },
    postIdea(
      worker: string,
      idea: { title: string; body: string; file?: string },
      cycle: number,
    ) {
      const companyId = workerCompany(worker)
      if (companyId === null) throw new Error('所属する会社がありません')
      db.query(
        'INSERT INTO ideas (company_id, worker, title, body, file, cycle) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(companyId, worker, idea.title, idea.body, idea.file ?? null, cycle)
    },
    scoreIdea(id: number, score: number, reason: string) {
      if (!(score >= 0 && score <= 10)) {
        throw new Error('score は 0〜10 です')
      }
      db.query('UPDATE ideas SET score = ?, reason = ? WHERE id = ?').run(
        score,
        reason,
        id,
      )
    },
    propose(from: string, to: string, content: string) {
      if (!db.query('SELECT 1 FROM workers WHERE name = ?').get(to)) {
        throw new Error(`${to} という worker はいません`)
      }
      db.query(
        'INSERT INTO proposals (from_worker, to_worker, content) VALUES (?, ?, ?)',
      ).run(from, to, content)
    },
    // 提案の採否を決める。採用した提案は呼び出し側が自分の記憶に入れる
    decideProposal(worker: string, id: number, accept: boolean) {
      const proposal = db
        .query<{ from_worker: string; content: string }, [number, string]>(
          "SELECT from_worker, content FROM proposals WHERE id = ? AND to_worker = ? AND status = 'pending'",
        )
        .get(id, worker)
      if (!proposal) throw new Error(`提案 ${id} はありません`)
      db.query('UPDATE proposals SET status = ? WHERE id = ?').run(
        accept ? 'accepted' : 'rejected',
        id,
      )
      return proposal
    },
    vote(
      worker: string,
      vote: { kind: 'merge' | 'split'; target?: number; philosophy?: string },
    ) {
      if (vote.kind === 'merge' && !company(vote.target ?? -1)) {
        throw new Error('合併先の会社がありません')
      }
      db.query(
        'INSERT INTO votes (worker, kind, target, philosophy) VALUES (?, ?, ?, ?) ON CONFLICT (worker) DO UPDATE SET kind = excluded.kind, target = excluded.target, philosophy = excluded.philosophy',
      ).run(worker, vote.kind, vote.target ?? null, vote.philosophy ?? null)
    },
    invest(investor: string, companyId: number, amount: number) {
      const cash =
        db
          .query<{ cash: number }, [string]>(
            'SELECT cash FROM investors WHERE name = ?',
          )
          .get(investor)?.cash ?? 0
      if (!(amount > 0 && amount <= cash)) {
        throw new Error(`投資額は 0 より大きく、手元の資金 ${cash} 以下です`)
      }
      if (!company(companyId)) throw new Error('投資先の会社がありません')
      db.transaction(() => {
        db.query('UPDATE investors SET cash = cash - ? WHERE name = ?').run(
          amount,
          investor,
        )
        db.query('UPDATE companies SET capital = capital + ? WHERE id = ?').run(
          amount,
          companyId,
        )
        db.query(
          'INSERT INTO stakes (investor, company_id, amount) VALUES (?, ?, ?) ON CONFLICT (investor, company_id) DO UPDATE SET amount = amount + excluded.amount',
        ).run(investor, companyId, amount)
      })()
    },
    saveMeeting(companyId: number, cycle: number, transcript: string) {
      db.query(
        'INSERT INTO meetings (company_id, cycle, transcript) VALUES (?, ?, ?)',
      ).run(companyId, cycle, transcript)
    },

    // 期末の精算: 市場の採点から価値と売上を決め、配当と費用を払い、投票で合併・分裂し、資本の尽きた会社を畳む
    settle(cycle: number) {
      db.transaction(() => {
        for (const c of companies()) {
          const { avg } = db
            .query<{ avg: number | null }, [number, number]>(
              'SELECT AVG(score) AS avg FROM ideas WHERE company_id = ? AND cycle = ? AND score IS NOT NULL',
            )
            .get(c.id, cycle) ?? { avg: null }
          // 成果のない期は価値が半分に下がる
          const value = avg ?? c.value / 2
          const revenue = value * REVENUE_RATE
          const stakes = db
            .query<{ investor: string; amount: number }, [number]>(
              'SELECT investor, amount FROM stakes WHERE company_id = ?',
            )
            .all(c.id)
          const total = stakes.reduce((sum, s) => sum + s.amount, 0)
          const dividend = total > 0 ? revenue / 2 : 0
          for (const s of stakes) {
            db.query('UPDATE investors SET cash = cash + ? WHERE name = ?').run(
              (dividend * s.amount) / total,
              s.investor,
            )
          }
          const cost = workersOf(c.id).length * WORKER_COST
          db.query(
            'UPDATE companies SET value = ?, capital = capital + ? - ? WHERE id = ?',
          ).run(value, revenue - dividend, cost, c.id)
        }

        const votes = db
          .query<
            {
              worker: string
              kind: string
              target: number | null
              philosophy: string | null
              company_id: number | null
            },
            []
          >(
            'SELECT v.*, w.company_id FROM votes v JOIN workers w ON w.name = v.worker',
          )
          .all()

        // 合併: A の過半数が B との合併に投票し、B からも1人以上が A との合併に投票したら、B が A を吸収する
        for (const a of companies()) {
          const members = workersOf(a.id)
          const targets = votes.filter(
            (v) => v.company_id === a.id && v.kind === 'merge',
          )
          for (const b of companies()) {
            if (b.id === a.id || !company(a.id) || !company(b.id)) continue
            const yes = targets.filter((v) => v.target === b.id).length
            const accepted = votes.some(
              (v) =>
                v.company_id === b.id &&
                v.kind === 'merge' &&
                v.target === a.id,
            )
            if (yes * 2 > members.length && accepted) {
              db.query(
                'UPDATE companies SET capital = capital + ? WHERE id = ?',
              ).run(a.capital, b.id)
              db.query(
                'UPDATE workers SET company_id = ? WHERE company_id = ?',
              ).run(b.id, a.id)
              db.query(
                'INSERT INTO stakes (investor, company_id, amount) SELECT investor, ?, amount FROM stakes WHERE company_id = ? ON CONFLICT (investor, company_id) DO UPDATE SET amount = amount + excluded.amount',
              ).run(b.id, a.id)
              db.query('DELETE FROM stakes WHERE company_id = ?').run(a.id)
              dissolve(a.id)
            }
          }
        }

        // 分裂: 同じ会社の2人以上が分裂に投票したら、その worker で新しい会社を作り、人数の比で資本を分ける
        for (const c of companies()) {
          const splitters = votes.filter(
            (v) =>
              v.company_id === c.id &&
              v.kind === 'split' &&
              workerCompany(v.worker) === c.id,
          )
          const members = workersOf(c.id)
          if (splitters.length < 2 || splitters.length >= members.length)
            continue
          const share = (c.capital * splitters.length) / members.length
          const id = found(
            `${c.name}から分裂`,
            share,
            splitters.find((v) => v.philosophy)?.philosophy ?? '',
          )
          db.query(
            'UPDATE companies SET capital = capital - ? WHERE id = ?',
          ).run(share, c.id)
          for (const v of splitters) {
            db.query('UPDATE workers SET company_id = ? WHERE name = ?').run(
              id,
              v.worker,
            )
          }
        }

        for (const c of companies()) {
          if (c.capital < WORKER_COST) dissolve(c.id)
        }
      })()
    },
  }
}

export type Economy = ReturnType<typeof openEconomy>
