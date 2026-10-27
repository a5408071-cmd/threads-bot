# threads-bot 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 鈴木社長個人の趣味用 Threads アカウントへ、毎日2回ランダムな時刻に AI が書いた投稿を自動で出し、イソ経由の写真投稿とコメントの知らせも行う小さな Cloud Run サービスを作る。

**Architecture:** Express 1プロセス。Cloud Scheduler が10分おきに `/cron/tick` を叩き、その日の投稿枠（Firestore `threads_days`）を見て、時刻を過ぎた枠があれば Claude で本文を書き Threads API に投稿する。外部（Anthropic・Threads・Firestore・iso-bot）はすべて `deps` で差し替えられるようにし、テストは本物につながない。iso-bot 側には道具 `post_to_threads` を1つ足して `/api/post` を呼ぶ。

**Tech Stack:** Node.js 20 / Express 5 / `@google-cloud/firestore` / `axios` / `@anthropic-ai/sdk` / jest + supertest。Cloud Run（iso-bot-503303, asia-northeast1）、Cloud Scheduler、Secret Manager。

**Spec:** `docs/specs/2026-10-27-threads-bot-design.md`（この計画は設計書を前提にする。実装者は両方読む）

## Global Constraints

- Node `>=20`、`"type": "commonjs"`、依存は上記のみ（wdp-pace-board と同じ最小構成）
- JST の日付・時刻は「+9時間ずらして getUTC* で読む」か `Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Tokyo'})`（Cloud Run は UTC）
- Firestore のコレクション名はすべて `threads_` 接頭辞: `threads_days` / `threads_posts` / `threads_replies` / `threads_config` / `threads_alerts`
- cron 系の認証は `X-Cron-Key` ヘッダとクエリ `?key=` の両対応、比較は `crypto.timingSafeEqual`。拒否はログ `CRON_DENIED via=… len=…`（鍵そのものは書かない）
- 失敗を 0 件・完了に見せない。戻り値に `errors` を入れ、HTTP は失敗なら 500
- 投稿本文: 500 字以内（AI には 300 字までと指示）、URL なし、`THREADS_BANNED_WORDS`（`;` 区切り）の語を含まない
- 投稿は 1 日最大 2 本（自動）。イソ経由（`source:'iso'`）は別枠
- 通知先は社長 DM だけ（iso-bot `/admin/post` の `to:'owner'`）。他の宛先は作らない
- 緊急停止 `THREADS_ENABLED=false`（tick も `/api/post` も何もしない）、`THREADS_AUTO_POST=false`（自動投稿だけ止める）
- 環境変数: `CRON_KEY`（Secret `threads-cron-key`）、`THREADS_APP_ID`、`THREADS_APP_SECRET`（Secret `threads-app-secret`）、`PUBLIC_BASE_URL`、`ANTHROPIC_API_KEY`（Secret `anthropic-api-key`）、`ISO_BOT_URL`、`ISO_CRON_KEY`（Secret `cron-key`、iso-bot と同じもの）、`THREADS_MODEL`（既定 `claude-opus-5-5`）、`THREADS_BANNED_WORDS`、`THREADS_COPY_TO_OWNER`、`THREADS_SLOT_GRACE_MIN`（既定 60）、`TZ=Asia/Tokyo`
- ログの接頭辞は `[threads]`
- コミットメッセージは日本語、末尾に `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`

## Review Focus

1. **止まっていた間に過ぎた枠**（Cloud Run が落ちていて 2 枠とも過ぎている）: 猶予 60 分を超えた枠は投稿せず `skipped` にする。深夜に 2 本まとめて出ない → Task 2 のテスト `猶予を超えた枠は skipped`
2. **同じ枠を 2 つのインスタンスが同時に踏む**: Firestore のトランザクションで「投稿中」を先に書いた方だけが投稿する → Task 4 のテスト `claimSlot は 2 回目が false`
3. **Threads のコンテナが FINISHED にならない**（`ERROR`／60 秒超え）: 公開せずエラーを返し、枠は `failed` として記録、社長 DM に知らせる → Task 5 のテスト `status が ERROR なら publish を呼ばない`
4. **トークンが無い・切れている**: 投稿を試みず「鍵が無い」を errors に入れ、社長 DM に取り直しの案内（12 時間に 1 回） → Task 8 のテスト `トークン無しなら Threads を呼ばず alert`
5. **AI が本文にゴルフ場名や会社名を入れた**: 検査で落として書き直し、2 回落ちたらその枠を飛ばす（自動投稿に force は無い） → Task 3 のテスト `NG 語は 2 回書き直しても落ちたら ok:false`

---

### Task 1: リポジトリの雛形と `/healthz`・cron 認証

**Files:**
- Create: `package.json`, `.gitignore`, `jest.config.js`（不要なら省略）, `src/server.js`, `src/auth.js`, `tests/server.test.js`, `README.md`（見出しだけ）

**Interfaces:**
- Produces: `createApp(deps = {})` → Express app（`deps.env`, `deps.now`, 以降の Task が `deps.store`・`deps.threads`・`deps.writer`・`deps.notify`・`deps.anthropic` を足す）
- Produces: `auth.cronAuthorized(req, env)` → boolean（`X-Cron-Key` か `?key=` を `env.CRON_KEY` と timingSafeEqual。未設定なら false）

- [ ] **Step 1: 雛形を作る**

`package.json`: name `threads-bot`、scripts `start: node src/server.js`、`test: jest`、dependencies `@anthropic-ai/sdk ^0.113.0` / `@google-cloud/firestore ^8.7.0` / `axios ^1.13.6` / `express ^5.2.1`、devDependencies `jest ^29.7.0` / `supertest ^7.2.2`、engines node `>=20`。`.gitignore` は `node_modules/ .env *.log coverage/`。`npm install`。

- [ ] **Step 2: 失敗するテストを書く** `tests/server.test.js`

```js
const request = require('supertest');
const { createApp } = require('../src/server');
test('GET /healthz は ok', async () => {
  const app = createApp({ env: { CRON_KEY: 'k' } });
  await request(app).get('/healthz').expect(200, { ok: true });
});
test('cron 系は鍵が無いと 403、ヘッダでもクエリでも通る', async () => {
  const app = createApp({ env: { CRON_KEY: 'k', THREADS_ENABLED: 'false' } });
  await request(app).get('/cron/tick').expect(403);
  await request(app).get('/cron/tick').set('X-Cron-Key', 'k').expect(200);
  await request(app).get('/cron/tick?key=k').expect(200);
});
test('CRON_KEY 未設定なら 503', async () => {
  const app = createApp({ env: {} });
  await request(app).get('/cron/tick?key=k').expect(503);
});
```

- [ ] **Step 3: テストが落ちることを確認** `npx jest tests/server.test.js` → `Cannot find module '../src/server'`

- [ ] **Step 4: 実装** `src/auth.js` に `cronAuthorized(req, env)`、`src/server.js` に `createApp(deps)`（`/healthz`、`/cron/tick` は認証だけして `THREADS_ENABLED==='false'` なら `{ok:true, disabled:true}` を返す仮実装）と `if (require.main === module) app.listen(PORT)`。

- [ ] **Step 5: テストが通ることを確認** `npx jest` → PASS

- [ ] **Step 6: コミット** `git add -A && git commit -m "雛形: healthz と cron 認証"`

---

### Task 2: 投稿枠（slots）

**Files:**
- Create: `src/slots.js`, `tests/slots.test.js`

**Interfaces:**
- Produces: `drawSlots(dateKey, rng = Math.random)` → `{ slots: ['HH:MM', ...] }`（1 本か 2 本、JST の時刻文字列、昇順）
- Produces: `dueSlot(day, now, { graceMin = 60 } = {})` → `{ index, status: 'due' | 'late' } | null`（`day = { dateKey, slots, posted: [{index,…}] }`。`posted` に無い枠のうち時刻を過ぎた最初のもの。猶予超えは `late`）
- Produces: `jstDateKey(now)` → `'YYYY-MM-DD'`、`jstHm(now)` → `'HH:MM'`

- [ ] **Step 1: 失敗するテストを書く** `tests/slots.test.js`

```js
const { drawSlots, dueSlot, jstDateKey } = require('../src/slots');
function seeded(seq) { let i = 0; return () => seq[i++ % seq.length]; }
test('2 本のときは 1 本目 7:00〜13:30、2 本目 17:30〜23:00、分は 00 と 30 以外、3 時間以上あく', () => {
  for (let k = 0; k < 200; k++) {
    const { slots } = drawSlots('2026-10-28', () => (k * 0.37) % 1);
    if (slots.length === 1) continue;
    const [a, b] = slots.map((s) => s.split(':').map(Number));
    expect(a[0] * 60 + a[1]).toBeGreaterThanOrEqual(7 * 60);
    expect(a[0] * 60 + a[1]).toBeLessThanOrEqual(13 * 60 + 30);
    expect(b[0] * 60 + b[1]).toBeGreaterThanOrEqual(17 * 60 + 30);
    expect(b[0] * 60 + b[1]).toBeLessThanOrEqual(23 * 60);
    expect([0, 30]).not.toContain(a[1]); expect([0, 30]).not.toContain(b[1]);
    expect(b[0] * 60 + b[1] - (a[0] * 60 + a[1])).toBeGreaterThanOrEqual(180);
  }
});
test('1 本だけの日が 1/7 くらい（乱数の先頭が 1/7 未満のとき）', () => {
  expect(drawSlots('2026-10-28', seeded([0.05, 0.5, 0.5, 0.5, 0.5])).slots).toHaveLength(1);
  expect(drawSlots('2026-10-28', seeded([0.9, 0.5, 0.5, 0.5, 0.5])).slots).toHaveLength(2);
});
test('dueSlot: 時刻前は null、過ぎたら due、投稿済みは飛ばす、猶予を超えた枠は late', () => {
  const day = { dateKey: '2026-10-28', slots: ['09:17', '20:41'], posted: [] };
  const at = (hm) => new Date(`2026-10-28T${hm}:00+09:00`);
  expect(dueSlot(day, at('09:00'))).toBeNull();
  expect(dueSlot(day, at('09:20'))).toEqual({ index: 0, status: 'due' });
  expect(dueSlot({ ...day, posted: [{ index: 0 }] }, at('09:20'))).toBeNull();
  expect(dueSlot(day, at('10:30'))).toEqual({ index: 0, status: 'late' });
  expect(dueSlot({ ...day, posted: [{ index: 0 }] }, at('20:45'))).toEqual({ index: 1, status: 'due' });
});
test('jstDateKey は UTC の夜でも JST の翌日', () => {
  expect(jstDateKey(new Date('2026-10-27T16:00:00Z'))).toBe('2026-10-28');
});
```

- [ ] **Step 2: 落ちることを確認** `npx jest tests/slots.test.js` → Cannot find module
- [ ] **Step 3: 実装** `src/slots.js`。分は 1〜29・31〜59 から引く。1 本だけの日は 1 本目の窓か 2 本目の窓をもう 1 回乱数で選ぶ。
- [ ] **Step 4: 通ることを確認** `npx jest tests/slots.test.js` → PASS
- [ ] **Step 5: コミット** `git commit -m "投稿枠: 毎日ランダムな 2 つの時刻と猶予"`

---

### Task 3: 本文を書く（writer）

**Files:**
- Create: `src/persona.js`（人物像・型の説明・見本 3 本＝設計書 §2 を文字列で持つ）, `src/writer.js`, `tests/writer.test.js`

**Interfaces:**
- Produces: `pickType(recentTypes, date, rng)` → `'question'|'aruaru'|'invite'|'season'|'small'|'hook'`（直近 2 本（前日分まで）の型は避ける。金土日祝前日は `invite` の重みを 2 倍）
- Produces: `checkText(text, { banned = [], recent = [] })` → `{ ok: true } | { ok: false, reason }`（500 字超／URL（`https?://`・`www.`）／banned の語／recent のどれかと類似度 0.6 以上（2-gram の Jaccard）／空文字）
- Produces: `writePost({ type, recent, dateKey, env, anthropic })` → `{ ok: true, text, type, attempts } | { ok: false, reason, type }`（最大 3 回＝初回＋書き直し 2 回。`anthropic.messages.create` を使う。モデルは `env.THREADS_MODEL || 'claude-opus-5-5'`、`max_tokens 1024`、`output_config: { effort: 'medium' }`）
- Consumes: なし

- [ ] **Step 1: 失敗するテストを書く** `tests/writer.test.js`

```js
const { pickType, checkText, writePost } = require('../src/writer');
test('pickType は直近 2 本の型を避ける', () => {
  for (let i = 0; i < 50; i++) expect(['question', 'aruaru']).not.toContain(pickType(['question', 'aruaru'], new Date('2026-10-28T03:00:00Z'), Math.random));
});
test('checkText: 500 字超・URL・NG 語・似すぎは落ちる', () => {
  expect(checkText('あ'.repeat(501)).ok).toBe(false);
  expect(checkText('詳しくは https://example.com').ok).toBe(false);
  expect(checkText('ウッドデザインパークのゴルフ会', { banned: ['ウッドデザインパーク'] })).toEqual({ ok: false, reason: 'NG語: ウッドデザインパーク' });
  const same = '名古屋で平日ゴルフ行ける人、いませんか！？';
  expect(checkText(same + 'よろしく', { recent: [same] }).ok).toBe(false);
  expect(checkText('今日のベストショットは？').ok).toBe(true);
});
function fakeAnthropic(texts) {
  let i = 0;
  return { messages: { create: jest.fn(async () => ({ content: [{ type: 'text', text: texts[i++] }], stop_reason: 'end_turn' })) } };
}
test('writePost: NG 語は 2 回書き直しても落ちたら ok:false', async () => {
  const a = fakeAnthropic(['ウッドの話', 'ウッドの話2', 'ウッドの話3']);
  const r = await writePost({ type: 'question', recent: [], dateKey: '2026-10-28', env: { THREADS_BANNED_WORDS: 'ウッド' }, anthropic: a });
  expect(r.ok).toBe(false); expect(a.messages.create).toHaveBeenCalledTimes(3);
});
test('writePost: 1 回目が落ちて 2 回目が通れば attempts 2、書き直しの指示に落ちた理由が入る', async () => {
  const a = fakeAnthropic(['https://x.y を見て', '名古屋で平日ゴルフ行ける人いませんか？']);
  const r = await writePost({ type: 'question', recent: [], dateKey: '2026-10-28', env: {}, anthropic: a });
  expect(r).toMatchObject({ ok: true, attempts: 2, type: 'question' });
  expect(JSON.stringify(a.messages.create.mock.calls[1][0])).toMatch(/URL/);
});
test('writePost の system に人物像と禁止事項が入る', async () => {
  const a = fakeAnthropic(['今日のベストショットは？']);
  await writePost({ type: 'hook', recent: [], dateKey: '2026-10-28', env: {}, anthropic: a });
  const sys = String(a.messages.create.mock.calls[0][0].system);
  expect(sys).toMatch(/名古屋/); expect(sys).toMatch(/90/); expect(sys).toMatch(/ゴルフ場の名前/); expect(sys).toMatch(/作り話/);
});
```

- [ ] **Step 2: 落ちることを確認** `npx jest tests/writer.test.js`
- [ ] **Step 3: 実装** `src/persona.js`（設計書 §2 の人物像・NG・型の説明・見本 3 本を `SYSTEM` 文字列に。「本文だけを返す、前置きや引用符は付けない」を末尾に）と `src/writer.js`。user には `今日: ${dateKey}（曜日）、型: …、直近の投稿（言い回しを変える）: …` を渡す。返りの前後の引用符・「投稿:」の見出しは剥がす。
- [ ] **Step 4: 通ることを確認** `npx jest tests/writer.test.js` → PASS
- [ ] **Step 5: コミット** `git commit -m "writer: 人物像・型のローテーション・本文の検査"`

---

### Task 4: Firestore の読み書き（store）

**Files:**
- Create: `src/store.js`, `tests/store.test.js`

**Interfaces:**
- Produces: `createStore(db)` → オブジェクト。`db` は `@google-cloud/firestore` の Firestore（テストは `memoryStore()`）
  - `getDay(dateKey)` → `{ dateKey, slots, posted:[{index, mediaId, at}], claimed:[index…] } | null`
  - `ensureDay(dateKey, drawFn)` → day（無ければ `drawFn()` の slots で作る。トランザクション）
  - `claimSlot(dateKey, index)` → boolean（`claimed` に無ければ足して true。トランザクション。2 回目は false）
  - `releaseSlot(dateKey, index)`、`markPosted(dateKey, index, { mediaId })`、`markSkipped(dateKey, index, reason)`
  - `savePost({ mediaId, text, type, source, permalink, postedAt })`、`recentPosts(n = 14)` → 新しい順
  - `getToken()` → `{ token, userId, expiresAt } | null`、`setToken(t)`
  - `seenReply(replyId)` → boolean、`markReplySeen(replyId, data)`
  - `alertDue(key, hours = 12)` → boolean（前回から hours 以上なら true にして時刻を書く。`threads_alerts/<key>`）
- Produces: `memoryStore()` → 同じ形の in-memory 実装（テスト用。`src/store.js` から export）

- [ ] **Step 1: 失敗するテストを書く** `tests/store.test.js`（`memoryStore()` に対して）

```js
const { memoryStore } = require('../src/store');
test('ensureDay は 1 回だけ draw する', async () => {
  const s = memoryStore(); const draw = jest.fn(() => ({ slots: ['09:17', '20:41'] }));
  await s.ensureDay('2026-10-28', draw); await s.ensureDay('2026-10-28', draw);
  expect(draw).toHaveBeenCalledTimes(1);
  expect((await s.getDay('2026-10-28')).slots).toEqual(['09:17', '20:41']);
});
test('claimSlot は 2 回目が false、release で戻る', async () => {
  const s = memoryStore(); await s.ensureDay('2026-10-28', () => ({ slots: ['09:17'] }));
  expect(await s.claimSlot('2026-10-28', 0)).toBe(true);
  expect(await s.claimSlot('2026-10-28', 0)).toBe(false);
  await s.releaseSlot('2026-10-28', 0);
  expect(await s.claimSlot('2026-10-28', 0)).toBe(true);
});
test('recentPosts は新しい順に n 件', async () => {
  const s = memoryStore();
  for (let i = 0; i < 20; i++) await s.savePost({ mediaId: 'm' + i, text: 't' + i, type: 'hook', source: 'auto', postedAt: new Date(2026, 9, 1 + i).toISOString() });
  const r = await s.recentPosts(14); expect(r).toHaveLength(14); expect(r[0].mediaId).toBe('m19');
});
test('alertDue は 12 時間に 1 回', async () => {
  const s = memoryStore({ now: () => new Date('2026-10-28T00:00:00Z') });
  expect(await s.alertDue('token')).toBe(true); expect(await s.alertDue('token')).toBe(false);
});
```

- [ ] **Step 2: 落ちることを確認** `npx jest tests/store.test.js`
- [ ] **Step 3: 実装** `src/store.js`。Firestore 版は `db.runTransaction` で `ensureDay`／`claimSlot`。`memoryStore` は Map で同じ振る舞い（`now` を deps で差し替え可）。
- [ ] **Step 4: 通ることを確認** → PASS
- [ ] **Step 5: コミット** `git commit -m "store: 投稿枠・投稿・トークン・知らせの記録"`

---

### Task 5: Threads API（threads）

**Files:**
- Create: `src/threads.js`, `tests/threads.test.js`

**Interfaces:**
- Produces: `createThreads({ http = axios, env, now, sleep })` → オブジェクト（`BASE = 'https://graph.threads.net/v1.0'`）
  - `publishPost({ token, userId, text, imageUrl = null })` → `{ ok: true, mediaId, permalink } | { ok: false, error, stage: 'container'|'status'|'publish'|'permalink' }`（`POST /{userId}/threads` → `GET /{id}?fields=status,error_message` を 5 秒おき最長 60 秒 → `POST /{userId}/threads_publish` → `GET /{mediaId}?fields=permalink`）
  - `exchangeCode({ code, redirectUri })` → `{ token, userId, expiresAt }`（`POST /oauth/access_token`（短期）→ `GET /access_token?grant_type=th_exchange_token`（長期。`expires_in` 秒から `expiresAt` ISO））
  - `refreshToken(token)` → `{ token, expiresAt }`（`GET /refresh_access_token?grant_type=th_refresh_token`）
  - `listMyPosts({ token, sinceIso })` → `[{ id, permalink, timestamp }]`（`GET /me/threads?fields=id,permalink,timestamp&since=`）
  - `listReplies({ token, mediaId })` → `[{ id, text, username, timestamp, permalink }]`（`GET /{mediaId}/replies?fields=…`）
  - `authorizeUrl({ redirectUri, state })` → `https://threads.net/oauth/authorize?client_id=…&redirect_uri=…&scope=threads_basic,threads_content_publish,threads_read_replies&response_type=code&state=…`
- `http` は `{ get(url, {params}), post(url, data|params) }` 互換（axios）。エラーは Meta の `error.message` を文に含める

- [ ] **Step 1: 失敗するテストを書く** `tests/threads.test.js`（`http` を jest.fn で差し替え、`sleep` は即時）

```js
const { createThreads } = require('../src/threads');
function http(script) { // script: [{ match: /regex/, reply: data|Error }]
  const calls = [];
  const run = async (url, opts) => { calls.push({ url, opts }); const s = script.find((x) => x.match.test(url)); if (!s) throw new Error('unexpected ' + url); if (s.reply instanceof Error) throw s.reply; return { data: s.reply }; };
  return { get: run, post: run, calls };
}
test('publishPost: TEXT はコンテナ→FINISHED→publish→permalink の順', async () => {
  const h = http([
    { match: /\/u1\/threads$/, reply: { id: 'c1' } },
    { match: /\/c1\?/, reply: { status: 'FINISHED' } },
    { match: /\/u1\/threads_publish/, reply: { id: 'm1' } },
    { match: /\/m1\?/, reply: { permalink: 'https://www.threads.net/@x/post/abc' } },
  ]);
  const t = createThreads({ http: h, env: {}, sleep: async () => {} });
  const r = await t.publishPost({ token: 'tk', userId: 'u1', text: 'hello' });
  expect(r).toEqual({ ok: true, mediaId: 'm1', permalink: 'https://www.threads.net/@x/post/abc' });
  expect(h.calls[0].opts).toMatchObject({ media_type: 'TEXT', text: 'hello', access_token: 'tk' });
});
test('publishPost: IMAGE は image_url を渡す', async () => { /* media_type IMAGE, image_url */ });
test('status が ERROR なら publish を呼ばない', async () => {
  const h = http([{ match: /\/u1\/threads$/, reply: { id: 'c1' } }, { match: /\/c1\?/, reply: { status: 'ERROR', error_message: 'bad image' } }]);
  const t = createThreads({ http: h, env: {}, sleep: async () => {} });
  const r = await t.publishPost({ token: 'tk', userId: 'u1', text: 'x', imageUrl: 'https://a/b.jpg' });
  expect(r).toMatchObject({ ok: false, stage: 'status' }); expect(r.error).toMatch(/bad image/);
  expect(h.calls.some((c) => /threads_publish/.test(c.url))).toBe(false);
});
test('status が 60 秒たっても IN_PROGRESS なら ok:false stage status', async () => { /* now を進める */ });
test('exchangeCode は短期→長期の 2 段で expiresAt を付ける', async () => { /* expires_in: 5184000 */ });
test('authorizeUrl に 3 つの scope と state', () => { /* … */ });
```

- [ ] **Step 2: 落ちることを確認**
- [ ] **Step 3: 実装** `src/threads.js`。Meta のエラーは `e.response?.data?.error?.message || e.message` を `error` に。
- [ ] **Step 4: 通ることを確認** → PASS
- [ ] **Step 5: コミット** `git commit -m "Threads API: 投稿・トークン・返信の取得"`

---

### Task 6: 社長 DM への知らせ（notify）

**Files:**
- Create: `src/notify.js`, `tests/notify.test.js`

**Interfaces:**
- Produces: `createNotify({ http = axios, env })` → `{ owner(text) }`。`POST ${env.ISO_BOT_URL}/admin/post` に JSON `{ to: 'owner', text }`、ヘッダ `X-Cron-Key: env.ISO_CRON_KEY`。返り `{ ok: true } | { ok: false, error }`（**投げない**。失敗はログ `[threads] NOTIFY_FAILED`）。`ISO_BOT_URL` か `ISO_CRON_KEY` が無ければ `{ ok: false, error: '未設定' }`

- [ ] **Step 1: テスト**: URL・ヘッダ・本文が正しい／http が投げても `{ok:false}` で返る／未設定なら呼ばない
- [ ] **Step 2: 落ちることを確認** → **Step 3: 実装** → **Step 4: PASS**
- [ ] **Step 5: コミット** `git commit -m "notify: iso-bot 経由で社長DMに知らせる"`

---

### Task 7: OAuth（`/oauth/start`・`/oauth/callback`）

**Files:**
- Modify: `src/server.js`
- Test: `tests/server.test.js`（追記）

**Interfaces:**
- Consumes: `threads.authorizeUrl`, `threads.exchangeCode`, `store.setToken`, `auth.cronAuthorized`
- Produces: `GET /oauth/start?key=<CRON_KEY>` → 302 to authorizeUrl（`state` はランダム 32 文字を `threads_config/oauthState` に 10 分の期限付きで保存）、`GET /oauth/callback?code=&state=` → state が合えば exchangeCode → setToken → 200 「Threads と接続しました（@userId、期限 …）。このタブは閉じてOK」、合わなければ 403。`redirectUri = ${env.PUBLIC_BASE_URL}/oauth/callback`

- [ ] **Step 1: テスト**: start は鍵無しで 403、鍵ありで 302 の Location に `threads.net/oauth/authorize` と state／callback は state 違いで 403、合えば setToken が呼ばれ 200
- [ ] **Step 2: 落ちることを確認** → **Step 3: 実装**（`store.setOauthState(state, expiresAt)`／`takeOauthState(state)` を Task 4 の store に足す。memoryStore も） → **Step 4: PASS**
- [ ] **Step 5: コミット** `git commit -m "OAuth: 社長のブラウザで Threads と接続する口"`

---

### Task 8: 見回り `/cron/tick` と `/admin/status`

**Files:**
- Create: `src/tick.js`, `tests/tick.test.js`
- Modify: `src/server.js`（`/cron/tick`、`/admin/status`）

**Interfaces:**
- Consumes: `slots.*`, `writer.writePost/pickType`, `store.*`, `threads.publishPost/refreshToken`, `notify.owner`, `replies.poll`（Task 10。無ければ飛ばす）
- Produces: `runTick({ env, store, threads, writer, notify, anthropic, now, mode: 'live'|'dry'|'test', replies })` → `{ ok, dateKey, slots, due, posted, skipped, token: { daysLeft, refreshed }, replies, errors: [] }`
  - 順序は設計書 §6: ENABLED → ensureDay → dueSlot → （`THREADS_AUTO_POST!=='false'` なら）claimSlot → 直近 14 本と直近 2 本の型 → writePost → `dry` なら文を返すだけ・`test` なら notify.owner に文を送って返す・`live` なら publishPost → markPosted + savePost（`THREADS_COPY_TO_OWNER==='true'` なら notify.owner に「📝 投稿しました: 本文 → permalink」）
  - `late` の枠は投稿せず markSkipped('猶予超え') と notify.owner（「⚠ N 本目（HH:MM）は時間が過ぎたので出しませんでした」）
  - writePost が ok:false なら markSkipped(reason) と notify.owner
  - publishPost が ok:false なら releaseSlot せず markSkipped('投稿失敗: …')（同じ枠を繰り返さない）、errors に入れ、notify.owner
  - トークン: 無ければ errors に「鍵なし」＋ `alertDue('token')` のとき notify.owner（取り直しの案内 `PUBLIC_BASE_URL/oauth/start?key=…` は**鍵を書かず**「/oauth/start を開いて」）。残り 10 日未満なら refreshToken → setToken。
  - 返信: `now` の分が `00〜09` のときだけ `replies.poll` を呼ぶ（10 分おきの tick で 1 時間に 1 回）
- `/cron/tick?dry=1|test=1` → mode。HTTP は errors が空なら 200、あれば 500（本文は同じ JSON）
- `/admin/status`（cron 認証）→ `{ today: day, token: { userId, expiresAt, daysLeft }, lastPosts: recentPosts(5), enabled }`

- [ ] **Step 1: 失敗するテストを書く** `tests/tick.test.js`（memoryStore・fake threads/writer/notify）

```js
test('時刻を過ぎた枠があれば書いて投稿し、記録と写しを残す', async () => { /* posted 1、savePost に permalink、COPY_TO_OWNER で notify 1 回 */ });
test('時刻前は何もしない（AI も Threads も呼ばない）', async () => {});
test('猶予を超えた枠は skipped にして知らせる、投稿しない', async () => {});
test('THREADS_AUTO_POST=false なら枠は作るが投稿しない', async () => {});
test('dry は投稿せず文を返す、test は社長DMに文を送って投稿しない（claim も残さない）', async () => {});
test('トークン無しなら Threads を呼ばず alert（2 回目は知らせない）', async () => {});
test('残り 10 日未満ならトークンを更新して保存', async () => {});
test('writePost が ok:false なら skipped と知らせ', async () => {});
test('publishPost が失敗したら skipped・errors・知らせ、HTTP は 500', async () => {});
```

- [ ] **Step 2: 落ちることを確認** → **Step 3: 実装** `src/tick.js` と server の配線（`deps.store` が無ければ `createStore(new Firestore())`、`deps.anthropic` が無ければ `new Anthropic({ maxRetries: 4 })`）。
- [ ] **Step 4: PASS** `npx jest`
- [ ] **Step 5: コミット** `git commit -m "tick: 10分おきの見回りで投稿・トークン更新・知らせ"`

---

### Task 9: 写真投稿の口 `POST /api/post`

**Files:**
- Modify: `src/server.js`, `src/tick.js`（検査を共用するなら `writer.checkText`）
- Test: `tests/server.test.js`（追記）

**Interfaces:**
- Produces: `POST /api/post`（cron 認証、JSON `{ text, imageUrl?, source = 'iso', preview?: boolean, force?: boolean }`）
  - `THREADS_ENABLED==='false'` → 503 `{ok:false, error:'停止中'}`
  - `checkText(text, { banned })` に落ちたら（`force` でなければ）400 `{ ok: false, blocked: true, reason, words: [...] }`（recent との類似は見ない）
  - `preview:true` → 200 `{ ok: true, preview: true, text, imageUrl, check: {ok, reason?} }`（投稿しない）
  - それ以外 → `threads.publishPost` → `savePost({ source })` → 200 `{ ok: true, mediaId, permalink }`／失敗 500 `{ ok: false, error, stage }`
  - `imageUrl` は `https://` で始まるものだけ（それ以外は 400）
- `/api/post` の投稿は `threads_days` の枠を消費しない

- [ ] **Step 1: テスト**: NG 語で 400 と blocked／force で通る／preview は publish を呼ばない／http 以外の imageUrl は 400／成功で permalink
- [ ] **Step 2: 落ちることを確認** → **Step 3: 実装** → **Step 4: PASS**
- [ ] **Step 5: コミット** `git commit -m "api/post: イソからの写真付き投稿"`

---

### Task 10: 返信（コメント）の取得と知らせ

**Files:**
- Create: `src/replies.js`, `tests/replies.test.js`
- Modify: `src/tick.js`（Task 8 の「分が 00〜09 のとき」で呼ぶ）

**Interfaces:**
- Produces: `createReplies({ threads, store, notify, now })` → `{ poll({ token, userId }) }` → `{ checked, newReplies, notified, errors }`
  - `threads.listMyPosts({ sinceIso: 7 日前 })` → 各投稿で `listReplies` → `store.seenReply(id)` に無いものを集める → 初回（`store.getConfig('repliesInitialized')` が無い）は全部 `markReplySeen` して知らせない → 2 回目以降は新着を 1 通にまとめて `notify.owner`（「💬 Threads にコメント N 件\n・@user「本文」\n  → permalink」。本文は 100 字で切る）→ 成功したら `markReplySeen`
  - 自分（`userId` と同じ `from.id`、取れなければ `username` が自分）の返信は除く
  - 1 投稿の失敗は errors に残して他は続ける

- [ ] **Step 1: テスト**: 初回は記録だけで notify 0／新着 2 件で notify 1 通に 2 件／既読は数えない／自分の返信は除く／1 投稿の listReplies が投げても他は続き errors に残る
- [ ] **Step 2: 落ちることを確認** → **Step 3: 実装** → **Step 4: PASS**
- [ ] **Step 5: コミット** `git commit -m "replies: 新しいコメントを社長DMに知らせる"`

---

### Task 11: iso-bot 側の道具 `post_to_threads`

**Files:**
- Modify: `C:\Users\WDP\iso-bot\src\tools.js`（TOOL_DEFINITIONS に追加、`executeTool` に case 追加。社員の許可リストには入れない。`DISCUSSION_BLOCKED` に `post_to_threads$` を足す）
- Modify: `C:\Users\WDP\iso-bot\src\persona.js`（「Threads に投稿しといて」の案内 2〜3 行: 写真 1 枚・一言はそのまま・無ければ下書きを見せて OK をもらう・結果の permalink を書く）
- Modify: `C:\Users\WDP\iso-bot\CLAUDE.md`（運用の 1 段落）
- Test: `C:\Users\WDP\iso-bot\tests\threadsTool.test.js`

**Interfaces:**
- Consumes: threads-bot `POST /api/post`（Task 9）、`receipts.uploadGenericFile({ buffer, mimeType, filename, company: '共通', category: 'Threads', subfolders: [年] })`、`gbpReviews.normalizePhotoUrl(fileId, env)`
- Produces: 道具 `post_to_threads` `{ text: string（必須）, preview?: boolean（既定 true）, force?: boolean, no_image?: boolean, image_index?: integer }`
  - 社長以外は `{ ok:false, error:'Threads への投稿は社長だけが使えます' }`
  - `THREADS_BOT_URL`／`THREADS_BOT_KEY`（env。Secret `threads-cron-key` 参照）が無ければ `{ ok:false, error:'THREADS_BOT_URL 未設定' }`
  - 画像: `ctx.attachments` の `kind==='image'`（`image_index` か 1 枚目）。`no_image` でなければ Drive へ保存（同じ添付は 1 回だけ。`target.threadsLink` に覚える）→ `normalizePhotoUrl(fileId)` を `imageUrl` に
  - `preview` が true なら threads-bot に `preview:true` で送り、`{ ok:true, preview:true, text, hasImage, check }` を返す（brain が社長に見せて OK をもらう）。`preview:false` で本投稿 → `{ ok:true, permalink, mediaId }`。`blocked` の 400 は `{ ok:false, blocked:true, reason, hint:'社長が「それでも出して」と言ったら force:true で' }`
- 道具の説明（description）に書くこと: 「社長が写真を送って『Threads に投稿しといて』。一言があればそのまま（言い換えない）。無ければ人物像（名古屋の30代エンジョイゴルファー。会社名・本名・ゴルフ場名は書かない）で 1〜2 行書き、**まず preview で社長に見せて OK をもらってから preview:false**。結果の permalink を必ず返答に書く。写真は 1 枚だけ（複数なら 1 枚目を使うと言う）」

- [ ] **Step 1: 失敗するテストを書く** `tests/threadsTool.test.js`（`executeTool` を `ctx.role:'owner'` と `attachments` で呼ぶ。`axios` と `receipts.uploadGenericFile` を jest.mock）: 社員は断る／未設定は error／preview は axios の body に preview:true・画像があれば imageUrl が `/media/drive/` で始まる／400 blocked は blocked:true／成功で permalink
- [ ] **Step 2: 落ちることを確認** `cd C:\Users\WDP\iso-bot && npx jest tests/threadsTool.test.js`
- [ ] **Step 3: 実装**（tools.js・persona.js・CLAUDE.md）
- [ ] **Step 4: iso-bot の全テストが通ることを確認** `npx jest`
- [ ] **Step 5: コミット（iso-bot）** `git commit -m "道具 post_to_threads: 写真をイソに渡して Threads に投稿（2026-10-27 社長「写真をイソに渡して投稿しといてってするのはありか」）"`

---

### Task 12: README・デプロイ・Scheduler・社長の手順書

**Files:**
- Create/Modify: `README.md`（入口の表・環境変数・止め方・鍵の取り直し・文体の直し方＝`src/persona.js` を直して deploy）、`docs/setup-for-suzuki.md`（設計書 §8 の手順を 1 行ずつ。実際の Meta・Instagram・Threads の画面名は作業時に確かめて書く）
- Modify: `C:\Users\WDP\iso-bot\CLAUDE.md`（threads-bot の所在とデプロイの 1 段落。鍵の値は書かない）

**Interfaces:** なし（運用）

- [ ] **Step 1: README と手順書を書く**（Scheduler の名前 `threads-tick`、`*/10 * * * *` Asia/Tokyo、`--headers "X-Cron-Key=…"`。Secret `threads-cron-key`・`threads-app-secret` の作り方は `gcloud secrets create … --data-file=-`）
- [ ] **Step 2: 社長が GitHub でリポジトリ `a5408071-cmd/threads-bot`（非公開）を作る → `git remote add origin git@github.com:a5408071-cmd/threads-bot.git && git push -u origin main`**（SSH 鍵は a5408071-cmd 名義で push 可＝memory github-accounts-and-repos。push 前に社長へ「作りましたか」と確認）
- [ ] **Step 3: Secret と Cloud Run** `gcloud secrets create threads-cron-key`（ランダム 32 文字）、`threads-app-secret`（社長が Meta の画面から貼る値。作業セッションは `%TEMP%` の 1 行の cmd を用意して社長に実行してもらう）→ `gcloud run deploy threads-bot --source . --region asia-northeast1 --project iso-bot-503303 --memory 512Mi --set-secrets CRON_KEY=threads-cron-key:latest,THREADS_APP_SECRET=threads-app-secret:latest,ANTHROPIC_API_KEY=anthropic-api-key:latest,ISO_CRON_KEY=cron-key:latest --set-env-vars THREADS_APP_ID=…,PUBLIC_BASE_URL=https://threads-bot-777525372244.asia-northeast1.run.app,ISO_BOT_URL=https://iso-bot-777525372244.asia-northeast1.run.app,THREADS_COPY_TO_OWNER=true,THREADS_BANNED_WORDS=…,TZ=Asia/Tokyo`（NG 語の初期値は iso-bot の CLAUDE.md にある会社名・店名・社長の姓名。`;` 区切り）
- [ ] **Step 4: Scheduler** `gcloud scheduler jobs create http threads-tick --location asia-northeast1 --schedule "*/10 * * * *" --time-zone Asia/Tokyo --uri "https://threads-bot-…/cron/tick" --headers "X-Cron-Key=$(gcloud secrets versions access latest --secret=threads-cron-key)"`
- [ ] **Step 5: iso-bot に `THREADS_BOT_URL` と Secret 参照 `THREADS_BOT_KEY=threads-cron-key:latest` を設定して deploy**（`git pull` → `gcloud run deploy iso-bot --source . --region asia-northeast1`）
- [ ] **Step 6: 社長の手作業（手順書）→ `/oauth/start?key=…` → `/cron/tick?test=1` で最初の文が社長 DM に届く → `/admin/status` でトークン残日数を確認**
- [ ] **Step 7: 本番の最初の 1 本は `THREADS_COPY_TO_OWNER=true` のまま見守り、写しが DM に届くことを確認。1 週間後に `false` に戻す**（カレンダーに予定を入れる＝イソの add_reminder で 11/4 に「Threads の写しを止める」）
- [ ] **Step 8: コミット** `git commit -m "README・手順書・デプロイ"`

---

## 自己レビューの記録

- 設計書 §3 の「写真投稿があった日も自動投稿を減らさない」→ Task 9（枠を消費しない）。§5 のトークン → Task 5・7・8。§6 の dry/test/status → Task 8。§7 → Task 9・11。§8 → Task 12 の手順書。§9 の止め方 → Global Constraints と Task 8・9。§10（やらないこと）は作らない
- 型名は `question|aruaru|invite|season|small|hook` で Task 3・8 で統一。`publishPost` の返り `{ok, mediaId, permalink}` は Task 5・8・9 で同じ
- Review Focus 5 件はそれぞれ Task 2・4・5・8・3 のテストに入れた
