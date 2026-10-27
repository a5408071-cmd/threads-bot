/**
 * threads-bot の HTTP 入口。
 *   GET  /healthz        … 生存確認
 *   GET  /cron/tick      … 10分おきの見回り（X-Cron-Key か ?key=）
 * 外部（Firestore・Anthropic・Threads・iso-bot）は deps で差し替えられる（テストは本物につながない）。
 */
const express = require('express');
const { cronAuthorized } = require('./auth');

function createApp(deps = {}) {
  const env = deps.env || process.env;
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

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  createApp().listen(port, () => console.log(`[threads] listening on ${port}`));
}

module.exports = { createApp };
