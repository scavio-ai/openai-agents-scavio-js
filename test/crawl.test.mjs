import { test } from "node:test";
import assert from "node:assert/strict";

import { buildScavioTools } from "../dist/index.js";

const JOB = "crawl_01a12d21-fb42-7000-88cf-6887f653ee5d";

const crawlTools = (extra = {}) =>
  new Map(
    buildScavioTools({ apiKey: "test", all: false, ...offAll(), enableCrawl: true, pollIntervalMs: 5, ...extra })
      .map((t) => [t.name, t]),
  );

function offAll() {
  const flags = [
    "Google", "Amazon", "Walmart", "Youtube", "Reddit", "Tiktok", "TiktokShop", "Instagram", "X",
    "Linkedin", "Threads", "Kuaishou", "Ebay", "Target", "HomeDepot", "Zillow", "Booking",
    "Tripadvisor", "Indeed", "Airbnb", "Glassdoor", "Yelp", "AppStore", "GooglePlay", "Sec",
    "Redfin", "CompaniesHouse", "G2", "Capterra", "GoogleAds", "MetaAds", "Heb", "Kroger", "Decathlon", "Extract",
  ];
  return Object.fromEntries(flags.map((f) => ["enable" + f, false]));
}

/** Stub fetch with a queue of [status, body] answers; record every request. */
async function withFetch(answers, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
    const [status, body] = answers.length > 1 ? answers.shift() : answers[0];
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  try {
    const out = await fn();
    return { out, calls };
  } finally {
    globalThis.fetch = real;
  }
}

const created = (id = JOB, type = "crawl") => [202, { data: { id, type, status: "queued" }, credits_used: 0 }];
const status = (s, id = JOB) => [200, { data: { id, status: s, results: [{ url: "https://hono.dev/docs" }], next_cursor: null } }];

const invoke = async (tool, args) => {
  const out = await tool.invoke({}, JSON.stringify(args));
  return typeof out === "string" ? JSON.parse(out) : out;
};

test("the crawl flag registers exactly the five website tools", () => {
  assert.deepEqual([...crawlTools().keys()], [
    "scavio_map_website",
    "scavio_crawl_website",
    "scavio_crawl_status",
    "scavio_batch_extract",
    "scavio_batch_status",
  ]);
});

test("map posts its body to /extract/map", async () => {
  const { calls } = await withFetch([[200, { data: { links: [] } }]], () =>
    invoke(crawlTools().get("scavio_map_website"), { url: "scavio.dev", limit: 5, include_paths: ["/blog/**"] }),
  );
  assert.match(calls[0].url, /\/api\/v1\/extract\/map$/);
  assert.deepEqual(calls[0].body, { url: "scavio.dev", limit: 5, include_paths: ["/blog/**"] });
});

test("crawl with wait_seconds 0 returns the 202 without polling", async () => {
  const { out, calls } = await withFetch([created()], () =>
    invoke(crawlTools().get("scavio_crawl_website"), { url: "https://hono.dev/docs", wait_seconds: 0 }),
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { url: "https://hono.dev/docs" });
  assert.equal(out.data.id, JOB);
});

test("crawl waits until completed, then reads the caller's results page", async () => {
  const { out, calls } = await withFetch(
    [created(), status("running"), status("completed"), status("completed")],
    () => invoke(crawlTools().get("scavio_crawl_website"), { url: "https://hono.dev/docs", max_pages: 3, limit: 7 }),
  );
  assert.equal(out.data.status, "completed");
  assert.deepEqual(calls[0].body, { url: "https://hono.dev/docs", max_pages: 3 });
  assert.match(calls[1].url, new RegExp(`/api/v1/extract/crawl/${JOB}\\?`));
  assert.match(calls[1].url, /include_content=false/);
  assert.match(calls[1].url, /limit=1(&|$)/);
  assert.equal(calls.length, 4);
  assert.match(calls[3].url, /limit=7/);
  assert.doesNotMatch(calls[3].url, /include_content/);
});

test("crawl still running when the wait ends returns its id", async () => {
  const started = Date.now();
  const { out } = await withFetch([created(), status("running")], () =>
    invoke(crawlTools().get("scavio_crawl_website"), { url: "https://hono.dev/docs", wait_seconds: 1 }),
  );
  assert.equal(out.data.status, "running");
  assert.equal(out.data.id, JOB);
  assert.ok(Date.now() - started < 5000);
});

test("crawl status passes cursor, booleans and the default limit", async () => {
  const { calls } = await withFetch([status("completed")], () =>
    invoke(crawlTools().get("scavio_crawl_status"), { id: JOB, cursor: "25", include_content: false }),
  );
  assert.equal(calls[0].method, "GET");
  for (const part of ["cursor=25", "include_content=false", "limit=10"]) assert.ok(calls[0].url.includes(part), part);
});

test("batch posts urls and reads the batch job", async () => {
  const id = "batch_1";
  const { out, calls } = await withFetch([created(id, "batch"), status("completed", id), status("completed", id)], () =>
    invoke(crawlTools().get("scavio_batch_extract"), { urls: ["https://example.com/"], mode: "normal" }),
  );
  assert.match(calls[0].url, /\/api\/v1\/extract\/batch$/);
  assert.deepEqual(calls[0].body, { urls: ["https://example.com/"], mode: "normal" });
  assert.match(calls[1].url, /\/api\/v1\/extract\/batch\/batch_1\?/);
  assert.equal(out.data.id, id);
});

test("batch status reads the batch path", async () => {
  const { calls } = await withFetch([status("running", "batch_1")], () =>
    invoke(crawlTools().get("scavio_batch_status"), { id: "batch_1" }),
  );
  assert.match(calls[0].url, /\/api\/v1\/extract\/batch\/batch_1\?limit=10$/);
});

test("descriptions state the price and never the fetch method", () => {
  for (const t of crawlTools().values()) {
    const text = (t.description + JSON.stringify(t.parameters)).toLowerCase();
    assert.match(text, /credit/, t.name);
    for (const word of ["proxy", "residential", "datacenter", "headless", "browser"]) {
      assert.ok(!text.includes(word), `${t.name}: ${word}`);
    }
  }
});
