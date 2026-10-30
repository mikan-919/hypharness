import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Row = Record<string, any>;
type Session = { id: string; purpose: string; mode: string; modelCalls: number; rootStatus: string; lastAt: number | null };
type Overview = {
  purpose: string; constraints: string; config: Row; modelCalls: number; totals: Row;
  agents: Row[]; goals: Row[]; tasks: Row[]; knowledge: Row[]; domains: Row[]; usage: Row[]; log: Row[];
};
type AgentDetail = { memory: { memory: string; version: number }; episodes: Row[]; history: Row[]; live: { episode: string; text: string } | null };

const REFRESH_MS = 3000;
const num = new Intl.NumberFormat("ja-JP");
const time = (at: number | null | undefined) => at ? new Date(at).toLocaleString("ja-JP") : "-";
const pct = (a: number, b: number) => b ? `${Math.round((a / b) * 100)}%` : "-";
// pi-ai reports input without cached tokens, so the prompt's full size is the sum of the three.
const promptTokens = (r: Row) => (r.input ?? 0) + (r.cacheRead ?? 0) + (r.cacheWrite ?? 0);

// Polls a JSON endpoint; the harness writes while the dashboard reads, so the view refreshes on an interval.
function usePoll<T>(url: string | null, ms = REFRESH_MS) {
  const [data, setData] = useState<T>();
  useEffect(() => {
    if (!url) return setData(undefined);
    let live = true;
    const load = () => fetch(url).then(r => r.ok ? r.json() : undefined).then(d => live && setData(d)).catch(() => {});
    load();
    const t = setInterval(load, ms);
    return () => { live = false; clearInterval(t); };
  }, [url, ms]);
  return data;
}

const statusVariant: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  done: "default", verified: "default", accepted: "default", active: "default", claimed: "secondary", review: "secondary", running: "secondary",
  open: "outline", hypothesis: "outline", dormant: "outline", failed: "destructive", rejected: "destructive", dropped: "destructive", expired: "destructive",
};
const Status = ({ value }: { value: string }) => <Badge variant={statusVariant[value] ?? "outline"}>{value}</Badge>;

function Kpi({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <Card className="gap-1 py-4">
      <CardHeader className="px-4"><CardDescription>{label}</CardDescription></CardHeader>
      <CardContent className="px-4">
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        {note && <div className="text-xs text-muted-foreground">{note}</div>}
      </CardContent>
    </Card>
  );
}

function DataTable({ columns, rows, onSelect, selected, empty = "データなし" }: {
  columns: { key: string; label: string; render?: (r: Row) => React.ReactNode; className?: string }[];
  rows: Row[]; onSelect?: (r: Row) => void; selected?: string; empty?: string;
}) {
  return (
    <Table>
      <TableHeader><TableRow>{columns.map(c => <TableHead key={c.key} className={c.className}>{c.label}</TableHead>)}</TableRow></TableHeader>
      <TableBody>
        {rows.length === 0 && <TableRow><TableCell colSpan={columns.length} className="text-muted-foreground">{empty}</TableCell></TableRow>}
        {rows.map((r, i) => (
          <TableRow key={r.id ?? i} onClick={onSelect && (() => onSelect(r))} data-state={selected !== undefined && r.id === selected ? "selected" : undefined}
            className={onSelect ? "cursor-pointer" : undefined}>
            {columns.map(c => <TableCell key={c.key} className={c.className}>{c.render ? c.render(r) : String(r[c.key] ?? "-")}</TableCell>)}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const Clip = ({ text, width = "max-w-md" }: { text?: string | null; width?: string }) =>
  <span className={`block truncate ${width}`} title={text ?? ""}>{text ?? "-"}</span>;

// Colors follow the agent (creation order), not its rank, so filtering never repaints a line.
function seriesConfig(agents: Row[]): ChartConfig {
  // ponytail: the palette has 8 validated slots; agents past the 8th are not drawn, fold them into "other" if larger organizations appear
  return Object.fromEntries(agents.slice(0, 8).map((a, i) => [a.id, { label: a.id, color: `var(--chart-${i + 1})` }]));
}

function PerCallChart({ title, description, usage, agents, field }: { title: string; description: string; usage: Row[]; agents: Row[]; field: string }) {
  const config = seriesConfig(agents);
  const data = usage.map((u, i) => ({ call: i + 1, [u.agent]: u[field] }));
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader>
      <CardContent>
        {usage.length === 0 ? <div className="text-sm text-muted-foreground">まだモデル呼び出しがありません</div> : (
          <ChartContainer config={config} className="aspect-auto h-64 w-full">
            <LineChart data={data} margin={{ left: 8, right: 16, top: 8 }}>
              <CartesianGrid vertical={false} strokeOpacity={0.5} />
              <XAxis dataKey="call" tickLine={false} axisLine={false} label={{ value: "呼び出し順", position: "insideBottomRight", offset: -4, fontSize: 11 }} />
              <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={v => num.format(v)} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, p) => `呼び出し #${p[0]?.payload.call}`} />} />
              <ChartLegend content={<ChartLegendContent />} />
              {Object.keys(config).map(id => (
                <Line key={id} dataKey={id} type="linear" stroke={`var(--color-${id})`} strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls isAnimationActive={false} />
              ))}
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

function AgentPanel({ session, agent }: { session: string; agent: Row }) {
  const detail = usePoll<AgentDetail>(`/api/agent?s=${encodeURIComponent(session)}&id=${encodeURIComponent(agent.id)}`);
  const [episode, setEpisode] = useState<string>();
  const past = usePoll<{ text: string }>(episode ? `/api/episode?s=${encodeURIComponent(session)}&id=${encodeURIComponent(episode)}` : null, 60_000);
  useEffect(() => setEpisode(undefined), [agent.id]);
  if (!detail) return null;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{agent.id} の作業記憶 <span className="text-muted-foreground font-normal">v{detail.memory.version}</span></CardTitle>
          <CardDescription>{agent.role}</CardDescription>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-72 rounded-md border p-3">
            <pre className="text-xs whitespace-pre-wrap">{detail.memory.memory || "(空)"}</pre>
          </ScrollArea>
          <div className="mt-2 text-xs text-muted-foreground">
            履歴: {detail.history.map(h => `v${h.version} (${num.format(h.chars)}字)`).join("、") || "なし"}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{episode ? `エピソード ${episode}` : "実行中の文脈"}</CardTitle>
          <CardDescription>{episode ? "過去のエピソードの最終状態" : detail.live ? detail.live.episode : "実行中のタスクなし"}</CardDescription>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-72 rounded-md border p-3">
            <pre className="text-xs whitespace-pre-wrap">{(episode ? past?.text : detail.live?.text) ?? "-"}</pre>
          </ScrollArea>
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader><CardTitle>エピソード</CardTitle><CardDescription>行を選ぶと右上に内容を表示します</CardDescription></CardHeader>
        <CardContent>
          <DataTable rows={detail.episodes} selected={episode} onSelect={r => setEpisode(r.id === episode ? undefined : r.id)} columns={[
            { key: "id", label: "ID" }, { key: "task", label: "タスク" },
            { key: "status", label: "状態", render: r => <Status value={r.status} /> },
            { key: "chars", label: "文字数", render: r => num.format(r.chars), className: "text-right tabular-nums" },
          ]} />
        </CardContent>
      </Card>
    </div>
  );
}

type RunInfo = { dir: string; kind: string; args: string[]; startedAt: number; endedAt: number | null; exitCode: number | null; running: boolean };

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

const toInt = (v: string) => v.trim() ? Number(v) : undefined;
const enc = encodeURIComponent;
// A bench run owns several sessions under its directory, so a session belongs to the run whose dir contains it.
const runFor = (list: RunInfo[] | undefined, session: string) =>
  list?.filter(r => r.dir === session || session.startsWith(`${r.dir}/`)).sort((a, b) => b.startedAt - a.startedAt)[0];

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function NewRun({ onStarted, onClose }: { onStarted: (dir: string) => void; onClose: () => void }) {
  const [form, setForm] = useState({ name: "", purpose: "", constraints: "", mode: "dynamic", calls: "", agents: "", concurrency: "", check: "", allowShell: false });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(undefined);
    try {
      const bench = form.mode === "bench";
      const run = await post("/api/runs", {
        name: form.name, kind: bench ? "bench" : "run", mode: bench ? undefined : form.mode, purpose: form.purpose, constraints: form.constraints,
        calls: toInt(form.calls), agents: toInt(form.agents), concurrency: toInt(form.concurrency), check: form.check, allowShell: form.allowShell,
      });
      onStarted(run.dir);
    } catch (err) { setError(String((err as Error).message)); } finally { setBusy(false); }
  };
  return (
    <Card>
      <CardHeader><CardTitle>新規実行</CardTitle><CardDescription>目的と制約だけを渡します。達成の手順はエージェントが決めます</CardDescription></CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
          <Field id="purpose" label="最上位目的"><Textarea id="purpose" required rows={3} value={form.purpose} onChange={set("purpose")} placeholder="例: CSV を集計する CLI を書き、テストを通す" /></Field>
          <Field id="constraints" label="制約" hint="任意"><Textarea id="constraints" rows={3} value={form.constraints} onChange={set("constraints")} placeholder="例: TypeScript のみ、外部パッケージを使わない" /></Field>
          <Field id="name" label="セッション名" hint="小文字・数字・- と _（.hyph/<名前> に保存）"><Input id="name" required pattern="[a-z0-9][a-z0-9_\-]{0,39}" value={form.name} onChange={set("name")} placeholder="csv-cli" /></Field>
          <Field id="mode" label="組織" hint="bench は single・fixed・dynamic を同じ条件で順に実行して比較します">
            <Select value={form.mode} onValueChange={v => setForm({ ...form, mode: v })}>
              <SelectTrigger id="mode"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="dynamic">dynamic（エージェントが増減を判断）</SelectItem>
                <SelectItem value="fixed">fixed（3体で固定）</SelectItem>
                <SelectItem value="single">single（1体）</SelectItem>
                <SelectItem value="bench">bench（3方式を比較）</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field id="calls" label="呼び出し上限"><Input id="calls" type="number" min={1} value={form.calls} onChange={set("calls")} placeholder="なし" /></Field>
            <Field id="agents" label="エージェント上限"><Input id="agents" type="number" min={1} value={form.agents} onChange={set("agents")} placeholder="なし" /></Field>
            <Field id="concurrency" label="同時実行"><Input id="concurrency" type="number" min={1} value={form.concurrency} onChange={set("concurrency")} placeholder="なし" /></Field>
          </div>
          <Field id="check" label="終了後の検査コマンド" hint="作業ディレクトリで実行し、終了コードを結果に含めます"><Input id="check" value={form.check} onChange={set("check")} placeholder="bun test" /></Field>
          <div className="flex items-center gap-2">
            <Switch id="shell" checked={form.allowShell} onCheckedChange={v => setForm({ ...form, allowShell: v })} />
            <Label htmlFor="shell">シェルの実行を許可する</Label>
          </div>
          <div className="flex items-center justify-end gap-2 md:col-span-2">
            {error && <span className="mr-auto text-sm text-destructive">{error}</span>}
            <Button type="button" variant="ghost" onClick={onClose}>閉じる</Button>
            <Button type="submit" disabled={busy}>{busy ? "起動中…" : "実行する"}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function RunControl({ session, o }: { session: string; o?: Overview }) {
  const list = usePoll<RunInfo[]>("/api/runs", 2000);
  const run = runFor(list, session);
  const live = usePoll<RunInfo & { lines: string[] }>(run ? `/api/output?dir=${enc(run.dir)}` : null, 2000);
  const saved = usePoll<{ lines: string[] }>(run ? null : `/api/runlog?s=${enc(session)}`, 10_000);
  const out = live ?? (saved?.lines.length ? saved : undefined);
  const [calls, setCalls] = useState("");
  const [allowShell, setAllowShell] = useState(false);
  const [check, setCheck] = useState("");
  const [error, setError] = useState<string>();
  const loaded = !!o;
  useEffect(() => { if (o) { setCalls(o.config.maxModelCalls == null ? "" : String(o.modelCalls + 50)); setAllowShell(!!o.config.allowShell); } }, [session, loaded]);
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [out?.lines.length]);
  const act = async (fn: () => Promise<unknown>) => { setError(undefined); try { await fn(); } catch (e) { setError(String((e as Error).message)); } };
  const running = !!run?.running;
  const done = o?.goals.find(g => g.id === "G0")?.status === "done";

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
        <div className="grid gap-1.5">
          <CardTitle className="flex items-center gap-2">実行 <Badge variant={running ? "secondary" : "outline"}>{running ? "実行中" : "停止中"}</Badge></CardTitle>
          <CardDescription>
            {run ? (running ? `${time(run.startedAt)} に開始` : `${time(run.endedAt)} に終了（終了コード ${run.exitCode}）`) : out ? "前回までの実行出力（run.log）" : "このダッシュボードを起動してからは実行していません"}
          </CardDescription>
        </div>
        {running ? (
          <Button variant="destructive" onClick={() => act(() => post("/api/runs/stop", { dir: run!.dir }))}>停止する</Button>
        ) : o && (
          <form className="flex flex-wrap items-end gap-3" onSubmit={e => { e.preventDefault(); act(() => post("/api/runs/resume", { session, calls: toInt(calls), allowShell, check })); }}>
            <Field id="resume-calls" label="呼び出し上限（累計）"><Input id="resume-calls" className="w-32" type="number" min={1} value={calls} onChange={e => setCalls(e.target.value)} placeholder="なし" /></Field>
            <Field id="resume-check" label="検査コマンド"><Input id="resume-check" className="w-40" value={check} onChange={e => setCheck(e.target.value)} placeholder="任意" /></Field>
            <div className="flex h-9 items-center gap-2">
              <Switch id="resume-shell" checked={allowShell} onCheckedChange={setAllowShell} />
              <Label htmlFor="resume-shell">シェルを許可</Label>
            </div>
            <Button type="submit" disabled={done} title={done ? "最上位目標は完了しています" : undefined}>再開する</Button>
          </form>
        )}
      </CardHeader>
      {(error || out) && (
        <CardContent className="grid gap-2">
          {error && <div className="text-sm text-destructive">{error}</div>}
          {out && (
            <pre ref={logRef} className="h-56 overflow-auto rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap">
              {out.lines.slice(-400).join("\n") || "(出力なし)"}
            </pre>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function Files({ session }: { session: string }) {
  const list = usePoll<{ path: string; size: number }[]>(`/api/files?s=${enc(session)}`, 5000);
  const [path, setPath] = useState<string>();
  const file = usePoll<{ path: string; size: number; truncated: boolean; text: string }>(path ? `/api/file?s=${enc(session)}&path=${enc(path)}` : null, 5000);
  useEffect(() => setPath(undefined), [session]);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <Card>
        <CardHeader><CardTitle>作業ディレクトリ</CardTitle><CardDescription>エージェントが作成した成果物</CardDescription></CardHeader>
        <CardContent>
          <DataTable rows={(list ?? []).map(f => ({ ...f, id: f.path }))} selected={path} onSelect={r => setPath(r.path)} empty="ファイルなし" columns={[
            { key: "path", label: "パス", render: r => <Clip text={r.path} width="max-w-xs" /> },
            { key: "size", label: "サイズ", render: r => `${num.format(r.size)} B`, className: "text-right tabular-nums" },
          ]} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{path ?? "ファイルを選択"}</CardTitle>{file?.truncated && <CardDescription>先頭 200,000 バイトのみ表示</CardDescription>}</CardHeader>
        <CardContent>
          <ScrollArea className="h-[32rem] rounded-md border p-3">
            <pre className="text-xs whitespace-pre-wrap">{file?.text ?? ""}</pre>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

function Dashboard({ session }: { session: string }) {
  const o = usePoll<Overview>(`/api/overview?s=${encodeURIComponent(session)}`);
  const [agentId, setAgentId] = useState<string>();
  const [taskStatus, setTaskStatus] = useState("all");
  const [tab, setTab] = useState(() => location.hash.slice(1) || "agents");
  useEffect(() => { history.replaceState(null, "", `#${tab}`); }, [tab]);
  useEffect(() => setAgentId(undefined), [session]);
  if (!o) return <div className="grid gap-6"><RunControl session={session} /><div className="text-muted-foreground">状態を読み込み中…</div></div>;
  const t = o.totals, root = o.goals.find(g => g.id === "G0");
  const work = o.tasks.filter(x => x.kind === "work");
  const agent = o.agents.find(a => a.id === agentId);
  const tasks = taskStatus === "all" ? o.tasks : o.tasks.filter(x => x.status === taskStatus);

  return (
    <div className="grid gap-6">
      <RunControl session={session} o={o} />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">最上位目的 {root && <Status value={root.status} />}</CardTitle>
          <CardDescription className="text-foreground">{o.purpose}</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          制約: {o.constraints || "なし"} ／ 組織: {o.config.organization} ／ シェル: {o.config.allowShell ? "許可" : "不許可"} ／ 最終呼び出し: {time(t.lastAt)}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-8">
        <Kpi label="モデル呼び出し" value={num.format(o.modelCalls)} note={o.config.maxModelCalls == null ? "上限なし" : `上限 ${num.format(o.config.maxModelCalls)}`} />
        <Kpi label="入力トークン" value={num.format(promptTokens(t))} note={`キャッシュ外 ${num.format(t.input)}`} />
        <Kpi label="出力トークン" value={num.format(t.output)} />
        <Kpi label="キャッシュ読み取り" value={pct(t.cacheRead, promptTokens(t))} note={`${num.format(t.cacheRead)} トークン`} />
        <Kpi label="最大入力トークン" value={num.format(t.maxPromptTokens)} note="1回の呼び出しの入力（キャッシュ分を含む）" />
        <Kpi label="モデル待ち時間" value={`${num.format(Math.round(t.ms / 1000))} 秒`} />
        <Kpi label="エージェント" value={`${o.agents.filter(a => a.status === "active").length} / ${o.agents.length}`} note="稼働 / 全体" />
        <Kpi label="作業タスク" value={`${work.filter(x => x.status === "done").length} / ${work.length}`} note="検証済み / 全体" />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="agents">エージェント</TabsTrigger>
          <TabsTrigger value="files">成果物</TabsTrigger>
          <TabsTrigger value="telemetry">テレメトリ</TabsTrigger>
          <TabsTrigger value="tasks">タスク</TabsTrigger>
          <TabsTrigger value="goals">目標</TabsTrigger>
          <TabsTrigger value="knowledge">知識・領域</TabsTrigger>
          <TabsTrigger value="log">ログ</TabsTrigger>
        </TabsList>

        <TabsContent value="agents" className="grid gap-4">
          <Card>
            <CardHeader><CardTitle>エージェント</CardTitle><CardDescription>行を選ぶと文脈を表示します</CardDescription></CardHeader>
            <CardContent>
              <DataTable rows={o.agents} selected={agentId} onSelect={r => setAgentId(r.id === agentId ? undefined : r.id)} columns={[
                { key: "id", label: "ID" },
                { key: "status", label: "状態", render: r => <Status value={r.status} /> },
                { key: "role", label: "役割", render: r => <Clip text={r.role} width="max-w-xs" /> },
                { key: "parent", label: "生成元" },
                { key: "currentTask", label: "実行中のタスク" },
                { key: "tasksDone", label: "完了", className: "text-right tabular-nums" },
                { key: "calls", label: "呼び出し", render: r => num.format(r.calls), className: "text-right tabular-nums" },
                { key: "input", label: "入力", render: r => num.format(promptTokens(r)), className: "text-right tabular-nums" },
                { key: "output", label: "出力", render: r => num.format(r.output), className: "text-right tabular-nums" },
                { key: "cacheRead", label: "キャッシュ", render: r => pct(r.cacheRead, promptTokens(r)), className: "text-right tabular-nums" },
                { key: "maxPromptTokens", label: "最大入力トークン", render: r => num.format(r.maxPromptTokens), className: "text-right tabular-nums" },
                { key: "memoryVersion", label: "記憶", render: r => `v${r.memoryVersion} · ${num.format(r.memoryChars)}字` },
                { key: "lastAt", label: "最終呼び出し", render: r => time(r.lastAt) },
              ]} />
            </CardContent>
          </Card>
          {agent && <AgentPanel session={session} agent={agent} />}
        </TabsContent>

        <TabsContent value="telemetry" className="grid gap-4">
          <PerCallChart title="1回の入力トークン" description="プロバイダーが報告した呼び出しごとの入力トークン数（キャッシュ分を含む）。長期実行で増え続けないことを確認します" usage={o.usage.map(u => ({ ...u, promptTokens: promptTokens(u) }))} agents={o.agents} field="promptTokens" />
          <Card>
            <CardHeader><CardTitle>呼び出しの記録</CardTitle><CardDescription>新しい順に最大 200 件</CardDescription></CardHeader>
            <CardContent>
              <DataTable rows={o.usage.slice(-200).reverse()} columns={[
                { key: "at", label: "時刻", render: r => time(r.at) }, { key: "agent", label: "エージェント" }, { key: "task", label: "タスク" },
                { key: "input", label: "入力（キャッシュ外）", render: r => num.format(r.input), className: "text-right tabular-nums" },
                { key: "cacheRead", label: "キャッシュ読取", render: r => num.format(r.cacheRead), className: "text-right tabular-nums" },
                { key: "cacheWrite", label: "キャッシュ書込", render: r => num.format(r.cacheWrite), className: "text-right tabular-nums" },
                { key: "output", label: "出力", render: r => num.format(r.output), className: "text-right tabular-nums" },
                { key: "promptTokens", label: "入力合計", render: r => num.format(promptTokens(r)), className: "text-right tabular-nums" },
                { key: "ms", label: "時間", render: r => `${num.format(r.ms)} ms`, className: "text-right tabular-nums" },
              ]} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tasks">
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div className="grid gap-1.5"><CardTitle>タスク</CardTitle><CardDescription>新しい順に最大 500 件</CardDescription></div>
              <Select value={taskStatus} onValueChange={setTaskStatus}>
                <SelectTrigger className="w-36" aria-label="状態で絞り込む"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["all", "open", "claimed", "review", "done", "failed"].map(s => <SelectItem key={s} value={s}>{s === "all" ? "すべて" : s}</SelectItem>)}
                </SelectContent>
              </Select>
            </CardHeader>
            <CardContent>
              <DataTable rows={tasks} columns={[
                { key: "id", label: "ID" }, { key: "kind", label: "種類" },
                { key: "status", label: "状態", render: r => <Status value={r.status} /> },
                { key: "goal", label: "目標" }, { key: "description", label: "内容", render: r => <Clip text={r.description} /> },
                { key: "claimed_by", label: "担当" }, { key: "verified_by", label: "検証者" },
                { key: "result", label: "結果・指摘", render: r => <Clip text={r.result ?? r.feedback} width="max-w-xs" /> },
              ]} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="goals">
          <Card>
            <CardHeader><CardTitle>目標</CardTitle></CardHeader>
            <CardContent>
              <DataTable rows={o.goals} columns={[
                { key: "id", label: "ID" }, { key: "parent", label: "親" },
                { key: "status", label: "状態", render: r => <Status value={r.status} /> },
                { key: "owner", label: "所有者" }, { key: "description", label: "内容", render: r => <Clip text={r.description} /> },
                { key: "deliverable", label: "成果物・指摘", render: r => <Clip text={r.deliverable ?? r.feedback} width="max-w-xs" /> },
                { key: "verified_by", label: "検証者" },
              ]} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="knowledge" className="grid gap-4">
          <Card>
            <CardHeader><CardTitle>知識</CardTitle><CardDescription>Gist と出典。検証状態で仮説と確定を区別します</CardDescription></CardHeader>
            <CardContent>
              <DataTable rows={o.knowledge} columns={[
                { key: "id", label: "ID" }, { key: "status", label: "状態", render: r => <Status value={r.status} /> },
                { key: "gist", label: "Gist", render: r => <Clip text={r.gist} /> }, { key: "source", label: "出典", render: r => <Clip text={r.source} width="max-w-xs" /> },
                { key: "author", label: "登録者" }, { key: "verified_by", label: "検証者" },
              ]} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>領域</CardTitle></CardHeader>
            <CardContent>
              <DataTable rows={o.domains} columns={[
                { key: "id", label: "ID" }, { key: "status", label: "状態", render: r => <Status value={r.status} /> },
                { key: "name", label: "名前" }, { key: "steward", label: "管理者" }, { key: "parent", label: "親" },
                { key: "knowledge", label: "知識数", className: "text-right tabular-nums" },
              ]} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="files"><Files session={session} /></TabsContent>

        <TabsContent value="log">
          <Card>
            <CardHeader><CardTitle>イベントログ</CardTitle><CardDescription>新しい順に最大 500 件</CardDescription></CardHeader>
            <CardContent>
              <DataTable rows={o.log} columns={[
                { key: "at", label: "時刻", render: r => time(r.at) }, { key: "agent", label: "主体", render: r => r.agent ?? "host" },
                { key: "event", label: "イベント" }, { key: "detail", label: "詳細", render: r => <Clip text={r.detail} width="max-w-2xl" /> },
              ]} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

type Generation = {
  gen: number; base: number | null; phase: string; startedAt: number; endedAt?: number; commit?: string; status?: string; note?: string;
  eval?: { ok: boolean; score?: number; reason?: string; context?: { calls: number; maxTokens: number; meanTokens: number; meanPeakTokens: number } };
  accepted?: boolean; reason?: string; error?: string;
};
type EvalTotals = Row & { expected: number; judged: number; calls: number; judgeCalls: number; ms: number; byCategory: Record<string, { avg: number; count: number }> };
type GenStats = Record<number, { improver: Row | null; eval: EvalTotals | null }>;
type RsiInfo = {
  dir: string; pid: number | null; lines: string[]; launcher: string[]; stats: GenStats;
  state: { incumbent?: { gen: number; commit: string }; settings: Row; generations: Generation[] } | null;
};
type RsiGen = { gen: number; usage: Row[]; agents: Row[]; samples: Row[] };

function StackedBars({ title, description, data, series, format = v => num.format(v) }: {
  title: string; description: string; data: Row[]; series: Record<string, string>; format?: (v: number) => string;
}) {
  const config: ChartConfig = Object.fromEntries(Object.entries(series).map(([k, label], i) => [k, { label, color: `var(--chart-${i + 1})` }]));
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader>
      <CardContent>
        {data.length === 0 ? <div className="text-sm text-muted-foreground">まだ世代がありません</div> : (
          <ChartContainer config={config} className="aspect-auto h-56 w-full">
            <BarChart data={data} margin={{ left: 8, right: 16, top: 8 }}>
              <CartesianGrid vertical={false} strokeOpacity={0.5} />
              <XAxis dataKey="gen" tickLine={false} axisLine={false} />
              <YAxis tickLine={false} axisLine={false} width={64} tickFormatter={format} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, p) => `世代 ${p[0]?.payload.gen}`} />} />
              <ChartLegend content={<ChartLegendContent />} />
              {Object.keys(series).map(k => <Bar key={k} dataKey={k} stackId="a" fill={`var(--color-${k})`} isAnimationActive={false} />)}
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

// Resources each generation spent: the improver's session and the evaluation's answering and judging.
function RsiTelemetry({ gens, stats }: { gens: Generation[]; stats: GenStats }) {
  const rows = gens.map(g => {
    const s = stats[g.gen], im = s?.improver, ev = s?.eval;
    return {
      id: String(g.gen), gen: g.gen, improverCalls: im?.calls ?? 0, evalCalls: ev?.calls ?? 0, judgeCalls: ev?.judgeCalls ?? 0,
      improverTokens: im ? promptTokens(im) : 0, evalTokens: ev ? promptTokens(ev) : 0, judgeTokens: ev?.judgeInput ?? 0,
      improverOutput: im?.output ?? 0, evalOutput: ev?.output ?? 0, improverMax: im?.maxPromptTokens ?? 0,
      improverMin: im?.firstAt ? Math.round((im.lastAt - im.firstAt) / 60_000) : 0, evalMin: ev ? Math.round(ev.ms / 60_000) : 0,
      cache: pct((im?.cacheRead ?? 0) + (ev?.cacheRead ?? 0), (im ? promptTokens(im) : 0) + (ev ? promptTokens(ev) : 0)),
      outcomes: ev ? Object.entries(ev.outcomes as Record<string, number>).map(([k, v]) => `${k} ${v}`).join("、") : "-",
    };
  });
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <StackedBars title="モデル呼び出し" description="世代ごとの呼び出し回数。改善役のセッション、評価での解答、採点" data={rows}
          series={{ improverCalls: "改善", evalCalls: "解答", judgeCalls: "採点" }} />
        <StackedBars title="入力トークン" description="世代ごとの入力トークン（キャッシュ分を含む）" data={rows}
          series={{ improverTokens: "改善", evalTokens: "解答", judgeTokens: "採点" }} />
        <StackedBars title="時間（分）" description="改善は最初と最後の呼び出しの間隔、評価は問題ごとの所要時間の合計（並行に解くため実時間より長い）" data={rows}
          series={{ improverMin: "改善", evalMin: "評価" }} />
        <StackedBars title="改善役の最大入力トークン" description="改善役のセッションの1回の呼び出しの最大入力" data={rows} series={{ improverMax: "改善" }} />
      </div>
      <Card>
        <CardHeader><CardTitle>世代ごとの使用量</CardTitle></CardHeader>
        <CardContent>
          <DataTable rows={[...rows].reverse()} columns={[
            { key: "gen", label: "世代" },
            { key: "improverCalls", label: "改善 呼出", render: r => num.format(r.improverCalls), className: "text-right tabular-nums" },
            { key: "improverTokens", label: "改善 入力", render: r => num.format(r.improverTokens), className: "text-right tabular-nums" },
            { key: "improverOutput", label: "改善 出力", render: r => num.format(r.improverOutput), className: "text-right tabular-nums" },
            { key: "evalCalls", label: "解答 呼出", render: r => num.format(r.evalCalls), className: "text-right tabular-nums" },
            { key: "evalTokens", label: "解答 入力", render: r => num.format(r.evalTokens), className: "text-right tabular-nums" },
            { key: "judgeCalls", label: "採点 呼出", render: r => num.format(r.judgeCalls), className: "text-right tabular-nums" },
            { key: "cache", label: "キャッシュ", className: "text-right tabular-nums" },
            { key: "improverMin", label: "改善 分", className: "text-right tabular-nums" },
            { key: "evalMin", label: "評価 分", className: "text-right tabular-nums" },
            { key: "outcomes", label: "解答の終わり方", render: r => <Clip text={r.outcomes} width="max-w-xs" /> },
          ]} />
        </CardContent>
      </Card>
    </div>
  );
}

// One generation against the harness it was built on: by category, by question, and the improver's calls.
function RsiDetail({ gens, gen, onGen, stats }: { gens: Generation[]; gen?: number; onGen: (g: number) => void; stats: GenStats }) {
  const g = gens.find(x => x.gen === gen);
  const detail = usePoll<RsiGen>(g ? `/api/rsi/gen?n=${g.gen}` : null, 5000);
  const base = usePoll<RsiGen>(g && g.base !== null ? `/api/rsi/gen?n=${g.base}` : null, 60_000);
  if (!g) return <div className="text-muted-foreground">まだ世代がありません</div>;
  const cats = stats[g.gen]?.eval?.byCategory ?? {}, baseCats = g.base !== null ? stats[g.base]?.eval?.byCategory ?? {} : {};
  const baseById = new Map((base?.samples ?? []).map(s => [s.id, s]));
  const signed = (v: number | undefined, f: (v: number) => string) => v === undefined ? "-" : `${v > 0 ? "+" : ""}${f(v)}`;
  const samples = (detail?.samples ?? []).map(s => {
    const b = baseById.get(s.id);
    return { ...s, baseScore: b?.score, baseScoreText: b ? String(b.score) : "-", scoreDiff: b ? s.score - b.score : undefined, peakDiff: b ? s.peakTokens - b.peakTokens : undefined };
  });
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={String(g.gen)} onValueChange={v => onGen(Number(v))}>
          <SelectTrigger className="w-48" aria-label="世代"><SelectValue /></SelectTrigger>
          <SelectContent>{[...gens].reverse().map(x => <SelectItem key={x.gen} value={String(x.gen)}>世代 {x.gen}</SelectItem>)}</SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">{g.base === null ? "ベースライン" : `世代 ${g.base} と比較`}・{g.reason ?? g.error ?? "評価前"}</span>
      </div>
      {g.note && (
        <Card>
          <CardHeader><CardTitle>改善役のメモ</CardTitle><CardDescription>変更内容と予測（rsi-traces/note.md）</CardDescription></CardHeader>
          <CardContent><pre className="max-h-64 overflow-auto text-xs whitespace-pre-wrap">{g.note}</pre></CardContent>
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Card>
          <CardHeader><CardTitle>分類別の点数</CardTitle></CardHeader>
          <CardContent>
            <DataTable rows={Object.entries(cats).map(([c, v]) => ({ id: c, category: c, ...v, base: baseCats[c]?.avg }))} empty="まだ採点がありません" columns={[
              { key: "category", label: "分類" },
              { key: "avg", label: "点数", render: r => r.avg.toFixed(2), className: "text-right tabular-nums" },
              { key: "base", label: "比較元", render: r => r.base?.toFixed(2) ?? "-", className: "text-right tabular-nums" },
              { key: "diff", label: "差", render: r => signed(r.base === undefined ? undefined : r.avg - r.base, v => v.toFixed(2)), className: "text-right tabular-nums" },
              { key: "count", label: "問題数", className: "text-right tabular-nums" },
            ]} />
          </CardContent>
        </Card>
        <PerCallChart title="改善役の入力トークン" description="改善役のセッションの呼び出しごとの入力トークン（キャッシュ分を含む）"
          usage={(detail?.usage ?? []).map(u => ({ ...u, promptTokens: promptTokens(u) }))} agents={detail?.agents ?? []} field="promptTokens" />
      </div>
      <Card>
        <CardHeader><CardTitle>問題別</CardTitle><CardDescription>ピークは1問のセッションでの1回の呼び出しの最大入力トークン。差は比較元の世代との差</CardDescription></CardHeader>
        <CardContent>
          <DataTable rows={samples} empty="まだ採点がありません" columns={[
            { key: "id", label: "問題" }, { key: "category", label: "分類" },
            { key: "label", label: "判定", render: r => <Status value={r.label === "correct" ? "done" : r.label === "partial" ? "review" : "failed"} /> },
            { key: "score", label: "点数", className: "text-right tabular-nums" },
            { key: "baseScoreText", label: "比較元", className: "text-right tabular-nums" },
            { key: "scoreDiff", label: "差", render: r => signed(r.scoreDiff, v => String(v)), className: "text-right tabular-nums" },
            { key: "peakTokens", label: "ピーク", render: r => num.format(r.peakTokens), className: "text-right tabular-nums" },
            { key: "peakDiff", label: "ピーク差", render: r => signed(r.peakDiff, v => num.format(v)), className: "text-right tabular-nums" },
            { key: "meanTokens", label: "平均入力", render: r => num.format(r.meanTokens), className: "text-right tabular-nums" },
            { key: "calls", label: "呼出", className: "text-right tabular-nums" },
            { key: "ms", label: "秒", render: r => num.format(Math.round(r.ms / 1000)), className: "text-right tabular-nums" },
            { key: "outcome", label: "終わり方" },
          ]} />
        </CardContent>
      </Card>
    </div>
  );
}

function GenerationChart({ title, description, rows, field, format }: { title: string; description: string; rows: Generation[]; field: (g: Generation) => number | undefined; format: (v: number) => string }) {
  const config: ChartConfig = { candidate: { label: "候補", color: "var(--chart-1)" }, incumbent: { label: "採用済み", color: "var(--chart-2)" } };
  // The incumbent line steps only when a candidate is accepted, so its gap to the candidate shows what was rejected.
  let current: number | undefined;
  const data = rows.filter(g => g.eval?.ok).map(g => {
    const v = field(g);
    if (g.accepted) current = v;
    return { gen: g.gen, candidate: v, incumbent: current };
  });
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader>
      <CardContent>
        {data.length === 0 ? <div className="text-sm text-muted-foreground">評価を終えた世代がまだありません</div> : (
          <ChartContainer config={config} className="aspect-auto h-56 w-full">
            <LineChart data={data} margin={{ left: 8, right: 16, top: 8 }}>
              <CartesianGrid vertical={false} strokeOpacity={0.5} />
              <XAxis dataKey="gen" tickLine={false} axisLine={false} label={{ value: "世代", position: "insideBottomRight", offset: -4, fontSize: 11 }} />
              <YAxis tickLine={false} axisLine={false} width={64} tickFormatter={format} domain={["auto", "auto"]} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, p) => `世代 ${p[0]?.payload.gen}`} />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Line dataKey="candidate" type="linear" stroke="var(--color-candidate)" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
              <Line dataKey="incumbent" type="stepAfter" stroke="var(--color-incumbent)" strokeWidth={2} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

function Rsi({ sessions, onOpen }: { sessions: Session[]; onOpen: (id: string) => void }) {
  const info = usePoll<RsiInfo>("/api/rsi", 3000);
  const [form, setForm] = useState({ calls: "150", generations: "", perCategory: "3", seed: "1", delta: "0.05" });
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState("overview");
  const [detailGen, setDetailGen] = useState<number>();
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [info?.lines.length, tab]);
  const act = async (fn: () => Promise<unknown>) => { setError(undefined); try { await fn(); } catch (e) { setError(String((e as Error).message)); } };
  if (!info) return <div className="text-muted-foreground">RSI の状態を読み込み中…</div>;
  const gens = info.state?.generations ?? [];
  const inc = info.state?.incumbent, incGen = gens.find(g => g.gen === inc?.gen);
  const current = gens.at(-1);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const sessionOf = (g: Generation) => `${info.dir}/gen-${g.gen}`;
  const phase: Record<string, string> = { improve: "改善中", evaluate: "評価中", done: "完了" };
  const curEval = current && info.stats[current.gen]?.eval;
  const totals = Object.values(info.stats).reduce((t, s) => {
    t.improver += s.improver?.calls ?? 0; t.eval += s.eval?.calls ?? 0; t.judge += s.eval?.judgeCalls ?? 0;
    t.tokens += (s.improver ? promptTokens(s.improver) : 0) + (s.eval ? promptTokens(s.eval) : 0);
    return t;
  }, { improver: 0, eval: 0, judge: 0, tokens: 0, calls: 0 });
  totals.calls = totals.improver + totals.eval + totals.judge;

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
          <div className="grid gap-1.5">
            <CardTitle className="flex items-center gap-2">再帰的自己改善 <Badge variant={info.pid ? "secondary" : "outline"}>{info.pid ? `実行中（pid ${info.pid}）` : "停止中"}</Badge></CardTitle>
            <CardDescription>
              採用中のハーネスが自分のソースの worktree を改善し、LoCoMo-Plus のサブセットで点数と1問あたりのピーク入力トークンを測ります。採用された候補が次の世代を動かします。状態は {info.dir} にあります
            </CardDescription>
          </div>
          {info.pid ? (
            <Button variant="destructive" onClick={() => act(() => post("/api/rsi/stop", {}))}>停止する</Button>
          ) : (
            <form className="flex flex-wrap items-end gap-3" onSubmit={e => {
              e.preventDefault();
              // The sample set is fixed by the first start; a resume keeps it.
              const sample = gens.length ? {} : { perCategory: toInt(form.perCategory), seed: toInt(form.seed) };
              act(() => post("/api/rsi/start", { calls: toInt(form.calls), generations: toInt(form.generations), ...sample, delta: form.delta.trim() ? Number(form.delta) : undefined }));
            }}>
              <Field id="rsi-calls" label="改善の呼び出し上限" hint="1世代あたり"><Input id="rsi-calls" className="w-28" type="number" min={1} value={form.calls} onChange={set("calls")} /></Field>
              <Field id="rsi-gens" label="世代数" hint="空欄で止めるまで"><Input id="rsi-gens" className="w-24" type="number" min={1} value={form.generations} onChange={set("generations")} placeholder="無制限" /></Field>
              <Field id="rsi-per" label="分類ごとの問題数"><Input id="rsi-per" className="w-24" type="number" min={1} disabled={gens.length > 0} value={gens.length ? info.state!.settings.perCategory : form.perCategory} onChange={set("perCategory")} /></Field>
              <Field id="rsi-seed" label="種"><Input id="rsi-seed" className="w-20" type="number" disabled={gens.length > 0} value={gens.length ? info.state!.settings.seed : form.seed} onChange={set("seed")} /></Field>
              <Field id="rsi-delta" label="許容幅 δ"><Input id="rsi-delta" className="w-20" type="number" step="0.01" min={0} max={1} value={form.delta} onChange={set("delta")} /></Field>
              <Button type="submit">{gens.length ? "再開する" : "開始する"}</Button>
            </form>
          )}
        </CardHeader>
        {error && <CardContent><div className="text-sm text-destructive">{error}</div></CardContent>}
      </Card>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-8">
        <Kpi label="現在の世代" value={current ? `${current.gen}` : "-"} note={current ? `${phase[current.phase] ?? current.phase}・${time(current.startedAt)} 開始` : undefined} />
        <Kpi label="評価の進み" value={curEval ? `${curEval.judged} / ${curEval.expected}` : "-"} note={current ? `世代 ${current.gen} の採点済みの問題数` : undefined} />
        <Kpi label="採用中" value={inc ? `世代 ${inc.gen}` : "-"} note={inc?.commit.slice(0, 10)} />
        <Kpi label="採用中の点数" value={incGen?.eval?.score != null ? incGen.eval.score.toFixed(3) : "-"} note="0〜1（正解1・部分0.5）" />
        <Kpi label="採用中のピーク平均" value={incGen?.eval?.context ? num.format(incGen.eval.context.meanPeakTokens) : "-"} note="1問ごとの最大入力トークンの平均" />
        <Kpi label="採用 / 評価済み" value={`${gens.filter(g => g.gen > 0 && g.accepted).length} / ${gens.filter(g => g.gen > 0 && g.phase === "done").length}`} />
        <Kpi label="総モデル呼び出し" value={num.format(totals.calls)} note={`改善 ${num.format(totals.improver)}・解答 ${num.format(totals.eval)}・採点 ${num.format(totals.judge)}`} />
        <Kpi label="総入力トークン" value={num.format(totals.tokens)} note="改善と解答（キャッシュ分を含む）" />
      </div>
      {current?.error && <Card><CardContent className="text-sm text-destructive">世代 {current.gen} のエラー: {current.error}</CardContent></Card>}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="overview">概要</TabsTrigger>
          <TabsTrigger value="telemetry">テレメトリ</TabsTrigger>
          <TabsTrigger value="detail">世代の詳細</TabsTrigger>
          <TabsTrigger value="log">ログ</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="grid gap-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <GenerationChart title="点数" description="各世代の候補と、その時点で採用中のハーネスの点数" rows={gens} field={g => g.eval?.score} format={v => v.toFixed(2)} />
            <GenerationChart title="ピーク入力トークン" description="1問ごとの最大入力トークン（キャッシュ分を含む）の平均。低いほど良い" rows={gens} field={g => g.eval?.context?.meanPeakTokens} format={v => num.format(v)} />
          </div>
          <Card>
            <CardHeader><CardTitle>世代</CardTitle><CardDescription>行を選ぶと「世代の詳細」に移ります。メモは改善役が書いた変更内容と予測です</CardDescription></CardHeader>
            <CardContent>
              <DataTable rows={[...gens].reverse().map(g => ({ ...g, id: String(g.gen) }))} empty="まだ世代がありません"
                onSelect={r => { setDetailGen(r.gen); setTab("detail"); }} columns={[
                { key: "gen", label: "世代" }, { key: "base", label: "元", render: r => r.base ?? "-" },
                { key: "phase", label: "段階", render: r => <Status value={r.phase === "done" ? (r.gen === 0 ? "done" : r.accepted ? "accepted" : "rejected") : "running"} /> },
                { key: "score", label: "点数", render: r => r.eval?.score?.toFixed(3) ?? "-", className: "text-right tabular-nums" },
                { key: "peak", label: "ピーク平均", render: r => r.eval?.context ? num.format(r.eval.context.meanPeakTokens) : "-", className: "text-right tabular-nums" },
                { key: "max", label: "最大", render: r => r.eval?.context ? num.format(r.eval.context.maxTokens) : "-", className: "text-right tabular-nums" },
                { key: "reason", label: "判定・エラー", render: r => <Clip text={r.error ?? r.reason} width="max-w-xs" /> },
                { key: "note", label: "メモ", render: r => <Clip text={r.note} width="max-w-sm" /> },
                { key: "commit", label: "コミット", render: r => r.commit?.slice(0, 8) ?? "-" },
                { key: "open", label: "", render: r => sessions.some(s => s.id === sessionOf(r as Generation))
                  ? <Button size="sm" variant="outline" onClick={e => { e.stopPropagation(); onOpen(sessionOf(r as Generation)); }}>セッション</Button> : null },
              ]} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="telemetry"><RsiTelemetry gens={gens} stats={info.stats} /></TabsContent>
        <TabsContent value="detail">
          <RsiDetail gens={gens} gen={detailGen ?? current?.gen} onGen={setDetailGen} stats={info.stats} />
        </TabsContent>

        <TabsContent value="log">
          <Card>
            <CardHeader><CardTitle>ループのログ</CardTitle><CardDescription>{info.dir}/rsi.log の末尾。各世代の詳細は gen-N/run.log と gen-N/eval.log にあります</CardDescription></CardHeader>
            <CardContent className="grid gap-2">
              <pre ref={logRef} className="h-96 overflow-auto rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap">{info.lines.join("\n") || "(まだありません)"}</pre>
              {!info.pid && info.launcher.length > 0 && <pre className="max-h-40 overflow-auto rounded-md border p-3 text-xs whitespace-pre-wrap">{info.launcher.join("\n")}</pre>}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function App() {
  const list = usePoll<Session[]>("/api/sessions");
  const [session, setSession] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [rsi, setRsi] = useState(() => location.hash === "#rsi");
  // A just-started run may not have a state file yet; keep it selected, and move into a bench run's first session once it appears.
  useEffect(() => {
    if (!list?.length || (session && list.some(s => s.id === session))) return;
    const child = session && list.find(s => s.id.startsWith(`${session}/`));
    if (child) setSession(child.id);
    else if (!session) setSession([...list].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))[0]!.id);
  }, [list, session]);
  return (
    <div className="mx-auto grid max-w-[1600px] gap-6 p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">hypharness</h1>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
        <Button variant={creating ? "secondary" : "default"} onClick={() => setCreating(!creating)}>新規実行</Button>
        <Button variant={rsi ? "secondary" : "outline"} onClick={() => { setRsi(!rsi); history.replaceState(null, "", rsi ? "#agents" : "#rsi"); }}>自己改善</Button>
        {list && list.length > 0 && (
          <Select value={session} onValueChange={id => { setRsi(false); setSession(id); }}>
            <SelectTrigger className="w-full sm:w-[28rem]" aria-label="セッション"><SelectValue placeholder="セッション" /></SelectTrigger>
            <SelectContent>
              {list.map(s => <SelectItem key={s.id} value={s.id}>{s.id} · {s.mode} · {s.rootStatus} · {s.modelCalls} 回</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        </div>
      </header>
      {creating && <NewRun onClose={() => setCreating(false)} onStarted={dir => { setCreating(false); setSession(dir); }} />}
      {rsi ? <Rsi sessions={list ?? []} onOpen={id => { setRsi(false); setSession(id); }} /> : <>
        {list && list.length === 0 && !creating && !session && <div className="text-muted-foreground">セッションがありません。「新規実行」から目的を渡して始めてください。</div>}
        {session && <Dashboard session={session} />}
      </>}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
