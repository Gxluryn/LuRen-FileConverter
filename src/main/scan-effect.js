/**
 * ============================================================
 * 扫描件模拟模块（模块 9）
 * 功能：电子文档 → 带真实扫描质感的 PDF
 * 效果：随机倾斜、高斯模糊、噪点、纸张色温、边缘暗角、JPEG 压缩
 *
 * 为什么用 Sharp 逐层叠加：
 * - rotate：每页随机角度（0.3°~1.2°），模拟手工放纸不正
 * - blur：消除矢量文字的锐利边缘，接近扫描仪光学模糊
 * - modulate/tint：纸张偏黄偏暗，替代纯白背景
 * - noise overlay：模拟传感器底噪
 * - vignette overlay：模拟扫描仪边缘光线衰减
 *
 * 性能说明：噪点/暗角在低分辨率生成后由 sharp 放大（锐利纹理不受影响，
 * 渐变本身平滑），避免大图逐像素循环拖慢转换（用户要求 4）
 * ============================================================
 */

const fs = require('fs');                    // 文件读写
const path = require('path');                // 路径拼接
const crypto = require('crypto');            // randomBytes：快速生成噪点数据
const sharp = require('sharp');              // 图像处理
const { PDFDocument } = require('pdf-lib');  // 合成图片型 PDF
const file = require('./utils/file');        // 临时目录（本文件位于 src/main/ 下）
const logger = require('./utils/logger');    // 日志（与 file 同级，均在 src/main/utils/）
const pdfMod = require('./converters/pdf');      // PDF 转图片
const docMod = require('./converters/document'); // 非 PDF 先转 PDF

/** 预设：不同「扫描旧化」程度的参数组合 */
const EFFECT_PRESETS = {
  // 轻度：只是去锐化 + 轻微噪点，接近新复印机效果
  light: { rotation: 0.4, blur: 0.2, noise: 0.04, brightness: 0.96, vignette: 0.08, jpegQuality: 80 },
  // 标准：推荐默认，模拟普通办公扫描仪
  normal: { rotation: 0.8, blur: 0.4, noise: 0.08, brightness: 0.92, vignette: 0.15, jpegQuality: 70 },
  // 重度：老式扫描仪，明显噪点与暗角
  heavy: { rotation: 1.1, blur: 0.6, noise: 0.14, brightness: 0.86, vignette: 0.25, jpegQuality: 60 },
  // 老照片：泛黄 + 更重暗角
  oldPhoto: { rotation: 1.2, blur: 0.5, noise: 0.12, brightness: 0.80, tint: '#c8b89a', vignette: 0.3, jpegQuality: 65 },
};

/**
 * 生成噪点图层（RGBA PNG Buffer）
 * 性能优化：缩小到最大边 1024 后由 sharp 放大，避免大图逐像素循环
 * @param {number} width - 目标宽度
 * @param {number} height - 目标高度
 * @param {number} intensity - 噪点强度（0-1）
 * @returns {Promise<Buffer>} PNG 缓冲
 */
async function generateNoise(width, height, intensity) {
  // 缩放尺寸：最长边 1024，噪点纹理缩放后视觉上仍是随机颗粒
  const scale = Math.min(1, 1024 / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  // randomBytes 原生生成随机数据（比逐像素 Math.random 快一个数量级）
  const raw = crypto.randomBytes(w * h * 4);
  const data = Buffer.from(raw); // 就地变换
  // 以 128 为灰心，按强度缩放偏离量；alpha 全 255（overlay 混合用灰度）
  const deviation = intensity * 255;
  for (let i = 0; i < raw.length; i += 4) {
    data[i] = Math.max(0, Math.min(255, 128 + (raw[i] - 128) * 2 * deviation));
    data[i + 1] = data[i];
    data[i + 2] = data[i];
    data[i + 3] = 255;
  }
  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

/**
 * 生成暗角图层（径向渐变 RGBA PNG Buffer）
 * 中心透明、边缘黑色半透明，alpha 随距中心距离平方衰减（符合镜头渐晕特性）
 * 性能优化：同样缩到最长边 1024 再放大
 * @param {number} width - 目标宽度
 * @param {number} height - 目标高度
 * @param {number} intensity - 暗角强度（0-1）
 * @returns {Promise<Buffer>} PNG 缓冲
 */
async function generateVignette(width, height, intensity) {
  const scale = Math.min(1, 1024 / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const data = Buffer.alloc(w * h * 4);
  const cx = w / 2;
  const cy = h / 2;
  // 归一化半径：以对角线一半为 1（正方形对角距离）
  const maxDist = Math.sqrt(cx * cx + cy * cy);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / maxDist;
      const dy = (y - cy) / maxDist;
      const dist2 = dx * dx + dy * dy; // 距离平方
      const idx = (y * w + x) * 4;
      // 边缘 alpha 随 dist2 增长；强度控制整体不透明度
      const alpha = Math.min(255, Math.round(dist2 * 255 * intensity));
      data[idx] = 0;      // 黑
      data[idx + 1] = 0;
      data[idx + 2] = 0;
      data[idx + 3] = alpha;
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

/** 随机旋转角度：0.3°~options.rotation 度，方向随机（每页不同） */
function randomAngle(maxDeg) {
  const mag = 0.3 + Math.random() * Math.max(0, maxDeg - 0.3);
  return Math.random() < 0.5 ? mag : -mag;
}

/**
 * 对单张图片应用扫描效果
 * @param {string} imagePath - 输入图片
 * @param {string} outputPath - 输出 JPEG 路径
 * @param {object} [options]
 * @param {number} [options.rotation] - 倾斜角度上限（不指定则每页随机）
 * @param {number} [options.blur=0.4] - 高斯模糊 sigma
 * @param {number} [options.noise=0.08] - 噪点强度
 * @param {number} [options.brightness=0.92] - 亮度
 * @param {string} [options.tint='#f5f0e6'] - 纸张色
 * @param {number} [options.vignette=0.15] - 暗角强度
 * @param {number} [options.jpegQuality=70] - 输出 JPEG 质量
 * @returns {Promise<string>} 输出路径
 */
async function applyScanEffect(imagePath, outputPath, options = {}) {
  const {
    rotation, blur = 0.4, noise = 0.08, brightness = 0.92,
    tint = '#f5f0e6', vignette = 0.15, jpegQuality = 70,
  } = options;

  const angle = rotation !== undefined ? rotation : randomAngle(1.2);

  // 第一步：渲染「旋转（纸色背景）→ 模糊 → 亮度 → 色偏」到内存缓冲
  // 为什么分两步：旋转后的画布尺寸由 sharp 决定（自算 bounding box 会有 ±1px 偏差），
  // 从渲染结果读真实尺寸，保证噪点/暗角图层与底图严格一致（composite 要求叠加层不大于底图）
  const base = await sharp(imagePath)
    .rotate(angle, { background: tint })
    .blur(blur)
    .modulate({ brightness })
    .tint(tint)
    .toBuffer();
  const baseMeta = await sharp(base).metadata();

  // 第二步：按真实尺寸生成并缩放噪点/暗角图层（低分辨率生成省内存，sharp 原生缩放）
  const [noiseSmall, vignetteSmall] = await Promise.all([
    generateNoise(baseMeta.width, baseMeta.height, noise),
    generateVignette(baseMeta.width, baseMeta.height, vignette),
  ]);
  const [noiseLayer, vignetteLayer] = await Promise.all([
    sharp(noiseSmall).resize(baseMeta.width, baseMeta.height).toBuffer(),
    sharp(vignetteSmall).resize(baseMeta.width, baseMeta.height).toBuffer(),
  ]);

  // 第三步：叠加噪点/暗角 → JPEG 输出
  // 叠加顺序必须噪声先、暗角后，暗角压在最上层才有效果
  await sharp(base)
    .composite([
      { input: noiseLayer, blend: 'overlay' },
      { input: vignetteLayer, blend: 'multiply' },
    ])
    .jpeg({ quality: jpegQuality })
    .toFile(outputPath);

  return outputPath;
}

/**
 * 电子文档 → 扫描件 PDF（完整流程）
 * 非 PDF 输入先转 PDF，再逐页转图片 → 扫描效果 → 合成图片型 PDF
 * @param {string} inputPath - 文档/图片/PDF 路径
 * @param {string} outputPath - 输出 PDF 路径
 * @param {object} [options] - applyScanEffect 参数 + dpi
 * @returns {Promise<string>} 输出路径
 */
async function convertToScannedPdf(inputPath, outputPath, options = {}) {
  const { dpi = 200, ...rawOptions } = options;
  // 支持 preset 预设：预览选择的效果参数直接应用到正式转换（预览即所得）
  let effectOptions = rawOptions;
  if (rawOptions.preset) {
    const presets = getEffectPresets();
    const presetParams = presets[rawOptions.preset];
    if (presetParams) effectOptions = { ...presetParams, ...rawOptions };
  }
  const tmpDir = file.createTempDir('luren-scan-');
  try {
    // 1) 非 PDF → 临时 PDF（LibreOffice 转换）
    let pdfPath = inputPath;
    if (file.getFileExtension(inputPath) !== 'pdf') {
      pdfPath = path.join(tmpDir, 'input.pdf');
      await docMod.convertDocument(inputPath, pdfPath);
    }

    // 2) 每页转 PNG（200 DPI，匹配办公扫描仪分辨率）
    const imgDir = path.join(tmpDir, 'pages');
    const images = await pdfMod.pdfToImages(pdfPath, imgDir, { format: 'png', dpi });

    // 3) 每页应用扫描效果（rotation 不指定 → 每页角度随机，效果各不相同）
    const outDoc = await PDFDocument.create();
    for (let i = 0; i < images.length; i++) {
      const effImg = path.join(tmpDir, 'eff-' + (i + 1) + '.jpg');
      await applyScanEffect(images[i], effImg, effectOptions);
      // 4) 嵌入图片型 PDF（JPEG 嵌入天然就是「纯图片 PDF」）
      const jpg = fs.readFileSync(effImg);
      const img = await outDoc.embedJpg(jpg);
      const page = outDoc.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }

    file.ensureDir(path.dirname(outputPath));
    fs.writeFileSync(outputPath, await outDoc.save());
    logger.info('[scan] 扫描件生成完成:', outputPath, '(' + images.length + ' 页)');
    return outputPath;
  } catch (err) {
    logger.error('[scan] 扫描件生成失败:', inputPath, err);
    throw new Error('扫描件生成失败: ' + inputPath + '（' + err.message + '）');
  } finally {
    file.cleanupTempDir(tmpDir);
  }
}

/** 获取效果预设（新增效果只需在这里加一组参数，无需改主流程） */
function getEffectPresets() {
  // 返回深拷贝，防止调用方意外修改内置预设
  return JSON.parse(JSON.stringify(EFFECT_PRESETS));
}

module.exports = { applyScanEffect, convertToScannedPdf, getEffectPresets, generateNoise, generateVignette };
