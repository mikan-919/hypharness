// bubblewrap の隔離環境でコマンドを動かす（ADR 0021）。システムは読み取り専用、ホームディレクトリは空、
// dir だけを書き込み可にし、環境変数を消す。ネットワークはホストと共有する（ADR 0030）
// ponytail: メモリの上限（旧実装の systemd-run --user の scope）はまだかけていない。重い検査を動かすようになったら足す
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const MAX_OUTPUT = 8_000

// dir が git worktree なら、元のリポジトリの .git を読み取り専用で見せる。履歴は読めるが、コミットはできない
function gitBinds(dir: string) {
  try {
    const gitdir = readFileSync(join(dir, '.git'), 'utf8').match(/^gitdir: (.+)$/m)?.[1].trim()
    if (!gitdir) return []
    const worktree = resolve(dir, gitdir)
    const common = resolve(worktree, readFileSync(join(worktree, 'commondir'), 'utf8').trim())
    return ['--ro-bind', common, common]
  } catch {
    return []
  }
}

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
      ...gitBinds(dir),
      '--unshare-all',
      '--share-net',
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
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  clearTimeout(timer)
  const output = stdout + stderr
  return {
    code,
    output: output.length > MAX_OUTPUT ? `…${output.slice(-MAX_OUTPUT)}` : output,
    // 呼び出し元が完全な検査記録を必要とする場合に使う。output の表示上限は維持する
    stdout,
    stderr,
  }
}
