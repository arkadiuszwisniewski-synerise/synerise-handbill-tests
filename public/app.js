const $ = (sel) => document.querySelector(sel);

// ---- Result rendering: colored, collapsible JSON trees ---------------------

// Objects/arrays up to this depth start expanded; deeper nodes start collapsed.
const JSON_AUTO_EXPAND_DEPTH = 2;

function jsonKeySpan(key) {
  const frag = document.createDocumentFragment();
  const k = document.createElement('span');
  k.className = 'json-key';
  k.textContent = String(key);
  const p = document.createElement('span');
  p.className = 'json-punct';
  p.textContent = ': ';
  frag.append(k, p);
  return frag;
}

function jsonLeafSpan(value) {
  const span = document.createElement('span');
  if (value === null || value === undefined) { span.className = 'json-null'; span.textContent = String(value); }
  else if (typeof value === 'string') { span.className = 'json-str'; span.textContent = JSON.stringify(value); }
  else if (typeof value === 'boolean') { span.className = 'json-bool'; span.textContent = String(value); }
  else { span.className = 'json-num'; span.textContent = String(value); }
  return span;
}

// One JSON node: primitives render as a line, objects/arrays as a collapsible
// <details> with an item/key count in the summary.
function jsonNode(key, value, depth) {
  const isComposite = value !== null && typeof value === 'object';
  const line = document.createElement('div');
  line.className = 'json-line';
  if (!isComposite) {
    if (key !== undefined) line.append(jsonKeySpan(key));
    line.append(jsonLeafSpan(value));
    return line;
  }
  const isArr = Array.isArray(value);
  const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
  if (entries.length === 0) {
    if (key !== undefined) line.append(jsonKeySpan(key));
    const empty = document.createElement('span');
    empty.className = 'json-punct';
    empty.textContent = isArr ? '[]' : '{}';
    line.append(empty);
    return line;
  }
  const det = document.createElement('details');
  det.className = 'json-node';
  det.open = depth < JSON_AUTO_EXPAND_DEPTH;
  const sum = document.createElement('summary');
  if (key !== undefined) sum.append(jsonKeySpan(key));
  const preview = document.createElement('span');
  preview.className = 'json-preview';
  preview.textContent = isArr
    ? `[…] ${entries.length} item${entries.length === 1 ? '' : 's'}`
    : `{…} ${entries.length} key${entries.length === 1 ? '' : 's'}`;
  sum.append(preview);
  det.append(sum);
  const kids = document.createElement('div');
  kids.className = 'json-children';
  for (const [k, v] of entries) kids.append(jsonNode(k, v, depth + 1));
  det.append(kids);
  return det;
}

// Paint the result stored on the element (set by renderResult). Honors the
// per-result raw toggle: tree view by default, plain JSON text in raw mode.
function paintResult(el) {
  const { text, json } = el.__result || {};
  const raw = el.dataset.view === 'raw';
  el.textContent = '';
  el.classList.toggle('json-view', !raw && json !== undefined);
  if (raw) {
    el.textContent = (text ? `${text}\n\n` : '') + (json !== undefined ? JSON.stringify(json, null, 2) : '');
    return;
  }
  if (text) {
    const t = document.createElement('div');
    t.className = 'result-text';
    t.textContent = text;
    el.append(t);
  }
  if (json !== undefined) el.append(jsonNode(undefined, json, 0));
  if (!text && json === undefined) el.textContent = '—';
}

// Render into an output <pre>. `formatted` is either a plain string or
// { text?, json? }: text renders verbatim, json as a collapsible colored tree.
function renderResult(el, formatted, prelude = '') {
  const rich = formatted !== null && typeof formatted === 'object';
  el.__result = {
    text: (prelude || '') + (rich ? (formatted.text || '') : String(formatted ?? '')),
    json: rich ? formatted.json : undefined,
  };
  paintResult(el);
}

function showJson(el, data) {
  renderResult(el, typeof data === 'string' ? data : { json: data });
}

function clearResult(pre) {
  pre.__result = null;
  delete pre.dataset.view;
  pre.classList.remove('json-view');
  pre.textContent = '—';
}

function formToObject(form) {
  const obj = {};
  for (const [k, v] of new FormData(form).entries()) {
    if (v === '') continue;
    obj[k] = v;
  }
  return obj;
}

function defaultFormat(data) {
  if (typeof data === 'string') return data;
  const promos = Array.isArray(data?.response?.data) ? data.response.data : null;
  if (promos) {
    const names = promos.map((p, i) => `${i + 1}. ${p.headerName || p.name || '(no name)'}`).join('\n');
    return { text: `Number of promotions: ${promos.length}\n\n${names || '(none)'}`, json: data };
  }
  return { json: data };
}

async function runFetch({ btn, outEl, url, method = 'POST', body, prelude = '', placeholder = 'fetching…', format, onData }) {
  btn.disabled = true;
  renderResult(outEl, placeholder);
  try {
    const init = { method, headers: { 'content-type': 'application/json' } };
    if (body !== undefined) {
      const payload = typeof body === 'function' ? body() : body;
      init.body = JSON.stringify(payload);
    }
    const res = await fetch(typeof url === 'function' ? url() : url, init);
    // Non-JSON replies (e.g. an HTML 404 from a server that predates a newly
    // added route) should surface as a readable error, not a parser exception.
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      showJson(outEl, {
        error: `HTTP ${res.status} — server returned non-JSON (is the app server up to date? restart it if a route is missing)`,
        body: text.slice(0, 300),
      });
      return;
    }
    renderResult(outEl, format ? format(data) : defaultFormat(data), prelude);
    if (onData) onData(data);
  } catch (err) {
    showJson(outEl, { error: err.message });
  } finally {
    btn.disabled = false;
  }
}

// ---- Token ---------------------------------------------------------------

async function loadToken({ force = false } = {}) {
  const statusEl = $('#token-status');
  const expiresEl = $('#token-expires');
  const outputEl = $('#token-output');
  statusEl.textContent = 'loading…';
  try {
    const res = await fetch(`/api/token${force ? '?refresh=1' : ''}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'error');
    statusEl.innerHTML = `<span class="ok">OK</span> ${data.cached ? '(cached)' : '(fresh)'}`;
    expiresEl.textContent = data.expiresAt;
    showJson(outputEl, { ...data, token: data.token.slice(0, 16) + '…' });
  } catch (err) {
    statusEl.innerHTML = `<span class="err">${err.message}</span>`;
  }
}

// ---- Promotion create ----------------------------------------------------

// Codes of the promotions created by the last successful "Create" run. The
// batch-overwrite section reuses these to re-import (overwrite) the same
// promotions by `code`.
let lastCreatedCodes = [];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// "a, b,,c" → ['a','b','c'] — every comma-separated input parses this way.
function splitCsv(value) {
  return (value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// The UI's identifier types mapped onto the values the Brickworks and vouchers
// APIs expect (mirrors PROFILE_IDENTIFIER_TYPES on the server). POS and events
// use different mappings — those stay at their call sites.
const PROFILE_ID_TYPES = { clientId: 'id', uuid: 'uuid', customId: 'custom_identify', email: 'email' };

// The vouchers, events and transactions services reject calls without this
// header — the server sets it on every proxied request, so the copied curl
// commands have to carry it too (mirrors VOUCHERS_API_VERSION on the server).
const API_VERSION = '4.4';

// Recursively merge `source` into `target`. Nested plain objects combine;
// scalars and arrays from `source` overwrite. Mirrors the server.
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

// Parse the custom-fields textarea. Returns the parsed object (or null when
// empty), and surfaces any error inline. Throws on invalid input so callers
// can abort the request.
function readCustomFields() {
  const inputEl = $('#promotion-custom-fields');
  const errEl = $('#promotion-custom-fields-error');
  const showErr = (msg) => {
    errEl.textContent = msg;
    errEl.hidden = false;
    inputEl.classList.add('invalid');
  };
  errEl.hidden = true;
  inputEl.classList.remove('invalid');
  const raw = (inputEl.value || '').trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    showErr(`Invalid JSON: ${err.message}`);
    throw new Error('customFields is not valid JSON');
  }
  if (!isPlainObject(parsed)) {
    showErr('Custom fields must be a JSON object, e.g. { "details": { … } }');
    throw new Error('customFields must be a JSON object');
  }
  return parsed;
}

async function createPromotion() {
  let customFields;
  try {
    customFields = readCustomFields();
  } catch (err) {
    showJson($('#promotion-output'), { error: err.message });
    return;
  }
  await runFetch({
    btn: $('#promotion-create'),
    outEl: $('#promotion-output'),
    url: '/api/promotion',
    placeholder: 'sending…',
    body: () => {
      const o = formToObject($('#promotion-form'));
      delete o.customFields;
      if (o.priority) o.priority = Number(o.priority);
      if (o.count) o.count = Number(o.count);
      if (o.redeemLimitPerClient) o.redeemLimitPerClient = Number(o.redeemLimitPerClient);
      for (const k of ['startAt', 'expireAt']) {
        if (o[k]) o[k] = new Date(o[k]).toISOString();
      }
      if (customFields) o.customFields = customFields;
      return o;
    },
    onData: (data) => {
      const codes = (data.results || [])
        .filter((r) => r.ok)
        .map((r) => r.request?.code)
        .filter(Boolean);
      if (codes.length) {
        lastCreatedCodes = codes;
        // Prefill the batch-overwrite textarea so Create → Overwrite flows.
        const codesEl = $('#batch-codes');
        if (codesEl) codesEl.value = codes.join(', ');
      }
    },
    format: (data) => {
      if (!data.results) return defaultFormat(data);
      const summary = `${data.okCount}/${data.count} OK${data.failCount ? `, ${data.failCount} failed` : ''}`;
      const names = data.results.map((r, i) =>
        `${i + 1}. [${r.status}] ${r.request?.headerName ?? ''}  code:${r.request?.code ?? '—'}${r.ok ? '' : '  ← FAIL'}`
      ).join('\n');
      return { text: `${summary}\n\n${names}`, json: data };
    },
  });
}

// ---- Voucher pools (ListPools, ListVouchersFromPool) ----------------------

// Pool picked in the Voucher pools card. Its combo is multi-select like the
// others, so only the first pick is used (with a warning).
function parsePoolUuids() {
  return splitCsv($('#pool-picker-input').value || '');
}

// Shared limit/page/includeMeta paging inputs of the Voucher pools card.
function poolPagingParams() {
  const o = formToObject($('#pool-form'));
  return {
    limit: Math.max(1, Math.min(Number(o.limit) || 100, 1000)),
    page: Math.max(1, Number(o.page) || 1),
    includeMeta: o.includeMeta === 'true',
  };
}

// Summarize one pagination source — the response `meta` (includeMeta: true) or
// the X-Pagination-* headers the server reads off the response — into a suffix.
function paginationSuffix(meta) {
  if (!meta || meta.totalCount == null) return '';
  return `  (page ${meta.page ?? '?'}/${meta.totalPages ?? '?'} of ${meta.totalCount} total)`;
}

// List the workspace's voucher pools (ListPools) — the same call the ↻ pickers
// make, but rendered with the full pool definitions.
async function fetchPoolList() {
  const paging = poolPagingParams();
  const qs = new URLSearchParams({
    limit: String(paging.limit),
    page: String(paging.page),
    includeMeta: String(paging.includeMeta),
  });
  await runFetch({
    btn: $('#pool-list'),
    outEl: $('#pool-output'),
    url: `/api/voucher-pools?${qs}`,
    method: 'GET',
    format: (data) => {
      const items = data.response?.data;
      if (!Array.isArray(items)) return defaultFormat(data);
      const suffix = paginationSuffix(data.response?.meta || data.pagination);
      const lines = items.map((pool, i) => `${i + 1}. ${pool.name || '(no name)'}  ${pool.uuid}`).join('\n');
      return { text: `Voucher pools: ${items.length}${suffix}\n\n${lines || '(none)'}`, json: data };
    },
  });
}

// List every voucher stored in the picked pool (ListVouchersFromPool).
async function fetchVouchersInPool() {
  const pools = parsePoolUuids();
  if (pools.length === 0) {
    showJson($('#pool-output'), { error: 'pick a voucher pool first (↻ fetches all pools)' });
    return;
  }
  const paging = poolPagingParams();
  const prelude = pools.length > 1
    ? `⚠ more than 1 pool is picked, listing only the first one (${pools[0]})\n\n`
    : '';
  await runFetch({
    btn: $('#vouchers-in-pool'),
    outEl: $('#pool-output'),
    url: '/api/vouchers-in-pool',
    prelude,
    body: () => ({ poolUuid: pools[0], ...paging }),
    format: (data) => {
      const items = data.response?.data;
      if (!Array.isArray(items)) return defaultFormat(data);
      const suffix = paginationSuffix(data.response?.meta || data.pagination);
      const lines = items.map(voucherLine).join('\n');
      return { text: `Vouchers in the pool: ${items.length}${suffix}\n\n${lines || '(none)'}`, json: data };
    },
  });
}

// ---- Voucher create (CreateAVoucher) --------------------------------------

function parseVoucherPoolUuids() {
  const raw = $('#voucher-pool-input').value || '';
  return splitCsv(raw);
}

// Build the /api/voucher request body from the form. The combo is
// multi-select, so only the first picked pool is used (with a warning).
function voucherBody(poolUuid) {
  const o = formToObject($('#voucher-form'));
  o.poolUuid = poolUuid;
  if (o.count) o.count = Number(o.count);
  if (o.clientId) o.clientId = Number(o.clientId);
  if (o.expireIn) o.expireIn = new Date(o.expireIn).toISOString();
  return o;
}

async function createVoucher() {
  const pools = parseVoucherPoolUuids();
  if (pools.length === 0) {
    showJson($('#voucher-output'), { error: 'pick a voucher pool first (↻ fetches all pools)' });
    return;
  }
  const prelude = pools.length > 1
    ? `⚠ more than 1 pool is picked, creating only in the first one (${pools[0]})\n\n`
    : '';
  await runFetch({
    btn: $('#voucher-create'),
    outEl: $('#voucher-output'),
    url: '/api/voucher',
    placeholder: 'creating…',
    prelude,
    body: () => voucherBody(pools[0]),
    onData: (data) => {
      // Prefill the check-voucher field with the first created code so
      // Create → check voucher flows without retyping.
      const first = (data.results || []).find((r) => r.ok && r.request?.code);
      if (first) {
        $('#voucher-check-value').value = first.request.code;
        $('#voucher-check-form').elements.searchKey.value = 'code';
      }
    },
    format: (data) => {
      if (!data.results) return defaultFormat(data);
      const summary = `${data.okCount}/${data.count} OK${data.failCount ? `, ${data.failCount} failed` : ''}`;
      const lines = data.results.map((r, i) => {
        const client = r.request?.clientId != null
          ? `  clientId:${r.request.clientId}`
          : (r.request?.clientUuid ? `  clientUuid:${r.request.clientUuid}` : '');
        return `${i + 1}. [${r.status}] code:${r.request?.code ?? '(auto)'}${client}${r.ok ? '' : '  ← FAIL'}`;
      }).join('\n');
      return { text: `${summary}\n\n${lines}`, json: data };
    },
  });
}

// Summarize one voucher object (from voucherData) into a single line.
function voucherLine(v, i) {
  const client = v.clientId != null ? `  clientId:${v.clientId}` : (v.clientUuid ? `  clientUuid:${v.clientUuid}` : '');
  const expires = v.expireIn ? `  expires:${v.expireIn}` : '';
  return `${i + 1}. [${v.status || '—'}] ${v.code || '(no code)'}${client}${expires}`;
}

async function checkVoucher() {
  const o = formToObject($('#voucher-check-form'));
  if (!o.searchValue) {
    showJson($('#voucher-output'), { error: 'enter a voucher code or uuid to check' });
    return;
  }
  await runFetch({
    btn: $('#voucher-check'),
    outEl: $('#voucher-output'),
    url: '/api/voucher-details',
    body: () => ({ searchKey: o.searchKey || 'code', searchValue: o.searchValue }),
    format: (data) => {
      const v = data.response?.data;
      if (!v) return defaultFormat(data);
      return { text: voucherLine(v, 0).slice(3), json: data };
    },
  });
}

async function redeemVoucher() {
  const o = formToObject($('#voucher-check-form'));
  if ((o.searchKey || 'code') !== 'code') {
    showJson($('#voucher-output'), { error: 'redeem works by code — switch "check voucher by" to code' });
    return;
  }
  if (!o.searchValue) {
    showJson($('#voucher-output'), { error: 'enter the voucher code to redeem' });
    return;
  }
  await runFetch({
    btn: $('#voucher-redeem'),
    outEl: $('#voucher-output'),
    url: '/api/voucher/redeem',
    placeholder: 'redeeming…',
    body: () => ({ code: o.searchValue }),
    format: (data) => {
      const v = data.response?.data;
      const head = v
        ? `${data.response?.message || 'redeemed'} — ${voucherLine(v, 0).slice(3)}`
        : `[${data.status ?? '—'}] ${data.response?.message || data.error || 'failed'}`;
      return { text: head, json: data };
    },
  });
}

async function fetchVouchersForClient() {
  const o = formToObject($('#vouchers-client-form'));
  if (!o.identifierValue) {
    showJson($('#voucher-output'), { error: 'set identifierType + identifierValue in the "vouchers for profile" row' });
    return;
  }
  await runFetch({
    btn: $('#vouchers-for-client'),
    outEl: $('#voucher-output'),
    url: '/api/vouchers-for-client',
    body: () => o,
    format: (data) => {
      const items = data.response?.data;
      if (!Array.isArray(items)) return defaultFormat(data);
      const lines = items.map(voucherLine).join('\n');
      return { text: `Vouchers assigned to the profile: ${items.length}\n\n${lines || '(none)'}`, json: data };
    },
  });
}

function batchRedeemBody() {
  return formToObject($('#voucher-batch-redeem-form'));
}

async function batchRedeemVouchersForProfile() {
  const o = batchRedeemBody();
  if (!o.profileValue) {
    showJson($('#voucher-output'), { error: 'set profileKey + profileValue in the "batch redeem" row' });
    return;
  }
  const codes = splitCsv(o.codes);
  if (codes.length === 0) {
    showJson($('#voucher-output'), { error: 'enter at least one voucher code (comma-separated)' });
    return;
  }
  await runFetch({
    btn: $('#voucher-batch-redeem'),
    outEl: $('#voucher-output'),
    url: '/api/voucher/batch-redeem-for-profile',
    placeholder: 'redeeming…',
    body: () => o,
    format: (data) => ({
      text: `[${data.status ?? '—'}] ${data.response?.message || (data.ok ? 'redeemed' : data.error || 'failed')} — ${data.count ?? codes.length} item(s)${data.status === 207 ? '  ⚠ partial: some items failed, see payload' : ''}`,
      json: data,
    }),
  });
}

// ---- Add event to profile (CustomEvent) ------------------------------------

// The params input has two modes: a key/value row builder (default) and a raw
// JSON textarea. Switching converts the current input into the other shape.
let eventParamsMode = 'fields';

// Coerce a builder value: anything that parses as JSON (42, true, null,
// ["a"], {"x":1}) is sent typed; everything else stays a string.
function coerceParamValue(raw) {
  const s = raw.trim();
  if (s === '') return '';
  try { return JSON.parse(s); } catch { return raw; }
}

function addEventParamRow(key = '', value = '') {
  const row = document.createElement('div');
  row.className = 'params-row';

  const keyEl = document.createElement('input');
  keyEl.className = 'params-key';
  keyEl.placeholder = 'key';
  keyEl.autocomplete = 'off';
  keyEl.value = key;

  const valEl = document.createElement('input');
  valEl.className = 'params-val';
  valEl.placeholder = 'value — JSON is parsed (42, true, ["a"]), else string';
  valEl.autocomplete = 'off';
  valEl.value = value;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'combo-btn';
  remove.title = 'Remove';
  remove.setAttribute('aria-label', 'Remove param');
  remove.textContent = '✕';
  remove.addEventListener('click', () => row.remove());

  row.append(keyEl, valEl, remove);
  $('#event-params-rows').appendChild(row);
}

// Rows with an empty key are skipped; duplicate keys — the last one wins.
function collectEventParamRows() {
  const obj = {};
  for (const row of document.querySelectorAll('#event-params-rows .params-row')) {
    const key = row.querySelector('.params-key').value.trim();
    if (!key) continue;
    obj[key] = coerceParamValue(row.querySelector('.params-val').value);
  }
  return obj;
}

function setEventParamsMode(mode) {
  if (mode === eventParamsMode) return;
  const ta = $('#event-params');
  if (mode === 'raw') {
    const obj = collectEventParamRows();
    ta.value = Object.keys(obj).length ? JSON.stringify(obj, null, 2) : '';
  } else {
    // raw → fields: the textarea must hold a valid JSON object (or nothing).
    let parsed;
    try {
      parsed = readEventParams(); // still in raw mode — validates the textarea
    } catch {
      return; // invalid JSON — stay in raw mode, the inline error is shown
    }
    const rows = $('#event-params-rows');
    rows.innerHTML = '';
    for (const [k, v] of Object.entries(parsed || {})) {
      addEventParamRow(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    if (!rows.children.length) addEventParamRow();
  }
  eventParamsMode = mode;
  ta.hidden = mode !== 'raw';
  $('#event-params-rows').hidden = mode !== 'fields';
  $('#event-params-add').hidden = mode !== 'fields';
  $('#event-params-mode-fields').classList.toggle('on', mode === 'fields');
  $('#event-params-mode-raw').classList.toggle('on', mode === 'raw');
  $('#event-params-error').hidden = true;
  ta.classList.remove('invalid');
}

// Read the event params from the active mode: the builder rows (never
// invalid), or the raw textarea (must be a JSON object). Raw errors surface
// inline and throw so callers can abort the request.
function readEventParams() {
  if (eventParamsMode === 'fields') {
    const obj = collectEventParamRows();
    return Object.keys(obj).length ? obj : null;
  }
  const inputEl = $('#event-params');
  const errEl = $('#event-params-error');
  const showErr = (msg) => {
    errEl.textContent = msg;
    errEl.hidden = false;
    inputEl.classList.add('invalid');
  };
  errEl.hidden = true;
  inputEl.classList.remove('invalid');
  const raw = (inputEl.value || '').trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    showErr(`Invalid JSON: ${err.message}`);
    throw new Error('params is not valid JSON');
  }
  if (!isPlainObject(parsed)) {
    showErr('Params must be a JSON object, e.g. { "source": "test" }');
    throw new Error('params must be a JSON object');
  }
  return parsed;
}

// The section sends either a custom event or a transaction — one toggle, one
// button. In transaction mode the whole request body (minus client) lives in
// a preconfigured JSON textarea.
let eventKind = 'event';

const TXN_DEFAULT_PAYLOAD = `{
  "orderId": "order-{rand5}-{date}",
  "source": "POS",
  "products": [
    {
      "sku": "SKU-001",
      "name": "Soft drink",
      "quantity": 2,
      "finalUnitPrice": { "amount": 3.25, "currency": "USD" },
      "categories": ["Beverages"]
    }
  ],
  "paymentInfo": { "method": "CASH" },
  "revenue": { "amount": 6.5, "currency": "USD" },
  "value": { "amount": 6.5, "currency": "USD" }
}`;

function setEventKind(kind) {
  if (kind === eventKind) return;
  eventKind = kind;
  const isTxn = kind === 'transaction';
  $('#event-kind-event').classList.toggle('on', !isTxn);
  $('#event-kind-transaction').classList.toggle('on', isTxn);
  document.querySelectorAll('#sec-events .event-only').forEach((el) => { el.hidden = isTxn; });
  $('#txn-payload-block').hidden = !isTxn;
  $('#event-hint').hidden = isTxn;
  $('#txn-hint').hidden = !isTxn;
  $('#event-add').textContent = isTxn ? 'Add transaction' : 'Add event';
  if (isTxn && !$('#txn-payload').value.trim()) $('#txn-payload').value = TXN_DEFAULT_PAYLOAD;
}

// Validate the transaction textarea: a JSON object with orderId + products.
// Errors surface inline and throw so callers can abort the request.
function readTxnPayload() {
  const inputEl = $('#txn-payload');
  const errEl = $('#txn-payload-error');
  const showErr = (msg) => {
    errEl.textContent = msg;
    errEl.hidden = false;
    inputEl.classList.add('invalid');
  };
  errEl.hidden = true;
  inputEl.classList.remove('invalid');
  const raw = (inputEl.value || '').trim();
  let parsed;
  try {
    parsed = JSON.parse(raw || 'null');
  } catch (err) {
    showErr(`Invalid JSON: ${err.message}`);
    throw new Error('payload is not valid JSON');
  }
  if (!isPlainObject(parsed)) {
    showErr('Payload must be a JSON object — the transaction body without client.');
    throw new Error('payload must be a JSON object');
  }
  if (typeof parsed.orderId !== 'string' || !parsed.orderId.trim()) {
    showErr('orderId is required (string).');
    throw new Error('orderId is required');
  }
  if (!Array.isArray(parsed.products) || parsed.products.length === 0) {
    showErr('products must be a non-empty array.');
    throw new Error('products must be a non-empty array');
  }
  return parsed;
}

async function addTransactionToProfile() {
  let payload;
  try {
    payload = readTxnPayload();
  } catch (err) {
    showJson($('#event-output'), { error: err.message });
    return;
  }
  await runFetch({
    btn: $('#event-add'),
    outEl: $('#event-output'),
    url: '/api/transaction',
    placeholder: 'sending…',
    body: () => {
      const o = formToObject($('#event-form'));
      return {
        identifierType: o.identifierType,
        identifierValue: o.identifierValue,
        count: Number(o.count) || 1,
        payload,
      };
    },
    format: (data) => {
      if (!data.results) return defaultFormat(data);
      const summary = `${data.okCount}/${data.count} OK${data.failCount ? `, ${data.failCount} failed` : ''}`;
      const lines = data.results.map((r, i) =>
        `${i + 1}. [${r.status}] orderId:${r.request?.orderId ?? '—'}  ${r.request?.revenue?.amount ?? '—'} ${r.request?.revenue?.currency ?? ''}${r.ok ? '' : '  ← FAIL'}`
      ).join('\n');
      return { text: `${summary}\n\n${lines}`, json: data };
    },
  });
}

async function addEventToProfile() {
  if (eventKind === 'transaction') return addTransactionToProfile();
  let params;
  try {
    params = readEventParams();
  } catch (err) {
    showJson($('#event-output'), { error: err.message });
    return;
  }
  await runFetch({
    btn: $('#event-add'),
    outEl: $('#event-output'),
    url: '/api/event',
    placeholder: 'sending…',
    body: () => {
      const o = formToObject($('#event-form'));
      if (o.count) o.count = Number(o.count);
      if (o.time) o.time = new Date(o.time).toISOString();
      if (params) o.params = params;
      return o;
    },
    format: (data) => {
      if (!data.results) return defaultFormat(data);
      const summary = `${data.okCount}/${data.count} OK${data.failCount ? `, ${data.failCount} failed` : ''}`;
      const lines = data.results.map((r, i) =>
        `${i + 1}. [${r.status}] ${r.request?.action ?? ''}  label:${r.request?.label ?? '—'}${r.ok ? '' : '  ← FAIL'}`
      ).join('\n');
      return { text: `${summary}\n\n${lines}`, json: data };
    },
  });
}

// ---- Batch overwrite (BatchImportPromotions) -----------------------------

function parseBatchCodes() {
  return splitCsv($('#batch-codes').value);
}

function parseBatchSegments() {
  const { targetSegment } = formToObject($('#batch-form'));
  return splitCsv(targetSegment);
}

function batchBody() {
  return { codes: parseBatchCodes(), targetSegment: parseBatchSegments() };
}

async function batchImport() {
  const codes = parseBatchCodes();
  if (codes.length === 0) {
    showJson($('#batch-output'), { error: 'no codes — create promotions first or paste codes' });
    return;
  }
  const targetSegment = parseBatchSegments();
  if (targetSegment.length === 0) {
    showJson($('#batch-output'), { error: 'targetSegment is required' });
    return;
  }
  await runFetch({
    btn: $('#batch-import'),
    outEl: $('#batch-output'),
    url: '/api/promotions/batch-import',
    placeholder: 'overwriting…',
    body: batchBody,
    format: (data) => ({
      text: `[${data.status ?? '—'}] overwrote ${data.count ?? 0} promotion(s) — targetSegment=[${targetSegment.join(', ')}]`,
      json: data,
    }),
  });
}

function useCreatedCodes() {
  if (lastCreatedCodes.length === 0) {
    showJson($('#batch-output'), { error: 'no codes captured yet — run Create first' });
    return;
  }
  $('#batch-codes').value = lastCreatedCodes.join(', ');
}

async function loadExistingCodes() {
  const outEl = $('#batch-output');
  renderResult(outEl, 'loading codes…');
  try {
    const r = await fetch('/api/promotions?prefix=test-');
    const data = await r.json();
    if (!r.ok || !data.ok) { showJson(outEl, data); return; }
    const codes = (data.items || []).map((i) => i.code).filter(Boolean);
    $('#batch-codes').value = codes.join(', ');
    renderResult(outEl, `Loaded ${codes.length} code(s) with prefix "test-".`);
  } catch (err) {
    showJson(outEl, { error: err.message });
  }
}

// ---- Activate a promotion for the client ---------------------------------

// Walk an arbitrary Synerise response and collect anything that looks like a
// promotion (has an id and a name). Deduped by uuid (preferred) or code.
function extractPromotions(data) {
  const root = data?.response ?? data;
  const found = [];
  const seen = new Set();
  const visit = (node) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== 'object') return;
    const uuid = node.uuid || node.promotionUuid || null;
    const code = node.code || null;
    const name = node.headerName || node.name || null;
    if ((uuid || code) && name && (node.status || node.type || code)) {
      const id = uuid || code;
      if (!seen.has(id)) {
        seen.add(id);
        found.push({ uuid, code, name, status: node.status || '', type: node.type || '' });
      }
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') visit(v);
    }
  };
  visit(root);
  return found;
}

function currentClientIdentifier() {
  const { identifierType, identifierValue } = formToObject($('#handbill-form'));
  return { identifierType, identifierValue };
}

function activateBody(promo) {
  const { identifierType, identifierValue } = currentClientIdentifier();
  const key = promo.uuid ? 'uuid' : 'code';
  const value = promo.uuid || promo.code;
  const body = { identifierType, identifierValue, key, value };
  const points = ($('#activate-points').value || '').trim();
  if (points) body.pointsToUse = Number(points);
  return body;
}

// Update the result <pre> (which sits ABOVE the promotion list and can shrink
// dramatically, e.g. a 20-promotion JSON replaced by a short response) while
// keeping `anchorEl` at the same viewport position, so the row the user just
// clicked doesn't jump away.
function showJsonAnchored(outEl, data, anchorEl) {
  const before = anchorEl.getBoundingClientRect().top;
  showJson(outEl, data);
  const delta = anchorEl.getBoundingClientRect().top - before;
  if (delta) window.scrollBy(0, delta);
}

// Pull a human-readable message out of the varied error shapes the server
// and Synerise return (top-level error, response.message, or an error array).
function activateErrorText(data) {
  if (data.error) return data.error;
  const resp = data.response;
  if (resp?.message) return resp.message;
  if (Array.isArray(resp?.error)) return resp.error.map((e) => e.message || JSON.stringify(e)).join(', ');
  if (typeof resp?.error === 'string') return resp.error;
  return 'failed';
}

async function activatePromotionForClient(promo, statusEl) {
  const { identifierType, identifierValue } = currentClientIdentifier();
  if (!identifierType || !identifierValue) {
    statusEl.innerHTML = '<span class="err">set identifierType + identifierValue above</span>';
    return;
  }
  statusEl.textContent = 'activating…';
  try {
    const r = await fetch('/api/promotion/activate-for-client', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(activateBody(promo)),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) {
      statusEl.innerHTML = `<span class="err">[${data.status || r.status}] ${activateErrorText(data)}</span>`;
    } else {
      statusEl.innerHTML = `<span class="ok">activated ✓ [${data.status}]</span>`;
    }
    showJsonAnchored($('#handbill-output'), data, statusEl);
  } catch (err) {
    statusEl.innerHTML = `<span class="err">${err.message}</span>`;
  }
}

function redeemBody(promo) {
  const { identifierType, identifierValue } = currentClientIdentifier();
  const body = { clientKey: identifierType, clientKeyValue: identifierValue, code: promo.code };
  const quantity = ($('#redeem-quantity').value || '').trim();
  if (quantity) body.quantity = Number(quantity);
  return body;
}

async function redeemPromotionForClient(promo, statusEl) {
  const { identifierType, identifierValue } = currentClientIdentifier();
  if (!identifierType || !identifierValue) {
    statusEl.innerHTML = '<span class="err">set identifierType + identifierValue above</span>';
    return;
  }
  if (!promo.code) {
    statusEl.innerHTML = '<span class="err">promotion has no code — cannot redeem</span>';
    return;
  }
  statusEl.textContent = 'redeeming…';
  try {
    const r = await fetch('/api/promotion/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(redeemBody(promo)),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) {
      statusEl.innerHTML = `<span class="err">[${data.status || r.status}] ${activateErrorText(data)}</span>`;
    } else {
      statusEl.innerHTML = `<span class="ok">redeemed ✓ [${data.status}]</span>`;
    }
    showJsonAnchored($('#handbill-output'), data, statusEl);
  } catch (err) {
    statusEl.innerHTML = `<span class="err">${err.message}</span>`;
  }
}

// Build one promotion row with one or more action buttons, each with its own
// copy-curl button. `actions` is [{ label, onAction, curlFor }]; every
// onAction(promo, statusEl) runs the call, curlFor(promo) returns the curl.
function makePromoRow(promo, actions) {
  const row = document.createElement('div');
  row.className = 'activate-row';

  const meta = document.createElement('div');
  meta.className = 'meta';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = promo.name;
  const sub = document.createElement('div');
  sub.className = 'uuid';
  sub.textContent = [promo.type, promo.status].filter(Boolean).join('/') + (promo.uuid ? `  ${promo.uuid}` : ` code:${promo.code}`);
  meta.appendChild(name);
  meta.appendChild(sub);

  const status = document.createElement('div');
  status.className = 'activate-status';

  const actionsEl = document.createElement('div');
  actionsEl.className = 'activate-actions';
  for (const { label, onAction, curlFor } of actions) {
    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.textContent = label;
    actionBtn.addEventListener('click', () => onAction(promo, status));
    const curlBtn = document.createElement('button');
    curlBtn.type = 'button';
    curlBtn.className = 'curl-copy';
    curlBtn.textContent = 'copy curl';
    curlBtn.addEventListener('click', (e) => copyCurlButton(e, () => curlFor(promo)));
    actionsEl.appendChild(actionBtn);
    actionsEl.appendChild(curlBtn);
  }

  row.appendChild(meta);
  row.appendChild(actionsEl);
  row.appendChild(status);
  return row;
}

// Render a promotion picker list into `listSel`, showing/hiding `blockSel`.
function renderPromoList({ blockSel, listSel, promos, actions }) {
  const block = $(blockSel);
  const listEl = $(listSel);
  listEl.innerHTML = '';
  if (promos.length === 0) {
    block.hidden = true;
    return;
  }
  block.hidden = false;
  for (const promo of promos) {
    listEl.appendChild(makePromoRow(promo, actions));
  }
}

function activateCurlFor(promo) {
  return getTokenForCurl().then(({ token, apiBase }) => {
    const { identifierType, identifierValue } = currentClientIdentifier();
    if (!identifierType || !identifierValue) throw new Error('identifier required');
    const b = activateBody(promo);
    const payload = { key: b.key, value: b.value };
    if (b.pointsToUse !== undefined) payload.pointsToUse = b.pointsToUse;
    return buildCurl({
      method: 'POST',
      url: `${apiBase}/v4/promotions/promotion/activate-for-client/${encodeURIComponent(identifierType)}/${encodeURIComponent(identifierValue)}`,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: payload,
    });
  });
}

function redeemCurlFor(promo) {
  return getTokenForCurl().then(({ token, apiBase }) => {
    const { identifierType, identifierValue } = currentClientIdentifier();
    if (!identifierType || !identifierValue) throw new Error('identifier required');
    if (!promo.code) throw new Error('no code');
    const b = redeemBody(promo);
    const payload = { code: b.code, clientKey: b.clientKey, clientKeyValue: b.clientKeyValue };
    if (b.quantity !== undefined) payload.quantity = b.quantity;
    return buildCurl({
      method: 'POST',
      url: `${apiBase}/v4/promotions/promotion/redeem`,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: payload,
    });
  });
}

// Render the promotion picker from a fetch result: every promotion gets an
// Activate and a Redeem button side by side (redeem is accepted by the API
// only for ACTIVE promotions — clicking it on another status shows the error).
function renderPromotionActions(data) {
  renderPromoList({
    blockSel: '#handbill-activate',
    listSel: '#activate-promo-list',
    promos: extractPromotions(data),
    actions: [
      { label: 'Activate', onAction: activatePromotionForClient, curlFor: activateCurlFor },
      { label: 'Redeem', onAction: redeemPromotionForClient, curlFor: redeemCurlFor },
    ],
  });
}

// Shared handler for the small "copy curl" buttons: manages the button's
// transient copied/error state; `build()` returns (or resolves to) the curl.
async function copyCurlButton(e, build) {
  const btn = e.currentTarget;
  const original = btn.textContent;
  btn.classList.remove('copied', 'err');
  btn.disabled = true;
  try {
    const curl = await build();
    await copyToClipboard(curl);
    btn.classList.add('copied');
    btn.textContent = 'copied ✓';
  } catch (err) {
    btn.classList.add('err');
    btn.textContent = err.message.length > 40 ? 'error' : err.message;
  } finally {
    setTimeout(() => {
      btn.classList.remove('copied', 'err');
      btn.textContent = original;
      btn.disabled = false;
    }, 1600);
  }
}

// ---- Handbill fetch ------------------------------------------------------

function parseSelectedUuids() {
  const raw = $('#handbill-uuid-input').value || '';
  return splitCsv(raw);
}

async function fetchHandbill() {
  const uuids = parseSelectedUuids();
  const prelude = uuids.length > 1
    ? `⚠ more than 1 handbill is picked, returning only the first one (${uuids[0]})\n\n`
    : '';
  await runFetch({
    btn: $('#handbill-fetch'),
    outEl: $('#handbill-output'),
    url: '/api/handbill',
    prelude,
    body: () => {
      const b = formToObject($('#handbill-form'));
      if (uuids.length > 0) b.handbillUuid = uuids[0];
      return b;
    },
    onData: renderPromotionActions,
  });
}

// ---- Promotions filters (GetAllClientPromotionsV2) --------------------------

// Known query filters per the API reference; each row becomes one query param.
// Multi-value params (status, type) take comma-separated values in one param,
// e.g. status=ACTIVE,REDEEMED. "custom…" sends an arbitrary name=value pair.
const FILTER_PARAMS = [
  { name: 'status', placeholder: 'e.g. ACTIVE,REDEEMED — of ACTIVE, ASSIGNED, REDEEMED, EXPIRED' },
  { name: 'type', placeholder: 'e.g. HANDBILL — comma-separated' },
  { name: 'presentOnly', bool: true },
  { name: 'displayableOnly', bool: true },
  { name: 'includeMeta', bool: true },
  { name: 'limit', placeholder: 'page size, e.g. 100' },
  { name: 'page', placeholder: 'page number, e.g. 1' },
];

function addFilterRow() {
  const row = document.createElement('div');
  row.className = 'sort-row filter-row';

  const name = document.createElement('select');
  name.className = 'filter-name';
  name.append(new Option('— param —', ''));
  for (const p of FILTER_PARAMS) name.append(new Option(p.name, p.name));
  name.append(new Option('custom…', '__custom'));

  const customName = document.createElement('input');
  customName.className = 'filter-custom-name';
  customName.placeholder = 'param name';
  customName.autocomplete = 'off';
  customName.hidden = true;

  const valueSlot = document.createElement('span');
  valueSlot.className = 'filter-value-slot';

  const buildValueControl = () => {
    const def = FILTER_PARAMS.find((p) => p.name === name.value);
    let ctrl;
    if (def?.bool) {
      ctrl = document.createElement('select');
      ctrl.append(new Option('true', 'true'), new Option('false', 'false'));
    } else {
      ctrl = document.createElement('input');
      ctrl.placeholder = def?.placeholder || 'value';
      ctrl.autocomplete = 'off';
    }
    ctrl.className = 'filter-value';
    valueSlot.replaceChildren(ctrl);
  };
  buildValueControl();

  name.addEventListener('change', () => {
    customName.hidden = name.value !== '__custom';
    buildValueControl();
  });

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'combo-btn';
  remove.title = 'Remove';
  remove.setAttribute('aria-label', 'Remove filter');
  remove.textContent = '✕';
  remove.addEventListener('click', () => row.remove());

  row.append(name, customName, valueSlot, remove);
  $('#filter-rows').appendChild(row);
}

function collectFilterParams() {
  return [...document.querySelectorAll('#filter-rows .filter-row')]
    .map((row) => {
      const sel = row.querySelector('.filter-name').value;
      const name = sel === '__custom' ? row.querySelector('.filter-custom-name').value.trim() : sel;
      const value = row.querySelector('.filter-value').value.trim();
      return name && value ? { name, value } : null;
    })
    .filter(Boolean);
}

// ---- Promotions sorting (GetAllClientPromotionsV2) -------------------------

// Sortable attributes per the API reference; each row becomes one repeated
// `sort=attribute,direction` query param, applied in row order.
const SORT_ATTRIBUTES = [
  'headerName', 'name', 'code', 'startAt', 'createdAt', 'updatedAt',
  'expireAt', 'requireRedeemedPoints', 'type', 'priority', 'status',
];

function addSortRow() {
  const row = document.createElement('div');
  row.className = 'sort-row';

  const attr = document.createElement('select');
  attr.className = 'sort-attr';
  attr.append(new Option('— attribute —', ''));
  for (const a of SORT_ATTRIBUTES) attr.append(new Option(a, a));

  const dir = document.createElement('select');
  dir.className = 'sort-dir';
  dir.append(new Option('asc', 'asc', true, true));
  dir.append(new Option('desc', 'desc'));

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'combo-btn';
  remove.title = 'Remove';
  remove.setAttribute('aria-label', 'Remove sort');
  remove.textContent = '✕';
  remove.addEventListener('click', () => row.remove());

  row.append(attr, dir, remove);
  $('#sort-rows').appendChild(row);
}

function collectSortParams() {
  return [...document.querySelectorAll('#sort-rows .sort-row')]
    .map((row) => {
      const attr = row.querySelector('.sort-attr').value;
      return attr ? `${attr},${row.querySelector('.sort-dir').value}` : null;
    })
    .filter(Boolean);
}

async function fetchPromotionsForClient() {
  await runFetch({
    btn: $('#promotions-fetch'),
    outEl: $('#handbill-output'),
    url: '/api/promotions-for-client',
    body: () => {
      const b = formToObject($('#handbill-form'));
      const sort = collectSortParams();
      if (sort.length) b.sort = sort;
      const filters = collectFilterParams();
      if (filters.length) b.filters = filters;
      return b;
    },
    onData: renderPromotionActions,
  });
}

async function fetchHandbillConfig() {
  const uuids = parseSelectedUuids();
  if (uuids.length === 0) {
    showJson($('#handbill-output'), { error: 'pick at least one handbillUuid' });
    return;
  }
  const prelude = uuids.length > 1
    ? `⚠ more than 1 handbill is picked, returning only the first one (${uuids[0]})\n\n`
    : '';
  await runFetch({
    btn: $('#handbill-config'),
    outEl: $('#handbill-output'),
    url: '/api/handbill-config',
    prelude,
    body: () => ({ handbillUuid: uuids[0] }),
    onData: renderPromotionActions,
  });
}

async function fetchHandbillBatch() {
  await runFetch({
    btn: $('#handbill-batch'),
    outEl: $('#handbill-output'),
    url: '/api/handbill-batch',
    body: () => {
      const b = formToObject($('#handbill-form'));
      const uuids = parseSelectedUuids();
      delete b.handbillUuid;
      if (uuids.length > 0) b.handbillUuids = uuids;
      return b;
    },
    onData: renderPromotionActions,
  });
}

// ---- POS: process basket / checkout ----------------------------------------

// Shared base of the processSale/processCheckout request bodies. The sale
// variant is the base as-is; checkout additionally requires paymentsReport.
const POS_TEMPLATE_BASE = {
  operationId: 1,
  clientDateTime: '{iso}',
  terminal: { storeId: 'store-1', posId: 1 },
  transactionMetric: {
    posTransactionId: 1,
    beginDateTime: '{iso}',
    globalTransactionId: 'trx-{rand5}-{date}-{serial}',
  },
  finalValue: '30.23',
  transactionItems: [
    {
      seqNo: 1,
      articleRef: 'sku-1',
      quantity: '1.000',
      evidPrice: '34.23',
      finalPrice: '30.23',
      finalValue: '30.23',
    },
  ],
  transactionAdditionalItems: [],
};

function posTemplate(kind) {
  const tpl = JSON.parse(JSON.stringify(POS_TEMPLATE_BASE));
  if (kind === 'checkout') {
    tpl.paymentsReport = {
      paymentItems: [{ seqNo: 1, type: 1, name: 'cash', amount: '30.23' }],
    };
  }
  return JSON.stringify(tpl, null, 2);
}

// Parse a JSON-object editor (textarea + inline error span). Shared by the
// POS, promotion-settings, handbill-config and Brickworks-context editors.
// Returns { ok, value }; on failure the error is already shown inline.
// `optional: true` treats an empty field as { ok: true, value: null }.
function readJsonObjectField({ inputSel, errSel, emptyMsg, objectMsg, optional = false }) {
  const inputEl = $(inputSel);
  const errEl = $(errSel);
  errEl.hidden = true;
  inputEl.classList.remove('invalid');
  const showErr = (msg) => {
    errEl.textContent = msg;
    errEl.hidden = false;
    inputEl.classList.add('invalid');
  };
  const raw = (inputEl.value || '').trim();
  if (!raw) {
    if (optional) return { ok: true, value: null };
    showErr(emptyMsg);
    return { ok: false, value: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    showErr(`Invalid JSON: ${err.message}`);
    return { ok: false, value: null };
  }
  if (!isPlainObject(parsed)) {
    showErr(objectMsg || 'Must be a JSON object, e.g. { "key": "value" }');
    return { ok: false, value: null };
  }
  return { ok: true, value: parsed };
}

// Parse the POS transaction textarea (must be a JSON object). Surfaces errors
// inline and returns null so the caller can abort.
function readPosJson() {
  const r = readJsonObjectField({
    inputSel: '#pos-json',
    errSel: '#pos-json-error',
    emptyMsg: 'Paste or insert a transaction JSON first (use the template buttons).',
    objectMsg: 'The transaction must be a JSON object.',
  });
  return r.ok ? r.value : null;
}

async function processPos(kind) {
  const body = readPosJson();
  if (!body) return;
  await runFetch({
    btn: $(kind === 'checkout' ? '#process-checkout' : '#process-sale'),
    outEl: $('#pos-output'),
    url: kind === 'checkout' ? '/api/process-checkout' : '/api/process-sale',
    body: () => ({ ...formToObject($('#pos-form')), body }),
    format: (data) => ({ json: data }),
  });
}

// ---- Promotion: get / create / update ---------------------------------------

// Writable fields of promotionDataCreate/promotionDataCreateOrUpdate — the GET
// response additionally carries read-only fields (uuid, counters, timestamps)
// that would pollute an update, so "⤵ insert fetched" trims to this list.
// `uuid` is deliberately left out: get/update identify the promotion via the
// inputs above the editor.
const PROMOTION_WRITABLE_FIELDS = [
  'code', 'visibilityStatus', 'type', 'redeemLimitPerClient', 'redeemQuantityPerActivation',
  'redeemLimitGlobal', 'redeemType', 'details', 'discountType', 'discountValue', 'discountMode',
  'discountModeDetails', 'preDiscountValue', 'requireRedeemedPoints', 'headerName',
  'headerDescription', 'name', 'headline', 'description', 'images', 'tags', 'startAt', 'expireAt',
  'displayFrom', 'displayTo', 'lastingTime', 'params', 'itemScope', 'minBasketValue',
  'maxBasketValue', 'catalog', 'catalogItemType', 'catalogIndexItems', 'catalogFilterIds',
  'catalogFilterQuery', 'excludeCatalog', 'excludeCatalogItemType', 'excludeCatalogIndexItems',
  'excludeCatalogFilterIds', 'excludeCatalogFilterQuery', 'activationLimitGlobalType',
  'activationLimitGlobalLimit', 'activationLimitGlobalRelativeMinutes', 'storeCatalog',
  'storeItemType', 'storeIds', 'targetType', 'targetSegment', 'price', 'priority', 'voucherPool',
  'importHash',
];

// The GET response calls the visibility field `status`; create/update expect
// it as `visibilityStatus` (same enum) — rename before trimming. Null and
// empty-string values are dropped: the update is partial (omitted = kept), and
// echoing them back trips validation (e.g. a fetched `name: ""` is rejected
// with "name is not allowed to be empty"). To null a field on purpose, add
// the null back by hand.
function promotionResponseToWritable(fetched) {
  const out = { ...fetched };
  if (out.visibilityStatus === undefined && out.status !== undefined) out.visibilityStatus = out.status;
  for (const [k, v] of Object.entries(out)) {
    if (v === null || v === '') delete out[k];
  }
  return out;
}

// Fetch one promotion's full body by uuid or code — the workspace view, no
// profile context (GetPromotionDetailsAsBusinessProfile).
async function fetchPromotionDetails() {
  const form = $('#promotion-get-form');
  const o = formToObject(form);
  if (!o.searchValue) {
    showJson($('#promotion-get-output'), { error: 'enter a promotion uuid or code first' });
    return;
  }
  await runFetch({
    btn: $('#promotion-get'),
    outEl: $('#promotion-get-output'),
    url: '/api/promotion-details',
    body: () => formToObject(form),
    format: (data) => ({ json: data }),
    onData: (data) => stashFetchedConfig('promotionCrud', '#promotion-crud-insert', '#promotion-crud-json', data,
      PROMOTION_WRITABLE_FIELDS, promotionResponseToWritable),
  });
}

function readPromotionCrudJson() {
  const r = readJsonObjectField({
    inputSel: '#promotion-crud-json',
    errSel: '#promotion-crud-json-error',
    emptyMsg: 'Paste the promotion JSON first (get prefills it).',
    objectMsg: 'The promotion must be a JSON object.',
  });
  return r.ok ? r.value : null;
}

async function createPromotionRaw() {
  const payload = readPromotionCrudJson();
  if (!payload) return;
  await runFetch({
    btn: $('#promotion-raw-create'),
    outEl: $('#promotion-get-output'),
    url: '/api/promotion-raw',
    body: { payload },
  });
}

async function updatePromotionRaw() {
  const { searchKey, searchValue } = formToObject($('#promotion-get-form'));
  if (!searchValue) {
    showJson($('#promotion-get-output'), { error: 'enter the promotion uuid or code to update first' });
    return;
  }
  const payload = readPromotionCrudJson();
  if (!payload) return;
  await runFetch({
    btn: $('#promotion-raw-update'),
    outEl: $('#promotion-get-output'),
    method: 'PUT',
    url: '/api/promotion-raw',
    body: { searchKey, searchValue, payload },
  });
}

// ---- Promotion settings & handbill configuration ---------------------------

// Last successful GET result of each editor-backed module, feeding the
// "⤵ insert fetched" buttons.
const lastFetchedConfigs = { promoSettings: null, handbillConfig: null, promotionCrud: null };

// The GET endpoints wrap the object in { data: {…} } but the write endpoints
// expect the bare object — unwrap before editing.
function unwrapData(response) {
  return isPlainObject(response?.data) ? response.data : response;
}

// The PATCH body schema (handbillConfigUpdateRequest) accepts ONLY these
// fields — the GET additionally returns read-only ones (uuid, createdAt,
// updatedAt, userId, origin, …) which make the PATCH fail with a 422, so the
// editor is fed a filtered copy.
const HANDBILL_PATCH_FIELDS = ['channel', 'status', 'name', 'description', 'controlGroup', 'variants'];

// Remember the fetched object, enable the insert button, and prefill the
// editor when it's still empty — never clobber an edit in progress.
// `pick` (optional) limits the copy to the update endpoint's writable fields;
// `transform` (optional) adapts the fetched object first (e.g. renames).
function stashFetchedConfig(key, insertBtnSel, textareaSel, data, pick, transform) {
  if (!data?.ok || !isPlainObject(data.response)) return;
  let value = unwrapData(data.response);
  if (!isPlainObject(value)) return;
  if (transform) value = transform(value);
  if (pick) {
    value = Object.fromEntries(pick.filter((k) => k in value).map((k) => [k, value[k]]));
  }
  lastFetchedConfigs[key] = value;
  $(insertBtnSel).disabled = false;
  const ta = $(textareaSel);
  if (!ta.value.trim()) ta.value = JSON.stringify(value, null, 2);
}

// "⤵ insert fetched" — copy the stashed GET result into the editor,
// overwriting whatever is there.
function insertFetchedConfig(key, textareaSel, errSel) {
  const value = lastFetchedConfigs[key];
  if (!value) return;
  const ta = $(textareaSel);
  ta.value = JSON.stringify(value, null, 2);
  ta.classList.remove('invalid');
  $(errSel).hidden = true;
}

async function fetchPromotionSettings() {
  await runFetch({
    btn: $('#promotion-settings'),
    outEl: $('#promotion-settings-output'),
    method: 'GET',
    url: '/api/promotion-settings',
    onData: (data) => stashFetchedConfig('promoSettings', '#promotion-settings-insert', '#promotion-settings-json', data),
  });
}

function readPromotionSettingsJson() {
  const r = readJsonObjectField({
    inputSel: '#promotion-settings-json',
    errSel: '#promotion-settings-json-error',
    emptyMsg: 'Paste the settings JSON first (check prefills it).',
    objectMsg: 'Settings must be a JSON object, e.g. { "key": "value" }',
  });
  return r.ok ? r.value : null;
}

async function updatePromotionSettings() {
  const payload = readPromotionSettingsJson();
  if (!payload) return;
  await runFetch({
    btn: $('#promotion-settings-update'),
    outEl: $('#promotion-settings-output'),
    method: 'PUT',
    url: '/api/promotion-settings',
    body: payload,
  });
}

// First uuid from the handbill-configuration card's own picker (tolerates a
// pasted comma-separated list — only the first uuid is used).
function hbcfgUuid() {
  return splitCsv($('#hbcfg-uuid-input').value)[0] || '';
}

async function fetchHandbillConfigCard() {
  const uuid = hbcfgUuid();
  if (!uuid) {
    showJson($('#handbill-config-output'), { error: 'pick a handbillUuid first' });
    return;
  }
  await runFetch({
    btn: $('#handbill-config-get'),
    outEl: $('#handbill-config-output'),
    url: '/api/handbill-config',
    body: () => ({ handbillUuid: uuid }),
    onData: (data) => stashFetchedConfig('handbillConfig', '#handbill-config-insert', '#handbill-config-json', data, HANDBILL_PATCH_FIELDS),
  });
}

function readHandbillConfigJson() {
  const r = readJsonObjectField({
    inputSel: '#handbill-config-json',
    errSel: '#handbill-config-json-error',
    emptyMsg: 'Paste the handbill JSON first (check prefills it).',
    objectMsg: 'The handbill configuration must be a JSON object.',
  });
  return r.ok ? r.value : null;
}

async function updateHandbillConfig() {
  const uuid = hbcfgUuid();
  if (!uuid) {
    showJson($('#handbill-config-output'), { error: 'pick a handbillUuid first' });
    return;
  }
  const payload = readHandbillConfigJson();
  if (!payload) return;
  await runFetch({
    btn: $('#handbill-config-update'),
    outEl: $('#handbill-config-output'),
    method: 'PATCH',
    url: '/api/handbill-config',
    body: { handbillUuid: uuid, payload },
  });
}

// ---- Brickworks output -----------------------------------------------------

// Parse the optional Brickworks context textarea (must be a JSON object).
// Surfaces errors inline and throws so callers can abort the request.
function readBrickworksContext() {
  const r = readJsonObjectField({
    inputSel: '#brickworks-context',
    errSel: '#brickworks-context-error',
    objectMsg: 'Context must be a JSON object, e.g. { "key": "value" }',
    optional: true,
  });
  if (!r.ok) throw new Error('context is not a valid JSON object');
  return r.value;
}

function parseBrickworksSchemaIds() {
  const raw = $('#brickworks-schema-input').value || '';
  return splitCsv(raw);
}

async function fetchBrickworksPreview() {
  let context;
  try {
    context = readBrickworksContext();
  } catch {
    return;
  }
  const ids = parseBrickworksSchemaIds();
  if (ids.length === 0) {
    showJson($('#brickworks-output'), { error: 'pick a schema first (↻ fetches all schemas)' });
    return;
  }
  const recordIds = parseBrickworksRecordIds();
  let prelude = ids.length > 1
    ? `⚠ more than 1 schema is picked, previewing only the first one (${ids[0]})\n\n`
    : '';
  if (recordIds.length > 1) {
    prelude += `⚠ more than 1 record is picked, using only the first one (${recordIds[0]})\n\n`;
  }
  await runFetch({
    btn: $('#brickworks-preview'),
    outEl: $('#brickworks-output'),
    url: '/api/brickworks-preview',
    prelude,
    body: () => {
      const b = formToObject($('#brickworks-form'));
      b.schemaId = ids[0];
      if (recordIds.length > 0) b.recordId = recordIds[0];
      else delete b.recordId;
      if (context) b.context = context;
      return b;
    },
    format: (data) => ({ json: data }),
  });
}

function parseBrickworksRecordIds() {
  const raw = $('#brickworks-record-input').value || '';
  return splitCsv(raw);
}

// Generate the record output for a profile — the real generation path (emits
// the brickwork.generated event), as opposed to the preview dry run.
async function fetchBrickworksGenerate() {
  let context;
  try {
    context = readBrickworksContext();
  } catch {
    return;
  }
  const schemaIds = parseBrickworksSchemaIds();
  const recordIds = parseBrickworksRecordIds();
  if (schemaIds.length === 0 || recordIds.length === 0) {
    showJson($('#brickworks-output'), { error: 'pick a schema AND a record first (↻ next to each field)' });
    return;
  }
  const prelude = (schemaIds.length > 1 || recordIds.length > 1)
    ? `⚠ more than 1 schema/record is picked, generating only the first pair (${schemaIds[0]} / ${recordIds[0]})\n\n`
    : '';
  await runFetch({
    btn: $('#brickworks-generate'),
    outEl: $('#brickworks-output'),
    url: '/api/brickworks-generate',
    placeholder: 'generating…',
    prelude,
    body: () => {
      const b = formToObject($('#brickworks-form'));
      b.schemaId = schemaIds[0];
      b.recordId = recordIds[0];
      if (context) b.context = context;
      return b;
    },
    format: (data) => ({ json: data }),
  });
}

// ---- Cleanup -------------------------------------------------------------

async function listMatching() {
  const prefix = new FormData($('#cleanup-form')).get('prefix') || '';
  await runFetch({
    btn: $('#cleanup-list'),
    outEl: $('#cleanup-output'),
    method: 'GET',
    url: `/api/promotions?prefix=${encodeURIComponent(prefix)}`,
    format: (data) => {
      if (!data.ok) return defaultFormat(data);
      const list = (data.items || []).map((i, idx) =>
        `${idx + 1}. [${i.type}/${i.status}] ${i.headerName || i.name || '—'}  (${i.code})`
      ).join('\n');
      return { text: `Matched ${data.matched}/${data.total} promotions.\n\n${list || '(none)'}`, json: data };
    },
  });
}

async function deleteMatching() {
  const prefix = (new FormData($('#cleanup-form')).get('prefix') || '').toString().trim();
  const message = prefix
    ? `Delete all promotions with headerName starting with "${prefix}"?`
    : 'WARNING: no prefix — this will delete ALL promotions in the workspace. Continue?';
  if (!confirm(message)) return;
  if (!prefix && !confirm('Are you sure? This cannot be undone.')) return;
  await runFetch({
    btn: $('#cleanup-delete'),
    outEl: $('#cleanup-output'),
    url: '/api/promotions/delete',
    placeholder: 'deleting…',
    body: { prefix },
    format: (data) => {
      const summary = `${data.okCount ?? 0}/${data.total ?? 0} OK${data.failCount ? `, ${data.failCount} failed` : ''}`;
      const lines = (data.results || []).map((rr, i) =>
        `${i + 1}. [${rr.status}] ${rr.code}${rr.ok ? '' : '  ← FAIL'}`
      ).join('\n');
      return { text: `${summary}\n\n${lines}`, json: data };
    },
  });
}

// ---- Generic multi-select combo dropdown ---------------------------------

function createCombo({ inputSel, listSel, refreshBtnSel, toggleBtnSel, clearBtnSel, fetchUrl, valueKey, labelKey, emptyText }) {
  let cache = null;
  let query = '';
  const inputEl = $(inputSel);
  const listEl = $(listSel);

  const parseSelected = () => splitCsv(inputEl.value);
  const getSet = () => new Set(parseSelected());
  const writeSet = (set) => { inputEl.value = [...set].join(','); };

  function render(items) {
    listEl.innerHTML = '';
    if (!items || items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'combo-empty';
      empty.textContent = emptyText || 'No items. Click ↻ to load.';
      listEl.appendChild(empty);
      return;
    }
    const selected = getSet();

    const head = document.createElement('div');
    head.className = 'combo-head';
    listEl.appendChild(head);

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'combo-search';
    search.placeholder = 'Type to filter…';
    search.value = query;
    head.appendChild(search);

    const actions = document.createElement('div');
    actions.className = 'combo-actions';
    const selectAllBtn = document.createElement('button');
    selectAllBtn.type = 'button';
    selectAllBtn.textContent = 'Select all';
    const clearAllBtn = document.createElement('button');
    clearAllBtn.type = 'button';
    clearAllBtn.textContent = 'Clear all';
    actions.appendChild(selectAllBtn);
    actions.appendChild(clearAllBtn);
    head.appendChild(actions);

    const checkboxes = [];
    const rows = [];
    for (const it of items) {
      const value = it[valueKey];
      const item = document.createElement('label');
      item.className = 'combo-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = value;
      cb.checked = selected.has(value);
      checkboxes.push(cb);
      const meta = document.createElement('div');
      meta.className = 'meta';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = it[labelKey];
      const id = document.createElement('div');
      id.className = 'uuid';
      id.textContent = value;
      meta.appendChild(name);
      meta.appendChild(id);
      item.appendChild(cb);
      item.appendChild(meta);
      cb.addEventListener('change', () => {
        const set = getSet();
        if (cb.checked) set.add(value); else set.delete(value);
        writeSet(set);
      });
      rows.push({ item, cb, text: `${it[labelKey] ?? ''} ${value}`.toLowerCase() });
      listEl.appendChild(item);
    }

    // Checked items stay visible regardless of the query.
    function applyFilter() {
      const q = query.trim().toLowerCase();
      for (const row of rows) {
        row.item.hidden = q !== '' && !row.cb.checked && !row.text.includes(q);
      }
    }
    search.addEventListener('input', () => {
      query = search.value;
      applyFilter();
    });
    applyFilter();

    selectAllBtn.addEventListener('click', () => {
      const set = getSet();
      for (const row of rows) {
        if (row.item.hidden) continue;
        set.add(row.cb.value);
        row.cb.checked = true;
      }
      writeSet(set);
    });
    clearAllBtn.addEventListener('click', () => {
      inputEl.value = '';
      checkboxes.forEach((cb) => { cb.checked = false; });
    });
  }

  async function refresh() {
    const btn = $(refreshBtnSel);
    btn.disabled = true;
    listEl.hidden = false;
    listEl.innerHTML = '<div class="combo-empty">Loading…</div>';
    try {
      // fetchUrl may be a function so the URL can depend on other form state
      // (e.g. the records combo depends on the picked schema).
      const r = await fetch(typeof fetchUrl === 'function' ? fetchUrl() : fetchUrl);
      const data = await r.json();
      if (!r.ok || !data.ok) {
        listEl.innerHTML = `<div class="combo-empty">Error: ${data.error || r.status}</div>`;
        return;
      }
      cache = data.items;
      render(cache);
    } catch (err) {
      listEl.innerHTML = `<div class="combo-empty">Error: ${err.message}</div>`;
    } finally {
      btn.disabled = false;
    }
  }

  function toggle() {
    if (!listEl.hidden) { listEl.hidden = true; return; }
    if (!cache) { refresh(); return; }
    render(cache);
    listEl.hidden = false;
    listEl.querySelector('.combo-search')?.focus();
  }

  function clearSelection() {
    inputEl.value = '';
    if (!listEl.hidden && cache) render(cache);
  }

  $(refreshBtnSel).addEventListener('click', refresh);
  $(toggleBtnSel).addEventListener('click', toggle);
  $(clearBtnSel).addEventListener('click', clearSelection);

  return { refresh, toggle, clearSelection };
}

// ---- Copy curl -----------------------------------------------------------

function shellEscape(s) {
  // Single-quote-wrap the value and escape any embedded single quotes.
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

function buildCurl({ method, url, headers = {}, body }) {
  const parts = [`curl -X ${method} ${shellEscape(url)}`];
  for (const [k, v] of Object.entries(headers)) {
    parts.push(`  -H ${shellEscape(`${k}: ${v}`)}`);
  }
  if (body !== undefined) {
    const json = typeof body === 'string' ? body : JSON.stringify(body);
    parts.push(`  --data-raw ${shellEscape(json)}`);
  }
  return parts.join(' \\\n');
}

async function getTokenForCurl() {
  const r = await fetch('/api/token');
  const data = await r.json();
  if (!r.ok || !data.token) throw new Error(data.error || 'no token');
  return { token: data.token, apiBase: data.apiBase };
}

function rand5Now() { return String(Math.floor(Math.random() * 100000)).padStart(5, '0'); }
function isoCompactNow() {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}
function renderTpl(tpl, ctx) {
  return String(tpl)
    .replaceAll('{rand5}', ctx.rand5)
    .replaceAll('{date}', ctx.date)
    .replaceAll('{serial}', ctx.serial)
    .replaceAll('{iso}', ctx.iso);
}
// Render placeholders in every string value of a JSON tree (mirrors the server).
function renderTplDeep(node, ctx) {
  if (typeof node === 'string') return renderTpl(node, ctx);
  if (Array.isArray(node)) return node.map((v) => renderTplDeep(v, ctx));
  if (isPlainObject(node)) {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = renderTplDeep(v, ctx);
    return out;
  }
  return node;
}

// Mirrors the per-action server logic. Returns a curl string (or a small
// shell snippet for multi-request actions) representing the Synerise call
// the button would trigger right now.
function buildCurlForAction(action, { token, apiBase }) {
  const authHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };

  if (action === 'promotions-fetch') {
    const { identifierType, identifierValue } = formToObject($('#handbill-form'));
    if (!identifierType || !identifierValue) throw new Error('identifierType + identifierValue required');
    const qs = [
      ...collectFilterParams().map((f) => `${encodeURIComponent(f.name)}=${encodeURIComponent(f.value)}`),
      ...collectSortParams().map((s) => `sort=${encodeURIComponent(s)}`),
    ].join('&');
    const url = `${apiBase}/v4/promotions/v2/promotion/get-for-client/${encodeURIComponent(identifierType)}/${encodeURIComponent(identifierValue)}${qs ? `?${qs}` : ''}`;
    return buildCurl({ method: 'GET', url, headers: authHeaders });
  }

  if (action === 'handbill-fetch') {
    const { identifierType, identifierValue } = formToObject($('#handbill-form'));
    const uuids = parseSelectedUuids();
    if (!identifierType || !identifierValue || uuids.length === 0) throw new Error('identifier + at least one handbillUuid required');
    const url = `${apiBase}/v4/promotions/v2/promotion/get-for-client/${encodeURIComponent(identifierType)}/${encodeURIComponent(identifierValue)}/handbill/${encodeURIComponent(uuids[0])}`;
    return buildCurl({ method: 'GET', url, headers: authHeaders });
  }

  if (action === 'handbill-batch') {
    const { identifierType, identifierValue } = formToObject($('#handbill-form'));
    const uuids = parseSelectedUuids();
    if (!identifierType || !identifierValue || uuids.length === 0) throw new Error('identifier + at least one handbillUuid required');
    const qs = uuids.map((u) => `handbillUuid=${encodeURIComponent(u)}`).join('&');
    const url = `${apiBase}/v4/promotions/promotion/get-for-client/${encodeURIComponent(identifierType)}/${encodeURIComponent(identifierValue)}/with-handbills?${qs}`;
    return buildCurl({ method: 'GET', url, headers: authHeaders });
  }

  if (action === 'handbill-config') {
    const uuids = parseSelectedUuids();
    if (uuids.length === 0) throw new Error('at least one handbillUuid required');
    const url = `${apiBase}/v4/promotions/handbill/${encodeURIComponent(uuids[0])}`;
    return buildCurl({ method: 'GET', url, headers: authHeaders });
  }

  if (action === 'process-sale' || action === 'process-checkout') {
    const o = formToObject($('#pos-form'));
    const posType = { clientId: 'clientId', uuid: 'uuid', customId: 'externalId', email: 'email' }[o.identifierType];
    if (!posType || !o.identifierValue) throw new Error('identifierType + identifierValue required');
    const body = readPosJson();
    if (!body) throw new Error('fix the transaction JSON first');
    const ctx = { rand5: rand5Now(), date: isoCompactNow(), iso: new Date().toISOString(), serial: '1' };
    const path = action === 'process-checkout'
      ? '/v4/promotions/sale/process-checkout'
      : '/v4/promotions/v2/sale/process-sale';
    return buildCurl({
      method: 'POST',
      url: `${apiBase}${path}/${encodeURIComponent(posType)}/${encodeURIComponent(o.identifierValue)}`,
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: renderTplDeep(body, ctx),
    });
  }

  if (action === 'promotion-get') {
    const o = formToObject($('#promotion-get-form'));
    if (!o.searchValue) throw new Error('enter a promotion uuid or code');
    return buildCurl({
      method: 'GET',
      url: `${apiBase}/v4/promotions/promotion/${encodeURIComponent(o.searchKey || 'uuid')}/${encodeURIComponent(o.searchValue)}`,
      headers: authHeaders,
    });
  }

  if (action === 'promotion-raw-create') {
    const payload = readPromotionCrudJson();
    if (!payload) throw new Error('promotion JSON required');
    return buildCurl({
      method: 'POST',
      url: `${apiBase}/v4/promotions/promotion`,
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: payload,
    });
  }

  if (action === 'promotion-raw-update') {
    const o = formToObject($('#promotion-get-form'));
    if (!o.searchValue) throw new Error('enter a promotion uuid or code');
    const payload = readPromotionCrudJson();
    if (!payload) throw new Error('promotion JSON required');
    return buildCurl({
      method: 'PUT',
      url: `${apiBase}/v4/promotions/promotion/${encodeURIComponent(o.searchKey || 'uuid')}/${encodeURIComponent(o.searchValue)}`,
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: payload,
    });
  }

  if (action === 'promotion-create') {
    const o = formToObject($('#promotion-form'));
    const count = Math.max(1, Math.min(Number(o.count) || 1, 100));
    const ctx = { rand5: rand5Now(), date: isoCompactNow(), iso: new Date().toISOString(), serial: '1' };
    const headerName = renderTpl(o.headerName || 'test-{rand5}-{date}-{serial}', ctx);
    const codeTpl = (o.code && o.code.trim()) ? o.code.trim() : '{headerName}';
    const code = renderTpl(codeTpl.replaceAll('{headerName}', headerName), ctx);
    const tagHashes = splitCsv(o.tagHash);
    const payload = {
      visibilityStatus: 'PUBLISH',
      type: o.type || 'HANDBILL',
      code,
      name: headerName,
      headerName,
      headerDescription: renderTpl(o.headerDescription || 'desc-{rand5}-{date}-{serial}', ctx),
      startAt: o.startAt ? new Date(o.startAt).toISOString() : null,
      expireAt: o.expireAt ? new Date(o.expireAt).toISOString() : null,
      params: {},
      catalog: o.catalog || '221',
      storeItemType: 'ALL',
      targetType: 'ALL',
      price: 0,
      priority: o.priority ? Number(o.priority) : 250,
      importHash: crypto.randomUUID ? crypto.randomUUID() : 'replace-me-with-uuid',
    };
    if (o.redeemLimitPerClient) payload.redeemLimitPerClient = Number(o.redeemLimitPerClient);
    if (tagHashes.length) payload.tags = tagHashes.map((hash) => ({ hash }));
    const customFields = readCustomFields();
    if (customFields) deepMerge(payload, customFields);
    const curl = buildCurl({
      method: 'POST',
      url: `${apiBase}/v4/promotions/promotion`,
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: payload,
    });
    return count > 1
      ? `# count=${count} — repeat this call ${count} times; placeholders re-roll each request\n${curl}`
      : curl;
  }

  if (action === 'voucher-create') {
    const pools = parseVoucherPoolUuids();
    if (pools.length === 0) throw new Error('pick a voucher pool first');
    const o = formToObject($('#voucher-form'));
    const count = Math.max(1, Math.min(Number(o.count) || 1, 100));
    const ctx = { rand5: rand5Now(), date: isoCompactNow(), iso: new Date().toISOString(), serial: '1' };
    const payload = { poolUuid: pools[0] };
    if (o.code && o.code.trim()) payload.code = renderTpl(o.code.trim(), ctx);
    if (o.clientUuid) payload.clientUuid = o.clientUuid.trim();
    if (o.clientId) payload.clientId = Number(o.clientId);
    if (o.expireIn) payload.expireIn = new Date(o.expireIn).toISOString();
    if (o.status) payload.status = o.status;
    const curl = buildCurl({
      method: 'POST',
      url: `${apiBase}/v4/vouchers/item`,
      headers: { ...authHeaders, 'Content-Type': 'application/json', 'Api-Version': API_VERSION },
      body: payload,
    });
    return count > 1
      ? `# count=${count} — repeat this call ${count} times; code placeholders re-roll each request\n${curl}`
      : curl;
  }

  if (action === 'voucher-check') {
    const o = formToObject($('#voucher-check-form'));
    if (!o.searchValue) throw new Error('enter a code or uuid');
    return buildCurl({
      method: 'GET',
      url: `${apiBase}/v4/vouchers/item/${encodeURIComponent(o.searchKey || 'code')}/${encodeURIComponent(o.searchValue)}`,
      headers: { ...authHeaders, 'Api-Version': API_VERSION },
    });
  }

  if (action === 'voucher-redeem') {
    const o = formToObject($('#voucher-check-form'));
    if ((o.searchKey || 'code') !== 'code') throw new Error('redeem works by code');
    if (!o.searchValue) throw new Error('enter a code');
    return buildCurl({
      method: 'POST',
      url: `${apiBase}/v4/vouchers/item/redeem`,
      headers: { ...authHeaders, 'Content-Type': 'application/json', 'Api-Version': API_VERSION },
      body: { code: o.searchValue },
    });
  }

  if (action === 'voucher-batch-redeem') {
    const o = batchRedeemBody();
    if (!o.profileValue) throw new Error('profileKey + profileValue required');
    const codes = splitCsv(o.codes);
    if (codes.length === 0) throw new Error('enter at least one code');
    const items = codes.map((code) => ({ profileKey: o.profileKey, profileValue: o.profileValue, voucherKey: 'code', voucherValue: code }));
    return buildCurl({
      method: 'POST',
      url: `${apiBase}/v4/promotions/voucher/batch-redeem-for-profile`,
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: items,
    });
  }

  if (action === 'pool-list' || action === 'vouchers-in-pool') {
    const paging = poolPagingParams();
    const qs = new URLSearchParams({
      limit: String(paging.limit),
      page: String(paging.page),
      includeMeta: String(paging.includeMeta),
    });
    if (action === 'pool-list') {
      return buildCurl({
        method: 'GET',
        url: `${apiBase}/v4/vouchers/pool/list?${qs}`,
        headers: { ...authHeaders, 'Api-Version': API_VERSION },
      });
    }
    const pools = parsePoolUuids();
    if (pools.length === 0) throw new Error('pick a voucher pool first');
    return buildCurl({
      method: 'GET',
      url: `${apiBase}/v4/vouchers/item/list/${encodeURIComponent(pools[0])}?${qs}`,
      headers: { ...authHeaders, 'Api-Version': API_VERSION },
    });
  }

  if (action === 'vouchers-for-client') {
    const o = formToObject($('#vouchers-client-form'));
    const name = PROFILE_ID_TYPES[o.identifierType];
    if (!name || !o.identifierValue) throw new Error('identifierType + identifierValue required');
    const qs = new URLSearchParams({ clientIdentifierName: name, clientIdentifierValue: o.identifierValue });
    return buildCurl({
      method: 'GET',
      url: `${apiBase}/v4/vouchers/item/get-assigned-for-client/by-identifier?${qs}`,
      headers: { ...authHeaders, 'Api-Version': API_VERSION },
    });
  }

  if (action === 'event-add') {
    const o = formToObject($('#event-form'));
    const clientKey = { clientId: 'id', uuid: 'uuid', customId: 'customId', email: 'email' }[o.identifierType];
    if (!clientKey || !o.identifierValue) throw new Error('identifierType + identifierValue required');
    if (eventKind === 'transaction') {
      const tpl = readTxnPayload();
      const ctx = { rand5: rand5Now(), date: isoCompactNow(), iso: new Date().toISOString(), serial: '1' };
      const renderDeep = (node) => {
        if (typeof node === 'string') return renderTpl(node, ctx);
        if (Array.isArray(node)) return node.map(renderDeep);
        if (isPlainObject(node)) return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, renderDeep(v)]));
        return node;
      };
      delete tpl.client;
      const payload = { ...renderDeep(tpl), client: { [clientKey]: clientKey === 'id' ? Number(o.identifierValue) : o.identifierValue } };
      const count = Math.max(1, Math.min(Number(o.count) || 1, 100));
      const curl = buildCurl({
        method: 'POST',
        url: `${apiBase}/v4/transactions`,
        headers: { ...authHeaders, 'Content-Type': 'application/json', 'Api-Version': API_VERSION },
        body: payload,
      });
      return count > 1
        ? `# count=${count} — repeat this call ${count} times; string placeholders re-roll each request\n${curl}`
        : curl;
    }
    if (!/^\S+\.\S+$/.test((o.action || '').trim())) throw new Error('action must be noun.verb');
    if (!o.label || !o.label.trim()) throw new Error('label required');
    const count = Math.max(1, Math.min(Number(o.count) || 1, 100));
    const ctx = { rand5: rand5Now(), date: isoCompactNow(), iso: new Date().toISOString(), serial: '1' };
    const payload = {
      action: o.action.trim(),
      label: renderTpl(o.label.trim(), ctx),
      client: { [clientKey]: clientKey === 'id' ? Number(o.identifierValue) : o.identifierValue },
    };
    if (o.time) payload.time = new Date(o.time).toISOString();
    if (o.eventSalt && o.eventSalt.trim()) payload.eventSalt = renderTpl(o.eventSalt.trim(), ctx);
    const params = readEventParams();
    if (params) payload.params = params;
    const curl = buildCurl({
      method: 'POST',
      url: `${apiBase}/v4/events/custom`,
      headers: { ...authHeaders, 'Content-Type': 'application/json', 'Api-Version': API_VERSION },
      body: payload,
    });
    return count > 1
      ? `# count=${count} — repeat this call ${count} times; label/eventSalt placeholders re-roll each request\n${curl}`
      : curl;
  }

  if (action === 'batch-import') {
    const codes = parseBatchCodes();
    if (codes.length === 0) throw new Error('no codes to overwrite');
    const segs = parseBatchSegments();
    if (segs.length === 0) throw new Error('targetSegment required');
    // Partial merge/upsert by code — send only the target fields; everything
    // else on the existing promotion is left untouched.
    const items = codes.map((code) => ({ code, targetType: 'SEGMENT', targetSegment: segs }));
    return buildCurl({
      method: 'POST',
      url: `${apiBase}/v4/promotions/v2/promotion/batch`,
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: { data: items },
    });
  }

  if (action === 'brickworks-preview') {
    const { identifierType, identifierValue } = formToObject($('#brickworks-form'));
    const bwType = PROFILE_ID_TYPES[identifierType];
    const ids = parseBrickworksSchemaIds();
    if (!bwType || !identifierValue || ids.length === 0) throw new Error('identifier + schema required');
    const recordIds = parseBrickworksRecordIds();
    const context = readBrickworksContext();
    const getSchema = buildCurl({
      method: 'GET',
      url: `${apiBase}/brickworks/v1/schemas/${encodeURIComponent(ids[0])}`,
      headers: authHeaders,
    });
    const post = buildCurl({
      method: 'POST',
      url: `${apiBase}/brickworks/v1/schemas/records/preview/by/${bwType}`,
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: {
        identifierValue,
        ...(context ? { context } : {}),
        schema: '<SCHEMA_JSON>',
        ...(recordIds.length > 0 ? { values: '<RECORD_VALUES_JSON>' } : {}),
      },
    });
    const lines = ['# Step 1 — fetch the full schema:', getSchema];
    if (recordIds.length > 0) {
      const getRecord = buildCurl({
        method: 'GET',
        url: `${apiBase}/brickworks/v1/schemas/${encodeURIComponent(ids[0])}/records/${encodeURIComponent(recordIds[0])}`,
        headers: authHeaders,
      });
      lines.push('', '# Step 2 — fetch the record:', getRecord,
        '', '# Step 3 — preview: replace "<SCHEMA_JSON>" with step 1 and "<RECORD_VALUES_JSON>" with the `values` object from step 2.',
        '# NOTE: for SINGLETON schemas omit `values` entirely — the API rejects it and renders the record implicitly:', post);
    } else {
      lines.push('', '# Step 2 — preview: replace "<SCHEMA_JSON>" with the response from step 1:', post);
    }
    return lines.join('\n');
  }

  if (action === 'brickworks-generate') {
    const { identifierType, identifierValue } = formToObject($('#brickworks-form'));
    const bwType = PROFILE_ID_TYPES[identifierType];
    const schemaIds = parseBrickworksSchemaIds();
    const recordIds = parseBrickworksRecordIds();
    if (!bwType || !identifierValue || schemaIds.length === 0 || recordIds.length === 0) throw new Error('identifier + schema + record required');
    const context = readBrickworksContext();
    return buildCurl({
      method: 'POST',
      url: `${apiBase}/brickworks/v1/schemas/${encodeURIComponent(schemaIds[0])}/records/${encodeURIComponent(recordIds[0])}/generate/by/${bwType}`,
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: { identifierValue, ...(context ? { context } : {}) },
    });
  }

  if (action === 'promotion-settings') {
    return buildCurl({
      method: 'GET',
      url: `${apiBase}/v4/promotions/settings`,
      headers: authHeaders,
    });
  }

  if (action === 'promotion-settings-update') {
    const payload = readPromotionSettingsJson();
    if (!payload) throw new Error('settings JSON required');
    return buildCurl({
      method: 'PUT',
      url: `${apiBase}/v4/promotions/settings`,
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: payload,
    });
  }

  if (action === 'handbill-config-get') {
    const uuid = hbcfgUuid();
    if (!uuid) throw new Error('handbillUuid required');
    return buildCurl({
      method: 'GET',
      url: `${apiBase}/v4/promotions/handbill/${encodeURIComponent(uuid)}`,
      headers: authHeaders,
    });
  }

  if (action === 'handbill-config-update') {
    const uuid = hbcfgUuid();
    if (!uuid) throw new Error('handbillUuid required');
    const payload = readHandbillConfigJson();
    if (!payload) throw new Error('handbill JSON required');
    return buildCurl({
      method: 'PATCH',
      url: `${apiBase}/v4/promotions/handbill/${encodeURIComponent(uuid)}`,
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: payload,
    });
  }

  if (action === 'cleanup-list') {
    return buildCurl({
      method: 'GET',
      url: `${apiBase}/v4/promotions/promotion/list?limit=1000`,
      headers: authHeaders,
    });
    // (Prefix filtering is done client-side in this app — the Synerise API
    // doesn't expose a prefix filter on this endpoint.)
  }

  if (action === 'cleanup-delete') {
    const list = buildCurl({
      method: 'GET',
      url: `${apiBase}/v4/promotions/promotion/list?limit=1000`,
      headers: authHeaders,
    });
    const del = buildCurl({
      method: 'DELETE',
      url: `${apiBase}/v4/promotions/promotion`,
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: { value: '<CODE>' },
    });
    return [
      '# Step 1 — list, then filter locally by headerName prefix:',
      list,
      '',
      '# Step 2 — repeat this DELETE for each matching <CODE>:',
      del,
    ].join('\n');
  }

  throw new Error(`Unknown action: ${action}`);
}

async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

async function handleCurlClick(e) {
  const btn = e.currentTarget;
  const action = btn.dataset.action;
  const originalText = btn.textContent;
  btn.classList.remove('copied', 'err');
  btn.disabled = true;
  try {
    const auth = await getTokenForCurl();
    const curl = buildCurlForAction(action, auth);
    await copyToClipboard(curl);
    btn.classList.add('copied');
    btn.textContent = 'copied ✓';
  } catch (err) {
    btn.classList.add('err');
    btn.textContent = err.message.length > 40 ? 'error' : err.message;
    console.error('[curl]', err);
  } finally {
    setTimeout(() => {
      btn.classList.remove('copied', 'err');
      btn.textContent = originalText;
      btn.disabled = false;
    }, 1600);
  }
}

// ---- Global client identifier (top bar) ------------------------------------
//
// The top bar holds the ONE client identifier every section targets. The
// forms keep hidden identifierType/identifierValue inputs so formToObject and
// the curl builders work unchanged — this just mirrors the top bar into them.

const IDENTIFIER_STORAGE_KEY = 'handbill-tests.identifier';

function syncGlobalIdentifier() {
  const type = $('#global-identifier-type').value;
  const value = $('#global-identifier-value').value.trim();
  document.querySelectorAll('input[type="hidden"][name="identifierType"]').forEach((el) => { el.value = type; });
  document.querySelectorAll('input[type="hidden"][name="identifierValue"]').forEach((el) => { el.value = value; });
  try { localStorage.setItem(IDENTIFIER_STORAGE_KEY, JSON.stringify({ type, value })); } catch { /* private mode */ }
}

function initGlobalIdentifier() {
  try {
    const saved = JSON.parse(localStorage.getItem(IDENTIFIER_STORAGE_KEY) || 'null');
    if (saved?.type) $('#global-identifier-type').value = saved.type;
    if (saved?.value) $('#global-identifier-value').value = saved.value;
  } catch { /* ignore corrupt storage */ }
  $('#global-identifier-type').addEventListener('change', syncGlobalIdentifier);
  $('#global-identifier-value').addEventListener('input', syncGlobalIdentifier);
  syncGlobalIdentifier();
}

// ---- Workspaces (top bar) ---------------------------------------------------
//
// A workspace = a named Synerise API key. The key itself never lives in the
// browser: the server keeps it in the platform keystore (macOS Keychain,
// Windows Credential Manager, libsecret) and the browser only mirrors
// { id, name } from GET /api/workspaces. The special "(.env key)" entry is
// whatever SYNERISE_API_KEY the server booted with. Only the id of the active
// workspace is remembered locally, in sessionStorage — so a new tab starts on
// the .env key rather than inheriting someone else's pick.
//
// The two legacy browser stores below (session/local entries that used to hold
// plaintext keys) are read once on boot to migrate old workspaces into the
// keystore, then cleared.

const WS_SESSION_KEY = 'handbill-tests.workspaces.session';
const WS_LOCAL_KEY = 'handbill-tests.workspaces.remembered';
const WS_ACTIVE_KEY = 'handbill-tests.workspace.active';
const ENV_WORKSPACE_ID = '__env__';

let serverWorkspaces = [];
let workspaceStoreName = 'system keychain'; // refined from GET /api/workspaces

function readWorkspaceStore(storage, key) {
  try {
    const v = JSON.parse(storage.getItem(key) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

async function refreshWorkspaces() {
  try {
    const r = await fetch('/api/workspaces');
    const data = await r.json();
    if (r.ok && data.ok) {
      serverWorkspaces = data.workspaces;
      if (data.store) {
        workspaceStoreName = data.store;
        const note = document.querySelector('.workspace-remember');
        if (note) note.textContent = `stored in the ${data.store} 🔒`;
      }
    }
  } catch { /* server unreachable — keep the last list */ }
}

// One-time import of keys saved by older versions in browser storage: push
// them to the Keychain (the server dedupes re-imports from other browsers),
// then wipe the plaintext copies. Kept if the server rejects them, so a
// failed migration can retry on the next load.
async function migrateBrowserWorkspaces() {
  const legacy = [
    ...readWorkspaceStore(localStorage, WS_LOCAL_KEY),
    ...readWorkspaceStore(sessionStorage, WS_SESSION_KEY),
  ].filter((w) => w && typeof w.apiKey === 'string' && w.apiKey);
  if (!legacy.length) return;
  for (const w of legacy) {
    try {
      const r = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: w.name, apiKey: w.apiKey }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`);
    } catch (err) {
      console.warn('workspace migration failed, keeping browser copy:', err.message);
      return;
    }
  }
  try {
    localStorage.removeItem(WS_LOCAL_KEY);
    sessionStorage.removeItem(WS_SESSION_KEY);
  } catch { /* private mode */ }
  console.info(`migrated ${legacy.length} workspace key(s) to the system keystore`);
}

function activeWorkspaceId() {
  return sessionStorage.getItem(WS_ACTIVE_KEY) || ENV_WORKSPACE_ID;
}

function renderWorkspaceSelect() {
  const sel = $('#workspace-select');
  const active = activeWorkspaceId();
  sel.innerHTML = '';
  const envOpt = document.createElement('option');
  envOpt.value = ENV_WORKSPACE_ID;
  envOpt.textContent = '(.env key)';
  sel.append(envOpt);
  for (const w of serverWorkspaces) {
    const o = document.createElement('option');
    o.value = w.id;
    o.textContent = w.name;
    o.title = `key stored in the ${workspaceStoreName}`;
    sel.append(o);
  }
  sel.value = [...sel.options].some((o) => o.value === active) ? active : ENV_WORKSPACE_ID;
}

function setWorkspaceStatus(html) {
  $('#workspace-status').innerHTML = html || '';
}

async function activateWorkspace(id) {
  const sel = $('#workspace-select');
  sel.disabled = true;
  setWorkspaceStatus('switching…');
  try {
    let r;
    if (id === ENV_WORKSPACE_ID) {
      r = await fetch('/api/apikey/reset', { method: 'POST' });
    } else {
      r = await fetch(`/api/workspaces/${encodeURIComponent(id)}/activate`, { method: 'POST' });
    }
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`);
    try { sessionStorage.setItem(WS_ACTIVE_KEY, id); } catch { /* private mode */ }
    setWorkspaceStatus('<span class="ok">✓</span>');
    loadToken();
  } catch (err) {
    setWorkspaceStatus(`<span class="err">${err.message}</span>`);
  } finally {
    renderWorkspaceSelect(); // reverts the <select> to the stored active on failure
    sel.disabled = false;
  }
}

async function addWorkspace() {
  const apiKey = ($('#workspace-key').value || '').trim();
  const statusEl = $('#workspace-add-status');
  if (!apiKey) {
    statusEl.innerHTML = '<span class="err">paste an API key</span>';
    return;
  }
  const name = ($('#workspace-name').value || '').trim();
  const btn = $('#workspace-add-btn');
  btn.disabled = true;
  statusEl.textContent = 'validating…';
  try {
    const r = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, apiKey }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) {
      statusEl.innerHTML = `<span class="err">invalid: ${data.error || r.status}</span>`;
      return;
    }
    await refreshWorkspaces();
    $('#workspace-name').value = '';
    $('#workspace-key').value = '';
    statusEl.textContent = '';
    $('#workspace-add').hidden = true;
    await activateWorkspace(data.id); // renders the select + sets the status
  } catch (err) {
    statusEl.innerHTML = `<span class="err">${err.message}</span>`;
  } finally {
    btn.disabled = false;
  }
}

async function forgetActiveWorkspace() {
  const id = $('#workspace-select').value;
  if (id === ENV_WORKSPACE_ID) {
    setWorkspaceStatus('<span class="err">the .env key can\'t be forgotten here</span>');
    return;
  }
  const ws = serverWorkspaces.find((w) => w.id === id);
  if (ws && !window.confirm(`Forget workspace "${ws.name}"? The key is removed from the ${workspaceStoreName} (the server keeps whatever key is currently active).`)) return;
  try {
    const r = await fetch(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`);
  } catch (err) {
    setWorkspaceStatus(`<span class="err">${err.message}</span>`);
    return;
  }
  if (activeWorkspaceId() === id) {
    try { sessionStorage.removeItem(WS_ACTIVE_KEY); } catch { /* private mode */ }
  }
  await refreshWorkspaces();
  renderWorkspaceSelect();
  setWorkspaceStatus('');
}

async function initWorkspaces() {
  renderWorkspaceSelect(); // shows (.env key) instantly while the list loads
  $('#workspace-select').addEventListener('change', (e) => activateWorkspace(e.target.value));
  $('#workspace-add-toggle').addEventListener('click', () => {
    const panel = $('#workspace-add');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) $('#workspace-key').focus();
  });
  $('#workspace-add-btn').addEventListener('click', addWorkspace);
  $('#workspace-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addWorkspace(); } });
  $('#workspace-remove').addEventListener('click', forgetActiveWorkspace);
  await migrateBrowserWorkspaces();
  await refreshWorkspaces();
  renderWorkspaceSelect();
  // Re-point the server at the active workspace on load — covers a server
  // restart that reverted to the .env key while the UI still shows another.
  const active = activeWorkspaceId();
  if (active !== ENV_WORKSPACE_ID && serverWorkspaces.some((w) => w.id === active)) {
    activateWorkspace(active);
  }
}

// ---- Tabs & section manager -------------------------------------------------

// Cards of the Testing tab, grouped by domain. The Settings tab lets the user
// reorder cards within a group, reorder whole groups, and toggle visibility
// per card, per group, or globally. The choice persists per browser.
const SECTION_GROUPS = [
  { id: 'handbills', title: 'Handbills' },
  { id: 'promotions', title: 'Promotions & POS' },
  { id: 'vouchers', title: 'Vouchers' },
  { id: 'profile', title: 'Profile & data' },
];
const SECTION_DEFS = [
  { id: 'sec-fetch', title: 'Fetch handbill', group: 'handbills' },
  { id: 'sec-handbill-config', title: 'Handbill configuration', group: 'handbills' },
  { id: 'sec-promo-get', title: 'Promotion: get / create / update', group: 'promotions' },
  { id: 'sec-create', title: 'Create promotions', group: 'promotions' },
  { id: 'sec-batch', title: 'Batch overwrite (targetSegment)', group: 'promotions' },
  { id: 'sec-cleanup', title: 'Cleanup promotions', group: 'promotions' },
  { id: 'sec-promo-settings', title: 'Promotion settings', group: 'promotions' },
  { id: 'sec-pos', title: 'Process basket / checkout (POS)', group: 'promotions' },
  { id: 'sec-voucher-pools', title: 'Voucher pools', group: 'vouchers' },
  { id: 'sec-vouchers', title: 'Vouchers', group: 'vouchers' },
  { id: 'sec-events', title: 'Add event/transaction to profile', group: 'profile' },
  { id: 'sec-brickworks', title: 'Brickworks output', group: 'profile' },
];
const SECTIONS_STORAGE_KEY = 'handbill-tests.sections';
const SECTION_GROUPS_STORAGE_KEY = 'handbill-tests.sections.groups';

// Display order of the groups — reorderable via ↑/↓ on the group headers.
// Unknown ids are dropped, missing ones appended in the default order.
function loadGroupOrder() {
  let stored = [];
  try {
    const raw = JSON.parse(localStorage.getItem(SECTION_GROUPS_STORAGE_KEY) || '[]');
    if (Array.isArray(raw)) stored = raw;
  } catch { /* corrupted storage — fall back to defaults */ }
  const order = stored.filter((id) => SECTION_GROUPS.some((g) => g.id === id));
  for (const g of SECTION_GROUPS) {
    if (!order.includes(g.id)) order.push(g.id);
  }
  return order;
}

let sectionGroupOrder = loadGroupOrder();

const sectionGroupOf = (id) => SECTION_DEFS.find((d) => d.id === id)?.group;
const sectionGroupIndexOf = (id) => sectionGroupOrder.indexOf(sectionGroupOf(id));

// Stable-sort the flat config so groups are contiguous and in SECTION_GROUPS
// order; the user's order within each group is preserved. Also migrates
// configs saved before grouping existed.
function normalizeSectionOrder(config) {
  return config.slice().sort((a, b) => sectionGroupIndexOf(a.id) - sectionGroupIndexOf(b.id));
}

// Returns [{ id, enabled }] in display order. Unknown ids are dropped and
// missing ones appended enabled, so adding a new card to the app never
// leaves it invisible for users with an older saved config.
function loadSectionConfig() {
  let stored = [];
  try {
    const raw = JSON.parse(localStorage.getItem(SECTIONS_STORAGE_KEY) || '[]');
    if (Array.isArray(raw)) stored = raw;
  } catch { /* corrupted storage — fall back to defaults */ }
  const config = stored
    .filter((e) => e && SECTION_DEFS.some((d) => d.id === e.id))
    .map((e) => ({ id: e.id, enabled: e.enabled !== false }));
  for (const d of SECTION_DEFS) {
    if (!config.some((e) => e.id === d.id)) config.push({ id: d.id, enabled: true });
  }
  return normalizeSectionOrder(config);
}

let sectionConfig = loadSectionConfig();

// Reorder/hide the cards in the Testing tab and renumber the visible ones.
function applySectionConfig() {
  const view = $('#view-testing');
  let n = 0;
  for (const entry of sectionConfig) {
    const el = document.getElementById(entry.id);
    if (!el) continue;
    view.appendChild(el);
    el.hidden = !entry.enabled;
    el.querySelector('.sec-num').textContent = entry.enabled ? `${++n}. ` : '';
  }
}

// Row / group box currently being dragged in the section manager (null
// outside a drag).
let draggedSectionRow = null;
let draggedGroupBox = null;

function renderSectionManager() {
  const list = $('#section-manager');
  list.innerHTML = '';
  let visible = 0;
  let lastGroup = null;
  let groupBox = null;
  sectionConfig.forEach((entry, i) => {
    const group = sectionGroupOf(entry.id);
    if (group !== lastGroup) {
      lastGroup = group;
      // Each group lives in its own box (header + rows), so the whole group
      // can be dragged as one element.
      groupBox = document.createElement('div');
      groupBox.className = 'section-group';
      groupBox.dataset.group = group;
      list.appendChild(groupBox);

      const head = document.createElement('div');
      head.className = 'section-group-head';

      const gHandle = document.createElement('span');
      gHandle.className = 'drag-handle';
      gHandle.textContent = '⠿';
      gHandle.title = 'Drag to reorder groups';

      const box = groupBox; // freeze for the listeners below
      head.draggable = true;
      head.addEventListener('dragstart', (e) => {
        draggedGroupBox = box;
        box.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', group);
        e.dataTransfer.setDragImage(box, 12, 12);
      });
      head.addEventListener('dragend', () => {
        box.classList.remove('dragging');
        if (!draggedGroupBox) return;
        draggedGroupBox = null;
        // The dragover handler already moved the box in the DOM — read the
        // final group order back and persist it.
        sectionGroupOrder = [...list.querySelectorAll('.section-group')].map((b) => b.dataset.group);
        sectionConfig = normalizeSectionOrder(sectionConfig);
        commitSectionConfig();
      });

      const title = document.createElement('span');
      title.className = 'section-group-title';
      title.textContent = SECTION_GROUPS.find((g) => g.id === group)?.title || group;

      // ↑/↓ move the whole group (with its cards) among the other groups.
      const gi = sectionGroupOrder.indexOf(group);
      const gUp = document.createElement('button');
      gUp.type = 'button';
      gUp.className = 'combo-btn';
      gUp.textContent = '↑';
      gUp.title = 'Move group up';
      gUp.disabled = gi <= 0;
      gUp.addEventListener('click', () => {
        [sectionGroupOrder[gi - 1], sectionGroupOrder[gi]] = [sectionGroupOrder[gi], sectionGroupOrder[gi - 1]];
        sectionConfig = normalizeSectionOrder(sectionConfig);
        commitSectionConfig();
      });
      const gDown = document.createElement('button');
      gDown.type = 'button';
      gDown.className = 'combo-btn';
      gDown.textContent = '↓';
      gDown.title = 'Move group down';
      gDown.disabled = gi === sectionGroupOrder.length - 1;
      gDown.addEventListener('click', () => {
        [sectionGroupOrder[gi], sectionGroupOrder[gi + 1]] = [sectionGroupOrder[gi + 1], sectionGroupOrder[gi]];
        sectionConfig = normalizeSectionOrder(sectionConfig);
        commitSectionConfig();
      });

      // Group-level 1/0/± toggle: shows/hides every card in the group at
      // once. Mixed state (±) counts as "not all shown", so a click shows all.
      const members = sectionConfig.filter((e) => sectionGroupOf(e.id) === group);
      const onCount = members.filter((e) => e.enabled).length;
      const allOn = onCount === members.length;
      const gToggle = document.createElement('button');
      gToggle.type = 'button';
      gToggle.className = 'combo-btn section-toggle group-toggle' + (allOn ? ' on' : onCount === 0 ? ' zero' : ' mixed');
      gToggle.textContent = allOn ? '1' : onCount === 0 ? '0' : '±';
      gToggle.title = allOn ? 'Whole group shown — click to hide it' : 'Click to show the whole group';
      gToggle.addEventListener('click', () => {
        for (const e of members) e.enabled = !allOn;
        commitSectionConfig();
      });

      head.append(gHandle, title, gUp, gDown, gToggle);
      groupBox.appendChild(head);
    }

    const row = document.createElement('div');
    row.className = 'section-row' + (entry.enabled ? '' : ' off');
    row.dataset.id = entry.id;
    row.dataset.group = group;
    row.draggable = true;

    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.textContent = '⠿';
    handle.title = 'Drag to reorder within the group';

    row.addEventListener('dragstart', (e) => {
      draggedSectionRow = row;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', entry.id);
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      if (!draggedSectionRow) return;
      draggedSectionRow = null;
      // The dragover handler already moved the row in the DOM — read the
      // final order back (skipping group headers) and persist it.
      const order = [...list.querySelectorAll('.section-row')].map((r) => r.dataset.id);
      sectionConfig.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      sectionConfig = normalizeSectionOrder(sectionConfig);
      commitSectionConfig();
    });

    const num = document.createElement('span');
    num.className = 'section-row-num';
    num.textContent = entry.enabled ? `${++visible}.` : '—';

    const name = document.createElement('span');
    name.className = 'section-row-name';
    name.textContent = SECTION_DEFS.find((d) => d.id === entry.id)?.title || entry.id;

    // ↑/↓ move within the group only — groups themselves are fixed. Because
    // the config is normalized (groups contiguous), the neighbour check is
    // enough.
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'combo-btn';
    up.textContent = '↑';
    up.title = 'Move up';
    up.disabled = i === 0 || sectionGroupOf(sectionConfig[i - 1].id) !== group;
    up.addEventListener('click', () => {
      [sectionConfig[i - 1], sectionConfig[i]] = [sectionConfig[i], sectionConfig[i - 1]];
      commitSectionConfig();
    });

    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'combo-btn';
    down.textContent = '↓';
    down.title = 'Move down';
    down.disabled = i === sectionConfig.length - 1 || sectionGroupOf(sectionConfig[i + 1].id) !== group;
    down.addEventListener('click', () => {
      [sectionConfig[i], sectionConfig[i + 1]] = [sectionConfig[i + 1], sectionConfig[i]];
      commitSectionConfig();
    });

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'combo-btn section-toggle' + (entry.enabled ? ' on' : ' zero');
    toggle.textContent = entry.enabled ? '1' : '0';
    toggle.title = entry.enabled ? 'Shown — click to hide' : 'Hidden — click to show';
    toggle.addEventListener('click', () => {
      entry.enabled = !entry.enabled;
      commitSectionConfig();
    });

    row.append(handle, num, name, up, down, toggle);
    groupBox.appendChild(row);
  });
}

function commitSectionConfig() {
  localStorage.setItem(SECTIONS_STORAGE_KEY, JSON.stringify(sectionConfig));
  localStorage.setItem(SECTION_GROUPS_STORAGE_KEY, JSON.stringify(sectionGroupOrder));
  applySectionConfig();
  renderSectionManager();
}

function showTab(tab) {
  $('#view-testing').hidden = tab !== 'testing';
  $('#view-settings').hidden = tab !== 'settings';
  $('#tab-testing').classList.toggle('active', tab === 'testing');
  $('#tab-settings').classList.toggle('active', tab === 'settings');
  hideHelpPopover();
}

function initTabsAndSections() {
  $('#tab-testing').addEventListener('click', () => showTab('testing'));
  $('#tab-settings').addEventListener('click', () => showTab('settings'));
  // Drag-to-reorder: move the dragged row/group box live while hovering;
  // dragend (attached per row / per group header) persists the DOM order.
  const list = $('#section-manager');
  list.addEventListener('dragover', (e) => {
    if (draggedGroupBox) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const over = e.target.closest('.section-group');
      if (!over || over === draggedGroupBox) return;
      const rect = over.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      list.insertBefore(draggedGroupBox, before ? over : over.nextSibling);
      return;
    }
    if (!draggedSectionRow) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const over = e.target.closest('.section-row');
    if (!over || over === draggedSectionRow) return;
    // Reordering is constrained to the dragged row's group (= its group box).
    if (over.dataset.group !== draggedSectionRow.dataset.group) return;
    const rect = over.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    over.parentElement.insertBefore(draggedSectionRow, before ? over : over.nextSibling);
  });
  list.addEventListener('drop', (e) => e.preventDefault());
  $('#sections-reset').addEventListener('click', () => {
    sectionGroupOrder = SECTION_GROUPS.map((g) => g.id);
    sectionConfig = SECTION_DEFS.map((d) => ({ id: d.id, enabled: true }));
    commitSectionConfig();
  });
  $('#sections-show-all').addEventListener('click', () => {
    for (const e of sectionConfig) e.enabled = true;
    commitSectionConfig();
  });
  $('#sections-hide-all').addEventListener('click', () => {
    for (const e of sectionConfig) e.enabled = false;
    commitSectionConfig();
  });
  applySectionConfig();
  renderSectionManager();
}

// ---- Collapsible cards -------------------------------------------------------

// Click a card's title (h2) to collapse/expand its body and result. The set of
// collapsed cards persists per browser (localStorage), like the section order.
const COLLAPSED_CARDS_KEY = 'handbill-tests.collapsed-cards';

function initCollapsibleCards() {
  let collapsed;
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_CARDS_KEY) || '[]');
    collapsed = new Set(Array.isArray(raw) ? raw : []);
  } catch {
    collapsed = new Set();
  }
  const save = () => localStorage.setItem(COLLAPSED_CARDS_KEY, JSON.stringify([...collapsed]));
  const cards = [];

  // The top-bar button flips between collapsing everything and expanding
  // everything — scoped to the visible tab: collapsing in Testing leaves the
  // Settings cards alone and vice versa.
  const visibleCards = () => {
    const view = document.querySelector('main .view:not([hidden])');
    return cards.filter((card) => view && view.contains(card));
  };
  const allBtn = $('#collapse-all');
  const syncAllBtn = () => {
    const anyOpen = visibleCards().some((card) => !card.classList.contains('collapsed'));
    allBtn.textContent = anyOpen ? 'Collapse all' : 'Expand all';
  };

  document.querySelectorAll('main section.card').forEach((card) => {
    const h2 = card.querySelector(':scope > header h2');
    if (!h2 || !card.id) return;
    cards.push(card);
    const caret = document.createElement('span');
    caret.className = 'collapse-caret';
    caret.textContent = '▾';
    h2.prepend(caret);
    if (collapsed.has(card.id)) card.classList.add('collapsed');
    h2.addEventListener('click', (e) => {
      if (e.target.closest('.help-btn')) return; // (?) opens help, not collapse
      const isCollapsed = card.classList.toggle('collapsed');
      if (isCollapsed) collapsed.add(card.id); else collapsed.delete(card.id);
      save();
      syncAllBtn();
    });
  });

  allBtn.addEventListener('click', () => {
    const scope = visibleCards();
    const collapse = scope.some((card) => !card.classList.contains('collapsed'));
    for (const card of scope) {
      card.classList.toggle('collapsed', collapse);
      if (collapse) collapsed.add(card.id); else collapsed.delete(card.id);
    }
    save();
    syncAllBtn();
  });
  // Re-sync the label when the visible tab changes (these listeners run after
  // showTab's — initTabsAndSections is initialized first).
  $('#tab-testing').addEventListener('click', syncAllBtn);
  $('#tab-settings').addEventListener('click', syncAllBtn);
  syncAllBtn();
}

// Add a Raw toggle to every result head: flips the output between the
// collapsible JSON tree and plain JSON text (for copy-pasting).
function initRawToggles() {
  document.querySelectorAll('.card-result .result-head').forEach((head) => {
    const pre = head.closest('.card-result')?.querySelector('pre');
    const clearBtn = head.querySelector('.result-clear');
    if (!pre || !clearBtn) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-trash result-raw';
    btn.textContent = 'Raw';
    btn.addEventListener('click', () => {
      if (!pre.__result || pre.__result.json === undefined) return;
      pre.dataset.view = pre.dataset.view === 'raw' ? '' : 'raw';
      btn.classList.toggle('on', pre.dataset.view === 'raw');
      paintResult(pre);
    });
    head.insertBefore(btn, clearBtn);
  });
}

// ---- Help popovers ---------------------------------------------------------

// Every (?) button carries a data-help key pointing into this registry. The
// docs URLs are the operation anchors on hub.synerise.com (verified against
// the live pages).
const DOCS = {
  lne: 'https://hub.synerise.com/api-reference/loyalty-and-engagement#tag/',
  bw: 'https://hub.synerise.com/api-reference/brickworks#tag/',
  auth: 'https://hub.synerise.com/api-reference/authorization#tag/',
  dm: 'https://hub.synerise.com/api-reference/data-management#tag/',
};

const HELP_TOPICS = {
  'sec-fetch': {
    title: 'Fetch handbill',
    desc: 'Everything a single profile can see: promotions and handbills. Every button in this card targets the client picked in the top bar; handbillUuid feeds the handbill buttons (↻ lists all handbill campaigns in the workspace).',
    endpoints: ['GET /v4/promotions/v2/promotion/get-for-client/…', 'GET /v4/promotions/handbill (↻ picker)'],
    docs: [
      { label: 'GetAllClientPromotionsV2', url: `${DOCS.lne}Promotions/operation/GetAllClientPromotionsV2` },
      { label: 'Get all handbills (picker)', url: `${DOCS.lne}Handbills/operation/getAllHandbillConfigs_GET` },
    ],
  },
  'fn-promotions-fetch': {
    title: 'promotions — GetAllClientPromotionsV2',
    desc: 'Lists all promotions available for the client picked in the top bar. Filter rows become query params — multi-value params (status, type) take comma-separated values in one param (e.g. status=ACTIVE,REDEEMED), booleans (presentOnly, displayableOnly, includeMeta) send true/false, and custom… sends any name=value pair. The sort rows are appended in order as repeated sort=attribute,direction query params (asc is the API default).',
    endpoints: ['GET /v4/promotions/v2/promotion/get-for-client/{identifierType}/{identifierValue}?status=…&type=…&presentOnly=…&sort=attribute,direction'],
    docs: [{ label: 'GetAllClientPromotionsV2', url: `${DOCS.lne}Promotions/operation/GetAllClientPromotionsV2` }],
  },
  'fn-handbill-fetch': {
    title: 'handbill — get one handbill for a client',
    desc: 'Fetches a single handbill rendered for the client picked in the top bar. Uses the first handbillUuid from the picker above.',
    endpoints: ['GET /v4/promotions/v2/promotion/get-for-client/{identifierType}/{identifierValue}/handbill/{handbillUuid}'],
    docs: [{ label: 'getHandbillForClientV2', url: `${DOCS.lne}Handbills/operation/getHandbillForClientV2_GET` }],
  },
  'fn-handbill-batch': {
    title: 'handbills + promotions',
    desc: 'Fetches the profile’s promotions together with the selected handbills. Every handbillUuid from the picker is sent as a repeated handbillUuid query param.',
    endpoints: ['GET /v4/promotions/promotion/get-for-client/{identifierType}/{identifierValue}/with-handbills?handbillUuid=…'],
    docs: [{ label: 'getAssignHandbillsForClient', url: `${DOCS.lne}Handbills/operation/getAssignHandbillsForClient_GET` }],
  },
  'fn-handbill-config': {
    title: 'handbill configuration',
    desc: 'Fetches the workspace configuration of a handbill campaign — no profile context, only the first handbillUuid from the picker is used.',
    endpoints: ['GET /v4/promotions/handbill/{handbillUuid}'],
    docs: [{ label: 'getHandbillConfig', url: `${DOCS.lne}Handbills/operation/getHandbillConfig_GET` }],
  },
  'fn-handbill-config-card': {
    title: 'Handbill configuration',
    desc: 'check shows the workspace configuration of the picked handbill campaign and prefills the editor when it\'s empty (trimmed to the PATCH-able fields: channel, status, name, description, controlGroup, variants). update PATCHes the editor\'s JSON back to the same campaign. Recommended flow: check → ⤵ insert fetched → edit → update, so the payload carries the current values and nothing gets nulled.',
    endpoints: ['GET /v4/promotions/handbill/{handbillUuid}', 'PATCH /v4/promotions/handbill/{handbillUuid}'],
    docs: [
      { label: 'Get handbill configuration', url: `${DOCS.lne}Handbills/operation/getHandbillConfig_GET` },
      { label: 'Update handbill', url: `${DOCS.lne}Handbills/operation/updateHandbill_PATCH` },
    ],
  },
  'fn-handbill-config-update': {
    title: 'update handbill configuration',
    desc: 'PATCHes the editor\'s JSON to the picked handbill campaign. The body may only contain channel, status, name, description, controlGroup and variants — read-only fields from the GET (uuid, createdAt, …) fail validation (422). The safest payload is the fetched configuration with your edits applied (⤵ insert fetched trims it for you).',
    endpoints: ['PATCH /v4/promotions/handbill/{handbillUuid}'],
    docs: [{ label: 'Update handbill', url: `${DOCS.lne}Handbills/operation/updateHandbill_PATCH` }],
  },
  'fn-handbill-list': {
    title: 'handbillUuid picker',
    desc: 'The ↻ button lists all handbill campaigns in the workspace (uuid + name) so you can pick one or more; multiple selections are comma-separated.',
    endpoints: ['GET /v4/promotions/handbill?limit=1000'],
    docs: [{ label: 'getAllHandbillConfigs', url: `${DOCS.lne}Handbills/operation/getAllHandbillConfigs_GET` }],
  },
  'fn-activate': {
    title: 'Activate a promotion for this client',
    desc: 'Activates the picked promotion for the client picked in the top bar. Optional pointsToUse applies to cashback promotions.',
    endpoints: ['POST /v4/promotions/promotion/activate-for-client/{identifierType}/{identifierValue}'],
    docs: [{ label: 'ActivateAPromotionAsProfile', url: `${DOCS.lne}Promotions/operation/ActivateAPromotionAsProfile` }],
  },
  'fn-redeem': {
    title: 'Redeem a promotion',
    desc: 'Redeems the picked promotion by its code (button next to Activate). The top-bar client identifier is sent as clientKey/clientKeyValue; optional quantity = number of redeemed items. The API accepts the call only for ACTIVE promotions — on any other status it returns an error (shown in the row).',
    endpoints: ['POST /v4/promotions/promotion/redeem'],
    docs: [{ label: 'RedeemAPromotion', url: `${DOCS.lne}Promotions/operation/RedeemAPromotion` }],
  },
  'sec-promo-get': {
    title: 'Promotion: get / create / update',
    desc: 'One card for a single promotion\'s lifecycle. get fetches the full body by uuid or code (workspace view, no client context) and prefills the editor when it\'s empty — trimmed to the writable fields. ⤵ insert fetched re-copies the fetched promotion into the editor. update PUTs the editor\'s JSON to the promotion picked above (partial update — only sent fields change, explicit null overwrites). create POSTs the editor\'s JSON as a new promotion (edit code/headerName first when starting from a fetched one).',
    endpoints: [
      'GET /v4/promotions/promotion/{uuid|code}/{value}',
      'POST /v4/promotions/promotion',
      'PUT /v4/promotions/promotion/{uuid|code}/{value}',
    ],
    docs: [
      { label: 'GetPromotionDetailsAsBusinessProfile', url: `${DOCS.lne}Promotions/operation/GetPromotionDetailsAsBusinessProfile` },
      { label: 'CreateAPromotion', url: `${DOCS.lne}Promotions/operation/CreateAPromotion` },
      { label: 'UpdateAPromotion', url: `${DOCS.lne}Promotions/operation/UpdateAPromotion` },
    ],
  },
  'fn-promotion-raw-create': {
    title: 'create promotion (from JSON)',
    desc: 'POSTs the editor\'s JSON as a new promotion, verbatim — unlike the Create promotions card there are no {rand5} placeholders and no count. code must be unique in the workspace; when starting from a fetched promotion change code and headerName first, or the API responds with a conflict.',
    endpoints: ['POST /v4/promotions/promotion'],
    docs: [{ label: 'CreateAPromotion', url: `${DOCS.lne}Promotions/operation/CreateAPromotion` }],
  },
  'fn-promotion-raw-update': {
    title: 'update promotion',
    desc: 'PUTs the editor\'s JSON to the promotion picked by uuid/code above. Partial update: only the fields present in the payload change — but an explicit null overwrites the stored value, so don\'t null fields you mean to keep. ⤵ insert fetched gives you the current values (trimmed to writable fields; the GET\'s status is renamed to visibilityStatus) as a safe starting point.',
    endpoints: ['PUT /v4/promotions/promotion/{uuid|code}/{value}'],
    docs: [{ label: 'UpdateAPromotion', url: `${DOCS.lne}Promotions/operation/UpdateAPromotion` }],
  },
  'sec-brickworks': {
    title: 'Brickworks output',
    desc: 'Renders the Brickworks output for one profile, two ways: preview (dry run of a schema definition, no event) or generate (real generation from a published record — emits brickwork.generated). The client comes from the top bar (mapped: clientId → id, customId → custom_identify).',
    endpoints: [
      'POST /brickworks/v1/schemas/records/preview/by/{identifierType}',
      'POST /brickworks/v1/schemas/{schemaId}/records/{recordId}/generate/by/{identifierType}',
    ],
    docs: [
      { label: 'previewObject', url: `${DOCS.bw}Brickworks:-Records/operation/previewObject` },
      { label: 'generateObjectForProfile', url: `${DOCS.bw}Brickworks:-Content-generation/operation/generateObjectForProfile` },
    ],
  },
  'fn-brickworks-generate': {
    title: 'generate record — generateObjectForProfile',
    desc: 'Generates the output from the latest PUBLISHED version of the picked record for the profile — the real generation path, which emits the brickwork.generated event on the profile (the preview does not). The optional context JSON is available inside the schema as {{ context.key }}. Requires both a schema and a record from the pickers.',
    endpoints: ['POST /brickworks/v1/schemas/{schemaId}/records/{recordId}/generate/by/{id|uuid|email|custom_identify}'],
    docs: [{ label: 'generateObjectForProfile', url: `${DOCS.bw}Brickworks:-Content-generation/operation/generateObjectForProfile` }],
  },
  'fn-brickworks-records': {
    title: 'record picker',
    desc: 'The ↻ button lists the records of the FIRST schema picked above (id + name + status). For preview it is optional — the picked record\'s values feed the dry run (leave empty to render from the schema\'s published data; SINGLETON schemas imply their record, so the selection is informational only). Generation requires a record and uses its latest published version — a record that was never published fails with 404/409.',
    endpoints: ['GET /brickworks/v1/schemas/{schemaId}/records?limit=100'],
    docs: [{ label: 'getRecordsFromSchema', url: `${DOCS.bw}Brickworks:-Records/operation/getRecordsFromSchema` }],
  },
  'fn-brickworks-preview': {
    title: 'preview record — previewObject',
    desc: 'Fetches the full schema by id — and, when a record is picked, that record\'s values — then POSTs everything together with the profile identifier. No record picked → the API renders from the schema\'s published data. The optional context JSON is available inside the schema as {{ context.key }}.',
    endpoints: [
      'GET /brickworks/v1/schemas/{schemaId}',
      'GET /brickworks/v1/schemas/{schemaId}/records/{recordId} (when a record is picked)',
      'POST /brickworks/v1/schemas/records/preview/by/{id|uuid|email|custom_identify}',
    ],
    docs: [
      { label: 'previewObject', url: `${DOCS.bw}Brickworks:-Records/operation/previewObject` },
      { label: 'getSchemaById', url: `${DOCS.bw}Brickworks:-Schemas/operation/getSchemaById` },
      { label: 'getRecord', url: `${DOCS.bw}Brickworks:-Records/operation/getRecord` },
    ],
  },
  'fn-brickworks-schemas': {
    title: 'schema picker',
    desc: 'The ↻ button lists all schemas in the workspace (id + displayName + type) so you can pick the one to preview.',
    endpoints: ['GET /brickworks/v1/schemas'],
    docs: [{ label: 'getSchemas', url: `${DOCS.bw}Brickworks:-Schemas/operation/getSchemas` }],
  },
  'fn-promotion-create': {
    title: 'Create promotions',
    desc: 'Creates `count` promotions, one POST each. Placeholders in the name/description re-roll per request; `code` is the unique key later used to overwrite (batch) or delete (cleanup). `redeemLimitPerClient` limits how many times a single profile can redeem the promotion (1 = single-use per user; empty = API default). Tags come from the "promotion" tag directory; custom fields JSON is deep-merged onto the payload.',
    endpoints: ['POST /v4/promotions/promotion', 'GET /tags-collector/directories (tag picker — internal API, no public docs)'],
    docs: [{ label: 'CreateAPromotion', url: `${DOCS.lne}Promotions/operation/CreateAPromotion` }],
  },
  'sec-voucher-pools': {
    title: 'Voucher pools',
    desc: 'Pool-level listing: the voucher pools defined in the workspace, and the codes stored inside one of them. Both calls share the limit / page / includeMeta inputs and carry the required Api-Version: 4.4 header. Voucher-level actions (create, check, redeem, assigned to a profile) live in the Vouchers card.',
    endpoints: [
      'GET /v4/vouchers/pool/list',
      'GET /v4/vouchers/item/list/{poolUuid}',
    ],
    docs: [
      { label: 'ListPools', url: `${DOCS.lne}Vouchers/operation/ListPools` },
      { label: 'ListVouchersFromPool', url: `${DOCS.lne}Vouchers/operation/ListVouchersFromPool` },
    ],
  },
  'fn-pool-list': {
    title: 'list pools — ListPools',
    desc: 'Lists the voucher pools in the workspace with their full definitions (uuid, name, code settings, expiration, limits) — the same call the ↻ pickers make, just rendered in full. Paginated with limit (max 1000, default 100) and 1-based page.',
    endpoints: ['GET /v4/vouchers/pool/list?limit=…&page=…&includeMeta=…  (header Api-Version: 4.4)'],
    docs: [{ label: 'ListPools', url: `${DOCS.lne}Vouchers/operation/ListPools` }],
  },
  'fn-vouchers-in-pool': {
    title: 'vouchers in pool — ListVouchersFromPool',
    desc: 'Lists the vouchers stored in the picked pool — every code in it regardless of status, not just the ones assigned to a profile. Paginated: limit (max 1000, default 100) and 1-based page. includeMeta: false (the API default) returns the totals in X-Pagination-* headers — the server reads them and reports them as `pagination`; includeMeta: true returns them in the response `meta` object.',
    endpoints: ['GET /v4/vouchers/item/list/{poolUuid}?limit=…&page=…&includeMeta=…  (header Api-Version: 4.4)'],
    docs: [{ label: 'ListVouchersFromPool', url: `${DOCS.lne}Vouchers/operation/ListVouchersFromPool` }],
  },
  'sec-vouchers': {
    title: 'Vouchers',
    desc: 'Create voucher codes in a voucher pool (optionally tied to a profile), check a single voucher by code/uuid, and list all vouchers assigned to a profile. Pool-level listing lives in the Voucher pools card. Every call to the vouchers service carries the required Api-Version: 4.4 header.',
    endpoints: [
      'POST /v4/vouchers/item',
      'GET /v4/vouchers/item/{code|uuid}/{value}',
      'POST /v4/vouchers/item/redeem',
      'POST /v4/promotions/voucher/batch-redeem-for-profile',
      'GET /v4/vouchers/item/get-assigned-for-client/by-identifier',
      'GET /v4/vouchers/pool/list (↻ picker)',
    ],
    docs: [
      { label: 'CreateAVoucher', url: `${DOCS.lne}Vouchers/operation/CreateAVoucher` },
      { label: 'ViewVoucherDetailsBySearchKey', url: `${DOCS.lne}Vouchers/operation/ViewVoucherDetailsBySearchKey` },
      { label: 'RedeemAVoucher', url: `${DOCS.lne}Vouchers/operation/RedeemAVoucher` },
      { label: 'BatchRedeemVouchersForProfile', url: `${DOCS.lne}Promotions/operation/BatchRedeemVouchersForProfile` },
      { label: 'GetVouchersAssignedToAClientByIdentifier', url: `${DOCS.lne}Vouchers/operation/GetVouchersAssignedToAClientByIdentifier` },
      { label: 'ListPools (picker)', url: `${DOCS.lne}Vouchers/operation/ListPools` },
    ],
  },
  'fn-voucher-check': {
    title: 'check voucher — ViewVoucherDetailsBySearchKey',
    desc: 'Fetches a single voucher by its code or uuid and shows its current status (ASSIGNED / UNASSIGNED / REDEEMED / CANCELED), the assigned profile and the dates. The value field is prefilled with the first code from the last Create run.',
    endpoints: ['GET /v4/vouchers/item/{searchKey}/{searchValue}  (header Api-Version: 4.4)'],
    docs: [{ label: 'ViewVoucherDetailsBySearchKey', url: `${DOCS.lne}Vouchers/operation/ViewVoucherDetailsBySearchKey` }],
  },
  'fn-voucher-redeem': {
    title: 'redeem voucher — RedeemAVoucher',
    desc: 'Redeems the voucher whose code is in the "check voucher" value field (redeeming works by code only) and flips its status to REDEEMED. Check the voucher again afterwards to see the redeemAt timestamp.',
    endpoints: ['POST /v4/vouchers/item/redeem  (header Api-Version: 4.4)'],
    docs: [{ label: 'RedeemAVoucher', url: `${DOCS.lne}Vouchers/operation/RedeemAVoucher` }],
  },
  'fn-voucher-batch-redeem': {
    title: 'batch redeem for profile — BatchRedeemVouchersForProfile',
    desc: 'Redeems up to 100 vouchers for a profile in one call (promotions service — targets vouchers connected to promotions, not standalone pool codes). One array item per code, all with the profileKey/profileValue from the form. A 207 response means some items failed — per-item errors in the payload. Note: the documented options object (quantity/sourceId/orderId) is rejected by the live API, so it is not sent.',
    endpoints: ['POST /v4/promotions/voucher/batch-redeem-for-profile'],
    docs: [{ label: 'BatchRedeemVouchersForProfile', url: `${DOCS.lne}Promotions/operation/BatchRedeemVouchersForProfile` }],
  },
  'fn-vouchers-for-client': {
    title: 'vouchers for profile — GetVouchersAssignedToAClientByIdentifier',
    desc: 'Lists all vouchers assigned to a profile. The profile is pointed at by clientId, uuid, customId or email (mapped to clientIdentifierName: id / uuid / custom_identify / email).',
    endpoints: ['GET /v4/vouchers/item/get-assigned-for-client/by-identifier?clientIdentifierName=…&clientIdentifierValue=…  (header Api-Version: 4.4)'],
    docs: [{ label: 'GetVouchersAssignedToAClientByIdentifier', url: `${DOCS.lne}Vouchers/operation/GetVouchersAssignedToAClientByIdentifier` }],
  },
  'fn-voucher-create': {
    title: 'Create — CreateAVoucher',
    desc: 'Creates `count` vouchers, one POST each. Placeholders in code ({rand5}, {date}, {serial}, {iso}) re-roll per request; an empty code is omitted from the payload. clientId/clientUuid + status ASSIGNED assigns the voucher to the profile; expireIn sets the expiration date.',
    endpoints: ['POST /v4/vouchers/item  (header Api-Version: 4.4)'],
    docs: [{ label: 'CreateAVoucher', url: `${DOCS.lne}Vouchers/operation/CreateAVoucher` }],
  },
  'fn-voucher-pools': {
    title: 'voucher pool picker',
    desc: 'The ↻ button lists the voucher pools in the workspace (uuid + name) so you can pick the pool the codes are stored in. Only the first selection is used. The Vouchers and Voucher pools cards each have their own picker — picking a pool in one does not change the other.',
    endpoints: ['GET /v4/vouchers/pool/list?limit=100'],
    docs: [{ label: 'ListPools', url: `${DOCS.lne}Vouchers/operation/ListPools` }],
  },
  'sec-events': {
    title: 'Add event/transaction to profile',
    desc: 'Sends custom events — or, via the type toggle, full transactions — to the activity log of the client picked in the top bar (data management API — requires the Api-Version: 4.4 header). Events feed Analytics, segmentations and automations, so this is the quickest way to simulate profile behaviour. A transaction additionally emits transaction.charge plus one product.buy per item. Identifier mapping to the client object: clientId → id (integer), customId → customId — note this differs from Brickworks/vouchers, which use custom_identify.',
    endpoints: [
      'POST /v4/events/custom  (header Api-Version: 4.4)',
      'POST /v4/transactions  (header Api-Version: 4.4)',
    ],
    docs: [
      { label: 'CustomEvent', url: `${DOCS.dm}Events/operation/CustomEvent` },
      { label: 'CreateATransaction', url: `${DOCS.dm}Events/operation/CreateATransaction` },
    ],
  },
  'fn-event-add': {
    title: 'Add event / transaction',
    desc: 'Custom event mode: sends `count` custom events, one POST each. action must be noun.verb (e.g. product.buy); label is required by the API but NOT saved (it can\'t be used in Analytics). Optional: time (ISO — future times are rejected; empty = API stamps now), eventSalt (sending the same salt+time+client+action again overwrites the event instead of duplicating it) and params (free-form parameters, clicked together key by key or pasted as raw JSON). Transaction mode: sends the preconfigured JSON payload to /v4/transactions with client injected from the top bar — required: orderId, products (name + finalUnitPrice each), paymentInfo.method, revenue, value, source; revenue/value are NOT auto-calculated and all amounts must share one currency. Placeholders ({rand5}, {date}, {serial}, {iso}) re-roll per request — in label/eventSalt for events, in every string value for transactions, so orderId stays unique across repeats. Success is 202 Accepted with an empty body — check the profile\'s activity log a moment later.',
    endpoints: [
      'POST /v4/events/custom  (header Api-Version: 4.4)',
      'POST /v4/transactions  (header Api-Version: 4.4)',
    ],
    docs: [
      { label: 'CustomEvent', url: `${DOCS.dm}Events/operation/CustomEvent` },
      { label: 'CreateATransaction', url: `${DOCS.dm}Events/operation/CreateATransaction` },
    ],
  },
  'sec-pos': {
    title: 'Process basket / checkout (POS)',
    desc: 'Simulates a POS transaction for the client picked in the top bar (mapping: customId → externalId; the API also accepts phone). Both calls take the same transaction body — operationId, clientDateTime, terminal, transactionMetric, finalValue, transactionItems, transactionAdditionalItems. Placeholders in string values ({rand5}, {date}, {serial}, {iso}) re-roll per request, so repeated sends get fresh transaction ids.',
    endpoints: [
      'POST /v4/promotions/v2/sale/process-sale/{identifierType}/{identifierValue}',
      'POST /v4/promotions/sale/process-checkout/{identifierType}/{identifierValue}',
    ],
    docs: [
      { label: 'processSale (Process basket)', url: `${DOCS.lne}Promotions/operation/processSale_POST` },
      { label: 'processCheckout (Process checkout on POS)', url: `${DOCS.lne}Promotions/operation/processCheckout_POST` },
    ],
  },
  'fn-process-sale': {
    title: 'process basket — processSale',
    desc: 'Evaluates the basket against the profile\'s promotions and returns the calculated discounts (transactionItems come back with promotion effects, plus promotionErrors for ones that could not apply). Optionally activates promotions in the same call via promotionsToActivate: [{ "key": "uuid"|"code", "value": "…", "pointsToUse": 0 }].',
    endpoints: ['POST /v4/promotions/v2/sale/process-sale/{identifierType}/{identifierValue}'],
    docs: [{ label: 'processSale (Process basket)', url: `${DOCS.lne}Promotions/operation/processSale_POST` }],
  },
  'fn-process-checkout': {
    title: 'process checkout — processCheckout',
    desc: 'Finalizes the POS transaction: same body as process basket, but paymentsReport.paymentItems (how the client paid) is required and promotionsToActivate is not accepted. The response contains a transactionGrantReport with printouts.',
    endpoints: ['POST /v4/promotions/sale/process-checkout/{identifierType}/{identifierValue}'],
    docs: [{ label: 'processCheckout (Process checkout on POS)', url: `${DOCS.lne}Promotions/operation/processCheckout_POST` }],
  },
  'sec-batch': {
    title: 'Batch overwrite (targetSegment)',
    desc: 'Partial merge/upsert by code (async, 202): each item sends only { code, targetType: "SEGMENT", targetSegment }, every other field on the existing promotion is left untouched. Unknown codes are created.',
    endpoints: ['POST /v4/promotions/v2/promotion/batch'],
    docs: [{ label: 'BatchImportPromotions', url: `${DOCS.lne}Promotions/operation/BatchImportPromotions` }],
  },
  'fn-batch-use-created': {
    title: 'Use last created codes',
    desc: 'Fills the codes field with the codes generated by the last successful Create run in this browser session. No API call.',
    endpoints: [],
    docs: [],
  },
  'fn-batch-load-existing': {
    title: 'Load codes by prefix',
    desc: 'Lists all promotions in the workspace and keeps the codes whose headerName starts with "test-" (filtered locally).',
    endpoints: ['GET /v4/promotions/promotion/list?limit=1000'],
    docs: [{ label: 'ViewBusinessProfilePromotions', url: `${DOCS.lne}Promotions/operation/ViewBusinessProfilePromotions` }],
  },
  'sec-cleanup': {
    title: 'Cleanup promotions',
    desc: 'Lists all workspace promotions (max 1000) and filters locally by headerName prefix; delete then removes each match one by one, by code.',
    endpoints: ['GET /v4/promotions/promotion/list?limit=1000', 'DELETE /v4/promotions/promotion'],
    docs: [
      { label: 'ViewBusinessProfilePromotions', url: `${DOCS.lne}Promotions/operation/ViewBusinessProfilePromotions` },
      { label: 'DeleteAPromotion', url: `${DOCS.lne}Promotions/operation/DeleteAPromotion` },
    ],
  },
  'fn-cleanup-list': {
    title: 'List matching',
    desc: 'Lists all promotions in the workspace and shows the ones whose headerName starts with the prefix (the filter runs locally — the API has no prefix parameter).',
    endpoints: ['GET /v4/promotions/promotion/list?limit=1000'],
    docs: [{ label: 'ViewBusinessProfilePromotions', url: `${DOCS.lne}Promotions/operation/ViewBusinessProfilePromotions` }],
  },
  'fn-cleanup-delete': {
    title: 'Delete matching',
    desc: 'Lists, filters by prefix, then deletes every match sequentially by code (body { value: code }). Empty prefix deletes ALL promotions — double confirmation required.',
    endpoints: ['GET /v4/promotions/promotion/list?limit=1000', 'DELETE /v4/promotions/promotion'],
    docs: [{ label: 'DeleteAPromotion', url: `${DOCS.lne}Promotions/operation/DeleteAPromotion` }],
  },
  'sec-manager': {
    title: 'Testing sections',
    desc: 'Controls the Testing tab: drag a row (or use ↑/↓) to change the order of the cards within a group; drag a group header by its ⠿ handle (or use its ↑/↓) to move the whole group — header and cards travel together. The 1/0 toggle shows (1) or hides (0) a card; the pill toggle on a group header flips the whole group at once (± = some shown, some hidden — clicking shows all of them); Show all / Hide all in the card header flip every section. The layout is stored locally in this browser (localStorage) — nothing is sent to Synerise.',
    endpoints: [],
    docs: [],
  },
  'sec-token': {
    title: 'Bearer token',
    desc: 'The local server logs in with the active workspace\'s API key (picked in the top bar) and caches the JWT it gets back; every call in this app reuses that token (auto-refreshed on 401). Refresh forces a new login.',
    endpoints: ['POST /uauth/v2/auth/login/profile'],
    docs: [{ label: 'profileLogin (Log in as workspace)', url: `${DOCS.auth}Authorization/operation/profileLogin` }],
  },
  'fn-client': {
    title: 'Client',
    desc: 'The profile every section targets — fetch, activate/redeem, Brickworks and vouchers-for-profile all use this one identifier. (Voucher create and batch redeem keep their own fields because those APIs take different key types.) The choice is saved in this browser.',
    endpoints: [],
    docs: [],
  },
  'fn-workspaces': {
    title: 'Workspaces',
    desc: 'Each workspace is a Synerise API key. ＋ adds one: the key is validated with a login, stored in the platform keystore (macOS Keychain, Windows Credential Manager or a libsecret keyring on Linux — service "handbill-tests"), and the app switches to it. The browser only ever sees { id, name } — switching sends the id and the server pulls the key from the keystore, so no key sits in browser storage or in a plaintext file, and the list is shared by every browser on this computer. "(.env key)" switches back to the key the server booted with; ✕ deletes the selected entry from the keystore. Keys saved by older versions in browser storage are migrated automatically on load. Keys never leave your machine except towards Synerise.',
    endpoints: ['POST /uauth/v2/auth/login/profile', 'GET /tags-collector/directories'],
    docs: [{ label: 'profileLogin (Log in as workspace)', url: `${DOCS.auth}Authorization/operation/profileLogin` }],
  },
  'fn-promotion-settings': {
    title: 'Promotion settings',
    desc: 'check shows the current promotion settings of the workspace (redeem limits, activation rules, …) and prefills the editor when it\'s empty. ⤵ insert fetched copies the last fetched settings into the editor. update PUTs the editor\'s JSON back — the object is sent as-is (full replace, not a merge), so edit the fetched settings instead of sending a fragment.',
    endpoints: ['GET /v4/promotions/settings', 'PUT /v4/promotions/settings'],
    docs: [
      { label: 'Get promotions settings', url: `${DOCS.lne}Promotion-settings/operation/endpointSettingsGetSettingsGET` },
      { label: 'Update promotions settings', url: `${DOCS.lne}Promotion-settings/operation/endpointSettingsUpdateSettingsPUT` },
    ],
  },
};

let helpPopoverEl = null;
let helpAnchorEl = null;

function hideHelpPopover() {
  if (helpPopoverEl) helpPopoverEl.remove();
  helpPopoverEl = null;
  helpAnchorEl = null;
}

function showHelpPopover(btn, topic) {
  hideHelpPopover();
  const pop = document.createElement('div');
  pop.className = 'help-popover';

  const h = document.createElement('h4');
  h.textContent = topic.title;
  pop.appendChild(h);

  const p = document.createElement('p');
  p.textContent = topic.desc;
  pop.appendChild(p);

  if (topic.endpoints?.length) {
    const lbl = document.createElement('div');
    lbl.className = 'help-label';
    lbl.textContent = topic.endpoints.length > 1 ? 'Endpoints' : 'Endpoint';
    pop.appendChild(lbl);
    for (const e of topic.endpoints) {
      const c = document.createElement('code');
      c.className = 'help-endpoint';
      c.textContent = e;
      pop.appendChild(c);
    }
  }

  if (topic.docs?.length) {
    const lbl = document.createElement('div');
    lbl.className = 'help-label';
    lbl.textContent = 'Documentation';
    pop.appendChild(lbl);
    for (const d of topic.docs) {
      const a = document.createElement('a');
      a.className = 'help-link';
      a.href = d.url;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.textContent = `${d.label} ↗`;
      pop.appendChild(a);
    }
  }

  document.body.appendChild(pop);
  const r = btn.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 12));
  pop.style.left = `${left + window.scrollX}px`;
  pop.style.top = `${r.bottom + 6 + window.scrollY}px`;
  helpPopoverEl = pop;
  helpAnchorEl = btn;
}

function initHelp() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.help-btn');
    if (btn) {
      e.preventDefault();
      if (helpAnchorEl === btn) {
        hideHelpPopover();
        return;
      }
      const topic = HELP_TOPICS[btn.dataset.help];
      if (topic) showHelpPopover(btn, topic);
      return;
    }
    if (helpPopoverEl && !helpPopoverEl.contains(e.target)) hideHelpPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideHelpPopover();
  });
}

// ---- Init ----------------------------------------------------------------

function init() {
  $('#token-refresh').addEventListener('click', () => loadToken({ force: true }));
  initGlobalIdentifier();
  initWorkspaces();
  $('#promotion-create').addEventListener('click', createPromotion);
  $('#promotions-fetch').addEventListener('click', fetchPromotionsForClient);
  $('#sort-add').addEventListener('click', addSortRow);
  $('#filter-add').addEventListener('click', addFilterRow);
  addSortRow();
  $('#handbill-fetch').addEventListener('click', fetchHandbill);
  $('#handbill-batch').addEventListener('click', fetchHandbillBatch);
  $('#handbill-config').addEventListener('click', fetchHandbillConfig);
  $('#promotion-get').addEventListener('click', fetchPromotionDetails);
  $('#promotion-raw-create').addEventListener('click', createPromotionRaw);
  $('#promotion-raw-update').addEventListener('click', updatePromotionRaw);
  $('#promotion-crud-insert').addEventListener('click', () =>
    insertFetchedConfig('promotionCrud', '#promotion-crud-json', '#promotion-crud-json-error'));
  createCombo({
    inputSel: '#handbill-uuid-input',
    listSel: '#handbill-uuid-list',
    refreshBtnSel: '#handbill-uuid-refresh',
    toggleBtnSel: '#handbill-uuid-toggle',
    clearBtnSel: '#handbill-uuid-clear',
    fetchUrl: '/api/handbills',
    valueKey: 'uuid',
    labelKey: 'name',
    emptyText: 'No handbills. Click ↻ to load.',
  });
  createCombo({
    inputSel: '#promotion-tag-input',
    listSel: '#promotion-tag-list',
    refreshBtnSel: '#promotion-tag-refresh',
    toggleBtnSel: '#promotion-tag-toggle',
    clearBtnSel: '#promotion-tag-clear',
    fetchUrl: '/api/promotion-tags',
    valueKey: 'hash',
    labelKey: 'name',
    emptyText: 'No tags. Click ↻ to load.',
  });
  $('#brickworks-preview').addEventListener('click', fetchBrickworksPreview);
  $('#brickworks-generate').addEventListener('click', fetchBrickworksGenerate);
  createCombo({
    inputSel: '#brickworks-schema-input',
    listSel: '#brickworks-schema-list',
    refreshBtnSel: '#brickworks-schema-refresh',
    toggleBtnSel: '#brickworks-schema-toggle',
    clearBtnSel: '#brickworks-schema-clear',
    fetchUrl: '/api/brickworks-schemas',
    valueKey: 'id',
    labelKey: 'name',
    emptyText: 'No schemas. Click ↻ to load.',
  });
  createCombo({
    inputSel: '#brickworks-record-input',
    listSel: '#brickworks-record-list',
    refreshBtnSel: '#brickworks-record-refresh',
    toggleBtnSel: '#brickworks-record-toggle',
    clearBtnSel: '#brickworks-record-clear',
    fetchUrl: () => `/api/brickworks-records?schemaId=${encodeURIComponent(parseBrickworksSchemaIds()[0] || '')}`,
    valueKey: 'id',
    labelKey: 'name',
    emptyText: 'No records. Pick a schema, then click ↻.',
  });
  $('#pool-list').addEventListener('click', fetchPoolList);
  $('#vouchers-in-pool').addEventListener('click', fetchVouchersInPool);
  createCombo({
    inputSel: '#pool-picker-input',
    listSel: '#pool-picker-list',
    refreshBtnSel: '#pool-picker-refresh',
    toggleBtnSel: '#pool-picker-toggle',
    clearBtnSel: '#pool-picker-clear',
    fetchUrl: '/api/voucher-pools',
    valueKey: 'uuid',
    labelKey: 'name',
    emptyText: 'No voucher pools. Click ↻ to load.',
  });
  $('#voucher-create').addEventListener('click', createVoucher);
  $('#voucher-check').addEventListener('click', checkVoucher);
  $('#voucher-redeem').addEventListener('click', redeemVoucher);
  $('#voucher-batch-redeem').addEventListener('click', batchRedeemVouchersForProfile);
  $('#vouchers-for-client').addEventListener('click', fetchVouchersForClient);
  createCombo({
    inputSel: '#voucher-pool-input',
    listSel: '#voucher-pool-list',
    refreshBtnSel: '#voucher-pool-refresh',
    toggleBtnSel: '#voucher-pool-toggle',
    clearBtnSel: '#voucher-pool-clear',
    fetchUrl: '/api/voucher-pools',
    valueKey: 'uuid',
    labelKey: 'name',
    emptyText: 'No voucher pools. Click ↻ to load.',
  });
  $('#process-sale').addEventListener('click', () => processPos('sale'));
  $('#process-checkout').addEventListener('click', () => processPos('checkout'));
  $('#pos-template-sale').addEventListener('click', () => { $('#pos-json').value = posTemplate('sale'); });
  $('#pos-template-checkout').addEventListener('click', () => { $('#pos-json').value = posTemplate('checkout'); });
  $('#pos-json').value = posTemplate('sale');
  $('#event-add').addEventListener('click', addEventToProfile);
  $('#event-kind-event').addEventListener('click', () => setEventKind('event'));
  $('#event-kind-transaction').addEventListener('click', () => setEventKind('transaction'));
  $('#event-params-mode-fields').addEventListener('click', () => setEventParamsMode('fields'));
  $('#event-params-mode-raw').addEventListener('click', () => setEventParamsMode('raw'));
  $('#event-params-add').addEventListener('click', () => addEventParamRow());
  addEventParamRow();
  $('#batch-import').addEventListener('click', batchImport);
  $('#batch-use-created').addEventListener('click', useCreatedCodes);
  $('#batch-load-existing').addEventListener('click', loadExistingCodes);
  $('#promotion-settings').addEventListener('click', fetchPromotionSettings);
  $('#promotion-settings-update').addEventListener('click', updatePromotionSettings);
  $('#promotion-settings-insert').addEventListener('click', () =>
    insertFetchedConfig('promoSettings', '#promotion-settings-json', '#promotion-settings-json-error'));
  $('#handbill-config-get').addEventListener('click', fetchHandbillConfigCard);
  $('#handbill-config-update').addEventListener('click', updateHandbillConfig);
  $('#handbill-config-insert').addEventListener('click', () =>
    insertFetchedConfig('handbillConfig', '#handbill-config-json', '#handbill-config-json-error'));
  createCombo({
    inputSel: '#hbcfg-uuid-input',
    listSel: '#hbcfg-uuid-list',
    refreshBtnSel: '#hbcfg-uuid-refresh',
    toggleBtnSel: '#hbcfg-uuid-toggle',
    clearBtnSel: '#hbcfg-uuid-clear',
    fetchUrl: '/api/handbills',
    valueKey: 'uuid',
    labelKey: 'name',
    emptyText: 'No handbills. Click ↻ to load.',
  });
  $('#cleanup-list').addEventListener('click', listMatching);
  $('#cleanup-delete').addEventListener('click', deleteMatching);

  document.addEventListener('click', (e) => {
    const combo = e.target.closest('.combo');
    document.querySelectorAll('.combo-list').forEach((list) => {
      if (!combo || !combo.contains(list)) list.hidden = true;
    });
  });

  document.querySelectorAll('.curl-copy').forEach((btn) => {
    btn.addEventListener('click', handleCurlClick);
  });

  initHelp();
  initTabsAndSections();

  document.querySelectorAll('.result-clear').forEach((btn) => {
    btn.addEventListener('click', () => {
      const result = btn.closest('.card-result');
      const pre = result?.querySelector('pre');
      if (pre) clearResult(pre);
      for (const [blockSel, listSel] of [['#handbill-activate', '#activate-promo-list']]) {
        const block = result?.querySelector(blockSel);
        if (block) {
          block.hidden = true;
          $(listSel).innerHTML = '';
        }
      }
    });
  });

  initCollapsibleCards();
  initRawToggles();

  loadToken();
}

init();
