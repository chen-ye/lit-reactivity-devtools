import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  bundleChecked,
  copyPanelAssets,
  createPngCanvas,
  emitClientDeclarations,
} from "./build-shared.ts";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const EXT_DIST = join(DIST, "extension");
const CLIENT_DIST = join(DIST, "client");
const DEMO_DIST = join(DIST, "demo");
const PANEL_SRC = join(ROOT, "src/panel");

function renderIconPng(size: number): Uint8Array {
  const canvas = createPngCanvas(size);

  canvas.fillRoundedRect(0, 0, size, size, size * 0.22, 19, 24, 33);

  // Lit Flow emblem: Model -> Controller -> Element + Context -> Memo
  const m = { x: size * 0.22, y: size * 0.3 };
  const ctx = { x: size * 0.22, y: size * 0.7 };
  const el = { x: size * 0.52, y: size * 0.5 };
  const comp = { x: size * 0.8, y: size * 0.32 };
  const obs = { x: size * 0.8, y: size * 0.68 };
  const edgeWidth = Math.max(1.2, size * 0.065);

  canvas.drawSegment(m.x, m.y, el.x, el.y, edgeWidth, 128, 152, 184);
  canvas.drawSegment(ctx.x, ctx.y, el.x, el.y, edgeWidth, 128, 152, 184);
  canvas.drawSegment(el.x, el.y, comp.x, comp.y, edgeWidth, 128, 152, 184);
  canvas.drawSegment(el.x, el.y, obs.x, obs.y, edgeWidth, 128, 152, 184);

  const nodeR = Math.max(2, size * 0.11);
  canvas.fillCircle(m.x, m.y, nodeR, 88, 166, 255); // Model blue
  canvas.fillCircle(ctx.x, ctx.y, nodeR, 242, 180, 65); // Context amber
  canvas.fillCircle(el.x, el.y, nodeR * 1.12, 57, 211, 83); // Element green
  canvas.fillCircle(comp.x, comp.y, nodeR, 86, 211, 100); // Computed emerald
  canvas.fillCircle(obs.x, obs.y, nodeR, 199, 155, 255); // Observer violet

  return canvas.toPng();
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
  copyPanelAssets(PANEL_SRC, EXT_DIST);

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

  emitClientDeclarations(ROOT);

  cpSync(join(ROOT, "src/demo/index.html"), join(DEMO_DIST, "index.html"));
  cpSync(join(ROOT, "src/demo/styles.css"), join(DEMO_DIST, "styles.css"));
  copyPanelAssets(PANEL_SRC, DEMO_DIST);
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
