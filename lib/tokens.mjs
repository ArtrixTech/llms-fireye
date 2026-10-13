// Token-count check: does every request run on the same tokenizer?
//
// The echo probe asks the model to repeat a fixed text verbatim. The reported output token
// count is then the text's length under the backend's tokenizer (+0-2 for end-of-turn tokens),
// independent of any system prompt the relay injects. A channel that serves every request with
// the claimed model reports the same count every time; requests answered by a model with a
// different tokenizer (another vendor, most open-weight models) report a different count.
// lib/tokenizers.json (scripts/tokenizer-table.py) lists the counts of public tokenizers, so a
// deviating count can usually be named. Claude's tokenizer is not public: its count is learned
// from runs against known-genuine endpoints (scripts/learn-tokens.mjs → "observed").
//
// Blind spots: same-tokenizer substitutes (e.g. another Claude model), and relays that compute
// usage themselves instead of passing the upstream count through (then every count matches the
// relay's own tokenizer, usually tiktoken cl100k/o200k).

import fs from 'node:fs';

const TABLE_FILE = new URL('./tokenizers.json', import.meta.url);
let tableCache;
export function loadTokenTable() {
  if (tableCache !== undefined) return tableCache;
  tableCache = fs.existsSync(TABLE_FILE) ? JSON.parse(fs.readFileSync(TABLE_FILE, 'utf8')) : null;
  return tableCache;
}

/** Two or more probes on another tokenizer make the lane suspicious. */
export const TOKEN_K = 2;
export const MIN_PROBES = 3;

const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n').trim();

/**
 * Reduce a raw transport response to a probe record. count is null when the answer is not the
 * verbatim text, usage is missing, or hidden reasoning tokens cannot be separated out.
 */
export function probeRecord(res, table = loadTokenTable()) {
  const rec = { status: res?.status ?? 'FAIL', output_tokens: res?.output ?? null, reasoning_tokens: res?.reasoning ?? null, count: null };
  if (!res?.ok) return { ...rec, why: 'error' };
  if (norm(res.text) !== norm(table.text)) return { ...rec, why: 'not_verbatim', text: String(res.text ?? '').slice(0, 200) };
  if (typeof res.output !== 'number') return { ...rec, why: 'no_usage' };
  if (res.thinkingChars > 0 && typeof res.reasoning !== 'number') return { ...rec, why: 'thinking' };
  return { ...rec, count: res.output - (res.reasoning || 0) };
}

/** Public tokenizers whose count fits c (count .. count + tolerance). */
export function identify(c, table = loadTokenTable()) {
  const tol = table.tolerance ?? 2;
  const hits = table.tokenizers.filter(t => c >= t.count && c <= t.count + tol).map(t => t.families.length ? t.families.join('/') : t.tokenizers.join('/'));
  for (const [label, n] of Object.entries(table.observed || {})) if (c >= n && c <= n + tol) hits.push(label);
  return hits;
}

/**
 * probes: probe records. Returns
 * { status: 'ok'|'none'|'estimated', m, deviants, expected, mode, counts, mode_like[], deviant_like{} }.
 * With a learned count for the label, a deviant is any count outside expected..expected+tol;
 * otherwise a deviant is any count further than tol from the most common count.
 */
export function tokenCheck(probes, labelId, table = loadTokenTable()) {
  if (!table) return { status: 'none', m: 0, why: 'lib/tokenizers.json missing' };
  const counts = (probes || []).map(p => p.count).filter(c => typeof c === 'number');
  const m = counts.length;
  const reasons = {};
  for (const p of probes || []) if (p.count == null) reasons[p.why] = (reasons[p.why] || 0) + 1;
  if (m < MIN_PROBES) return { status: 'none', m, total: probes?.length ?? 0, reasons };
  const tol = table.tolerance ?? 2;
  const hist = {};
  for (const c of counts) hist[c] = (hist[c] || 0) + 1;
  // Mode as the densest window of width tol (end-of-turn tokens can add 1-2).
  let mode = counts[0], best = -1;
  for (const c of Object.keys(hist).map(Number)) {
    const w = counts.filter(x => x >= c && x <= c + tol).length;
    if (w > best) { best = w; mode = c; }
  }
  const expected = table.observed?.[labelId] ?? null;
  const ok = (c) => (expected != null ? c >= expected && c <= expected + tol : c >= mode && c <= mode + tol);
  const dev = counts.filter(c => !ok(c));
  // Relay software that counts usage itself reports its own tokenizer for every request.
  const relayTok = table.tokenizers.filter(t => !t.families.length);
  const estimated = expected == null && dev.length === 0 && relayTok.some(t => counts.every(c => c >= t.count && c <= t.count + tol));
  const deviantLike = {};
  for (const c of dev) for (const f of identify(c, table).length ? identify(c, table) : ['未知分词器']) deviantLike[f] = (deviantLike[f] || 0) + 1;
  return {
    status: estimated ? 'estimated' : 'ok', m, total: probes.length, deviants: dev.length, expected, mode,
    counts: hist, mode_like: identify(mode, table), deviant_like: deviantLike, reasons,
  };
}
