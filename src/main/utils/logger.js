/**
 * ============================================================
 * 日志工具（模块 3）
 * 功能：统一日志输出（控制台带颜色 + 追加写入日志文件）
 *
 * 为什么需要本模块？
 * - 用户要求 15：关键流程、错误要有日志，方便排查问题
 * - 各模块统一走这里，日志格式一致；切换级别即可控制输出量，不用改业务代码
 *
 * 设计要点：
 * - 日志文件写失败绝不能抛异常（日志失败不能导致转换失败）
 * - 用 appendFileSync 保证多行日志顺序一致、不交错（低频日志，同步开销可忽略）
 * - 文件输出不带颜色码（颜色码会污染日志文件，且对 grep/编辑器不友好）
 * - 无第三方依赖，纯 Node 内置模块，可独立测试
 * ============================================================
 */

const fs = require('fs');      // 文件系统：追加写入日志文件
const os = require('os');      // os.tmpdir()：日志文件放系统临时目录，不污染项目目录
const path = require('path');  // 路径拼接
const util = require('util');  // util.format：支持 console.log 式多参数格式化

// 级别数值表：数值越小越详细。debug < info < warn < error
// 通过数值比较实现「设置 info 时 debug 不输出」，避免写一堆 if 分支
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

// 控制台颜色（ANSI 转义码）：只在终端显示时生效
// 为什么用颜色：日志多时按颜色快速区分级别，利于人工排查
const COLORS = {
  debug: '\x1b[90m', // 灰色
  info: '\x1b[32m',  // 绿色
  warn: '\x1b[33m',  // 黄色
  error: '\x1b[31m', // 红色
  reset: '\x1b[0m',  // 重置
};

// 当前日志级别（默认 info：debug 级调试信息默认不输出，减少噪音）
let currentLevel = 'info';

// 日志文件路径：系统临时目录下固定文件名，多次运行追加同一文件，便于跨会话排查
const LOG_FILE = path.join(os.tmpdir(), 'luren-fileconverter.log');

/**
 * 格式化时间戳：YYYY-MM-DD HH:mm:ss（本地时间）
 * 为什么手写而非 toISOString：toISOString 是 UTC，与用户本地时间不一致，排查不便
 * @returns {string}
 */
function formatTime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

/**
 * 将参数数组格式化为一行文本
 * Error 对象特殊处理：输出 name + message + 堆栈，方便定位（普通 toString 会丢堆栈）
 * @param {Array} args
 * @returns {string}
 */
function formatArgs(args) {
  return args.map((arg) => {
    if (arg instanceof Error) {
      return arg.stack || arg.message;
    }
    return util.format(arg);
  }).join(' ');
}

/**
 * 写日志（内部方法）
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {Array} args - 日志内容
 */
function write(level, args) {
  // 级别过滤：当前级别数值 > 日志级别数值则不输出
  // 例如 currentLevel=info(1)，debug(0) 不输出；error(3) 输出
  if (LEVELS[level] < LEVELS[currentLevel]) return;

  // 时间戳 + 级别标签 + 内容
  const message = formatArgs(args);
  const line = '[' + formatTime() + '] [' + level.toUpperCase() + '] ' + message;

  // 控制台输出：带颜色（便于终端快速识别级别）
  // eslint-disable-next-line no-console
  console[level === 'debug' ? 'log' : level](COLORS[level] + line + COLORS.reset);

  // 文件输出：不带颜色码。追加写失败只降级到控制台，不抛异常
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (err) {
    // 文件写失败（如磁盘满/无权限）：不影响功能，仅提示一次
    console.warn('[logger] 写入日志文件失败:', err.message);
  }
}

const logger = {
  /** 信息日志（正常流程记录，如「转换开始/完成」） */
  info(...args) { write('info', args); },

  /** 警告日志（可恢复的异常，如「引擎缺失但可降级」） */
  warn(...args) { write('warn', args); },

  /** 错误日志（失败场景，Error 对象自动带堆栈） */
  error(...args) { write('error', args); },

  /** 调试日志（详细过程，默认关闭，通过 setLevel('debug') 开启） */
  debug(...args) { write('debug', args); },

  /**
   * 设置日志级别
   * @param {'debug'|'info'|'warn'|'error'} level
   */
  setLevel(level) {
    // 非法级别静默忽略并保持原级别：级别是配置，配错不应崩溃
    if (LEVELS[level] !== undefined) {
      currentLevel = level;
    }
  },

  /** 暴露日志文件路径（排查问题时告知用户日志在哪） */
  getLogFilePath() {
    return LOG_FILE;
  },
};

module.exports = logger;
