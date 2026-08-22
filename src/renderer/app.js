/**
 * ============================================================
 * 前端交互逻辑文件
 * 功能：窗口控制、导航切换、文件上传、文件列表管理、
 *       格式选择、模拟转换过程、结果面板展示
 * 注意：目前转换过程是模拟的（进度条动画+假结果），
 *       后续需要接入主进程的真实转换逻辑（通过 IPC 通信）
 * ============================================================
 */

// ============================================================
// 功能配置：定义每个功能模块的标题、说明、支持的目标格式
// 导航切换时，根据当前功能更新标题、副标题、格式下拉框
// ============================================================
const FEATURES = {
  // 文档转换
  document: {
    title: '文档转换',
    subtitle: '支持 Word / Excel / PPT / PDF / TXT / Markdown 互转',
    formats: ['pdf', 'docx', 'xlsx', 'pptx', 'txt', 'md', 'html'],
  },
  // 图片转换
  image: {
    title: '图片转换',
    subtitle: '支持 JPG / PNG / WebP / GIF / BMP / TIFF / HEIC / ICO 互转',
    formats: ['jpg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'heic', 'ico'],
  },
  // 音视频转换
  media: {
    title: '音视频转换',
    subtitle: '支持 MP3 / WAV / FLAC / M4A / AAC / OGG / MP4 / MKV / AVI / MOV 互转',
    formats: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'mp4', 'mkv', 'avi', 'mov'],
  },
  // PDF 处理
  pdf: {
    title: 'PDF 处理',
    subtitle: '支持 PDF 拆分 / 合并 / 加密 / 解密 / 提取文字 / 转图片',
    formats: ['pdf', 'docx', 'txt', 'jpg', 'png'],
  },
  // 扫描件模拟
  scan: {
    title: '扫描件模拟',
    subtitle: '将电子文档转为带真实扫描质感的 PDF（随机倾斜、噪点、暗角）',
    formats: ['pdf'],
  },
  // OCR 识别
  ocr: {
    title: 'OCR 识别',
    subtitle: '扫描件 / 图片转可编辑文字，支持中英文',
    formats: ['txt', 'docx', 'pdf'],
  },
  // 批量转换
  batch: {
    title: '批量转换',
    subtitle: '多文件同时处理，支持统一目标格式和批量导出',
    formats: ['pdf', 'docx', 'xlsx', 'jpg', 'png', 'mp3', 'mp4'],
  },
};

// ============================================================
// 格式显示名称映射：扩展名 → 友好显示名称
// 用于文件列表和结果卡片中显示格式名称
// ============================================================
const FORMAT_LABELS = {
  pdf: 'PDF',
  docx: 'Word (.docx)',
  xlsx: 'Excel (.xlsx)',
  pptx: 'PPT (.pptx)',
  txt: 'TXT',
  md: 'Markdown',
  html: 'HTML',
  jpg: 'JPG',
  png: 'PNG',
  webp: 'WebP',
  gif: 'GIF',
  bmp: 'BMP',
  tiff: 'TIFF',
  heic: 'HEIC',
  ico: 'ICO',
  mp3: 'MP3',
  wav: 'WAV',
  flac: 'FLAC',
  m4a: 'M4A',
  aac: 'AAC',
  ogg: 'OGG',
  mp4: 'MP4',
  mkv: 'MKV',
  avi: 'AVI',
  mov: 'MOV',
};

// ============================================================
// 全局状态变量
// ============================================================
let currentFeature = 'document';   // 当前选中的功能标识，默认文档转换
let files = [];                     // 待转换文件列表（真实模式含 path/taskId 字段）
let results = [];                   // 转换结果列表（真实模式含 path 字段）
let fileIdCounter = 0;              // 文件 ID 计数器，用于生成唯一 ID
let resultIdCounter = 0;            // 结果 ID 计数器
let renderTimer = null;             // 进度重渲染节流定时器（进度推送频繁，避免每帧重渲染）
let outputDir = null;               // 自定义输出目录（null = 默认：输出到文件所在目录）
let autoConvertFormat = null;     // 右键菜单指定的目标格式（--convert-to），非空则自动转换
let autoConvertStarted = false;   // 自动转换是否已启动（防重复触发）
let previewOptions = { preset: 'normal', quality: 90, width: '' }; // 预览参数（应用到正式转换）
let previewRegenTimer = null;     // 预览重生成防抖定时器

/**
 * 按当前功能构造转换选项（预览参数 → 正式转换）
 * 图片：质量/缩放宽度；扫描件：效果预设；其他：无参数
 * @returns {object}
 */
function buildConversionOptions() {
  if (currentFeature === 'scan') {
    return { preset: previewOptions.preset };
  }
  if (currentFeature === 'image') {
    const opts = {};
    const quality = Number(previewOptions.quality);
    if (Number.isFinite(quality)) opts.quality = quality;
    const width = Number(previewOptions.width);
    if (width > 0) opts.width = width;
    return opts;
  }
  return {};
}

// ============================================================
// DOM 元素缓存：通过 id 获取常用元素，避免重复查询
// ============================================================
const $ = (id) => document.getElementById(id);
const dropZone = $('drop-zone');              // 拖拽上传区
const fileInput = $('file-input');            // 隐藏的文件选择 input
const fileListBody = $('file-list-body');     // 文件列表容器
const emptyState = $('empty-state');          // 文件列表空状态
const fileCount = $('file-count');            // 文件数量显示
const targetFormat = $('target-format');      // 目标格式下拉框
const btnConvert = $('btn-convert');          // 开始转换按钮
const btnClear = $('btn-clear');              // 清空列表按钮
const resultList = $('result-list');          // 结果列表容器
const resultEmpty = $('result-empty');        // 结果空状态
const resultCount = $('result-count');        // 结果数量徽章
const featureTitle = $('feature-title');      // 功能标题
const featureSubtitle = $('feature-subtitle'); // 功能副标题

// 新增功能 DOM 引用
const btnChooseDir = $('btn-choose-dir');      // 选择输出目录按钮
const btnResetDir = $('btn-reset-dir');        // 恢复默认输出目录按钮
const outputDirText = $('output-dir-text');    // 输出目录显示文本
const btnPreview = $('btn-preview');           // 预览按钮
const previewModal = $('preview-modal');       // 预览模态框
const previewOriginal = $('preview-original'); // 原图 img
const previewResult = $('preview-result');     // 预览结果 img
const previewOriginalEmpty = $('preview-original-empty');
const previewResultEmpty = $('preview-result-empty');
const previewInfo = $('preview-info');         // 预览说明文字
// 预览参数控制区（问题 2：预览不是摆设，参数可调且应用到正式转换）
const previewControls = $('preview-controls');
const previewControlPreset = $('preview-control-preset');
const previewControlQuality = $('preview-control-quality');
const previewControlWidth = $('preview-control-width');
const previewPreset = $('preview-preset');
const previewQuality = $('preview-quality');
const previewQualityValue = $('preview-quality-value');
const previewWidth = $('preview-width');
const previewStats = $('preview-stats');       // 对比统计（大小等）
const previewFileInfo = $('preview-fileinfo'); // 文件信息

// ============================================================
// 窗口控制：通过预加载脚本暴露的 electronAPI 调用主进程
// ============================================================

// 最小化窗口
$('btn-minimize').addEventListener('click', () => {
  window.electronAPI?.minimize();  // ?. 可选链：如果 electronAPI 不存在（如浏览器调试），不报错
});

// 最大化/还原窗口
$('btn-maximize').addEventListener('click', () => {
  window.electronAPI?.maximize();
});

// 关闭窗口
$('btn-close').addEventListener('click', () => {
  window.electronAPI?.close();
});

// ============================================================
// 导航切换：点击左侧导航项，切换当前功能
// ============================================================
document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', () => {
    // 移除所有导航项的 active 类
    document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
    // 给当前点击的导航项添加 active 类
    item.classList.add('active');
    // 更新当前功能标识
    currentFeature = item.dataset.feature;
    // 更新界面（标题、副标题、格式下拉框）
    updateFeatureUI();
  });
});

/**
 * 更新功能界面：根据当前选中的功能更新标题、副标题、格式下拉框
 * 导航切换时调用
 */
function updateFeatureUI() {
  const config = FEATURES[currentFeature];
  // 更新标题和副标题
  featureTitle.textContent = config.title;
  featureSubtitle.textContent = config.subtitle;

  // 更新格式下拉框选项
  targetFormat.innerHTML = '';  // 清空现有选项
  config.formats.forEach((fmt) => {
    const option = document.createElement('option');
    option.value = fmt;
    option.textContent = FORMAT_LABELS[fmt] || fmt.toUpperCase();  // 显示友好名称，没有则用扩展名大写
    targetFormat.appendChild(option);
  });
}

// ============================================================
// 文件上传：支持点击选择和拖拽上传
// ============================================================

// 点击上传区 → 触发隐藏的 file input 点击事件
dropZone.addEventListener('click', () => fileInput.click());

// 文件选择完成 → 处理选中的文件
fileInput.addEventListener('change', (e) => {
  handleFiles(e.target.files);
  fileInput.value = '';  // 清空 input 值，允许重复选择同一个文件
});

// 拖拽事件：dragover（拖拽经过）
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();  // 必须阻止默认行为，才能触发 drop 事件
  dropZone.classList.add('drag-over');  // 添加高亮样式
});

// 拖拽事件：dragleave（拖拽离开）
dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');  // 移除高亮样式
});

// 拖拽事件：drop（释放文件）
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();  // 阻止默认行为（浏览器会默认打开文件）
  dropZone.classList.remove('drag-over');
  handleFiles(e.dataTransfer.files);  // 处理拖拽的文件
});

/**
 * 处理文件列表：将 File 对象转换为内部文件对象，添加到 files 数组
 * @param {FileList} fileList - 来自 input 或 drop 的文件列表
 */
function handleFiles(fileList) {
  for (const file of fileList) {
    files.push({
      id: ++fileIdCounter,           // 唯一 ID
      name: file.name,               // 文件名
      size: file.size,               // 文件大小（字节）
      type: file.name.split('.').pop().toLowerCase(),  // 文件扩展名
      path: file.path || null,       // Electron 真实文件路径（浏览器调试时为 null）
      progress: 0,                   // 转换进度（0-100）
      status: 'pending',             // pending / converting / done / failed
      taskId: null,                  // 真实模式下与主进程任务 ID 关联
    });
  }
  renderFileList();  // 重新渲染文件列表
}

/**
 * 格式化文件大小：字节 → 友好显示（B/KB/MB）
 * @param {number} bytes - 文件大小（字节）
 * @returns {string} 格式化后的大小字符串
 */
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * 根据文件扩展名获取文件类型图标缩写
 * 用于文件列表中的图标显示（显示如 PDF、IMG、AUD 等缩写）
 * @param {string} type - 文件扩展名
 * @returns {string} 类型缩写
 */
function getFileIcon(type) {
  const ext = type.toLowerCase();
  // 图片格式
  if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tiff', 'heic', 'ico'].includes(ext)) return 'IMG';
  // 音频格式
  if (['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg'].includes(ext)) return 'AUD';
  // 视频格式
  if (['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv'].includes(ext)) return 'VID';
  // 文档格式
  if (['pdf'].includes(ext)) return 'PDF';
  if (['doc', 'docx'].includes(ext)) return 'DOC';
  if (['xls', 'xlsx'].includes(ext)) return 'XLS';
  if (['ppt', 'pptx'].includes(ext)) return 'PPT';
  if (['txt', 'md'].includes(ext)) return 'TXT';
  // 未知格式
  return 'FILE';
}

// ============================================================
// 文件列表渲染
// ============================================================

/**
 * 渲染文件列表：根据 files 数组动态生成 DOM
 * 包括空状态显示、文件条目、进度条、移除按钮
 */
function renderFileList() {
  // 更新文件数量显示
  fileCount.textContent = files.length + ' 个文件';

  // 空列表：显示空状态
  if (files.length === 0) {
    emptyState.style.display = 'flex';
    fileListBody.innerHTML = '';
    fileListBody.appendChild(emptyState);
    return;
  }

  // 非空列表：隐藏空状态，渲染文件条目
  emptyState.style.display = 'none';
  fileListBody.innerHTML = '';

  files.forEach((file) => {
    // 显示目标格式：右键菜单自动转换时用其指定格式，否则用下拉框当前值
    const displayFmt = autoConvertFormat || targetFormat.value;
    const item = document.createElement('div');
    item.className = 'file-item';
    // 文件条目 HTML：图标 + 信息（名称/大小/目标格式） + 进度条 + 移除按钮
    item.innerHTML = `
      <div class="file-item-icon">${getFileIcon(file.type)}</div>
      <div class="file-item-info">
        <div class="file-item-name">${file.name}</div>
        <div class="file-item-meta">
          <span>${formatSize(file.size)}</span>
          <span class="arrow">→</span>
          <span>${FORMAT_LABELS[displayFmt] || displayFmt.toUpperCase()}</span>
        </div>
      </div>
      <div class="file-item-progress">
        <div class="progress-bar">
          <div class="progress-fill ${file.status === 'done' ? 'done' : file.status === 'failed' ? 'failed' : ''}" style="width: ${file.status === 'failed' ? 100 : file.progress}%"></div>
        </div>
      </div>
      <button class="file-item-remove" data-id="${file.id}" title="移除">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    `;
    fileListBody.appendChild(item);
  });

  // 绑定移除按钮点击事件（事件委托：给每个按钮绑定）
  fileListBody.querySelectorAll('.file-item-remove').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();  // 阻止事件冒泡，避免触发文件条目点击
      const id = parseInt(btn.dataset.id);
      // 从 files 数组中移除该文件
      files = files.filter((f) => f.id !== id);
      renderFileList();  // 重新渲染
    });
  });
}

// ============================================================
// 清空列表按钮
// ============================================================
btnClear.addEventListener('click', () => {
  files = [];              // 清空文件数组
  renderFileList();        // 重新渲染
});

// ============================================================
// 模拟转换过程
// 注意：这是模拟实现，通过 setInterval 模拟进度增长
// 后续需要替换为通过 IPC 调用主进程的真实转换逻辑
// ============================================================
btnConvert.addEventListener('click', () => {
  // 没有文件时提示
  if (files.length === 0) {
    showToast('请先添加文件', 'info');
    return;
  }

  // 真实模式：预加载 API 存在且所有文件带真实路径 → 走主进程真实转换；
  // 否则（浏览器调试）使用原模拟流程
  const canReal = typeof window.electronAPI?.convertStart === 'function' && files.every((f) => f.path);
  if (canReal) {
    startRealConversion();
    return;
  }
  startSimulatedConversion();
});

/**
 * 模拟转换（浏览器调试用）
 * 当 window.electronAPI 不存在或文件无真实路径时自动启用；
 * 与真实模式共用文件列表/结果列表渲染
 */
function startSimulatedConversion() {
  // 禁用转换按钮，防止重复点击
  btnConvert.disabled = true;
  btnConvert.textContent = '转换中...';

  const targetFmt = targetFormat.value;  // 目标格式
  let completed = 0;                       // 已完成文件计数

  // 遍历每个文件，模拟转换过程
  files.forEach((file, index) => {
    file.status = 'converting';  // 更新状态为转换中

    // 使用 setInterval 模拟进度增长
    // 每个文件的进度增长速度略有不同（index * 100 延迟），模拟并发处理
    const interval = setInterval(() => {
      // 随机增长 5-20% 进度
      file.progress += Math.random() * 15 + 5;

      // 进度达到 100%：转换完成
      if (file.progress >= 100) {
        file.progress = 100;
        file.status = 'done';
        clearInterval(interval);  // 清除定时器
        completed++;

        // 添加到结果列表（unshift：最新的在最前面）
        results.unshift({
          id: file.id,
          name: file.name.replace(/\.[^.]+$/, '.' + targetFmt),  // 替换扩展名为目标格式
          size: Math.floor(file.size * (0.8 + Math.random() * 0.4)),  // 模拟输出文件大小（原大小的 80%-120%）
          format: targetFmt,
        });
        renderResults();  // 重新渲染结果列表

        // 所有文件都完成了：恢复按钮，清空待转换列表
        if (completed === files.length) {
          btnConvert.disabled = false;
          // 恢复按钮原始内容（图标 + 文字）
          btnConvert.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            开始转换
          `;
          // 延迟 500ms 后清空待转换列表（让用户看到进度条变绿）
          setTimeout(() => {
            files = [];
            renderFileList();
          }, 500);
        }
      }
      renderFileList();  // 每次进度更新都重新渲染文件列表（更新进度条）
    }, 200 + index * 100);  // 每个文件间隔 100ms 启动，模拟并发
  });
}

// ============================================================
// 真实转换（IPC 模式）
// ============================================================

/** 节流渲染文件列表：进度推送频繁，合并到 ~100ms 一次避免每帧重渲染 */
function renderFileListThrottled() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderFileList();
  }, 100);
}

/** 恢复转换按钮为初始状态（图标 + 文字 + 可点） */
function resetConvertButton() {
  btnConvert.disabled = false;
  btnConvert.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="5 3 19 12 5 21 5 3"/>
    </svg>
    开始转换
  `;
}

/**
 * 真实转换流程：调用主进程 convert:start
 * 任务 ID 与文件通过 taskId 关联，进度/完成/失败由事件推送驱动
 */
function startRealConversion() {
  // 右键菜单自动转换时使用其指定格式，否则用下拉框当前选择
  const targetFmt = autoConvertFormat || targetFormat.value;
  const inputPaths = files.map((f) => f.path);
  btnConvert.disabled = true;
  btnConvert.textContent = '转换中...';
  files.forEach((f) => { f.status = 'converting'; });
  renderFileList();

  // 输出目录：用户自选目录优先，否则 null（主进程默认输出到文件所在目录）
  // options：带上预览设置的参数（图片质量/缩放、扫描效果预设），预览即所得
  window.electronAPI.convertStart({ files: inputPaths, targetFormat: targetFmt, outputDir, options: buildConversionOptions() })
    .then((results_) => {
      // 建立 taskId ↔ 文件关联；路由失败的文件带 error 字段
      results_.forEach((r) => {
        const f = files.find((x) => x.path === r.inputPath);
        if (!f) return;
        f.taskId = r.taskId;
        if (r.error) { f.status = 'failed'; f.error = r.error; }
      });
      renderFileList();
    })
    .catch((err) => {
      // 启动失败（如 IPC 异常）：恢复按钮，不留下卡死的界面
      showToast('启动转换失败：' + err.message, 'error', 5000);
      resetConvertButton();
      files.forEach((f) => { f.status = 'pending'; });
      renderFileList();
    });
}

/** 注册主进程事件推送（进程生命周期内注册一次） */
function registerConversionListeners() {
  const api = window.electronAPI;
  if (!api || typeof api.onConvertProgress !== 'function') return;

  // 进度推送：更新对应文件的进度条（节流渲染）
  api.onConvertProgress(({ taskId, progress, status }) => {
    const f = files.find((x) => x.taskId === taskId);
    if (!f) return;
    if (progress !== undefined && progress !== null) f.progress = progress;
    if (status === 'processing') f.status = 'converting';
    renderFileListThrottled();
  });

  // 完成推送：加入结果列表；全部完成时恢复按钮并清空待转列表
  api.onConvertComplete(({ taskId, outputPath, size }) => {
    const f = files.find((x) => x.taskId === taskId);
    if (f) { f.status = 'done'; f.progress = 100; }
    if (outputPath) {
      const parts = outputPath.split(/[\\/]/);
      const name = parts[parts.length - 1];
      const ext = name.split('.').pop().toLowerCase();
      // 输出目录：截取路径目录部分用于结果卡片展示与提示
      const dir = outputPath.replace(/[\\/][^\\/]*$/, '');
      results.unshift({
        id: ++resultIdCounter,
        name,
        size: size || 0, // 主进程 stat 的真实输出大小
        format: ext,
        path: outputPath,
        dir,
      });
      renderResults();
      // 明确提示输出位置（用户要求：转换后知道文件去了哪里）
      showToast('转换完成：' + name + ' → ' + dir, 'success', 5000);
    }
    renderFileList();
    if (!files.some((x) => x.status === 'converting' || x.status === 'pending')) {
      resetConvertButton();
      // 重置右键菜单自动转换状态（一次一用）
      autoConvertFormat = null;
      autoConvertStarted = false;
      // 延迟清空列表，让用户看到进度条变绿
      setTimeout(() => { files = []; renderFileList(); }, 400);
    }
  });

  // 失败推送：标记文件 failed，保留移除/重试入口
  api.onConvertError(({ taskId, error }) => {
    const f = files.find((x) => x.taskId === taskId);
    if (f) { f.status = 'failed'; f.error = error || '转换失败'; }
    renderFileList();
    if (!files.some((x) => x.status === 'converting' || x.status === 'pending')) {
      resetConvertButton();
      // 全部结束（含失败）也重置自动转换状态
      autoConvertFormat = null;
      autoConvertStarted = false;
    }
  });
}

/** 真实模式下从主进程拉取支持格式，刷新图片功能下拉（动态探测结果为准） */
function refreshFormatsFromMain() {
  if (typeof window.electronAPI?.getSupportedFormats !== 'function') return;
  window.electronAPI.getSupportedFormats()
    .then((fmts) => {
      if (fmts && Array.isArray(fmts.image?.output) && fmts.image.output.length > 0) {
        FEATURES.image.formats = fmts.image.output;
        if (currentFeature === 'image') updateFeatureUI();
      }
    })
    .catch(() => { /* 拉取失败保留硬编码清单，不阻塞使用 */ });
}

/** 底部状态栏：引擎就绪状态（缺失时提示缺哪个引擎） */
function refreshEngineStatus() {
  if (typeof window.electronAPI?.getEngineStatus !== 'function') return;
  window.electronAPI.getEngineStatus()
    .then((status) => {
      const dot = document.querySelector('.status-dot');
      const label = document.querySelector('.status-left span:last-child');
      if (dot) dot.className = 'status-dot ' + (status.ready ? 'status-ok' : 'status-warn');
      if (label) label.textContent = status.ready ? '引擎状态：全部就绪' : '引擎状态：缺失 ' + (status.missing || []).join(', ');
    })
    .catch(() => {});
}

// ============================================================
// Toast 轻提示（替代 alert：不阻塞操作、可堆叠、自动消失）
// ============================================================
let toastContainer = null;
function ensureToastContainer() {
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }
  return toastContainer;
}
/**
 * 显示一条轻提示
 * @param {string} message - 提示内容
 * @param {'info'|'success'|'error'} [type='info']
 * @param {number} [duration=3000] - 显示时长（毫秒）
 */
function showToast(message, type = 'info', duration = 3000) {
  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.textContent = message;
  ensureToastContainer().appendChild(toast);
  // 自动淡出并移除（防止残留 DOM）
  setTimeout(() => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ============================================================
// 新增功能：输出目录选择 / 转换效果预览 / 右键菜单文件接收
// ============================================================

/** 更新输出目录显示文本 */
function renderOutputDir() {
  outputDirText.textContent = outputDir || '文件所在目录（默认）';
  outputDirText.title = outputDir || '';
}

/** 选择输出目录（系统目录对话框；取消则保持原选择） */
function chooseOutputDir() {
  if (typeof window.electronAPI?.chooseDirectory !== 'function') {
    showToast('（调试模式）请使用 Electron 运行以选择输出目录', 'info');
    return;
  }
  window.electronAPI.chooseDirectory()
    .then((dir) => {
      if (!dir) return; // 用户取消
      outputDir = dir;
      localStorage.setItem('luren-output-dir', dir); // 记住本次选择，下次启动沿用
      renderOutputDir();
    })
    .catch((err) => showToast('选择输出目录失败：' + err.message, 'error', 4000));
}

/** 恢复默认输出目录（输出到文件所在目录） */
function resetOutputDir() {
  outputDir = null;
  localStorage.removeItem('luren-output-dir');
  renderOutputDir();
}

/** 打开/关闭预览模态框 */
function openPreviewModal() { previewModal.hidden = false; }
function closePreviewModal() { previewModal.hidden = true; }

/**
 * 把预览服务的返回结果渲染到模态框
 * @param {{original: string|null, preview: string|null, info: string|null}} res
 */
function displayPreviewData(res) {
  // 有结果就隐藏加载 spinner
  $('preview-spinner').hidden = true;
  if (res.original) {
    previewOriginal.src = res.original;
    previewOriginal.hidden = false;
    previewOriginalEmpty.style.display = 'none';
  } else {
    previewOriginalEmpty.style.display = 'flex';
    previewOriginalEmpty.textContent = '无原图预览';
  }
  if (res.preview) {
    previewResult.src = res.preview;
    previewResult.hidden = false;
    previewResultEmpty.style.display = 'none';
  } else {
    previewResultEmpty.style.display = 'flex';
    $('preview-result-text').textContent = '无预览';
  }
  previewInfo.textContent = res.info || '';

  // 对比统计：原图大小 → 预览大小（让"效果"可感知，无损格式差异体现在文件大小）
  if (res.originalStats || res.previewStats) {
    const orig = res.originalStats ? formatSize(res.originalStats.size) : '—';
    const prev = res.previewStats ? formatSize(res.previewStats.size) : '—';
    previewStats.textContent = '原图大小：' + orig + '  →  转换效果：' + prev + '（' + (targetFormat.value || '').toUpperCase() + '）';
  } else {
    previewStats.textContent = '';
  }

  // 文件信息（文档/音视频等无法图片预览时也有信息可看）
  if (res.fileInfo) {
    previewFileInfo.textContent = '文件：' + res.fileInfo.name + '（' + res.fileInfo.type + '，' + formatSize(res.fileInfo.size) + '）';
  } else {
    previewFileInfo.textContent = '';
  }
}

/** 重置模态框为「生成中」状态 */
function resetPreviewModal() {
  previewOriginal.hidden = true;
  previewResult.hidden = true;
  previewOriginalEmpty.style.display = 'flex';
  previewOriginalEmpty.textContent = '无原图预览';
  previewResultEmpty.style.display = 'flex';
  $('preview-spinner').hidden = false;
  $('preview-result-text').textContent = '正在生成…';
  previewInfo.textContent = '';
}

/**
 * 生成并展示第一个文件的转换效果预览
 * 真实调用主进程预览服务（与正式转换同一套管线，预览即所得）
 */
/**
 * 按当前功能显示/隐藏预览参数控件
 * 扫描件：效果预设；图片：质量 + 缩放宽度；其他：无参数控件
 */
function updatePreviewControls() {
  const isScan = currentFeature === 'scan';
  const isImage = currentFeature === 'image';
  previewControls.hidden = !(isScan || isImage);
  previewControlPreset.hidden = !isScan;
  previewControlQuality.hidden = !isImage;
  previewControlWidth.hidden = !isImage;
}

/** 生成当前预览（使用预览参数），供初次预览与参数变更后重预览共用 */
function generatePreviewRequest() {
  const target = files.find((f) => f.path);
  if (!target) return;
  if (typeof window.electronAPI?.getPreview !== 'function') return;
  resetPreviewModal();
  window.electronAPI.getPreview({
    inputPath: target.path,
    feature: currentFeature,
    targetFormat: targetFormat.value,
    options: buildConversionOptions(),
  })
    .then(displayPreviewData)
    .catch((err) => {
      $('preview-spinner').hidden = true;
      $('preview-result-text').textContent = '预览失败';
      previewInfo.textContent = err.message || '预览生成失败';
    });
}

/** 参数变更 → 防抖重新预览（400ms，避免滑块拖动时频繁请求） */
function schedulePreviewRegen() {
  if (previewRegenTimer) clearTimeout(previewRegenTimer);
  previewRegenTimer = setTimeout(() => {
    previewRegenTimer = null;
    if (!previewModal.hidden) generatePreviewRequest();
  }, 400);
}

function showPreview() {
  const target = files.find((f) => f.path);
  if (!target) {
    showToast('请先添加文件再预览', 'info');
    return;
  }
  if (typeof window.electronAPI?.getPreview !== 'function') {
    showToast('（调试模式）请使用 Electron 运行以预览效果', 'info');
    return;
  }
  // 同步控件状态与参数显示，再生成预览
  updatePreviewControls();
  previewPreset.value = previewOptions.preset;
  previewQuality.value = previewOptions.quality;
  previewQualityValue.textContent = previewOptions.quality;
  previewWidth.value = previewOptions.width;
  openPreviewModal();
  generatePreviewRequest();
}

// 预览参数控件事件：变更即防抖重新预览（预览不再是摆设）
previewPreset.addEventListener('change', () => {
  previewOptions.preset = previewPreset.value;
  schedulePreviewRegen();
});
previewQuality.addEventListener('input', () => {
  previewOptions.quality = previewQuality.value;
  previewQualityValue.textContent = previewQuality.value;
  schedulePreviewRegen();
});
previewWidth.addEventListener('change', () => {
  previewOptions.width = previewWidth.value;
  schedulePreviewRegen();
});

/**
 * 把「文件描述数组」加入待转换列表（右键菜单传入）
 * @param {Array<{path: string, name: string, size: number}>} fileDescs
 */
function addExternalFiles(fileDescs) {
  if (!Array.isArray(fileDescs) || fileDescs.length === 0) return;
  fileDescs.forEach((fd) => {
    // 去重：同一路径不重复添加（用户可能多次右键同一批文件）
    if (files.some((f) => f.path === fd.path)) return;
    const name = fd.name || String(fd.path).split(/[\\/]/).pop() || '文件';
    files.push({
      id: ++fileIdCounter,
      name,
      size: fd.size || 0,
      type: name.split('.').pop().toLowerCase(),
      path: fd.path,
      progress: 0,
      status: 'pending',
      taskId: null,
    });
  });
  renderFileList();
}

/**
 * 处理右键菜单携带的目标格式：设置自动转换状态并延迟启动（WPS 风格：点击即转）
 * @param {string|null} format
 */
function handleConvertTo(format) {
  if (!format) return;
  autoConvertFormat = String(format).toLowerCase();
  // 若当前功能的下拉框包含该格式则同步选中（界面一致性好）；不含则按实际格式转换
  const options = [...targetFormat.options].map((o) => o.value);
  if (options.includes(autoConvertFormat)) targetFormat.value = autoConvertFormat;
  // 延迟启动：先让文件列表渲染出来，再自动开始转换
  setTimeout(() => {
    if (files.length > 0 && !autoConvertStarted) {
      autoConvertStarted = true;
      const canReal = typeof window.electronAPI?.convertStart === 'function' && files.every((f) => f.path);
      if (canReal) startRealConversion();
      else startSimulatedConversion();
    }
  }, 400);
}

/** 注册右键菜单文件接收（启动携带 + 运行中二次实例转发） */
function registerOpenFiles() {
  const api = window.electronAPI;
  if (!api) return;
  // 启动时携带的文件：主动拉取（比推送可靠，避免渲染层监听器未就绪的竞态）
  if (typeof api.getPendingFiles === 'function') {
    api.getPendingFiles().then((payload) => {
      // 兼容两种载荷：新版 { files, convertTo }，旧版 文件数组
      const fileList = Array.isArray(payload) ? payload : payload?.files;
      addExternalFiles(fileList);
      handleConvertTo(Array.isArray(payload) ? null : payload?.convertTo);
    }).catch(() => {});
  }
  // 运行中收到新文件（右键菜单在应用已启动时再次触发）
  if (typeof api.onOpenFiles === 'function') {
    api.onOpenFiles((payload) => {
      const fileList = Array.isArray(payload) ? payload : payload?.files;
      addExternalFiles(fileList);
      handleConvertTo(Array.isArray(payload) ? null : payload?.convertTo);
    });
  }
}

// 事件绑定（新增功能）
btnChooseDir.addEventListener('click', chooseOutputDir);
btnResetDir.addEventListener('click', resetOutputDir);
btnPreview.addEventListener('click', showPreview);
$('btn-preview-close').addEventListener('click', closePreviewModal);
// 点击遮罩空白处关闭
previewModal.addEventListener('click', (e) => {
  if (e.target === previewModal) closePreviewModal();
});
// Esc 键关闭
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !previewModal.hidden) closePreviewModal();
});

// ============================================================
// 结果面板渲染
// ============================================================

/**
 * 渲染转换结果列表：根据 results 数组动态生成 DOM
 * 包括空状态显示、结果卡片、打开/保存按钮
 */
function renderResults() {
  // 更新结果数量徽章
  resultCount.textContent = results.length;

  // 空结果：显示空状态
  if (results.length === 0) {
    resultEmpty.style.display = 'flex';
    resultList.innerHTML = '';
    resultList.appendChild(resultEmpty);
    return;
  }

  // 非空：隐藏空状态，渲染结果卡片
  resultEmpty.style.display = 'none';
  resultList.innerHTML = '';

  results.forEach((result) => {
    const card = document.createElement('div');
    card.className = 'result-card';
    // 结果卡片 HTML：成功图标 + 文件名/大小 + 打开/保存按钮
    card.innerHTML = `
      <div class="result-card-header">
        <div class="result-card-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </div>
        <div class="result-card-info">
          <div class="result-card-name">${result.name}</div>
          <div class="result-card-size">${formatSize(result.size)} · ${FORMAT_LABELS[result.format] || result.format.toUpperCase()}</div>
          <div class="result-card-path" title="${result.path || ''}">${result.dir || ''}</div>
        </div>
      </div>
      <div class="result-card-actions">
        <!-- 图片类结果可预览（新增功能 2） -->
        <button class="result-card-btn" data-action="preview" data-id="${result.id}" ${['png','jpg','jpeg','webp','bmp','gif','ico','tiff','heic'].includes(result.format) ? '' : 'hidden'}>预览</button>
        <button class="result-card-btn" data-action="open" data-id="${result.id}">打开</button>
        <button class="result-card-btn" data-action="save" data-id="${result.id}">保存</button>
      </div>
    `;
    resultList.appendChild(card);
  });

  // 绑定结果卡片按钮点击事件
  resultList.querySelectorAll('.result-card-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;   // 操作类型：open / save
      const id = parseInt(btn.dataset.id);
      const result = results.find((r) => r.id === id);

      // 真实模式：打开文件 / 在资源管理器中显示 / 预览；浏览器调试时退化为提示
      if (action === 'preview') {
        // 结果预览：对输出文件生成预览图（复用预览模态框）
        if (result.path && window.electronAPI?.getPreview) {
          resetPreviewModal();
          openPreviewModal();
          window.electronAPI.getPreview({ inputPath: result.path, feature: 'image', targetFormat: result.format, options: {} })
            .then(displayPreviewData)
            .catch((err) => {
              $('preview-spinner').hidden = true;
              $('preview-result-text').textContent = '预览失败';
              previewInfo.textContent = err.message || '预览生成失败';
            });
        } else {
          showToast('（调试模式）预览：' + result.name, 'info');
        }
      } else if (action === 'open') {
        if (result.path && window.electronAPI?.openPath) {
          window.electronAPI.openPath(result.path);
        } else {
          showToast('（调试模式）打开：' + result.name, 'info');
        }
      } else if (action === 'save') {
        // 真正的"另存为"：系统保存对话框选择位置后复制文件；取消/失败有明确反馈
        if (result.path && window.electronAPI?.saveAs) {
          window.electronAPI.saveAs({
            sourcePath: result.path,
            suggestedName: result.name,
            defaultDir: outputDir || undefined, // 自定义输出目录优先作为默认位置
          })
            .then((saved) => {
              if (saved) showToast('已保存到：' + saved, 'success', 4000);
            })
            .catch((err) => showToast('保存失败：' + err.message, 'error', 4000));
        } else if (result.path && window.electronAPI?.showInFolder) {
          // 降级：无保存对话框能力时在资源管理器中显示
          window.electronAPI.showInFolder(result.path);
        } else {
          showToast('（调试模式）保存：' + result.name, 'info');
        }
      }
    });
  });
}

// ============================================================
// 初始化：页面加载完成后执行
// ============================================================
updateFeatureUI();   // 初始化功能界面（标题、格式下拉框）
renderFileList();    // 初始化文件列表（空状态）
renderResults();     // 初始化结果列表（空状态）
registerConversionListeners(); // 注册主进程事件推送（真实模式）
refreshFormatsFromMain();      // 真实模式下用主进程支持清单刷新下拉框
refreshEngineStatus();         // 底部状态栏显示引擎就绪情况
registerOpenFiles();           // 右键菜单文件接收（启动携带 + 二次实例转发）
// 恢复上次选择的输出目录（localStorage 持久化；null = 默认）
outputDir = localStorage.getItem('luren-output-dir') || null;
renderOutputDir();             // 输出目录显示
