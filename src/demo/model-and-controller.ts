import memoizeOne from "memoize-one";

export interface TelemetryData {
  readonly altitudeFt: number;
  readonly airspeedKt: number;
  readonly headingDeg: number;
  readonly muted: boolean;
  readonly unit: "ft" | "m";
  readonly statusMessage: string;
}

export interface CockpitViewModel {
  readonly altitudeDisplay: string;
  readonly airspeedDisplay: string;
  readonly headingDeg: number;
  readonly muted: boolean;
  readonly warningActive: boolean;
  readonly statusMessage: string;
}

export class FlightModelManager extends EventTarget {
  private _modelData: TelemetryData = {
    altitudeFt: 12000,
    airspeedKt: 185,
    headingDeg: 270,
    muted: false,
    unit: "ft",
    statusMessage: "Nominal cruise",
  };

  get model(): TelemetryData {
    return this._modelData;
  }

  update(patch: Partial<TelemetryData>): void {
    this._modelData = { ...this._modelData, ...patch };
    this.dispatchEvent(
      new CustomEvent("model-update", { detail: { model: this._modelData } }),
    );
  }
}

export class CockpitController extends EventTarget {
  readonly modelManager: FlightModelManager;
  view: (HTMLElement & { viewModel?: CockpitViewModel }) | null = null;
  viewModel: CockpitViewModel;
  onStatusSync?: (msg: string) => void;

  _computeAltitudeDisplay = memoizeOne(
    (altitudeFt: number, unit: "ft" | "m"): string => {
      if (unit === "m") {
        return `${Math.round(altitudeFt * 0.3048)} m`;
      }
      return `${altitudeFt} ft`;
    },
  );

  _computeWarningActive = memoizeOne(
    (altitudeFt: number, airspeedKt: number): boolean =>
      altitudeFt < 5000 || airspeedKt < 110,
  );

  _observeAlertState = memoizeOne(
    (warningActive: boolean, statusMessage: string): void => {
      const line = warningActive
        ? `ALERT: ${statusMessage}`
        : `OK: ${statusMessage}`;
      this.onStatusSync?.(line);
    },
  );

  constructor(modelManager: FlightModelManager) {
    super();
    this.modelManager = modelManager;
    this.viewModel = this._transform(modelManager.model);
    this.modelManager.addEventListener("model-update", () => {
      this.syncFromModel();
    });
  }

  attachView(view: HTMLElement & { viewModel?: CockpitViewModel }): void {
    this.view = view;
    this.view.viewModel = this.viewModel;
    view.addEventListener("telemetry-unit-toggle", () => {
      const nextUnit = this.modelManager.model.unit === "ft" ? "m" : "ft";
      this.modelManager.update({ unit: nextUnit });
    });
    view.addEventListener("heading-nudge", (evt: Event) => {
      const detail: unknown = evt instanceof CustomEvent ? evt.detail : null;
      const delta =
        detail !== null &&
        typeof detail === "object" &&
        typeof Reflect.get(detail, "delta") === "number"
          ? Number(Reflect.get(detail, "delta"))
          : 15;
      const nextHdg = (this.modelManager.model.headingDeg + delta + 360) % 360;
      this.modelManager.update({ headingDeg: nextHdg });
    });
    view.addEventListener("mute-toggle", () => {
      this.modelManager.update({ muted: !this.modelManager.model.muted });
    });
  }

  syncFromModel(): void {
    this.viewModel = this._transform(this.modelManager.model);
    if (this.view) {
      this.view.viewModel = this.viewModel;
    }
    this.dispatchEvent(
      new CustomEvent("view-model-update", {
        detail: { model: this.modelManager.model, viewModel: this.viewModel },
      }),
    );
  }

  private _transform(model: TelemetryData): CockpitViewModel {
    const altitudeDisplay = this._computeAltitudeDisplay(
      model.altitudeFt,
      model.unit,
    );
    const warningActive = this._computeWarningActive(
      model.altitudeFt,
      model.airspeedKt,
    );
    this._observeAlertState(warningActive, model.statusMessage);
    return {
      altitudeDisplay,
      airspeedDisplay: `${model.airspeedKt} kt`,
      headingDeg: model.headingDeg,
      muted: model.muted,
      warningActive,
      statusMessage: model.statusMessage,
    };
  }
}
