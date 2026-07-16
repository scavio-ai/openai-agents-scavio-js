import { test } from "node:test";
import assert from "node:assert/strict";

import { googleV2Params } from "../dist/index.js";

test("maps v1 params to v2 (gl/hl/start)", () => {
  assert.deepEqual(
    googleV2Params({
      query: "ai agents",
      country_code: "us",
      language: "en",
      page: 3,
      device: "mobile",
      nfpr: true,
    }),
    { query: "ai agents", gl: "us", hl: "en", start: 20, device: "mobile", nfpr: true },
  );
});

test("page 1 omits start", () => {
  assert.deepEqual(googleV2Params({ query: "x", page: 1 }), { query: "x" });
});

test("no page omits start", () => {
  assert.deepEqual(googleV2Params({ query: "x" }), { query: "x" });
});

test("v2-native params pass through unchanged", () => {
  assert.deepEqual(
    googleV2Params({ query: "x", device: "desktop", nfpr: false }),
    { query: "x", device: "desktop", nfpr: false },
  );
});
