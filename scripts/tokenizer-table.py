#!/usr/bin/env python3
"""Build lib/tokenizers.json: token counts of the fireye echo probe under public tokenizers.

The echo probe asks the model to repeat a fixed text verbatim. The reported output token
count then equals the text's length under the backend's tokenizer (±1-2 for an end-of-turn
token), with no dependence on system prompts the relay may inject. Requests served by models
with different tokenizers report different counts for the same text.

This script picks the probe text from a candidate list (largest minimum gap between the
known tokenizers) and records each tokenizer's count. Claude has no public tokenizer; its
count is learned from real runs (see docs/METHODOLOGY.md).

Usage (needs network for the Hugging Face downloads):
  python3 -m venv /tmp/tokvenv
  /tmp/tokvenv/bin/pip install tiktoken==0.14.0 tokenizers==0.23.3 huggingface_hub==2.2.0
  HF_HUB_CACHE=/tmp/tokcache /tmp/tokvenv/bin/python scripts/tokenizer-table.py [--write]
"""
import itertools
import json
import os
import sys

import tiktoken
from huggingface_hub import hf_hub_download
from tokenizers import Tokenizer

# tokenizer id -> (bank family or None, source). Repos sharing a tokenizer are merged below.
HF = {
    "glm-5.3": ("glm", "zai-org/GLM-5.3"),
    "glm-5.3-flash": ("glm", "zai-org/GLM-5.3-Flash"),
    "glm-5.2": ("glm", "zai-org/GLM-5.2"),
    "deepseek-v4-pro": ("deepseek", "deepseek-ai/DeepSeek-V4-Pro"),
    "deepseek-v4.1-flash": ("deepseek", "deepseek-ai/DeepSeek-V4.1-Flash"),
    "minimax-m3": ("minimax", "MiniMaxAI/MiniMax-M3"),
    "minimax-m2.7": ("minimax", "MiniMaxAI/MiniMax-M2.7"),
    "qwen3.5": ("qwen", "Qwen/Qwen3.5-9B"),
    "mistral-large-3": ("mistral", "mistralai/Mistral-Large-3-675B-Instruct-2512"),
    "nemotron-3": ("nemotron", "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16"),
    "gemma-4": ("gemma", "google/gemma-4-31B-it"),
    "gpt-oss": ("gpt-oss", "openai/gpt-oss-120b"),
}
KIMI = {"kimi-k3": "moonshotai/Kimi-K3", "kimi-k2.6": "moonshotai/Kimi-K2.6"}
KIMI_PAT = "|".join([
    r"""[\p{Han}]+""",
    r"""[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]*[\p{Ll}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]+(?i:'s|'t|'re|'ve|'m|'ll|'d)?""",
    r"""[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]+[\p{Ll}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]*(?i:'s|'t|'re|'ve|'m|'ll|'d)?""",
    r"""\p{N}{1,3}""",
    r""" ?[^\s\p{L}\p{N}]+[\r\n]*""",
    r"""\s*[\r\n]+""",
    r"""\s+(?!\S)""",
    r"""\s+""",
])
# OpenAI encodings: o200k = GPT-4o / GPT-5.x; cl100k = what relay software typically uses
# when it estimates usage itself instead of passing the upstream count through.
TIKTOKEN = {"o200k": ("gpt", "o200k_base"), "cl100k": (None, "cl100k_base")}


def load():
    enc = {}
    for tid, (fam, repo) in HF.items():
        tok = Tokenizer.from_file(hf_hub_download(repo, "tokenizer.json"))
        enc[tid] = (fam, repo, lambda s, t=tok: len(t.encode(s, add_special_tokens=False).ids))
    for tid, repo in KIMI.items():
        from tiktoken.load import load_tiktoken_bpe
        ranks = load_tiktoken_bpe(hf_hub_download(repo, "tiktoken.model"))
        e = tiktoken.Encoding(name=tid, pat_str=KIMI_PAT, mergeable_ranks=ranks, special_tokens={})
        enc[tid] = ("kimi", repo, lambda s, e=e: len(e.encode(s, disallowed_special=())))
    for tid, (fam, name) in TIKTOKEN.items():
        e = tiktoken.get_encoding(name)
        enc[tid] = (fam, f"tiktoken:{name}", lambda s, e=e: len(e.encode(s, disallowed_special=())))
    return enc


# Plain, everyday sentences: models repeat them with the canonical tokenization. Chinese text
# separates Chinese-heavy vocabularies (GLM, Qwen, DeepSeek, Kimi) from Western ones; digits
# separate 1-digit from 3-digit number tokens; English separates the rest.
PARTS_ZH = [
    "今天下午三点，我们在图书馆二楼的会议室讨论新的排班表。",
    "请把这份报告转交给财务部的王经理，并抄送行政组。",
    "周末天气晴朗，适合带孩子去公园放风筝或者骑自行车。",
    "这家餐厅的招牌菜是红烧肉和清蒸鲈鱼，价格也很实惠。",
    "小区东门的快递柜明天停用一天，请大家到西门领取包裹。",
    "他一边喝着热茶，一边翻看昨天的旧报纸。",
    "我们计划下个月去杭州西湖旅游，顺便看望外婆。",
]
PARTS_NUM = [
    "订单号 2026101284，金额 357.40 元，共 12 件。",
    "航班 CA1831 于 08:45 起飞，预计 11:20 到达。",
    "电话 010-62751234，邮编 100871。",
    "第 3 季度销量 48,215 台，同比增长 6.7%。",
    "",
]
PARTS_EN = [
    "The quarterly meeting moved to Thursday at 9:30 in room 204.",
    "Please bring your badge, a laptop charger, and the signed forms.",
    "Rain is expected tonight, so the outdoor concert starts indoors.",
    "My neighbour's dog barks whenever the mail carrier walks by.",
    "",
]


def candidates():
    zhs = PARTS_ZH + [a + b for a, b in itertools.permutations(PARTS_ZH, 2)]
    seen = set()
    for zh, num, en in itertools.product(zhs, PARTS_NUM, PARTS_EN):
        for c in (f"{zh}{num}{en}", f"{en} {zh}{num}" if en else f"{zh}{num}"):
            c = c.strip()
            if c not in seen and 60 <= len(c) <= 200:
                seen.add(c)
                yield c


def main():
    enc = load()
    probe = "请原样输出下面这段文字，只输出这段文字本身，不要加引号、不要翻译、不要任何解释：\n\n"
    # Merge tokenizers that give identical counts on every candidate (same vocabulary).
    cands = list(candidates())
    sig = {tid: tuple(f(c) for c in cands) for tid, (_, _, f) in enc.items()}
    groups = {}
    for tid, s in sig.items():
        groups.setdefault(s, []).append(tid)
    tok_groups = list(groups.values())
    print(f"{len(enc)} tokenizers -> {len(tok_groups)} distinct:", [g for g in tok_groups], file=sys.stderr)

    # Pick the text whose smallest gap between distinct tokenizers is largest.
    def gap(i):
        counts = sorted(sig[g[0]][i] for g in tok_groups)
        return min(b - a for a, b in zip(counts, counts[1:])) if len(counts) > 1 else 0
    best = max(range(len(cands)), key=lambda i: (gap(i), -len(cands[i])))
    text = cands[best]
    table = []
    for g in tok_groups:
        fams = sorted({enc[t][0] for t in g if enc[t][0]})
        table.append({"tokenizers": g, "families": fams, "sources": [enc[t][1] for t in g], "count": sig[g[0]][best]})
    table.sort(key=lambda r: r["count"])
    for r in table:
        print(f"  {r['count']:4d}  {'/'.join(r['tokenizers']):40s} {r['families']}", file=sys.stderr)
    print(f"text ({len(text)} chars, min gap {gap(best)}): {text}", file=sys.stderr)
    out = {
        "note": "Echo probe for the token-count check. Built by scripts/tokenizer-table.py; counts exclude special tokens.",
        "prompt": probe + text,
        "text": text,
        "tolerance": 2,
        "tokenizers": table,
        # Filled from real runs against known-genuine endpoints (no public tokenizer).
        "observed": {},
    }
    if "--write" in sys.argv:
        path = os.path.join(os.path.dirname(__file__), "..", "lib", "tokenizers.json")
        old = json.load(open(path)) if os.path.exists(path) else {}
        if old.get("text") == text:
            out["observed"] = old.get("observed", {})
        json.dump(out, open(path, "w"), ensure_ascii=False, indent=1)
        print(f"wrote {path}", file=sys.stderr)


if __name__ == "__main__":
    main()
