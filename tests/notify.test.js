const { createNotify } = require('../src/notify');

test('owner は iso-bot の /admin/post に to:owner と X-Cron-Key で送る', async () => {
  const post = jest.fn(async () => ({ data: { ok: true } }));
  const n = createNotify({ http: { post }, env: { ISO_BOT_URL: 'https://iso.example/', ISO_CRON_KEY: 'ik' } });
  const r = await n.owner('こんにちは');
  expect(r).toEqual({ ok: true });
  expect(post).toHaveBeenCalledWith('https://iso.example/admin/post', { to: 'owner', text: 'こんにちは' }, expect.objectContaining({ headers: expect.objectContaining({ 'X-Cron-Key': 'ik' }) }));
});

test('http が投げても {ok:false} で返り、例外にならない', async () => {
  const post = jest.fn(async () => { const e = new Error('boom'); e.response = { status: 403 }; throw e; });
  const n = createNotify({ http: { post }, env: { ISO_BOT_URL: 'https://iso.example', ISO_CRON_KEY: 'ik' } });
  const r = await n.owner('x');
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/403|boom/);
});

test('ISO_BOT_URL か ISO_CRON_KEY が無ければ呼ばずに {ok:false}', async () => {
  const post = jest.fn();
  const n = createNotify({ http: { post }, env: { ISO_BOT_URL: 'https://iso.example' } });
  expect(await n.owner('x')).toEqual({ ok: false, error: 'ISO_BOT_URL / ISO_CRON_KEY 未設定' });
  expect(post).not.toHaveBeenCalled();
});

test('空の本文は送らない', async () => {
  const post = jest.fn();
  const n = createNotify({ http: { post }, env: { ISO_BOT_URL: 'https://iso.example', ISO_CRON_KEY: 'ik' } });
  expect((await n.owner('  ')).ok).toBe(false);
  expect(post).not.toHaveBeenCalled();
});
