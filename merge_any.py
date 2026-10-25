r"""通用 LoRA 合并脚本：把指定 adapter 合进基础模型。

用法：
    py -3.12 merge_any.py <lora目录> <输出目录>

例：
    py -3.12 merge_any.py F:\\amiya-training\\stage1-wisdom F:\\amiya-training\\stage1-merged
    py -3.12 merge_any.py F:\\amiya-training\\stage2        F:\\amiya-training\\stage2-merged
"""
import gc
import os
import sys
import time

BASE = r"F:\qq-deepseek-robot\build\models\Qwen3-4B-Instruct-2507"


def human(n):
    return f"{n / 1024 ** 3:.2f} GB"


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    lora_dir = sys.argv[1]
    out_dir = sys.argv[2]

    if not os.path.isdir(lora_dir):
        print(f"[错误] 找不到 LoRA 目录：{lora_dir}")
        return 1
    if not os.path.exists(os.path.join(lora_dir, "adapter_model.safetensors")):
        print(f"[错误] {lora_dir} 里没有 adapter_model.safetensors")
        return 1

    print(f"基础模型: {BASE}")
    print(f"LoRA    : {lora_dir}")
    print(f"输出    : {out_dir}")
    print()

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import PeftModel

    torch.set_grad_enabled(False)

    print("[1/4] 加载基础模型...")
    t0 = time.time()
    model = AutoModelForCausalLM.from_pretrained(
        BASE,
        torch_dtype=torch.float16,
        device_map="cpu",
        low_cpu_mem_usage=True,
    )
    print(f"      完成 {time.time() - t0:.0f}s")

    print("[2/4] 挂载 LoRA...")
    t0 = time.time()
    model = PeftModel.from_pretrained(model, lora_dir)
    print(f"      完成 {time.time() - t0:.0f}s")

    print("[3/4] 合并...")
    t0 = time.time()
    model = model.merge_and_unload()
    gc.collect()
    print(f"      完成 {time.time() - t0:.0f}s")

    print("[4/4] 保存...")
    t0 = time.time()
    os.makedirs(out_dir, exist_ok=True)
    model.save_pretrained(out_dir, safe_serialization=True, max_shard_size="4GB")
    tok = AutoTokenizer.from_pretrained(BASE)
    tok.save_pretrained(out_dir)
    print(f"      完成 {time.time() - t0:.0f}s")

    total = sum(
        os.path.getsize(os.path.join(out_dir, f))
        for f in os.listdir(out_dir)
        if os.path.isfile(os.path.join(out_dir, f))
    )
    print()
    print(f"OK {out_dir}  {human(total)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
