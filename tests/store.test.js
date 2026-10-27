const { memoryStore } = require('../src/store');

test('ensureDay は 1 回だけ draw する', async () => {
  const s = memoryStore();
  const draw = jest.fn(() => ({ slots: ['09:17', '20:41'] }));
  await s.ensureDay('2026-10-28', draw);
  await s.ensureDay('2026-10-28', draw);
  expect(draw).toHaveBeenCalledTimes(1);
  const d = await s.getDay('2026-10-28');
  expect(d).toMatchObject({ dateKey: '2026-10-28', slots: ['09:17', '20:41'], posted: [], claimed: [] });
  expect(await s.getDay('2026-10-29')).toBeNull();
});

test('claimSlot は 2 回目が false、release で戻る', async () => {
  const s = memoryStore();
  await s.ensureDay('2026-10-28', () => ({ slots: ['09:17'] }));
  expect(await s.claimSlot('2026-10-28', 0)).toBe(true);
  expect(await s.claimSlot('2026-10-28', 0)).toBe(false);
  await s.releaseSlot('2026-10-28', 0);
  expect(await s.claimSlot('2026-10-28', 0)).toBe(true);
});

test('markPosted / markSkipped は posted に残る', async () => {
  const s = memoryStore();
  await s.ensureDay('2026-10-28', () => ({ slots: ['09:17', '20:41'] }));
  await s.markPosted('2026-10-28', 0, { mediaId: 'm1' });
  await s.markSkipped('2026-10-28', 1, '猶予超え');
  const d = await s.getDay('2026-10-28');
  expect(d.posted).toEqual([
    expect.objectContaining({ index: 0, mediaId: 'm1' }),
    expect.objectContaining({ index: 1, skipped: '猶予超え' }),
  ]);
});

test('recentPosts は新しい順に n 件', async () => {
  const s = memoryStore();
  for (let i = 0; i < 20; i++) await s.savePost({ mediaId: 'm' + i, text: 't' + i, type: 'hook', source: 'auto', postedAt: new Date(2026, 9, 1 + i).toISOString() });
  const r = await s.recentPosts(14);
  expect(r).toHaveLength(14);
  expect(r[0].mediaId).toBe('m19');
  expect(r[13].mediaId).toBe('m6');
});

test('token は無ければ null、set で入る', async () => {
  const s = memoryStore();
  expect(await s.getToken()).toBeNull();
  await s.setToken({ token: 'tk', userId: 'u1', expiresAt: '2026-12-26T00:00:00.000Z' });
  expect(await s.getToken()).toMatchObject({ token: 'tk', userId: 'u1', expiresAt: '2026-12-26T00:00:00.000Z' });
  expect(typeof (await s.getToken()).savedAt).toBe('string');
});

test('seenReply / markReplySeen', async () => {
  const s = memoryStore();
  expect(await s.seenReply('r1')).toBe(false);
  await s.markReplySeen('r1', { text: 'hi' });
  expect(await s.seenReply('r1')).toBe(true);
});

test('alertDue は 12 時間に 1 回', async () => {
  let t = new Date('2026-10-28T00:00:00Z');
  const s = memoryStore({ now: () => t });
  expect(await s.alertDue('token')).toBe(true);
  expect(await s.alertDue('token')).toBe(false);
  t = new Date('2026-10-28T11:00:00Z');
  expect(await s.alertDue('token')).toBe(false);
  t = new Date('2026-10-28T12:30:00Z');
  expect(await s.alertDue('token')).toBe(true);
});

test('getConfig / setConfig', async () => {
  const s = memoryStore();
  expect(await s.getConfig('repliesInitialized')).toBeNull();
  await s.setConfig('repliesInitialized', { at: 'x' });
  expect(await s.getConfig('repliesInitialized')).toEqual({ at: 'x' });
});

test('oauthState は 10 分で切れ、take は 1 回きり', async () => {
  let t = new Date('2026-10-28T00:00:00Z');
  const s = memoryStore({ now: () => t });
  await s.setOauthState('st1');
  t = new Date('2026-10-28T00:05:00Z');
  expect(await s.takeOauthState('st1')).toBe(true);
  expect(await s.takeOauthState('st1')).toBe(false);
  await s.setOauthState('st2');
  t = new Date('2026-10-28T00:16:00Z');
  expect(await s.takeOauthState('st2')).toBe(false);
  expect(await s.takeOauthState('nope')).toBe(false);
});
