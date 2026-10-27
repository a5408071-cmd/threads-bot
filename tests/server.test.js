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
