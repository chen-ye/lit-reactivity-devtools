import { LitElement, html, type PropertyDeclarations } from "lit";
import { getOrInstallGlobalHook } from "../../src/hook/hook.ts";

const hook = getOrInstallGlobalHook();

class SibCard extends LitElement {
  static override properties: PropertyDeclarations = {
    label: { type: String },
    seq: { type: Number },
  };
  declare label: string;
  declare seq: number;

  constructor() {
    super();
    this.label = "";
    this.seq = 0;
  }

  override render() {
    return html`<span>${this.label}:${this.seq}</span>`;
  }
}
customElements.define("sib-card", SibCard);

class SoloBadge extends LitElement {
  static override properties: PropertyDeclarations = {
    count: { type: Number },
  };
  declare count: number;

  constructor() {
    super();
    this.count = 1;
  }

  override render() {
    return html`<b>${this.count}</b>`;
  }
}
customElements.define("solo-badge", SoloBadge);

class SibHost extends LitElement {
  override render() {
    return html`
      <sib-card label="ALT" seq="100"></sib-card>
      <sib-card label="HDG" seq="270"></sib-card>
      <solo-badge count="3"></solo-badge>
    `;
  }
}
customElements.define("sib-host", SibHost);

Reflect.set(window, "__HOOK__", hook);
