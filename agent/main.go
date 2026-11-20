// 研究エージェント。将来の自己改善で書き換える対象。
// 隔離環境の中で動き、/hyph.sock の model・train・runs だけで外とやり取りする。
// 1回の研究（仮説を立て、/work/train.py を変え、学習させ、結果を読む）を終えたら終了し、ハーネスが新しい文脈で起動し直す。
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

const maxCalls = 60

const instructions = `あなたは LLM のアーキテクチャと学習法を研究する研究者です。同じ GPU を分け合う他の研究者と並行して研究しています。指揮役はおらず、研究者どうしは共有の文脈だけで協調します。

目的: /work/train.py を改良し、検証データの val bpb（1バイトあたりのビット数。低いほど良い）を下げること。

環境:
- /research/prepare.py は固定部です（読み取り専用）。データ、学習の予算（TOKEN_BUDGET バイト。prepare.batches が返す分）、評価を決めています。必ず読んでから始めてください。
- /best/train.py が今の最良です。/work/train.py は研究の開始時にその複製になっています。
- /runs/<番号>/ に過去の実験のスクリプト（train.py）と出力（output.log）があります。
- ネットワークはありません。GPU は train で学習するときだけ使えます。sh では CPU しか使えません。

共有の文脈（全員が追記だけをするログ）:
- claim: これから検証する仮説の申告。他の研究者の未完了の claim と同じ仮説は選ばない。
- fact: 根拠のある発見。fail: 否定された仮説や失敗した方法。他の研究者は fail を制約として扱い、同じ失敗を避ける。
- train の結果は、ハーネスが fact か fail として書き、あなたの claim を閉じる。
- 既存の項目は書き換えられない。誤りを見つけたら、根拠を添えて新しい fail を書く。
- read は前回読んだ後に増えた項目だけを返す。

規則:
- 学習データだけで学習し、検証データ（val.bin）を学習に使わないこと。
- 学習データは prepare.batches からだけ取り、最後に prepare.report(model) を呼ぶこと。
- 1回の学習は12分で打ち切られる。GPU は Windows の画面と共有で、混むと遅くなるので、混んでいないときに8分以内で終わる大きさにすること。
- 1回の研究で検証する仮説は1つにすること。

手順:
1. read で共有の文脈を読む。試された仮説、失敗、他の研究者が申告中の仮説を確かめる。
2. 根拠のある仮説を1つ選び、claim で申告する。
3. /work/train.py を変え、sh で CPU と小さな設定で動くことを短く確かめる（例: 数ステップだけ回す）。学習の失敗は GPU の待ち時間を無駄にする。
4. 申告の前に read し直し、同じ仮説を他の研究者が先に申告していたら release で手放して別の仮説を選ぶ。
5. train で学習させる。待ち行列があるため、結果が返るまで数十分かかることがある。
6. 結果から、他の研究者の役に立つ発見があれば fact か fail に書く。学んだことを最後の応答に短く書いて終える。`

func textTool(name, description string) map[string]any {
	return map[string]any{
		"type": "function", "name": name, "strict": true, "description": description,
		"parameters": map[string]any{
			"type": "object", "additionalProperties": false, "required": []string{"text"},
			"properties": map[string]any{"text": map[string]any{"type": "string"}},
		},
	}
}

var noArgs = map[string]any{"type": "object", "additionalProperties": false, "properties": map[string]any{}, "required": []string{}}

var tools = []map[string]any{
	{
		"type": "function", "name": "sh", "strict": true,
		"description": "/work で bash のコマンドを実行し、終了コードと出力を返す。CPU のみ。120秒で打ち切る",
		"parameters": map[string]any{
			"type": "object", "additionalProperties": false, "required": []string{"command"},
			"properties": map[string]any{"command": map[string]any{"type": "string"}},
		},
	},
	{"type": "function", "name": "read", "strict": true, "description": "共有の文脈のうち、前回読んだ後に増えた項目を返す", "parameters": noArgs},
	textTool("claim", "検証する仮説と、加える変更を申告する。未完了の申告は1つまで"),
	textTool("release", "検証せずに申告を手放す。理由を書く"),
	textTool("fact", "根拠のある発見を共有の文脈に書く。根拠（実験の番号や出力）を含める"),
	textTool("fail", "否定された仮説や失敗した方法を共有の文脈に書く。根拠を含める"),
	{
		"type": "function", "name": "train", "strict": true, "parameters": noArgs,
		"description": "申告した仮説について /work/train.py を GPU で学習させ、val bpb と出力の末尾を返す。他の研究者と待ち行列を共有する",
	},
}

var client = &http.Client{Transport: &http.Transport{
	DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", "/hyph.sock")
	},
}}

func call(method, path string, body any) ([]byte, error) {
	var r io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		r = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, "http://hyph"+path, r)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(resp.Body)
	if err == nil && resp.StatusCode != 200 {
		err = fmt.Errorf("%s %s が失敗しました（%d）: %s", method, path, resp.StatusCode, out)
	}
	return out, err
}

// 長い出力は先頭と末尾を残す
func clip(s string) string {
	const head, tail = 2000, 6000
	if len(s) <= head+tail {
		return s
	}
	return strings.ToValidUTF8(s[:head], "") + fmt.Sprintf("\n…（%d バイトを省略）…\n", len(s)-head-tail) + strings.ToValidUTF8(s[len(s)-tail:], "")
}

func sh(command string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "bash", "-c", command)
	cmd.Dir = "/work"
	out, err := cmd.CombinedOutput()
	code := 0
	if ctx.Err() != nil {
		return clip(string(out)) + "\n（120秒で打ち切りました）"
	}
	if e, ok := err.(*exec.ExitError); ok {
		code = e.ExitCode()
	} else if err != nil {
		return "実行できません: " + err.Error()
	}
	return fmt.Sprintf("終了コード %d\n%s", code, clip(string(out)))
}

func use(name, arguments string) string {
	var args struct {
		Command string `json:"command"`
		Text    string `json:"text"`
	}
	if err := json.Unmarshal([]byte(arguments), &args); err != nil {
		return "引数を読めません: " + err.Error()
	}
	var out []byte
	var err error
	switch name {
	case "sh":
		return sh(args.Command)
	case "read":
		// ponytail: 新しい項目は省略せずに渡す。文脈が溢れるようになったら古い項目を要約する
		out, err = call("GET", "/context", nil)
	case "claim", "release", "fact", "fail":
		out, err = call("POST", "/"+name, map[string]string{"text": args.Text})
	case "train":
		out, err = call("POST", "/train", map[string]string{})
	default:
		return "そのツールはありません: " + name
	}
	if err != nil {
		return err.Error()
	}
	if len(out) == 0 {
		return "完了しました"
	}
	return string(out)
}

type item struct {
	Type      string `json:"type"`
	Name      string `json:"name"`
	CallID    string `json:"call_id"`
	Arguments string `json:"arguments"`
	Content   []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

func main() {
	input := []any{map[string]string{"role": "user", "content": "研究を始めてください。"}}
	for range maxCalls {
		out, err := call("POST", "/model", map[string]any{
			"instructions": instructions, "input": input, "tools": tools, "parallel_tool_calls": false,
		})
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		var resp struct {
			Output []json.RawMessage `json:"output"`
		}
		if err := json.Unmarshal(out, &resp); err != nil {
			fmt.Fprintln(os.Stderr, "応答を読めません:", err)
			os.Exit(1)
		}
		used := false
		for _, raw := range resp.Output {
			input = append(input, raw) // 推論の過程も含めて送り返し、次の呼び出しで続きから考えさせる
			var it item
			if err := json.Unmarshal(raw, &it); err != nil {
				continue
			}
			switch it.Type {
			case "message":
				for _, c := range it.Content {
					fmt.Println(c.Text)
				}
			case "function_call":
				used = true
				fmt.Printf("> %s %s\n", it.Name, it.Arguments)
				result := use(it.Name, it.Arguments)
				fmt.Println(clip(result))
				input = append(input, map[string]string{"type": "function_call_output", "call_id": it.CallID, "output": result})
			}
		}
		if !used {
			return
		}
	}
	fmt.Println("呼び出しの上限に達しました")
}
