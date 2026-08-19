import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  SYNERISE_API_KEY,
  SYNERISE_API_BASE = 'https://api.synerise.com',
  PORT = 3000,
} = process.env;

const PROMOTION_TAG_DIRECTORY_NAME = 'promotion';
let promotionTagDirectoryHash = process.env.PROMOTION_TAG_DIRECTORY_HASH || null;

if (!SYNERISE_API_KEY) {
  console.error('Missing SYNERISE_API_KEY in .env');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// ---- Local-only access guard -----------------------------------------------
//
// The server only ever serves a single user on their own machine. Three
// stacked defences keep a malicious page (or a process on the LAN) from
// hijacking the API:
//   1. Bind to 127.0.0.1 only — LAN traffic can't reach us at all.
//   2. Host/Origin allow-list — defeats DNS rebinding (attacker domain
//      resolves to 127.0.0.1, but Host/Origin still names the attacker).
//   3. Session cookie set on GET / with SameSite=Strict — a cross-site
//      fetch can't carry the cookie, so /api/* routes reject it.

const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
const SESSION_COOKIE = 'handbill_session';
const SESSION_TOKEN = randomUUID();

function parseCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function hostOriginGuard(req, res, next) {
  if (!ALLOWED_HOSTS.has(req.headers.host)) {
    return res.status(403).json({ error: `Host not allowed: ${req.headers.host}` });
  }
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return res.status(403).json({ error: `Origin not allowed: ${origin}` });
  }
  return next();
}

// Issue a session cookie when the HTML shell is loaded. SameSite=Strict
// means the cookie is never attached to cross-site requests, so a malicious
// page that somehow reaches 127.0.0.1 can't piggy-back on a logged-in tab.
app.get(['/', '/index.html'], (req, res, next) => {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${SESSION_TOKEN}; HttpOnly; SameSite=Strict; Path=/`);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// All API routes require both the host/origin allow-list and the session cookie.
app.use('/api', hostOriginGuard, (req, res, next) => {
  if (parseCookie(req, SESSION_COOKIE) !== SESSION_TOKEN) {
    return res.status(403).json({ error: 'Missing or stale session cookie — reload http://localhost:' + PORT });
  }
  return next();
});

// ---- Token cache -----------------------------------------------------------

let tokenCache = { token: null, expiresAt: 0, raw: null };

async function requestToken(apiKey) {
  const res = await fetch(`${SYNERISE_API_BASE}/uauth/v2/auth/login/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    throw new Error(`Token request failed: ${res.status} ${res.statusText} — ${text}`);
  }
  const token = body.token || body.access_token;
  const expiresInSec = Number(body.expires_in ?? body.expiresIn ?? 1800);
  if (!token) {
    throw new Error('Token response missing token field: ' + text);
  }
  return { token, expiresInSec, raw: body };
}

async function fetchToken() {
  const { token, expiresInSec, raw } = await requestToken(process.env.SYNERISE_API_KEY);
  tokenCache = {
    token,
    expiresAt: Date.now() + (expiresInSec - 30) * 1000,
    raw,
  };
  return tokenCache;
}

async function getToken({ force = false } = {}) {
  if (!force && tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache;
  }
  return fetchToken();
}

// Call a Synerise endpoint with bearer auth. On 401, refresh the token once and retry.
async function authedFetch(url, init = {}) {
  const send = async (token) => {
    const headers = { ...(init.headers || {}), Authorization: `Bearer ${token}` };
    return fetch(url, { ...init, headers });
  };
  let t = await getToken();
  let res = await send(t.token);
  if (res.status === 401) {
    console.warn(`[auth] 401 from ${url} — refreshing token and retrying once`);
    t = await getToken({ force: true });
    res = await send(t.token);
  }
  return res;
}

// ---- Helpers ---------------------------------------------------------------

async function readBody(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function proxyGet(res, { label, url, headers = {} }) {
  try {
    const apiRes = await authedFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...headers },
    });
    const body = await readBody(apiRes);
    console.log(`[${label}] ${apiRes.status} ${url}`);
    console.dir(body, { depth: null });
    res.status(apiRes.ok ? 200 : apiRes.status).json({
      ok: apiRes.ok,
      status: apiRes.status,
      url,
      response: body,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

let promotionSerial = 0;

function nextSerial() {
  promotionSerial += 1;
  return promotionSerial;
}

function rand5() {
  return String(Math.floor(Math.random() * 100000)).padStart(5, '0');
}

function isoDateCompact(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function renderTemplate(tpl, ctx) {
  return tpl
    .replaceAll('{rand5}', ctx.rand5)
    .replaceAll('{date}', ctx.date)
    .replaceAll('{serial}', String(ctx.serial))
    .replaceAll('{iso}', ctx.iso);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Render {rand5}/{date}/{serial}/{iso} placeholders in every string value of
// a JSON tree — lets transaction ids re-roll per request like promotion names.
function renderTemplatesDeep(node, ctx) {
  if (typeof node === 'string') return renderTemplate(node, ctx);
  if (Array.isArray(node)) return node.map((v) => renderTemplatesDeep(v, ctx));
  if (isPlainObject(node)) {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = renderTemplatesDeep(v, ctx);
    return out;
  }
  return node;
}

// Recursively merge `source` into `target`. Nested plain objects combine;
// scalars and arrays from `source` overwrite.
function deepMerge(target, source) {
  for (const [k, v] of Object.entries(source)) {
    if (isPlainObject(v) && isPlainObject(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

// Normalize a targetSegment value (array, comma-string, or single string)
// into an array of trimmed non-empty segment ids.
function toSegmentArray(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

// Batch-overwrite payload, keyed on `code`. BatchImportPromotions is a partial
// merge/upsert (verified) — fields you DON'T send are left untouched on an
// existing promotion. So the minimal, non-destructive item to point a promotion
// at a segment is just the id + the two target fields. `targetType: SEGMENT` is
// required for the segment to actually be enforced (sending only targetSegment
// leaves targetType=ALL and the list is ignored).
function buildImportPayload({ code, targetSegment }) {
  return { code, targetType: 'SEGMENT', targetSegment };
}

// ---- Workspace keychain ----------------------------------------------------
//
// Workspace API keys live in the platform keystore — macOS Keychain, Windows
// Credential Manager (PasswordVault) or a libsecret keyring on Linux — one
// item per workspace, service "handbill-tests". Never in browser storage,
// never in a plaintext file, and the secret never appears on a command line
// (macOS: stdin into `security -i`; Windows: env vars into PowerShell;
// Linux: stdin into secret-tool). The browser only sees { id, name };
// switching sends the id and the server pulls the key from the keystore.
// The names/ids (not secret) are listed in workspaces.json next to .env.

const KEYCHAIN_SERVICE = 'handbill-tests';
const WORKSPACES_PATH = path.join(__dirname, 'workspaces.json');

// Human-readable keystore name; null = platform without a supported store.
const KEYSTORE_NAME = {
  darwin: 'macOS Keychain',
  win32: 'Windows Credential Manager',
  linux: 'libsecret keyring',
}[process.platform] || null;

function execWithStdin(cmd, args, stdin, env) {
  return new Promise((resolve, reject) => {
    const p = execFile(cmd, args, env ? { env: { ...process.env, ...env } } : {}, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').pop()));
      else resolve(stdout);
    });
    if (stdin != null) p.stdin.write(stdin);
    p.stdin.end();
  });
}

// Windows: PasswordVault via the always-present powershell.exe — per-user,
// encrypted at rest, shows up under Credential Manager → Web Credentials.
// Account and secret travel through env vars only.
const PS_VAULT = `[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]|Out-Null;$v=New-Object Windows.Security.Credentials.PasswordVault;`;

function runPowershell(script, env) {
  return execWithStdin('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], null, env);
}

async function keychainSet(account, secret) {
  if (process.platform === 'darwin') {
    const esc = (s) => `"${String(s).replace(/([\\"])/g, '\\$1')}"`;
    return execWithStdin('security', ['-i'], // -U updates an existing item in place
      `add-generic-password -U -s ${esc(KEYCHAIN_SERVICE)} -a ${esc(account)} -l ${esc('Handbill Tests — workspace key')} -w ${esc(secret)}\n`);
  }
  if (process.platform === 'win32') {
    return runPowershell(
      `${PS_VAULT}try{$v.Remove($v.Retrieve('${KEYCHAIN_SERVICE}',$env:HB_ACCOUNT))}catch{};` +
      `$v.Add((New-Object Windows.Security.Credentials.PasswordCredential('${KEYCHAIN_SERVICE}',$env:HB_ACCOUNT,$env:HB_SECRET)))`,
      { HB_ACCOUNT: account, HB_SECRET: secret });
  }
  if (process.platform === 'linux') {
    return execWithStdin('secret-tool',
      ['store', '--label=Handbill Tests — workspace key', 'service', KEYCHAIN_SERVICE, 'account', account],
      secret);
  }
  throw new Error('no supported system keystore on this platform');
}

async function keychainGet(account) {
  if (process.platform === 'darwin') {
    return (await execWithStdin('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'])).trim();
  }
  if (process.platform === 'win32') {
    return (await runPowershell(
      `${PS_VAULT}$c=$v.Retrieve('${KEYCHAIN_SERVICE}',$env:HB_ACCOUNT);$c.RetrievePassword();[Console]::Out.Write($c.Password)`,
      { HB_ACCOUNT: account })).trim();
  }
  if (process.platform === 'linux') {
    const out = (await execWithStdin('secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE, 'account', account])).trim();
    if (!out) throw new Error('key not found in the keyring');
    return out;
  }
  throw new Error('no supported system keystore on this platform');
}

function keychainDelete(account) {
  if (process.platform === 'darwin') {
    return execWithStdin('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account]);
  }
  if (process.platform === 'win32') {
    return runPowershell(
      `${PS_VAULT}$v.Remove($v.Retrieve('${KEYCHAIN_SERVICE}',$env:HB_ACCOUNT))`,
      { HB_ACCOUNT: account });
  }
  if (process.platform === 'linux') {
    return execWithStdin('secret-tool', ['clear', 'service', KEYCHAIN_SERVICE, 'account', account]);
  }
  throw new Error('no supported system keystore on this platform');
}

async function readWorkspacesMeta() {
  try {
    const list = JSON.parse(await fs.readFile(WORKSPACES_PATH, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeWorkspacesMeta(list) {
  return fs.writeFile(WORKSPACES_PATH, JSON.stringify(list, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}

// Point the whole server at a new key: validate with a login, swap the cached
// token, drop the workspace-specific tag-directory hash.
async function switchActiveKey(apiKey) {
  const issued = await requestToken(apiKey); // throws on an invalid key
  process.env.SYNERISE_API_KEY = apiKey;
  tokenCache = {
    token: issued.token,
    expiresAt: Date.now() + (issued.expiresInSec - 30) * 1000,
    raw: issued.raw,
  };
  promotionTagDirectoryHash = null;
  delete process.env.PROMOTION_TAG_DIRECTORY_HASH;
  let directoryHash = null;
  let directoryError = null;
  try {
    directoryHash = await resolvePromotionTagDirectoryHash({ force: true });
  } catch (err) {
    directoryError = err.message;
  }
  return {
    expiresAt: new Date(tokenCache.expiresAt).toISOString(),
    promotionTagDirectoryHash: directoryHash,
    promotionTagDirectoryError: directoryError,
  };
}

app.get('/api/workspaces', async (req, res) => {
  const meta = await readWorkspacesMeta();
  res.json({ ok: true, store: KEYSTORE_NAME, workspaces: meta.map(({ id, name }) => ({ id, name })) });
});

// Add a workspace: validate the key, store it in the Keychain, register
// { id, name } in workspaces.json. Deliberately does NOT switch to it — the
// client calls /activate next, and the browser-store migration can import
// old entries without side effects. Re-adding an already stored key returns
// the existing entry instead of creating a duplicate.
app.post('/api/workspaces', async (req, res) => {
  if (!KEYSTORE_NAME) {
    return res.status(501).json({ ok: false, error: `no supported system keystore on ${process.platform} (supported: macOS, Windows, Linux)` });
  }
  const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
  if (!apiKey) return res.status(400).json({ ok: false, error: 'apiKey is required' });
  const name = (typeof req.body?.name === 'string' && req.body.name.trim()) || `workspace ${apiKey.slice(0, 8)}…`;
  try {
    await requestToken(apiKey);
  } catch (err) {
    return res.status(401).json({ ok: false, error: err.message });
  }
  const meta = await readWorkspacesMeta();
  for (const w of meta) {
    try {
      if (await keychainGet(w.id) === apiKey) {
        return res.json({ ok: true, id: w.id, name: w.name, existed: true });
      }
    } catch { /* metadata without a keychain item — ignore */ }
  }
  const id = `ws-${randomUUID()}`;
  try {
    await keychainSet(id, apiKey);
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Keychain write failed: ${err.message}` });
  }
  meta.push({ id, name, createdAt: new Date().toISOString() });
  await writeWorkspacesMeta(meta);
  console.log(`[workspace] added "${name}" (${id}) — key stored in the ${KEYSTORE_NAME}`);
  res.json({ ok: true, id, name });
});

app.post('/api/workspaces/:id/activate', async (req, res) => {
  const meta = await readWorkspacesMeta();
  const ws = meta.find((w) => w.id === req.params.id);
  if (!ws) return res.status(404).json({ ok: false, error: 'unknown workspace id' });
  let apiKey;
  try {
    apiKey = await keychainGet(ws.id);
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Keychain read failed: ${err.message}` });
  }
  try {
    const r = await switchActiveKey(apiKey);
    res.json({ ok: true, id: ws.id, name: ws.name, ...r });
  } catch (err) {
    res.status(401).json({ ok: false, error: err.message });
  }
});

app.delete('/api/workspaces/:id', async (req, res) => {
  const meta = await readWorkspacesMeta();
  const ws = meta.find((w) => w.id === req.params.id);
  if (!ws) return res.status(404).json({ ok: false, error: 'unknown workspace id' });
  try {
    await keychainDelete(ws.id);
  } catch { /* item already gone — still drop the metadata */ }
  await writeWorkspacesMeta(meta.filter((w) => w.id !== ws.id));
  console.log(`[workspace] removed "${ws.name}" (${ws.id}) from the ${KEYSTORE_NAME}`);
  res.json({ ok: true });
});

const ENV_PATH = path.join(__dirname, '.env');

// Switch back to the API key stored in .env (the "(.env key)" workspace in
// the UI) — used after a Keychain workspace was active.
app.post('/api/apikey/reset', async (req, res) => {
  let envKey = null;
  try {
    const content = await fs.readFile(ENV_PATH, 'utf8');
    const m = content.match(/^SYNERISE_API_KEY=(.+)$/m);
    envKey = m ? m[1].trim() : null;
  } catch (err) {
    return res.status(500).json({ ok: false, error: `.env read failed: ${err.message}` });
  }
  if (!envKey) return res.status(400).json({ ok: false, error: 'No SYNERISE_API_KEY in .env' });

  let issued;
  try {
    issued = await requestToken(envKey);
  } catch (err) {
    return res.status(401).json({ ok: false, error: err.message });
  }
  process.env.SYNERISE_API_KEY = envKey;
  tokenCache = {
    token: issued.token,
    expiresAt: Date.now() + (issued.expiresInSec - 30) * 1000,
    raw: issued.raw,
  };
  promotionTagDirectoryHash = null;
  delete process.env.PROMOTION_TAG_DIRECTORY_HASH;
  res.json({ ok: true, expiresAt: new Date(tokenCache.expiresAt).toISOString() });
});

// ---- Token -----------------------------------------------------------------

app.get('/api/token', async (req, res) => {
  try {
    const force = req.query.refresh === '1';
    const t = await getToken({ force });
    res.json({
      token: t.token,
      expiresAt: new Date(t.expiresAt).toISOString(),
      cached: !force,
      apiBase: SYNERISE_API_BASE,
      raw: t.raw,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Promotions ------------------------------------------------------------

app.post('/api/promotion', async (req, res) => {
  try {
    const overrides = req.body || {};
    const count = Math.max(1, Math.min(Number(overrides.count) || 1, 100));
    const tagHashes = (typeof overrides.tagHash === 'string' ? overrides.tagHash : '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const headerNameTpl = overrides.headerName || 'test-{rand5}-{date}-{serial}';
    const headerDescriptionTpl = overrides.headerDescription || 'desc-{rand5}-{date}-{serial}';
    // The `code` is the user-settable unique id ("custom_id") used later to
    // match/overwrite the promotion via batch import. Defaults to the header
    // name via the {headerName} placeholder, so "custom_id = what's in the name".
    const codeTpl = (typeof overrides.code === 'string' && overrides.code.trim())
      ? overrides.code.trim()
      : '{headerName}';
    const now = new Date();
    const startAt = overrides.startAt?.trim() ? overrides.startAt.trim() : null;
    const expireAt = overrides.expireAt?.trim() ? overrides.expireAt.trim() : null;

    let customFields = overrides.customFields;
    if (typeof customFields === 'string') {
      const trimmed = customFields.trim();
      if (!trimmed) {
        customFields = null;
      } else {
        try {
          customFields = JSON.parse(trimmed);
        } catch (err) {
          return res.status(400).json({ ok: false, error: `customFields is not valid JSON: ${err.message}` });
        }
      }
    }
    if (customFields != null && !isPlainObject(customFields)) {
      return res.status(400).json({ ok: false, error: 'customFields must be a JSON object' });
    }

    const buildPayload = () => {
      const ctx = {
        rand5: rand5(),
        date: isoDateCompact(now),
        iso: now.toISOString(),
        serial: nextSerial(),
      };
      const headerName = renderTemplate(headerNameTpl, ctx);
      const code = renderTemplate(codeTpl.replaceAll('{headerName}', headerName), ctx);
      const payload = {
        visibilityStatus: 'PUBLISH',
        type: overrides.type || 'HANDBILL',
        code,
        name: headerName,
        headerName,
        headerDescription: renderTemplate(headerDescriptionTpl, ctx),
        startAt,
        expireAt,
        params: {},
        catalog: overrides.catalog || '221',
        storeItemType: overrides.storeItemType || 'ALL',
        targetType: overrides.targetType || 'ALL',
        price: overrides.price ?? 0,
        priority: overrides.priority ?? 250,
        importHash: overrides.importHash || randomUUID(),
      };
      // Only send targetSegment when actual segment ids were provided — the
      // old ["string"] placeholder was ignored while targetType=ALL, but became
      // a live (bogus) target the moment something flipped the type to SEGMENT.
      const targetSegment = toSegmentArray(overrides.targetSegment);
      if (targetSegment.length) payload.targetSegment = targetSegment;
      // Same deal for the store scoping fields: the docs-example "string"
      // placeholders used to be stored verbatim on the promotion.
      if (typeof overrides.storeCatalog === 'string' && overrides.storeCatalog.trim()) {
        payload.storeCatalog = overrides.storeCatalog.trim();
      }
      const storeIds = toSegmentArray(overrides.storeIds);
      if (storeIds.length) payload.storeIds = storeIds;
      const redeemLimitPerClient = Number(overrides.redeemLimitPerClient);
      if (Number.isInteger(redeemLimitPerClient) && redeemLimitPerClient > 0) {
        payload.redeemLimitPerClient = redeemLimitPerClient;
      }
      if (tagHashes.length) payload.tags = tagHashes.map((hash) => ({ hash }));
      if (customFields) deepMerge(payload, customFields);
      return payload;
    };

    const results = [];
    for (let i = 0; i < count; i++) {
      const payload = buildPayload();
      try {
        const apiRes = await authedFetch(`${SYNERISE_API_BASE}/v4/promotions/promotion`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        results.push({ ok: apiRes.ok, status: apiRes.status, request: payload, response: await readBody(apiRes) });
      } catch (err) {
        results.push({ ok: false, status: 0, request: payload, error: err.message });
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    res.json({
      ok: okCount === count,
      count,
      okCount,
      failCount: count - okCount,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Overwrite promotions in bulk via BatchImportPromotions. Matching is by
// `code` — sending a promotion whose code already exists overwrites it.
//
// Two input modes:
//   1. { promotions: [ {...}, ... ] }  → sent verbatim (power user / curl).
//   2. { codes, targetSegment, targetType, overrides } → server builds one
//      full payload per code, applying the segment under test.
app.post('/api/promotions/batch-import', async (req, res) => {
  try {
    const body = req.body || {};
    let items;

    if (Array.isArray(body.promotions) && body.promotions.length) {
      items = body.promotions;
    } else {
      const codes = Array.isArray(body.codes)
        ? body.codes.map((c) => String(c).trim()).filter(Boolean)
        : toSegmentArray(body.codes);
      if (!codes.length) {
        return res.status(400).json({ ok: false, error: 'provide either `promotions` (array) or `codes` (array/CSV)' });
      }
      const targetSegment = toSegmentArray(body.targetSegment);
      if (targetSegment.length === 0) {
        return res.status(400).json({ ok: false, error: 'targetSegment is required' });
      }
      items = codes.map((code) => buildImportPayload({ code, targetSegment }));
    }

    // BatchImportPromotions expects an OBJECT wrapping the array under `data`,
    // NOT a bare array (a raw array → 400 "Object type invalid" at root).
    const url = `${SYNERISE_API_BASE}/v4/promotions/v2/promotion/batch`;
    const apiRes = await authedFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: items }),
    });
    const responseBody = await readBody(apiRes);
    console.log(`[promotions-batch-import] ${apiRes.status} ${items.length} promotion(s)`);
    res.status(apiRes.ok ? 200 : apiRes.status).json({
      ok: apiRes.ok,
      status: apiRes.status,
      url,
      count: items.length,
      request: items,
      response: responseBody,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/promotion/activate-for-client', async (req, res) => {
  try {
    const { identifierType, identifierValue, key, value, pointsToUse } = req.body || {};
    if (!identifierType || !identifierValue) {
      return res.status(400).json({ ok: false, error: 'identifierType and identifierValue are required' });
    }
    if (key !== 'uuid' && key !== 'code') {
      return res.status(400).json({ ok: false, error: 'key must be "uuid" or "code"' });
    }
    if (typeof value !== 'string' || !value.trim()) {
      return res.status(400).json({ ok: false, error: 'value is required' });
    }
    const payload = { key, value: value.trim() };
    if (pointsToUse !== undefined && pointsToUse !== null && pointsToUse !== '') {
      const n = Number(pointsToUse);
      if (!Number.isFinite(n)) {
        return res.status(400).json({ ok: false, error: 'pointsToUse must be a number' });
      }
      payload.pointsToUse = n;
    }
    const url = `${SYNERISE_API_BASE}/v4/promotions/promotion/activate-for-client/${encodeURIComponent(identifierType)}/${encodeURIComponent(identifierValue)}`;
    const apiRes = await authedFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await readBody(apiRes);
    console.log(`[promotion-activate-for-client] ${apiRes.status} ${identifierType}/${identifierValue} ${key}=${payload.value}`);
    res.status(apiRes.ok ? 200 : apiRes.status).json({
      ok: apiRes.ok,
      status: apiRes.status,
      url,
      request: payload,
      response: body,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/promotion/redeem', async (req, res) => {
  try {
    const { clientKey, clientKeyValue, code, quantity } = req.body || {};
    if (!clientKey || !clientKeyValue) {
      return res.status(400).json({ ok: false, error: 'clientKey and clientKeyValue are required' });
    }
    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ ok: false, error: 'code is required' });
    }
    const payload = { code: code.trim(), clientKey, clientKeyValue };
    if (quantity !== undefined && quantity !== null && quantity !== '') {
      const n = Number(quantity);
      if (!Number.isFinite(n)) {
        return res.status(400).json({ ok: false, error: 'quantity must be a number' });
      }
      payload.quantity = n;
    }
    const apiRes = await authedFetch(`${SYNERISE_API_BASE}/v4/promotions/promotion/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await readBody(apiRes);
    console.log(`[promotion-redeem] ${apiRes.status} ${clientKey}/${clientKeyValue} code=${payload.code}`);
    res.status(apiRes.ok ? 200 : apiRes.status).json({
      ok: apiRes.ok,
      status: apiRes.status,
      request: payload,
      response: body,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch the full body of a single promotion (GetPromotionDetailsAsBusinessProfile)
// by uuid or code — the workspace view, no profile context.
app.post('/api/promotion-details', async (req, res) => {
  const { searchKey, searchValue } = req.body || {};
  if (searchKey !== 'uuid' && searchKey !== 'code') {
    return res.status(400).json({ ok: false, error: 'searchKey must be "uuid" or "code"' });
  }
  if (typeof searchValue !== 'string' || !searchValue.trim()) {
    return res.status(400).json({ ok: false, error: 'searchValue is required' });
  }
  const url = `${SYNERISE_API_BASE}/v4/promotions/promotion/${encodeURIComponent(searchKey)}/${encodeURIComponent(searchValue.trim())}`;
  return proxyGet(res, { label: 'promotion-details', url });
});

// Create a promotion from a verbatim JSON payload (CreateAPromotion) — the
// editor-driven counterpart of POST /api/promotion (which builds the payload
// from form fields and renders {rand5}-style placeholders).
app.post('/api/promotion-raw', async (req, res) => {
  try {
    const { payload } = req.body || {};
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ ok: false, error: '`payload` must be a JSON object' });
    }
    const url = `${SYNERISE_API_BASE}/v4/promotions/promotion`;
    const apiRes = await authedFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await readBody(apiRes);
    console.log(`[promotion-raw-create] ${apiRes.status} ${url}`);
    console.dir(body, { depth: null });
    res.status(apiRes.ok ? 200 : apiRes.status).json({
      ok: apiRes.ok,
      status: apiRes.status,
      request: payload,
      response: body,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Partial update of a promotion (UpdateAPromotion) — only the fields present
// in the payload change, but an explicit null overwrites the stored value.
app.put('/api/promotion-raw', async (req, res) => {
  try {
    const { searchKey, searchValue, payload } = req.body || {};
    if (searchKey !== 'uuid' && searchKey !== 'code') {
      return res.status(400).json({ ok: false, error: 'searchKey must be "uuid" or "code"' });
    }
    if (typeof searchValue !== 'string' || !searchValue.trim()) {
      return res.status(400).json({ ok: false, error: 'searchValue is required' });
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ ok: false, error: '`payload` must be a JSON object' });
    }
    const url = `${SYNERISE_API_BASE}/v4/promotions/promotion/${encodeURIComponent(searchKey)}/${encodeURIComponent(searchValue.trim())}`;
    const apiRes = await authedFetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await readBody(apiRes);
    console.log(`[promotion-raw-update] ${apiRes.status} ${url}`);
    console.dir(body, { depth: null });
    res.status(apiRes.ok ? 200 : apiRes.status).json({
      ok: apiRes.ok,
      status: apiRes.status,
      request: payload,
      response: body,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/promotions', async (req, res) => {
  try {
    const prefix = (req.query.prefix || '').toString();
    const apiRes = await authedFetch(`${SYNERISE_API_BASE}/v4/promotions/promotion/list?limit=1000`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const body = await readBody(apiRes);
    if (!apiRes.ok) return res.status(apiRes.status).json({ ok: false, response: body });
    const all = body.data || [];
    const matched = prefix
      ? all.filter((p) => (p.headerName || p.name || '').startsWith(prefix))
      : all;
    const items = matched.map((p) => ({
      code: p.code,
      uuid: p.uuid,
      type: p.type,
      status: p.status,
      name: p.name,
      headerName: p.headerName,
      createdAt: p.createdAt,
    }));
    res.json({ ok: true, total: all.length, matched: matched.length, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/promotions/delete', async (req, res) => {
  try {
    const { prefix, codes } = req.body || {};
    let targetCodes = Array.isArray(codes) ? codes.filter(Boolean) : null;

    if (!targetCodes) {
      const safePrefix = typeof prefix === 'string' ? prefix : '';
      const listRes = await authedFetch(`${SYNERISE_API_BASE}/v4/promotions/promotion/list?limit=1000`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      const listBody = await listRes.json();
      const all = listBody.data || [];
      targetCodes = (safePrefix
        ? all.filter((p) => (p.headerName || p.name || '').startsWith(safePrefix))
        : all
      ).map((p) => p.code);
    }

    const results = [];
    for (const code of targetCodes) {
      try {
        const r = await authedFetch(`${SYNERISE_API_BASE}/v4/promotions/promotion`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: code }),
        });
        results.push({ code, ok: r.ok, status: r.status, response: await readBody(r) });
      } catch (err) {
        results.push({ code, ok: false, status: 0, error: err.message });
      }
    }
    const okCount = results.filter((r) => r.ok).length;
    res.json({
      ok: okCount === results.length,
      total: results.length,
      okCount,
      failCount: results.length - okCount,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function resolvePromotionTagDirectoryHash({ force = false } = {}) {
  if (!force && promotionTagDirectoryHash) return promotionTagDirectoryHash;
  const apiRes = await authedFetch(`${SYNERISE_API_BASE}/tags-collector/directories`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  const body = await readBody(apiRes);
  if (!apiRes.ok) {
    throw new Error(`Directories request failed: ${apiRes.status} — ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  const list = Array.isArray(body) ? body : (body?.data || body?.directories || []);
  const match = list.find((d) => {
    const n = (d?.name || '').toLowerCase();
    const tn = (d?.type?.name || '').toLowerCase();
    return n === PROMOTION_TAG_DIRECTORY_NAME || n === PROMOTION_TAG_DIRECTORY_NAME + 's' || tn === PROMOTION_TAG_DIRECTORY_NAME;
  });
  if (!match) {
    throw new Error(`Directory "${PROMOTION_TAG_DIRECTORY_NAME}" not found among ${list.length} directories`);
  }
  const hash = match.hash || match.id || match.uuid;
  if (!hash) throw new Error(`Directory "${PROMOTION_TAG_DIRECTORY_NAME}" has no hash field`);
  promotionTagDirectoryHash = hash;
  process.env.PROMOTION_TAG_DIRECTORY_HASH = hash;
  console.log(`[tags] resolved promotion directory hash: ${hash}`);
  return hash;
}

app.get('/api/promotion-tags', async (req, res) => {
  try {
    const force = req.query.refresh === '1';
    const hash = await resolvePromotionTagDirectoryHash({ force });
    const apiRes = await authedFetch(`${SYNERISE_API_BASE}/tags-collector/directories/${encodeURIComponent(hash)}/tags`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const body = await readBody(apiRes);
    if (!apiRes.ok) return res.status(apiRes.status).json({ ok: false, directoryHash: hash, response: body });
    const all = Array.isArray(body) ? body : (Array.isArray(body?.data) ? body.data : (Array.isArray(body?.tags) ? body.tags : []));
    const items = all.map((t) => ({
      hash: t.hash || t.id || t.uuid,
      name: t.value || t.name || t.label || '(no name)',
    })).filter((t) => t.hash);
    res.json({ ok: true, directoryHash: hash, total: items.length, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/handbills', async (req, res) => {
  try {
    const apiRes = await authedFetch(`${SYNERISE_API_BASE}/v4/promotions/handbill?limit=1000`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const body = await readBody(apiRes);
    if (!apiRes.ok) return res.status(apiRes.status).json({ ok: false, response: body });
    const all = Array.isArray(body?.data) ? body.data : (Array.isArray(body) ? body : []);
    const items = all.map((h) => ({
      uuid: h.uuid || h.id,
      name: h.name || h.headerName || '(no name)',
    })).filter((h) => h.uuid);
    res.json({ ok: true, total: items.length, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/promotion-settings', async (req, res) => {
  const url = `${SYNERISE_API_BASE}/v4/promotions/settings`;
  return proxyGet(res, { label: 'promotion-settings', url });
});

app.put('/api/promotion-settings', async (req, res) => {
  try {
    const payload = req.body;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ ok: false, error: 'body must be a JSON object' });
    }
    const url = `${SYNERISE_API_BASE}/v4/promotions/settings`;
    const apiRes = await authedFetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await readBody(apiRes);
    console.log(`[promotion-settings-update] ${apiRes.status} ${url}`);
    console.dir(body, { depth: null });
    res.status(apiRes.ok ? 200 : apiRes.status).json({
      ok: apiRes.ok,
      status: apiRes.status,
      request: payload,
      response: body,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Handbills (and the promotions shown on them) --------------------------

app.post('/api/promotions-for-client', async (req, res) => {
  const { identifierType, identifierValue, sort, filters } = req.body || {};
  if (!identifierType || !identifierValue) {
    return res.status(400).json({ error: 'identifierType and identifierValue are required' });
  }
  // Filters arrive as [{ name, value }] and are appended verbatim as query
  // params (status/type take comma-separated values in one param), followed by
  // repeated `sort=attribute,direction` params (GetAllClientPromotionsV2);
  // ascending is the API default when no direction is given.
  const params = new URLSearchParams();
  const filterList = Array.isArray(filters) ? filters : [];
  for (const f of filterList) {
    const name = typeof f?.name === 'string' ? f.name.trim() : '';
    const value = f?.value === undefined || f?.value === null ? '' : String(f.value).trim();
    if (name && value) params.append(name, value);
  }
  const sortList = Array.isArray(sort) ? sort : (typeof sort === 'string' && sort ? [sort] : []);
  for (const s of sortList) {
    if (typeof s === 'string' && s.trim()) params.append('sort', s.trim());
  }
  const qs = params.toString();
  const url = `${SYNERISE_API_BASE}/v4/promotions/v2/promotion/get-for-client/${encodeURIComponent(identifierType)}/${encodeURIComponent(identifierValue)}${qs ? `?${qs}` : ''}`;
  return proxyGet(res, { label: 'promotions-for-client', url });
});

app.post('/api/handbill', async (req, res) => {
  const { identifierType, identifierValue, handbillUuid } = req.body || {};
  if (!identifierType || !identifierValue || !handbillUuid) {
    return res.status(400).json({ error: 'identifierType, identifierValue and handbillUuid are required' });
  }
  const url = `${SYNERISE_API_BASE}/v4/promotions/v2/promotion/get-for-client/${encodeURIComponent(identifierType)}/${encodeURIComponent(identifierValue)}/handbill/${encodeURIComponent(handbillUuid)}`;
  return proxyGet(res, { label: 'handbill', url });
});

app.post('/api/handbill-config', async (req, res) => {
  const { handbillUuid } = req.body || {};
  if (!handbillUuid) {
    return res.status(400).json({ error: 'handbillUuid is required' });
  }
  const url = `${SYNERISE_API_BASE}/v4/promotions/handbill/${encodeURIComponent(handbillUuid)}`;
  return proxyGet(res, { label: 'handbill-config', url });
});

// Partial update of a handbill campaign (updateHandbill_PATCH). The payload is
// sent as-is — PATCH the fetched config (edited) to avoid nulling fields.
app.patch('/api/handbill-config', async (req, res) => {
  try {
    const { handbillUuid, payload } = req.body || {};
    if (!handbillUuid) {
      return res.status(400).json({ ok: false, error: 'handbillUuid is required' });
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ ok: false, error: '`payload` must be a JSON object' });
    }
    const url = `${SYNERISE_API_BASE}/v4/promotions/handbill/${encodeURIComponent(handbillUuid)}`;
    const apiRes = await authedFetch(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await readBody(apiRes);
    console.log(`[handbill-config-update] ${apiRes.status} ${url}`);
    console.dir(body, { depth: null });
    res.status(apiRes.ok ? 200 : apiRes.status).json({
      ok: apiRes.ok,
      status: apiRes.status,
      request: payload,
      response: body,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/handbill-batch', async (req, res) => {
  const { identifierType, identifierValue, handbillUuid, handbillUuids } = req.body || {};
  const uuidList = Array.isArray(handbillUuids)
    ? handbillUuids.filter(Boolean)
    : (typeof handbillUuid === 'string' && handbillUuid ? [handbillUuid] : []);
  if (!identifierType || !identifierValue || uuidList.length === 0) {
    return res.status(400).json({ error: 'identifierType, identifierValue and at least one handbillUuid are required' });
  }
  const params = new URLSearchParams();
  for (const u of uuidList) params.append('handbillUuid', u);
  const url = `${SYNERISE_API_BASE}/v4/promotions/promotion/get-for-client/${encodeURIComponent(identifierType)}/${encodeURIComponent(identifierValue)}/with-handbills?${params.toString()}`;
  return proxyGet(res, { label: 'handbill-batch', url });
});

// Map the identifier types shared across the UI (promotions/handbills forms)
// onto the values the vouchers and Brickworks APIs expect.
const PROFILE_IDENTIFIER_TYPES = {
  clientId: 'id',
  uuid: 'uuid',
  customId: 'custom_identify',
  email: 'email',
};

// ---- POS: process basket / checkout ----------------------------------------

// The POS sale endpoints take the profile identifier in the path; the top-bar
// identifier types map 1:1 except customId, which this API calls externalId.
const POS_IDENTIFIER_TYPES = {
  clientId: 'clientId',
  uuid: 'uuid',
  customId: 'externalId',
  email: 'email',
};

async function processPosTransaction(req, res, { label, path }) {
  const { identifierType, identifierValue, body } = req.body || {};
  const posType = POS_IDENTIFIER_TYPES[identifierType];
  if (!posType || typeof identifierValue !== 'string' || !identifierValue.trim()) {
    return res.status(400).json({ ok: false, error: 'identifierType (clientId|uuid|customId|email) and identifierValue are required' });
  }
  if (!isPlainObject(body)) {
    return res.status(400).json({ ok: false, error: 'body must be a JSON object (the POS transaction payload)' });
  }
  try {
    const now = new Date();
    const ctx = { rand5: rand5(), date: isoDateCompact(now), iso: now.toISOString(), serial: nextSerial() };
    const payload = renderTemplatesDeep(body, ctx);
    const url = `${SYNERISE_API_BASE}${path}/${encodeURIComponent(posType)}/${encodeURIComponent(identifierValue.trim())}`;
    const apiRes = await authedFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const responseBody = await readBody(apiRes);
    console.log(`[${label}] ${apiRes.status} ${posType}/${identifierValue}`);
    res.status(apiRes.ok ? 200 : apiRes.status).json({
      ok: apiRes.ok,
      status: apiRes.status,
      url,
      request: payload,
      response: responseBody,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// Evaluate a basket against the profile's promotions (processSale — "Process basket").
app.post('/api/process-sale', (req, res) => processPosTransaction(req, res, {
  label: 'process-sale',
  path: '/v4/promotions/v2/sale/process-sale',
}));

// Finalize a POS transaction with a payments report (processCheckout — "Process checkout on POS").
app.post('/api/process-checkout', (req, res) => processPosTransaction(req, res, {
  label: 'process-checkout',
  path: '/v4/promotions/sale/process-checkout',
}));

// ---- Vouchers and voucher pools --------------------------------------------

// The vouchers service requires an Api-Version header on every call.
const VOUCHERS_API_VERSION = '4.4';
const VOUCHER_STATUSES = new Set(['ASSIGNED', 'UNASSIGNED', 'REDEEMED', 'CANCELED']);

// limit / page / includeMeta — shared by the paginated vouchers endpoints.
// limit caps at the API maximum of 1000, page is 1-based.
function voucherPagingParams({ limit, page, includeMeta } = {}) {
  return new URLSearchParams({
    limit: String(Math.max(1, Math.min(Number(limit) || 100, 1000))),
    page: String(Math.max(1, Number(page) || 1)),
    includeMeta: includeMeta === true || includeMeta === 'true' ? 'true' : 'false',
  });
}

// With includeMeta=false (the API default) the pagination data lands in
// X-Pagination-* response headers instead of the body — read them off so the
// totals are available in both modes. Returns null when none are set.
function paginationFromHeaders(apiRes) {
  const num = (name) => {
    const raw = apiRes.headers.get(name);
    return raw === null || raw === '' ? null : Number(raw);
  };
  const pagination = {
    totalCount: num('x-pagination-total-count'),
    totalPages: num('x-pagination-total-pages'),
    page: num('x-pagination-page'),
    limit: num('x-pagination-limit'),
  };
  return Object.values(pagination).some((v) => v !== null) ? pagination : null;
}

// ---- Voucher pools ---------------------------------------------------------

// List the workspace's voucher pools (ListPools). Serves both the ↻ pool
// pickers — which read the trimmed `items` — and the Voucher pools card, which
// renders the untouched `response` body.
app.get('/api/voucher-pools', async (req, res) => {
  try {
    const url = `${SYNERISE_API_BASE}/v4/vouchers/pool/list?${voucherPagingParams(req.query)}`;
    const apiRes = await authedFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'Api-Version': VOUCHERS_API_VERSION },
    });
    const body = await readBody(apiRes);
    if (!apiRes.ok) return res.status(apiRes.status).json({ ok: false, status: apiRes.status, url, response: body });
    const all = Array.isArray(body?.data) ? body.data : (Array.isArray(body) ? body : []);
    const items = all.map((p) => ({
      uuid: p.uuid,
      name: p.name || '(no name)',
    })).filter((p) => p.uuid);
    const pagination = paginationFromHeaders(apiRes);
    console.log(`[voucher-pools] ${apiRes.status} ${items.length} pool(s) ${url}`);
    res.json({
      ok: true,
      status: apiRes.status,
      url,
      total: items.length,
      items,
      ...(pagination ? { pagination } : {}),
      response: body,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List the vouchers stored in a single pool (ListVouchersFromPool) — paginated
// with `limit` (max 1000) and 1-based `page`.
app.post('/api/vouchers-in-pool', async (req, res) => {
  try {
    const { poolUuid } = req.body || {};
    if (typeof poolUuid !== 'string' || !poolUuid.trim()) {
      return res.status(400).json({ ok: false, error: 'poolUuid is required' });
    }
    const params = voucherPagingParams(req.body);
    const url = `${SYNERISE_API_BASE}/v4/vouchers/item/list/${encodeURIComponent(poolUuid.trim())}?${params}`;
    const apiRes = await authedFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'Api-Version': VOUCHERS_API_VERSION },
    });
    const body = await readBody(apiRes);
    const pagination = paginationFromHeaders(apiRes);
    console.log(`[vouchers-in-pool] ${apiRes.status} ${url}`);
    console.dir(body, { depth: null });
    res.status(apiRes.ok ? 200 : apiRes.status).json({
      ok: apiRes.ok,
      status: apiRes.status,
      url,
      ...(pagination ? { pagination } : {}),
      response: body,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Vouchers --------------------------------------------------------------

// Look up a single voucher (ViewVoucherDetailsBySearchKey) by code or uuid —
// the quickest way to check a voucher's current status.
app.post('/api/voucher-details', async (req, res) => {
  const { searchKey, searchValue } = req.body || {};
  if (searchKey !== 'code' && searchKey !== 'uuid') {
    return res.status(400).json({ ok: false, error: 'searchKey must be "code" or "uuid"' });
  }
  if (typeof searchValue !== 'string' || !searchValue.trim()) {
    return res.status(400).json({ ok: false, error: 'searchValue is required' });
  }
  const url = `${SYNERISE_API_BASE}/v4/vouchers/item/${encodeURIComponent(searchKey)}/${encodeURIComponent(searchValue.trim())}`;
  return proxyGet(res, { label: 'voucher-details', url, headers: { 'Api-Version': VOUCHERS_API_VERSION } });
});

// List all vouchers assigned to a profile (GetVouchersAssignedToAClientByIdentifier).
// The profile can be pointed at by id, uuid, email or custom_identify — the
// UI-facing identifierType values are mapped like in the Brickworks preview.
app.post('/api/vouchers-for-client', async (req, res) => {
  const { identifierType, identifierValue } = req.body || {};
  const clientIdentifierName = PROFILE_IDENTIFIER_TYPES[identifierType];
  if (!clientIdentifierName || typeof identifierValue !== 'string' || !identifierValue.trim()) {
    return res.status(400).json({ ok: false, error: 'identifierType (clientId|uuid|customId|email) and identifierValue are required' });
  }
  const params = new URLSearchParams({
    clientIdentifierName,
    clientIdentifierValue: identifierValue.trim(),
  });
  const url = `${SYNERISE_API_BASE}/v4/vouchers/item/get-assigned-for-client/by-identifier?${params}`;
  return proxyGet(res, { label: 'vouchers-for-client', url, headers: { 'Api-Version': VOUCHERS_API_VERSION } });
});

// Redeem a voucher by code (RedeemAVoucher) — flips its status to REDEEMED.
app.post('/api/voucher/redeem', async (req, res) => {
  try {
    const { code } = req.body || {};
    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ ok: false, error: 'code is required' });
    }
    const payload = { code: code.trim() };
    const apiRes = await authedFetch(`${SYNERISE_API_BASE}/v4/vouchers/item/redeem`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Accept: 'application/json',
        'Api-Version': VOUCHERS_API_VERSION,
      },
      body: JSON.stringify(payload),
    });
    const body = await readBody(apiRes);
    console.log(`[voucher-redeem] ${apiRes.status} code=${payload.code}`);
    res.status(apiRes.ok ? 200 : apiRes.status).json({
      ok: apiRes.ok,
      status: apiRes.status,
      request: payload,
      response: body,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Batch-redeem vouchers for profiles (BatchRedeemVouchersForProfile). Lives
// in the promotions service (no Api-Version header) and takes a BARE ARRAY
// of up to 100 { profileKey, profileValue, voucherKey: "code", voucherValue }
// items. NOTE: the docs describe an `options` object (quantity/sourceId/
// orderId) but the live API rejects it ('"[0].options" is not allowed'), so
// it is not sent. Partial failures come back as 207 with per-item errors.
const BATCH_REDEEM_PROFILE_KEYS = new Set(['externalId', 'clientId', 'email', 'phone', 'uuid']);

app.post('/api/voucher/batch-redeem-for-profile', async (req, res) => {
  try {
    const o = req.body || {};
    const profileKey = typeof o.profileKey === 'string' ? o.profileKey.trim() : '';
    const profileValue = typeof o.profileValue === 'string' ? o.profileValue.trim() : '';
    if (!BATCH_REDEEM_PROFILE_KEYS.has(profileKey)) {
      return res.status(400).json({ ok: false, error: `profileKey must be one of: ${[...BATCH_REDEEM_PROFILE_KEYS].join(', ')}` });
    }
    if (!profileValue) {
      return res.status(400).json({ ok: false, error: 'profileValue is required' });
    }
    const codes = Array.isArray(o.codes)
      ? o.codes.map((c) => String(c).trim()).filter(Boolean)
      : (typeof o.codes === 'string' ? o.codes.split(',').map((s) => s.trim()).filter(Boolean) : []);
    if (codes.length === 0 || codes.length > 100) {
      return res.status(400).json({ ok: false, error: 'codes must contain 1–100 voucher codes (array or CSV)' });
    }
    const items = codes.map((code) => ({ profileKey, profileValue, voucherKey: 'code', voucherValue: code }));

    const apiRes = await authedFetch(`${SYNERISE_API_BASE}/v4/promotions/voucher/batch-redeem-for-profile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(items),
    });
    const body = await readBody(apiRes);
    console.log(`[voucher-batch-redeem] ${apiRes.status} ${items.length} item(s) ${profileKey}=${profileValue}`);
    res.status(apiRes.ok ? 200 : apiRes.status).json({
      ok: apiRes.ok,
      status: apiRes.status,
      count: items.length,
      request: items,
      response: body,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create `count` vouchers (CreateAVoucher), one POST each. Only poolUuid is
// required; clientId / clientUuid optionally tie the voucher to a profile
// (pair them with status ASSIGNED for an actual assignment). The code field
// supports the same placeholders as promotion names and re-rolls per request.
app.post('/api/voucher', async (req, res) => {
  try {
    const o = req.body || {};
    const poolUuid = typeof o.poolUuid === 'string' ? o.poolUuid.trim() : '';
    if (!poolUuid) {
      return res.status(400).json({ ok: false, error: 'poolUuid is required' });
    }
    const count = Math.max(1, Math.min(Number(o.count) || 1, 100));
    const codeTpl = typeof o.code === 'string' ? o.code.trim() : '';
    const clientUuid = typeof o.clientUuid === 'string' ? o.clientUuid.trim() : '';
    let clientId = null;
    if (o.clientId !== undefined && o.clientId !== null && o.clientId !== '') {
      clientId = Number(o.clientId);
      if (!Number.isInteger(clientId)) {
        return res.status(400).json({ ok: false, error: 'clientId must be an integer (profile ID)' });
      }
    }
    const status = typeof o.status === 'string' && o.status.trim() ? o.status.trim().toUpperCase() : null;
    if (status && !VOUCHER_STATUSES.has(status)) {
      return res.status(400).json({ ok: false, error: `status must be one of: ${[...VOUCHER_STATUSES].join(', ')}` });
    }
    const expireIn = typeof o.expireIn === 'string' && o.expireIn.trim() ? o.expireIn.trim() : null;
    const now = new Date();

    const buildPayload = () => {
      const ctx = {
        rand5: rand5(),
        date: isoDateCompact(now),
        iso: now.toISOString(),
        serial: nextSerial(),
      };
      const payload = { poolUuid };
      if (codeTpl) payload.code = renderTemplate(codeTpl, ctx);
      if (clientUuid) payload.clientUuid = clientUuid;
      if (clientId !== null) payload.clientId = clientId;
      if (expireIn) payload.expireIn = expireIn;
      if (status) payload.status = status;
      return payload;
    };

    const results = [];
    for (let i = 0; i < count; i++) {
      const payload = buildPayload();
      try {
        const apiRes = await authedFetch(`${SYNERISE_API_BASE}/v4/vouchers/item`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Accept: 'application/json',
            'Api-Version': VOUCHERS_API_VERSION,
          },
          body: JSON.stringify(payload),
        });
        results.push({ ok: apiRes.ok, status: apiRes.status, request: payload, response: await readBody(apiRes) });
      } catch (err) {
        results.push({ ok: false, status: 0, request: payload, error: err.message });
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    console.log(`[voucher-create] ${okCount}/${count} OK pool=${poolUuid}${clientId !== null ? ` clientId=${clientId}` : ''}${clientUuid ? ` clientUuid=${clientUuid}` : ''}`);
    res.json({
      ok: okCount === count,
      count,
      okCount,
      failCount: count - okCount,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Events ----------------------------------------------------------------

// The events service (data management API) requires Api-Version 4.4, like
// vouchers. Its `client` object keys differ from the Brickworks/vouchers
// identifier mapping: custom identifiers are `customId` (NOT custom_identify)
// and `id` must be an integer.
const EVENT_CLIENT_KEYS = {
  clientId: 'id',
  uuid: 'uuid',
  customId: 'customId',
  email: 'email',
};

// Send `count` custom events to a profile (CustomEvent), one POST each.
// `action` must be noun.verb; `label` is required by the API (but not stored);
// optional `params` (free-form JSON object), `time` (ISO, no future) and
// `eventSalt` (dedup/overwrite key). Placeholders re-roll per request in
// label and eventSalt. The API replies 202 Accepted with an empty body.
app.post('/api/event', async (req, res) => {
  try {
    const o = req.body || {};
    const clientKey = EVENT_CLIENT_KEYS[o.identifierType];
    const identifierValue = typeof o.identifierValue === 'string' ? o.identifierValue.trim() : '';
    if (!clientKey || !identifierValue) {
      return res.status(400).json({ ok: false, error: 'identifierType (clientId|uuid|customId|email) and identifierValue are required' });
    }
    let clientValue = identifierValue;
    if (clientKey === 'id') {
      clientValue = Number(identifierValue);
      if (!Number.isInteger(clientValue)) {
        return res.status(400).json({ ok: false, error: 'clientId must be an integer (profile ID) — switch the top bar to uuid/customId/email otherwise' });
      }
    }
    const action = typeof o.action === 'string' ? o.action.trim() : '';
    if (!/^\S+\.\S+$/.test(action)) {
      return res.status(400).json({ ok: false, error: 'action is required in noun.verb format, e.g. "test.event"' });
    }
    const labelTpl = typeof o.label === 'string' ? o.label.trim() : '';
    if (!labelTpl) {
      return res.status(400).json({ ok: false, error: 'label is required (the API rejects events without it)' });
    }
    let params = o.params;
    if (params != null && !isPlainObject(params)) {
      return res.status(400).json({ ok: false, error: 'params must be a JSON object' });
    }
    const time = typeof o.time === 'string' && o.time.trim() ? o.time.trim() : null;
    const saltTpl = typeof o.eventSalt === 'string' && o.eventSalt.trim() ? o.eventSalt.trim() : null;
    const count = Math.max(1, Math.min(Number(o.count) || 1, 100));
    const now = new Date();

    const buildPayload = () => {
      const ctx = {
        rand5: rand5(),
        date: isoDateCompact(now),
        iso: now.toISOString(),
        serial: nextSerial(),
      };
      const payload = {
        action,
        label: renderTemplate(labelTpl, ctx),
        client: { [clientKey]: clientValue },
      };
      if (time) payload.time = time;
      if (saltTpl) payload.eventSalt = renderTemplate(saltTpl, ctx);
      if (params) payload.params = params;
      return payload;
    };

    const results = [];
    for (let i = 0; i < count; i++) {
      const payload = buildPayload();
      try {
        const apiRes = await authedFetch(`${SYNERISE_API_BASE}/v4/events/custom`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Accept: 'application/json',
            'Api-Version': '4.4',
          },
          body: JSON.stringify(payload),
        });
        results.push({ ok: apiRes.ok, status: apiRes.status, request: payload, response: await readBody(apiRes) });
      } catch (err) {
        results.push({ ok: false, status: 0, request: payload, error: err.message });
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    console.log(`[event-create] ${okCount}/${count} OK action=${action} ${clientKey}=${clientValue}`);
    res.json({
      ok: okCount === count,
      count,
      okCount,
      failCount: count - okCount,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send `count` transactions to a profile (CreateATransaction). The `payload`
// is the full request body minus `client`, which is injected from the top-bar
// identifier (same client-key mapping as custom events). Placeholders re-roll
// per request in every string value, so orderId can stay unique across
// repeats. Creating a transaction also emits transaction.charge + one
// product.buy per item. The API replies 202 Accepted with an empty body.
app.post('/api/transaction', async (req, res) => {
  try {
    const o = req.body || {};
    const clientKey = EVENT_CLIENT_KEYS[o.identifierType];
    const identifierValue = typeof o.identifierValue === 'string' ? o.identifierValue.trim() : '';
    if (!clientKey || !identifierValue) {
      return res.status(400).json({ ok: false, error: 'identifierType (clientId|uuid|customId|email) and identifierValue are required' });
    }
    let clientValue = identifierValue;
    if (clientKey === 'id') {
      clientValue = Number(identifierValue);
      if (!Number.isInteger(clientValue)) {
        return res.status(400).json({ ok: false, error: 'clientId must be an integer (profile ID) — switch the top bar to uuid/customId/email otherwise' });
      }
    }
    if (!isPlainObject(o.payload)) {
      return res.status(400).json({ ok: false, error: 'payload must be a JSON object (the transaction body without client)' });
    }
    const tpl = { ...o.payload };
    delete tpl.client; // always taken from the top bar, never from the payload
    if (typeof tpl.orderId !== 'string' || !tpl.orderId.trim()) {
      return res.status(400).json({ ok: false, error: 'payload.orderId is required (string)' });
    }
    if (!Array.isArray(tpl.products) || tpl.products.length === 0) {
      return res.status(400).json({ ok: false, error: 'payload.products must be a non-empty array' });
    }
    const count = Math.max(1, Math.min(Number(o.count) || 1, 100));
    const now = new Date();

    const results = [];
    for (let i = 0; i < count; i++) {
      const ctx = { rand5: rand5(), date: isoDateCompact(now), iso: now.toISOString(), serial: nextSerial() };
      const payload = { ...renderTemplatesDeep(tpl, ctx), client: { [clientKey]: clientValue } };
      try {
        const apiRes = await authedFetch(`${SYNERISE_API_BASE}/v4/transactions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Accept: 'application/json',
            'Api-Version': '4.4',
          },
          body: JSON.stringify(payload),
        });
        results.push({ ok: apiRes.ok, status: apiRes.status, request: payload, response: await readBody(apiRes) });
      } catch (err) {
        results.push({ ok: false, status: 0, request: payload, error: err.message });
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    console.log(`[transaction-create] ${okCount}/${count} OK ${clientKey}=${clientValue}`);
    res.json({
      ok: okCount === count,
      count,
      okCount,
      failCount: count - okCount,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Brickworks ------------------------------------------------------------

app.get('/api/brickworks-schemas', async (req, res) => {
  try {
    const apiRes = await authedFetch(`${SYNERISE_API_BASE}/brickworks/v1/schemas?limit=1000`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const body = await readBody(apiRes);
    if (!apiRes.ok) return res.status(apiRes.status).json({ ok: false, response: body });
    const all = Array.isArray(body?.data) ? body.data
      : (Array.isArray(body?.items) ? body.items : (Array.isArray(body) ? body : []));
    const items = all.map((s) => ({
      id: s.id || s.schemaId || s.appId,
      name: `${s.displayName || s.appId || '(no name)'}${s.schemaType ? ` [${s.schemaType}]` : ''}`,
    })).filter((s) => s.id);
    res.json({ ok: true, total: items.length, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List records of a Brickworks schema (getRecordsFromSchema) — feeds the
// record picker for the generate action.
app.get('/api/brickworks-records', async (req, res) => {
  const schemaId = (req.query.schemaId || '').toString().trim();
  if (!schemaId) {
    return res.status(400).json({ ok: false, error: 'schemaId is required — pick a schema first' });
  }
  try {
    const apiRes = await authedFetch(`${SYNERISE_API_BASE}/brickworks/v1/schemas/${encodeURIComponent(schemaId)}/records?limit=100`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const body = await readBody(apiRes);
    if (!apiRes.ok) return res.status(apiRes.status).json({ ok: false, response: body });
    const all = Array.isArray(body?.data) ? body.data
      : (Array.isArray(body?.items) ? body.items : (Array.isArray(body) ? body : []));
    const items = all.map((r) => ({
      id: r.id || r.recordId || r.slug,
      name: `${r.name || r.slug || '(no name)'}${r.status ? ` [${r.status}]` : ''}`,
    })).filter((r) => r.id);
    res.json({ ok: true, schemaId, total: items.length, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate the Brickworks output for a profile from the latest PUBLISHED
// version of a record (generateObjectForProfile). Unlike the preview, this is
// the real generation path — it emits the `brickwork.generated` event on the
// profile. Optional `context` is exposed to the schema as {{ context.key }}.
app.post('/api/brickworks-generate', async (req, res) => {
  const { identifierType, identifierValue, schemaId, recordId, context } = req.body || {};
  const brickworksType = PROFILE_IDENTIFIER_TYPES[identifierType];
  if (!brickworksType || !identifierValue || !schemaId || !recordId) {
    return res.status(400).json({ error: 'identifierType (clientId|uuid|customId|email), identifierValue, schemaId and recordId are required' });
  }
  try {
    const payload = { identifierValue };
    if (context && typeof context === 'object' && !Array.isArray(context)) payload.context = context;
    const url = `${SYNERISE_API_BASE}/brickworks/v1/schemas/${encodeURIComponent(schemaId)}/records/${encodeURIComponent(recordId)}/generate/by/${brickworksType}`;
    const apiRes = await authedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await readBody(apiRes);
    console.log(`[brickworks-generate] ${apiRes.status} ${brickworksType}/${identifierValue} schema=${schemaId} record=${recordId}`);
    res.status(apiRes.ok ? 200 : apiRes.status).json({ ok: apiRes.ok, status: apiRes.status, url, request: payload, response: body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unwrap responses shaped as { data: {...} }.
function unwrapData(body) {
  return (body && typeof body === 'object' && !Array.isArray(body)
    && body.data && typeof body.data === 'object' && !Array.isArray(body.data))
    ? body.data : body;
}

// Preview the Brickworks output for a profile (previewObject): fetch the full
// schema by id — and, when a record is picked, that record's values — then
// POST both together with the profile identifier to the preview-by-identifier
// endpoint. Optional `context` is exposed to the schema as {{ context.keyName }}.
app.post('/api/brickworks-preview', async (req, res) => {
  const { identifierType, identifierValue, schemaId, recordId, context } = req.body || {};
  const brickworksType = PROFILE_IDENTIFIER_TYPES[identifierType];
  if (!brickworksType || !identifierValue || !schemaId) {
    return res.status(400).json({ error: 'identifierType (clientId|uuid|customId|email), identifierValue and schemaId are required' });
  }
  try {
    const schemaRes = await authedFetch(`${SYNERISE_API_BASE}/brickworks/v1/schemas/${encodeURIComponent(schemaId)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const schemaBody = await readBody(schemaRes);
    if (!schemaRes.ok) {
      console.log(`[brickworks-preview] schema fetch ${schemaRes.status} ${schemaId}`);
      return res.status(schemaRes.status).json({ ok: false, step: 'get-schema', status: schemaRes.status, response: schemaBody });
    }
    const schema = unwrapData(schemaBody);
    const payload = { identifierValue, schema };
    // The preview API requires `values` for non-SINGLETON schemas and rejects
    // it for SINGLETON ones (their single record is implied).
    let note;
    if (recordId && schema?.schemaType === 'SINGLETON') {
      note = 'SINGLETON schema — the API renders its record implicitly, so the picked record was not sent as `values`.';
    } else if (recordId) {
      const recordRes = await authedFetch(`${SYNERISE_API_BASE}/brickworks/v1/schemas/${encodeURIComponent(schemaId)}/records/${encodeURIComponent(recordId)}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      const recordBody = await readBody(recordRes);
      if (!recordRes.ok) {
        console.log(`[brickworks-preview] record fetch ${recordRes.status} ${schemaId}/${recordId}`);
        return res.status(recordRes.status).json({ ok: false, step: 'get-record', status: recordRes.status, response: recordBody });
      }
      const record = unwrapData(recordBody);
      payload.values = (record && typeof record.values === 'object') ? record.values : record;
    }
    if (context && typeof context === 'object' && !Array.isArray(context)) payload.context = context;
    const url = `${SYNERISE_API_BASE}/brickworks/v1/schemas/records/preview/by/${brickworksType}`;
    const apiRes = await authedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await readBody(apiRes);
    console.log(`[brickworks-preview] ${apiRes.status} ${brickworksType}/${identifierValue} schema=${schemaId}${recordId ? ` record=${recordId}` : ''}`);
    res.status(apiRes.ok ? 200 : apiRes.status).json({ ok: apiRes.ok, status: apiRes.status, url, schemaId, ...(recordId ? { recordId } : {}), ...(note ? { note } : {}), response: body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Handbill Tests running on http://localhost:${PORT} (loopback only)`);
});
