import { ContextConsumer, ContextProvider, createContext } from "@lit/context";
import { LitElement, html, type PropertyDeclarations } from "lit";
import memoizeOne from "memoize-one";

// Zero-config fixture: does NOT import or touch __LIT_DEVTOOLS_HOOK__ at all!
const zcCtx = createContext<number>("zc-ctx");

class ZeroConfigModel extends EventTarget {
  factor = 2;
  bump() {
    this.factor += 1;
    this.dispatchEvent(
      new CustomEvent("model-update", {
        detail: { model: { factor: this.factor } },
      }),
    );
  }
}

class ZcChild extends LitElement {
  static override properties: PropertyDeclarations = {
    value: { type: Number },
  };
  declare value: number;

  private _ctx = new ContextConsumer(this, { context: zcCtx, subscribe: true });
  private _computeScaled = memoizeOne(
    (v: number, factor: number) => v * factor,
  );

  constructor() {
    super();
    this.value = 10;
  }

  override render() {
    const factor = this._ctx.value ?? 1;
    return html`${this._computeScaled(this.value, factor)}`;
  }
}

class ZcParent extends LitElement {
  static override properties: PropertyDeclarations = {
    baseVal: { type: Number },
  };
  declare baseVal: number;

  private _model = new ZeroConfigModel();
  private _provider = new ContextProvider(this, {
    context: zcCtx,
    initialValue: 2,
  });

  constructor() {
    super();
    this.baseVal = 20;
    this._model.addEventListener("model-update", () => {
      this._provider.setValue(this._model.factor);
    });
  }

  triggerModelUpdate() {
    this._model.bump();
  }

  override render() {
    return html`<zc-child .value=${this.baseVal}></zc-child>`;
  }
}

customElements.define("zc-child", ZcChild);
customElements.define("zc-parent", ZcParent);
