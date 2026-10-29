import { Database } from "bun:sqlite";

// Shared state of the whole organization (DeLM) and each agent's persistent context (CLM).
// Every multi-row change runs inside a transaction; single-row ownership changes use conditional UPDATEs.

export type Config = {
  organization: "single" | "fixed" | "dynamic";
  maxAgents: number;
  maxConcurrency: number;
  maxModelCalls: number;
  maxSteps: number;
  memoryLimit: number; // characters of working memory per agent
  toolOutputLimit: number;
  leaseMs: number;
  idleRounds: number; // rounds without work before a dynamic agent goes dormant
  allowShell: boolean;
};

export const defaultConfig: Config = {
  organization: "dynamic", maxAgents: 6, maxConcurrency: 3, maxModelCalls: 200, maxSteps: 16,
  memoryLimit: 6000, toolOutputLimit: 4000, leaseMs: 10 * 60_000, idleRounds: 3, allowShell: false,
};

const schema = `
create table if not exists meta(key text primary key, value text not null);
create table if not exists agents(id text primary key, role text not null, status text not null, parent text, idle int not null default 0, created_at int not null);
create table if not exists goals(id text primary key, parent text, description text not null, status text not null, owner text not null,
  deliverable text, feedback text, verified_by text, rev int not null default 0, created_at int not null);
create table if not exists tasks(id text primary key, goal text not null, kind text not null, description text not null, status text not null,
  author text not null, assignee text, exclude text, target text, claimed_by text, lease_until int, result text, feedback text,
  verified_by text, rev int not null default 0, created_at int not null);
create table if not exists knowledge(id text primary key, gist text not null, summary text not null, raw text not null, source text not null,
  status text not null, author text not null, verified_by text, created_at int not null);
create table if not exists domains(id text primary key, name text not null, description text not null, steward text not null, parent text,
  status text not null, rev int not null default 0);
create table if not exists domain_knowledge(domain text not null, knowledge text not null, primary key(domain, knowledge));
create table if not exists context(agent text primary key, memory text not null, version int not null);
create table if not exists context_history(agent text not null, version int not null, memory text not null, at int not null, primary key(agent, version));
create table if not exists episodes(id text primary key, agent text not null, task text not null, messages text not null, status text not null);
create table if not exists episode_history(episode text not null, at int not null, messages text not null);
create table if not exists ops(episode text not null, call_id text not null, result text not null, is_error int not null, primary key(episode, call_id));
create table if not exists usage(id integer primary key, agent text not null, task text not null, input int not null, output int not null,
  cache_read int not null, cache_write int not null, prompt_chars int not null, ms int not null, at int not null);
create table if not exists log(id integer primary key, at int not null, agent text, event text not null, detail text not null);
`;

export type Agent = { id: string; role: string; status: "active" | "dormant"; parent: string | null; idle: number };
export type Goal = { id: string; parent: string | null; description: string; status: "open" | "review" | "done" | "dropped"; owner: string; deliverable: string | null; feedback: string | null; verified_by: string | null; rev: number };
export type Task = {
  id: string; goal: string; kind: "work" | "verify" | "steer"; description: string; status: "open" | "claimed" | "review" | "done" | "failed";
  author: string; assignee: string | null; exclude: string | null; target: string | null; claimed_by: string | null; lease_until: number | null;
  result: string | null; feedback: string | null; verified_by: string | null; rev: number;
};

export class Store {
  readonly db: Database;
  private seq = 0;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("pragma journal_mode = wal");
    this.db.run("pragma busy_timeout = 5000");
    this.db.exec(schema);
  }

  tx<T>(fn: () => T): T { return this.db.transaction(fn)(); }

  get<T>(sql: string, ...params: any[]) { return (this.db.query(sql).get(...params) ?? undefined) as T | undefined; }
  all<T>(sql: string, ...params: any[]) { return this.db.query(sql).all(...params) as T[]; }
  run(sql: string, ...params: any[]) { return this.db.query(sql).run(...params).changes; }

  id(prefix: string) { return `${prefix}-${Date.now().toString(36)}${(this.seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`; }

  meta(key: string) { return this.get<{ value: string }>("select value from meta where key = ?", key)?.value; }
  setMeta(key: string, value: string) { this.run("insert into meta(key, value) values(?, ?) on conflict(key) do update set value = excluded.value", key, value); }
  get config(): Config { return JSON.parse(this.meta("config") ?? "null") ?? defaultConfig; }
  get purpose() { return this.meta("purpose"); }

  log(agent: string | null, event: string, detail: unknown) {
    this.run("insert into log(at, agent, event, detail) values(?, ?, ?, ?)", Date.now(), agent, event, JSON.stringify(detail));
  }

  // The purpose is fixed for the lifetime of a store; constraints and limits are set alongside it.
  init(purpose: string, constraints: string, config: Config) {
    const existing = this.purpose;
    if (existing !== undefined) {
      if (existing !== purpose) throw new Error("This store already has a different purpose");
      return;
    }
    this.tx(() => {
      this.setMeta("purpose", purpose);
      this.setMeta("constraints", constraints);
      this.setMeta("config", JSON.stringify(config));
      this.setMeta("model_calls", "0");
      this.addAgent("lead", "lead: owns the top-level purpose, plans, organizes, and delivers", null);
      if (config.organization === "fixed") {
        this.addAgent("worker", "worker: carries out assigned work and produces artifacts", "lead");
        this.addAgent("reviewer", "reviewer: verifies results and knowledge independently", "lead");
      }
      this.run("insert into goals(id, parent, description, status, owner, created_at) values('G0', null, ?, 'open', 'lead', ?)", purpose, Date.now());
    });
  }

  addAgent(id: string, role: string, parent: string | null) {
    this.run("insert into agents(id, role, status, parent, created_at) values(?, ?, 'active', ?, ?)", id, role, parent, Date.now());
    this.run("insert into context(agent, memory, version) values(?, '', 0)", id);
    this.log(parent, "agent_created", { id, role });
  }

  agents(status?: string) { return status ? this.all<Agent>("select * from agents where status = ?", status) : this.all<Agent>("select * from agents"); }
  agent(id: string) { return this.get<Agent>("select * from agents where id = ?", id); }
  task(id: string) { return this.get<Task>("select * from tasks where id = ?", id); }
  goal(id: string) { return this.get<Goal>("select * from goals where id = ?", id); }

  addTask(t: { goal: string; kind: Task["kind"]; description: string; author: string; assignee?: string | null; exclude?: string | null; target?: string | null }) {
    const id = this.id("T");
    this.run("insert into tasks(id, goal, kind, description, status, author, assignee, exclude, target, created_at) values(?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)",
      id, t.goal, t.kind, t.description, t.author, t.assignee ?? null, t.exclude ?? null, t.target ?? null, Date.now());
    if (t.assignee) this.run("update agents set status = 'active', idle = 0 where id = ? and status = 'dormant'", t.assignee);
    return id;
  }

  // Atomic claim: only one agent can move an open task to claimed.
  claim(taskId: string, agent: string, now = Date.now()) {
    return this.run("update tasks set status = 'claimed', claimed_by = ?, lease_until = ?, rev = rev + 1 where id = ? and status = 'open'",
      agent, now + this.config.leaseMs, taskId) === 1;
  }

  renew(taskId: string, agent: string) {
    this.run("update tasks set lease_until = ? where id = ? and claimed_by = ? and status = 'claimed'", Date.now() + this.config.leaseMs, taskId, agent);
  }

  reclaimExpired(now = Date.now()) {
    return this.run("update tasks set status = 'open', claimed_by = null, lease_until = null, rev = rev + 1 where status = 'claimed' and lease_until < ?", now);
  }

  // Counts a model call against the persistent budget before it is made.
  takeModelCall() {
    return this.tx(() => {
      const used = Number(this.meta("model_calls"));
      if (used >= this.config.maxModelCalls) return false;
      this.setMeta("model_calls", String(used + 1));
      return true;
    });
  }

  memory(agent: string) { return this.get<{ memory: string; version: number }>("select memory, version from context where agent = ?", agent); }

  // Old versions stay in context_history so a rewrite or compaction never loses earlier context.
  writeMemory(agent: string, memory: string) {
    return this.tx(() => {
      const current = this.memory(agent)!;
      this.run("insert into context_history(agent, version, memory, at) values(?, ?, ?, ?)", agent, current.version, current.memory, Date.now());
      this.run("update context set memory = ?, version = version + 1 where agent = ?", memory, agent);
      return current.version + 1;
    });
  }
}
