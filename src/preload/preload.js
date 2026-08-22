/**
 * ============================================================
 * Electron 预加载脚本（Preload Script）
 * 功能：在渲染进程加载前执行，安全地向渲染进程暴露有限的 API
 * 
 * 为什么需要预加载脚本？
 * - 出于安全考虑，渲染进程（前端页面）默认不能直接访问 Node.js API
 * - 预加载脚本运行在一个特殊的上下文中，可以访问 Node.js API
 * - 通过 contextBridge 可以选择性地把 API 暴露给渲染进程
 * - 这样既保证了安全性，又让前端能调用原生能力（如窗口控制）
 * ============================================================
 */

// 引入 contextBridge：用于安全地向渲染进程暴露 API
// 引入 ipcRenderer：渲染进程端的 IPC 通信，用于向主进程发送消息
const { contextBridge, ipcRenderer } = require('electron');

/**
 * 通过 contextBridge.exposeInMainWorld 暴露 API
 * 第一个参数是 API 在 window 对象上的属性名（渲染进程通过 window.electronAPI 访问）
 * 第二个参数是暴露的 API 对象，包含各种方法
 * 
 * 注意：这里只暴露纯函数，不暴露 ipcRenderer 本身，防止渲染进程滥用
 */
contextBridge.exposeInMainWorld('electronAPI', {
  // ===== 窗口控制 API =====

  /**
   * 最小化窗口
   * 向主进程发送 'window-minimize' 消息，主进程接收后执行最小化
   */
  minimize: () => ipcRenderer.send('window-minimize'),

  /**
   * 最大化/还原窗口
   * 向主进程发送 'window-maximize' 消息，主进程接收后切换最大化状态
   */
  maximize: () => ipcRenderer.send('window-maximize'),

  /**
   * 关闭窗口
   * 向主进程发送 'window-close' 消息，主进程接收后关闭窗口
   */
  close: () => ipcRenderer.send('window-close'),

  /**
   * 查询窗口是否已最大化
   * 使用 invoke 方式（异步请求-响应模式），返回 Promise
   * 渲染进程可以 await 这个方法获取返回值
   */
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),

  /**
   * 监听最大化状态变化
   * 当窗口最大化/还原状态改变时，主进程会发送消息，这里注册回调
   * 注意：目前主进程尚未实现此事件的发送，预留接口供后续扩展
   * 
   * @param {Function} callback - 状态变化时的回调函数，参数为 isMaximized（布尔值）
   */
  onMaximizeChange: (callback) => {
    ipcRenderer.on('window-maximized-state', (_event, isMax) => callback(isMax));
  },

  // ===== 文件转换 API =====
  // 全部走 invoke（请求-响应）或事件监听，不暴露 ipcRenderer 本体（安全隔离）

  /**
   * 开始转换（单文件或批量）
   * @param {{files: string[], targetFormat: string, outputDir?: string, options?: object}} payload
   * @returns {Promise<Array<{taskId: number|null, outputPath: string|null, inputPath: string, error?: string}>>}
   */
  convertStart: (payload) => ipcRenderer.invoke('convert:start', payload),

  /** 取消转换 */
  convertCancel: (taskId) => ipcRenderer.invoke('convert:cancel', { taskId }),

  /** 批量转换（等待全部完成） */
  convertBatch: (files, targetFormat, outputDir, options) =>
    ipcRenderer.invoke('convert:batch', { files, targetFormat, outputDir, options }),

  /** 获取全部支持格式（导航切换时刷新下拉框） */
  getSupportedFormats: () => ipcRenderer.invoke('formats:supported'),

  /** 引擎状态检查（底部状态栏显示） */
  getEngineStatus: () => ipcRenderer.invoke('engines:status'),

  /** 监听转换进度推送 */
  onConvertProgress: (callback) => {
    ipcRenderer.on('convert:progress', (_event, payload) => callback(payload));
  },

  /** 监听转换完成推送 */
  onConvertComplete: (callback) => {
    ipcRenderer.on('convert:complete', (_event, payload) => callback(payload));
  },

  /** 监听转换失败推送 */
  onConvertError: (callback) => {
    ipcRenderer.on('convert:error', (_event, payload) => callback(payload));
  },

  // ===== 文件操作 API（结果面板用）=====

  /** 用系统默认程序打开文件 */
  openPath: (filePath) => ipcRenderer.invoke('file:open-path', filePath),

  /** 在资源管理器中显示文件所在位置 */
  showInFolder: (filePath) => ipcRenderer.invoke('file:show-in-folder', filePath),

  /**
   * 另存为：系统保存对话框 + 复制文件到目标位置（真正的"下载"）
   * @param {{sourcePath: string, suggestedName?: string, defaultDir?: string}} payload
   * @returns {Promise<string|null>} 保存路径；取消返回 null
   */
  saveAs: (payload) => ipcRenderer.invoke('file:save-as', payload),

  // ===== 新增功能 1：自选输出目录 =====

  /** 弹出系统目录选择对话框；取消返回 null */
  chooseDirectory: () => ipcRenderer.invoke('dialog:select-directory'),

  // ===== 新增功能 2：转换效果预览 =====

  /**
   * 生成预览图
   * @param {{inputPath: string, feature: string, targetFormat: string, options?: object}} payload
   * @returns {Promise<{original: string|null, preview: string|null, info: string|null}>}
   */
  getPreview: (payload) => ipcRenderer.invoke('preview:get', payload),

  // ===== 新增功能 3：右键菜单启动的文件 =====

  /** 拉取启动时携带的文件（右键菜单场景） */
  getPendingFiles: () => ipcRenderer.invoke('files:pending'),

  /** 监听新文件推送（二次实例转发 / 启动携带） */
  onOpenFiles: (callback) => {
    ipcRenderer.on('open-files', (_event, files) => callback(files));
  },
});
