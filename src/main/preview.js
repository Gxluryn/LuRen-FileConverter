/**
 * ============================================================
 * 预览服务（增强版）
 * 功能：为前端生成「转换效果预览」，并返回对比数据
 * - 图片转换：原图 + 按参数（质量/缩放）转换后的预览 + 尺寸/大小对比
 * - 扫描件模拟：原图（或 PDF 首页）+ 应用扫描效果（支持预设）后的预览
 * - PDF 处理：渲染首页作为预览（无论目标格式）
 * - 文档/音视频/OCR：如实返回文件信息与说明（不做假预览）
 *
 * 设计要点：
 * - 预览使用真实转换管线（与正式转换同一套函数），预览即所得
 * - 临时文件在 finally 中清理（用户要求 7）
 * - 图片以 base64 dataURL 返回，渲染进程可直接显示
 * ============================================================
 */

const fs = require('fs');                    // 读文件、stat 大小
const path = require('path');                // 路径拼接
const file = require('./utils/file');        // 临时目录、扩展名
const logger = require('./utils/logger');    // 日志
const imageMod = require('./converters/image');   // 图片转换
const pdfMod = require('./converters/pdf');       // PDF 转图
const scanEffect = require('./scan-effect');      // 扫描效果

// 可直接显示为图片的扩展名（预览原图用）
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'ico', 'tiff', 'heic', 'svg'];

// 扩展名 → MIME（dataURL 需要正确的 MIME 类型）
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  bmp: 'image/bmp', gif: 'image/gif', ico: 'image/x-icon', tiff: 'image/tiff',
  heic: 'image/heic', svg: 'image/svg+xml',
};

/** 读取图片文件为 dataURL（读失败返回 null） */
function toDataUrl(filePath) {
  try {
    const ext = file.getFileExtension(filePath);
    const buf = fs.readFileSync(filePath);
    return 'data:' + (MIME[ext] || 'application/octet-stream') + ';base64,' + buf.toString('base64');
  } catch (err) {
    logger.warn('[preview] 读取图片失败:', filePath, err.message);
    return null;
  }
}

/** 获取文件大小（字节）与尺寸信息（图片），失败返回 0/null */
function fileStats(filePath) {
  const size = (() => { try { return fs.statSync(filePath).size; } catch { return 0; } })();
  return { size };
}

/**
 * 把 options.preset 展开为扫描效果参数
 * 预览与正式转换共用同一映射，保证「预览即所得」
 * @param {object} options
 * @returns {object} 展开后的效果参数
 */
function resolveScanOptions(options) {
  if (options && options.preset) {
    const presets = scanEffect.getEffectPresets();
    const presetParams = presets[options.preset];
    if (presetParams) return { ...presetParams, ...options };
  }
  return { ...options };
}

/**
 * 生成预览图与对比数据
 * @param {string} inputPath - 输入文件路径
 * @param {string} feature - 当前功能（document/image/media/pdf/scan/ocr）
 * @param {string} targetFormat - 目标格式
 * @param {object} [options] - 转换选项（图片质量/缩放、扫描预设等）
 * @returns {Promise<object>}
 *   { original, preview, info, fileInfo, originalStats, previewStats }
 */
async function generatePreview(inputPath, feature, targetFormat, options = {}) {
  const ext = file.getFileExtension(inputPath);
  const tmpDir = file.createTempDir('luren-preview-');
  try {
    // 文件信息（所有类型都返回，前端可展示）
    const fileInfo = {
      name: path.basename(inputPath),
      type: ext.toUpperCase() || '未知',
      size: fileStats(inputPath).size,
      fullPath: inputPath,
    };

    // 原图：仅图片类输入可显示
    let original = IMAGE_EXTS.includes(ext) ? toDataUrl(inputPath) : null;

    // 分功能生成预览
    if (feature === 'scan') {
      const opts = resolveScanOptions(options);
      if (IMAGE_EXTS.includes(ext)) {
        const out = path.join(tmpDir, 'preview.jpg');
        await scanEffect.applyScanEffect(inputPath, out, opts);
        return {
          original, preview: toDataUrl(out), info: null, fileInfo,
          originalStats: original ? fileStats(inputPath) : null,
          previewStats: fileStats(out),
        };
      }
      if (ext === 'pdf') {
        const imgDir = path.join(tmpDir, 'pages');
        const imgs = await pdfMod.pdfToImages(inputPath, imgDir, { format: 'png', dpi: 120, firstPage: 1, lastPage: 1 });
        const out = path.join(tmpDir, 'preview.jpg');
        await scanEffect.applyScanEffect(imgs[0], out, opts);
        return { original: null, preview: toDataUrl(out), info: 'PDF 首页扫描预览', fileInfo, originalStats: null, previewStats: fileStats(out) };
      }
      return { original: null, preview: null, info: '扫描件预览支持图片或 PDF 输入', fileInfo, originalStats: null, previewStats: null };
    }

    if (feature === 'image') {
      if (imageMod.isSupported(ext, targetFormat)) {
        const out = path.join(tmpDir, 'preview.' + targetFormat);
        await imageMod.convertImage(inputPath, out, options);
        return {
          original, preview: toDataUrl(out), info: null, fileInfo,
          originalStats: original ? fileStats(inputPath) : null,
          previewStats: fileStats(out),
        };
      }
      return { original, preview: null, info: '该格式组合暂不支持预览', fileInfo, originalStats: original ? fileStats(inputPath) : null, previewStats: null };
    }

    if (feature === 'pdf') {
      // PDF 处理（拆分/合并/加密/转文档等）：渲染首页作为预览，让用户看到内容
      const imgDir = path.join(tmpDir, 'pages');
      const imgs = await pdfMod.pdfToImages(inputPath, imgDir, { format: 'png', dpi: 120, firstPage: 1, lastPage: 1 });
      // 页数信息：pdfinfo 快速读取（失败时省略，不影响预览）
      let pageInfo = '';
      try {
        const info = await pdfMod.getPdfInfo(inputPath);
        if (info && info.pages) pageInfo = '，共 ' + info.pages + ' 页';
      } catch { /* 页数读取失败不影响预览 */ }
      return { original: null, preview: toDataUrl(imgs[0]), info: 'PDF 首页预览' + pageInfo, fileInfo, originalStats: null, previewStats: fileStats(imgs[0]) };
    }

    // 文档/音视频/OCR 等：如实返回文件信息与说明
    const info = '该类型暂不支持图片预览，可查看文件信息后直接转换';
    return { original, preview: null, info, fileInfo, originalStats: original ? fileStats(inputPath) : null, previewStats: null };
  } catch (err) {
    logger.error('[preview] 生成预览失败:', inputPath, err);
    throw new Error('预览生成失败: ' + inputPath + '（' + err.message + '）');
  } finally {
    file.cleanupTempDir(tmpDir);
  }
}

module.exports = { generatePreview, toDataUrl, resolveScanOptions };
