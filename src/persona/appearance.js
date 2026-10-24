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
import { config, envConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('persona:appearance');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 头像再大，QQ 那边容易直接拒收。超过这个就提醒一声。 */
const AVATAR_SOFT_LIMIT = 1024 * 1024;

/**
 * 群名片上的名字。
 *
 * 本地模型（Ollama）和云端 API 的能力差很多，群里只看名字分不出来，
 * 所以在名片后面挂个「（本地模型）」，让人一眼知道现在是谁在回话。
 *
 * 幂等：先剥掉结尾的旧括号后缀再加，重复调用不会变成
 * 「大肥鱼（本地模型）（本地模型）」。
 */
const LOCAL_SUFFIX = '（本地模型）';

export function cardNameFor(nickname, provider) {
  if (!nickname) return nickname;
  const base = String(nickname).replace(/（[^（）]*）\s*$/, '').trim();
  if (!base) return nickname;
  const p = provider ?? envConfig.provider;
  return p === 'local' ? `${base}${LOCAL_SUFFIX}` : base;
}

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
 * 只改某一个群的群名片，不动头像。
 *
 * 用在「群内切换人格」的场景：每个群可以有自己的人格，但头像属于账号级，
 * 一个群改了别的群也会跟着变 —— 所以干脆只改名片，靠名字区分。
 */
export async function applyGroupCardOnly({ api, groupId, selfId, identity, mode }) {
  const base = mode?.nickname || identity?.nickname;
  if (!base || !groupId || !selfId) return { ok: false, reason: 'missing' };
  const nickname = cardNameFor(base);
  try {
    await api.setGroupCard(groupId, selfId, nickname);
    log.info(`群 ${groupId} 名片 → ${nickname}`);
    return { ok: true, nickname };
  } catch (err) {
    log.warn(`改群名片失败（群 ${groupId}）：${err.message}`);
    return { ok: false, reason: err.message };
  }
}

/**
 * 把某个主人格的外观应用上去。
 *
 * @param mode 子人格。子人格可以覆盖头像和昵称（换一张脸、名字换成另一个）；
 *             不覆盖的部分继承主人格。退出子人格时再用同一个函数恢复。
 * @param {number} [throttleMs] 覆盖配置里的群名片间隔（测试时传 0 就不用等）
 * @returns {Promise<{avatar: string, nickname: string, cards: number, failed: number}>}
 */
export async function applyIdentityAppearance({ api, identity, mode, selfId, throttleMs }) {
  const cfg = config.persona?.apply || {};
  const out = { avatar: 'skip', nickname: 'skip', cards: 0, failed: 0 };

  if (!identity) return out;

  // 子人格优先，没有就继承主人格
  const avatar = mode?.avatar || identity.avatar;
  const nickname = mode?.nickname || identity.nickname;
  const who = mode?.label ? `${identity.label}·${mode.label}` : identity.label;

  // ---- 头像（账号级） ----
  if (cfg.avatar !== false) {
    if (!avatar) {
      log.debug(`「${who}」没配可用头像，跳过`);
    } else {
      const data = toBase64Url(avatar);
      if (!data) {
        out.avatar = 'fail';
      } else {
        try {
          await api.setAvatar(data.base64);
          out.avatar = 'ok';
          log.info(`头像 → ${path.basename(avatar)}（${who}）`);
        } catch (err) {
          out.avatar = 'fail';
          log.warn(`换头像失败：${err.message}`);
        }
      }
    }
  }

  // ---- QQ 昵称（账号级，默认关：影响面比群名片大） ----
  if (cfg.nickname === true && nickname) {
    try {
      await api.setProfile({ nickname });
      out.nickname = 'ok';
      log.info(`QQ 昵称 → ${nickname}`);
    } catch (err) {
      out.nickname = 'fail';
      log.warn(`改 QQ 昵称失败：${err.message}`);
    }
  }

  // ---- 群名片（逐群） ----
  if (cfg.groupCard !== false && nickname && selfId) {
    const groups = await api.getGroupList();
    const gap =
      throttleMs != null ? Math.max(0, Number(throttleMs) || 0) : Math.max(0, Number(cfg.throttleMs) || 1500);

    // 本地模型的名片后面挂「（本地模型）」，云端保持原名
    const cardName = cardNameFor(nickname);

    for (const g of groups) {
      const gid = g?.group_id;
      if (!gid) continue;
      try {
        await api.setGroupCard(gid, selfId, cardName);
        out.cards += 1;
      } catch (err) {
        out.failed += 1;
        log.debug(`改群名片失败（群 ${gid}）：${err.message}`);
      }
      if (gap) await sleep(gap);
    }

    if (groups.length) {
      log.info(`群名片 → ${cardName}（成功 ${out.cards}，失败 ${out.failed}）`);
    }
  }

  return out;
}
