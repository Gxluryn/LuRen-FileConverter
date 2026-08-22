# LuRen FileConverter

完全离线的 Windows 桌面文件格式转换工具，支持文档、图片、音视频、PDF 互转，内置扫描件模拟和 OCR 文字识别。

---

## 🚀 快速安装（推荐）

1. 前往 [Releases](https://github.com/Gxluryn/LuRen-FileConverter/releases) 下载安装包（约 500MB，已内置全部转换引擎，完全离线，无需额外配置）；
2. 双击运行，按向导选择安装位置（可选）完成安装；
3. 安装后自动创建桌面/开始菜单快捷方式，并在文件右键菜单中出现「使用 LuRen FileConverter 转换」入口（首次运行注册）；
4. 卸载：控制面板 → 卸载程序 → LuRen FileConverter（卸载只清理自身数据，不影响你的其他文件）。

> 以下「安装教程」为**从源码运行**的替代方案（需自行准备转换引擎），一般用户无需操作。

---

## 功能一览
## 功能一览

| 类别 | 支持格式 |
|---|---|
| 文档转换 | Word / Excel / PPT / PDF / TXT / Markdown / HTML 互转 |
| 图片转换 | JPG / PNG / WebP / GIF / BMP / TIFF / HEIC / ICO 互转 |
| 音视频转换 | MP3 / WAV / FLAC / M4A / AAC / OGG / MP4 / MKV / AVI / MOV 互转 |
| PDF 处理 | 拆分 / 合并 / 加密 / 解密 / 提取文字 / 转图片 |
| 扫描件模拟 | 电子文档 → 带真实扫描质感的 PDF（随机倾斜、噪点、暗角、纸张色温） |
| OCR 识别 | 扫描件 / 图片 → 可编辑文字，支持中英文 |
| 批量转换 | 多文件同时处理 |
| 完全离线 | 所有转换本地完成，不上传任何文件 |

---

## 安装教程（零基础小白版）

### 第一步：安装 Node.js

本工具基于 Node.js 运行，需要先安装。

1. 打开浏览器，访问 [https://nodejs.org/zh-cn](https://nodejs.org/zh-cn)
2. 点击页面上的 **LTS 长期维护版**（绿色按钮，推荐）下载安装包
3. 双击下载的 `.msi` 安装包，一路点击 **Next** 即可完成安装
4. 验证是否安装成功：
   - 按 `Win + R`，输入 `cmd`，回车打开命令提示符
   - 输入 `node -v`，回车
   - 如果显示版本号（如 `v20.x.x`），说明安装成功

### 第二步：获取项目源码

将项目文件夹放到你想存放的位置，例如 `E:\LuRen-FileConverter`。

> 确保项目路径中**没有中文和空格**，否则可能导致引擎调用失败。

### 第三步：安装项目依赖

1. 打开项目文件夹 `E:\LuRen-FileConverter`
2. 在文件夹空白处按住 `Shift` + 鼠标右键，选择 **在此处打开 PowerShell 窗口**（或 **在终端中打开**）
3. 输入以下命令，回车：

```bash
npm install
```

4. 等待安装完成（首次安装可能需要 1-3 分钟，取决于网络速度）
5. 看到 `added xxx packages` 字样即表示安装成功

> 如果下载速度慢，可以先执行 `npm config set registry https://registry.npmmirror.com` 切换到国内镜像，再执行 `npm install`。

### 第四步：确认转换引擎

项目的 `bin/` 目录下需要包含以下引擎文件夹：

```
bin/
├── ffmpeg/          ← 音视频编码引擎
├── libreoffice/     ← 办公文档转换引擎
├── poppler/         ← PDF 渲染引擎
├── tesseract/       ← OCR 文字识别引擎
├── tessdata/        ← OCR 语言包（压缩包格式）
└── avs3/            ← AVS3 音频解码器
```

如果 `bin/` 目录已存在且包含以上文件夹，说明引擎已就位，可以跳过此步。

如果缺少引擎，需要自行准备：
- **FFmpeg**：从 [ffmpeg.org](https://ffmpeg.org/download.html) 下载 Windows 版，将 `ffmpeg.exe` 放入 `bin/ffmpeg/`
- **LibreOffice Portable**：从 [portableapps.com](https://portableapps.com/apps/office/libreoffice_portable) 下载便携版，解压到 `bin/libreoffice/`
- **Poppler**：从 [GitHub](https://github.com/oschwartz10612/poppler-windows/releases) 下载 Windows 版，解压到 `bin/poppler/`
- **Tesseract**：按 `Win + R` 输入 `cmd`，执行 `winget install tesseract-ocr.tesseract`，安装后将安装目录内容复制到 `bin/tesseract/`

### 第五步：验证引擎是否就位

在项目目录下打开 PowerShell，输入：

```bash
node -e "const { checkEngines } = require('./src/main/engines'); const r = checkEngines(); console.log('可用:', r.available.join(', ')); console.log('缺失:', r.missing.length > 0 ? r.missing.join(', ') : '无');"
```

如果显示「缺失: 无」，说明所有引擎都就位了。

### 第六步：启动应用

在项目目录下的 PowerShell 中输入：

```bash
npm start
```

等待几秒，应用窗口就会弹出。首次启动可能稍慢（需要加载引擎），属于正常现象。

---

## 项目结构

```
LuRen-FileConverter/
│
├── bin/                          # 【转换引擎】所有本地转换引擎存放处，git 忽略
│   ├── ffmpeg/                   #   FFmpeg — 音视频/图片编码转换
│   │   └── ffmpeg.exe
│   ├── libreoffice/              #   LibreOffice Portable — 办公文档互转
│   │   └── LibreOfficePortable/
│   │       └── LibreOfficePortable.exe
│   ├── poppler/                  #   Poppler — PDF 渲染、拆分、信息读取
│   │   └── Library/bin/
│   │       ├── pdftoppm.exe      #     PDF 转图片
│   │       └── pdfinfo.exe       #     PDF 信息读取
│   ├── tesseract/                #   Tesseract — OCR 文字识别引擎
│   │   ├── tesseract.exe
│   │   └── tessdata/             #     OCR 语言包
│   │       ├── chi_sim.traineddata  #   中文简体
│   │       ├── eng.traineddata      #   英文
│   │       └── osd.traineddata      #   方向检测
│   ├── tessdata/                 #   备用语言包（.gz 压缩格式，供 tesseract.js 使用）
│   └── avs3/                     #   AVS3 音频解码器
│       ├── avs3RM0Decoder.exe
│       └── model.bin
│
├── src/                          # 【源代码】项目所有源代码
│   ├── main/                     #   主进程 / 后端逻辑（Node.js 运行）
│   │   ├── index.js              #     应用入口，Electron 主进程启动
│   │   ├── engines.js            #     引擎路径管理，统一管理所有本地引擎路径
│   │   ├── converter.js          #     转换调度核心，任务队列、进度管理
│   │   ├── scan-effect.js        #     扫描件模拟效果，基于 Sharp 实现
│   │   ├── converters/           #     各格式转换器（按格式分类）
│   │   │   ├── document.js       #       文档转换（Word/Excel/PPT/PDF/TXT/MD）
│   │   │   ├── image.js          #       图片转换（JPG/PNG/WebP/GIF/BMP/TIFF/HEIC）
│   │   │   ├── media.js          #       音视频转换（MP3/WAV/FLAC/MP4/MKV/AVI）
│   │   │   ├── pdf.js            #       PDF 处理（拆分/合并/加密/解密/提取）
│   │   │   └── ocr.js            #       OCR 文字识别
│   │   └── utils/                #     工具函数
│   │       ├── file.js           #       文件操作工具（路径、重命名、清理）
│   │       ├── process.js        #       子进程调用工具（封装引擎调用）
│   │       └── logger.js         #       日志工具
│   ├── preload/                  #   预加载脚本（Electron 安全机制）
│   │   └── preload.js            #     暴露安全 API 给渲染进程
│   └── renderer/                 #   前端界面（运行在 Electron 窗口中）
│       ├── index.html            #     主页面 HTML
│       ├── style.css             #     样式文件
│       └── app.js                #     前端交互逻辑
│
├── node_modules/                 # 【依赖包】npm install 自动生成，git 忽略
├── package.json                  # 项目配置文件（依赖、脚本、元信息）
├── package-lock.json             # 依赖版本锁定文件
├── .gitignore                    # Git 忽略规则（忽略 node_modules、bin 等）
└── README.md                     # 项目说明文档（本文件）
```

---

## 技术栈

| 类别 | 技术 | 用途 |
|---|---|---|
| 桌面框架 | Electron | 跨平台桌面应用 |
| 图像处理 | Sharp | 图片旋转、模糊、噪点、格式转换 |
| 后端服务 | Express | 本地 HTTP 服务（可选） |
| 文档处理 | Mammoth | DOCX 转 HTML / 文本 |
| | docx | 生成 Word 文档 |
| | ExcelJS | 生成 Excel 表格 |
| | Turndown | HTML 转 Markdown |
| | Marked | Markdown 转 HTML |
| | pdf-lib | PDF 创建、合并、加密 |
| | pdfjs-dist | PDF 文本提取 |
| 音视频 | fluent-ffmpeg | FFmpeg 封装，音视频转换 |
| OCR | Tesseract（本地） | 子进程调用，文字识别 |
| 压缩包 | yauzl / yazl | ZIP 解压与压缩 |

---

## 常用命令

```bash
npm start       # 启动应用
npm run dev     # 启动应用（同 start）
npm install     # 安装项目依赖
```

---

## 扫描件模拟效果参数

| 参数 | 推荐值 | 说明 |
|---|---|---|
| 随机旋转 | 0.3° ~ 1.2° | 每页角度不同，模拟手工放纸不正 |
| 高斯模糊 | sigma 0.3 ~ 0.5 | 消除矢量文字锐利边缘 |
| 噪点强度 | 0.06 ~ 0.1 | 模拟扫描仪传感器底噪 |
| 纸张色温 | 亮度 92%，偏黄 | 替代纯白背景，模拟打印纸 |
| 边缘暗角 | 降低 10% ~ 15% | 模拟扫描仪光线衰减 |
| 输出 DPI | 150 ~ 200 | 匹配办公扫描仪分辨率 |
| JPEG 质量 | 65 ~ 75 | 轻微压缩失真，更真实 |

---

## 常见问题

**Q: 启动时提示 "Electron failed to install correctly"**
A: 执行以下命令重新安装 Electron：
```bash
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
npm install electron
```

**Q: 转换时提示引擎不存在**
A: 检查 `bin/` 目录下是否包含所有引擎文件夹，参考上方「第四步：确认转换引擎」。

**Q: OCR 识别中文全是乱码**
A: 确认 `bin/tesseract/tessdata/` 目录下有 `chi_sim.traineddata` 文件。

**Q: LibreOffice 首次调用很慢**
A: 正常现象，LibreOffice 首次启动需要初始化，后续调用会快很多。

---

## 注意事项

- 本工具仅供个人学习使用，禁止商业售卖或套壳发布
- 项目路径请勿包含中文和空格
- 转换大文件时建议关闭其他占用内存的程序
- 所有转换均在本地完成，不会上传任何文件

---

## License

MIT
