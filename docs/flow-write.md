# 実装した構成

[flow.md](flow.md) の目標の図に対して、実際に作ったものを同じ3部（①メインハーネス・②オフライン RSI・③分散基盤）で示す。各ノードの括弧内は、その処理があるファイルと関数である。目標の図にあって作っていないものは、最後の表にまとめる。

```mermaid
flowchart TD
    GOAL["最終目的<br/>~/.hyph/*-goal.md"]
    H["基準版・稼働版・試験版<br/>セッションの meta（base・stable・canary）"]
    TASKS["目的遂行タスク<br/>画面から追加（src/index.tsx /tasks）"]
    EVO_TASKS[("進化用課題<br/>セッションの tasks 表<br/>node/tasks.ts generate")]
    ALLOC["資源配分<br/>node/ledger.ts<br/>区分: 目的遂行・局所改善・自己改善・検証"]

    GOAL --> EVO_TASKS
    GOAL --> ALLOC
    TASKS --> RELAY_Q
    H --> NODE_RUN

    subgraph MAIN["① メインハーネス（agent/。候補ごとに隔離環境の /agent に読み取り専用で置く）"]
        direction TB
        START["前の課題の成否で記憶を評価<br/>agent/solve.ts（/state/last.json・outcome.json）<br/>memory.judge"]
        SELECT["文脈選択: 記憶を全文検索し、参照関係と評価で並べて上位5件<br/>memory.entries"]
        HEAD["最初のメッセージ = 課題文 + 記憶 + 作業メモ<br/>solve.ts head"]
        API["モデル中継（/model.sock）<br/>node/model.ts serveModel<br/>予算・prompt_cache_key・再試行"]
        DECIDE{"次の行動<br/>solve.ts act"}
        SH["sh: /work でコマンド実行<br/>出力の全文は原文に、文脈には番号と先頭4,000字"]
        RECALL["recall・expand: 原文と記憶を検索・復元"]
        EDIT["edit_context: drop・note・unnote・move を提案<br/>checkEdits で検証して貯める"]
        DELEGATE["delegate: 子のエージェント（新しい文脈・20回まで）<br/>要約だけを親に返す"]
        COMPACT{"入力が16,000トークンを超えたか"}
        APPLY["貯めた編集と作業メモをまとめて反映し、<br/>直近6件より古い出力を原文の参照に置き換える<br/>applyEdits・compact"]
        DONE["finish"]
        REFLECT["振り返り: remember（3回まで）<br/>引用が原文に含まれるかを確かめ、似た要旨は統合"]
        subgraph MEM["/state/memory.sqlite（課題をまたいで残る。計測では試行ごとに空）"]
            RAW[("raw: 原文（追記のみ）<br/>FTS5 trigram")]
            ENTRIES[("entries: 記憶（self・shared）<br/>Gist・Summary・評価")]
            SOURCES[("sources: 記憶の根拠の原文")]
            LINKS[("links: 参照関係<br/>task・cause・depend")]
        end

        START --> SELECT --> HEAD --> API --> DECIDE
        DECIDE -->|"ツール"| SH
        DECIDE --> RECALL
        DECIDE --> EDIT
        DECIDE --> DELEGATE
        DECIDE -->|"完了"| DONE
        SH --> RAW
        DELEGATE --> RAW
        RECALL --> RAW
        RECALL --> ENTRIES
        SH --> COMPACT
        COMPACT -->|"はい"| APPLY --> API
        COMPACT -->|"いいえ"| API
        DONE --> REFLECT --> ENTRIES
        REFLECT --> SOURCES
        REFLECT --> LINKS
        SELECT --> ENTRIES
        SELECT --> LINKS
    end

    subgraph ECON["局所改善（オンライン RSI。node/ideas.ts）"]
        WORKER["worker が方針を1行提案"]
        INVEST["投資家が資本に比例して試す番を配る"]
        LOCALTEST["今の方針と新しい方針を検証用課題で5回ずつ測る"]
        LOCALGATE{"成功率が確かに上がったか、<br/>下げずに費用が2割以上下がったか"}
        MEMO[("採用された方針<br/>課題文の前に置く")]
        WORKER --> INVEST --> LOCALTEST --> LOCALGATE
        LOCALGATE -->|"はい"| MEMO
    end

    subgraph RSI["② オフライン RSI（node/evolve.ts・node/harden.ts）"]
        direction TB
        RUN["基準版で検証用課題を測る<br/>node/measure.ts measure"]
        LOG[("セッションの runs・calls 表<br/>実行記録と費用")]
        WEAK["弱点の抽出: 成功と失敗の応答を対比<br/>weakness（explore のとき）"]
        ARCH[("系統: candidates 表<br/>コミットは refs/hypharness/")]
        PARENT["親を成功率に比例して選ぶ<br/>choose"]
        POLICY["改善対象を UCB1 で選ぶ<br/>prompt・module・spec・code<br/>ucb"]
        IMPROVE["親自身が agent/ を直す<br/>improve（変更は120行まで）"]
        META["固定部の変更の提案<br/>/work/META.patch → proposals 表"]
        GATE{"門番: agent/ の外を変えていない・型検査・<br/>agent/ のテスト・自己編集できる<br/>gate"}
        FILTER["批評役が不要な変更を指摘し、<br/>除いた候補が門番を通ればそちらを使う<br/>filter"]
        MEASURE1["1回測って系統に記録<br/>measureCandidate"]
        PROMOTE["上位の候補を5回ずつ測り直す<br/>最初の1回は判定に使わない<br/>promote"]
        COMPARE{"検証用で確かに上回り、<br/>成績用で確かに下回らないか<br/>（差 > 差のばらつきの2倍）"}
        HARDEN["課題の強化: 基準版が20〜80%解く課題を足し、<br/>毎回解ける課題を外す<br/>harden"]
        PR["成功した試行の差分を対象のリポジトリに PR<br/>node/pr.ts"]

        RUN --> LOG
        LOG --> WEAK --> IMPROVE
        ARCH --> PARENT --> POLICY --> IMPROVE
        IMPROVE --> META
        IMPROVE --> GATE
        GATE -->|"いいえ"| ARCH
        GATE -->|"はい"| FILTER --> MEASURE1 --> ARCH
        ARCH --> PROMOTE --> COMPARE
        LOG --> HARDEN --> EVO_TASKS
        LOG --> PR
    end

    subgraph RELEASE["試験配備（node/deploy.ts）"]
        CANARY["ノードがタスクの25%を試験版で解く"]
        RGATE{"判定付きの結果で稼働版と比べる"}
        STABLE["試験版を稼働版にする"]
        BACK["試験版を外し、基準版を稼働版に戻す"]
        CANARY --> RGATE
        RGATE -->|"10件で下回らない"| STABLE
        RGATE -->|"確かに下回る"| BACK
    end

    COMPARE -->|"採用"| CANARY
    COMPARE -->|"改善量"| ALLOC
    STABLE --> H
    BACK --> H
    ALLOC -->|"自己改善・局所改善の予算"| IMPROVE
    ALLOC --> WORKER
    MEMO --> HEAD

    subgraph INFRA["③ 分散基盤"]
        direction TB
        UI["画面（src/pages/Home.tsx）<br/>ノード・資源配分・進化の系統・提案の承認・タスク"]
        subgraph CONTROL["中継（Cloudflare Workers + Durable Object。src/relay.ts・src/queue.ts）"]
            REGISTRY["ノードの登録とペアリング<br/>src/accounts.ts"]
            RELAY_Q[("待ち行列: task（目的遂行）と trial（計測の試行）<br/>実行権: 期限45秒・世代番号")]
            EVOL[("evolution・approvals 表<br/>系統と提案の番号・状態・数値だけ")]
        end
        CAS[("R2: 内容の SHA-256 をキーにした CAS<br/>チェックポイント・試行の中身と結果<br/>ノードが AES-GCM で暗号化")]
        subgraph NODE["ノード（node/index.ts）"]
            NODE_RUN["タスクを稼働版か試験版で解く"]
            TRIAL["配られた試行を解く<br/>node/trials.ts solveTrial"]
            CHECKPOINT["作業領域を20秒ごとに暗号化して保存"]
            STATE[("~/.hyph/state/セッション名<br/>エージェントの状態")]
            SANDBOX["bubblewrap + systemd scope<br/>1つ4GB・合計10GB<br/>node/sandbox.ts"]
            APPROVE["承認された提案を PR にする<br/>approve"]
        end
        SUBMIT["計測する側（HYPH_TRIALS=relay）<br/>remoteAttempt"]

        UI <--> REGISTRY
        UI -->|"承認"| EVOL
        RELAY_Q -->|"実行権"| NODE_RUN
        RELAY_Q -->|"実行権"| TRIAL
        SUBMIT -->|"暗号化した中身"| CAS
        SUBMIT --> RELAY_Q
        TRIAL --> CAS
        CHECKPOINT --> CAS
        CAS -->|"期限切れで別のノードが再開"| NODE_RUN
        NODE_RUN --> SANDBOX
        TRIAL --> SANDBOX
        NODE_RUN --> STATE
        EVOL -->|"approve"| APPROVE
        NODE -->|"系統・提案・資源配分を1分ごと"| EVOL
    end

    RUN -.-> SUBMIT
    SANDBOX -.->|"実行環境"| MAIN
    STATE -.->|"/state"| MEM
    NODE_RUN -->|"成否を outcome.json に"| STATE
    ARCH -.-> EVOL
    META -.-> EVOL
    APPROVE -.->|"hypharness への PR"| H

    classDef storage fill:#e2eee9,stroke:#40866b,color:#123b2c
    classDef compute fill:#e4ebfa,stroke:#567db8,color:#193965
    classDef active fill:#f8edda,stroke:#bd8a3c,color:#593b10

    class RAW,ENTRIES,SOURCES,LINKS,LOG,ARCH,EVO_TASKS,RELAY_Q,EVOL,CAS,STATE,MEMO storage
    class SELECT,HEAD,APPLY,ALLOC,FILTER,POLICY,PARENT compute
    class API,DECIDE,COMPACT,GATE,COMPARE,LOCALGATE,RGATE active
```

## 目標の図との違い

| 目標の図の要素                                                                 | 実装                                                                                                                                                                                 |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. 永続記憶（LCM 原文・DeLM 共有記憶と自己記憶・索引・参照グラフ・管轄の統合） | `agent/memory.ts`。原文・記憶・根拠・参照関係を `/state/memory.sqlite` に置く。管轄の分割・統合は、要旨の3文字組の一致率 0.6 以上で統合することだけで行う                            |
| B. 文脈選択（VISTA・RECAP 代替）                                               | 全文検索の順位・参照のつながり・評価で並べる。埋め込みによる意味検索はない（隔離環境から埋め込みの API を呼ぶ経路がない）                                                            |
| C. 作業文脈（CLM・TokenPilot）                                                 | 編集はモデルが提案し、検証して貯め、圧縮のときにまとめて反映する。作業メモは最初のメッセージに置く                                                                                   |
| D. 推論・実行（子エージェント）                                                | `delegate` は親だけが使え、子は1段まで                                                                                                                                               |
| E. オンライン RSI                                                              | 2つある。実行中は、課題の成否で記憶の評価を上下させ、3回失敗に関わった記憶を外す（`memory.judge`）。期ごとには、`node/ideas.ts` の経済のループが方針を検証用課題で測って採否を決める |
| DeLM（目的分解・担当選択）                                                     | `delegate` による部分目的の切り出しだけ。複数の担当エージェントを選ぶ仕組みはない                                                                                                    |
| ② A〜C                                                                         | 図のとおり。SpecForge は改善対象 `spec` と `agent/SPEC.md`、RRSI の批評は `filter`                                                                                                   |
| ② META                                                                         | 自動では採用しない。改善役が `META.patch` を書くと提案として残り、画面か `approve` で承認すると PR になる                                                                            |
| ② D 配備・復旧                                                                 | 図のとおり（`node/deploy.ts`）                                                                                                                                                       |
| ③ Scheduler                                                                    | 中継の待ち行列が、接続中で実行権を持たないノードに先頭から割り当てる。1ノードに1つまで。計測の試行は `HYPH_TRIALS=relay` のときだけ中継に置く                                        |
| ③ CAS・確定チェックポイント                                                    | R2 に内容のハッシュで置く。Git は候補のコミット（`refs/hypharness/`）に使う                                                                                                          |
| ③ Agent State                                                                  | ノードの `~/.hyph/state/<セッション>` に置き、チェックポイントには入れない。別のノードで再開したタスクは、そのノードの状態で続ける                                                   |
