export const css = `
:root {
  --bg: #f4f3ef;
  --panel: #ffffff;
  --sunken: #f7f6f3;
  --ink: #1d1d1f;
  --muted: #6b6b70;
  --line: #e4e2dd;
  --accent: #3b5bdb;
  --fail: #c92a2a;
  --done: #2b8a3e;
  --wait: #d9480f;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111113;
    --panel: #1b1b1e;
    --sunken: #161618;
    --ink: #ececef;
    --muted: #9a9aa2;
    --line: #2c2c31;
    --accent: #7c93f0;
    --fail: #ff8787;
    --done: #69db7c;
    --wait: #ffa94d;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 14px/1.6 system-ui, "Noto Sans JP", sans-serif;
}
h1 { font-size: 16px; margin: 0; }
h2 { font-size: 12px; font-weight: 600; color: var(--muted); letter-spacing: 0.06em; margin: 20px 0 6px; }
p { margin: 0; }
.hint { font-size: 12px; color: var(--muted); }

.shell {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr) 380px;
  gap: 12px;
  height: 100vh;
  padding: 12px;
}
.threads, .conversation, .context {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  min-height: 0;
}
.threads, .conversation { overflow-y: auto; padding: 16px; }
.conversation { display: flex; flex-direction: column; gap: 12px; }
.context { display: flex; flex-direction: column; overflow: hidden; }

button {
  font: inherit;
  font-size: 13px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--ink);
  border-radius: 8px;
  padding: 6px 12px;
  cursor: pointer;
}
button:hover:not(:disabled) { border-color: var(--accent); }
button:disabled { opacity: 0.45; cursor: default; }
button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }

.badge {
  display: inline-block;
  font-size: 11px;
  line-height: 1;
  padding: 4px 7px;
  border-radius: 999px;
  white-space: nowrap;
  color: var(--muted);
  background: var(--sunken);
  border: 1px solid var(--line);
}
.badge.wait { color: var(--wait); border-color: color-mix(in srgb, var(--wait) 40%, transparent); background: color-mix(in srgb, var(--wait) 10%, var(--panel)); }
.badge.done, .badge.committed { color: var(--done); border-color: color-mix(in srgb, var(--done) 40%, transparent); background: color-mix(in srgb, var(--done) 10%, var(--panel)); }
.badge.fail, .badge.held { color: var(--fail); border-color: color-mix(in srgb, var(--fail) 40%, transparent); background: color-mix(in srgb, var(--fail) 10%, var(--panel)); }
.badge.fact, .badge.solving, .badge.checking { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); background: color-mix(in srgb, var(--accent) 10%, var(--panel)); }

/* 左列 */
.brand { font-weight: 700; font-size: 15px; margin-bottom: 14px; }
.stages { list-style: none; margin: 0; padding: 0; position: relative; }
.stages::before { content: ""; position: absolute; left: 11px; top: 12px; bottom: 12px; width: 2px; background: var(--line); }
.stage {
  position: relative;
  display: grid;
  grid-template-columns: 24px 1fr;
  column-gap: 10px;
  padding: 5px 0;
  font-size: 13px;
  color: var(--muted);
}
.stage .number {
  width: 24px; height: 24px;
  border-radius: 50%;
  display: grid; place-items: center;
  font-size: 11px;
  background: var(--panel);
  border: 2px solid var(--line);
  z-index: 1;
}
.stage .name { align-self: center; }
.stage .note { grid-column: 2; font-size: 11px; line-height: 1.4; }
.stage.past { color: var(--ink); }
.stage.past .number { border-color: var(--done); color: var(--done); }
.stage.current { color: var(--ink); font-weight: 700; }
.stage.current .number { background: var(--accent); border-color: var(--accent); color: #fff; }
.stage.current .note { color: var(--accent); font-weight: 400; }
.stage.halted { color: var(--fail); font-weight: 700; }
.stage.halted .number { border-color: var(--fail); }
.stage.halted .note { color: var(--fail); font-weight: 400; }
.start { display: grid; gap: 6px; margin-top: 16px; }
.start .stop { color: var(--fail); border-color: var(--fail); }
.thread {
  display: grid;
  grid-template-columns: 10px 1fr auto;
  column-gap: 8px;
  align-items: center;
  padding: 6px 0;
  font-size: 13px;
}
.thread .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--line); }
.thread.researching .dot { background: var(--accent); animation: pulse 1.2s infinite; }
.thread.asking .dot { background: var(--wait); }
.thread.ready .dot { background: var(--done); }
.thread.blocked .dot { background: var(--fail); }
.thread .state { font-size: 12px; color: var(--muted); }
.thread .tokens { grid-column: 2 / 4; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
@keyframes pulse { 50% { opacity: 0.4; } }

/* 中央 */
.banner {
  border: 1px solid var(--line);
  border-left-width: 4px;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
  background: var(--sunken);
}
.banner.fail { border-left-color: var(--fail); }
.banner.done { border-left-color: var(--done); }
.banner summary { cursor: pointer; }
.banner summary::marker { color: var(--muted); }
.banner p { margin-top: 6px; color: var(--muted); white-space: pre-wrap; max-height: 30vh; overflow-y: auto; }
p.banner { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; color: var(--fail); }
.goal { display: flex; flex-direction: column; gap: 8px; flex: 1 1 auto; min-height: 0; }
.goal-head { display: flex; align-items: center; gap: 10px; }
/* 質問が待っているときは、エディタを縮めて質問を同じ画面に収める */
.conversation:has(.question) .goal { flex: none; }
.conversation:has(.question) .goal .editor { flex: none; height: 42vh; min-height: 240px; }
.goal-head button { margin-left: auto; }
.goal .editor {
  flex: 1 1 auto;
  min-height: 360px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 8px;
}
.question {
  border: 1px solid color-mix(in srgb, var(--wait) 45%, var(--line));
  border-radius: 10px;
  padding: 14px 16px;
  background: color-mix(in srgb, var(--wait) 5%, var(--panel));
}
.question-head { display: flex; gap: 8px; align-items: center; }
.question h2 { font-size: 15px; font-weight: 600; color: var(--ink); letter-spacing: 0; margin: 8px 0 10px; }
.options { list-style: none; padding: 0; margin: 0 0 10px; display: grid; gap: 6px; }
.option { width: 100%; text-align: left; display: grid; gap: 2px; padding: 8px 12px; background: var(--panel); }
.option span { color: var(--muted); font-size: 13px; }
.option.recommended { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); }
.option.picked { border-color: var(--wait); box-shadow: inset 0 0 0 1px var(--wait); background: color-mix(in srgb, var(--wait) 12%, var(--panel)); }
.recommendation { color: var(--muted); font-size: 13px; margin-bottom: 10px; }
.reply { display: grid; gap: 8px; }
.reply textarea {
  font: inherit; min-height: 64px; padding: 8px;
  border: 1px solid var(--line); border-radius: 8px;
  background: var(--panel); color: var(--ink);
  resize: vertical;
}
.reply-foot { display: flex; gap: 12px; align-items: center; justify-content: space-between; }

/* 右列 */
.totals {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  flex: none;
  padding: 12px;
  border-bottom: 1px solid var(--line);
}
.totals > div { display: grid; background: var(--sunken); border-radius: 8px; padding: 6px 10px; }
.totals .value { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
.tabs {
  display: flex;
  gap: 2px;
  flex: none;
  padding: 8px 12px 0;
  border-bottom: 1px solid var(--line);
}
.tabs .tab {
  flex: 1 1 0;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 6px 2px 8px;
  font-size: 12px;
  border: none;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  background: none;
  color: var(--muted);
}
.tabs .tab.current { color: var(--ink); font-weight: 600; border-bottom-color: var(--accent); }
.tab-body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px; }

.activity { border-left: 2px solid var(--line); padding: 4px 0 4px 10px; margin-bottom: 6px; font-size: 12px; }
.activity-head { display: flex; justify-content: space-between; gap: 8px; }
.activity p {
  color: var(--muted);
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.activity.live { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 6%, var(--panel)); }
.activity.live p { color: var(--ink); -webkit-line-clamp: 8; }
.activity.fail { border-color: var(--fail); }
.activity.commit, .activity.check { border-color: var(--done); }

.task, .edit { border: 1px solid var(--line); border-left-width: 3px; border-radius: 8px; margin-bottom: 6px; font-size: 13px; }
.task summary, .edit summary {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  padding: 6px 10px;
  cursor: pointer;
  list-style: none;
}
.edit summary { grid-template-columns: auto auto minmax(0, 1fr); }
.task summary::-webkit-details-marker, .edit summary::-webkit-details-marker { display: none; }
.task > :not(summary), .edit > :not(summary) { margin: 0 10px 8px; }
.task-id { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 12px; }
.task-title, .edit-reason { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task[open] .task-title, .edit[open] .edit-reason { white-space: normal; }
.task.solving, .task.checking { border-left-color: var(--accent); }
.task.committed { border-left-color: var(--done); }
.task.held { border-left-color: var(--fail); }
.reason { color: var(--fail); font-size: 12px; }
.edit.user { border-left-color: var(--wait); }
.edit.agent { border-left-color: var(--accent); }
.edit button { font-size: 12px; padding: 2px 8px; }
.diff {
  font: 12px/1.5 ui-monospace, monospace;
  font-variant-ligatures: none;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--muted);
  background: var(--sunken);
  border-radius: 6px;
  padding: 6px 8px;
}

.entry { border-left: 3px solid var(--line); padding: 4px 0 4px 10px; margin-bottom: 10px; font-size: 13px; }
.entry p { margin: 4px 0 2px; }
.entry small { color: var(--muted); font-size: 11px; }
.entry.fail { border-color: var(--fail); }
.entry.done { border-color: var(--done); }
.entry.fact { border-color: var(--accent); }

.evolution-head { font-weight: 600; margin-bottom: 8px; }
.candidate { font-size: 13px; font-weight: 600; margin-top: 12px; padding-top: 8px; border-top: 1px solid var(--line); }
.candidate.adopted { color: var(--done); }
.candidate.rejected { color: var(--muted); }
.change { font-size: 12px; padding-left: 12px; position: relative; margin-top: 4px; }
.change::before { content: "・"; position: absolute; left: 0; color: var(--muted); }
.note { font-size: 12px; color: var(--muted); white-space: pre-wrap; margin-top: 4px; max-height: 8em; overflow: hidden; }
.check-output { border: 1px solid var(--line); border-radius: 6px; margin: 4px 0 8px; font-size: 12px; }
.check-output summary { cursor: pointer; padding: 5px 8px; color: var(--muted); }
.check-output > div { padding: 0 8px 4px; }
.check-output strong { color: var(--muted); font-size: 11px; }
.check-output pre {
  font: 12px/1.5 ui-monospace, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--muted);
  background: var(--sunken);
  border-radius: 6px;
  padding: 6px 8px;
  margin: 4px 0 8px;
}

.evolution-round-picker { display: flex; align-items: center; gap: 8px; margin: 8px 0; font-size: 12px; }
.evolution-round-picker select { font: inherit; color: var(--ink); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; }
.evolution-row { font-size: 12px; }
.evolution-row:not(.candidate) .evolution-candidate, .evolution-row:not(.change) .evolution-change, .evolution-row:not(.memo) .note-detail, .evolution-row:not(.diff) .diff-detail, .evolution-row:not(.check) .check-detail { display: none; }
.evolution-row.candidate { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--line); }
.evolution-candidate { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3px 8px; overflow-wrap: anywhere; }
.evolution-candidate strong:first-child { font-size: 13px; }
.evolution-candidate.adopted { color: var(--done); }
.evolution-change { font: 12px/1.5 ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; margin: 4px 0 8px; padding-left: 8px; color: var(--muted); }
.evolution-detail { border: 1px solid var(--line); border-radius: 6px; margin: 4px 0 8px; }
.evolution-detail summary { cursor: pointer; padding: 5px 8px; color: var(--muted); }
.evolution-detail > :not(summary) { margin: 4px 8px 8px; }
.evolution-detail > strong { display: block; color: var(--muted); font-size: 11px; }
.evolution-detail pre { font: 12px/1.5 ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--muted); background: var(--sunken); border-radius: 6px; padding: 6px 8px; }

@media (max-width: 900px) {
  .shell { grid-template-columns: 1fr; height: auto; }
  .context { max-height: 80vh; }
  .goal .editor { height: 60vh; }
}

.metrics { max-width: 1200px; margin: 0 auto; padding: 16px; }
.metrics-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.metrics-head .brand { color: var(--ink); text-decoration: none; margin: 0; }
.brand a { font-weight: 400; margin-left: 8px; }
.metric-cards { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); padding: 0 0 4px; border: none; }
.table-wrap { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; }
.metric-table { border-collapse: collapse; width: 100%; font-size: 12px; font-variant-numeric: tabular-nums; }
.metric-table th, .metric-table td { padding: 6px 10px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
.metric-table th { color: var(--muted); font-weight: 600; background: var(--sunken); }
.metric-table th:first-child, .metric-table td:first-child { text-align: left; }
.metric-table .statement { max-width: 360px; overflow: hidden; text-overflow: ellipsis; }
.metric-table .prompt { display: inline-flex; align-items: center; gap: 6px; }
.metric-table meter { width: 80px; }
`
