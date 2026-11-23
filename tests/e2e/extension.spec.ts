import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test } from "@playwright/test";
import type { PanelToBackgroundMessage } from "../../src/protocol/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const EXT_DIR = join(ROOT, "dist/extension");
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

function bundleZeroConfigLitApp(): string {
  const appEntry = join(ROOT, "tests/e2e/fixtures-zero-config-lit.ts");
  return execFileSync(
    "bun",
    ["build", appEntry, "--format=esm", "--target=browser"],
    {
      cwd: ROOT,
      encoding: "utf-8",
    },
  );
}

test.describe("Lit Reactivity DevTools MV3 Extension E2E", () => {
  test("zero-config MAIN-world hooks trace Lit, @lit/context, memoize-one, and EventTarget without app instrumentation", async () => {
    const appJs = bundleZeroConfigLitApp();
    const server = await startStaticServer({
      "/app.html": {
        mime: "text/html; charset=utf-8",
        body: `<!doctype html><html><body><zc-parent></zc-parent><script type="module" src="/app.js"></script></body></html>`,
      },
      "/app.js": {
        mime: "text/javascript; charset=utf-8",
        body: appJs,
      },
    });

    const userDataDir = mkdtempSync(join(tmpdir(), "lit-devtools-ext-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      args: [
        `--disable-extensions-except=${EXT_DIR}`,
        `--load-extension=${EXT_DIR}`,
      ],
    });

    try {
      let [serviceWorker] = context.serviceWorkers();
      if (!serviceWorker) {
        serviceWorker = await context.waitForEvent("serviceworker");
      }
      const extensionId = serviceWorker.url().split("/")[2];
      expect(extensionId).toBeTruthy();

      const pageErrors: string[] = [];
      const page = await context.newPage();
      page.on("pageerror", (err) => pageErrors.push(err.message));

      const extControlPage = await context.newPage();
      await extControlPage.goto(
        `chrome-extension://${extensionId}/devtools.html`,
      );

      await page.bringToFront();
      const targetTabId = await serviceWorker.evaluate(async () => {
        const [activeTab] = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        return activeTab?.id ?? null;
      });
      expect(typeof targetTabId).toBe("number");

      await extControlPage.evaluate((tid) => {
        const msgs: unknown[] = [];
        const port = chrome.runtime.connect({ name: `devtools:${tid}` });
        Reflect.set(window, "portMsgs", msgs);
        Reflect.set(window, "sendPortMsg", (msg: PanelToBackgroundMessage) => {
          port.postMessage(msg);
        });
        port.onMessage.addListener((msg: unknown) => {
          msgs.push(msg);
        });
      }, targetTabId);

      // Navigate to the zero-config Lit + @lit/context + memoize-one app
      await page.goto(`${server.origin}/app.html`);
      expect(
        await page.evaluate(
          () =>
            document.querySelector("zc-parent")?.querySelector("zc-child") ??
            null,
        ),
      ).toBeNull(); // zc-child lives inside zc-parent Shadow DOM!
      await expect(page.locator("zc-child")).toHaveText("40");

      // Trigger model-update -> ContextProvider.setValue(3) -> zc-child re-renders to 60!
      await page.locator("zc-parent").evaluate((el) => {
        const fn: unknown = Reflect.get(el, "triggerModelUpdate");
        if (typeof fn === "function") Reflect.apply(fn, el, []);
      });
      await expect(page.locator("zc-child")).toHaveText("60");

      // Wait for snapshot over extension port -> verify elements, context, memoize-one, model, controller, prop-flow!
      let childNodeId: number | null = null;
      await expect
        .poll(async () => {
          const summary = await extControlPage.evaluate(() => {
            const raw: unknown = Reflect.get(window, "portMsgs");
            if (!Array.isArray(raw)) return null;
            let latestSnap: unknown = null;
            for (const m of raw) {
              if (
                m !== null &&
                typeof m === "object" &&
                Reflect.get(m, "type") === "SNAPSHOT"
              ) {
                latestSnap = Reflect.get(m, "snapshot");
              }
            }
            if (!latestSnap || typeof latestSnap !== "object") return null;
            const nodes = Reflect.get(latestSnap, "nodes");
            const edges = Reflect.get(latestSnap, "edges");
            if (!Array.isArray(nodes) || !Array.isArray(edges)) return null;
            const child = nodes.find(
              (n) =>
                n !== null &&
                typeof n === "object" &&
                Reflect.get(n, "label") === "zc-child",
            );
            return {
              labels: nodes.map((n) =>
                n !== null && typeof n === "object"
                  ? Reflect.get(n, "label")
                  : "",
              ),
              rootTypes: nodes
                .filter(
                  (n) =>
                    n !== null &&
                    typeof n === "object" &&
                    Reflect.get(n, "kind") === "element",
                )
                .map((n) =>
                  n !== null && typeof n === "object"
                    ? Reflect.get(n, "rootType")
                    : null,
                ),
              edgeKinds: edges.map((e) =>
                e !== null && typeof e === "object"
                  ? Reflect.get(e, "kind")
                  : "",
              ),
              childId:
                child && typeof child === "object"
                  ? Reflect.get(child, "id")
                  : null,
            };
          });
          if (summary && typeof summary.childId === "number") {
            childNodeId = summary.childId;
          }
          return summary;
        })
        .toMatchObject({
          labels: expect.arrayContaining([
            "zc-parent",
            "zc-child",
            "zc-ctx",
            "_computeScaled",
            "ZeroConfigModel",
          ]),
          rootTypes: ["shadow", "shadow"],
          edgeKinds: expect.arrayContaining([
            "prop-flow",
            "context-provide",
            "context-consume",
            "memo-compute",
          ]),
        });

      // Mutate `zc-child.value` remotely via extension SET_PROPERTY -> updates real Shadow DOM (100 * factor 3 = 300)!
      await extControlPage.evaluate((nodeId) => {
        const send: unknown = Reflect.get(window, "sendPortMsg");
        if (typeof send === "function") {
          Reflect.apply(send, window, [
            {
              type: "SET_PROPERTY",
              nodeId,
              propName: "value",
              jsonText: "100",
              requestId: "zc-set-1",
            },
          ]);
        }
      }, childNodeId!);

      await expect(page.locator("zc-child")).toHaveText("300");
      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
      await server.close();
    }
  });

  test("registers the Lit Flow tab inside a real Chrome DevTools window", async () => {
    const server = await startStaticServer({}, DEMO_DIR);
    const userDataDir = mkdtempSync(join(tmpdir(), "lit-devtools-win-"));
    const prevEnv = process.env.PW_CHROMIUM_ATTACH_TO_OTHER;
    process.env.PW_CHROMIUM_ATTACH_TO_OTHER = "1";

    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      args: [
        `--disable-extensions-except=${EXT_DIR}`,
        `--load-extension=${EXT_DIR}`,
        "--auto-open-devtools-for-tabs",
      ],
    });

    try {
      let [serviceWorker] = context.serviceWorkers();
      if (!serviceWorker) {
        serviceWorker = await context.waitForEvent("serviceworker");
      }

      const initialDevtools = new Set(
        context.pages().filter((p) => p.url().startsWith("devtools://")),
      );
      const page = await context.newPage();
      await page.goto(`${server.origin}/index.html`);

      await expect
        .poll(() =>
          context
            .pages()
            .some(
              (p) =>
                p.url().startsWith("devtools://devtools") &&
                !initialDevtools.has(p),
            ),
        )
        .toBe(true);

      const devtoolsPage = context
        .pages()
        .find(
          (p) =>
            p.url().startsWith("devtools://devtools") &&
            !initialDevtools.has(p),
        );
      expect(devtoolsPage).toBeTruthy();

      await expect
        .poll(async () => {
          const urls = devtoolsPage!.frames().map((f) => f.url());
          return urls.some((u) => u.includes("/devtools.html"));
        })
        .toBe(true);

      const mainNav = devtoolsPage!.getByRole("navigation", {
        name: "Main toolbar",
      });
      await mainNav.getByRole("tab", { name: "Elements" }).click();
      for (let i = 0; i < 15; i++) {
        if (
          (await devtoolsPage!.locator('iframe[src*="panel.html"]').count()) > 0
        ) {
          break;
        }
        await devtoolsPage!.keyboard.press("Control+]");
        await devtoolsPage!.waitForTimeout(80);
      }

      const panelFrame = devtoolsPage!.frameLocator(
        'iframe[src*="panel.html"]',
      );
      await expect(panelFrame.getByTestId("connection-status")).toHaveAttribute(
        "data-state",
        "connected",
      );
      await expect(panelFrame.locator(".graph-node.kind-element")).toHaveCount(
        4,
      );
      await expect(panelFrame.locator(".graph-node.kind-model")).toHaveCount(1);
      await expect(
        panelFrame.locator(".graph-node.kind-controller"),
      ).toHaveCount(1);
      await expect(panelFrame.locator(".graph-node.kind-context")).toHaveCount(
        2,
      );

      mkdirSync(SHOTS_DIR, { recursive: true });
      await devtoolsPage!.screenshot({
        path: join(SHOTS_DIR, "devtools-window-lit-flow.png"),
      });
    } finally {
      if (prevEnv === undefined) {
        delete process.env.PW_CHROMIUM_ATTACH_TO_OTHER;
      } else {
        process.env.PW_CHROMIUM_ATTACH_TO_OTHER = prevEnv;
      }
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
      await server.close();
    }
  });
});

test.describe("Panel UI & Cockpit Playground Interactive Verification", () => {
  test("traces model->controller->context->element->memo cascades, vetoes, custom events, subgraph focus, and multi-viewport screenshots", async () => {
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

      await page.emulateMedia({ colorScheme: "light" });
      await page.goto(`${server.origin}/index.html`);

      const frame = page.frameLocator("#panel-frame");
      await expect(frame.getByTestId("connection-status")).toHaveAttribute(
        "data-state",
        "connected",
      );
      await expect(frame.locator(".graph-node.kind-element")).toHaveCount(4);

      // 1. Trigger Model update -> Controller -> Context -> Elements -> Memoized computes
      await page.click("#alt-inc");
      await expect(page.locator("#alt-card")).toHaveText(/13000 ft/);

      // 2. Trigger CustomEvent feedback loop from child <x-nav-strip> -> CockpitController -> ModelManager
      await page.click("#hdg-right");
      await expect(page.locator("x-nav-strip")).toContainText("HDG 285°");

      // 3. Trigger shouldUpdate veto on muted <x-telemetry-card>
      await page.click("#toggle-mute-btn");
      await page.click("#alt-inc");
      await expect(frame.getByTestId("stats-bar")).toContainText("veto");

      // Select <x-cockpit-shell> and verify light + dark wide demo screenshots
      const shellNode = frame.locator(
        '.graph-node[aria-label*="x-cockpit-shell"]',
      );
      await shellNode.click();
      await page.screenshot({
        path: join(SHOTS_DIR, "demo-wide-light.png"),
        animations: "disabled",
      });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({
        path: join(SHOTS_DIR, "demo-wide-dark.png"),
        animations: "disabled",
      });

      // 4. Live JSON property edit on <x-telemetry-card#alt-card>
      const altCardNode = frame.locator(
        '.graph-node[aria-label*="x-telemetry-card#alt-card"]',
      );
      await altCardNode.click();
      await frame.getByTestId("prop-input-label").fill('"MSL Alt"');
      await frame.getByTestId("prop-set-label").click();
      await expect(page.locator("#alt-card")).toContainText("MSL Alt");
      // Verify ShadowRoot rootType is accurately detected as "shadow" (not "light")
      await expect(frame.getByTestId("inspector-view")).toContainText("shadow");
      // Verify lastCause reflects self-edit of `label`, not stale parent `valueText`
      await expect(frame.getByTestId("inspector-view")).toContainText(
        "prop 'label'",
      );

      // 5. Focused Subgraph mode & reset
      await frame.getByTestId("focus-subgraph-btn").click();
      await expect(frame.getByTestId("focus-breadcrumb")).toBeVisible();
      await frame.getByTestId("clear-focus-btn").click();
      await expect(frame.getByTestId("focus-breadcrumb")).toBeHidden();

      // 6. Empty state containment check
      const panelOnly = await browser.newPage();
      panelOnly.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      panelOnly.on("pageerror", (err) => pageErrors.push(err.message));

      await panelOnly.setViewportSize({ width: 1000, height: 680 });
      await panelOnly.emulateMedia({ colorScheme: "dark" });
      await panelOnly.goto(`${server.origin}/panel.html`);
      await expect(panelOnly.getByTestId("empty-state")).toBeVisible();
      await expect(panelOnly.getByTestId("sync-elements-btn")).toBeHidden();
      await expect(panelOnly.getByTestId("inspector-view")).toBeHidden();
      const emptyContainment = await panelOnly.evaluate(() => {
        const pane = document
          .querySelector(".graph-pane")!
          .getBoundingClientRect();
        const card = document
          .querySelector(".empty-card")!
          .getBoundingClientRect();
        return {
          fitsTop: card.top >= pane.top,
          fitsBottom: card.bottom <= pane.bottom,
        };
      });
      expect(emptyContainment).toEqual({ fitsTop: true, fitsBottom: true });
      await panelOnly.screenshot({
        path: join(SHOTS_DIR, "panel-empty-state-dark.png"),
        animations: "disabled",
      });
      await panelOnly.close();

      // 7. Standalone panel viewports: Wide-Tall (1280x800), Docked-Bottom (1280x440), Docked-Right (540x900), Narrow (420x700)
      const snapPayload = await page.evaluate((): unknown => {
        const hook: unknown = Reflect.get(globalThis, "__LIT_DEVTOOLS_HOOK__");
        if (hook === null || typeof hook !== "object")
          throw new Error("Missing hook");
        const fn: unknown = Reflect.get(hook, "snapshot");
        if (typeof fn !== "function") throw new Error("Missing snapshot()");
        return Reflect.apply(fn, hook, []);
      });

      const hostedPanel = await browser.newPage({
        viewport: { width: 1280, height: 800 },
      });
      await hostedPanel.emulateMedia({ colorScheme: "dark" });
      await hostedPanel.goto(`${server.origin}/panel.html`);
      await hostedPanel.evaluate((snap) => {
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

      await expect(hostedPanel.locator(".graph-node.kind-element")).toHaveCount(
        4,
      );
      await hostedPanel
        .locator('.graph-node[aria-label*="x-telemetry-card#alt-card"]')
        .click();
      await hostedPanel.getByTestId("fit-graph").click();
      await hostedPanel.screenshot({
        path: join(SHOTS_DIR, "panel-wide-tall-dark.png"),
        animations: "disabled",
      });

      await hostedPanel.setViewportSize({ width: 1280, height: 440 });
      await hostedPanel.emulateMedia({ colorScheme: "light" });
      await hostedPanel.getByTestId("fit-graph").click();
      await hostedPanel.mouse.move(0, 0);
      await expect(hostedPanel.getByTestId("pause-btn")).toHaveCSS(
        "background-color",
        "rgb(255, 255, 255)",
      );
      await hostedPanel.screenshot({
        path: join(SHOTS_DIR, "panel-docked-bottom-light.png"),
        animations: "disabled",
      });

      await hostedPanel.setViewportSize({ width: 540, height: 900 });
      await hostedPanel.emulateMedia({ colorScheme: "dark" });
      await hostedPanel.getByTestId("fit-graph").click();
      await hostedPanel.mouse.move(0, 0);
      await expect(hostedPanel.getByTestId("pause-btn")).toHaveCSS(
        "background-color",
        "rgb(22, 27, 35)",
      );
      await hostedPanel.screenshot({
        path: join(SHOTS_DIR, "panel-docked-right-dark.png"),
        animations: "disabled",
      });

      await hostedPanel.setViewportSize({ width: 420, height: 700 });
      await hostedPanel.getByTestId("tab-waterfall").click();
      await expect(hostedPanel.getByTestId("waterfall-view")).toBeVisible();
      await hostedPanel.getByTestId("fit-graph").click();
      await hostedPanel.screenshot({
        path: join(SHOTS_DIR, "panel-narrow-waterfall-dark.png"),
        animations: "disabled",
      });

      const overflowPx = await hostedPanel.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflowPx).toBe(0);

      await hostedPanel.close();
      expect(consoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);
    } finally {
      await browser.close();
      await server.close();
    }
  });
});
