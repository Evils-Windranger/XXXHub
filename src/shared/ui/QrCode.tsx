import { useMemo } from "react";

// Minimal zero-dependency ISO/IEC 18004 QR Code (Byte mode, ECC-L, Versions 1..6, up to 134 bytes).
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsPoly(ecLen: number): number[] {
  let poly = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsCompute(data: number[], ecLen: number): number[] {
  const gen = rsPoly(ecLen);
  const rem = new Array<number>(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    if (factor !== 0) {
      for (let i = 0; i < ecLen; i++) rem[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return rem;
}

// [version, size, totalDataBytes, ecBytesPerBlock, numBlocks, alignPositions]
const VERSION_SPECS: Array<[number, number, number, number, number, number[]]> = [
  [1, 21, 19, 7, 1, []],
  [2, 25, 34, 10, 1, [6, 18]],
  [3, 29, 55, 15, 1, [6, 22]],
  [4, 33, 80, 20, 1, [6, 26]],
  [5, 37, 108, 26, 1, [6, 30]],
  [6, 41, 136, 18, 2, [6, 34]],
];

function formatBits(mask: number): number {
  // ECC-L indicator = 01 (bits 4..3), mask = 3 bits (bits 2..0)
  const data = (0b01 << 3) | (mask & 7);
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function maskCond(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

export function encodeQrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  // Byte mode header: 4-bit mode (0100) + 8-bit length = 12 bits + 4-bit terminator = 2 bytes overhead
  const spec = VERSION_SPECS.find(([, , cap]) => bytes.length + 2 <= cap);
  if (!spec) throw new Error("QR payload too long");
  const [ver, size, dataCap, ecPerBlock, numBlocks, align] = spec;

  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  pushBits(0b0100, 4);
  pushBits(bytes.length, 8);
  for (const b of bytes) pushBits(b, 8);
  const capBits = dataCap * 8;
  pushBits(0, Math.min(4, capBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  let padToggle = 0;
  while (bits.length < capBits) {
    pushBits(padToggle ? 0x11 : 0xec, 8);
    padToggle ^= 1;
  }

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    codewords.push(b);
  }

  // Split into equal blocks (Versions 1..6 ECC-L all have evenly divisible block lengths)
  const blockLen = dataCap / numBlocks;
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  for (let b = 0; b < numBlocks; b++) {
    const slice = codewords.slice(b * blockLen, (b + 1) * blockLen);
    dataBlocks.push(slice);
    ecBlocks.push(rsCompute(slice, ecPerBlock));
  }
  const finalBytes: number[] = [];
  for (let i = 0; i < blockLen; i++) for (let b = 0; b < numBlocks; b++) finalBytes.push(dataBlocks[b][i]);
  for (let i = 0; i < ecPerBlock; i++) for (let b = 0; b < numBlocks; b++) finalBytes.push(ecBlocks[b][i]);

  const grid: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(-1));
  const setFn = (r: number, c: number, dark: boolean) => {
    if (r >= 0 && r < size && c >= 0 && c < size) grid[r][c] = dark ? 2 : 3;
  };
  const drawFinder = (top: number, left: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const dark = inside && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        setFn(top + dr, left + dc, dark);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  for (const r of align) {
    for (const c of align) {
      if (grid[r][c] !== -1) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          setFn(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }
  for (let i = 8; i < size - 8; i++) {
    if (grid[6][i] === -1) setFn(6, i, i % 2 === 0);
    if (grid[i][6] === -1) setFn(i, 6, i % 2 === 0);
  }
  setFn(4 * ver + 9, 8, true); // dark module

  // Reserve format info slots
  for (let i = 0; i < 9; i++) {
    if (grid[8][i] === -1) grid[8][i] = 3;
    if (grid[i][8] === -1) grid[i][8] = 3;
  }
  for (let i = 0; i < 8; i++) {
    if (grid[8][size - 1 - i] === -1) grid[8][size - 1 - i] = 3;
    if (grid[size - 1 - i][8] === -1) grid[size - 1 - i][8] = 3;
  }

  // Place data bits in upward/downward 2-col zigzag
  let bitIdx = 0;
  const totalBits = finalBytes.length * 8;
  let upward = true;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col--;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx++) {
        const c = col - dx;
        if (grid[r][c] !== -1) continue;
        const dark = bitIdx < totalBits ? ((finalBytes[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1) === 1 : false;
        grid[r][c] = dark ? 1 : 0;
        bitIdx++;
      }
    }
    upward = !upward;
  }

  // Pick mask with lowest penalty score
  let bestMatrix: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m: boolean[][] = Array.from({ length: size }, (_, r) =>
      Array.from({ length: size }, (_, c) => {
        const cell = grid[r][c];
        if (cell === 2) return true;
        if (cell === 3) return false;
        const bit = cell === 1;
        return maskCond(mask, r, c) ? !bit : bit;
      }),
    );
    const fmt = formatBits(mask);
    for (let i = 0; i < 6; i++) m[8][i] = Boolean((fmt >> (14 - i)) & 1);
    m[8][7] = Boolean((fmt >> 8) & 1);
    m[8][8] = Boolean((fmt >> 7) & 1);
    m[7][8] = Boolean((fmt >> 6) & 1);
    for (let i = 0; i < 6; i++) m[5 - i][8] = Boolean((fmt >> (5 - i)) & 1);
    for (let i = 0; i < 8; i++) m[8][size - 1 - i] = Boolean((fmt >> i) & 1);
    for (let i = 0; i < 7; i++) m[size - 1 - i][8] = Boolean((fmt >> (14 - i)) & 1);

    let score = 0;
    for (let r = 0; r < size; r++) {
      let run = 1;
      for (let c = 1; c < size; c++) {
        if (m[r][c] === m[r][c - 1]) { run++; if (run === 5) score += 3; else if (run > 5) score += 1; }
        else run = 1;
      }
    }
    for (let c = 0; c < size; c++) {
      let run = 1;
      for (let r = 1; r < size; r++) {
        if (m[r][c] === m[r - 1][c]) { run++; if (run === 5) score += 3; else if (run > 5) score += 1; }
        else run = 1;
      }
    }
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }
    if (score < bestScore) {
      bestScore = score;
      bestMatrix = m;
    }
  }
  return bestMatrix!;
}

export default function QrCode({
  value,
  size = 188,
  className,
  quietZone = 2,
}: {
  value: string;
  size?: number;
  className?: string;
  quietZone?: number;
}) {
  const q = Math.max(0, Math.floor(quietZone));
  const { modules, path } = useMemo(() => {
    try {
      const m = encodeQrMatrix(value);
      let d = "";
      for (let r = 0; r < m.length; r++) {
        for (let c = 0; c < m.length; c++) {
          if (m[r][c]) d += `M${c + q},${r + q}h1v1h-1z`;
        }
      }
      return { modules: m.length + q * 2, path: d };
    } catch {
      return { modules: 0, path: "" };
    }
  }, [value, q]);

  if (!modules) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${modules} ${modules}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={value}
      className={className}
      style={{ display: "block", borderRadius: 12, background: "#fff" }}
    >
      <rect width={modules} height={modules} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
