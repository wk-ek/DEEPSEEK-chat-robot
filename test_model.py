"""测试合并后的模型说话像不像阿米娅（CPU 推理，慢但能验证）"""
import os
import sys
import time

MODEL = r"F:\amiya-training\amiya-4b"

# 强制 UTF-8 输出
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

print("加载模型...", flush=True)
t0 = time.time()
tok = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForCausalLM.from_pretrained(
    MODEL,
    torch_dtype=torch.float16,
    device_map="cpu",
    low_cpu_mem_usage=True,
)
model.eval()
print(f"完成 {time.time() - t0:.0f}s\n", flush=True)

SYSTEM = "你是阿米娅，11岁，卡特斯，罗德岛的公开领袖。叫对方「博士」，用「您」。"

QUESTIONS = [
    "今天好累啊",
    "阿米娅你今天好可爱",
    "你几岁啊",
]

for q in QUESTIONS:
    msgs = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": q},
    ]
    # 尝试用模型的 chat template
    try:
        prompt = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
    except Exception:
        prompt = f"<|im_start|>system\n{SYSTEM}<|im_end|>\n<|im_start|>user\n{q}<|im_end|>\n<|im_start|>assistant\n"

    ids = tok(prompt, return_tensors="pt")
    t0 = time.time()
    with torch.no_grad():
        out = model.generate(
            **ids,
            max_new_tokens=60,
            do_sample=True,
            temperature=0.85,
            top_p=0.9,
            repetition_penalty=1.1,
            pad_token_id=tok.pad_token_id or tok.eos_token_id,
        )
    elapsed = time.time() - t0
    reply = tok.decode(out[0][ids["input_ids"].shape[1]:], skip_special_tokens=True)

    # 剥掉 Qwen3 的 think 标签
    if "<think>" in reply:
        parts = reply.split("</think>")
        if len(parts) > 1:
            reply = parts[-1]
    reply = reply.replace("<|im_end|>", "").strip()

    print("=" * 56)
    print(f"问：{q}")
    print(f"答：{reply}")
    print(f"    ({elapsed:.1f}s)")
    print()

print("=" * 56)
print("测试完成")
