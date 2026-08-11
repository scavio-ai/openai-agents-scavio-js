# openai-agents-scavio

[Scavio](https://scavio.dev) real-time search tools for the [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) (TypeScript) — **188 tools across 31 platforms and one URL reader**, with one API key.

Google, YouTube, Amazon, Walmart, eBay, Target, Home Depot, Reddit, X, TikTok, TikTok Shop, Instagram, Threads, LinkedIn, Kuaishou, Zillow, Redfin, Booking.com, Airbnb, Tripadvisor, Yelp, Indeed, Glassdoor, the Apple App Store, Google Play, SEC EDGAR, Companies House, G2, Capterra, Google Ads Transparency and the Meta Ad Library — plus `scavio_extract`, which reads any URL as HTML, Markdown or plain text.

Nothing is held back for the MCP server any more: every live Scavio endpoint is a tool in this package.

## Install

```bash
npm install openai-agents-scavio @openai/agents zod
```

Requires `scavio@^0.15.0` — the version that introduced the 21 new platform namespaces and the top-level `extract` method. An older SDK cannot resolve most of the tools below.

## Setup

Get a Scavio API key from the [Scavio Dashboard](https://dashboard.scavio.dev) (new accounts get 50 free credits, no credit card). Set `SCAVIO_API_KEY` or pass `{ apiKey }`.

## Usage

```typescript
import { Agent, run } from "@openai/agents";
import { buildScavioTools } from "openai-agents-scavio";

const agent = new Agent({
  name: "Search Assistant",
  instructions: "Search the web, shopping sites, and social platforms with Scavio.",
  tools: buildScavioTools(), // reads SCAVIO_API_KEY
});

const result = await run(agent, "Find the top budget laptops on Amazon");
console.log(result.finalOutput);
```

### Pick your platforms

188 tools is far more than any one agent should carry. Every platform is gated by
an `enable*` flag, all defaulting to `true`, so disable what you do not need:

```typescript
const tools = buildScavioTools({
  enableGoogle: true,
  enableReddit: true,
  enableExtract: true,
  enableAmazon: false,
  enableWalmart: false,
  enableYoutube: false,
  enableTiktok: false,
  enableInstagram: false,
  // ... and so on for the rest
});
```

Pass `{ all: true }` to register every tool regardless of the individual flags.

| Flag | Tools | Flag | Tools |
|---|---|---|---|
| `enableGoogle` | 14 | `enableAirbnb` | 3 |
| `enableAmazon` | 3 | `enableGlassdoor` | 4 |
| `enableWalmart` | 7 | `enableYelp` | 3 |
| `enableYoutube` | 15 | `enableAppStore` | 3 |
| `enableReddit` | 12 | `enableGooglePlay` | 3 |
| `enableTiktok` | 11 | `enableSec` | 6 |
| `enableTiktokShop` | 8 | `enableRedfin` | 3 |
| `enableInstagram` | 12 | `enableCompaniesHouse` | 4 |
| `enableX` | 11 | `enableG2` | 3 |
| `enableLinkedin` | 9 | `enableCapterra` | 3 |
| `enableThreads` | 6 | `enableGoogleAds` | 3 |
| `enableKuaishou` | 14 | `enableMetaAds` | 3 |
| `enableEbay` | 3 | `enableTarget` | 4 |
| `enableHomeDepot` | 3 | `enableZillow` | 3 |
| `enableBooking` | 3 | `enableTripadvisor` | 4 |
| `enableIndeed` | 4 | `enableExtract` | 1 |

## Tools

Each tool is named `scavio_<platform>_<action>` (`scavio_google_search`,
`scavio_ebay_search`, `scavio_sec_filings`, `scavio_meta_ads_search`), takes a
flat object of scalar arguments, and returns the structured Scavio JSON response.

Every tool's `execute` input is typed as `SdkOpts<typeof client.<ns>.<method>>`,
pulled straight off the SDK method. A zod schema that has drifted from the SDK —
a renamed field, a stale enum value — is a compile error in this package rather
than a 400 at runtime.

`scavio_extract` is the exception to the naming rule: it is a core endpoint
rather than a platform, and it is the one to reach for when the agent has a URL
and needs the page behind it.

```typescript
const tools = buildScavioTools({ enableExtract: true }); // scavio_extract({ url, format, mode })
```

### Start with the resolver on lookup-first platforms

Five platforms are keyed by an id you have to look up first. Give the agent the
resolver alongside the endpoint, or it will guess an id and get a 404:

| Platform | Resolve with | Then call |
|---|---|---|
| SEC EDGAR | `scavio_sec_lookup` (ticker → CIK) | `scavio_sec_filings`, `scavio_sec_facts`, ... |
| Tripadvisor | `scavio_tripadvisor_locations` | `scavio_tripadvisor_search`, `scavio_tripadvisor_reviews` |
| Glassdoor | `scavio_glassdoor_companies` | `scavio_glassdoor_reviews`, `scavio_glassdoor_salaries` |
| Google Ads Transparency | `scavio_google_ads_advertisers` | `scavio_google_ads_search`, `scavio_google_ads_creative` |
| Companies House | `scavio_companies_house_search` | `scavio_companies_house_officers`, ... |

## Credits

Most tools cost 1 credit per call: every Google, Amazon, Reddit, X, TikTok, TikTok
Shop, eBay, Target, Zillow, Redfin, Airbnb, Booking.com, App Store, Glassdoor, SEC
EDGAR, Companies House, Google Ads Transparency and Meta Ad Library tool, plus most
YouTube and LinkedIn ones. The exceptions:

| Tool | Credits |
|---|---|
| Home Depot, Google Play, Tripadvisor, Yelp, Indeed, Capterra (all tools) | 2 |
| `scavio_youtube_search`, `scavio_youtube_shorts` | 2 |
| `scavio_youtube_streams` | 3 |
| `scavio_youtube_transcript` | 8 |
| G2 (all tools) | 5 |
| `scavio_instagram_user_posts` | 2 |
| `scavio_instagram_post`, `scavio_instagram_comment_replies` | 8 |
| every other `scavio_instagram_*` | 10 |
| `scavio_linkedin_person_posts`, `scavio_linkedin_company_posts`, `scavio_linkedin_post_comments`, `scavio_linkedin_search_jobs` | 10 |
| `scavio_linkedin_job` | 30 |

Four surfaces are **body-priced** — the cost depends on what you send, not on
which tool you call:

| Tool | Credits |
|---|---|
| `scavio_walmart_search`, `scavio_walmart_category` | 1 on `domain: "com"` or `"ca"`, 2 on `"com.mx"` |
| `scavio_threads_*` | 2 addressed by `user_id`, 4 by `username` |
| `scavio_kuaishou_*` | per endpoint: 1, 2, 10, or 40 for `scavio_kuaishou_videos_batch` |
| `scavio_extract` | 1 on `mode: "normal"` or `"advanced"`, 2 on `"ultra"` |

Each tool's own description states its price. See [scavio.dev/docs](https://scavio.dev/docs).

## Notes on specific platforms

- **Walmart** — `device`, `delivery_zip` and `store_id` were retired. Sending them
  is not an error: the response carries a `warnings[]` array saying they were
  ignored. `domain` was *not* retired and is the price-bearing parameter.
  `scavio_walmart_offers` returns the buy-box seller only, not the full offer
  list, and `scavio_walmart_seller_products` returns roughly the first 40
  server-rendered items with no pagination at all.
- **Amazon** — `country` (a two-letter marketplace code; the UK is `gb`, not `uk`)
  replaced `domain` in 2026-07, and `sort_by`, `pages`, `category_id`,
  `merchant_id`, `language`, `currency`, `device`, `zip_code` and
  `autoselect_variant` are gone. The marketplace ignored all of them, so they
  were removed rather than kept as silent no-ops. Rank and filter yourself.
- **Google** — v2 only. `/api/v1/google` was sunset on 2026-08-04 and returns 410,
  and the v1 vocabulary (`country_code`, `language`, `page`, `search_type`,
  `light_request`) went with it. `start` is a 0-based result offset, not a page.
- **LinkedIn** — five endpoints (person contact info, company people, company
  jobs, people search, post search) were withdrawn upstream and always return
  410. They are deliberately not tools. Use `scavio_linkedin_search_jobs` with a
  company name instead of the retired per-company job listing.
- **eBay** — `scavio_ebay_seller` is a storefront profile, not a catalogue. To page
  a seller's inventory, call `scavio_ebay_search` with `seller` set and no `query`.

## Also available via MCP

If you would rather not install anything, the same endpoints are served by the
hosted MCP server:

```typescript
import { Agent, MCPServerStreamableHttp } from "@openai/agents";

const server = new MCPServerStreamableHttp({
  url: "https://mcp.scavio.dev/mcp",
  name: "scavio",
  requestInit: { headers: { "x-api-key": process.env.SCAVIO_API_KEY! } },
});

const agent = new Agent({ name: "Search Assistant", mcpServers: [server] });
```

## Links

- Scavio: https://scavio.dev
- Docs: https://scavio.dev/docs/openai-agents
- Dashboard: https://dashboard.scavio.dev
