package main

import (
	"net/url"
	"strings"
	"testing"
)

func TestParseBPB(t *testing.T) {
	v, err := parseBPB("step 0 loss 5.5\nval_bpb: 1.000000\nval_bpb: 1.234500\n")
	if err != nil || v != 1.2345 {
		t.Fatalf("最後の val_bpb を読むこと: %v %v", v, err)
	}
	for _, out := range []string{"step 0 loss 5.5\n", "val_bpb: nan\n", "val_bpb: abc\n"} {
		if _, err := parseBPB(out); err == nil {
			t.Fatalf("読めない出力を失敗にすること: %q", out)
		}
	}
}

func TestImproves(t *testing.T) {
	best, n := record{BPB: 1.5}, noise{Std: 0.01}
	if improves(1.49, best, n) {
		t.Fatal("ばらつきの2倍以内の差では更新しないこと")
	}
	if !improves(1.47, best, n) {
		t.Fatal("ばらつきの2倍を超えて下がったら更新すること")
	}
}

func TestParseCallback(t *testing.T) {
	u, _ := url.Parse("http://127.0.0.1:1455/auth/callback?code=c&state=s&client_id=id")
	if c, err := parseCallback(u, "s"); err != nil || c.code != "c" || c.clientID != "id" {
		t.Fatalf("正しいコールバックを受け付けること: %+v %v", c, err)
	}
	if _, err := parseCallback(u, "other"); err == nil {
		t.Fatal("state が違うコールバックを拒否すること")
	}
}

func TestCompleted(t *testing.T) {
	sse := "event: response.created\ndata: {\"type\":\"response.created\"}\n\n" +
		"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\"}}\n\n"
	out, err := completed(strings.NewReader(sse))
	if err != nil || string(out) != `{"id":"r"}` {
		t.Fatalf("最後の応答を返すこと: %s %v", out, err)
	}
	if _, err := completed(strings.NewReader("data: {\"type\":\"response.created\"}\n")); err == nil {
		t.Fatal("途中で切れた応答を失敗にすること")
	}
}

func TestClaim(t *testing.T) {
	l := &lab{dir: t.TempDir()}
	if _, err := l.claim(0, "仮説A"); err != nil {
		t.Fatal(err)
	}
	if _, err := l.claim(0, "仮説B"); err == nil {
		t.Fatal("未完了の申告があるうちは次の申告を拒否すること")
	}
	if _, err := l.claim(1, "仮説B"); err != nil {
		t.Fatal("別の個体は申告できること:", err)
	}
	run := 3
	if err := l.close(0, "fail", "最良を更新しなかった", &run); err != nil {
		t.Fatal(err)
	}
	es, _ := l.entries()
	if c := openClaim(es, 0); c != nil {
		t.Fatalf("閉じた申告が残っている: %+v", c)
	}
	if c := openClaim(es, 1); c == nil || c.Text != "仮説B" {
		t.Fatalf("他の個体の申告は閉じないこと: %+v", c)
	}
	if _, err := l.claim(0, "仮説C"); err != nil {
		t.Fatal("閉じた後は申告できること:", err)
	}
}
