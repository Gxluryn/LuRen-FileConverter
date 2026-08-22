/**
 * ============================================================
 * 右键菜单注册（新增功能 3）
 * 功能：在 Windows 资源管理器右键菜单中注册「使用 LuRen FileConverter 转换」，
 *       选中文件后点击即可启动应用并自动载入这些文件
 *
 * 原理：
 * - 注册表 HKCU\Software\Classes\*\shell\LuRenFileConverter 下写入菜单项
 *   （HKCU 仅当前用户、无需管理员权限；* 表示对所有文件生效）
 * - 菜单命令形如："<electron.exe>" "<应用目录>" "%1"，
 *   资源管理器会把所有选中文件作为命令行参数追加
 * - 应用启动时通过 collectFileArgs 从 process.argv 提取真实文件路径
 *
 * 注意：
 * - 只在 Windows 上工作（其他平台静默跳过）
 * - 注册为幂等操作：已注册则跳过；用 reg.exe（系统自带）写入，不引入外部依赖
 * ============================================================
 */

const fs = require('fs');                    // 判断参数是否为文件
const path = require('path');                // 路径拼接
const logger = require('./utils/logger');    // 日志
const { runCommand } = require('./utils/process'); // 子进程调用（reg.exe）

// 菜单显示名称
const MENU_NAME = '使用 LuRen FileConverter 转换';
// 注册表键（HKCU\Software\Classes 会被系统合并进 HKEY_CLASSES_ROOT，无需管理员）
const MENU_BASE = 'HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\LuRenFileConverter';

/** reg.exe 绝对路径（System32，避免 PATH 缺失） */
function regExe() {
  return path.join(process.env.windir || 'C:\\Windows', 'System32', 'reg.exe');
}

/**
 * 构造菜单命令：<exe> [应用目录] "%1"
 * 打包应用：直接 "exe" "%1"；开发模式：electron.exe + 项目目录 + "%1"
 * （%1 由资源管理器替换为第一个选中文件，其余选中文件自动追加到命令行尾部）
 */
function buildCommandLine() {
  const exe = process.execPath; // 开发时是 electron.exe，打包后是应用 exe
  const quote = (s) => '"' + s + '"';
  // 纯 Node 测试环境下 require('electron') 返回的是可执行文件路径字符串（不是 API），
  // 因此用 try 兜底：取不到 app 对象时按「开发模式」构造（可单测，用户要求 16）
  let app = null;
  try {
    app = require('electron').app;
  } catch {
    app = null;
  }
  if (app && app.isPackaged) return quote(exe) + ' "%1"';
  const appPath = app && typeof app.getAppPath === 'function' ? app.getAppPath() : process.cwd();
  return quote(exe) + ' ' + quote(appPath) + ' "%1"';
}

/**
 * 检查右键菜单是否已注册（幂等判断）
 * reg query 退出码 0 = 键存在；非 0 = 不存在
 */
async function isContextMenuInstalled() {
  try {
    await runCommand(regExe(), ['query', MENU_BASE], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取已注册的命令值（用于自愈：安装位置变化/开发模式切换后自动重写）
 * @returns {Promise<string|null>} 命令值（含引号原样），读取失败返回 null
 */
async function getInstalledCommand() {
  try {
    const { stdout } = await runCommand(regExe(), ['query', MENU_BASE + '\\command', '/ve'], { timeout: 10000 });
    // 输出形如：    (Default)    REG_SZ    "C:\...\app.exe" "%1"
    const m = stdout.match(/REG_SZ\s+(.+)/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * 注册右键菜单（幂等：已注册则直接返回 true）
 * @returns {Promise<boolean>} 是否注册成功
 */
async function installContextMenu() {
  // 仅 Windows 需要此功能
  if (process.platform !== 'win32') return false;
  try {
    const expected = buildCommandLine();
    // 自愈：已注册但命令指向旧路径（如开发版→安装版切换）时重新写入，
    // 否则会出现「菜单存在但打不开」的假象（用户要求 1：不编造可用）
    if (await isContextMenuInstalled() && (await getInstalledCommand()) === expected) {
      logger.debug('[context-menu] 右键菜单已存在且路径正确，跳过注册');
      return true;
    }
    // 菜单项（默认值 = 显示名称）
    await runCommand(regExe(), ['add', MENU_BASE, '/ve', '/d', MENU_NAME, '/f'], { timeout: 15000 });
    // 命令（默认值 = 启动命令）
    await runCommand(regExe(), ['add', MENU_BASE + '\\command', '/ve', '/d', buildCommandLine(), '/f'], { timeout: 15000 });
    // 图标：显示应用图标，增强识别度
    await runCommand(regExe(), ['add', MENU_BASE, '/v', 'Icon', '/d', process.execPath, '/f'], { timeout: 15000 });
    logger.info('[context-menu] 右键菜单注册成功:', buildCommandLine());
    return true;
  } catch (err) {
    // 注册失败不阻断应用启动：记录并降级（右键功能不可用但转换功能正常）
    logger.warn('[context-menu] 右键菜单注册失败:', err.message);
    return false;
  }
}

/**
 * 卸载右键菜单（供设置项/测试使用）
 * @returns {Promise<boolean>}
 */
async function uninstallContextMenu() {
  if (process.platform !== 'win32') return false;
  try {
    await runCommand(regExe(), ['delete', MENU_BASE, '/f'], { timeout: 15000 });
    logger.info('[context-menu] 右键菜单已卸载');
    return true;
  } catch (err) {
    logger.warn('[context-menu] 卸载右键菜单失败:', err.message);
    return false;
  }
}

/**
 * 从命令行参数中提取真实文件路径
 * 过滤规则：绝对路径、存在的文件、排除应用自身参数（electron . 的项目目录是文件夹会被排除）
 * @param {string[]} argv - process.argv
 * @returns {string[]} 文件路径数组
 */
function collectFileArgs(argv) {
  if (!Array.isArray(argv)) return [];
  // argv[0] 永远是可执行文件（electron.exe / 打包后的应用 exe），是存在的文件，
  // 不能当「待转换文件」收集——必须显式跳过（实测发现的坑）
  const args = argv.slice(1);

  // 应用路径（开发模式 argv[1] 是项目目录；electron app.asar 场景是 asar 文件）
  // 也需跳过，否则 app.asar 会被误收为文件
  let appPath = null;
  try {
    const app = require('electron').app;
    if (app && typeof app.getAppPath === 'function') appPath = app.getAppPath();
  } catch {
    appPath = null;
  }

  const files = [];
  for (const arg of args) {
    // 跳过空参、开关参数（--xxx / -x）、应用自身路径
    if (!arg || arg.startsWith('-')) continue;
    if (appPath && arg === appPath) continue;
    try {
      // 只收真实文件（目录与不存在的路径排除），异常参数静默跳过（用户要求 6）
      if (fs.statSync(arg).isFile()) files.push(arg);
    } catch {
      // 路径无效/不存在：跳过
    }
  }
  return files;
}

module.exports = { installContextMenu, uninstallContextMenu, isContextMenuInstalled, collectFileArgs, buildCommandLine, MENU_NAME };
