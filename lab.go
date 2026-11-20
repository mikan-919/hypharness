package main

// 研究室。研究エージェントに Unix ソケットで model・train・runs を提供し、GPU の待ち行列と実験の記録を持つ。
//
// ~/.hyph/lab/
//   best/train.py   今の最良の学習スクリプト。全エージェントに読み取り専用で見せる
//   best.json       最良の val bpb と、それを出した実験の番号
//   noise.json      基準を繰り返し学習した val bpb の平均と標準偏差
//   runs.jsonl      実験ノート。1行が1回の学習
//   runs/<番号>/    学習したスクリプトと出力
//   agents/<番号>/  エージェントごとの作業用ディレクトリ、ソケット、ログ

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// 暴走を止めるための打ち切りの時間。予算は prepare.TOKEN_BUDGET（バイト数）で決め、時間は GPU の混み具合で変わる。
// 基準は混んでいなければ約4分で終わる
const trainTimeout = 12 * time.Minute

type run struct {
	ID         int      `json:"id"`
	Agent      int      `json:"agent"` // 基準の計測は -1
	Hypothesis string   `json:"hypothesis"`
	BPB        *float64 `json:"val_bpb"`           // 失敗したら null
	Best       bool     `json:"best"`              // 最良を更新したか
	Against    *float64 `json:"against,omitempty"` // 比べた最良の val bpb
	Error      string   `json:"error,omitempty"`
	Seconds    float64  `json:"seconds"`
	At         string   `json:"at"`
}

type record struct {
	Run int     `json:"run"`
	BPB float64 `json:"val_bpb"`
}

type noise struct {
	Mean float64 `json:"mean"`
	Std  float64 `json:"std"`
	N    int     `json:"n"`
}

type lab struct {
	dir, research, data, venv string
	ai                        *openAI
	model, reasoning          string
	gpu                       sync.Mutex // ponytail: GPU は1枚で、学習は1本ずつ。複数枚にするときは枚数分の待ち行列にする
	mu                        sync.Mutex // runs.jsonl と best の読み書き
}

func (l *lab) path(p ...string) string { return filepath.Join(append([]string{l.dir}, p...)...) }

func readJSON(path string, v any) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, v)
}

func writeJSON(path string, v any) error {
	raw, _ := json.MarshalIndent(v, "", "  ")
	if err := os.WriteFile(path+".tmp", append(raw, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(path+".tmp", path)
}

// 学習の出力から最後の "val_bpb: X" を読む
func parseBPB(output string) (float64, error) {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if v, ok := strings.CutPrefix(strings.TrimSpace(lines[i]), "val_bpb:"); ok {
			f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
			if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
				return 0, fmt.Errorf("val_bpb を読めません: %q", v)
			}
			return f, nil
		}
	}
	return 0, errors.New("出力に val_bpb の行がありません。最後に prepare.report(model) を呼んでください")
}

// 最良を更新するのは、ばらつき（標準偏差）の2倍より大きく下がったときだけ
// ponytail: 最良の値は1回の計測なので、たまたま低く出た値が残りうる。採用を厳しくする方向なので今は測り直さない
func improves(bpb float64, best record, n noise) bool {
	return bpb < best.BPB-2*n.Std
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return "…\n" + s[len(s)-n:]
}

// src を GPU の隔離環境で学習させ、記録して返す。待ち行列が空くまで待つ
func (l *lab) train(ctx context.Context, agent int, hypothesis string, src []byte) (run, string) {
	l.gpu.Lock()
	defer l.gpu.Unlock()
	r := run{Agent: agent, Hypothesis: hypothesis, At: time.Now().Format(time.RFC3339)}
	l.mu.Lock()
	defer l.mu.Unlock()
	r.ID = l.count()
	dir := l.path("runs", strconv.Itoa(r.ID))
	err := os.MkdirAll(dir, 0o755)
	if err == nil {
		err = os.WriteFile(filepath.Join(dir, "train.py"), src, 0o644)
	}
	if err == nil {
		err = l.append(r) // 番号を確保するため、結果の前に一度書く。結果は finish で書き直す
	}
	if err != nil {
		r.Error = "実験を用意できません: " + err.Error()
		return r, ""
	}
	l.mu.Unlock()
	output, err := l.execute(ctx, &r, dir)
	l.mu.Lock()
	if err != nil {
		r.Error = err.Error()
	}
	if err := l.finish(&r); err != nil {
		r.Error = strings.TrimSpace(r.Error + " 記録に失敗しました: " + err.Error())
	}
	return r, tail(output, 4000)
}

// dir/train.py を学習させ、r に時間と val bpb を書く
func (l *lab) execute(ctx context.Context, r *run, dir string) (string, error) {
	python, err := pythonBinds(l.venv)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, trainTimeout)
	defer cancel()
	cmd, err := box{
		work:   dir,
		ro:     append(python, [2]string{l.research, "/research"}, [2]string{l.data, "/data"}),
		gpu:    true,
		memory: "8G",
		env:    []string{"PYTHONPATH=/research", "HYPH_DATA=/data", "HYPH_SEED=" + strconv.Itoa(r.ID), "PYTHONUNBUFFERED=1"},
	}.command(ctx, filepath.Join(l.venv, "bin", "python"), "/work/train.py")
	if err != nil {
		return "", err
	}
	start := time.Now()
	out, runErr := cmd.CombinedOutput()
	r.Seconds = math.Round(time.Since(start).Seconds())
	output := string(out)
	os.WriteFile(filepath.Join(dir, "output.log"), out, 0o644)
	if ctx.Err() != nil {
		return output, fmt.Errorf("%v で打ち切りました", trainTimeout)
	}
	if runErr != nil {
		return output, fmt.Errorf("学習が失敗しました: %v", runErr)
	}
	bpb, err := parseBPB(output)
	if err != nil {
		return output, err
	}
	r.BPB = &bpb
	return output, nil
}

func (l *lab) count() int {
	f, err := os.Open(l.path("runs.jsonl"))
	if err != nil {
		return 0
	}
	defer f.Close()
	n := 0
	for s := bufio.NewScanner(f); s.Scan(); {
		n++
	}
	return n
}

func (l *lab) append(r run) error {
	f, err := os.OpenFile(l.path("runs.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	raw, _ := json.Marshal(r)
	_, err = f.Write(append(raw, '\n'))
	return err
}

// 結果で最良を更新し、ノートの該当行を書き直す。基準の計測（agent -1）は最良を更新しない
func (l *lab) finish(r *run) error {
	if r.BPB != nil && r.Agent >= 0 {
		var best record
		var n noise
		if err := errors.Join(readJSON(l.path("best.json"), &best), readJSON(l.path("noise.json"), &n)); err != nil {
			return err
		}
		r.Against = &best.BPB
		if improves(*r.BPB, best, n) {
			src, err := os.ReadFile(l.path("runs", strconv.Itoa(r.ID), "train.py"))
			if err != nil {
				return err
			}
			if err := os.WriteFile(l.path("best", "train.py.tmp"), src, 0o644); err != nil {
				return err
			}
			if err := os.Rename(l.path("best", "train.py.tmp"), l.path("best", "train.py")); err != nil {
				return err
			}
			r.Best = true
			if err := writeJSON(l.path("best.json"), record{r.ID, *r.BPB}); err != nil {
				return err
			}
		}
	}
	raw, err := os.ReadFile(l.path("runs.jsonl"))
	if err != nil {
		return err
	}
	lines := strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n")
	line, _ := json.Marshal(r)
	lines[r.ID] = string(line)
	if err := os.WriteFile(l.path("runs.jsonl.tmp"), []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		return err
	}
	return os.Rename(l.path("runs.jsonl.tmp"), l.path("runs.jsonl"))
}

// 基準の train.py を k 回学習させ、平均とばらつきを noise.json に、平均を最良の値として best.json に置く
func (l *lab) baseline(ctx context.Context, k int) error {
	src, err := os.ReadFile(filepath.Join(l.research, "train.py"))
	if err != nil {
		return err
	}
	if err := os.MkdirAll(l.path("best"), 0o755); err != nil {
		return err
	}
	var values []float64
	first := -1
	for i := range k {
		r, output := l.train(ctx, -1, "基準の計測", src)
		if r.Error != "" {
			return fmt.Errorf("基準の学習 %d が失敗しました: %s\n%s", r.ID, r.Error, output)
		}
		if first < 0 {
			first = r.ID
		}
		fmt.Printf("%d/%d: val_bpb %.6f（%v秒）\n", i+1, k, *r.BPB, r.Seconds)
		values = append(values, *r.BPB)
	}
	var n noise
	n.N = len(values)
	for _, v := range values {
		n.Mean += v / float64(n.N)
	}
	for _, v := range values {
		n.Std += (v - n.Mean) * (v - n.Mean) / float64(n.N-1)
	}
	n.Std = math.Sqrt(n.Std)
	fmt.Printf("平均 %.6f、標準偏差 %.6f\n", n.Mean, n.Std)
	if err := os.WriteFile(l.path("best", "train.py"), src, 0o644); err != nil {
		return err
	}
	return errors.Join(writeJSON(l.path("noise.json"), n), writeJSON(l.path("best.json"), record{first, n.Mean}))
}

// エージェント i のソケットで、モデルの呼び出し・共有の文脈・学習を受け付ける。cursor は共有の文脈を読んだ位置
func (l *lab) serve(i int, socket, work string, cursor *atomic.Int64) (*http.Server, error) {
	os.Remove(socket)
	ln, err := net.Listen("unix", socket)
	if err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /model", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "JSON のオブジェクトを送ってください: "+err.Error(), 400)
			return
		}
		// モデルの選択と保存の可否はハーネスが決める。推論の過程は保存しないため、暗号化して返させ、次の呼び出しで送り返す
		body["model"] = l.model
		body["store"] = false
		body["stream"] = true
		body["include"] = []string{"reasoning.encrypted_content"}
		body["reasoning"] = map[string]string{"effort": l.reasoning}
		req, _ := json.Marshal(body)
		out, status, err := l.ai.respond(req)
		if err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		w.Write(out)
	})
	// 前回読んだ後に増えた項目だけを返す
	mux.HandleFunc("GET /context", func(w http.ResponseWriter, r *http.Request) {
		l.mu.Lock()
		es, err := l.entries()
		l.mu.Unlock()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		from := min(int(cursor.Swap(int64(len(es)))), len(es))
		json.NewEncoder(w).Encode(append([]entry{}, es[from:]...))
	})
	text := func(w http.ResponseWriter, r *http.Request) (string, bool) {
		var body struct {
			Text string `json:"text"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Text) == "" {
			http.Error(w, `{"text": "..."} を送ってください`, 400)
			return "", false
		}
		return body.Text, true
	}
	mux.HandleFunc("POST /claim", func(w http.ResponseWriter, r *http.Request) {
		t, ok := text(w, r)
		if !ok {
			return
		}
		e, err := l.claim(i, t)
		if err != nil {
			http.Error(w, err.Error(), 409)
			return
		}
		json.NewEncoder(w).Encode(e)
	})
	mux.HandleFunc("POST /release", func(w http.ResponseWriter, r *http.Request) {
		t, ok := text(w, r)
		if !ok {
			return
		}
		if err := l.close(i, "release", t, nil); err != nil {
			http.Error(w, err.Error(), 500)
		}
	})
	for _, kind := range []string{"fact", "fail"} {
		mux.HandleFunc("POST /"+kind, func(w http.ResponseWriter, r *http.Request) {
			t, ok := text(w, r)
			if !ok {
				return
			}
			l.mu.Lock()
			e, err := l.post(entry{Agent: i, Kind: kind, Text: t})
			l.mu.Unlock()
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			json.NewEncoder(w).Encode(e)
		})
	}
	// 申告した仮説を /work/train.py で検証し、結果を fact か fail として書いて申告を閉じる
	mux.HandleFunc("POST /train", func(w http.ResponseWriter, r *http.Request) {
		l.mu.Lock()
		es, err := l.entries()
		l.mu.Unlock()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		c := openClaim(es, i)
		if c == nil {
			http.Error(w, "先に claim で仮説を申告してください", 409)
			return
		}
		src, err := os.ReadFile(filepath.Join(work, "train.py"))
		if err != nil {
			http.Error(w, "/work/train.py を読めません: "+err.Error(), 400)
			return
		}
		res, output := l.train(r.Context(), i, c.Text, src)
		kind, summary := outcome(res)
		if err := l.close(i, kind, summary, &res.ID); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"run": res, "output": output})
	})
	server := &http.Server{Handler: mux}
	go server.Serve(ln)
	return server, nil
}

// エージェント i を、作業用ディレクトリを最良の train.py だけにしてから1回の研究として動かし、終わったら繰り返す
func (l *lab) agent(ctx context.Context, i int, binary string) error {
	home := l.path("agents", strconv.Itoa(i))
	work := filepath.Join(home, "work")
	if err := os.MkdirAll(home, 0o755); err != nil {
		return err
	}
	socket := filepath.Join(home, "hyph.sock")
	var cursor atomic.Int64
	server, err := l.serve(i, socket, work, &cursor)
	if err != nil {
		return err
	}
	defer server.Close()
	python, err := pythonBinds(l.venv)
	if err != nil {
		return err
	}
	for episode := 0; ctx.Err() == nil; episode++ {
		cursor.Store(0) // 新しい文脈で始めるので、共有の文脈を初めから読ませる
		// 前の研究が検証せずに終えた申告は、他の個体が取れるように手放す
		if err := l.close(i, "release", "研究を終えたため手放した", nil); err != nil {
			return err
		}
		if err := os.RemoveAll(work); err != nil {
			return err
		}
		if err := os.MkdirAll(work, 0o755); err != nil {
			return err
		}
		src, err := os.ReadFile(l.path("best", "train.py"))
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(work, "train.py"), src, 0o644); err != nil {
			return err
		}
		cmd, err := box{
			work: work,
			ro: append(python, [2]string{binary, "/opt/agent"}, [2]string{l.research, "/research"}, [2]string{l.data, "/data"},
				[2]string{l.path("best"), "/best"}, [2]string{l.path("runs"), "/runs"}),
			rw:     [][2]string{{socket, "/hyph.sock"}},
			memory: "2G",
			env:    []string{"PATH=" + filepath.Join(l.venv, "bin") + ":/run/current-system/sw/bin:/usr/bin:/bin", "PYTHONPATH=/research", "HYPH_DATA=/data"},
		}.command(ctx, "/opt/agent")
		if err != nil {
			return err
		}
		log, err := os.Create(filepath.Join(home, fmt.Sprintf("episode-%d.log", episode)))
		if err != nil {
			return err
		}
		cmd.Stdout, cmd.Stderr = log, log
		err = cmd.Run()
		log.Close()
		fmt.Printf("エージェント %d: 研究 %d が終わりました（%v）\n", i, episode, errOrOK(err))
		if err != nil && ctx.Err() == nil {
			time.Sleep(time.Minute) // 失敗が続くときにモデルを呼び続けない
		}
	}
	return nil
}

func errOrOK(err error) string {
	if err == nil {
		return "正常終了"
	}
	return err.Error()
}

func (l *lab) start(ctx context.Context, agents int) error {
	if err := errors.Join(readJSON(l.path("best.json"), &record{}), readJSON(l.path("noise.json"), &noise{})); err != nil {
		return fmt.Errorf("先に hyph baseline でばらつきを測ってください: %w", err)
	}
	binary := l.path("agent")
	build := exec.Command("go", "build", "-o", binary, "./agent")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := build.CombinedOutput(); err != nil {
		return fmt.Errorf("エージェントをビルドできません: %v\n%s", err, out)
	}
	var wg sync.WaitGroup
	errs := make([]error, agents)
	for i := range agents {
		wg.Go(func() { errs[i] = l.agent(ctx, i, binary) })
	}
	wg.Wait()
	return errors.Join(errs...)
}
