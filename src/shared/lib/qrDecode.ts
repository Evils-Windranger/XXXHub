export type TvLanTarget = {
  url: string;
  ip: string;
  port: number;
  token: string;
};

type JsQrFn = typeof import("jsqr").default;

type BarcodeDetectorInstance = {
  detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue?: string }>>;
};

type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorInstance;

let jsQrPromise: Promise<JsQrFn> | null = null;
let detectorInstance: BarcodeDetectorInstance | null | false = null;

function isRfc1918Ipv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
  if (nums.some((n) => n < 0 || n > 255)) return false;
  const [a, b] = nums;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Validate an ephemeral TV LAN push URL (`http://<rfc1918-ip>:<port>=1024+/?t=<token>`). */
export function parseTvLanTarget(raw: string): TvLanTarget | null {
  const trimmed = raw.trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" || u.username || u.password) return null;
  if (!isRfc1918Ipv4(u.hostname)) return null;
  if (!u.port) return null;
  const port = Number(u.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  const token = u.searchParams.get("t") ?? "";
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(token)) return null;
  return { url: u.toString(), ip: u.hostname, port, token };
}

function getDetector(): BarcodeDetectorInstance | null {
  if (detectorInstance === false) return null;
  if (detectorInstance) return detectorInstance;
  const Ctor = (typeof window !== "undefined"
    ? (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
    : undefined);
  if (!Ctor) {
    detectorInstance = false;
    return null;
  }
  try {
    detectorInstance = new Ctor({ formats: ["qr_code"] });
    return detectorInstance;
  } catch {
    detectorInstance = false;
    return null;
  }
}

async function getJsQr(): Promise<JsQrFn> {
  if (!jsQrPromise) {
    jsQrPromise = import("jsqr").then((mod) => {
      const m = mod as unknown as JsQrFn | { default?: JsQrFn };
      return typeof m === "function" ? m : m.default!;
    });
  }
  return jsQrPromise;
}

async function decodeCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): Promise<string | null> {
  const detector = getDetector();
  if (detector) {
    try {
      const hits = await detector.detect(canvas);
      const val = hits.find((h) => h.rawValue)?.rawValue?.trim();
      if (val) return val;
    } catch {
      detectorInstance = false;
    }
  }
  const jsQR = await getJsQr();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const hit = jsQR(img.data, canvas.width, canvas.height, { inversionAttempts: "attemptBoth" });
  return hit?.data?.trim() || null;
}

export async function decodeQrFromVideo(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
): Promise<string | null> {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
  const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
  const w = Math.max(1, Math.round(video.videoWidth * scale));
  const h = Math.max(1, Math.round(video.videoHeight * scale));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, w, h);
  return decodeCanvas(canvas, ctx);
}

function loadImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image load failed"));
    };
    img.src = url;
  });
}

export async function decodeQrFromFile(file: File): Promise<string | null> {
  const canvas = document.createElement("canvas");
  let source: ImageBitmap | HTMLImageElement | null = null;
  let width = 0;
  let height = 0;
  try {
    if (typeof createImageBitmap === "function") {
      try {
        const bmp = await createImageBitmap(file);
        source = bmp;
        width = bmp.width;
        height = bmp.height;
      } catch { /* fallback to Image element */ }
    }
    if (!source) {
      const img = await loadImageElement(file);
      source = img;
      width = img.naturalWidth || img.width;
      height = img.naturalHeight || img.height;
    }
    if (!width || !height) return null;
    const scale = Math.min(1, 1024 / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return await decodeCanvas(canvas, ctx);
  } finally {
    if (source && "close" in source && typeof source.close === "function") {
      source.close();
    }
  }
}
