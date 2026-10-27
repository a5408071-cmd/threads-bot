const request = require('supertest');
const { createApp } = require('../src/server');
const { memoryStore } = require('../src/store');

describe('POST /api/post（イソからの写真付き投稿）', () => {
  const mk = (over = {}) => {
    const store = memoryStore();
    const threads = { publishPost: jest.fn(async () => ({ ok: true, mediaId: 'm9', permalink: 'https://www.threads.net/@x/post/zzz' })), ...(over.threads || {}) };
    const app = createApp({ env: { CRON_KEY: 'k', THREADS_BANNED_WORDS: 'ウッドデザインパーク;鈴木', ...(over.env || {}) }, store, threads, notify: { owner: jest.fn() } });
    return { app, store, threads };
  };
  const withToken = async (x) => { await x.store.setToken({ token: 'tk', userId: 'u1', expiresAt: '2026-12-20T00:00:00.000Z' }); return x; };

  test('鍵が無いと 403、本文が空なら 400', async () => {
    const { app } = await withToken(mk());
    await request(app).post('/api/post').send({ text: 'x' }).expect(403);
    const r = await request(app).post('/api/post').set('X-Cron-Key', 'k').send({ text: '  ' }).expect(400);
    expect(r.body.ok).toBe(false);
  });

  test('NG 語で 400 と blocked、force で通る', async () => {
    const { app, threads } = await withToken(mk());
    const r = await request(app).post('/api/post').set('X-Cron-Key', 'k').send({ text: '鈴木とゴルフ' }).expect(400);
    expect(r.body).toMatchObject({ ok: false, blocked: true, reason: 'NG語: 鈴木', words: ['鈴木'] });
    expect(threads.publishPost).not.toHaveBeenCalled();
    const r2 = await request(app).post('/api/post').set('X-Cron-Key', 'k').send({ text: '鈴木とゴルフ', force: true }).expect(200);
    expect(r2.body).toMatchObject({ ok: true, mediaId: 'm9', permalink: 'https://www.threads.net/@x/post/zzz' });
  });

  test('preview は publish を呼ばず本文と検査結果を返す', async () => {
    const { app, threads } = await withToken(mk());
    const r = await request(app).post('/api/post').set('X-Cron-Key', 'k').send({ text: '岐阜でゆるゴルフでした', imageUrl: 'https://iso.example/media/drive/abc.jpg?sig=1', preview: true }).expect(200);
    expect(r.body).toEqual({ ok: true, preview: true, text: '岐阜でゆるゴルフでした', imageUrl: 'https://iso.example/media/drive/abc.jpg?sig=1', check: { ok: true } });
    expect(threads.publishPost).not.toHaveBeenCalled();
    const r2 = await request(app).post('/api/post').set('X-Cron-Key', 'k').send({ text: '鈴木とゴルフ', preview: true }).expect(200);
    expect(r2.body.check).toEqual({ ok: false, reason: 'NG語: 鈴木' });
  });

  test('https 以外の imageUrl は 400', async () => {
    const { app } = await withToken(mk());
    const r = await request(app).post('/api/post').set('X-Cron-Key', 'k').send({ text: 'x', imageUrl: 'http://a/b.jpg' }).expect(400);
    expect(r.body.error).toMatch(/https/);
  });

  test('成功で permalink、savePost に source:iso、枠は消費しない', async () => {
    const { app, store, threads } = await withToken(mk());
    await store.ensureDay('2026-10-28', () => ({ slots: ['09:17'] }));
    const r = await request(app).post('/api/post').set('X-Cron-Key', 'k').send({ text: '岐阜でゆるゴルフでした', imageUrl: 'https://iso.example/m.jpg' }).expect(200);
    expect(r.body).toEqual({ ok: true, mediaId: 'm9', permalink: 'https://www.threads.net/@x/post/zzz' });
    expect(threads.publishPost).toHaveBeenCalledWith({ token: 'tk', userId: 'u1', text: '岐阜でゆるゴルフでした', imageUrl: 'https://iso.example/m.jpg' });
    expect(await store.recentPosts(1)).toEqual([expect.objectContaining({ mediaId: 'm9', source: 'iso', text: '岐阜でゆるゴルフでした', permalink: 'https://www.threads.net/@x/post/zzz' })]);
    expect((await store.getDay('2026-10-28')).posted).toEqual([]);
  });

  test('publish 失敗は 500 で stage と error', async () => {
    const { app } = await withToken(mk({ threads: { publishPost: jest.fn(async () => ({ ok: false, stage: 'status', error: 'ERROR: bad image' })) } }));
    const r = await request(app).post('/api/post').set('X-Cron-Key', 'k').send({ text: 'x', imageUrl: 'https://a/b.jpg' }).expect(500);
    expect(r.body).toEqual({ ok: false, stage: 'status', error: 'ERROR: bad image' });
  });

  test('トークンが無ければ 503、停止中は 503', async () => {
    const { app } = mk();
    const r = await request(app).post('/api/post').set('X-Cron-Key', 'k').send({ text: 'x' }).expect(503);
    expect(r.body.error).toMatch(/鍵/);
    const { app: app2 } = await withToken(mk({ env: { THREADS_ENABLED: 'false' } }));
    const r2 = await request(app2).post('/api/post').set('X-Cron-Key', 'k').send({ text: 'x' }).expect(503);
    expect(r2.body.error).toMatch(/停止中/);
  });
});
