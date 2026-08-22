/**
 * ============================================================
 * 预览服务（新增功能 2）
 * 功能：为前端生成「转换效果预览图」，支持：
 * - 图片转换：原图 + 转目标格式后的预览图
 * - 扫描件模拟：原图（或 PDF 首页）+ 应用扫描效果后的预览图
 * - PDF→图片：渲染首页作为预览
 * - 其他类型：如实返回「暂不支持图片预览」信息（不编造）
 *
 * 设计要点：
 * - 预览使用真实转换管线（与正式转换同一套函数），预览即所得（用户要求 1）
 * - 临时文件在 finally 中清理（用户要求 7）
 * - 图片以 base64 dataURL 返回，渲染进程可直接 <img> 显示，无需文件协议权限
 * ============================================================
 */

const fs = require('fs');                    // 读文件转 base64
const path = require('path');                // 路径拼接
const file = require('./utils/file');        // 临时目录
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

/** 读取图片文件为 dataURL（读失败返回 null，不中断预览流程） */
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

/**
 * 生成预览图
 * @param {string} inputPath - 输入文件路径
 * @param {string} feature - 当前功能（document/image/media/pdf/scan/ocr）
 * @param {string} targetFormat - 目标格式
 * @param {object} [options] - 转换选项（如扫描效果参数）
 * @returns {Promise<{original: string|null, preview: string|null, info: string|null}>}
 *   original/preview 为 dataURL；info 为不能预览时的说明文字
 */
async function generatePreview(inputPath, feature, targetFormat, options = {}) {
  const ext = file.getFileExtension(inputPath);
  // 创建一次性临时目录：预览产物用完即清理（用户要求 7）
  const tmpDir = file.createTempDir('luren-preview-');
  try {
    // 原图：仅图片类输入可显示
    let original = IMAGE_EXTS.includes(ext) ? toDataUrl(inputPath) : null;

    // 分功能生成预览图（真实调用转换管线，预览即所得）
    if (feature === 'scan') {
      // 扫描件模拟：图片直接应用效果；PDF 先渲染首页再应用效果
      if (IMAGE_EXTS.includes(ext)) {
        const out = path.join(tmpDir, 'preview.jpg');
        await scanEffect.applyScanEffect(inputPath, out, options);
        return { original, preview: toDataUrl(out), info: null };
      }
      if (ext === 'pdf') {
        const imgDir = path.join(tmpDir, 'pages');
        const imgs = await pdfMod.pdfToImages(inputPath, imgDir, { format: 'png', dpi: 120, firstPage: 1, lastPage: 1 });
        const out = path.join(tmpDir, 'preview.jpg');
        await scanEffect.applyScanEffect(imgs[0], out, options);
        return { original: null, preview: toDataUrl(out), info: 'PDF 首页预览' };
      }
      return { original: null, preview: null, info: '扫描件预览支持图片或 PDF 输入' };
    }

    if (feature === 'image') {
      // 图片转换：转到目标格式后显示
      if (imageMod.isSupported(ext, targetFormat)) {
        const out = path.join(tmpDir, 'preview.' + targetFormat);
        await imageMod.convertImage(inputPath, out, options);
        return { original, preview: toDataUrl(out), info: null };
      }
      return { original, preview: null, info: '该格式组合暂不支持预览' };
    }

    if (feature === 'pdf' && ['png', 'jpg', 'jpeg'].includes(targetFormat)) {
      // PDF → 图片：渲染首页作为预览
      const imgDir = path.join(tmpDir, 'pages');
      const imgs = await pdfMod.pdfToImages(inputPath, imgDir, { format: 'png', dpi: 120, firstPage: 1, lastPage: 1 });
      return { original: null, preview: toDataUrl(imgs[0]), info: 'PDF 首页预览' };
    }

    // 文档/音视频/OCR 等：无图片化预览能力，如实说明（用户要求 1）
    return { original, preview: null, info: '该类型暂不支持图片预览（转换完成后可打开/查看结果）' };
  } catch (err) {
    logger.error('[preview] 生成预览失败:', inputPath, err);
    throw new Error('预览生成失败: ' + inputPath + '（' + err.message + '）');
  } finally {
    file.cleanupTempDir(tmpDir);
  }
}

module.exports = { generatePreview, toDataUrl };
