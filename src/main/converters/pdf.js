/**
 * ============================================================
 * PDF 处理模块（模块 7）
 * 功能：PDF 信息读取、转图片、文字提取、拆分、合并、加密、解密
 *
 * 技术选型：
 * - 元信息/转图片：poppler（pdfinfo / pdftoppm）— 引擎成熟可靠
 * - 文字提取：pdfjs-dist（与浏览器一致的渲染引擎，中文支持好）
 * - 拆分/合并：pdf-lib（纯 JS，页面级操作）
 * - 加密/解密：自研标准安全处理器（pdf-crypto + pdf-structure）
 *   为什么自研：实测 pdf-lib 1.17.1 的 encrypt 选项为空转、LibreOffice 过滤器被忽略，
 *   因此按 ISO 32000 规范自研并用 pdfjs/poppler/pypdf 三方交叉验证（详见 pdf-crypto.js）
 *
 * 解密限制（如实声明）：仅支持经典 xref 结构的加密 PDF；
 * xref stream 结构会给出明确错误（见 pdf-structure.js）
 * ============================================================
 */

const fs = require('fs');                    // 文件读写
const path = require('path');                // 路径拼接
const { PDFDocument } = require('pdf-lib');  // 页面级操作（拆分/合并/规范化）
const file = require('../utils/file');       // 临时目录、扩展名
const logger = require('../utils/logger');   // 日志
const { runEngine } = require('../utils/process'); // 子进程调用
const { encryptPdfBuffer, decryptPdfBuffer } = require('./pdf-structure'); // 自研加解密

/**
 * 读取 PDF 元信息（pdfinfo 解析）
 * @param {string} inputPath - PDF 文件路径
 * @returns {Promise<object>} { pages, pageSize, encrypted, creator, creationDate, modDate }
 */
async function getPdfInfo(inputPath) {
  // pdfinfo 输出为键值行，按行解析；字段缺失时为 null（如实返回）
  const { stdout } = await runEngine('pdfinfo', [inputPath], { timeout: 60000 });
  const info = { pages: null, pageSize: null, encrypted: null, creator: null, creationDate: null, modDate: null };

  const get = (key) => {
    const line = stdout.split('\n').find((l) => l.startsWith(key + ':'));
    return line ? line.slice(key.length + 1).trim() : null;
  };

  info.pages = get('Pages') ? Number(get('Pages')) : null;
  info.pageSize = get('Page size');
  info.encrypted = get('Encrypted');
  info.creator = get('Creator');
  info.creationDate = get('CreationDate');
  info.modDate = get('ModDate');
  return info;
}

/**
 * PDF → 图片（pdftoppm）
 * @param {string} inputPath - PDF 路径
 * @param {string} outputDir - 输出目录（自动创建）
 * @param {object} [options]
 * @param {'png'|'jpg'|'tiff'} [options.format='png'] - 输出格式
 * @param {number} [options.dpi=150] - 分辨率
 * @param {number} [options.firstPage] - 起始页（1 基）
 * @param {number} [options.lastPage] - 结束页
 * @param {string} [options.prefix='page'] - 输出文件前缀（默认为 'page'，得到 page-1.png）
 * @returns {Promise<string[]>} 生成的图片路径数组
 */
async function pdfToImages(inputPath, outputDir, options = {}) {
  const { format = 'png', dpi = 150, firstPage, lastPage, prefix = 'page' } = options;
  file.ensureDir(outputDir);

  // pdftoppm 参数：格式标志 -png/-jpeg/-tiff，-r 分辨率，-f/-l 页范围
  const fmtFlag = format === 'jpg' ? '-jpeg' : format === 'tiff' ? '-tiff' : '-png';
  const args = [fmtFlag, '-r', String(dpi)];
  if (firstPage) args.push('-f', String(firstPage));
  if (lastPage) args.push('-l', String(lastPage));

  // 输出前缀：pdftoppm 生成 prefix-1.png（页号从 1 开始）；前缀可自定义以匹配输出命名
  const prefixPath = path.join(outputDir, prefix);
  args.push(inputPath, prefixPath);
  await runEngine('pdftoppm', args, { timeout: 300000 });

  // 收集产物：prefix-<页码>.<ext>（pagemark 按文件系统实际生成收集，避免假设）
  const ext = format === 'jpg' ? 'jpg' : format;
  // 正则字面量无法拼接变量，必须用 new RegExp（此前写法导致匹配不到文件）
  const nameRe = new RegExp('^' + prefix + '-\\d+\\.' + ext + '$');
  const files = fs.readdirSync(outputDir)
    .filter((name) => nameRe.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    .map((name) => path.join(outputDir, name));

  if (files.length === 0) {
    throw new Error('PDF 转图片失败：未生成任何图片（可能文件损坏或页数为 0）');
  }
  return files;
}

/**
 * 提取 PDF 文字（pdfjs-dist legacy 构建）
 * @param {string} inputPath - PDF 路径
 * @returns {Promise<string>} 全部页面文字（页间换行分隔）
 */
async function extractText(inputPath) {
  // pdfjs v5 是 ESM，Node 环境用动态 import；legacy 构建兼容 Node
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let doc = null;
  try {
    // 读取放在 try 内：文件不存在等错误统一包装成带上下文的错误（而非裸 ENOENT）
    const data = new Uint8Array(fs.readFileSync(inputPath));
    // Node 下 pdfjs 自动使用 fake worker（已验证无需显式 workerSrc）
    doc = await pdfjsLib.getDocument({ data }).promise;
    let text = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map((item) => item.str || '').join(' ') + '\n';
    }
    return text;
  } catch (err) {
    // 加密 PDF 提取会失败：给出友好提示（先解密再提取）
    logger.error('[pdf] 提取文字失败:', inputPath, err);
    throw new Error('PDF 文字提取失败: ' + inputPath + '（' + err.message + '）');
  } finally {
    if (doc) await doc.destroy().catch(() => {});
  }
}

/**
 * 拆分 PDF（pdf-lib 页面复制）
 * @param {string} inputPath - PDF 路径
 * @param {string} outputDir - 输出目录
 * @param {object} [options]
 * @param {'perPage'|'range'} [options.mode='perPage'] - 每页一个 / 按范围
 * @param {number[][]} [options.ranges] - 范围列表，如 [[1,3],[4,5]]（1 基闭区间）
 * @returns {Promise<string[]>} 拆分后的文件路径
 */
async function splitPdf(inputPath, outputDir, options = {}) {
  const { mode = 'perPage', ranges = [] } = options;
  file.ensureDir(outputDir);
  const base = path.basename(inputPath, path.extname(inputPath));

  const src = await PDFDocument.load(fs.readFileSync(inputPath));
  const total = src.getPageCount();
  const outputs = [];

  // 确定拆分方案：perPage 每页一组；range 按传入范围（1 基 → 0 基）
  const plans = [];
  if (mode === 'perPage') {
    for (let i = 0; i < total; i++) plans.push({ pages: [i], label: 'page-' + (i + 1) });
  } else {
    ranges.forEach(([s, e], idx) => {
      // 边界校验：越界页范围直接跳过（容错而非崩溃）
      const start = Math.max(0, (s || 1) - 1);
      const end = Math.min(total - 1, (e || s || 1) - 1);
      if (start <= end) plans.push({ pages: Array.from({ length: end - start + 1 }, (_, i) => start + i), label: 'part-' + (idx + 1) });
    });
  }
  if (plans.length === 0) throw new Error('拆分范围无效');

  for (const plan of plans) {
    const outDoc = await PDFDocument.create();
    const copied = await outDoc.copyPages(src, plan.pages);
    copied.forEach((p) => outDoc.addPage(p));
    const outPath = path.join(outputDir, base + '-' + plan.label + '.pdf');
    fs.writeFileSync(outPath, await outDoc.save());
    outputs.push(outPath);
  }
  logger.info('[pdf] 拆分完成:', inputPath, '→', outputs.length, '个文件');
  return outputs;
}

/**
 * 合并多个 PDF
 * @param {string[]} inputPaths - PDF 路径数组（按此顺序合并）
 * @param {string} outputPath - 输出路径
 * @returns {Promise<string>} 输出路径
 */
async function mergePdfs(inputPaths, outputPath) {
  if (!inputPaths || inputPaths.length === 0) throw new Error('合并至少需要一个 PDF');
  file.ensureDir(path.dirname(outputPath));

  const outDoc = await PDFDocument.create();
  for (const inputPath of inputPaths) {
    // 逐个加载复制：避免一次性加载全部文档占满内存（大文件场景）
    const src = await PDFDocument.load(fs.readFileSync(inputPath));
    const pages = await outDoc.copyPages(src, src.getPageIndices());
    pages.forEach((p) => outDoc.addPage(p));
  }
  fs.writeFileSync(outputPath, await outDoc.save());
  logger.info('[pdf] 合并完成:', inputPaths.length, '个 →', outputPath);
  return outputPath;
}

/**
 * 加密 PDF（R4 AES-128，标准安全处理器）
 * @param {string} inputPath - 输入 PDF（须未加密）
 * @param {string} outputPath - 输出路径
 * @param {string} password - 用户/所有者密码
 * @returns {Promise<string>}
 */
async function encryptPdf(inputPath, outputPath, password) {
  if (!password) throw new Error('加密密码不能为空');
  // 先用 pdf-lib 加载并规范化（useObjectStreams:false 输出经典结构），
  // 再交给自研加密器处理——任意结构的输入 PDF 都能统一加密
  let plainBytes;
  try {
    const src = await PDFDocument.load(fs.readFileSync(inputPath));
    plainBytes = await src.save({ useObjectStreams: false });
  } catch (err) {
    // pdf-lib 打不开的（如已加密）给出明确提示
    throw new Error('加密失败：无法解析输入 PDF（' + err.message + '）');
  }
  fs.writeFileSync(outputPath, encryptPdfBuffer(Buffer.from(plainBytes), password));
  logger.info('[pdf] 加密完成:', outputPath);
  return outputPath;
}

/**
 * 解密 PDF
 * @param {string} inputPath - 加密 PDF
 * @param {string} outputPath - 输出路径
 * @param {string} password - 用户密码（或所有者密码）
 * @returns {Promise<string>}
 */
async function decryptPdf(inputPath, outputPath, password) {
  if (!password) throw new Error('解密密码不能为空');
  const decrypted = decryptPdfBuffer(fs.readFileSync(inputPath), password);
  fs.writeFileSync(outputPath, decrypted);
  logger.info('[pdf] 解密完成:', outputPath);
  return outputPath;
}

/**
 * PDF → 文本文件
 * @param {string} inputPath - PDF 路径
 * @param {string} outputPath - 输出 txt 路径
 * @returns {Promise<string>}
 */
async function pdfToTextFile(inputPath, outputPath) {
  const text = await extractText(inputPath);
  file.ensureDir(path.dirname(outputPath));
  fs.writeFileSync(outputPath, text, 'utf8');
  return outputPath;
}

module.exports = {
  getPdfInfo,
  pdfToImages,
  extractText,
  splitPdf,
  mergePdfs,
  encryptPdf,
  decryptPdf,
  pdfToTextFile,
};
