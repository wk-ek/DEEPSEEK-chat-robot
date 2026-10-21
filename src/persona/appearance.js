/**
 * 主人格切换时改「外观」：头像、QQ 昵称、各群名片。
 *
 * 注意这些操作的范围不一样：
 *   头像、QQ 昵称  → 账号级，改了全局生效
 *   群名片        → 每个群一份，要逐个群调
 *
 * 全部按「尽力而为」处理：某一项失败只记日志，不打断切人格，也不影响别的项。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('persona:appearance');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 头像再大，QQ 那边容易直接拒收。超过这个就提醒一声。 */
const AVATAR_SOFT_LIMIT = 1024 * 1024;

/** 本地图片 → base64:// URL。读不到返回 null。 */
function toBase64Url(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length > AVATAR_SOFT_LIMIT) {
      log.warn(
        `头像 ${path.basename(String(file))} 有 ${(buf.length / 1024 / 1024).toFixed(1)}MB，偏大，` +
          `QQ 可能拒收。建议压到 512x512 以内（几十到几百 KB）。`
      );
    }
    return { base64: `base64://${buf.toString('base64')}`, bytes: buf.length };
  } catch (err) {
    log.warn(`读头像失败 ${file}：${err.message}`);
    return null;
  }
}

/**
 * 把某个主人格的外观应用上去。
 * @returns {Promise<{avatar: string, nickname: string, cards: number, failed: number}>}
 */
export async function applyIdentityAppearance({ api, identity, selfId }) {
  const cfg = config.persona?.apply || {};
  const out = { avatar: 'skip', nickname: 'skip', cards: 0, failed: 0 };

  if (!identity) return out;

  // ---- 头像（账号级） ----
  if (cfg.avatar !== false) {
    if (!identity.avatar) {
      log.debug(`主人格「${identity.label}」没配可用头像，跳过`);
    } else {
      const data = toBase64Url(identity.avatar);
      if (!data) {
        out.avatar = 'fail';
      } else {
        try {
          await api.setAvatar(data.base64);
          out.avatar = 'ok';
          log.info(`头像 → ${path.basename(identity.avatar)}`);
        } catch (err) {
          out.avatar = 'fail';
          log.warn(`换头像失败：${err.message}`);
        }
      }
    }
  }

  // ---- QQ 昵称（账号级，默认关：影响面比群名片大） ----
  if (cfg.nickname === true && identity.nickname) {
    try {
      await api.setProfile({ nickname: identity.nickname });
      out.nickname = 'ok';
      log.info(`QQ 昵称 → ${identity.nickname}`);
    } catch (err) {
      out.nickname = 'fail';
      log.warn(`改 QQ 昵称失败：${err.message}`);
    }
  }

  // ---- 群名片（逐群） ----
  if (cfg.groupCard !== false && identity.nickname && selfId) {
    const groups = await api.getGroupList();
    const gap = Math.max(0, Number(cfg.throttleMs) || 1500);

    for (const g of groups) {
      const gid = g?.group_id;
      if (!gid) continue;
      try {
        await api.setGroupCard(gid, selfId, identity.nickname);
        out.cards += 1;
      } catch (err) {
        out.failed += 1;
        log.debug(`改群名片失败（群 ${gid}）：${err.message}`);
      }
      if (gap) await sleep(gap);
    }

    if (groups.length) {
      log.info(`群名片 → ${identity.nickname}（成功 ${out.cards}，失败 ${out.failed}）`);
    }
  }

  return out;
}
