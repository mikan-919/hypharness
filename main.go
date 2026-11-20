package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
)

const usage = `使い方（リポジトリの直下で実行する）:
  hyph login            ChatGPT でサインインする
  hyph setup            Python の環境と学習データを ~/.hyph に用意する
  hyph baseline [回数]  基準の train.py を学習させて val bpb のばらつきを測る（既定3回）
  hyph lab [体数]       研究エージェントを動かす（既定10体）。Ctrl-C で止める`

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func number(args []string, fallback int) (int, error) {
	if len(args) < 3 {
		return fallback, nil
	}
	n, err := strconv.Atoi(args[2])
	if err != nil || n < 1 {
		return 0, fmt.Errorf("1以上の数を指定してください: %s", args[2])
	}
	return n, nil
}

func setup(home, research string) error {
	venv := filepath.Join(home, "venv")
	steps := [][]string{
		{"uv", "venv", "--allow-existing", "--python", "3.12", venv},
		{"uv", "pip", "install", "--python", filepath.Join(venv, "bin", "python"),
			"--index", "https://download.pytorch.org/whl/cu128", "--index-strategy", "unsafe-best-match",
			"torch", "numpy", "pyarrow"},
	}
	if _, err := os.Stat(filepath.Join(home, "data", "train.bin")); err != nil {
		steps = append(steps, []string{filepath.Join(venv, "bin", "python"), filepath.Join(research, "prepare.py"), filepath.Join(home, "data")})
	}
	for _, s := range steps {
		cmd := exec.Command(s[0], s[1:]...)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		// uv の Python は NixOS の証明書の場所を知らない
		if os.Getenv("SSL_CERT_FILE") == "" {
			cmd.Env = append(os.Environ(), "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt")
		}
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("%v: %w", s, err)
		}
	}
	return nil
}

func cli(args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("%s", usage)
	}
	userHome, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	home := filepath.Join(userHome, ".hyph")
	research, err := filepath.Abs("research")
	if err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(research, "prepare.py")); err != nil {
		return fmt.Errorf("リポジトリの直下で実行してください: %w", err)
	}
	if err := os.MkdirAll(filepath.Join(home, "lab", "runs"), 0o755); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	l := &lab{
		dir:       filepath.Join(home, "lab"),
		research:  research,
		data:      filepath.Join(home, "data"),
		venv:      filepath.Join(home, "venv"),
		ai:        &openAI{path: filepath.Join(home, "auth.json")},
		model:     env("MODEL", "gpt-6-luna"),
		reasoning: env("REASONING", "medium"),
	}
	switch args[1] {
	case "login":
		return l.ai.login()
	case "setup":
		return setup(home, research)
	case "baseline":
		k, err := number(args, 3)
		if err != nil {
			return err
		}
		if k < 2 {
			return fmt.Errorf("ばらつきを測るには2回以上が必要です")
		}
		return l.baseline(ctx, k)
	case "lab":
		n, err := number(args, 10)
		if err != nil {
			return err
		}
		return l.start(ctx, n)
	}
	return fmt.Errorf("%s", usage)
}

func main() {
	if err := cli(os.Args); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
