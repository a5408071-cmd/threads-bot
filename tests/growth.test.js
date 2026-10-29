const { createGrowth, DEFAULT_WEIGHTS } = require('../src/growth');
const { memoryStore } = require('../src/store');

const NOW = new Date('2026-11-02T07:05:00+09:00'); // 月曜 7:05 JST
const TOKEN = { token: 'tk', userId: 'u1' };

function mk({ store = memoryStore({ now: () => NOW }), now = () => NOW, followers = 42, insights = {}, ai = null } = {}) {
  const threads = {
    userInsights: jest.fn(async () => ({ followers })),
    postInsights: jest.fn(async ({ mediaId }) => insights[mediaId] || { views: 0, likes: 0, replies: 0, reposts: 0, quotes: 0 }),
  };
  const notify = { owner: jest.fn(async () => ({ ok: true })) };
  const anthropic = ai || { messages: { create: jest.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify({ weights: { question: 3, aruaru: 1, invite: 1, season: 1, small: 1, hook: 2, work: 2, fitness: 3, daily: 1, news: 1 }, notes: ['質問型と運動型が伸びている'], report: '今週は +30 人。質問型と運動型が強い。' }) }], stop_reason: 'end_turn' })) } };
  const growth = createGrowth({ threads, store, notify, anthropic, env: {}, now });
  return { growth, threads, notify, anthropic, store };
}

test('daily: フォロワー数と直近 7 日の投稿の数字を記録する（1 日 1 回）', async () => {
  const { growth, store, threads } = mk({ followers: 42, insights: { m1: { views: 500, likes: 12, replies: 3, reposts: 0, quotes: 1 } } });
  await store.savePost({ mediaId: 'm1', text: 't', type: 'question', source: 'auto', postedAt: '2026-11-01T10:00:00.000Z' });
  await store.savePost({ mediaId: 'old', text: 't', type: 'hook', source: 'auto', postedAt: '2026-10-01T10:00:00.000Z' });
  const r = await growth.daily(TOKEN);
  expect(r).toMatchObject({ ok: true, followers: 42, updated: 1 });
  expect(await store.getMetric('2026-11-02')).toMatchObject({ followers: 42 });
  expect((await store.recentPosts(2)).find((p) => p.mediaId === 'm1').insights).toEqual({ views: 500, likes: 12, replies: 3, reposts: 0, quotes: 1 });
  expect(threads.postInsights).toHaveBeenCalledTimes(1); // 古い投稿は見ない
  const r2 = await growth.daily(TOKEN);
  expect(r2.skipped).toBe('done'); // 同じ日は 1 回
});

test('weekly: 月曜に直近 7 日の数字を AI に渡して配分（weights）と報告を作り、保存して社長 DM', async () => {
  const { growth, store, notify, anthropic } = mk();
  await store.setMetric('2026-10-26', { followers: 12 });
  await store.setMetric('2026-11-02', { followers: 42 });
  await store.savePost({ mediaId: 'm1', text: '質問の投稿', type: 'question', source: 'auto', postedAt: '2026-11-01T10:00:00.000Z', insights: { views: 500, likes: 12, replies: 3, reposts: 0, quotes: 0 }, photoId: 'P1' });
  await store.savePost({ mediaId: 'm2', text: '仕事の投稿', type: 'work', source: 'auto', postedAt: '2026-10-31T10:00:00.000Z', insights: { views: 100, likes: 1, replies: 0, reposts: 0, quotes: 0 } });
  const r = await growth.weekly(TOKEN);
  expect(r.ok).toBe(true);
  const strategy = await store.getConfig('strategy');
  expect(strategy.weights).toMatchObject({ question: 3, fitness: 3 });
  expect(notify.owner.mock.calls[0][0]).toMatch(/今週は \+30 人/);
  expect(notify.owner.mock.calls[0][0]).toMatch(/42/);
  const prompt = JSON.stringify(anthropic.messages.create.mock.calls[0][0].messages);
  expect(prompt).toMatch(/500/); expect(prompt).toMatch(/question/); expect(prompt).toMatch(/写真/);
  expect(await growth.weekly(TOKEN)).toMatchObject({ skipped: 'done' });
});

test('weekly: AI の答えが読めなければ配分は変えず、報告だけ送る', async () => {
  const ai = { messages: { create: jest.fn(async () => ({ content: [{ type: 'text', text: 'まとまりませんでした' }], stop_reason: 'end_turn' })) } };
  const { growth, store, notify } = mk({ ai });
  await store.setConfig('strategy', { weights: { question: 5 } });
  const r = await growth.weekly(TOKEN);
  expect(r.ok).toBe(false);
  expect((await store.getConfig('strategy')).weights).toEqual({ question: 5 });
  expect(notify.owner).toHaveBeenCalled();
});

test('weightsFor: 保存した配分が無ければ既定', async () => {
  const { growth, store } = mk();
  expect(await growth.weightsFor()).toEqual(DEFAULT_WEIGHTS);
  await store.setConfig('strategy', { weights: { question: 9 } });
  expect((await growth.weightsFor()).question).toBe(9);
});

test('weekly: AI の答えに無い型（後から足した countdown など）は 0 にせず今の重みのまま', async () => {
  const { growth, store } = mk();
  await growth.weekly(TOKEN);
  const { weights } = await store.getConfig('strategy');
  expect(weights).toMatchObject({ countdown: DEFAULT_WEIGHTS.countdown, koyomi: DEFAULT_WEIGHTS.koyomi, tips: DEFAULT_WEIGHTS.tips });
  expect(DEFAULT_WEIGHTS.countdown).toBeGreaterThan(0);
});
