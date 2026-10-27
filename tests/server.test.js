const request = require('supertest');
const { createApp } = require('../src/server');

test('GET /healthz は ok', async () => {
  const app = createApp({ env: { CRON_KEY: 'k' } });
  await request(app).get('/healthz').expect(200, { ok: true });
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
