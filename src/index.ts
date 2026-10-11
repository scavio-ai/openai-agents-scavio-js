/**
 * Scavio tools for the OpenAI Agents SDK.
 *
 * Exposes the whole Scavio API across 31 platforms - Google, YouTube, Amazon,
 * Walmart, Reddit, TikTok, TikTok Shop, Instagram, X, LinkedIn, Threads, Kuaishou,
 * eBay, Target, Home Depot, Zillow, Redfin, Booking.com, Airbnb, Tripadvisor, Yelp,
 * Indeed, Glassdoor, App Store, Google Play, SEC EDGAR, Companies House, G2,
 * Capterra, Google Ads Transparency and the Meta Ad Library - plus the top-level
 * `extract` endpoint that reads any URL as HTML, Markdown or plain text.
 *
 * 193 tools over the Scavio SDK's endpoints. The seven that are not
 * registered are dead or duplicate surfaces: /youtube/metadata (a deprecated alias
 * of /youtube/video), /amazon/options (a keyless static marketplace list, not a
 * search), and the five LinkedIn endpoints the upstream provider withdrew, which
 * always return HTTP 410. Build the tools with `buildScavioTools()` and pass them
 * to an Agent:
 *
 *   import { Agent, run } from "@openai/agents";
 *   import { buildScavioTools } from "openai-agents-scavio";
 *
 *   const agent = new Agent({
 *     name: "Search Assistant",
 *     tools: buildScavioTools({ apiKey: process.env.SCAVIO_API_KEY }),
 *   });
 *   const result = await run(agent, "Find the top budget laptops on Amazon");
 *
 * Each provider is gated by an `enable*` flag so an agent only sees the tools it needs.
 */
import { tool as agentTool } from "@openai/agents";
import { Scavio } from "scavio";
import { z } from "zod";

export interface BuildScavioToolsOptions {
  /** Scavio API key. Falls back to the SCAVIO_API_KEY env var. */
  apiKey?: string;
  enableGoogle?: boolean;
  enableAmazon?: boolean;
  enableWalmart?: boolean;
  enableYoutube?: boolean;
  enableReddit?: boolean;
  enableTiktok?: boolean;
  enableTiktokShop?: boolean;
  enableInstagram?: boolean;
  enableX?: boolean;
  enableLinkedin?: boolean;
  enableThreads?: boolean;
  enableKuaishou?: boolean;
  enableEbay?: boolean;
  enableTarget?: boolean;
  enableHomeDepot?: boolean;
  enableZillow?: boolean;
  enableBooking?: boolean;
  enableTripadvisor?: boolean;
  enableIndeed?: boolean;
  enableAirbnb?: boolean;
  enableGlassdoor?: boolean;
  enableYelp?: boolean;
  enableAppStore?: boolean;
  enableGooglePlay?: boolean;
  enableSec?: boolean;
  enableRedfin?: boolean;
  enableCompaniesHouse?: boolean;
  enableG2?: boolean;
  enableCapterra?: boolean;
  enableGoogleAds?: boolean;
  enableMetaAds?: boolean;
  enableExtract?: boolean;
  /**
   * Website map, crawl and batch extract (five tools: scavio_map_website,
   * scavio_crawl_website, scavio_crawl_status, scavio_batch_extract,
   * scavio_batch_status). Off by default: a crawl bills per page.
   */
  enableCrawl?: boolean;
  /**
   * Milliseconds between progress polls while scavio_crawl_website or
   * scavio_batch_extract waits for its job. Default 3000.
   */
  pollIntervalMs?: number;
  /** Register every tool, ignoring the individual flags. */
  all?: boolean;
}

/**
 * The options object an SDK namespace method accepts, pulled straight off the
 * method type. Annotating each tool's `execute` input with it is what makes a
 * zod schema that has drifted from the SDK - a renamed field, a number where a
 * string belongs - a compile error here rather than a 400 at runtime.
 */
type SdkOpts<F> = F extends (options: infer O) => unknown ? O : never;

const str = (d: string) => z.string().describe(d);
const ostr = (d: string) => z.string().optional().describe(d);
const onum = (d: string) => z.number().optional().describe(d);
const obool = (d: string) => z.boolean().optional().describe(d);

// Google locale params, identical across most Google endpoints.
const HL = ostr("UI language (ISO 639-1), e.g. 'en'.");
const GL = ostr("Country of the search (ISO 3166-1 alpha-2), e.g. 'us'.");
const GOOGLE_DOMAIN = ostr("Regional Google domain, e.g. 'google.co.uk'.");
const LOCATION = ostr("Canonical location name; auto-encoded to a UULE string.");
const UULE = ostr("Pre-encoded UULE location string (takes priority over location).");

// ---------------------------------------------------------------------------
// Website map, crawl and batch: the multi-page members of the Extract family.
//
// Map answers in one call. Crawl and batch are background jobs: the start tools
// post the job, then wait up to wait_seconds (default 45, max 300) for it to
// finish, polling progress without page content, and return the job's status
// with its first page of results either way. A job still running when the wait
// ends keeps going server-side; read the rest with the matching status tool.
// ---------------------------------------------------------------------------

const JOB_POLL_INTERVAL_MS = 3_000;
const JOB_WAIT_DEFAULT_SECONDS = 45;
const JOB_WAIT_MAX_SECONDS = 300;
const JOB_RESULTS_DEFAULT_LIMIT = 10;
const JOB_TERMINAL = new Set(["completed", "failed", "cancelled"]);

type JobQuery = {
  cursor?: string;
  limit?: number;
  status?: "succeeded" | "failed" | "skipped";
  include_content?: boolean;
};
type JobPayload = { data?: { id?: string; status?: string } } & Record<string, unknown>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll a job (content-free) until it finishes or the wait runs out, then read one results page. */
async function waitForJob(
  status: (id: string, query: JobQuery) => Promise<unknown>,
  id: string,
  waitSeconds: number,
  pollMs: number,
  query: JobQuery,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + Math.max(0, Math.min(waitSeconds, JOB_WAIT_MAX_SECONDS)) * 1000;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));
    const probe = (await status(id, { limit: 1, include_content: false })) as JobPayload;
    if (JOB_TERMINAL.has(String(probe?.data?.status))) break;
  }
  return (await status(id, query)) as Record<string, unknown>;
}

/** Split the tool-only fields (wait_seconds, limit, include_content) off a start-tool input. */
function splitJobInput<T extends { wait_seconds?: number; limit?: number; include_content?: boolean }>(input: T) {
  const { wait_seconds, limit, include_content, ...body } = input;
  const query: JobQuery = { limit: limit ?? JOB_RESULTS_DEFAULT_LIMIT };
  if (include_content !== undefined) query.include_content = include_content;
  return { body, query, wait: wait_seconds ?? JOB_WAIT_DEFAULT_SECONDS };
}

const MODE_DESCRIPTION =
  "Fetch tier, and the price-bearing parameter: 'normal' is the standard fetch, 'advanced' renders JavaScript-built pages, 'ultra' reaches the hardest pages. Server default 'normal'.";
const PATHS_DESCRIPTION =
  "Path globs (max 20). '*' matches within one path segment, '**' across segments; a pattern without wildcards matches that path and everything under it. Example: ['/blog/**'].";
const JOB_PRICE =
  "Billed per SUCCESSFUL page at Extract's price for the mode: normal and advanced 1 credit, ultra 2 credits. Failed and skipped pages are free, and if the balance runs out the job stops cleanly.";

const jobWait = z
  .number()
  .int()
  .min(0)
  .max(JOB_WAIT_MAX_SECONDS)
  .optional()
  .describe("Seconds to wait for the job to finish before returning, 0-300 (default 45). 0 returns the job id at once. A job still running when the wait ends keeps going; read it later with its status tool.");
const jobLimit = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe("Results per response, 1-100 (default 10, to keep page content inside the context window); page on with next_cursor.");
const jobIncludeContent = obool("Set false to list results without their page content (default true).");
const jobFormat = z.enum(["html", "markdown", "text"]).optional().describe("Format for each page, as on Extract: html, markdown or text (default markdown).");
const jobMode = z.enum(["normal", "advanced", "ultra"]).optional().describe(MODE_DESCRIPTION);
const jobStatusParams = z.object({
  id: str("Job id returned when the job was started (data.id)."),
  cursor: ostr("next_cursor from the previous response, to read the next page."),
  limit: jobLimit,
  status: z.enum(["succeeded", "failed", "skipped"]).optional().describe("Only results with this status."),
  include_content: jobIncludeContent,
});

const TIKTOK_SHOP_REGION = ostr(
  "Marketplace region: 'US' (default), 'GB', 'SG', 'MY', 'PH', 'TH', 'VN', 'ID'.",
);

/**
 * Build Scavio tools for an OpenAI Agents SDK Agent.
 *
 * Scavio is a single Search API over Google, YouTube, Amazon, Walmart, Reddit,
 * TikTok, TikTok Shop, Instagram, X and LinkedIn, and this package ships a tool for
 * every live endpoint. Returns an array of tools to pass to `new Agent({ tools })`.
 * Each tool is named `scavio_<provider>_<action>` (e.g. `scavio_google_search`).
 */
export function buildScavioTools(options: BuildScavioToolsOptions = {}) {
  const {
    apiKey,
    enableGoogle = true,
    enableAmazon = true,
    enableWalmart = true,
    enableYoutube = true,
    enableReddit = true,
    enableTiktok = true,
    enableTiktokShop = true,
    enableInstagram = true,
    enableX = true,
    enableLinkedin = true,
    enableThreads = true,
    enableKuaishou = true,
    enableEbay = true,
    enableTarget = true,
    enableHomeDepot = true,
    enableZillow = true,
    enableBooking = true,
    enableTripadvisor = true,
    enableIndeed = true,
    enableAirbnb = true,
    enableGlassdoor = true,
    enableYelp = true,
    enableAppStore = true,
    enableGooglePlay = true,
    enableSec = true,
    enableRedfin = true,
    enableCompaniesHouse = true,
    enableG2 = true,
    enableCapterra = true,
    enableGoogleAds = true,
    enableMetaAds = true,
    enableExtract = true,
    enableCrawl = false,
    pollIntervalMs = JOB_POLL_INTERVAL_MS,
    all = false,
  } = options;

  const client = new Scavio({ apiKey: apiKey ?? process.env.SCAVIO_API_KEY });

  function tool<P extends z.ZodObject<any>>(
    slug: string,
    _name: string,
    description: string,
    parameters: P,
    call: (input: z.infer<P>) => Promise<Record<string, unknown>>
  ) {
    return agentTool({
      name: "scavio_" + slug.toLowerCase(),
      description,
      parameters: parameters as z.ZodObject<any>,
      execute: async (input: any) => call(input),
    });
  }

  const tools = [];

  // Google is v2 only: /api/v1/google was sunset on 2026-08-04 and now returns 410.
  // The v1 param spellings (light_request, country_code, language, search_type,
  // page) went with it; v2 takes gl, hl, start, google_domain and device, and every
  // Google tool below uses those names verbatim.
  if (all || enableGoogle) {
    tools.push(
      tool(
        "GOOGLE_SEARCH",
        "Scavio Google Search",
        "Search Google for real-time web results: organic_results (title, link, snippet), ads, and the AI Overview when present. Costs 1 credit.",
        z.object({
          query: str("The search query (1-500 characters)."),
          device: z.enum(["desktop", "mobile"]).optional().describe("Device to emulate: 'desktop' or 'mobile'."),
          start: onum("Result offset: 0 = page 1, 10 = page 2, up to 990."),
          hl: HL,
          gl: GL,
          google_domain: GOOGLE_DOMAIN,
          location: LOCATION,
          uule: UULE,
          lr: ostr("Language restrict, e.g. 'lang_en'."),
          cr: ostr("Country restrict, e.g. 'countryUS'."),
          safe: z.enum(["active"]).optional().describe("SafeSearch filter; 'active' is the only value."),
          nfpr: obool("Disable spelling correction / auto-fixes when true."),
          filter: z.enum(["0", "1"]).optional().describe("'0' disables the omitted/similar-results filter, '1' keeps it."),
          time_period: z.enum(["last_hour", "last_day", "last_week", "last_month", "last_year"]).optional().describe("Recent time window: 'last_hour', 'last_day', 'last_week', 'last_month', 'last_year'."),
          resolve_ai_overview: obool("Resolve a deferred AI Overview (server default true)."),
          include_html: obool("Include the raw Google HTML in the response. Large; leave off unless parsing it."),
        }),
        (i: SdkOpts<typeof client.google.search>) => client.google.search(i)
      ),
      tool(
        "GOOGLE_AI_MODE",
        "Scavio Google AI Mode",
        "Get a Google AI Mode conversational answer with its source references, instead of a plain list of links. Costs 1 credit.",
        z.object({
          query: str("Question or prompt (1-500 characters)."),
          device: z.enum(["desktop", "mobile"]).optional().describe("Device to emulate: 'desktop' or 'mobile'."),
          hl: HL,
          gl: GL,
          google_domain: GOOGLE_DOMAIN,
          location: LOCATION,
          uule: UULE,
          safe: z.enum(["active"]).optional().describe("SafeSearch filter; 'active' is the only value."),
          include_html: obool("Include the raw Google HTML in the response."),
        }),
        (i: SdkOpts<typeof client.google.aiMode>) => client.google.aiMode(i)
      ),
      tool(
        "GOOGLE_MAPS_SEARCH",
        "Scavio Google Maps Search",
        "Search Google Maps for local businesses. Each result carries name, address, rating, review count, place_id, data_cid and coordinates. Costs 1 credit.",
        z.object({
          query: str("The search query (1-500 characters)."),
          start: onum("Result offset; must be a multiple of 20 (0, 20, 40, ...)."),
          ll: ostr("Map center as '@lat,lng,zoomz'; controls where results come from."),
          hl: HL,
          gl: GL,
          google_domain: GOOGLE_DOMAIN,
        }),
        (i: SdkOpts<typeof client.google.mapsSearch>) => client.google.mapsSearch(i)
      ),
      tool(
        "GOOGLE_MAPS_PLACE",
        "Scavio Google Maps Place",
        "Fetch Google Maps details for one place. Costs 1 credit.",
        z.object({
          place_id: ostr("Place ID (ChIJ...). Provide this or data_cid."),
          data_cid: ostr("Numeric CID. Provide this or place_id."),
        }),
        (i: SdkOpts<typeof client.google.mapsPlace>) => client.google.mapsPlace(i)
      ),
      tool(
        "GOOGLE_MAPS_REVIEWS",
        "Scavio Google Maps Reviews",
        "List Google Maps reviews for a place. Costs 1 credit per page.",
        z.object({
          data_id: ostr("Data ID (0xHEX:0xHEX). Provide this or place_id."),
          place_id: ostr("Place ID (ChIJ...). Provide this or data_id."),
          num: onum("Reviews per page (1-20)."),
          next_page_token: ostr("Pagination cursor from a prior response."),
          sort_by: z.enum(["relevance", "newest", "highest_rating", "lowest_rating"]).optional().describe("Sort order: 'relevance', 'newest', 'highest_rating', 'lowest_rating'."),
          hl: HL,
          gl: GL,
          google_domain: GOOGLE_DOMAIN,
        }),
        (i: SdkOpts<typeof client.google.mapsReviews>) => client.google.mapsReviews(i)
      ),
      tool(
        "GOOGLE_SHOPPING",
        "Scavio Google Shopping",
        "Search Google Shopping product listings across merchants. Costs 1 credit.",
        z.object({
          query: str("Product search query (1-500 characters)."),
          device: z.enum(["desktop", "mobile"]).optional().describe("Device to emulate: 'desktop' or 'mobile'."),
          start: onum("Result offset."),
          min_price: onum("Minimum price filter."),
          max_price: onum("Maximum price filter."),
          sort_by: onum("0 = relevance, 1 = price ascending, 2 = price descending."),
          free_shipping: obool("Only items with free shipping."),
          on_sale: obool("Only items on sale."),
          shoprs: ostr("Opaque Google Shopping filter token."),
          hl: HL,
          gl: GL,
          google_domain: GOOGLE_DOMAIN,
          location: LOCATION,
          uule: UULE,
        }),
        (i: SdkOpts<typeof client.google.shopping>) => client.google.shopping(i)
      ),
      tool(
        "GOOGLE_SHOPPING_PRODUCT",
        "Scavio Google Shopping Product",
        "Fetch a Google Shopping product's detail page and its sellers. Pass catalog_id together with query for full data. Costs 1 credit.",
        z.object({
          catalog_id: ostr("Durable product catalog id."),
          query: ostr("Product query; required when catalog_id is set."),
          immersive_product_page_token: ostr("Immersive product page token."),
          page_token: ostr("Alias for immersive_product_page_token."),
          product_id: ostr("Product id."),
          device: z.enum(["desktop", "mobile", "tablet"]).optional().describe("Device to emulate: 'desktop', 'mobile' or 'tablet'."),
          sort_by: z.enum(["base_price", "total_price", "promotion", "seller_rating"]).optional().describe("Seller sort order: 'base_price', 'total_price', 'promotion', 'seller_rating'."),
          load_all_stores: obool("Load all available stores."),
          more_stores: obool("Fetch additional stores."),
          hl: HL,
          gl: GL,
          google_domain: GOOGLE_DOMAIN,
          location: LOCATION,
          uule: UULE,
        }),
        (i: SdkOpts<typeof client.google.shoppingProduct>) => client.google.shoppingProduct(i)
      ),
      tool(
        "GOOGLE_SHOPPING_STORES",
        "Scavio Google Shopping Stores",
        "Fetch more sellers for a Google Shopping product: the pagination leg of scavio_google_shopping_product. Costs 1 credit.",
        z.object({
          catalog_id: str("Durable product catalog id."),
          next_page_token: str("Pagination cursor returned by scavio_google_shopping_product."),
        }),
        (i: SdkOpts<typeof client.google.shoppingStores>) => client.google.shoppingStores(i)
      ),
      tool(
        "GOOGLE_FLIGHTS",
        "Scavio Google Flights",
        "Search Google Flights for itineraries and prices. Costs 1 credit.",
        z.object({
          departure_id: str("Departure IATA code(s); comma-separated allowed."),
          arrival_id: str("Arrival IATA code(s); comma-separated allowed."),
          outbound_date: str("Outbound date (YYYY-MM-DD)."),
          type: onum("1 = round trip, 2 = one way, 3 = multi-city."),
          return_date: ostr("Return date (YYYY-MM-DD); required when type is 1."),
          adults: onum("Number of adults (1-9)."),
          children: onum("Number of children (0-9)."),
          infants_in_seat: onum("Infants in seat (0-4)."),
          infants_on_lap: onum("Infants on lap (0-4)."),
          travel_class: onum("1 = economy, 2 = premium, 3 = business, 4 = first."),
          stops: onum("0 = any, 1 = nonstop, 2 = one stop or fewer, 3 = two stops or fewer."),
          sort_by: onum("1 = top, 2 = price, 3 = departure, 4 = arrival, 5 = duration, 6 = emissions."),
          include_airlines: ostr("Comma-separated airline codes/alliances to include."),
          exclude_airlines: ostr("Comma-separated airline codes/alliances to exclude."),
          hl: HL,
          gl: GL,
          currency: ostr("Currency code (ISO 4217), e.g. 'USD'."),
        }),
        (i: SdkOpts<typeof client.google.flights>) => client.google.flights(i)
      ),
      tool(
        "GOOGLE_HOTELS",
        "Scavio Google Hotels",
        "Search Google Hotels for properties, nightly rates and availability. Costs 1 credit.",
        z.object({
          query: str("Search query; use a '<City> hotels' form."),
          check_in_date: str("Check-in date (YYYY-MM-DD)."),
          check_out_date: str("Check-out date (YYYY-MM-DD)."),
          hl: HL,
          gl: GL,
          currency: ostr("Currency code (ISO 4217), e.g. 'USD'."),
          sort_by: onum("3 = lowest price, 8 = highest rating, 13 = most reviewed."),
          min_price: onum("Minimum nightly price."),
          max_price: onum("Maximum nightly price."),
          rating: onum("7 = 3.5+, 8 = 4.0+, 9 = 4.5+."),
          hotel_class: ostr("Comma-separated star ratings (2-5)."),
          amenities: ostr("Comma-separated amenity ids."),
          property_types: ostr("Comma-separated property-type ids, e.g. '12' for vacation rentals."),
          free_cancellation: obool("Only properties with free cancellation."),
          eco_certified: obool("Only eco-certified properties."),
          special_offers: obool("Only properties with special offers."),
          next_page_token: ostr("Pagination cursor from a prior response."),
          limit: onum("Number of properties to return (1-20)."),
        }),
        (i: SdkOpts<typeof client.google.hotels>) => client.google.hotels(i)
      ),
      tool(
        "GOOGLE_HOTELS_DETAIL",
        "Scavio Google Hotels Detail",
        "Fetch full details for one Google Hotels property, using a detail_token from a hotels listing. Costs 1 credit.",
        z.object({
          detail_token: str("Property detail token from a scavio_google_hotels result."),
          check_in_date: str("Check-in date (YYYY-MM-DD)."),
          check_out_date: str("Check-out date (YYYY-MM-DD)."),
          currency: ostr("Currency code (ISO 4217), e.g. 'USD'."),
          gl: GL,
          hl: HL,
        }),
        (i: SdkOpts<typeof client.google.hotelsDetail>) => client.google.hotelsDetail(i)
      ),
      tool(
        "GOOGLE_NEWS",
        "Scavio Google News",
        "Fetch Google News results. Provide a query, or a topic/story/publication token from a prior response. Costs 1 credit.",
        z.object({
          query: ostr("Keyword search."),
          topic_token: ostr("Browse a news topic."),
          section_token: ostr("Browse a topic section."),
          story_token: ostr("Fetch full coverage of a story."),
          publication_token: ostr("Browse a publication."),
          kgmid: ostr("Knowledge Graph entity id."),
          hl: HL,
          gl: GL,
          google_domain: GOOGLE_DOMAIN,
          so: onum("Sort order: 0 = relevance, 1 = date. Only honoured with query or kgmid."),
        }),
        (i: SdkOpts<typeof client.google.news>) => client.google.news(i)
      ),
      tool(
        "GOOGLE_TRENDS",
        "Scavio Google Trends",
        "Fetch Google Trends interest data for one or more terms. Costs 1 credit.",
        z.object({
          query: str("Search term(s); comma-separated to compare up to five."),
          geo: ostr("Location code, e.g. 'US', 'GB', 'US-CA'."),
          hl: HL,
          date: ostr("Time range, e.g. 'today 12-m', 'now 7-d'."),
          tz: ostr("Timezone offset in minutes."),
          data_type: z.enum(["TIMESERIES", "GEO_MAP", "GEO_MAP_0", "RELATED_QUERIES", "RELATED_TOPICS"]).optional().describe("Dataset: 'TIMESERIES', 'GEO_MAP', 'GEO_MAP_0', 'RELATED_QUERIES', 'RELATED_TOPICS'."),
          cat: ostr("Category id."),
          gprop: z.enum(["images", "news", "youtube", "froogle"]).optional().describe("Google property filter: 'images', 'news', 'youtube', 'froogle'."),
          region: z.enum(["COUNTRY", "REGION", "DMA", "CITY"]).optional().describe("Resolution for GEO_MAP data: 'COUNTRY', 'REGION', 'DMA', 'CITY'."),
        }),
        (i: SdkOpts<typeof client.google.trends>) => client.google.trends(i)
      ),
      tool(
        "GOOGLE_TRENDING",
        "Scavio Google Trending",
        "List Google Trending Now searches for a country. Costs 1 credit.",
        z.object({
          geo: str("Country code, e.g. 'US'."),
          hl: HL,
          hours: onum("Trending window: 4, 24, 48 or 168."),
          cat: onum("Category id (0-20)."),
          sort: z.enum(["relevance", "search_volume", "recency", "title"]).optional().describe("Sort order: 'relevance', 'search_volume', 'recency', 'title'."),
          status: z.enum(["all", "active"]).optional().describe("Filter by trend status: 'all' or 'active'."),
        }),
        (i: SdkOpts<typeof client.google.trending>) => client.google.trending(i)
      )
    );
  }

  // Amazon moved upstream in 2026-07: sort_by, pages, category_id, merchant_id,
  // language, currency, device, zip_code and autoselect_variant no longer exist.
  // Removed rather than kept as no-ops - sort_by was verified to return the
  // identical unordered set for every value. `domain` still works on the wire
  // as a deprecated alias but is not offered: one spelling per param.
  if (all || enableAmazon) {
    tools.push(
      tool(
        "AMAZON_SEARCH",
        "Scavio Amazon Search",
        "Search Amazon for products matching a query. Results are unsorted and cannot be filtered by category, merchant or price. Costs 1 credit.",
        z.object({
          query: str("The product search query."),
          country: ostr("Marketplace country code (ISO 3166-1 alpha-2), not a domain: 'us' (default), 'gb' (the UK is gb, not uk), 'ca', 'de', 'fr', 'es', 'it', 'jp', 'in', 'au', 'br', 'mx', 'nl', 'pl', 'se', 'sg', 'ae', 'sa', 'eg', 'cn', 'be', 'tr'. An unknown code falls back to us."),
          page: onum("Result page, 1-based. One page per call, 1 credit each."),
        }),
        (i: SdkOpts<typeof client.amazon.search>) => client.amazon.search(i)
      ),
      tool(
        "AMAZON_PRODUCT",
        "Scavio Amazon Product",
        "Fetch full Amazon product details by ASIN. price is the buy-box price only. Costs 1 credit.",
        z.object({
          asin: str("Amazon Standard Identification Number (ASIN) of the product."),
          country: ostr("Marketplace country code (ISO 3166-1 alpha-2), not a domain: 'us' (default), 'gb' (the UK is gb, not uk), 'ca', 'de', 'fr', 'es', 'it', 'jp', 'in', 'au', 'br', 'mx', 'nl', 'pl', 'se', 'sg', 'ae', 'sa', 'eg', 'cn', 'be', 'tr'. An unknown code falls back to us."),
        }),
        (i: SdkOpts<typeof client.amazon.product>) => client.amazon.product(i)
      ),
      tool(
        "AMAZON_OFFERS",
        "Scavio Amazon Offers",
        "List every seller offer for one Amazon ASIN: price, seller, condition, shipping, and which offer holds the buy box. Page 1 only. Costs 1 credit. Use this instead of AMAZON_PRODUCT when comparing sellers or checking who owns the buy box.",
        z.object({
          asin: str("Amazon Standard Identification Number (ASIN) of the product."),
          country: ostr("Marketplace country code (ISO 3166-1 alpha-2), not a domain: 'us' (default), 'gb' (the UK is gb, not uk), 'ca', 'de', 'fr', 'es', 'it', 'jp', 'in', 'au', 'br', 'mx', 'nl', 'pl', 'se', 'sg', 'ae', 'sa', 'eg', 'cn', 'be', 'tr'. An unknown code falls back to us."),
        }),
        (i: SdkOpts<typeof client.amazon.offers>) => client.amazon.offers(i)
      )
    );
  }

  // Walmart is BODY-PRICED: `domain` sets the cost, com and ca at 1 credit and
  // com.mx at 2, and only search and category accept it (walmart.ca product pages
  // cannot be fetched at all). device, delivery_zip and store_id were retired -
  // sending them is not an error, the response just carries a warnings[] array
  // saying they were ignored. offers returns the BUY-BOX seller only, and
  // sellerProducts is the ~40 server-rendered items with no page param at all.
  if (all || enableWalmart) {
    tools.push(
      tool(
        "WALMART_SEARCH",
        "Scavio Walmart Search",
        "Search Walmart and get structured product rows (products, products_count and the store the results were priced against). Costs 1 credit on domain 'com' or 'ca' and 2 credits on 'com.mx'.",
        z.object({
          query: str("Product search query (1-500 characters)."),
          domain: z.enum(["com", "ca", "com.mx"]).optional().describe("Marketplace: 'com' (US, default, 1 credit), 'ca' (1 credit), 'com.mx' (2 credits). Sets the currency and product URLs of the response."),
          page: onum("Results page, 1-based (integer >= 1). One page per call."),
          sort_by: z.enum(["best_match", "price_low", "price_high", "best_seller", "rating_high", "new"]).optional().describe("Result sort order. Defaults to 'best_match'. One of: best_match, price_low, price_high, best_seller, rating_high, new."),
          min_price: onum("Minimum price filter in the marketplace's own currency; decimals allowed (e.g. 19.99)."),
          max_price: onum("Maximum price filter in the marketplace's own currency; decimals allowed (e.g. 199.5)."),
          fulfillment_speed: z.enum(["today", "tomorrow"]).optional().describe("Only items deliverable today, or by tomorrow. '2_days' and 'anytime' are not accepted - for anytime, omit this parameter."),
          fulfillment_type: z.enum(["in_store"]).optional().describe("Set to 'in_store' to return only items available for in-store pickup."),
        }),
        (i: SdkOpts<typeof client.walmart.search>) => client.walmart.search(i)
      ),
      tool(
        "WALMART_PRODUCT",
        "Scavio Walmart Product",
        "Full detail for a single Walmart product: price, rating, images, specifications, availability and seller. US marketplace only - walmart.ca product pages could not be fetched at all, so this endpoint takes no domain. Costs 1 credit. Walmart is body-priced through `domain`, but this endpoint takes no domain, so it is always 1.",
        z.object({
          product_id: str("Walmart item id (usItemId), e.g. '13544111159'."),
        }),
        (i: SdkOpts<typeof client.walmart.product>) => client.walmart.product(i)
      ),
      tool(
        "WALMART_REVIEWS",
        "Scavio Walmart Reviews",
        "Customer reviews for a Walmart product with ratings, text, author, date and the rating breakdown. 10 reviews per page; paginate with page. Costs 1 credit. Walmart is body-priced through `domain`, but this endpoint takes no domain, so it is always 1.",
        z.object({
          product_id: str("Walmart item id (usItemId), e.g. '13544111159'."),
          page: onum("Reviews page, 1-based (integer >= 1). 10 reviews per page."),
          sort: z.enum(["relevancy", "submission-desc", "submission-asc", "rating-desc", "rating-asc", "helpful-desc"]).optional().describe("Review sort order. Omit for Walmart's own default ordering. One of: relevancy, submission-desc, submission-asc, rating-desc, rating-asc, helpful-desc."),
        }),
        (i: SdkOpts<typeof client.walmart.reviews>) => client.walmart.reviews(i)
      ),
      tool(
        "WALMART_CATEGORY",
        "Scavio Walmart Category",
        "Products within a Walmart category, in the same product shape as search. Costs 1 credit on domain 'com' or 'ca' and 2 credits on 'com.mx'; `limit` trims the response after fetching and never reduces the cost.",
        z.object({
          category_id: str("Walmart category id: either a leaf id ('1095191') or the full underscore-joined path ('3944_133251_1095191'). Both are accepted."),
          domain: z.enum(["com", "ca", "com.mx"]).optional().describe("Marketplace: 'com' (US, default, 1 credit), 'ca' (1 credit), 'com.mx' (2 credits). Sets the currency and product URLs of the response."),
          page: onum("Results page, 1-based (integer >= 1). One page per call."),
          limit: onum("Trim the returned products to at most this many (integer >= 1). Applied after fetching, so it does not reduce the credit cost of the call."),
          sort_by: z.enum(["best_match", "price_low", "price_high", "best_seller", "rating_high", "new"]).optional().describe("Result sort order. Defaults to 'best_match'. One of: best_match, price_low, price_high, best_seller, rating_high, new."),
          min_price: onum("Minimum price filter in the marketplace's own currency; decimals allowed (e.g. 19.99)."),
          max_price: onum("Maximum price filter in the marketplace's own currency; decimals allowed (e.g. 199.5)."),
          fulfillment_speed: z.enum(["today", "tomorrow"]).optional().describe("Only items deliverable today, or by tomorrow. '2_days' and 'anytime' are not accepted - for anytime, omit this parameter."),
        }),
        (i: SdkOpts<typeof client.walmart.category>) => client.walmart.category(i)
      ),
      tool(
        "WALMART_OFFERS",
        "Scavio Walmart Offers",
        "The buy-box offer for a Walmart product: price, seller, condition and buy-box flag. BUY-BOX SELLER ONLY - this is not the full offer list, and there is no way to page through the other sellers. Costs 1 credit. Walmart is body-priced through `domain`, but this endpoint takes no domain, so it is always 1.",
        z.object({
          product_id: str("Walmart item id (usItemId), e.g. '2979510112'."),
        }),
        (i: SdkOpts<typeof client.walmart.offers>) => client.walmart.offers(i)
      ),
      tool(
        "WALMART_SELLER",
        "Scavio Walmart Seller",
        "Marketplace seller storefront: name, rating, review count, Pro Seller badge and business details. Costs 1 credit. Walmart is body-priced through `domain`, but this endpoint takes no domain, so it is always 1.",
        z.object({
          seller_id: str("Numeric Walmart catalog seller id, as returned in `seller_catalog_id` on a product, search or offers response (e.g. '101480084'). The GUID `seller_id` is not accepted here - it 404s."),
        }),
        (i: SdkOpts<typeof client.walmart.seller>) => client.walmart.seller(i)
      ),
      tool(
        "WALMART_SELLER_PRODUCTS",
        "Scavio Walmart Seller Products",
        "A marketplace seller's catalog. Roughly the first 40 items are server-rendered and returned; total_count reports the seller's real catalog size. There is no pagination - the rest of the catalog is not reachable. Costs 1 credit. Walmart is body-priced through `domain`, but this endpoint takes no domain, so it is always 1.",
        z.object({
          seller_id: str("Numeric Walmart catalog seller id, as returned in `seller_catalog_id` on a product, search or offers response (e.g. '101480084'). The GUID `seller_id` 404s."),
        }),
        (i: SdkOpts<typeof client.walmart.sellerProducts>) => client.walmart.sellerProducts(i)
      )
    );
  }

  if (all || enableYoutube) {
    tools.push(
      tool(
        "YOUTUBE_SEARCH",
        "Scavio YouTube Search",
        "Search YouTube for videos, channels, or playlists. Costs 2 credits.",
        z.object({
          query: str("The video search query."),
          upload_date: z.enum(["last_hour", "today", "this_week", "this_month", "this_year"]).optional().describe("Upload date filter, e.g. 'last_hour', 'today', 'this_week', 'this_month', 'this_year'."),
          type: z.enum(["video", "channel", "playlist", "movie"]).optional().describe("Result type, e.g. 'video', 'channel', 'playlist', 'movie'."),
          duration: z.enum(["short", "medium", "long"]).optional().describe("Duration filter, e.g. 'short', 'medium', 'long'."),
          sort_by: z.enum(["relevance", "date", "view_count", "rating"]).optional().describe("Sort order: 'relevance', 'date', 'view_count', 'rating'."),
          features: z.array(z.string()).optional().describe("Feature filters, e.g. ['hd', '4k', 'subtitles', 'creative_commons', 'live', '360', '3d', 'hdr', 'vr180']."),
          cursor: ostr("Pagination cursor from a prior response."),
          hd: obool("Restrict to HD videos when true."),
          subtitles: obool("Restrict to videos with subtitles when true."),
          creative_commons: obool("Restrict to Creative Commons videos when true."),
          live: obool("Restrict to live videos when true."),
        }),
        (i: SdkOpts<typeof client.youtube.search>) => client.youtube.search(i)
      ),
      tool(
        "YOUTUBE_SHORTS",
        "Scavio YouTube Shorts",
        "Search YouTube Shorts by keyword. Costs 2 credits.",
        z.object({
          query: str("The Shorts search query."),
          sort_by: z.enum(["relevance", "date", "view_count", "rating"]).optional().describe("Sort order: 'relevance', 'date', 'view_count', 'rating'."),
          cursor: ostr("Pagination cursor."),
        }),
        (i: SdkOpts<typeof client.youtube.shorts>) => client.youtube.shorts(i)
      ),
      tool(
        "YOUTUBE_SUGGESTIONS",
        "Scavio YouTube Suggestions",
        "Fetch YouTube search autocomplete suggestions for a query. Costs 1 credit.",
        z.object({
          query: str("The partial search query to autocomplete."),
          language: ostr("Two-letter language code (default 'en')."),
          region: ostr("Two-letter region code (default 'US')."),
        }),
        (i: SdkOpts<typeof client.youtube.suggestions>) => client.youtube.suggestions(i)
      ),
      tool(
        "YOUTUBE_VIDEO",
        "Scavio YouTube Video",
        "Fetch full details for a YouTube video (title, author, view count, description, captions, chapters). Costs 1 credit.",
        z.object({ video_id: str("YouTube video id or a full watch URL.") }),
        (i: SdkOpts<typeof client.youtube.video>) => client.youtube.video(i)
      ),
      // /youtube/metadata is a deprecated alias of /youtube/video with the same
      // schema and the same handler. It is not registered as its own tool: two
      // identical tools only split the model's choice.
      tool(
        "YOUTUBE_COMMENTS",
        "Scavio YouTube Comments",
        "List comments on a YouTube video. Costs 1 credit.",
        z.object({
          video_id: str("YouTube video id or a full watch URL."),
          cursor: ostr("Pagination cursor."),
        }),
        (i: SdkOpts<typeof client.youtube.comments>) => client.youtube.comments(i)
      ),
      tool(
        "YOUTUBE_COMMENT_REPLIES",
        "Scavio YouTube Comment Replies",
        "List replies to a YouTube comment. Costs 1 credit.",
        z.object({
          video_id: str("YouTube video id or a full watch URL."),
          reply_cursor: str("Reply cursor from a parent comment's reply_cursor."),
          cursor: ostr("Pagination cursor."),
        }),
        (i: SdkOpts<typeof client.youtube.commentReplies>) => client.youtube.commentReplies(i)
      ),
      tool(
        "YOUTUBE_TRANSCRIPT",
        "Scavio YouTube Transcript",
        "Fetch a YouTube video's transcript or timed subtitles. Costs 8 credits, the most expensive YouTube tool.",
        z.object({
          video_id: str("YouTube video id or a full watch URL."),
          language: ostr("Transcript language code (default 'en')."),
          format: z.enum(["text", "srt"]).optional().describe("'text' for a plain transcript, 'srt' for timed subtitles."),
        }),
        (i: SdkOpts<typeof client.youtube.transcript>) => client.youtube.transcript(i)
      ),
      tool(
        "YOUTUBE_RELATED",
        "Scavio YouTube Related",
        "List videos related to a YouTube video. Costs 1 credit.",
        z.object({
          video_id: str("YouTube video id or a full watch URL."),
          cursor: ostr("Pagination cursor."),
        }),
        (i: SdkOpts<typeof client.youtube.related>) => client.youtube.related(i)
      ),
      tool(
        "YOUTUBE_CHANNEL_SEARCH",
        "Scavio YouTube Channel Search",
        "Search YouTube channels by keyword. Costs 1 credit.",
        z.object({
          query: str("The channel search query."),
          cursor: ostr("Pagination cursor."),
        }),
        (i: SdkOpts<typeof client.youtube.channelSearch>) => client.youtube.channelSearch(i)
      ),
      tool(
        "YOUTUBE_CHANNEL",
        "Scavio YouTube Channel",
        "Fetch a YouTube channel's details (subscribers, video count, views, links). Costs 1 credit.",
        z.object({ channel_id: str("YouTube channel id, @handle, or channel URL.") }),
        (i: SdkOpts<typeof client.youtube.channel>) => client.youtube.channel(i)
      ),
      tool(
        "YOUTUBE_CHANNEL_VIDEOS",
        "Scavio YouTube Channel Videos",
        "List a YouTube channel's uploaded videos. Costs 1 credit.",
        z.object({
          channel_id: str("YouTube channel id."),
          cursor: ostr("Pagination cursor."),
        }),
        (i: SdkOpts<typeof client.youtube.channelVideos>) => client.youtube.channelVideos(i)
      ),
      tool(
        "YOUTUBE_CHANNEL_SHORTS",
        "Scavio YouTube Channel Shorts",
        "List a YouTube channel's Shorts. Costs 1 credit.",
        z.object({
          channel_id: str("YouTube channel id."),
          cursor: ostr("Pagination cursor."),
        }),
        (i: SdkOpts<typeof client.youtube.channelShorts>) => client.youtube.channelShorts(i)
      ),
      tool(
        "YOUTUBE_CHANNEL_COMMUNITY",
        "Scavio YouTube Channel Community",
        "List a YouTube channel's community posts. Costs 1 credit.",
        z.object({
          channel_id: str("YouTube channel id."),
          cursor: ostr("Pagination cursor."),
        }),
        (i: SdkOpts<typeof client.youtube.channelCommunity>) => client.youtube.channelCommunity(i)
      ),
      tool(
        "YOUTUBE_CHANNEL_RESOLVE",
        "Scavio YouTube Channel Resolve",
        "Resolve a YouTube @handle or channel URL to a channel id. Costs 1 credit.",
        z.object({ channel: str("A channel @handle or channel URL.") }),
        (i: SdkOpts<typeof client.youtube.channelResolve>) => client.youtube.channelResolve(i)
      ),
      tool(
        "YOUTUBE_STREAMS",
        "Scavio YouTube Streams",
        "Fetch direct playable/downloadable stream URLs for a YouTube video. Costs 3 credits.",
        z.object({ video_id: str("YouTube video id or a full watch URL.") }),
        (i: SdkOpts<typeof client.youtube.streams>) => client.youtube.streams(i)
      )
    );
  }

  // /reddit/search takes query and cursor only. The type and sort params it used
  // to advertise were never read by the API - they were stripped on the wire, so
  // the model planned around a filter it never got. Removed.
  if (all || enableReddit) {
    tools.push(
      tool(
        "REDDIT_SEARCH",
        "Scavio Reddit Search",
        "Search Reddit posts by keyword. Costs 1 credit. Posts only: there is no type or sort filter, so rank data.results yourself.",
        z.object({
          query: str("The Reddit search query."),
          cursor: ostr("Pagination cursor. Pass data.next_cursor from a prior response; data.has_more says whether another page exists."),
        }),
        (i: SdkOpts<typeof client.reddit.search>) => client.reddit.search(i)
      ),
      tool(
        "REDDIT_SEARCH_SUGGESTIONS",
        "Scavio Reddit Search Suggestions",
        "Fetch Reddit search autocomplete suggestions for a seed keyword. Costs 1 credit.",
        z.object({ query: str("The partial search query to expand.") }),
        (i: SdkOpts<typeof client.reddit.searchSuggestions>) => client.reddit.searchSuggestions(i)
      ),
      tool(
        "REDDIT_POST",
        "Scavio Reddit Post",
        "Fetch one Reddit post by URL or post id. Costs 1 credit. data is a flat post object (title, text, score, upvote_ratio, num_comments, subreddit, author) and carries no comments: call REDDIT_POST_COMMENTS for those.",
        z.object({
          url: ostr("Full URL of the Reddit post. Provide this or post_id."),
          post_id: ostr("Post fullname (t3_...) or bare id. Provide this or url."),
        }),
        (i: SdkOpts<typeof client.reddit.post>) => client.reddit.post(i)
      ),
      tool(
        "REDDIT_POST_COMMENTS",
        "Scavio Reddit Post Comments",
        "List the top-level comments on a Reddit post. Costs 1 credit per page. Each comment carries a reply_cursor for REDDIT_COMMENT_REPLIES; page with data.next_cursor while data.has_more.",
        z.object({
          post_id: str("Post fullname (t3_...) or bare id."),
          sort: z.enum(["HOT", "NEW", "TOP", "BEST", "CONTROVERSIAL"]).optional().describe("Comment sort order: 'HOT', 'NEW', 'TOP', 'BEST', 'CONTROVERSIAL' (server default 'TOP')."),
          cursor: ostr("Pagination cursor from a prior response."),
        }),
        (i: SdkOpts<typeof client.reddit.postComments>) => client.reddit.postComments(i)
      ),
      tool(
        "REDDIT_COMMENT_REPLIES",
        "Scavio Reddit Comment Replies",
        "List the replies to one Reddit comment. Costs 1 credit per page.",
        z.object({
          post_id: str("Post fullname (t3_...) or bare id."),
          cursor: str("The reply_cursor of a comment from REDDIT_POST_COMMENTS. Required, and not interchangeable with next_cursor."),
          sort: z.enum(["HOT", "NEW", "TOP", "BEST", "CONTROVERSIAL"]).optional().describe("Comment sort order: 'HOT', 'NEW', 'TOP', 'BEST', 'CONTROVERSIAL' (server default 'TOP')."),
        }),
        (i: SdkOpts<typeof client.reddit.commentReplies>) => client.reddit.commentReplies(i)
      ),
      tool(
        "REDDIT_SUBREDDIT",
        "Scavio Reddit Subreddit",
        "Fetch a subreddit's metadata: title, description, subscriber count, type, NSFW flag, icon, banner, creation date. Costs 1 credit.",
        z.object({ subreddit: str("Subreddit name, without the r/ prefix.") }),
        (i: SdkOpts<typeof client.reddit.subreddit>) => client.reddit.subreddit(i)
      ),
      tool(
        "REDDIT_SUBREDDIT_POSTS",
        "Scavio Reddit Subreddit Posts",
        "List a subreddit's post feed, under data.posts. Costs 1 credit per page.",
        z.object({
          subreddit: str("Subreddit name, without the r/ prefix."),
          sort: z.enum(["BEST", "HOT", "NEW", "TOP", "CONTROVERSIAL", "RISING"]).optional().describe("Feed sort order: 'BEST', 'HOT', 'NEW', 'TOP', 'CONTROVERSIAL', 'RISING' (server default 'HOT')."),
          cursor: ostr("Pagination cursor from a prior response."),
        }),
        (i: SdkOpts<typeof client.reddit.subredditPosts>) => client.reddit.subredditPosts(i)
      ),
      tool(
        "REDDIT_USER",
        "Scavio Reddit User",
        "Fetch a redditor's profile: id, name, employee/verified flags, account type, whether they accept private messages. Costs 1 credit.",
        z.object({ username: str("Reddit username, without the u/ prefix.") }),
        (i: SdkOpts<typeof client.reddit.user>) => client.reddit.user(i)
      ),
      tool(
        "REDDIT_USER_POSTS",
        "Scavio Reddit User Posts",
        "List a redditor's submitted posts, under data.posts. Costs 1 credit per page.",
        z.object({
          username: str("Reddit username, without the u/ prefix."),
          sort: z.enum(["HOT", "NEW", "TOP", "BEST", "CONTROVERSIAL"]).optional().describe("Sort order: 'HOT', 'NEW', 'TOP', 'BEST', 'CONTROVERSIAL' (server default 'NEW')."),
          cursor: ostr("Pagination cursor from a prior response."),
        }),
        (i: SdkOpts<typeof client.reddit.userPosts>) => client.reddit.userPosts(i)
      ),
      tool(
        "REDDIT_USER_COMMENTS",
        "Scavio Reddit User Comments",
        "List a redditor's comments, under data.comments, each with the post it belongs to. Costs 1 credit per page.",
        z.object({
          username: str("Reddit username, without the u/ prefix."),
          sort: z.enum(["HOT", "NEW", "TOP", "BEST", "CONTROVERSIAL"]).optional().describe("Sort order: 'HOT', 'NEW', 'TOP', 'BEST', 'CONTROVERSIAL' (server default 'NEW')."),
          cursor: ostr("Pagination cursor from a prior response."),
        }),
        (i: SdkOpts<typeof client.reddit.userComments>) => client.reddit.userComments(i)
      ),
      tool(
        "REDDIT_POPULAR",
        "Scavio Reddit Popular",
        "List the site-wide Reddit popular feed, under data.posts. Costs 1 credit per page.",
        z.object({ cursor: ostr("Pagination cursor from a prior response.") }),
        (i: SdkOpts<typeof client.reddit.popular>) => client.reddit.popular(i)
      ),
      tool(
        "REDDIT_TRENDING",
        "Scavio Reddit Trending",
        "List Reddit's current trending search queries. Takes no parameters. Costs 1 credit.",
        z.object({}),
        () => client.reddit.trending()
      )
    );
  }

  if (all || enableTiktok) {
    tools.push(
      tool(
        "TIKTOK_PROFILE",
        "Scavio TikTok Profile",
        "Fetch a TikTok user profile by username or secUid. Costs 1 credit.",
        z.object({
          username: ostr("TikTok username (without @). Provide this or sec_user_id."),
          sec_user_id: ostr("TikTok secUid. Provide this or username."),
        }),
        (i: SdkOpts<typeof client.tiktok.profile>) => client.tiktok.profile(i)
      ),
      tool(
        "TIKTOK_USER_POSTS",
        "Scavio TikTok User Posts",
        "List a TikTok user's posts by secUid. Costs 1 credit per page.",
        z.object({
          sec_user_id: str("TikTok secUid of the user."),
          cursor: ostr("Pagination cursor, as a string (default '0')."),
          count: onum("Number of posts to return (1-30)."),
          sort_type: z.enum(["0", "1"]).optional().describe("'0' = latest, '1' = popular."),
        }),
        (i: SdkOpts<typeof client.tiktok.userPosts>) => client.tiktok.userPosts(i)
      ),
      tool(
        "TIKTOK_VIDEO",
        "Scavio TikTok Video",
        "Fetch a TikTok video by id. Costs 1 credit.",
        z.object({ video_id: str("TikTok video id.") }),
        (i: SdkOpts<typeof client.tiktok.video>) => client.tiktok.video(i)
      ),
      tool(
        "TIKTOK_VIDEO_COMMENTS",
        "Scavio TikTok Video Comments",
        "List comments on a TikTok video. Costs 1 credit per page.",
        z.object({
          video_id: str("TikTok video id."),
          cursor: ostr("Pagination cursor, as a string (default '0')."),
          count: onum("Number of comments to return (1-50)."),
        }),
        (i: SdkOpts<typeof client.tiktok.videoComments>) => client.tiktok.videoComments(i)
      ),
      tool(
        "TIKTOK_COMMENT_REPLIES",
        "Scavio TikTok Comment Replies",
        "List replies to a TikTok video comment. Costs 1 credit per page.",
        z.object({
          video_id: str("TikTok video id."),
          comment_id: str("Parent comment id."),
          cursor: ostr("Pagination cursor, as a string (default '0')."),
          count: onum("Number of replies to return (1-50)."),
        }),
        (i: SdkOpts<typeof client.tiktok.commentReplies>) => client.tiktok.commentReplies(i)
      ),
      tool(
        "TIKTOK_SEARCH_VIDEOS",
        "Scavio TikTok Search Videos",
        "Search TikTok videos by keyword. Costs 1 credit per page.",
        z.object({
          keyword: str("Search keyword."),
          cursor: ostr("Pagination cursor, as a string (default '0')."),
          count: onum("Number of videos to return (1-30)."),
          sort_type: z.enum(["0", "1"]).optional().describe("'0' = relevance, '1' = most likes."),
          publish_time: z.enum(["0", "1", "7", "30", "90", "180"]).optional().describe("Age filter in days: '0' = all time, '1', '7', '30', '90', '180'."),
        }),
        (i: SdkOpts<typeof client.tiktok.searchVideos>) => client.tiktok.searchVideos(i)
      ),
      tool(
        "TIKTOK_SEARCH_USERS",
        "Scavio TikTok Search Users",
        "Search TikTok users by keyword. Costs 1 credit per page.",
        z.object({
          keyword: str("Search keyword."),
          cursor: ostr("Pagination cursor, as a string (default '0')."),
          count: onum("Number of users to return (1-30)."),
        }),
        (i: SdkOpts<typeof client.tiktok.searchUsers>) => client.tiktok.searchUsers(i)
      ),
      tool(
        "TIKTOK_HASHTAG",
        "Scavio TikTok Hashtag",
        "Fetch a TikTok hashtag by name or id. Costs 1 credit.",
        z.object({
          hashtag_name: ostr("Hashtag name (without #). Provide this or hashtag_id."),
          hashtag_id: ostr("Hashtag id. Provide this or hashtag_name."),
        }),
        (i: SdkOpts<typeof client.tiktok.hashtag>) => client.tiktok.hashtag(i)
      ),
      tool(
        "TIKTOK_HASHTAG_VIDEOS",
        "Scavio TikTok Hashtag Videos",
        "List videos for a TikTok hashtag by id. Costs 1 credit per page.",
        z.object({
          hashtag_id: str("Hashtag id."),
          cursor: ostr("Pagination cursor, as a string (default '0')."),
          count: onum("Number of videos to return (1-30)."),
        }),
        (i: SdkOpts<typeof client.tiktok.hashtagVideos>) => client.tiktok.hashtagVideos(i)
      ),
      tool(
        "TIKTOK_USER_FOLLOWERS",
        "Scavio TikTok User Followers",
        "List a TikTok user's followers by secUid. Costs 1 credit per page.",
        z.object({
          sec_user_id: str("TikTok secUid of the user."),
          count: onum("Number of followers to return (1-20)."),
          page_token: ostr("Pagination token from a prior response."),
          min_time: onum("Minimum timestamp cursor."),
        }),
        (i: SdkOpts<typeof client.tiktok.userFollowers>) => client.tiktok.userFollowers(i)
      ),
      tool(
        "TIKTOK_USER_FOLLOWINGS",
        "Scavio TikTok User Followings",
        "List the accounts a TikTok user follows, by secUid. Costs 1 credit per page.",
        z.object({
          sec_user_id: str("TikTok secUid of the user."),
          count: onum("Number of followings to return (1-20)."),
          page_token: ostr("Pagination token from a prior response."),
          min_time: onum("Minimum timestamp cursor."),
        }),
        (i: SdkOpts<typeof client.tiktok.userFollowings>) => client.tiktok.userFollowings(i)
      )
    );
  }

  // Two upstream limits shape these descriptions, and a model that does not see
  // them will build a pipeline that silently loses most of its rows: only ~44% of
  // the product ids returned by search resolve on product(), and product() never
  // carries a price. Prices come from the listing tools.
  if (all || enableTiktokShop) {
    tools.push(
      tool(
        "TIKTOK_SHOP_SEARCH",
        "Scavio TikTok Shop Search",
        "Search TikTok Shop products by keyword (US catalog). Up to 30 per page with exact prices, ratings, sold counts and shop details. Costs 1 credit per page. Page with data.next_cursor while data.has_more and dedupe by product_id. Only about 44% of these product ids resolve on TIKTOK_SHOP_PRODUCT, so treat this as a standalone price source rather than the first leg of a search-then-detail pipeline.",
        z.object({
          search: str("Search keyword (1-200 characters)."),
          cursor: ostr("Opaque cursor from a prior response's next_cursor."),
        }),
        (i: SdkOpts<typeof client.tiktokShop.search>) => client.tiktokShop.search(i)
      ),
      tool(
        "TIKTOK_SHOP_SEARCH_SUGGESTIONS",
        "Scavio TikTok Shop Search Suggestions",
        "Fetch TikTok Shop keyword autocomplete and expansion for a partial query. Costs 1 credit. Suggestions are not guaranteed prefix matches: a misspelling returns typo corrections, and results can include brand and shop names.",
        z.object({
          search: str("Partial search keyword (1-100 characters)."),
          region: z.enum(["US", "GB", "SG", "MY", "PH", "TH", "VN", "ID"]).optional().describe("Marketplace region: 'US' (default), 'GB', 'SG', 'MY', 'PH', 'TH', 'VN', 'ID'."),
        }),
        (i: SdkOpts<typeof client.tiktokShop.searchSuggestions>) => client.tiktokShop.searchSuggestions(i)
      ),
      tool(
        "TIKTOK_SHOP_PRODUCT",
        "Scavio TikTok Shop Product",
        "Fetch full TikTok Shop product detail: description, images, variants with stock, shipping, shop profile, category path and top reviews. Costs 1 credit. Two hard limits: it returns NO price (upstream masks it, so read prices from TIKTOK_SHOP_SEARCH, TIKTOK_SHOP_SHOP_PRODUCTS or TIKTOK_SHOP_CATEGORY_PRODUCTS), and only about 44% of search product ids resolve here. A 404 is a normal outcome, not a transient error: skip that product instead of retrying, and try TIKTOK_SHOP_PRODUCT_REVIEWS, which often works for ids this cannot resolve.",
        z.object({
          product_id: str("TikTok Shop product id (6-25 digits)."),
          region: z.enum(["US", "GB", "SG", "MY", "PH", "TH", "VN", "ID"]).optional().describe("Marketplace region: 'US' (default), 'GB', 'SG', 'MY', 'PH', 'TH', 'VN', 'ID'."),
        }),
        (i: SdkOpts<typeof client.tiktokShop.product>) => client.tiktokShop.product(i)
      ),
      tool(
        "TIKTOK_SHOP_PRODUCT_REVIEWS",
        "Scavio TikTok Shop Product Reviews",
        "List TikTok Shop product reviews with text, images, star histogram and verified-purchase flags, up to 200 per call. Costs 1 credit per page. total_reviews drifts between calls, so page with has_more rather than computing a page count.",
        z.object({
          product_id: str("TikTok Shop product id (6-25 digits)."),
          page: onum("1-based page number (1-500; server default 1)."),
          page_size: onum("Reviews per page (1-200; server default 20)."),
          sort: z.enum(["relevant", "recent"]).optional().describe("'relevant' (default) returns text-complete, image-heavy reviews; 'recent' is fresher but far more text-sparse."),
          rating: onum("Only reviews with this star rating (1-5)."),
          has_media: obool("Only reviews with a photo or video."),
          verified_only: obool("Only verified purchases. Ignored when has_media is true; upstream allows one filter at a time."),
          region: z.enum(["US", "GB", "SG", "MY", "PH", "TH", "VN", "ID"]).optional().describe("Marketplace region: 'US' (default), 'GB', 'SG', 'MY', 'PH', 'TH', 'VN', 'ID'."),
        }),
        (i: SdkOpts<typeof client.tiktokShop.productReviews>) => client.tiktokShop.productReviews(i)
      ),
      tool(
        "TIKTOK_SHOP_CATEGORIES",
        "Scavio TikTok Shop Categories",
        "Fetch the global TikTok Shop category tree: 28 top-level categories, 240 nodes, two levels deep. Category ids are identical in every region and names are always English. Takes no parameters. Costs 1 credit.",
        z.object({}),
        () => client.tiktokShop.categories()
      ),
      tool(
        "TIKTOK_SHOP_CATEGORY_PRODUCTS",
        "Scavio TikTok Shop Category Products",
        "List TikTok Shop products under a category id from TIKTOK_SHOP_CATEGORIES, with exact prices. Costs 1 credit per page. Page size is inconsistent upstream (15 to 20), so always page with data.next_cursor. Listings are shallow: has_more turning false after a few pages is the end of the listing, not an error.",
        z.object({
          category_id: str("Category id from TIKTOK_SHOP_CATEGORIES; level 1 or 2 both work."),
          cursor: ostr("Opaque cursor from a prior response's next_cursor."),
          region: z.enum(["US", "GB"]).optional().describe("Marketplace region. Category listings are served for 'US' (default) and 'GB' only."),
        }),
        (i: SdkOpts<typeof client.tiktokShop.categoryProducts>) => client.tiktokShop.categoryProducts(i)
      ),
      tool(
        "TIKTOK_SHOP_SHOP_PRODUCTS",
        "Scavio TikTok Shop Shop Products",
        "List a TikTok Shop seller's product catalog, 30 per page, with exact prices. Costs 1 credit per page. Shop follower count, location and shop-level rating are not here; call TIKTOK_SHOP_PRODUCT for the full shop profile.",
        z.object({
          shop_id: str("TikTok Shop seller id (also called seller_id elsewhere on TikTok)."),
          cursor: ostr("Opaque cursor from a prior response's next_cursor."),
          region: z.enum(["US", "GB", "SG", "MY", "PH", "TH", "VN", "ID"]).optional().describe("Marketplace region: 'US' (default), 'GB', 'SG', 'MY', 'PH', 'TH', 'VN', 'ID'."),
        }),
        (i: SdkOpts<typeof client.tiktokShop.shopProducts>) => client.tiktokShop.shopProducts(i)
      ),
      tool(
        "TIKTOK_SHOP_RESOLVE",
        "Scavio TikTok Shop Resolve",
        "Resolve any TikTok Shop URL or share link to a product_id or shop_id, ready for the other TikTok Shop tools. Costs 1 credit. Accepts canonical product and store pages, tiktok.com/view links, affiliate share links and vt.tiktok.com short links.",
        z.object({ url: str("A TikTok Shop URL or share link.") }),
        (i: SdkOpts<typeof client.tiktokShop.resolve>) => client.tiktokShop.resolve(i)
      )
    );
  }

  // Instagram credits are per-endpoint, not flat: 10 for the hedged endpoints, 8
  // for post and comment replies (no fallback leg to hedge), 2 for user posts.
  // Each description states its own cost so a model can pick the cheap call when
  // either would do.
  if (all || enableInstagram) {
    tools.push(
      tool(
        "INSTAGRAM_PROFILE",
        "Scavio Instagram Profile",
        "Fetch an Instagram profile by username or user id. Costs 10 credits.",
        z.object({
          username: ostr("Instagram username. Provide this or user_id."),
          user_id: ostr("Instagram user id. Provide this or username."),
        }),
        (i: SdkOpts<typeof client.instagram.profile>) => client.instagram.profile(i)
      ),
      tool(
        "INSTAGRAM_USER_POSTS",
        "Scavio Instagram User Posts",
        "List an Instagram user's posts. Costs 2 credits, the cheapest Instagram tool.",
        z.object({
          username: ostr("Instagram username. Provide this or user_id."),
          user_id: ostr("Instagram user id. Provide this or username."),
          count: onum("Number of posts to return (1-50)."),
          cursor: ostr("Pagination cursor."),
        }),
        (i: SdkOpts<typeof client.instagram.userPosts>) => client.instagram.userPosts(i)
      ),
      tool(
        "INSTAGRAM_USER_REELS",
        "Scavio Instagram User Reels",
        "List an Instagram user's reels. Costs 10 credits.",
        z.object({
          username: ostr("Instagram username. Provide this or user_id."),
          user_id: ostr("Instagram user id. Provide this or username."),
          count: onum("Number of reels to return (1-50)."),
          cursor: ostr("Pagination cursor."),
        }),
        (i: SdkOpts<typeof client.instagram.userReels>) => client.instagram.userReels(i)
      ),
      tool(
        "INSTAGRAM_USER_TAGGED",
        "Scavio Instagram User Tagged",
        "List posts an Instagram user is tagged in. Costs 10 credits.",
        z.object({
          username: ostr("Instagram username. Provide this or user_id."),
          user_id: ostr("Instagram user id. Provide this or username."),
          count: onum("Number of tagged posts to return (1-50)."),
          cursor: ostr("Pagination cursor."),
        }),
        (i: SdkOpts<typeof client.instagram.userTagged>) => client.instagram.userTagged(i)
      ),
      tool(
        "INSTAGRAM_USER_STORIES",
        "Scavio Instagram User Stories",
        "Fetch an Instagram user's current stories. Costs 10 credits.",
        z.object({
          username: ostr("Instagram username. Provide this or user_id."),
          user_id: ostr("Instagram user id. Provide this or username."),
        }),
        (i: SdkOpts<typeof client.instagram.userStories>) => client.instagram.userStories(i)
      ),
      tool(
        "INSTAGRAM_POST",
        "Scavio Instagram Post",
        "Fetch an Instagram post by URL, media id, or shortcode. Costs 8 credits. Video URLs are in video_versions[].url and covers in image_versions2.candidates; there is no video_url or thumbnail_url field.",
        z.object({
          url: ostr("Post URL. Provide one of url, media_id, or shortcode."),
          media_id: ostr("Post media id. Provide one of url, media_id, or shortcode."),
          shortcode: ostr("Post shortcode. Provide one of url, media_id, or shortcode."),
        }),
        (i: SdkOpts<typeof client.instagram.post>) => client.instagram.post(i)
      ),
      tool(
        "INSTAGRAM_POST_COMMENTS",
        "Scavio Instagram Post Comments",
        "List comments on an Instagram post by shortcode or URL. Costs 10 credits.",
        z.object({
          shortcode: ostr("Post shortcode. Provide this or url."),
          url: ostr("Post URL. Provide this or shortcode."),
          cursor: ostr("Pagination cursor."),
          sort_order: z.enum(["popular", "newest"]).optional().describe("Comment sort order: 'popular' or 'newest'."),
        }),
        (i: SdkOpts<typeof client.instagram.postComments>) => client.instagram.postComments(i)
      ),
      tool(
        "INSTAGRAM_COMMENT_REPLIES",
        "Scavio Instagram Comment Replies",
        "List replies to an Instagram post comment. Costs 8 credits.",
        z.object({
          media_id: str("Post media id."),
          comment_id: str("Parent comment id."),
          cursor: ostr("Pagination cursor."),
        }),
        (i: SdkOpts<typeof client.instagram.commentReplies>) => client.instagram.commentReplies(i)
      ),
      tool(
        "INSTAGRAM_SEARCH_USERS",
        "Scavio Instagram Search Users",
        "Search Instagram users by keyword. Costs 10 credits.",
        z.object({
          keyword: str("Search keyword."),
          cursor: ostr("Pagination cursor."),
        }),
        (i: SdkOpts<typeof client.instagram.searchUsers>) => client.instagram.searchUsers(i)
      ),
      tool(
        "INSTAGRAM_SEARCH_HASHTAGS",
        "Scavio Instagram Search Hashtags",
        "Search Instagram hashtags by keyword. Costs 10 credits.",
        z.object({
          keyword: str("Search keyword."),
          cursor: ostr("Pagination cursor."),
        }),
        (i: SdkOpts<typeof client.instagram.searchHashtags>) => client.instagram.searchHashtags(i)
      ),
      tool(
        "INSTAGRAM_USER_FOLLOWERS",
        "Scavio Instagram User Followers",
        "List an Instagram user's followers. Costs 10 credits.",
        z.object({
          username: ostr("Instagram username. Provide this or user_id."),
          user_id: ostr("Instagram user id. Provide this or username."),
          count: onum("Number of followers to return (1-100)."),
          cursor: ostr("Pagination cursor."),
        }),
        (i: SdkOpts<typeof client.instagram.userFollowers>) => client.instagram.userFollowers(i)
      ),
      tool(
        "INSTAGRAM_USER_FOLLOWINGS",
        "Scavio Instagram User Followings",
        "List the accounts an Instagram user follows. Costs 10 credits.",
        z.object({
          username: ostr("Instagram username. Provide this or user_id."),
          user_id: ostr("Instagram user id. Provide this or username."),
          count: onum("Number of followings to return (1-100)."),
          cursor: ostr("Pagination cursor."),
        }),
        (i: SdkOpts<typeof client.instagram.userFollowings>) => client.instagram.userFollowings(i)
      )
    );
  }

  if (all || enableX) {
    tools.push(
      tool(
        "X_SEARCH",
        "Scavio X Search",
        "Search X for tweets and people. Costs 1 credit per page. Each result carries the tweet id, author handle, text, language, timestamp and engagement counts. Page with data.next_cursor while data.has_more.",
        z.object({
          search: str("The X search query (1-500 characters)."),
          search_type: z.enum(["Top", "Latest", "People", "Photos", "Videos"]).optional().describe("Result category: 'Top' (default), 'Latest', 'People', 'Photos', 'Videos'."),
          cursor: ostr("Pagination cursor from a prior response."),
        }),
        (i: SdkOpts<typeof client.x.search>) => client.x.search(i)
      ),
      tool(
        "X_TWEET",
        "Scavio X Tweet",
        "Fetch full details for a single tweet: text, timestamp, language, engagement counts, source and reply-to reference. Costs 1 credit.",
        z.object({ tweet_id: str("Tweet id.") }),
        (i: SdkOpts<typeof client.x.tweet>) => client.x.tweet(i)
      ),
      tool(
        "X_TWEET_COMMENTS",
        "Scavio X Tweet Comments",
        "List the replies to a tweet, ranked or chronological. Costs 1 credit per page. Page with data.next_cursor while data.has_more.",
        z.object({
          tweet_id: str("Tweet id."),
          rank: z.enum(["top", "latest"]).optional().describe("'top' for ranked replies (default) or 'latest' for chronological."),
          cursor: ostr("Pagination cursor from a prior response."),
        }),
        (i: SdkOpts<typeof client.x.tweetComments>) => client.x.tweetComments(i)
      ),
      tool(
        "X_TWEET_RETWEETERS",
        "Scavio X Tweet Retweeters",
        "List the users who retweeted a tweet, under data.retweeters. Costs 1 credit per page.",
        z.object({
          tweet_id: str("Tweet id."),
          cursor: ostr("Pagination cursor from a prior response."),
        }),
        (i: SdkOpts<typeof client.x.tweetRetweeters>) => client.x.tweetRetweeters(i)
      ),
      tool(
        "X_USER",
        "Scavio X User",
        "Fetch an X user's profile: handle, name, description, follower/friends/statuses/media counts, verified flag, avatar, location, website, creation date. Costs 1 credit.",
        z.object({ screen_name: str("An X handle, without the @.") }),
        (i: SdkOpts<typeof client.x.user>) => client.x.user(i)
      ),
      tool(
        "X_USER_TWEETS",
        "Scavio X User Tweets",
        "List an X user's tweets, under data.timeline, plus data.pinned and data.user. Costs 1 credit per page. There is no has_more here: stop when next_cursor is absent or the timeline comes back empty.",
        z.object({
          screen_name: str("An X handle, without the @."),
          cursor: ostr("Pagination cursor from a prior response."),
        }),
        (i: SdkOpts<typeof client.x.userTweets>) => client.x.userTweets(i)
      ),
      tool(
        "X_USER_REPLIES",
        "Scavio X User Replies",
        "List an X user's tweets and replies, under data.timeline. Costs 1 credit per page. There is no has_more here: stop when next_cursor is absent or the timeline comes back empty.",
        z.object({
          screen_name: str("An X handle, without the @."),
          cursor: ostr("Pagination cursor from a prior response."),
        }),
        (i: SdkOpts<typeof client.x.userReplies>) => client.x.userReplies(i)
      ),
      tool(
        "X_USER_MEDIA",
        "Scavio X User Media",
        "List an X user's media tweets (posts with photos or videos), under data.timeline. Costs 1 credit per page. There is no has_more here: stop when next_cursor is absent or the timeline comes back empty.",
        z.object({
          screen_name: str("An X handle, without the @."),
          cursor: ostr("Pagination cursor from a prior response."),
        }),
        (i: SdkOpts<typeof client.x.userMedia>) => client.x.userMedia(i)
      ),
      tool(
        "X_USER_FOLLOWERS",
        "Scavio X User Followers",
        "List an X user's followers. Costs 1 credit per page. Page with data.next_cursor while data.has_more.",
        z.object({
          screen_name: str("An X handle, without the @."),
          cursor: ostr("Pagination cursor from a prior response."),
        }),
        (i: SdkOpts<typeof client.x.userFollowers>) => client.x.userFollowers(i)
      ),
      tool(
        "X_USER_FOLLOWINGS",
        "Scavio X User Followings",
        "List the accounts an X user follows, under data.following (singular). Costs 1 credit per page. Page with data.next_cursor while data.has_more.",
        z.object({
          screen_name: str("An X handle, without the @."),
          cursor: ostr("Pagination cursor from a prior response."),
        }),
        (i: SdkOpts<typeof client.x.userFollowings>) => client.x.userFollowings(i)
      ),
      tool(
        "X_TRENDING",
        "Scavio X Trending",
        "List trending topics on X for a country. Costs 1 credit.",
        z.object({
          country: ostr("Country name, e.g. 'UnitedStates' (default), 'UnitedKingdom', 'Japan'."),
        }),
        (i: SdkOpts<typeof client.x.trending>) => client.x.trending(i)
      )
    );
  }

  // LinkedIn credits are not uniform: profile, company and single-post reads are
  // 1, the paginated list tools are 10 per page, and job detail is 30. Each
  // description states its own cost.
  //
  // Five endpoints were dropped rather than wrapped - person/contact,
  // company/people, company/jobs, search/people and search/posts have no upstream
  // left and can only answer 410. A tool that always fails is a menu item a model
  // will still pick, burning turns on retries, so it is better absent. The REST
  // API keeps answering those paths with an explicit 410 for code that already
  // calls them.
  if (all || enableLinkedin) {
    tools.push(
      tool(
        "LINKEDIN_PERSON",
        "Scavio LinkedIn Person",
        "Fetch a LinkedIn member's full profile: headline, about text, location, follower and connection counts, current company, work experience, education, honours and bio links. Costs 1 credit.",
        z.object({
          username: ostr("Public identifier (vanity handle), e.g. 'williamhgates'. Provide this or url."),
          url: ostr("Full LinkedIn profile URL. Provide this or username."),
        }),
        (i: SdkOpts<typeof client.linkedin.person>) => client.linkedin.person(i)
      ),
      tool(
        "LINKEDIN_PERSON_ABOUT",
        "Scavio LinkedIn Person About",
        "Fetch the about/overview slice of a LinkedIn member's profile: about text, headline, experience, education, honours and bio links. Costs 1 credit. Use instead of LINKEDIN_PERSON when only the narrative sections are needed.",
        z.object({
          username: ostr("Public identifier (vanity handle). Provide this or url."),
          url: ostr("Full LinkedIn profile URL. Provide this or username."),
        }),
        (i: SdkOpts<typeof client.linkedin.personAbout>) => client.linkedin.personAbout(i)
      ),
      tool(
        "LINKEDIN_PERSON_POSTS",
        "Scavio LinkedIn Person Posts",
        "List a LinkedIn member's posts, with text, url, timestamps, a full reaction breakdown, comment and repost counts and attached media. Costs 10 credits per page. 50 per page; pass the previous response's next_cursor to page.",
        z.object({
          username: ostr("Public identifier (vanity handle). Provide this or url."),
          url: ostr("Full LinkedIn profile URL. Provide this or username."),
          type: z.enum(["posts", "comments", "reactions"]).optional().describe("Which feed: 'posts' (default), 'comments' (posts they commented on), or 'reactions' (posts they reacted to)."),
          cursor: ostr("Opaque cursor from a prior response's next_cursor."),
        }),
        (i: SdkOpts<typeof client.linkedin.personPosts>) => client.linkedin.personPosts(i)
      ),
      tool(
        "LINKEDIN_COMPANY",
        "Scavio LinkedIn Company",
        "Fetch a LinkedIn company profile: about, website, industries, specialties, size, employee and follower counts, headquarters, all office locations, featured employees, similar and affiliated companies. Costs 1 credit.",
        z.object({
          company: ostr("Company universal name (slug), e.g. 'microsoft'. Provide this or url."),
          url: ostr("Full LinkedIn company URL. Provide this or company."),
        }),
        (i: SdkOpts<typeof client.linkedin.company>) => client.linkedin.company(i)
      ),
      tool(
        "LINKEDIN_COMPANY_POSTS",
        "Scavio LinkedIn Company Posts",
        "List a LinkedIn company's recent posts, in the same shape as member posts. Costs 10 credits per page. 50 per page; pass the previous response's next_cursor to page.",
        z.object({
          company: ostr("Company universal name (slug). Provide this or url."),
          url: ostr("Full LinkedIn company URL. Provide this or company."),
          cursor: ostr("Opaque cursor from a prior response's next_cursor."),
        }),
        (i: SdkOpts<typeof client.linkedin.companyPosts>) => client.linkedin.companyPosts(i)
      ),
      tool(
        "LINKEDIN_SEARCH_JOBS",
        "Scavio LinkedIn Search Jobs",
        "Search LinkedIn job listings by keyword, returning title, company, location, posted time, workplace type and salary. Costs 10 credits per page. 25 per page; the provider rotates its result set, so pages overlap and repeat calls differ - dedupe by job id. Pass a company name as the search term to approximate a per-company job listing.",
        z.object({
          search: str("Search keyword, e.g. 'software engineer'."),
          location: ostr("Geographic filter, e.g. 'United States'. Omit to search everywhere."),
          cursor: ostr("Opaque cursor from a prior response's next_cursor."),
        }),
        (i: SdkOpts<typeof client.linkedin.searchJobs>) => client.linkedin.searchJobs(i)
      ),
      tool(
        "LINKEDIN_JOB",
        "Scavio LinkedIn Job",
        "Fetch full details for one LinkedIn job listing, including the hiring company. Costs 30 credits, the most expensive Scavio tool: prefer the fields already returned by LINKEDIN_SEARCH_JOBS when they are enough. Roughly one job id in five has no detail record upstream and returns an unbilled 404.",
        z.object({
          job_id: ostr("Job listing id. Provide this or url."),
          url: ostr("Full LinkedIn job URL. Provide this or job_id."),
        }),
        (i: SdkOpts<typeof client.linkedin.job>) => client.linkedin.job(i)
      ),
      tool(
        "LINKEDIN_POST",
        "Scavio LinkedIn Post",
        "Fetch full details for one LinkedIn post: body text, timestamp, hashtags, links, media, like and comment counts, tagged companies and people, top visible comments and the author. Costs 1 credit.",
        z.object({
          post_id: ostr("Post id or activity urn. Provide this or url."),
          url: ostr("Full LinkedIn post URL. Provide this or post_id."),
        }),
        (i: SdkOpts<typeof client.linkedin.post>) => client.linkedin.post(i)
      ),
      tool(
        "LINKEDIN_POST_COMMENTS",
        "Scavio LinkedIn Post Comments",
        "List the comments on a LinkedIn post, each with the commenter and any nested replies. Costs 10 credits per page. Paginated by a 1-based page number, not a cursor; page size varies, so keep incrementing until a page comes back empty.",
        z.object({
          post_id: ostr("Post id or activity urn. Provide this or url."),
          url: ostr("Full LinkedIn post URL. Provide this or post_id."),
          page: onum("1-based page number (default 1)."),
        }),
        (i: SdkOpts<typeof client.linkedin.postComments>) => client.linkedin.postComments(i)
      )
    );
  }

  if (all || enableThreads) {
    tools.push(
      tool(
        "THREADS_PROFILE",
        "Scavio Threads Profile",
        "Profile details for a Threads user. Costs 2 credits addressed by user_id and 4 by username; pass user_id whenever you have it.",
        z.object({
          user_id: ostr("Numeric Threads user id, e.g. '63625256886'. The cheap path: 2 credits."),
          username: ostr("Threads handle without the @ (1-60 characters). Costs 2 extra credits (4 total): the upstream handle lookup is down, so the handle is resolved through people search first. Pass user_id instead to avoid that."),
        }),
        (i: SdkOpts<typeof client.threads.profile>) => client.threads.profile(i)
      ),
      tool(
        "THREADS_USER_POSTS",
        "Scavio Threads User Posts",
        "A user's Threads posts, cursor-paginated via next_cursor. Costs 2 credits addressed by user_id and 4 by username.",
        z.object({
          user_id: ostr("Numeric Threads user id, e.g. '63625256886'. The cheap path: 2 credits."),
          username: ostr("Threads handle without the @ (1-60 characters). Costs 2 extra credits (4 total) because the handle has to be resolved through people search first."),
          cursor: ostr("Pagination cursor from a prior response's next_cursor. Omit for the first page."),
        }),
        (i: SdkOpts<typeof client.threads.userPosts>) => client.threads.userPosts(i)
      ),
      tool(
        "THREADS_USER_REPLIES",
        "Scavio Threads User Replies",
        "A user's Threads replies, cursor-paginated via next_cursor. Costs 2 credits addressed by user_id and 4 by username.",
        z.object({
          user_id: ostr("Numeric Threads user id, e.g. '63625256886'. The cheap path: 2 credits."),
          username: ostr("Threads handle without the @ (1-60 characters). Costs 2 extra credits (4 total) because the handle has to be resolved through people search first."),
          cursor: ostr("Pagination cursor from a prior response's next_cursor. Omit for the first page."),
        }),
        (i: SdkOpts<typeof client.threads.userReplies>) => client.threads.userReplies(i)
      ),
      tool(
        "THREADS_POST",
        "Scavio Threads Post",
        "A single Threads post, addressed by post_id or by its threads.net URL. Costs 2 credits. Threads is body-priced by identifier, but this endpoint has no username form, so it is always 2.",
        z.object({
          post_id: ostr("Threads post id, e.g. '3349029093483693129'."),
          url: ostr("Full threads.net post URL (e.g. 'https://www.threads.net/@natgeo/post/C8xY'), as an alternative to post_id."),
        }),
        (i: SdkOpts<typeof client.threads.post>) => client.threads.post(i)
      ),
      tool(
        "THREADS_POST_COMMENTS",
        "Scavio Threads Post Comments",
        "Replies to a Threads post, cursor-paginated via next_cursor. Post-keyed only: there is no username form, so this endpoint always costs 2 credits.",
        z.object({
          post_id: str("Threads post id, e.g. '3349029093483693129'."),
          cursor: ostr("Pagination cursor from a prior response's next_cursor. Omit for the first page."),
        }),
        (i: SdkOpts<typeof client.threads.postComments>) => client.threads.postComments(i)
      ),
      tool(
        "THREADS_SEARCH_USERS",
        "Scavio Threads Search Users",
        "Search Threads profiles by name or handle. This is the only search Threads exposes - there is no post or content search - and it returns a single unpaginated page. Costs 2 credits. Threads is body-priced by identifier, but this endpoint has no username form, so it is always 2.",
        z.object({
          query: str("Name or handle to search for (1-200 characters)."),
        }),
        (i: SdkOpts<typeof client.threads.searchUsers>) => client.threads.searchUsers(i)
      )
    );
  }

  if (all || enableKuaishou) {
    tools.push(
      tool(
        "KUAISHOU_PROFILE",
        "Scavio Kuaishou Profile",
        "Profile details for a Kuaishou user. Costs 10 credits, the dearest single-object call on the platform.",
        z.object({
          user_id: str("Kuaishou user id (non-empty); get one from user_resolve or search_users."),
        }),
        (i: SdkOpts<typeof client.kuaishou.profile>) => client.kuaishou.profile(i)
      ),
      tool(
        "KUAISHOU_USER_POSTS",
        "Scavio Kuaishou User Posts",
        "A Kuaishou user's top posts, cursor-paginated via next_cursor. Costs 1 credit. Kuaishou is priced PER ENDPOINT (1, 2, 10 or 40), never per platform.",
        z.object({
          user_id: str("Kuaishou user id (non-empty); get one from user_resolve or search_users."),
          cursor: ostr("Opaque next_cursor from a prior response; omit for the first page."),
        }),
        (i: SdkOpts<typeof client.kuaishou.userPosts>) => client.kuaishou.userPosts(i)
      ),
      tool(
        "KUAISHOU_USER_LIVE",
        "Scavio Kuaishou User Live",
        "A Kuaishou user's current live-stream status. Not paginated. Costs 1 credit. Kuaishou is priced PER ENDPOINT (1, 2, 10 or 40), never per platform.",
        z.object({
          user_id: str("Kuaishou user id (non-empty); get one from user_resolve or search_users."),
        }),
        (i: SdkOpts<typeof client.kuaishou.userLive>) => client.kuaishou.userLive(i)
      ),
      tool(
        "KUAISHOU_USER_RESOLVE",
        "Scavio Kuaishou User Resolve",
        "Turns a Kuaishou share link into a user id. Only kuaishou.com and v.kuaishou.com links are accepted; Kwai international (kwai.com) is not served upstream. Costs 1 credit. Kuaishou is priced PER ENDPOINT (1, 2, 10 or 40), never per platform.",
        z.object({
          share_link: str("A kuaishou.com or v.kuaishou.com URL; kwai.com links are rejected."),
        }),
        (i: SdkOpts<typeof client.kuaishou.userResolve>) => client.kuaishou.userResolve(i)
      ),
      tool(
        "KUAISHOU_VIDEO",
        "Scavio Kuaishou Video",
        "A single Kuaishou video by photo id or URL. Provide photo_id or url. Costs 2 credits.",
        z.object({
          photo_id: ostr("Kuaishou photo (video) id, non-empty."),
          url: ostr("Full kuaishou.com video URL, as an alternative to photo_id."),
        }),
        (i: SdkOpts<typeof client.kuaishou.video>) => client.kuaishou.video(i)
      ),
      tool(
        "KUAISHOU_VIDEO_COMMENTS",
        "Scavio Kuaishou Video Comments",
        "Comments on a Kuaishou video, cursor-paginated via next_cursor. Costs 1 credit. Kuaishou is priced PER ENDPOINT (1, 2, 10 or 40), never per platform.",
        z.object({
          photo_id: str("Kuaishou photo (video) id, non-empty."),
          cursor: ostr("Opaque next_cursor from a prior response; omit for the first page."),
        }),
        (i: SdkOpts<typeof client.kuaishou.videoComments>) => client.kuaishou.videoComments(i)
      ),
      tool(
        "KUAISHOU_COMMENT_REPLIES",
        "Scavio Kuaishou Comment Replies",
        "Replies under a root comment on a Kuaishou video, cursor-paginated via next_cursor; count sizes the page (1-50). Costs 1 credit. Kuaishou is priced PER ENDPOINT (1, 2, 10 or 40), never per platform.",
        z.object({
          photo_id: str("Kuaishou photo (video) id, non-empty."),
          root_comment_id: str("Id of the top-level comment whose replies you want, from video_comments."),
          cursor: ostr("Opaque next_cursor from a prior response; omit for the first page."),
          count: onum("Replies per page, 1-50. Omit to use the upstream default."),
        }),
        (i: SdkOpts<typeof client.kuaishou.commentReplies>) => client.kuaishou.commentReplies(i)
      ),
      tool(
        "KUAISHOU_VIDEOS_BATCH",
        "Scavio Kuaishou Videos Batch",
        "Several Kuaishou videos in one call, hard-capped at 20 photo ids. Costs 40 credits, the dearest call on the platform.",
        z.object({
          photo_ids: z.array(z.string()).describe("Kuaishou photo (video) ids, 1-20 per call; more than 20 is rejected."),
        }),
        (i: SdkOpts<typeof client.kuaishou.videosBatch>) => client.kuaishou.videosBatch(i)
      ),
      tool(
        "KUAISHOU_SEARCH",
        "Scavio Kuaishou Search",
        "Mixed-result search across Kuaishou, cursor-paginated via next_cursor. Costs 10 credits per page.",
        z.object({
          keyword: str("Search keyword, 1-200 characters."),
          cursor: ostr("Opaque next_cursor from a prior response; omit for the first page."),
        }),
        (i: SdkOpts<typeof client.kuaishou.search>) => client.kuaishou.search(i)
      ),
      tool(
        "KUAISHOU_SEARCH_VIDEOS",
        "Scavio Kuaishou Search Videos",
        "Kuaishou video search results, cursor-paginated via next_cursor. Costs 10 credits per page.",
        z.object({
          keyword: str("Search keyword, 1-200 characters."),
          cursor: ostr("Opaque next_cursor from a prior response; omit for the first page."),
        }),
        (i: SdkOpts<typeof client.kuaishou.searchVideos>) => client.kuaishou.searchVideos(i)
      ),
      tool(
        "KUAISHOU_SEARCH_USERS",
        "Scavio Kuaishou Search Users",
        "Kuaishou user search results, cursor-paginated via next_cursor. Costs 10 credits per page.",
        z.object({
          keyword: str("Search keyword, 1-200 characters."),
          cursor: ostr("Opaque next_cursor from a prior response; omit for the first page."),
        }),
        (i: SdkOpts<typeof client.kuaishou.searchUsers>) => client.kuaishou.searchUsers(i)
      ),
      tool(
        "KUAISHOU_SEARCH_LIVE",
        "Scavio Kuaishou Search Live",
        "Kuaishou live-stream search results, cursor-paginated via next_cursor. Costs 10 credits per page.",
        z.object({
          keyword: str("Search keyword, 1-200 characters."),
          cursor: ostr("Opaque next_cursor from a prior response; omit for the first page."),
        }),
        (i: SdkOpts<typeof client.kuaishou.searchLive>) => client.kuaishou.searchLive(i)
      ),
      tool(
        "KUAISHOU_TAG_FEED",
        "Scavio Kuaishou Tag Feed",
        "Posts under a Kuaishou hashtag, cursor-paginated via next_cursor. Costs 1 credit. Kuaishou is priced PER ENDPOINT (1, 2, 10 or 40), never per platform.",
        z.object({
          tag: str("Hashtag text without the leading '#', 1-200 characters."),
          cursor: ostr("Opaque next_cursor from a prior response; omit for the first page."),
        }),
        (i: SdkOpts<typeof client.kuaishou.tagFeed>) => client.kuaishou.tagFeed(i)
      ),
      tool(
        "KUAISHOU_TRENDING",
        "Scavio Kuaishou Trending",
        "Kuaishou hot / live / shopping / brand / music leaderboards. One board per call, not paginated. Costs 1 credit. Kuaishou is priced PER ENDPOINT (1, 2, 10 or 40), never per platform.",
        z.object({
          board: z.enum(["hot", "live", "shopping", "brand", "music"]).optional().describe("Leaderboard to return; defaults to 'hot' when omitted. One of: hot, live, shopping, brand, music."),
        }),
        (i: SdkOpts<typeof client.kuaishou.trending>) => client.kuaishou.trending(i)
      )
    );
  }

  if (all || enableEbay) {
    tools.push(
      tool(
        "EBAY_SEARCH",
        "Scavio eBay Search",
        "Search live or SOLD eBay listings: price, condition, bids, shipping, seller, feedback. Provide query or seller; per_page accepts only 60, 120 or 240. Costs 1 credit.",
        z.object({
          query: ostr("Keyword to search (1-500 characters). Optional: a seller-only search pages that seller's whole catalogue."),
          seller: ostr("Restrict results to one seller's listings (1-64 characters), as in ebay.com/usr/<name>. Can be sent with no query."),
          page: onum("Results page, 1-based."),
          sort_by: z.enum(["best_match", "ending_soonest", "newly_listed", "price_low", "price_high"]).optional().describe("Result sort order. Defaults to 'best_match'. eBay's 'Distance: nearest first' is deliberately unsupported (it ranks against our proxy exit, not the caller). One of: best_match, ending_soonest, newly_listed, price_low, price_high."),
          min_price: onum("Minimum price, inclusive. Must be 0 or greater."),
          max_price: onum("Maximum price, inclusive. Must be 0 or greater."),
          condition: z.enum(["new", "open_box", "refurbished", "used", "for_parts"]).optional().describe("Item condition filter. 'refurbished' is eBay's parent condition, not one of its three graded tiers. One of: new, open_box, refurbished, used, for_parts."),
          buying_format: z.enum(["auction", "buy_it_now", "best_offer"]).optional().describe("Listing format: auction, fixed price (buy_it_now), or fixed price accepting offers (best_offer)."),
          free_shipping: obool("Only listings with free shipping."),
          sold: obool("Search completed listings that actually SOLD, for price research. eBay publishes no headline count on this view, so total_results is null."),
          category_id: ostr("eBay category id; must be numeric (e.g. '112529'). An unrecognised id returns the UNFILTERED set under a 200."),
          per_page: z.union([z.literal(60), z.literal(120), z.literal(240)]).optional().describe("Listings per page: 60, 120 or 240 only. Defaults to 60; eBay silently falls back to 60 for anything else."),
        }),
        (i: SdkOpts<typeof client.ebay.search>) => client.ebay.search(i)
      ),
      tool(
        "EBAY_PRODUCT",
        "Scavio eBay Product",
        "One eBay listing in full: price, condition, images, item specifics, shipping, returns, auction state, seller. Costs 1 credit.",
        z.object({
          item_id: str("eBay item number (e.g. '168591664725'), or a full ebay.com/itm/... listing URL; tracking parameters on a pasted URL are discarded."),
        }),
        (i: SdkOpts<typeof client.ebay.product>) => client.ebay.product(i)
      ),
      tool(
        "EBAY_SELLER",
        "Scavio eBay Seller",
        "eBay seller profile card: store name, feedback score and %, items sold, followers, location, categories. Profile only: page a catalogue with search(seller=...). Costs 1 credit.",
        z.object({
          seller: str("eBay username as it appears in ebay.com/usr/<name> (1-64 characters), which is what seller_name on a search or product result returns."),
        }),
        (i: SdkOpts<typeof client.ebay.seller>) => client.ebay.seller(i)
      )
    );
  }

  if (all || enableTarget) {
    tools.push(
      tool(
        "TARGET_SEARCH",
        "Scavio Target Search",
        "Search Target.com, the US retailer: prices, ratings, badges and promotions. Up to 28 results per page; rendered upstream, so expect around 9 seconds. Costs 1 credit.",
        z.object({
          keyword: str("Search keyword (1-500 characters)."),
          page: onum("Results page, 1-based."),
          count: onum("Results per page, 1-28. Defaults to 24; Target rejects anything above 28 outright."),
          sort: z.enum(["relevance", "featured", "price_low", "price_high", "rating_high", "best_seller", "newest"]).optional().describe("Result sort order. Defaults to 'relevance'. One of: relevance, featured, price_low, price_high, rating_high, best_seller, newest."),
          store_id: ostr("Numeric Target store id whose prices and availability the response reflects. Defaults to '3991', the store target.com uses with no store context."),
        }),
        (i: SdkOpts<typeof client.target.search>) => client.target.search(i)
      ),
      tool(
        "TARGET_CATEGORY",
        "Scavio Target Category",
        "Products in a Target category, same shape as search plus the category breadcrumb. Up to 28 per page; the slowest Target endpoint at around 37 seconds. Costs 1 credit.",
        z.object({
          category_id: str("Target category id: the segment after 'N-' in a target.com /c/ URL (target.com/c/apple/-/N-5xtg6 -> '5xtg6')."),
          page: onum("Results page, 1-based."),
          count: onum("Results per page, 1-28. Defaults to 24; Target rejects anything above 28 outright."),
          sort: z.enum(["relevance", "featured", "price_low", "price_high", "rating_high", "best_seller", "newest"]).optional().describe("Result sort order. Defaults to 'relevance'. One of: relevance, featured, price_low, price_high, rating_high, best_seller, newest."),
          store_id: ostr("Numeric Target store id whose prices and availability the response reflects. Defaults to '3991'."),
        }),
        (i: SdkOpts<typeof client.target.category>) => client.target.category(i)
      ),
      tool(
        "TARGET_PRODUCT",
        "Scavio Target Product",
        "Target product details by TCIN: price, rating, images, specifications, variants, return policy, fulfillment. seller_id/seller_name are null for stock sold by Target. Costs 1 credit.",
        z.object({
          tcin: str("Target catalog id (tcin, e.g. '1010453160'). A colour/size child tcin is answered by its variation parent, with the child present in 'variants'."),
          store_id: ostr("Numeric Target store id whose prices and availability the response reflects. Defaults to '3991'."),
        }),
        (i: SdkOpts<typeof client.target.product>) => client.target.product(i)
      ),
      tool(
        "TARGET_REVIEWS",
        "Scavio Target Reviews",
        "Target reviews with the rating breakdown, per-attribute averages and guest photos. 8 review bodies maximum and no paging; expect around 40 seconds. Costs 1 credit.",
        z.object({
          tcin: str("Target catalog id (tcin, e.g. '1010453160')."),
          limit: onum("Trim the returned reviews to at most this many (1 or greater). Target publishes 8 anonymously and offers no paging, so this only trims."),
          store_id: ostr("Numeric Target store id whose prices and availability the response reflects. Defaults to '3991'."),
        }),
        (i: SdkOpts<typeof client.target.reviews>) => client.target.reviews(i)
      )
    );
  }

  if (all || enableHomeDepot) {
    tools.push(
      tool(
        "HOME_DEPOT_SEARCH",
        "Scavio Home Depot Search",
        "Search Home Depot: price and promotions, brand and model, ratings, badges, per-store pickup/delivery. Page size is fixed at 12 and cannot be changed. Costs 2 credits.",
        z.object({
          query: str("Search keyword (1-500 characters)."),
          page: onum("Results page, 1-based. Home Depot serves 12 products per page and offers no way to change that, so paging is the only way to read further."),
          sort_by: z.enum(["best_match", "top_sellers", "top_rated", "price_low", "price_high"]).optional().describe("Result sort order. Defaults to 'best_match'. Closed enum: Home Depot answers an unknown sort with an empty page that is still billed. 'Newest' is absent - it is rejected on keyword search. One of: best_match, top_sellers, top_rated, price_low, price_high."),
          min_price: onum("Minimum price, inclusive. Must be 0 or greater."),
          max_price: onum("Maximum price, inclusive. Must be 0 or greater."),
        }),
        (i: SdkOpts<typeof client.homeDepot.search>) => client.homeDepot.search(i)
      ),
      tool(
        "HOME_DEPOT_PRODUCT",
        "Scavio Home Depot Product",
        "Full Home Depot item detail: pricing, images and videos, spec table, dimensions, bullets, documents, return policy. Carries a 10-review preview only. Costs 2 credits.",
        z.object({
          item_id: str("Home Depot item id (e.g. '325479354'), or a full homedepot.com/p/... product URL; tracking parameters on a pasted URL are discarded."),
        }),
        (i: SdkOpts<typeof client.homeDepot.product>) => client.homeDepot.product(i)
      ),
      tool(
        "HOME_DEPOT_REVIEWS",
        "Scavio Home Depot Reviews",
        "One page of full Home Depot review bodies, the rating distribution, per-attribute ratings, photos and seller responses. 30 reviews per page. Costs 2 credits.",
        z.object({
          item_id: str("Home Depot item id (e.g. '325479354'), or a full homedepot.com/p/... product URL; tracking parameters on a pasted URL are discarded."),
          page: onum("Reviews page, 1-based. 30 reviews per page; 'total_pages' in the response is the last one that exists, and asking past it is a 404."),
        }),
        (i: SdkOpts<typeof client.homeDepot.reviews>) => client.homeDepot.reviews(i)
      )
    );
  }

  if (all || enableZillow) {
    tools.push(
      tool(
        "ZILLOW_SEARCH",
        "Scavio Zillow Search",
        "Zillow listings in a region: price, beds, baths, living area, Zestimate, coordinates, images, days on market. A bare ZIP works alone but cannot be combined with a filter or a sort. Costs 1 credit.",
        z.object({
          location: str("Region to search (1-200 characters): a Zillow slug ('austin-tx'), a human form ('Austin, TX'), a ZIP, or a pasted zillow.com search URL. A ZIP works alone but cannot be combined with a filter or sort; an unresolvable region is a 404."),
          listing_status: z.enum(["for_sale", "for_rent", "sold"]).optional().describe("Which listings to return. Defaults to 'for_sale'. One of: for_sale, for_rent, sold."),
          page: onum("Results page, 1-based."),
          sort: z.enum(["relevance", "recommended", "newest", "price_low", "price_high", "payment_low", "payment_high", "beds", "baths", "sqft", "lot_size", "zestimate_low", "zestimate_high", "recent_change"]).optional().describe("Result sort order. Sorts that rank against a signed-in profile (saved/featured/personalised) are unsupported - we are never signed in. One of: relevance, recommended, newest, price_low, price_high, payment_low, payment_high, beds, baths, sqft, lot_size, zestimate_low, zestimate_high, recent_change."),
          min_price: onum("Minimum price, inclusive (0 or greater). On listing_status='for_rent' this is MONTHLY RENT - Zillow files rent under its payment filter."),
          max_price: onum("Maximum price, inclusive (0 or greater). On listing_status='for_rent' this is MONTHLY RENT."),
          beds_min: onum("Minimum bedrooms; whole number, 0 or greater."),
          beds_max: onum("Maximum bedrooms; whole number, 0 or greater."),
          baths_min: onum("Minimum bathrooms, 0 or greater. Half-baths are allowed (1.5)."),
          baths_max: onum("Maximum bathrooms, 0 or greater. Half-baths are allowed (1.5)."),
          sqft_min: onum("Minimum living area in square feet; whole number, 0 or greater."),
          sqft_max: onum("Maximum living area in square feet; whole number, 0 or greater."),
          lot_size_min: onum("Minimum lot size in square feet; whole number, 0 or greater."),
          lot_size_max: onum("Maximum lot size in square feet; whole number, 0 or greater."),
          year_built_min: onum("Earliest year built; whole number, 0 or greater."),
          year_built_max: onum("Latest year built; whole number, 0 or greater."),
          max_hoa: onum("Maximum monthly HOA fee in dollars, 0 or greater."),
          home_type: z.enum(["houses", "townhomes", "multi_family", "condos", "apartments", "manufactured", "lots_land"]).optional().describe("Property type filter. One of: houses, townhomes, multi_family, condos, apartments, manufactured, lots_land."),
          days_on_zillow: z.enum(["1", "7", "14", "30", "90", "6m", "12m", "24m", "36m"]).optional().describe("Listed - or, with listing_status='sold', sold - within the last N days. Closed enum: an unrecognised value returns the UNFILTERED set under a 200. One of: 1, 7, 14, 30, 90, 6m, 12m, 24m, 36m."),
          keywords: ostr("Free-text match against the listing description (1-200 characters)."),
          has_pool: obool("Only listings with a pool."),
          has_garage: obool("Only listings with a garage."),
          has_air_conditioning: obool("Only listings with air conditioning."),
          is_waterfront: obool("Only waterfront listings."),
          has_basement: obool("Only listings with a basement."),
          is_new_construction: obool("Only new-construction listings."),
          has_open_house: obool("Only listings with an upcoming open house."),
          price_reduced: obool("Only listings whose price was reduced."),
          is_3d_tour: obool("Only listings with a 3D tour."),
        }),
        (i: SdkOpts<typeof client.zillow.search>) => client.zillow.search(i)
      ),
      tool(
        "ZILLOW_PROPERTY",
        "Scavio Zillow Property",
        "Full Zillow listing: price and price history, Zestimate, tax history, RESO facts, rooms, schools, open houses, photos. Rental buildings return floor plans instead. Costs 1 credit.",
        z.object({
          zpid: str("Zillow property id (e.g. '29414894'), a full /homedetails/ URL, or a rental building URL (zillow.com/apartments/...). The building form is required for buildings: they have no zpid a caller can see."),
        }),
        (i: SdkOpts<typeof client.zillow.property>) => client.zillow.property(i)
      ),
      tool(
        "ZILLOW_AGENT_REVIEWS",
        "Scavio Zillow Agent Reviews",
        "A Zillow AGENT's profile and reviews: rating, bodies with sub-ratings, specialties, licenses, service areas, sales counts. Zillow server-renders the first five. Costs 1 credit.",
        z.object({
          screen_name: str("Zillow agent profile screen name as it appears in zillow.com/profile/<name>/ (1-200 characters, may contain spaces), or a full profile URL."),
        }),
        (i: SdkOpts<typeof client.zillow.agentReviews>) => client.zillow.agentReviews(i)
      )
    );
  }

  if (all || enableBooking) {
    tools.push(
      tool(
        "BOOKING_SEARCH",
        "Scavio Booking.com Search",
        "Booking.com properties for a destination and stay: live nightly price, review score, star rating, location, room type, deal badges. 25 properties per page. Provide destination or dest_id. Costs 1 credit.",
        z.object({
          destination: ostr("Destination to search, e.g. 'Paris' (1-200 characters). Required unless dest_id is given."),
          dest_id: ostr("Numeric Booking.com destination id, as an alternative to destination."),
          dest_type: z.enum(["city", "region", "country", "district", "landmark", "airport", "hotel"]).optional().describe("What dest_id refers to. Requires dest_id and is rejected without it, because Booking silently ignores a lone dest_type. One of: city, region, country, district, landmark, airport, hotel."),
          page: onum("Results page, 1-based. 25 properties per page, 1 credit each."),
          sort_by: z.enum(["popularity", "price_low", "price_high", "stars_high", "stars_low", "stars_and_price", "distance", "review_score"]).optional().describe("Result sort order (default 'popularity'). One of: popularity, price_low, price_high, stars_high, stars_low, stars_and_price, distance, review_score."),
          min_price: onum("Minimum price PER NIGHT in `currency`, >= 0. Must not exceed max_price."),
          max_price: onum("Maximum price PER NIGHT in `currency`, >= 0."),
          stars: z.array(z.number()).optional().describe("Star ratings to include, each 1-5, 1-5 values, OR'd together (e.g. [4, 5])."),
          min_review_score: z.enum(["6", "7", "8", "9"]).optional().describe("Minimum guest review score. Only '6', '7', '8' and '9' exist upstream; any other threshold is silently dropped."),
          property_type: z.enum(["apartments", "hostels", "hotels", "motels", "resorts", "bed_and_breakfasts", "villas", "campgrounds", "vacation_homes", "lodges", "homestays"]).optional().describe("Accommodation type by name, or a raw numeric Booking accommodation-type id (>= 1)."),
          free_cancellation: obool("Only properties offering free cancellation."),
          no_prepayment: obool("Only properties that take no prepayment."),
          breakfast_included: obool("Only rates that include breakfast."),
          checkin: ostr("Check-in date, YYYY-MM-DD. Must be sent together with checkout: a lone checkin is ignored and Booking prices a default range of its own."),
          checkout: ostr("Check-out date, YYYY-MM-DD. Must be later than checkin and sent together with it."),
          adults: onum("Adult guests, >= 1 (default 2)."),
          children_ages: z.array(z.number()).optional().describe("AGES of accompanying children, each 0-17, max 10 entries. Ages, not a count."),
          rooms: onum("Rooms required, >= 1 (default 1)."),
          currency: ostr("ISO 4217 currency for prices, 3 letters (default 'USD'). Without it Booking prices off the proxy exit and identical requests disagree."),
        }),
        (i: SdkOpts<typeof client.booking.search>) => client.booking.search(i)
      ),
      tool(
        "BOOKING_HOTEL",
        "Scavio Booking.com Hotel",
        "One Booking.com property in full: rooms and rate plans, facilities, house rules, check-in windows, policies, images, location and review scores, priced for the stay asked for. Chaining the `url` a search row returns is cheaper than a bare slug. Costs 1 credit.",
        z.object({
          hotel: str("Booking.com property URL or the bare page slug (1-500 characters); query params are discarded."),
          country_code: ostr("Two-letter country code for the property page (default 'us'). Only consulted for a bare slug, where a wrong one is a real, BILLED 404."),
          checkin: ostr("Check-in date, YYYY-MM-DD. Must be sent together with checkout; omitting both prices a two-night range Booking chose, echoed back in the response."),
          checkout: ostr("Check-out date, YYYY-MM-DD. Must be later than checkin and sent together with it."),
          adults: onum("Adult guests, >= 1 (default 2)."),
          children_ages: z.array(z.number()).optional().describe("AGES of accompanying children, each 0-17, max 10 entries. Ages, not a count."),
          rooms: onum("Rooms required, >= 1 (default 1)."),
          currency: ostr("ISO 4217 currency for prices, 3 letters (default 'USD'). Without it Booking prices off the proxy exit and identical requests disagree."),
        }),
        (i: SdkOpts<typeof client.booking.hotel>) => client.booking.hotel(i)
      ),
      tool(
        "BOOKING_REVIEWS",
        "Scavio Booking.com Reviews",
        "Booking.com guest reviews for a property with the score breakdown by category and Booking's own praise/complaint summary. No page param: total_count is the whole review history, count is what this response holds. Costs 1 credit.",
        z.object({
          hotel: str("Booking.com property URL or the bare page slug (1-500 characters); query params are discarded."),
          country_code: ostr("Two-letter country code for the property page (default 'us'). Only consulted for a bare slug, where a wrong one is a real, BILLED 404."),
          checkin: ostr("Check-in date, YYYY-MM-DD. Must be sent together with checkout; it prices the stay the review page is rendered for."),
          checkout: ostr("Check-out date, YYYY-MM-DD. Must be later than checkin and sent together with it."),
          adults: onum("Adult guests, >= 1 (default 2)."),
          children_ages: z.array(z.number()).optional().describe("AGES of accompanying children, each 0-17, max 10 entries. Ages, not a count."),
          rooms: onum("Rooms required, >= 1 (default 1)."),
          currency: ostr("ISO 4217 currency for prices, 3 letters (default 'USD')."),
        }),
        (i: SdkOpts<typeof client.booking.reviews>) => client.booking.reviews(i)
      )
    );
  }

  if (all || enableTripadvisor) {
    tools.push(
      tool(
        "TRIPADVISOR_LOCATIONS",
        "Scavio Tripadvisor Locations",
        "START HERE: resolve a place or business NAME to the TripAdvisor geo_id / location_id pair every other TripAdvisor endpoint is keyed by. Up to 20 rows. Costs 2 credits.",
        z.object({
          query: str("Place or business name to resolve (1-120 characters)."),
          limit: onum("Rows to return, 1-20 (default 12). Sizes the response only; there is no paging here."),
        }),
        (i: SdkOpts<typeof client.tripadvisor.locations>) => client.tripadvisor.locations(i)
      ),
      tool(
        "TRIPADVISOR_SEARCH",
        "Scavio Tripadvisor Search",
        "Restaurants, hotels or attractions in a TripAdvisor geo, TripAdvisor-ranked: rating, review count, price band, address, coordinates, phone, hours, Travelers' Choice badge; each row carries the location_id + geo_id pair. 30 locations per page. Provide geo_id or url. Costs 2 credits.",
        z.object({
          geo_id: ostr("TripAdvisor geo id (1-500 characters): 30196, g30196, or a URL carrying one. Required unless url is given."),
          category: z.enum(["restaurants", "hotels", "attractions"]).optional().describe("Listing family to search (default 'restaurants'). One of: restaurants, hotels, attractions."),
          page: onum("Results page, 1-based. 30 locations per page; a page beyond the last is a 404, not an empty result."),
          url: ostr("Full tripadvisor.com listing URL (1-500 characters), as an alternative to geo_id; country sites are accepted."),
        }),
        (i: SdkOpts<typeof client.tripadvisor.search>) => client.tripadvisor.search(i)
      ),
      tool(
        "TRIPADVISOR_LOCATION",
        "Scavio Tripadvisor Location",
        "One TripAdvisor location in full: rating, review histogram and per-aspect sub-ratings, city ranking, price band, cuisines, amenities, address, coordinates, contact, photos, and the FIRST PAGE OF REVIEWS. Provide location_id or url. Costs 2 credits.",
        z.object({
          location_id: ostr("TripAdvisor location id (1-500 characters): 1899234, d1899234, or a full _Review URL. Required unless url is given."),
          geo_id: ostr("Geo the location sits in; required when location_id is a bare d-id."),
          category: z.enum(["restaurants", "hotels", "attractions"]).optional().describe("Location family (default 'restaurants'); match the location's own type. One of: restaurants, hotels, attractions."),
          url: ostr("Full tripadvisor.com _Review URL (1-500 characters), as an alternative to location_id."),
        }),
        (i: SdkOpts<typeof client.tripadvisor.location>) => client.tripadvisor.location(i)
      ),
      tool(
        "TRIPADVISOR_REVIEWS",
        "Scavio Tripadvisor Reviews",
        "A page of TripAdvisor reviews: rating, trip date and type, reviewer home town and contribution count, management response. Page 1 already rides along in location(), so use this to page PAST it; consecutive pages can repeat one review at the boundary, so de-duplicate on review_id. Provide location_id or url. Costs 2 credits.",
        z.object({
          location_id: ostr("TripAdvisor location id (1-500 characters): 1899234, d1899234, or a full _Review URL. Required unless url is given."),
          geo_id: ostr("Geo the location sits in; required when location_id is a bare d-id."),
          category: z.enum(["restaurants", "hotels", "attractions"]).optional().describe("Location family (default 'restaurants'). It sets the page size, so it must match the location's own type on any page past the first. One of: restaurants, hotels, attractions."),
          url: ostr("Full tripadvisor.com _Review URL (1-500 characters), as an alternative to location_id."),
          page: onum("Reviews page, 1-based. 15 per page for restaurants, 10 for hotels and attractions; past the last page is a 404."),
        }),
        (i: SdkOpts<typeof client.tripadvisor.reviews>) => client.tripadvisor.reviews(i)
      )
    );
  }

  if (all || enableIndeed) {
    tools.push(
      tool(
        "INDEED_SEARCH",
        "Scavio Indeed Search",
        "Indeed job postings: title, employer, rating, location, salary range, job type, benefits, posting age, apply route. 10 postings per page. Provide query or location - a location-only search (every posting in a metro) is valid. Costs 2 credits.",
        z.object({
          query: ostr("Job title, keywords or employer (1-500 characters). Required unless location is given."),
          location: ostr("City and state, postal code, state, country, or 'Remote' (1-200 characters). Valid on its own with no query."),
          page: onum("Results page, 1-based. 10 postings per page, 1 call each."),
          radius: z.union([z.literal(0), z.literal(5), z.literal(10), z.literal(15), z.literal(25), z.literal(35), z.literal(50), z.literal(100)]).optional().describe("Search radius in miles around location. Closed set: Indeed IGNORES any other value and returns the unfiltered set. Upstream default 50. One of: 0, 5, 10, 15, 25, 35, 50, 100."),
          max_age_days: z.union([z.literal(1), z.literal(3), z.literal(7), z.literal(14)]).optional().describe("Maximum posting age in days. Closed set: Indeed IGNORES any other value and returns postings of every age. One of: 1, 3, 7, 14."),
          job_type: z.enum(["full_time", "part_time", "contract", "temporary", "internship"]).optional().describe("Employment type filter. One of: full_time, part_time, contract, temporary, internship."),
          min_salary: onum("Minimum annual salary, >= 0. Filters on INDEED'S OWN ESTIMATE for the role, not a posted figure, so postings publishing no salary still match."),
          remote: obool("Remote postings only."),
        }),
        (i: SdkOpts<typeof client.indeed.search>) => client.indeed.search(i)
      ),
      tool(
        "INDEED_JOB",
        "Scavio Indeed Job",
        "One Indeed posting in full: description text and HTML, structured salary, employment types, benefits, geocoded address, employer rating, applicant count, original ATS link. An unknown job key is a real 404 that is still billed. Costs 2 credits.",
        z.object({
          job_id: str("16-hex Indeed job key, or any indeed.com URL carrying jk= (/viewjob, /rc/clk, /pagead/clk)."),
        }),
        (i: SdkOpts<typeof client.indeed.job>) => client.indeed.job(i)
      ),
      tool(
        "INDEED_COMPANY",
        "Scavio Indeed Company",
        "Indeed employer profile: description, industry, HQ, size, revenue, CEO approval, overall and per-category ratings, reported salaries, open roles, locations. An unknown slug is a real 404 that is still billed. Costs 2 credits.",
        z.object({
          company: str("indeed.com/cmp/<slug> slug or a full profile URL (1-200 characters); slugs are untidy, e.g. 'Tata-Consultancy-Services-(tcs)'."),
        }),
        (i: SdkOpts<typeof client.indeed.company>) => client.indeed.company(i)
      ),
      tool(
        "INDEED_COMPANY_REVIEWS",
        "Scavio Indeed Company Reviews",
        "Indeed employee reviews, 20 per page, with per-category ratings, pros/cons, reviewer job title and location, plus aggregated sentiment and topic/location/job-title breakdowns. Costs 2 credits.",
        z.object({
          company: str("indeed.com/cmp/<slug> slug or a full profile URL (1-200 characters)."),
          page: onum("Reviews page, 1-based. 20 reviews per page."),
        }),
        (i: SdkOpts<typeof client.indeed.companyReviews>) => client.indeed.companyReviews(i)
      )
    );
  }

  if (all || enableAirbnb) {
    tools.push(
      tool(
        "AIRBNB_SEARCH",
        "Scavio Airbnb Search",
        "Airbnb stays: stay-total and per-night price with the full discount ledger, rating and review count, bedrooms/beds/baths, coordinates, badges, images, dates_are_defaulted. 18 listings per page; page and cursor are mutually exclusive. Costs 1 credit.",
        z.object({
          location: str("City, region, ZIP, or a pasted airbnb.com/s/ URL (1-200 characters). An unresolvable location is a 404."),
          check_in: ostr("Check-in date, YYYY-MM-DD. Must be sent with check_out; omitting both defaults to +30 days and flags dates_are_defaulted in the response."),
          check_out: ostr("Check-out date, YYYY-MM-DD. Must be later than check_in; defaults to check_in plus 5 nights when omitted."),
          adults: onum("Adult guests, >= 1."),
          children: onum("Children aged 2-12, >= 0."),
          infants: onum("Infants under 2, >= 0."),
          pets: onum("Pets, >= 0."),
          min_price: onum("Minimum price for the WHOLE STAY in `currency`, not per night, >= 0. Must not exceed max_price."),
          max_price: onum("Maximum price for the WHOLE STAY in `currency`, not per night, >= 0."),
          room_type: z.enum(["entire_home", "private_room", "shared_room", "hotel_room"]).optional().describe("Room type. Validated before the scrape, because an unrecognised value returns the UNFILTERED set under a 200. One of: entire_home, private_room, shared_room, hotel_room."),
          min_bedrooms: onum("Minimum bedrooms, >= 0."),
          min_beds: onum("Minimum beds, >= 0."),
          min_bathrooms: onum("Minimum bathrooms, >= 0."),
          superhost: obool("Superhost listings only."),
          instant_book: obool("Instant Book listings only."),
          guest_favorite: obool("Guest Favorite listings only."),
          free_cancellation: obool("Listings with free cancellation only."),
          amenities: ostr("Comma-separated amenities (1-200 characters): wifi, air_conditioning, pool, kitchen, free_parking, washer, self_check_in, tv, or raw numeric Airbnb amenity ids. An unrecognised NAME is rejected before the scrape."),
          currency: ostr("ISO 4217 currency for prices, 3 letters (default 'USD'). Without it Airbnb prices off the proxy exit and identical requests disagree."),
          page: onum("Results page, 1-based. 18 listings per page. Cannot be combined with cursor."),
          cursor: ostr("next_cursor from a previous response (1-500 characters); wins over page, so sending both is rejected."),
        }),
        (i: SdkOpts<typeof client.airbnb.search>) => client.airbnb.search(i)
      ),
      tool(
        "AIRBNB_LISTING",
        "Scavio Airbnb Listing",
        "One Airbnb listing in full: description, property/room type, capacity and room counts, the complete grouped amenity list (including what the place does NOT have), host profile and stats, house rules, cancellation policy, sleeping arrangements, photo tour and the RATING BREAKDOWN. Carries NO nightly price - prices are search-only. Costs 1 credit.",
        z.object({
          listing_id: str("Airbnb listing id or a full /rooms/ URL (1-500 characters); query params are discarded, since they carry someone else's dates."),
          check_in: ostr("Check-in date, YYYY-MM-DD. Must be sent with check_out. Does not produce a price: the room page has no nightly rate."),
          check_out: ostr("Check-out date, YYYY-MM-DD. Must be later than check_in and sent together with it."),
          adults: onum("Adult guests, >= 1."),
          children: onum("Children aged 2-12, >= 0."),
          infants: onum("Infants under 2, >= 0."),
          pets: onum("Pets, >= 0."),
          currency: ostr("ISO 4217 currency, 3 letters (default 'USD')."),
        }),
        (i: SdkOpts<typeof client.airbnb.listing>) => client.airbnb.listing(i)
      ),
      tool(
        "AIRBNB_REVIEWS",
        "Scavio Airbnb Reviews",
        "Airbnb review BODIES with per-review rating, date and reviewer name/photo/location, limit/offset paged at up to 50 per call. `count` is the listing's TOTAL review count, `returned` is how many this page holds. The rating breakdown lives on listing(), not here. Costs 1 credit.",
        z.object({
          listing_id: str("Airbnb listing id or a full /rooms/ URL (1-500 characters)."),
          currency: ostr("ISO 4217 currency, 3 letters (default 'USD')."),
          limit: onum("Reviews to return, 1-50 (default 30). Upstream returns a fixed 7 when no explicit limit is sent."),
          offset: onum("Reviews to skip before this page, >= 0 (default 0)."),
        }),
        (i: SdkOpts<typeof client.airbnb.reviews>) => client.airbnb.reviews(i)
      )
    );
  }

  if (all || enableGlassdoor) {
    tools.push(
      tool(
        "GLASSDOOR_COMPANIES",
        "Scavio Glassdoor Companies",
        "START HERE. Resolve a company NAME to the employer_id every other Glassdoor method is keyed by, ranked by Glassdoor and de-duplicated. Costs 1 credit.",
        z.object({
          query: str("Company name to resolve (1-120 characters)."),
        }),
        (i: SdkOpts<typeof client.glassdoor.companies>) => client.glassdoor.companies(i)
      ),
      tool(
        "GLASSDOOR_COMPANY",
        "Scavio Glassdoor Company",
        "Glassdoor employer profile: description, mission, industry, sector, HQ, size and revenue bands, stock symbol, year founded, overall and per-category ratings, star distribution, CEO approval, awards, FAQ and the five server-rendered reviews. Also returns reviews_url and salaries_url, which reviews() and salaries() accept as url to save a fetch. Provide employer_id or url. Costs 1 credit.",
        z.object({
          employer_id: ostr("Glassdoor employer id (1-50 characters) in any form Glassdoor writes it: '1699', 'E1699' or 'IE1699'. Must be a STRING - a JSON number is rejected."),
          company: ostr("Employer name as it appears in a Glassdoor slug (1-200 characters). COSMETIC: the profile resolves on employer_id alone, it is ignored entirely when url is set, and it does not satisfy the employer_id-or-url requirement."),
          url: ostr("Any glassdoor.com employer URL (1-500 characters): /Overview/, /Reviews/ or /Salary/. A non-glassdoor.com host is rejected."),
        }),
        (i: SdkOpts<typeof client.glassdoor.company>) => client.glassdoor.company(i)
      ),
      tool(
        "GLASSDOOR_REVIEWS",
        "Scavio Glassdoor Reviews",
        "Up to THREE full Glassdoor reviews - the cap is Glassdoor's login wall - with per-axis scores, pros, cons, advice, job title, location, employment status and employer response, plus complete rating statistics, star distribution, aggregate pro/con highlight terms and per-job-title review counts. There is no page param: move the window with category and employment_status. Provide employer_id or url. Costs 1 credit.",
        z.object({
          employer_id: ostr("Glassdoor employer id (1-50 characters): '1699', 'E1699' or 'IE1699'. Must be a STRING - a JSON number is rejected. Addressing by id costs two upstream fetches; the customer price is unchanged."),
          company: ostr("Employer name as it appears in a Glassdoor slug (1-200 characters). COSMETIC: ignored when url is set, and it does not satisfy the employer_id-or-url requirement."),
          url: ostr("Any glassdoor.com employer URL (1-500 characters). Pass back reviews_url from company() to skip the resolve fetch. A non-glassdoor.com host is rejected."),
          category: z.enum(["career_development", "compensation", "culture", "diversity_and_inclusion", "management", "work_life_balance"]).optional().describe("Restrict to reviews Glassdoor files under one topic. Closed enum: Glassdoor IGNORES an unknown value and serves the unfiltered set under a 200. Read filtered_review_count on the response to see how many match. One of: career_development, compensation, culture, diversity_and_inclusion, management, work_life_balance."),
          employment_status: z.enum(["full_time", "part_time", "contract", "intern"]).optional().describe("Restrict to one kind of employment. Closed enum for the same reason as category; FREELANCE is deliberately absent because it was never confirmed to change the result set. One of: full_time, part_time, contract, intern."),
        }),
        (i: SdkOpts<typeof client.glassdoor.reviews>) => client.glassdoor.reviews(i)
      ),
      tool(
        "GLASSDOOR_SALARIES",
        "Scavio Glassdoor Salaries",
        "Glassdoor salaries by job title, 10 titles per page: base-pay and total-pay percentiles P10-P90 with medians called out, sample counts, currency, pay period and last-reported date. The figures are Glassdoor's ESTIMATES for the title, not individual reported salaries. Provide employer_id or url. Costs 1 credit.",
        z.object({
          employer_id: ostr("Glassdoor employer id (1-50 characters): '1699', 'E1699' or 'IE1699'. Must be a STRING - a JSON number is rejected. Addressing by id costs two upstream fetches; the customer price is unchanged."),
          company: ostr("Employer name as it appears in a Glassdoor slug (1-200 characters). COSMETIC: ignored when url is set, and it does not satisfy the employer_id-or-url requirement."),
          url: ostr("Any glassdoor.com employer URL (1-500 characters). Pass back salaries_url from company() to skip the resolve fetch. A non-glassdoor.com host is rejected."),
          page: onum("Results page, 1-based. Ten job titles per page; page_count on the response is how many pages exist."),
        }),
        (i: SdkOpts<typeof client.glassdoor.salaries>) => client.glassdoor.salaries(i)
      )
    );
  }

  if (all || enableYelp) {
    tools.push(
      tool(
        "YELP_SEARCH",
        "Scavio Yelp Search",
        "Businesses in Yelp's ranked order: rating, review count, price band, categories, address, contact rails, hours, photos and a review snippet; every row carries both business_id and alias. Yelp fixes the page size at 10. Provide term and location, or url. Costs 2 credits.",
        z.object({
          term: ostr("What to look for (1-200 characters): a category ('plumbers'), a dish, or a business name. Required together with location unless url is given."),
          location: ostr("Where to look (1-200 characters): city and region, a full address, or a postcode. Effectively required - Yelp geolocates a location-less search off the proxy exit, so the same request answers about a different metro run to run."),
          page: onum("Results page, 1-based. Yelp fixes the page size at 10."),
          sort: z.enum(["recommended", "rating", "review_count"]).optional().describe("Result ordering (upstream default 'recommended'). Closed enum: Yelp IGNORES an unrecognised sortby and serves default ranking under a 200, billing a premium scrape for a sort that never ran. One of: recommended, rating, review_count."),
          price: z.array(z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])).optional().describe("Price bands to include, 1 ($) to 4 ($$$$); 1-4 values, combined freely - [1, 2] means $ or $$."),
          open_now: obool("Only businesses open at the moment of the request."),
          attributes: z.array(z.string()).optional().describe("Raw Yelp filter aliases, max 20, each 1-100 characters ('RestaurantsDelivery', 'GoodForKids', 'WheelchairAccessible'). A deliberate PASSTHROUGH, not an enum - Yelp's vocabulary runs to ~117 values per vertical and an alias it does not know is ignored upstream, returning unfiltered results."),
          url: ostr("A full yelp.com/search URL (1-1000 characters) as an alternative to term + location; the query, offset and sort are read out of it and the URL is rebuilt."),
        }),
        (i: SdkOpts<typeof client.yelp.search>) => client.yelp.search(i)
      ),
      tool(
        "YELP_BUSINESS",
        "Scavio Yelp Business",
        "One business in full: rating and per-star histogram, review count, price band, categories, address and coordinates, phone, website and menu links, hours and holidays, amenities, photos and videos, popular items, health inspections, Q&A, licences and claim status - plus the first page of reviews at no extra cost. Provide business_id or url. Costs 2 credits.",
        z.object({
          business_id: ostr("A Yelp business alias ('desnudo-coffee-austin-2'), its opaque encid, or any yelp.com/biz URL carrying one (1-500 characters). Search rows return both id forms."),
          url: ostr("A full yelp.com/biz URL (1-1000 characters) as an alternative to business_id."),
        }),
        (i: SdkOpts<typeof client.yelp.business>) => client.yelp.business(i)
      ),
      tool(
        "YELP_REVIEWS",
        "Scavio Yelp Reviews",
        "A page of reviews: rating, full text, language, author profile and expertise counts, attached photos, reaction counts and owner response. 10 per page. PAGE 1 IS REDUNDANT - it re-fetches the document business() already returned - so start at page 2. Provide business_id or url. Costs 2 credits.",
        z.object({
          business_id: ostr("A Yelp business alias ('desnudo-coffee-austin-2'), its opaque encid, or any yelp.com/biz URL carrying one (1-500 characters)."),
          url: ostr("A full yelp.com/biz URL (1-1000 characters) as an alternative to business_id."),
          page: onum("Reviews page, 1-based, 10 per page. Page 1 duplicates the reviews business() already returned and costs another 2 credits - start at 2. A page past the last review is a 404, not an empty result."),
          sort: z.enum(["relevance", "newest", "oldest", "rating_high", "rating_low", "elites"]).optional().describe("Review ordering (upstream default 'relevance'). Closed enum: Yelp IGNORES an unrecognised value and serves default ranking under a billed 200. One of: relevance, newest, oldest, rating_high, rating_low, elites."),
          rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional().describe("Only reviews at this star rating, 1-5. Changes filtered_review_count on the response, not review_count. One of: 1, 2, 3, 4, 5."),
        }),
        (i: SdkOpts<typeof client.yelp.reviews>) => client.yelp.reviews(i)
      )
    );
  }

  if (all || enableAppStore) {
    tools.push(
      tool(
        "APP_STORE_SEARCH",
        "Scavio App Store Search",
        "Search the App Store and get up to 200 fully-shaped app rows - the same 43-field row as app() - so a search doubles as a bulk metadata fetch and as a publisher lookup. NO PAGINATION: raise limit, there is no second page. Costs 1 credit.",
        z.object({
          term: str("What to search for (1-500 characters). Apple matches an app name, a keyword OR a publisher name, so searching a developer returns their catalogue."),
          limit: onum("Apps to return, 1-200 (default 25). The ONLY lever on result volume: the search API has no pagination and every offset spelling is silently ignored."),
          country: ostr("Two-letter ISO storefront code (default 'us'); decides price, currency, localised title and whether the app is sold there at all. Anything that is not exactly two letters is rejected with a free 400."),
          entity: z.enum(["software", "ipad_software", "mac_software"]).optional().describe("Which catalogue to search: iPhone/iPad apps ('software', the default), iPad apps, or Mac App Store apps. These are separate stores, not a filter - Mac rows carry no iPad/Apple TV screenshots, advisories, features, supported devices or Game Center flag, returning them empty rather than absent. One of: software, ipad_software, mac_software."),
          lang: ostr("Listing text language as a five-letter code ('en_us', 'ja_jp'); any other shape is rejected. Independent of country: the storefront sets the price, this sets the words."),
        }),
        (i: SdkOpts<typeof client.appStore.search>) => client.appStore.search(i)
      ),
      tool(
        "APP_STORE_APP",
        "Scavio App Store App",
        "Full App Store listing: title, description, developer and seller identity, price and currency, all-time and current-version ratings, version and release notes, genres, content rating and advisories, icons at three sizes, screenshots, download size, minimum OS, languages, supported devices and the Game Center and VPP flags. Costs 1 credit.",
        z.object({
          app_id: str("App Store id - the digits after 'id' in an apps.apple.com URL - or the app's bundle id ('notion.id', 'com.burbn.instagram'); both resolve to the identical payload. 1-255 characters matching ^[A-Za-z0-9][A-Za-z0-9._-]*$, so a pasted apps.apple.com URL is rejected with a free 400. An id Apple cannot resolve is a billed 404."),
          country: ostr("Two-letter ISO storefront code (default 'us'); decides price, currency, localised title and whether the app is sold there at all. Anything that is not exactly two letters is rejected with a free 400."),
        }),
        (i: SdkOpts<typeof client.appStore.app>) => client.appStore.app(i)
      ),
      tool(
        "APP_STORE_REVIEWS",
        "Scavio App Store Reviews",
        "A page of App Store reviews: star rating, title, full text, author and the APP VERSION the review was written against. 50 per page, hard-stopped at page 10 - 500 reviews per storefront is Apple's anonymous ceiling. This endpoint cannot 404: an unknown id and a real app with no reviews return the same empty feed. Costs 1 credit.",
        z.object({
          app_id: str("App Store id, NUMERIC ONLY - unlike app(), the reviews feed has no bundle-id form."),
          country: ostr("Two-letter ISO storefront code (default 'us'). Anything that is not exactly two letters is rejected with a free 400. Ask a different country to reach past the 500-review ceiling."),
          page: onum("Reviews page, 1-10, 50 reviews each (default 1). Apple hard-stops at page 10."),
          sort: z.enum(["most_recent", "most_helpful"]).optional().describe("Review ordering (default 'most_recent'). The choice decides whether the vote fields mean anything: under most_recent almost every review is too new to have been voted on and returns zeroes, while most_helpful returns them densely populated."),
        }),
        (i: SdkOpts<typeof client.appStore.reviews>) => client.appStore.reviews(i)
      )
    );
  }

  if (all || enableGooglePlay) {
    tools.push(
      tool(
        "GOOGLE_PLAY_SEARCH",
        "Scavio Google Play Search",
        "Ranked Google Play apps: package name, title, developer, rating, install count, price and IAP range, content rating, icon and screenshots. A branded query returns the hero card as result 1 in the same row shape, plus Play's related-query rail. NO PAGINATION - one shelf of about 30 apps. Costs 2 credits.",
        z.object({
          query: str("What to search the store for (1-200 characters): an app name, a publisher, or a category phrase. Apps only - games are folded into the apps vertical, but books and films use a different card shape and are not covered."),
          hl: ostr("UI language, 2-20 characters (default 'en'). Changes the STOREFRONT, not only the strings: at hl=pt-BR the title, description, install formatting and content rating all move with it. Play silently falls back to English on a value it does not serve."),
          gl: ostr("Country code, 2-10 characters (default 'us'), deciding which storefront's price and availability are returned. Play silently falls back to the US storefront on a country it does not serve."),
        }),
        (i: SdkOpts<typeof client.googlePlay.search>) => client.googlePlay.search(i)
      ),
      tool(
        "GOOGLE_PLAY_APP",
        "Scavio Google Play App",
        "Full Google Play store listing: installs including the REAL count Play publishes but never renders, rating and star histogram, description, developer identity and legal contact, price and IAPs, categories and gameplay tags, screenshots and trailer, version and Android requirement, release and update dates, changelog, the full permission tree, the Data safety table, the 20 server-rendered reviews and the similar-apps and more-by-developer rails. Costs 2 credits.",
        z.object({
          app_id: str("Android package name ('com.spotify.music') or any play.google.com URL carrying one in its id param (1-500 characters)."),
          hl: ostr("UI language, 2-20 characters (default 'en'). Changes the STOREFRONT, not only the strings: title, description, install formatting and content rating all move with it. Play silently falls back to English on a value it does not serve."),
          gl: ostr("Country code, 2-10 characters (default 'us'), deciding which storefront's price and availability are returned. Play silently falls back to the US storefront on a country it does not serve."),
        }),
        (i: SdkOpts<typeof client.googlePlay.app>) => client.googlePlay.app(i)
      ),
      tool(
        "GOOGLE_PLAY_REVIEWS",
        "Scavio Google Play Reviews",
        "A page of Google Play reviews: star score, full text, author, thumbs-up count, developer reply and the APP VERSION the reviewer was running. Paged by cursor, up to 200 per call. app() already returns the 20 reviews Play server-renders; use this to page past them or sort differently. Costs 2 credits.",
        z.object({
          app_id: str("Android package name ('com.spotify.music') or any play.google.com URL carrying one in its id param (1-500 characters)."),
          sort: z.enum(["relevance", "newest", "rating"]).optional().describe("Review ordering (default 'newest'). Closed enum. The cursor encodes the sort, so keep this identical when paging. One of: relevance, newest, rating."),
          count: onum("Reviews to return, 1-200 (default 50); 200 is our cap, not Play's. Play honours more, but a single page that large is megabytes for one credit - page with cursor instead."),
          cursor: ostr("Continuation token from a prior response's next_cursor (1-4000 characters). Opaque and SINGLE-USE, and it encodes the sort as well as the position - send it back with the SAME sort it came from. A cursor past the last review is a 404, not an empty page."),
          hl: ostr("UI language, 2-20 characters (default 'en'). Changes the STOREFRONT, not only the strings. Play silently falls back to English on a value it does not serve."),
          gl: ostr("Country code, 2-10 characters (default 'us'), deciding which storefront's price and availability are returned. Play silently falls back to the US storefront on a country it does not serve."),
        }),
        (i: SdkOpts<typeof client.googlePlay.reviews>) => client.googlePlay.reviews(i)
      )
    );
  }

  if (all || enableSec) {
    tools.push(
      tool(
        "SEC_LOOKUP",
        "Scavio SEC EDGAR Lookup",
        "START HERE. Resolve a company name or ticker (AAPL) to the CIK (0000320193) every other SEC EDGAR endpoint is keyed by. Up to 100 rows, tiered by match quality. Costs 1 credit.",
        z.object({
          query: str("Ticker ('AAPL', 'BRK.B'), company name, or a fragment of one (1-200 characters); each row carries its match tier as 'match'."),
          limit: onum("Rows to return, 1-100. Defaults to 10. Sizes the response; it is not a page param."),
          exchange: z.enum(["NASDAQ", "NYSE", "OTC", "CBOE"]).optional().describe("Restrict to one listing venue; matched case-insensitively, so 'Nasdaq' also works. Filers the SEC lists with no exchange at all are excluded by any value. One of: NASDAQ, NYSE, OTC, CBOE."),
        }),
        (i: SdkOpts<typeof client.sec.lookup>) => client.sec.lookup(i)
      ),
      tool(
        "SEC_COMPANY",
        "Scavio SEC EDGAR Company",
        "SEC filer profile: legal and former names, SIC industry, filer category, EIN, LEI, state of incorporation, fiscal year end, addresses, every ticker with its exchange, and a preview of its 10 most recent filings. Provide cik or ticker. Costs 1 credit.",
        z.object({
          cik: ostr("Filer CIK in any spelling (1-20 characters): 320193, 0000320193 or CIK0000320193. A ticker is accepted here too."),
          ticker: ostr("Ticker symbol (1-20 characters), dotted or dashed (BRK.B / BRK-B). Wins over cik when both are given."),
        }),
        (i: SdkOpts<typeof client.sec.company>) => client.sec.company(i)
      ),
      tool(
        "SEC_FILINGS",
        "Scavio SEC EDGAR Filings",
        "A page of one filer's filings: accession number, form and root form, filing and period dates, 8-K item codes, direct links to the primary document, filing index and attachment directory. Up to 500 per page. Provide cik or ticker. Costs 1 credit.",
        z.object({
          cik: ostr("Filer CIK, zero-padded or bare (1-20 characters). A ticker is accepted here too."),
          ticker: ostr("Ticker symbol (1-20 characters), as an alternative to cik."),
          form: z.array(z.string()).optional().describe("Form types to keep: '10-K', ['10-K', '10-Q'] or the comma-joined '10-K,8-K'; each value 1-50 characters, at most 25 values. Matched against the form AND its root form, so 10-K also returns 10-K/A amendments; ask for '10-K/A' to get only amendments."),
          date_from: ostr("Earliest filing date, inclusive (YYYY-MM-DD)."),
          date_to: ostr("Latest filing date, inclusive (YYYY-MM-DD)."),
          page: onum("Results page, 1-based; page size is whatever limit is set to. No upper bound."),
          limit: onum("Filings per page, 1-500. Defaults to 50."),
          include_history: obool("Also fetch the archived filing history beyond EDGAR's 'recent' block, which is not a fixed window (a decade for a quiet filer, about a year for a prolific one). Off by default; at most 10 archived shards are fetched, history_truncated says when a filer had more, and it is still 1 credit."),
        }),
        (i: SdkOpts<typeof client.sec.filings>) => client.sec.filings(i)
      ),
      tool(
        "SEC_CONCEPT",
        "Scavio SEC EDGAR Concept",
        "Every value a filer reported for one XBRL concept, newest period first, with the form and filing each number came from. Restatements are kept, not collapsed. Up to 2000 rows. Provide cik or ticker. Costs 1 credit.",
        z.object({
          concept: str("XBRL concept tag, CASE-SENSITIVE (1-120 characters, ^[A-Za-z][A-Za-z0-9]*$): 'NetIncomeLoss' matches, 'netincomeloss' is a 404 upstream. Use facts() to list what a filer actually reports."),
          cik: ostr("Filer CIK, zero-padded or bare (1-20 characters). A ticker is accepted here too."),
          ticker: ostr("Ticker symbol (1-20 characters), as an alternative to cik."),
          taxonomy: ostr("Reporting taxonomy (1-40 characters, ^[A-Za-z][A-Za-z0-9-]*$): us-gaap, dei, ifrs-full or srt. Defaults to 'us-gaap'."),
          unit: ostr("Unit of measure to keep (1-40 characters), e.g. 'USD' vs 'USD/shares'."),
          form: ostr("Form to keep (1-50 characters). EXACT match here, unlike filings(), so '10-K' excludes 10-K/A."),
          limit: onum("Rows to return, 1-2000. Defaults to 250. Sizes the response; it is not a page param."),
        }),
        (i: SdkOpts<typeof client.sec.concept>) => client.sec.concept(i)
      ),
      tool(
        "SEC_FACTS",
        "Scavio SEC EDGAR Facts",
        "The index of every XBRL concept a filer reports - tag, label, description, units and most recent value - across us-gaap, dei and any other taxonomy it uses. This is how you find what to ask concept() for. Up to 2000 rows. Provide cik or ticker. Costs 1 credit.",
        z.object({
          cik: ostr("Filer CIK, zero-padded or bare (1-20 characters). A ticker is accepted here too."),
          ticker: ostr("Ticker symbol (1-20 characters), as an alternative to cik."),
          taxonomy: ostr("Restrict to one taxonomy (1-40 characters), e.g. 'us-gaap' or 'dei'."),
          query: ostr("Case-insensitive substring matched against the tag name and label (1-200 characters)."),
          limit: onum("Rows to return, 1-2000. Defaults to 250. Sizes the response; it is not a page param."),
        }),
        (i: SdkOpts<typeof client.sec.facts>) => client.sec.facts(i)
      ),
      tool(
        "SEC_SEARCH",
        "Scavio SEC EDGAR Search",
        "EDGAR full-text search, coverage starting 2001: each hit is the matching DOCUMENT with its URL, form, filing date and filer identity, plus facets by company, form, industry and state. 100 documents per page, last page is 100. Costs 1 credit.",
        z.object({
          query: ostr("Full-text query over filing documents (1-500 characters); a quoted phrase is matched exactly, bare words as a bag of terms. Optional - a cik, ticker, form or date filter on its own is a valid search."),
          cik: z.array(z.string()).optional().describe("Restrict to one or more filers by CIK: a single value, a list, or a comma-joined string; each 1-20 characters, at most 25 values. Tickers are accepted here too."),
          ticker: z.array(z.string()).optional().describe("Restrict to one or more filers by ticker symbol: a single value, a list, or a comma-joined string; each 1-20 characters, at most 25 values."),
          form: z.array(z.string()).optional().describe("Form types to keep: '8-K', ['10-K', '10-Q'] or the comma-joined '10-K,10-Q'; each 1-50 characters, at most 25 values."),
          date_from: ostr("Earliest filing date, inclusive (YYYY-MM-DD). Full-text coverage starts in 2001."),
          date_to: ostr("Latest filing date, inclusive (YYYY-MM-DD)."),
          location: z.array(z.string()).optional().describe("Filer business-address locations as EDGAR's own 2-character codes (CA, NY, and its alphanumeric codes for foreign jurisdictions): a single value, a list, or a comma-joined string; at most 25 values."),
          sort: z.enum(["relevance", "newest", "oldest"]).optional().describe("Result ordering. Defaults to the index's own relevance ranking. One of: relevance, newest, oldest."),
          page: onum("Results page, 1-based, 1-100, 100 documents per page. The SEC's index refuses a result window past 10,000, so 100 is the last page for any query."),
        }),
        (i: SdkOpts<typeof client.sec.search>) => client.sec.search(i)
      )
    );
  }

  if (all || enableRedfin) {
    tools.push(
      tool(
        "REDFIN_SEARCH",
        "Scavio Redfin Search",
        "Redfin listings: price, price per sqft, beds, baths, living area, lot size, year built, coordinates, listing remarks and full photo galleries, for sale, sold or for rent. Up to 350 per page. Provide location, or region_id together with region_type. Costs 1 credit.",
        z.object({
          location: ostr("A redfin.com region URL (/city/, /neighborhood/, /county/, /zipcode/) or a bare 5-digit ZIP (1-500 characters). CITY NAMES ARE NOT ACCEPTED - Redfin's own name lookup is blocked to us; use region_id + region_type instead."),
          region_id: onum("Redfin internal region id (>= 1), used together with region_type. NOT a ZIP code - the two are different number spaces and a ZIP here resolves to another city rather than failing."),
          region_type: z.union([z.literal(1), z.literal(2), z.literal(5), z.literal(6)]).optional().describe("Region kind that region_id belongs to: 1 neighborhood, 2 ZIP, 5 county, 6 city. Must be sent together with region_id or both are ignored in favour of location."),
          listing_status: z.enum(["for_sale", "sold", "for_rent"]).optional().describe("Market to search. Defaults to 'for_sale'. One of: for_sale, sold, for_rent."),
          sold_within_days: onum("Sold within the last N days (>= 1). REJECTED unless listing_status='sold', where it defaults to 90."),
          page: onum("Results page, 1-based; page size is whatever limit is set to. No upper bound."),
          limit: onum("Listings per page, 1-350. Defaults to 100."),
          sort: z.enum(["recommended", "price_low", "price_high", "newest", "oldest", "sqft_low", "sqft_high", "price_per_sqft_low", "price_per_sqft_high"]).optional().describe("Result sort order. Defaults to 'recommended', Redfin's own ranking. One of: recommended, price_low, price_high, newest, oldest, sqft_low, sqft_high, price_per_sqft_low, price_per_sqft_high."),
          min_price: onum("Minimum price, inclusive (>= 0). Monthly rent when listing_status='for_rent'."),
          max_price: onum("Maximum price, inclusive (>= 0). Monthly rent when listing_status='for_rent'."),
          beds_min: onum("Minimum bedrooms (whole number >= 0); fractional values are rejected."),
          beds_max: onum("Maximum bedrooms (whole number >= 0); fractional values are rejected."),
          baths_min: onum("Minimum bathrooms (whole number >= 0). WHOLE BATHS ONLY - 1.5 is rejected rather than silently truncated to 1. There is no baths_max."),
          sqft_min: onum("Minimum living area in square feet (whole number >= 0)."),
          sqft_max: onum("Maximum living area in square feet (whole number >= 0)."),
          lot_size_min: onum("Minimum lot size in square feet (whole number >= 0). There is no lot_size_max."),
          year_built_min: onum("Earliest year built (whole number >= 0)."),
          year_built_max: onum("Latest year built (whole number >= 0)."),
          max_hoa: onum("Maximum monthly HOA fee in dollars (>= 0)."),
          property_type: z.enum(["house", "condo", "townhouse", "multi_family", "land", "other", "co_op"]).optional().describe("Restrict to one property type. One of: house, condo, townhouse, multi_family, land, other, co_op."),
          has_pool: obool("Only listings with a pool."),
          max_days_on_market: onum("Listed at most N days ago (whole number >= 0). Cannot be combined with min_days_on_market - Redfin expresses both bounds through one param."),
          min_days_on_market: onum("Listed at least N days ago (whole number >= 0). Cannot be combined with max_days_on_market."),
        }),
        (i: SdkOpts<typeof client.redfin.search>) => client.redfin.search(i)
      ),
      tool(
        "REDFIN_PROPERTY",
        "Scavio Redfin Property",
        "One Redfin listing in full: price, Redfin Estimate and rental estimate, complete MLS fact sheet, price and tax history, listing agents, open houses, schools, climate risk, walkability, sun exposure, monthly weather, permits, zoning, comparable sales and photos. Costs 1 credit.",
        z.object({
          property_id: str("Redfin property id, or any redfin.com listing URL carrying one (1-500 characters)."),
        }),
        (i: SdkOpts<typeof client.redfin.property>) => client.redfin.property(i)
      ),
      tool(
        "REDFIN_MARKET",
        "Scavio Redfin Market",
        "Redfin housing-market stats for a region: median list and sale price, price per sqft, sale-to-list ratio, average offers and days on market, YoY movement, 0-100 compete score, live inventory by property type and by bedroom count, and Redfin agent presence. Provide location, or region_id together with region_type. Costs 1 credit.",
        z.object({
          location: ostr("A redfin.com region URL (/city/, /neighborhood/, /county/, /zipcode/) or a bare 5-digit ZIP (1-500 characters). City names are not accepted."),
          region_id: onum("Redfin internal region id (>= 1), used together with region_type. Not a ZIP code."),
          region_type: z.union([z.literal(1), z.literal(2), z.literal(5), z.literal(6)]).optional().describe("Region kind that region_id belongs to: 1 neighborhood, 2 ZIP, 5 county, 6 city. Must be sent together with region_id or both are ignored in favour of location."),
        }),
        (i: SdkOpts<typeof client.redfin.market>) => client.redfin.market(i)
      )
    );
  }

  if (all || enableCompaniesHouse) {
    tools.push(
      tool(
        "COMPANIES_HOUSE_SEARCH",
        "Scavio Companies House Search",
        "START HERE. Search the UK register by name and get the company_number every other Companies House endpoint is keyed by, plus status, incorporation or dissolution date, registered office and matched former names. 20 per page, last page is 50. Costs 1 credit.",
        z.object({
          query: str("Company name or fragment (1-200 characters, non-blank). Matches CURRENT AND FORMER names."),
          page: onum("Results page, 1-based, 1-50, 20 results per page. Defaults to 1. The register serves only a 1000-result window per term whatever hit count it prints, and answers page 51 with HTTP 416."),
        }),
        (i: SdkOpts<typeof client.companiesHouse.search>) => client.companiesHouse.search(i)
      ),
      tool(
        "COMPANIES_HOUSE_COMPANY",
        "Scavio Companies House Company",
        "Full UK register entry: status, type, incorporation and dissolution dates, registered office, SIC codes, previous names, accounts and confirmation-statement due dates with overdue flags, and whether it has charges, insolvency history, officers or UK establishments. Costs 1 credit.",
        z.object({
          company_number: str("UK company number (1-20 characters), zero-padded and upper-cased for you, so '445790' and 'sc090312' both work. Registry prefixes supported: SC, NI, OC, SO, NC, FC, BR, CE."),
        }),
        (i: SdkOpts<typeof client.companiesHouse.company>) => client.companiesHouse.company(i)
      ),
      tool(
        "COMPANIES_HOUSE_OFFICERS",
        "Scavio Companies House Officers",
        "UK company officers, current and resigned, 35 per page: name, role, appointment and resignation dates, correspondence address, nationality, country of residence, month-and-year date of birth and identity-verification status. Costs 1 credit.",
        z.object({
          company_number: str("UK company number (1-20 characters), zero-padded and upper-cased for you."),
          page: onum("Results page, 1-based, 35 per page. Defaults to 1. No upper bound: past the last page the register answers an ordinary 200 with an empty list, identical to a company with no officers."),
        }),
        (i: SdkOpts<typeof client.companiesHouse.officers>) => client.companiesHouse.officers(i)
      ),
      tool(
        "COMPANIES_HOUSE_FILING_HISTORY",
        "Scavio Companies House Filing History",
        "UK filings, most recent first: date, filing type code (AA, CS01, SH03), description, register annotations and child documents, and a link to the filed PDF with its page count. A filing the register has not finished processing carries a processing_note instead of a document. Costs 1 credit.",
        z.object({
          company_number: str("UK company number (1-20 characters), zero-padded and upper-cased for you."),
          page: onum("Results page, 1-based. Defaults to 1. No upper bound: past the last page the register answers an ordinary 200 with an empty list."),
        }),
        (i: SdkOpts<typeof client.companiesHouse.filingHistory>) => client.companiesHouse.filingHistory(i)
      )
    );
  }

  if (all || enableG2) {
    tools.push(
      tool(
        "G2_SEARCH",
        "Scavio G2 Search",
        "Search G2, the B2B software review site, for products: star rating, review count, vendor, categories, seller description and logo, with product_id and slug on every row. Up to 100 results per page (server default 20) and page-paginated; total_results is G2's Products-tab headline and caps at 10000, while total_by_type splits the query across products, sellers, categories and discussions. Provide query or url. Costs 5 credits.",
        z.object({
          query: ostr("Search term (1-200 characters). Provide this or url."),
          page: onum("1-based page number; page size follows limit (server default 20). G2 keeps paginating well past its own widget's page links."),
          limit: onum("Results per page (1-100; server default 20). The 100 ceiling is ours, to keep a single request inside the 60s deadline; G2 itself paginates at any size."),
          sort: z.enum(["relevance", "popular", "alphabetical", "rating"]).optional().describe("Result sort order (server default 'relevance'). Closed enum: G2 silently accepts an unknown sort and answers 200 with an unstated ordering. One of: relevance, popular, alphabetical, rating."),
          rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional().describe("Only products at or above this star rating (1-5, sent as an integer). Omit for no rating floor. One of: 1, 2, 3, 4, 5."),
          url: ostr("Full g2.com/search URL, as an alternative to query (1-1000 characters; the host is checked by the transport)."),
        }),
        (i: SdkOpts<typeof client.g2.search>) => client.g2.search(i)
      ),
      tool(
        "G2_PRODUCT",
        "Scavio G2 Product",
        "Full G2 product profile: rating with per-star histogram, review count, vendor, description and seller website, pricing editions with parsed amounts, feature groups, categories and breadcrumbs, supported languages, integrations, alternatives, head-to-head comparisons, media, community discussions and G2's AI-derived pros and cons. Carries NO review text at all -- G2 loads review bodies in a separate frame, so call reviews() for those. Provide product_id or url. Costs 5 credits.",
        z.object({
          product_id: ostr("G2 product slug ('notion') or the numeric G2 id ('82623') as a string (1-200 characters); both resolve on the same upstream path."),
          url: ostr("Full g2.com product URL, as an alternative to product_id (1-1000 characters)."),
        }),
        (i: SdkOpts<typeof client.g2.product>) => client.g2.product(i)
      ),
      tool(
        "G2_REVIEWS",
        "Scavio G2 Reviews",
        "A page of G2 reviews: rating, title, likes and dislikes, problems solved, reviewer job title, industry and company size, validated and incentivized flags -- plus what the profile page has no form of: exact per-star counts, pros and cons with per-theme counts, and company-size, role, industry, region and category facets with counts. Fixed at 10 reviews per page and paginates well past the 10 pages G2's own widget links to. Provide product_id or url. Costs 5 credits.",
        z.object({
          product_id: ostr("G2 product slug or numeric G2 id as a string (1-200 characters)."),
          url: ostr("Full g2.com reviews URL, as an alternative to product_id (1-1000 characters)."),
          page: onum("1-based page number; fixed at 10 reviews per page."),
          sort: z.enum(["relevance", "newest", "most_helpful", "rating_high", "rating_low"]).optional().describe("Review sort order (server default 'relevance'). Closed enum: an unknown sort is silently accepted upstream and never runs. One of: relevance, newest, most_helpful, rating_high, rating_low."),
          rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional().describe("Only reviews in this star bucket (1-5, sent as an integer). Buckets are half- star-inclusive: 1 returns 0, 0.5 and 1-star reviews. One of: 1, 2, 3, 4, 5."),
          company_size: z.enum(["small_business", "mid_market", "enterprise"]).optional().describe("Reviewer company size: small_business is 50 employees or fewer, mid_market 51-1000, enterprise over 1000. Closed enum -- an unknown value matches nothing and returns a billed 'Reviews (0)'."),
          role: z.enum(["user", "administrator", "executive_sponsor", "internal_consultant", "consultant", "agency", "industry_analyst"]).optional().describe("Reviewer role. Closed enum -- an unknown value matches nothing rather than erroring. One of: user, administrator, executive_sponsor, internal_consultant, consultant, agency, industry_analyst."),
          region: z.enum(["north_america", "europe", "asia", "latin_america", "anz", "middle_east", "africa"]).optional().describe("Reviewer region. Closed enum -- an unknown value matches nothing rather than erroring. One of: north_america, europe, asia, latin_america, anz, middle_east, africa."),
          query: ostr("Full-text search within this product's reviews (1-200 characters); narrows the review list AND every facet count."),
        }),
        (i: SdkOpts<typeof client.g2.reviews>) => client.g2.reviews(i)
      )
    );
  }

  if (all || enableCapterra) {
    tools.push(
      tool(
        "CAPTERRA_SEARCH",
        "Scavio Capterra Search",
        "Search Capterra, the B2B software review site: 20 ranked products with name, vendor description, rating, review count, logo and paid-placement flag, each row carrying product_id and slug. The result set is fixed at 20 and does NOT paginate -- Capterra serves identical rows for page 2, so there is deliberately no page parameter. Provide query or url. Costs 2 credits.",
        z.object({
          query: ostr("Search term (1-200 characters). Required in practice: a term-less Capterra search serves a fixed popular-products list unrelated to the caller."),
          url: ostr("Full capterra.com search URL, as an alternative to query (1-1000 characters; the transport also accepts capterra.co.uk and capterra.com.br hosts)."),
        }),
        (i: SdkOpts<typeof client.capterra.search>) => client.capterra.search(i)
      ),
      tool(
        "CAPTERRA_PRODUCT",
        "Scavio Capterra Product",
        "Full Capterra profile: rating with per-star histogram and the four scored criteria, likelihood to recommend, review sentiment and topics, the complete pricing table with every plan and its features, every rated feature and integration, AI-derived pros and cons with the quoted review, FAQs, screenshots, badges and awards, competitor comparisons and alternatives, and the buyer profile by company size, industry and job function -- PLUS the 25 most recent reviews at no extra cost. vendor is always null here: Capterra does not publish it as structured data on the product page. Provide product_id or url. Costs 2 credits.",
        z.object({
          product_id: ostr("The number in a Capterra product path such as /p/186596/Notion/ (1-50 characters). Must be a STRING -- a JSON number is rejected."),
          slug: ostr("Product slug (1-200 characters). Cosmetic on this endpoint -- a wrong slug still returns the right profile -- but load-bearing on reviews()."),
          url: ostr("Full Capterra product URL, as an alternative to product_id (1-1000 characters)."),
        }),
        (i: SdkOpts<typeof client.capterra.product>) => client.capterra.product(i)
      ),
      tool(
        "CAPTERRA_REVIEWS",
        "Scavio Capterra Reviews",
        "A page of Capterra reviews: overall score plus five per-criterion scores, title, pros, cons, advice, usage duration, incentivized flag, alternatives considered and what they switched from, reviewer job title, industry and company size, and the vendor response -- plus a competitor list richer than the profile's, each alternative with its own rating histogram and starting price. 25 reviews per page, capped at page 100. Page 1 already rides along inside product(), so use this to page past it. Provide product_id or url. Costs 2 credits.",
        z.object({
          product_id: ostr("Capterra product id as a string (1-50 characters)."),
          slug: ostr("Product slug (1-200 characters). LOAD-BEARING here: it is case-sensitive upstream and a wrong one silently serves page one under a billed 200. Pass back the slug from search() or product()."),
          url: ostr("Full Capterra reviews URL, as an alternative to product_id (1-1000 characters). Passing back reviews_url from product() is the reliable way to page."),
          page: onum("1-based page number (1-100); 25 reviews per page. 100 is a hard cap whatever the review count says -- past it Capterra answers 200 with page one."),
        }),
        (i: SdkOpts<typeof client.capterra.reviews>) => client.capterra.reviews(i)
      )
    );
  }

  if (all || enableGoogleAds) {
    tools.push(
      tool(
        "GOOGLE_ADS_ADVERTISERS",
        "Scavio Google Ads Transparency Advertisers",
        "Resolve a brand name or domain to the advertiser_id that search() and creative() are keyed by. Returns two row kinds in one list: 'advertiser' rows carrying the id, verified name, verification country and total ad count as a range, and 'domain' rows carrying a website. A name query returns both kinds; a domain-shaped query returns domains only. Autocomplete-backed, roughly 20 rows per arm, and it does not paginate. Costs 1 credit.",
        z.object({
          query: str("Brand name or domain to resolve (1-200 characters)."),
          region: ostr("ISO 3166-1 alpha-2 country ('US', 'GB', 'DE') or a Google geo criteria id as a string (2-12 characters). Default: no region filter."),
          limit: onum("Rows per arm (1-20; server default 10). Advertisers and domains are capped separately, so a name query can return up to twice this many rows."),
        }),
        (i: SdkOpts<typeof client.googleAds.advertisers>) => client.googleAds.advertisers(i)
      ),
      tool(
        "GOOGLE_ADS_SEARCH",
        "Scavio Google Ads Transparency Search",
        "Every ad Google Ads Transparency holds for one advertiser: the creative (archived image, rich-media bundle, Google's renderer link, dimensions), advertiser id and name, format, first and last seen dates and days actually run, plus total_ads_min and total_ads_max -- Google publishes the advertiser's ad total as a range, never an exact figure. Up to 100 ads per page (server default 40); paginate by sending next_cursor back as cursor alongside the SAME filters. Provide domain or advertiser_id. Costs 1 credit.",
        z.object({
          domain: ostr("Advertiser website (1-253 characters): bare host, www host or full URL, reduced to the registrable host. The only way to get `domain` back on each row."),
          advertiser_id: ostr("Google advertiser id, e.g. 'AR16735076323512287233' (3-40 characters). The shape is checked before any request, so a typo costs no credits. Querying by id drops `domain` from every row."),
          region: ostr("ISO 3166-1 alpha-2 country ('US', 'GB', 'DE') or a Google geo criteria id as a string (2-12 characters). Scopes the deep links on every row, and the same advertiser can share zero creatives between two countries. Default: worldwide."),
          format: z.enum(["text", "image", "video"]).optional().describe("Creative format. The three sets are disjoint -- an advertiser's text, image and video ads share no creatives. Default: all formats."),
          platform: z.enum(["play", "maps", "search", "shopping", "youtube"]).optional().describe("Google surface the ad ran on. Default: all surfaces. One of: play, maps, search, shopping, youtube."),
          topic: z.enum(["all", "political"]).optional().describe("Ad topic (server default 'all'). One of: all, political."),
          limit: onum("Ads per page (1-100; server default 40). 100 is a hard upstream ceiling, not our policy: Google answers a larger request with zero rows rather than an error."),
          cursor: ostr("next_cursor from the previous response (1-4000 characters), 100 ads per page. Re-send the same filters alongside it; next_cursor is null once exhausted."),
        }),
        (i: SdkOpts<typeof client.googleAds.search>) => client.googleAds.search(i)
      ),
      tool(
        "GOOGLE_ADS_CREATIVE",
        "Scavio Google Ads Transparency Creative",
        "One creative in full, and the only endpoint carrying its history: every size variation of the asset, the impression bucket, the per-region breakdown with first and last shown dates and a per-surface impression split inside each region, the format, Google's category label and the funder disclosure on political ads. Impressions and first_shown are EEA-only (DSA-compelled) and come back null for US creatives, and an impression bucket may carry only a lower or only an upper bound. Costs 1 credit.",
        z.object({
          advertiser_id: str("Google advertiser id, e.g. 'AR16735076323512287233' (3-40 characters)."),
          creative_id: str("Creative id (3-40 characters). It must belong to the advertiser_id sent with it -- the lookup is keyed by the pair and a mismatched pair is a 404."),
        }),
        (i: SdkOpts<typeof client.googleAds.creative>) => client.googleAds.creative(i)
      )
    );
  }

  if (all || enableMetaAds) {
    tools.push(
      tool(
        "META_ADS_SEARCH",
        "Scavio Meta Ad Library Search",
        "Search the Meta Ad Library by keyword: 30 ads on page 1 with the full creative -- page name, ad copy, headline, CTA, images and videos, the platforms each ran on and its run dates -- then 10 ads per cursor page, walking has_next_page to the end of the query. total_results caps at 50000 with total_is_capped true, because Meta only reports '>50,000'; never present it as an exact count. Every page costs 1 credit.",
        z.object({
          query: str("Keyword to search the ad library for (1-200 characters)."),
          country: ostr("Ad library country as an exactly 2-character ISO 3166-1 alpha-2 code (server default 'US')."),
          active_status: z.enum(["all", "active", "inactive"]).optional().describe("Whether the ad is still running (server default 'all'). One of: all, active, inactive."),
          ad_type: z.enum(["all", "political_and_issue_ads"]).optional().describe("Set 'political_and_issue_ads' to expose spend, reach, impressions and the paid-for-by disclosure; commercial ads leave all four null (server default 'all')."),
          media_type: z.enum(["all", "image", "video", "meme", "image_and_meme", "none"]).optional().describe("Creative media filter. Default: no media filter. One of: all, image, video, meme, image_and_meme, none."),
          search_type: z.enum(["keyword_unordered", "keyword_exact_phrase"]).optional().describe("How the query is matched (server default 'keyword_unordered'). One of: keyword_unordered, keyword_exact_phrase."),
          cursor: ostr("next_cursor from the previous response: page 1 is 30 ads, every cursor page is 10. The cursor is a self-contained blob, so ALL other filters are ignored when it is present."),
        }),
        (i: SdkOpts<typeof client.metaAds.search>) => client.metaAds.search(i)
      ),
      tool(
        "META_ADS_ADVERTISER",
        "Scavio Meta Ad Library Advertiser",
        "Every ad a Facebook Page is running, by numeric page id: 30 ads on page 1 with the same creative detail as search(), then 10 ads per cursor page, walking has_next_page to the end of the advertiser. Every page costs 1 credit.",
        z.object({
          page_id: str("The advertiser's numeric Facebook Page id (3-25 digits, as a string)."),
          country: ostr("Ad library country as an exactly 2-character ISO 3166-1 alpha-2 code (server default 'US')."),
          active_status: z.enum(["all", "active", "inactive"]).optional().describe("Whether the ad is still running (server default 'all'). One of: all, active, inactive."),
          ad_type: z.enum(["all", "political_and_issue_ads"]).optional().describe("Set 'political_and_issue_ads' to expose spend, reach, impressions and the paid-for-by disclosure; commercial ads leave all four null (server default 'all')."),
          media_type: z.enum(["all", "image", "video", "meme", "image_and_meme", "none"]).optional().describe("Creative media filter. Default: no media filter. One of: all, image, video, meme, image_and_meme, none."),
          cursor: ostr("next_cursor from the previous response: page 1 is 30 ads, every cursor page is 10. ALL other filters are ignored when it is present."),
        }),
        (i: SdkOpts<typeof client.metaAds.advertiser>) => client.metaAds.advertiser(i)
      ),
      tool(
        "META_ADS_AD",
        "Scavio Meta Ad Library Ad",
        "One Meta ad in full by archive id: creative, advertiser, run dates, the platforms it ran on, and the political disclosure when the ad carries one. Commercial ads leave spend, reach and impressions null. Costs 1 credit.",
        z.object({
          ad_archive_id: str("Meta ad archive id (3-25 digits, as a string)."),
        }),
        (i: SdkOpts<typeof client.metaAds.ad>) => client.metaAds.ad(i)
      )
    );
  }

  if (all || enableExtract) {
    tools.push(
      tool(
        "EXTRACT",
        "Scavio Extract",
        "Read any URL and get the page back as raw HTML, readability Markdown or plain text: { url, format, mode, content, content_length }. Tier-priced by mode -- normal and advanced cost 1 credit, ultra costs 2 -- and only a successful extraction is billed, so a dead link, bot wall or timeout costs nothing.",
        z.object({
          url: str("Page to read (1-2048 characters). http(s) only; a bare host is upgraded to https, and loopback, private, link-local and metadata hosts are rejected with a 400."),
          format: z.enum(["html", "markdown", "text"]).optional().describe("Output format: 'html' is the raw page, 'markdown' a readability extraction, 'text' that markdown flattened to plain text (server default 'markdown')."),
          mode: z.enum(["normal", "advanced", "ultra"]).optional().describe("Fetch tier, and the price-bearing parameter: 'normal' is the standard fetch (1 credit), 'advanced' renders JavaScript-built pages (1 credit), 'ultra' reaches the hardest pages (2 credits). Server default 'normal'."),
        }),
        (i: SdkOpts<typeof client.extract>) => client.extract(i)
      )
    );
  }

  if (all || enableCrawl) {
    const crawlStatus = (id: string, q: JobQuery) => client.extract.crawlStatus(id, q);
    const batchStatus = (id: string, q: JobQuery) => client.extract.batchStatus(id, q);
    tools.push(
      tool(
        "MAP_WEBSITE",
        "Scavio Map Website",
        "List a website's page URLs, gathered from its sitemaps and its start page, deduplicated, filtered by path or search words and limited: { url, links: [{ url, source, lastmod }], total_found, returned, truncated }. Pages the site's robots.txt disallows are left out. Use it to find the right pages before extracting or crawling. Costs 1 credit in normal mode; advanced costs up to 2 credits and ultra up to 10, priced by what the call needed.",
        z.object({
          url: str("The site to map. A bare host is upgraded to https."),
          search: ostr("Only return URLs containing every word of this text (case-insensitive)."),
          limit: z.number().int().min(1).max(5000).optional().describe("Maximum links to return, 1-5000. Default 1000 (or the plan's limit if lower: Free 500, PAYG 1,000, paid plans 5,000)."),
          sitemap: z.enum(["include", "only", "skip"]).optional().describe("'include' combines the site's sitemaps with the start page's links (default); 'only' uses sitemaps alone; 'skip' uses page links alone."),
          include_subdomains: obool("Also return URLs on subdomains of the site (default false)."),
          include_paths: z.array(z.string()).optional().describe("Keep only URLs matching these. " + PATHS_DESCRIPTION),
          exclude_paths: z.array(z.string()).optional().describe("Drop URLs matching these. " + PATHS_DESCRIPTION),
          ignore_query_parameters: obool("Treat URLs that differ only by query string as one URL (default true)."),
          mode: jobMode,
        }),
        async (i: SdkOpts<typeof client.extract.map>) =>
          (await client.extract.map(i)) as unknown as Record<string, unknown>
      ),
      tool(
        "CRAWL_WEBSITE",
        "Scavio Crawl Website",
        "Crawl a website from one start URL: same-site pages are discovered and extracted breadth-first within the page, depth and path limits, each returned as Markdown, text or HTML. Pages the site's robots.txt disallows are skipped. Waits up to wait_seconds (default 45) and returns { id, status, pages, credits_used, results, next_cursor }; if status is still queued or running, call scavio_crawl_status with the id later. " + JOB_PRICE,
        z.object({
          url: str("Where the crawl starts. Only pages on the same site are crawled."),
          max_pages: z.number().int().min(1).max(10000).optional().describe("Maximum pages to fetch. Default 100. Plan limits: Free 10, PAYG 100, Project 500, Bootstrap 2,000, Startup 5,000, Growth 10,000."),
          max_depth: z.number().int().min(0).max(10).optional().describe("How many links away from the start page to follow, 0-10 (default 3). 0 fetches only the start page."),
          include_paths: z.array(z.string()).optional().describe("Crawl only paths matching these. " + PATHS_DESCRIPTION),
          exclude_paths: z.array(z.string()).optional().describe("Skip paths matching these. " + PATHS_DESCRIPTION),
          allow_subdomains: obool("Also crawl subdomains of the site (default false)."),
          ignore_query_parameters: obool("Treat URLs that differ only by query string as one page (default true)."),
          sitemap: z.enum(["include", "skip", "only"]).optional().describe("'include' also starts from the site's sitemap (default); 'skip' follows links only; 'only' fetches sitemap pages without following links."),
          format: jobFormat,
          mode: jobMode,
          wait_seconds: jobWait,
          limit: jobLimit,
          include_content: jobIncludeContent,
        }),
        async (input) => {
          const { body, query, wait } = splitJobInput(input);
          const created = (await client.extract.crawl(
            body as SdkOpts<typeof client.extract.crawl>
          )) as unknown as JobPayload;
          const id = created?.data?.id;
          if (!id || wait <= 0) return created;
          return waitForJob(crawlStatus, id, wait, pollIntervalMs, query);
        }
      ),
      tool(
        "CRAWL_STATUS",
        "Scavio Crawl Status",
        "Read a crawl's progress and its page results by job id, paged by cursor: { status, stopped_reason, pages, credits_used, results: [{ url, status, content }], next_cursor }. Results are kept for 3 days after the crawl finishes. Free: reading a job costs 0 credits.",
        jobStatusParams,
        async ({ id, limit, ...q }) =>
          (await crawlStatus(id, { ...q, limit: limit ?? JOB_RESULTS_DEFAULT_LIMIT })) as unknown as Record<string, unknown>
      ),
      tool(
        "BATCH_EXTRACT",
        "Scavio Batch Extract",
        "Extract a list of URLs (up to 1,000, plan-limited) in one job, each returned as Markdown, text or HTML exactly like scavio_extract. Waits up to wait_seconds (default 45) and returns { id, status, pages, credits_used, results, next_cursor }; if status is still queued or running, call scavio_batch_status with the id later. " + JOB_PRICE,
        z.object({
          urls: z.array(z.string()).min(1).max(1000).describe("The pages to extract (duplicates removed). Plan limits: Free 10, PAYG 50, Project 100, Bootstrap 500, Startup and Growth 1,000."),
          format: jobFormat,
          mode: jobMode,
          wait_seconds: jobWait,
          limit: jobLimit,
          include_content: jobIncludeContent,
        }),
        async (input) => {
          const { body, query, wait } = splitJobInput(input);
          const created = (await client.extract.batch(
            body as SdkOpts<typeof client.extract.batch>
          )) as unknown as JobPayload;
          const id = created?.data?.id;
          if (!id || wait <= 0) return created;
          return waitForJob(batchStatus, id, wait, pollIntervalMs, query);
        }
      ),
      tool(
        "BATCH_STATUS",
        "Scavio Batch Status",
        "Read a batch extract's progress and its page results by job id, paged by cursor: { status, pages, credits_used, results: [{ url, status, content }], next_cursor }. Results are kept for 3 days after the batch finishes. Free: reading a job costs 0 credits.",
        jobStatusParams,
        async ({ id, limit, ...q }) =>
          (await batchStatus(id, { ...q, limit: limit ?? JOB_RESULTS_DEFAULT_LIMIT })) as unknown as Record<string, unknown>
      )
    );
  }
  return tools;
}

export default buildScavioTools;
