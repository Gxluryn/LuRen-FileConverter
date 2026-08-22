/**
 * ============================================================
 * 图片转换器（模块 4）
 * 功能：图片格式互转，覆盖 jpg/png/webp/gif/bmp/tiff/heic/ico/svg
 *
 * 为什么用 Sharp 为主、FFmpeg 为辅？
 * - Sharp（libvips）速度快、内存占用低，是主流格式的主力
 * - 实测发现：本机 sharp 0.35.3 不支持 bmp/ico 输出、不支持 bmp 输入
 *   → bmp 输入输出改走 FFmpeg（项目必需引擎），ico 输出用 PNG 容器封装（格式规范简单可靠）
 *   → heic 输出用 sharp 的 av1 编码；heic 输入先试 sharp，失败降级 heic-convert
 * - 支持清单通过运行时探测得出并缓存，对外声明与真实能力一致（用户要求 1：不虚假宣传）
 *
 * 结构：
 * - convertImage：编排入口（输入适配 → 按目标格式分派）
 * - prepareInput：把 sharp 读不了的格式（bmp/ico/heic）转成 PNG 临时文件
 * - 各格式专用小函数：职责单一、每个都短，方便单测
 * ============================================================
 */

const fs = require('fs');                    // 临时文件读写
const path = require('path');                // 路径拼接
const sharp = require('sharp');              // 高性能图像处理
const file = require('../utils/file');       // 文件工具：临时目录、扩展名
const logger = require('../utils/logger');   // 日志
const { getEngine } = require('../engines'); // 引擎路径（bmp 走 ffmpeg 时需要）
const { runEngine } = require('../utils/process'); // 子进程调用

// 支持的输入格式（bmp/ico/heic 经 prepareInput 适配后同样可读）
const INPUT_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'heic', 'ico', 'svg'];

// 输出扩展名 → sharp 原生格式名（仅 sharp 直接支持的；bmp/ico/heic 单独处理）
const SHARP_NATIVE_OUT = {
  jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp', gif: 'gif', tiff: 'tiff',
};

// heic 走 sharp heif 输出，需要显式 compression（实测本机 hevc 不可用、av1 可用）
const HEIC_COMPRESSION = 'av1';

/**
 * 探测 sharp 实际支持的输出能力（模块加载后执行一次并缓存）
 * 为什么实测而不是查文档：sharp 预编译包因编译选项不同能力差异大，
 * 只有真实编码一次才能保证声明 = 能力
 * @returns {Promise<Set<string>>} 实际可输出的扩展名集合
 */
async function probeSharpOutput() {
  const supported = new Set(['ico']); // ico 由自家容器封装实现，必然支持
  // 1x1 样本探测，内存开销可忽略
  const sample = await sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();

  // sharp 原生格式逐个实测；jpeg 与 jpg 同一种格式，只测一次避免清单重复
  for (const [ext, fmt] of Object.entries(SHARP_NATIVE_OUT)) {
    if (ext === 'jpeg') continue; // 与 jpg 等价，不再重复探测
    try {
      await sharp(sample).toFormat(fmt).toBuffer();
      supported.add(ext);
    } catch { /* 该格式不可用，跳过 */ }
  }
  // heic：av1 压缩实测
  try {
    await sharp(sample).toFormat('heic', { compression: HEIC_COMPRESSION }).toBuffer();
    supported.add('heic');
  } catch { /* 无 libheif，heic 输出不可用 */ }

  // bmp：走 ffmpeg，仅当引擎就位才声明支持
  try {
    getEngine('ffmpeg');
    supported.add('bmp');
  } catch { /* ffmpeg 缺失，bmp 转换不可用 */ }

  return supported;
}

// 缓存探测结果：Promise 只创建一次，避免每次调用都重新探测（性能要求）
let supportedPromise = null;
function getSharpSupported() {
  if (!supportedPromise) {
    supportedPromise = probeSharpOutput().catch(() => new Set(['jpg', 'png', 'webp', 'gif', 'tiff']));
  }
  return supportedPromise;
}

/**
 * 用 FFmpeg 把任意图片解码为 PNG 文件
 * 用途：bmp 输入、ico 内嵌 BMP 条目（sharp 读不了这些）
 * @param {string} inputPath - 输入图片
 * @param {string} outputPngPath - 输出 PNG 路径
 * @returns {Promise<void>}
 */
async function decodeViaFfmpeg(inputPath, outputPngPath) {
  // -y 覆盖输出，-frames:v 1 只取第一帧（静态图场景），输出 PNG 由扩展名推断
  await runEngine('ffmpeg', ['-y', '-i', inputPath, '-frames:v', '1', outputPngPath], { timeout: 120000 });
}

/**
 * 把 DIB（无文件头的位图数据，常见于老式 ICO 内嵌条目）包装成完整 BMP 文件
 * 只支持 24/32 位未压缩（BI_RGB）：这是 BMP-in-ICO 的绝大多数情况；
 * 其他（调色板/RLE）如实报错，不假装支持（用户要求 1）
 * @param {Buffer} dib - 内嵌位图数据
 * @returns {Buffer} 完整 BMP 文件缓冲
 */
function wrapDibToBmp(dib) {
  // BITMAPINFOHEADER：前 4 字节是 biSize（通常 40）
  const biSize = dib.readUInt32LE(0);
  if (biSize < 40) throw new Error('不支持的 ICO 内嵌位图（非 BITMAPINFOHEADER）');
  const width = dib.readInt32LE(4);
  const heightRaw = dib.readInt32LE(8);
  const bpp = dib.readUInt16LE(14);
  const compression = dib.readUInt32LE(16);
  if (compression !== 0) throw new Error('不支持的 ICO 内嵌位图（压缩位图）');
  if (bpp !== 24 && bpp !== 32) throw new Error('不支持的 ICO 内嵌位图（仅支持 24/32 位）');
  // height 含 XOR/AND 掩码两段（高位为掩码），取绝对值前半段为实际高度
  const height = heightRaw < 0 ? -heightRaw : heightRaw / 2;

  // 计算像素区偏移与文件大小：14 字节文件头 + 40 字节信息头 + 对齐后的像素数据
  const pixelOffset = 14 + biSize;
  const rowSize = Math.ceil((width * bpp / 8) / 4) * 4;
  const fileSize = pixelOffset + rowSize * height;

  const bmp = Buffer.alloc(fileSize);
  bmp.write('BM', 0, 'ascii');                 // 文件类型标识
  bmp.writeUInt32LE(fileSize, 2);              // 文件大小
  bmp.writeUInt32LE(pixelOffset, 10);          // 像素数据偏移
  dib.copy(bmp, 14, 0, biSize);                // 复制信息头
  // 像素数据复制（BMP 文件要求按行 4 字节对齐；DIB 内嵌数据通常已对齐，直接复制像素区）
  const srcPixelStart = biSize;
  const pixelsLen = Math.min(dib.length - srcPixelStart, fileSize - pixelOffset);
  dib.copy(bmp, pixelOffset, srcPixelStart, srcPixelStart + pixelsLen);
  return bmp;
}

/**
 * 解析 ICO 容器，取出图像数据（优先取最大的 PNG 条目；无 PNG 则取首个 BMP 条目）
 * @param {Buffer} icoBuffer - ICO 文件内容
 * @returns {{data: Buffer, isPng: boolean}}
 */
function extractIcoImage(icoBuffer) {
  // ICONDIR 结构：2 字节保留 + 2 字节类型 + 2 字节数量（小端）
  const count = icoBuffer.readUInt16LE(4);
  if (count === 0) throw new Error('ICO 文件不包含图像条目');

  // 遍历所有条目（每条 16 字节，从偏移 6 开始），找字节数最大的 PNG 条目（质量最好）
  let best = null;
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    const size = icoBuffer.readUInt32LE(entry + 8);
    const offset = icoBuffer.readUInt32LE(entry + 12);
    const data = icoBuffer.subarray(offset, offset + size);
    // PNG 魔数 89 50 4E 47
    const isPng = data.length > 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
    if (isPng && (!best || size > best.size)) {
      best = { data, isPng, size };
    }
    if (!best && !isPng) {
      best = { data, isPng, size }; // 首个非 PNG 条目作为 BMP 兜底
    }
  }
  if (!best) throw new Error('ICO 文件图像数据损坏');
  return { data: best.data, isPng: best.isPng };
}

/**
 * 输入适配：把 sharp 无法直接读取的输入格式转成 PNG 临时文件
 * 返回 { workInput, cleanup }；cleanup 必须由调用方在 finally 中执行
 * @param {string} inputPath
 * @returns {Promise<{workInput: string, cleanup: Function}>}
 */
async function prepareInput(inputPath) {
  const ext = file.getFileExtension(inputPath);
  // 非特殊格式：sharp 原生可读，直接用原文件，无需临时目录
  if (!['bmp', 'ico', 'heic'].includes(ext)) {
    return { workInput: inputPath, cleanup: () => {} };
  }

  // heic：优先尝试 sharp 原生解码（快、零中间文件），成功直接返回原文件
  if (ext === 'heic') {
    try {
      await sharp(inputPath).metadata();
      return { workInput: inputPath, cleanup: () => {} };
    } catch {
      // sharp 无 libheif → 落入下方 heic-convert 降级分支（此时才创建临时目录）
    }
  }

  // 其余情况（bmp / ico / heic 降级）需要中间文件：
  // 临时目录按需创建并随返回值带出 cleanup，由调用方 finally 统一清理
  const tmpDir = file.createTempDir('luren-img-');
  const cleanup = () => file.cleanupTempDir(tmpDir);

  try {
    if (ext === 'bmp') {
      // sharp 读不了 bmp → ffmpeg 解码为 PNG
      const png = path.join(tmpDir, 'input.png');
      await decodeViaFfmpeg(inputPath, png);
      return { workInput: png, cleanup };
    }

    if (ext === 'ico') {
      const ico = extractIcoImage(fs.readFileSync(inputPath));
      if (ico.isPng) {
        // PNG 条目：直接落盘为临时 PNG（零重编码，无损且快）
        const png = path.join(tmpDir, 'input.png');
        fs.writeFileSync(png, ico.data);
        return { workInput: png, cleanup };
      }
      // BMP 条目：DIB 包装成 BMP 后由 ffmpeg 解码
      const bmpFile = path.join(tmpDir, 'input.bmp');
      fs.writeFileSync(bmpFile, wrapDibToBmp(ico.data));
      const png = path.join(tmpDir, 'input.png');
      await decodeViaFfmpeg(bmpFile, png);
      return { workInput: png, cleanup };
    }

    // heic 降级：用 heic-convert（内置 wasm 解码器）转 PNG
    // 延迟加载 require：仅此路径用到，避免拖慢模块启动
    const convert = require('heic-convert');
    const outBuffer = await convert({ buffer: fs.readFileSync(inputPath), format: 'PNG' });
    const png = path.join(tmpDir, 'input.png');
    fs.writeFileSync(png, outBuffer);
    return { workInput: png, cleanup };
  } catch (err) {
    // 适配失败也要清理临时目录，避免残留（用户要求 7：不留垃圾文件）
    cleanup();
    throw err;
  }
}

/**
 * 构建 sharp 处理链：旋转（尊重 EXIF）+ 可选缩放
 * 为什么单独抽函数：bmp/ico 两条输出路径都要复用同一段缩放逻辑，避免复制粘贴
 * @param {string} inputPath
 * @param {{width?: number, height?: number, fit?: string}} options
 * @returns {sharp.Sharp}
 */
function buildPipeline(inputPath, options) {
  const { width, height, fit = 'inside' } = options;
  let pipeline = sharp(inputPath).rotate();
  // 仅指定尺寸才缩放；未指定保持原尺寸，避免无谓重采样损失画质
  if (width || height) {
    pipeline = pipeline.resize({ width, height, fit, withoutEnlargement: true });
  }
  return pipeline;
}

/**
 * 输出到 BMP：sharp 渲染 → PNG 临时文件 → ffmpeg 编码 BMP
 * 为什么绕一道：sharp 不支持 BMP 输出，ffmpeg 的 BMP 编码成熟稳定
 * @returns {Promise<string>} outputPath
 */
async function outputBmp(pipeline, outputPath, tmpDir) {
  const tempPng = path.join(tmpDir, 'render.png');
  await pipeline.png().toFile(tempPng);
  await runEngine('ffmpeg', ['-y', '-i', tempPng, outputPath], { timeout: 120000 });
  // ffmpeg 退出码为 0 不代表一定产出了文件，显式校验避免下游拿到空路径
  if (!fs.existsSync(outputPath)) {
    throw new Error('FFmpeg 未生成 BMP 文件');
  }
  return outputPath;
}

/**
 * 输出到 ICO：sharp 渲染 PNG → 封装进 ICO 容器（Vista+ 标准，PNG 条目）
 * ICO 规范：图标边长上限 256（超限值用 0 表示），封装前强制缩放
 * @returns {Promise<string>} outputPath
 */
/**
 * 从 PNG 缓冲解析宽高（PNG 固定头：8 字节签名 + IHDR 块，宽高在第 16-23 字节，大端序）
 * 为什么不信任 metadata()：sharp 的 metadata() 返回输入尺寸，管线上的缩放不体现在里面，
 * 从最终缓冲解析才是输出文件的真实尺寸（用户要求 1：以实际为准）
 * @param {Buffer} pngBuf
 * @returns {{width: number, height: number}}
 */
function parsePngSize(pngBuf) {
  if (pngBuf.length < 24) throw new Error('PNG 数据不完整');
  return { width: pngBuf.readUInt32BE(16), height: pngBuf.readUInt32BE(20) };
}

async function outputIco(pipeline, outputPath) {
  let png = await pipeline.png().toBuffer();
  // ICO 硬性规范：图标边长不得超过 256。解析最终缓冲的实际尺寸判断
  let size = parsePngSize(png);
  if (size.width > 256 || size.height > 256) {
    // 超限时以缓冲为源重建管线二次缩放（原管线已消费，且能保证缩放基于已渲染结果）
    png = await sharp(png).resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    size = parsePngSize(png);
  }

  // ICONDIR(6 字节) + ICONDIRENTRY(16 字节) + PNG 数据
  const ico = Buffer.alloc(22 + png.length);
  ico.writeUInt16LE(0, 0);       // 保留字段
  ico.writeUInt16LE(1, 2);       // 类型：1 = 图标
  ico.writeUInt16LE(1, 4);       // 图像数量：1
  // 宽高字节：ICO 规范规定 0 表示 256，因此 ≥256 时写 0，其余写实际值
  const sizeByte = (v) => (v >= 256 ? 0 : v);
  ico.writeUInt8(sizeByte(size.width), 6);
  ico.writeUInt8(sizeByte(size.height), 7);
  ico.writeUInt8(0, 8);          // 调色板数（PNG 条目为 0）
  ico.writeUInt8(0, 9);          // 保留
  ico.writeUInt16LE(1, 10);      // 颜色平面数
  ico.writeUInt16LE(32, 12);     // 每像素位数（PNG 条目约定 32）
  ico.writeUInt32LE(png.length, 14); // 图像数据字节数
  ico.writeUInt32LE(22, 18);     // 图像数据偏移
  png.copy(ico, 22);
  fs.writeFileSync(outputPath, ico);
  return outputPath;
}

/**
 * 图片格式转换（主入口）
 * @param {string} inputPath - 输入图片路径
 * @param {string} outputPath - 输出路径（扩展名决定目标格式）
 * @param {object} [options]
 * @param {number} [options.quality=90] - 有损格式质量
 * @param {number} [options.width] - 目标宽度（可选）
 * @param {number} [options.height] - 目标高度（可选）
 * @param {string} [options.fit='inside'] - 缩放模式
 * @returns {Promise<string>} 输出文件路径
 */
async function convertImage(inputPath, outputPath, options = {}) {
  const outExt = file.getFileExtension(outputPath);
  const supported = await getSharpSupported();

  // 前置校验：扩展名不在支持清单内则提前报错，避免走到一半才失败
  if (!supported.has(outExt)) {
    throw new Error('不支持的图片输出格式: ' + (outExt || '(无扩展名)'));
  }

  logger.info('[image] 开始转换:', inputPath, '→', outputPath);
  // 输入适配（bmp/ico/heic 需要转 PNG）；tmpDir 在需要时创建，否则为 null
  // cleanup 用 let：bmp 输出时还要追加一个临时目录的清理，需要重新赋值
  const prepared = await prepareInput(inputPath);
  const workInput = prepared.workInput;
  let cleanup = prepared.cleanup;
  let tmpDir = null;
  if (workInput !== inputPath) tmpDir = path.dirname(workInput);
  // bmp 输出走 ffmpeg，需要临时 PNG 中转：即使输入无需适配也创建专用临时目录
  // 与输入适配的清理合并成一次 cleanup，保证 finally 全部清理干净
  if (outExt === 'bmp') {
    const bmpTmp = file.createTempDir('luren-bmp-');
    const prevCleanup = cleanup;
    tmpDir = tmpDir || bmpTmp;
    cleanup = () => { prevCleanup(); file.cleanupTempDir(bmpTmp); };
  }

  try {
    const pipeline = buildPipeline(workInput, options);

    // 分派：bmp/ico 有专属输出路径，其余走 sharp 原生编码
    if (outExt === 'bmp') {
      await outputBmp(pipeline, outputPath, tmpDir);
    } else if (outExt === 'ico') {
      await outputIco(pipeline, outputPath);
    } else {
      const formatOptions = { quality: options.quality ?? 90 };
      // GIF 输出保留多帧动画（animated:true 对动图输入生效）
      if (outExt === 'gif') formatOptions.animated = true;
      // heic 必须显式指定压缩算法（实测本机仅 av1 可用）
      if (outExt === 'heic') formatOptions.compression = HEIC_COMPRESSION;
      await pipeline.toFormat(SHARP_NATIVE_OUT[outExt] || 'heic', formatOptions).toFile(outputPath);
    }

    logger.info('[image] 转换完成:', outputPath);
    return outputPath;
  } catch (err) {
    // 错误带上下文（输入/输出路径），sharp/ffmpeg 原生错误信息通常不含文件名，不便排查
    logger.error('[image] 转换失败:', inputPath, '→', outputPath, err);
    throw new Error('图片转换失败: ' + inputPath + ' → ' + outputPath + '（' + err.message + '）');
  } finally {
    // 无论成败都清理临时目录（用户要求 7：不留残留；要求 16：finally 语义）
    cleanup();
  }
}

/**
 * 获取实际支持的格式清单（动态探测，声明与能力一致）
 * @returns {Promise<{input: string[], output: string[]}>}
 */
async function getSupportedFormats() {
  const sharpSupported = await getSharpSupported();
  return { input: INPUT_FORMATS.slice(), output: Array.from(sharpSupported).sort() };
}

/**
 * 判断格式对是否支持（jpeg 视为 jpg）
 * @param {string} inputExt
 * @param {string} outputExt
 * @returns {boolean}
 */
function isSupported(inputExt, outputExt) {
  const inExt = String(inputExt || '').toLowerCase();
  const outExt = String(outputExt || '').toLowerCase();
  const norm = (e) => (e === 'jpeg' ? 'jpg' : e);
  return INPUT_FORMATS.includes(inExt) && ['jpg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'heic', 'ico'].includes(norm(outExt));
}

module.exports = { convertImage, getSupportedFormats, isSupported, INPUT_FORMATS };
