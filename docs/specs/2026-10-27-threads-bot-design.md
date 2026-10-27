# threads-bot 設計書（2026-10-27）

鈴木社長個人の趣味用 Threads アカウントに、毎日2回 AI が投稿文を書いて自動で投稿する仕組み。
会社の仕事ではなく、ゴルフ・飲み仲間をリアルで増やすための匿名アカウント。
iso-bot とは別のリポジトリ・別の Cloud Run サービスとして作る（社長「イソの中に作る必要ある？」→ 不要）。

## 1. ねらい

- **ゴール**: Threads 上でゴルフ・飲み会の話題で人とつながり、最終的にラウンド仲間・飲み仲間とリアルで会う
- **社長がやること**: 基本は何もしない（「毎日勝手に自動で投稿していってほしい」）。たまに写真をイソに渡して「Threads に投稿しといて」と言う。コメントが付いたらイソの DM で知り、返信は社長の手で行う
- **自動投稿っぽく見せない**（社長「自動投稿っぽくない感じにしよ」）: 投稿の時刻は毎日ばらす、話題の型を回す、言い回しの繰り返しを避ける

## 2. 出していいこと・出さないこと

### 人物像（投稿に書いてよい本当のこと。社長が確定）
- 名古屋・愛知の30代経営者
- エンジョイゴルファー。スコア 90〜100 くらいで楽しむ派。初心者歓迎
- 20代・30代を特に歓迎、40代も OK
- よく行くのは三重・岐阜
- お酒は何でも飲める。一杯から付き合える
- 話し方: 普通の敬体で明るく、テンション高め。絵文字は1本に 0〜2個（「笑」も可）

### 書かないこと（アンチゴール）
- 会社名・本名・店名など、社長個人や会社に結び付くもの（社長「会社や実名はいらん」）
- 個別のゴルフ場の名前（三重・岐阜という地域名は OK）
- **作り話のラウンド報告・飲み会報告**（「昨日〇〇で90切りました」のような、実際に起きていない出来事）。リアルで会ったときに話が合わなくなるため。本当の出来事は社長が写真を渡したときだけ載せる（私の判断、社長了承）
- 政治・宗教・他人への悪口・特定の人や店への批判
- 宣伝・リンク・ハッシュタグの羅列（コミュニティ目的なので人に話しかける文だけ）

### 投稿の型（日ごとにローテーション。同じ型が2日続かない）
1. **質問型**: 「名古屋で平日ゴルフ行ける人いませんか」「二軒目どこ派？」
2. **あるある型**: ゴルフ・飲み会のあるある
3. **誘い型**: 「今週末岐阜あたりでゆるく回りたい」（金・土・日・祝前日に出やすくする）
4. **季節・天気ネタ**: 暑い・寒い・梅雨・年末の忘年会シーズン など（日付と季節から）
5. **小ネタ**: 道具・練習・お酒の銘柄の話（特定の商品を推さない）
6. **返しやすい一言**: 「今日のベストショットは？」のような、コメントしやすい短い問いかけ

長さは 300 字まで（Threads の上限は 500 字。短いほうが人っぽい）。見本（社長 OK 済み）:

> 名古屋で平日ゴルフ行ける人、いませんか！？⛳
> 三重・岐阜は平日ガラガラで安くて最高なのに、周りが土日派ばっかりで寂しいです笑
> 30代、スコア90〜100で楽しむ派。20代・30代大歓迎、40代ももちろんOKです！気軽にコメントください🙌

## 3. 投稿の時刻

- 1日 **2本**（社長指示）
  - 1本目: 7:00〜13:30 のどこか
  - 2本目: 17:30〜23:00 のどこか
- 毎日 0:00 JST を過ぎた最初の見回りで、その日の2つの時刻を分単位でランダムに引く（「:00」「:30」ちょうどは避ける）。Firestore `threads_days/<YYYY-MM-DD>` に `{slots:[…], posted:[…]}`
- **週に1回くらい（確率 1/7）は1本だけ**にして人間っぽいムラを出す（私の判断）
- 2本の間は3時間以上あける
- 見回り（Cloud Scheduler → `/cron/tick`）は **10分おき**。時刻を過ぎていて未投稿の枠があれば、トランザクションで「投稿中」の印を先に付けてから投稿する（iso-bot の scheduledTasks と同じ）
- 1日の投稿数は **最大2**（イソ経由の写真投稿は別枠。写真投稿があった日は自動投稿を1本減らさない＝社長の実体験は多いほどよい）

## 4. 構成

### 置き場所
- GitHub: 社長個人アカウント **a5408071-cmd** の非公開リポジトリ `threads-bot`（社長がブラウザで作る。この PC に gh もトークンも無い＝memory github-accounts-and-repos）
- ローカル: `C:\Users\WDP\threads-bot`
- Cloud Run: サービス名 `threads-bot`、プロジェクト `iso-bot-503303`、リージョン `asia-northeast1`（iso-bot・wdp-pace-board と同じ。社長が運用に慣れている）。メモリ 512Mi、最小インスタンス 0
- Firestore: 同じプロジェクトの既定データベース。コレクションは **`threads_` 接頭辞**で iso-bot のものと分ける
- Secret Manager: `threads-cron-key`（見回りの合言葉）、`threads-app-secret`（Meta アプリのシークレット）。iso-bot へ知らせるときの鍵は **iso-bot と同じ secret `cron-key` をそのまま参照**する（`--set-secrets ISO_CRON_KEY=cron-key:latest`。写しを別名で持つと rotate-cron-key.ps1 が古い版を無効化したときに通知だけが黙って 403 になるため＝レビュー指摘）。Anthropic の鍵も iso-bot と同じ secret を参照

### 言語・ライブラリ
- Node.js 20、Express、`@google-cloud/firestore`、`axios`、`@anthropic-ai/sdk`、jest（wdp-pace-board と同じ最小構成）
- 投稿文の生成: Claude **Opus 5.5**（`claude-opus-5-5`。1日2本なので費用はごくわずか。`THREADS_MODEL` で上書き）

### 主なファイル（builder が決めてよい。目安）
- `src/server.js` … Express。`/healthz`、`/cron/tick`、`/api/post`、`/oauth/start`、`/oauth/callback`、`/admin/status`
- `src/slots.js` … その日の時刻を引く・次に投稿すべき枠を判定（純関数、テストしやすく）
- `src/writer.js` … Claude に投稿文を書かせる（persona・型のローテーション・直近投稿の回避）
- `src/threads.js` … Threads API（コンテナ作成 → 公開、トークン更新、返信の取得）
- `src/replies.js` … 新しいコメントの検出と社長への知らせ
- `src/notify.js` … iso-bot の `/admin/post?to=owner` 経由で社長 DM に送る
- `src/store.js` … Firestore の読み書き
- `tests/` … jest。Anthropic・Threads・Firestore はスタブ（本物へつながない）

## 5. Threads API の使い方

公式: `https://graph.threads.net/v1.0/`。権限は `threads_basic`・`threads_content_publish`・`threads_read_replies`。

### 投稿
1. `POST /{threads-user-id}/threads` に `media_type=TEXT&text=…`（写真なら `media_type=IMAGE&image_url=…&text=…`）→ コンテナ ID
2. `GET /{container-id}?fields=status` が `FINISHED` になるまで数秒おきに待つ（最長 60 秒。Meta は 30 秒待つことを推奨）
3. `POST /{threads-user-id}/threads_publish?creation_id=…` → 投稿 ID
4. `GET /{media-id}?fields=permalink` で URL を取り、Firestore `threads_posts/<mediaId>` に `{text, type, postedAt, source:'auto'|'iso', permalink}` を残す

写真の `image_url` は **誰でも開ける URL** が必須（GBP と同じ制約）。イソ経由の写真は iso-bot の `/media/drive/<ID>.jpg?sig=…` を使う（§7）。

### トークン
- 初回: `/oauth/start` が `https://threads.net/oauth/authorize?client_id=…&redirect_uri=…&scope=…&response_type=code` へ飛ばし、`/oauth/callback` が code → 短期トークン（`/oauth/access_token`）→ 長期トークン（`/access_token?grant_type=th_exchange_token`、60日）に交換して Firestore `threads_config/token` に `{token, userId, expiresAt}` を保存。**コールバックは合言葉付き**（`/oauth/start?key=<cron-key>` で発行した state を照合。誰かが勝手に別アカウントを結び付けないため）
- 更新: 見回りで **残り 10 日を切ったら** `GET /refresh_access_token?grant_type=th_refresh_token` で延ばす（発行から 24 時間は更新できない）。失敗したら社長 DM に「⚠ Threads の鍵が切れそう。`/oauth/start` を開いて取り直して」と1回知らせる（12 時間に1回）
- トークンは Secret Manager ではなく Firestore に置く（60 日ごとにプログラムが書き換えるため）

### 返信（コメント）の取得
- 1時間に1回（見回り 6 回に1回）、直近 7 日の自分の投稿（`GET /me/threads?fields=id,permalink&since=…`）ごとに `GET /{media-id}/replies?fields=id,text,username,timestamp,permalink` を読む
- Firestore `threads_replies/<replyId>` に無いものを新着とし、社長 DM へ「💬 Threads にコメント: @username『本文』→ 投稿リンク」を1通にまとめて送る。初回は記録だけ（知らせない）
- Webhook（リアルタイム）は App Review＋ビジネス認証が要るので使わない。自分のアカウントをテスターにしておけば審査なしで読める見込み
- **開発モードで他人の返信が取れなかった場合は、返信の知らせを落として社長が Threads アプリで直接見る**（App Review は実名・会社名での申請になり「裏垢」の方針と衝突するので進まない。私の判断）。返信の取得は §12 の最後に回し、取れないと分かったらそこで打ち切る

### 制限
- 本文 500 字、投稿 250 本/24 時間、返信の投稿 1,000 本/24 時間（この仕組みは1日2〜3本なので当たらない）

## 6. 見回り `/cron/tick` の中身（10 分おき）

1. 合言葉チェック（`X-Cron-Key` ヘッダかクエリ `?key=`）
2. `THREADS_ENABLED=false` なら何もしない（緊急停止）
3. 今日の枠が無ければ引く（§3）
4. 時刻を過ぎた未投稿の枠があれば: 直近 14 本の投稿と直近 2 日の型を Firestore から取り → writer で本文を作る → **検査**（500 字以内、NG 語＝会社名・本名・ゴルフ場名のリスト `THREADS_BANNED_WORDS`、URL 無し、直近 14 本と 6 割以上同じ文でない）→ 投稿 → 記録。検査に落ちたら最大 2 回書き直させ、それでも落ちたらその枠は飛ばして社長 DM に「⚠ 今日の N 本目は出せませんでした（理由）」
5. トークンの残り日数を見て必要なら更新（§5）
6. 1 時間に 1 回、返信を取りに行く（§5）
7. 戻り値に `{slots, posted, skipped, replies, tokenDaysLeft, errors}`（失敗を 0 件に見せない）

### 手動確認
- `/cron/tick?dry=1` … 投稿せず、今書くならこの文、を返す（AI は呼ぶ）
- `/cron/tick?test=1` … 投稿せず、書いた文を **社長 DM** に送る（文体の調整用）
- `/admin/status` … 今日の枠・投稿済み・トークン残り日数・最後のエラー
- `/admin/post`（§7 と同じ口）を `?dry=1` で

### 慣らし期間（私の判断）
- 最初の 1 週間は `THREADS_COPY_TO_OWNER=true` にして、**投稿はしつつ、出した文の写しを社長 DM にも送る**。社長が「ここ直して」と言えば persona を直す。1 週間たったら写しを止める（DM を増やさない）

## 7. イソからの写真投稿

iso-bot 側に道具 **`post_to_threads`** を1つ足す（社長専用。社員の許可リストに入れない）。

- 使い方: 社長が DM で写真を送り「これ Threads に投稿しといて」「一言は『岐阜でゆるゴルフでした』で」
- 流れ: ①写真を Drive の イソ保管庫/共通/Threads/<年>/ に保存（`receipts.uploadGenericFile`）→ ② `gbpReviews.normalizePhotoUrl` で `/media/drive/<ID>.jpg?sig=…` の URL に → ③ threads-bot の `POST /api/post`（`X-Cron-Key`、JSON `{text, imageUrl, source:'iso'}`）→ ④返ってきた `permalink` を社長に返す
- 本文: 社長が一言を言えばそれをそのまま（AI で言い換えない）。言わなければイソが人物像に合わせて 1〜2 行書き、**投稿前に社長に見せて OK をもらう**（`preview=true` で threads-bot は投稿せず本文だけ返す）。会社名・本名・ゴルフ場名が入っていれば threads-bot 側の検査で止まり、イソは「『〇〇』が入っていますが出しますか」と聞く。**社長が「それでも出して」と言ったときだけ `force=true` で通す**（本人の実体験にゴルフ場名が出るのは自然なので、止めるだけにしない。私の判断。自動投稿には force は無い）
- 写真は 1 枚（複数はカルーセルになり API の手順が違うので、まずは 1 枚。複数渡されたら「1枚目を使う」と言って進める）
- 写真を渡したときは Threads 側で `source:'iso'` として記録し、その後の自動投稿の「直近の投稿」にも含める（AI が「昨日岐阜で回った話」に触れられる＝本当の出来事だけ言及できる）

## 8. アカウントの作り方（社長の手作業。手順書は別に 1 行ずつ渡す）

「裏垢」として知り合いに見つからないようにする（社長「誰にも知られたくない」）。

1. **新しい Gmail** を作る（この仕組み専用）
2. **Instagram** を PC のブラウザで、既存の Instagram からログアウトした状態で新規作成。メールだけ・電話番号は登録しない・連絡先の同期はオフ・Facebook と連携しない・「同じようなアカウントのおすすめ」をオフ・非公開・投稿しない。**今の Instagram アプリの「アカウントを追加」は使わない**（アカウントセンターで同じ人として結び付く）
3. **Threads** にその Instagram でログイン。名前・ユーザー名・写真は本名や今の SNS と結び付かないもの。設定の「他のアプリ（Instagram・Facebook）でおすすめ表示」をオフ。プロフィールは公開のまま
4. **Meta for Developers** でアプリを作る（用途「Threads API にアクセス」）。開発者登録には Facebook か Instagram のログインが要る。**社長の既存アカウントで登録してよい**（アプリの所有者は Threads 上の誰からも見えない。新垢と結び付く経路ではない）。builder は作業時にこの点を Meta の画面で再確認する
5. アプリの「アプリの役割」で新垢を **Threads テスター** に招待 → 新垢側で Threads の設定「ウェブサイトの権限」から承諾（審査なしで自分のアカウントに投稿できる開発モード）
6. アプリの Threads 設定にリダイレクト URI `https://threads-bot-….run.app/oauth/callback` を登録。アプリ ID・シークレットを Cloud Run に設定
7. 社長が **新垢でログインしたブラウザ**で `/oauth/start?key=…` を開いて許可 → トークンが入る → `/cron/tick?test=1` で最初の文を DM で確認

設定の項目名は作業時に実際の画面で確かめて手順書に書く（2026-10 時点の推測で固定しない）。

## 9. 止め方・困ったとき

- 全部止める: Cloud Run の `THREADS_ENABLED=false`
- 自動投稿だけ止めて写真投稿は残す: `THREADS_AUTO_POST=false`
- 出してしまった投稿を消す: Threads API に削除は無いので、社長が Threads アプリで消す
- 鍵が切れた: `/oauth/start?key=…` を新垢のブラウザで開き直す（§5）
- iso-bot が落ちていても threads-bot の投稿は止まらない（知らせだけ届かない）

## 10. やらないこと（今回の範囲外）

- コメントへの自動返信（返信は社長の手）
- フォロー・いいねの自動化（スパム扱いの危険。コミュニティ目的に合わない）
- Instagram への投稿
- 複数枚の写真・動画
- 閲覧数・いいね数の集計レポート（必要になったら `threads_insights` の権限を足す）

## 11. builder に任せること

- ファイル分割・関数名
- writer の prompt の細かい書き方（§2 の内容と見本は必ず入れる）
- 時刻の乱数の作り方（秒の種など）
- jest のテストの構成（スタブの形）
- Dockerfile か buildpack か（iso-bot と同じ `gcloud run deploy --source .`）
- README（社長向けの運用メモ: 止め方・鍵の取り直し・文体の直し方）

## 12. 作る順番（計画は別途 writing-plans で）

1. リポジトリと雛形（server・tests・README）
2. slots と writer（dry で文が出るところまで）
3. Threads API（OAuth → TEXT 投稿 → IMAGE 投稿）
4. 返信の取得と社長 DM
5. iso-bot の `post_to_threads` 道具
6. デプロイ・Scheduler・社長の手作業の手順書
