// ponytail: irisout 0.3.7 は相対 import の .ts/.tsx を自前で解析し、動的 import を scope limit として断る。
// このファイルは vite.config.ts の別名（hyph-monaco）で読み込み、irisout に解析させず Vite に任せる。
// SSR では page.tsx の onMount の中でしか使わないので、サーバー側の描画では monaco-editor を読まない
export async function mountMonaco(element, value, onChange) {
  const monaco = await import('monaco-editor')
  const editor = monaco.editor.create(element, {
    value,
    language: 'markdown',
    lineNumbers: 'on',
    wordWrap: 'on',
    minimap: { enabled: false },
    automaticLayout: true,
  })
  editor.onDidChangeModelContent(() => onChange(editor.getValue()))
  return editor
}
