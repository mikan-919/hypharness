import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
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
  done: "default", verified: "default", active: "default", claimed: "secondary", review: "secondary", running: "secondary",
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

function Dashboard({ session }: { session: string }) {
  const o = usePoll<Overview>(`/api/overview?s=${encodeURIComponent(session)}`);
  const [agentId, setAgentId] = useState<string>();
  const [taskStatus, setTaskStatus] = useState("all");
  const [tab, setTab] = useState(() => location.hash.slice(1) || "agents");
  useEffect(() => { history.replaceState(null, "", `#${tab}`); }, [tab]);
  useEffect(() => setAgentId(undefined), [session]);
  if (!o) return <div className="text-muted-foreground">読み込み中…</div>;
  const t = o.totals, root = o.goals.find(g => g.id === "G0");
  const work = o.tasks.filter(x => x.kind === "work");
  const agent = o.agents.find(a => a.id === agentId);
  const tasks = taskStatus === "all" ? o.tasks : o.tasks.filter(x => x.status === taskStatus);

  return (
    <div className="grid gap-6">
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
        <Kpi label="モデル呼び出し" value={num.format(o.modelCalls)} note={`上限 ${num.format(o.config.maxModelCalls ?? 0)}`} />
        <Kpi label="入力トークン" value={num.format(promptTokens(t))} note={`キャッシュ外 ${num.format(t.input)}`} />
        <Kpi label="出力トークン" value={num.format(t.output)} />
        <Kpi label="キャッシュ読み取り" value={pct(t.cacheRead, promptTokens(t))} note={`${num.format(t.cacheRead)} トークン`} />
        <Kpi label="最大入力文字数" value={num.format(t.maxPromptChars)} />
        <Kpi label="モデル待ち時間" value={`${num.format(Math.round(t.ms / 1000))} 秒`} />
        <Kpi label="エージェント" value={`${o.agents.filter(a => a.status === "active").length} / ${o.agents.length}`} note="稼働 / 全体" />
        <Kpi label="作業タスク" value={`${work.filter(x => x.status === "done").length} / ${work.length}`} note="検証済み / 全体" />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="agents">エージェント</TabsTrigger>
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
                { key: "maxPromptChars", label: "最大入力", render: r => num.format(r.maxPromptChars), className: "text-right tabular-nums" },
                { key: "memoryVersion", label: "記憶", render: r => `v${r.memoryVersion} · ${num.format(r.memoryChars)}字` },
                { key: "lastAt", label: "最終呼び出し", render: r => time(r.lastAt) },
              ]} />
            </CardContent>
          </Card>
          {agent && <AgentPanel session={session} agent={agent} />}
        </TabsContent>

        <TabsContent value="telemetry" className="grid gap-4">
          <div className="grid gap-4 xl:grid-cols-2">
            <PerCallChart title="1回の入力の文字数" description="システムプロンプトと文脈の合計。長期実行で増え続けないことを確認します" usage={o.usage} agents={o.agents} field="promptChars" />
            <PerCallChart title="入力トークン" description="プロバイダーが報告した呼び出しごとの入力トークン数（キャッシュ分を含む）" usage={o.usage.map(u => ({ ...u, promptTokens: promptTokens(u) }))} agents={o.agents} field="promptTokens" />
          </div>
          <Card>
            <CardHeader><CardTitle>呼び出しの記録</CardTitle><CardDescription>新しい順に最大 200 件</CardDescription></CardHeader>
            <CardContent>
              <DataTable rows={o.usage.slice(-200).reverse()} columns={[
                { key: "at", label: "時刻", render: r => time(r.at) }, { key: "agent", label: "エージェント" }, { key: "task", label: "タスク" },
                { key: "input", label: "入力（キャッシュ外）", render: r => num.format(r.input), className: "text-right tabular-nums" },
                { key: "cacheRead", label: "キャッシュ読取", render: r => num.format(r.cacheRead), className: "text-right tabular-nums" },
                { key: "cacheWrite", label: "キャッシュ書込", render: r => num.format(r.cacheWrite), className: "text-right tabular-nums" },
                { key: "output", label: "出力", render: r => num.format(r.output), className: "text-right tabular-nums" },
                { key: "promptChars", label: "入力文字数", render: r => num.format(r.promptChars), className: "text-right tabular-nums" },
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

function App() {
  const list = usePoll<Session[]>("/api/sessions", 10_000);
  const [session, setSession] = useState<string>();
  useEffect(() => {
    if (list?.length && !list.some(s => s.id === session)) setSession([...list].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))[0]!.id);
  }, [list, session]);
  return (
    <div className="mx-auto grid max-w-[1600px] gap-6 p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">hypharness</h1>
        {list && list.length > 0 && (
          <Select value={session} onValueChange={setSession}>
            <SelectTrigger className="w-full sm:w-[28rem]" aria-label="セッション"><SelectValue placeholder="セッション" /></SelectTrigger>
            <SelectContent>
              {list.map(s => <SelectItem key={s.id} value={s.id}>{s.id} · {s.mode} · {s.rootStatus} · {s.modelCalls} 回</SelectItem>)}
            </SelectContent>
          </Select>
        )}
      </header>
      {list && list.length === 0 && <div className="text-muted-foreground">状態ファイル（state.sqlite）が見つかりません。ハーネスを一度実行してください。</div>}
      {session && <Dashboard session={session} />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
