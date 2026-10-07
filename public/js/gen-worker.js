// Module Web Worker: runs generate.js off the main thread with every decoder
// available here (ZXing-wasm, jsQR, and the platform scanner when exposed).

import '../vendor/jsQR.js'; // UMD build: defines self.jsQR
import { readBarcodes, prepareZXingModule } from '../vendor/zxing/reader/index.js';
import { generateAll } from './generate.js';
import { jsqrDecoder, zxingDecoder, nativeDecoder } from './verify.js';

prepareZXingModule({
  overrides: {
    locateFile: (path, prefix) =>
      path.endsWith('.wasm') ? new URL('../vendor/zxing/zxing_reader.wasm', import.meta.url).href : prefix + path,
  },
});

let decodersPromise = null;
function getDecoders() {
  decodersPromise ??= (async () => {
    const list = [zxingDecoder(readBarcodes), jsqrDecoder(self.jsQR)];
    try {
      if ('BarcodeDetector' in self && (await self.BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
        list.push(nativeDecoder(self.BarcodeDetector));
      }
    } catch { /* no platform scanner */ }
    return list;
  })();
  return decodersPromise;
}

self.onmessage = async ({ data: msg }) => {
  if (msg.type !== 'generate') return;
  const { jobId } = msg;
  const post = (m) => self.postMessage({ jobId, ...m });
  try {
    const decoders = await getDecoders();
    post({ type: 'decoders', names: decoders.map((d) => d.name) });
    let done = 0, total = 0;
    await generateAll({
      ...msg,
      decoders,
      onStart: (t) => { total = t; post({ type: 'start', total }); },
      onCandidate: (candidate) => {
        post({ type: 'candidate', candidate });
        post({ type: 'progress', done: ++done, total });
      },
    });
    post({ type: 'done' });
  } catch (e) {
    post({ type: 'error', message: e.message || String(e) });
  }
};
