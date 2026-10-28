const { createPhotos, mediaSig, COOLDOWN_DAYS, isHeic } = require('../src/photos');
const { memoryStore } = require('../src/store');

const NOW = new Date('2026-10-28T09:20:00+09:00');
const ENV = { THREADS_PHOTO_FOLDER_ID: 'FOLDER', CRON_KEY: 'tbkey', PUBLIC_BASE_URL: 'https://tb.example' };

function mk({ files = [], store = memoryStore({ now: () => NOW }), env = ENV, rng = () => 0, download, convert } = {}) {
  const drive = {
    listImages: jest.fn(async () => files),
    download: jest.fn(async (id) => (download ? download(id) : { bytes: Buffer.from('rawbytes'), mimeType: 'image/jpeg' })),
  };
  const conv = convert || jest.fn(async (bytes, mimeType) => Buffer.from(`jpeg:${mimeType}:${bytes.toString()}`));
  const photos = createPhotos({ drive, convert: conv, store, env, now: () => NOW, rng });
  return { photos, drive, store, convert: conv };
}

test('mediaSig は CRON_KEY の HMAC-SHA256 の先頭 32 桁', () => {
  const expected = require('crypto').createHmac('sha256', 'tbkey').update('photo:ABC').digest('hex').slice(0, 32);
  expect(mediaSig('ABC', { CRON_KEY: 'tbkey' })).toBe(expected);
  expect(mediaSig('ABC', {})).toBeNull();
});

test('pick: フォルダの画像から 60 日以内に使っていないものを選び、Drive から取って JPEG に変換し、自分の公開 URL を返す', async () => {
  const { photos, drive, convert } = mk({ files: [{ id: 'P1', name: 'course.HEIC', mimeType: 'image/heic' }, { id: 'P2', name: 'beer.jpg', mimeType: 'image/jpeg' }], rng: () => 0.9 });
  const p = await photos.pick();
  expect(p).toMatchObject({ id: 'P2', name: 'beer.jpg', url: `https://tb.example/media/photo/P2.jpg?sig=${mediaSig('P2', ENV)}`, mediaType: 'image/jpeg' });
  expect(drive.download).toHaveBeenCalledWith('P2');
  expect(convert).toHaveBeenCalledWith(Buffer.from('rawbytes'), 'image/jpeg', 'beer.jpg');
  expect(p.bytes.toString()).toBe('jpeg:image/jpeg:rawbytes');
});

test('serve: 同じ写真を URL で頼まれたら変換済みの JPEG を返す（Meta が取りに来る）。署名が違えば null', async () => {
  const { photos } = mk({ files: [{ id: 'P1', name: 'a.HEIC', mimeType: 'image/heic' }], download: async () => ({ bytes: Buffer.from('heicbytes'), mimeType: 'image/heic' }) });
  const p = await photos.pick();
  const served = await photos.serve('P1', mediaSig('P1', ENV));
  expect(served.toString()).toBe('jpeg:image/heic:heicbytes');
  expect(p.bytes.equals(served)).toBe(true);
  expect(await photos.serve('P1', 'wrong')).toBeNull();
  // 選んでいない写真でも、署名が合えば Drive から取って変換して返す（別インスタンスが受けても出せる）
  const { photos: p2, drive } = mk({ files: [], download: async () => ({ bytes: Buffer.from('x'), mimeType: 'image/jpeg' }) });
  expect((await p2.serve('P9', mediaSig('P9', ENV))).toString()).toBe('jpeg:image/jpeg:x');
  expect(drive.download).toHaveBeenCalledWith('P9');
});

test('pick: 最近使った写真は避ける。全部最近なら一番前に使ったものを使い回す', async () => {
  const { photos, store } = mk({ files: [{ id: 'P1', name: 'a.jpg', mimeType: 'image/jpeg' }, { id: 'P2', name: 'b.jpg', mimeType: 'image/jpeg' }], rng: () => 0 });
  await store.markPhotoUsed('P1');
  expect((await photos.pick()).id).toBe('P2');
  await store.markPhotoUsed('P2');
  expect((await photos.pick()).id).toBe('P1');
});

test('pick: フォルダ未設定・画像なし・一覧の失敗・変換の失敗は null（投稿は止めない）', async () => {
  expect(await mk({ env: { CRON_KEY: 'k', PUBLIC_BASE_URL: 'x' } }).photos.pick()).toBeNull();
  expect(await mk({ files: [] }).photos.pick()).toBeNull();
  const { photos, drive } = mk({ files: [{ id: 'P1', name: 'a.jpg', mimeType: 'image/jpeg' }] });
  drive.listImages.mockRejectedValueOnce(new Error('drive down'));
  expect(await photos.pick()).toBeNull();
  const bad = mk({ files: [{ id: 'P1', name: 'a.HEIC', mimeType: 'image/heic' }], convert: async () => { throw new Error('bad seek'); } });
  expect(await bad.photos.pick()).toBeNull();
});

test('shouldAttach: THREADS_PHOTO_RATE（既定 0.5）の確率', () => {
  expect(mk({ rng: () => 0.3 }).photos.shouldAttach()).toBe(true);
  expect(mk({ rng: () => 0.7 }).photos.shouldAttach()).toBe(false);
  expect(mk({ rng: () => 0.7, env: { ...ENV, THREADS_PHOTO_RATE: '0.9' } }).photos.shouldAttach()).toBe(true);
  expect(mk({ rng: () => 0.1, env: { ...ENV, THREADS_PHOTO_RATE: '0' } }).photos.shouldAttach()).toBe(false);
});

test('isHeic は mimeType か拡張子で判定', () => {
  expect(isHeic('image/heic', 'a.HEIC')).toBe(true);
  expect(isHeic('application/octet-stream', 'IMG_1.heif')).toBe(true);
  expect(isHeic('image/jpeg', 'a.jpg')).toBe(false);
});

test('COOLDOWN_DAYS は 60', () => expect(COOLDOWN_DAYS).toBe(60));

test('pick: 全部 60 日以内に使っていたら、一番前に使ったものを使い回す（在庫切れで写真なしにしない）', async () => {
  let t = new Date('2026-10-28T00:00:00Z');
  const store = memoryStore({ now: () => t });
  const { photos } = mk({ store, files: [{ id: 'P1', name: 'a.jpg', mimeType: 'image/jpeg' }, { id: 'P2', name: 'b.jpg', mimeType: 'image/jpeg' }], rng: () => 0 });
  await store.markPhotoUsed('P1');
  t = new Date('2026-10-29T00:00:00Z');
  await store.markPhotoUsed('P2');
  t = new Date('2026-10-30T00:00:00Z');
  expect((await photos.pick()).id).toBe('P1');
});
