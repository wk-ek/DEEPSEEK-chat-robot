#!/usr/bin/env bash
# ============================================================
#  阿米娅人格模型 · 一键训练（两阶段官方 + 可选同人层）
#
#  用法（在云端容器里）：
#      bash run.sh                 解压即用：用包里自带的数据直接训
#      bash run.sh --auto          现场生成数据再训（要 API key）
#      bash run.sh                 用已上传的数据训练
#      bash run.sh --official-only 只训纯官方版（推荐先用这个）
#      bash run.sh --dry           只检查环境，不训练
#
#  --auto 模式需要：
#      1. 剧情文本放到 /workspace/story/（ark_story_data 的 collected 目录）
#      2. .env 里配好 DEEPSEEK_API_KEY
#    它会自动跑完数据准备（约 5-10 元 API），然后训练。
# ============================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; DIM='\033[2m'; NC='\033[0m'
say()  { echo -e "${CYAN}▸${NC} $*"; }
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}!${NC} $*"; }
die()  { echo -e "${RED}✗${NC} $*"; exit 1; }
hr()   { echo -e "${DIM}────────────────────────────────────────${NC}"; }

WORKSPACE="${WORKSPACE:-/workspace}"
# 数据目录：优先用包里自带的 data/（解压即用），否则用 /workspace/data
if [[ -z "${DATA_DIR:-}" ]]; then
  if [[ -d "$SCRIPT_DIR/../data" ]] && [[ -f "$SCRIPT_DIR/../data/persona.jsonl" ]]; then
    DATA_DIR="$SCRIPT_DIR/../data"
  else
    DATA_DIR="$WORKSPACE/data"
  fi
fi
OUT_DIR="${OUT_DIR:-$WORKSPACE/output}"
STORY_DIR="${STORY_DIR:-$WORKSPACE/story}"
BASE_MODEL="${BASE_MODEL:-Qwen/Qwen3-4B-Instruct-2507}"
LF_DIR="${LF_DIR:-$WORKSPACE/LLaMA-Factory}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

AUTO=0; OFFICIAL_ONLY=0; DRY=0; SKIP_EXPORT=0
for a in "$@"; do
  case "$a" in
    --auto)          AUTO=1 ;;
    --official-only) OFFICIAL_ONLY=1 ;;
    --dry)           DRY=1 ;;
    --skip-export)   SKIP_EXPORT=1 ;;
    -h|--help)       sed -n '2,18p' "$0"; exit 0 ;;
    *) die "未知参数：$a" ;;
  esac
done

echo -e "\n${CYAN}═══ 阿米娅人格模型 ═══${NC}"
echo -e "${DIM}  两阶段官方训练 + 可选同人层${NC}\n"

# ---------- 1. 环境 ----------
say "检查环境"
command -v python3 >/dev/null || die "没有 python3"
python3 - <<'PY' || die "没有可用的 CUDA"
import torch, sys
if not torch.cuda.is_available():
    print("  ✗ CUDA 不可用"); sys.exit(1)
p = torch.cuda.get_device_properties(0)
print(f"  GPU: {p.name}  {p.total_memory/1024**3:.1f} GB")
if p.total_memory/1024**3 < 15:
    print("  ⚠ 显存偏小，4B QLoRA 建议 16GB+（24GB 最稳）")
PY
ok "环境正常"

# ---------- 2. 数据准备 ----------
if [[ $AUTO -eq 1 ]]; then
  hr; say "自动生成训练数据"
  if [[ ! -f "$REPO_DIR/.env" ]] && [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
    die "缺少 DEEPSEEK_API_KEY。--auto 要调 API 生成数据，请先配置"
  fi
  [[ -d "$STORY_DIR" ]] || die "缺少剧情目录 $STORY_DIR"

  export ARK_STORY_ROOT="$STORY_DIR"

  say "① 干员档案 → 角色知识（免费，约 1 分钟）"
  ( cd "$REPO_DIR" && node train/prepare-wisdom.mjs )

  say "② 剧情章节 → 世界观问答（约 1-2 元，20 分钟）"
  ( cd "$REPO_DIR" && node train/prepare-lore.mjs )

  say "③ 剧情对话 → 她的语气（免费，约 1 分钟）"
  ( cd "$REPO_DIR" && node train/prepare-data.mjs )

  say "④ 生成日常闲聊（约 3-6 元，10 分钟）"
  ( cd "$REPO_DIR" && node train/augment-dialogue.mjs --count 1500 )

  say "⑤ 同人素材（可选，没有就跳过）"
  ( cd "$REPO_DIR" && node train/prepare-extra.mjs --generate 200 ) || warn "同人层跳过"

  say "⑥ 构建训练集"
  ( cd "$REPO_DIR" && node train/build-dataset.mjs )

  # 把产出搬到 data 目录
  mkdir -p "$DATA_DIR"
  for f in wisdom wisdom_val persona persona_val extra extra_val; do
    [[ -f "$REPO_DIR/train/out/$f.jsonl" ]] && cp "$REPO_DIR/train/out/$f.jsonl" "$DATA_DIR/"
  done
  cp "$SCRIPT_DIR/dataset_info.json" "$DATA_DIR/"
  ok "数据就绪"
fi

# ---------- 3. 数据检查 ----------
hr; say "检查数据"
[[ -d "$DATA_DIR" ]] || die "数据目录不存在：$DATA_DIR"
[[ -f "$DATA_DIR/dataset_info.json" ]] || die "缺少 $DATA_DIR/dataset_info.json"

need_wisdom=1; need_persona=1; have_extra=0
[[ -f "$DATA_DIR/wisdom.jsonl" ]] || need_wisdom=0
[[ -f "$DATA_DIR/persona.jsonl" ]] || need_persona=0
[[ -f "$DATA_DIR/extra.jsonl" ]] && have_extra=1

[[ $need_persona -eq 1 ]] || die "缺少 $DATA_DIR/persona.jsonl（Stage 2 必需）"
for f in wisdom wisdom_val persona persona_val; do
  [[ -f "$DATA_DIR/$f.jsonl" ]] && echo -e "  ${DIM}$f.jsonl  $(wc -l < "$DATA_DIR/$f.jsonl") 条${NC}"
done
[[ $have_extra -eq 1 ]] && echo -e "  ${DIM}extra.jsonl  $(wc -l < "$DATA_DIR/extra.jsonl") 条（同人层）${NC}"
ok "数据检查通过"

# ---------- 4. 装 LLaMA-Factory ----------
if ! command -v llamafactory-cli >/dev/null 2>&1; then
  hr; say "安装 LLaMA-Factory（首次约 3-5 分钟）"
  [[ -d "$LF_DIR" ]] || git clone --depth 1 https://github.com/hiyouga/LLaMA-Factory.git "$LF_DIR"
  ( cd "$LF_DIR" && pip install -e ".[torch,metrics,bitsandbytes]" -q ) || die "安装失败"
  ok "安装完成"
else
  ok "LLaMA-Factory 已安装"
fi

[[ $DRY -eq 1 ]] && { echo -e "\n${YELLOW}--dry：只检查，不训练${NC}\n"; exit 0; }

mkdir -p "$OUT_DIR"
TOTAL_START=$(date +%s)

# ---------- 5. Stage 1 ----------
if [[ $need_wisdom -eq 1 ]]; then
  hr; echo -e "${CYAN}Stage 1 / 智慧层：让她认识这个世界${NC}"
  say "约 1250 条，20-30 分钟"
  S=$(date +%s)
  llamafactory-cli train "$SCRIPT_DIR/stage1-wisdom.yaml" \
    model_name_or_path="$BASE_MODEL" dataset_dir="$DATA_DIR" \
    output_dir="$OUT_DIR/stage1-wisdom" || die "Stage 1 失败"
  ok "Stage 1 完成（$(( ($(date +%s)-S)/60 )) 分钟）"
  STAGE2_BASE="$OUT_DIR/stage1-wisdom"
else
  warn "没有 wisdom 数据，跳过 Stage 1（直接训说话层）"
  STAGE2_BASE=""
fi

# ---------- 6. Stage 2 ----------
hr; echo -e "${CYAN}Stage 2 / 说话层：让她像阿米娅那样说话${NC}"
say "约 4900 条，20-30 分钟"
S=$(date +%s)
if [[ -n "$STAGE2_BASE" ]]; then
  llamafactory-cli train "$SCRIPT_DIR/stage2-persona.yaml" \
    model_name_or_path="$BASE_MODEL" dataset_dir="$DATA_DIR" \
    adapter_name_or_path="$STAGE2_BASE" \
    output_dir="$OUT_DIR/stage2-persona" || die "Stage 2 失败"
else
  llamafactory-cli train "$SCRIPT_DIR/stage2-persona.yaml" \
    model_name_or_path="$BASE_MODEL" dataset_dir="$DATA_DIR" \
    output_dir="$OUT_DIR/stage2-persona" || die "Stage 2 失败"
fi
ok "Stage 2 完成（$(( ($(date +%s)-S)/60 )) 分钟）→ 这是【纯官方版】"

# ---------- 7. Stage 3（同人层，可选）----------
FINAL_DIR="$OUT_DIR/stage2-persona"
FINAL_NAME="amiya-official"

if [[ $have_extra -eq 1 && $OFFICIAL_ONLY -eq 0 ]]; then
  hr; echo -e "${CYAN}Stage 3 / 同人层：加一层同人的味道${NC}"
  say "在纯官方版基础上微调，训歪了随时丢掉"
  S=$(date +%s)
  if llamafactory-cli train "$SCRIPT_DIR/stage3-extra.yaml" \
    model_name_or_path="$BASE_MODEL" dataset_dir="$DATA_DIR" \
    adapter_name_or_path="$OUT_DIR/stage2-persona" \
    output_dir="$OUT_DIR/stage3-extra"; then
    ok "Stage 3 完成（$(( ($(date +%s)-S)/60 )) 分钟）→ 这是【官方+同人版】"
    FINAL_DIR="$OUT_DIR/stage3-extra"
    FINAL_NAME="amiya-extra"
  else
    warn "Stage 3 失败，不影响官方版"
  fi
fi

# ---------- 8. 导出 ----------
if [[ $SKIP_EXPORT -eq 0 ]]; then
  hr; echo -e "${CYAN}导出完整模型${NC}"
  say "把 LoRA 合并进基座，10 分钟"

  # 官方版
  llamafactory-cli export "$SCRIPT_DIR/stage2-persona.yaml" \
    model_name_or_path="$BASE_MODEL" \
    adapter_name_or_path="$OUT_DIR/stage2-persona" \
    export_dir="$OUT_DIR/amiya-official-merged" \
    export_size=4 2>/dev/null && ok "官方版 → $OUT_DIR/amiya-official-merged" || warn "官方版合并失败（LoRA 还在）"

  # 同人版
  if [[ "$FINAL_NAME" == "amiya-extra" ]]; then
    llamafactory-cli export "$SCRIPT_DIR/stage3-extra.yaml" \
      model_name_or_path="$BASE_MODEL" \
      adapter_name_or_path="$OUT_DIR/stage3-extra" \
      export_dir="$OUT_DIR/amiya-extra-merged" \
      export_size=4 2>/dev/null && ok "同人版 → $OUT_DIR/amiya-extra-merged" || warn "同人版合并失败（LoRA 还在）"
  fi
fi

# ---------- 9. 总结 ----------
TOTAL=$(( ($(date +%s) - TOTAL_START) / 60 ))
echo -e "\n${GREEN}═══ 全部完成（GPU 共 ${TOTAL} 分钟）═══${NC}\n"
echo "  产物："
[[ -d "$OUT_DIR/amiya-official-merged" ]] && echo "    $OUT_DIR/amiya-official-merged     ← 纯官方版（推荐主用）"
[[ -d "$OUT_DIR/amiya-extra-merged" ]]    && echo "    $OUT_DIR/amiya-extra-merged        ← 官方+同人版"
echo "    $OUT_DIR/stage2-persona            官方版 LoRA"
[[ -d "$OUT_DIR/stage3-extra" ]]          && echo "    $OUT_DIR/stage3-extra              同人层 LoRA"
echo ""
echo -e "  ${YELLOW}⚠️  立刻关机！挂一晚上 20-30 元${NC}"
echo -e "  ${DIM}GPU 预估花费：$(( TOTAL * 3 / 60 )) 元左右（按 3 元/小时）${NC}"
echo ""
echo "  怎么用：见 train/README.md 第六节"
echo ""
