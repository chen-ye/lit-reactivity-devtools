import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const EXT_DIST = join(DIST, "extension");
const CLIENT_DIST = join(DIST, "client");
const DEMO_DIST = join(DIST, "demo");

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(4 + 4 + data.length + 4);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) {
    chunk[4 + i] = type.charCodeAt(i);
  }
  chunk.set(data, 8);
  const crc = crc32(chunk.subarray(4, 8 + data.length));
  view.setUint32(8 + data.length, crc, false);
  return chunk;
}

function renderIconPng(size: number): Uint8Array {
  const stride = size * 4 + 1;
  const raw = new Uint8Array(stride * size);

  const setPixel = (
    x: number,
    y: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const offset = y * stride + 1 + x * 4;
    const prevA = (raw[offset + 3] ?? 0) / 255;
    const nextA = a / 255;
    const outA = nextA + prevA * (1 - nextA);
    if (outA <= 0) return;
    raw[offset] = Math.round(
      (r * nextA + (raw[offset] ?? 0) * prevA * (1 - nextA)) / outA,
    );
    raw[offset + 1] = Math.round(
      (g * nextA + (raw[offset + 1] ?? 0) * prevA * (1 - nextA)) / outA,
    );
    raw[offset + 2] = Math.round(
      (b * nextA + (raw[offset + 2] ?? 0) * prevA * (1 - nextA)) / outA,
    );
    raw[offset + 3] = Math.round(outA * 255);
  };

  const fillCircle = (
    cx: number,
    cy: number,
    radius: number,
    r: number,
    g: number,
    b: number,
  ) => {
    const minX = Math.floor(cx - radius - 1);
    const maxX = Math.ceil(cx + radius + 1);
    const minY = Math.floor(cy - radius - 1);
    const maxY = Math.ceil(cy + radius + 1);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const alpha = Math.max(0, Math.min(1, radius + 0.5 - dist));
        if (alpha > 0) setPixel(x, y, r, g, b, Math.round(alpha * 255));
      }
    }
  };

  const drawSegment = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    thickness: number,
    r: number,
    g: number,
    b: number,
  ) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy || 1;
    const minX = Math.floor(Math.min(x1, x2) - thickness - 1);
    const maxX = Math.ceil(Math.max(x1, x2) + thickness + 1);
    const minY = Math.floor(Math.min(y1, y2) - thickness - 1);
    const maxY = Math.ceil(Math.max(y1, y2) + thickness + 1);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const t = Math.max(
          0,
          Math.min(1, ((x + 0.5 - x1) * dx + (y + 0.5 - y1) * dy) / len2),
        );
        const px = x1 + t * dx;
        const py = y1 + t * dy;
        const dist = Math.hypot(x + 0.5 - px, y + 0.5 - py);
        const alpha = Math.max(0, Math.min(1, thickness * 0.5 + 0.5 - dist));
        if (alpha > 0) setPixel(x, y, r, g, b, Math.round(alpha * 255));
      }
    }
  };

  const radius = size * 0.22;
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      const dx = Math.max(
        0,
        Math.abs(x + 0.5 - size / 2) - (size / 2 - radius),
      );
      const dy = Math.max(
        0,
        Math.abs(y + 0.5 - size / 2) - (size / 2 - radius),
      );
      const dist = Math.hypot(dx, dy);
      const alpha = Math.max(0, Math.min(1, radius + 0.5 - dist));
      if (alpha > 0) {
        setPixel(x, y, 19, 24, 33, Math.round(alpha * 255));
      }
    }
  }

  // Lit Flow emblem: Model -> Controller -> Element + Context -> Memo
  const m = { x: size * 0.22, y: size * 0.3 };
  const ctx = { x: size * 0.22, y: size * 0.7 };
  const el = { x: size * 0.52, y: size * 0.5 };
  const comp = { x: size * 0.8, y: size * 0.32 };
  const obs = { x: size * 0.8, y: size * 0.68 };
  const edgeWidth = Math.max(1.2, size * 0.065);

  drawSegment(m.x, m.y, el.x, el.y, edgeWidth, 128, 152, 184);
  drawSegment(ctx.x, ctx.y, el.x, el.y, edgeWidth, 128, 152, 184);
  drawSegment(el.x, el.y, comp.x, comp.y, edgeWidth, 128, 152, 184);
  drawSegment(el.x, el.y, obs.x, obs.y, edgeWidth, 128, 152, 184);

  const nodeR = Math.max(2, size * 0.11);
  fillCircle(m.x, m.y, nodeR, 88, 166, 255); // Model blue
  fillCircle(ctx.x, ctx.y, nodeR, 242, 180, 65); // Context amber
  fillCircle(el.x, el.y, nodeR * 1.12, 57, 211, 83); // Element green
  fillCircle(comp.x, comp.y, nodeR, 86, 211, 100); // Computed emerald
  fillCircle(obs.x, obs.y, nodeR, 199, 155, 255); // Observer violet

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, size, false);
  ihdrView.setUint32(4, size, false);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const compressed = deflateSync(raw);
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrChunk = makePngChunk("IHDR", ihdr);
  const idatChunk = makePngChunk("IDAT", compressed);
  const iendChunk = makePngChunk("IEND", new Uint8Array(0));

  const png = new Uint8Array(
    sig.length + ihdrChunk.length + idatChunk.length + iendChunk.length,
  );
  let pos = 0;
  for (const part of [sig, ihdrChunk, idatChunk, iendChunk]) {
    png.set(part, pos);
    pos += part.length;
  }
  return png;
}

async function bundleChecked(
  options: Parameters<typeof Bun.build>[0],
  label: string,
): Promise<void> {
  const result = await Bun.build(options);
  if (!result.success) {
    const details = result.logs.map((log) => log.message).join("\n");
    throw new Error(`Bun.build failed for ${label}:\n${details}`);
  }
}

async function main(): Promise<void> {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(join(EXT_DIST, "icons"), { recursive: true });
  mkdirSync(CLIENT_DIST, { recursive: true });
  mkdirSync(DEMO_DIST, { recursive: true });

  for (const size of [16, 32, 48, 128]) {
    writeFileSync(
      join(EXT_DIST, "icons", `icon-${size}.png`),
      renderIconPng(size),
    );
  }

  cpSync(
    join(ROOT, "src/extension/manifest.json"),
    join(EXT_DIST, "manifest.json"),
  );
  cpSync(
    join(ROOT, "src/extension/devtools.html"),
    join(EXT_DIST, "devtools.html"),
  );
  cpSync(join(ROOT, "src/panel/panel.html"), join(EXT_DIST, "panel.html"));
  cpSync(join(ROOT, "src/panel/panel.css"), join(EXT_DIST, "panel.css"));

  await Promise.all([
    bundleChecked(
      {
        entrypoints: [join(ROOT, "src/hook/main-entry.ts")],
        outdir: EXT_DIST,
        naming: "hook-main.js",
        format: "iife",
        target: "browser",
      },
      "hook-main",
    ),
    bundleChecked(
      {
        entrypoints: [join(ROOT, "src/hook/isolated-bridge.ts")],
        outdir: EXT_DIST,
        naming: "bridge-isolated.js",
        format: "iife",
        target: "browser",
      },
      "bridge-isolated",
    ),
    bundleChecked(
      {
        entrypoints: [join(ROOT, "src/extension/background.ts")],
        outdir: EXT_DIST,
        naming: "background.js",
        format: "esm",
        target: "browser",
      },
      "background",
    ),
    bundleChecked(
      {
        entrypoints: [join(ROOT, "src/extension/devtools.ts")],
        outdir: EXT_DIST,
        naming: "devtools.js",
        format: "esm",
        target: "browser",
      },
      "devtools",
    ),
    bundleChecked(
      {
        entrypoints: [join(ROOT, "src/panel/main.ts")],
        outdir: EXT_DIST,
        naming: "panel.js",
        format: "esm",
        target: "browser",
      },
      "panel",
    ),
    bundleChecked(
      {
        entrypoints: [join(ROOT, "src/client/index.ts")],
        outdir: CLIENT_DIST,
        naming: "index.js",
        format: "esm",
        target: "browser",
      },
      "client-index",
    ),
  ]);

  const tscProc = Bun.spawnSync(
    ["bunx", "tsc", "-p", join(ROOT, "tsconfig.client.json")],
    {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (tscProc.exitCode !== 0) {
    throw new Error(
      `tsc declaration emit failed:\n${tscProc.stdout.toString()}\n${tscProc.stderr.toString()}`,
    );
  }

  cpSync(join(ROOT, "src/demo/index.html"), join(DEMO_DIST, "index.html"));
  cpSync(join(ROOT, "src/demo/styles.css"), join(DEMO_DIST, "styles.css"));
  cpSync(join(ROOT, "src/panel/panel.html"), join(DEMO_DIST, "panel.html"));
  cpSync(join(ROOT, "src/panel/panel.css"), join(DEMO_DIST, "panel.css"));
  cpSync(join(EXT_DIST, "panel.js"), join(DEMO_DIST, "panel.js"));

  await bundleChecked(
    {
      entrypoints: [join(ROOT, "src/demo/main.ts")],
      outdir: DEMO_DIST,
      naming: "main.js",
      format: "esm",
      target: "browser",
    },
    "demo",
  );

  console.log(
    "Built dist/extension, dist/client, dist/types, and dist/demo successfully.",
  );
}

await main();
