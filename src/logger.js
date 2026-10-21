import fs from 'node:fs';
import path from 'node:path';
import { PATHS, envConfig } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
  dim: '\x1b[90m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
};

const minLevel = LEVELS[envConfig.logLevel] ?? LEVELS.info;
const dateStr = () => new Date().toISOString().slice(0, 10);
const logFile = path.join(PATHS.logs, `bot-${dateStr()}.log`);

function write(level, scope, msg, extra) {
  if (LEVELS[level] < minLevel) return;
  const ts = new Date().toTimeString().slice(0, 8);
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const color = COLORS[level] || '';
  const out = `${COLORS.dim}${ts}${COLORS.reset} ${color}${level.toUpperCase().padEnd(5)}${COLORS.reset} ${COLORS.dim}[${scope}]${COLORS.reset} ${msg}`;
  if (level === 'error') console.error(out);
  else if (level === 'warn') console.warn(out);
  else console.log(out);

  let fileLine = line;
  if (extra !== undefined) {
    try {
      fileLine += ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra));
    } catch {
      fileLine += ' [unserializable]';
    }
  }
  try {
    fs.appendFileSync(logFile, fileLine + '\n');
  } catch {
    /* 日志写失败不能拖垮主流程 */
  }
}

export function createLogger(scope) {
  return {
    debug: (m, e) => write('debug', scope, m, e),
    info: (m, e) => write('info', scope, m, e),
    warn: (m, e) => write('warn', scope, m, e),
    error: (m, e) => write('error', scope, m, e),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export const colors = COLORS;
