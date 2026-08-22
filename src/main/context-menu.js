/**
 * ============================================================
 * 右键菜单注册（WPS 风格二级子菜单）
 * 功能：在 Windows 资源管理器右键菜单注册「LuRen FileConverter」子菜单，
 *       内含「转换为 PDF/Word/Excel/...」等目标格式项，
 *       点击后启动应用并携带 --convert-to <格式> 参数，应用自动完成转换
 *
 * 注册表结构（HKCU 免管理员）：
 *   HKCU\Software\Classes\*\shell\LuRenFileConverter          ← 父菜单（默认值=菜单名）
 *     \shell\pdf\command        = "app.exe" "%1" --convert-to pdf   ← 子项：转换为 PDF
 *     \shell\docx\command       = ... --convert-to docx
 *     ...
 * （父键下挂 \shell 子键即形成资源管理器二级菜单，与 WPS/7-Zip 同款结构）
 *
 * 卸载：删除父键即递归删除全部子键（reg delete /f 递归）
 * ============================================================
 */

const fs = require('fs');                    // 判断参数是否为文件
const path = require('path');                // 路径拼接
const logger = require('./utils/logger');    // 日志
const { runCommand } = require('./utils/process'); // 子进程调用（reg.exe）

// 菜单显示名称
const MENU_NAME = 'LuRen FileConverter';
// 注册表根键（HKCU\Software\Classes 会被系统合并进 HKEY_CLASSES_ROOT）
const MENU_BASE = 'HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\LuRenFileConverter';

// 子菜单目标格式（WPS 风格：常用目标，点击直接转换；其他格式可在应用内选择）
const MENU_FORMATS = [
  { ext: 'pdf', label: '转换为 PDF 文档' },
  { ext: 'docx', label: '转换为 Word 文档' },
  { ext: 'xlsx', label: '转换为 Excel 表格' },
  { ext: 'pptx', label: '转换为 PPT 演示' },
  { ext: 'txt', label: '转换为 TXT 文本' },
  { ext: 'html', label: '转换为 HTML 网页' },
  { ext: 'jpg', label: '转换为 JPG 图片' },
  { ext: 'png', label: '转换为 PNG 图片' },
  { ext: 'webp', label: '转换为 WebP 图片' },
  { ext: 'gif', label: '转换为 GIF 动图' },
  { ext: 'mp3', label: '转换为 MP3 音频' },
  { ext: 'mp4', label: '转换为 MP4 视频' },
];

/** reg.exe 绝对路径（System32，避免 PATH 缺失） */
function regExe() {
  return path.join(process.env.windir || 'C:\\Windows', 'System32', 'reg.exe');
}

/**
 * 构造应用启动命令：<exe> [应用目录] "%1"
 * %1 由资源管理器替换为第一个选中文件，其余选中文件自动追加到命令行尾部
 */
function buildCommandLine() {
  const exe = process.execPath; // 开发时是 electron.exe，打包后是应用 exe
  const quote = (s) => '"' + s + '"';
  // 纯 Node 测试环境下 require('electron') 返回路径字符串，用 try 兜底
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
 * 检查右键菜单父键是否已注册
 * @returns {Promise<boolean>}
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
 * 注册 WPS 风格右键菜单（幂等）
 * 先删除旧结构再重建，避免结构变化后残留无用子键
 * @returns {Promise<boolean>}
 */
async function installContextMenu() {
  if (process.platform !== 'win32') return false;
  try {
    const base = buildCommandLine();
    // 删除旧结构（reg delete 对不存在的键返回非 0，忽略该错误）
    await runCommand(regExe(), ['delete', MENU_BASE, '/f'], { timeout: 15000 }).catch(() => {});

    // 父菜单项（默认值 = 菜单名）
    await runCommand(regExe(), ['add', MENU_BASE, '/ve', '/d', MENU_NAME, '/f'], { timeout: 15000 });
    // 图标
    await runCommand(regExe(), ['add', MENU_BASE, '/v', 'Icon', '/d', process.execPath, '/f'], { timeout: 15000 });

    // 子菜单项：每个格式一个 command（--convert-to 参数由应用解析）
    for (const fmt of MENU_FORMATS) {
      const verbKey = MENU_BASE + '\\shell\\' + fmt.ext;
      await runCommand(regExe(), ['add', verbKey, '/ve', '/d', fmt.label, '/f'], { timeout: 15000 });
      await runCommand(
        regExe(),
        ['add', verbKey + '\\command', '/ve', '/d', base + ' --convert-to ' + fmt.ext, '/f'],
        { timeout: 15000 }
      );
    }
    logger.info('[context-menu] WPS 式右键菜单注册完成（' + MENU_FORMATS.length + ' 个子项）');
    return true;
  } catch (err) {
    logger.warn('[context-menu] 右键菜单注册失败:', err.message);
    return false;
  }
}

/**
 * 卸载右键菜单（删除父键即递归删除全部子键）
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
 * 从命令行参数提取目标格式（--convert-to <格式>）
 * @param {string[]} argv
 * @returns {string|null} 格式小写（如 'pdf'），无则 null
 */
function parseConvertArg(argv) {
  if (!Array.isArray(argv)) return null;
  const idx = argv.indexOf('--convert-to');
  if (idx !== -1 && argv[idx + 1]) {
    const fmt = String(argv[idx + 1]).toLowerCase().replace(/^\./, '');
    return /^[a-z0-9]{1,10}$/.test(fmt) ? fmt : null;
  }
  return null;
}

/**
 * 从命令行参数提取真实文件路径
 * 过滤：跳过可执行文件/应用路径/开关参数/--convert-to 的值
 * @param {string[]} argv
 * @returns {string[]}
 */
function collectFileArgs(argv) {
  if (!Array.isArray(argv)) return [];
  const args = argv.slice(1); // 跳过可执行文件

  let appPath = null;
  try {
    const app = require('electron').app;
    if (app && typeof app.getAppPath === 'function') appPath = app.getAppPath();
  } catch {
    appPath = null;
  }

  const files = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg || arg.startsWith('-')) continue;
    // --convert-to 后面的格式值是参数而非文件
    if (args[i - 1] === '--convert-to') continue;
    if (appPath && arg === appPath) continue;
    try {
      if (fs.statSync(arg).isFile()) files.push(arg);
    } catch {
      // 无效路径跳过（用户要求 6：容错不崩溃）
    }
  }
  return files;
}

module.exports = {
  installContextMenu,
  uninstallContextMenu,
  isContextMenuInstalled,
  collectFileArgs,
  parseConvertArg,
  buildCommandLine,
  MENU_NAME,
  MENU_FORMATS,
};
