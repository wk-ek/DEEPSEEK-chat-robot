#!/usr/bin/env bash
# ============================================================
#  阿米娅人格模型 · 一键训练
#
#  用法（在云端容器里）：
#      bash run.sh                 完整两阶段
#      bash run.sh --stage1-only   只训智慧层
#      bash run.sh --skip-export   训完不导出
#      bash run.sh --dry           只检查环境，不训练
#
#  前置：数据已经放到 /workspace/data/
#      wisdom.jsonl  wisdom_val.jsonl
#      persona.jsonl persona_val.jsonl
#      dataset_info.json
# ============================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; DIM='\033[2m'; NC='\033[0m'
say()  { echo -e "${CYAN}▸${NC} $*"; }
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}!${NC} $*"; }
die()  { echo -e "${RED}✗${NC} $*"; exit 1; }

DATA_DIR="${DATA_DIR:-/workspace/data}"
OUT_DIR="${OUT_DIR:-/workspace/output}"
BASE_MODEL="${BASE_MODEL:-Qwen/Qwen3-4B-Instruct-2507}"
LF_DIR="${LF_DIR:-/workspace/LLaMA-Factory}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

STAGE1_ONLY=0; SKIP_EXPORT=0; DRY=0
for a in "$@"; do
  case "$a" in
    --stage1-only) STAGE1_ONLY=1 ;;
    --skip-export) SKIP_EXPORT=1 ;;
    --dry)         DRY=1 ;;
    -h|--help)     sed -n '2,20p' "$0"; exit 0 ;;
    *) die "未知参数：$a" ;;
  esac
done

echo -e "\n${CYAN}═══ 阿米娅人格模型 · 两阶段训练 ═══${NC}\n"

# ---------- 1. 环境检查 ----------
say "检查环境"
command -v python3 >/dev/null || die "没有 python3"
python3 -c "import torch; print(f'  torch {torch.__version__}, CUDA {torch.cuda.is_available()}')" 2>/dev/null || die "torch 没装好"
python3 - <<'PY' || die "显存不足或没有 GPU"
import torch, sys
if not torch.cuda.is_available():
    print("  没有可用的 CUDA 设备"); sys.exit(1)
name = torch.cuda.get_device_name(0)
total = torch.cuda.get_device_properties(0).total_memory / 1024**3
print(f"  GPU: {name}  {total:.1f} GB")
if total < 15:
    print(f"  ⚠️  显存 {total:.1f}GB 偏小，4B QLoRA 建议 16GB+（24GB 最稳）")
PY
ok "环境正常"

# ---------- 2. 数据检查 ----------
say "检查数据"
[[ -d "$DATA_DIR" ]] || die "数据目录不存在：$DATA_DIR"
for f in wisdom.jsonl wisdom_val.jsonl persona.jsonl persona_val.jsonl dataset_info.json; do
  [[ -f "$DATA_DIR/$f" ]] || die "缺少 $DATA_DIR/$f
  请把 train/out/ 下的 jsonl 和 train/dataset_info.json 上传到 $DATA_DIR"
  n=$(wc -l < "$DATA_DIR/$f" 2>/dev/null || echo 0)
  [[ "$f" == *.jsonl ]] && echo -e "  ${DIM}$f  $n 条${NC}"
done
ok "数据齐全"

# ---------- 3. 装 LLaMA-Factory ----------
if ! command -v llamafactory-cli >/dev/null 2>&1; then
  say "安装 LLaMA-Factory（首次约 3-5 分钟）"
  if [[ ! -d "$LF_DIR" ]]; then
    git clone --depth 1 https://github.com/hiyouga/LLaMA-Factory.git "$LF_DIR"
  fi
  cd "$LF_DIR"
  pip install -e ".[torch,metrics,bitsandbytes]" -q || die "依赖安装失败"
  cd - >/dev/null
  ok "安装完成"
else
  ok "LLaMA-Factory 已安装"
fi

if [[ $DRY -eq 1 ]]; then
  echo -e "\n${YELLOW}--dry：只检查，不训练${NC}\n"
  exit 0
fi

mkdir -p "$OUT_DIR"

# ---------- 4. Stage 1：智慧层 ----------
echo -e "\n${CYAN}═══ Stage 1 / 智慧层：让她认识这个世界 ═══${NC}"
say "约 1250 条（干员档案 + 世界观），预计 20-30 分钟"
START=$(date +%s)

llamafactory-cli train "$SCRIPT_DIR/stage1-wisdom.yaml" \
  model_name_or_path="$BASE_MODEL" \
  dataset_dir="$DATA_DIR" \
  output_dir="$OUT_DIR/stage1-wisdom" \
  || die "Stage 1 训练失败"

T1=$(( ($(date +%s) - START) / 60 ))
ok "Stage 1 完成（${T1} 分钟）→ $OUT_DIR/stage1-wisdom"

if [[ $STAGE1_ONLY -eq 1 ]]; then
  echo -e "\n${GREEN}只训了 Stage 1。产物：$OUT_DIR/stage1-wisdom${NC}\n"
  exit 0
fi

# ---------- 5. Stage 2：说话层 ----------
echo -e "\n${CYAN}═══ Stage 2 / 说话层：让她像阿米娅那样说话 ═══${NC}"
say "约 3400 条（剧情对话 + 日常），从 Stage 1 接着训，预计 20-30 分钟"
START=$(date +%s)

llamafactory-cli train "$SCRIPT_DIR/stage2-persona.yaml" \
  model_name_or_path="$BASE_MODEL" \
  dataset_dir="$DATA_DIR" \
  adapter_name_or_path="$OUT_DIR/stage1-wisdom" \
  output_dir="$OUT_DIR/stage2-persona" \
  || die "Stage 2 训练失败"

T2=$(( ($(date +%s) - START) / 60 ))
ok "Stage 2 完成（${T2} 分钟）→ $OUT_DIR/stage2-persona"

# ---------- 6. 导出 ----------
if [[ $SKIP_EXPORT -eq 0 ]]; then
  echo -e "\n${CYAN}═══ 导出合并模型 ═══${NC}"
  say "把 LoRA 合并进基座，并转成 GGUF（Q4_K_M），预计 10 分钟"

  EXPORT_DIR="$OUT_DIR/amiya-merged"
  llamafactory-cli export "$SCRIPT_DIR/stage2-persona.yaml" \
    model_name_or_path="$BASE_MODEL" \
    adapter_name_or_path="$OUT_DIR/stage2-persona" \
    export_dir="$EXPORT_DIR" \
    export_size=4 \
    || warn "合并失败，但 LoRA 权重还在，可以稍后单独导出"

  if [[ -d "$EXPORT_DIR" ]]; then
    ok "合并完成 → $EXPORT_DIR"
    if command -v llama.cpp/convert_hf_to_gguf.py >/dev/null 2>&1; then
      say "转 GGUF"
      python3 llama.cpp/convert_hf_to_gguf.py "$EXPORT_DIR" --outfile "$OUT_DIR/amiya-4b-f16.gguf" --outtype f16 2>/dev/null || warn "GGUF 转换失败（不影响 LoRA 使用）"
    fi
  fi
fi

# ---------- 7. 总结 ----------
echo -e "\n${GREEN}═══ 全部完成 ═══${NC}\n"
echo "  产物："
echo "    $OUT_DIR/stage1-wisdom    智慧层 LoRA"
echo "    $OUT_DIR/stage2-persona   说话层 LoRA（最终）"
[[ -d "$OUT_DIR/amiya-merged" ]] && echo "    $OUT_DIR/amiya-merged     合并后的完整模型"
echo ""
echo -e "  ${YELLOW}⚠️  记得关机！挂一晚上 20-30 元${NC}"
echo ""
echo "  怎么用："
echo "    Ollama:  ollama create amiya -f Modelfile   （Modelfile 见 train/README.md）"
echo "    机器人:  把 .env 的 LLM_PROVIDER 改成 local，指向本地服务"
echo ""
