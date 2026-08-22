/**
 * ============================================================
 * 引擎路径管理模块
 * 功能：统一管理所有本地转换引擎的可执行文件路径，
 *       提供引擎存在性检查和安全获取方法
 * 
 * 为什么需要这个模块？
 * - 项目依赖多个外部开源引擎（FFmpeg、LibreOffice、Poppler、Tesseract）
 * - 这些引擎的可执行文件放在项目 bin/ 目录下
 * - 统一管理路径可以避免在代码中各处硬编码路径，方便维护和迁移
 * - 提供检查方法，启动时可验证引擎是否就位
 * ============================================================
 */

// 引入 Node.js 内置模块
const path = require('path');  // path：处理文件路径，跨平台路径拼接
const fs = require('fs');      // fs：文件系统操作，用于检查文件/目录是否存在

/**
 * bin 目录的绝对路径
 * 开发模式：__dirname 是 src/main/，../.. 回退到项目根目录 → 项目根目录/bin
 * 打包模式（.exe 安装后）：引擎作为 extraResources 放在 resources/bin（process.resourcesPath/bin）
 * 用 app.isPackaged 区分；纯 Node 测试环境下 require('electron') 返回路径字符串，需 try 兜底
 */
let isPackaged = false;
try {
  const electronApp = require('electron').app;
  isPackaged = !!(electronApp && electronApp.isPackaged);
} catch {
  isPackaged = false;
}
const BIN_DIR = isPackaged
  ? path.join(process.resourcesPath, 'bin')
  : path.join(__dirname, '..', '..', 'bin');

/**
 * ============================================================
 * 所有引擎路径配置对象
 * 键名：引擎标识（代码中通过此名称引用）
 * 键值：引擎可执行文件或目录的绝对路径
 * 
 * 注意：路径基于实际 bin 目录结构，如目录结构变化需同步更新
 * ============================================================
 */
const ENGINES = {
  // ===== 音视频 / 图片编码引擎 =====
  // FFmpeg：强大的多媒体处理工具，支持音视频编码、解码、转码、滤镜等
  // 也可用于图片格式转换（如 WebP、TIFF 等）
  ffmpeg: path.join(BIN_DIR, 'ffmpeg', 'ffmpeg.exe'),

  // ===== 办公文档互转引擎 =====
  // LibreOffice Portable：开源办公套件，支持 Word/Excel/PPT/PDF 等格式互转
  // 注意：这是便携版，主程序入口是 LibreOfficePortable.exe（不是 soffice.exe）
  libreoffice: path.join(BIN_DIR, 'libreoffice', 'LibreOfficePortable', 'LibreOfficePortable.exe'),

  // ===== PDF 渲染与处理引擎 =====
  // Poppler：PDF 渲染工具集，支持 PDF 转图片、提取信息、提取文字等
  // 重要注意：真正的 exe 在 Library/bin 目录下，bin/ 目录下只是 .cmd 包装脚本
  // 调用时必须使用 Library/bin 下的 exe，否则可能找不到依赖 DLL
  pdftoppm: path.join(BIN_DIR, 'poppler', 'Library', 'bin', 'pdftoppm.exe'),  // PDF 转图片
  pdfinfo: path.join(BIN_DIR, 'poppler', 'Library', 'bin', 'pdfinfo.exe'),      // 读取 PDF 元信息

  // ===== OCR 文字识别引擎 =====
  // Tesseract：开源 OCR 引擎，支持多语言文字识别
  // tessdata 是语言包目录，存放 .traineddata 训练数据文件（如 chi_sim 中文、eng 英文）
  tesseract: path.join(BIN_DIR, 'tesseract', 'tesseract.exe'),  // OCR 主程序
  tessdata: path.join(BIN_DIR, 'tesseract', 'tessdata'),         // 语言包目录

  // ===== AVS3 音频解码器 =====
  // AVS3：中国自主音视频编码标准的音频部分
  // 用于解码 AVS3 编码的音频文件
  avs3Decoder: path.join(BIN_DIR, 'avs3', 'avs3RM0Decoder.exe'),
};

/**
 * 检查所有引擎是否存在
 * 遍历 ENGINES 对象，检查每个路径对应的文件或目录是否存在
 * 
 * @returns {{ missing: string[], available: string[] }} 
 *   - missing：不存在的引擎名称数组
 *   - available：存在的引擎名称数组
 * 
 * 特殊处理：tessdata 是目录（用 isDirectory 判断），其他是文件（用 existsSync 判断）
 */
function checkEngines() {
  const missing = [];    // 不存在的引擎
  const available = [];  // 存在的引擎

  // 遍历引擎配置对象的键值对
  for (const [name, enginePath] of Object.entries(ENGINES)) {
    // tessdata 是目录，需要特殊判断（检查是否为目录）
    if (name === 'tessdata') {
      if (fs.existsSync(enginePath) && fs.statSync(enginePath).isDirectory()) {
        available.push(name);
      } else {
        missing.push(name);
      }
    } else {
      // 其他引擎是可执行文件，只需要判断文件是否存在
      if (fs.existsSync(enginePath)) {
        available.push(name);
      } else {
        missing.push(name);
      }
    }
  }

  return { missing, available };
}

/**
 * 安全获取引擎路径
 * 如果引擎不存在或名称未知，抛出明确的错误信息
 * 用于在调用引擎前做安全检查，避免调用不存在的文件导致崩溃
 * 
 * @param {string} name - 引擎名称（必须是 ENGINES 对象中的键名）
 * @returns {string} 引擎的绝对路径
 * @throws {Error} 未知引擎名称或引擎文件不存在时抛出错误
 */
function getEngine(name) {
  const enginePath = ENGINES[name];

  // 检查引擎名称是否存在于配置中
  if (!enginePath) {
    throw new Error(`未知引擎: ${name}`);
  }

  // 检查引擎文件是否实际存在
  if (!fs.existsSync(enginePath)) {
    throw new Error(`引擎不存在: ${name} (${enginePath})`);
  }

  return enginePath;
}

// ============================================================
// 模块导出：供其他文件 require 使用
// ============================================================
module.exports = {
  ENGINES,       // 引擎路径配置对象（可直接访问所有路径）
  BIN_DIR,       // bin 目录绝对路径
  checkEngines,  // 检查所有引擎是否存在的方法
  getEngine,     // 安全获取单个引擎路径的方法
};
