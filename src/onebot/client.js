import { EventEmitter } from 'node:events';
import { createLogger } from '../logger.js';

const log = createLogger('onebot');

/**
 * OneBot v11 正向 WebSocket 客户端。
 * NapCat 那边开「WebSocket 服务器」，我们连过去，收发都是 JSON。
 */
export class OneBotClient extends EventEmitter {
  constructor({ url, token = '', callTimeoutMs = 15000 }) {
    super();
    this.url = url;
    this.token = token;
    this.callTimeoutMs = callTimeoutMs;
    this.ws = null;
    this.selfId = null;
    this.pending = new Map();
    this.seq = 0;
    this.retry = 0;
    this.closedByUser = false;
    this.connected = false;
  }

  start() {
    this.closedByUser = false;
    this.#connect();
    return this;
  }

  #connect() {
    if (this.closedByUser) return;
    const opts = this.token ? { headers: { Authorization: `Bearer ${this.token}` } } : undefined;
    log.info(`连接 ${this.url}${this.token ? '（带 Access Token）' : ''}`);

    let ws;
    try {
      ws = opts ? new WebSocket(this.url, opts) : new WebSocket(this.url);
    } catch (err) {
      log.error(`WebSocket 创建失败：${err.message}`);
      this.#scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.retry = 0;
      this.connected = true;
      log.info('已连接到 NapCat / OneBot 服务');
      this.emit('connected');
    });

    ws.addEventListener('message', (ev) => {
      let data;
      try {
        data = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      this.#onPayload(data);
    });

    ws.addEventListener('error', () => {
      // 具体原因通常在 close 里更清楚，这里只留痕
      log.debug('WebSocket error 事件');
    });

    ws.addEventListener('close', (ev) => {
      this.connected = false;
      this.ws = null;
      this.#rejectAll('连接已关闭');
      if (this.closedByUser) {
        log.info('连接已手动关闭');
        return;
      }
      log.warn(`连接断开（code=${ev.code}${ev.reason ? ' reason=' + ev.reason : ''}），准备重连`);
      this.emit('disconnected');
      this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    this.retry += 1;
    const delay = Math.min(30000, 1000 * Math.pow(1.7, Math.min(this.retry, 8)));
    log.info(`${Math.round(delay / 1000)}s 后重连（第 ${this.retry} 次）`);
    setTimeout(() => this.#connect(), delay);
  }

  #onPayload(data) {
    // 1) action 的响应
    if (data.echo !== undefined && this.pending.has(data.echo)) {
      const { resolve, reject, timer } = this.pending.get(data.echo);
      clearTimeout(timer);
      this.pending.delete(data.echo);
      if (data.status === 'ok' || data.retcode === 0) resolve(data);
      else reject(new Error(`API 失败 retcode=${data.retcode} ${data.wording || data.message || ''}`.trim()));
      return;
    }
    // 2) 事件推送
    if (data.post_type) {
      if (data.post_type === 'meta_event') {
        if (data.meta_event_type === 'lifecycle') {
          this.selfId = data.self_id ?? this.selfId;
          log.info(`生命周期：${data.sub_type}，self_id=${this.selfId}`);
        }
        return;
      }
      if (data.self_id) this.selfId = data.self_id;
      this.emit('event', data);
    }
  }

  async call(action, params = {}, timeoutMs = this.callTimeoutMs) {
    if (!this.ws || this.ws.readyState !== 1) {
      throw new Error(`未连接，无法调用 ${action}`);
    }
    const echo = `c${++this.seq}`;
    const payload = JSON.stringify({ action, params, echo });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`调用 ${action} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      try {
        this.ws.send(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(err);
      }
    });
  }

  #rejectAll(reason) {
    for (const [, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    this.pending.clear();
  }

  close() {
    this.closedByUser = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
