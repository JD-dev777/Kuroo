import { createHash, randomInt } from 'node:crypto';
import { deflateSync } from 'node:zlib';
// Small bitmap alphabet keeps captcha rendering independent of native libraries and fonts.
const glyphs: Record<string, string[]> = {
  A: ['01110','10001','10001','11111','10001','10001','10001'],
  E: ['11111','10000','10000','11110','10000','10000','11111'],
  F: ['11111','10000','10000','11110','10000','10000','10000'],
  H: ['10001','10001','10001','11111','10001','10001','10001'],
  J: ['00111','00010','00010','00010','00010','10010','01100'],
  K: ['10001','10010','10100','11000','10100','10010','10001'],
  M: ['10001','11011','10101','10101','10001','10001','10001'],
  N: ['10001','11001','11001','10101','10011','10011','10001'],
  R: ['11110','10001','10001','11110','10100','10010','10001'],
  T: ['11111','00100','00100','00100','00100','00100','00100'],
  X: ['10001','10001','01010','00100','01010','10001','10001'],
  Y: ['10001','10001','01010','00100','00100','00100','00100'],
  '2': ['01110','10001','00001','00010','00100','01000','11111'],
  '3': ['11110','00001','00001','01110','00001','00001','11110'],
  '4': ['00010','00110','01010','10010','11111','00010','00010'],
  '5': ['11111','10000','10000','11110','00001','00001','11110'],
  '6': ['01110','10000','10000','11110','10001','10001','01110'],
  '7': ['11111','00001','00010','00100','01000','01000','01000'],
  '8': ['01110','10001','10001','01110','10001','10001','01110'],
  '9': ['01110','10001','10001','01111','00001','00001','01110'],
};
function chunk(type: string, data: Buffer) {
  const name = Buffer.from(type); const payload = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of payload) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, payload, checksum]);
}
export function captchaDigest(nonce: string, answer: string) {
  return createHash('sha256').update(`${nonce}:${answer.trim().toUpperCase()}`).digest('hex');
}
export function createCaptcha() {
  const width = 300, height = 90;
  const pixels = Buffer.alloc(width * height * 3, 30);
  const paint = (x: number, y: number, color: number[]) => {
    if (x >= 0 && x < width && y >= 0 && y < height) for (let c = 0; c < 3; c++) pixels[(y * width + x) * 3 + c] = color[c]!;
  };
  const alphabet = Object.keys(glyphs);
  let answer = '';
  for (let letter = 0; letter < 6; letter++) {
    const char = alphabet[randomInt(alphabet.length)]!; answer += char;
    const top = randomInt(15, 35), left = 12 + letter * 47, shear = randomInt(-2, 3);
    const color = [randomInt(170, 256), randomInt(150, 256), randomInt(170, 256)];
    glyphs[char]!.forEach((row, y) => [...row].forEach((bit, x) => {
      if (bit !== '1') return;
      for (let dx = 0; dx < 5; dx++) for (let dy = 0; dy < 6; dy++) paint(left + x * 5 + dx + Math.floor(y * shear / 2), top + y * 6 + dy, color);
    }));
  }
  for (let i = 0; i < 700; i++) paint(randomInt(width), randomInt(height), [randomInt(80, 180), randomInt(80, 180), randomInt(80, 180)]);
  const scanlines = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(scanlines, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const image = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
  return { answer, image };
}
