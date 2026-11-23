# lit-reactivity-devtools

Chrome DevTools extension (**Lit Flow**) for zero-config tracing of reactive properties, `EventTarget` models/controllers, `@lit/context` streams, `memoize-one` (`_compute*` / `_observe*`) functions, and custom events flowing through Lit and custom elements.

## What It Traces

1. **Elements (`LitElement` / `ReactiveElement`)**:
   - Hooks `CustomElementRegistry.prototype.define` at `document_start` (`MAIN` world) and lazily resolves `ReactiveElement` / `LitElement` prototypes by duck-typing (`performUpdate`, `requestUpdate`, `update`), supporting both global and scoped registries and multiple Lit versions without importing `lit`.
   - Captures static `elementProperties` declarations (`attribute`, `type`, `reflect`, `state`), live property values (`prev → current`), parent-to-child property propagation (`prop-flow`), `shouldUpdate` render vetoes, and per-render execution timings.
2. **`@lit/context` Channels (`ContextProvider` & `ContextConsumer`)**:
   - Intercepts `context-request` and `context-provider` DOM `Event`s plus `ContextProvider.setValue()` pushes and `ContextConsumer` callbacks—tracing context updates even when a provider pushes values without re-rendering its host element.
3. **Models & Controllers (`EventTarget` / `ReactiveController`)**:
   - Tracks `addController` / `removeController`, `model-update` and `view-model-update` `EventTarget` dispatches, `controller.modelManager` / `controller.parentController` / `controller.view` links, plus optional explicit registration via `globalThis.__LIT_DEVTOOLS_HOOK__` or `lit-reactivity-devtools`.
4. **Memoized Derived Values & Side Effects (`memoize-one`)**:
   - Detects `memoize-one` instance fields (`_compute*`, `_observe*`, or `fn.name === "memoized"` with `.clear()`) on elements and controllers and wraps them transparently via `Proxy` to record cache **HIT** vs **MISS**, arguments, return values, and execution durations.
5. **Composed `CustomEvent` Feedback Loops**:
   - Traces bubbling, composed `CustomEvent`s dispatched from custom elements and connects feedback edges when an event synchronously drives a parent element, controller, or model update.

## DevTools Features

- **Focused Causal Dataflow Graph**: Topological left-to-right layout (`Model → Controller → Context → Element → Computed / Observer`) with dashed `event-emit` feedback arcs, pan/zoom/fit, keyboard navigation, and **Focus Subgraph** isolation for large component trees.
- **Waterfall & Trace Stream**: Cascade-grouped execution bars (`cascadeId`) showing exact causal chains (`model-update → controller transform → context push → element render → memo miss → child prop`) alongside a filterable chronological trace stream.
- **Live Property & Memo Inspector**: Inspect reactive property metadata and values, edit element properties live via JSON, clear `memoize-one` caches, reveal DOM nodes in Chrome DevTools **Elements**, sync from `$0`, and log live objects to Console as `$lit`.

## Project Structure

```text
src/
├── protocol/types.ts       # Shared snapshot, node, edge, waterfall trace, and MV3 message contracts
├── hook/                   # Zero-import MAIN-world runtime hooks & ISOLATED bridge
├── client/index.ts         # Optional registerModel / registerController / label / traceMemoized helpers
├── extension/              # MV3 manifest, background SW Port router, devtools registration ("Lit Flow")
├── panel/                  # DevTools UI, topological DAG layout, subgraph/waterfall state, SVG graph
└── demo/                   # Lit + @lit/context + memoize-one + Model/Controller Flight Cockpit Demo
scripts/
├── build.ts                # Builds dist/extension, dist/client, dist/types, and dist/demo
└── dev-demo.ts             # Serves dist/demo locally
tests/
├── unit/                   # Bun unit tests (memo-tracker, EventTarget model/controller, layout, state)
└── e2e/                    # Playwright Chromium E2E (MV3 extension, real DevTools "Lit Flow" tab, UI)
```

## Build & Load in Chrome

```bash
bun install
bun run build
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select `dist/extension`.
3. Open your Lit application (or run `bun run dev` and open `http://127.0.0.1:4174`), open Chrome DevTools, and switch to the **Lit Flow** panel.

## Optional Manual Registration (`lit-reactivity-devtools`)

Zero-config hooks automatically discover `LitElement` / `ReactiveElement`, `@lit/context`, `memoize-one` fields, and `model-update` / `view-model-update` `EventTarget`s. For custom stores that do not dispatch DOM events:

```ts
import {
  registerModel,
  registerController,
  label,
  traceMemoized,
} from "lit-reactivity-devtools";

registerModel(myStore, { name: "FlightStore", initialValue: myStore.state });
registerController(myCtrl, {
  name: "NavController",
  model: myStore,
  host: myElement,
});
```

## Verification

```bash
bun run fmt:check
bun check
bun run lint
bun test
bun run test:e2e
```
