// Fingerprint bank loader. Downloads the unified bank from ModelTrace GitHub Pages
// and caches it (24h TTL). --bank overrides with a local file.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BANK_URL = 'https://xqy2006.github.io/ModelTrace/data/unified_bank.json';
const CACHE_DIR = path.join(os.homedir(), '.cache', 'llms-fireye');
const TTL_MS = 24 * 3600 * 1000;

export async function loadBank({ bankPath, force = false, log = () => {} } = {}) {
  if (bankPath) {
    log(`bank: local file ${bankPath}`);
    return JSON.parse(fs.readFileSync(bankPath, 'utf8'));
  }
  const cacheFile = path.join(CACHE_DIR, 'unified_bank.json');
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
  return { models: bank.models.length, families: fams };
}

export function bankCovers(bank, label) {
  return bank.models.some(m => m.id === label || m.display_name === label);
}
