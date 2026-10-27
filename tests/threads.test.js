const { createThreads, BASE } = require('../src/threads');

function http(script) {
  const calls = [];
  const run = async (url, a, b) => {
    const opts = (a && a.params) ? a.params : (b && b.params ? b.params : a);
    calls.push({ url, opts: opts || {} });
    const s = script.find((x) => x.match.test(url));
    if (!s) throw new Error('unexpected ' + url);
    if (s.reply instanceof Error) throw s.reply;
    return { data: typeof s.reply === 'function' ? s.reply() : s.reply };
  };
  return { get: run, post: run, calls };
}
const noSleep = async () => {};

test('publishPost: TEXT はコンテナ→FINISHED→publish→permalink の順', async () => {
  const h = http([
    { match: /\/u1\/threads$/, reply: { id: 'c1' } },
    { match: /\/c1$/, reply: { status: 'FINISHED' } },
    { match: /\/u1\/threads_publish$/, reply: { id: 'm1' } },
    { match: /\/m1$/, reply: { permalink: 'https://www.threads.net/@x/post/abc' } },
  ]);
  const t = createThreads({ http: h, env: {}, sleep: noSleep });
  const r = await t.publishPost({ token: 'tk', userId: 'u1', text: 'hello' });
  expect(r).toEqual({ ok: true, mediaId: 'm1', permalink: 'https://www.threads.net/@x/post/abc' });
  expect(h.calls[0].url).toBe(`${BASE}/u1/threads`);
  expect(h.calls[0].opts).toMatchObject({ media_type: 'TEXT', text: 'hello', access_token: 'tk' });
  expect(h.calls[0].opts.image_url).toBeUndefined();
  expect(h.calls[1].opts).toMatchObject({ fields: 'status,error_message', access_token: 'tk' });
  expect(h.calls[2].opts).toMatchObject({ creation_id: 'c1', access_token: 'tk' });
});

test('publishPost: IMAGE は image_url を渡す', async () => {
  const h = http([
    { match: /\/u1\/threads$/, reply: { id: 'c1' } },
    { match: /\/c1$/, reply: { status: 'FINISHED' } },
    { match: /\/u1\/threads_publish$/, reply: { id: 'm1' } },
    { match: /\/m1$/, reply: { permalink: 'p' } },
  ]);
  const t = createThreads({ http: h, env: {}, sleep: noSleep });
  const r = await t.publishPost({ token: 'tk', userId: 'u1', text: 'x', imageUrl: 'https://a/b.jpg' });
  expect(r.ok).toBe(true);
  expect(h.calls[0].opts).toMatchObject({ media_type: 'IMAGE', image_url: 'https://a/b.jpg', text: 'x' });
});

test('status が ERROR なら publish を呼ばない', async () => {
  const h = http([
    { match: /\/u1\/threads$/, reply: { id: 'c1' } },
    { match: /\/c1$/, reply: { status: 'ERROR', error_message: 'bad image' } },
  ]);
  const t = createThreads({ http: h, env: {}, sleep: noSleep });
  const r = await t.publishPost({ token: 'tk', userId: 'u1', text: 'x', imageUrl: 'https://a/b.jpg' });
  expect(r).toMatchObject({ ok: false, stage: 'status' });
  expect(r.error).toMatch(/bad image/);
  expect(h.calls.some((c) => /threads_publish/.test(c.url))).toBe(false);
});

test('status が 60 秒たっても IN_PROGRESS なら ok:false stage status', async () => {
  let t0 = 0;
  const h = http([
    { match: /\/u1\/threads$/, reply: { id: 'c1' } },
    { match: /\/c1$/, reply: { status: 'IN_PROGRESS' } },
  ]);
  const t = createThreads({ http: h, env: {}, sleep: async (ms) => { t0 += ms; }, now: () => new Date(t0) });
  const r = await t.publishPost({ token: 'tk', userId: 'u1', text: 'x' });
  expect(r).toMatchObject({ ok: false, stage: 'status' });
  expect(r.error).toMatch(/60/);
  expect(h.calls.filter((c) => /\/c1$/.test(c.url)).length).toBeGreaterThanOrEqual(10);
});

test('コンテナ作成が Meta のエラーなら error に message、stage container', async () => {
  const e = new Error('Request failed with status code 400');
  e.response = { data: { error: { message: 'Invalid OAuth access token' } } };
  const h = http([{ match: /\/u1\/threads$/, reply: e }]);
  const t = createThreads({ http: h, env: {}, sleep: noSleep });
  const r = await t.publishPost({ token: 'tk', userId: 'u1', text: 'x' });
  expect(r).toEqual({ ok: false, stage: 'container', error: 'Invalid OAuth access token' });
});

test('exchangeCode は短期→長期の 2 段で expiresAt を付ける', async () => {
  const h = http([
    { match: /\/oauth\/access_token$/, reply: { access_token: 'short', user_id: 'u1' } },
    { match: /\/access_token$/, reply: { access_token: 'long', token_type: 'bearer', expires_in: 5184000 } },
  ]);
  const t = createThreads({ http: h, env: { THREADS_APP_ID: 'app', THREADS_APP_SECRET: 'sec' }, sleep: noSleep, now: () => new Date('2026-10-27T00:00:00Z') });
  const r = await t.exchangeCode({ code: 'cd', redirectUri: 'https://x/oauth/callback' });
  expect(r).toEqual({ token: 'long', userId: 'u1', expiresAt: '2026-12-26T00:00:00.000Z' });
  expect(h.calls[0].opts).toMatchObject({ client_id: 'app', client_secret: 'sec', grant_type: 'authorization_code', redirect_uri: 'https://x/oauth/callback', code: 'cd' });
  expect(h.calls[1].opts).toMatchObject({ grant_type: 'th_exchange_token', client_secret: 'sec', access_token: 'short' });
});

test('refreshToken は th_refresh_token で延ばす', async () => {
  const h = http([{ match: /\/refresh_access_token$/, reply: { access_token: 'long2', expires_in: 5184000 } }]);
  const t = createThreads({ http: h, env: {}, sleep: noSleep, now: () => new Date('2026-10-27T00:00:00Z') });
  const r = await t.refreshToken('long');
  expect(r).toEqual({ token: 'long2', expiresAt: '2026-12-26T00:00:00.000Z' });
  expect(h.calls[0].opts).toMatchObject({ grant_type: 'th_refresh_token', access_token: 'long' });
});

test('listMyPosts と listReplies は配列を返す', async () => {
  const h = http([
    { match: /\/me\/threads$/, reply: { data: [{ id: 'm1', permalink: 'p1', timestamp: '2026-10-27T00:00:00+0000' }] } },
    { match: /\/m1\/replies$/, reply: { data: [{ id: 'r1', text: 'hi', username: 'bob', timestamp: 't', permalink: 'pr' }] } },
  ]);
  const t = createThreads({ http: h, env: {}, sleep: noSleep });
  expect(await t.listMyPosts({ token: 'tk', sinceIso: '2026-10-20T00:00:00Z' })).toEqual([{ id: 'm1', permalink: 'p1', timestamp: '2026-10-27T00:00:00+0000' }]);
  expect(h.calls[0].opts).toMatchObject({ fields: 'id,permalink,timestamp', since: '2026-10-20T00:00:00Z', access_token: 'tk' });
  expect(await t.listReplies({ token: 'tk', mediaId: 'm1' })).toEqual([{ id: 'r1', text: 'hi', username: 'bob', timestamp: 't', permalink: 'pr', is_reply_owned_by_me: false }]);
});

test('authorizeUrl に 3 つの scope と state', () => {
  const t = createThreads({ http: http([]), env: { THREADS_APP_ID: 'app' }, sleep: noSleep });
  const u = new URL(t.authorizeUrl({ redirectUri: 'https://x/oauth/callback', state: 'st' }));
  expect(u.origin + u.pathname).toBe('https://threads.net/oauth/authorize');
  expect(u.searchParams.get('client_id')).toBe('app');
  expect(u.searchParams.get('redirect_uri')).toBe('https://x/oauth/callback');
  expect(u.searchParams.get('scope')).toBe('threads_basic,threads_content_publish,threads_read_replies');
  expect(u.searchParams.get('response_type')).toBe('code');
  expect(u.searchParams.get('state')).toBe('st');
});

test('listReplies は is_reply_owned_by_me も頼んで返す', async () => {
  const h = http([{ match: /\/m1\/replies$/, reply: { data: [{ id: 'r1', text: 'hi', username: 'bob', timestamp: 't', permalink: 'pr', is_reply_owned_by_me: true }] } }]);
  const t = createThreads({ http: h, env: {}, sleep: noSleep });
  const r = await t.listReplies({ token: 'tk', mediaId: 'm1' });
  expect(h.calls[0].opts.fields).toBe('id,text,username,timestamp,permalink,is_reply_owned_by_me');
  expect(r[0].is_reply_owned_by_me).toBe(true);
});

test('トークン関係の道はバージョン無し（graph.threads.net/oauth/access_token 等。公式の例のとおり）', async () => {
  const h = http([
    { match: /\/oauth\/access_token$/, reply: { access_token: 'short', user_id: 'u1' } },
    { match: /\/access_token$/, reply: { access_token: 'long', expires_in: 5184000 } },
    { match: /\/refresh_access_token$/, reply: { access_token: 'long2', expires_in: 5184000 } },
  ]);
  const t = createThreads({ http: h, env: { THREADS_APP_ID: 'app', THREADS_APP_SECRET: 'sec' }, sleep: noSleep });
  await t.exchangeCode({ code: 'cd', redirectUri: 'https://x/cb' });
  await t.refreshToken('long');
  expect(h.calls[0].url).toBe('https://graph.threads.net/oauth/access_token');
  expect(h.calls[1].url).toBe('https://graph.threads.net/access_token');
  expect(h.calls[2].url).toBe('https://graph.threads.net/refresh_access_token');
});

test('whoAmI は /me と /debug_token で鍵の持ち主と権限を返す（鍵そのものは返さない）', async () => {
  const h = http([
    { match: /\/me$/, reply: { id: 'u1', username: 'tete' } },
    { match: /\/debug_token$/, reply: { data: { app_id: 'app', scopes: ['threads_basic', 'threads_content_publish'], expires_at: 1 } } },
  ]);
  const t = createThreads({ http: h, env: { THREADS_APP_ID: 'app', THREADS_APP_SECRET: 'sec' }, sleep: noSleep });
  const r = await t.whoAmI('tk');
  expect(r).toEqual({ id: 'u1', username: 'tete', scopes: ['threads_basic', 'threads_content_publish'], appId: 'app' });
  expect(JSON.stringify(r)).not.toMatch(/tk/);
});
