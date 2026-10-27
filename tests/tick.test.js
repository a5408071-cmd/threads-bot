const { runTick } = require('../src/tick');
const { memoryStore } = require('../src/store');

const at = (hm, d = '2026-10-28') => new Date(`${d}T${hm}:00+09:00`);
const TOKEN = { token: 'tk', userId: 'u1', expiresAt: '2026-12-20T00:00:00.000Z' };

function deps(over = {}) {
  const store = over.store || memoryStore({ now: () => over.now || at('09:20') });
  const threads = {
    publishPost: jest.fn(async () => ({ ok: true, mediaId: 'm1', permalink: 'https://www.threads.net/@x/post/abc' })),
    refreshToken: jest.fn(async () => ({ token: 'tk2', expiresAt: '2027-01-15T00:00:00.000Z' })),
    ...(over.threads || {}),
  };
  const writer = {
    pickType: jest.fn(() => 'question'),
    writePost: jest.fn(async () => ({ ok: true, text: '名古屋で平日ゴルフ行ける人いませんか？', type: 'question', attempts: 1 })),
    ...(over.writer || {}),
  };
  const notify = { owner: jest.fn(async () => ({ ok: true })) };
  const draw = over.draw || (() => ({ slots: ['09:17', '20:41'] }));
  return { store, threads, writer, notify, draw, anthropic: {}, env: { THREADS_COPY_TO_OWNER: 'true', ...(over.env || {}) }, now: () => over.now || at('09:20'), mode: over.mode || 'live', replies: over.replies };
}

async function withToken(d) { await d.store.setToken(TOKEN); return d; }

test('時刻を過ぎた枠があれば書いて投稿し、記録と写しを残す', async () => {
  const d = await withToken(deps());
  const r = await runTick(d);
  expect(r.ok).toBe(true);
  expect(r.errors).toEqual([]);
  expect(r.dateKey).toBe('2026-10-28');
  expect(r.slots).toEqual(['09:17', '20:41']);
  expect(r.posted).toEqual([expect.objectContaining({ index: 0, mediaId: 'm1', permalink: 'https://www.threads.net/@x/post/abc' })]);
  expect(d.threads.publishPost).toHaveBeenCalledWith({ token: 'tk', userId: 'u1', text: '名古屋で平日ゴルフ行ける人いませんか？' });
  const day = await d.store.getDay('2026-10-28');
  expect(day.posted).toEqual([expect.objectContaining({ index: 0, mediaId: 'm1' })]);
  expect(await d.store.recentPosts(5)).toEqual([expect.objectContaining({ mediaId: 'm1', text: '名古屋で平日ゴルフ行ける人いませんか？', type: 'question', source: 'auto', permalink: 'https://www.threads.net/@x/post/abc' })]);
  expect(d.notify.owner).toHaveBeenCalledTimes(1);
  expect(d.notify.owner.mock.calls[0][0]).toMatch(/投稿しました/);
  expect(d.notify.owner.mock.calls[0][0]).toMatch(/threads\.net/);
});

test('直近の投稿の本文と型を writer に渡す（直近 14 本・型は直近 2 本）', async () => {
  const d = await withToken(deps());
  for (let i = 0; i < 20; i++) await d.store.savePost({ mediaId: 'p' + i, text: 'past' + i, type: i % 2 ? 'aruaru' : 'hook', source: 'auto', postedAt: new Date(2026, 8, 1 + i).toISOString() });
  await runTick(d);
  expect(d.writer.pickType.mock.calls[0][0]).toEqual(['aruaru', 'hook']);
  const arg = d.writer.writePost.mock.calls[0][0];
  expect(arg.recent).toHaveLength(14);
  expect(arg.recent[0]).toBe('past19');
  expect(arg.type).toBe('question');
  expect(arg.dateKey).toBe('2026-10-28');
});

test('写しは THREADS_COPY_TO_OWNER が true のときだけ', async () => {
  const d = await withToken(deps({ env: { THREADS_COPY_TO_OWNER: 'false' } }));
  await runTick(d);
  expect(d.notify.owner).not.toHaveBeenCalled();
});

test('時刻前は何もしない（AI も Threads も呼ばない）', async () => {
  const d = await withToken(deps({ now: at('09:00') }));
  const r = await runTick(d);
  expect(r.due).toBeNull();
  expect(d.writer.writePost).not.toHaveBeenCalled();
  expect(d.threads.publishPost).not.toHaveBeenCalled();
  expect((await d.store.getDay('2026-10-28')).slots).toEqual(['09:17', '20:41']);
});

test('猶予を超えた枠は skipped にして知らせる、投稿しない', async () => {
  const d = await withToken(deps({ now: at('11:00') }));
  const r = await runTick(d);
  expect(r.skipped).toEqual([expect.objectContaining({ index: 0, reason: expect.stringMatching(/猶予/) })]);
  expect(d.threads.publishPost).not.toHaveBeenCalled();
  expect(d.notify.owner.mock.calls[0][0]).toMatch(/09:17/);
  expect((await d.store.getDay('2026-10-28')).posted[0]).toMatchObject({ index: 0, skipped: expect.stringMatching(/猶予/) });
});

test('THREADS_AUTO_POST=false なら枠は作るが投稿しない', async () => {
  const d = await withToken(deps({ env: { THREADS_AUTO_POST: 'false' } }));
  const r = await runTick(d);
  expect(r.autoPost).toBe(false);
  expect(d.writer.writePost).not.toHaveBeenCalled();
  expect((await d.store.getDay('2026-10-28')).slots).toHaveLength(2);
});

test('dry は投稿せず文を返す', async () => {
  const d = await withToken(deps({ mode: 'dry' }));
  const r = await runTick(d);
  expect(r.preview).toMatchObject({ text: '名古屋で平日ゴルフ行ける人いませんか？', type: 'question' });
  expect(d.threads.publishPost).not.toHaveBeenCalled();
  expect(d.notify.owner).not.toHaveBeenCalled();
  expect((await d.store.getDay('2026-10-28')).claimed).toEqual([]);
});

test('test は社長DMに文を送って投稿しない（claim も残さない）', async () => {
  const d = await withToken(deps({ mode: 'test' }));
  const r = await runTick(d);
  expect(r.preview.text).toBe('名古屋で平日ゴルフ行ける人いませんか？');
  expect(d.threads.publishPost).not.toHaveBeenCalled();
  expect(d.notify.owner).toHaveBeenCalledTimes(1);
  expect(d.notify.owner.mock.calls[0][0]).toMatch(/テスト/);
  expect((await d.store.getDay('2026-10-28')).claimed).toEqual([]);
  expect((await d.store.getDay('2026-10-28')).posted).toEqual([]);
});

test('dry は時刻前でも文を作って見せる（文体の確認用）', async () => {
  const d = await withToken(deps({ mode: 'dry', now: at('09:00') }));
  const r = await runTick(d);
  expect(r.preview.text).toBeTruthy();
});

test('トークン無しなら Threads を呼ばず alert（2 回目は知らせない）', async () => {
  const d = deps();
  const r1 = await runTick(d);
  expect(r1.ok).toBe(false);
  expect(r1.errors).toEqual([expect.stringMatching(/鍵/)]);
  expect(d.threads.publishPost).not.toHaveBeenCalled();
  expect(d.writer.writePost).not.toHaveBeenCalled();
  expect(d.notify.owner).toHaveBeenCalledTimes(1);
  expect(d.notify.owner.mock.calls[0][0]).toMatch(/oauth\/start/);
  expect(d.notify.owner.mock.calls[0][0]).not.toMatch(/key=/);
  await runTick(d);
  expect(d.notify.owner).toHaveBeenCalledTimes(1);
});

test('残り 10 日未満ならトークンを更新して保存', async () => {
  const d = deps({ now: at('09:00') });
  await d.store.setToken({ ...TOKEN, expiresAt: '2026-11-05T00:00:00.000Z' });
  const r = await runTick(d);
  expect(d.threads.refreshToken).toHaveBeenCalledWith('tk');
  expect(r.token).toMatchObject({ refreshed: true });
  expect(await d.store.getToken()).toMatchObject({ token: 'tk2', userId: 'u1', expiresAt: '2027-01-15T00:00:00.000Z' });
});

test('残り 10 日以上なら更新しない、daysLeft を返す', async () => {
  const d = await withToken(deps({ now: at('09:00') }));
  const r = await runTick(d);
  expect(d.threads.refreshToken).not.toHaveBeenCalled();
  expect(r.token).toMatchObject({ refreshed: false, daysLeft: 53 });
});

test('トークン更新に失敗しても投稿は続け、errors と知らせに残す', async () => {
  const d = deps({ threads: { refreshToken: jest.fn(async () => { throw new Error('refresh denied'); }) } });
  await d.store.setToken({ ...TOKEN, expiresAt: '2026-11-05T00:00:00.000Z' });
  const r = await runTick(d);
  expect(r.errors).toEqual([expect.stringMatching(/refresh denied/)]);
  expect(r.posted).toHaveLength(1);
  expect(d.notify.owner.mock.calls.map((c) => c[0]).join('\n')).toMatch(/鍵/);
});

test('writePost が ok:false なら skipped と知らせ', async () => {
  const d = await withToken(deps({ writer: { writePost: jest.fn(async () => ({ ok: false, reason: 'NG語: ウッド', type: 'question' })) } }));
  const r = await runTick(d);
  expect(r.skipped).toEqual([expect.objectContaining({ index: 0, reason: 'NG語: ウッド' })]);
  expect(d.threads.publishPost).not.toHaveBeenCalled();
  expect(d.notify.owner.mock.calls[0][0]).toMatch(/NG語/);
  expect(r.ok).toBe(true);
});

test('publishPost が失敗したら skipped・errors・知らせ、同じ枠を繰り返さない', async () => {
  const d = await withToken(deps({ threads: { publishPost: jest.fn(async () => ({ ok: false, stage: 'status', error: 'ERROR: bad' })) } }));
  const r = await runTick(d);
  expect(r.ok).toBe(false);
  expect(r.errors).toEqual([expect.stringMatching(/bad/)]);
  expect(r.skipped).toEqual([expect.objectContaining({ index: 0 })]);
  expect(d.notify.owner.mock.calls[0][0]).toMatch(/bad/);
  const r2 = await runTick(d);
  expect(d.threads.publishPost).toHaveBeenCalledTimes(1);
  expect(r2.due).toBeNull();
});

test('THREADS_ENABLED=false なら枠も作らない', async () => {
  const d = await withToken(deps({ env: { THREADS_ENABLED: 'false' } }));
  const r = await runTick(d);
  expect(r).toMatchObject({ ok: true, disabled: true });
  expect(await d.store.getDay('2026-10-28')).toBeNull();
});

test('分が 00〜09 のときだけ replies.poll を呼ぶ', async () => {
  const poll = jest.fn(async () => ({ checked: 1, newReplies: 0, notified: 0, errors: [] }));
  const d1 = await withToken(deps({ now: at('09:05'), replies: { poll } }));
  const r1 = await runTick(d1);
  expect(poll).toHaveBeenCalledWith({ token: 'tk', userId: 'u1' });
  expect(r1.replies).toEqual({ checked: 1, newReplies: 0, notified: 0, errors: [] });
  const d2 = await withToken(deps({ now: at('09:15'), replies: { poll } }));
  const r2 = await runTick(d2);
  expect(poll).toHaveBeenCalledTimes(1);
  expect(r2.replies).toBeNull();
});

test('replies.poll が投げても tick は続き errors に残る', async () => {
  const d = await withToken(deps({ now: at('09:05'), replies: { poll: jest.fn(async () => { throw new Error('reply boom'); }) } }));
  const r = await runTick(d);
  expect(r.errors).toEqual([expect.stringMatching(/reply boom/)]);
});

test('鍵の期限が切れている（か expiresAt が無い）なら鍵が無いのと同じ扱い＝投稿を試みず知らせる', async () => {
  const d = deps();
  await d.store.setToken({ ...TOKEN, expiresAt: '2026-10-01T00:00:00.000Z' });
  const r = await runTick(d);
  expect(r.ok).toBe(false);
  expect(r.errors).toEqual([expect.stringMatching(/切れ/)]);
  expect(d.threads.publishPost).not.toHaveBeenCalled();
  expect(d.threads.refreshToken).not.toHaveBeenCalled();
  expect(d.notify.owner.mock.calls[0][0]).toMatch(/oauth\/start/);
  const d2 = deps();
  await d2.store.setToken({ token: 'tk', userId: 'u1' });
  const r2 = await runTick(d2);
  expect(r2.ok).toBe(false);
  expect(d2.threads.publishPost).not.toHaveBeenCalled();
});

test('猶予超えの枠がすでに claim 済み（投稿中に止まった）なら、その旨を知らせる', async () => {
  const d = await withToken(deps({ now: at('11:00') }));
  await d.store.ensureDay('2026-10-28', () => ({ slots: ['09:17', '20:41'] }));
  await d.store.claimSlot('2026-10-28', 0);
  const r = await runTick(d);
  expect(r.skipped[0].reason).toMatch(/投稿中に止ま/);
  expect(d.notify.owner.mock.calls[0][0]).toMatch(/Threads を確認/);
});

test('写真: shouldAttach が true で pick が返れば imageUrl 付きで投稿し、使用を記録、写しに写真名を添える', async () => {
  const d = await withToken(deps());
  const photo = { id: 'P1', name: 'course.jpg', url: 'https://iso.example/media/drive/P1.jpg?sig=x', mediaType: 'image/jpeg', bytes: Buffer.from('x') };
  d.photos = { shouldAttach: () => true, pick: jest.fn(async () => photo) };
  const r = await runTick(d);
  expect(d.threads.publishPost).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: photo.url }));
  expect(d.writer.writePost.mock.calls[0][0].photo).toBe(photo);
  expect(r.posted[0]).toMatchObject({ photo: 'course.jpg' });
  expect(await d.store.photoUsedRecently('P1', 60)).toBe(true);
  expect((await d.store.recentPosts(1))[0]).toMatchObject({ photoId: 'P1' });
  expect(d.notify.owner.mock.calls[0][0]).toMatch(/course\.jpg/);
});

test('写真: pick が null なら写真なしで投稿する（止めない）', async () => {
  const d = await withToken(deps());
  d.photos = { shouldAttach: () => true, pick: jest.fn(async () => null) };
  const r = await runTick(d);
  expect(r.posted).toHaveLength(1);
  expect(d.threads.publishPost.mock.calls[0][0].imageUrl).toBeUndefined();
});

test('写真: dry/test でも preview に写真名が入る（使用は記録しない）', async () => {
  const d = await withToken(deps({ mode: 'dry' }));
  const photo = { id: 'P1', name: 'course.jpg', url: 'u', mediaType: 'image/jpeg', bytes: Buffer.from('x') };
  d.photos = { shouldAttach: () => true, pick: jest.fn(async () => photo) };
  const r = await runTick(d);
  expect(r.preview).toMatchObject({ photo: 'course.jpg' });
  expect(await d.store.photoUsedRecently('P1', 60)).toBe(false);
});

test('写真: forcePhoto なら shouldAttach に関係なく pick する（dry/test の確認用 ?photo=1）', async () => {
  const d = await withToken(deps({ mode: 'dry' }));
  d.photos = { shouldAttach: () => false, pick: jest.fn(async () => ({ id: 'P1', name: 'a.jpg', url: 'u', mediaType: 'image/jpeg', bytes: Buffer.from('x') })) };
  const r = await runTick({ ...d, forcePhoto: true });
  expect(d.photos.pick).toHaveBeenCalled();
  expect(r.preview.photo).toBe('a.jpg');
});

test('forcePost: 枠に関係なく今すぐ 1 本書いて投稿する（枠は消費しない。記録と写しは通常どおり）', async () => {
  const d = await withToken(deps({ now: at('15:00'), draw: () => ({ slots: ['20:11', '22:41'] }) }));
  const photo = { id: 'P1', name: 'course.jpg', url: 'u', mediaType: 'image/jpeg', bytes: Buffer.from('x') };
  d.photos = { shouldAttach: () => false, pick: jest.fn(async () => photo) };
  const r = await runTick({ ...d, forcePost: true, forcePhoto: true });
  expect(r.posted).toEqual([expect.objectContaining({ manual: true, mediaId: 'm1', photo: 'course.jpg' })]);
  expect(d.threads.publishPost).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: 'u' }));
  const day = await d.store.getDay('2026-10-28');
  expect(day.posted).toEqual([]);
  expect(day.claimed).toEqual([]);
  expect((await d.store.recentPosts(1))[0]).toMatchObject({ source: 'auto', photoId: 'P1' });
  expect(d.notify.owner.mock.calls[0][0]).toMatch(/投稿しました/);
});
