/**
 * Threads API（graph.threads.net）。投稿・トークン・返信の取得。
 * 投稿は「コンテナを作る → status が FINISHED になるのを待つ → 公開する → permalink を取る」の 4 段。
 * 写真の image_url は誰でも開ける URL が必須（Meta が取りに来る）。
 * 公式: https://developers.facebook.com/docs/threads
 */
const ROOT = 'https://graph.threads.net';
const BASE = `${ROOT}/v1.0`;
const AUTHORIZE = 'https://threads.net/oauth/authorize';
// 2026-10-28 社長「フォロワー500人」で insights（数字）と manage_replies（コメントへの返事）を追加。足したら社長が /oauth/start で接続し直す
const SCOPES = ['threads_basic', 'threads_content_publish', 'threads_read_replies', 'threads_manage_replies', 'threads_manage_insights', 'threads_keyword_search'];
const POST_METRICS = ['views', 'likes', 'replies', 'reposts', 'quotes'];
const STATUS_POLL_MS = 5000;
const STATUS_TIMEOUT_MS = 60000;

function metaError(e) {
  const er = e && e.response && e.response.data && e.response.data.error;
  if (!er || !er.message) return (e && e.message) || String(e);
  // 制限・停止の理由は code / error_subcode / error_user_msg にしか出ないことがある（2026-10-29 「API access blocked.」の調査）
  const extra = [er.code != null ? `code=${er.code}` : '', er.error_subcode != null ? `sub=${er.error_subcode}` : '', er.error_user_title || '', er.error_user_msg || ''].filter(Boolean).join(' ');
  return extra ? `${er.message}（${extra}）` : er.message;
}

function createThreads({ http, env = process.env, now = () => new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const client = http || require('axios');

  const post = async (path, params) => (await client.post(`${BASE}${path}`, null, { params })).data;
  const get = async (path, params) => (await client.get(`${BASE}${path}`, { params })).data;
  // トークン関係だけは公式の例どおりバージョン無し（graph.threads.net/oauth/access_token など）
  const postRoot = async (path, params) => (await client.post(`${ROOT}${path}`, null, { params })).data;
  const getRoot = async (path, params) => (await client.get(`${ROOT}${path}`, { params })).data;

  const expiresAtFrom = (expiresIn) => new Date(now().getTime() + Number(expiresIn || 0) * 1000).toISOString();

  /**
   * @returns {Promise<{ok:true, mediaId, permalink}|{ok:false, error, stage}>}
   */
  async function publishPost({ token, userId, text, imageUrl = null, topicTag = null, replyToId = null }) {
    let containerId;
    try {
      const params = { media_type: imageUrl ? 'IMAGE' : 'TEXT', text, access_token: token };
      if (imageUrl) params.image_url = imageUrl;
      if (topicTag) params.topic_tag = String(topicTag).replace(/[#＃.&]/g, '').slice(0, 50); // Threads のトピックタグ（1 つ。. と & は不可）
      if (replyToId) params.reply_to_id = String(replyToId); // 返信（コメントへの返事）
      containerId = (await post(`/${userId}/threads`, params)).id;
      if (!containerId) return { ok: false, stage: 'container', error: 'コンテナ ID が返らなかった' };
    } catch (e) {
      return { ok: false, stage: 'container', error: metaError(e) };
    }
    const started = now().getTime();
    for (;;) {
      let st;
      try {
        st = await get(`/${containerId}`, { fields: 'status,error_message', access_token: token });
      } catch (e) {
        return { ok: false, stage: 'status', error: metaError(e) };
      }
      if (st.status === 'FINISHED') break;
      if (st.status === 'ERROR' || st.status === 'EXPIRED') return { ok: false, stage: 'status', error: `${st.status}: ${st.error_message || '理由不明'}` };
      if (now().getTime() - started >= STATUS_TIMEOUT_MS) return { ok: false, stage: 'status', error: `${STATUS_TIMEOUT_MS / 1000}秒待っても ${st.status || '不明'} のまま` };
      await sleep(STATUS_POLL_MS);
    }
    let mediaId;
    try {
      mediaId = (await post(`/${userId}/threads_publish`, { creation_id: containerId, access_token: token })).id;
      if (!mediaId) return { ok: false, stage: 'publish', error: '投稿 ID が返らなかった' };
    } catch (e) {
      return { ok: false, stage: 'publish', error: metaError(e) };
    }
    try {
      const m = await get(`/${mediaId}`, { fields: 'permalink', access_token: token });
      return { ok: true, mediaId, permalink: m.permalink || null };
    } catch (e) {
      // 公開はできているので失敗にしない（リンクだけ無い）
      console.warn(`[threads] PERMALINK_FAILED media=${mediaId}: ${metaError(e)}`);
      return { ok: true, mediaId, permalink: null };
    }
  }

  /** code → 短期トークン → 長期トークン（60日） */
  async function exchangeCode({ code, redirectUri }) {
    const short = await postRoot('/oauth/access_token', {
      client_id: env.THREADS_APP_ID, client_secret: env.THREADS_APP_SECRET,
      grant_type: 'authorization_code', redirect_uri: redirectUri, code,
    });
    const long = await getRoot('/access_token', { grant_type: 'th_exchange_token', client_secret: env.THREADS_APP_SECRET, access_token: short.access_token });
    // user_id は 2^53 を超える数字で JSON の読み込みで末尾が丸まる（2026-10-27 実測: …047 が …050 になり投稿が「Object does not exist」）。/me は文字列で返すのでそちらを使う
    const me = await get('/me', { fields: 'id', access_token: long.access_token });
    return { token: long.access_token, userId: String(me.id), expiresAt: expiresAtFrom(long.expires_in) };
  }

  async function refreshToken(token) {
    const r = await getRoot('/refresh_access_token', { grant_type: 'th_refresh_token', access_token: token });
    return { token: r.access_token, expiresAt: expiresAtFrom(r.expires_in) };
  }

  async function listMyPosts({ token, sinceIso }) {
    const params = { fields: 'id,permalink,timestamp', access_token: token, limit: 50 };
    if (sinceIso) params.since = sinceIso;
    const r = await get('/me/threads', params);
    return (r.data || []).map((p) => ({ id: p.id, permalink: p.permalink, timestamp: p.timestamp }));
  }

  async function listReplies({ token, mediaId }) {
    const r = await get(`/${mediaId}/replies`, { fields: 'id,text,username,timestamp,permalink,is_reply_owned_by_me', access_token: token });
    return (r.data || []).map((x) => ({ id: x.id, text: x.text, username: x.username, timestamp: x.timestamp, permalink: x.permalink, is_reply_owned_by_me: Boolean(x.is_reply_owned_by_me) }));
  }

  /** 公開投稿のキーワード検索（threads_keyword_search。審査前は自分の投稿しか返らない） */
  async function keywordSearch({ token, q, type = 'RECENT' }) {
    const r = await get('/keyword_search', { q, search_type: type, fields: 'id,text,username,permalink,timestamp,media_type,has_replies,is_reply', access_token: token });
    return (r.data || []).map((p) => ({ id: p.id, text: p.text, username: p.username, permalink: p.permalink, timestamp: p.timestamp, isReply: Boolean(p.is_reply) }));
  }

  /** コメントへの返事（reply_to_id 付きの投稿） */
  function publishReply({ token, userId, text, replyToId }) {
    return publishPost({ token, userId, text, replyToId });
  }

  /** フォロワー数（threads_manage_insights） */
  async function userInsights({ token }) {
    const r = await get('/me/threads_insights', { metric: 'followers_count', access_token: token });
    const row = ((r.data || []).find((d) => d.name === 'followers_count')) || {};
    const v = row.total_value ? row.total_value.value : (row.values && row.values[0] ? row.values[0].value : null);
    return { followers: Number(v) || 0 };
  }

  /** 投稿ごとの数字（無い指標は 0） */
  async function postInsights({ token, mediaId }) {
    const r = await get(`/${mediaId}/insights`, { metric: POST_METRICS.join(','), access_token: token });
    const out = {};
    for (const m of POST_METRICS) out[m] = 0;
    for (const d of r.data || []) {
      const v = d.total_value ? d.total_value.value : (d.values && d.values[0] ? d.values[0].value : 0);
      if (POST_METRICS.includes(d.name)) out[d.name] = Number(v) || 0;
    }
    return out;
  }

  /** 鍵の持ち主と権限（診断用。鍵そのものは返さない） */
  async function whoAmI(token) {
    const me = await get('/me', { fields: 'id,username', access_token: token });
    let scopes = null; let appId = null;
    try {
      const d = await getRoot('/debug_token', { input_token: token, access_token: `${env.THREADS_APP_ID}|${env.THREADS_APP_SECRET}` });
      scopes = (d.data && d.data.scopes) || null; appId = (d.data && d.data.app_id) || null;
    } catch (e) {
      console.warn(`[threads] DEBUG_TOKEN_FAILED ${metaError(e)}`);
    }
    return { id: me.id, username: me.username, scopes, appId };
  }

  function authorizeUrl({ redirectUri, state }) {
    const u = new URL(AUTHORIZE);
    u.searchParams.set('client_id', env.THREADS_APP_ID || '');
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('scope', SCOPES.join(','));
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('state', state);
    return u.toString();
  }

  return { publishPost, publishReply, userInsights, postInsights, keywordSearch, exchangeCode, refreshToken, listMyPosts, listReplies, authorizeUrl, whoAmI };
}

module.exports = { createThreads, BASE, SCOPES, metaError };
