/**
 * threads-bot の HTTP 入口。
 *   GET  /healthz        … 生存確認
 *   GET  /cron/tick      … 10分おきの見回り（X-Cron-Key か ?key=）
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
  const redirectUri = () => `${String(env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')}/oauth/callback`;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  /** cron 系の共通の門。通れば true、通らなければ応答済みで false */
  const gate = (req, res) => {
    if (!env.CRON_KEY) { res.status(503).json({ ok: false, error: 'CRON_KEY未設定' }); return false; }
    if (!cronAuthorized(req, env)) { res.sendStatus(403); return false; }
    return true;
  };

  app.get('/cron/tick', async (req, res) => {
    if (!gate(req, res)) return;
    if (env.THREADS_ENABLED === 'false') return res.json({ ok: true, disabled: true });
    res.json({ ok: true });
  });

  // OAuth: 社長が「新垢でログインしたブラウザ」で /oauth/start?key=… を開く → Threads の許可画面 → /oauth/callback にトークンが入る。
  // state は Firestore に 10 分だけ置き、合わない・古い・2 回目は 403（誰かが勝手に別アカウントを結び付けないため）
  app.get('/oauth/start', async (req, res) => {
    if (!gate(req, res)) return;
    if (!env.PUBLIC_BASE_URL) return res.status(503).type('text/plain').send('PUBLIC_BASE_URL 未設定');
    try {
      const state = crypto.randomBytes(24).toString('base64url');
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
      const t = await getThreads().exchangeCode({ code: String(q.code), redirectUri: redirectUri() });
      await getStore().setToken(t);
      console.log(`[threads] OAUTH_OK user=${t.userId} expires=${t.expiresAt}`);
      res.type('text/plain').send(`Threads と接続しました（user ${t.userId}、期限 ${t.expiresAt}）。このタブは閉じてOKです。`);
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
