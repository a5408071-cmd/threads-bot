# Meta App Review（審査）の出し方 — threads_keyword_search の本番利用

2026-10-28 社長「審査を出す」。目的: 公開投稿をキーワードで検索して、関心の近い人の投稿に一言コメントする（フォロワー増やしの一番の伸びしろ）。
Meta の決まりで、`threads_keyword_search` は審査を通すまで「自分の投稿しか検索できない」。

## 全体の流れ（社長の操作 ＋ こちらの準備）

| # | 誰 | やること | 所要 |
|---|---|---|---|
| 1 | 社長 | **ビジネス認証**: Meta ビジネスマネージャで会社（ウッドデザインパーク株式会社）を認証。登記事項証明書か公共料金の請求書などの画像を出す。Meta 内部の確認で、Threads 上には出ない | 10 分＋Meta の確認 1〜3 日 |
| 2 | 社長 | アプリの基本設定: 表示名・アプリアイコン（下記で用意）・カテゴリ・プライバシーポリシー URL・利用規約 URL・データ削除 URL（下記）を入れる | 5 分 |
| 3 | 社長 | 「アプリレビュー」→「権限と機能」→ `threads_keyword_search` の **「詳細アクセスをリクエスト」** → 説明文（下記）を貼り、画面録画を添付して送信 | 10 分 |
| 4 | こちら | 画面録画に使う「デモ画面」をサービスに用意（検索 → 結果 → コメント投稿 の流れが見える 1 ページ） | 審査の前に |
| 5 | Meta | 審査（数日〜2 週間）。差し戻しがあれば文面・録画を直して再提出 | — |

## 2 で入れる URL（すべて公開済み）

- プライバシーポリシー: https://threads-bot-777525372244.asia-northeast1.run.app/privacy
- 利用規約: https://threads-bot-777525372244.asia-northeast1.run.app/terms
- データ削除の案内: https://threads-bot-777525372244.asia-northeast1.run.app/data-deletion
- アプリアイコン（1024×1024 PNG）: `docs/app-icon.png`（このリポジトリ）

## 3 で貼る説明文

### 日本語（画面が日本語のとき）

> このアプリは、アプリ所有者本人（1 名）が自分の Threads アカウントを運用するための個人用ツールです。一般公開はしていません。
> threads_keyword_search は、所有者の関心（ゴルフ、ランニング、マラソン、名古屋）に関する公開投稿を 1 日に数回検索し、その中から所有者が返信したい投稿を見つけるために使います。検索結果は所有者にだけ表示され、保存は投稿 ID と本文の一部を最大 90 日、重複して返信しないための記録としてのみ行います。検索結果を第三者に提供したり、分析データとして販売したりすることはありません。
> 使い方: 1) 所有者が Threads でログイン（OAuth） 2) キーワードを入れて検索（/keyword_search） 3) 一覧から投稿を選び、返信を書いて投稿（/me/threads に reply_to_id 付きで作成 → /threads_publish）。

### English

> This app is a personal tool used by a single person (the app owner) to manage their own Threads account. It is not offered to the public.
> We use threads_keyword_search to search public posts about the owner's interests (golf, running, marathon, Nagoya) a few times a day, so the owner can find posts they want to reply to. Results are shown only to the owner. We store only the post ID and a short excerpt for up to 90 days, solely to avoid replying to the same post twice. We never share search results with third parties or sell them as analytics.
> Flow: 1) the owner logs in with Threads (OAuth); 2) enters a keyword and searches (/keyword_search); 3) picks a post from the list, writes a reply and publishes it (create on /me/threads with reply_to_id, then /threads_publish).

## 画面録画に写すもの（4 で用意するデモ画面を使う）

1. ブラウザで `https://threads-bot-777525372244.asia-northeast1.run.app/demo?key=…` を開く（鍵付き。審査員には録画だけ見せる）
2. 「Threads でログイン」を押す → Threads の許可画面 → 戻ってくる（OAuth の流れ）
3. キーワード「ゴルフ」を入れて検索 → 投稿の一覧が出る（審査前は自分の投稿だけ出るが、それで構わない）
4. 一覧の 1 件を選び、返信を書いて「投稿」→ Threads 上に返信が付いたことを Threads のアプリ画面で見せる
5. 録画は 2〜3 分、音声なしでよい。画面の文字が読める大きさで

## 審査員向けの補足（提出フォームの「テスト手順」欄）

> The app is single-user (owner only). To reproduce: open the demo URL provided below (includes an access key), click "Log in with Threads" using the Threads tester account, search a keyword, pick a result and publish a reply. No other account can sign up.
> Demo URL: https://threads-bot-777525372244.asia-northeast1.run.app/demo?key=（審査提出時に発行する鍵）

## 注意

- ビジネス認証は Meta の社内確認で、Threads のプロフィールや投稿には何も出ない
- 審査中もいまの機能（自動投稿・コメントへの返事・数字の記録）はそのまま動く
- 通ったら threads-bot の「他人の投稿にコメント」を有効にする（`THREADS_ENGAGE=true`。実装は審査が通ってから）
