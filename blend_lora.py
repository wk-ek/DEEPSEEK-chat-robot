"""把两个 LoRA adapter 按比例插值合并。

背景：Stage 1 学知识、Stage 2 学语气，但 Stage 2 的数据量是 Stage 1 的 2.4 倍，
训练时把 Stage 1 的权重盖掉了（灾难性遗忘）。两个 adapter 结构相同（r=32、
target_modules 一致），所以可以直接对权重做线性插值，取一个折中。

用法：
    py -3.12 blend_lora.py <stage1目录> <stage2目录> <输出目录> [alpha]

    alpha 是 stage1 的权重比例：
      0.0 = 纯 stage2（只有语气，没知识）
      1.0 = 纯 stage1（只有知识，没语气）
      0.4 = 默认，偏语气但保留一部分知识
"""
import os
import sys

from safetensors.torch import load_file, save_file
import torch


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        return 1

    s1_dir, s2_dir, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    alpha = float(sys.argv[4]) if len(sys.argv) > 4 else 0.4

    s1_path = os.path.join(s1_dir, "adapter_model.safetensors")
    s2_path = os.path.join(s2_dir, "adapter_model.safetensors")
    for p in (s1_path, s2_path):
        if not os.path.exists(p):
            print(f"[错误] 找不到 {p}")
            return 1

    print(f"stage1: {s1_path}  (权重 {alpha})")
    print(f"stage2: {s2_path}  (权重 {1 - alpha})")
    print(f"输出  : {out_dir}")
    print()

    a = load_file(s1_path)
    b = load_file(s2_path)

    print(f"stage1 张量: {len(a)}")
    print(f"stage2 张量: {len(b)}")

    only_a = set(a) - set(b)
    only_b = set(b) - set(a)
    if only_a or only_b:
        print(f"[警告] 键不一致：只有 stage1 {len(only_a)} 个，只有 stage2 {len(only_b)} 个")
        for k in list(only_a)[:3]:
            print(f"  只有 s1: {k}")
        for k in list(only_b)[:3]:
            print(f"  只有 s2: {k}")

    common = sorted(set(a) & set(b))
    print(f"公共张量: {len(common)}")
    print()

    merged = {}
    for k in common:
        ta, tb = a[k], b[k]
        if ta.shape != tb.shape:
            print(f"[跳过] {k} 形状不同 {tuple(ta.shape)} vs {tuple(tb.shape)}")
            merged[k] = tb
            continue
        # 用 float32 中间计算，避免 fp16 精度损失
        merged[k] = (alpha * ta.float() + (1 - alpha) * tb.float()).to(tb.dtype)

    # 只在一个里的，按原样带过去（正常情况不该有）
    for k in only_a:
        merged[k] = a[k]

    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "adapter_model.safetensors")
    save_file(merged, out_path)
    print(f"OK 写入 {out_path}  ({os.path.getsize(out_path) / 1024 / 1024:.1f} MB)")

    # adapter_config.json 用 stage2 的（r、target_modules 都一样）
    cfg_src = os.path.join(s2_dir, "adapter_config.json")
    cfg_dst = os.path.join(out_dir, "adapter_config.json")
    if os.path.exists(cfg_src):
        with open(cfg_src, encoding="utf-8") as f:
            cfg = f.read()
        with open(cfg_dst, "w", encoding="utf-8") as f:
            f.write(cfg)
        print(f"OK 复制 adapter_config.json")

    return 0


if __name__ == "__main__":
    sys.exit(main())
