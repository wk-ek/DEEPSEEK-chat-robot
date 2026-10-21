/**
 * 下载 NapCat.Shell.zip（可复用，以后升级版本也能跑）。
 *
 *   node scripts/fetch-napcat.mjs              下载最新版到 ../NapCat/
 *   node scripts/fetch-napcat.mjs --tag v4.18.38   指定版本
 *   node scripts/fetch-napcat.mjs --out D:\NapCat  指定目录
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const args = process.argv.slice(2);
const getArg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const OUT_DIR = path.resolve(getArg('out', path.join(ROOT, '..', 'NapCat')));
const TAG = getArg('tag', null);
const ASSET_NAME = getArg('asset', 'NapCat.Shell.zip');

const C = { dim: '\x1b[90m', green: '\x1b[32m', red: '\x1b[31m', reset: '\x1b[0m', bold: '\x1b[1m' };
const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;

async function resolveAsset() {
  const api = TAG
    ? `https://api.github.com/repos/NapNeko/NapCatQQ/releases/tags/${TAG}`
    : 'https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest';
  const res = await fetch(api, {
    headers: { 'User-Agent': 'dsh-agent', Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`查询版本失败 HTTP ${res.status}`);
  const json = await res.json();
  const asset = (json.assets || []).find((a) => a.name === ASSET_NAME);
  if (!asset) {
    throw new Error(
      `版本 ${json.tag_name} 里没有 ${ASSET_NAME}，可用资产：\n` +
        (json.assets || []).map((a) => `  - ${a.name}`).join('\n')
    );
  }
  return { tag: json.tag_name, asset };
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': 'dsh-agent' } });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  const file = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  let got = 0;
  let lastTick = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.byteLength;
    if (!file.write(Buffer.from(value))) {
      await new Promise((r) => file.once('drain', r));
    }
    if (Date.now() - lastTick > 400) {
      lastTick = Date.now();
      const pct = total ? Math.floor((got / total) * 100) : 0;
      process.stdout.write(`\r  下载中 ${mb(got)}${total ? ' / ' + mb(total) : ''}  ${pct}%   `);
    }
  }
  await new Promise((resolve, reject) => file.end((err) => (err ? reject(err) : resolve())));
  process.stdout.write(`\r  下载完成 ${mb(got)}                    \n`);
  return got;
}

async function main() {
  console.log(`\n${C.bold}  获取 NapCat${C.reset}\n`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const { tag, asset } = await resolveAsset();
  console.log(`  版本   ${C.green}${tag}${C.reset}`);
  console.log(`  文件   ${asset.name}  ${C.dim}(${mb(asset.size)})${C.reset}`);
  console.log(`  目录   ${OUT_DIR}`);

  const zipPath = path.join(OUT_DIR, asset.name);
  if (fs.existsSync(zipPath) && fs.statSync(zipPath).size === asset.size) {
    console.log(`  ${C.dim}已存在且大小一致，跳过下载${C.reset}\n`);
  } else {
    console.log('');
    await download(asset.browser_download_url, zipPath);
  }

  // 写一个版本标记，方便以后判断
  fs.writeFileSync(
    path.join(OUT_DIR, '.version'),
    JSON.stringify({ tag, asset: asset.name, downloadedAt: new Date().toISOString() }, null, 2)
  );

  console.log(`\n  ${C.green}✓ 下载完成${C.reset}  ${zipPath}`);
  console.log(`  ${C.dim}下一步：解压，然后双击 launcher.bat 扫码登录${C.reset}\n`);
}

main().catch((err) => {
  console.error(`\n  ${C.red}✗ ${err.message}${C.reset}\n`);
  process.exit(1);
});
