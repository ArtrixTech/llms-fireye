#!/usr/bin/env node
// Record the echo-probe token count of a model from a run against an endpoint you TRUST to be
// genuine (official API, or a relay already verified by other means). Afterwards the token
// check compares every probe against this count instead of only against the other probes,
// which also catches full substitutions. Never learn from a relay you are testing.
//
// Usage: node scripts/learn-tokens.mjs reports/<run-dir> [--write]
import fs from 'node:fs';
import path from 'node:path';
import { tokenCheck, loadTokenTable } from '../lib/tokens.mjs';

const dir = process.argv[2];
if (!dir) { console.error('usage: node scripts/learn-tokens.mjs reports/<run-dir> [--write]'); process.exit(1); }
const raw = JSON.parse(fs.readFileSync(path.join(dir, 'raw.json'), 'utf8'));
const table = loadTokenTable();
const learned = {};
for (const lane of raw.lanes) {
  const id = lane.bank_id || lane.label;
  // Judge against the probes alone (no learned value), so a stale entry cannot bias it.
  const t = tokenCheck(lane.probes || [], null, { ...table, observed: {} });
  if (t.status !== 'ok') { console.log(`${id}: skipped (${t.status}, ${t.m} usable probes)`); continue; }
  if (t.m < 5 || t.deviants) { console.log(`${id}: skipped (need >= 5 usable probes that agree; got ${t.m}, ${t.deviants} deviating)`); continue; }
  learned[id] = t.mode;
  console.log(`${id}: ${t.mode} tokens (${t.m} probes${t.mode_like.length ? `; also fits ${t.mode_like.join(', ')}` : ''})`);
}
if (process.argv.includes('--write') && Object.keys(learned).length) {
  const file = new URL('../lib/tokenizers.json', import.meta.url);
  const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  cur.observed = { ...(cur.observed || {}), ...learned };
  fs.writeFileSync(file, JSON.stringify(cur, null, 1) + '\n');
  console.log('wrote lib/tokenizers.json');
}
