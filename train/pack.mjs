/**
 * 打包成「可以直接上传到云端」的压缩包。
 *
 * 为什么需要：训练脚本依赖仓库里的 src/llm（调 API）和 config/persona.amiya.profile.json
 * （读人格）。单独传 train/ 目录会缺依赖，所以打包时把最小依赖一起带上，
 * 云端解压后 cd train && bash run.sh 就能跑。
 *
 *   node train/pack.mjs
 *   node train/pack.mjs --with-data    把本地已生成的 train/out 一起打包
 *
 * 产出：dist/amiya-train-<日期>.zip
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const withData = args.includes('--with-data');
const withStory = args.includes('--with-story');
const STORY_SRC = process.env.ARK_STORY_ROOT || 'F:\\ark_story_data\\collected\\合集版';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, '_stage', 'amiya-train');

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const ZIP = path.join(DIST, `amiya-train-${stamp}.zip`);

/** 要带上的东西 */
const INCLUDE = [
  // 训练本体
  { from: 'train', to: 'train', filter: (f) => !f.includes(path.sep + 'data' + path.sep) && !f.includes(path.sep + 'out' + path.sep) },
  // 脚本依赖：调 API、读人格
  { from: 'src/llm', to: 'src/llm' },
  { from: 'src/config.js', to: 'src/config.js' },
  { from: 'src/logger.js', to: 'src/logger.js' },
  { from: 'src/memory/lore.js', to: 'src/memory/lore.js' },
  { from: 'src/persona/identities.js', to: 'src/persona/identities.js' },
  // 人格档案（生成数据时要用）
  { from: 'config/persona.amiya.profile.json', to: 'config/persona.amiya.profile.json' },
  // 基础配置
  { from: 'config/config.example.json', to: 'config/config.example.json' },
  // 根目录的启动脚本（解压后直接双击用）
  { from: '本地自检.bat', to: '本地自检.bat' },
  { from: '本地自检.ps1', to: '本地自检.ps1' },
  { from: '安装环境.bat', to: '安装环境.bat' },
  { from: '安装环境.ps1', to: '安装环境.ps1' },
  { from: '开始训练.bat', to: '开始训练.bat' },
  { from: '诊断依赖.bat', to: '诊断依赖.bat' },
  { from: '诊断依赖.ps1', to: '诊断依赖.ps1' },
  { from: '手动训练.bat', to: '手动训练.bat' },
  { from: '修复安装.bat', to: '修复安装.bat' },
  { from: 'package.json', to: 'package.json' },
];

function copyRecursive(src, dst, filter) {
  if (!fs.existsSync(src)) return 0;
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
    n += copyRecursive(s, d, filter);
  }
  return n;
}

// ---- 清理并复制 ----
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

let count = 0;
console.log('打包内容：');
for (const item of INCLUDE) {
  const src = path.join(ROOT, item.from);
  const dst = path.join(STAGE, item.to);
  if (!fs.existsSync(src)) {
    console.log(`  ⚠️  跳过（不存在）：${item.from}`);
    continue;
  }
  const n = copyRecursive(src, dst, item.filter);
  console.log(`  ${item.to.padEnd(38)} ${n} 个文件`);
  count += n;
}

// ---- 可选：带上已生成的数据 ----
if (withData) {
  const outDir = path.join(ROOT, 'train', 'out');
  if (fs.existsSync(outDir)) {
    const dst = path.join(STAGE, 'data');
    fs.mkdirSync(dst, { recursive: true });
    let n = 0;
    for (const f of fs.readdirSync(outDir).filter((x) => x.endsWith('.jsonl'))) {
      fs.copyFileSync(path.join(outDir, f), path.join(dst, f));
      n++;
    }
    fs.copyFileSync(path.join(ROOT, 'train', 'dataset_info.json'), path.join(dst, 'dataset_info.json'));
    console.log(`  ${'data/（训练数据）'.padEnd(38)} ${n} 个文件`);
    count += n;
  } else {
    console.log('  ⚠️  没有 train/out，--with-data 无数据可带');
  }
}

// ---- 可选：带上剧情素材 ----
if (withStory) {
  if (!fs.existsSync(STORY_SRC)) {
    console.log(`  ⚠️  剧情目录不存在：${STORY_SRC}`);
  } else {
    console.log('  正在复制剧情素材（约 37 MB）…');
    const dst = path.join(STAGE, 'story');
    let n = 0;
    for (const e of fs.readdirSync(STORY_SRC, { withFileTypes: true })) {
      if (e.isDirectory()) n += copyRecursive(path.join(STORY_SRC, e.name), path.join(dst, e.name));
    }
    console.log(`  ${'story/（剧情素材）'.padEnd(38)} ${n} 个文件`);
    count += n;
  }
}

// ---- 附一份上传说明 ----
const README = `# 上传说明

## 包里有什么

\`\`\`
amiya-train/
├── train/           训练脚本 + 配置 + run.sh
├── src/             脚本依赖（调 API、读人格）
├── config/          人格档案 + 配置模板
└── package.json
\`\`\`

${withData ? '**本包已包含训练数据（data/ 目录）**，可以直接开训。' : '**本包不含训练数据**，需要用 `bash run.sh --auto` 现场生成（要剧情文本 + API key）。'}

## 怎么用

\`\`\`bash
# 1. 上传并解压到 /workspace
cd /workspace && unzip amiya-train-*.zip
cd amiya-train

# 2. 配 API key（只有 --auto 生成数据时才需要）
cp config/config.example.json config/config.json
export DEEPSEEK_API_KEY=sk-xxxx

# 3. 检查环境
bash train/run.sh --dry

# 4. 开训
${withData ? 'cp data/*.jsonl /workspace/data/ && cp data/dataset_info.json /workspace/data/\nbash train/run.sh' : 'bash train/run.sh --auto'}
\`\`\`

## 三种训练模式

| 命令 | 做什么 | 产出 |
| --- | --- | --- |
| \`bash train/run.sh\` | 用已有数据训两阶段 | 纯官方版 |
| \`bash train/run.sh --auto\` | 现场生成数据再训 | 纯官方版 |
| \`bash train/run.sh --official-only\` | 只训官方，跳过同人层 | 纯官方版 |

有 \`extra.jsonl\` 时会自动多训一层同人版，产物是：
- \`amiya-official\` 纯官方（推荐主用）
- \`amiya-extra\` 官方 + 同人

## 成本

- 数据生成（--auto）：约 5-10 元 API
- GPU：约 1-1.5 小时，3-5 元
- **合计 8-15 元**

⚠️ 跑完立刻关机。
`;

fs.writeFileSync(path.join(STAGE, 'README-上传说明.md'), README, 'utf8');
count++;

// ---- 压缩 ----
fs.mkdirSync(DIST, { recursive: true });
fs.rmSync(ZIP, { force: true });

try {
  // Windows 自带 tar 或 PowerShell 压缩
  if (process.platform === 'win32') {
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `Compress-Archive -Path "${path.join(DIST, '_stage', '*')}" -DestinationPath "${ZIP}" -Force`],
      { stdio: 'pipe' }
    );
  } else {
    execFileSync('zip', ['-rq', ZIP, '.'], { cwd: path.join(DIST, '_stage'), stdio: 'pipe' });
  }
} catch (err) {
  console.error(`压缩失败：${err.message}`);
  console.error(`文件已在 ${path.join(DIST, '_stage')}，可手动压缩`);
  process.exit(1);
}

fs.rmSync(path.join(DIST, '_stage'), { recursive: true, force: true });

const size = fs.statSync(ZIP).size;
console.log(`\n✅ 打包完成`);
console.log(`   ${ZIP}`);
console.log(`   ${(size / 1024 / 1024).toFixed(2)} MB，${count} 个文件`);
console.log(`\n上传到服务器后：`);
console.log(`   unzip ${path.basename(ZIP)} && cd amiya-train`);
console.log(`   bash train/run.sh${withData ? '' : ' --auto'}`);
