package main

// 研究者の共有の文脈。DeLM（arXiv:2606.10662）にならい、全員が追記だけをするログにする。
// 書き換えはせず、誤りは新しい fail で指摘する。
//   claim    これから検証する仮説の申告。1体が同時に持てる未完了の申告は1つまで
//   fact     根拠のある発見
//   fail     否定された仮説・失敗した方法
//   release  検証せずに手放した申告
// 学習の結果はハーネスが fact か fail として書き、申告を閉じる。

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

type entry struct {
	ID    int    `json:"id"`
	Agent int    `json:"agent"`
	Kind  string `json:"kind"`
	Text  string `json:"text"`
	Claim *int   `json:"claim,omitempty"` // この項目が閉じる申告
	Run   *int   `json:"run,omitempty"`   // 根拠の実験
	At    string `json:"at"`
}

// ponytail: 読むたびにファイル全体を読む。数万件を超えて遅くなったら件数をメモリに持つ
func (l *lab) entries() ([]entry, error) {
	f, err := os.Open(l.path("context.jsonl"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var es []entry
	s := bufio.NewScanner(f)
	s.Buffer(nil, 1<<20)
	for s.Scan() {
		var e entry
		if err := json.Unmarshal(s.Bytes(), &e); err != nil {
			return nil, fmt.Errorf("context.jsonl の %d 行目を読めません: %w", len(es)+1, err)
		}
		es = append(es, e)
	}
	return es, s.Err()
}

// 呼び出し側が l.mu を持つこと
func (l *lab) post(e entry) (entry, error) {
	es, err := l.entries()
	if err != nil {
		return e, err
	}
	e.ID, e.At = len(es), time.Now().Format(time.RFC3339)
	f, err := os.OpenFile(l.path("context.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return e, err
	}
	defer f.Close()
	raw, _ := json.Marshal(e)
	_, err = f.Write(append(raw, '\n'))
	return e, err
}

// agent のまだ閉じていない申告。なければ nil
func openClaim(es []entry, agent int) *entry {
	closed := map[int]bool{}
	for _, e := range es {
		if e.Claim != nil {
			closed[*e.Claim] = true
		}
	}
	for i := len(es) - 1; i >= 0; i-- {
		if es[i].Agent == agent && es[i].Kind == "claim" && !closed[es[i].ID] {
			return &es[i]
		}
	}
	return nil
}

func (l *lab) claim(agent int, text string) (entry, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	es, err := l.entries()
	if err != nil {
		return entry{}, err
	}
	if c := openClaim(es, agent); c != nil {
		return entry{}, fmt.Errorf("未完了の申告 #%d があります。train で検証するか、release で手放してください", c.ID)
	}
	return l.post(entry{Agent: agent, Kind: "claim", Text: strings.TrimSpace(text)})
}

// agent の未完了の申告を閉じる項目を書く。申告がなければ何もしない
func (l *lab) close(agent int, kind, text string, run *int) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	es, err := l.entries()
	if err != nil {
		return err
	}
	c := openClaim(es, agent)
	if c == nil {
		return nil
	}
	_, err = l.post(entry{Agent: agent, Kind: kind, Text: text, Claim: &c.ID, Run: run})
	return err
}

// 学習の結果を、申告の仮説を添えた fact か fail に書き直す
func outcome(r run) (string, string) {
	switch {
	case r.Error != "":
		return "fail", fmt.Sprintf("学習が失敗した: %s。仮説: %s", r.Error, r.Hypothesis)
	case r.Best:
		return "fact", fmt.Sprintf("最良を更新した（val_bpb %.4f、前の最良 %.4f）。仮説: %s", *r.BPB, *r.Against, r.Hypothesis)
	default:
		return "fail", fmt.Sprintf("最良を更新しなかった（val_bpb %.4f、最良 %.4f）。仮説: %s", *r.BPB, *r.Against, r.Hypothesis)
	}
}
