// ponytail: irisout 0.3.7 は相対 import の .ts/.tsx を自前で解析し、動的 import を scope limit として断る（mikan-919/irisout#8）。
// このファイルは vite.config.ts の別名（hyph-monaco）で読み込み、irisout に解析させず Vite に任せる。
// SSR では page.tsx の onMount の中でしか使わないので、サーバー側の描画では monaco-editor を読まない
export async function mountMonaco(element, value, onChange) {
  // Monaco の Web Worker は Vite の ?worker で別に束ねる。指定しないと読み込みに失敗し、主スレッドで動く
  const [monaco, { default: EditorWorker }] = await Promise.all([
    import('monaco-editor'),
    import('monaco-editor/editor/editor.worker?worker'),
  ])
  self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
  const dark = matchMedia('(prefers-color-scheme: dark)')
  const editor = monaco.editor.create(element, {
    value,
    language: 'markdown',
    theme: dark.matches ? 'vs-dark' : 'vs',
    lineNumbers: 'on',
    wordWrap: 'on',
    minimap: { enabled: false },
    fontSize: 13,
    lineHeight: 21,
    padding: { top: 10, bottom: 10 },
    scrollBeyondLastLine: false,
    renderLineHighlight: 'none',
    automaticLayout: true,
  })
  dark.addEventListener('change', (event) => monaco.editor.setTheme(event.matches ? 'vs-dark' : 'vs'))
  editor.onDidChangeModelContent(() => onChange(editor.getValue()))
  return editor
}
