/**
 * Refresh the Instagram long-lived access token and update the GitHub secret.
 * Runs monthly via .github/workflows/refresh-token.yml.
 */
import { execSync } from 'node:child_process';
import { refreshLongLivedToken } from './lib/instagram.mjs';

const token = process.env.IG_ACCESS_TOKEN;
if (!token) { console.error('IG_ACCESS_TOKEN not set'); process.exit(1); }

const repo = process.env.GITHUB_REPOSITORY;
if (!repo) { console.error('GITHUB_REPOSITORY not set'); process.exit(1); }

const { access_token: newToken, expires_in } = await refreshLongLivedToken({ currentToken: token });
const days = Math.round(expires_in / 86400);
console.log(`[refresh] new token obtained — expires in ~${days} days`);

// gh CLI is pre-installed on ubuntu-latest; pipe value via stdin so it's never
// visible in process arguments or logs.
execSync(`gh secret set IG_ACCESS_TOKEN --repo ${repo}`, {
  input: newToken,
  stdio: ['pipe', 'inherit', 'inherit'],
  env: { ...process.env, GH_TOKEN: process.env.GH_TOKEN },
});
console.log(`[refresh] ✅ IG_ACCESS_TOKEN secret updated in ${repo}`);
