export interface ScanSession {
  stop(): void;
}

/** Starts the camera in `video` and calls `onCode` for each retail barcode seen. */
export type StartScanner = (video: HTMLVideoElement, onCode: (code: string) => void) => Promise<ScanSession>;

/** Shape of the Barcode Detection API (not in TypeScript's DOM lib). */
interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}
interface BarcodeDetectorClass {
  new (options: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats(): Promise<string[]>;
}

export const RETAIL_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
const CAMERA: MediaStreamConstraints = { video: { facingMode: 'environment' }, audio: false };

/** Codes the server accepts at /api/barcode/:code. */
export const isBarcodeCode = (text: string): boolean => /^\d{6,14}$/.test(text);

async function startNative(Detector: BarcodeDetectorClass, formats: string[], video: HTMLVideoElement, onCode: (code: string) => void): Promise<ScanSession> {
  const stream = await navigator.mediaDevices.getUserMedia(CAMERA);
  video.srcObject = stream;
  await video.play();
  const detector = new Detector({ formats });
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const code = (await detector.detect(video)).map((b) => b.rawValue).find(isBarcodeCode);
      if (code) onCode(code);
    } catch {
      // The video frame was not ready yet; try the next tick.
    }
    if (!stopped) setTimeout(() => void tick(), 250);
  };
  void tick();
  return {
    stop() {
      stopped = true;
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
    },
  };
}

async function startZxing(video: HTMLVideoElement, onCode: (code: string) => void): Promise<ScanSession> {
  // Loaded only when BarcodeDetector is missing (Safari, Firefox), keeping it out of the main bundle.
  const { BrowserMultiFormatReader } = await import('@zxing/browser');
  const controls = await new BrowserMultiFormatReader().decodeFromConstraints(CAMERA, video, (result) => {
    const text = result?.getText();
    if (text && isBarcodeCode(text)) onCode(text);
  });
  return { stop: () => controls.stop() };
}

/** BarcodeDetector where it supports retail formats (spec §8), ZXing otherwise. */
export const startScanner: StartScanner = async (video, onCode) => {
  const Detector = (globalThis as { BarcodeDetector?: BarcodeDetectorClass }).BarcodeDetector;
  if (Detector) {
    const formats = (await Detector.getSupportedFormats()).filter((f) => RETAIL_FORMATS.includes(f));
    if (formats.length > 0) return startNative(Detector, formats, video, onCode);
  }
  return startZxing(video, onCode);
};
