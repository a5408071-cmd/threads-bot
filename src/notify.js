/**
 * 社長 DM への知らせ。threads-bot は LINE WORKS を持たないので、iso-bot の /admin/post（to:'owner'、X-Cron-Key）を経由する。
 * 失敗しても投げない（投稿そのものを止めないため）。ログ [threads] NOTIFY_FAILED に残す。
 */
function createNotify({ http, env = process.env } = {}) {
  const client = http || require('axios');

  async function owner(text) {
    const body = String(text || '').trim();
    if (!body) return { ok: false, error: '本文が空' };
    if (!env.ISO_BOT_URL || !env.ISO_CRON_KEY) return { ok: false, error: 'ISO_BOT_URL / ISO_CRON_KEY 未設定' };
    const url = `${String(env.ISO_BOT_URL).replace(/\/+$/, '')}/admin/post`;
    try {
      await client.post(url, { to: 'owner', text: body }, { headers: { 'X-Cron-Key': env.ISO_CRON_KEY, 'Content-Type': 'application/json' }, timeout: 15000 });
      return { ok: true };
    } catch (e) {
      const status = e && e.response && e.response.status;
      const error = `${status ? `HTTP ${status}: ` : ''}${(e && e.message) || e}`;
      console.error(`[threads] NOTIFY_FAILED ${error}`);
      return { ok: false, error };
    }
  }

  return { owner };
}

module.exports = { createNotify };
