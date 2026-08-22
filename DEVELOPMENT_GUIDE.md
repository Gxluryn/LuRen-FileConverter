# LuRen FileConverter 开发指南

> 本文档是项目剩余模块的完整开发需求，供 AI 编程助手（DeepSeek Harness / openclaw 等）读取并按顺序实现。
> 每个模块包含：功能概述、依赖、函数规范、实现要点、注意事项、验证方法。

---

## 一、项目概述

**项目名称**：LuRen FileConverter
**项目定位**：完全离线的 Windows 桌面文件格式转换工具
**核心功能**：文档转换、图片转换、音视频转换、PDF 处理、扫描件模拟、OCR 识别、批量转换
**技术栈**：Electron + Node.js + Sharp + 本地开源引擎（FFmpeg/LibreOffice/Poppler/Tesseract）

---

## 二、技术栈与依赖

### 已安装的 npm 依赖
- **electron**（dev）：桌面应用框架
- **express**：本地 HTTP 服务（可选）
- **multer**：文件上传（可选）
- **sharp**：高性能图像处理
- **pdf-lib**：PDF 创建、编辑、合并、加密
- **pdfjs-dist**：PDF 文本提取
- **mammoth**：DOCX 转 HTML/文本
- **docx**：生成 Word 文档
- **exceljs**：生成 Excel 表格
- **turndown**：HTML 转 Markdown
- **marked**：Markdown 转 HTML
- **fluent-ffmpeg**：FFmpeg 封装（可选，也可直接子进程调用）
- **sanitize-filename**：文件名清理
- **yauzl / yazl**：ZIP 解压/压缩
- **js-yaml**：YAML 处理
- **csv-parse**：CSV 解析
- **mime-types**：MIME 类型判断
- **heic-convert**：HEIC 图片转换

### 本地引擎（bin 目录）
- **FFmpeg**：`bin/ffmpeg/ffmpeg.exe` — 音视频/图片编码
- **LibreOffice Portable**：`bin/libreoffice/LibreOfficePortable/LibreOfficePortable.exe` — 办公文档互转
- **Poppler**：`bin/poppler/Library/bin/pdftoppm.exe`、`pdfinfo.exe` — PDF 渲染（注意：真正的 exe 在 Library/bin 下，不是 bin/ 下的 .cmd）
- **Tesseract**：`bin/tesseract/tesseract.exe` — OCR 文字识别
- **Tessdata**：`bin/tesseract/tessdata/` — OCR 语言包（chi_sim.traineddata、eng.traineddata）
- **AVS3**：`bin/avs3/avs3RM0Decoder.exe` — AVS3 音频解码

---

## 三、现有文件说明

以下文件已经写好，**不要修改**，新模块需要引用它们：

| 文件路径 | 功能 | 导出 |
|---|---|---|
| `src/main/index.js` | Electron 主进程入口，创建窗口、窗口控制 IPC | 无（主进程） |
| `src/main/engines.js` | 引擎路径管理，统一管理所有本地引擎路径 | `ENGINES`, `BIN_DIR`, `checkEngines()`, `getEngine(name)` |
| `src/preload/preload.js` | 预加载脚本，暴露窗口控制 API | `window.electronAPI` |
| `src/renderer/index.html` | 前端页面结构（三栏布局） | 无 |
| `src/renderer/style.css` | 前端样式（浅色主题） | 无 |
| `src/renderer/app.js` | 前端交互逻辑（目前转换是模拟的，后续需替换为真实 IPC） | 无 |

### engines.js 使用示例
```javascript
const { getEngine, ENGINES, checkEngines } = require('./engines');
// 获取引擎路径（不存在会抛错）
const ffmpegPath = getEngine('ffmpeg');
// 直接访问所有路径
const tesseractPath = ENGINES.tesseract;
// 检查所有引擎
const { missing, available } = checkEngines();
```

---

## 四、目录结构

```
LuRen-FileConverter/
├── bin/                          # 转换引擎（git 忽略）
├── src/
│   ├── main/                     # 主进程 / 后端逻辑
│   │   ├── index.js              # ✅ 已完成：Electron 入口
│   │   ├── engines.js            # ✅ 已完成：引擎路径管理
│   │   ├── converter.js          # ⏳ 待开发：转换调度核心（最后写）
│   │   ├── scan-effect.js        # ⏳ 待开发：扫描件模拟效果
│   │   ├── converters/           # 各格式转换器
│   │   │   ├── image.js          # ⏳ 待开发：图片转换
│   │   │   ├── media.js          # ⏳ 待开发：音视频转换
│   │   │   ├── document.js       # ⏳ 待开发：文档转换
│   │   │   ├── pdf.js            # ⏳ 待开发：PDF 处理
│   │   │   └── ocr.js            # ⏳ 待开发：OCR 识别
│   │   └── utils/                # 工具函数
│   │       ├── process.js        # ⏳ 待开发：子进程调用封装（最先写）
│   │       ├── file.js           # ⏳ 待开发：文件操作工具
│   │       └── logger.js         # ⏳ 待开发：日志工具
│   ├── preload/
│   │   └── preload.js            # ✅ 已完成
│   └── renderer/                 # 前端界面
│       ├── index.html            # ✅ 已完成
│       ├── style.css             # ✅ 已完成
│       └── app.js                # ⏳ 待修改：对接真实 IPC（最后改）
├── package.json
├── .gitignore
├── README.md
└── DEVELOPMENT_GUIDE.md          # 本文件
```

---

## 五、开发顺序（必须按此顺序）

按依赖关系排序，前一个模块是后一个的基础：

| 顺序 | 模块 | 文件路径 | 优先级 |
|---|---|---|---|
| 1 | 子进程调用工具 | `src/main/utils/process.js` | 最高（所有引擎调用依赖它） |
| 2 | 文件操作工具 | `src/main/utils/file.js` | 高 |
| 3 | 日志工具 | `src/main/utils/logger.js` | 中（可选但建议） |
| 4 | 图片转换 | `src/main/converters/image.js` | 高（最简单，练手验证） |
| 5 | 音视频转换 | `src/main/converters/media.js` | 高 |
| 6 | 文档转换 | `src/main/converters/document.js` | 高 |
| 7 | PDF 处理 | `src/main/converters/pdf.js` | 高 |
| 8 | OCR 识别 | `src/main/converters/ocr.js` | 中 |
| 9 | 扫描件模拟 | `src/main/scan-effect.js` | 中（最复杂） |
| 10 | 转换调度核心 | `src/main/converter.js` | 高（串联所有模块） |
| 11 | 前端 IPC 对接 | 修改 `src/renderer/app.js` + `src/main/index.js` | 高（最后做） |

**每个模块写好后必须用对应的验证方法测试通过，再写下一个。**

---

## 六、通用开发规范

所有模块必须遵守以下规范：

1. **路径处理**：所有路径使用 `path.join()` 拼接，禁止字符串拼接；禁止硬编码绝对路径。
2. **子进程调用**：必须使用 `utils/process.js` 的 `runEngine()` 或 `runCommand()`，禁止直接使用 `child_process`。
3. **异步编程**：所有 I/O 操作使用 `async/await`，禁止同步阻塞方法（除了启动时的一次性检查）。
4. **错误处理**：所有异步函数必须有 try-catch，错误信息要包含上下文（哪个文件、哪个操作）。
5. **临时文件**：使用系统临时目录（`os.tmpdir()`），必须在 `finally` 中清理。
6. **中文路径**：必须正确处理中文和空格路径（`execFile` 天然支持，不要用 `exec`）。
7. **日志记录**：关键操作（转换开始、完成、失败）使用 `utils/logger.js` 记录。
8. **模块导出**：使用 `module.exports = { ... }`，导出函数名使用小驼峰。
9. **代码注释**：每个函数必须有 JSDoc 注释（参数、返回值、功能），复杂逻辑有行内注释。
10. **引擎路径**：从 `engines.js` 获取，禁止在代码中硬编码引擎路径。

---

## 七、各模块详细需求

---

### 模块 1：子进程调用工具

**文件路径**：`src/main/utils/process.js`
**依赖**：Node.js 内置 `child_process`（用 `execFile`，禁止用 `exec`）、`src/main/engines.js`

#### 需要实现的函数

**1. `runCommand(executablePath, args, options)` → `Promise<{stdout, stderr, code}>`**
- 功能：异步执行命令行程序
- 参数：
  - `executablePath`：string，可执行文件绝对路径
  - `args`：string[]，命令参数数组（每个参数单独一个元素，不要拼接成字符串）
  - `options`：object，可选：
    - `cwd`：string，工作目录
    - `timeout`：number，超时毫秒，默认 60000（1分钟）
    - `maxBuffer`：number，最大输出缓冲区，默认 10*1024*1024（10MB）
    - `env`：object，环境变量
- 返回：Promise，resolve 时返回 `{ stdout, stderr, code }`
- 错误处理：非0退出码或超时，reject Error（错误信息包含命令、参数、stderr）
- 注意：超时后必须 kill 子进程，避免僵尸进程

**2. `runEngine(engineName, args, options)` → `Promise<{stdout, stderr, code}>`**
- 功能：通过引擎名称调用，内部从 `engines.js` 获取路径
- 参数：`engineName` 是 ENGINES 对象的键名（如 `'ffmpeg'`、`'tesseract'`、`'pdftoppm'`）
- 内部调用 `runCommand(getEngine(engineName), args, options)`
- 引擎不存在时直接抛出错误

#### 导出
```javascript
module.exports = { runCommand, runEngine }
```

#### 验证方法
```bash
node -e "const { runEngine } = require('./src/main/utils/process'); runEngine('pdfinfo', ['--help']).then(r => console.log('成功:', r.stdout.substring(0,100))).catch(e => console.error('失败:', e.message))"
```

---

### 模块 2：文件操作工具

**文件路径**：`src/main/utils/file.js`
**依赖**：Node.js 内置 `fs`、`path`、`os`；npm 包 `sanitize-filename`

#### 需要实现的函数

1. **`createTempDir(prefix)` → string**：创建临时目录，默认前缀 `'luren-convert-'`，用 `fs.mkdtempSync(path.join(os.tmpdir(), prefix))`
2. **`cleanupTempDir(dirPath)` → void**：递归删除临时目录，失败只打印警告不抛异常
3. **`sanitizeFileName(name)` → string**：清理文件名，调用 `sanitize-filename`
4. **`formatFileSize(bytes)` → string**：字节转友好显示（B/KB/MB/GB，保留1位小数）
5. **`getFileExtension(filePath)` → string**：获取小写扩展名（不含点）
6. **`replaceExtension(filePath, newExt)` → string**：替换扩展名
7. **`ensureDir(dirPath)` → void**：确保目录存在，`fs.mkdirSync(dirPath, { recursive: true })`
8. **`generateOutputPath(inputPath, targetFormat, outputDir)` → string**：生成输出路径，文件重名时加 `(1)`、`(2)` 避免覆盖

#### 导出
```javascript
module.exports = { createTempDir, cleanupTempDir, sanitizeFileName, formatFileSize, getFileExtension, replaceExtension, ensureDir, generateOutputPath }
```

#### 验证方法
```bash
node -e "const f = require('./src/main/utils/file'); console.log('格式化:', f.formatFileSize(1536)); console.log('扩展名:', f.getFileExtension('test.PDF')); console.log('替换:', f.replaceExtension('/a/b/c.docx', 'pdf')); console.log('清理:', f.sanitizeFileName('my:file*name?.pdf'));"
```

---

### 模块 3：日志工具

**文件路径**：`src/main/utils/logger.js`
**依赖**：Node.js 内置 `fs`、`path`、`os`

#### 需要实现的对象

`logger` 对象，包含：
- `logger.info(...args)`：绿色 `[INFO]` 标签
- `logger.warn(...args)`：黄色 `[WARN]` 标签
- `logger.error(...args)`：红色 `[ERROR]` 标签，Error 对象包含堆栈
- `logger.debug(...args)`：灰色 `[DEBUG]` 标签，仅 debug 级别输出
- `logger.setLevel(level)`：设置级别（`'debug'/'info'/'warn'/'error'`），默认 `'info'`

日志格式：`[YYYY-MM-DD HH:mm:ss] [级别] 消息`
日志文件：`path.join(os.tmpdir(), 'luren-fileconverter.log')`，追加写入，文件输出不带颜色码

#### 导出
```javascript
module.exports = logger
```

---

### 模块 4：图片转换

**文件路径**：`src/main/converters/image.js`
**依赖**：npm 包 `sharp`；`src/main/utils/file.js`；`src/main/utils/logger.js`

#### 支持格式
- 输入：jpg, jpeg, png, webp, gif, bmp, tiff, heic, ico, svg
- 输出：jpg, png, webp, gif, bmp, tiff, heic, ico

#### 需要实现的函数

1. **`convertImage(inputPath, outputPath, options)` → `Promise<string>`**
   - 使用 sharp 链式调用：`.resize()`（如指定尺寸）→ `.toFormat()`（根据输出扩展名）→ `.toFile(outputPath)`
   - options：`quality`（默认90）、`width`、`height`、`fit`（默认 `'inside'`）
   - 输出格式从 outputPath 扩展名推断，用 `file.getFileExtension()`
   - GIF 输出设置 `{ animated: true }`；ICO 输出尺寸限制 256x256 以内

2. **`getSupportedFormats()` → `{ input: string[], output: string[] }`**

3. **`isSupported(inputExt, outputExt)` → boolean**

#### 导出
```javascript
module.exports = { convertImage, getSupportedFormats, isSupported }
```

#### 验证方法
准备 test.png，执行：
```bash
node -e "const { convertImage } = require('./src/main/converters/image'); convertImage('test.png', 'test-output.jpg', {quality: 80}).then(p => console.log('成功:', p)).catch(e => console.error('失败:', e.message))"
```

---

### 模块 5：音视频转换

**文件路径**：`src/main/converters/media.js`
**依赖**：`src/main/utils/process.js`（用 `runEngine('ffmpeg', args)`）；`src/main/utils/file.js`；`src/main/utils/logger.js`

#### 支持格式
- 音频输入：mp3, wav, flac, m4a, aac, ogg, wma, opus
- 音频输出：mp3, wav, flac, m4a, aac, ogg, opus
- 视频输入：mp4, mkv, avi, mov, wmv, flv, webm
- 视频输出：mp4, mkv, avi, mov, webm, gif

#### 需要实现的函数

1. **`convertMedia(inputPath, outputPath, options)` → `Promise<string>`**
   - FFmpeg 命令：`ffmpeg -y -i inputPath [选项] outputPath`
   - options：`audioBitrate`（默认 `'192k'`）、`audioCodec`、`videoCodec`（默认 `'libx264'`）、`videoBitrate`、`quality`、`startTime`、`duration`、`width`、`height`
   - 大文件 timeout 设置 600000ms（10分钟）
   - FFmpeg 输出在 stderr（不是 stdout），注意解析错误信息

2. **`getMediaInfo(inputPath)` → `Promise<object>`**
   - 用 `ffmpeg -i inputPath` 解析 stderr 中的信息
   - 返回：`{ duration, format, videoCodec, audioCodec, width, height, bitrate }`

3. **`getSupportedFormats()` → `{ audioInput, audioOutput, videoInput, videoOutput }`**

4. **`isSupported(inputExt, outputExt)` → boolean**

#### 导出
```javascript
module.exports = { convertMedia, getMediaInfo, getSupportedFormats, isSupported }
```

#### 验证方法
准备 test.mp3，执行：
```bash
node -e "const { convertMedia } = require('./src/main/converters/media'); convertMedia('test.mp3', 'test-output.wav').then(p => console.log('成功:', p)).catch(e => console.error('失败:', e.message))"
```

---

### 模块 6：文档转换

**文件路径**：`src/main/converters/document.js`
**依赖**：`src/main/utils/process.js`（`runEngine('libreoffice', args)`）；`src/main/utils/file.js`；`src/main/utils/logger.js`；npm 包 `mammoth`

#### 支持格式
- 输入：doc, docx, xls, xlsx, ppt, pptx, pdf, txt, rtf, odt, ods, odp, html
- 输出：pdf, docx, xlsx, pptx, txt, html, odt, ods, odp, rtf

#### 需要实现的函数

1. **`convertDocument(inputPath, outputPath, options)` → `Promise<string>`**
   - LibreOffice 命令：`LibreOfficePortable.exe --headless --convert-to <格式> --outdir <输出目录> <输入文件>`
   - 输出目录是 outputPath 的父目录，LibreOffice 自动生成文件名
   - 转换完成后检查输出文件是否存在，如文件名不一致则重命名为 outputPath
   - LibreOffice 不支持并发，批量转换必须串行

2. **`convertDocxToHtml(inputPath)` → `Promise<string>`**
   - 用 mammoth：`mammoth.convertToHtml({ path: inputPath })`

3. **`convertDocxToText(inputPath)` → `Promise<string>`**

4. **`batchConvert(inputPaths, outputDir, targetFormat)` → `Promise<string[]>`**
   - 串行调用 convertDocument（LibreOffice 不支持并发）

5. **`getSupportedFormats()` → `{ input: string[], output: string[] }`**

6. **`isSupported(inputExt, outputExt)` → boolean**

#### 导出
```javascript
module.exports = { convertDocument, convertDocxToHtml, convertDocxToText, batchConvert, getSupportedFormats, isSupported }
```

#### 注意事项
- LibreOffice 首次启动较慢（10-30秒），后续调用会快
- 中文路径通过 process.js 的 execFile 已正确处理
- 扫描版 PDF 转文档可能效果差（需要 OCR）

#### 验证方法
准备 test.docx，执行：
```bash
node -e "const { convertDocument } = require('./src/main/converters/document'); convertDocument('test.docx', 'test-output.pdf').then(p => console.log('成功:', p)).catch(e => console.error('失败:', e.message))"
```

---

### 模块 7：PDF 处理

**文件路径**：`src/main/converters/pdf.js`
**依赖**：`src/main/utils/process.js`（调用 pdftoppm/pdfinfo）；`src/main/utils/file.js`；`src/main/utils/logger.js`；npm 包 `pdf-lib`、`pdfjs-dist`

#### 需要实现的函数

1. **`getPdfInfo(inputPath)` → `Promise<object>`**
   - 调用 `pdfinfo inputPath`，解析输出
   - 返回：`{ pages, pageSize, encrypted, creator, creationDate, modDate }`

2. **`pdfToImages(inputPath, outputDir, options)` → `Promise<string[]>`**
   - 调用 `pdftoppm -png -r 150 input.pdf output_prefix`
   - options：`format`（`'png'|'jpg'|'tiff'`）、`dpi`（默认150）、`firstPage`、`lastPage`
   - pdftoppm 输出文件名格式 `prefix-1.png`，注意解析收集

3. **`extractText(inputPath)` → `Promise<string>`**
   - 用 pdfjs-dist（Node.js 中用 `require('pdfjs-dist/legacy/build/pdf')`）
   - 设置 worker：`pdfjsLib.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.entry')`
   - 逐页提取文字拼接

4. **`splitPdf(inputPath, outputDir, options)` → `Promise<string[]>`**
   - options：`mode`（`'perPage'` 每页一个 / `'range'` 按范围）、`ranges`（如 `[[1,3],[4,5]]`）
   - 用 pdf-lib 复制页面到新文档

5. **`mergePdfs(inputPaths, outputPath)` → `Promise<string>`**
   - 用 pdf-lib 将多个文档页面复制到一个新文档

6. **`encryptPdf(inputPath, outputPath, password)` → `Promise<string>`**
   - pdf-lib 保存时 `{ encrypt: { userPassword: password, ownerPassword: password } }`

7. **`decryptPdf(inputPath, outputPath, password)` → `Promise<string>`**
   - 加载时传入密码，保存时不加密

8. **`pdfToTextFile(inputPath, outputPath)` → `Promise<string>`**

#### 导出
```javascript
module.exports = { getPdfInfo, pdfToImages, extractText, splitPdf, mergePdfs, encryptPdf, decryptPdf, pdfToTextFile }
```

#### 注意事项
- pdf-lib 处理大 PDF（几百页）可能占用大量内存，注意分批
- pdfjs-dist 对扫描版 PDF 提取文字无效（需要 OCR）
- 加密 PDF 后提醒用户记住密码

#### 验证方法
准备 test.pdf，执行：
```bash
node -e "const { getPdfInfo } = require('./src/main/converters/pdf'); getPdfInfo('test.pdf').then(info => console.log('信息:', info)).catch(e => console.error('失败:', e.message))"
```

---

### 模块 8：OCR 识别

**文件路径**：`src/main/converters/ocr.js`
**依赖**：`src/main/utils/process.js`（调用 tesseract）；`src/main/utils/file.js`；`src/main/utils/logger.js`；`src/main/converters/pdf.js`（PDF 转图片）

#### 需要实现的函数

1. **`recognizeImage(imagePath, options)` → `Promise<string>`**
   - Tesseract 命令：`tesseract imagePath stdout -l chi_sim+eng --psm 3 --oem 1 --tessdata-dir "tessdata路径"`
   - options：`lang`（默认 `'chi_sim+eng'`）、`psm`（默认3，全自动分割）、`oem`（默认1，LSTM）
   - 输出到 stdout（第二个参数用 stdout）
   - tessdata 路径从 `ENGINES.tessdata` 获取

2. **`recognizePdf(pdfPath, options)` → `Promise<string>`**
   - 先调用 `pdf.pdfToImages` 将 PDF 每页转为临时图片（DPI 默认200）
   - 逐页调用 recognizeImage
   - 拼接所有页文字（页之间加分页符）
   - 在 finally 中清理临时图片
   - options 额外：`dpi`、`firstPage`、`lastPage`

3. **`recognizeToFile(inputPath, outputPath, options)` → `Promise<string>`**

4. **`getSupportedLanguages()` → string[]**
   - 读取 tessdata 目录下的 `.traineddata` 文件名

#### 导出
```javascript
module.exports = { recognizeImage, recognizePdf, recognizeToFile, getSupportedLanguages }
```

#### 注意事项
- 中文识别需要 `chi_sim.traineddata`，确认已存在
- Tesseract 不支持并发，批量识别串行
- 大图片识别 timeout 设置 120000ms
- 识别结果可做后处理（trim、合并连续空行）

#### 验证方法
准备 test.png（含文字），执行：
```bash
node -e "const { recognizeImage } = require('./src/main/converters/ocr'); recognizeImage('test.png', {lang: 'chi_sim+eng'}).then(text => console.log('结果:', text.substring(0,200))).catch(e => console.error('失败:', e.message))"
```

---

### 模块 9：扫描件模拟效果

**文件路径**：`src/main/scan-effect.js`
**依赖**：npm 包 `sharp`、`pdf-lib`；`src/main/converters/pdf.js`；`src/main/converters/document.js`；`src/main/utils/file.js`；`src/main/utils/logger.js`

#### 处理流程
1. 输入非 PDF → 先调 `document.convertDocument` 转临时 PDF
2. 调 `pdf.pdfToImages` 将 PDF 每页转 PNG（DPI 200）
3. 每页用 sharp 应用扫描效果（旋转角度每页随机不同）
4. 用 pdf-lib 将处理后的 JPEG 合并为纯图片 PDF
5. 清理临时文件

#### 需要实现的函数

1. **`applyScanEffect(imagePath, outputPath, options)` → `Promise<string>`**
   - sharp 链式处理：
     a. `.rotate(angle, { background: tint })` — 随机旋转（默认0.3-1.2°），背景填充纸张色
     b. `.blur(sigma)` — 高斯模糊（默认0.4）
     c. `.modulate({ brightness })` — 亮度（默认0.92）
     d. `.tint({ r:245, g:240, b:230 })` — 米白色偏
     e. 叠加噪点图层（composite overlay）
     f. 叠加暗角图层（composite）
     g. `.jpeg({ quality: 70 })` — 输出
   - options：`rotation`（不指定则随机）、`blur`（默认0.4）、`noise`（默认0.08）、`brightness`（默认0.92）、`tint`（默认`'#f5f0e6'`）、`vignette`（默认0.15）、`jpegQuality`（默认70）

2. **`generateNoise(width, height, intensity)` → Buffer**
   - 生成随机噪点 PNG Buffer（raw 模式创建 RGBA buffer，alpha 随机）

3. **`generateVignette(width, height, intensity)` → Buffer**
   - 生成径向渐变暗角 PNG Buffer（中心透明，边缘黑色半透明）

4. **`convertToScannedPdf(inputPath, outputPath, options)` → `Promise<string>`**
   - 完整流程：转PDF → 转图片 → 逐页扫描效果 → 合并PDF → 清理临时
   - options 同 applyScanEffect，额外 `dpi`（默认200）

5. **`getEffectPresets()` → object**
   - 返回预设：`light`（轻度）、`normal`（标准，默认参数）、`heavy`（重度）、`oldPhoto`（老照片）

#### 导出
```javascript
module.exports = { applyScanEffect, convertToScannedPdf, getEffectPresets, generateNoise, generateVignette }
```

#### 注意事项
- **每页旋转角度必须随机不同**，不能所有页效果一样
- 最终输出必须是纯图片 PDF（pdf-lib 图片嵌入天然就是纯图片）
- 大文档处理慢，建议分批
- 临时文件必须在 finally 中清理
- sharp composite 叠加顺序：先旋转模糊，再叠加噪点和暗角
- 纸张色 tint 作为旋转背景色，避免旋转后白边

#### 验证方法
准备 test.pdf 或 test.png，执行：
```bash
node -e "const { convertToScannedPdf } = require('./src/main/scan-effect'); convertToScannedPdf('test.pdf', 'test-scanned.pdf').then(p => console.log('成功:', p)).catch(e => console.error('失败:', e.message))"
```

---

### 模块 10：转换调度核心

**文件路径**：`src/main/converter.js`
**依赖**：所有 converters 模块 + scan-effect + utils

#### 需要实现的类和函数

1. **`class ConversionTask`**
   - 属性：`id`, `inputPath`, `outputPath`, `format`, `status`（`pending`/`processing`/`done`/`failed`）, `progress`（0-100）, `error`, `createdAt`
   - 方法：`start()` → Promise、`cancel()`、`onProgress(callback)`

2. **`class ConversionQueue`**
   - 并发控制（默认并发数2）
   - 方法：`addTask(task)` → taskId、`cancelTask(taskId)`、`getStatus(taskId)`、`on(event, callback)`（事件：`taskStart`/`taskProgress`/`taskComplete`/`taskError`/`queueEmpty`）、`start()`、`pause()`、`getQueueInfo()`

3. **`convertFile(inputPath, targetFormat, outputDir, options)` → `Promise<{outputPath, taskId}>`**
   - 根据输入扩展名和目标格式路由到对应转换器
   - 生成输出路径，创建任务加入队列

4. **`batchConvert(inputPaths, targetFormat, outputDir, options)` → `Promise<string[]>`**

5. **`getConverterForFormat(inputExt, outputExt)` → `{ converter, convertFn, type }`**
   - 路由规则：
     - 图片格式 → image.convertImage
     - 音视频格式 → media.convertMedia
     - 文档格式 → document.convertDocument
     - PDF→图片 → pdf.pdfToImages
     - PDF→文档 → document.convertDocument
     - 目标扫描件PDF → scanEffect.convertToScannedPdf
     - 图片/PDF→txt → ocr.recognizeToFile

6. **`registerIpcHandlers(ipcMain, mainWindow)`**
   - 注册 IPC 通道：
     - `'convert:start'`：开始转换
     - `'convert:cancel'`：取消转换
     - `'convert:status'`：查询状态
     - `'convert:batch'`：批量转换
     - `'formats:supported'`：获取支持格式
   - 进度推送：`mainWindow.webContents.send('convert:progress', { taskId, progress })`
   - 完成推送：`mainWindow.webContents.send('convert:complete', { taskId, outputPath })`
   - 错误推送：`mainWindow.webContents.send('convert:error', { taskId, error })`

#### 导出
```javascript
module.exports = { ConversionTask, ConversionQueue, convertFile, batchConvert, getConverterForFormat, registerIpcHandlers }
```

#### 注意事项
- LibreOffice 和 Tesseract 不支持并发，图片转换可以并发
- registerIpcHandlers 在主进程 index.js 中调用，传入 ipcMain 和 mainWindow
- 大文件转换实时推送进度
- 转换失败保留错误信息

#### 验证方法
```bash
# 测试格式路由
node -e "const { getConverterForFormat } = require('./src/main/converter'); console.log('png→jpg:', getConverterForFormat('png','jpg').type); console.log('mp3→wav:', getConverterForFormat('mp3','wav').type); console.log('docx→pdf:', getConverterForFormat('docx','pdf').type);"
```

---

### 模块 11：前端 IPC 对接（修改现有文件）

**需要修改的文件**：
1. `src/main/index.js` — 在 app.whenReady 中调用 `converter.registerIpcHandlers(ipcMain, mainWindow)`
2. `src/renderer/app.js` — 将模拟转换替换为真实 IPC 调用

#### 修改 src/main/index.js
- 在文件顶部引入：`const { registerIpcHandlers } = require('./converter')`
- 在 createWindow 函数中，mainWindow 创建后调用：`registerIpcHandlers(ipcMain, mainWindow)`

#### 修改 src/renderer/app.js
1. **添加 IPC 通信封装**（检查 window.electronAPI 是否存在，不存在则用模拟模式 fallback）
2. **修改 btnConvert 点击事件**：调用真实 convertFile，通过 IPC 事件监听实时更新进度条，完成后添加到结果列表
3. **修改文件上传**：保存 `file.path`（Electron 的 File 对象有 path 属性）到 files 数组
4. **添加获取支持格式**：调用 IPC 获取格式列表，导航切换时更新下拉框
5. **保留模拟模式**：window.electronAPI 不存在时（浏览器调试）使用原模拟逻辑

#### 注意事项
- 所有 IPC 调用要有 try-catch
- 进度更新要防抖，避免频繁重渲染
- 转换过程中禁用转换按钮，完成后恢复
- 错误信息友好显示给用户

---

## 八、完成后的整体验证

所有模块完成后，执行以下整体验证：

1. **启动应用**：`npm start`，确认窗口正常显示
2. **引擎检查**：在控制台执行 `node -e "const { checkEngines } = require('./src/main/engines'); console.log(checkEngines())"`，确认无缺失
3. **图片转换**：拖入一张 PNG，转 JPG，确认成功
4. **文档转换**：拖入 DOCX，转 PDF，确认成功（LibreOffice 首次较慢）
5. **PDF 处理**：拖入 PDF，查看信息、拆分、合并
6. **OCR 识别**：拖入含文字的图片，转 TXT，确认识别结果
7. **扫描件模拟**：拖入 PDF，转扫描件 PDF，确认效果
8. **批量转换**：同时拖入多个文件，批量转换

---

## 九、常见问题排查

| 问题 | 可能原因 | 解决方案 |
|---|---|---|
| 引擎不存在报错 | bin 目录引擎缺失 | 检查 bin 目录结构，参考 engines.js 中的路径 |
| LibreOffice 转换失败 | 首次启动慢 / 路径有中文 | 增加 timeout，确认路径无中文 |
| FFmpeg 转换无输出 | 参数错误 | 检查 args 数组，每个参数单独元素 |
| Tesseract 中文乱码 | 缺少语言包 | 确认 tessdata 目录有 chi_sim.traineddata |
| Poppler 调用失败 | 用了 .cmd 而不是 .exe | 使用 Library/bin 下的 exe，不是 bin/ 下的 .cmd |
| 大文件内存溢出 | 一次性加载全部 | 分批处理，分页处理 PDF |
| 并发转换崩溃 | LibreOffice/Tesseract 不支持并发 | 转换调度核心中限制并发数 |

---

> **文档结束**。按模块顺序逐个实现，每个模块验证通过后再进行下一个。

---

## 十、实现完成记录（2026-08-22）

11 个模块已全部按本文档顺序实现，**每个模块都用本文档的验证方法实测通过后再进入下一个**。新增/修改文件：

| 文件 | 状态 |
|---|---|
| `src/main/utils/process.js` | ✅ 新增（runCommand/runEngine，含超时进程树清理） |
| `src/main/utils/file.js` | ✅ 新增（8 个文件工具函数） |
| `src/main/utils/logger.js` | ✅ 新增（分级日志，控制台彩色 + 文件 UTF-8） |
| `src/main/converters/image.js` | ✅ 新增（sharp 主力；bmp 走 ffmpeg、ico 容器封装、heic av1） |
| `src/main/converters/media.js` | ✅ 新增（ffmpeg 参数编排，音频/视频/GIF/裁剪/缩放） |
| `src/main/converters/document.js` | ✅ 新增（LibreOffice + mammoth，串行批量） |
| `src/main/converters/pdf.js` | ✅ 新增（信息/转图/提取/拆分/合并/加解密/转文本） |
| `src/main/converters/pdf-crypto.js` | ✅ 新增（自研 ISO 32000 标准安全处理器，R4 AES-128 + R2/3 RC4） |
| `src/main/converters/pdf-structure.js` | ✅ 新增（经典 xref 解析/流加解密/重建） |
| `src/main/converters/ocr.js` | ✅ 新增（tesseract 中英文识别、PDF 逐页 OCR） |
| `src/main/scan-effect.js` | ✅ 新增（随机倾斜/模糊/噪点/色温/暗角/JPEG） |
| `src/main/converter.js` | ✅ 新增（任务队列/路由/IPC 注册） |
| `src/main/index.js` | ✅ 修改（注册转换 IPC + 文件/引擎 IPC） |
| `src/preload/preload.js` | ✅ 修改（暴露转换/文件 API） |
| `src/renderer/app.js` | ✅ 修改（真实 IPC 转换 + 保留浏览器模拟模式） |
| `src/renderer/style.css` | ✅ 修改（failed/warn 状态样式） |

### 关键实现说明与验证结论

- **PDF 加密/解密为自研实现**：实测 pdf-lib 1.17.1 的 save({encrypt}) 为空转、LibreOffice headless 过滤器选项被忽略，故按 ISO 32000-1 7.6 节规范实现（算法 1-7），并用 pdfjs / poppler / pypdf 三个独立解码器交叉验证：加密文件 poppler 显示 Encrypted: yes (algorithm:AES)、pdfjs 无密码拒绝打开、pypdf 生成的 R4-AES 与 R3-RC4 参考文件可成功解密。
- **已知限制（如实声明）**：PDF 解密仅支持经典 xref 结构（xref stream 结构的加密 PDF 会给出明确错误）；取消任务仅对排队中任务生效（正在运行的子进程转换无法中途终止）。
- **测试中修复的真实 bug**（示例）：LibreOffice 输出的 txt 中文乱码（需显式 UTF-8 过滤器）；sharp 不支持 bmp/ico/heic 输出的探测与替代路径；队列并发触发时串行任务被重复调度（加 _scheduled 标记）；输出目录未创建导致转换失败等。
---

## 十一、新增功能记录（2026-08-22）

在基础模块之上新增三项功能（沿用原 16 条开发要求）：

### 功能 1：自选转换文件保存位置
- 前端操作栏新增「输出位置」选择器（显示当前目录 + 选择…/默认按钮），选择结果存 localStorage 下次启动沿用
- 主进程 `dialog:select-directory`（系统目录对话框）；`convert:start` 载荷携带 `outputDir`
- 相关文件：`src/main/index.js`（IPC）、`src/renderer/index.html`、`src/renderer/app.js`、`src/preload/preload.js`

### 功能 2：转换效果预览
- 主进程 `src/main/preview.js` 预览服务：真实调用转换管线生成预览图（图片转换 / 扫描件模拟 / PDF 转图首页），不支持的类型如实返回说明
- 前端「预览」按钮 + 模态框（原图 → 转换效果左右对比）；图片类转换结果卡片也可直接预览
- IPC 通道：`preview:get`；临时文件 finally 清理，无残留

### 功能 3：鼠标右键选中文件转换（Windows）
- `src/main/context-menu.js`：首次启动自动注册注册表右键菜单（`HKCU\Software\Classes\*\shell\LuRenFileConverter`，无需管理员；已注册则幂等跳过；卸载函数供测试/设置用）
- 单实例锁 + `second-instance`：应用已运行时右键更多文件 → 新实例退出，文件转发给已运行实例
- 启动参数文件收集（`collectFileArgs`：跳过可执行文件/应用路径/开关参数，只收真实文件）→ 渲染层初始化时主动拉取（`files:pending`）
- 实测链路：启动带文件 → 渲染层拉取 ✓；二次实例 → 转发日志 ✓；右键菜单注册命令为真实 electron.exe 路径 ✓

### 验证摘要
- 预览服务：图片/扫描(PNG)/扫描(PDF首页)/PDF转图 4 种预览 dataURL 全部生成正确，无临时目录残留
- 右键菜单：注册→查询→卸载→确认移除 全链路通过（HKCU 可逆操作）
- collectFileArgs 修复真实 bug：argv[0]（electron.exe）与 app 路径不得误收为文件
- Electron 冒烟：单实例启动/二次实例转发/渲染层拉取文件 全部通过；17 个源码文件语法检查通过
---

## 十二、打包安装/卸载功能记录（2026-08-22）

### 交付物
- 安装包：`LuRen-FileConverter-Setup-1.0.0.exe`（约 500MB，位于项目根目录，含全部转换引擎，完全离线）
- 配置：`electron-builder.yml`（NSIS 向导式安装）；NSIS 卸载清理脚本：`build/installer.nsh`
- 构建命令：`npm run dist`（或 `npx electron-builder --win nsis`）

### 安装能力
- 向导式安装（oneClick:false），**可自选安装位置**（allowToChangeInstallationDirectory:true）
- 仅当前用户安装（perMachine:false，无需管理员）
- 自动创建桌面 + 开始菜单快捷方式；注册「卸载程序」入口（控制面板可卸载）
- 转换引擎（bin/）作为 extraResources 打包进 resources/bin；应用启动时注册右键菜单并**自愈命令路径**

### 卸载能力（严格只操作自身数据）
卸载器（Uninstall LuRenFileConverter.exe）只清理：
1. 安装目录（本应用文件）
2. 自己的注册表键：右键菜单键 + 卸载程序入口
3. 自己创建的桌面/开始菜单快捷方式
4. 自己的 %APPDATA% 应用数据
5. %TEMP% 下自己的日志文件与临时目录（**只匹配本应用实际使用的前缀** luren-convert-/img-/bmp-/doc-/ocr-/scan-/preview-，绝不误删用户其他文件）

### 打包适配
- `src/main/engines.js`：打包模式 BIN_DIR 指向 `process.resourcesPath/bin`（纯 Node 测试环境仍走开发路径）
- `src/main/context-menu.js`：注册前校验命令值，路径变化自动重写（开发版→安装版切换不残留旧路径）
- `asarUnpack`：sharp / heic-convert 从 asar 解包，保证原生模块与 wasm 可加载

### 实测验证（完整闭环）
静默安装到自定义目录 → 主程序/引擎/快捷方式/卸载入口全部就位 ✓ → 运行安装版应用（存活 12s+，证明原生依赖全部加载成功）✓ → 右键菜单自愈指向安装目录 exe ✓ → 静默卸载（退出码 0）→ 安装目录/右键菜单键/卸载注册表项/桌面与开始菜单快捷方式/%TEMP% 日志与 luren-* 临时目录/%APPDATA% 应用数据 **全部清理** ✓ → 用户其他数据文件**原样保留** ✓

### 构建中修复的问题
- NSIS 卸载段调用的函数必须用 `un.` 前缀（否则编译报错）
- 独立 `un.` 函数需 `!ifdef BUILD_UNINSTALLER` 守卫（否则安装器编译通道报 warning 6020，electron-builder 把警告当错误）
- 临时目录清理从宽泛的 `luren-*` 收窄为本应用实际使用的前缀清单（严格满足「只操作自身数据」）
---

## 十三、问题修复与体验优化记录（2026-08-22）

### 1. 修复：预览模态框启动即弹出且无法关闭
- 根因：CSS `.modal-overlay { display:flex }` 覆盖了 HTML `hidden` 属性（UA 的 `[hidden]{display:none}` 优先级低于显式 display 规则），模态框一直可见、关闭无效
- 修复：新增全局守卫 `[hidden] { display: none !important; }`，所有 hidden 元素强制隐藏

### 2. 右键菜单升级为 WPS 风格二级子菜单
- 原单一「使用 LuRen FileConverter 转换」项 → 父菜单「LuRen FileConverter」+ 12 个子项：转换为 PDF/Word/Excel/PPT/TXT/HTML/JPG/PNG/WebP/GIF/MP3/MP4
- 注册表结构：`*\shell\LuRenFileConverter\shell\<格式>\command`，命令携带 `--convert-to <格式>`（与 WPS/7-Zip 同款）
- 应用侧：`parseConvertArg` 解析目标格式；文件载荷改为 `{ files, convertTo }`；前端收到后**自动开始转换**（WPS 点击即转体验）
- 新增**图片→PDF** 转换路由（`imageToPdfConverter`：pdf-lib 嵌入图片，其他格式先经 sharp 转 PNG），右键菜单图片转 PDF 不再报错

### 3. 界面优化
- Toast 轻提示系统替代全部 `alert()`（不阻塞、可堆叠、自动消失）
- 结果卡片显示**真实输出文件大小**（主进程 complete 事件附带 stat 结果）
- 预览模态框增加加载 spinner；拖拽区悬停/拖入高亮、导航选中左侧竖条、按钮聚焦环、进度条渐变填充、卡片悬停浮起、细滚动条等视觉打磨

### 验证
- 右键菜单：父键 + 12 子项 command 全部写入（含 --convert-to），卸载递归删除 ✓
- `--convert-to pdf` 启动 → 自动加载文件 → 自动转换 → 产物生成 ✓（日志链路确认）
- 图片→PDF 路由：png→pdf 实测转换成功 ✓；parseConvertArg/collectFileArgs 边界（大小写、非法值、格式值不被当文件）✓
- 全部改动文件语法检查通过；安装包已重新构建
---

## 十四、pnpm/npm 依赖管理适配记录（2026-08-22）

### 问题
- 用户改用 pnpm 后 `pnpm start` 失败：pnpm 默认拦截依赖构建脚本（ERR_PNPM_IGNORED_BUILDS），electron 的 postinstall 未执行 → 二进制缺失 → Electron failed to install
- electron 二进制默认从 GitHub 下载，网络受限时 `fetch failed`

### 修复
- `pnpm-workspace.yaml`：`allowBuilds` 白名单（electron / electron-builder / electron-winstaller / sharp / app-builder-bin / 7zip-bin），允许执行安装脚本
- `.npmrc`：`electron_mirror=https://npmmirror.com/mirrors/electron/`，electron 安装脚本（npm 与 pnpm 都会读取）改从国内镜像下载
- 清理 pnpm 移入 `node_modules/.ignored` 的旧 npm 安装（462MB）
- 若 pnpm 已装但未下载二进制，可手动 `node node_modules/electron/install.js`（镜像已在 .npmrc）

### 验证
- `pnpm install` 退出码 0，electron-winstaller 脚本执行成功 ✓
- electron dist 下载成功（224.6MB），`pnpm start` 与 `npm start` 均可正常启动应用 ✓
---

## 十五、遗留问题修复记录：保存/下载与预览（2026-08-22）

### 1. 转换后无法下载、选定保存位置未保存
- 根因：结果卡片的「保存」原为「在资源管理器中显示」（shell.showItemInFolder），并非真正的另存为；输出位置也未在界面明确展示
- 修复：
  - 新增 `file:save-as` IPC：系统保存对话框（默认目录=自定义输出目录，默认文件名=输出文件名）→ `fs.copyFile` 复制，成功/取消/失败均有明确反馈
  - 结果卡片显示**输出目录**（路径行 + title 完整路径）
  - 转换完成 toast 明确提示「已输出到 <目录>」
  - 自定义输出目录经端到端实测确认生效（文件落在所选目录）且经 localStorage 持久化
- 相关文件：`src/main/index.js`、`src/preload/preload.js`、`src/renderer/app.js`

### 2. 预览功能是摆设、无法预览
- 根因：文档类预览只显示「不支持」；图片预览与原图看不出差异；无参数可调，预览与正式转换无关
- 修复：
  - 预览模态框新增**参数控制区**：扫描件=效果预设（轻度/标准/重度/老照片），图片=质量滑块+缩放宽度；调整即防抖自动重新预览
  - 预览显示**对比统计**：原图大小 → 转换效果大小（格式），让无损转换的差异可感知；并显示文件信息（名称/类型/大小）
  - **PDF 处理**任意目标格式都渲染首页预览（含页数信息）
  - **预览参数应用到正式转换**：图片质量/缩放、扫描预设会随转换请求下发（预览即所得）
  - 文档/音视频/OCR 等如实展示文件信息与说明（不做假预览）
- 相关文件：`src/main/preview.js`、`src/main/scan-effect.js`（convertToScannedPdf 支持 preset）、`src/renderer/index.html`、`src/renderer/app.js`、`src/renderer/style.css`

### 验证
- 图片预览带参数、扫描预设展开、PDF 首页预览（含页数）、文档类型 info+fileInfo、扫描转换应用 preset、自定义输出目录端到端生效：10/10 通过
- 渲染层 `--enable-logging` 无 JS 错误；39 个 DOM 引用与 HTML 全部匹配；全部文件语法检查通过
