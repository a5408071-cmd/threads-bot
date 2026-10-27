/**
 * Firestore の読み書き（コレクションはすべて threads_ 接頭辞）。
 *   threads_days/<YYYY-MM-DD>   … その日の投稿枠 {dateKey, slots, posted:[{index,...}], claimed:[index]}
 *   threads_posts/<mediaId>     … 出した投稿 {text, type, source, permalink, postedAt}
 *   threads_replies/<replyId>   … 知らせ済みのコメント
 *   threads_config/<key>        … token / oauthState / その他の設定
 *   threads_alerts/<key>        … 社長 DM の知らせの最終時刻（同じ知らせを 12 時間に 1 回に）
 * テストは memoryStore()（Firestore の使う部分だけを Map で真似た fakeDb を createStore に渡す＝本番と同じ経路を通る）。
 */
const C = {
  days: 'threads_days',
  posts: 'threads_posts',
  replies: 'threads_replies',
  config: 'threads_config',
  alerts: 'threads_alerts',
};

function createStore(db, { now = () => new Date() } = {}) {
  const col = (name) => db.collection(name);
  const data = (snap) => (snap && snap.exists ? snap.data() : null);

  async function getDay(dateKey) {
    return data(await col(C.days).doc(dateKey).get());
  }

  async function ensureDay(dateKey, drawFn) {
    const ref = col(C.days).doc(dateKey);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return snap.data();
      const drawn = drawFn();
      const day = { dateKey, slots: drawn.slots, posted: [], claimed: [], createdAt: now().toISOString() };
      tx.set(ref, day);
      return day;
    });
  }

  async function claimSlot(dateKey, index) {
    const ref = col(C.days).doc(dateKey);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const d = snap.data();
      const claimed = Array.isArray(d.claimed) ? d.claimed : [];
      if (claimed.includes(index) || (d.posted || []).some((p) => p.index === index)) return false;
      tx.update(ref, { claimed: [...claimed, index] });
      return true;
    });
  }

  async function releaseSlot(dateKey, index) {
    const ref = col(C.days).doc(dateKey);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const claimed = (snap.data().claimed || []).filter((i) => i !== index);
      tx.update(ref, { claimed });
    });
  }

  async function appendPosted(dateKey, entry) {
    const ref = col(C.days).doc(dateKey);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const posted = [...(snap.data().posted || []), entry];
      tx.update(ref, { posted });
    });
  }

  const markPosted = (dateKey, index, { mediaId }) => appendPosted(dateKey, { index, mediaId, at: now().toISOString() });
  const markSkipped = (dateKey, index, reason) => appendPosted(dateKey, { index, skipped: reason, at: now().toISOString() });

  async function savePost(post) {
    const postedAt = post.postedAt || now().toISOString();
    await col(C.posts).doc(String(post.mediaId)).set({ ...post, postedAt });
  }

  async function recentPosts(n = 14) {
    const snap = await col(C.posts).orderBy('postedAt', 'desc').limit(n).get();
    return snap.docs.map((d) => d.data());
  }

  async function getToken() {
    return data(await col(C.config).doc('token').get());
  }
  async function setToken(t) {
    await col(C.config).doc('token').set({ ...t, savedAt: now().toISOString() });
  }

  async function getConfig(key) {
    return data(await col(C.config).doc(key).get());
  }
  async function setConfig(key, value) {
    await col(C.config).doc(key).set(value);
  }

  async function seenReply(replyId) {
    const snap = await col(C.replies).doc(String(replyId)).get();
    return Boolean(snap && snap.exists);
  }
  async function markReplySeen(replyId, extra = {}) {
    await col(C.replies).doc(String(replyId)).set({ ...extra, seenAt: now().toISOString() });
  }

  /** 同じ知らせを hours ごとに 1 回だけ。出してよいときは時刻を書いて true */
  async function alertDue(key, hours = 12) {
    const ref = col(C.alerts).doc(key);
    const t = now();
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const last = snap.exists && snap.data().at ? new Date(snap.data().at).getTime() : 0;
      if (t.getTime() - last < hours * 3600 * 1000) return false;
      tx.set(ref, { at: t.toISOString() });
      return true;
    });
  }

  return { getDay, ensureDay, claimSlot, releaseSlot, markPosted, markSkipped, savePost, recentPosts, getToken, setToken, getConfig, setConfig, seenReply, markReplySeen, alertDue };
}

/** Firestore の使う部分だけを Map で真似る（テスト用）。createStore に渡すので本番と同じ経路を通る */
function fakeDb() {
  const cols = new Map();
  const table = (name) => { if (!cols.has(name)) cols.set(name, new Map()); return cols.get(name); };
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const snapOf = (t, id) => ({ exists: t.has(id), id, data: () => clone(t.get(id)) });
  const docRef = (t, id) => ({
    id,
    get: async () => snapOf(t, id),
    set: async (v) => { t.set(id, clone(v)); },
    update: async (v) => { if (!t.has(id)) throw new Error('not found'); t.set(id, { ...t.get(id), ...clone(v) }); },
    create: async (v) => { if (t.has(id)) throw new Error('already exists'); t.set(id, clone(v)); },
    delete: async () => { t.delete(id); },
    _t: t,
  });
  const query = (t, { order = null, dir = 'asc', lim = null } = {}) => ({
    orderBy: (f, d = 'asc') => query(t, { order: f, dir: d, lim }),
    limit: (n) => query(t, { order, dir, lim: n }),
    get: async () => {
      let rows = [...t.entries()].map(([id, v]) => ({ id, data: () => clone(v), exists: true }));
      if (order) rows.sort((a, b) => (a.data()[order] < b.data()[order] ? -1 : a.data()[order] > b.data()[order] ? 1 : 0) * (dir === 'desc' ? -1 : 1));
      if (lim != null) rows = rows.slice(0, lim);
      return { docs: rows, empty: rows.length === 0 };
    },
  });
  return {
    collection: (name) => {
      const t = table(name);
      return { doc: (id) => docRef(t, String(id)), ...query(t) };
    },
    runTransaction: async (fn) => {
      const tx = {
        get: (ref) => ref.get(),
        set: (ref, v) => { ref._t.set(ref.id, clone(v)); },
        update: (ref, v) => { ref._t.set(ref.id, { ...ref._t.get(ref.id), ...clone(v) }); },
        delete: (ref) => { ref._t.delete(ref.id); },
      };
      return fn(tx);
    },
    _cols: cols,
  };
}

function memoryStore(opts = {}) {
  const db = fakeDb();
  const s = createStore(db, opts);
  s._db = db;
  return s;
}

module.exports = { createStore, memoryStore, fakeDb, COLLECTIONS: C };
