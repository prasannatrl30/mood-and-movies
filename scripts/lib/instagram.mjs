/**
 * Instagram Graph API publishing.
 *
 * Flow (official, TOS-compliant):
 *   1. POST /{ig-user-id}/media        with image_url + caption  → creation_id
 *   2. Poll  /{creation_id}?fields=status_code  until FINISHED
 *   3. POST /{ig-user-id}/media_publish with creation_id          → media_id
 *   4. GET   /{media_id}?fields=permalink                         → live URL
 *
 * Requires, in env:
 *   IG_USER_ID        — Instagram Business/Creator account id (numeric)
 *   IG_ACCESS_TOKEN   — long-lived token with instagram_content_publish
 */

// Instagram API with Instagram Login uses the graph.instagram.com host
// (not graph.facebook.com). The access token is an Instagram User token.
const GRAPH = 'https://graph.instagram.com/v21.0';

async function graph(path, { method = 'GET', params = {} } = {}) {
  const url = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, { method });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`Instagram API error on ${method} ${path}: ${msg}`);
  }
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolve the Instagram user id straight from the token (so IG_USER_ID is optional). */
export async function resolveIgUserId(accessToken) {
  const me = await graph('me', { params: { fields: 'user_id,username', access_token: accessToken } });
  return me.user_id ?? me.id;
}

/**
 * Publish a single image to Instagram.
 * @returns {Promise<{ id: string, permalink: string|null }>}
 */
export async function publishImage({ igUserId, accessToken, imageUrl, caption }) {
  if (!accessToken) throw new Error('Missing IG_ACCESS_TOKEN');
  if (!igUserId) {
    igUserId = await resolveIgUserId(accessToken);
    console.log(`[instagram] resolved IG user id: ${igUserId}`);
  }

  // 1. Create the media container
  const container = await graph(`${igUserId}/media`, {
    method: 'POST',
    params: { image_url: imageUrl, caption, access_token: accessToken },
  });
  const creationId = container.id;
  console.log(`[instagram] container created: ${creationId}`);

  // 2. Wait for Instagram to fetch + process the image
  for (let attempt = 0; attempt < 15; attempt++) {
    await sleep(3000);
    const { status_code, status } = await graph(creationId, {
      params: { fields: 'status_code,status', access_token: accessToken },
    });
    console.log(`[instagram] container status: ${status_code}${status ? ` (${status})` : ''}`);
    if (status_code === 'FINISHED') break;
    if (status_code === 'ERROR') throw new Error(`Container processing failed: ${status ?? 'ERROR'}`);
    if (attempt === 14) throw new Error('Container never reached FINISHED — aborting publish');
  }

  // 3. Publish
  const published = await graph(`${igUserId}/media_publish`, {
    method: 'POST',
    params: { creation_id: creationId, access_token: accessToken },
  });
  console.log(`[instagram] published media: ${published.id}`);

  // 4. Fetch the permalink (best-effort)
  let permalink = null;
  try {
    const info = await graph(published.id, {
      params: { fields: 'permalink', access_token: accessToken },
    });
    permalink = info.permalink ?? null;
  } catch (e) {
    console.warn('[instagram] could not fetch permalink:', e.message);
  }

  return { id: published.id, permalink };
}

/**
 * Refresh a long-lived Instagram token (~60 day lifetime).
 * Use this from a monthly maintenance job so the token never silently expires.
 * @returns {Promise<{ access_token: string, expires_in: number }>}
 */
export async function refreshLongLivedToken({ currentToken }) {
  const data = await graph('refresh_access_token', {
    params: { grant_type: 'ig_refresh_token', access_token: currentToken },
  });
  return { access_token: data.access_token, expires_in: data.expires_in };
}
