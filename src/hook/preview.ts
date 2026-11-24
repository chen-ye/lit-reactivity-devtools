import type { ValuePreview } from "../protocol/types.ts";
import {
  formatErrorMessage,
  serializePreview as serializeSharedPreview,
  truncateText,
  type PreviewOptions,
} from "../shared/preview.ts";

function formatLitTemplateResult(obj: object): string | null {
  const litType: unknown = Reflect.get(obj, "_$litType$");
  const litStrings: unknown = Reflect.get(obj, "strings");
  if (
    (litType === 1 || litType === 2 || litType === 3) &&
    Array.isArray(litStrings)
  ) {
    const tag = litType === 2 ? "svg" : litType === 3 ? "mathml" : "html";
    const firstChunk =
      typeof litStrings[0] === "string"
        ? litStrings[0].replace(/\s+/g, " ").trim()
        : "";
    const snippet = firstChunk ? truncateText(firstChunk, 26).text : "…";
    return `${tag}\`${snippet}\``;
  }
  return null;
}

const LIT_PREVIEW_OPTIONS: PreviewOptions = {
  customFormat: formatLitTemplateResult,
};

export function serializePreview(value: unknown): ValuePreview {
  return serializeSharedPreview(value, LIT_PREVIEW_OPTIONS);
}

export { formatErrorMessage };
