/** Pure helpers shared by the browser UI and dependency-free Node tests. */

export function parseToolResult(value) {
  if (value !== null && typeof value === "object") {
    return { structured: true, value };
  }
  if (typeof value !== "string") {
    return { structured: true, value };
  }
  try {
    let parsed = JSON.parse(value);
    if (typeof parsed === "string" && /^[\s]*[\[{]/.test(parsed)) {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        // A valid JSON string is still a structured primitive result.
      }
    }
    return { structured: true, value: parsed };
  } catch {
    return { structured: false, value };
  }
}

export function valueSummary(value) {
  if (Array.isArray(value)) {
    return `Array · ${value.length} ${value.length === 1 ? "item" : "items"}`;
  }
  if (value && typeof value === "object") {
    const count = Object.keys(value).length;
    return `Object · ${count} ${count === 1 ? "field" : "fields"}`;
  }
  if (value === null) return "Null result";
  return `${typeof value} result`;
}

export function humanizeKey(key) {
  return String(key)
    .replaceAll("_", " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (character) => character.toUpperCase());
}
