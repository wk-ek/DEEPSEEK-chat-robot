import { createLogger } from '../logger.js';

const log = createLogger('onebot:api');

/** 本地路径 → OneBot 可识别的 file:// URL。 */
function toFileUrl(p) {
  const s = String(p);
  if (/^https?:\/\//i.test(s) || s.startsWith('file://') || s.startsWith('base64://')) return s;
  return `file:///${s.replace(/\\/g, '/').replace(/^\/+/, '')}`;
}

/** OneBot v11 常用 API 的薄封装，统一用纯文本发送，避免 CQ 码注入。 */
export function createApi(client) {
  const textMsg = (text) => [{ type: 'text', data: { text } }];

  return {
    async sendPrivate(userId, text, { sticker } = {}) {
      const message = [];
      if (text) message.push(...textMsg(text));
      if (sticker) message.push({ type: 'image', data: { file: toFileUrl(sticker) } });
      return client.call('send_private_msg', { user_id: Number(userId), message });
    },

    async sendGroup(groupId, text, { atUserId, replyMsgId, sticker } = {}) {
      const message = [];
      if (replyMsgId) message.push({ type: 'reply', data: { id: String(replyMsgId) } });
      if (atUserId) message.push({ type: 'at', data: { qq: String(atUserId) } });
      if (text) message.push(...textMsg(text));
      if (sticker) message.push({ type: 'image', data: { file: toFileUrl(sticker) } });
      return client.call('send_group_msg', { group_id: Number(groupId), message });
    },

    async getLoginInfo() {
      const res = await client.call('get_login_info', {});
      return res.data;
    },

    async getStrangerInfo(userId) {
      try {
        const res = await client.call('get_stranger_info', { user_id: Number(userId), no_cache: false });
        return res.data;
      } catch (err) {
        log.debug(`拉取用户资料失败 ${userId}: ${err.message}`);
        return null;
      }
    },

    async getGroupMemberInfo(groupId, userId) {
      try {
        const res = await client.call('get_group_member_info', {
          group_id: Number(groupId),
          user_id: Number(userId),
          no_cache: false,
        });
        return res.data;
      } catch (err) {
        log.debug(`拉取群成员失败 ${groupId}/${userId}: ${err.message}`);
        return null;
      }
    },

    async getGroupList() {
      try {
        const res = await client.call('get_group_list', {});
        return res.data || [];
      } catch {
        return [];
      }
    },

    /** 给消息贴个表情回应，像真人一样"已读"一下，轻微但很有用 */
    async react(messageId, emojiId = '128077') {
      try {
        await client.call('set_msg_emoji_like', {
          message_id: Number(messageId),
          emoji_id: String(emojiId),
        });
      } catch {
        /* 有些版本不支持，忽略即可 */
      }
    },

    /**
     * 换账号头像。file 支持 base64:// / file:// / 绝对路径。
     * 注意这是账号级的，一改所有地方都变。
     */
    async setAvatar(file) {
      if (!file) throw new Error('setAvatar 需要一个文件');
      return client.call('set_qq_avatar', { file: String(file) });
    },

    /**
     * 改账号昵称 / 个性签名。同样是账号级，影响面比群名片大。
     * 只传想改的字段，没传的不动。
     */
    async setProfile({ nickname, personalNote } = {}) {
      const params = {};
      if (nickname) params.nickname = String(nickname);
      if (personalNote) params.personal_note = String(personalNote);
      if (!Object.keys(params).length) throw new Error('setProfile 至少要给一个字段');
      return client.call('set_qq_profile', params);
    },

    /** 改自己在某个群里的名片。只对这个群生效。 */
    async setGroupCard(groupId, userId, card) {
      if (!groupId || !userId) throw new Error('setGroupCard 缺 group_id 或 user_id');
      return client.call('set_group_card', {
        group_id: String(groupId),
        user_id: String(userId),
        card: String(card || ''),
      });
    },
  };
}
