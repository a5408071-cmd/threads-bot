/**
 * セルフカフェ公式の毎日の見直し（2026-11-02 社長「伸ばす投稿を日々ブラッシュアップしていきたい」）。
 *   daily     : 毎朝（数字の記録のあと）直近 7 日の投稿の数字を AI に見せ、型の配分（weights）と「伸びやすい書き方」のメモ（notes）を作って
 *               threads_cafe_config/strategy に保存する。1 日 1 回。社長への報告は月曜だけ（毎日 DM すると多い）。
 *   weightsFor: 今の配分（pickCafeType に渡す）。無ければ null＝今までどおり
 *   notesText : 投稿を書くときの指示に足す文（無ければ空）
 * 店名・駅名・数字・URL を書かないなどの決まりはメモで変えさせない（AI にもそう伝える）。失敗しても投稿は止めない。
 */
const personaCafe = require('./personaCafe');
const { jstDateKey } = require('./slots');
const { WEEKLY_DAY } = require('./growth');

const LOOKBACK_DAYS = 7;
const MIN_POSTS = 3; // 数字の付いた投稿がこれ未満なら見直さない
const MAX_NOTES = 5;
const NOTE_MAX = 80;
const MODEL = 'claude-opus-5-5';
const LABEL = '【公式】';
const WD = ['日', '月', '火', '水', '木', '金', '土'];

function summarize(posts, metrics) {
  const lines = [`フォロワー数の推移（日付: 人数）: ${metrics.map((m) => `${m.date}: ${m.followers}`).join(', ') || '記録なし'}`];
  lines.push('投稿ごと（型 | 曜日 時刻JST | タグ | 表示 | いいね | 返信 | 再投稿 | 本文の冒頭）:');
  for (const p of posts) {
    const i = p.insights || {};
    const j = new Date(new Date(p.postedAt).getTime() + 9 * 3600 * 1000);
    lines.push(`- ${p.type} | ${WD[j.getUTCDay()]} ${j.toISOString().slice(11, 16)} | ${p.tag || '-'} | ${i.views || 0} | ${i.likes || 0} | ${i.replies || 0} | ${i.reposts || 0} | ${String(p.text || '').replace(/\n/g, ' ').slice(0, 60)}`);
  }
  return lines.join('\n');
}

function createCafeLearning({ store, anthropic, notify, env = process.env, now = () => new Date() }) {
  async function strategy() {
    try { return (await store.getConfig('strategy')) || null; } catch (e) { console.warn(`[threads] CAFE_STRATEGY_READ_FAILED ${e.message}`); return null; }
  }

  async function weightsFor() {
    const s = await strategy();
    if (!s || !s.weights || typeof s.weights !== 'object') return null;
    const w = {};
    for (const t of personaCafe.TYPES) if (t in s.weights) w[t] = s.weights[t];
    return Object.values(w).some((v) => v > 0) ? w : null;
  }

  async function notesText() {
    const s = await strategy();
    const notes = (s && Array.isArray(s.notes) ? s.notes : []).filter(Boolean);
    if (!notes.length) return '';
    return `これまでの数字から分かった、伸びやすい書き方（上の決まりを守れる範囲で取り入れる）:\n${notes.map((n) => `- ${n}`).join('\n')}`;
  }

  async function daily() {
    const t = now();
    const key = `learn:${jstDateKey(t)}`;
    if (await store.getConfig(key)) return { ok: true, skipped: 'done' };
    const since = t.getTime() - LOOKBACK_DAYS * 86400000;
    const posts = (await store.recentPosts(60)).filter((p) => new Date(p.postedAt).getTime() >= since && p.insights);
    if (posts.length < MIN_POSTS) return { ok: true, skipped: 'few', posts: posts.length };
    const metrics = (await store.listMetrics(14)).filter((m) => m.followers != null);
    const prev = await strategy();
    const prompt = [
      'あなたはセルフカフェ（無人のワークスペース型カフェ）公式 Threads アカウントの運用担当です。目的は表示・いいね・返信を増やし、フォロワーを増やすこと。',
      '直近 7 日の投稿の数字を見比べて、伸びた投稿と伸びなかった投稿の違い（型・曜日と時間・タグ・書き出し・長さ・問いかけの有無・写真・取り上げた話題）を探し、次のものを作ってください。',
      `1. weights: 型ごとの配分（各 0〜5 の整数）。型: ${personaCafe.TYPES.join(', ')}。新店・キャンペーン・メディアの告知（newstore・campaign・media）は記事があるときに自動で出るので配分には入れない。本数が少なくて判断できない型は今の値（無ければ 2）のまま。`,
      `2. notes: 次の投稿を書く人への具体的な指示を ${MAX_NOTES} つまで（各 ${NOTE_MAX} 字以内）。「何をすると伸びた／伸びなかった」を、すぐ実行できる形で（例: 新店のタグは駅名でなく市区の名前にする／1 行目に問いかけを置く）。`,
      '   変えてはいけない決まり: ふだんの回で店名・駅名・地名を書かない、料金などの数字を書かない、URL・ハッシュタグを書かない、他社と比べない、事実に無い設備を書かない。これに反する指示は書かない。時刻は選べないので時間帯の指示は書かない（気づきとして report に書くのはよい）。',
      '   数字の差が小さくて言い切れないことは書かない。前回のメモで効かなかったものは外す。',
      '3. report: 社長への短い報告（200 字以内。数字と「来週こうする」）。',
      prev && prev.notes && prev.notes.length ? `前回のメモ: ${prev.notes.join(' ／ ')}` : '',
      prev && prev.weights ? `今の配分: ${JSON.stringify(prev.weights)}` : '',
      '',
      summarize(posts, metrics),
      '',
      'JSON だけを返す: {"weights": {型: 整数, ...}, "notes": ["…", ...], "report": "…"}',
    ].filter((x) => x !== '').join('\n');
    let parsed = null;
    try {
      const res = await anthropic.messages.create({ model: env.THREADS_MODEL || MODEL, max_tokens: 8000, output_config: { effort: 'medium' }, messages: [{ role: 'user', content: prompt }] });
      const raw = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    } catch (e) {
      console.warn(`[threads] CAFE_LEARN_AI_FAILED ${e.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || (!parsed.weights && !parsed.notes)) return { ok: false, error: 'AI の答えが読めない（前のメモ・配分のまま）' };
    const weights = {};
    const given = parsed.weights && typeof parsed.weights === 'object' ? parsed.weights : {};
    for (const ty of personaCafe.TYPES) {
      const cur = prev && prev.weights && ty in prev.weights ? prev.weights[ty] : 2;
      weights[ty] = ty in given ? Math.max(0, Math.min(5, Math.round(Number(given[ty]) || 0))) : cur;
    }
    const notes = (Array.isArray(parsed.notes) ? parsed.notes : []).map((n) => String(n).trim().slice(0, NOTE_MAX)).filter(Boolean).slice(0, MAX_NOTES);
    const keepWeights = Object.values(weights).some((v) => v > 0);
    await store.setConfig('strategy', { weights: keepWeights ? weights : (prev && prev.weights) || null, notes, report: String(parsed.report || ''), updatedAt: t.toISOString() });
    await store.setConfig(key, { at: t.toISOString() });

    let reported = false;
    const wd = new Date(t.getTime() + 9 * 3600 * 1000).getUTCDay();
    if (wd === WEEKLY_DAY && notify) {
      const latest = metrics.length ? metrics[metrics.length - 1].followers : null;
      const old = metrics.find((m) => new Date(m.date).getTime() <= since) || metrics[0];
      const delta = latest != null && old && old !== metrics[metrics.length - 1] ? latest - old.followers : null;
      const order = Object.entries(weights).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ');
      const msg = [
        `${LABEL}📈 Threads 週次（${jstDateKey(t)}）フォロワー ${latest ?? '不明'} 人${delta == null ? '' : `（7日で ${delta >= 0 ? '+' : ''}${delta}）`}`,
        String(parsed.report || ''),
        notes.length ? `\n今週の書き方:\n${notes.map((n) => `・${n}`).join('\n')}` : '',
        `\n配分: ${order}`,
      ].filter(Boolean).join('\n');
      try { const s = await notify.owner(msg); reported = Boolean(s && s.ok); } catch (e) { console.warn(`[threads] CAFE_LEARN_REPORT_FAILED ${e.message}`); }
    }
    console.log(`[threads] CAFE_LEARN posts=${posts.length} notes=${notes.length} reported=${reported}`);
    return { ok: true, weights, notes, reported };
  }

  return { daily, weightsFor, notesText };
}

module.exports = { createCafeLearning, summarize };
