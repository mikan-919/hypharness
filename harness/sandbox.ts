// bubblewrap の隔離環境でコマンドを動かす（ADR 0021）。システムは読み取り専用、ホームディレクトリは空、
// dir だけを書き込み可にし、ネットワークを切り、環境変数を消す
// ponytail: メモリの上限（旧実装の systemd-run --user の scope）はまだかけていない。重い検査を動かすようになったら足す

const MAX_OUTPUT = 8_000

export async function sandboxed(dir: string, command: string, timeoutMs = 300_000) {
  const proc = Bun.spawn(
    [
      'bwrap',
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--proc', '/proc',
      '--tmpfs', '/tmp',
      '--tmpfs', '/home',
      '--bind', dir, dir,
      '--unshare-all',
      '--die-with-parent',
      '--clearenv',
      '--setenv', 'PATH', process.env.PATH ?? '/run/current-system/sw/bin',
      '--setenv', 'HOME', '/tmp',
      '--chdir', dir,
      'sh', '-c', command,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  clearTimeout(timer)
  const output = out + err
  return { code, output: output.length > MAX_OUTPUT ? `…${output.slice(-MAX_OUTPUT)}` : output }
}
