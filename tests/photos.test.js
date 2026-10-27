const { createPhotos, mediaSig, COOLDOWN_DAYS } = require('../src/photos');
const { memoryStore } = require('../src/store');

const NOW = new Date('2026-10-28T09:20:00+09:00');
const ENV = { THREADS_PHOTO_FOLDER_ID: 'FOLDER', ISO_CRON_KEY: 'isokey', ISO_BOT_URL: 'https://iso-bot.example' };

function mk({ files = [], store = memoryStore({ now: () => NOW }), env = ENV, rng = () => 0, fetchImage } = {}) {
  const drive = { listImages: jest.fn(async () => files) };
  const http = { get: jest.fn(async (url) => (fetchImage ? fetchImage(url) : { data: Buffer.from('jpegbytes'), headers: { 'content-type': 'image/jpeg' } })) };
  const photos = createPhotos({ drive, http, store, env, now: () => NOW, rng });
  return { photos, drive, http, store };
}

test('mediaSig は iso-bot の gbpReviews.mediaSig と同じ式（HMAC-SHA256 の先頭 32 桁）', () => {
  const expected = require('crypto').createHmac('sha256', 'isokey').update('drive:ABC').digest('hex').slice(0, 32);
  expect(mediaSig('ABC', { ISO_CRON_KEY: 'isokey' })).toBe(expected);
});

test('pick: フォルダの画像から 60 日以内に使っていないものを選び、公開 URL と中身を返す', async () => {
  const { photos, http } = mk({ files: [{ id: 'P1', name: 'course.jpg', mimeType: 'image/jpeg' }, { id: 'P2', name: 'beer.jpg', mimeType: 'image/jpeg' }], rng: () => 0.9 });
  const p = await photos.pick();
  expect(p).toMatchObject({ id: 'P2', name: 'beer.jpg', url: `https://iso-bot.example/media/drive/P2.jpg?sig=${mediaSig('P2', ENV)}`, mediaType: 'image/jpeg' });
  expect(p.bytes.toString('base64')).toBe(Buffer.from('jpegbytes').toString('base64'));
  expect(http.get).toHaveBeenCalledWith(p.url, expect.objectContaining({ responseType: 'arraybuffer' }));
});

test('pick: 最近使った写真は避ける。全部最近なら null', async () => {
  const { photos, store } = mk({ files: [{ id: 'P1', name: 'a.jpg', mimeType: 'image/jpeg' }, { id: 'P2', name: 'b.jpg', mimeType: 'image/jpeg' }], rng: () => 0 });
  await store.markPhotoUsed('P1');
  expect((await photos.pick()).id).toBe('P2');
  await store.markPhotoUsed('P2');
  expect(await photos.pick()).toBeNull();
});

test('pick: フォルダ未設定・画像なし・一覧の失敗は null（投稿は止めない）', async () => {
  expect(await mk({ env: { ISO_CRON_KEY: 'k', ISO_BOT_URL: 'x' } }).photos.pick()).toBeNull();
  expect(await mk({ files: [] }).photos.pick()).toBeNull();
  const { photos, drive } = mk();
  drive.listImages.mockRejectedValueOnce(new Error('drive down'));
  expect(await photos.pick()).toBeNull();
});

test('pick: 中身が取れなければ null（URL だけで投稿しない＝Meta も取れない）', async () => {
  const { photos } = mk({ files: [{ id: 'P1', name: 'a.jpg', mimeType: 'image/jpeg' }], fetchImage: async () => { throw new Error('502'); } });
  expect(await photos.pick()).toBeNull();
});

test('shouldAttach: THREADS_PHOTO_RATE（既定 0.5）の確率', () => {
  const { photos } = mk({ rng: () => 0.3 });
  expect(photos.shouldAttach()).toBe(true);
  expect(mk({ rng: () => 0.7 }).photos.shouldAttach()).toBe(false);
  expect(mk({ rng: () => 0.7, env: { ...ENV, THREADS_PHOTO_RATE: '0.9' } }).photos.shouldAttach()).toBe(true);
  expect(mk({ rng: () => 0.1, env: { ...ENV, THREADS_PHOTO_RATE: '0' } }).photos.shouldAttach()).toBe(false);
});

test('COOLDOWN_DAYS は 60', () => expect(COOLDOWN_DAYS).toBe(60));
