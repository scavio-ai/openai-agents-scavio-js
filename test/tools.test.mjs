import { test } from "node:test";
import assert from "node:assert/strict";

import { buildScavioTools } from "../dist/index.js";

const byName = () => new Map(buildScavioTools({ apiKey: "test", all: true }).map((t) => [t.name, t]));

test("reddit search exposes query and cursor only", () => {
  const search = byName().get("scavio_reddit_search");
  assert.ok(search);
  // The API reads query and cursor only; type/sort were stripped on the wire.
  assert.deepEqual(Object.keys(search.parameters.properties), ["query", "cursor"]);
});

test("youtube metadata is not a tool of its own", () => {
  const tools = byName();
  assert.ok(tools.has("scavio_youtube_video"));
  assert.ok(!tools.has("scavio_youtube_metadata"));
});

test("reddit flag gates the reddit tools", () => {
  const tools = buildScavioTools({
    apiKey: "test",
    enableGoogle: false,
    enableAmazon: false,
    enableWalmart: false,
    enableYoutube: false,
    enableReddit: true,
    enableTiktok: false,
    enableInstagram: false,
    enableX: false,
    enableLinkedin: false,
    enableTiktokShop: false,
  });
  const names = tools.map((t) => t.name).sort();
  assert.ok(names.length > 0);
  assert.ok(names.every((n) => n.startsWith("scavio_reddit_")), names.join(","));
  for (const required of ["scavio_reddit_search", "scavio_reddit_post", "scavio_reddit_trending"]) {
    assert.ok(names.includes(required), `missing ${required}`);
  }
});
