import { Database } from 'bun:sqlite'

// ponytail: 経済の定数は仮の値。ループを回して偏りが出たら調整する
export const WORKER_COST = 10
export const MAX_WORKERS = 5
export const REVENUE_RATE = 3
const FOUNDING_CAPITAL = 30
const INVESTOR_CASH = 100
const INITIAL_COMPANIES = 2
const INITIAL_INVESTORS = 2
// investor が1期に使える、期の初めの資金に対する割合
const INVEST_SHARE = 0.3

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
  entry: string | null
  cycle: number
}
export type Message = {
  id: number
  from_agent: string
  to_agent: string
  content: string
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
    CREATE TABLE IF NOT EXISTS pool_tasks (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      worker TEXT,
      body TEXT NOT NULL,
      result TEXT,
      cycle INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS votes (
      worker TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      target INTEGER,
      philosophy TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      content TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS board (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL,
      from_agent TEXT NOT NULL,
      content TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS investments (
      investor TEXT NOT NULL,
      company_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      cycle INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history (
      cycle INTEGER NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      amount REAL NOT NULL
    );`)
  // 古い DB には列を足す。settled は採点済みのアイデアを精算に1回だけ使うための印、
  // entry はアイデアの根拠になる共有コンテキストのラベル
  const ideaColumns = db
    .query<{ name: string }, []>('PRAGMA table_info(ideas)')
    .all()
    .map((c) => c.name)
  if (!ideaColumns.includes('settled')) {
    db.run('ALTER TABLE ideas ADD COLUMN settled INTEGER NOT NULL DEFAULT 0')
  }
  if (!ideaColumns.includes('entry')) {
    db.run('ALTER TABLE ideas ADD COLUMN entry TEXT')
  }

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
  const cycle = () => Number(meta('cycle') ?? 0)
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
  // worker が引き受けて、まだ終えていない仕事
  const openTask = (worker: string) =>
    db
      .query<{ id: number; body: string }, [string]>(
        'SELECT id, body FROM pool_tasks WHERE worker = ? AND result IS NULL ORDER BY id LIMIT 1',
      )
      .get(worker)
  // 会社のタスクプールにある、誰も引き受けていない仕事
  const pool = (companyId: number) =>
    db
      .query<{ id: number; body: string }, [number]>(
        'SELECT id, body FROM pool_tasks WHERE company_id = ? AND worker IS NULL AND result IS NULL ORDER BY id',
      )
      .all(companyId)

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

  // 資本で賄える数に worker を合わせる。採用は所属のない worker から優先し、記憶を引き継ぐ
  const staff = (companyId: number) => {
    const target = Math.min(
      MAX_WORKERS,
      Math.max(0, Math.floor((company(companyId)?.capital ?? 0) / WORKER_COST)),
    )
    const current = workersOf(companyId)
    for (const name of current.slice(target)) {
      db.query('UPDATE workers SET company_id = NULL WHERE name = ?').run(name)
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
  }

  return {
    db,
    cycle,
    goal: () => meta('goal') ?? '',
    companies,
    company,
    workersOf,
    workerCompany,
    openTask,
    pool,
    // 画面に出す、会社の仕事の新しい順。未着手・作業中・完了のどれかは worker と result で分かる
    tasks: (companyId: number, limit = 20) =>
      db
        .query<
          {
            id: number
            worker: string | null
            body: string
            result: string | null
          },
          [number, number]
        >(
          'SELECT id, worker, body, result FROM pool_tasks WHERE company_id = ? ORDER BY id DESC LIMIT ?',
        )
        .all(companyId, limit),
    staff,
    investors: () =>
      db
        .query<{ name: string; cash: number }, []>(
          'SELECT name, cash FROM investors ORDER BY name',
        )
        .all(),
    // 画面の関係図に出す、投資家ごとの出資
    stakes: () =>
      db
        .query<{ investor: string; company_id: number; amount: number }, []>(
          'SELECT investor, company_id, amount FROM stakes ORDER BY investor, company_id',
        )
        .all(),
    // 画面のグラフに出す、精算ごとの会社の資本・価値と投資家の資金
    history: () =>
      db
        .query<
          { cycle: number; kind: string; name: string; amount: number },
          []
        >('SELECT cycle, kind, name, amount FROM history ORDER BY cycle')
        .all(),
    // 期ごとのアイデアの数と平均の評価
    ideaStats: () =>
      db
        .query<{ cycle: number; ideas: number; avg: number | null }, []>(
          'SELECT cycle, COUNT(*) AS ideas, AVG(score) AS avg FROM ideas GROUP BY cycle ORDER BY cycle',
        )
        .all(),
    stakesOf: (investor: string) =>
      db
        .query<{ company_id: number; amount: number }, [string]>(
          'SELECT company_id, amount FROM stakes WHERE investor = ?',
        )
        .all(investor),
    unscoredIdeas: () =>
      db
        .query<Idea, []>('SELECT * FROM ideas WHERE score IS NULL ORDER BY id')
        .all(),
    recentIdeas: (companyId: number, limit = 10) =>
      db
        .query<Idea, [number, number]>(
          'SELECT * FROM ideas WHERE company_id = ? ORDER BY id DESC LIMIT ?',
        )
        .all(companyId, limit),
    latestIdeas: (limit = 20) =>
      db
        .query<Idea, [number]>('SELECT * FROM ideas ORDER BY id DESC LIMIT ?')
        .all(limit),
    unread: (agent: string) =>
      db
        .query<Message, [string]>(
          'SELECT id, from_agent, to_agent, content FROM messages WHERE to_agent = ? AND read = 0 ORDER BY id',
        )
        .all(agent),
    markRead: (ids: number[]) => {
      for (const id of ids) {
        db.query('UPDATE messages SET read = 1 WHERE id = ?').run(id)
      }
    },
    recentMessages: (limit = 30) =>
      db
        .query<Message, [number]>(
          'SELECT id, from_agent, to_agent, content FROM messages ORDER BY id DESC LIMIT ?',
        )
        .all(limit),

    // 目的を設定する。初回は会社と投資家を用意する
    setGoal(goal: string) {
      db.transaction(() => {
        setMeta('goal', goal)
        if (companies().length) return
        for (let i = 1; i <= INITIAL_COMPANIES; i++) {
          staff(found(`会社${i}`, FOUNDING_CAPITAL))
        }
        for (let i = 1; i <= INITIAL_INVESTORS; i++) {
          db.query('INSERT INTO investors (name, cash) VALUES (?, ?)').run(
            `investor-${i}`,
            INVESTOR_CASH,
          )
        }
        setMeta('cycle', '1')
      })()
    },

    setPhilosophy(companyId: number, philosophy: string) {
      db.query('UPDATE companies SET philosophy = ? WHERE id = ?').run(
        philosophy,
        companyId,
      )
    },
    // 会社のタスクプールに仕事を足す。誰がやるかは worker が選ぶ
    addTask(companyId: number, body: string) {
      db.query(
        'INSERT INTO pool_tasks (company_id, body, cycle) VALUES (?, ?, ?)',
      ).run(companyId, body, cycle())
    },
    // 自分の会社のプールから仕事を引き受ける。抱える仕事は1件まで
    claimTask(worker: string, id: number) {
      if (openTask(worker)) throw new Error('まだ仕事の途中です')
      const { changes } = db
        .query(
          'UPDATE pool_tasks SET worker = ? WHERE id = ? AND company_id = ? AND worker IS NULL AND result IS NULL',
        )
        .run(worker, id, workerCompany(worker) ?? -1)
      if (changes) return
      // 同僚と同時に取り合ったときに、別の仕事を選び直せるよう、誰が持っているかと残りを返す
      const taken = db
        .query<
          { worker: string | null; result: string | null },
          [number, number]
        >(
          'SELECT worker, result FROM pool_tasks WHERE id = ? AND company_id = ?',
        )
        .get(id, workerCompany(worker) ?? -1)
      const rest = pool(workerCompany(worker) ?? -1).map((t) => t.id)
      const left = rest.length
        ? `まだ誰も引き受けていない仕事: ${rest.join(', ')}`
        : 'まだ誰も引き受けていない仕事はありません'
      throw new Error(
        taken?.result
          ? `仕事 ${id} は終わっています。${left}`
          : taken?.worker
            ? `仕事 ${id} は ${taken.worker} が引き受けました。${left}`
            : `自分の会社のプールに仕事 ${id} はありません。${left}`,
      )
    },
    finishTask(worker: string, result: string) {
      const task = openTask(worker)
      if (!task) throw new Error('終わらせる仕事がありません')
      db.query('UPDATE pool_tasks SET result = ? WHERE id = ?').run(
        result,
        task.id,
      )
    },
    // entry は根拠になる共有コンテキストのラベル（S…）。市場はその Summary を見て評価する
    postIdea(
      worker: string,
      idea: { title: string; body: string; entry?: string },
    ) {
      const companyId = workerCompany(worker)
      if (companyId === null) throw new Error('所属する会社がありません')
      db.query(
        'INSERT INTO ideas (company_id, worker, title, body, entry, cycle) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        companyId,
        worker,
        idea.title,
        idea.body,
        idea.entry ?? null,
        cycle(),
      )
    },
    scoreIdea(id: number, score: number, reason: string) {
      if (!(score >= 0 && score <= 10)) {
        throw new Error('score は 0〜10 です')
      }
      const { changes } = db
        .query(
          'UPDATE ideas SET score = ?, reason = ? WHERE id = ? AND score IS NULL',
        )
        .run(score, reason, id)
      if (!changes) throw new Error(`未採点のアイデア ${id} はありません`)
    },
    // メッセージは届いた相手を起こすため、1人の相手への質問や依頼に限る。進捗は掲示板に出す
    sendMessage(from: string, to: string, content: string) {
      if (to === from) throw new Error('自分には送れません')
      if (!db.query('SELECT 1 FROM workers WHERE name = ?').get(to)) {
        throw new Error(`${to} という worker はいません`)
      }
      db.query(
        'INSERT INTO messages (from_agent, to_agent, content) VALUES (?, ?, ?)',
      ).run(from, to, content)
    },
    // 会社の掲示板。誰も起こさず、次に動くときに読まれる
    postBoard(from: string, content: string) {
      const companyId = workerCompany(from)
      if (companyId === null) throw new Error('所属する会社がありません')
      db.query(
        'INSERT INTO board (company_id, from_agent, content) VALUES (?, ?, ?)',
      ).run(companyId, from, content)
    },
    board: (companyId: number, limit = 10) =>
      db
        .query<
          { id: number; from_agent: string; content: string },
          [number, number]
        >(
          'SELECT id, from_agent, content FROM board WHERE company_id = ? ORDER BY id DESC LIMIT ?',
        )
        .all(companyId, limit)
        .reverse(),
    // 市場の採点の目安にする、採点済みのアイデアの分布
    scoreSummary: () =>
      db
        .query<{ score: number; n: number }, []>(
          'SELECT score, COUNT(*) AS n FROM ideas WHERE score IS NOT NULL GROUP BY score ORDER BY score',
        )
        .all(),
    nextSettleAt: () => Number(meta('next_settle_at') ?? 0),
    setNextSettleAt: (at: number) => setMeta('next_settle_at', String(at)),
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
      // 1期に使えるのは、期の初めの資金の一定割合まで。一度に全額を賭けて判断の余地をなくさないため
      const spent =
        db
          .query<{ total: number | null }, [string, number]>(
            'SELECT SUM(amount) AS total FROM investments WHERE investor = ? AND cycle = ?',
          )
          .get(investor, cycle())?.total ?? 0
      const limit = (cash + spent) * INVEST_SHARE - spent
      if (!(amount > 0 && amount <= limit + 1e-9)) {
        throw new Error(
          `投資額は 0 より大きく、この期の残りの上限 ${limit.toFixed(1)} 以下です（期の初めの資金の ${INVEST_SHARE * 100}% まで）`,
        )
      }
      if (!company(companyId)) throw new Error('投資先の会社がありません')
      db.transaction(() => {
        db.query(
          'INSERT INTO investments (investor, company_id, amount, cycle) VALUES (?, ?, ?, ?)',
        ).run(investor, companyId, amount, cycle())
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

    // 期末の精算: 未精算の採点から価値と売上を決め、配当と費用を払い、投票で合併・分裂し、
    // 資本の尽きた会社を畳み、資本に合わせて人数を揃えてから次の期に進む
    settle() {
      db.transaction(() => {
        for (const c of companies()) {
          const { avg } = db
            .query<{ avg: number | null }, [number]>(
              'SELECT AVG(score) AS avg FROM ideas WHERE company_id = ? AND score IS NOT NULL AND settled = 0',
            )
            .get(c.id) ?? { avg: null }
          db.query(
            'UPDATE ideas SET settled = 1 WHERE company_id = ? AND score IS NOT NULL',
          ).run(c.id)
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
              ).run(company(a.id)?.capital ?? 0, b.id)
              db.query(
                'UPDATE workers SET company_id = ? WHERE company_id = ?',
              ).run(b.id, a.id)
              db.query(
                'INSERT INTO stakes (investor, company_id, amount) SELECT investor, ?, amount FROM stakes WHERE company_id = ? ON CONFLICT (investor, company_id) DO UPDATE SET amount = amount + excluded.amount',
              ).run(b.id, a.id)
              db.query(
                'UPDATE pool_tasks SET company_id = ? WHERE company_id = ?',
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
          else staff(c.id)
        }
        // 解雇や移籍で会社を離れた worker の仕事は、元の会社のプールに戻す
        db.run(
          'UPDATE pool_tasks SET worker = NULL WHERE result IS NULL AND worker IS NOT NULL AND worker NOT IN (SELECT name FROM workers WHERE company_id = pool_tasks.company_id)',
        )
        db.run('DELETE FROM votes')
        const record = db.query(
          'INSERT INTO history (cycle, kind, name, amount) VALUES (?, ?, ?, ?)',
        )
        for (const c of companies()) {
          record.run(cycle(), 'capital', `${c.id}: ${c.name}`, c.capital)
          record.run(cycle(), 'value', `${c.id}: ${c.name}`, c.value)
        }
        for (const i of db
          .query<{ name: string; cash: number }, []>(
            'SELECT name, cash FROM investors',
          )
          .all()) {
          record.run(cycle(), 'cash', i.name, i.cash)
        }
        setMeta('cycle', String(cycle() + 1))
      })()
    },
  }
}

export type Economy = ReturnType<typeof openEconomy>
