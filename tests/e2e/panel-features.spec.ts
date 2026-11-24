import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test } from "@playwright/test";
import type {
  GraphSnapshot,
  ReactivityEdgeSnapshot,
  ReactivityNodeSnapshot,
} from "../../src/protocol/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const DEMO_DIR = join(ROOT, "dist/demo");
const SHOTS_DIR = join(ROOT, "test-results/shots");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
};

async function startStaticServer(
  handlers: Record<string, { body: string | Uint8Array; mime: string }>,
  dir?: string,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const custom = handlers[reqUrl.pathname];
    if (custom) {
      res.writeHead(200, { "Content-Type": custom.mime });
      res.end(custom.body);
      return;
    }
    if (dir) {
      const rel = reqUrl.pathname === "/" ? "/index.html" : reqUrl.pathname;
      const filePath = join(dir, rel);
      if (filePath.startsWith(dir) && existsSync(filePath)) {
        res.writeHead(200, {
          "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
        });
        res.end(readFileSync(filePath));
        return;
      }
    }
    res.writeHead(404);
    res.end("Not found");
  });

  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Expected TCP address");
  }
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

function buildLargeStressSnapshot(): GraphSnapshot {
  const nodes: ReactivityNodeSnapshot[] = [];
  const edges: ReactivityEdgeSnapshot[] = [];
  let nextId = 1;

  const mkNode = (
    overrides: Partial<ReactivityNodeSnapshot> &
      Pick<ReactivityNodeSnapshot, "kind" | "label">,
  ): ReactivityNodeSnapshot => {
    const id = nextId++;
    const node: ReactivityNodeSnapshot = {
      id,
      subtitle: null,
      site: {
        file: `src/components/widget-${id % 12}.ts`,
        line: 24 + (id % 90),
        column: 3,
        fn: overrides.label,
      },
      connected: true,
      updates: (id % 7) + 1,
      hits: id % 4,
      misses: (id % 3) + 1,
      vetoes: 0,
      lastDurationMs: 0.14,
      lastChangedSeq: id,
      lastCauseLabel: null,
      lastCauseNodeId: null,
      value: {
        kind: "string",
        text: `"val-${id}"`,
      },
      error: null,
      ...overrides,
    };
    nodes.push(node);
    return node;
  };

  // Root model -> controller -> shared context bus (10 consumers)
  const model = mkNode({ kind: "model", label: "DashboardStore" });
  const ctrl = mkNode({
    kind: "controller",
    label: "viewModel (DashboardController)",
    ownerNodeId: model.id,
  });
  edges.push({
    id: `e-${model.id}-${ctrl.id}`,
    sourceId: model.id,
    targetId: ctrl.id,
    kind: "model-to-controller",
    label: "model-update",
    count: 5,
    lastSeq: 5,
    lastDetail: null,
  });

  const ctx = mkNode({
    kind: "context",
    label: "telemetry-stream-context",
  });
  edges.push({
    id: `e-${ctrl.id}-${ctx.id}`,
    sourceId: ctrl.id,
    targetId: ctx.id,
    kind: "context-provide",
    label: "provide",
    count: 4,
    lastSeq: 6,
    lastDetail: null,
  });

  // Hub element with 8 leaf memos (triggers >4 collapse into +8 memos cluster)
  const mapHost = mkNode({
    kind: "element",
    label: "ui-dashboard-route-canvas-map#primary",
    tagName: "ui-dashboard-route-canvas-map",
    disambiguator: "#primary",
    rootType: "shadow",
    subtitle: "RouteMapElement",
  });
  edges.push({
    id: `e-${ctx.id}-${mapHost.id}`,
    sourceId: ctx.id,
    targetId: mapHost.id,
    kind: "context-consume",
    label: "subscribe",
    count: 8,
    lastSeq: 12,
    lastDetail: null,
  });

  for (let m = 0; m < 8; m++) {
    const memoNode = mkNode({
      kind: m < 6 ? "computed" : "observer",
      label:
        m < 6
          ? `_computeLayerSegment${m} (ui-dashboard-route-canvas-map#primary)`
          : `_observeViewportBounds${m} (ui-dashboard-route-canvas-map#primary)`,
      ownerNodeId: mapHost.id,
      computeSignature: "(plan, rangeKm) => …",
      computeSource: `(plan, rangeKm) => projectSegment(${m}, plan, rangeKm)`,
    });
    edges.push({
      id: `e-${mapHost.id}-${memoNode.id}`,
      sourceId: mapHost.id,
      targetId: memoNode.id,
      kind: m < 6 ? "memo-compute" : "memo-observe",
      label: m < 6 ? "computes" : "observes",
      count: 3,
      lastSeq: 15 + m,
      lastDetail: null,
    });
  }

  // 10 more context-consume elements to trigger yEd bus routing (fanOut >= 5)
  const consumers: ReactivityNodeSnapshot[] = [];
  for (let i = 0; i < 10; i++) {
    const consumer = mkNode({
      kind: "element",
      label: `ui-metric-readout-tile [channel="CH-${i}"]`,
      tagName: "ui-metric-readout-tile",
      disambiguator: `[channel="CH-${i}"]`,
      rootType: "shadow",
    });
    consumers.push(consumer);
    edges.push({
      id: `e-${ctx.id}-${consumer.id}`,
      sourceId: ctx.id,
      targetId: consumer.id,
      kind: "context-consume",
      label: "subscribe",
      count: 2,
      lastSeq: 30 + i,
      lastDetail: null,
    });
  }

  // Feedback event loop from consumer back to controller
  edges.push({
    id: `e-${consumers[0]!.id}-${ctrl.id}:ev`,
    sourceId: consumers[0]!.id,
    targetId: ctrl.id,
    kind: "event-emit",
    label: "waypoint-select",
    count: 2,
    lastSeq: 45,
    lastDetail: null,
  });

  // Expand to 420 nodes across chained subsystems + leaf widgets + isolated icons
  let chainIdx = 0;
  while (nodes.length < 380) {
    const parent = consumers[chainIdx % consumers.length]!;
    const subEl = mkNode({
      kind: "element",
      label: `ui-strip-widget [${chainIdx}]`,
      tagName: "ui-strip-widget",
      disambiguator: `[${chainIdx}]`,
      rootType: "shadow",
    });
    edges.push({
      id: `e-${parent.id}-${subEl.id}`,
      sourceId: parent.id,
      targetId: subEl.id,
      kind: "prop-flow",
      label: "prop",
      count: 1,
      lastSeq: 60 + chainIdx,
      lastDetail: null,
    });
    if (nodes.length < 379) {
      const comp = mkNode({
        kind: "computed",
        label: `_computeReadout${chainIdx}`,
        ownerNodeId: subEl.id,
      });
      edges.push({
        id: `e-${subEl.id}-${comp.id}`,
        sourceId: subEl.id,
        targetId: comp.id,
        kind: "memo-compute",
        label: "computes",
        count: 1,
        lastSeq: 200 + chainIdx,
        lastDetail: null,
      });
    }
    chainIdx++;
  }

  while (nodes.length < 420) {
    mkNode({
      kind: "element",
      label: `md-icon [in nav-bar]`,
      tagName: "md-icon",
      disambiguator: `[in nav-bar]`,
      rootType: "shadow",
      updates: 1,
    });
  }

  return {
    version: 1,
    seq: 420,
    baseSeq: 0,
    droppedEvents: 0,
    litVersions: ["3.1.4"],
    settings: {
      paused: false,
      captureMemoHits: false,
      captureCustomEvents: true,
    },
    nodes,
    edges,
    events: [],
  };
}

test.describe("Lit Flow Wave 3 Feature E2E & Stress Verification", () => {
  test("pane splitters, bottom collapse/restore, Compute Expression, Open Source, Highlight/Filter, and Tags popover", async () => {
    mkdirSync(SHOTS_DIR, { recursive: true });
    const server = await startStaticServer({}, DEMO_DIR);
    const browser = await chromium.launch({
      channel: "chromium",
      headless: true,
    });

    try {
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      });
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      page.on("pageerror", (err) => pageErrors.push(err.message));

      // Grant clipboard write permission for bridge Open Source copy verification
      await page
        .context()
        .grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.goto(`${server.origin}/index.html`);

      const frame = page.frameLocator("#panel-frame");
      await expect(frame.getByTestId("connection-status")).toHaveAttribute(
        "data-state",
        "connected",
      );

      // 1. Verify Compute Expression & Open Source in Inspector
      await page.click("#alt-inc");
      const formattedNode = frame
        .locator('.graph-node.kind-computed[aria-label*="Formatted"]')
        .first();
      await formattedNode.click();

      await expect(
        frame.getByTestId("compute-expression-section"),
      ).toBeVisible();
      await expect(
        frame.getByTestId("compute-expression-section"),
      ).toContainText("${label}: ${val}");

      // Open Source from Inspector action button in bridge mode
      await frame.getByTestId("open-source-btn").click();
      await expect(frame.getByTestId("inspector-view")).toContainText(
        "Copied source location to clipboard",
      );

      // Clickable site link and property jump button on element node
      const altCard = frame.locator(
        '.graph-node[aria-label*="x-telemetry-card#alt-card"]',
      );
      await altCard.click();
      await expect(frame.getByTestId("inspector-site-btn")).toBeVisible();
      await frame.getByTestId("prop-source-label").click();
      await expect(frame.getByTestId("inspector-view")).toContainText(
        "Copied source location to clipboard",
      );

      // 2. Standalone panel test for splitters, collapse/restore, Highlight/Filter, and Tags popover
      const snapPayload = await page.evaluate((): unknown => {
        const hook: unknown = Reflect.get(globalThis, "__LIT_DEVTOOLS_HOOK__");
        const fn: unknown =
          hook && typeof hook === "object"
            ? Reflect.get(hook, "snapshot")
            : null;
        if (typeof fn !== "function") throw new Error("Missing hook.snapshot");
        return Reflect.apply(fn, hook, []);
      });

      const panelPage = await browser.newPage({
        viewport: { width: 1280, height: 800 },
      });
      await panelPage
        .context()
        .grantPermissions(["clipboard-read", "clipboard-write"]);
      panelPage.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      panelPage.on("pageerror", (err) => pageErrors.push(err.message));

      await panelPage.goto(`${server.origin}/panel.html`);
      await panelPage.evaluate((snap) => {
        window.postMessage(
          {
            channel: "lit-reactivity-devtools",
            direction: "host-to-panel",
            payload: {
              type: "PAGE_CONNECTED",
              url: "http://127.0.0.1:4174/index.html",
            },
          },
          window.location.origin,
        );
        window.postMessage(
          {
            channel: "lit-reactivity-devtools",
            direction: "host-to-panel",
            payload: { type: "SNAPSHOT", snapshot: snap },
          },
          window.location.origin,
        );
      }, snapPayload);

      await expect(panelPage.locator(".graph-node")).toHaveCount(16);

      // Verify Wide & Tall splitters drag + keyboard + persistence
      const rightSplitter = panelPage.getByTestId("splitter-right");
      await expect(rightSplitter).toBeVisible();
      const rsBox = await rightSplitter.boundingBox();
      expect(rsBox).toBeTruthy();

      const beforeInspectorW = await panelPage
        .getByTestId("inspector-view")
        .evaluate((el) => el.getBoundingClientRect().width);
      await panelPage.mouse.move(
        rsBox!.x + rsBox!.width / 2,
        rsBox!.y + rsBox!.height / 2,
      );
      await panelPage.mouse.down();
      await panelPage.mouse.move(
        rsBox!.x + rsBox!.width / 2 - 90,
        rsBox!.y + rsBox!.height / 2,
      );
      await panelPage.mouse.up();

      const afterInspectorW = await panelPage
        .getByTestId("inspector-view")
        .evaluate((el) => el.getBoundingClientRect().width);
      expect(afterInspectorW).toBeGreaterThan(beforeInspectorW + 70);

      // Collapse bottom pane via button and restore via restore strip
      await panelPage.getByTestId("collapse-bottom-btn").click();
      await expect(panelPage.locator("#panel-shell")).toHaveAttribute(
        "data-bottom-collapsed",
        "true",
      );
      await expect(panelPage.getByTestId("waterfall-view")).toBeHidden();
      await expect(panelPage.getByTestId("restore-bottom-btn")).toBeVisible();
      await panelPage.getByTestId("restore-bottom-btn").click();
      await expect(panelPage.locator("#panel-shell")).toHaveAttribute(
        "data-bottom-collapsed",
        "false",
      );
      await expect(panelPage.getByTestId("waterfall-view")).toBeVisible();

      // Drag bottom splitter down past snap threshold (< 56px) -> snaps to collapsed
      const bottomSplitter = panelPage.getByTestId("splitter-bottom");
      const bsBox = await bottomSplitter.boundingBox();
      expect(bsBox).toBeTruthy();
      await panelPage.mouse.move(
        bsBox!.x + bsBox!.width / 2,
        bsBox!.y + bsBox!.height / 2,
      );
      await panelPage.mouse.down();
      await panelPage.mouse.move(bsBox!.x + bsBox!.width / 2, 790);
      await panelPage.mouse.up();
      await expect(panelPage.locator("#panel-shell")).toHaveAttribute(
        "data-bottom-collapsed",
        "true",
      );
      await panelPage.getByTestId("restore-bottom-btn").click();

      // Verify localStorage persistence across reload
      await panelPage.reload();
      await panelPage.evaluate((snap) => {
        window.postMessage(
          {
            channel: "lit-reactivity-devtools",
            direction: "host-to-panel",
            payload: { type: "SNAPSHOT", snapshot: snap },
          },
          window.location.origin,
        );
      }, snapPayload);
      const persistedW = await panelPage
        .getByTestId("inspector-view")
        .evaluate((el) => el.getBoundingClientRect().width);
      expect(Math.abs(persistedW - afterInspectorW)).toBeLessThanOrEqual(4);

      // Verify Highlight (default) vs Filter query mode + N/M stepper
      const searchInput = panelPage.getByTestId("search-input");
      await searchInput.fill("tag:x-telemetry-card");
      await expect(panelPage.locator(".graph-node")).toHaveCount(16); // Highlight keeps all 16 visible!
      await expect(panelPage.getByTestId("search-match-count")).toHaveText(
        "1/2",
      );
      await expect(
        panelPage.locator(".graph-node.is-search-match"),
      ).toHaveCount(2);
      await expect(panelPage.locator(".graph-node.is-dimmed")).toHaveCount(14);
      await panelPage.getByTestId("search-next-btn").click();
      await expect(panelPage.getByTestId("search-match-count")).toHaveText(
        "2/2",
      );

      // Free-text query matches elements + child memos via subtitle
      await searchInput.fill("x-telemetry-card");
      await expect(panelPage.getByTestId("search-match-count")).toHaveText(
        "1/6",
      );

      // Toggle to Filter mode -> only 6 matching nodes visible
      await panelPage.getByTestId("search-mode-btn").click();
      await expect(panelPage.getByTestId("search-mode-btn")).toHaveText(
        "Filter",
      );
      await expect(panelPage.locator(".graph-node")).toHaveCount(6);

      // Switch back to Highlight & clear
      await panelPage.getByTestId("search-mode-btn").click();
      await panelPage.getByTestId("search-clear-btn").click();
      await expect(panelPage.locator(".graph-node")).toHaveCount(16);

      // Verify Tags popover query-mutating Hide/Show & Show all
      await panelPage.getByTestId("tags-filter-btn").click();
      await expect(panelPage.getByTestId("tags-popover")).toBeVisible();
      await panelPage
        .getByTestId("tags-popover")
        .locator('label:has-text("<x-nav-strip>") input[type="checkbox"]')
        .uncheck();
      await expect(searchInput).toHaveValue("-tag:x-nav-strip");
      await expect(panelPage.locator(".graph-node")).toHaveCount(15);

      // Re-check <x-nav-strip> inside x-* prefix exclusion -> expands prefix wildcard cleanly
      await panelPage
        .getByTestId("tags-popover")
        .getByRole("button", { name: "Show all" })
        .click();
      await expect(panelPage.locator(".graph-node")).toHaveCount(16);
      await panelPage
        .getByTestId("tags-popover")
        .locator('label:has-text("x-*") input[type="checkbox"]')
        .uncheck();
      await expect(searchInput).toHaveValue("-tag:x-*");
      await panelPage
        .getByTestId("tags-popover")
        .locator('label:has-text("<x-nav-strip>") input[type="checkbox"]')
        .check();
      await expect(panelPage.locator(".graph-node")).toHaveCount(13);
      expect(await searchInput.inputValue()).not.toContain("-tag:x-*");
      expect(await searchInput.inputValue()).toContain("-tag:x-telemetry-card");

      // Show all resets tag tokens
      await panelPage
        .getByTestId("tags-popover")
        .getByRole("button", { name: "Show all" })
        .click();
      await expect(panelPage.locator(".graph-node")).toHaveCount(16);
      await panelPage.keyboard.press("Escape");
      await expect(panelPage.getByTestId("tags-popover")).toBeHidden();

      // Verify Inspector Hide <tag> -> Show <tag> round-trip (select from Waterfall trace!)
      await panelPage
        .locator('.graph-node[aria-label*="x-nav-strip"]')
        .first()
        .click();
      await panelPage.getByTestId("toggle-hide-tag-btn").click();
      await expect(searchInput).toHaveValue("-tag:x-nav-strip");
      await expect(panelPage.getByTestId("toggle-hide-tag-btn")).toHaveText(
        "Show x-nav-strip",
      );
      await panelPage.getByTestId("toggle-hide-tag-btn").click();
      await expect(searchInput).toHaveValue("");
      await expect(panelPage.locator(".graph-node")).toHaveCount(16);

      // Verify narrow mode hides bottom collapse button
      await panelPage.setViewportSize({ width: 420, height: 700 });
      await panelPage.getByTestId("tab-waterfall").click();
      await expect(panelPage.getByTestId("collapse-bottom-btn")).toBeHidden();

      expect(consoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);
      await panelPage.close();
    } finally {
      await browser.close();
      await server.close();
    }
  });

  test("6-tier sibling disambiguation differentiates un-IDed Lit siblings without affecting singletons", async () => {
    const fixtureEntry = join(ROOT, "tests/e2e/fixtures-sibling-lit.ts");
    const bundledJs = execFileSync(
      "bun",
      ["build", fixtureEntry, "--format=esm", "--target=browser"],
      {
        cwd: ROOT,
        encoding: "utf-8",
      },
    );

    const server = await startStaticServer({
      "/sib.html": {
        mime: "text/html; charset=utf-8",
        body: `<!doctype html><html><body><sib-host></sib-host><script type="module" src="/sib.js"></script></body></html>`,
      },
      "/sib.js": {
        mime: "text/javascript; charset=utf-8",
        body: bundledJs,
      },
    });
    const browser = await chromium.launch({
      channel: "chromium",
      headless: true,
    });

    try {
      const page = await browser.newPage();
      await page.goto(`${server.origin}/sib.html`);
      await expect(page.locator("sib-card")).toHaveCount(2);

      const snapshotSummary = await page.evaluate(() => {
        const hook: unknown = Reflect.get(window, "__HOOK__");
        const snapFn: unknown =
          hook && typeof hook === "object"
            ? Reflect.get(hook, "snapshot")
            : null;
        if (typeof snapFn !== "function") {
          throw new Error("Missing hook.snapshot()");
        }
        const snap: unknown = Reflect.apply(snapFn, hook, []);
        const rawNodes: unknown =
          snap && typeof snap === "object" ? Reflect.get(snap, "nodes") : null;
        if (!Array.isArray(rawNodes)) return [];
        const out: Array<{
          tagName: unknown;
          label: unknown;
          disambiguator: unknown;
        }> = [];
        for (const n of rawNodes) {
          if (
            n &&
            typeof n === "object" &&
            Reflect.get(n, "kind") === "element"
          ) {
            out.push({
              tagName: Reflect.get(n, "tagName"),
              label: Reflect.get(n, "label"),
              disambiguator: Reflect.get(n, "disambiguator"),
            });
          }
        }
        return out;
      });

      expect(snapshotSummary).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tagName: "sib-card",
            disambiguator: 'label="ALT"',
          }),
          expect.objectContaining({
            tagName: "sib-card",
            disambiguator: 'label="HDG"',
          }),
          expect.objectContaining({
            tagName: "solo-badge",
            label: "solo-badge",
            disambiguator: null,
          }),
        ]),
      );
    } finally {
      await browser.close();
      await server.close();
    }
  });

  test("renders 420-node large-graph stress layout with bus routing, collapsible >4 memo cluster, LOD zoom, and clean screenshots", async () => {
    mkdirSync(SHOTS_DIR, { recursive: true });
    const server = await startStaticServer({}, DEMO_DIR);
    const browser = await chromium.launch({
      channel: "chromium",
      headless: true,
    });

    try {
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      });
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      page.on("pageerror", (err) => pageErrors.push(err.message));

      const stressSnapshot = buildLargeStressSnapshot();
      await page.goto(`${server.origin}/panel.html`);

      const renderMs = await page.evaluate((snap) => {
        const t0 = performance.now();
        window.postMessage(
          {
            channel: "lit-reactivity-devtools",
            direction: "host-to-panel",
            payload: {
              type: "PAGE_CONNECTED",
              url: "http://127.0.0.1:4174/stress.html",
            },
          },
          window.location.origin,
        );
        window.postMessage(
          {
            channel: "lit-reactivity-devtools",
            direction: "host-to-panel",
            payload: { type: "SNAPSHOT", snapshot: snap },
          },
          window.location.origin,
        );
        return performance.now() - t0;
      }, stressSnapshot);

      // 8 leaf memos collapsed into 1 cluster node => 420 - 8 + 1 = 413 rendered SVG nodes
      await expect(page.locator(".graph-node")).toHaveCount(413);
      expect(renderMs).toBeLessThan(1500);

      // Verify bus trunks & junctions are rendered
      expect(await page.locator(".graph-bus-trunk").count()).toBeGreaterThan(0);
      expect(await page.locator(".graph-bus-junction").count()).toBeGreaterThan(
        5,
      );

      // Verify +8 memos cluster card exists and clicking expands it to all 420 nodes
      const clusterCard = page.locator(".graph-node.is-memo-cluster");
      await expect(clusterCard).toHaveCount(1);
      await expect(clusterCard).toContainText("+8 memos");
      await page.screenshot({
        path: join(SHOTS_DIR, "stress-420-wide.png"),
        animations: "disabled",
      });

      await clusterCard.click();
      await expect(page.locator(".graph-node")).toHaveCount(420);
      await expect(page.locator(".graph-node.is-memo-cluster")).toHaveCount(0);

      // Verify LOD toggles .is-zoomed-out below 45% zoom
      for (let i = 0; i < 4; i++) {
        await page.locator("#zoom-out-btn").click();
      }
      await expect(page.getByTestId("graph-svg")).toHaveClass(/is-zoomed-out/);

      // Verify Highlight search on 420-node graph (tag: matches 1 element, text matches element + 8 expanded memos)
      await page.getByTestId("search-input").fill("tag:ui-dashboard*");
      await expect(page.getByTestId("search-match-count")).toHaveText("1/1");
      await page.getByTestId("search-input").fill("ui-dashboard");
      await expect(page.getByTestId("search-match-count")).toHaveText("1/9");

      // Zero horizontal overflow
      const overflowPx = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflowPx).toBe(0);
      expect(consoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);
    } finally {
      await browser.close();
      await server.close();
    }
  });
});
