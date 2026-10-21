import { config, envConfig, PATHS } from './config.js';
import { createLogger, colors } from './logger.js';
import { OneBotClient } from './onebot/client.js';
import { createApi } from './onebot/api.js';
import { Brain } from './brain/reply.js';
import { Proactive } from './brain/proactive.js';
import { getDb, closeDb } from './memory/db.js';
import { kvGet } from './memory/store.js';
import { normalizeIdentities, findIdentity, defaultIdentity } from './persona/identities.js';

const log = createLogger('main');

function banner() {
  const mode = envConfig.provider === 'mock' ? 'mock（假回复）' : envConfig.deepseekModel;
  const identities = normalizeIdentities();
  const who =
    identities.map((i) => (i.enabled ? i.label : `${i.label}(关)`)).join(' / ') || config.botName;
  console.log('');
  console.log(`${colors.magenta}  ┌─────────────────────────────────────────────┐${colors.reset}`);
  console.log(`${colors.magenta}  │${colors.reset}  ${colors.green}${config.botName}${colors.reset} 正在醒来…`.padEnd(58) + `${colors.magenta}│${colors.reset}`);
  console.log(`${colors.magenta}  ├─────────────────────────────────────────────┤${colors.reset}`);
  console.log(`${colors.magenta}  │${colors.reset}  OneBot   ${envConfig.onebotWsUrl}`.padEnd(58) + `${colors.magenta}│${colors.reset}`);
  console.log(`${colors.magenta}  │${colors.reset}  模型     ${mode}`.padEnd(58) + `${colors.magenta}│${colors.reset}`);
  console.log(`${colors.magenta}  │${colors.reset}  人格     ${who}`.padEnd(58) + `${colors.magenta}│${colors.reset}`);
  console.log(`${colors.magenta}  │${colors.reset}  数据库   data/bot.db`.padEnd(58) + `${colors.magenta}│${colors.reset}`);
  console.log(`${colors.magenta}  └─────────────────────────────────────────────┘${colors.reset}`);
  console.log('');
}

async function main() {
  banner();

  if (envConfig.provider !== 'mock' && !envConfig.deepseekKey) {
    log.warn('未配置 DEEPSEEK_API_KEY —— 收到消息时会报错。请改 .env，或临时设 LLM_PROVIDER=mock 先跑通链路。');
  }

  getDb();

  // 明确打印启动时用的是谁 —— 上次关窗口时如果停在阿米娅，这里就该显示阿米娅
  try {
    const ids = normalizeIdentities();
    const savedKey = String(kvGet('persona:identity', '') || '');
    const saved = savedKey ? findIdentity(savedKey, ids) : null;
    const active = saved || defaultIdentity(ids);
    log.info(
      `当前主人格：${active.label}` +
        (saved ? `（读取自数据库，上次退出时就是这个）` : `（数据库里没有记录，使用默认人格）`)
    );
  } catch (err) {
    log.warn(`读取当前人格失败：${err.message}`);
  }

  const client = new OneBotClient({
    url: envConfig.onebotWsUrl,
    token: envConfig.onebotToken,
  });
  const api = createApi(client);
  const brain = new Brain({ api, getSelfId: () => client.selfId });
  const proactive = new Proactive({ api, getSelfId: () => client.selfId });

  client.on('event', (ev) => {
    if (ev.post_type === 'message' || ev.post_type === 'message_sent') {
      brain.onEvent(ev);
    }
  });

  client.on('connected', async () => {
    try {
      const info = await api.getLoginInfo();
      if (info?.user_id) {
        client.selfId = String(info.user_id);
        log.info(`登录账号：${info.nickname || ''} (${info.user_id})`);
      }
    } catch (err) {
      log.warn(`获取登录信息失败：${err.message}`);
    }
    proactive.start();
  });

  client.on('disconnected', () => {
    log.warn('与 NapCat 断开，等待重连…');
    proactive.stop();
  });

  client.start();

  const shutdown = (sig) => {
    log.info(`收到 ${sig}，正在退出…`);
    proactive.stop();
    client.close();
    setTimeout(() => {
      closeDb();
      process.exit(0);
    }, 300);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (err) => {
    log.error(`未处理的 Promise 拒绝：${err?.message || err}`, err?.stack);
  });
  process.on('uncaughtException', (err) => {
    log.error(`未捕获异常：${err?.message || err}`, err?.stack);
  });
}

main().catch((err) => {
  console.error('启动失败：', err);
  process.exit(1);
});
