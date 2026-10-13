// Transport layer: format detection, thinking-param ladder, single call.
// Supports OpenAI-compatible (/v1/chat/completions) and Anthropic-native (/v1/messages).

const MASK = (k) => (k ? `${k.slice(0, 6)}…${k.slice(-4)}` : '(none)');

function anthropicBody(model, prompt, maxTokens, effort, thinkingMode) {
  const body = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
  if (thinkingMode === 'adaptive') {
    body.thinking = { type: 'adaptive' };
    body.output_config = { effort };
  } else if (thinkingMode === 'enabled') {
    body.thinking = { type: 'enabled', budget_tokens: { low: 1024, medium: 8192, high: 16384 }[effort] || 8192 };
  } else if (thinkingMode === 'off') {
    // Explicit off (echo probes): relays that turn thinking on by default honour this.
    body.thinking = { type: 'disabled' };
  }
  return body;
}

function openaiBody(model, prompt, maxTokens, effort, thinkingMode) {
  const body = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
  if (thinkingMode === 'effort') body.reasoning_effort = effort;
  else if (thinkingMode === 'off') body.reasoning_effort = 'none';
  return body;
}

function responsesBody(model, prompt, maxTokens, effort, thinkingMode) {
  // Reasoning models burn hidden tokens before text; keep the probe floor above 1k.
  const body = { model, input: prompt, max_output_tokens: thinkingMode === 'effort' ? Math.max(maxTokens, 1024) : maxTokens };
  if (thinkingMode === 'effort') body.reasoning = { effort };
  return body;
}

async function rawCall({ base, key, format, model, prompt, maxTokens, effort, thinkingMode, timeoutMs }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const b = base.replace(/\/+$/, '');
  const url = format === 'anthropic' ? `${b}/v1/messages` : format === 'openai-responses' ? `${b}/v1/responses` : `${b}/v1/chat/completions`;
  const headers = format === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    : { Authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const body = format === 'anthropic'
    ? anthropicBody(model, prompt, maxTokens, effort, thinkingMode)
    : format === 'openai-responses'
      ? responsesBody(model, prompt, maxTokens, effort, thinkingMode)
      : openaiBody(model, prompt, maxTokens, effort, thinkingMode);
  try {
    const r = await fetch(url, { method: 'POST', headers: JSON.parse(JSON.stringify(headers)), body: JSON.stringify(body), signal: ac.signal });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* non-JSON error page */ }
    if (j?.error) return { status: r.status, ok: false, error: j.error?.message || JSON.stringify(j.error).slice(0, 200), input: null, text: '' };
    if (format === 'anthropic') {
      const blocks = j.content || [];
      return {
        status: r.status, ok: r.ok,
        text: blocks.filter(b => b.type === 'text').map(b => b.text).join(''),
        thinkingChars: blocks.filter(b => b.type === 'thinking' || b.type === 'redacted_thinking').map(b => (b.thinking || b.data || ' ').length).reduce((a, b) => a + b, 0),
        input: j.usage?.input_tokens, output: j.usage?.output_tokens, reasoning: null,
        stop: j.stop_reason, model: j.model,
      };
    }
    const msg = j.choices?.[0]?.message || {};
    if (format === 'openai-responses') {
      const items = j.output || [];
      const text = items.filter(i => i.type === 'message').flatMap(i => i.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('');
      const thinkingChars = items.filter(i => i.type === 'reasoning').flatMap(i => i.summary || []).map(s => (s.text || '').length).reduce((a, b2) => a + b2, 0);
      return {
        status: r.status, ok: r.ok,
        text, thinkingChars,
        input: j.usage?.input_tokens, output: j.usage?.output_tokens,
        reasoning: j.usage?.output_tokens_details?.reasoning_tokens ?? null,
        stop: j.status, model: j.model,
      };
    }
    return {
      status: r.status, ok: r.ok,
      text: typeof msg.content === 'string' ? msg.content : (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join(''),
      thinkingChars: (msg.reasoning_content || msg.reasoning || '').length,
      input: j.usage?.prompt_tokens, output: j.usage?.completion_tokens,
      reasoning: j.usage?.completion_tokens_details?.reasoning_tokens ?? null,
      stop: j.choices?.[0]?.finish_reason, model: j.model,
    };
  } catch (e) {
    return { status: e.name === 'AbortError' ? 'TIMEOUT' : 'FETCH_ERROR', ok: false, error: e.message, input: null, text: '' };
  } finally { clearTimeout(timer); }
}

// Probe which thinking param set the (base, model, format) accepts. Order: cheapest semantics first.
const LADDERS = {
  anthropic: ['adaptive', 'enabled', 'none'],
  openai: ['effort', 'none'],
  'openai-responses': ['effort', 'none'],
};

export async function detectTransport({ base, key, model, effort = 'medium', timeoutMs = 60000, format: formatOverride, log = () => {} }) {
  const format = formatOverride && formatOverride !== 'auto'
    ? formatOverride
    : (/claude|opus|sonnet|haiku/i.test(model) ? 'anthropic' : 'openai');
  for (const mode of LADDERS[format]) {
    const res = await rawCall({ base, key, format, model, prompt: 'hi', maxTokens: 64, effort, thinkingMode: mode, timeoutMs });
    if (res.ok) {
      log(`transport: ${format}/${mode} accepted (input=${res.input})`);
      return { format, thinkingMode: mode, probe: res };
    }
    log(`transport: ${format}/${mode} rejected [${res.status}] ${(res.error || '').slice(0, 90)}`);
    // A 400 that names an alternative param keeps the ladder going; auth, rate limit and
    // network failures say nothing about the parameter, so stop instead of walking the ladder.
    if ([401, 403, 429, 'TIMEOUT', 'FETCH_ERROR'].includes(res.status)) return { format, thinkingMode: mode, probe: res, fatal: true };
  }
  return { format, thinkingMode: 'none', probe: null, fatal: true };
}

export { rawCall, MASK };
