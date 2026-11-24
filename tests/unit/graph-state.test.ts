import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FILTER_STATE,
  derivePanelViewModel,
} from "../../src/panel/graph-state.ts";
import type {
  GraphSnapshot,
  ReactivityEdgeSnapshot,
  ReactivityNodeSnapshot,
} from "../../src/protocol/types.ts";
import {
  clearTagTokens,
  listExcludedTags,
  listIncludedTags,
  matchGlob,
  parseQuery,
  setKindExcludedInQuery,
  setTagExcludedInQuery,
  setTagOnlyInQuery,
} from "../../src/shared/query-parser.ts";

function makeNode(
  overrides: Partial<ReactivityNodeSnapshot> &
    Pick<ReactivityNodeSnapshot, "id" | "kind" | "label">,
): ReactivityNodeSnapshot {
  return {
    subtitle: null,
    site: null,
    connected: true,
    updates: 1,
    hits: 0,
    misses: 0,
    vetoes: 0,
    lastDurationMs: null,
    lastChangedSeq: 1,
    lastCauseLabel: null,
    lastCauseNodeId: null,
    value: null,
    error: null,
    ...overrides,
  };
}

function makeSnapshot(
  nodes: ReadonlyArray<ReactivityNodeSnapshot>,
  edges: ReadonlyArray<ReactivityEdgeSnapshot> = [],
): GraphSnapshot {
  return {
    version: 1,
    seq: 10,
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

describe("query-parser", () => {
  test("parses structured tokens, quoted phrases, negations, and lossless spans", () => {
    const query =
      '  tag:ui-* -tag:ui-toggle-button kind:element -kind:observer prop:active* -prop:_raw file:"src/panel/main.ts" -file:vendor is:connected -is:error #42 -#7 "hello world" -"bad actor" -noise - ';
    const parsed = parseQuery(query);

    for (const token of parsed.tokens) {
      expect(query.slice(token.start, token.end)).toBe(token.raw);
    }

    expect(
      parsed.tokens.map((t) => ({
        field: t.field,
        negated: t.negated,
        value: t.value,
        quoted: t.quoted,
      })),
    ).toEqual([
      { field: "tag", negated: false, value: "ui-*", quoted: false },
      {
        field: "tag",
        negated: true,
        value: "ui-toggle-button",
        quoted: false,
      },
      { field: "kind", negated: false, value: "element", quoted: false },
      { field: "kind", negated: true, value: "observer", quoted: false },
      { field: "prop", negated: false, value: "active*", quoted: false },
      { field: "prop", negated: true, value: "_raw", quoted: false },
      {
        field: "file",
        negated: false,
        value: "src/panel/main.ts",
        quoted: true,
      },
      { field: "file", negated: true, value: "vendor", quoted: false },
      { field: "is", negated: false, value: "connected", quoted: false },
      { field: "is", negated: true, value: "error", quoted: false },
      { field: "id", negated: false, value: "42", quoted: false },
      { field: "id", negated: true, value: "7", quoted: false },
      { field: "text", negated: false, value: "hello world", quoted: true },
      { field: "text", negated: true, value: "bad actor", quoted: true },
      { field: "text", negated: true, value: "noise", quoted: false },
      { field: "text", negated: false, value: "-", quoted: false },
    ]);

    expect(parsed.inclusions.length).toBe(8);
    expect(parsed.exclusions.length).toBe(8);
  });

  test("ignores incomplete empty structured tokens in inclusions/exclusions", () => {
    const parsed = parseQuery("tag: -tag: #");
    expect(parsed.tokens.length).toBe(3);
    expect(parsed.inclusions.length).toBe(0);
    expect(parsed.exclusions.length).toBe(0);
  });

  test("matches case-insensitive globs with * wildcard", () => {
    expect(matchGlob("ui-*", "ui-toggle-button")).toBe(true);
    expect(matchGlob("UI-*", "ui-card")).toBe(true);
    expect(matchGlob("ui-toggle", "ui-toggle-button")).toBe(false);
    expect(matchGlob("*toggle*", "ui-toggle-button")).toBe(true);
    expect(matchGlob("***button", "ui-toggle-button")).toBe(true);
    expect(matchGlob("", "anything")).toBe(false);
  });

  test("performs lossless AST query mutations including wildcard expansion", () => {
    expect(setTagExcludedInQuery("", "ui-toggle-button", true)).toBe(
      "-tag:ui-toggle-button",
    );
    expect(
      setTagExcludedInQuery(
        'kind:element tag:ui-toggle-button "my note"',
        "ui-toggle-button",
        true,
      ),
    ).toBe('kind:element "my note" -tag:ui-toggle-button');
    expect(
      setTagExcludedInQuery(
        "kind:element -tag:ui-toggle-button foo",
        "ui-toggle-button",
        true,
      ),
    ).toBe("kind:element -tag:ui-toggle-button foo");
    expect(
      setTagExcludedInQuery(
        "kind:element -tag:ui-toggle-button foo",
        "ui-toggle-button",
        false,
      ),
    ).toBe("kind:element foo");

    // Un-excluding one tag under -tag:ui-* expands remaining matching tags explicitly
    expect(
      setTagExcludedInQuery("kind:element -tag:ui-*", "ui-card", false, [
        "ui-card",
        "ui-panel",
        "ui-button",
        "md-icon",
      ]),
    ).toBe("kind:element -tag:ui-panel -tag:ui-button");

    // Excluding prefix group collapses narrower redundant -tag:ui-card tokens
    expect(
      setTagExcludedInQuery("-tag:ui-card -tag:md-icon", "ui-*", true),
    ).toBe("-tag:md-icon -tag:ui-*");

    expect(
      setTagOnlyInQuery(
        "kind:element -tag:md-icon tag:ui-card foo",
        "ui-button",
      ),
    ).toBe("kind:element foo tag:ui-button");
    expect(setTagOnlyInQuery("tag:ui-button", "ui-button")).toBe(
      "tag:ui-button",
    );

    expect(setKindExcludedInQuery("foo kind:observer", "observer", true)).toBe(
      "foo -kind:observer",
    );
    expect(
      setKindExcludedInQuery("foo -kind:observer", "observer", false),
    ).toBe("foo");

    const mixed = "-tag:md-* tag:ui-card -tag:ui-toggle-button -tag:MD-*";
    expect(listExcludedTags(mixed)).toEqual(["md-*", "ui-toggle-button"]);
    expect(listIncludedTags(mixed)).toEqual(["ui-card"]);
    expect(clearTagTokens(`kind:element ${mixed} foo`)).toBe(
      "kind:element foo",
    );
  });
});

describe("derivePanelViewModel", () => {
  test("scopes Focused Subgraph to transitive upstream/downstream neighborhood and groups waterfall cascades", () => {
    const snapshot: GraphSnapshot = {
      version: 1,
      seq: 4,
      baseSeq: 0,
      droppedEvents: 0,
      litVersions: ["4.2.2"],
      settings: {
        paused: false,
        captureMemoHits: false,
        captureCustomEvents: true,
      },
      nodes: [
        {
          id: 1,
          kind: "model",
          label: "FlightModel",
          subtitle: "Model",
          site: null,
          connected: true,
          updates: 1,
          hits: 0,
          misses: 0,
          vetoes: 0,
          lastDurationMs: null,
          lastChangedSeq: 1,
          lastCauseLabel: null,
          lastCauseNodeId: null,
          value: null,
          error: null,
        },
        {
          id: 2,
          kind: "controller",
          label: "MapController",
          subtitle: "Controller",
          site: null,
          connected: true,
          updates: 1,
          hits: 0,
          misses: 0,
          vetoes: 0,
          lastDurationMs: null,
          lastChangedSeq: 2,
          lastCauseLabel: null,
          lastCauseNodeId: 1,
          value: null,
          error: null,
        },
        {
          id: 3,
          kind: "element",
          label: "x-route-map",
          subtitle: "RouteMapElement",
          site: null,
          connected: true,
          updates: 1,
          hits: 0,
          misses: 0,
          vetoes: 0,
          lastDurationMs: 1.4,
          lastChangedSeq: 3,
          lastCauseLabel: "viewModel",
          lastCauseNodeId: 2,
          value: null,
          error: null,
        },
        {
          id: 4,
          kind: "element",
          label: "unrelated-clock",
          subtitle: "ClockElement",
          site: null,
          connected: true,
          updates: 1,
          hits: 0,
          misses: 0,
          vetoes: 0,
          lastDurationMs: 0.2,
          lastChangedSeq: 4,
          lastCauseLabel: null,
          lastCauseNodeId: null,
          value: null,
          error: null,
        },
      ],
      edges: [
        {
          id: "1->2:model-to-controller:model-update",
          sourceId: 1,
          targetId: 2,
          kind: "model-to-controller",
          label: "model-update",
          count: 1,
          lastSeq: 2,
          lastDetail: null,
        },
        {
          id: "2->3:controller-to-element:viewModel",
          sourceId: 2,
          targetId: 3,
          kind: "controller-to-element",
          label: "viewModel",
          count: 1,
          lastSeq: 3,
          lastDetail: null,
        },
      ],
      events: [
        {
          seq: 1,
          cascadeId: 10,
          timestamp: 1000,
          durationMs: 0,
          nodeId: 1,
          kind: "model-update",
          label: "FlightModel model-update",
          causeNodeId: null,
          detail: "{alt: 100}",
        },
        {
          seq: 2,
          cascadeId: 10,
          timestamp: 1001,
          durationMs: 0.5,
          nodeId: 2,
          kind: "controller-transform",
          label: "MapController view-model-update",
          causeNodeId: 1,
          detail: null,
        },
        {
          seq: 3,
          cascadeId: 10,
          timestamp: 1002,
          durationMs: 1.4,
          nodeId: 3,
          kind: "render",
          label: "x-route-map render",
          causeNodeId: 2,
          detail: null,
        },
        {
          seq: 4,
          cascadeId: 11,
          timestamp: 1100,
          durationMs: 0.2,
          nodeId: 4,
          kind: "render",
          label: "unrelated-clock render",
          causeNodeId: null,
          detail: null,
        },
      ],
    };

    const focused = derivePanelViewModel(
      snapshot,
      { ...DEFAULT_FILTER_STATE, focusSubgraphNodeId: 2 },
      3,
    );

    expect(
      focused.visibleNodes.map((n) => n.id).toSorted((a, b) => a - b),
    ).toEqual([1, 2, 3]);
    expect(focused.upstreamIds).toEqual(new Set([1, 2]));
    expect(focused.downstreamIds).toEqual(new Set());
    expect(focused.cascades.length).toBe(2);
    expect(focused.cascades[0]?.cascadeId).toBe(11);
    expect(focused.cascades[1]?.cascadeId).toBe(10);
    expect(focused.cascades[1]?.totalDurationMs).toBeCloseTo(1.9);

    const selfCauseSnap: GraphSnapshot = {
      ...snapshot,
      nodes: snapshot.nodes.map((n) =>
        n.id === 3
          ? { ...n, lastCauseNodeId: 3, lastCauseLabel: "prop 'x'" }
          : n,
      ),
    };
    const selfChecked = derivePanelViewModel(
      selfCauseSnap,
      DEFAULT_FILTER_STATE,
      3,
    );
    expect(selfChecked.directCauseNodeIds.has(3)).toBe(false);
  });

  test("Highlight mode keeps non-matching nodes visible and orders orderedMatchIds by (layer, row, id)", () => {
    const snapshot = makeSnapshot(
      [
        makeNode({
          id: 1,
          kind: "model",
          label: "StoreModel",
          site: { file: "src/store.ts", line: 10, column: 2, fn: null },
        }),
        makeNode({
          id: 2,
          kind: "element",
          label: "ui-panel",
          tagName: "ui-panel",
          disambiguator: "#main",
        }),
        makeNode({
          id: 3,
          kind: "element",
          label: "ui-toggle-button",
          tagName: "ui-toggle-button",
          subtitle: "ToggleControl",
        }),
        makeNode({
          id: 4,
          kind: "computed",
          label: "derivedTitle",
          computeSource: "() => state.title.trim()",
          computeSignature: "(title)",
        }),
      ],
      [
        {
          id: "1->2:model-to-controller:state",
          sourceId: 1,
          targetId: 2,
          kind: "model-to-controller",
          label: "state",
          count: 1,
          lastSeq: 1,
          lastDetail: null,
        },
        {
          id: "2->4:memo-compute:derivedTitle",
          sourceId: 2,
          targetId: 4,
          kind: "memo-compute",
          label: "derivedTitle",
          count: 1,
          lastSeq: 2,
          lastDetail: null,
        },
      ],
    );

    const highlighted = derivePanelViewModel(
      snapshot,
      {
        ...DEFAULT_FILTER_STATE,
        query: "ui-* tag:ui-*",
        queryMode: "highlight",
      },
      null,
    );
    // "ui-*" free-text wouldn't match literal "ui-*" without glob unless tag:ui-* is used
    expect(highlighted.queryMode).toBe("highlight");
    expect(highlighted.visibleNodes.length).toBe(4);

    const tagHighlighted = derivePanelViewModel(
      snapshot,
      { ...DEFAULT_FILTER_STATE, query: "tag:ui-*" },
      null,
    );
    expect(tagHighlighted.isHighlightQueryActive).toBe(true);
    expect(tagHighlighted.visibleNodes.map((n) => n.id)).toEqual([1, 2, 3, 4]);
    expect(tagHighlighted.searchMatchIds).toEqual(new Set([2, 3]));
    // Node 3 is disconnected layer 1 (or earlier/later row than 2); verify orderedMatchIds matches layout (layer, row, id)
    const expectedOrder = [2, 3].toSorted((a, b) => {
      const pa = tagHighlighted.layout.nodeById.get(a)!;
      const pb = tagHighlighted.layout.nodeById.get(b)!;
      if (pa.layer !== pb.layer) return pa.layer - pb.layer;
      if (pa.row !== pb.row) return pa.row - pb.row;
      return pa.node.id - pb.node.id;
    });
    expect(tagHighlighted.orderedMatchIds).toEqual(expectedOrder);

    // Also test Filter mode hides non-matching nodes
    const filtered = derivePanelViewModel(
      snapshot,
      { ...DEFAULT_FILTER_STATE, query: "tag:ui-*", queryMode: "filter" },
      null,
    );
    expect(filtered.isHighlightQueryActive).toBe(false);
    expect(filtered.visibleNodes.map((n) => n.id)).toEqual([2, 3]);
    expect(filtered.searchMatchIds).toEqual(new Set([2, 3]));

    // Test matching across disambiguator, computeSource, computeSignature, subtitle, properties, site.file
    expect(
      derivePanelViewModel(
        snapshot,
        { ...DEFAULT_FILTER_STATE, query: "#main" },
        null,
      ).searchMatchIds,
    ).toEqual(new Set());
    expect(
      derivePanelViewModel(
        snapshot,
        { ...DEFAULT_FILTER_STATE, query: '"#main"' },
        null,
      ).searchMatchIds,
    ).toEqual(new Set([2]));
    expect(
      derivePanelViewModel(
        snapshot,
        { ...DEFAULT_FILTER_STATE, query: "state.title.trim" },
        null,
      ).searchMatchIds,
    ).toEqual(new Set([4]));
    expect(
      derivePanelViewModel(
        snapshot,
        { ...DEFAULT_FILTER_STATE, query: "(title)" },
        null,
      ).searchMatchIds,
    ).toEqual(new Set([4]));
    expect(
      derivePanelViewModel(
        snapshot,
        { ...DEFAULT_FILTER_STATE, query: "ToggleControl" },
        null,
      ).searchMatchIds,
    ).toEqual(new Set([3]));
    expect(
      derivePanelViewModel(
        snapshot,
        { ...DEFAULT_FILTER_STATE, query: "file:src/store.ts" },
        null,
      ).searchMatchIds,
    ).toEqual(new Set([1]));
  });

  test("negative exclusions remove nodes in Highlight mode without activating isHighlightQueryActive when no positive tokens exist", () => {
    const snapshot = makeSnapshot([
      makeNode({ id: 1, kind: "model", label: "AppModel" }),
      makeNode({
        id: 2,
        kind: "element",
        label: "ui-toggle-button",
        tagName: "ui-toggle-button",
      }),
      makeNode({
        id: 3,
        kind: "element",
        label: "md-icon",
        tagName: "md-icon",
      }),
      makeNode({
        id: 4,
        kind: "element",
        label: "md-button",
        tagName: "md-button",
      }),
      makeNode({
        id: 5,
        kind: "element",
        label: "ui-card",
        tagName: "ui-card",
        properties: [
          {
            name: "disabled",
            isState: false,
            reflect: true,
            attribute: "disabled",
            typeName: "Boolean",
            value: { kind: "boolean", text: "true" },
            prevValue: null,
            changes: 1,
            lastChangedSeq: 1,
            sourceLabel: null,
          },
        ],
      }),
    ]);

    const vm = derivePanelViewModel(
      snapshot,
      {
        ...DEFAULT_FILTER_STATE,
        query: "-tag:ui-toggle-button -tag:md-*",
        queryMode: "highlight",
      },
      null,
    );

    expect(vm.isHighlightQueryActive).toBe(false);
    expect(vm.searchMatchIds).toEqual(new Set());
    expect(vm.orderedMatchIds).toEqual([]);
    expect(vm.visibleNodes.map((n) => n.id)).toEqual([1, 5]);

    // Combine negative exclusion + positive inclusion in highlight mode
    const vmWithPositive = derivePanelViewModel(
      snapshot,
      {
        ...DEFAULT_FILTER_STATE,
        query: "-tag:md-* prop:disabled",
        queryMode: "highlight",
      },
      null,
    );
    expect(vmWithPositive.isHighlightQueryActive).toBe(true);
    expect(vmWithPositive.visibleNodes.map((n) => n.id)).toEqual([1, 2, 5]);
    expect(vmWithPositive.searchMatchIds).toEqual(new Set([5]));
  });

  test("tagInventory and prefixGroups preserve excluded tags with accurate pre-exclusion counts", () => {
    const snapshot = makeSnapshot([
      makeNode({
        id: 1,
        kind: "element",
        label: "md-icon",
        tagName: "md-icon",
      }),
      makeNode({
        id: 2,
        kind: "element",
        label: "md-icon",
        tagName: "md-icon",
      }),
      makeNode({
        id: 3,
        kind: "element",
        label: "md-icon",
        tagName: "md-icon",
      }),
      makeNode({
        id: 4,
        kind: "element",
        label: "md-button",
        tagName: "md-button",
      }),
      makeNode({
        id: 5,
        kind: "element",
        label: "ui-card",
        tagName: "ui-card",
      }),
      makeNode({
        id: 6,
        kind: "element",
        label: "ui-panel",
        tagName: "ui-panel",
      }),
      makeNode({
        id: 7,
        kind: "element",
        label: "solo-widget",
        tagName: "solo-widget",
      }),
      makeNode({
        id: 8,
        kind: "element",
        label: "solo-widget",
        tagName: "solo-widget",
      }),
    ]);

    const vm = derivePanelViewModel(
      snapshot,
      {
        ...DEFAULT_FILTER_STATE,
        query: "-tag:md-* tag:ui-card",
        queryMode: "highlight",
      },
      null,
    );

    // md-* nodes are excluded from visibleNodes, but remain in tagInventory!
    expect(vm.visibleNodes.map((n) => n.id)).toEqual([5, 6, 7, 8]);
    expect(vm.tagInventory).toEqual([
      { tagName: "md-icon", count: 3, excluded: true, included: false },
      { tagName: "solo-widget", count: 2, excluded: false, included: false },
      { tagName: "md-button", count: 1, excluded: true, included: false },
      { tagName: "ui-card", count: 1, excluded: false, included: true },
      { tagName: "ui-panel", count: 1, excluded: false, included: false },
    ]);

    // solo-* has only 1 distinct tag (count 2 instances), so it must NOT form a prefix group
    expect(vm.prefixGroups).toEqual([
      { prefix: "md-*", count: 4, excluded: true },
      { prefix: "ui-*", count: 2, excluded: false },
    ]);
  });

  test("composes Focus Subgraph with Highlight mode and tagInventory", () => {
    const snapshot = makeSnapshot(
      [
        makeNode({ id: 1, kind: "model", label: "RootModel" }),
        makeNode({
          id: 2,
          kind: "element",
          label: "ui-header",
          tagName: "ui-header",
        }),
        makeNode({
          id: 3,
          kind: "element",
          label: "ui-footer",
          tagName: "ui-footer",
        }),
        makeNode({
          id: 4,
          kind: "element",
          label: "md-toast",
          tagName: "md-toast",
        }),
      ],
      [
        {
          id: "1->2:model-to-controller:h",
          sourceId: 1,
          targetId: 2,
          kind: "model-to-controller",
          label: "h",
          count: 1,
          lastSeq: 1,
          lastDetail: null,
        },
        {
          id: "1->3:model-to-controller:f",
          sourceId: 1,
          targetId: 3,
          kind: "model-to-controller",
          label: "f",
          count: 1,
          lastSeq: 2,
          lastDetail: null,
        },
      ],
    );

    const vm = derivePanelViewModel(
      snapshot,
      {
        ...DEFAULT_FILTER_STATE,
        focusSubgraphNodeId: 2,
        query: "tag:ui-header",
        queryMode: "highlight",
      },
      null,
    );

    // Subgraph of node 2 is {1, 2} (node 3 is sibling from 1, not upstream/downstream of 2; node 4 is disconnected)
    expect(vm.visibleNodes.map((n) => n.id)).toEqual([1, 2]);
    expect(vm.isHighlightQueryActive).toBe(true);
    expect(vm.searchMatchIds).toEqual(new Set([2]));
    expect(vm.orderedMatchIds).toEqual([2]);
    expect(vm.tagInventory).toEqual([
      { tagName: "ui-header", count: 1, excluded: false, included: true },
    ]);
  });

  test("wires expandedMemoOwnerIds into layout and resolves collapsed memo matches in orderedMatchIds via layout.nodeById", () => {
    const snapshot = makeSnapshot(
      [
        makeNode({ id: 1, kind: "element", label: "owner-el" }),
        makeNode({
          id: 11,
          kind: "computed",
          label: "_computeAlpha",
          ownerNodeId: 1,
        }),
        makeNode({
          id: 12,
          kind: "computed",
          label: "_computeBeta",
          ownerNodeId: 1,
        }),
        makeNode({
          id: 13,
          kind: "computed",
          label: "_computeGamma",
          ownerNodeId: 1,
        }),
        makeNode({
          id: 14,
          kind: "observer",
          label: "observeDelta",
          ownerNodeId: 1,
        }),
        makeNode({
          id: 15,
          kind: "computed",
          label: "_computeEpsilon",
          ownerNodeId: 1,
        }),
        makeNode({
          id: 16,
          kind: "computed",
          label: "_computeFailing",
          ownerNodeId: 1,
          error: "Boom",
        }),
      ],
      [11, 12, 13, 14, 15, 16].map((id) => ({
        id: `1->${id}:memo-compute:memo`,
        sourceId: 1,
        targetId: id,
        kind: id === 14 ? ("memo-observe" as const) : ("memo-compute" as const),
        label: "memo",
        count: 1,
        lastSeq: id,
        lastDetail: null,
      })),
    );

    const collapsed = derivePanelViewModel(
      snapshot,
      {
        ...DEFAULT_FILTER_STATE,
        query: "kind:computed",
        queryMode: "highlight",
      },
      null,
    );

    const cluster = collapsed.layout.clusters?.[0];
    expect(cluster).toBeDefined();
    expect(cluster?.expanded).toBe(false);
    expect(collapsed.searchMatchIds).toEqual(new Set([11, 12, 13, 15, 16]));
    // 11,12,13,15 are collapsed into clusterNodeId, so orderedMatchIds maps & deduplicates them to the visible cluster card + 16
    for (const matchId of collapsed.orderedMatchIds) {
      expect(collapsed.layout.nodeById.has(matchId)).toBe(true);
    }
    expect(new Set(collapsed.orderedMatchIds)).toEqual(
      new Set([cluster!.clusterNodeId, 16]),
    );

    const expanded = derivePanelViewModel(
      snapshot,
      {
        ...DEFAULT_FILTER_STATE,
        query: "kind:computed",
        queryMode: "highlight",
        expandedMemoOwnerIds: new Set([1]),
      },
      null,
    );

    expect(expanded.layout.clusters?.[0]?.expanded).toBe(true);
    expect(expanded.layout.nodeById.has(cluster!.clusterNodeId)).toBe(false);
    expect(expanded.orderedMatchIds.length).toBe(5);
    expect(new Set(expanded.orderedMatchIds)).toEqual(
      new Set([11, 12, 13, 15, 16]),
    );
    for (const matchId of expanded.orderedMatchIds) {
      expect(expanded.layout.nodeById.has(matchId)).toBe(true);
    }
  });
});
