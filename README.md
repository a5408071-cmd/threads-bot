# threads-bot — 趣味用 Threads の自動投稿

鈴木個人の趣味用 Threads アカウント（匿名。ゴルフ・飲み仲間づくり）に、毎日2本、ランダムな時刻に AI が書いた投稿を自動で出す。
Cloud Run（サービス名 `threads-bot`、asia-northeast1、プロジェクト iso-bot-503303）で動く。イソ（iso-bot）とは別の仕組み。
設計は `docs/specs/2026-10-27-threads-bot-design.md`、作り方は `docs/superpowers/plans/2026-10-27-threads-bot.md`、最初の設定は `docs/setup-for-suzuki.md`。

## 何をするか

- 毎日 0 時過ぎに、その日の投稿時刻を 4 つ引く（朝 7:00〜10:00・昼 11:30〜14:30・夕 16:00〜19:00・夜 20:00〜23:30。週に 1 回くらいは 1 本少ない。2026-10-28 社長「毎日4投稿しよう」）
- 時刻になったら Claude（Opus 5.5）が「名古屋・愛知の30代経営者、エンジョイゴルファー」として本文を書き、検査（500 字・URL なし・NG 語なし・直近と似すぎない）を通ったものを Threads に投稿
- 社長が写真をイソに渡して「Threads に投稿しといて」と言えば、イソが `POST /api/post` で同じアカウントに投稿（本文は社長の言葉のまま）
- 1 時間に 1 回コメントを見に行き、新しいものがあればイソ経由で社長 DM に知らせる
- 鍵（60 日で切れる）は残り 10 日を切ると自動で延ばす。延ばせなければ社長 DM に知らせる

## 写真

本物の写真を Drive の **イソ保管庫/共通/Threads写真/**（`THREADS_PHOTO_FOLDER_ID`）にためておくと、**2 本に 1 本**（直前の投稿に写真があれば今回は文字だけ。2026-10-28 社長「2つに1回は画像なしで文字だけシンプルに」）付ける。文字だけの回は 100〜180 字でシンプルに、写真ありは 150〜300 字。同じ写真は 60 日あける（在庫が尽きたら一番前に使ったものを使い回す）。
AI は写真を見て写っているものに合う文を書く（いつ・どこで撮ったかは断定しない）。フォルダは Cloud Run のサービスアカウントに閲覧者で共有してある。iPhone の HEIC は heic-convert で JPEG に直し、長辺 2000px に縮めて自分の `/media/photo/<ID>.jpg?sig=…` で公開する（Meta が取りに来る）。
写真が取れなければ写真なしで投稿する。`/cron/tick?dry=1&photo=1` で写真付きの文を確かめられる。`/cron/tick?post=1`（`&photo=1` で写真必須）は枠に関係なく今すぐ 1 本投稿する。

## 写真の付け方（2026-10-28 社長「写真そんなに在庫ないなー」→ 案1）

- **4 本に 1 本**（`THREADS_PHOTO_EVERY` 既定 4。直近 3 本に写真が無ければ付ける）
- ゴルフの型（質問・あるある・誘い・小ネタ・問いかけ）→ 社長の写真（Drive の Threads写真）。無ければストックで代用
- ゴルフ以外の型（日常・季節・時事）→ **ストック写真（Pixabay。無料・商用可・クレジット不要）**。文を先に書き、AI が付けた「写真: <英語の検索語>」で検索し、横長の 1 枚を選ぶ（同じ写真は 180 日あける）。画像 URL を実際に開いて確かめてから Meta に渡す。鍵は `PIXABAY_API_KEY`（Secret `pixabay-api-key`）。鍵が無ければ写真なし
- 文は「自分が撮った」とは書かない（「こういう季節が好き」の言い方）

## 成長の仕組み（2026-10-28 社長「1か月以内でフォロワー500人」「どうすれば増えるかは日々自分で考えて」）

- **毎朝 7:00〜7:09 の見回り**で `growth.daily`: フォロワー数（`/me/threads_insights?metric=followers_count`）と直近 7 日の投稿の数字（表示・いいね・返信・再投稿・引用）を Firestore に記録（`threads_metrics/<日付>`、`threads_posts.insights`）
- **月曜**は `growth.weekly`: 直近 7 日を AI に見せて、型ごとの配分（`threads_config/strategy.weights`）と短い報告を作り、社長 DM へ。以後の投稿は `pickType` がその配分で型を選ぶ
- **コメントへの返事は自動**（`THREADS_AUTO_REPLY=true`。`src/replies.js`）: 新しいコメントに人物像で 1〜2 文の返事を書いて投稿し、社長 DM に「コメント ↩ 返事」を並べて知らせる。営業・荒らし・意味不明は返事しない（AI が SKIP）
- 権限 `threads_manage_insights`・`threads_manage_replies` が要る（`/oauth/start` で接続し直す。Meta のアプリ側でも権限を足す）
- **他人の投稿へのコメント（検索して絡む）は未実装**: `/keyword_search` は Meta の App Review（審査）を通さないと自分の投稿しか検索できない（公式の記述）。審査は会社名での申請になる

## 話題とタグ

型は 8 つ（質問・あるある・誘い・季節・小ネタ・問いかけ・**日常**・**時事**）。日常と時事はゴルフ以外で、3 回に 1 回くらい出る（2026-10-28 社長「ゴルフ以外の季節とか時事とか関係ない話も」）。
時事は Claude のウェブ検索（`web_search_20260209`）で今日の明るい話題を確かめてから書く（政治・事件・事故・災害・訃報・不祥事は選ばない。`src/persona.js` の news）。
タグは Threads のトピックタグ（1 投稿 1 つ、`topic_tag`）。AI が「タグ: 〇〇」の行で選び、無ければ型ごとの既定（ゴルフ／名古屋）。候補は `src/persona.js` の `TAG_HINTS`。

## 入口

| パス | 認証 | 動き |
|---|---|---|
| `GET /health` | なし | `{ok:true}`（`/healthz` は Cloud Run の入口が横取りして 404 になる） |
| `GET /cron/tick` | `X-Cron-Key` ヘッダ か `?key=` | 10 分おきの見回り（Cloud Scheduler `threads-tick`）。`?dry=1` は投稿せず文を返す、`?test=1` は文を社長 DM に送るだけ |
| `GET /admin/status` | 同上 | 今日の枠・投稿済み・鍵の残り日数・直近の投稿（鍵そのものは返さない） |
| `POST /api/post` | 同上 | イソからの投稿。JSON `{text, imageUrl?, preview?, force?}`。`preview:true` は投稿しない。NG 語は 400（`force:true` で通す） |
| `GET /oauth/start?key=…` | `?key=` | 社長が**新しいアカウントでログインしたブラウザ**で開く → Threads の許可画面へ |
| `GET /oauth/callback` | state | Threads から戻る。鍵を Firestore に保存 |

## 環境変数

| 名前 | 中身 |
|---|---|
| `CRON_KEY` | 見回り・API の合言葉（Secret Manager `threads-cron-key`） |
| `THREADS_APP_ID` / `THREADS_APP_SECRET` | Meta のアプリ ID とシークレット（シークレットは Secret `threads-app-secret`） |
| `PUBLIC_BASE_URL` | このサービスの URL（OAuth の戻り先に使う） |
| `ANTHROPIC_API_KEY` | Secret `anthropic-api-key`（イソと同じ） |
| `ISO_BOT_URL` / `ISO_CRON_KEY` | 社長 DM に知らせるためのイソの URL と鍵（Secret `cron-key`＝イソと同じものを参照。写しを別に持たない） |
| `THREADS_MODEL` | 既定 `claude-opus-5-5` |
| `THREADS_BANNED_WORDS` | 書かない語（`;` 区切り。会社名・本名・店名・ゴルフ場名） |
| `THREADS_ENABLED` | `false` で全部止める（見回りも API も） |
| `THREADS_AUTO_POST` | `false` で自動投稿だけ止める（イソからの投稿は残る） |
| `THREADS_COPY_TO_OWNER` | `true` なら出した文の写しを社長 DM にも送る（最初の 1 週間だけ） |
| `THREADS_PHOTO_FOLDER_ID` | 写真のフォルダ ID（写真は 4 本に 1 本） |
| `THREADS_AUTO_REPLY` | `true` でコメントに自動で返事（既定は知らせるだけ） |
| `THREADS_SLOT_GRACE_MIN` | 枠の時刻を何分過ぎたら諦めるか（既定 60。止まっていた間の枠を深夜にまとめて出さないため） |
| `TZ` | `Asia/Tokyo` |

## 困ったとき

- **全部止める**: `gcloud run services update threads-bot --region asia-northeast1 --update-env-vars THREADS_ENABLED=false`
- **戻す**: 同じコマンドで `THREADS_ENABLED=true`
- **文体を直す**: `src/persona.js` を直して deploy（人物像・見本・禁止事項がここにある）
- **鍵が切れた・「鍵が入っていません」の DM が来た**: 新しいアカウントでログインしたブラウザで `https://<サービスURL>/oauth/start?key=<CRON_KEY>` を開く
- **様子を見る**: `curl -H "X-Cron-Key: <鍵>" https://<サービスURL>/admin/status`
- **出してしまった投稿を消す**: Threads のアプリで消す（API に削除は無い）
- **今すぐ 1 本書かせて見る（投稿しない）**: `/cron/tick?test=1`（社長 DM に届く）

## デプロイ

```
cd C:\Users\WDP\threads-bot
git pull
gcloud run deploy threads-bot --source . --region asia-northeast1 --project iso-bot-503303
```

## テスト

`npx jest`（外部にはつながない。Firestore・Anthropic・Threads・イソはすべてスタブ）

## 作り

- `src/server.js` … HTTP の入口
- `src/tick.js` … 見回りの手順
- `src/slots.js` … 投稿時刻を引く・時刻が来たか判定
- `src/writer.js` + `src/persona.js` … 本文を書く・検査する
- `src/threads.js` … Threads API
- `src/replies.js` … コメントの取得と知らせ
- `src/notify.js` … イソ経由で社長 DM
- `src/store.js` … Firestore（コレクションは `threads_` 接頭辞）

## 時間の上限（止まったときの記録がずれないように）

- Cloud Run の `--timeout 300`、Cloud Scheduler `threads-tick` の `--attempt-deadline 300s`（どちらも設定済み）
- AI の呼び出しは 60 秒・再試行 2 回（`src/server.js`）。書き直し 3 回＋写真の処理待ち 60 秒でも 300 秒に収まる
- 投稿の途中で止まった枠は、60 分後の見回りが「投稿中に止まった可能性。Threads を確認」と社長 DM に知らせる
