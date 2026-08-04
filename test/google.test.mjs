import { test } from "node:test";
import assert from "node:assert/strict";

import { buildScavioTools } from "../dist/index.js";

function googleSearch() {
  const tools = buildScavioTools({ apiKey: "test" });
  return tools.find((t) => t.name === "scavio_google_search");
}

// /api/v1/google was retired 2026-08-04 and returns 410. Google params are now
// declared natively as v2 rather than mapped from the v1 vocabulary: `start` is
// a 0-based result offset, not a 1-based page, so a silent remap of `page`
// would have fetched the wrong page.
test("google search exposes v2 params natively", () => {
  const props = Object.keys(googleSearch().parameters.properties);
  for (const p of ["query", "gl", "hl", "start"]) {
    assert.ok(props.includes(p), `missing v2 param ${p}`);
  }
});

test("the v1 vocabulary is gone, not mapped", () => {
  const props = Object.keys(googleSearch().parameters.properties);
  for (const dead of ["country_code", "language", "page", "search_type", "light_request"]) {
    assert.ok(!props.includes(dead), `v1 param ${dead} still present`);
  }
});

test("start is documented as an offset", () => {
  const d = googleSearch().parameters.properties.start.description;
  assert.match(d, /offset/i);
});
