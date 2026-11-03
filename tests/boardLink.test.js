/**
 * 掲示板のリンクを数日に 1 回、自分の投稿の返信欄に添える（2026-11-03 社長「その案でいい」＝プロフィールにリンク＋数日に1回返信に添える。本文には入れない）
 */
const { createBoardLink, TEMPLATES } = require('../src/boardLink');
const { memoryStore } = require('../src/store');
const { runTick } = require('../src/tick');

const TOKEN = { token: 'tk', userId: 'u1', expiresAt: '2026-12-20T00:00:00.000Z' };
const at = (iso) => new Date(iso);

function mk({ now = at('2026-11-05T08:10:00+09:00'), env = {} } = {}) {
  const store = memoryStore({ now: () => now });
  const threads = { publishReply: jest.fn(async () => ({ ok: true, mediaId: 'r1', permalink: 'https://www.threads.net/@x/post/r1' })) };
  const link = createBoardLink({ store, threads, env, now: () => now });
  return { store, threads, link };
}

test('ホノルル系の投稿のあと、初回は返信でリンクを添え、記録する', async () => {
  const { store, threads, link } = mk();
  const r = await link.maybeReply({ token: TOKEN, mediaId: 'm1', type: 'honolulu' });
  expect(r.ok).toBe(true);
  expect(threads.publishReply).toHaveBeenCalledWith(expect.objectContaining({ replyToId: 'm1', text: expect.stringContaining('https://nakamaboard.com/honolulu-2026') }));
  expect(threads.publishReply.mock.calls[0][0].text).not.toMatch(/#/);
  const c = await store.getConfig('boardLink');
  expect(c).toMatchObject({ lastAt: '2026-11-04T23:10:00.000Z', mediaId: 'm1', count: 1 });
});

test('3 日たつまでは添えない（既定）。THREADS_BOARD_LINK_EVERY_DAYS で変えられる', async () => {
  const { store, threads, link } = mk();
  await store.setConfig('boardLink', { lastAt: '2026-11-03T03:00:00.000Z', count: 1 });
  expect(await link.maybeReply({ token: TOKEN, mediaId: 'm2', type: 'honolulu' })).toMatchObject({ ok: false, skipped: 'recent' });
  expect(threads.publishReply).not.toHaveBeenCalled();
  const d2 = mk({ env: { THREADS_BOARD_LINK_EVERY_DAYS: '1' } });
  await d2.store.setConfig('boardLink', { lastAt: '2026-11-03T03:00:00.000Z', count: 1 });
  expect((await d2.link.maybeReply({ token: TOKEN, mediaId: 'm2', type: 'honolulu' })).ok).toBe(true);
});

test('ゴルフなど関係ない型には添えない。文は順番に変える', async () => {
  const { store, threads, link } = mk({ env: { THREADS_BOARD_LINK_EVERY_DAYS: '0' } });
  expect(await link.maybeReply({ token: TOKEN, mediaId: 'g1', type: 'question' })).toMatchObject({ ok: false, skipped: 'type' });
  await link.maybeReply({ token: TOKEN, mediaId: 'm1', type: 'board' });
  await link.maybeReply({ token: TOKEN, mediaId: 'm2', type: 'fitness' });
  const [a, b] = threads.publishReply.mock.calls.map((c) => c[0].text);
  expect(a).not.toBe(b);
  expect(TEMPLATES.length).toBeGreaterThanOrEqual(3);
  expect((await store.getConfig('boardLink')).count).toBe(2);
});

test('記録が読めないときは付けない（読めない間に毎回付かないように）。間隔の設定が壊れていれば既定の 3 日', async () => {
  const d = mk();
  d.store.getConfig = async () => { throw new Error('firestore down'); };
  expect(await d.link.maybeReply({ token: TOKEN, mediaId: 'm1', type: 'honolulu' })).toMatchObject({ ok: false, skipped: 'config' });
  expect(d.threads.publishReply).not.toHaveBeenCalled();
  const bad = mk({ env: { THREADS_BOARD_LINK_EVERY_DAYS: 'abc' } });
  await bad.store.setConfig('boardLink', { lastAt: '2026-11-03T03:00:00.000Z', count: 1 }); // 2 日前
  expect(await bad.link.maybeReply({ token: TOKEN, mediaId: 'm1', type: 'honolulu' })).toMatchObject({ ok: false, skipped: 'recent' });
});

test('先に印（lastAt）を取ってから返信する。同じ見回りで 2 本続けて出ても付くのは 1 本だけ。失敗したら印を戻す', async () => {
  const { store, threads, link } = mk();
  let release;
  threads.publishReply.mockImplementationOnce(() => new Promise((r) => { release = () => r({ ok: true, mediaId: 'r1' }); }));
  const first = link.maybeReply({ token: TOKEN, mediaId: 'm1', type: 'honolulu' });
  await new Promise((r) => setImmediate(r));
  expect(await link.maybeReply({ token: TOKEN, mediaId: 'm2', type: 'board' })).toMatchObject({ ok: false, skipped: 'recent' }); // 1 本目の返信中でも印があるので止まる
  release(); expect((await first).ok).toBe(true);
  expect(threads.publishReply).toHaveBeenCalledTimes(1);
  // 失敗したら印を戻す＝次の投稿でまた付けられる
  const f = mk();
  f.threads.publishReply.mockImplementationOnce(async () => ({ ok: false, error: 'x' }));
  expect(await f.link.maybeReply({ token: TOKEN, mediaId: 'm1', type: 'honolulu' })).toMatchObject({ ok: false, error: 'x' });
  expect(((await f.store.getConfig('boardLink')) || {}).lastAt).toBeUndefined(); // 印（lastAt）が戻っている（Firestore に null は書けないので {count} だけ残る）
  expect((await f.link.maybeReply({ token: TOKEN, mediaId: 'm2', type: 'honolulu' })).ok).toBe(true);
});

test('THREADS_BOARD_URL が空なら何もしない。返信に失敗しても落ちない', async () => {
  const off = mk({ env: { THREADS_BOARD_URL: '' } });
  expect(await off.link.maybeReply({ token: TOKEN, mediaId: 'm1', type: 'honolulu' })).toMatchObject({ ok: false, skipped: 'off' });
  const bad = mk();
  bad.threads.publishReply.mockImplementation(async () => ({ ok: false, error: 'x' }));
  expect(await bad.link.maybeReply({ token: TOKEN, mediaId: 'm1', type: 'honolulu' })).toMatchObject({ ok: false, error: 'x' });
  expect(((await bad.store.getConfig('boardLink')) || {}).lastAt).toBeUndefined();
});

test('tick: 自動投稿が出たあとに boardLink.maybeReply を呼び、結果と社長への写しを残す', async () => {
  const now = at('2026-11-05T09:20:00+09:00');
  const store = memoryStore({ now: () => now });
  await store.setToken(TOKEN);
  const threads = {
    publishPost: jest.fn(async () => ({ ok: true, mediaId: 'm1', permalink: 'https://www.threads.net/@x/post/m1' })),
    publishReply: jest.fn(async () => ({ ok: true, mediaId: 'r1', permalink: 'https://www.threads.net/@x/post/r1' })),
    refreshToken: jest.fn(async () => ({ token: 'tk2', expiresAt: '2027-01-15T00:00:00.000Z' })),
  };
  const writer = { pickType: () => 'honolulu', writePost: jest.fn(async () => ({ ok: true, text: '初フル、緊張とワクワク', type: 'honolulu', attempts: 1, tag: 'ホノルルマラソン' })) };
  const notify = { owner: jest.fn(async () => ({ ok: true })) };
  const boardLink = createBoardLink({ store, threads, env: {}, now: () => now });
  const r = await runTick({ env: { THREADS_COPY_TO_OWNER: 'true' }, store, threads, writer, notify, anthropic: {}, now: () => now, mode: 'live', draw: () => ({ slots: ['09:17', '20:41'] }), boardLink });
  expect(r.posted).toHaveLength(1);
  expect(r.boardLink).toMatchObject({ ok: true, mediaId: 'm1' });
  expect(threads.publishReply).toHaveBeenCalledWith(expect.objectContaining({ replyToId: 'm1' }));
  expect(notify.owner.mock.calls.map((c) => c[0]).join('\n')).toMatch('掲示板のリンク');
});
