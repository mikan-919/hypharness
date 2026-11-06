export const css = `
:root {
  --bg: #f6f5f2;
  --panel: #ffffff;
  --ink: #1d1d1f;
  --muted: #6b6b70;
  --line: #e4e2dd;
  --accent: #3b5bdb;
  --fail: #c92a2a;
  --done: #2b8a3e;
  --wait: #e8590c;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141416;
    --panel: #1d1d20;
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
h1 { font-size: 18px; margin: 0 0 12px; }
h2 { font-size: 12px; color: var(--muted); letter-spacing: 0.08em; margin: 16px 0 8px; }
.shell {
  display: grid;
  grid-template-columns: 240px 1fr 300px;
  gap: 12px;
  height: 100vh;
  padding: 12px;
}
.threads, .conversation, .context {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 12px;
  overflow-y: auto;
}
.thread {
  display: grid;
  grid-template-columns: 32px 1fr auto;
  grid-template-rows: auto auto;
  column-gap: 8px;
  align-items: center;
  padding: 8px;
  border-radius: 8px;
}
.thread .avatar {
  grid-row: span 2;
  width: 32px; height: 32px;
  border-radius: 50%;
  display: grid; place-items: center;
  background: var(--line);
  border: 2px solid var(--line);
}
.thread.researching .avatar { border-color: var(--accent); animation: pulse 1.2s infinite; }
.thread.asking .avatar { border-color: var(--wait); }
.thread.ready .avatar { border-color: var(--done); }
.thread.blocked .avatar { border-color: var(--fail); }
@keyframes pulse { 50% { opacity: 0.5; } }
.thread .state { font-size: 12px; color: var(--muted); grid-column: 2; }
.thread .tokens { grid-row: span 2; font-variant-numeric: tabular-nums; color: var(--muted); }
.start { border-top: 1px solid var(--line); margin-top: 12px; padding-top: 8px; }
.hint { font-size: 12px; color: var(--muted); }
button {
  font: inherit;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--ink);
  border-radius: 8px;
  padding: 6px 12px;
  cursor: pointer;
}
button:disabled { opacity: 0.5; cursor: default; }
.start button, .reply button { background: var(--accent); color: #fff; border-color: var(--accent); }
.queue { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
.chip.head { border-color: var(--wait); color: var(--wait); }
.chip.answered { opacity: 0.6; }
.question.head { border-left: 3px solid var(--wait); padding-left: 12px; }
.options { list-style: none; padding: 0; display: grid; gap: 8px; }
.option { width: 100%; text-align: left; display: grid; padding: 8px 12px; }
.option:hover:not(:disabled) { border-color: var(--accent); }
.option.recommended { border-color: var(--accent); }
.option.picked { border-color: var(--wait); box-shadow: inset 0 0 0 1px var(--wait); background: color-mix(in srgb, var(--wait) 12%, var(--panel)); }
.question { margin-bottom: 16px; }
.options span, .recommendation { color: var(--muted); }
.answer { background: var(--bg); border-radius: 8px; padding: 8px 12px; }
.reply { display: grid; gap: 8px; }
.reply textarea {
  font: inherit; min-height: 80px; padding: 8px;
  border: 1px solid var(--line); border-radius: 8px;
  background: var(--bg); color: var(--ink);
}
.metrics .big { font-size: 28px; font-variant-numeric: tabular-nums; margin: 0; }
.metrics p { margin: 0; }
.entry { border-left: 3px solid var(--line); padding: 4px 8px; margin-bottom: 8px; }
.entry p { margin: 2px 0; }
.entry small { color: var(--muted); }
.entry .kind { font-size: 12px; color: var(--muted); }
.entry.fail { border-color: var(--fail); }
.entry.done { border-color: var(--done); }
.entry.fact { border-color: var(--accent); }
.goal-head { display: flex; align-items: baseline; gap: 12px; }
.goal { display: grid; gap: 8px; margin-bottom: 16px; }
.goal textarea {
  font: 14px/1.7 ui-monospace, "Noto Sans Mono CJK JP", monospace;
  min-height: 55vh; padding: 12px; resize: vertical;
  border: 1px solid var(--line); border-radius: 8px;
  background: var(--bg); color: var(--ink);
}
.goal button[type=submit] { justify-self: end; background: var(--accent); color: #fff; border-color: var(--accent); }
.conflict { display: flex; gap: 8px; align-items: center; color: var(--wait); margin: 0; }
.question h2 { font-size: 15px; color: var(--ink); letter-spacing: 0; margin: 0 0 8px; }
.edit { border-left: 3px solid var(--line); padding: 4px 8px; margin-bottom: 8px; }
.edit.user { border-color: var(--wait); }
.edit.agent { border-color: var(--accent); }
.edit p { margin: 2px 0; }
.edit-head { display: flex; gap: 8px; align-items: center; }
.edit-head button { margin-left: auto; padding: 2px 8px; font-size: 12px; }
.diff { margin: 4px 0 0; font: 12px/1.5 ui-monospace, monospace; white-space: pre-wrap; color: var(--muted); max-height: 160px; overflow: auto; }
@media (max-width: 900px) {
  .shell { grid-template-columns: 1fr; height: auto; }
}
`
