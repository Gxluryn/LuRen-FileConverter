/**
 * ============================================================
 * PDF 结构处理工具（经典 xref 结构）
 * 功能：解析经典结构的 PDF（对象/流/trailer/xref），
 *       对全部流做 AES/RC4 加解密，并重建 xref 表与 trailer
 *
 * 为什么单独成模块：加密/解密都需「解析-变换-重建」三件事，
 * 共用一套代码，避免在 pdf.js 里复制两份（用户要求 10）
 *
 * 适用范围（如实声明）：
 * - 解析：经典 xref 表结构（含 xref 中 type-2 压缩对象条目）
 * - 加密输出：R=4 AES-128（AESV2），全部流加密、字符串不加密（StrF /Identity）
 * - 解密输入：R=2/3（RC4）与 R=4（AESV2）的经典结构加密 PDF
 * - xref stream 结构的 PDF 直接给出明确错误（不做假成功）
 * ============================================================
 */

const crypto = require('crypto'); // randomBytes：生成文件 ID / 流 IV
const pc = require('./pdf-crypto'); // 加解密原语（密钥派生、AES、RC4）

/** 对象解析结果：{num, start(文件偏移), end, dict(文本), streamData(Buffer|null)} */
function parseObjects(buffer) {
  const str = buffer.toString('latin1');
  const objects = [];
  // 对象头特征：行首 "<num> 0 obj"；用行首锚定大幅减少流内容中的误匹配
  const re = /(?:^|[\r\n])(\d+) (\d+) obj/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const num = Number(m[1]);
    const gen = Number(m[2]);
    // start：对象头起始偏移（不含行首换行）；headerEnd：对象头之后（字典起点）
    // 必须跳过对象头再取字典，否则重建时会重复输出 "N 0 obj"（实测导致结构损坏）
    const leadingNewline = m[0].startsWith('\r\n') ? 2 : 1;
    const start = m.index + leadingNewline;
    const headerEnd = m.index + m[0].length;
    const endObj = str.indexOf('endobj', headerEnd);
    if (endObj === -1) continue; // 没有 endobj 结尾 = 误匹配，跳过
    const end = endObj + 6;

    // 对象体 = 对象头之后到 endobj 的内容（字典 + 可能的流）
    const body = str.slice(headerEnd, end);
    const streamMatch = /stream[\r\n]+/.exec(body);
    let streamData = null;
    let dict;
    if (streamMatch) {
      // stream 关键字前是对象字典，关键字后换行即流数据起点
      dict = body.slice(0, streamMatch.index);
      const dataStart = headerEnd + streamMatch.index + streamMatch[0].length;
      // /Length 权威时按长度截取；缺失/间接引用时退回扫描 endstream 并去掉结尾换行
      const lenMatch = dict.match(/\/Length\s+(\d+)/);
      let dataEnd;
      if (lenMatch) {
        dataEnd = dataStart + Number(lenMatch[1]);
      } else {
        const es = str.indexOf('endstream', dataStart);
        dataEnd = es === -1 ? end : es;
        // endstream 前的换行属于分隔符，不属于数据
        if (str[dataEnd - 1] === '\n') dataEnd--;
        if (str[dataEnd - 1] === '\r') dataEnd--;
      }
      streamData = buffer.subarray(dataStart, Math.min(dataEnd, end));
    } else {
      // 无 stream：字典就是到 endobj 的全部内容
      dict = body;
    }
    objects.push({ num, gen, start, end, dict, streamData });
  }
  return objects;
}

/** 从对象字典文本中取值：/Key <value>（value 为不含空白/嵌套的简单值） */
function getDictValue(dict, key) {
  const re = new RegExp('\\' + key + '\\s+([^\\s/<]+)');
  const m = dict.match(re);
  return m ? m[1] : null;
}

/**
 * 从字典文本中提取 /Key 的值（支持嵌套字典、hex 字符串、简单 token）
 * 为什么自写平衡扫描：/Encrypt 字典含嵌套 << >>，非贪婪正则会在内层提前截断，
 * 导致 pypdf 生成的加密文件解析失败（实测定位的问题）
 * @param {string} dictText - 字典体文本
 * @param {string} key - 键名（不含斜杠）
 * @returns {string|null} 值的原始文本（嵌套字典返回完整 <<...>>，hex 返回 <...>）
 */
function extractDictValue(dictText, key) {
  const re = new RegExp('\\/' + key + '\\s*', 'g');
  let m;
  while ((m = re.exec(dictText)) !== null) {
    let i = re.lastIndex;
    // 跳过键与值之间的空白
    while (i < dictText.length && /\s/.test(dictText[i])) i++;
    if (dictText[i] === '<' && dictText[i + 1] === '<') {
      // 嵌套字典：数 << 与 >> 配对，取完整字典
      let depth = 0;
      let j = i;
      for (; j < dictText.length; j++) {
        if (dictText[j] === '<' && dictText[j + 1] === '<') { depth++; j++; }
        else if (dictText[j] === '>' && dictText[j + 1] === '>') { depth--; j++; if (depth === 0) break; }
      }
      if (depth === 0) return dictText.slice(i, j + 1);
    }
    if (dictText[i] === '<') {
      // hex 字符串 <...>：读到匹配的 >
      const end = dictText.indexOf('>', i);
      if (end !== -1) return dictText.slice(i, end + 1);
    }
    // 简单 token：名字/数字/引用（遇分隔符停止）
    const rest = dictText.slice(i);
    // 数字开头时优先尝试完整间接引用 "N G R"（如 /Encrypt 5 0 R），
    // 否则会被空格截断成 "5"，导致后续解析失败
    if (/^\d/.test(rest)) {
      const ref = /^(\d+)\s+(\d+)\s+R/.exec(rest);
      if (ref) return ref[0].trim();
    }
    const tok = /^[^\s/<>[\]()]+/.exec(rest);
    if (tok) return tok[0];
  }
  return null;
}

/**
 * 解析 PDF 字面量字符串的转义序列 → 字节 Buffer
 * 支持：\\( \\) \\\\ \\n \\r \\t \\b \\f \\ooo(八进制) \\<换行>(续行)
 * @param {string} raw - 括号内的原始内容（不含最外层括号）
 * @returns {Buffer}
 */
function decodePdfString(raw) {
  const bytes = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\') {
      const next = raw[i + 1];
      if (next === 'n') { bytes.push(0x0a); i++; }
      else if (next === 'r') { bytes.push(0x0d); i++; }
      else if (next === 't') { bytes.push(0x09); i++; }
      else if (next === 'b') { bytes.push(0x08); i++; }
      else if (next === 'f') { bytes.push(0x0c); i++; }
      else if (next === '\n' || (next === '\r' && raw[i + 2] === '\n')) { i += next === '\r' ? 2 : 1; } // 续行：跳过
      else if (next === '\r') { i++; } // 续行
      else if (/[0-7]/.test(next || '')) {
        // 八进制 1-3 位
        let octal = '';
        let k = i + 1;
        while (k < raw.length && octal.length < 3 && /[0-7]/.test(raw[k])) { octal += raw[k]; k++; }
        bytes.push(parseInt(octal, 8) & 0xff);
        i = k - 1;
      } else if (next !== undefined) {
        // 其他转义（含 \\ 本身）：取该字符的字面值
        bytes.push(raw.charCodeAt(i + 1) & 0xff);
        i++;
      }
    } else {
      bytes.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/**
 * 变换对象字典中的全部字符串（解密后改写为 hex 字符串）
 * 为什么输出 hex 字符串：hex 与字面量字符串对解析器是等价值的 token，
 * 无需处理解密后字节的重新转义（可读性差些但正确性有保障）
 * 注意：hex 字符串 <...> 与字典 <</>> 需要区分
 * @param {string} dictText - 对象字典文本
 * @param {Buffer} objKey - 对象级密钥
 * @param {boolean} isAes - 是否 AESV2（含 IV 前缀）
 * @param {Function} decryptBytes - (bytes) => Buffer 解密函数
 * @returns {string} 变换后的字典文本
 */
function decryptDictStrings(dictText, objKey, isAes, decryptBytes) {
  let out = '';
  let i = 0;
  const n = dictText.length;
  while (i < n) {
    const ch = dictText[i];
    if (ch === '(') {
      // 字面量字符串：括号配对（转义括号不计入配对）
      let depth = 1;
      let j = i + 1;
      let raw = '';
      while (j < n && depth > 0) {
        if (dictText[j] === '\\') { raw += dictText.slice(j, j + 2); j += 2; continue; }
        if (dictText[j] === '(') depth++;
        else if (dictText[j] === ')') depth--;
        raw += dictText[j];
        j++;
      }
      if (depth === 0) {
        const decrypted = decryptBytes(decodePdfString(raw));
        out += '<' + decrypted.toString('hex').toUpperCase() + '>';
        i = j + 1; // 跳过右括号
        continue;
      }
    } else if (ch === '<' && dictText[i + 1] !== '<') {
      // hex 字符串（< 后跟 < 是字典，不处理）
      const end = dictText.indexOf('>', i);
      if (end !== -1) {
        const rawHex = dictText.slice(i + 1, end).replace(/\s/g, '');
        if (/^[0-9A-Fa-f]*$/.test(rawHex)) {
          const decrypted = decryptBytes(Buffer.from(rawHex, 'hex'));
          out += '<' + decrypted.toString('hex').toUpperCase() + '>';
          i = end + 1;
          continue;
        }
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * 解析经典 xref 表 → 对象偏移表
 * 返回 Map<objNum, offset>；含 type-2 时返回 { entries, compressed: Map<num, [objstm, idx]> }
 */
function parseXref(buffer) {
  const str = buffer.toString('latin1');
  const xrefIdx = str.indexOf('\nxref\n');
  if (xrefIdx === -1) return null; // 非经典 xref 结构
  const trailerIdx = str.indexOf('\ntrailer\n', xrefIdx);
  const xrefText = str.slice(xrefIdx + 7, trailerIdx === -1 ? str.length : trailerIdx);

  const offsets = new Map();
  const compressed = new Map();
  // 子段：<起始号> <数量>\n 后跟 20 字节/条 的条目
  const subsectionRe = /(\d+)\s+(\d+)\s*\n([\s\S]*?)(?=\d+\s+\d+\s*\n|$)/g;
  let sub;
  while ((sub = subsectionRe.exec(xrefText)) !== null) {
    let first = Number(sub[1]);
    const count = Number(sub[2]);
    const body = sub[3];
    // 每条目 20 字节：10 位偏移 空格 5 位代数 空格 类型 2 空格 换行
    const entryRe = /(\d{10}) (\d{5}) ([nf]) \r?\n/g;
    let e;
    while ((e = entryRe.exec(body)) !== null) {
      const num = first++;
      const type = e[3];
      if (type === 'n') offsets.set(num, Number(e[1]));
      else if (type === 'f') { /* 空闲条目无需处理 */ }
      else {
        // 压缩对象条目（pdf-lib 不产生，但兼容旧文件）
        const parts = e[1].trim().split(/\s+/);
        compressed.set(num, [Number(parts[0]), Number(parts[1])]);
      }
    }
  }
  return { offsets, compressed };
}

/** 从 hex 字符串（<...>）解析 Buffer，容忍内部换行/空白 */
function hexToBuffer(hexStr) {
  const clean = hexStr.replace(/[\s<>{}\[\]]/g, '');
  return Buffer.from(clean, 'hex');
}

/**
 * 解析 trailer 字典中的 /Encrypt 与 /ID
 * 支持 /Encrypt 内联字典（含嵌套 /CF）或间接引用（N 0 R）
 * @returns {object|null} 加密信息；encryptObjNum 为 /Encrypt 所在对象号（间接引用时）
 */
function parseTrailerSecurity(buffer, objects) {
  const str = buffer.toString('latin1');
  // trailer 字典用平衡扫描取完整内容（防嵌套字典提前截断）
  const trailerStart = /trailer\s*<</.exec(str);
  if (!trailerStart) return null;
  let depth = 0;
  let j = trailerStart.index + trailerStart[0].length - 2; // 定位到 <<
  const from = j;
  for (; j < str.length; j++) {
    if (str[j] === '<' && str[j + 1] === '<') { depth++; j++; }
    else if (str[j] === '>' && str[j + 1] === '>') { depth--; j++; if (depth === 0) break; }
  }
  if (depth !== 0) return null;
  const trailer = str.slice(from, j + 1);

  // 文件 ID：加密必需（密钥派生输入）；容忍内部空白
  const idMatch = trailer.match(/\/ID\s*\[\s*<([0-9A-Fa-f\s]*)>\s*<([0-9A-Fa-f\s]*)>\s*\]/);
  if (!idMatch) return null;
  const id0 = hexToBuffer(idMatch[1]);

  // /Encrypt 值：内联字典（平衡提取）或间接引用
  const encRaw = extractDictValue(trailer, 'Encrypt');
  let encText = null;
  let encryptObjNum = null;
  if (encRaw && encRaw.startsWith('<<')) {
    encText = encRaw;
  } else if (encRaw) {
    // 间接引用 "N 0 R"：到对象里找对应字典
    const refMatch = /^(\d+)\s+\d+\s+R$/.exec(encRaw.trim());
    if (refMatch) {
      const num = Number(refMatch[1]);
      encryptObjNum = num;
      const obj = objects.find((o) => o.num === num && !o.streamData);
      if (obj) {
        const inner = obj.dict.match(/<</);
        if (inner) encText = obj.dict.slice(inner.index);
      }
    }
  }
  if (!encText) return null;

  // 解析加密字典必需字段（用平衡提取器，容忍嵌套 /CF 结构）
  const getVal = (key) => {
    const v = extractDictValue(encText, key);
    return v;
  };
  const o = hexToBuffer(getVal('O') || '');
  const u = hexToBuffer(getVal('U') || '');
  const r = Number(getVal('R') || 0);
  const v = Number(getVal('V') || 0);
  const lengthBits = Number(getVal('Length') || (r >= 3 ? 128 : 40));
  // 加密方法：/CF/StdCF/CFM，缺省按版本推断（V<=3 → RC4，V=4 → AESV2）
  const cfmRaw = getVal('CFM');
  const cfm = cfmRaw ? cfmRaw.replace(/^\//, '') : v >= 4 ? 'AESV2' : 'V2';
  // 字符串是否加密：StrF 为 /StdCF 时字符串也加密（decryptDictStrings 处理）
  const strfRaw = getVal('StrF');
  const strf = strfRaw ? strfRaw.replace(/^\//, '') : 'Identity';
  // 元数据是否加密：默认 true；仅当显式 /EncryptMetadata false 时 false
  // （影响算法 2 中是否追加 4 字节 0xFF）
  const metadataEncrypted = !/\/EncryptMetadata\s+false/i.test(encText);
  // /P 可能很大（4294967292），用 Number 需注意精度；这里按无符号 32 位解析
  const pRaw = getVal('P');
  const p = pRaw !== null ? Number(pRaw) >>> 0 : 0;

  return {
    id0,
    o,
    u,
    r,
    v,
    keyLength: lengthBits / 8,
    cfm,
    strf,
    p,
    metadataEncrypted,
    encryptObjNum,
  };
}

/**
 * 加密经典结构 PDF（R=4 AESV2）
 * @param {Buffer} buffer - 未加密的经典结构 PDF（建议先经 pdf-lib useObjectStreams:false 规范化）
 * @param {string} password - 用户/所有者密码
 * @returns {Buffer} 加密后的 PDF
 */
function encryptPdfBuffer(buffer, password) {
  const objects = parseObjects(buffer);
  if (objects.length === 0) throw new Error('无法解析 PDF 对象结构');

  // 文件 ID：规范要求 /ID；pdf-lib 经典输出不带 ID，这里生成随机 ID
  // （加密密钥依赖 ID，随机 ID 使同一密码的两次加密结果不同，更安全）
  const id0 = crypto.randomBytes(16);
  const id1 = crypto.randomBytes(16);

  // 权限值 -4（0xFFFFFFFC）：允许全部权限（除规范保留位）
  const p = -4;
  const paddedUser = pc.padPassword(password);
  // 算法 2 需要 O 项参与哈希，因此必须先算 O（算法 3，只依赖两个密码）
  const oEntry = pc.computeOwnerKey(pc.padPassword(password), paddedUser, 4, 16);
  // 文件加密密钥（算法 2）：密码 + O + P + ID 的 MD5 链 + 50 次迭代
  const key = pc.computeEncryptionKey(paddedUser, oEntry, id0, p, 4, 16, true);
  // U 项（算法 5）
  const uEntry = pc.computeUserKey(key, id0, 4);

  // 逐对象重建文件（顺序与偏移在此过程中确定，同时记录供 xref 使用）
  const chunks = [];
  const offsets = new Map();
  let maxNum = 0;

  // 文件头（%PDF-x.y 及首个对象前的内容）必须保留，否则解析器无法识别版本
  // （首次实现时漏掉此段，pdfinfo 报 PDF version 0.0 并误判未加密）
  if (objects.length > 0 && objects[0].start > 0) {
    chunks.push(buffer.subarray(0, objects[0].start));
  }

  for (const obj of objects) {
    maxNum = Math.max(maxNum, obj.num);
    offsets.set(obj.num, 0); // 偏移稍后回填（xref 写在最后，先记录占位）
    let dict = obj.dict;
    let body = null;

    if (obj.streamData) {
      // xref 流不加密（规范强制），其余流一律 AESV2 加密
      const type = getDictValue(dict, 'Type');
      if (type !== 'XRef') {
        // 每个流使用对象级密钥（算法 1：fileKey + 对象号 + 代数 + 'sAlT'）
        const objKey = pc.buildObjectKey(key, obj.num, obj.gen || 0, true);
        const encrypted = pc.aesEncryptStream(objKey, obj.streamData);
        // /Length 更新为「IV + 密文」总长度（AESV2 的流数据包含 IV）
        dict = dict.replace(/\/Length\s+\d+/, '/Length ' + encrypted.length);
        body = encrypted;
      } else {
        body = obj.streamData;
      }
    }

    // 组装对象字节；记录其起始偏移（xref 中 type-1 条目用）
    offsets.set(obj.num, chunkLength(chunks));
    if (body) {
      chunks.push(Buffer.from(obj.num + ' 0 obj\n' + dict + '\nstream\n'));
      chunks.push(body);
      chunks.push(Buffer.from('\nendstream\nendobj\n'));
    } else {
      chunks.push(Buffer.from(obj.num + ' 0 obj\n' + dict + '\nendobj\n'));
    }
  }

  // 计算 xref 偏移并回填各对象偏移（此前占位为 0，现在补真实值）
  const bodyLen = chunkLength(chunks);
  // xref 表字节先按文本生成，偏移通过累加计算
  let xrefText = 'xref\n0 ' + (maxNum + 1) + '\n';
  xrefText += '0000000000 65535 f \n';
  const entryLines = [];
  for (let n = 1; n <= maxNum; n++) {
    const off = offsets.get(n);
    if (off !== undefined) {
      entryLines.push(String(off).padStart(10, '0') + ' 00000 n \n');
    } else {
      entryLines.push('0000000000 00000 f \n'); // 空缺对象号 → 空闲条目
    }
  }
  // 对象偏移已知后回写：将占位 0 替换为真实偏移（直接重算各对象块）
  const xrefOffset = bodyLen;
  // 修正 offsets 中的占位：上面 chunks 已按顺序压入，偏移=前面所有块长度之和
  // （占位已在上面的组装循环中设置为 chunkLength，无需回填）

  // 组装 trailer（保留原 /Root /Info；追加 /ID；/Encrypt 用独立对象 + 间接引用）
  // 为什么独立对象：poppler 对「trailer 内联 /Encrypt」的识别有兼容问题（实测 Encrypted:no），
  // 而 pypdf/Adobe 均用独立对象，这也是最常见的布局
  const trailerSrc = /trailer\s*<<([\s\S]*?)>>/.exec(buffer.toString('latin1'));
  const rootInfo = trailerSrc ? (trailerSrc[1].match(/\/Root\s+\d+ \d+ R/) || [''])[0] : '';
  const infoRef = trailerSrc ? (trailerSrc[1].match(/\/Info\s+\d+ \d+ R/) || [''])[0] : '';
  const encryptObjNum = maxNum + 1; // 新对象号：紧接现有对象之后
  const encryptDict =
    '<< /Filter /Standard /V 4 /R 4 /Length 128 ' +
    '/CF << /StdCF << /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >> >> ' +
    '/StmF /StdCF /StrF /StdCF ' + // StrF 用 /StdCF（与 pypdf/Adobe 一致；实测 poppler 对 /Identity 识别异常）
    '/O <' + oEntry.toString('hex').toUpperCase() + '> ' +
    '/U <' + uEntry.toString('hex').toUpperCase() + '> ' +
    '/P ' + (p >>> 0) + ' >>'; // P 用无符号 32 位整数书写（与 pypdf/Adobe 一致）

  const trailer =
    'trailer\n<<\n/Size ' + (encryptObjNum + 1) + '\n' + rootInfo + '\n' + infoRef +
    '\n/ID [<' + id0.toString('hex').toUpperCase() + '> <' + id1.toString('hex').toUpperCase() + '>]\n' +
    '/Encrypt ' + encryptObjNum + ' 0 R\n>>\n';

  // /Encrypt 对象追加到对象区末尾（必须在 xref 之前）
  chunks.push(Buffer.from(encryptObjNum + ' 0 obj\n' + encryptDict + '\nendobj\n'));

  // 最终文件：对象区 + xref + trailer + startxref
  const xrefBlock = Buffer.from(xrefText + entryLines.join(''));
  const trailerBlock = Buffer.from(trailer + 'startxref\n' + xrefOffset + '\n%%EOF\n');
  return Buffer.concat([...chunks, xrefBlock, trailerBlock]);
}

/** 统计 chunks 总字节数 */
function chunkLength(chunks) {
  return chunks.reduce((sum, c) => sum + c.length, 0);
}

/**
 * 解密经典结构加密 PDF
 * @param {Buffer} buffer - 加密 PDF
 * @param {string} password - 用户密码（或所有者密码）
 * @returns {Buffer} 解密后的 PDF
 */
function decryptPdfBuffer(buffer, password) {
  const str = buffer.toString('latin1');

  // 结构判定：必须是经典 xref；xref stream 结构给出明确错误（不做假支持）
  if (!/\nxref\n/.test(str)) {
    throw new Error('暂不支持该 PDF 结构（xref stream / 压缩对象表），请使用其他工具解密');
  }

  const objects = parseObjects(buffer);
  const security = parseTrailerSecurity(buffer, objects);
  if (!security || security.o.length === 0 || security.u.length === 0) {
    throw new Error('未找到有效的 PDF 加密信息');
  }
  if (security.cfm !== 'AESV2' && security.cfm !== 'V2') {
    throw new Error('不支持的加密方式: ' + security.cfm);
  }

  // 密码验证：先按用户密码，失败再按所有者密码恢复用户密码（规范算法 6/7）
  let key = pc.authenticateUserPassword(password, security);
  if (!key && security.r >= 3) {
    // 所有者密码路径：从 O 恢复填充后的用户密码（32 字节），直接按用户密码验证
    // （填充函数对已满 32 字节的输入原样返回，无需先解填充）
    const recoveredPadded = pc.recoverUserPasswordFromOwner(password, security.o, security.r, security.keyLength);
    key = pc.authenticateUserPassword(recoveredPadded, security);
  }
  if (!key) throw new Error('密码错误，无法解密');

  // 解密全部流并重建文件
  const chunks = [];
  const offsets = new Map();
  let maxNum = 0;

  // 保留文件头前缀（%PDF-x.y），否则解析器无法识别版本
  if (objects.length > 0 && objects[0].start > 0) {
    chunks.push(buffer.subarray(0, objects[0].start));
  }

  // 字符串加密模式：StrF 非 Identity 时字典里的字符串也需解密（pypdf/Adobe 产物常见）
  const stringsEncrypted = security.strf !== 'Identity';
  const isAes = security.cfm === 'AESV2';

  for (const obj of objects) {
    maxNum = Math.max(maxNum, obj.num);
    let dict = obj.dict;
    let body = null;

    if (obj.streamData && obj.streamData.length > 0) {
      const type = getDictValue(dict, 'Type');
      if (type !== 'XRef') {
        // 对象级密钥（算法 1）：AESV2 加 'sAlT' 盐，RC4 不加
        const objKey = pc.buildObjectKey(key, obj.num, obj.gen || 0, isAes);
        // AESV2：IV+密文 → 明文；RC4（V2）：直接按对象密钥解密（RC4 加解密同构）
        const decrypted = isAes
          ? pc.aesDecryptStream(objKey, obj.streamData)
          : pc.rc4(objKey, obj.streamData);
        // /Length 可能是间接引用（"N 0 R"），解密后必须改为直接值，否则读取会按旧长度截断
        dict = dict
          .replace(/\/Length\s+\d+\s+\d+\s+R/, '/Length ' + decrypted.length)
          .replace(/\/Length\s+\d+/, '/Length ' + decrypted.length);
        body = decrypted;
      } else {
        body = obj.streamData;
      }
    }

    // 字符串解密：/Encrypt 字典对象本身永不被加密，必须跳过
    if (stringsEncrypted && obj.num !== security.encryptObjNum) {
      const objKey = pc.buildObjectKey(key, obj.num, obj.gen || 0, isAes);
      dict = decryptDictStrings(dict, objKey, isAes, (bytes) =>
        isAes ? pc.aesDecryptStream(objKey, bytes) : pc.rc4(objKey, bytes)
      );
    }

    offsets.set(obj.num, chunkLength(chunks));
    if (body) {
      chunks.push(Buffer.from(obj.num + ' 0 obj\n' + dict + '\nstream\n'));
      chunks.push(body);
      chunks.push(Buffer.from('\nendstream\nendobj\n'));
    } else {
      chunks.push(Buffer.from(obj.num + ' 0 obj\n' + dict + '\nendobj\n'));
    }
  }

  // xref 重建：与原结构一致（含 type-2 压缩对象条目，由调用方 xref 解析结果补齐）
  const xrefInfo = parseXref(buffer);
  const bodyLen = chunkLength(chunks);
  const xrefOffset = bodyLen;
  let xrefText = 'xref\n0 ' + (maxNum + 1) + '\n';
  xrefText += '0000000000 65535 f \n';
  const entryLines = [];
  for (let n = 1; n <= maxNum; n++) {
    if (offsets.has(n)) {
      entryLines.push(String(offsets.get(n)).padStart(10, '0') + ' 00000 n \n');
    } else if (xrefInfo && xrefInfo.compressed.has(n)) {
      // 压缩对象：保留 type-2 条目（ObjStm 内偏移在解密后依然有效）
      const [objstm, idx] = xrefInfo.compressed.get(n);
      entryLines.push(String(objstm).padStart(10, '0') + ' ' + String(idx).padStart(5, '0') + ' n \n');
    } else {
      entryLines.push('0000000000 00000 f \n');
    }
  }

  // trailer：去掉 /Encrypt，保留 /Size /Root /Info /ID
  const trailerMatch = /trailer\s*<<([\s\S]*?)>>\s*startxref/.exec(str);
  const inner = trailerMatch ? trailerMatch[1] : '';
  const keepKeys = ['/Size', '/Root', '/Info', '/ID'];
  const kept = keepKeys
    .map((k) => {
      const m = inner.match(new RegExp('\\' + k + '[^\\n]*'));
      return m ? m[0].trim() : null;
    })
    .filter(Boolean);

  const trailer = 'trailer\n<<\n' + kept.join('\n') + '\n>>\n';
  const xrefBlock = Buffer.from(xrefText + entryLines.join(''));
  const trailerBlock = Buffer.from(trailer + 'startxref\n' + xrefOffset + '\n%%EOF\n');
  return Buffer.concat([...chunks, xrefBlock, trailerBlock]);
}

module.exports = { parseObjects, parseXref, encryptPdfBuffer, decryptPdfBuffer };
