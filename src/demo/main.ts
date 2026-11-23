import { ContextConsumer, ContextProvider, createContext } from "@lit/context";
import {
  LitElement,
  css,
  html,
  type PropertyDeclarations,
  type PropertyValues,
} from "lit";
import memoizeOne from "memoize-one";
import { getOrInstallGlobalHook } from "../hook/hook.ts";
import {
  BRIDGE_CHANNEL,
  type BackgroundToPanelMessage,
  type PanelToBackgroundMessage,
} from "../protocol/types.ts";
import {
  CockpitController,
  FlightModelManager,
  type CockpitViewModel,
} from "./model-and-controller.ts";

// Install hook BEFORE defining custom elements (mirrors extension MAIN-world document_start order)
const hook = getOrInstallGlobalHook();

const telemetryContext = createContext<CockpitViewModel>("cockpit-telemetry");
const armedCommandContext = createContext<string | null>(
  Symbol("armed-command"),
);

// Minimal base element using static properties (no TypeScript decorators)
abstract class BaseDemoElement extends LitElement {
  static readonly tag: string;
}

class XTelemetryCard extends BaseDemoElement {
  static override readonly tag = "x-telemetry-card";
  static override properties: PropertyDeclarations = {
    label: { type: String },
    valueText: { type: String },
    muted: { type: Boolean, reflect: true },
    warning: { type: Boolean, reflect: true },
    _renderTag: { type: String, state: true },
  };

  declare label: string;
  declare valueText: string;
  declare muted: boolean;
  declare warning: boolean;
  declare _renderTag: string;

  private _computeFormatted = memoizeOne(
    (label: string, val: string): string => `${label}: ${val}`,
  );
  private _observeWarning = memoizeOne((warning: boolean) => {
    this.dataset.alertState = warning ? "warning" : "nominal";
  });

  constructor() {
    super();
    this.label = "";
    this.valueText = "—";
    this.muted = false;
    this.warning = false;
    this._renderTag = "card";
  }

  static override styles = css`
    :host {
      display: block;
      padding: 12px;
      border-radius: 8px;
      border: 1px solid light-dark(#d5dce5, #313847);
      background: light-dark(#ffffff, #1b2028);
    }
    :host([warning]) {
      border-color: light-dark(#cf222e, #f85149);
    }
    :host([muted]) {
      opacity: 0.7;
    }
    .k {
      font-size: 0.72rem;
      color: light-dark(#566074, #99a4b8);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .v {
      margin-top: 4px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 1.05rem;
      font-weight: 700;
    }
  `;

  override shouldUpdate(changedProperties: PropertyValues<this>): boolean {
    if (
      this.muted &&
      changedProperties.size === 1 &&
      changedProperties.has("valueText")
    ) {
      return false;
    }
    return true;
  }

  override updated(): void {
    this._observeWarning(this.warning);
  }

  override render() {
    const formatted = this._computeFormatted(this.label, this.valueText);
    return html`
      <div class="k">${this.label}</div>
      <div class="v" data-testid="card-value">${formatted.split(": ")[1]}</div>
    `;
  }
}

class XNavStrip extends BaseDemoElement {
  static override readonly tag = "x-nav-strip";
  static override properties: PropertyDeclarations = {
    headingDeg: { type: Number },
    _armedLabel: { type: String, state: true },
  };

  declare headingDeg: number;
  declare _armedLabel: string;

  private _telemetryConsumer = new ContextConsumer(this, {
    context: telemetryContext,
    subscribe: true,
  });

  private _armedConsumer = new ContextConsumer(this, {
    context: armedCommandContext,
    subscribe: true,
    callback: (val) => {
      this._armedLabel = val ?? "none";
    },
  });

  constructor() {
    super();
    this.headingDeg = 0;
    this._armedLabel = "none";
  }

  static override styles = css`
    :host {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 14px;
      border-radius: 8px;
      border: 1px solid light-dark(#d5dce5, #313847);
      background: light-dark(#ffffff, #1b2028);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.85rem;
    }
    .actions {
      display: flex;
      gap: 6px;
    }
    button {
      padding: 4px 9px;
      border-radius: 5px;
      border: 1px solid light-dark(#c6cfdc, #3a4254);
      background: light-dark(#eef1f5, #242a35);
      color: inherit;
      cursor: pointer;
      font: inherit;
      font-size: 0.78rem;
    }
  `;

  private _onTurnLeft = () => {
    this.dispatchEvent(
      new CustomEvent("heading-nudge", {
        detail: { delta: -15 },
        bubbles: true,
        composed: true,
      }),
    );
  };

  private _onTurnRight = () => {
    this.dispatchEvent(
      new CustomEvent("heading-nudge", {
        detail: { delta: 15 },
        bubbles: true,
        composed: true,
      }),
    );
  };

  private _onArmHeading = () => {
    this.dispatchEvent(
      new CustomEvent("command-arm", {
        detail: { command: `HDG ${String(this.headingDeg).padStart(3, "0")}°` },
        bubbles: true,
        composed: true,
      }),
    );
  };

  override render() {
    const ctxVal = this._telemetryConsumer.value;
    const activeConsumer = this._armedConsumer;
    void activeConsumer;
    return html`
      <div>
        <strong data-testid="nav-heading"
          >HDG ${String(this.headingDeg).padStart(3, "0")}°</strong
        >
        <span> · ${ctxVal?.statusMessage ?? "—"}</span>
        <span> · Armed: <code>${this._armedLabel}</code></span>
      </div>
      <div class="actions">
        <button type="button" id="hdg-left" @click=${this._onTurnLeft}>
          −15°
        </button>
        <button type="button" id="hdg-right" @click=${this._onTurnRight}>
          +15°
        </button>
        <button type="button" id="arm-cmd-btn" @click=${this._onArmHeading}>
          Arm HDG
        </button>
      </div>
    `;
  }
}

class XCockpitShell extends BaseDemoElement {
  static override readonly tag = "x-cockpit-shell";
  static override properties: PropertyDeclarations = {
    viewModel: { type: Object },
    armedCommand: { type: String },
  };

  declare viewModel: CockpitViewModel;
  declare armedCommand: string | null;

  private _telemetryProvider = new ContextProvider(this, {
    context: telemetryContext,
  });
  private _armedProvider = new ContextProvider(this, {
    context: armedCommandContext,
    initialValue: null,
  });

  private _computeBannerText = memoizeOne((vm: CockpitViewModel): string =>
    vm.warningActive ? `WARNING: ${vm.statusMessage}` : vm.statusMessage,
  );

  constructor() {
    super();
    this.viewModel = {
      altitudeDisplay: "12000 ft",
      airspeedDisplay: "185 kt",
      headingDeg: 270,
      muted: false,
      warningActive: false,
      statusMessage: "Nominal cruise",
    };
    this.armedCommand = null;
    this.addEventListener("command-arm", (evt: Event) => {
      const cmd: unknown =
        evt instanceof CustomEvent &&
        evt.detail &&
        typeof evt.detail === "object"
          ? Reflect.get(evt.detail, "command")
          : null;
      this.armedCommand = typeof cmd === "string" ? cmd : null;
    });
  }

  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 14px;
      border-radius: 10px;
      border: 1px solid light-dark(#d5dce5, #313847);
      background: light-dark(#f0f3f8, #161a21);
    }
    .top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 10px;
    }
    .btn-row {
      display: flex;
      gap: 6px;
    }
    button {
      padding: 5px 10px;
      border-radius: 6px;
      border: 1px solid light-dark(#c6cfdc, #3a4254);
      background: light-dark(#ffffff, #222733);
      color: inherit;
      cursor: pointer;
      font: inherit;
      font-size: 0.78rem;
    }
  `;

  override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("viewModel")) {
      this._telemetryProvider.setValue(this.viewModel);
    }
    if (changed.has("armedCommand")) {
      this._armedProvider.setValue(this.armedCommand);
    }
  }

  private _onToggleUnit = () => {
    this.dispatchEvent(
      new CustomEvent("telemetry-unit-toggle", {
        bubbles: true,
        composed: true,
      }),
    );
  };

  private _onToggleMute = () => {
    this.dispatchEvent(
      new CustomEvent("mute-toggle", { bubbles: true, composed: true }),
    );
  };

  override render() {
    const banner = this._computeBannerText(this.viewModel);
    return html`
      <div class="top">
        <strong data-testid="shell-banner">${banner}</strong>
        <div class="btn-row">
          <button
            type="button"
            id="toggle-unit-btn"
            @click=${this._onToggleUnit}
          >
            Toggle ft / m
          </button>
          <button
            type="button"
            id="toggle-mute-btn"
            @click=${this._onToggleMute}
          >
            ${this.viewModel.muted ? "Unmute Card (Veto off)" : "Mute Card (Test shouldUpdate veto)"}
          </button>
        </div>
      </div>

      <div class="cards">
        <x-telemetry-card
          id="alt-card"
          label="Altitude"
          .valueText=${this.viewModel.altitudeDisplay}
          ?muted=${this.viewModel.muted}
          ?warning=${this.viewModel.warningActive}
        ></x-telemetry-card>
        <x-telemetry-card
          id="spd-card"
          label="Airspeed"
          .valueText=${this.viewModel.airspeedDisplay}
          ?muted=${this.viewModel.muted}
          ?warning=${this.viewModel.warningActive}
        ></x-telemetry-card>
      </div>

      <x-nav-strip .headingDeg=${this.viewModel.headingDeg}></x-nav-strip>
    `;
  }
}

customElements.define(XTelemetryCard.tag, XTelemetryCard);
customElements.define(XNavStrip.tag, XNavStrip);
customElements.define(XCockpitShell.tag, XCockpitShell);

const modelManager = new FlightModelManager();
const cockpitController = new CockpitController(modelManager);
const observerLogEl = document.getElementById("observer-log");
cockpitController.onStatusSync = (line) => {
  if (observerLogEl) observerLogEl.textContent = line;
};

const shellEl = document.getElementById("cockpit-shell");
if (shellEl instanceof HTMLElement) {
  cockpitController.attachView(shellEl);
  cockpitController.syncFromModel();
}

const altInput = document.getElementById("alt-input");
const spdInput = document.getElementById("spd-input");
const statusInput = document.getElementById("status-input");

document.getElementById("alt-inc")?.addEventListener("click", () => {
  const next = modelManager.model.altitudeFt + 1000;
  modelManager.update({ altitudeFt: next });
  if (altInput instanceof HTMLInputElement) altInput.value = String(next);
});
document.getElementById("alt-dec")?.addEventListener("click", () => {
  const next = Math.max(0, modelManager.model.altitudeFt - 1000);
  modelManager.update({ altitudeFt: next });
  if (altInput instanceof HTMLInputElement) altInput.value = String(next);
});
if (altInput instanceof HTMLInputElement) {
  altInput.addEventListener("input", () => {
    const v = Number(altInput.value);
    if (Number.isFinite(v)) modelManager.update({ altitudeFt: v });
  });
}

document.getElementById("spd-inc")?.addEventListener("click", () => {
  const next = modelManager.model.airspeedKt + 20;
  modelManager.update({ airspeedKt: next });
  if (spdInput instanceof HTMLInputElement) spdInput.value = String(next);
});
document.getElementById("spd-dec")?.addEventListener("click", () => {
  const next = Math.max(0, modelManager.model.airspeedKt - 20);
  modelManager.update({ airspeedKt: next });
  if (spdInput instanceof HTMLInputElement) spdInput.value = String(next);
});
if (spdInput instanceof HTMLInputElement) {
  spdInput.addEventListener("input", () => {
    const v = Number(spdInput.value);
    if (Number.isFinite(v)) modelManager.update({ airspeedKt: v });
  });
}

document.getElementById("status-apply")?.addEventListener("click", () => {
  if (statusInput instanceof HTMLInputElement) {
    modelManager.update({ statusMessage: statusInput.value });
  }
});

document.getElementById("low-alt-trigger")?.addEventListener("click", () => {
  modelManager.update({
    altitudeFt: 2500,
    statusMessage: "Terrain floor warning",
  });
  if (altInput instanceof HTMLInputElement) altInput.value = "2500";
  if (statusInput instanceof HTMLInputElement)
    statusInput.value = "Terrain floor warning";
});

document.getElementById("burst-btn")?.addEventListener("click", () => {
  for (let i = 1; i <= 4; i++) {
    setTimeout(() => {
      modelManager.update({ headingDeg: (270 + i * 15) % 360 });
    }, i * 55);
  }
});

const toggleInspectorBtn = document.getElementById("toggle-inspector");
const playgroundShell = document.querySelector(".playground-shell");
toggleInspectorBtn?.addEventListener("click", () => {
  const hidden = playgroundShell?.classList.toggle("inspector-hidden") ?? false;
  toggleInspectorBtn.textContent = hidden
    ? "Show Embedded DevTools"
    : "Hide Embedded DevTools";
  toggleInspectorBtn.setAttribute("aria-expanded", String(!hidden));
});

// Embedded iframe panel bridge
const panelFrameEl = document.getElementById("panel-frame");
const panelFrame =
  panelFrameEl instanceof HTMLIFrameElement ? panelFrameEl : null;
let bridgeSub: (() => void) | null = null;
let bridgeTimer: ReturnType<typeof setTimeout> | null = null;

function postToEmbeddedPanel(payload: BackgroundToPanelMessage): void {
  panelFrame?.contentWindow?.postMessage(
    {
      channel: BRIDGE_CHANNEL,
      direction: "host-to-panel",
      payload,
    },
    "*",
  );
}

function scheduleBridgePush(): void {
  if (bridgeTimer !== null) return;
  bridgeTimer = setTimeout(() => {
    bridgeTimer = null;
    postToEmbeddedPanel({ type: "SNAPSHOT", snapshot: hook.snapshot() });
  }, 45);
}

function isPanelMessage(value: unknown): value is PanelToBackgroundMessage {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof Reflect.get(value, "type") === "string"
  );
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== panelFrame?.contentWindow) return;
  const data: unknown = event.data;
  if (
    data === null ||
    typeof data !== "object" ||
    Reflect.get(data, "channel") !== BRIDGE_CHANNEL ||
    Reflect.get(data, "direction") !== "panel-to-host"
  ) {
    return;
  }
  const msg: unknown = Reflect.get(data, "payload");
  if (!isPanelMessage(msg)) return;

  switch (msg.type) {
    case "START_INSPECTION":
      hook.scanDom();
      bridgeSub?.();
      bridgeSub = hook.subscribe(() => scheduleBridgePush());
      postToEmbeddedPanel({
        type: "PAGE_CONNECTED",
        url: window.location.href,
      });
      postToEmbeddedPanel({ type: "SNAPSHOT", snapshot: hook.snapshot() });
      break;
    case "STOP_INSPECTION":
      bridgeSub?.();
      bridgeSub = null;
      hook.highlightElement(null);
      break;
    case "REQUEST_SNAPSHOT":
      postToEmbeddedPanel({ type: "SNAPSHOT", snapshot: hook.snapshot() });
      break;
    case "SCAN_DOM":
      hook.scanDom();
      postToEmbeddedPanel({ type: "SNAPSHOT", snapshot: hook.snapshot() });
      break;
    case "SET_PROPERTY": {
      const result = hook.setProperty(msg.nodeId, msg.propName, msg.jsonText);
      postToEmbeddedPanel({
        type: "ACTION_RESULT",
        requestId: msg.requestId,
        result,
      });
      postToEmbeddedPanel({ type: "SNAPSHOT", snapshot: hook.snapshot() });
      break;
    }
    case "CLEAR_MEMO_CACHE": {
      const result = hook.clearMemoCache(msg.nodeId);
      postToEmbeddedPanel({
        type: "ACTION_RESULT",
        requestId: msg.requestId,
        result,
      });
      postToEmbeddedPanel({ type: "SNAPSHOT", snapshot: hook.snapshot() });
      break;
    }
    case "LOG_NODE":
      hook.logToConsole(msg.nodeId);
      break;
    case "HIGHLIGHT_ELEMENT":
      hook.highlightElement(msg.nodeId);
      break;
    case "CONFIGURE_HOOK":
      hook.configure(msg.settings);
      postToEmbeddedPanel({ type: "SNAPSHOT", snapshot: hook.snapshot() });
      break;
    case "CLEAR_EVENTS":
      hook.clearEvents();
      postToEmbeddedPanel({ type: "SNAPSHOT", snapshot: hook.snapshot() });
      break;
    case "PING":
      postToEmbeddedPanel({ type: "PONG" });
      break;
  }
});
