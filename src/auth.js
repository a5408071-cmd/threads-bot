/**
 * cron 系の合言葉。X-Cron-Key ヘッダかクエリ ?key= を CRON_KEY と一定時間で比べる。
 * 鍵そのものはログに書かない（経路と長さだけ）。
 */
const crypto = require('crypto');

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** @returns {boolean} 鍵が合えば true。CRON_KEY 未設定は常に false（呼ぶ側が 503 にする） */
function cronAuthorized(req, env = process.env) {
  if (!env.CRON_KEY) return false;
  const header = req.get ? req.get('x-cron-key') : null;
  const given = header || (req.query && req.query.key) || '';
  const ok = safeEqual(given, env.CRON_KEY);
  if (!ok) console.warn(`[threads] CRON_DENIED via=${header ? 'header' : given ? 'query' : 'none'} len=${String(given).length}`);
  return ok;
}

module.exports = { cronAuthorized, safeEqual };
