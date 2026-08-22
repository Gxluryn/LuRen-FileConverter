/**
 * ============================================================
 * 文档转换器（模块 6）
 * 功能：办公文档互转（Word/Excel/PPT/PDF/TXT/RTF/ODF/HTML）
 *
 * 技术选型：
 * - 主力引擎 LibreOffice Portable（headless 模式），覆盖绝大多数文档互转
 * - docx → html / txt 走 mammoth（纯 JS、快、排版保真度好），避免每次起 LibreOffice
 *
 * 关键约束（必须遵守）：
 * - LibreOffice 不支持并发：batchConvert 必须串行执行（用户要求 4/6）
 * - 转换输出文件名由 LibreOffice 自行决定（输入同名+新扩展名），
 *   所以先转到临时目录，再移动到调用方指定的最终路径（已去重），避免覆盖用户文件
 * - 首次启动 LibreOffice 慢（10-30 秒初始化），属正常现象，超时给足 5 分钟
 * ============================================================
 */

const fs = require('fs');                    // 文件移动、存在性检查
const path = require('path');                // 路径拼接
const mammoth = require('mammoth');          // DOCX → HTML/文本（纯 JS）
const file = require('../utils/file');       // 临时目录、扩展名
const logger = require('../utils/logger');   // 日志
const { runEngine } = require('../utils/process'); // 子进程调用

// 支持的输入格式（LibreOffice 能打开的办公文档）
const INPUT_FORMATS = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf', 'txt', 'rtf', 'odt', 'ods', 'odp', 'html'];

// 支持的输出格式
const OUTPUT_FORMATS = ['pdf', 'docx', 'xlsx', 'pptx', 'txt', 'html', 'odt', 'ods', 'odp', 'rtf'];

// LibreOffice 首次启动慢，转换超时放宽到 5 分钟；正常转换远快于此
const LO_TIMEOUT = 300000;

/**
 * 通过 LibreOffice headless 转换单个文档
 * 流程：输入 → LibreOffice 输出到临时目录（同名新扩展名）→ 移动到最终路径
 * @param {string} inputPath - 输入文件路径
 * @param {string} outputPath - 最终输出路径（调用方负责去重）
 * @param {object} [options] - 保留参数位（与转换器签名一致），当前无额外选项
 * @returns {Promise<string>} 输出文件路径
 */
async function convertDocument(inputPath, outputPath, options = {}) {
  const outExt = file.getFileExtension(outputPath);
  // 前置校验：目标格式必须在支持清单内（提前报错，避免 LibreOffice 晦涩报错）
  if (!OUTPUT_FORMATS.includes(outExt)) {
    throw new Error('不支持的文档输出格式: ' + (outExt || '(无扩展名)'));
  }

  logger.info('[document] 开始转换:', inputPath, '→', outputPath);
  // 创建一次性临时目录作为 LibreOffice 输出目录：
  // 产物文件名由 LibreOffice 决定（输入同名+新扩展名），转到临时目录可避免覆盖用户已有文件
  const tmpDir = file.createTempDir('luren-doc-');
  try {
    // txt 输出必须显式指定 UTF-8 过滤器：LibreOffice 默认按系统 ANSI 编码写 txt，
    // 中文内容会乱码（实测验证）；其他格式用默认过滤器即可
    const convertTo = outExt === 'txt' ? 'txt:Text (encoded):UTF8' : outExt;
    // --convert-to 目标格式；--outdir 指定输出目录；--headless 无界面模式
    // 注意：LibreOffice Portable 的启动器路径在 engines.js 已配置，由 runEngine 统一调用
    await runEngine('libreoffice', ['--headless', '--convert-to', convertTo, '--outdir', tmpDir, inputPath], {
      timeout: LO_TIMEOUT,
    });

    // 定位生成的产物：正常情况是 输入basename + '.' + 目标扩展名
    const baseName = path.basename(inputPath, path.extname(inputPath));
    let generated = path.join(tmpDir, baseName + '.' + outExt);

    // 若文件名不符（个别过滤器命名差异），退回取临时目录中最新生成的文件
    if (!fs.existsSync(generated)) {
      const candidates = fs.readdirSync(tmpDir).map((name) => path.join(tmpDir, name));
      const newest = candidates
        .filter((p) => fs.statSync(p).isFile())
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
      if (newest) generated = newest;
    }

    // 产物不存在 = 转换失败（LibreOffice 退出码常为 0，文件存在性才是可靠信号）
    if (!fs.existsSync(generated)) {
      throw new Error('LibreOffice 未生成输出文件');
    }

    // 确保目标目录存在（输出到新目录时调用方可能未预先创建）
    file.ensureDir(path.dirname(outputPath));
    // 移动到最终路径：同盘 rename 是原子操作，速度远快于复制
    fs.renameSync(generated, outputPath);

    logger.info('[document] 转换完成:', outputPath);
    return outputPath;
  } catch (err) {
    logger.error('[document] 转换失败:', inputPath, '→', outputPath, err);
    throw new Error('文档转换失败: ' + inputPath + ' → ' + outputPath + '（' + err.message + '）');
  } finally {
    // 无论成败都清理临时目录（用户要求 7：不留残留）
    file.cleanupTempDir(tmpDir);
  }
}

/**
 * DOCX → HTML（mammoth 实现，保真排版）
 * 为什么不用 LibreOffice：docx→html 是高频操作，mammoth 纯 JS 毫秒级完成，无需启动重型引擎
 * @param {string} inputPath - .docx 文件路径
 * @returns {Promise<string>} HTML 字符串
 */
async function convertDocxToHtml(inputPath) {
  try {
    const result = await mammoth.convertToHtml({ path: inputPath });
    logger.info('[document] docx→html 完成:', inputPath);
    return result.value;
  } catch (err) {
    logger.error('[document] docx→html 失败:', inputPath, err);
    throw new Error('DOCX 转 HTML 失败: ' + inputPath + '（' + err.message + '）');
  }
}

/**
 * DOCX → 纯文本（mammoth 实现，提取正文）
 * @param {string} inputPath - .docx 文件路径
 * @returns {Promise<string>} 提取的文本
 */
async function convertDocxToText(inputPath) {
  try {
    const result = await mammoth.extractRawText({ path: inputPath });
    logger.info('[document] docx→txt 完成:', inputPath);
    return result.value;
  } catch (err) {
    logger.error('[document] docx→txt 失败:', inputPath, err);
    throw new Error('DOCX 转文本失败: ' + inputPath + '（' + err.message + '）');
  }
}

/**
 * 批量转换（严格串行）
 * 为什么必须串行：LibreOffice 单实例设计，并发启动会争抢配置文件导致失败（用户要求 4/6）
 * @param {string[]} inputPaths - 输入文件路径数组
 * @param {string} outputDir - 输出目录
 * @param {string} targetFormat - 目标格式（如 'pdf'）
 * @param {object} [options] - 传给单个转换的选项
 * @returns {Promise<string[]>} 输出文件路径数组（与输入一一对应）
 */
async function batchConvert(inputPaths, outputDir, targetFormat, options = {}) {
  file.ensureDir(outputDir);
  const outputs = [];
  // for...of + await 天然串行；不能用 Promise.all（LibreOffice 不支持并发）
  for (const inputPath of inputPaths) {
    const outputPath = file.generateOutputPath(inputPath, targetFormat, outputDir);
    // 单个失败不影响其他文件：记录并继续，调用方可根据返回结果判定
    try {
      outputs.push(await convertDocument(inputPath, outputPath, options));
    } catch (err) {
      logger.warn('[document] 批量转换跳过失败项:', inputPath, err.message);
      outputs.push(null); // null 标记失败项，保持与输入顺序对应
    }
  }
  return outputs;
}

/**
 * 获取支持的格式清单
 * @returns {{input: string[], output: string[]}}
 */
function getSupportedFormats() {
  return { input: INPUT_FORMATS.slice(), output: OUTPUT_FORMATS.slice() };
}

/**
 * 判断格式对是否支持
 * @param {string} inputExt
 * @param {string} outputExt
 * @returns {boolean}
 */
function isSupported(inputExt, outputExt) {
  const inExt = String(inputExt || '').toLowerCase();
  const outExt = String(outputExt || '').toLowerCase();
  return INPUT_FORMATS.includes(inExt) && OUTPUT_FORMATS.includes(outExt);
}

module.exports = {
  convertDocument,
  convertDocxToHtml,
  convertDocxToText,
  batchConvert,
  getSupportedFormats,
  isSupported,
};
