/**
 * ============================================================
 * 转换调度核心（模块 10）
 * 功能：任务队列（并发控制）、格式路由、进度/事件管理、IPC 注册
 *
 * 设计要点：
 * - ConversionQueue 并发执行（默认 2），但 LibreOffice/Tesseract 类任务必须串行
 *   → 串行任务走独立的 promise 链（serialLock），互不重叠
 * - 转换任务统一由 convertFn(inputPath, outputPath, options) 驱动，
 *   新增格式只需扩展 getConverterForFormat 的路由表（用户要求 13：易扩展）
 * - 事件（taskStart/taskProgress/taskComplete/taskError/queueEmpty）供 IPC 推送给前端
 * ============================================================
 */

const fs = require('fs');                    // 写文本文件（txt 输出路径）
const path = require('path');                // 路径拼接
const { EventEmitter } = require('events');  // 事件驱动（Node 内置）
const file = require('./utils/file');        // 输出路径生成
const logger = require('./utils/logger');    // 日志

// 各转换器（模块 4-9）
const imageMod = require('./converters/image');
const mediaMod = require('./converters/media');
const documentMod = require('./converters/document');
const pdfMod = require('./converters/pdf');
const ocrMod = require('./converters/ocr');
const scanEffect = require('./scan-effect');

// 任务 ID 全局递增计数器（跨 IPC 调用唯一）
let taskIdCounter = 0;

/**
 * 单个转换任务
 * 属性与状态机：pending → processing → done | failed | cancelled
 */
class ConversionTask {
  /**
   * @param {object} param0
   * @param {string} param0.inputPath - 输入文件路径
   * @param {string} param0.outputPath - 输出文件路径
   * @param {string} param0.format - 目标格式
   * @param {Function} param0.convertFn - 实际转换函数 (input, output, options) => Promise
   * @param {object} [param0.options] - 转换选项
   * @param {boolean} [param0.serial=false] - 是否独占串行（LibreOffice/Tesseract 类）
   */
  constructor({ inputPath, outputPath, format, convertFn, options = {}, serial = false }) {
    this.id = ++taskIdCounter;
    this.inputPath = inputPath;
    this.outputPath = outputPath;
    this.format = format;
    this.convertFn = convertFn;
    this.options = options;
    this.serial = serial;
    this.status = 'pending';   // pending / processing / done / failed / cancelled
    this.progress = 0;         // 0-100
    this.error = null;
    this.createdAt = Date.now();
    this._onProgress = null;   // 进度回调（由队列注入）
  }

  /** 注册进度回调 */
  onProgress(callback) {
    this._onProgress = callback;
  }

  /** 更新进度并通知（仅单调递增，防倒退） */
  setProgress(value) {
    if (value > this.progress) {
      this.progress = Math.min(100, value);
      if (this._onProgress) this._onProgress(this);
    }
  }

  /** 执行转换（由队列调度） */
  async start() {
    if (this.status === 'cancelled') return; // 已取消的任务直接跳过
    this.status = 'processing';
    this.setProgress(5);
    logger.info('[converter] 任务开始:', this.id, this.inputPath, '→', this.outputPath);
    try {
      // 转换函数返回的实际路径可能不同于预生成路径（如 PDF→图片实际产物是 base-1.png），
      // 以实际产物为准，保证完成事件/状态查询指向真实文件
      const resultPath = await this.convertFn(this.inputPath, this.outputPath, this.options);
      if (resultPath && typeof resultPath === 'string') this.outputPath = resultPath;
      if (this.status === 'cancelled') return;
      this.status = 'done';
      this.setProgress(100);
      logger.info('[converter] 任务完成:', this.id, this.outputPath);
    } catch (err) {
      if (this.status === 'cancelled') return;
      this.status = 'failed';
      this.error = err.message || String(err);
      logger.error('[converter] 任务失败:', this.id, this.inputPath, err);
    }
  }

  /**
   * 取消任务
   * 说明：仅对「排队中」的任务生效；正在执行的子进程转换无法中途终止
   * （终止子进程需要进程句柄，当前设计下转换会自然跑完，见 utils/process.js）
   */
  cancel() {
    if (this.status === 'pending') {
      this.status = 'cancelled';
      logger.info('[converter] 任务已取消:', this.id);
    }
  }
}

/**
 * 转换队列：并发控制 + 事件通知 + 串行任务隔离
 */
class ConversionQueue extends EventEmitter {
  /**
   * @param {number} [concurrency=2] - 最大并发数
   */
  constructor(concurrency = 2) {
    super();
    this.concurrency = concurrency;
    this.tasks = new Map(); // taskId → ConversionTask
    this.running = 0;
    this.paused = false;
    // 串行锁：所有串行任务排队依次执行（LibreOffice/Tesseract 不能并发）
    this.serialLock = Promise.resolve();
  }

  /** 添加任务并尝试启动 */
  addTask(task) {
    task.onProgress((t) => this.emit('taskProgress', t));
    this.tasks.set(task.id, task);
    this.emit('taskStart', task);
    this._pump();
    return task.id;
  }

  /** 取消任务（排队中生效） */
  cancelTask(taskId) {
    const task = this.tasks.get(taskId);
    if (task) task.cancel();
    return !!task;
  }

  /** 查询任务状态快照 */
  getStatus(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    return {
      id: task.id,
      status: task.status,
      progress: task.progress,
      error: task.error,
      inputPath: task.inputPath,
      outputPath: task.outputPath,
    };
  }

  /** 暂停调度（已在运行的继续跑完） */
  pause() { this.paused = true; }

  /** 恢复调度 */
  resume() { this.paused = false; this._pump(); }

  /** 队列信息（前端可显示） */
  getQueueInfo() {
    return {
      running: this.running,
      pending: [...this.tasks.values()].filter((t) => t.status === 'pending').length,
      total: this.tasks.size,
    };
  }

  /** 是否有未完成任务（供批量等待） */
  hasPending() {
    return [...this.tasks.values()].some((t) => t.status === 'pending' || t.status === 'processing');
  }

  /**
   * 调度器：有空闲槽位就取出下一个 pending 任务执行
   * 串行任务挂到 serialLock 链上（一次一个），其余任务直接并发
   */
  _pump() {
    if (this.paused) return;
    while (this.running < this.concurrency) {
      // _scheduled 标记：任务一旦被选中调度就不能再被选（多个 finally 并发触发 _pump 时，
      // 若不加标记，同一个串行任务会被链上两次导致重复执行——实测发现的 bug）
      const next = [...this.tasks.values()].find((t) => t.status === 'pending' && !t._scheduled);
      if (!next) {
        // 无待办且无运行中 → 队列清空
        if (this.running === 0) this.emit('queueEmpty');
        return;
      }
      next._scheduled = true;
      this.running++;
      const runTask = async () => {
        try {
          await next.start();
          // 任务结果事件：done → taskComplete；failed → taskError（cancelled 不发）
          if (next.status === 'done') this.emit('taskComplete', next);
          else if (next.status === 'failed') this.emit('taskError', next);
        } finally {
          this.running--;
          this._pump();
        }
      };
      if (next.serial) {
        // 串行：接到现有链条末尾，保证同一时刻只有一个串行任务在跑
        this.serialLock = this.serialLock.then(runTask);
      } else {
        runTask();
      }
    }
  }
}

// 模块级单例队列：所有 IPC 调用共享同一队列（任务 ID 与并发控制全局一致）
const queue = new ConversionQueue(2);

/**
 * 文本输出专用转换：PDF 优先文本层提取（快），空结果降级 OCR（扫描件）
 * @param {string} inputPath
 * @param {string} outputPath
 * @returns {Promise<string>}
 */
async function convertToText(inputPath, outputPath, options) {
  const ext = file.getFileExtension(inputPath);
  if (ext === 'pdf') {
    try {
      const text = await pdfMod.extractText(inputPath);
      if (text && text.trim().length > 0) {
        fs.writeFileSync(outputPath, text, 'utf8');
        return outputPath;
      }
    } catch {
      // 提取失败（如加密 PDF）→ 落到 OCR 路径，由 OCR 给出明确错误
    }
  }
  return ocrMod.recognizeToFile(inputPath, outputPath, options);
}

/**
 * PDF → 图片 专用转换：把输出路径的「基名+扩展名」作为 pdftoppm 前缀
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {object} options
 * @returns {Promise<string>} 第一张图片路径（其余在 outputPaths 中）
 */
async function pdfToImagesConverter(inputPath, outputPath, options) {
  const dir = path.dirname(outputPath);
  const base = path.basename(outputPath, path.extname(outputPath));
  const format = path.extname(outputPath).slice(1);
  const images = await pdfMod.pdfToImages(inputPath, dir, { format, dpi: options.dpi || 150, prefix: base });
  return images[0];
}

/**
 * 格式路由：根据输入/输出扩展名选择转换器
 * 规则（按优先级）：
 * - 目标扫描件 PDF（options.scanEffect）→ scan-effect
 * - 图片互转 → image.convertImage（可并发）
 * - 音视频互转 → media.convertMedia（可并发）
 * - PDF→图片 → pdf.pdfToImages（多页）
 * - 目标 txt（图片/PDF 输入）→ 文本提取或 OCR
 * - 文档互转（含 PDF→文档）→ document.convertDocument（LibreOffice，串行）
 * @param {string} inputExt - 输入扩展名（小写）
 * @param {string} outputExt - 输出扩展名（小写）
 * @param {object} [options] - 路由选项（scanEffect/dpi 等）
 * @returns {{convertFn: Function, type: string, serial: boolean}|null}
 */
function getConverterForFormat(inputExt, outputExt, options = {}) {
  const inExt = String(inputExt || '').toLowerCase();
  const outExt = String(outputExt || '').toLowerCase();

  // 1) 扫描件模拟：目标 PDF 且调用方要求扫描效果
  if (outExt === 'pdf' && options.scanEffect) {
    return { convertFn: scanEffect.convertToScannedPdf, type: 'scan', serial: true };
  }

  // 2) 图片互转（sharp 主力的并发安全）
  if (imageMod.isSupported(inExt, outExt)) {
    return { convertFn: imageMod.convertImage, type: 'image', serial: false };
  }

  // 3) 音视频互转（ffmpeg 可并发）
  if (mediaMod.isSupported(inExt, outExt)) {
    return { convertFn: mediaMod.convertMedia, type: 'media', serial: false };
  }

  // 4) PDF → 图片（多页输出）
  if (inExt === 'pdf' && ['png', 'jpg', 'jpeg', 'tiff'].includes(outExt)) {
    return { convertFn: pdfToImagesConverter, type: 'pdf-image', serial: false };
  }

  // 5) → txt：PDF 走文本提取（空则 OCR），图片走 OCR（Tesseract 串行）
  const isImageInput = imageMod.INPUT_FORMATS.includes(inExt);
  if (outExt === 'txt' && (inExt === 'pdf' || isImageInput)) {
    return { convertFn: convertToText, type: 'text', serial: true };
  }

  // 6) 文档互转（LibreOffice，必须串行；pdf→docx 等也走这里）
  if (documentMod.isSupported(inExt, outExt)) {
    return { convertFn: documentMod.convertDocument, type: 'document', serial: true };
  }

  return null;
}

/**
 * 转换单个文件（创建任务并入队）
 * @param {string} inputPath - 输入文件路径
 * @param {string} targetFormat - 目标格式（如 'pdf'）
 * @param {string} [outputDir] - 输出目录（默认输入文件同目录）
 * @param {object} [options] - 转换/路由选项
 * @returns {{outputPath: string, taskId: number}}
 */
function convertFile(inputPath, targetFormat, outputDir, options = {}) {
  const inputExt = file.getFileExtension(inputPath);
  const outputExt = String(targetFormat || '').toLowerCase();
  // 同格式转换无意义（如 pdf→pdf），提前拦截避免白白跑一遍引擎
  if (inputExt === outputExt) {
    throw new Error('输入与输出格式相同，无需转换');
  }
  const route = getConverterForFormat(inputExt, outputExt, options);
  if (!route) {
    throw new Error('不支持的转换: ' + (inputExt || '?') + ' → ' + (outputExt || '?'));
  }

  let outputPath = file.generateOutputPath(inputPath, outputExt, outputDir);
  // 与队列中已排队任务的输出路径去重：批量转换同名输入（不同目录的同名文件）
  // 会在文件落盘前同时生成相同路径，后写的任务会覆盖先写的（实测发现的边界问题）
  let collisionCounter = 1;
  while ([...queue.tasks.values()].some((t) => t.outputPath === outputPath)) {
    const cleanBase = path.basename(outputPath, path.extname(outputPath)).replace(/\s*\(\d+\)$/, '');
    outputPath = path.join(path.dirname(outputPath), cleanBase + ' (' + collisionCounter + ').' + outputExt);
    collisionCounter++;
  }
  // 输出目录必须预先创建：generateOutputPath 只做存在性检查不建目录，
  // 而图片/媒体转换器直接写文件，目录缺失会导致转换失败（实测发现）
  file.ensureDir(path.dirname(outputPath));
  const task = new ConversionTask({
    inputPath,
    outputPath,
    format: outputExt,
    convertFn: route.convertFn,
    options,
    serial: route.serial,
  });
  queue.addTask(task);
  logger.info('[converter] 入队:', task.id, inputPath, '→', outputExt);
  return { outputPath, taskId: task.id };
}

/**
 * 批量转换（多个文件统一目标格式）
 * @param {string[]} inputPaths - 输入文件数组
 * @param {string} targetFormat - 目标格式
 * @param {string} [outputDir] - 输出目录
 * @param {object} [options] - 选项
 * @returns {Promise<string[]>} 输出路径数组（失败项为 null，与输入一一对应）
 */
async function batchConvert(inputPaths, targetFormat, outputDir, options = {}) {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) throw new Error('批量转换至少需要一个文件');

  const results = inputPaths.map(() => null);
  const tasks = [];

  // 先入队全部任务（避免串行等待时新任务插队），记录每个任务对应的结果槽位
  inputPaths.forEach((inputPath, index) => {
    try {
      const { outputPath, taskId } = convertFile(inputPath, targetFormat, outputDir, options);
      tasks.push({ taskId, index, outputPath });
    } catch (err) {
      // 单文件不支持等：记录错误并继续（不中断整体）
      logger.warn('[converter] 批量跳过:', inputPath, err.message);
      results[index] = null;
    }
  });

  // 等待所有任务结束：轮询 hasPending（队列事件驱动更优雅，但轮询简单可靠且频率低）
  await new Promise((resolve) => {
    const check = () => {
      if (!queue.hasPending()) {
        resolve();
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });

  // 汇总输出路径（失败任务 → null）
  tasks.forEach(({ taskId, index, outputPath }) => {
    const status = queue.getStatus(taskId);
    results[index] = status && status.status === 'done' ? outputPath : null;
  });
  return results;
}

/**
 * 注册 IPC 处理器（在主进程 index.js 中调用）
 * @param {Electron.IpcMain} ipcMain
 * @param {Electron.BrowserWindow} mainWindow
 */
function registerIpcHandlers(ipcMain, mainWindow) {
  // 推送封装：窗口可能已关闭，发送前必须检查（否则会抛异常）
  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  };

  // 队列事件 → 渲染进程推送
  queue.on('taskStart', (t) => send('convert:progress', { taskId: t.id, status: 'processing', progress: t.progress }));
  queue.on('taskProgress', (t) => send('convert:progress', { taskId: t.id, status: t.status, progress: t.progress }));
  queue.on('taskComplete', (t) => send('convert:complete', { taskId: t.id, outputPath: t.outputPath, status: 'done' }));
  queue.on('taskError', (t) => send('convert:error', { taskId: t.id, error: t.error, status: 'failed' }));

  /**
   * 开始转换（单文件或批量）
   * 载荷：{ files: string[], targetFormat: string, outputDir?: string, options?: object }
   * 返回：[{ taskId, outputPath, inputPath }]
   */
  ipcMain.handle('convert:start', (event, payload = {}) => {
    const { files = [], targetFormat, outputDir, options = {} } = payload;
    if (!Array.isArray(files) || files.length === 0) throw new Error('未指定转换文件');
    if (!targetFormat) throw new Error('未指定目标格式');

    return files.map((inputPath) => {
      try {
        const { outputPath, taskId } = convertFile(inputPath, targetFormat, outputDir, options);
        return { taskId, outputPath, inputPath };
      } catch (err) {
        // 单个文件路由失败不中断批量：返回错误标记由前端展示
        return { taskId: null, outputPath: null, inputPath, error: err.message };
      }
    });
  });

  /** 取消任务 */
  ipcMain.handle('convert:cancel', (event, { taskId } = {}) => {
    return queue.cancelTask(taskId);
  });

  /** 查询任务状态 */
  ipcMain.handle('convert:status', (event, { taskId } = {}) => {
    return queue.getStatus(taskId);
  });

  /** 批量转换（等待全部完成） */
  ipcMain.handle('convert:batch', async (event, { files = [], targetFormat, outputDir, options = {} } = {}) => {
    return batchConvert(files, targetFormat, outputDir, options);
  });

  /** 获取所有支持格式（前端导航切换时刷新下拉框） */
  ipcMain.handle('formats:supported', async () => {
    const [image, media] = await Promise.all([imageMod.getSupportedFormats(), Promise.resolve(mediaMod.getSupportedFormats())]);
    return {
      document: documentMod.getSupportedFormats(),
      image,
      media,
      ocr: { languages: ocrMod.getSupportedLanguages() },
      pdf: { formats: ['pdf'] },
    };
  });
}

module.exports = {
  ConversionTask,
  ConversionQueue,
  convertFile,
  batchConvert,
  getConverterForFormat,
  registerIpcHandlers,
};
