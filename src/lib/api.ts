// JSON を送り、失敗時はサーバーが返した error を例外にする
export async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const json = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(json.error ?? `${response.status}`)
  return json
}
