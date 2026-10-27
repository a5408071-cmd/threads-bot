const request = require('supertest');
const { createApp } = require('../src/server');

test('GET /health は ok（/healthz は Cloud Run の入口が横取りして 404 になる＝2026-10-27 実測。iso-bot も同じ）', async () => {
  const app = createApp({ env: { CRON_KEY: 'k' } });
  await request(app).get('/health').expect(200, { ok: true });
});

test('cron 系は鍵が無いと 403、ヘッダでもクエリでも通る', async () => {
  const app = createApp({ env: { CRON_KEY: 'k', THREADS_ENABLED: 'false' } });
  await request(app).get('/cron/tick').expect(403);
  await request(app).get('/cron/tick').set('X-Cron-Key', 'k').expect(200);
  await request(app).get('/cron/tick?key=k').expect(200);
});

test('CRON_KEY 未設定なら 503', async () => {
  const app = createApp({ env: {} });
  await request(app).get('/cron/tick?key=k').expect(503);
});

describe('OAuth（社長のブラウザで Threads と接続）', () => {
  const { memoryStore } = require('../src/store');
  const env = { CRON_KEY: 'k', THREADS_APP_ID: 'app', THREADS_APP_SECRET: 'sec', PUBLIC_BASE_URL: 'https://tb.example' };

  test('start は鍵無しで 403、鍵ありで authorize へ 302（state 付き）', async () => {
    const store = memoryStore();
    const app = createApp({ env, store, threads: { authorizeUrl: ({ redirectUri, state }) => `https://threads.net/oauth/authorize?r=${encodeURIComponent(redirectUri)}&state=${state}` } });
    await request(app).get('/oauth/start').expect(403);
    const r = await request(app).get('/oauth/start?key=k').expect(302);
    const loc = new URL(r.headers.location);
    expect(loc.hostname).toBe('threads.net');
    expect(loc.searchParams.get('r')).toBe('https://tb.example/oauth/callback');
    const state = loc.searchParams.get('state');
    expect(state).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  });

  test('callback は state 違いで 403、合えば exchangeCode → setToken → 200', async () => {
    const store = memoryStore();
    const exchangeCode = jest.fn(async () => ({ token: 'long', userId: 'u1', expiresAt: '2026-12-26T00:00:00.000Z' }));
    const app = createApp({ env, store, threads: { authorizeUrl: ({ state }) => `https://threads.net/oauth/authorize?state=${state}`, exchangeCode } });
    const r0 = await request(app).get('/oauth/start?key=k').expect(302);
    const state = new URL(r0.headers.location).searchParams.get('state');
    await request(app).get('/oauth/callback?code=cd&state=wrong').expect(403);
    expect(exchangeCode).not.toHaveBeenCalled();
    const r = await request(app).get(`/oauth/callback?code=cd&state=${state}`).expect(200);
    expect(r.text).toMatch(/接続しました/);
    expect(r.text).toMatch(/u1/);
    expect(exchangeCode).toHaveBeenCalledWith({ code: 'cd', redirectUri: 'https://tb.example/oauth/callback' });
    expect(await store.getToken()).toMatchObject({ token: 'long', userId: 'u1' });
    // state は 1 回きり
    await request(app).get(`/oauth/callback?code=cd&state=${state}`).expect(403);
  });

  test('callback は code 無し（ユーザーが拒否）なら 400 で理由を出す', async () => {
    const app = createApp({ env, store: memoryStore(), threads: {} });
    const r = await request(app).get('/oauth/callback?error=access_denied&error_description=The+user+denied').expect(400);
    expect(r.text).toMatch(/denied/);
  });

  test('callback で exchangeCode が失敗したら 500 でトークンは入らない', async () => {
    const store = memoryStore();
    const app = createApp({ env, store, threads: { authorizeUrl: ({ state }) => `https://x/?state=${state}`, exchangeCode: async () => { throw new Error('Invalid code'); } } });
    const state = new URL((await request(app).get('/oauth/start?key=k')).headers.location).searchParams.get('state');
    const r = await request(app).get(`/oauth/callback?code=cd&state=${state}`).expect(500);
    expect(r.text).toMatch(/Invalid code/);
    expect(await store.getToken()).toBeNull();
  });
});

describe('/cron/tick と /admin/status の配線', () => {
  const { memoryStore } = require('../src/store');
  test('/cron/tick は runTick の結果を返し、errors があれば 500', async () => {
    const store = memoryStore();
    const tick = { runTick: jest.fn(async ({ mode }) => ({ ok: mode !== 'live', errors: mode === 'live' ? ['x'] : [], mode })) };
    const app = createApp({ env: { CRON_KEY: 'k' }, store, tick, threads: {}, writer: {}, notify: {}, anthropic: {} });
    const r1 = await request(app).get('/cron/tick?key=k&dry=1').expect(200);
    expect(r1.body).toMatchObject({ ok: true, mode: 'dry' });
    const r2 = await request(app).get('/cron/tick?key=k&test=1').expect(200);
    expect(r2.body.mode).toBe('test');
    const r3 = await request(app).get('/cron/tick?key=k').expect(500);
    expect(r3.body).toMatchObject({ ok: false, errors: ['x'], mode: 'live' });
  });

  test('/admin/status は今日の枠・トークンの残り・直近の投稿を返す（鍵そのものは返さない）', async () => {
    const store = memoryStore({ now: () => new Date('2026-10-28T00:20:00+09:00') });
    await store.ensureDay('2026-10-28', () => ({ slots: ['09:17', '20:41'] }));
    await store.setToken({ token: 'SECRET', userId: 'u1', expiresAt: '2026-12-20T00:00:00.000Z' });
    await store.savePost({ mediaId: 'm1', text: 't', type: 'hook', source: 'auto', permalink: 'p' });
    const app = createApp({ env: { CRON_KEY: 'k' }, store, now: () => new Date('2026-10-28T00:20:00+09:00') });
    await request(app).get('/admin/status').expect(403);
    const r = await request(app).get('/admin/status?key=k').expect(200);
    expect(r.body.today).toMatchObject({ dateKey: '2026-10-28', slots: ['09:17', '20:41'] });
    expect(r.body.token).toEqual({ userId: 'u1', expiresAt: '2026-12-20T00:00:00.000Z', daysLeft: 53 });
    expect(JSON.stringify(r.body)).not.toMatch(/SECRET/);
    expect(r.body.lastPosts).toEqual([expect.objectContaining({ mediaId: 'm1' })]);
    expect(r.body.enabled).toBe(true);
  });
});

describe('GET /media/photo/:id.jpg（Meta が写真を取りに来る口）', () => {
  test('署名が合えば JPEG、違えば 403、無ければ 404', async () => {
    const photos = { serve: jest.fn(async (id, sig) => (id === 'PHOTOID1234567890' && sig === 'good' ? Buffer.from('jpegdata') : null)) };
    const app = createApp({ env: { CRON_KEY: 'k' }, photos });
    const r = await request(app).get('/media/photo/PHOTOID1234567890.jpg?sig=good').expect(200);
    expect(r.headers['content-type']).toMatch(/image\/jpeg/);
    expect(r.body.toString()).toBe('jpegdata');
    await request(app).get('/media/photo/PHOTOID1234567890.jpg?sig=bad').expect(404);
    await request(app).get('/media/photo/PHOTOID1234567890.jpg').expect(403);
    await request(app).get('/media/photo/%2F..%2Fetc.jpg?sig=good').expect(403);
  });
});

test('/admin/whoami?fix=1 は保存した userId が /me と違えば書き直す', async () => {
  const { memoryStore } = require('../src/store');
  const store = memoryStore();
  await store.setToken({ token: 'tk', userId: '29077612258522050', expiresAt: '2026-12-20T00:00:00.000Z' });
  const threads = { whoAmI: jest.fn(async () => ({ id: '29077612258522047', username: 'tete', scopes: null, appId: null })) };
  const app = createApp({ env: { CRON_KEY: 'k' }, store, threads });
  const r = await request(app).get('/admin/whoami?key=k&fix=1').expect(200);
  expect(r.body).toMatchObject({ storedUserId: '29077612258522050', id: '29077612258522047', fixed: true });
  expect((await store.getToken()).userId).toBe('29077612258522047');
  expect(JSON.stringify(r.body)).not.toMatch(/"tk"/);
});
