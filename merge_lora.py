r"""
把 LoRA 合并进基础模型，产出可直接用的完整模型。

用法：
    py -3.12 merge_lora.py

输入：
    F:\qq-deepseek-robot\build\models\Qwen3-4B-Instruct-2507   基础模型
    F:\amiya-training\stage2\                                   LoRA（含 Stage1+Stage2）

输出：
    F:\amiya-training\amiya-4b\                                 完整模型（fp16，约 8 GB）
"""
import gc
import os
import sys
import time

F = r"F:\qq-deepseek-robot\build\models\Qwen3-4B-Instruct-2507"
L = r"F:\amiya-training\stage2"
O = r"F:\amiya-training\amiya-4b"


def human(n):
    return f"{n / 1024 ** 3:.2f} GB"


def main():
    # ---- 检查输入 ----
    for p, name in ((F, "基础模型"), (L, "LoRA")):
        if not os.path.isdir(p):
            print(f"[错误] 找不到{name}：{p}")
            return 1
    if not os.path.exists(os.path.join(F, "config.json")):
        print(f"[错误] 基础模型缺 config.json")
        return 1
    if not os.path.exists(os.path.join(L, "adapter_model.safetensors")):
        print(f"[错误] LoRA 缺 adapter_model.safetensors")
        return 1

    base_size = sum(
        os.path.getsize(os.path.join(F, f))
        for f in os.listdir(F)
        if f.endswith(".safetensors")
    )
    lora_size = os.path.getsize(os.path.join(L, "adapter_model.safetensors"))
    print(f"基础模型: {human(base_size)}")
    print(f"LoRA:     {human(lora_size)}")
    print(f"输出目录: {O}")
    print()

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import PeftModel

    torch.set_grad_enabled(False)

    # ---- 加载基础模型 ----
    print("[1/4] 加载基础模型（fp16，low_cpu_mem_usage）...")
    t0 = time.time()
    model = AutoModelForCausalLM.from_pretrained(
        F,
        torch_dtype=torch.float16,
        device_map="cpu",
        low_cpu_mem_usage=True,
        trust_remote_code=False,
    )
    print(f"      完成 {time.time() - t0:.0f}s")

    # ---- 加载 LoRA ----
    print("[2/4] 挂载 LoRA...")
    t0 = time.time()
    model = PeftModel.from_pretrained(model, L)
    n_train = sum(p.numel() for p in model.parameters() if p.requires_grad)
    n_all = sum(p.numel() for p in model.parameters())
    print(f"      完成 {time.time() - t0:.0f}s")
    print(f"      LoRA 参数 {n_train:,} / 总参数 {n_all:,}")

    # ---- 合并 ----
    print("[3/4] 合并权重（把 LoRA delta 加到 base 上）...")
    t0 = time.time()
    model = model.merge_and_unload()
    gc.collect()
    print(f"      完成 {time.time() - t0:.0f}s")

    # ---- 保存 ----
    print("[4/4] 保存模型...")
    t0 = time.time()
    os.makedirs(O, exist_ok=True)
    model.save_pretrained(O, safe_serialization=True, max_shard_size="4GB")
    print(f"      权重完成 {time.time() - t0:.0f}s")

    print("      保存 tokenizer...")
    tok = AutoTokenizer.from_pretrained(F)
    tok.save_pretrained(O)

    total = sum(
        os.path.getsize(os.path.join(O, f))
        for f in os.listdir(O)
        if os.path.isfile(os.path.join(O, f))
    )
    print()
    print("=" * 56)
    print(f"完成！输出 {human(total)}")
    print(f"目录：{O}")
    print("=" * 56)
    print()
    print("文件清单：")
    for f in sorted(os.listdir(O)):
        p = os.path.join(O, f)
        if os.path.isfile(p):
            print(f"  {f}  {human(os.path.getsize(p))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
