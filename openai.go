package main

// Sign in with ChatGPT で受け取ったトークンで、OpenAI の Responses API を呼ぶ。
// pi-ai（MIT）の auth/oauth/openai-chatgpt.js を移植した。トークンは pi-ai と同じ形式で ~/.hyph/auth.json に置く。

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	dynamicClientID = "dynamic_agent_client" // サインインのたびに新しいクライアントが発行され、コールバックで ID が返る
	authorizeURL    = "https://auth.openai.com/api/accounts/authorize"
	tokenURL        = "https://auth.openai.com/api/accounts/oauth/token"
	resource        = "https://api.openai.com/v1"
	redirectURI     = "http://127.0.0.1:1455/auth/callback"
	directScope     = "chatgpt.tokens.use.direct"
	responsesURL    = "https://api.openai.com/v1/responses"
	// 期限の少し前に更新し、期限切れ間近のトークンで呼び出しを始めない
	expiryMargin = 3 * time.Minute
)

type credential struct {
	Type     string   `json:"type"`
	Access   string   `json:"access"`
	Refresh  string   `json:"refresh"`
	Expires  int64    `json:"expires"` // ミリ秒
	ClientID string   `json:"clientId"`
	Scopes   []string `json:"scopes"`
}

type openAI struct {
	path string // auth.json
	mu   sync.Mutex
}

func randomValue() string {
	b := make([]byte, 32)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// auth.json がなければ空の表を返す
func (o *openAI) read() (map[string]json.RawMessage, error) {
	file := map[string]json.RawMessage{}
	raw, err := os.ReadFile(o.path)
	if errors.Is(err, os.ErrNotExist) {
		return file, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		return nil, fmt.Errorf("%s を読めません: %w", o.path, err)
	}
	return file, nil
}

// 他の提供元のトークンを消さないよう、openai の項目だけを書き換える
func (o *openAI) save(file map[string]json.RawMessage, c credential) error {
	raw, err := json.Marshal(c)
	if err != nil {
		return err
	}
	file["openai"] = raw
	out, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	tmp := o.path + ".tmp"
	if err := os.WriteFile(tmp, out, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, o.path)
}

func requestToken(form url.Values) (credential, map[string]any, error) {
	var c credential
	resp, err := http.PostForm(tokenURL, form)
	if err != nil {
		return c, nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return c, nil, fmt.Errorf("トークンの取得に失敗しました（%d）: %s", resp.StatusCode, body)
	}
	var t map[string]any
	if err := json.Unmarshal(body, &t); err != nil {
		return c, nil, fmt.Errorf("トークンの応答を読めません: %w", err)
	}
	access, _ := t["access_token"].(string)
	refresh, _ := t["refresh_token"].(string)
	scope, _ := t["scope"].(string)
	expiresIn, _ := t["expires_in"].(float64)
	if access == "" || refresh == "" || scope == "" || expiresIn <= 0 {
		return c, nil, errors.New("トークンの応答に access_token・refresh_token・scope・expires_in がありません")
	}
	c = credential{
		Type:     "oauth",
		Access:   access,
		Refresh:  refresh,
		Expires:  time.Now().Add(time.Duration(expiresIn)*time.Second - expiryMargin).UnixMilli(),
		ClientID: form.Get("client_id"),
		Scopes:   strings.Fields(scope),
	}
	if !slices.Contains(c.Scopes, directScope) {
		return c, nil, fmt.Errorf("許可に %s が含まれていません", directScope)
	}
	return c, t, nil
}

// 期限が切れていれば更新して保存する。更新トークンは使うたびに替わるため、並行して更新しないよう排他する
func (o *openAI) token() (string, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	file, err := o.read()
	if err != nil {
		return "", err
	}
	var c credential
	if file["openai"] == nil {
		return "", errors.New("サインインしていません。hyph login を実行してください")
	}
	if err := json.Unmarshal(file["openai"], &c); err != nil {
		return "", fmt.Errorf("%s の openai を読めません: %w", o.path, err)
	}
	if time.Now().UnixMilli() < c.Expires {
		return c.Access, nil
	}
	if c.ClientID == "" {
		return "", errors.New("保存したトークンに発行されたクライアント ID がありません。hyph login をやり直してください")
	}
	next, _, err := requestToken(url.Values{
		"grant_type":    {"refresh_token"},
		"client_id":     {c.ClientID},
		"refresh_token": {c.Refresh},
		"resource":      {resource},
	})
	if err != nil {
		return "", err
	}
	return next.Access, o.save(file, next)
}

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// OpenAI はインストールごとに固定の ID（urn:uuid:...）でエージェントの実行元を見分ける
func deviceID(dir string) (string, error) {
	path := filepath.Join(dir, "device-id")
	if raw, err := os.ReadFile(path); err == nil && uuidPattern.Match(bytes.TrimSpace(raw)) {
		return string(bytes.TrimSpace(raw)), nil
	}
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	id := fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
	return id, os.WriteFile(path, []byte(id+"\n"), 0o600)
}

type callback struct{ code, state, clientID string }

func parseCallback(u *url.URL, state string) (callback, error) {
	q := u.Query()
	c := callback{q.Get("code"), q.Get("state"), strings.TrimSpace(q.Get("client_id"))}
	switch {
	case q.Get("error") != "":
		return c, fmt.Errorf("サインインが拒否されました: %s %s", q.Get("error"), q.Get("error_description"))
	case c.code == "":
		return c, errors.New("認可コードがありません")
	case c.state != state:
		return c, errors.New("state が一致しません")
	case c.clientID == "":
		return c, errors.New("発行されたクライアント ID がありません")
	}
	return c, nil
}

func (o *openAI) login() error {
	id, err := deviceID(filepath.Dir(o.path))
	if err != nil {
		return err
	}
	verifier := randomValue()
	sum := sha256.Sum256([]byte(verifier))
	state := randomValue()
	u, _ := url.Parse(authorizeURL)
	u.RawQuery = url.Values{
		"client_id":             {dynamicClientID},
		"agent_name_hint":       {"hypharness"},
		"ext_agent_host_id":     {"urn:uuid:" + id},
		"response_type":         {"code"},
		"redirect_uri":          {redirectURI},
		"resource":              {resource},
		"scope":                 {"openid profile email offline_access resource.invoke " + directScope},
		"state":                 {state},
		"code_challenge":        {base64.RawURLEncoding.EncodeToString(sum[:])},
		"code_challenge_method": {"S256"},
		"nonce":                 {randomValue()},
	}.Encode()

	ln, err := net.Listen("tcp", "127.0.0.1:1455")
	if err != nil {
		return fmt.Errorf("ポート 1455 を使えません。Codex CLI など、別のサインインが動いていないか確かめてください: %w", err)
	}
	result := make(chan callback, 1)
	failed := make(chan error, 1)
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/auth/callback" {
			http.NotFound(w, r)
			return
		}
		c, err := parseCallback(r.URL, state)
		if err != nil {
			http.Error(w, err.Error(), 400)
			failed <- err
			return
		}
		fmt.Fprintln(w, "サインインしました。このタブを閉じてください。")
		result <- c
	})}
	go server.Serve(ln)
	defer server.Close()

	fmt.Println("ブラウザで次の URL を開いてサインインしてください:")
	fmt.Println(u.String())
	var c callback
	select {
	case c = <-result:
	case err := <-failed:
		return err
	case <-time.After(15 * time.Minute):
		return errors.New("15分以内にサインインが終わりませんでした")
	}
	next, raw, err := requestToken(url.Values{
		"grant_type":    {"authorization_code"},
		"client_id":     {c.clientID},
		"code":          {c.code},
		"code_verifier": {verifier},
		"redirect_uri":  {redirectURI},
		"resource":      {resource},
	})
	if err != nil {
		return err
	}
	if s, _ := raw["id_token"].(string); s == "" {
		return errors.New("トークンの応答に id_token がありません")
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	file, err := o.read()
	if err != nil {
		return err
	}
	return o.save(file, next)
}

// ChatGPT のトークンでは stream が必須なので、SSE（応答を data: 行で流す形式）を読み、最後の応答だけを返す
func completed(body io.Reader) ([]byte, error) {
	s := bufio.NewScanner(body)
	s.Buffer(nil, 64<<20)
	for s.Scan() {
		data, ok := strings.CutPrefix(s.Text(), "data: ")
		if !ok {
			continue
		}
		var e struct {
			Type     string          `json:"type"`
			Response json.RawMessage `json:"response"`
		}
		if json.Unmarshal([]byte(data), &e) != nil {
			continue
		}
		switch e.Type {
		case "response.completed", "response.incomplete":
			return e.Response, nil
		case "response.failed", "error":
			return nil, fmt.Errorf("モデルの応答が失敗しました: %s", data)
		}
	}
	if err := s.Err(); err != nil {
		return nil, err
	}
	return nil, errors.New("応答の終わりを受け取る前に切れました")
}

// 混雑とサーバー側の失敗だけを間隔を空けて呼び直す。それ以外の失敗はそのまま返す
var retryDelays = []time.Duration{10 * time.Second, 30 * time.Second, 2 * time.Minute}

func (o *openAI) respond(body []byte) ([]byte, int, error) {
	for i := 0; ; i++ {
		token, err := o.token()
		if err != nil {
			return nil, 0, err
		}
		req, _ := http.NewRequest("POST", responsesURL, bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		var out []byte
		status := 0
		if err == nil {
			status = resp.StatusCode
			if status == 200 {
				out, err = completed(resp.Body)
			} else {
				out, err = io.ReadAll(resp.Body)
			}
			resp.Body.Close()
		}
		if err == nil && status != 429 && status < 500 {
			return out, status, nil
		}
		if i >= len(retryDelays) {
			if err == nil {
				err = fmt.Errorf("モデルの障害が回復しません（%d）: %s", status, out)
			}
			return nil, status, err
		}
		time.Sleep(retryDelays[i])
	}
}
