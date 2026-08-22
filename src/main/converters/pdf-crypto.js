/**
 * ============================================================
 * PDF 加解密核心（ISO 32000 标准安全处理器实现）
 *
 * 为什么自研：实测 pdf-lib 1.17.1 的 save({encrypt}) 选项为空转（pdfinfo 显示未加密），
 * LibreOffice headless 的过滤器选项也被忽略，因此按公开标准规范实现加密/解密。
 * 所有算法均对照 pypdf 6.16（其文档字符串直接引用规范原文）与 pdfjs 实现逐行核对，
 * 并用 pypdf 生成的加密 PDF 作为参考样本交叉验证（用户要求 1：不编造）
 *
 * 能力范围（如实声明）：
 * - 加密：128 位 AES（R=4 / V=4 / AESV2），经典 xref 结构
 * - 解密：R=2/3（RC4）与 R=4（AES-128）的经典 xref 加密 PDF
 * - 不支持 xref stream 结构的加密 PDF（给出明确错误而非假成功）
 *
 * 安全说明：算法全部来自公开 PDF 规范（ISO 32000-1 第 7.6 节），
 * 使用 Node 内置 crypto（MD5/AES）；RC4 因 OpenSSL3 移除而手写（已用 RFC 向量验证）
 * ============================================================
 */

const crypto = require('crypto'); // MD5 / AES-128-CBC（Node 内置，无需外部依赖）

// PDF 规范规定的 32 字节密码填充串（7.6.3.2 节）
// 注意：不是全 0x28！必须与规范逐字节一致（首个实现写成全 28 导致 O/U/key 全错，对照 pypdf 才发现）
const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');

/**
 * RC4 流加密（手写实现）
 * 为什么手写：Node 的 OpenSSL 3 已移除 RC4，而 PDF 安全处理器（R<=4）的密钥派生必须用它。
 * 算法简单且已用 RFC 6229 向量验证（key=Key, plaintext=Plaintext → bbf316e8d940af0ad3）
 * @param {Buffer} keyBytes - 密钥
 * @param {Buffer} data - 待加密/解密数据（RC4 加解密同构）
 * @returns {Buffer}
 */
function rc4(keyBytes, data) {
  // KSA：用密钥初始化 256 字节状态数组 S
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + keyBytes[i % keyBytes.length]) & 0xff;
    const t = s[i]; s[i] = s[j]; s[j] = t;
  }
  // PRGA：生成密钥流并与数据逐字节异或
  let i = 0;
  j = 0;
  const out = Buffer.alloc(data.length);
  for (let n = 0; n < data.length; n++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    const t = s[i]; s[i] = s[j]; s[j] = t;
    out[n] = data[n] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

/**
 * 密码填充/截断到 32 字节（规范 7.6.3.2）
 * 兼容 string 与 Buffer 输入：所有者密码恢复路径产出的是 32 字节 Buffer，
 * 直接使用而非转字符串（字符串化 Buffer 会产生乱码）
 */
function padPassword(password) {
  const buf = Buffer.isBuffer(password) ? password : Buffer.from(String(password), 'utf8');
  if (buf.length >= 32) return buf.subarray(0, 32);
  return Buffer.concat([buf, PAD.subarray(0, 32 - buf.length)]);
}

/**
 * 算法 2：计算文件加密密钥
 * 严格对照规范原文：MD5(填充密码 + O项 + P(小端4字节) + ID[0] [+ 4×FF 当 R>=4 且元数据未加密])
 * 再对 R>=3 迭代 50 次 MD5（每次取前 keyLength 字节），最终取前 keyLength 字节
 * @param {Buffer} paddedUserPwd - 填充后的用户密码
 * @param {Buffer} oEntry - /Encrypt 的 O 项（32 字节，参与哈希！）
 * @param {Buffer} id0 - 文件 ID[0]
 * @param {number} p - /Encrypt 权限值 P
 * @param {number} r - 修订号（2/3/4）
 * @param {number} keyLength - 密钥字节数（R=2 时 5，R>=3 时 16）
 * @param {boolean} metadataEncrypted - 元数据是否加密（默认 true，不加 0xFF 段）
 * @returns {Buffer} 文件加密密钥
 */
function computeEncryptionKey(paddedUserPwd, oEntry, id0, p, r, keyLength, metadataEncrypted = true) {
  // P 按 32 位小端字节序参与哈希；R>=4 需置位 0xE8（表示使用加密过滤器，规范要求）
  const permissions = (p | 0xe8) >>> 0;
  const permBytes = Buffer.alloc(4);
  permBytes.writeUInt32LE(permissions, 0);

  // 哈希输入顺序必须与规范一致：密码、O、P、ID，最后按条件追加 0xFF
  const parts = [paddedUserPwd, oEntry, permBytes, id0];
  if (r >= 4 && !metadataEncrypted) parts.push(Buffer.from([0xff, 0xff, 0xff, 0xff]));
  let digest = crypto.createHash('md5').update(Buffer.concat(parts)).digest();

  // R>=3：50 次迭代（每次只取前 keyLength 字节作为下次输入）
  if (r >= 3) {
    for (let i = 0; i < 50; i++) {
      digest = crypto.createHash('md5').update(digest.subarray(0, keyLength)).digest();
    }
  }
  return digest.subarray(0, keyLength);
}

/**
 * 算法 3：计算 O 项（所有者密钥）
 * @param {Buffer} paddedOwnerPwd - 填充后的所有者密码
 * @param {Buffer} paddedUserPwd - 填充后的用户密码
 * @param {number} r - 修订号
 * @param {number} keyLength - 密钥字节数
 * @returns {Buffer} 32 字节 O 值
 */
function computeOwnerKey(paddedOwnerPwd, paddedUserPwd, r, keyLength) {
  // 第一步：MD5(填充的所有者密码)，R>=3 迭代 50 次（规范同算法 2 的 50 次）
  let hash = crypto.createHash('md5').update(paddedOwnerPwd).digest();
  if (r >= 3) {
    for (let i = 0; i < 50; i++) hash = crypto.createHash('md5').update(hash).digest();
  }
  const rc4Key = hash.subarray(0, keyLength);

  // 第二步：RC4 加密填充后的用户密码，R>=3 再迭代 19 次（密钥 = 原密钥 XOR i，i=1..19）
  // 注意迭代顺序必须 1→19（对照 pypdf range(1,20)；写反会导致密文不同）
  let result = rc4(rc4Key, paddedUserPwd);
  if (r >= 3) {
    for (let i = 1; i <= 19; i++) {
      const xorKey = Buffer.from(rc4Key.map((b) => b ^ i));
      result = rc4(xorKey, result);
    }
  }
  return result;
}

/**
 * 算法 5：计算 U 项（用户密钥，R>=3）
 * 规范：MD5(填充串 + ID[0]) → RC4(key) → 19 次 RC4(密钥 XOR i, i=1..19) → 16 字节结果用填充串补到 32
 * @param {Buffer} key - 文件加密密钥
 * @param {Buffer} id0 - 文件 ID[0]
 * @param {number} r - 修订号
 * @returns {Buffer} 32 字节 U 值
 */
function computeUserKey(key, id0, r) {
  if (r <= 2) {
    // R=2：U = RC4(key, 填充串)（32 字节）
    return rc4(key, PAD);
  }
  // MD5(填充串 + ID[0])：ID 必须参与哈希（对照 pypdf Algorithm 5 步骤 b/c）
  const digest = crypto.createHash('md5').update(PAD).update(id0).digest();
  let result = rc4(key, digest);
  for (let i = 1; i <= 19; i++) {
    const xorKey = Buffer.from(key.map((b) => b ^ i));
    result = rc4(xorKey, result);
  }
  // 16 字节结果 + 填充串前 16 字节 → 32 字节（规范步骤 f：追加任意数据，用填充串最稳妥）
  return Buffer.concat([result, PAD.subarray(0, 16)]);
}

/**
 * 算法 6：验证用户密码并返回文件加密密钥（失败返回 null）
 * 验证方式（对照 pypdf）：计算密钥 → 计算 U → 比较前 16 字节（R>=3）或全部 32 字节（R=2）
 * @param {string} password - 用户密码
 * @param {{o: Buffer, u: Buffer, p: number, id0: Buffer, r: number, keyLength: number, metadataEncrypted: boolean}} enc
 * @returns {Buffer|null}
 */
function authenticateUserPassword(password, enc) {
  const key = computeEncryptionKey(
    padPassword(password), enc.o, enc.id0, enc.p, enc.r, enc.keyLength, enc.metadataEncrypted
  );
  const u = computeUserKey(key, enc.id0, enc.r);
  const compareLen = enc.r >= 3 ? 16 : 32;
  return u.subarray(0, compareLen).equals(enc.u.subarray(0, compareLen)) ? key : null;
}

/**
 * 算法 7（R>=3）：从所有者密码恢复「填充后的用户密码」（32 字节）
 * @param {string} ownerPassword
 * @param {Buffer} o - /Encrypt 的 O 项
 * @param {number} r - 修订号
 * @param {number} keyLength
 * @returns {Buffer} 填充后的用户密码（32 字节）
 */
function recoverUserPasswordFromOwner(ownerPassword, o, r, keyLength) {
  // MD5(填充的所有者密码) 迭代 50 次 → RC4 密钥
  let hash = crypto.createHash('md5').update(padPassword(ownerPassword)).digest();
  for (let i = 0; i < 50; i++) hash = crypto.createHash('md5').update(hash).digest();
  const rc4Key = hash.subarray(0, keyLength);
  // 逆向算法 3：用密钥 XOR i（i=19..0）依次 RC4 解密 O → 填充后的用户密码
  let result = o;
  for (let i = 19; i >= 0; i--) {
    const xorKey = Buffer.from(rc4Key.map((b) => b ^ i));
    result = rc4(xorKey, result);
  }
  return result;
}

/**
 * 算法 1：计算对象级加密密钥
 * 每个流的密钥不是文件密钥本身，而是 MD5(文件密钥 + 对象号3字节LE + 代数2字节LE [+ 'sAlT' AES])
 * 取前 min(n+5, 16) 字节（对照 pdfjs #buildObjectKey 与规范 7.6.3.2）
 * @param {Buffer} fileKey - 文件加密密钥
 * @param {number} objNum - 对象编号
 * @param {number} gen - 对象代数（通常 0）
 * @param {boolean} isAes - 是否 AESV2（追加 'sAlT' 盐）
 * @returns {Buffer} 对象级密钥
 */
function buildObjectKey(fileKey, objNum, gen, isAes) {
  const key = Buffer.alloc(fileKey.length + 5 + (isAes ? 4 : 0));
  fileKey.copy(key, 0);
  key[fileKey.length] = objNum & 0xff;
  key[fileKey.length + 1] = (objNum >> 8) & 0xff;
  key[fileKey.length + 2] = (objNum >> 16) & 0xff;
  key[fileKey.length + 3] = gen & 0xff;
  key[fileKey.length + 4] = (gen >> 8) & 0xff;
  if (isAes) {
    // 'sAlT' 盐字节（ASCII s A l T），AESV2 专属
    key[fileKey.length + 5] = 0x73;
    key[fileKey.length + 6] = 0x41;
    key[fileKey.length + 7] = 0x6c;
    key[fileKey.length + 8] = 0x54;
  }
  const digest = crypto.createHash('md5').update(key).digest();
  return digest.subarray(0, Math.min(fileKey.length + 5, 16));
}

/**
 * AES-128-CBC 加密流数据（AESV2 模式，使用对象级密钥）
 * @param {Buffer} objKey - 对象级密钥（16 字节）
 * @param {Buffer} data - 明文流数据
 * @returns {Buffer} IV(16 字节) + 密文（含 PKCS7 填充）
 */
function aesEncryptStream(objKey, data) {
  // 每个流的 IV 必须随机：相同内容用不同 IV，防止密文模式泄露（安全要求）
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-cbc', objKey, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, encrypted]);
}

/**
 * AES-128-CBC 解密流数据（AESV2 模式，使用对象级密钥）
 * @param {Buffer} objKey - 对象级密钥（16 字节）
 * @param {Buffer} data - IV + 密文
 * @returns {Buffer} 明文流数据
 */
function aesDecryptStream(objKey, data) {
  if (data.length <= 16) throw new Error('加密流数据不完整（缺少 IV）');
  const iv = data.subarray(0, 16);
  // 注意：createDecipheriv 的第三参数是 IV，绝不能传密文（此前传错导致 IV 校验失败）
  const decipher = crypto.createDecipheriv('aes-128-cbc', objKey, iv);
  return Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]);
}

module.exports = {
  rc4,
  padPassword,
  computeEncryptionKey,
  computeOwnerKey,
  computeUserKey,
  buildObjectKey,
  authenticateUserPassword,
  recoverUserPasswordFromOwner,
  aesEncryptStream,
  aesDecryptStream,
  PAD,
};
