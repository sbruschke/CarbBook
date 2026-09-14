import { useEffect, useRef, useState } from 'react';
import { useServices } from '../app/services';
import { isBarcodeCode, type ScanSession } from '../barcode/scanner';

/** Camera scanner with a typed-code fallback (camera denied, no camera, damaged label). */
export function ScannerDialog(props: { onCode: (code: string) => void; onClose: () => void }) {
  const { startScanner } = useServices();
  const videoRef = useRef<HTMLVideoElement>(null);
  const onCodeRef = useRef(props.onCode);
  onCodeRef.current = props.onCode;
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let session: ScanSession | null = null;
    let done = false;
    startScanner(video, (code) => {
      if (done) return;
      done = true;
      session?.stop();
      onCodeRef.current(code);
    })
      .then((started) => {
        session = started;
        if (done) started.stop();
      })
      .catch((e: unknown) => {
        setError(`Camera unavailable (${e instanceof Error ? e.message : String(e)}). Type the barcode instead.`);
      });
    return () => {
      done = true;
      session?.stop();
    };
  }, [startScanner]);

  const code = typed.trim();
  return (
    <div className="overlay" role="dialog" aria-label="Scan barcode">
      <video ref={videoRef} className="scanner-video" muted playsInline />
      {error && <p role="alert">{error}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (isBarcodeCode(code)) onCodeRef.current(code);
        }}
      >
        <label>
          Barcode
          <input inputMode="numeric" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </label>
        <div className="button-row">
          <button type="submit" className="primary" disabled={!isBarcodeCode(code)}>
            Look up
          </button>
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
