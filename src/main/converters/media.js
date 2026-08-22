/**
 * ============================================================
 * 音视频转换器（模块 5）
 * 功能：基于 FFmpeg 的音视频格式互转 + 媒体信息探测
 *
 * 为什么用 FFmpeg：音视频编解码是 FFmpeg 的看家本领，格式覆盖广、编码参数成熟，
 * 自己实现任何格式都会是灾难——这里只做「参数编排」而非「编解码」
 *
 * 设计要点：
 * - 全部调用走 utils/process.js 的 runEngine（统一超时/杀进程/中文路径处理）
 * - 音频输出加 -vn（丢弃视频流）；视频输出保留默认流选择
 * - 音频→视频的特殊场景：补一个黑色静态画面源（-shortest 结束），避免失败
 * - 探测 getMediaInfo 用 allowNonZero：ffmpeg -i 无输出参数时返回码为 1，属正常
 * - 默认给 -nostdin，防止 ffmpeg 在无终端环境等待 stdin 输入导致卡死（用户要求 6）
 * ============================================================
 */

const file = require('../utils/file');            // 文件工具：扩展名
const logger = require('../utils/logger');        // 日志
const { runEngine } = require('../utils/process'); // 子进程调用（引擎统一入口）

// 支持的音频输入/输出格式
const AUDIO_INPUT = ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'wma', 'opus'];
const AUDIO_OUTPUT = ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus'];

// 支持的视频输入/输出格式
const VIDEO_INPUT = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm'];
const VIDEO_OUTPUT = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'gif'];

// 输出扩展名 → 音频编码器（无损格式用原生编码器，有损用高质量默认）
const AUDIO_CODECS = {
  mp3: 'libmp3lame',
  wav: 'pcm_s16le',   // 无损 PCM，wav 标准编码
  flac: 'flac',       // 无损
  m4a: 'aac',
  aac: 'aac',
  ogg: 'libvorbis',
  opus: 'libopus',
};

// 输出扩展名 → 视频编码器（兼顾兼容性与质量的常用默认）
const VIDEO_CODECS = {
  mp4: 'libx264',
  mkv: 'libx264',
  avi: 'mpeg4',       // avi + h264 兼容性差，mpeg4 是经典搭配
  mov: 'libx264',
  webm: 'libvpx',     // vp8 编码速度远快于 vp9，适合桌面工具（反应快）
};

// 视频容器配套的音频编码器（webm 只能用 vorbis/opus，与 mp4 的 aac 不同）
const VIDEO_AUDIO_CODECS = {
  mp4: 'aac',
  mkv: 'aac',
  avi: 'mp3',
  mov: 'aac',
  webm: 'libvorbis',
};

/**
 * 把 quality(0-100) 映射为视频 CRF（0-51，越低质量越高）
 * 为什么用 CRF：恒定质量编码，文件大小自动适配，是桌面工具的合理默认
 * @param {number} quality - 0-100
 * @returns {number} crf 值
 */
function qualityToCrf(quality) {
  // quality=100 → crf=0（最高质量），quality=0 → crf=51（最低），线性映射
  return Math.max(0, Math.min(51, Math.round(51 - (quality / 100) * 51)));
}

/**
 * 解析 ffmpeg -i 探测输出（stderr）为结构化信息
 * ffmpeg 的探测信息全部在 stderr，且格式相对固定（多语言下仍以英文输出）
 * @param {string} stderr - ffmpeg 探测输出
 * @returns {{duration: number|null, format: string|null, videoCodec: string|null, audioCodec: string|null, width: number|null, height: number|null, bitrate: number|null}}
 */
function parseMediaInfo(stderr) {
  const info = { duration: null, format: null, videoCodec: null, audioCodec: null, width: null, height: null, bitrate: null };

  // 容器格式：Input #0, mp3, from 'xxx':
  const fmtMatch = stderr.match(/Input #0, ([\w+.-]+),/);
  if (fmtMatch) info.format = fmtMatch[1];

  // 时长与总码率：Duration: 00:00:03.21, start: 0.0, bitrate: 128 kb/s
  const durMatch = stderr.match(/Duration: (\d+):(\d+):(\d+\.?\d*)/);
  if (durMatch) {
    // 时:分:秒 转秒数，供裁剪等功能直接使用
    info.duration = Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]);
  }
  const brMatch = stderr.match(/bitrate: (\d+) kb\/s/);
  if (brMatch) info.bitrate = Number(brMatch[1]);

  // 视频流：Stream #0:0: Video: h264 (High), yuv420p, 1920x1080
  const videoMatch = stderr.match(/Stream #\d+:\d+.*?: Video: (\S+)[,\s].*?(\d{2,5})x(\d{2,5})/);
  if (videoMatch) {
    info.videoCodec = videoMatch[1];
    info.width = Number(videoMatch[2]);
    info.height = Number(videoMatch[3]);
  }

  // 音频流：Stream #0:1: Audio: aac (LC), 44100 Hz, stereo, 128 kb/s
  const audioMatch = stderr.match(/Stream #\d+:\d+.*?: Audio: (\S+)/);
  if (audioMatch) info.audioCodec = audioMatch[1];

  return info;
}

/**
 * 获取媒体文件信息（时长/格式/编码/分辨率/码率）
 * @param {string} inputPath - 媒体文件路径
 * @returns {Promise<object>} 结构化信息，缺失字段为 null
 */
async function getMediaInfo(inputPath) {
  // ffmpeg -i 不带输出参数时返回码为 1 且把信息打在 stderr：
  // 用 allowNonZero 把这次「失败」当作结果接收
  const { stderr } = await runEngine('ffmpeg', ['-hide_banner', '-i', inputPath], {
    allowNonZero: true,
    timeout: 60000,
  });
  const info = parseMediaInfo(stderr);
  logger.debug('[media] 探测信息:', inputPath, JSON.stringify(info));
  return info;
}

/**
 * 音视频格式转换
 * @param {string} inputPath - 输入文件路径
 * @param {string} outputPath - 输出路径（扩展名决定目标格式）
 * @param {object} [options]
 * @param {string} [options.audioBitrate='192k'] - 音频码率（有损格式）
 * @param {string} [options.audioCodec] - 音频编码器覆盖
 * @param {string} [options.videoCodec] - 视频编码器覆盖
 * @param {string} [options.videoBitrate] - 视频码率（不指定则用 CRF）
 * @param {number} [options.quality] - 0-100，映射视频 CRF / 有损音频质量
 * @param {string} [options.startTime] - 起始时间，如 '00:00:10' 或 '10'
 * @param {string} [options.duration] - 时长，如 '00:00:05'
 * @param {number} [options.width] - 输出宽度（仅视频）
 * @param {number} [options.height] - 输出高度（仅视频）
 * @returns {Promise<string>} 输出文件路径
 */
async function convertMedia(inputPath, outputPath, options = {}) {
  const outExt = file.getFileExtension(outputPath);
  const inExt = file.getFileExtension(inputPath);
  const isAudioOut = AUDIO_OUTPUT.includes(outExt);
  const isVideoOut = VIDEO_OUTPUT.includes(outExt);

  // 前置校验：目标格式必须在支持清单内（提前报错，避免 ffmpeg 晦涩报错）
  if (!isAudioOut && !isVideoOut) {
    throw new Error('不支持的媒体输出格式: ' + (outExt || '(无扩展名)'));
  }

  logger.info('[media] 开始转换:', inputPath, '→', outputPath);
  // 基础参数：-y 覆盖，-nostdin 防卡死，-hide_banner 减少噪音
  const args = ['-y', '-nostdin', '-hide_banner'];

  // 截取片段：-ss 放 -i 前用快速 seek（按关键帧对齐，速度优先），-t 限制时长
  if (options.startTime) args.push('-ss', String(options.startTime));
  args.push('-i', inputPath);
  if (options.duration) args.push('-t', String(options.duration));

  // 音频→视频：输入没有视频流，补一个黑色静态画面作为视频源（-shortest 随音频结束）
  if (isVideoOut && AUDIO_INPUT.includes(inExt) && !VIDEO_INPUT.includes(inExt)) {
    args.push('-f', 'lavfi', '-i', 'color=c=black:s=640x480:r=25', '-shortest');
  }

  try {
    if (isAudioOut) {
      // —— 音频输出：丢弃视频流，按扩展名选编码器 ——
      const codec = options.audioCodec || AUDIO_CODECS[outExt];
      args.push('-vn', '-c:a', codec);
      if (options.audioBitrate) args.push('-b:a', options.audioBitrate);
      // quality 对 mp3/ogg 有损编码生效：映射到 VBR 等级（0 最好，9 最差）
      if (options.quality !== undefined && (outExt === 'mp3' || outExt === 'ogg')) {
        const vbr = Math.max(0, Math.min(9, Math.round((100 - options.quality) / 11.1)));
        args.push('-q:a', String(vbr));
      }
    } else if (outExt === 'gif') {
      // —— GIF 输出：特殊处理 ——
      // GIF 无音频（-an），且不指定编码器（ffmpeg 按容器自动选 gif 编码器）
      // 调色板配方是 GIF 画质的标准做法：限帧 + 缩放 + palettegen/paletteuse
      const w = options.width || '480';
      const h = options.height || '-1';
      args.push('-an', '-vf', 'fps=10,scale=' + w + ':' + h + ':flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse');
    } else {
      // —— 普通视频输出：选视频编码器 + 配套音频编码器 ——
      const vCodec = options.videoCodec || VIDEO_CODECS[outExt];
      const aCodec = options.audioCodec || VIDEO_AUDIO_CODECS[outExt];
      args.push('-c:v', vCodec, '-c:a', aCodec);
      // 码率/质量二选一：显式给码率用 CBR，否则用 CRF 恒定质量
      if (options.videoBitrate) {
        args.push('-b:v', options.videoBitrate);
      } else if (options.quality !== undefined) {
        args.push('-crf', String(qualityToCrf(options.quality)));
      }

      // 尺寸调整：只给宽或高时另一维用 -2 保持等比且为偶数（h264 要求偶数尺寸）
      if (options.width || options.height) {
        const w = options.width || '-2';
        const h = options.height || '-2';
        args.push('-vf', 'scale=' + w + ':' + h);
      }
    }

    args.push(outputPath);

    // 大文件转换可能很慢：10 分钟超时（用户要求 4：不卡死）
    await runEngine('ffmpeg', args, { timeout: 600000 });
    logger.info('[media] 转换完成:', outputPath);
    return outputPath;
  } catch (err) {
    // 带上输入输出上下文（ffmpeg 错误信息本身不含文件名，不便排查）
    logger.error('[media] 转换失败:', inputPath, '→', outputPath, err);
    throw new Error('媒体转换失败: ' + inputPath + ' → ' + outputPath + '（' + err.message + '）');
  }
}

/**
 * 获取支持的格式清单
 * @returns {{audioInput: string[], audioOutput: string[], videoInput: string[], videoOutput: string[]}}
 */
function getSupportedFormats() {
  return {
    audioInput: AUDIO_INPUT.slice(),
    audioOutput: AUDIO_OUTPUT.slice(),
    videoInput: VIDEO_INPUT.slice(),
    videoOutput: VIDEO_OUTPUT.slice(),
  };
}

/**
 * 判断格式对是否支持转换
 * 规则：音频→音频 / 视频→任意媒体 / 音频→视频 均视为支持（FFmpeg 都能处理）
 * @param {string} inputExt
 * @param {string} outputExt
 * @returns {boolean}
 */
function isSupported(inputExt, outputExt) {
  const inExt = String(inputExt || '').toLowerCase();
  const outExt = String(outputExt || '').toLowerCase();
  const isAudioIn = AUDIO_INPUT.includes(inExt);
  const isVideoIn = VIDEO_INPUT.includes(inExt);
  const isAudioOut = AUDIO_OUTPUT.includes(outExt);
  const isVideoOut = VIDEO_OUTPUT.includes(outExt);
  return (isAudioIn || isVideoIn) && (isAudioOut || isVideoOut);
}

module.exports = { convertMedia, getMediaInfo, getSupportedFormats, isSupported };
