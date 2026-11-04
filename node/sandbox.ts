import { existsSync } from 'node:fs'

// bubblewrap で、システムを読み取り専用、作業用ディレクトリだけを書き込み可にした隔離環境を作る。
// ネットワークを含む名前空間をすべて分け、環境変数を消すため、~/.hyph のトークンや手元のサービスには届かない。
// binds で、ホストのパスを隔離環境の中に見せる。既定は読み取り専用で、Unix ソケットのように書き込みが要るものだけ rw にする
export type Bind = [host: string, inside: string, mode?: 'ro' | 'rw']

// ponytail: 隔離環境1つのメモリの上限。生成役の書いたプログラムが無限にメモリを取り、ノードの PC ごと落ちたことがある。
// 同時に動く試行（最大8）がすべて上限まで使うことは想定しない。大きなビルドが要るリポジトリでは見直す
const MEMORY_MAX = '4G'

// prelude は、コマンドの前に読み込むシェルの設定（nix print-dev-env の出力など）。読み込んだあとも、一時ディレクトリと
// bun の場所は隔離環境のものに戻す
export function sandbox(
  work: string,
  command: string,
  binds: Bind[] = [],
  prelude?: string,
) {
  const bwrap = Bun.which('bwrap')
  if (!bwrap) throw new Error('タスクの実行には bubblewrap（bwrap）が必要です')
  // bubblewrap はメモリを制限しないため、systemd の scope（cgroup）に入れて上限を超えたら止める
  const systemdRun = Bun.which('systemd-run')
  if (!systemdRun) {
    throw new Error(
      'タスクの実行には systemd-run（ユーザーの systemd）が必要です',
    )
  }
  const system = [
    '/nix/store',
    '/run/current-system/sw',
    '/usr',
    '/bin',
    '/lib',
    '/lib64',
  ]
    .filter(existsSync)
    .flatMap((path) => ['--ro-bind', path, path])
  return [
    systemdRun,
    '--user',
    '--scope',
    '--quiet',
    '-p',
    `MemoryMax=${MEMORY_MAX}`,
    '-p',
    'MemorySwapMax=0',
    bwrap,
    '--unshare-all',
    '--die-with-parent',
    '--clearenv',
    ...system,
    // 実行中の bun を、隔離環境の中では bun という名前で使えるようにする
    '--ro-bind',
    process.execPath,
    '/opt/bin/bun',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--bind',
    work,
    '/work',
    ...(prelude ? ['--ro-bind', prelude, '/prelude.sh'] : []),
    ...binds.flatMap(([host, inside, mode]) => [
      mode === 'rw' ? '--bind' : '--ro-bind',
      host,
      inside,
    ]),
    '--chdir',
    '/work',
    '--setenv',
    'PATH',
    '/opt/bin:/run/current-system/sw/bin:/usr/bin:/bin',
    '--setenv',
    'HOME',
    '/tmp',
    '--',
    'sh',
    '-c',
    prelude
      ? `. /prelude.sh\nexport HOME=/tmp TMPDIR=/tmp TMP=/tmp TEMP=/tmp PATH="/opt/bin:$PATH"\n${command}`
      : command,
  ]
}
