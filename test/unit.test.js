import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toSegments,
  extractText,
  isAt,
  stripAt,
  mentionsName,
  toContextLine,
} from '../src/onebot/parse.js';
import { sanitizeReply, isMuteCommand } from '../src/brain/reply.js';
import { favorTier, normalizeMood } from '../src/persona/state.js';
import {
  normalizeIdentities,
  findIdentity,
  findMode,
  modeOf,
  matchSessionMode,
  matchGlobalExit,
  parsePersonaCommand,
  parseCommandArg,
  describePersona,
  stickerKeysFor,
} from '../src/persona/identities.js';
import { keywords } from '../src/memory/store.js';
import { parseJsonLoose } from '../src/llm/deepseek.js';

test('解析消息段：文本 + @ + 图片', () => {
  const msg = [
    { type: 'at', data: { qq: '10000', name: '小满' } },
    { type: 'text', data: { text: ' 你好 ' } },
    { type: 'image', data: { url: 'x' } },
  ];
  assert.equal(extractText(msg), '@小满 你好 [图片]');
});

test('解析 CQ 码字符串', () => {
  const segs = toSegments('[CQ:at,qq=10000] 在吗[CQ:face,id=1]');
  assert.equal(segs[0].type, 'at');
  assert.equal(segs[0].data.qq, '10000');
  assert.equal(extractText('[CQ:at,qq=10000] 在吗[CQ:face,id=1]'), '@10000 在吗[表情]');
});

test('isAt 只认自己，@全体 不算', () => {
  const me = '10000';
  assert.equal(isAt([{ type: 'at', data: { qq: '10000' } }], me), true);
  assert.equal(isAt([{ type: 'at', data: { qq: '99999' } }], me), false);
  assert.equal(isAt([{ type: 'at', data: { qq: 'all' } }], me), false);
});

test('stripAt 去掉 @ 后保留正文', () => {
  const msg = [
    { type: 'at', data: { qq: '10000' } },
    { type: 'text', data: { text: ' 今晚吃什么' } },
  ];
  assert.equal(stripAt(msg, '10000'), '今晚吃什么');
});

test('mentionsName 命中别名', () => {
  assert.equal(mentionsName('小满你在吗', ['小满', '满']), true);
  assert.equal(mentionsName('今天天气不错', ['小满']), false);
});

test('上下文行带昵称', () => {
  assert.equal(toContextLine({ senderName: '阿泽', text: '在' }), '阿泽: 在');
});

test('sanitizeReply 去掉前缀、markdown、动作描写', () => {
  assert.equal(sanitizeReply('大肥鱼：嗯，我在。'), '嗯，我在。');
  assert.equal(sanitizeReply('鲸鱼娘：嗯。'), '嗯。');
  assert.equal(sanitizeReply('**晚安**'), '晚安');
  assert.equal(sanitizeReply('（叹了口气）好吧。'), '好吧。');
  assert.equal(sanitizeReply('「今天好冷」'), '今天好冷');
  assert.equal(sanitizeReply(''), '');
});

test('isMuteCommand 识别闭嘴指令', () => {
  assert.equal(isMuteCommand('别说话'), true);
  assert.equal(isMuteCommand('闭嘴'), true);
  assert.equal(isMuteCommand('安静点'), true);
  assert.equal(isMuteCommand('先别说'), true);
  assert.equal(isMuteCommand('今天天气不错'), false);
  assert.equal(isMuteCommand(''), false);
  // 超过 16 字的句子不当作指令，避免误伤正常聊天
  assert.equal(isMuteCommand('我跟你说你别说话了这句话听明白没有'), false);
});

test('sanitizeReply 截断超长回复', () => {  const long = '啊'.repeat(1000);
  const out = sanitizeReply(long, '小满', 100);
  assert.ok(out.length <= 201, `实际长度 ${out.length}`);
});

test('favorTier 分段', () => {
  assert.equal(favorTier(5).desc, '戒备、疏离');
  assert.equal(favorTier(30).desc, '刚认识');
  assert.equal(favorTier(50).desc, '有点熟了');
  assert.equal(favorTier(70).desc, '朋友');
  assert.equal(favorTier(95).desc, '很亲近');
});

test('normalizeMood 中英文都能吃', () => {
  assert.equal(normalizeMood('开心'), 'happy');
  assert.equal(normalizeMood('happy'), 'happy');
  assert.equal(normalizeMood('不存在的'), 'calm');
});

test('keywords 提取中文二元组并过滤停用词', () => {
  const k = keywords('我今天去看了电影，很好看');
  assert.ok(k.includes('电影'));
  assert.ok(!k.includes('我们'));
});

test('parseJsonLoose 能吃代码块和脏文本', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('好的，结果是 {"favorDelta": 2} 以上'), { favorDelta: 2 });
  assert.equal(parseJsonLoose('完全不是 JSON'), null);
});

// ---------- 人格：两层结构（主人格 + 子人格） ----------

test('主人格：大肥鱼在用，阿米娅占位', () => {
  const ids = normalizeIdentities();
  assert.equal(ids.length, 2);

  const feiyu = findIdentity('大肥鱼', ids);
  assert.ok(feiyu, '应该能找到大肥鱼');
  assert.equal(feiyu.key, 'feiyu');
  assert.equal(feiyu.enabled, true);
  assert.ok(feiyu.avatar.endsWith('avatar.png'), `头像路径异常：${feiyu.avatar}`);
  assert.equal(feiyu.nickname, '大肥鱼 Robot');

  const amiya = findIdentity('阿米娅', ids);
  assert.ok(amiya, '应该能找到阿米娅');
  assert.equal(amiya.enabled, false, '阿米娅现在应该是占位未启用');
  assert.equal(amiya.modes.length, 0, '阿米娅暂时没有子人格');
  assert.ok(amiya.avatarConfigured.endsWith('avatar_amiya.png'));
});

test('子人格：大肥鱼下面挂三个，空 key 表示正常', () => {
  const feiyu = findIdentity('大肥鱼', normalizeIdentities());

  assert.equal(feiyu.modes.length, 3);
  assert.deepEqual(feiyu.modes.map((m) => m.key).sort(), ['aggressive', 'chuanzi', 'tsundere']);

  assert.equal(modeOf(feiyu, 'tsundere').label, '傲娇');
  assert.equal(modeOf(feiyu, 'aggressive').label, '毒舌');
  assert.equal(modeOf(feiyu, 'chuanzi').label, '串子');

  // 空 key / 不认识 = 正常状态，返回 null 而不是报错
  assert.equal(modeOf(feiyu, ''), null);
  assert.equal(modeOf(feiyu, '不存在'), null);
});

test('会话识别：说对触发词就切子人格', () => {
  const feiyu = findIdentity('大肥鱼', normalizeIdentities());

  assert.equal(matchSessionMode('当傲娇', feiyu).mode.key, 'tsundere');
  assert.equal(matchSessionMode('傲娇一点嘛', feiyu).mode.key, 'tsundere');
  assert.equal(matchSessionMode('给我上强度', feiyu).mode.key, 'aggressive');
  assert.equal(matchSessionMode('开启攻击', feiyu).mode.key, 'aggressive');
  assert.equal(matchSessionMode('当串子', feiyu).mode.key, 'chuanzi');

  const out = matchSessionMode('不傲娇了', feiyu);
  assert.equal(out.action, 'exit');
  assert.equal(out.mode.key, 'tsundere');
});

test('会话识别：否定句和普通聊天不该误触发', () => {
  const feiyu = findIdentity('大肥鱼', normalizeIdentities());

  // 触发词前面有「别 / 不要」时不算 —— 否则吵架时会莫名切人格
  assert.equal(matchSessionMode('别上强度', feiyu), null);
  assert.equal(matchSessionMode('不要毒舌一点', feiyu), null);
  assert.equal(matchSessionMode('别开启攻击', feiyu), null);

  // 去掉否定就该正常触发
  assert.equal(matchSessionMode('上强度', feiyu).mode.key, 'aggressive');

  // 「正常点」是全局退出词，走另一条路径，不该被当成会话触发
  assert.equal(matchSessionMode('正常点', feiyu), null);
  assert.equal(matchSessionMode('今天天气不错', feiyu), null);
  assert.equal(matchSessionMode('', feiyu), null);
  // 太长的句子不当指令
  assert.equal(matchSessionMode('我跟你说你别上强度这句话听明白没有啊啊', feiyu), null);
});

test('全局退出词：任何子人格下都能回正常', () => {
  assert.equal(matchGlobalExit('正常点'), true);
  assert.equal(matchGlobalExit('变回来吧'), true);
  assert.equal(matchGlobalExit('别演了'), true);
  assert.equal(matchGlobalExit('今天好累'), false);
  assert.equal(matchGlobalExit(''), false);
});

test('/persona 命令解析', () => {
  assert.deepEqual(parsePersonaCommand('/persona 阿米娅'), { prefix: '/persona', rest: '阿米娅' });
  assert.deepEqual(parsePersonaCommand('/人格默认'), { prefix: '/人格', rest: '默认' });
  assert.deepEqual(parsePersonaCommand('/PERSONA 傲娇'), { prefix: '/persona', rest: '傲娇' });
  assert.equal(parsePersonaCommand('阿米娅'), null);
  assert.equal(parsePersonaCommand(''), null);

  assert.deepEqual(parseCommandArg(''), { action: 'list' });
  assert.deepEqual(parseCommandArg('列表'), { action: 'list' });
  assert.deepEqual(parseCommandArg('默认'), { action: 'reset' });
  assert.deepEqual(parseCommandArg('off'), { action: 'reset' });
  assert.deepEqual(parseCommandArg('主人格 阿米娅'), { action: 'identity', token: '阿米娅' });
  assert.deepEqual(parseCommandArg('子人格 傲娇'), { action: 'mode', token: '傲娇' });
  assert.deepEqual(parseCommandArg('傲娇'), { action: 'auto', token: '傲娇' });
});

test('列表文案带上现在的主人格、子人格和禁用的阿米娅', () => {
  const ids = normalizeIdentities();
  const feiyu = findIdentity('大肥鱼', ids);
  const text = describePersona(ids, feiyu, findMode(feiyu, '傲娇'));

  assert.ok(text.includes('大肥鱼'), text);
  assert.ok(text.includes('傲娇'), text);
  assert.ok(text.includes('阿米娅（未启用）'), text);
  assert.ok(text.includes('/persona'), text);
  assert.ok(text.length < 260, `列表太长了（${text.length} 字），QQ 消息会不方便看`);
});

test('表情包按人格挑：子人格 > 主人格 > 默认', () => {
  const feiyu = findIdentity('大肥鱼', normalizeIdentities());

  // 子人格优先（结果按 stickers.list 的键顺序，不是配置里的书写顺序）
  assert.deepEqual(stickerKeysFor({ mode: modeOf(feiyu, 'tsundere'), identity: feiyu }), [
    'confused',
    'smug',
    'pout',
    'tease',
  ]);

  // 正常状态用主人格那套
  assert.deepEqual(stickerKeysFor({ mode: null, identity: feiyu }), [
    'happy',
    'sleepy',
    'hungry',
    'confused',
  ]);

  // 什么都没有时回落 defaultKeys
  assert.deepEqual(stickerKeysFor({}), ['happy', 'sleepy', 'hungry', 'confused']);
});
