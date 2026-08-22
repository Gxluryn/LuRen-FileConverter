/**
 * ============================================================
 * OCR 识别模块（模块 8）
 * 功能：图片/扫描件文字识别（Tesseract），支持中英文
 *
 * 技术要点：
 * - 调用本地 tesseract.exe（engines.js 管理路径），输出到 stdout（第二个参数为 stdout）
 * - Tesseract 不支持并发：批量识别必须串行（调度层限制）
 * - PDF 识别流程：PDF → 每页转图片（poppler）→ 逐页 OCR → 拼接（ 分页符）
 * - 识别结果后处理：去首尾空白、合并连续空行（tesseract 输出常有空行噪声）
 * ============================================================
 */

const fs = require('fs');                    // 语言包目录读取
const path = require('path');                // 路径拼接
const file = require('../utils/file');       // 临时目录
const logger = require('../utils/logger');   // 日志
const { runEngine } = require('../utils/process'); // 子进程调用
const { ENGINES } = require('../engines');   // tessdata 路径
const pdfMod = require('./pdf');             // PDF 转图片（识别 PDF 时复用）

// 图片扩展名集合：识别到非图片输入（如 PDF）走 recognizePdf
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff', 'webp', 'gif', 'ico', 'heic'];

/**
 * 识别单张图片中的文字
 * @param {string} imagePath - 图片路径
 * @param {object} [options]
 * @param {string} [options.lang='chi_sim+eng'] - 语言组合（+ 连接）
 * @param {number} [options.psm=3] - 页面分割模式（3=全自动，无方向检测）
 * @param {number} [options.oem=1] - OCR 引擎模式（1=LSTM）
 * @returns {Promise<string>} 识别出的文本
 */
async function recognizeImage(imagePath, options = {}) {
  const { lang = 'chi_sim+eng', psm = 3, oem = 1 } = options;
  // 第二个参数 'stdout' 让 tesseract 把结果打到标准输出（而非写文件）
  // --tessdata-dir 显式指定语言包目录，避免环境变量未配置时找不到语言包
  const { stdout } = await runEngine('tesseract', [
    imagePath, 'stdout', '-l', lang, '--psm', String(psm), '--oem', String(oem),
    '--tessdata-dir', ENGINES.tessdata,
  ], { timeout: 120000 });

  return postProcessText(stdout);
}

/**
 * 识别整个 PDF 的文字（逐页 OCR 后拼接）
 * @param {string} pdfPath - PDF 路径
 * @param {object} [options] - recognizeImage 的选项 + dpi/firstPage/lastPage
 * @returns {Promise<string>} 全部页文字（页间  分页符）
 */
async function recognizePdf(pdfPath, options = {}) {
  const { dpi = 200, firstPage, lastPage, ...ocrOptions } = options;
  // 创建一次性临时目录存放中间图片；无论成败都要清理（用户要求 7）
  const tmpDir = file.createTempDir('luren-ocr-');
  try {
    const images = await pdfMod.pdfToImages(pdfPath, tmpDir, { format: 'png', dpi, firstPage, lastPage });

    // Tesseract 不支持并发：串行逐页识别，页间以 （换页符）分隔
    // （PDF 文本提取惯例用  表示分页，便于下游按页切分）
    const pages = [];
    for (const img of images) {
      const pageText = await recognizeImage(img, ocrOptions);
      pages.push(pageText);
    }
    return pages.join('\f');
  } catch (err) {
    logger.error('[ocr] PDF 识别失败:', pdfPath, err);
    throw new Error('PDF 识别失败: ' + pdfPath + '（' + err.message + '）');
  } finally {
    file.cleanupTempDir(tmpDir);
  }
}

/**
 * 识别输入文件（图片或 PDF）并输出到文本文件
 * @param {string} inputPath - 图片或 PDF 路径
 * @param {string} outputPath - 输出 txt 路径
 * @param {object} [options]
 * @returns {Promise<string>} 输出路径
 */
async function recognizeToFile(inputPath, outputPath, options = {}) {
  const ext = file.getFileExtension(inputPath);
  const text = IMAGE_EXTS.includes(ext)
    ? await recognizeImage(inputPath, options)
    : await recognizePdf(inputPath, options);
  file.ensureDir(path.dirname(outputPath));
  fs.writeFileSync(outputPath, text, 'utf8');
  return outputPath;
}

/**
 * 获取已安装的 OCR 语言列表
 * @returns {string[]} 语言代码数组（如 ['chi_sim', 'eng']）
 */
function getSupportedLanguages() {
  try {
    return fs.readdirSync(ENGINES.tessdata)
      .filter((name) => name.endsWith('.traineddata'))
      .map((name) => name.replace(/.traineddata$/, ''))
      .sort();
  } catch (err) {
    // tessdata 目录缺失：返回空数组并记录（比崩溃好）
    logger.warn('[ocr] 读取 tessdata 目录失败:', err.message);
    return [];
  }
}

/**
 * 识别文本后处理：去首尾空白 + 合并连续空行
 * tesseract 输出常含行尾空格与多个空行，清理后更整洁
 * @param {string} text
 * @returns {string}
 */
function postProcessText(text) {
  return String(text)
    .replace(/\r\n/g, '\n')         // Windows 换行统一为 \n（tesseract 输出是 CRLF）
    .replace(/[ \t]+$/gm, '')      // 每行行尾空白
    .replace(/\n{3,}/g, '\n\n')    // 连续空行压缩
    .trim();
}

module.exports = { recognizeImage, recognizePdf, recognizeToFile, getSupportedLanguages, IMAGE_EXTS };
