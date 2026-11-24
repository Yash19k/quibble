// In-app QR scanner for the Join card: opens the camera in a themed popup, reads the host's QR code and hands back the
// game code. Uses the browser's own BarcodeDetector where there is one (Chrome on Android, ...); elsewhere (Safari on
// iPhone) it loads the vendored jsQR decoder on demand. No camera (denied, none, not HTTPS)? A photo of the code works
// too. A scan only ever yields a 6-character game code (common.codeFromScan): it never opens the scanned link.
import { el, codeFromScan } from './common.js';
import { icon } from './icons.js';

const SCAN_EVERY_MS = 120; // ~8 reads a second: quick to lock on, light on a phone's battery
const MAX_SIDE = 720; // frames are scaled down to this before decoding (QR codes on a screen are large)
let jsqrLoading = null;

/** The jsQR decoder (js/vendor/jsQR.js, a classic script that sets window.jsQR), loaded once on first use. */
function loadJsQr() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  jsqrLoading ??= new Promise((resolve, reject) => {
    const s = el('script', { src: '/js/vendor/jsQR.js', async: true });
    s.addEventListener('load', () => (window.jsQR ? resolve(window.jsQR) : reject(new Error('jsQR missing'))));
    s.addEventListener('error', () => { jsqrLoading = null; reject(new Error('Could not load the QR reader')); });
    document.head.append(s);
  });
  return jsqrLoading;
}

/** A function (source, width, height) -> decoded text or null, using the best reader this browser has. */
async function makeReader() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        return async (source) => (await detector.detect(source))[0]?.rawValue ?? null;
      }
    } catch { /* fall back to jsQR */ }
  }
  const jsQR = await loadJsQr();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return async (source, width, height, { both = false } = {}) => {
    const k = Math.min(1, MAX_SIDE / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * k));
    canvas.height = Math.max(1, Math.round(height * k));
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(img.data, img.width, img.height, { inversionAttempts: both ? 'attemptBoth' : 'dontInvert' })?.data ?? null;
  };
}

function cameraError(err) {
  if (!window.isSecureContext) return 'The camera needs a secure (https) page. Upload a photo of the code instead.';
  if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') return 'Camera access was blocked. Allow it in your browser settings, or upload a photo of the code.';
  if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') return 'No camera found. Upload a photo of the code instead.';
  if (err?.name === 'NotReadableError') return 'The camera is busy in another app. Close it and try again, or upload a photo.';
  return 'The camera could not start. Upload a photo of the code instead.';
}

/**
 * Open the scanner popup. Resolves the game code that was scanned, or null if the popup was closed without one.
 */
export function scanJoinCode() {
  return new Promise((resolve) => {
    let stream = null;
    let timer = 0;
    let done = false;
    let reader = null;
    let lastBadAt = 0;

    const video = el('video', { class: 'scan-video', playsinline: true, muted: true, autoplay: true, 'aria-hidden': 'true' });
    video.muted = true; // the attribute alone isn't enough for autoplay on iOS
    const frame = el('div', { class: 'scan-frame' }, video, el('div', { class: 'scan-target', 'aria-hidden': 'true' }),
      el('div', { class: 'scan-off', 'aria-hidden': 'true' }, icon('camera', { size: 34 })));
    const status = el('p', { class: 'scan-status', role: 'status', 'aria-live': 'polite' }, 'Starting the camera…');
    const file = el('input', { type: 'file', accept: 'image/*', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
    const upload = el('button', { type: 'button', class: 'ghost with-icon', onclick: () => file.click() }, icon('image'), 'Upload a photo');
    const cancel = el('button', { type: 'button', class: 'ghost', onclick: () => dlg.close() }, 'Cancel');
    const dlg = el('dialog', { class: 'modal scan-modal', 'aria-labelledby': 'scan-title' },
      el('h3', { id: 'scan-title', class: 'with-icon' }, icon('scan', { size: 22 }), 'Scan to join'),
      el('p', { class: 'muted' }, 'Point your camera at the QR code on the host’s screen.'),
      frame,
      status,
      file,
      el('div', { class: 'modal-actions' }, upload, cancel));

    const setStatus = (text, kind = '') => {
      status.textContent = text;
      status.className = `scan-status${kind ? ` ${kind}` : ''}`;
    };

    function stop() {
      clearTimeout(timer);
      timer = 0;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      video.srcObject = null;
    }

    function finish(code) {
      if (done) return;
      done = true;
      stop();
      if (code) navigator.vibrate?.(40);
      dlg.close(code ? 'ok' : '');
      resolve(code);
    }

    /** True if `text` was a game code (and the popup is closing). */
    function handle(text) {
      if (text == null) return false;
      const code = codeFromScan(text);
      if (code) {
        setStatus(`Found game ${code}`, 'good');
        frame.classList.add('found');
        setTimeout(() => finish(code), 250);
        return true;
      }
      if (Date.now() - lastBadAt > 2500) setStatus('That QR code isn’t a Quibble game. Try the one on the host’s screen.', 'bad');
      lastBadAt = Date.now();
      return false;
    }

    async function tick() {
      timer = 0;
      if (done || !stream) return;
      if (video.readyState >= 2 && video.videoWidth) {
        try {
          if (handle(await reader(video, video.videoWidth, video.videoHeight))) return;
        } catch { /* a frame that couldn't be read: try the next one */ }
      }
      if (!done && stream) timer = setTimeout(tick, SCAN_EVERY_MS);
    }

    async function startCamera() {
      try {
        reader ??= await makeReader();
      } catch {
        setStatus('The QR reader could not load. Check your connection and try again.', 'bad');
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        frame.classList.add('off');
        setStatus(cameraError(), 'bad');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
      } catch (err) {
        frame.classList.add('off');
        setStatus(cameraError(err), 'bad');
        return;
      }
      if (done) return stop(); // closed while the permission prompt was up
      video.srcObject = stream;
      try { await video.play(); } catch { /* autoplay is muted; frames still arrive */ }
      setStatus('Looking for a QR code…');
      tick();
    }

    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      setStatus('Reading the photo…');
      try {
        reader ??= await makeReader();
        const bmp = await createImageBitmap(f);
        const text = await reader(bmp, bmp.width, bmp.height, { both: true });
        bmp.close?.();
        if (text == null) setStatus('No QR code found in that photo. Try a sharper, closer one.', 'bad');
        else if (!handle(text)) setStatus('That QR code isn’t a Quibble game.', 'bad');
      } catch {
        setStatus('That photo could not be read. Try another one.', 'bad');
      }
    });

    // The camera pauses while the tab is hidden (and iOS stops it): restart when the page is shown again.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !done && !stream && !frame.classList.contains('off')) startCamera();
      else if (document.visibilityState === 'hidden') stop();
    };
    document.addEventListener('visibilitychange', onVisible);

    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener('close', () => {
      document.removeEventListener('visibilitychange', onVisible);
      if (!done) {
        done = true;
        stop();
        resolve(null);
      }
      dlg.remove();
    }, { once: true });

    document.body.append(dlg);
    dlg.showModal();
    cancel.focus();
    startCamera();
  });
}
