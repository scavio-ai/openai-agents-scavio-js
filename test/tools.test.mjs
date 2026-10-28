import { test } from "node:test";
import assert from "node:assert/strict";

import { buildScavioTools } from "../dist/index.js";

const TOTAL_TOOLS = 201;

// Tool counts per enable* flag. The list doubles as the flag inventory: if a
// platform ships without an entry here, allOff() leaves it enabled and
// test_no_platform_escapes_its_flag fails.
const PLATFORM_COUNTS = {
  enableGoogle: 14,
  enableAmazon: 3,
  enableWalmart: 7,
  enableYoutube: 15,
  enableReddit: 12,
  enableTiktok: 11,
  enableTiktokShop: 8,
  enableInstagram: 12,
  enableX: 11,
  enableLinkedin: 9,
  enableThreads: 6,
  enableKuaishou: 14,
  enableEbay: 3,
  enableTarget: 5,
  enableHomeDepot: 3,
  enableZillow: 3,
  enableBooking: 3,
  enableTripadvisor: 4,
  enableIndeed: 4,
  enableAirbnb: 3,
  enableGlassdoor: 4,
  enableYelp: 3,
  enableAppStore: 3,
  enableGooglePlay: 3,
  enableSec: 6,
  enableRedfin: 3,
  enableCompaniesHouse: 4,
  enableG2: 3,
  enableCapterra: 3,
  enableGoogleAds: 3,
  enableMetaAds: 3,
  enableHeb: 3,
  enableKroger: 2,
  enableDecathlon: 2,
  enableExtract: 1,
  enableCrawl: 5,
};

const allOff = () =>
  Object.fromEntries(Object.keys(PLATFORM_COUNTS).map((f) => [f, false]));

const only = (flag) =>
  buildScavioTools({ apiKey: "test", ...allOff(), [flag]: true });

const byName = () =>
  new Map(buildScavioTools({ apiKey: "test", all: true }).map((t) => [t.name, t]));

const props = (t) => t.parameters.properties ?? t.parameters.shape ?? {};

/** Values a zod-derived JSON schema property allows, optional or not. */
function enumOf(prop) {
  if (prop.enum) return prop.enum;
  for (const branch of prop.anyOf ?? []) if (branch.enum) return branch.enum;
  return null;
}

/** Invoke a tool against a stubbed fetch and return { url, body }. */
async function capture(tool, args) {
  const real = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), body: JSON.parse(init.body ?? "{}") };
    return new Response(JSON.stringify({ data: {}, credits_used: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await tool.invoke({}, JSON.stringify(args));
  } finally {
    globalThis.fetch = real;
  }
  return seen;
}

test("every tool registers exactly once", () => {
  const tools = buildScavioTools({ apiKey: "test", all: true });
  const names = tools.map((t) => t.name);
  assert.equal(names.length, TOTAL_TOOLS);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every((n) => n.startsWith("scavio_")));
});

test("no platform escapes its flag", () => {
  // Turning every declared flag off must leave nothing behind. A new platform
  // wired without a flag - or with a flag missing from PLATFORM_COUNTS - shows
  // up here as a stray tool rather than as a surprise in someone's agent.
  assert.deepEqual(buildScavioTools({ apiKey: "test", ...allOff() }), []);
  assert.equal(
    Object.values(PLATFORM_COUNTS).reduce((a, b) => a + b, 0),
    TOTAL_TOOLS,
  );
});

test("each flag registers its own tools only", () => {
  for (const [flag, count] of Object.entries(PLATFORM_COUNTS)) {
    assert.equal(only(flag).length, count, flag);
  }
});

test("youtube metadata is not a tool of its own", () => {
  const tools = byName();
  assert.ok(tools.has("scavio_youtube_video"));
  assert.ok(!tools.has("scavio_youtube_metadata"));
});

test("the retired LinkedIn endpoints are not tools", () => {
  const tools = byName();
  for (const dead of [
    "scavio_linkedin_person_contact",
    "scavio_linkedin_company_people",
    "scavio_linkedin_company_jobs",
    "scavio_linkedin_search_people",
    "scavio_linkedin_search_posts",
  ]) {
    assert.ok(!tools.has(dead), dead);
  }
});

test("reddit search exposes query and cursor only", () => {
  const search = byName().get("scavio_reddit_search");
  assert.ok(search);
  // The API reads query and cursor only; type/sort were stripped on the wire.
  assert.deepEqual(Object.keys(props(search)), ["query", "cursor"]);
});

test("heb search and product take store_id", () => {
  const tools = byName();
  assert.deepEqual(Object.keys(props(tools.get("scavio_heb_search"))), ["query", "page", "page_size", "store_id"]);
  assert.deepEqual(Object.keys(props(tools.get("scavio_heb_product"))), ["product_url", "product_id", "slug", "store_id"]);
});

test("reddit flag gates the reddit tools", () => {
  const names = only("enableReddit").map((t) => t.name).sort();
  assert.equal(names.length, 12);
  assert.ok(names.every((n) => n.startsWith("scavio_reddit_")), names.join(","));
  for (const required of ["scavio_reddit_search", "scavio_reddit_post", "scavio_reddit_trending"]) {
    assert.ok(names.includes(required), `missing ${required}`);
  }
});

test("walmart ships all seven endpoints without the retired params", () => {
  const names = only("enableWalmart").map((t) => t.name).sort();
  assert.deepEqual(names, [
    "scavio_walmart_category",
    "scavio_walmart_offers",
    "scavio_walmart_product",
    "scavio_walmart_reviews",
    "scavio_walmart_search",
    "scavio_walmart_seller",
    "scavio_walmart_seller_products",
  ]);
  const tools = byName();
  const search = props(tools.get("scavio_walmart_search"));
  // device / delivery_zip / store_id were retired. The API answers 200 with a
  // warnings[] array instead of failing, so a stale schema fails silently.
  for (const dead of ["device", "delivery_zip", "store_id", "start_page"]) {
    assert.ok(!(dead in search), dead);
  }
  // domain was NOT retired - it is the price-bearing param.
  assert.deepEqual(enumOf(search.domain), ["com", "ca", "com.mx"]);
  assert.ok("page" in search);
  // product is US-only: walmart.ca product pages cannot be fetched at all.
  assert.deepEqual(Object.keys(props(tools.get("scavio_walmart_product"))), ["product_id"]);
  // seller-products is ~40 server-rendered items, so there is no page param.
  assert.ok(!("page" in props(tools.get("scavio_walmart_seller_products"))));
});

test("body-priced surfaces never claim a flat cost", () => {
  const tools = byName();
  for (const name of ["scavio_walmart_search", "scavio_walmart_category"]) {
    const d = tools.get(name).description;
    assert.match(d, /com\.mx/);
    assert.match(d, /2 credit/);
  }
  const threads = tools.get("scavio_threads_profile").description;
  assert.match(threads, /user_id/);
  assert.match(threads, /4/);
  const extract = tools.get("scavio_extract").description;
  assert.match(extract, /ultra/);
  assert.match(extract, /mode/);
});

test("extract is a top-level method on the client", async () => {
  const tools = only("enableExtract");
  assert.deepEqual(tools.map((t) => t.name), ["scavio_extract"]);
  const seen = await capture(tools[0], {
    url: "https://example.com/pricing",
    format: "text",
    mode: "ultra",
  });
  // client.extract({ url }), never client.extract.extract() - the latter would
  // not resolve to /api/v1/extract at all.
  assert.match(seen.url, /\/api\/v1\/extract$/);
  assert.deepEqual(seen.body, {
    url: "https://example.com/pricing",
    format: "text",
    mode: "ultra",
  });
});

test("meta ads posts to the hyphenated path", async () => {
  const tools = new Map(only("enableMetaAds").map((t) => [t.name, t]));
  assert.deepEqual([...tools.keys()].sort(), [
    "scavio_meta_ads_ad",
    "scavio_meta_ads_advertiser",
    "scavio_meta_ads_search",
  ]);
  // The route key is metaads and the namespace is metaAds, but the API serves
  // /api/v1/meta-ads/* - a path derived from either name 404s.
  const seen = await capture(tools.get("scavio_meta_ads_search"), { query: "crm software" });
  assert.match(seen.url, /\/api\/v1\/meta-ads\/search$/);
});

test("walmart seller-products keeps its hyphenated path", async () => {
  const tools = new Map(byName());
  const seen = await capture(tools.get("scavio_walmart_seller_products"), {
    seller_id: "101040442",
  });
  assert.match(seen.url, /\/api\/v1\/walmart\/seller-products$/);
});

test("enum params carry their allowed values into the schema", () => {
  const extract = props(byName().get("scavio_extract"));
  assert.deepEqual(enumOf(extract.mode), ["normal", "advanced", "ultra"]);
  assert.deepEqual(enumOf(extract.format), ["html", "markdown", "text"]);
});

test("lookup-first platforms ship their resolver", () => {
  const tools = byName();
  for (const resolver of [
    "scavio_sec_lookup",
    "scavio_tripadvisor_locations",
    "scavio_glassdoor_companies",
    "scavio_google_ads_advertisers",
    "scavio_companies_house_search",
  ]) {
    assert.ok(tools.has(resolver), resolver);
  }
});

test("crawl tools are opt-in: the default build has none of them", () => {
  const names = buildScavioTools({ apiKey: "test" }).map((t) => t.name);
  assert.equal(names.length, TOTAL_TOOLS - 5);
  assert.ok(!names.some((n) => /map_website|crawl|batch_/.test(n)));
});
