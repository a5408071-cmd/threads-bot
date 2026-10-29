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

test('exchangeCode は短期→長期の 2 段で expiresAt を付け、userId は /me から文字列で取る（user_id は 2^53 超で丸まる＝2026-10-27 実測 …047 が …050 に）', async () => {
  const h = http([
    { match: /\/oauth\/access_token$/, reply: { access_token: 'short', user_id: 29077612258522050 } },
    { match: /\/access_token$/, reply: { access_token: 'long', token_type: 'bearer', expires_in: 5184000 } },
    { match: /\/me$/, reply: { id: 'u1', username: 'tete' } },
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
  expect(u.searchParams.get('scope')).toMatch(/^threads_basic,threads_content_publish,threads_read_replies/);
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
    { match: /\/me$/, reply: { id: 'u1' } },
  ]);
  const t = createThreads({ http: h, env: { THREADS_APP_ID: 'app', THREADS_APP_SECRET: 'sec' }, sleep: noSleep });
  await t.exchangeCode({ code: 'cd', redirectUri: 'https://x/cb' });
  await t.refreshToken('long');
  expect(h.calls[0].url).toBe('https://graph.threads.net/oauth/access_token');
  expect(h.calls[1].url).toBe('https://graph.threads.net/access_token');
  expect(h.calls[3].url).toBe('https://graph.threads.net/refresh_access_token');
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

test('publishPost: topicTag を topic_tag として渡す', async () => {
  const h = http([
    { match: /\/u1\/threads$/, reply: { id: 'c1' } },
    { match: /\/c1$/, reply: { status: 'FINISHED' } },
    { match: /\/u1\/threads_publish$/, reply: { id: 'm1' } },
    { match: /\/m1$/, reply: { permalink: 'p' } },
  ]);
  const t = createThreads({ http: h, env: {}, sleep: noSleep });
  await t.publishPost({ token: 'tk', userId: 'u1', text: 'x', topicTag: 'ゴルフ' });
  expect(h.calls[0].opts).toMatchObject({ topic_tag: 'ゴルフ' });
});

describe('成長の仕組み（2026-10-28 社長「1か月以内でフォロワー500人」）', () => {
  test('userInsights は followers_count を返す', async () => {
    const h = http([{ match: /\/me\/threads_insights$/, reply: { data: [{ name: 'followers_count', total_value: { value: 123 } }] } }]);
    const t = createThreads({ http: h, env: {}, sleep: noSleep });
    expect(await t.userInsights({ token: 'tk' })).toEqual({ followers: 123 });
    expect(h.calls[0].opts).toMatchObject({ metric: 'followers_count', access_token: 'tk' });
  });
  test('postInsights は views/likes/replies/reposts/quotes を数で返す（無い指標は 0）', async () => {
    const h = http([{ match: /\/m1\/insights$/, reply: { data: [{ name: 'views', values: [{ value: 500 }] }, { name: 'likes', values: [{ value: 12 }] }, { name: 'replies', values: [{ value: 3 }] }] } }]);
    const t = createThreads({ http: h, env: {}, sleep: noSleep });
    expect(await t.postInsights({ token: 'tk', mediaId: 'm1' })).toEqual({ views: 500, likes: 12, replies: 3, reposts: 0, quotes: 0 });
    expect(h.calls[0].opts.metric).toBe('views,likes,replies,reposts,quotes');
  });
  test('publishReply は reply_to_id 付きでコンテナ→publish', async () => {
    const h = http([
      { match: /\/u1\/threads$/, reply: { id: 'c9' } },
      { match: /\/c9$/, reply: { status: 'FINISHED' } },
      { match: /\/u1\/threads_publish$/, reply: { id: 'r9' } },
      { match: /\/r9$/, reply: { permalink: 'pr' } },
    ]);
    const t = createThreads({ http: h, env: {}, sleep: noSleep });
    const r = await t.publishReply({ token: 'tk', userId: 'u1', text: 'ありがとうございます！', replyToId: 'cmt1' });
    expect(r).toEqual({ ok: true, mediaId: 'r9', permalink: 'pr' });
    expect(h.calls[0].opts).toMatchObject({ media_type: 'TEXT', text: 'ありがとうございます！', reply_to_id: 'cmt1' });
  });
  test('authorizeUrl の scope に insights と manage_replies が入る', () => {
    const t = createThreads({ http: http([]), env: { THREADS_APP_ID: 'app' }, sleep: noSleep });
    const u = new URL(t.authorizeUrl({ redirectUri: 'https://x/cb', state: 'st' }));
    expect(u.searchParams.get('scope').split(',')).toEqual(expect.arrayContaining(['threads_basic', 'threads_content_publish', 'threads_read_replies', 'threads_manage_replies', 'threads_manage_insights', 'threads_keyword_search']));
  });
});

test('keywordSearch は /keyword_search を q と search_type で呼び、投稿の一覧を返す', async () => {
  const h = http([{ match: /\/keyword_search$/, reply: { data: [{ id: 'k1', text: 'ゴルフ行きたい', username: 'ann', permalink: 'pk1', timestamp: 't', media_type: 'TEXT', has_replies: false, is_reply: false }] } }]);
  const t = createThreads({ http: h, env: {}, sleep: noSleep });
  const r = await t.keywordSearch({ token: 'tk', q: 'ゴルフ', type: 'RECENT' });
  expect(r).toEqual([{ id: 'k1', text: 'ゴルフ行きたい', username: 'ann', permalink: 'pk1', timestamp: 't', isReply: false }]);
  expect(h.calls[0].opts).toMatchObject({ q: 'ゴルフ', search_type: 'RECENT', access_token: 'tk' });
  expect(h.calls[0].opts.fields).toMatch(/id,text,username,permalink,timestamp/);
});

describe('publish の「メディアが見つかりません」（code 24 / 4279009）は待ってやり直す（2026-10-29 19:38 の失敗）', () => {
  const notFound = () => { const e = new Error('400'); e.response = { data: { error: { message: 'The requested resource does not exist', code: 24, error_subcode: 4279009 } } }; return e; };
  test('1回目が見つからない → 待って2回目で公開できれば ok', async () => {
    let n = 0;
    const slept = [];
    const h = http([
      { match: /\/u1\/threads$/, reply: { id: 'c1' } },
      { match: /\/c1$/, reply: { status: 'FINISHED' } },
      { match: /\/u1\/threads_publish$/, reply: () => { n += 1; if (n === 1) throw notFound(); return { id: 'm1' }; } },
      { match: /\/m1$/, reply: { permalink: 'https://p' } },
    ]);
    const t = createThreads({ http: h, env: {}, sleep: async (ms) => { slept.push(ms); } });
    const r = await t.publishPost({ token: 'tk', userId: 'u1', text: 'x' });
    expect(r).toMatchObject({ ok: true, mediaId: 'm1' });
    expect(n).toBe(2);
    expect(slept).toContain(10000);
  });
  test('3回とも見つからなければ ok:false stage publish', async () => {
    const h = http([
      { match: /\/u1\/threads$/, reply: { id: 'c1' } },
      { match: /\/c1$/, reply: { status: 'FINISHED' } },
      { match: /\/u1\/threads_publish$/, reply: () => { throw notFound(); } },
    ]);
    const t = createThreads({ http: h, env: {}, sleep: noSleep });
    const r = await t.publishPost({ token: 'tk', userId: 'u1', text: 'x' });
    expect(r).toMatchObject({ ok: false, stage: 'publish' });
    expect(h.calls.filter((c) => /threads_publish/.test(c.url)).length).toBe(3);
  });
  test('別のエラーはやり直さない', async () => {
    const e = new Error('400'); e.response = { data: { error: { message: 'API access blocked.', code: 200 } } };
    const h = http([
      { match: /\/u1\/threads$/, reply: { id: 'c1' } },
      { match: /\/c1$/, reply: { status: 'FINISHED' } },
      { match: /\/u1\/threads_publish$/, reply: e },
    ]);
    const t = createThreads({ http: h, env: {}, sleep: noSleep });
    const r = await t.publishPost({ token: 'tk', userId: 'u1', text: 'x' });
    expect(r).toMatchObject({ ok: false, stage: 'publish' });
    expect(h.calls.filter((c) => /threads_publish/.test(c.url)).length).toBe(1);
  });
});
