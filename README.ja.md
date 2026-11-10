[English](README.md) | [한국어](README.ko.md) | 日本語 | [中文](README.zh.md) | [Español](README.es.md)

# whosup

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png">
    <img src="assets/logo.png" alt="whosup" width="360">
  </picture>
</p>

> **もうセッションを放置しない。** whosup は herdr のすべてのセッションを1枚のボードにまとめ、次に見るべきペインを教えます。

[herdr](https://herdr.dev) のペインでコーディングエージェントを6個、10個、15個と走らせていると、動いているもの、1時間前に終わったもの、気づかないまま権限確認で止まっているものが混ざります。whosup は、実行中のすべての herdr セッションのすべてのペインをブラウザの1ページにまとめます。入力待ち、いま終わったもの、まだ実行中のもの、静かになったもの。セルをクリックすると herdr がそのペインへ移動します。

<p align="center">
  <img src="assets/hero.png" alt="whosup — 散らばって忘れられたターミナルセッションを1枚のボードに。次に見るペインだけがオレンジ" width="900">
</p>

[クイックスタート](#クイックスタート) • [なぜwhosupなのか](#なぜwhosupなのか) • [画面の見方](#画面の見方) • [仕組み](#仕組み) • [機能](#機能) • [設定](#設定) • [動作要件](#動作要件)

---

## クイックスタート

### 1. herdr プラグインをインストール

```bash
herdr plugin install fivetaku/whosup --yes
```

### 2. 起動する(または herdr を再起動するだけ)

```bash
herdr plugin action invoke fivetaku.whosup.start
```

ボードは `http://127.0.0.1:4790` で起動し、ブラウザが一度だけ開きます。以降は herdr と一緒に起動します。

### 3. herdr セッションは好きなだけ追加

```bash
herdr --session work      # 名前もターミナルも自由
```

実行中のセッションは自動でボードに表示されます。管理するリストはありません。

---

## なぜwhosupなのか

- **ペインを見回らなくて済みます。** 上部のバンドに、入力待ち・失敗・完了・実行中のペイン数が出ます。**next** 行は最初に見るべきペインを1つ示し、そのエージェントが尋ねている質問も引用します。
- **1クリックで目的のペインへ。** セルをクリックすると、どのセッションのどのタブにあっても herdr がそのペインにフォーカスします。macOS ではターミナルアプリも前面に出せます。
- **再起動しても会話は失われません。** 再起動後、herdr はペインを復元しますがエージェントは復元しません。空のセルには **resume** ボタンが出て、そのフォルダの最新の Claude Code の会話を探し、ペイン内で `AGENT_CMD --resume <id>` を実行します。resume が読むのは Claude Code の会話履歴だけで、ほかのエージェントは新しい会話として始まります。
- **色には意味があります。** 基本は白黒、次に見るべき1つだけオレンジ、失敗は赤。点滅し続けるものはありません。
- **別のウィンドウにいても知らせます。** タブのタイトルに待っているペイン数が `(3) whosup` のように出て、ファビコンのオレンジのマスが点きます。いま手を挙げたセルにはオレンジの枠が一度だけ走ります。ヘッダーの並び替えボタンで **by desk**(デスク順)と **neglected first**(放置順)を切り替えます。放置順では長く待っているペインが各デスクの先頭に集まります。ヘッダーの **alerts** をオンにするとデスクトップ通知が届き、クリックでそのペインへ移動します。
- **待っているペインを見失いません。** あなたを待つペインは対応するまでボードに残ります。日付が変わっても、再起動しても、herdr が一時的に応答しなくても同じです。**seen** は30分だけ先送りし、その後も待っていればまた上がってきます。閉じたペインは7日間、**stash**(保管)したペインは戻すまで **recently closed** 行に残り、そこから再開・復元できます。保管したペインが再び動き出すと自動で戻ります。いつも見るペインはピンで最上段に固定できます。
- **分からないときは分からないと言います。** herdr に届かないと、ヘッダーに *disconnected · last collect HH:MM* が出て、タブのタイトルは `(!) whosup`、ファビコンは灰色になります。古い画面を黙って見せ続けることはしません。
- **ライト、ダーク、言語。** モード(auto / light / dark)はヘッダーのボタンで、言語(English / 한국어)は **settings** パネルで切り替えます。日本語表示はないため、この README のボタン名は英語表示に合わせています。配色は実際の IDE テーマを参考にし、文字のコントラストは WCAG AA を保っています。

---

## 画面の見方

<p align="center">
  <img src="assets/board-light-en.png" alt="whosup ボード、ライト" width="900"><br>
  <img src="assets/board-dark-ko.png" alt="whosup ボード、ダーク、韓国語" width="900">
</p>

| 領域 | 意味 |
|---|---|
| **状態バンド** | 入力待ち・失敗・完了・実行中・アイドルのペイン数と全ペイン数、今日の要対応イベント数と、そのうち3分以内に対応した割合。数字をクリックするとその状態だけに絞り込みます。 |
| **next 行** | 最初に見るべきペイン1つとその理由(保留中の質問、失敗、届いた回答)。 |
| **デスク** | herdr セッションごとに1行(デスク)、ペイン順に1ペイン1セル。セルの見出し: ラベル · git ブランチ(ブランチがなければセッション名) · 状態。共通の順番で先頭から9つの待っているペインには 1〜9 の番号が付く(例 `needs input 3`、3 を押すとそのペインへ) · 待ち時間(実行中・アイドルのペインは最後のリクエストからの経過時間) · 失敗の種類(例 usage limit)と *unreachable* のタグ。その下に文脈の1行。 |
| **セルの1行** | エージェントが尋ねている質問(権限ボックス、フォルダ信頼の確認、A か B か)、最後の一文、またはあなたの最後のリクエスト。状態に応じて一番必要なもの1つ。 |
| **resume** | 再起動後の空のペインで、そのフォルダの最新の会話を再開します。 |
| **+ new pane** | セッションとフォルダを選ぶと、whosup がそこにタブを開き、エージェントを起動してフォーカスします。 |

---

## 仕組み

```
herdr sessions (main, side, …)
   └─ pane list + agent list, every 3 s  ──►  whosup collector  ──►  SQLite (node:sqlite)
                                                                       │
browser  ◄──  http://127.0.0.1:4790  ◄──  board server  ◄─────────────┘
   │
   └─ click  ──►  pane.focus over herdr's socket  ──►  the pane
```

Node プロセス1つだけで、ビルドは不要です。herdr の startup フックは一度だけ実行されるコマンドで、herdr の起動時に whosup をバックグラウンドのサーバーとして起動して終わります。その後サーバーは単独で動き続け、herdr が監視したり止めたりはしません。止めるには `stop` アクションを使います。ペインの状態は herdr のエージェント検出(working / blocked / done / idle)から、質問文はペインの画面から、最後のリクエストは Claude Code の会話履歴(`~/.claude/projects` または `CLAUDE_PROJECTS_DIR`)から読みます。ほかのエージェントのペインには最後のリクエストが表示されず、resume は新しい会話として始まります。

**信頼モデル。** サーバーは 127.0.0.1 だけで待ち受け、ログインはありません。ほかのサイトから来たブラウザの変更リクエストは拒否しますが、同じコンピューターで動くプログラムなら誰でも API を使えます。resume や new pane のときに whosup がペインに入力するコマンド `AGENT_CMD` などの設定も変えられます。ポートをほかの人に公開しないでください。サーバーは `Host` ヘッダーが `127.0.0.1`、`localhost`、`[::1]` 以外のリクエストに 403 `local only` を返します。そのため公開ホスト名を転送するトンネル(Tailscale Serve、cloudflared、ngrok)ではボードをまったく開けません。自分の別のマシンから見るときは `ssh -L 4790:127.0.0.1:4790 <host>` のように localhost のホストを保つポート転送を使って `http://localhost:4790` を開き、サーバーは `WHOSUP_READONLY=1` で起動します。読み取り専用が止めるのは変更で、閲覧ではありません。ホーム以下のフォルダ一覧は返しませんが、ボードに出るものはすべて見えます。セルのツールチップのフォルダパス、最後のリクエスト、質問の原文がそうで、`GET /api/settings` も `agent_cmd` を返します。

---

## 機能

| 機能 | 説明 |
|---|---|
| 自動検出 | 実行中のすべての herdr セッションとペインを設定なしで表示 |
| 要対応の状態 | needs input · failed · finished · running · idle · empty |
| 質問の抽出 | 権限ボックス、フォルダ信頼の確認、「A か B か」の質問を原文のまま表示 |
| ジャンプ | クリック → `pane.focus`。macOS では `FRONT_APP` でターミナルを前面に(任意) |
| resume | そのペイン自身の会話、なければほかのペインで動いていない、そのフォルダの最新の会話 → `AGENT_CMD --resume`。押す前にどの会話かボードに表示。Claude Code の会話のみ対応、ほかのエージェントは新しく始まる |
| new pane | セッションとフォルダを選び、エージェントのコマンドを実行 |
| デスク(任意) | モニターごとのセッションとペインを `desks.json` に宣言。`desks-apply` アクションが足りないものだけを作成(何度実行しても同じ結果) |
| 言語 | English、한국어(**settings** パネル、`?lang=`) |
| テーマ | auto / light / dark(ヘッダーのボタン、`?theme=`)、IDE の配色を調べて作ったパレット |
| 読み取り専用モード | `WHOSUP_READONLY=1` で操作ボタンと **+ new pane** を隠し、クリック・Enter・1〜9・`n`・通知のクリック・設定の変更を止め(設定パネルには言語の選択だけが出る)、フォルダ一覧も表示しない。止めるのは変更で、閲覧ではない — 信頼モデルを参照 |
| seen = 先送り | 待っているペインの **seen** は30分だけ隠し、**unsee** ですぐ戻す |
| ピン固定 | 固定したペインは並び順に関係なく、全デスクの上の固定行に表示 |
| stash と recently closed | アイドルのペインを保管。閉じたペインは7日間、保管したペインは戻すまで **recently closed** に残る。保管したペインが再び動くと自動で戻る |
| ひとつの順番 | next 行・Enter・1〜9・通知・放置順がすべて同じ順番: 失敗 → 入力待ち → 完了、待ち時間の長い順 |
| キーボード | `n`(韓国語配列なら `ㅜ`)で new pane · Enter で次のペインへ移動、パネルが開いていれば保存・作成 · 1〜9 で番号の付いたペインへ移動 · Esc でパネルを閉じる。入力欄に入力している間は `n` と 1〜9 を無視 |
| 再通知 | 待ったままのペインは15分ごとに最大4回再通知、対応すると通知を閉じる |
| macOS 通知(任意) | タブを閉じていてもサーバーが macOS 通知を送る — 既定はオフ |
| 画面分割(任意、macOS) | ペインをクリックするとボードを画面の左に、ターミナルを残りに配置(`split_pct`)。既定はオフ、`FRONT_APP` とアクセシビリティ権限が必要 |
| 正直な状態表示 | ヘッダーに最終収集時刻、収集が止まると *disconnected*、herdr に確認できないセッションのペインは残したまま *unreachable* と表示 |
| 設定パネル | ヘッダーの **settings**: 先送り時間・再通知の間隔と回数・閉じたとみなす基準・切断警告・recently closed の保持日数・放置の目安日数・macOS 通知・unreachable の判定時間・画面分割・エージェントのコマンド。読み取り専用モードでは言語の選択だけを表示 |

### プラグインアクション

| アクション | 内容 |
|---|---|
| `fivetaku.whosup.start` | ボードを起動(herdr 起動時にも実行) |
| `fivetaku.whosup.stop` | 停止 |
| `fivetaku.whosup.status` | URL(ポート)と PID |
| `fivetaku.whosup.open` | ブラウザでボードを開く |
| `fivetaku.whosup.desks-apply` | `desks.json` からセッションとペインを作成 |
| `fivetaku.whosup.desks-status` | 宣言したペインと実際のペインを比較 |

---

## 設定

プラグインの設定フォルダ(`herdr plugin config-dir fivetaku.whosup`。herdr の外で動かすときは `~/.config/whosup`)の `.env` に `KEY=value` の行を書きます。このファイルは `start` がサーバーを起動するときにだけ読まれるので、変更したら `stop` アクションを実行してから `start` を実行します。`desks-apply` アクションは `.env` を読まず、エージェントのコマンドを `desks.json` の `agent_cmd` から取ります。

| キー | 既定値 | 意味 |
|---|---|---|
| `PORT` | 4790 | 使用中なら次の空きポートを使用 |
| `OPEN_BROWSER` | 1 | herdr 起動時にタブを一度だけ開く |
| `AGENT_CMD` | claude | resume と new pane で使うコマンド。ラッパーを使うならここに。**settings** パネルで変えた値が優先 |
| `FRONT_APP` | 未設定 | ジャンプ時に前面に出す macOS アプリ(例: `Ghostty`) |
| `STALE_DAYS`(または `WHOSUP_STALE_DAYS`) | 3 | この日数動きがないペインを保管候補として表示 |
| `WHOSUP_READONLY` | 0 | 1 で読み取り専用: 変更不可、フォルダ一覧も非表示 |
| `WHOSUP_SEEN_SNOOZE_MIN` · `WHOSUP_RENOTIFY_MIN` · `WHOSUP_RENOTIFY_MAX` · `WHOSUP_GONE_MISSES` · `WHOSUP_STALE_COLLECT_SEC` · `WHOSUP_CLOSED_KEEP_DAYS` · `WHOSUP_OS_NOTIFY` · `WHOSUP_UNREACHABLE_TTL_H` · `WHOSUP_SPLIT_PCT` | 30 · 15 · 4 · 3 · 30 · 7 · 0 · 24 · 0 | 初期値。ヘッダーの **settings** パネルで変えた値がこのコンピューターで優先 |
| `WHOSUP_INTERVAL` | 3 | 収集間隔(秒) |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | resume と最後のリクエストが Claude Code の会話を探すフォルダ |
| `HERDR_BIN_PATH`(または `HERDR_BIN`) | 自動 | herdr 実行ファイルのパス。未設定なら `/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`、`PATH` の順に探す |

### デスク(任意)

「モニターごとに herdr セッションを1つ」のように配置を固定したいなら、一度書いておけば whosup が作ります。

```json
{ "agent_cmd": "claude",
  "desks": [
    { "session": "main", "note": "left monitor", "agent": true,
      "panes": [ { "label": "api", "cwd": "~/src/api" }, { "label": "web", "cwd": "~/src/web" } ] },
    { "session": "side", "panes": [ { "label": "notes", "cwd": "~/notes" } ] }
  ] }
```

これをプラグインの設定フォルダ(`herdr plugin config-dir fivetaku.whosup`。herdr の外で動かすときは `~/.config/whosup`)に `desks.json` として保存し、`herdr plugin action invoke fivetaku.whosup.desks-apply` を実行します。足りないものを追加するだけです。ターミナルはセッションごとに好きな場所で開いてください(`herdr --session main`)。

### エージェントの復元

herdr は再起動後にエージェントを自分で起動し直すこともできます(`[session] resume_agents_on_restore`)。ラッパー経由でエージェントを起動しているなら、これを `false` にして whosup の **resume** を使ってください。そうすればラッパーが使われます。

---

## 動作要件

- [herdr](https://herdr.dev) 0.9.0 以降
- Node.js 22.13 以降(`node:sqlite` をフラグなしで使用)。bun もビルドも不要
- curl(`start`・`status`・`open` アクションが稼働確認に使用)
- macOS または Linux

---

## whosup ではないもの

ターミナルのミラーリング、チャット、スマホからの入力は [ovis](https://github.com/devswha/ovis)。カンバンで動かすエージェントは herdr-board。whosup は見ることとジャンプすることだけを行います。

## ライセンス

MIT — [LICENSE](LICENSE) を参照。

---

<div align="center">

**一度見て、呼んでいるペインへジャンプ。**

</div>
