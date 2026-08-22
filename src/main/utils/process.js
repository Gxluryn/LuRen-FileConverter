/**
 * ============================================================
 * 子进程调用工具（模块 1）
 * 功能：统一封装外部引擎（FFmpeg/LibreOffice/Poppler/Tesseract）的子进程调用
 *
 * 为什么需要本模块？
 * - 所有引擎调用都必须走这里，避免各处直接使用 child_process 造成代码重复
 * - 统一处理：超时杀进程（防僵尸）、错误信息上下文、输出缓冲上限
 * - 中文/空格路径天然安全：用 execFile（参数数组逐项传递）而非 exec（字符串拼接）
 *
 * 设计要点：
 * - 本模块刻意不依赖 logger（日志模块在其后编写），保持纯函数、可独立单元测试
 * - Promise 只 settle 一次（防双重 resolve/reject 造成难排查的 bug）
 * - 超时用「进程树」级杀死（Windows 用 taskkill /T），防止引擎的子进程残留
 * ============================================================
 */

// execFile：参数数组方式执行程序，天然规避路径注入与引号转义问题
const { execFile, execFileSync } = require('child_process');
// getEngine：从 engines.js 安全获取引擎绝对路径（不存在会抛错）
const { getEngine } = require('../engines');

/**
 * 递归杀死进程树
 * 为什么需要进程树而不是单进程？
 * - LibreOffice Portable、部分编码器会派生子进程，只杀父进程会留下孤儿/僵尸进程
 * - Windows 上 taskkill /T /F 是官方支持的进程树终止方式
 * @param {number} pid - 父进程 PID
 */
function killProcessTree(pid) {
  // pid 无效时直接返回，避免误杀
  if (!pid) return;

  if (process.platform === 'win32') {
    // /T 递归终止子进程，/F 强制终止，/PID 指定目标
    // stdio:'ignore' + try-catch：进程可能已自行退出，失败可静默忽略
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // 进程已退出或无权操作：无需再处理
    }
  } else {
    // POSIX：负 PID 表示杀整个进程组（需要调用方 spawn 时 detached:true 才生效）
    // 这里直接杀进程本身即可满足当前 Windows 目标平台
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 进程已退出，忽略
    }
  }
}

/**
 * 异步执行命令行程序
 * @param {string} executablePath - 可执行文件绝对路径
 * @param {string[]} [args=[]] - 命令参数数组（每个参数单独一个元素）
 * @param {object} [options={}] - 可选配置
 * @param {string} [options.cwd] - 工作目录
 * @param {number} [options.timeout=60000] - 超时毫秒，默认 1 分钟
 * @param {number} [options.maxBuffer=10485760] - 输出缓冲上限（字节），默认 10MB
 * @param {object} [options.env] - 环境变量（不传则继承 process.env）
 * @param {boolean} [options.allowNonZero=false] - 允许非 0 退出码作为结果返回
 *   用途：ffmpeg -i 探测文件信息时返回码为 1 但 stderr 携带全部信息，这是正常用法
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 * @throws {Error} 非 0 退出码 / 超时 / 程序不存在时 reject，错误信息含命令与 stderr
 */
function runCommand(executablePath, args = [], options = {}) {
  // 解构默认值：保证调用方传 null/undefined 时也不崩溃
  const { cwd, timeout = 60000, maxBuffer = 10 * 1024 * 1024, env, allowNonZero = false } = options;

  // 返回 Promise 把回调式 API 转为 async/await 友好形式
  return new Promise((resolve, reject) => {
    // settled 防重入：错误事件、退出回调、超时定时器三者可能竞争，只允许第一个生效
    let settled = false;
    // 累计输出：即使进程被杀/超时，也能把已产生的输出带进错误信息，便于排查
    let stdoutBuf = '';
    let stderrBuf = '';

    // windowsHide:true 隐藏引擎的黑窗口，避免用户看到闪烁的 cmd 窗口
    const child = execFile(
      executablePath,
      args,
      { cwd, maxBuffer, env, windowsHide: true },
      (error, stdout, stderr) => {
        // 已有结果（如超时已处理）则忽略本次回调，保证 Promise 只 settle 一次
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        if (error) {
          // allowNonZero 场景：非 0 退出码（数字型 code）作为结果返回，
          // 但程序不存在/超时等致命错误仍拒绝——退出码数字是「有输出但非零」，字符串 code 是「压根没跑起来」
          if (allowNonZero && typeof error.code === 'number') {
            resolve({ stdout: stdout || stdoutBuf, stderr: stderr || stderrBuf, code: error.code });
            return;
          }
          // 区分三种失败原因，分别给出可读性强的错误信息：
          // 1) 超时（我们手动杀进程后 error.killed 为 true）
          // 2) 程序不存在/无权限（error.code 为 ENOENT/EACCES）
          // 3) 输出超限（maxBuffer 触发，Node 自动销毁流并报 ERR_CHILD_PROCESS_STDIO_MAXBUFFER）
          // 4) 其他非 0 退出码
          let message;
          if (error.killed) {
            message = '命令执行超时';
          } else if (error.code === 'ENOENT') {
            message = '可执行文件不存在';
          } else if (error.code === 'EACCES') {
            message = '没有执行权限';
          } else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            message = '输出超过缓冲区上限';
          } else {
            message = '命令执行失败（退出码 ' + (error.code ?? '未知') + '）';
          }

          // 错误信息带上命令与 stderr 尾部，方便日志定位问题
          // 截断 args 展示，避免错误信息过长
          const cmdText = executablePath + ' ' + args.slice(0, 20).join(' ');
          const err = new Error(
            message + ': ' + cmdText + (stderrBuf.trim() ? ' — ' + stderrBuf.trim().slice(-500) : '')
          );
          err.name = 'ProcessError';
          err.exitCode = error.code;
          err.stdout = stdout || stdoutBuf;
          err.stderr = stderr || stderrBuf;
          reject(err);
          return;
        }

        resolve({ stdout, stderr, code: 0 });
      }
    );

    // 手动超时（不用 execFile 内置 timeout 的原因：内置 timeout 只杀直接子进程，
    // 无法清理 LibreOffice 这类会派生孙进程的引擎，容易残留僵尸进程）
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // 先杀进程树，再 reject —— 顺序不能反，否则错误回调可能先触发导致杀不掉
      killProcessTree(child.pid);
      const err = new Error(
        '命令执行超时(' + timeout + 'ms): ' + executablePath + ' ' + args.slice(0, 20).join(' ') +
        (stderrBuf.trim() ? ' — ' + stderrBuf.trim().slice(-500) : '')
      );
      err.name = 'ProcessError';
      err.exitCode = 'ETIMEDOUT';
      err.stdout = stdoutBuf;
      err.stderr = stderrBuf;
      reject(err);
    }, timeout);

    // 累积输出：execFile 回调只在进程结束时给完整缓冲，超时场景需要实时累积才能带出部分输出
    child.stdout.on('data', (chunk) => { stdoutBuf += chunk; });
    child.stderr.on('data', (chunk) => { stderrBuf += chunk; });
  });
}

/**
 * 通过引擎名称调用本地引擎（内部从 engines.js 获取路径）
 * @param {string} engineName - ENGINES 对象的键名，如 'ffmpeg'、'tesseract'、'pdfinfo'
 * @param {string[]} [args=[]] - 命令参数数组
 * @param {object} [options] - 同 runCommand 的 options
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 * @throws {Error} 引擎不存在时 reject
 */
function runEngine(engineName, args = [], options = {}) {
  let executablePath;
  try {
    executablePath = getEngine(engineName);
  } catch (err) {
    // 引擎缺失是配置问题，直接拒绝并带上引擎名，方便用户定位
    return Promise.reject(err);
  }
  return runCommand(executablePath, args, options);
}

module.exports = { runCommand, runEngine };
