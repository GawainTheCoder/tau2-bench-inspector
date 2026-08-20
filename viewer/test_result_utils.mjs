import assert from "node:assert/strict";
import test from "node:test";

import {
  humanizeKey,
  parseToolResult,
  valueSummary,
} from "./static/result_utils.mjs";

test("parses the JSON-encoded tool result shown by the viewer", () => {
  const parsed = parseToolResult(
    '{"user_id":"raj_sanchez_7340","name":{"first_name":"Raj"},"reservations":["Q69X3R"]}',
  );
  assert.equal(parsed.structured, true);
  assert.equal(parsed.value.name.first_name, "Raj");
  assert.deepEqual(parsed.value.reservations, ["Q69X3R"]);
});

test("preserves message fields and parses one double-encoded JSON layer", () => {
  const original = { message: "visible", sibling: "must remain" };
  const parsed = parseToolResult(JSON.stringify(JSON.stringify(original)));
  assert.deepEqual(parsed.value, original);
});

test("keeps non-JSON text as plain output", () => {
  assert.deepEqual(parseToolResult("Transfer successful"), {
    structured: false,
    value: "Transfer successful",
  });
});

test("preserves JSON primitives including false, zero, and null", () => {
  assert.deepEqual(parseToolResult("false"), { structured: true, value: false });
  assert.deepEqual(parseToolResult("0"), { structured: true, value: 0 });
  assert.deepEqual(parseToolResult("null"), { structured: true, value: null });
});

test("does not execute or rewrite hostile-looking strings", () => {
  const payload = '<img src=x onerror="globalThis.pwned=true">';
  const parsed = parseToolResult(JSON.stringify({ payload }));
  assert.equal(parsed.value.payload, payload);
  assert.equal(globalThis.pwned, undefined);
});

test("labels values and humanizes keys", () => {
  assert.equal(valueSummary({ one: 1, two: 2 }), "Object · 2 fields");
  assert.equal(valueSummary([1]), "Array · 1 item");
  assert.equal(valueSummary(null), "Null result");
  assert.equal(humanizeKey("payment_methods"), "Payment methods");
  assert.equal(humanizeKey("userID"), "User ID");
});
