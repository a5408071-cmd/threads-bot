/**
 * threads-bot の HTTP 入口。
 *   GET  /health         … 生存確認
 *   GET  /cron/tick      … 10分おきの見回り（X-Cron-Key か ?key=）。?dry=1 は文を返すだけ、?test=1 は文を社長DMへ（投稿しない）
 *   POST /api/post       … イソからの投稿（X-Cron-Key。JSON {text, imageUrl?, source?, preview?, force?}）
 *   GET  /admin/status   … 今日の枠・トークンの残り日数・直近の投稿（鍵そのものは返さない）
 *   GET  /oauth/start    … 社長が新垢でログインしたブラウザで開く（?key=）→ Threads の許可画面へ
 *   GET  /oauth/callback … Threads から戻る。code をトークンに換えて Firestore に保存
 * 外部（Firestore・Anthropic・Threads・iso-bot）は deps で差し替えられる（テストは本物につながない）。
 */
const express = require('express');
const crypto = require('crypto');
const { cronAuthorized } = require('./auth');

function createApp(deps = {}) {
  const env = deps.env || process.env;
  let store = deps.store || null;
  const getStore = () => {
    if (!store) {
      const { Firestore } = require('@google-cloud/firestore');
      store = require('./store').createStore(new Firestore());
    }
    return store;
  };
  let threads = deps.threads || null;
  const getThreads = () => {
    if (!threads) threads = require('./threads').createThreads({ env });
    return threads;
  };
  const now = deps.now || (() => new Date());
  let anthropic = deps.anthropic || null;
  const getAnthropic = () => {
    // 1 回の見回りを Cloud Run の 300 秒・Scheduler の期限に収める（書き直し 3 回＋status 待ち 60 秒でも超えない）
    if (!anthropic) { const Anthropic = require('@anthropic-ai/sdk'); anthropic = new Anthropic({ maxRetries: 2, timeout: 60000 }); }
    return anthropic;
  };
  let notify = deps.notify || null;
  const getNotify = () => { if (!notify) notify = require('./notify').createNotify({ env }); return notify; };
  let replies = deps.replies === undefined ? null : deps.replies;
  let photos = deps.photos === undefined ? null : deps.photos;
  const getPhotos = () => {
    if (photos === null && deps.photos === undefined) photos = require('./photos').createPhotos({ store: getStore(), env, now });
    return photos;
  };
  let stock = deps.stock === undefined ? null : deps.stock;
  const getStock = () => {
    if (stock === null && deps.stock === undefined) stock = require('./stock').createStock({ store: getStore(), env, now });
    return stock;
  };
  let growth = deps.growth === undefined ? null : deps.growth;
  const getGrowth = () => {
    if (growth === null && deps.growth === undefined) growth = require('./growth').createGrowth({ threads: getThreads(), store: getStore(), notify: getNotify(), anthropic: getAnthropic(), env, now });
    return growth;
  };
  const getReplies = () => {
    if (replies === null && deps.replies === undefined) {
      try { replies = require('./replies').createReplies({ threads: getThreads(), store: getStore(), notify: getNotify(), now, anthropic: getAnthropic(), env }); } catch (e) { replies = null; }
    }
    return replies;
  };
  // セルフカフェ公式アカウント（2026-10-28）。記録は threads_cafe_ 接頭辞で趣味用と分ける
  // テストで store だけ差し替えたとき、公式の store も本物の Firestore につながないようにメモリ版にする
  let cafeStore = deps.cafeStore || (deps.store ? require('./store').memoryStore({ prefix: 'threads_cafe_' }) : null);
  const getCafeStore = () => {
    if (!cafeStore) {
      const { Firestore } = require('@google-cloud/firestore');
      cafeStore = require('./store').createStore(new Firestore(), { prefix: 'threads_cafe_' });
    }
    return cafeStore;
  };
  const cafeNotify = { owner: (text) => getNotify().owner(text) };
  let cafeSite = deps.cafeSite || null;
  const getCafeSite = () => { if (!cafeSite) cafeSite = require('./cafeSite').createCafeSite({}); return cafeSite; };
  let cafeReplies = deps.cafeReplies === undefined ? null : deps.cafeReplies;
  const getCafeReplies = () => {
    if (cafeReplies === null && deps.cafeReplies === undefined) {
      try { cafeReplies = require('./replies').createReplies({ threads: getThreads(), store: getCafeStore(), notify: cafeNotify, now, anthropic: getAnthropic(), env, persona: require('./personaCafe'), label: '【公式】' }); } catch (e) { cafeReplies = null; }
    }
    return cafeReplies;
  };
  const runCafe = (mode, extra = {}) => (deps.cafeTick || require('./cafeTick')).runCafeTick({ env, store: getCafeStore(), threads: getThreads(), writer: deps.writer || require('./writer'), notify: cafeNotify, anthropic: getAnthropic(), site: getCafeSite(), now, mode, replies: getCafeReplies(), ...extra });
  const storeFor = (account) => (account === 'cafe' ? getCafeStore() : getStore());
  const redirectUri = () => `${String(env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')}/oauth/callback`;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (req, res) => res.json({ ok: true })); // /healthz は Cloud Run の入口が横取りして 404 になる（2026-10-27 実測）

  /** cron 系の共通の門。通れば true、通らなければ応答済みで false */
  const gate = (req, res) => {
    if (!env.CRON_KEY) { res.status(503).json({ ok: false, error: 'CRON_KEY未設定' }); return false; }
    if (!cronAuthorized(req, env)) { res.sendStatus(403); return false; }
    return true;
  };

  app.get('/cron/tick', async (req, res) => {
    if (!gate(req, res)) return;
    const mode = req.query.dry === '1' ? 'dry' : req.query.test === '1' ? 'test' : 'live';
    if (env.THREADS_ENABLED === 'false') return res.json({ ok: true, disabled: true, mode }); // 緊急停止。Firestore にもつながない
    try {
      if (req.query.account === 'cafe') {
        const rc = await runCafe(mode, { forcePost: mode === 'live' && req.query.post === '1', forceType: (mode !== 'live' || req.query.post === '1') && req.query.type ? String(req.query.type) : null });
        const ec = (rc && rc.errors) || [];
        if (ec.length) console.error(`[threads] CAFE_TICK_ERRORS ${ec.join(' | ')}`);
        return res.status(ec.length ? 500 : 200).json(rc);
      }
      const tick = deps.tick || require('./tick');
      const r = await tick.runTick({ env, store: getStore(), threads: getThreads(), writer: deps.writer || require('./writer'), notify: getNotify(), anthropic: getAnthropic(), now, mode, replies: getReplies(), photos: getPhotos(), stock: getStock(), growth: getGrowth(), forcePhoto: req.query.photo === '1', forcePost: mode === 'live' && req.query.post === '1', forceType: (mode !== 'live' || req.query.post === '1') && req.query.type ? String(req.query.type) : null });
      // 趣味用のあとに公式も回す（公式が落ちても趣味用の結果は返す）
      if (mode === 'live' && !(req.query.post === '1')) {
        try { r.cafe = await runCafe('live'); } catch (e) { r.cafe = { ok: false, errors: [`【公式】${e.message}`] }; }
        if (r.cafe && r.cafe.errors && r.cafe.errors.length) r.errors = [...(r.errors || []), ...r.cafe.errors];
      }
      const errs = (r && r.errors) || [];
      if (errs.length) console.error(`[threads] TICK_ERRORS ${errs.join(' | ')}`);
      res.status(errs.length ? 500 : 200).json(r);
    } catch (e) {
      console.error('[threads] TICK_ERROR:', e);
      res.status(500).json({ ok: false, mode, errors: [e.message] });
    }
  });

  // イソ経由の投稿（社長が写真を渡して「Threads に投稿しといて」）。設計書 §7。
  // 本文は社長の言葉をそのまま（AI は通さない）。NG 語は止めるが、社長が「それでも出して」なら force=true で通す。
  // preview=true は投稿せず本文と検査結果だけ返す（イソが社長に見せて OK をもらうため）。投稿枠（threads_days）は消費しない
  app.post('/api/post', async (req, res) => {
    if (!gate(req, res)) return;
    if (env.THREADS_ENABLED === 'false') return res.status(503).json({ ok: false, error: '停止中（THREADS_ENABLED=false）' });
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const text = String(body.text || '').trim();
    const imageUrl = body.imageUrl ? String(body.imageUrl).trim() : null;
    const source = String(body.source || 'iso');
    if (!text) return res.status(400).json({ ok: false, error: '本文（text）が空です' });
    if (imageUrl && !/^https:\/\//.test(imageUrl)) return res.status(400).json({ ok: false, error: 'imageUrl は https:// で始まる誰でも開ける URL だけ' });
    const writer = deps.writer || require('./writer');
    const banned = writer.parseBanned(env);
    const check = writer.checkText(text, { banned });
    if (body.preview === true || body.preview === 'true') {
      return res.json({ ok: true, preview: true, text, imageUrl, check });
    }
    const force = body.force === true || body.force === 'true';
    if (!check.ok && !force) {
      const squash = (s) => String(s).toLowerCase().replace(/\s+/g, '');
      const words = banned.filter((w) => squash(text).includes(squash(w)));
      return res.status(400).json({ ok: false, blocked: true, reason: check.reason, words });
    }
    try {
      const store = getStore();
      const token = await store.getToken();
      if (!token || !token.token) return res.status(503).json({ ok: false, error: 'Threads の鍵が入っていません（/oauth/start で接続）' });
      const r = await getThreads().publishPost({ token: token.token, userId: token.userId, text, ...(imageUrl ? { imageUrl } : {}) });
      if (!r.ok) {
        console.error(`[threads] API_POST_FAILED stage=${r.stage} ${r.error}`);
        return res.status(500).json({ ok: false, stage: r.stage, error: r.error });
      }
      await store.savePost({ mediaId: r.mediaId, text, type: 'manual', source, permalink: r.permalink, imageUrl: imageUrl || null, forced: force, postedAt: now().toISOString() });
      console.log(`[threads] API_POSTED source=${source} media=${r.mediaId} image=${Boolean(imageUrl)} forced=${force}`);
      res.json({ ok: true, mediaId: r.mediaId, permalink: r.permalink });
    } catch (e) {
      console.error('[threads] API_POST_ERROR:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Meta が投稿の写真を取りに来る口（署名付き。Drive の写真を JPEG に直して返す。HEIC も可）
  app.get('/media/photo/:file', async (req, res) => {
    const id = String(req.params.file || '').replace(/\.jpe?g$/i, '');
    const sig = String(req.query.sig || '');
    if (!/^[\w-]{10,}$/.test(id) || !sig) return res.sendStatus(403);
    try {
      const ph = getPhotos();
      const bytes = ph && (await ph.serve(id, sig));
      if (!bytes) return res.sendStatus(404);
      res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'public, max-age=3600').send(bytes);
    } catch (e) {
      console.error('[threads] MEDIA_PHOTO_ERROR:', e.message);
      res.sendStatus(502);
    }
  });

  // 鍵の持ち主と権限（投稿が「Object does not exist / missing permissions」で断られたときの診断。鍵そのものは返さない）
  app.get('/admin/whoami', async (req, res) => {
    if (!gate(req, res)) return;
    try {
      const tok = await getStore().getToken();
      if (!tok || !tok.token) return res.status(503).json({ ok: false, error: '鍵なし' });
      const r = await getThreads().whoAmI(tok.token);
      let fixed = false;
      if (req.query.fix === '1' && r.id && String(r.id) !== String(tok.userId)) {
        await getStore().setToken({ ...tok, userId: String(r.id) });
        fixed = true;
        console.log(`[threads] USERID_FIXED ${tok.userId} -> ${r.id}`);
      }
      res.json({ ok: true, storedUserId: tok.userId, ...r, fixed });
    } catch (e) {
      res.status(500).json({ ok: false, error: require('./threads').metaError(e) });
    }
  });

  // ストック写真（Pixabay）を Meta に渡す口。Pixabay はホットリンク禁止なので自分で出す（署名付き）
  app.get('/media/stock/:file', async (req, res) => {
    const id = String(req.params.file || '').replace(/\.jpe?g$/i, '');
    const sig = String(req.query.sig || '');
    if (!/^\d{1,12}$/.test(id) || !sig) return res.sendStatus(403);
    try {
      const st = getStock();
      const bytes = st && (await st.serve(id, sig));
      if (!bytes) return res.sendStatus(404);
      res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'public, max-age=3600').send(bytes);
    } catch (e) {
      console.error('[threads] MEDIA_STOCK_ERROR:', e.message);
      res.sendStatus(502);
    }
  });

  // Meta の審査で求められる固定ページ（誰でも開ける）
  const pages = require('./pages');
  app.get('/privacy', (req, res) => res.type('html').send(pages.PRIVACY));
  app.get('/terms', (req, res) => res.type('html').send(pages.TERMS));
  app.get('/data-deletion', (req, res) => res.type('html').send(pages.DELETION));
  app.post('/data-deletion', (req, res) => res.json({ url: `${String(env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')}/data-deletion`, confirmation_code: `del-${Date.now()}` })); // Meta の「データ削除コールバック」の形

  // 審査の画面録画用のデモ画面（docs/app-review.md）。鍵付き
  app.get('/demo', (req, res) => {
    if (!gate(req, res)) return;
    res.type('html').send(require('./demo').demoHtml({ base: String(env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''), key: String(req.query.key || '') }));
  });
  app.get('/demo/search', async (req, res) => {
    if (!gate(req, res)) return;
    try {
      const tok = await getStore().getToken();
      if (!tok || !tok.token) return res.status(503).json({ ok: false, error: '鍵なし（先にログイン）' });
      const posts = await getThreads().keywordSearch({ token: tok.token, q: String(req.query.q || ''), type: 'RECENT' });
      res.json({ ok: true, posts });
    } catch (e) {
      res.status(500).json({ ok: false, error: require('./threads').metaError(e) });
    }
  });
  app.post('/demo/reply', async (req, res) => {
    if (!gate(req, res)) return;
    try {
      const tok = await getStore().getToken();
      if (!tok || !tok.token) return res.status(503).json({ ok: false, error: '鍵なし（先にログイン）' });
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const text = String(body.text || '').trim();
      const replyToId = String(body.replyToId || '').trim();
      if (!text || !replyToId) return res.status(400).json({ ok: false, error: '本文と返信先が要ります' });
      const r = await getThreads().publishReply({ token: tok.token, userId: tok.userId, text, replyToId });
      res.status(r.ok ? 200 : 500).json(r);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 成長の仕組みを今すぐ走らせる（確認用。?daily=1 / ?weekly=1）
  app.get('/admin/growth', async (req, res) => {
    if (!gate(req, res)) return;
    try {
      const tok = await getStore().getToken();
      if (!tok || !tok.token) return res.status(503).json({ ok: false, error: '鍵なし' });
      const g = getGrowth();
      const out = {};
      if (req.query.daily === '1') out.daily = await g.daily(tok);
      if (req.query.weekly === '1') out.weekly = await g.weekly(tok);
      if (req.query.weights === '1') out.weights = await g.weightsFor();
      res.json(out);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // その日の枠を足す（?account=cafe&slots=16:58,18:07）。2026-10-29 社長「今日から5本にして」。過ぎた時刻・形の違う値は 400
  const ADD_SLOTS_MAX = 8;
  const ADD_SLOTS_GAP_MIN = 30; // 連投にならない最低限の間（ふだんの抽選は 90 分）
  app.get('/admin/add-slots', async (req, res) => {
    if (!gate(req, res)) return;
    try {
      const { jstDateKey, jstHm } = require('./slots');
      const t = now();
      const times = [...new Set(String(req.query.slots || '').split(/[,;\s]+/).filter(Boolean))];
      const nowHm = jstHm(t);
      const bad = times.filter((x) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(x) || x <= nowHm);
      if (!times.length || bad.length) return res.status(400).json({ ok: false, error: `時刻は HH:MM で今（${nowHm}）より後: ${bad.join(',') || '空'}` });
      const store = storeFor(req.query.account === 'cafe' ? 'cafe' : 'hobby');
      const cur = (await store.getDay(jstDateKey(t))) || { slots: [] };
      const mins = (x) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3));
      const all = [...cur.slots, ...times.filter((x) => !cur.slots.includes(x))];
      if (all.length > ADD_SLOTS_MAX) return res.status(400).json({ ok: false, error: `1 日 ${ADD_SLOTS_MAX} 本まで（足すと ${all.length} 本）` });
      const close = times.filter((x) => all.some((y) => y !== x && Math.abs(mins(x) - mins(y)) < ADD_SLOTS_GAP_MIN));
      if (close.length) return res.status(400).json({ ok: false, error: `ほかの枠と ${ADD_SLOTS_GAP_MIN} 分以上あける: ${close.join(',')}` });
      const day = await store.addSlots(jstDateKey(t), times);
      if (!day) return res.status(404).json({ ok: false, error: '今日の枠がまだ無い（見回りが一度動いてから）' });
      res.json({ ok: true, slots: day.slots });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/admin/status', async (req, res) => {
    if (!gate(req, res)) return;
    try {
      const store = storeFor(req.query.account === 'cafe' ? 'cafe' : 'hobby');
      const { jstDateKey } = require('./slots');
      const { daysLeft } = require('./tick');
      const t = now();
      const tok = await store.getToken();
      res.json({
        today: await store.getDay(jstDateKey(t)),
        token: tok ? { userId: tok.userId, expiresAt: tok.expiresAt, daysLeft: daysLeft(tok.expiresAt, t) } : null,
        lastPosts: await store.recentPosts(5),
        enabled: env.THREADS_ENABLED !== 'false',
        autoPost: env.THREADS_AUTO_POST !== 'false',
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // OAuth: 社長が「新垢でログインしたブラウザ」で /oauth/start?key=… を開く → Threads の許可画面 → /oauth/callback にトークンが入る。
  // state は Firestore に 10 分だけ置き、合わない・古い・2 回目は 403（誰かが勝手に別アカウントを結び付けないため）
  app.get('/oauth/start', async (req, res) => {
    if (!gate(req, res)) return;
    if (!env.PUBLIC_BASE_URL) return res.status(503).type('text/plain').send('PUBLIC_BASE_URL 未設定');
    try {
      const account = req.query.account === 'cafe' ? 'cafe' : 'hobby';
      const state = `${account}.${crypto.randomBytes(24).toString('base64url')}`;
      await getStore().setOauthState(state);
      res.redirect(302, getThreads().authorizeUrl({ redirectUri: redirectUri(), state }));
    } catch (e) {
      console.error('[threads] OAUTH_START_ERROR:', e);
      res.status(500).type('text/plain').send(`エラー: ${e.message}`);
    }
  });

  app.get('/oauth/callback', async (req, res) => {
    const q = req.query || {};
    if (!q.code) {
      return res.status(400).type('text/plain').send(`Threads から code が返りませんでした: ${q.error || ''} ${q.error_description || ''}`.trim());
    }
    try {
      const okState = await getStore().takeOauthState(String(q.state || ''));
      if (!okState) {
        console.warn('[threads] OAUTH_STATE_MISMATCH');
        return res.status(403).type('text/plain').send('state が合いません（古いか 2 回目）。/oauth/start からやり直してください');
      }
      const account = String(q.state || '').startsWith('cafe.') ? 'cafe' : 'hobby';
      const t = await getThreads().exchangeCode({ code: String(q.code), redirectUri: redirectUri() });
      // 違うアカウントでログインしたまま接続するのを防ぐ（趣味用と公式が同じ利用者なら止める）
      const other = await storeFor(account === 'cafe' ? 'hobby' : 'cafe').getToken();
      if (other && other.userId && String(other.userId) === String(t.userId)) {
        console.warn(`[threads] OAUTH_SAME_USER account=${account} user=${t.userId}`);
        return res.status(409).type('text/plain').send(`このブラウザでログインしているのは${account === 'cafe' ? '趣味用' : '公式'}のアカウントです。${account === 'cafe' ? 'セルフカフェ公式' : '趣味用'}の Threads でログインし直してから、もう一度開いてください（何も保存していません）`);
      }
      await storeFor(account).setToken(t);
      console.log(`[threads] OAUTH_OK account=${account} user=${t.userId} expires=${t.expiresAt}`);
      res.type('text/plain').send(`Threads と接続しました（${account === 'cafe' ? 'セルフカフェ公式' : '趣味用'}、user ${t.userId}、期限 ${t.expiresAt}）。このタブは閉じてOKです。`);
    } catch (e) {
      console.error('[threads] OAUTH_CALLBACK_ERROR:', e);
      res.status(500).type('text/plain').send(`接続に失敗しました: ${e.message}`);
    }
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  createApp().listen(port, () => console.log(`[threads] listening on ${port}`));
}

module.exports = { createApp };
