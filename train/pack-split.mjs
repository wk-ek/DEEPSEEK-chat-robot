/**
 * 打成两个包：
 *   amiya-env.zip    环境包（Python 依赖 + PyTorch + LLaMA-Factory 源码 + 环境脚本）
 *   amiya-train.zip  训练包（模型 + 数据 + 剧情 + 训练脚本）
 *
 * 用 7z 打包，模型那种已经是二进制压缩过的数据用 -mx1 快速模式。
 *
 *   node train/pack-split.mjs
 *   node train/pack-split.mjs --env-only
 *   node train/pack-split.mjs --train-only
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const BUILD = path.join(ROOT, 'build');
const DIST = path.join(ROOT, 'dist');
const SEVEN_ZIP = path.join(ROOT, 'NapCat', 'OneKey', '7z.exe');

const args = process.argv.slice(2);
const envOnly = args.includes('--env-only');
const trainOnly = args.includes('--train-only');

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');

function exists(p) {
  return fs.existsSync(p);
}

function copyRec(src, dst, filter) {
  if (!exists(src)) return 0;
  const st = fs.statSync(src);
  if (st.isFile()) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return 1;
  }
  let n = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (filter && !filter(s)) continue;
    n += copyRec(s, d, filter);
  }
  return n;
}

function dirSize(dir) {
  if (!exists(dir)) return 0;
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += fs.statSync(p).size;
    }
  };
  walk(dir);
  return total;
}

function fmt(bytes) {
  if (bytes > 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  return (bytes / 1024 ** 2).toFixed(1) + ' MB';
}

function zip(srcDir, outFile, level = 1) {
  console.log(`  压缩 ${path.basename(srcDir)} → ${path.basename(outFile)} (等级 ${level})`);
  const t0 = Date.now();
  // 7z 的 a 命令：-t7z 是 7z 格式，用 -tzip 生成 zip
  execFileSync(SEVEN_ZIP, [
    'a', '-tzip', `-mx=${level}`, '-mmt=on', '-y',
    outFile,
    path.join(srcDir, '*'),
  ], { stdio: 'pipe' });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const size = fs.statSync(outFile).size;
  console.log(`    完成 ${fmt(size)}  ${secs}s`);
  return size;
}

// ============================================================
//  环境包
// ============================================================
function buildEnv() {
  const stage = path.join(BUILD, '_stage_env', 'amiya-env');
  fs.rmSync(path.join(BUILD, '_stage_env'), { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  console.log('\n【环境包】');
  let n = 0;

  // 环境脚本（根目录）
  for (const f of ['安装环境.bat', '安装环境.ps1', '修复安装.bat', '诊断依赖.bat', '诊断依赖.ps1', '本地自检.bat', '本地自检.ps1']) {
    const src = path.join(ROOT, f);
    if (exists(src)) {
      fs.copyFileSync(src, path.join(stage, f));
      n++;
    }
  }
  console.log(`  环境脚本 ${n} 个`);

  // train/vendor（源码 + wheels + torch wheels）
  const vendorSrc = path.join(ROOT, 'train', 'vendor');
  if (exists(vendorSrc)) {
    const c = copyRec(vendorSrc, path.join(stage, 'train', 'vendor'));
    console.log(`  train/vendor（源码+wheels）${c} 个文件  ${fmt(dirSize(path.join(stage, 'train', 'vendor')))}`);
  }

  // train 下的配置（安装时 yaml 可能要用）
  for (const f of ['dataset_info.json']) {
    const src = path.join(ROOT, 'train', f);
    if (exists(src)) {
      fs.mkdirSync(path.join(stage, 'train'), { recursive: true });
      fs.copyFileSync(src, path.join(stage, 'train', f));
    }
  }

  // 说明
  fs.writeFileSync(path.join(stage, 'README-环境包.md'), ENV_README, 'utf8');

  const out = path.join(DIST, `amiya-env-${stamp}.zip`);
  fs.mkdirSync(DIST, { recursive: true });
  fs.rmSync(out, { force: true });
  zip(stage, out, 1);
  fs.rmSync(path.join(BUILD, '_stage_env'), { recursive: true, force: true });
  return out;
}

// ============================================================
//  训练包
// ============================================================
function buildTrain() {
  const stage = path.join(BUILD, '_stage_train', 'amiya-train');
  fs.rmSync(path.join(BUILD, '_stage_train'), { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  console.log('\n【训练包】');

  // 训练脚本（根目录）
  for (const f of ['开始训练.bat', '手动训练.bat', '下载模型.bat', '下载模型.ps1']) {
    const src = path.join(ROOT, f);
    if (exists(src)) fs.copyFileSync(src, path.join(stage, f));
  }
  console.log('  训练脚本 4 个');

  // train（不含 vendor，环境包里有）
  const c1 = copyRec(path.join(ROOT, 'train'), path.join(stage, 'train'), (p) => {
    return !p.includes(path.sep + 'vendor' + path.sep) && !p.includes(path.sep + 'data' + path.sep) && !p.includes(path.sep + 'out' + path.sep);
  });
  console.log(`  train（脚本+配置）${c1} 个文件`);

  // 数据
  const dataSrc = path.join(ROOT, 'train', 'out');
  if (exists(dataSrc)) {
    const c = copyRec(dataSrc, path.join(stage, 'data'));
    const info = path.join(ROOT, 'train', 'dataset_info.json');
    if (exists(info)) fs.copyFileSync(info, path.join(stage, 'data', 'dataset_info.json'));
    console.log(`  data（训练集）${c + 1} 个文件  ${fmt(dirSize(path.join(stage, 'data')))}`);
  }

  // 剧情素材
  const storySrc = 'F:\\ark_story_data\\collected\\合集版';
  if (exists(storySrc)) {
    const c = copyRec(storySrc, path.join(stage, 'story'));
    console.log(`  story（剧情素材）${c} 个文件  ${fmt(dirSize(path.join(stage, 'story')))}`);
  }

  // 模型
  const modelSrc = path.join(BUILD, 'models', 'Qwen3-4B-Instruct-2507');
  if (exists(modelSrc) && fs.readdirSync(modelSrc).length > 0) {
    const dst = path.join(stage, 'models', 'Qwen3-4B-Instruct-2507');
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(modelSrc)) {
      const s = path.join(modelSrc, f);
      if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(dst, f));
    }
    console.log(`  models（Qwen3-4B）${fs.readdirSync(dst).length} 个文件  ${fmt(dirSize(dst))}`);
  } else {
    console.log('  ⚠️ models 目录是空的，模型还没下完');
  }

  // 依赖（脚本依赖的 src）
  copyRec(path.join(ROOT, 'src', 'llm'), path.join(stage, 'src', 'llm'));
  for (const f of ['src/config.js', 'src/logger.js', 'src/memory/lore.js', 'src/persona/identities.js', 'config/persona.amiya.profile.json', 'package.json']) {
    const src = path.join(ROOT, f);
    if (exists(src)) {
      fs.mkdirSync(path.dirname(path.join(stage, f)), { recursive: true });
      fs.copyFileSync(src, path.join(stage, f));
    }
  }

  // 说明
  fs.writeFileSync(path.join(stage, 'README-训练包.md'), TRAIN_README, 'utf8');

  const total = dirSize(stage);
  console.log(`  打包前总体积 ${fmt(total)}`);

  const out = path.join(DIST, `amiya-train-${stamp}.zip`);
  fs.rmSync(out, { force: true });
  zip(stage, out, 1);
  fs.rmSync(path.join(BUILD, '_stage_train'), { recursive: true, force: true });
  return out;
}

const ENV_README = `# 环境包（只需装一次）

这个包含 Python 依赖，装一次之后不用再动。

## 内容

\`\`\`
train/vendor/
├── LLaMA-Factory/   LLaMA-Factory 源码
├── wheels/          82 个依赖 wheel（transformers / datasets / peft / trl 等）
└── torch-wheels/    PyTorch cu121（2.4 GB，从 PyTorch 官方源下载的 CUDA 版）
\`\`\`

## 安装顺序

\`\`\`
1. 双击 安装环境.bat     装 Python 3.12 + PyTorch cu121
   （如果 Python 已经是 3.12，会自动跳过）
2. 双击 修复安装.bat     装 LLaMA-Factory 和 82 个依赖（全离线）
3. 双击 诊断依赖.bat     确认 15 个模块都能 import（可选但推荐）
\`\`\`

三步都跑完，环境就绪。之后换训练包不需要重装。

## 注意

- 安装环境.bat 会先检测，能跳过就跳过
- 修复安装.bat 用 --no-deps 装，绕过 pip 对 sentencepiece 的依赖检查
  （sentencepiece 在 Windows Server 上会崩，Qwen3 不需要它）
- 全程不需要外网（除了 安装环境.bat 装 Python 那一步，如果你的 Python 已经够新就不用）
`;

const TRAIN_README = `# 训练包（可以反复替换）

环境装好之后，只用这个包。

## 内容

\`\`\`
models/Qwen3-4B-Instruct-2507/   模型 7.51 GB（已下好，不用联网）
data/                            训练集 wisdom 2045 / persona 4824 / extra 59
story/                           剧情素材 553 个文件
train/                           训练脚本和配置
开始训练.bat                      完整流程
手动训练.bat                      只跑 Stage 1（看真实输出）
\`\`\`

## 用法

\`\`\`
双击 开始训练.bat
\`\`\`

会自动串起三阶段：智慧层 → 说话层 → 同人层。

## 前提

**必须先跑过环境包的 安装环境.bat 和 修复安装.bat。**

如果没装，训练时会报模块缺失。这时去装环境包。
`;

// ============================================================
console.log('=== 分包打包 ===');
if (!exists(SEVEN_ZIP)) {
  console.log('找不到 7z.exe：' + SEVEN_ZIP);
  process.exit(1);
}

const results = [];
if (!trainOnly) results.push(['环境包', buildEnv()]);
if (!envOnly) results.push(['训练包', buildTrain()]);

console.log('\n=== 完成 ===');
for (const [name, f] of results) {
  console.log(`  ${name}: ${f}  ${fmt(fs.statSync(f).size)}`);
}
