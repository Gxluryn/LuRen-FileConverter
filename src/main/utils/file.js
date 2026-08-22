/**
 * ============================================================
 * 文件操作工具（模块 2）
 * 功能：统一的文件/路径工具函数集合
 *
 * 为什么需要本模块？
 * - 所有转换器都涉及：临时目录、路径生成、文件名清理、大小格式化
 * - 集中实现一次，避免各转换器重复粘贴相似代码（用户要求 10：功能只写一遍）
 * - 统一处理 Windows 非法字符、重名避让等边界情况，减少各模块出错面
 *
 * 设计要点：
 * - 纯同步小函数为主，无 I/O 依赖，方便单元测试（用户要求 16）
 * - 所有函数对异常输入有兜底（如 formatFileSize 处理负数/NaN）
 * - 不依赖 logger（日志模块在其后编写），清理失败仅 console.warn 不抛异常
 * ============================================================
 */

const fs = require('fs');              // 文件系统：目录创建、存在性检查
const os = require('os');              // 系统信息：os.tmpdir() 获取系统临时目录
const path = require('path');          // 路径处理：跨平台拼接、解析
const sanitizeFilename = require('sanitize-filename'); // 清理 Windows/Linux 非法文件名字符

// 临时目录默认前缀：mkdtemp 会在前缀后追加随机串，保证每次转换目录唯一、可并发
const DEFAULT_TEMP_PREFIX = 'luren-convert-';

/**
 * 创建临时目录
 * mkdtempSync 保证目录唯一且已创建，无需担心重名
 * @param {string} [prefix=DEFAULT_TEMP_PREFIX] - 目录名前缀
 * @returns {string} 新创建的临时目录绝对路径
 */
function createTempDir(prefix = DEFAULT_TEMP_PREFIX) {
  // 前缀必须是合法目录名片段：去掉路径分隔符，防止用户传入 '../' 等越权路径（安全要求）
  const safePrefix = String(prefix).replace(/[\\/:*?"<>|]/g, '-');
  return fs.mkdtempSync(path.join(os.tmpdir(), safePrefix));
}

/**
 * 递归删除临时目录
 * @param {string} dirPath - 要删除的目录
 * 失败只警告不抛异常：清理是收尾工作，失败不应中断主流程（但会让下次转换多占磁盘）
 */
function cleanupTempDir(dirPath) {
  // 空路径直接返回：避免误删当前目录等危险操作
  if (!dirPath) return;
  try {
    // recursive:true 删除子内容，force:true 文件不存在时不报错
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (err) {
    // 不向上抛：调用方通常已在 finally 中清理，这里只记录便于排查
    console.warn('[file] 清理临时目录失败:', dirPath, err.message);
  }
}

/**
 * 清理文件名中的非法字符（Windows 保留字符、保留设备名等）
 * @param {string} name - 原始文件名
 * @returns {string} 安全的文件名
 */
function sanitizeFileName(name) {
  // sanitize-filename 会替换 <>:"/\\|?* 等非法字符，并处理 CON/PRN 等保留名
  const cleaned = sanitizeFilename(String(name));
  // 极端情况：清理后为空（如名字全是非法字符）时给兜底名，避免生成空文件名
  return cleaned || 'unnamed';
}

/**
 * 字节数 → 友好显示（B/KB/MB/GB，保留 1 位小数）
 * @param {number} bytes - 字节数
 * @returns {string} 如 "1.5 MB"
 */
function formatFileSize(bytes) {
  // 防御非法输入：非数字/负数/NaN 统一按 0 处理，避免显示 NaN/负数
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  // 每 1024 提升一档；最多到 TB，防止超大数字无限循环
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  // 整数单位（B）不带小数，其余保留 1 位小数，避免 "1.0 KB" 这类冗余显示
  return unitIndex === 0 ? value + ' ' + units[unitIndex] : value.toFixed(1) + ' ' + units[unitIndex];
}

/**
 * 获取文件扩展名（小写、不含点）
 * @param {string} filePath - 文件路径或文件名
 * @returns {string} 扩展名，无扩展名返回空字符串
 */
function getFileExtension(filePath) {
  // path.extname 对目录路径中的点免疫（只取 basename 最后一段），
  // 但隐藏文件如 '.gitignore' 会被误判为 '.gitignore' 扩展名，需用 basename 二次判断：
  const base = path.basename(String(filePath));
  // 首字符是 '.' 且没有其他 '.' → 隐藏文件，无扩展名
  if (base.startsWith('.') && base.indexOf('.', 1) === -1) return '';
  return path.extname(base).slice(1).toLowerCase();
}

/**
 * 替换文件扩展名
 * @param {string} filePath - 原路径
 * @param {string} newExt - 新扩展名（可带或不带点）
 * @returns {string} 替换后的路径
 */
function replaceExtension(filePath, newExt) {
  // 统一去掉点并小写，避免调用方传 '.PDF'/'pdf' 混用导致路径不一致
  const ext = String(newExt).replace(/^\./, '').toLowerCase();
  const base = path.basename(String(filePath));
  // 无扩展名的文件直接追加 '.ext'；有则替换最后一段
  const newBase = base.includes('.') && !base.startsWith('.')
    ? base.slice(0, base.lastIndexOf('.')) + '.' + ext
    : base + '.' + ext;
  return path.join(path.dirname(String(filePath)), newBase);
}

/**
 * 确保目录存在（不存在则创建，含多级目录）
 * @param {string} dirPath - 目录路径
 */
function ensureDir(dirPath) {
  // recursive:true 创建多级且已存在时不报错，幂等安全
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * 生成输出路径：重名时自动追加 (1)、(2) 避免覆盖用户已有文件
 * @param {string} inputPath - 输入文件路径
 * @param {string} targetFormat - 目标格式（如 'pdf'）
 * @param {string} [outputDir] - 输出目录，默认输入文件所在目录
 * @returns {string} 不冲突的输出文件路径
 */
function generateOutputPath(inputPath, targetFormat, outputDir) {
  // 校验目标格式：只允许字母数字且长度 ≤10，
  // 防止目标格式被注入路径分隔符/非法字符（安全要求：禁止路径注入）
  const format = String(targetFormat || '').toLowerCase();
  if (!/^[a-z0-9]{1,10}$/.test(format)) {
    throw new Error('非法的目标格式: ' + targetFormat);
  }

  const dir = outputDir || path.dirname(String(inputPath));
  // 清理原始文件名（去掉非法字符），扩展名替换为目标格式
  const baseName = sanitizeFileName(path.basename(String(inputPath), path.extname(String(inputPath))));
  let candidate = path.join(dir, baseName + '.' + format);

  // 重名避让：存在则追加 (1)/(2)...，用 while 而非递归，避免深路径且逻辑直白
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, baseName + ' (' + counter + ').' + format);
    counter++;
  }
  return candidate;
}

module.exports = {
  createTempDir,
  cleanupTempDir,
  sanitizeFileName,
  formatFileSize,
  getFileExtension,
  replaceExtension,
  ensureDir,
  generateOutputPath,
};
