const request = require('supertest');
const { createApp } = require('../src/server');
const { memoryStore } = require('../src/store');
const scheduled = require('../src/scheduled');

// 予約投稿（2026-11-02 社長「これを参考に明日投稿して」）。/api/post に at を付けると預かり、10分おきの見回りが時刻に出す
const T = new Date('2026-11-03T11:00:00Z'); // JST 20:00
const withToken = async (store) => { await store.setToken({ token: 'tk', userId: 'u1', expiresAt: '2026-12-20T00:00:00.000Z' }); return store; };

test('at を付けた /api/post は投稿せずに預かる。形が違う・過ぎた時刻・返信の NG 語は 400', async () => {
  const store = memoryStore();
  const threads = { publishPost: jest.fn() };
  const app = createApp({ env: { CRON_KEY: 'k', THREADS_BANNED_WORDS: '鈴木' }, store, threads, notify: { owner: jest.fn() }, now: () => new Date('2026-11-02T13:00:00Z') });
  const r = await request(app).post('/api/post').set('X-Cron-Key', 'k').send({ text: '本文', at: '2026-11-03T20:00', replyText: 'リンクはこちら https://nakamaboard.com/' }).expect(200);
  expect(r.body).toMatchObject({ ok: true, scheduled: true, at: '2026-11-03T20:00' });
  expect(threads.publishPost).not.toHaveBeenCalled();
  expect(await store.listScheduled()).toHaveLength(1);
  await request(app).post('/api/post').set('X-Cron-Key', 'k').send({ text: '本文', at: '明日' }).expect(400);
  await request(app).post('/api/post').set('X-Cron-Key', 'k').send({ text: '本文', at: '2026-11-01T20:00' }).expect(400);
  await request(app).post('/api/post').set('X-Cron-Key', 'k').send({ text: '本文', at: '2026-11-03T20:00', replyText: '鈴木です' }).expect(400);
});

test('runDue: 時刻を過ぎたものだけ出し、返信を本投稿にぶら下げ、2回は出さない', async () => {
  const store = await withToken(memoryStore());
  await scheduled.add(store, { at: '2026-11-03T20:00', text: '本文A', topicTag: 'ホノルルマラソン', replyText: 'こちら https://nakamaboard.com/' });
  await scheduled.add(store, { at: '2026-11-04T20:00', text: '本文B' });
  const threads = { publishPost: jest.fn(async ({ replyToId }) => ({ ok: true, mediaId: replyToId ? 'r1' : 'm1', permalink: 'https://threads.example/p' })) };
  const r = await scheduled.runDue({ store, threads, now: () => T });
  expect(r.posted).toHaveLength(1);
  expect(threads.publishPost).toHaveBeenNthCalledWith(1, expect.objectContaining({ text: '本文A', topicTag: 'ホノルルマラソン' }));
  expect(threads.publishPost).toHaveBeenNthCalledWith(2, expect.objectContaining({ text: 'こちら https://nakamaboard.com/', replyToId: 'm1' }));
  const again = await scheduled.runDue({ store, threads, now: () => T });
  expect(again.posted).toHaveLength(0);
  expect(threads.publishPost).toHaveBeenCalledTimes(2);
});

test('runDue: 本投稿に失敗したら errors に残し、claim を外す（次の見回りでやり直す）', async () => {
  const store = await withToken(memoryStore());
  await scheduled.add(store, { at: '2026-11-03T20:00', text: '本文A' });
  const threads = { publishPost: jest.fn(async () => ({ ok: false, stage: 'publish', error: 'down' })) };
  const r = await scheduled.runDue({ store, threads, now: () => T });
  expect(r.errors[0]).toMatch('down');
  const [x] = await store.listScheduled();
  expect(x.doneAt).toBeFalsy();
  expect(x.claimedAt).toBeNull();
});

test('runDue: 返信だけ失敗したら本投稿は出し直さず、次の見回りで返信だけやり直す', async () => {
  const store = await withToken(memoryStore());
  await scheduled.add(store, { at: '2026-11-03T20:00', text: '本文A', replyText: 'リンク' });
  let replyOk = false;
  const threads = { publishPost: jest.fn(async ({ replyToId }) => (replyToId ? (replyOk ? { ok: true, mediaId: 'r1' } : { ok: false, error: 'busy' }) : { ok: true, mediaId: 'm1' })) };
  const r1 = await scheduled.runDue({ store, threads, now: () => T });
  expect(r1.errors[0]).toMatch('返信');
  replyOk = true;
  await scheduled.runDue({ store, threads, now: () => T });
  expect(threads.publishPost.mock.calls.filter(([a]) => !a.replyToId)).toHaveLength(1);
  expect((await store.listScheduled())[0]).toMatchObject({ replyId: 'r1', doneAt: expect.any(String) });
});

test('runDue: 見回りが重なっても同じ予約は1回だけ（claim）', async () => {
  const store = await withToken(memoryStore());
  await scheduled.add(store, { at: '2026-11-03T20:00', text: '本文A' });
  let release;
  const gate = new Promise((r) => { release = r; });
  const threads = { publishPost: jest.fn(async () => { await gate; return { ok: true, mediaId: 'm1' }; }) };
  const a = scheduled.runDue({ store, threads, now: () => T });
  const b = scheduled.runDue({ store, threads, now: () => T });
  await new Promise((r) => setTimeout(r, 10));
  release();
  await Promise.all([a, b]);
  expect(threads.publishPost).toHaveBeenCalledTimes(1);
});

test('atMs: 存在しない日付は NaN', () => {
  expect(Number.isNaN(scheduled.atMs('2026-02-30T10:00'))).toBe(true);
  expect(scheduled.atMs('2026-11-03T20:00')).toBe(Date.parse('2026-11-03T11:00:00Z'));
});
