# 0045 モデルの提供元に OpenDesign を選べるようにする

日付: 2026-11-07

## 状況

OpenDesign（https://open-design.ai/ja/pricing/）の Go プランは月 10 ドルで、Design Plan のクレジット（月 220 ドルまで）で DeepSeek V4.1 Flash などのモデルを使える。OpenDesign の API キーを使うと、Codex・Claude Code・OpenCode・Hermes などのエージェントから同じモデルを呼べる。API は OpenAI Chat Completions・OpenAI Responses・Anthropic Messages の形に対応する（https://open-design.ai/ja/model-credits/）。

資料が示す条件は次のとおり。

- API とアプリは同じクレジットを使う。外からの利用で枠は増えない。
- 含まれる無料の利用と期間限定の優待は、OpenDesign の中での利用だけに当たり、MCP・CLI・API には当たらない。
- Go には画像の生成が含まれない。

接続先の URL とモデルの API の id は公開の資料に無い。Console の API キーの画面（https://open-design.ai/cloud/api-keys）が、ログインの後に実行時の設定から出す。

## 決定

- `PROVIDER=opendesign` で OpenDesign を選ぶ。OpenAI Chat Completions の形で呼ぶ。
- 接続先は `OPENDESIGN_BASE_URL`（Console に出る、末尾が `/v1` の URL）、モデルは `OPENDESIGN_MODEL`（その接続先の `/v1/models` に出る id）、鍵は `OPENDESIGN_API_KEY` に書く。接続先かモデルが無ければ、起動の時点で止める。
- `User-Agent` は OpenCode Go と同じ `hypharness/0.1` にする（ADR 0044）。OpenDesign にセッション id の見出しの決まりは無いので送らない。
- 1回の応答の出力の上限は 32,768 トークンにする。

## 結果

- 費用は DeepSeek V4.1 Flash の公開の単価（入力 0.15・出力 0.6・キャッシュの読み出し 0.003 ドル）で数える。OpenDesign のクレジットの倍率（DeepSeek V4.1 Flash は 0.5 倍）は数えていない。
- 接続先とモデルの id は、利用者が Console で確かめて書く必要がある。
