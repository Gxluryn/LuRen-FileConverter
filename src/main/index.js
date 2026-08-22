/**
 * ============================================================
 * Electron 主进程入口文件
 * 功能：创建应用窗口、加载前端页面、处理窗口控制指令
 * 作者：LuRen FileConverter
 * ============================================================
 */

// 引入 Electron 核心模块
// app：控制应用生命周期（启动、退出等）
// BrowserWindow：创建和控制浏览器窗口
// ipcMain：主进程端的 IPC 通信，接收渲染进程发来的消息
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');

// 引入 path 模块，用于处理文件路径
const path = require('path');

// 转换调度核心：注册全部转换 IPC 通道（模块 10）
const { registerIpcHandlers } = require('./converter');
// 引擎检查：底部状态栏显示引擎就绪情况
const { checkEngines } = require('./engines');
// 日志
const logger = require('./utils/logger');
// 预览服务（新增功能 2）
const { generatePreview } = require('./preview');
// 右键菜单注册与文件参数提取（新增功能 3；WPS 式子菜单附带 --convert-to 目标格式）
const { installContextMenu, collectFileArgs, parseConvertArg } = require('./context-menu');

/**
 * 主窗口实例
 * 用 let 声明，因为窗口可能被关闭后重新创建
 * 初始为 null，在 createWindow 函数中赋值
 */
let mainWindow = null;

// 启动时通过命令行携带的文件（右键菜单场景），等渲染层就绪后投递
let pendingFiles = [];
// 右键菜单指定的目标格式（--convert-to <格式>），随文件一起交给渲染层自动转换
let pendingConvertTo = null;

/**
 * 把文件路径数组补充为 { path, name, size }（渲染层展示需要名称与大小）
 * 单文件 stat 失败（如文件被删）则跳过该文件，不中断整体（用户要求 6）
 * @param {string[]} paths
 * @returns {Array<{path: string, name: string, size: number}>}
 */
function describeFiles(paths) {
  const fs = require('fs');
  return paths
    .map((p) => {
      try {
        const stat = fs.statSync(p);
        if (!stat.isFile()) return null;
        return { path: p, name: path.basename(p), size: stat.size };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * 创建主窗口函数
 * 功能：配置窗口参数、加载前端 HTML 页面
 * 在 app 就绪后调用，也可在 macOS 点击 dock 图标时重新调用
 */
function createWindow() {
  // 创建 BrowserWindow 实例，配置窗口参数
  mainWindow = new BrowserWindow({
    width: 1280,           // 窗口初始宽度
    height: 820,           // 窗口初始高度
    minWidth: 960,         // 窗口最小宽度，防止布局错乱
    minHeight: 640,        // 窗口最小高度
    frame: false,          // 关闭默认标题栏，使用自定义标题栏（在 HTML 中实现）
    backgroundColor: '#f5f7fa', // 窗口背景色，防止启动时白屏闪烁
    webPreferences: {
      // 预加载脚本：在渲染进程加载前执行，用于安全地暴露 API
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,  // 启用上下文隔离，防止渲染进程直接访问 Node.js API（安全最佳实践）
      nodeIntegration: false,  // 禁用渲染进程的 Node.js 集成（安全最佳实践）
    },
  });

  // 加载前端页面（相对路径基于当前文件所在目录）
  // __dirname 是当前 JS 文件所在目录（src/main/），所以需要 ../renderer/index.html
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 注册转换相关 IPC（convert:start/cancel/status/batch、formats:supported 等）
  // 每次创建窗口都注册：macOS 关窗重建窗口后通道依然可用（ipcMain.handle 重复注册会覆盖，无副作用）
  registerIpcHandlers(ipcMain, mainWindow);

  // ===== 结果面板文件操作 IPC =====
  // 打开文件：用系统默认程序打开（shell.openPath 异步，返回错误信息字符串）
  ipcMain.handle('file:open-path', async (_event, filePath) => {
    if (typeof filePath !== 'string' || !filePath) return '路径无效';
    // 只允许打开存在且为绝对路径的文件，防止渲染进程传任意参数（安全要求）
    if (!path.isAbsolute(filePath)) return '仅支持绝对路径';
    return await shell.openPath(filePath);
  });
  // 在资源管理器中显示文件
  ipcMain.handle('file:show-in-folder', (_event, filePath) => {
    if (typeof filePath !== 'string' || !filePath || !path.isAbsolute(filePath)) return;
    shell.showItemInFolder(filePath);
  });
  // 引擎状态（底部状态栏）
  ipcMain.handle('engines:status', () => {
    const { missing, available } = checkEngines();
    return { missing, available, ready: missing.length === 0 };
  });

  // 页面加载完成后投递启动文件（did-finish-load 确保渲染层监听器已就绪）
  // 注意：此处用 webContents.on 每次窗口重建都会新加监听器，旧窗口已销毁无影响
  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingFiles.length > 0) {
      logger.info('[index] 投递启动文件:', pendingFiles.join(' | '), '目标格式:', pendingConvertTo);
      mainWindow.webContents.send('open-files', {
        files: describeFiles(pendingFiles.slice()),
        convertTo: pendingConvertTo,
      });
      pendingFiles = [];
      pendingConvertTo = null;
    }
  });

  // ===== 开发调试用：打开开发者工具 =====
  // 正式发布时请注释掉此行，防止用户误操作打开 DevTools
  // mainWindow.webContents.openDevTools();
}

// ============================================================
// 窗口控制 IPC 通信
// 渲染进程通过 ipcRenderer 发送消息，主进程通过 ipcMain 接收并执行
// ============================================================

/**
 * 最小化窗口
 * 渲染进程点击最小化按钮时触发
 */
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

/**
 * 最大化/还原窗口
 * 渲染进程点击最大化按钮时触发
 * 如果当前已最大化则还原，否则最大化
 */
ipcMain.on('window-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize(); // 还原窗口
  } else {
    mainWindow.maximize();   // 最大化窗口
  }
});

/**
 * 关闭窗口
 * 渲染进程点击关闭按钮时触发
 */
ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

/**
 * 查询窗口是否已最大化
 * 渲染进程可通过 invoke 方式调用，获取返回值
 * 用于同步最大化按钮的图标状态
 */
ipcMain.handle('window-is-maximized', () => {
  return mainWindow ? mainWindow.isMaximized() : false;
});

// ============================================================
// 新增功能相关 IPC（模块级注册一次，窗口重建不重复）
// ============================================================

// 新增功能 1：自选输出目录（系统目录选择对话框；取消返回 null）
ipcMain.handle('dialog:select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择转换文件的保存位置',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

// 新增功能 2：转换效果预览
// 请求：{ inputPath, feature, targetFormat, options }；返回 { original, preview, info }
ipcMain.handle('preview:get', async (_event, payload = {}) => {
  const { inputPath, feature, targetFormat, options = {} } = payload;
  if (typeof inputPath !== 'string' || !inputPath) throw new Error('未指定预览文件');
  return await generatePreview(inputPath, feature, targetFormat, options);
});

// 新增功能 3：渲染层初始化时拉取启动携带的文件（避免推送丢失）
ipcMain.handle('files:pending', () => {
  const files = pendingFiles.splice(0); // 取出即清空，防止重复接收
  if (files.length > 0) logger.info('[index] 渲染层拉取启动文件:', files.join(' | '), '目标格式:', pendingConvertTo);
  const convertTo = pendingConvertTo;
  pendingConvertTo = null; // 消费后清空
  return { files: describeFiles(files), convertTo };
});

// ============================================================
// 应用生命周期事件
// ============================================================

// ============================================================
// 新增功能 3：右键菜单 / 单实例
// ============================================================

/**
 * 单实例锁：保证同时只有一个应用实例在运行
 * 右键菜单再次启动应用时，新实例把文件转给已运行实例后自动退出
 * （若不抢锁，会打开第二个窗口且文件参数不会送达第一个实例）
 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit(); // 已有实例在运行：本实例立即退出（文件转发在 second-instance 中完成）
} else {
  // 二次启动（右键菜单选中更多文件时）：把文件发给主窗口并聚焦
  app.on('second-instance', (_event, argv) => {
    const files = collectFileArgs(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (files.length > 0) {
        const convertTo = parseConvertArg(argv);
        logger.info('[index] 二次实例转发文件:', files.join(' | '), '目标格式:', convertTo);
        mainWindow.webContents.send('open-files', { files: describeFiles(files), convertTo });
      }
    }
  });
}

/**
 * app.whenReady()：Electron 初始化完成后触发
 * 此时可以创建窗口、注册全局快捷键等
 */
app.whenReady().then(() => {
  // 收集启动参数中的文件与目标格式（右键菜单启动场景）；渲染层就绪后由 createWindow 投递
  pendingFiles = collectFileArgs(process.argv);
  pendingConvertTo = parseConvertArg(process.argv);
  // 诊断：确认启动参数与收集结果（右键菜单排障用）
  logger.info('[index] 启动参数:', JSON.stringify(process.argv), '→ 收集文件:', JSON.stringify(pendingFiles), '目标格式:', pendingConvertTo);

  createWindow();

  // 注册 Windows 右键菜单（幂等，已注册则跳过；失败只警告不阻断启动）
  if (process.platform === 'win32') {
    installContextMenu().then((ok) => {
      if (!ok) logger.warn('[index] 右键菜单未注册，可通过设置重新安装');
    });
  }

  /**
   * macOS 特有行为：点击 Dock 图标时，如果没有窗口则重新创建
   * Windows/Linux 不需要此逻辑，因为关闭窗口即退出应用
   */
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

/**
 * window-all-closed：所有窗口都关闭时触发
 * macOS 除外（macOS 应用通常在关闭所有窗口后仍保持运行，可通过 Dock 重新打开）
 */
app.on('window-all-closed', () => {
  // process.platform 检测操作系统：'darwin' 是 macOS
  if (process.platform !== 'darwin') {
    app.quit(); // 退出应用
  }
});
