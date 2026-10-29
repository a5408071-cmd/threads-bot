/**
 * 成長の仕組み（2026-10-28 社長「1か月以内でフォロワー500人はいってね どうすれば増えるかは日々自分で考えて」）。
 *   daily : 毎朝 1 回、フォロワー数と直近 7 日の投稿の数字（表示・いいね・返信・再投稿・引用）を記録する（threads_metrics/<日付>、threads_posts の insights）
 *   weekly: 月曜に直近 7 日を AI に見せ、型ごとの配分（weights）と短い報告を作る → threads_config/strategy に保存 → 社長 DM に報告
 *   weightsFor: 今の配分（pickType に渡す）。無ければ既定
 * 失敗しても投稿は止めない（errors で返す）。
 */
const { jstDateKey } = require('./slots');

const DEFAULT_WEIGHTS = { question: 2, aruaru: 1, invite: 1, season: 1, small: 1, hook: 1, work: 2, fitness: 2, daily: 1, news: 1, countdown: 1, koyomi: 1, tips: 1 };
const LOOKBACK_DAYS = 7;
const WEEKLY_DAY = 1; // 月曜
const DEFAULT_MODEL = 'claude-opus-5-5';
const GOAL = 500;

function createGrowth({ threads, store, notify, anthropic, env = process.env, now = () => new Date() }) {
  const dateKey = () => jstDateKey(now());

  async function weightsFor() {
    try {
      const s = await store.getConfig('strategy');
      if (s && s.weights && typeof s.weights === 'object') return { ...DEFAULT_WEIGHTS, ...s.weights };
    } catch (e) { console.warn(`[threads] STRATEGY_READ_FAILED ${e.message}`); }
    return { ...DEFAULT_WEIGHTS };
  }

  /** 1 日 1 回: フォロワー数と直近 7 日の投稿の数字を記録 */
  async function daily(token) {
    const key = dateKey();
    const existing = await store.getMetric(key);
    if (existing && existing.followers != null) return { ok: true, skipped: 'done', followers: existing.followers };
    const out = { ok: true, followers: null, updated: 0, errors: [] };
    try {
      const u = await threads.userInsights({ token: token.token });
      out.followers = u.followers;
    } catch (e) {
      out.errors.push(`フォロワー数が取れない: ${e.message}`);
    }
    const since = now().getTime() - LOOKBACK_DAYS * 86400000;
    const posts = (await store.recentPosts(60)).filter((p) => new Date(p.postedAt).getTime() >= since);
    for (const p of posts) {
      try {
        const ins = await threads.postInsights({ token: token.token, mediaId: p.mediaId });
        await store.updatePost(p.mediaId, { insights: ins, insightsAt: now().toISOString() });
        out.updated++;
      } catch (e) {
        out.errors.push(`投稿 ${p.mediaId} の数字が取れない: ${e.message}`);
      }
    }
    if (out.followers != null) await store.setMetric(key, { followers: out.followers, posts7d: posts.length });
    if (out.errors.length) out.ok = false;
    console.log(`[threads] GROWTH_DAILY followers=${out.followers} updated=${out.updated} errors=${out.errors.length}`);
    return out;
  }

  function summarize(posts, metrics) {
    const byType = {};
    for (const p of posts) {
      const t = p.type || '?';
      const b = byType[t] || (byType[t] = { n: 0, views: 0, likes: 0, replies: 0, withPhoto: 0 });
      b.n++;
      const i = p.insights || {};
      b.views += i.views || 0; b.likes += i.likes || 0; b.replies += i.replies || 0;
      if (p.photoId) b.withPhoto++;
    }
    const lines = [];
    lines.push(`フォロワー数の推移（日付: 人数）: ${metrics.map((m) => `${m.date}: ${m.followers}`).join(', ') || '記録なし'}`);
    lines.push('型ごとの合計（本数 / 表示 / いいね / 返信 / 写真あり本数）:');
    for (const [t, b] of Object.entries(byType)) lines.push(`- ${t}: ${b.n} / ${b.views} / ${b.likes} / ${b.replies} / ${b.withPhoto}`);
    lines.push('投稿ごと（型 | 写真 | 時刻JST | 表示 | いいね | 返信 | 本文の冒頭）:');
    for (const p of posts) {
      const i = p.insights || {};
      const hm = new Date(new Date(p.postedAt).getTime() + 9 * 3600 * 1000).toISOString().slice(11, 16);
      lines.push(`- ${p.type} | ${p.photoId ? '写真' : 'なし'} | ${hm} | ${i.views || 0} | ${i.likes || 0} | ${i.replies || 0} | ${String(p.text || '').replace(/\n/g, ' ').slice(0, 40)}`);
    }
    return lines.join('\n');
  }

  /** 月曜に 1 回: 配分と報告 */
  async function weekly(token) {
    const key = `weekly:${dateKey()}`;
    if (await store.getConfig(key)) return { ok: true, skipped: 'done' };
    const since = now().getTime() - LOOKBACK_DAYS * 86400000;
    const posts = (await store.recentPosts(60)).filter((p) => new Date(p.postedAt).getTime() >= since);
    const metrics = (await store.listMetrics(14)).filter((m) => m.followers != null);
    const latest = metrics.length ? metrics[metrics.length - 1].followers : null;
    const weekAgo = metrics.find((m) => new Date(m.date).getTime() <= since - 1) || metrics[0];
    const delta = latest != null && weekAgo ? latest - weekAgo.followers : null;
    const current = await weightsFor();
    const prompt = [
      `あなたは Threads アカウントの運用を考える担当です。目標: 1 か月以内にフォロワー ${GOAL} 人（今 ${latest ?? '不明'} 人、この 7 日で ${delta == null ? '不明' : (delta >= 0 ? '+' : '') + delta} 人）。`,
      '直近 7 日の投稿の数字を見て、来週の投稿の型ごとの配分（weights）を決め、社長に送る短い報告（200 字以内。数字と「来週こうする」）を書いてください。',
      `型: question（ゴルフの質問）, aruaru（ゴルフ・飲みのあるある）, invite（誘い）, season（季節）, small（道具・酒の小ネタ）, hook（問いかけで締める）, work（経営者の仕事）, fitness（マラソン・ジム）, daily（キラキラ日常）, news（時事）, countdown（試験・行事の残り日数）, koyomi（暦）, tips（継続・やる気のコツ）。今の配分: ${JSON.stringify(current)}`,
      '判断のコツ: 返信が多い型はアルゴリズムに強いので増やす。表示が少ない型は減らす（0 にはしない。各型 0〜5 の整数で、合計 10〜20）。写真あり/なしの差、時間帯の差も見る。本数が少なくて判断できない型は今の値のまま。',
      '',
      summarize(posts, metrics),
      '',
      'JSON だけを返す: {"weights": {型: 整数, ...}, "notes": ["気づき", ...], "report": "社長への報告（200字以内）"}',
    ].join('\n');
    let parsed = null; let raw = '';
    try {
      const res = await anthropic.messages.create({ model: env.THREADS_MODEL || DEFAULT_MODEL, max_tokens: 8000, output_config: { effort: 'medium' }, messages: [{ role: 'user', content: prompt }] });
      raw = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    } catch (e) {
      console.warn(`[threads] GROWTH_WEEKLY_AI_FAILED ${e.message}`);
    }
    const head = `📈 Threads 週次（${dateKey()}）フォロワー ${latest ?? '不明'} 人${delta == null ? '' : `（7日で ${delta >= 0 ? '+' : ''}${delta}）`}／目標 ${GOAL}`;
    if (!parsed || !parsed.weights || typeof parsed.weights !== 'object') {
      await notify.owner(`${head}\n分析がまとまりませんでした。配分は前のままにします。`);
      await store.setConfig(key, { at: now().toISOString(), ok: false });
      return { ok: false, error: 'AI の答えが読めない', raw: raw.slice(0, 200) };
    }
    const weights = {};
    for (const t of Object.keys(DEFAULT_WEIGHTS)) weights[t] = t in parsed.weights ? Math.max(0, Math.min(5, Math.round(Number(parsed.weights[t]) || 0))) : (current[t] ?? DEFAULT_WEIGHTS[t]); // 答えに無い型（後から足した型など）は今の重みのまま
    if (!Object.values(weights).some((v) => v > 0)) Object.assign(weights, current);
    await store.setConfig('strategy', { weights, notes: parsed.notes || [], updatedAt: now().toISOString(), followers: latest, delta });
    await store.setConfig(key, { at: now().toISOString(), ok: true });
    const order = Object.entries(weights).sort((a, b) => b[1] - a[1]).map(([t, w]) => `${t}:${w}`).join(' ');
    await notify.owner(`${head}\n${parsed.report || ''}\n\n来週の配分: ${order}${(parsed.notes || []).length ? `\n・${(parsed.notes || []).slice(0, 3).join('\n・')}` : ''}`);
    console.log(`[threads] GROWTH_WEEKLY followers=${latest} delta=${delta} weights=${order}`);
    return { ok: true, weights, followers: latest, delta };
  }

  return { daily, weekly, weightsFor, summarize };
}

module.exports = { createGrowth, DEFAULT_WEIGHTS, WEEKLY_DAY, GOAL };
