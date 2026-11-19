/**
 * 配对面板 —— Client 半。
 *
 * 注册位置：`sidebar.footer.action`（侧边栏底部「设置」旁边）。
 * 为什么放这儿：配对是一次性动作，塞进设置页要三跳；放 footer 一点就到。
 *
 * 两条实现约束（都是实测出来的，别改回去）：
 *
 *  1. **必须是单文件**。DSH 的 Client 模块加载器只给 `require('react')` /
 *     `require('react-dom')`，**不支持相对路径的 import / 动态 import**。
 *     所以二维码编码器（Nayuki 的 MIT 实现）是内联在下面的，不是外部文件。
 *
 *  2. **面板自己发 fetch**，走页面同源 → 127.0.0.1:19387，
 *     这样服务端的 isLoopback() 才认。手机走公网是被拒的，那正是修复目标。
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-workbench',
  factory: (require) => {
    var React = require('react')
    var h = React.createElement

    /* ==================== 内联：QR 编码器 ==================== */
    /* 见文件末尾 __QR_BEGIN__ / __QR_END__，安装时由脚本注入 */
    /**
     * QR Code generator — extracted verbatim from qrcode.react 4.2.0
     * (lib/esm/index.js, lines 33-761), which embeds:
     * @license QR Code generator library (TypeScript)
     * Copyright (c) Project Nayuki. SPDX-License-Identifier: MIT
     *
     * No dependencies; used by the host side of dsh-mobile-plus to render
     * pairing QR codes as SVG for the desktop panel and mobile page.
     */
    // src/third-party/qrcodegen/index.ts
    /**
     * @license QR Code generator library (TypeScript)
     * Copyright (c) Project Nayuki.
     * SPDX-License-Identifier: MIT
     */
    var qrcodegen;
    ((qrcodegen2) => {
      const _QrCode = class _QrCode {
        /*-- Constructor (low level) and fields --*/
        // Creates a new QR Code with the given version number,
        // error correction level, data codeword bytes, and mask number.
        // This is a low-level API that most users should not use directly.
        // A mid-level API is the encodeSegments() function.
        constructor(version, errorCorrectionLevel, dataCodewords, msk) {
          this.version = version;
          this.errorCorrectionLevel = errorCorrectionLevel;
          // The modules of this QR Code (false = light, true = dark).
          // Immutable after constructor finishes. Accessed through getModule().
          this.modules = [];
          // Indicates function modules that are not subjected to masking. Discarded when constructor finishes.
          this.isFunction = [];
          if (version < _QrCode.MIN_VERSION || version > _QrCode.MAX_VERSION)
            throw new RangeError("Version value out of range");
          if (msk < -1 || msk > 7)
            throw new RangeError("Mask value out of range");
          this.size = version * 4 + 17;
          let row = [];
          for (let i = 0; i < this.size; i++)
            row.push(false);
          for (let i = 0; i < this.size; i++) {
            this.modules.push(row.slice());
            this.isFunction.push(row.slice());
          }
          this.drawFunctionPatterns();
          const allCodewords = this.addEccAndInterleave(dataCodewords);
          this.drawCodewords(allCodewords);
          if (msk == -1) {
            let minPenalty = 1e9;
            for (let i = 0; i < 8; i++) {
              this.applyMask(i);
              this.drawFormatBits(i);
              const penalty = this.getPenaltyScore();
              if (penalty < minPenalty) {
                msk = i;
                minPenalty = penalty;
              }
              this.applyMask(i);
            }
          }
          assert(0 <= msk && msk <= 7);
          this.mask = msk;
          this.applyMask(msk);
          this.drawFormatBits(msk);
          this.isFunction = [];
        }
        /*-- Static factory functions (high level) --*/
        // Returns a QR Code representing the given Unicode text string at the given error correction level.
        // As a conservative upper bound, this function is guaranteed to succeed for strings that have 738 or fewer
        // Unicode code points (not UTF-16 code units) if the low error correction level is used. The smallest possible
        // QR Code version is automatically chosen for the output. The ECC level of the result may be higher than the
        // ecl argument if it can be done without increasing the version.
        static encodeText(text, ecl) {
          const segs = qrcodegen2.QrSegment.makeSegments(text);
          return _QrCode.encodeSegments(segs, ecl);
        }
        // Returns a QR Code representing the given binary data at the given error correction level.
        // This function always encodes using the binary segment mode, not any text mode. The maximum number of
        // bytes allowed is 2953. The smallest possible QR Code version is automatically chosen for the output.
        // The ECC level of the result may be higher than the ecl argument if it can be done without increasing the version.
        static encodeBinary(data, ecl) {
          const seg = qrcodegen2.QrSegment.makeBytes(data);
          return _QrCode.encodeSegments([seg], ecl);
        }
        /*-- Static factory functions (mid level) --*/
        // Returns a QR Code representing the given segments with the given encoding parameters.
        // The smallest possible QR Code version within the given range is automatically
        // chosen for the output. Iff boostEcl is true, then the ECC level of the result
        // may be higher than the ecl argument if it can be done without increasing the
        // version. The mask number is either between 0 to 7 (inclusive) to force that
        // mask, or -1 to automatically choose an appropriate mask (which may be slow).
        // This function allows the user to create a custom sequence of segments that switches
        // between modes (such as alphanumeric and byte) to encode text in less space.
        // This is a mid-level API; the high-level API is encodeText() and encodeBinary().
        static encodeSegments(segs, ecl, minVersion = 1, maxVersion = 40, mask = -1, boostEcl = true) {
          if (!(_QrCode.MIN_VERSION <= minVersion && minVersion <= maxVersion && maxVersion <= _QrCode.MAX_VERSION) || mask < -1 || mask > 7)
            throw new RangeError("Invalid value");
          let version;
          let dataUsedBits;
          for (version = minVersion; ; version++) {
            const dataCapacityBits2 = _QrCode.getNumDataCodewords(version, ecl) * 8;
            const usedBits = QrSegment.getTotalBits(segs, version);
            if (usedBits <= dataCapacityBits2) {
              dataUsedBits = usedBits;
              break;
            }
            if (version >= maxVersion)
              throw new RangeError("Data too long");
          }
          for (const newEcl of [_QrCode.Ecc.MEDIUM, _QrCode.Ecc.QUARTILE, _QrCode.Ecc.HIGH]) {
            if (boostEcl && dataUsedBits <= _QrCode.getNumDataCodewords(version, newEcl) * 8)
              ecl = newEcl;
          }
          let bb = [];
          for (const seg of segs) {
            appendBits(seg.mode.modeBits, 4, bb);
            appendBits(seg.numChars, seg.mode.numCharCountBits(version), bb);
            for (const b of seg.getData())
              bb.push(b);
          }
          assert(bb.length == dataUsedBits);
          const dataCapacityBits = _QrCode.getNumDataCodewords(version, ecl) * 8;
          assert(bb.length <= dataCapacityBits);
          appendBits(0, Math.min(4, dataCapacityBits - bb.length), bb);
          appendBits(0, (8 - bb.length % 8) % 8, bb);
          assert(bb.length % 8 == 0);
          for (let padByte = 236; bb.length < dataCapacityBits; padByte ^= 236 ^ 17)
            appendBits(padByte, 8, bb);
          let dataCodewords = [];
          while (dataCodewords.length * 8 < bb.length)
            dataCodewords.push(0);
          bb.forEach((b, i) => dataCodewords[i >>> 3] |= b << 7 - (i & 7));
          return new _QrCode(version, ecl, dataCodewords, mask);
        }
        /*-- Accessor methods --*/
        // Returns the color of the module (pixel) at the given coordinates, which is false
        // for light or true for dark. The top left corner has the coordinates (x=0, y=0).
        // If the given coordinates are out of bounds, then false (light) is returned.
        getModule(x, y) {
          return 0 <= x && x < this.size && 0 <= y && y < this.size && this.modules[y][x];
        }
        // Modified to expose modules for easy access
        getModules() {
          return this.modules;
        }
        /*-- Private helper methods for constructor: Drawing function modules --*/
        // Reads this object's version field, and draws and marks all function modules.
        drawFunctionPatterns() {
          for (let i = 0; i < this.size; i++) {
            this.setFunctionModule(6, i, i % 2 == 0);
            this.setFunctionModule(i, 6, i % 2 == 0);
          }
          this.drawFinderPattern(3, 3);
          this.drawFinderPattern(this.size - 4, 3);
          this.drawFinderPattern(3, this.size - 4);
          const alignPatPos = this.getAlignmentPatternPositions();
          const numAlign = alignPatPos.length;
          for (let i = 0; i < numAlign; i++) {
            for (let j = 0; j < numAlign; j++) {
              if (!(i == 0 && j == 0 || i == 0 && j == numAlign - 1 || i == numAlign - 1 && j == 0))
                this.drawAlignmentPattern(alignPatPos[i], alignPatPos[j]);
            }
          }
          this.drawFormatBits(0);
          this.drawVersion();
        }
        // Draws two copies of the format bits (with its own error correction code)
        // based on the given mask and this object's error correction level field.
        drawFormatBits(mask) {
          const data = this.errorCorrectionLevel.formatBits << 3 | mask;
          let rem = data;
          for (let i = 0; i < 10; i++)
            rem = rem << 1 ^ (rem >>> 9) * 1335;
          const bits = (data << 10 | rem) ^ 21522;
          assert(bits >>> 15 == 0);
          for (let i = 0; i <= 5; i++)
            this.setFunctionModule(8, i, getBit(bits, i));
          this.setFunctionModule(8, 7, getBit(bits, 6));
          this.setFunctionModule(8, 8, getBit(bits, 7));
          this.setFunctionModule(7, 8, getBit(bits, 8));
          for (let i = 9; i < 15; i++)
            this.setFunctionModule(14 - i, 8, getBit(bits, i));
          for (let i = 0; i < 8; i++)
            this.setFunctionModule(this.size - 1 - i, 8, getBit(bits, i));
          for (let i = 8; i < 15; i++)
            this.setFunctionModule(8, this.size - 15 + i, getBit(bits, i));
          this.setFunctionModule(8, this.size - 8, true);
        }
        // Draws two copies of the version bits (with its own error correction code),
        // based on this object's version field, iff 7 <= version <= 40.
        drawVersion() {
          if (this.version < 7)
            return;
          let rem = this.version;
          for (let i = 0; i < 12; i++)
            rem = rem << 1 ^ (rem >>> 11) * 7973;
          const bits = this.version << 12 | rem;
          assert(bits >>> 18 == 0);
          for (let i = 0; i < 18; i++) {
            const color = getBit(bits, i);
            const a = this.size - 11 + i % 3;
            const b = Math.floor(i / 3);
            this.setFunctionModule(a, b, color);
            this.setFunctionModule(b, a, color);
          }
        }
        // Draws a 9*9 finder pattern including the border separator,
        // with the center module at (x, y). Modules can be out of bounds.
        drawFinderPattern(x, y) {
          for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
              const dist = Math.max(Math.abs(dx), Math.abs(dy));
              const xx = x + dx;
              const yy = y + dy;
              if (0 <= xx && xx < this.size && 0 <= yy && yy < this.size)
                this.setFunctionModule(xx, yy, dist != 2 && dist != 4);
            }
          }
        }
        // Draws a 5*5 alignment pattern, with the center module
        // at (x, y). All modules must be in bounds.
        drawAlignmentPattern(x, y) {
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++)
              this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) != 1);
          }
        }
        // Sets the color of a module and marks it as a function module.
        // Only used by the constructor. Coordinates must be in bounds.
        setFunctionModule(x, y, isDark) {
          this.modules[y][x] = isDark;
          this.isFunction[y][x] = true;
        }
        /*-- Private helper methods for constructor: Codewords and masking --*/
        // Returns a new byte string representing the given data with the appropriate error correction
        // codewords appended to it, based on this object's version and error correction level.
        addEccAndInterleave(data) {
          const ver = this.version;
          const ecl = this.errorCorrectionLevel;
          if (data.length != _QrCode.getNumDataCodewords(ver, ecl))
            throw new RangeError("Invalid argument");
          const numBlocks = _QrCode.NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
          const blockEccLen = _QrCode.ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver];
          const rawCodewords = Math.floor(_QrCode.getNumRawDataModules(ver) / 8);
          const numShortBlocks = numBlocks - rawCodewords % numBlocks;
          const shortBlockLen = Math.floor(rawCodewords / numBlocks);
          let blocks = [];
          const rsDiv = _QrCode.reedSolomonComputeDivisor(blockEccLen);
          for (let i = 0, k = 0; i < numBlocks; i++) {
            let dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
            k += dat.length;
            const ecc = _QrCode.reedSolomonComputeRemainder(dat, rsDiv);
            if (i < numShortBlocks)
              dat.push(0);
            blocks.push(dat.concat(ecc));
          }
          let result = [];
          for (let i = 0; i < blocks[0].length; i++) {
            blocks.forEach((block, j) => {
              if (i != shortBlockLen - blockEccLen || j >= numShortBlocks)
                result.push(block[i]);
            });
          }
          assert(result.length == rawCodewords);
          return result;
        }
        // Draws the given sequence of 8-bit codewords (data and error correction) onto the entire
        // data area of this QR Code. Function modules need to be marked off before this is called.
        drawCodewords(data) {
          if (data.length != Math.floor(_QrCode.getNumRawDataModules(this.version) / 8))
            throw new RangeError("Invalid argument");
          let i = 0;
          for (let right = this.size - 1; right >= 1; right -= 2) {
            if (right == 6)
              right = 5;
            for (let vert = 0; vert < this.size; vert++) {
              for (let j = 0; j < 2; j++) {
                const x = right - j;
                const upward = (right + 1 & 2) == 0;
                const y = upward ? this.size - 1 - vert : vert;
                if (!this.isFunction[y][x] && i < data.length * 8) {
                  this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
                  i++;
                }
              }
            }
          }
          assert(i == data.length * 8);
        }
        // XORs the codeword modules in this QR Code with the given mask pattern.
        // The function modules must be marked and the codeword bits must be drawn
        // before masking. Due to the arithmetic of XOR, calling applyMask() with
        // the same mask value a second time will undo the mask. A final well-formed
        // QR Code needs exactly one (not zero, two, etc.) mask applied.
        applyMask(mask) {
          if (mask < 0 || mask > 7)
            throw new RangeError("Mask value out of range");
          for (let y = 0; y < this.size; y++) {
            for (let x = 0; x < this.size; x++) {
              let invert;
              switch (mask) {
                case 0:
                  invert = (x + y) % 2 == 0;
                  break;
                case 1:
                  invert = y % 2 == 0;
                  break;
                case 2:
                  invert = x % 3 == 0;
                  break;
                case 3:
                  invert = (x + y) % 3 == 0;
                  break;
                case 4:
                  invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 == 0;
                  break;
                case 5:
                  invert = x * y % 2 + x * y % 3 == 0;
                  break;
                case 6:
                  invert = (x * y % 2 + x * y % 3) % 2 == 0;
                  break;
                case 7:
                  invert = ((x + y) % 2 + x * y % 3) % 2 == 0;
                  break;
                default:
                  throw new Error("Unreachable");
              }
              if (!this.isFunction[y][x] && invert)
                this.modules[y][x] = !this.modules[y][x];
            }
          }
        }
        // Calculates and returns the penalty score based on state of this QR Code's current modules.
        // This is used by the automatic mask choice algorithm to find the mask pattern that yields the lowest score.
        getPenaltyScore() {
          let result = 0;
          for (let y = 0; y < this.size; y++) {
            let runColor = false;
            let runX = 0;
            let runHistory = [0, 0, 0, 0, 0, 0, 0];
            for (let x = 0; x < this.size; x++) {
              if (this.modules[y][x] == runColor) {
                runX++;
                if (runX == 5)
                  result += _QrCode.PENALTY_N1;
                else if (runX > 5)
                  result++;
              } else {
                this.finderPenaltyAddHistory(runX, runHistory);
                if (!runColor)
                  result += this.finderPenaltyCountPatterns(runHistory) * _QrCode.PENALTY_N3;
                runColor = this.modules[y][x];
                runX = 1;
              }
            }
            result += this.finderPenaltyTerminateAndCount(runColor, runX, runHistory) * _QrCode.PENALTY_N3;
          }
          for (let x = 0; x < this.size; x++) {
            let runColor = false;
            let runY = 0;
            let runHistory = [0, 0, 0, 0, 0, 0, 0];
            for (let y = 0; y < this.size; y++) {
              if (this.modules[y][x] == runColor) {
                runY++;
                if (runY == 5)
                  result += _QrCode.PENALTY_N1;
                else if (runY > 5)
                  result++;
              } else {
                this.finderPenaltyAddHistory(runY, runHistory);
                if (!runColor)
                  result += this.finderPenaltyCountPatterns(runHistory) * _QrCode.PENALTY_N3;
                runColor = this.modules[y][x];
                runY = 1;
              }
            }
            result += this.finderPenaltyTerminateAndCount(runColor, runY, runHistory) * _QrCode.PENALTY_N3;
          }
          for (let y = 0; y < this.size - 1; y++) {
            for (let x = 0; x < this.size - 1; x++) {
              const color = this.modules[y][x];
              if (color == this.modules[y][x + 1] && color == this.modules[y + 1][x] && color == this.modules[y + 1][x + 1])
                result += _QrCode.PENALTY_N2;
            }
          }
          let dark = 0;
          for (const row of this.modules)
            dark = row.reduce((sum, color) => sum + (color ? 1 : 0), dark);
          const total = this.size * this.size;
          const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
          assert(0 <= k && k <= 9);
          result += k * _QrCode.PENALTY_N4;
          assert(0 <= result && result <= 2568888);
          return result;
        }
        /*-- Private helper functions --*/
        // Returns an ascending list of positions of alignment patterns for this version number.
        // Each position is in the range [0,177), and are used on both the x and y axes.
        // This could be implemented as lookup table of 40 variable-length lists of integers.
        getAlignmentPatternPositions() {
          if (this.version == 1)
            return [];
          else {
            const numAlign = Math.floor(this.version / 7) + 2;
            const step = this.version == 32 ? 26 : Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2;
            let result = [6];
            for (let pos = this.size - 7; result.length < numAlign; pos -= step)
              result.splice(1, 0, pos);
            return result;
          }
        }
        // Returns the number of data bits that can be stored in a QR Code of the given version number, after
        // all function modules are excluded. This includes remainder bits, so it might not be a multiple of 8.
        // The result is in the range [208, 29648]. This could be implemented as a 40-entry lookup table.
        static getNumRawDataModules(ver) {
          if (ver < _QrCode.MIN_VERSION || ver > _QrCode.MAX_VERSION)
            throw new RangeError("Version number out of range");
          let result = (16 * ver + 128) * ver + 64;
          if (ver >= 2) {
            const numAlign = Math.floor(ver / 7) + 2;
            result -= (25 * numAlign - 10) * numAlign - 55;
            if (ver >= 7)
              result -= 36;
          }
          assert(208 <= result && result <= 29648);
          return result;
        }
        // Returns the number of 8-bit data (i.e. not error correction) codewords contained in any
        // QR Code of the given version number and error correction level, with remainder bits discarded.
        // This stateless pure function could be implemented as a (40*4)-cell lookup table.
        static getNumDataCodewords(ver, ecl) {
          return Math.floor(_QrCode.getNumRawDataModules(ver) / 8) - _QrCode.ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver] * _QrCode.NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
        }
        // Returns a Reed-Solomon ECC generator polynomial for the given degree. This could be
        // implemented as a lookup table over all possible parameter values, instead of as an algorithm.
        static reedSolomonComputeDivisor(degree) {
          if (degree < 1 || degree > 255)
            throw new RangeError("Degree out of range");
          let result = [];
          for (let i = 0; i < degree - 1; i++)
            result.push(0);
          result.push(1);
          let root = 1;
          for (let i = 0; i < degree; i++) {
            for (let j = 0; j < result.length; j++) {
              result[j] = _QrCode.reedSolomonMultiply(result[j], root);
              if (j + 1 < result.length)
                result[j] ^= result[j + 1];
            }
            root = _QrCode.reedSolomonMultiply(root, 2);
          }
          return result;
        }
        // Returns the Reed-Solomon error correction codeword for the given data and divisor polynomials.
        static reedSolomonComputeRemainder(data, divisor) {
          let result = divisor.map((_) => 0);
          for (const b of data) {
            const factor = b ^ result.shift();
            result.push(0);
            divisor.forEach((coef, i) => result[i] ^= _QrCode.reedSolomonMultiply(coef, factor));
          }
          return result;
        }
        // Returns the product of the two given field elements modulo GF(2^8/0x11D). The arguments and result
        // are unsigned 8-bit integers. This could be implemented as a lookup table of 256*256 entries of uint8.
        static reedSolomonMultiply(x, y) {
          if (x >>> 8 != 0 || y >>> 8 != 0)
            throw new RangeError("Byte out of range");
          let z = 0;
          for (let i = 7; i >= 0; i--) {
            z = z << 1 ^ (z >>> 7) * 285;
            z ^= (y >>> i & 1) * x;
          }
          assert(z >>> 8 == 0);
          return z;
        }
        // Can only be called immediately after a light run is added, and
        // returns either 0, 1, or 2. A helper function for getPenaltyScore().
        finderPenaltyCountPatterns(runHistory) {
          const n = runHistory[1];
          assert(n <= this.size * 3);
          const core = n > 0 && runHistory[2] == n && runHistory[3] == n * 3 && runHistory[4] == n && runHistory[5] == n;
          return (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0) + (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0);
        }
        // Must be called at the end of a line (row or column) of modules. A helper function for getPenaltyScore().
        finderPenaltyTerminateAndCount(currentRunColor, currentRunLength, runHistory) {
          if (currentRunColor) {
            this.finderPenaltyAddHistory(currentRunLength, runHistory);
            currentRunLength = 0;
          }
          currentRunLength += this.size;
          this.finderPenaltyAddHistory(currentRunLength, runHistory);
          return this.finderPenaltyCountPatterns(runHistory);
        }
        // Pushes the given value to the front and drops the last value. A helper function for getPenaltyScore().
        finderPenaltyAddHistory(currentRunLength, runHistory) {
          if (runHistory[0] == 0)
            currentRunLength += this.size;
          runHistory.pop();
          runHistory.unshift(currentRunLength);
        }
      };
      /*-- Constants and tables --*/
      // The minimum version number supported in the QR Code Model 2 standard.
      _QrCode.MIN_VERSION = 1;
      // The maximum version number supported in the QR Code Model 2 standard.
      _QrCode.MAX_VERSION = 40;
      // For use in getPenaltyScore(), when evaluating which mask is best.
      _QrCode.PENALTY_N1 = 3;
      _QrCode.PENALTY_N2 = 3;
      _QrCode.PENALTY_N3 = 40;
      _QrCode.PENALTY_N4 = 10;
      _QrCode.ECC_CODEWORDS_PER_BLOCK = [
        // Version: (note that index 0 is for padding, and is set to an illegal value)
        //0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40    Error correction level
        [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
        // Low
        [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
        // Medium
        [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
        // Quartile
        [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
        // High
      ];
      _QrCode.NUM_ERROR_CORRECTION_BLOCKS = [
        // Version: (note that index 0 is for padding, and is set to an illegal value)
        //0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40    Error correction level
        [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
        // Low
        [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
        // Medium
        [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
        // Quartile
        [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
        // High
      ];
      let QrCode = _QrCode;
      qrcodegen2.QrCode = _QrCode;
      function appendBits(val, len, bb) {
        if (len < 0 || len > 31 || val >>> len != 0)
          throw new RangeError("Value out of range");
        for (let i = len - 1; i >= 0; i--)
          bb.push(val >>> i & 1);
      }
      function getBit(x, i) {
        return (x >>> i & 1) != 0;
      }
      function assert(cond) {
        if (!cond)
          throw new Error("Assertion error");
      }
      const _QrSegment = class _QrSegment {
        /*-- Constructor (low level) and fields --*/
        // Creates a new QR Code segment with the given attributes and data.
        // The character count (numChars) must agree with the mode and the bit buffer length,
        // but the constraint isn't checked. The given bit buffer is cloned and stored.
        constructor(mode, numChars, bitData) {
          this.mode = mode;
          this.numChars = numChars;
          this.bitData = bitData;
          if (numChars < 0)
            throw new RangeError("Invalid argument");
          this.bitData = bitData.slice();
        }
        /*-- Static factory functions (mid level) --*/
        // Returns a segment representing the given binary data encoded in
        // byte mode. All input byte arrays are acceptable. Any text string
        // can be converted to UTF-8 bytes and encoded as a byte mode segment.
        static makeBytes(data) {
          let bb = [];
          for (const b of data)
            appendBits(b, 8, bb);
          return new _QrSegment(_QrSegment.Mode.BYTE, data.length, bb);
        }
        // Returns a segment representing the given string of decimal digits encoded in numeric mode.
        static makeNumeric(digits) {
          if (!_QrSegment.isNumeric(digits))
            throw new RangeError("String contains non-numeric characters");
          let bb = [];
          for (let i = 0; i < digits.length; ) {
            const n = Math.min(digits.length - i, 3);
            appendBits(parseInt(digits.substring(i, i + n), 10), n * 3 + 1, bb);
            i += n;
          }
          return new _QrSegment(_QrSegment.Mode.NUMERIC, digits.length, bb);
        }
        // Returns a segment representing the given text string encoded in alphanumeric mode.
        // The characters allowed are: 0 to 9, A to Z (uppercase only), space,
        // dollar, percent, asterisk, plus, hyphen, period, slash, colon.
        static makeAlphanumeric(text) {
          if (!_QrSegment.isAlphanumeric(text))
            throw new RangeError("String contains unencodable characters in alphanumeric mode");
          let bb = [];
          let i;
          for (i = 0; i + 2 <= text.length; i += 2) {
            let temp = _QrSegment.ALPHANUMERIC_CHARSET.indexOf(text.charAt(i)) * 45;
            temp += _QrSegment.ALPHANUMERIC_CHARSET.indexOf(text.charAt(i + 1));
            appendBits(temp, 11, bb);
          }
          if (i < text.length)
            appendBits(_QrSegment.ALPHANUMERIC_CHARSET.indexOf(text.charAt(i)), 6, bb);
          return new _QrSegment(_QrSegment.Mode.ALPHANUMERIC, text.length, bb);
        }
        // Returns a new mutable list of zero or more segments to represent the given Unicode text string.
        // The result may use various segment modes and switch modes to optimize the length of the bit stream.
        static makeSegments(text) {
          if (text == "")
            return [];
          else if (_QrSegment.isNumeric(text))
            return [_QrSegment.makeNumeric(text)];
          else if (_QrSegment.isAlphanumeric(text))
            return [_QrSegment.makeAlphanumeric(text)];
          else
            return [_QrSegment.makeBytes(_QrSegment.toUtf8ByteArray(text))];
        }
        // Returns a segment representing an Extended Channel Interpretation
        // (ECI) designator with the given assignment value.
        static makeEci(assignVal) {
          let bb = [];
          if (assignVal < 0)
            throw new RangeError("ECI assignment value out of range");
          else if (assignVal < 1 << 7)
            appendBits(assignVal, 8, bb);
          else if (assignVal < 1 << 14) {
            appendBits(2, 2, bb);
            appendBits(assignVal, 14, bb);
          } else if (assignVal < 1e6) {
            appendBits(6, 3, bb);
            appendBits(assignVal, 21, bb);
          } else
            throw new RangeError("ECI assignment value out of range");
          return new _QrSegment(_QrSegment.Mode.ECI, 0, bb);
        }
        // Tests whether the given string can be encoded as a segment in numeric mode.
        // A string is encodable iff each character is in the range 0 to 9.
        static isNumeric(text) {
          return _QrSegment.NUMERIC_REGEX.test(text);
        }
        // Tests whether the given string can be encoded as a segment in alphanumeric mode.
        // A string is encodable iff each character is in the following set: 0 to 9, A to Z
        // (uppercase only), space, dollar, percent, asterisk, plus, hyphen, period, slash, colon.
        static isAlphanumeric(text) {
          return _QrSegment.ALPHANUMERIC_REGEX.test(text);
        }
        /*-- Methods --*/
        // Returns a new copy of the data bits of this segment.
        getData() {
          return this.bitData.slice();
        }
        // (Package-private) Calculates and returns the number of bits needed to encode the given segments at
        // the given version. The result is infinity if a segment has too many characters to fit its length field.
        static getTotalBits(segs, version) {
          let result = 0;
          for (const seg of segs) {
            const ccbits = seg.mode.numCharCountBits(version);
            if (seg.numChars >= 1 << ccbits)
              return Infinity;
            result += 4 + ccbits + seg.bitData.length;
          }
          return result;
        }
        // Returns a new array of bytes representing the given string encoded in UTF-8.
        static toUtf8ByteArray(str) {
          str = encodeURI(str);
          let result = [];
          for (let i = 0; i < str.length; i++) {
            if (str.charAt(i) != "%")
              result.push(str.charCodeAt(i));
            else {
              result.push(parseInt(str.substring(i + 1, i + 3), 16));
              i += 2;
            }
          }
          return result;
        }
      };
      /*-- Constants --*/
      // Describes precisely all strings that are encodable in numeric mode.
      _QrSegment.NUMERIC_REGEX = /^[0-9]*$/;
      // Describes precisely all strings that are encodable in alphanumeric mode.
      _QrSegment.ALPHANUMERIC_REGEX = /^[A-Z0-9 $%*+.\/:-]*$/;
      // The set of all legal characters in alphanumeric mode,
      // where each character value maps to the index in the string.
      _QrSegment.ALPHANUMERIC_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
      let QrSegment = _QrSegment;
      qrcodegen2.QrSegment = _QrSegment;
    })(qrcodegen || (qrcodegen = {}));
    ((qrcodegen2) => {
      let QrCode;
      ((QrCode2) => {
        const _Ecc = class _Ecc {
          // The QR Code can tolerate about 30% erroneous codewords
          /*-- Constructor and fields --*/
          constructor(ordinal, formatBits) {
            this.ordinal = ordinal;
            this.formatBits = formatBits;
          }
        };
        /*-- Constants --*/
        _Ecc.LOW = new _Ecc(0, 1);
        // The QR Code can tolerate about  7% erroneous codewords
        _Ecc.MEDIUM = new _Ecc(1, 0);
        // The QR Code can tolerate about 15% erroneous codewords
        _Ecc.QUARTILE = new _Ecc(2, 3);
        // The QR Code can tolerate about 25% erroneous codewords
        _Ecc.HIGH = new _Ecc(3, 2);
        let Ecc = _Ecc;
        QrCode2.Ecc = _Ecc;
      })(QrCode = qrcodegen2.QrCode || (qrcodegen2.QrCode = {}));
    })(qrcodegen || (qrcodegen = {}));
    ((qrcodegen2) => {
      let QrSegment;
      ((QrSegment2) => {
        const _Mode = class _Mode {
          /*-- Constructor and fields --*/
          constructor(modeBits, numBitsCharCount) {
            this.modeBits = modeBits;
            this.numBitsCharCount = numBitsCharCount;
          }
          /*-- Method --*/
          // (Package-private) Returns the bit width of the character count field for a segment in
          // this mode in a QR Code at the given version number. The result is in the range [0, 16].
          numCharCountBits(ver) {
            return this.numBitsCharCount[Math.floor((ver + 7) / 17)];
          }
        };
        /*-- Constants --*/
        _Mode.NUMERIC = new _Mode(1, [10, 12, 14]);
        _Mode.ALPHANUMERIC = new _Mode(2, [9, 11, 13]);
        _Mode.BYTE = new _Mode(4, [8, 16, 16]);
        _Mode.KANJI = new _Mode(8, [8, 10, 12]);
        _Mode.ECI = new _Mode(7, [0, 0, 0]);
        let Mode = _Mode;
        QrSegment2.Mode = _Mode;
      })(QrSegment = qrcodegen2.QrSegment || (qrcodegen2.QrSegment = {}));
    })(qrcodegen || (qrcodegen = {}));
    var qrcodegen_default = qrcodegen;

    /**
     * Render a QR code SVG string for arbitrary URL/text.
     * @param text - the string to encode (e.g. a pairing URL).
     * @returns SVG markup with a 4-module quiet zone.
     */
    function makeQrSvg(text) {
      const qr = qrcodegen_default.QrCode.encodeText(String(text), qrcodegen_default.QrCode.Ecc.MEDIUM);
      const margin = 4;
      const size = qr.size + margin * 2;
      const cells = [];
      for (let y = 0; y < qr.size; y++) {
        for (let x = 0; x < qr.size; x++) {
          if (qr.getModule(x, y)) cells.push(`M${x + margin} ${y + margin}h1v1h-1z`);
        }
      }
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`
        + `<rect width="${size}" height="${size}" fill="#ffffff"/>`
        + `<path d="${cells.join('')}" fill="#111827"/>`
        + '</svg>';
    }



    /* ==================== 图标 ==================== */
    function PhoneIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.8,
          strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        [
          h('rect', { key: 'b', x: 6, y: 2, width: 12, height: 20, rx: 2.5 }),
          h('line', { key: 'l', x1: 10.5, y1: 18.5, x2: 13.5, y2: 18.5 }),
        ],
      )
    }

    /* ==================== 取数 ==================== */
    function fetchJson(path, init) {
      return fetch(path, Object.assign(
        { credentials: 'same-origin', headers: { 'content-type': 'application/json' } },
        init || {},
      )).then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return null }).then(function (body) {
            return {
              ok: false,
              error: { message: (body && body.error && body.error.message) || ('HTTP ' + res.status) },
            }
          })
        }
        return res.json()
      })
    }

    /* ==================== 面板 DOM ==================== */
    var PANEL_CSS = [
      '.rwx-panel{display:flex;flex-direction:column;gap:14px;font-size:13px;',
      'color:var(--dsw-alias-label-primary);line-height:1.5}',
      '.rwx-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.rwx-code{font-size:34px;font-weight:700;letter-spacing:.14em;',
      'font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
      '.rwx-muted{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.rwx-qr{background:#fff;border-radius:12px;padding:12px;width:200px;height:200px;',
      'display:flex;align-items:center;justify-content:center;flex:none}',
      '.rwx-qr svg{width:100%;height:100%;display:block}',
      '.rwx-btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;',
      'color:var(--dsw-alias-label-primary);border-radius:10px;padding:6px 14px;',
      'font-size:13px;cursor:pointer;font-family:inherit;transition:background .12s ease}',
      '.rwx-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
      // ⚠️ 主按钮底色只能用 button-info-fill，**不能用 brand-primary**。
      // brand-primary 是随主题反转的**前景色**：浅色 #0f1115 / 深色 #f9fafb，
      // 拿它当底色再配 color:#fff，深色主题下就是白底白字（实测截图确认过）。
      // button-info-fill 两个主题都是蓝（deepseek-500 / deepseek-400）。
      '.rwx-btn-primary{background:var(--dsw-alias-button-info-fill);color:#fff;',
      'border-color:transparent;font-weight:600}',
      '.rwx-btn-primary:hover{background:var(--dsw-alias-button-info-hover)}',
      '.rwx-err{color:var(--dsw-alias-state-error-primary);font-size:12px}',
      '.rwx-ok{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}',
      '.rwx-qrcol{display:flex;flex-direction:column;align-items:center;gap:8px}',
      // 两个标签：同一个配对码，两种地址。手机在家扫「局域网」，出门扫「公网」。
      '.rwx-tabs{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);',
      'border-radius:8px;overflow:hidden}',
      '.rwx-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary);',
      'padding:4px 12px;font-size:12px;cursor:pointer;font-family:inherit}',
      '.rwx-tab[data-on="1"]{background:var(--dsw-alias-button-info-fill);color:#fff}',
      '.rwx-url{font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all;',
      'max-width:200px;text-align:center}',
    ].join('')

    function esc(v) {
      return String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    }

    function panelHtml(view) {
      var inner
      if (view.state === 'loading') {
        inner = '<div class="rwx-muted">正在生成配对码…</div>'
      } else if (view.state === 'error') {
        inner =
          '<div><div class="rwx-err">' + esc(view.message || '生成失败') + '</div>' +
          '<div class="rwx-row" style="margin-top:10px">' +
          '<button class="rwx-btn rwx-btn-primary" data-rwx="new">重试</button></div></div>'
      } else {
        var tabs = ''
        // 两个地址都有才给切换标签；只有一个就直接显示
        if (view.lan && view.public) {
          tabs =
            '<div class="rwx-tabs">' +
            '<button class="rwx-tab" data-on="' + (view.pick === 'lan' ? '1' : '0') +
            '" data-rwx="tab-lan">局域网</button>' +
            '<button class="rwx-tab" data-on="' + (view.pick === 'public' ? '1' : '0') +
            '" data-rwx="tab-public">公网</button>' +
            '</div>'
        }
        inner = [
          '<div class="rwx-ok">',
          '<div class="rwx-qrcol">',
          '<div class="rwx-qr">', view.svg || '', '</div>',
          tabs,
          '<div class="rwx-url">', esc(view.base || ''), '</div>',
          '</div>',
          '<div style="display:flex;flex-direction:column;gap:10px;min-width:190px">',
          '<div class="rwx-muted">在手机上输入这 6 位，或用 App 扫码</div>',
          '<div class="rwx-code">', esc(view.code || '------'), '</div>',
          '<div class="rwx-muted">', esc(view.expireText || ''), '</div>',
          '<div class="rwx-muted">已授权设备 ', String(view.devices || 0), ' 台</div>',
          '</div></div>',
          '<div class="rwx-row">',
          '<button class="rwx-btn rwx-btn-primary" data-rwx="new">刷新配对码</button>',
          '<button class="rwx-btn" data-rwx="copy">复制码</button>',
          '</div>',
          '<div class="rwx-muted">配对码 10 分钟内有效、只能用一次。' +
          '二维码里带地址和码，App 扫完会自动填好 —— ' +
          '在家扫「局域网」更快，出门用「公网」。</div>',
        ].join('')
      }
      return '<div class="rwx-panel">' + inner + '</div>'
    }

    /**
     * 二维码里装的地址。
     *
     * ⚠️ **不能用 `location.origin`**：面板跑在桌面浏览器里，
     * 那是 `http://127.0.0.1:19387`，手机扫过去只会连它自己，必然连不上。
     * 地址必须由宿主下发（`/rw/pair/endpoint` 会探测局域网 IP + 读配置里的公网域名）。
     *
     * 格式故意选成「普通 URL + query」而不是自定义 scheme：
     * 这样手机上用任何相机扫都能打开浏览器预览，App 也能自己解析，不依赖专用扫一扫。
     */
    function qrPayload(base, code) {
      return base + '/rw/pair?code=' + encodeURIComponent(code)
    }

    /* ==================== 弹层 ==================== */
    var active = null

    function closePanel() {
      if (!active) return
      document.removeEventListener('keydown', active.onKey, true)
      if (active.styleEl && active.styleEl.parentNode) active.styleEl.parentNode.removeChild(active.styleEl)
      if (active.host && active.host.parentNode) active.host.parentNode.removeChild(active.host)
      active = null
    }

    function openPanel() {
      if (active) { closePanel(); return }

      var styleEl = document.createElement('style')
      styleEl.setAttribute('data-rw-pair-style', '')
      styleEl.textContent = PANEL_CSS
      document.head.appendChild(styleEl)

      var host = document.createElement('div')
      host.setAttribute('data-rw-pair-host', '')
      host.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;' +
        'align-items:center;justify-content:center;background:rgba(0,0,0,.45);' +
        'backdrop-filter:blur(6px)'

      var card = document.createElement('div')
      card.style.cssText = 'min-width:min(520px,92vw);max-width:92vw;max-height:88vh;' +
        'overflow:auto;padding:22px 24px;border-radius:16px;' +
        'background:var(--dsw-alias-bg-overlay);' +
        'border:1px solid var(--dsw-alias-border-l2);' +
        'box-shadow:0 24px 64px rgba(0,0,0,.42);font-family:inherit;color:var(--dsw-alias-label-primary)'

      var head = document.createElement('div')
      head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;' +
        'margin-bottom:16px;font-size:16px;font-weight:600'
      var headText = document.createElement('span')
      headText.textContent = '配对我的手机'
      var closeBtn = document.createElement('button')
      closeBtn.type = 'button'
      closeBtn.textContent = '✕'
      closeBtn.setAttribute('aria-label', '关闭')
      closeBtn.style.cssText = 'border:0;background:transparent;cursor:pointer;font-size:16px;' +
        'line-height:1;padding:4px 8px;border-radius:8px;' +
        'color:var(--dsw-alias-label-secondary);font-family:inherit'
      head.appendChild(headText)
      head.appendChild(closeBtn)

      var body = document.createElement('div')

      card.appendChild(head)
      card.appendChild(body)
      host.appendChild(card)
      document.body.appendChild(host)

      var onKey = function (e) {
        if (e.key === 'Escape') { e.stopPropagation(); closePanel() }
      }
      document.addEventListener('keydown', onKey, true)
      active = { host: host, styleEl: styleEl, onKey: onKey }

      closeBtn.addEventListener('click', closePanel)
      host.addEventListener('mousedown', function (e) {
        if (e.target === host) closePanel()
      })

      // 当前选中的地址类型：'public' | 'lan'。宿主给了公网就默认公网 ——
      // 手机不保证和电脑同一个 Wi-Fi，公网是唯一必然可达的。
      var pick = 'public'
      var lastGood = null // 上一次成功的 { code, expiresAt, endpoint, devices }

      function paint(state) {
        body.innerHTML = panelHtml(state)
        bindButtons()
      }

      function paintOk() {
        if (!lastGood) return
        var g = lastGood
        var base = (pick === 'lan' ? g.endpoint.lan : g.endpoint.public) || g.endpoint.default
        paint({
          state: 'ok',
          code: g.code,
          base: base,
          pick: pick,
          svg: makeQrSvg(qrPayload(base, g.code)),
          devices: g.devices,
          expireText: '有效至 ' + new Date(g.expiresAt).toLocaleTimeString(),
          lan: g.endpoint.lan,
          public: g.endpoint.public,
        })
      }

      function bindButtons() {
        Array.prototype.forEach.call(body.querySelectorAll('[data-rwx]'), function (el) {
          var act = el.getAttribute('data-rwx')
          el.addEventListener('click', function () {
            if (act === 'new') { void refresh(); return }
            if (act === 'tab-lan') { pick = 'lan'; paintOk(); return }
            if (act === 'tab-public') { pick = 'public'; paintOk(); return }
            if (act === 'copy') {
              var codeEl = body.querySelector('.rwx-code')
              var text = codeEl ? codeEl.textContent : ''
              if (navigator.clipboard) navigator.clipboard.writeText(text)
              el.textContent = '已复制'
              setTimeout(function () { el.textContent = '复制码' }, 1200)
            }
          })
        })
      }

      function refresh() {
        paint({ state: 'loading' })
        // 三件事并行：发新码、拿已有设备数、问宿主「手机该连哪个地址」
        return Promise.all([
          fetchJson('/rw/pair/new', { method: 'POST' }),
          fetchJson('/rw/pair/info', { method: 'GET' }).catch(function () { return null }),
          fetchJson('/rw/pair/endpoint', { method: 'GET' }).catch(function () { return null }),
        ])
          .then(function (all) {
            var out = all[0]
            var info = all[1]
            var ep = all[2]
            if (!out || !out.ok) {
              throw new Error((out && out.error && out.error.message) || '宿主未返回配对码')
            }
            var endpoint = {
              lan: (ep && ep.lan) || '',
              public: (ep && ep.public) || '',
              default: (ep && ep.default) || '',
            }
            // 默认值拿不到就退到页面自身 origin（至少桌面端自己能用）
            if (!endpoint.default) {
              endpoint.default = (typeof location !== 'undefined' && location.origin) || ''
            }
            if (!endpoint.lan) endpoint.lan = endpoint.default
            if (!endpoint.public) endpoint.public = ''

            // 宿主没配公网就自动落到局域网，免得标签指着空地址
            pick = endpoint.public ? 'public' : 'lan'

            lastGood = {
              code: out.code,
              expiresAt: out.expiresAt,
              endpoint: endpoint,
              devices: (info && info.devices) ? info.devices.length : 0,
            }
            paintOk()
          })
          .catch(function (error) {
            paint({
              state: 'error',
              message: '生成失败：' + ((error && error.message) || error),
            })
          })
      }

      void refresh()
    }

    /* ==================== 触发按钮 ==================== */
    function PairButton() {
      var st = React.useState(false)
      var hover = st[0]
      var setHover = st[1]
      return h('button', {
        type: 'button',
        title: '配对我的手机',
        'aria-label': '配对我的手机',
        onClick: openPanel,
        onMouseEnter: function () { setHover(true) },
        onMouseLeave: function () { setHover(false) },
        style: {
          display: 'flex', alignItems: 'center', gap: 8,
          width: '100%', padding: '6px 10px',
          border: 0, borderRadius: 8, cursor: 'pointer',
          background: hover ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          font: 'inherit', fontSize: 13, textAlign: 'left',
          transition: 'background .12s ease',
        },
      }, [h(PhoneIcon, { key: 'i' }), h('span', { key: 't' }, '配对我的手机')])
    }

    return {
      inject: ['slots'],
      apply: function (ctx) {
        ctx.slots.inject('sidebar.footer.action', function () {
          return ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'rw-pair', order: 10 },
            PairButton,
          )
        })
        ctx.effect(function () { return closePanel })
      },
    }
  },
})
