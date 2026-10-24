"""验证合并是否真的生效：对比 base 和 merged 的权重是否相同"""
import os
import sys
import json

F = r"F:\qq-deepseek-robot\build\models\Qwen3-4B-Instruct-2507"
L = r"F:\amiya-training\stage2"
M = r"F:\amiya-training\amiya-4b"

from safetensors import safe_open

# ---- LoRA 里有什么 ----
print("=== LoRA 内容 ===")
lora_path = os.path.join(L, "adapter_model.safetensors")
with safe_open(lora_path, framework="pt") as f:
    keys = list(f.keys())
    print(f"  张量数: {len(keys)}")
    print(f"  前 5 个键:")
    for k in keys[:5]:
        t = f.get_tensor(k)
        print(f"    {k}  shape={t.shape}  dtype={t.dtype}")
    total = sum(f.get_tensor(k).numel() for k in keys)
    print(f"  总元素: {total:,}")

# ---- 找出一个 LoRA 对应的 base 权重 ----
print("\n=== 对比 base 与 merged 的同一层 ===")
# LoRA 键名格式: base_model.model.model.layers.0.self_attn.q_proj.lora_A.weight
sample_lora = None
for k in keys:
    if "lora_A" in k and "layers.0." in k:
        sample_lora = k
        break
print(f"  取 LoRA 键: {sample_lora}")

if sample_lora:
    # 对应 base 的键: model.layers.0.self_attn.q_proj.weight
    parts = sample_lora.replace("base_model.model.", "").split(".")
    # 去掉最后的 lora_A.weight
    base_key = ".".join(parts[:-2]) + ".weight"
    print(f"  对应 base 键: {base_key}")

    # 读 base 权重
    def load_weight(dir_path, key):
        idx_file = os.path.join(dir_path, "model.safetensors.index.json")
        if os.path.exists(idx_file):
            with open(idx_file, encoding="utf-8") as fh:
                idx = json.load(fh)
            shard = idx["weight_map"].get(key)
            if not shard:
                return None
            with safe_open(os.path.join(dir_path, shard), framework="pt") as f:
                return f.get_tensor(key)
        else:
            with safe_open(os.path.join(dir_path, "model.safetensors"), framework="pt") as f:
                return f.get_tensor(key)

    import torch

    wb = load_weight(F, base_key)
    wm = load_weight(M, base_key)
    print(f"\n  base   shape={wb.shape} dtype={wb.dtype}")
    print(f"  merged shape={tuple(wm.shape)} dtype={wm.dtype}")

    diff = (wb.float() - wm.float()).abs()
    print(f"\n  最大差异: {diff.max():.8f}")
    print(f"  平均差异: {diff.mean().item():.8f}")
    print(f"  不同元素占比: {(diff > 1e-6).float().mean().item() * 100:.4f}%")

    if diff.max().item() < 1e-6:
        print("\n  ❌ base 和 merged 权重完全相同 —— LoRA 没有合并进去")
    else:
        print("\n  ✅ 权重有差异 —— LoRA 生效了")
