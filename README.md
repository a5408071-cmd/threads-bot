# threads-bot — 趣味用 Threads の自動投稿

鈴木個人の趣味用 Threads アカウント（匿名。ゴルフ・飲み仲間づくり）に、毎日2本、ランダムな時刻に AI が書いた投稿を自動で出す。
Cloud Run（サービス名 `threads-bot`、asia-northeast1、プロジェクト iso-bot-503303）で動く。イソ（iso-bot）とは別の仕組み。
設計は `docs/specs/2026-10-27-threads-bot-design.md`、作り方は `docs/superpowers/plans/2026-10-27-threads-bot.md`、最初の設定は `docs/setup-for-suzuki.md`。

## 何をするか

- 毎日 0 時過ぎに、その日の投稿時刻を 2 つ引く（1 本目 7:00〜13:30、2 本目 17:30〜23:00。週に 1 回くらいは 1 本だけ）
- 時刻になったら Claude（Opus 5.5）が「名古屋・愛知の30代経営者、エンジョイゴルファー」として本文を書き、検査（500 字・URL なし・NG 語なし・直近と似すぎない）を通ったものを Threads に投稿
- 社長が写真をイソに渡して「Threads に投稿しといて」と言えば、イソが `POST /api/post` で同じアカウントに投稿（本文は社長の言葉のまま）
- 1 時間に 1 回コメントを見に行き、新しいものがあればイソ経由で社長 DM に知らせる
- 鍵（60 日で切れる）は残り 10 日を切ると自動で延ばす。延ばせなければ社長 DM に知らせる

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
