package main

// bubblewrap で、システムを読み取り専用、/work だけを書き込み可にした隔離環境を作る。
// ネットワークを含む名前空間をすべて分け、環境変数を消すため、~/.hyph のトークンには届かない。
// bubblewrap はメモリを制限しないため、systemd の scope（cgroup）に入れて上限を超えたら止める。

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// ponytail: 合計の上限は 16GB の PC で OS とハーネスの分を残す値。PC のメモリに合わせて変える
const (
	slice       = "hyph.slice"
	totalMemory = "11G"
)

var sliceOnce = sync.OnceValue(func() error {
	out, err := exec.Command("systemctl", "--user", "set-property", "--runtime", slice,
		"MemoryMax="+totalMemory, "MemorySwapMax=0").CombinedOutput()
	if err != nil {
		return fmt.Errorf("隔離環境の合計のメモリの上限を付けられません: %v %s", err, out)
	}
	return nil
})

type box struct {
	work   string      // 書き込み可にして /work に置く
	ro     [][2]string // 読み取り専用で見せる [ホスト, 中]
	rw     [][2]string // 書き込み可で見せる（Unix ソケットなど）
	gpu    bool        // WSL の GPU（/dev/dxg と /usr/lib/wsl）を見せる
	memory string
	env    []string // KEY=VALUE
}

func (b box) command(ctx context.Context, argv ...string) (*exec.Cmd, error) {
	if err := sliceOnce(); err != nil {
		return nil, err
	}
	args := []string{"--user", "--scope", "--quiet", "--slice=" + slice,
		"-p", "MemoryMax=" + b.memory, "-p", "MemorySwapMax=0",
		"bwrap", "--unshare-all", "--die-with-parent", "--clearenv",
		"--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--bind", b.work, "/work", "--chdir", "/work"}
	for _, p := range []string{"/nix/store", "/run/current-system/sw", "/usr", "/bin", "/lib", "/lib64", "/etc/ssl"} {
		if _, err := os.Stat(p); err == nil {
			args = append(args, "--ro-bind", p, p)
		}
	}
	for _, m := range b.ro {
		args = append(args, "--ro-bind", m[0], m[1])
	}
	for _, m := range b.rw {
		args = append(args, "--bind", m[0], m[1])
	}
	env := []string{"HOME=/tmp", "TMPDIR=/tmp", "PATH=/run/current-system/sw/bin:/usr/bin:/bin"}
	// NixOS の nix-ld で、Python や PyTorch のように他の Linux 向けに作られたバイナリを動かす
	for _, k := range []string{"NIX_LD", "NIX_LD_LIBRARY_PATH"} {
		if v := os.Getenv(k); v != "" {
			env = append(env, k+"="+v)
		}
	}
	if b.gpu {
		args = append(args, "--dev-bind", "/dev/dxg", "/dev/dxg", "--ro-bind", "/usr/lib/wsl", "/usr/lib/wsl")
		env = append(env, "LD_LIBRARY_PATH=/usr/lib/wsl/lib")
	}
	for _, kv := range append(env, b.env...) {
		k, v, _ := strings.Cut(kv, "=")
		args = append(args, "--setenv", k, v)
	}
	args = append(append(args, "--"), argv...)
	return exec.CommandContext(ctx, "systemd-run", args...), nil
}

// venv の python は uv が置いた Python への、版の別名のディレクトリを経由したリンクなので、venv と uv の Python の置き場の両方を同じパスで見せる
func pythonBinds(venv string) ([][2]string, error) {
	real, err := filepath.EvalSymlinks(filepath.Join(venv, "bin", "python"))
	if err != nil {
		return nil, fmt.Errorf("Python の環境がありません。hyph setup を実行してください: %w", err)
	}
	home := filepath.Dir(filepath.Dir(filepath.Dir(real)))
	return [][2]string{{venv, venv}, {home, home}}, nil
}
