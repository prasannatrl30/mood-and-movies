# Instagram auto-post — setup checklist

This is the one-time, manual part. Everything else (picking a title, writing the
caption, rendering the card, posting at 5PM Sydney) is automated by
[`scripts/daily-post.mjs`](scripts/daily-post.mjs) and
[`.github/workflows/daily-post.yml`](.github/workflows/daily-post.yml).

You'll end up with four secrets in GitHub:
`ANTHROPIC_API_KEY`, `TMDB_API_KEY`, `IG_USER_ID`, `IG_ACCESS_TOKEN`.

Budget ~30–45 minutes. The Meta side is fiddly but you only do it once.

---

## 1. Make the Instagram account postable (5 min)

1. Open Instagram → **Settings → Account type and tools → Switch to professional account**.
2. Choose **Creator** (or Business). It's free and reversible.
3. Create or pick a **Facebook Page** and link your Instagram to it.
   Meta's publishing API *requires* an IG account connected to a Page — there's no way around this.

## 2. Create a Meta developer app (10 min)

1. Go to <https://developers.facebook.com/apps> → **Create app**.
2. Use case: pick **Other → Business**.
3. In the app dashboard → **Add product** → add **Instagram Graph API**
   (and **Facebook Login for Business** if prompted).

## 3. Get your IDs and a token (15 min)

Easiest path is the **Graph API Explorer** (<https://developers.facebook.com/tools/explorer>):

1. Select your app (top right).
2. Click **Generate Access Token** and grant these permissions:
   - `instagram_basic`
   - `instagram_content_publish`
   - `pages_show_list`
   - `pages_read_engagement`
   - `business_management`
3. Run these queries in the Explorer to find your Instagram Business Account id:
   - `me/accounts` → note your Page's `id`
   - `{page-id}?fields=instagram_business_account` → this returns your **`IG_USER_ID`** ✅
4. The token shown is short-lived (~1 hour). Exchange it for a **long-lived** one (~60 days):

   ```bash
   curl "https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=SHORT_LIVED_TOKEN"
   ```

   The `access_token` it returns is your **`IG_ACCESS_TOKEN`** ✅
   (App ID + Secret are in the app dashboard under **Settings → Basic**.)

> **App Review:** while your app is in *Development mode* you can publish to
> Instagram accounts that have a **role** on the app (i.e. your own). That's all
> you need for a personal feed — you do **not** need to submit for App Review.

## 4. Add the secrets to GitHub (5 min)

In your repo → **Settings → Secrets and variables → Actions**:

**Secrets** (New repository secret):
| Name | Value |
|------|-------|
| `ANTHROPIC_API_KEY` | your Claude key |
| `TMDB_API_KEY` | your TMDB key |
| `IG_USER_ID` | from step 3.3 |
| `IG_ACCESS_TOKEN` | the long-lived token from step 3.4 |

**Variables** (the "Variables" tab — not secret):
| Name | Value |
|------|-------|
| `IG_HANDLE` | e.g. `@prasanna.watches` (shown on the card) |

## 5. Test it (5 min)

1. Locally, copy `.env.example` → `.env`, fill in `ANTHROPIC_API_KEY` + `TMDB_API_KEY`,
   then render a card without posting:

   ```bash
   npm install
   npm run post:dry
   ```

   Open `posts/latest.jpg` — that's exactly what would go up. Tweak the design in
   [`scripts/lib/card.mjs`](scripts/lib/card.mjs) until you love it.

2. When happy, go to the repo's **Actions** tab → **Daily Instagram post** →
   **Run workflow**. `workflow_dispatch` ignores the 5PM gate so it posts immediately.
   Check your Instagram. 🎉

3. From then on it runs **every day at 5PM Sydney** on its own.

---

## Keeping the token alive

The long-lived token lasts ~60 days. Two options:

- **Simple:** set a calendar reminder every ~50 days to re-run the `curl` in step 3.4
  and update the `IG_ACCESS_TOKEN` secret.
- **Hands-off (later):** add a monthly workflow that calls
  `refreshLongLivedToken()` in [`scripts/lib/instagram.mjs`](scripts/lib/instagram.mjs)
  and writes the new token back as a secret via the GitHub API. We can wire this
  up once the daily post is proven.

## If a post fails

The workflow logs show exactly where. Common causes:
- **`(#10) Application does not have permission`** → token missing `instagram_content_publish`, regenerate (step 3.2).
- **Container `ERROR` status** → Instagram couldn't fetch the image; the card URL wasn't public yet. The workflow pins an immutable commit URL to avoid this, but a private repo would break it — keep the repo public, or switch to a dedicated image host.
- **Token expired** → refresh it (above).
