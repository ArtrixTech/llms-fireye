// Fingerprint bank loader.
// Priority: --bank <file>  →  vendor/modeltrace submodule (pinned fork, offline)
//           →  fork's raw unified_bank.json on GitHub (24h cache) when the submodule is absent.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_BANK = path.join(REPO_ROOT, 'vendor', 'modeltrace', 'data', 'unified_bank.json');
const BANK_URL = 'https://raw.githubusercontent.com/ArtrixTech/ModelTrace/fireye/data/unified_bank.json';
const CACHE_DIR = path.join(os.homedir(), '.cache', 'llms-fireye');
const TTL_MS = 24 * 3600 * 1000;

export async function loadBank({ bankPath, force = false, log = () => {} } = {}) {
  if (bankPath) {
    log(`bank: local file ${bankPath}`);
    return JSON.parse(fs.readFileSync(bankPath, 'utf8'));
  }
  if (!force && fs.existsSync(VENDOR_BANK)) {
    log(`bank: submodule ${path.relative(REPO_ROOT, VENDOR_BANK)}`);
    return JSON.parse(fs.readFileSync(VENDOR_BANK, 'utf8'));
  }
  log('bank: vendor/modeltrace missing — run `git submodule update --init`; falling back to download');
  const cacheFile = path.join(CACHE_DIR, 'unified_bank.fork.json');
  if (!force && fs.existsSync(cacheFile) && Date.now() - fs.statSync(cacheFile).mtimeMs < TTL_MS) {
    log(`bank: cache hit (${cacheFile})`);
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }
  const r = await fetch(BANK_URL);
  if (!r.ok) {
    if (fs.existsSync(cacheFile)) {
      log(`bank: download failed HTTP ${r.status}, using stale cache`);
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    }
    throw new Error(`bank download failed HTTP ${r.status} and no cache exists`);
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const text = await r.text();
  fs.writeFileSync(cacheFile, text);
  log(`bank: downloaded ${BANK_URL} → ${cacheFile}`);
  return JSON.parse(text);
}

export function bankSummary(bank) {
  const fams = {};
  for (const m of bank.models) fams[m.family || 'other'] = (fams[m.family || 'other'] || 0) + 1;
  return { models: bank.models.length, families: fams, built_at: bank.built_at };
}

// Relay model names drift from bank ids: vendor prefixes ("zai-org/glm-5.3"), ollama-style
// tags ("deepseek-v4-pro:0813"), date stamps ("claude-haiku-4-5-20251001"), case.
const norm = (s) => String(s ?? '').toLowerCase().trim()
  .replace(/^.*\//, '').replace(/-\d{8}$/, '').replace(/[._:\s]+/g, '-');

/** Bank model matching a relay label, or null when the label is not enrolled. */
export function resolveLabel(bank, label) {
  const exact = bank.models.find(m => m.id === label || m.display_name === label);
  if (exact) return exact;
  const t = norm(label);
  const same = bank.models.find(m => norm(m.id) === t || norm(m.display_name) === t);
  if (same) return same;
  // "deepseek-v4-pro" → bank "deepseek-v4-pro:0813" only when the expansion is unique.
  const longer = bank.models.filter(m => norm(m.id).startsWith(`${t}-`));
  return longer.length === 1 ? longer[0] : null;
}

export function bankCovers(bank, label) {
  return !!resolveLabel(bank, label);
}
