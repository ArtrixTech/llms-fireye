// Challenge generator, sourced from the ModelTrace fork submodule
// (vendor/modeltrace/static/challenge-browser.js). Upstream uses the global Web Crypto
// API (`crypto.getRandomValues` / `crypto.randomUUID`), which Node ≥19 exposes natively,
// so prompts stay byte-identical with the ones the fingerprint bank was built against.
export { generateChallenges } from '../vendor/modeltrace/static/challenge-browser.js';
