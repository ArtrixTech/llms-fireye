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
  }
  return body;
}

function openaiBody(model, prompt, maxTokens, effort, thinkingMode) {
  const body = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
  if (thinkingMode === 'effort') body.reasoning_effort = effort;
  return body;
}

async function rawCall({ base, key, format, model, prompt, maxTokens, effort, thinkingMode, timeoutMs }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const url = format === 'anthropic' ? `${base.replace(/\/+$/, '')}/v1/messages` : `${base.replace(/\/+$/, '')}/v1/chat/completions`;
  const headers = format === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    : { Authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const body = format === 'anthropic'
    ? anthropicBody(model, prompt, maxTokens, effort, thinkingMode)
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
        thinkingChars: blocks.filter(b => b.type === 'thinking').map(b => (b.thinking || '').length).reduce((a, b) => a + b, 0),
        input: j.usage?.input_tokens, output: j.usage?.output_tokens,
        stop: j.stop_reason, model: j.model,
      };
    }
    const msg = j.choices?.[0]?.message || {};
    return {
      status: r.status, ok: r.ok,
      text: typeof msg.content === 'string' ? msg.content : (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join(''),
      thinkingChars: (msg.reasoning_content || '').length,
      input: j.usage?.prompt_tokens, output: j.usage?.completion_tokens,
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
};

export async function detectTransport({ base, key, model, effort = 'medium', timeoutMs = 60000, log = () => {} }) {
  const format = /claude|opus|sonnet|haiku/i.test(model) ? 'anthropic' : 'openai';
  for (const mode of LADDERS[format]) {
    const res = await rawCall({ base, key, format, model, prompt: 'hi', maxTokens: 64, effort, thinkingMode: mode, timeoutMs });
    if (res.ok) {
      log(`transport: ${format}/${mode} accepted (input=${res.input})`);
      return { format, thinkingMode: mode, probe: res };
    }
    log(`transport: ${format}/${mode} rejected [${res.status}] ${(res.error || '').slice(0, 90)}`);
    // A 400 that names an alternative param keeps the ladder going; hard auth/5xx aborts.
    if (res.status === 401 || res.status === 403 || res.status === 429) return { format, thinkingMode: mode, probe: res, fatal: true };
  }
  return { format, thinkingMode: 'none', probe: null, fatal: true };
}

export { rawCall, MASK };
