/**
 * Scavio tools for the OpenAI Agents SDK.
 *
 * Exposes the whole Scavio API - Google, YouTube, Amazon, Walmart, Reddit, TikTok,
 * TikTok Shop, Instagram, X and LinkedIn - as OpenAI Agents SDK tools: 97 tools over
 * the 98 live billable endpoints (/youtube/metadata is a deprecated alias of
 * /youtube/video and is not registered twice). Build the tools with
 * `buildScavioTools()` and pass them to an Agent:
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
  /** Register every tool, ignoring the individual flags. */
  all?: boolean;
}

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
    all = false,
  } = options;

  const client = new Scavio({ apiKey: apiKey ?? process.env.SCAVIO_API_KEY });

  function tool(
    slug: string,
    _name: string,
    description: string,
    parameters: z.ZodObject<any>,
    call: (input: any) => Promise<Record<string, unknown>>
  ) {
    return agentTool({
      name: "scavio_" + slug.toLowerCase(),
      description,
      parameters,
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
          device: ostr("Device to emulate: 'desktop' or 'mobile'."),
          start: onum("Result offset: 0 = page 1, 10 = page 2, up to 990."),
          hl: HL,
          gl: GL,
          google_domain: GOOGLE_DOMAIN,
          location: LOCATION,
          uule: UULE,
          lr: ostr("Language restrict, e.g. 'lang_en'."),
          cr: ostr("Country restrict, e.g. 'countryUS'."),
          safe: ostr("SafeSearch filter; 'active' is the only value."),
          nfpr: obool("Disable spelling correction / auto-fixes when true."),
          filter: ostr("'0' disables the omitted/similar-results filter, '1' keeps it."),
          time_period: ostr("Recent time window: 'last_hour', 'last_day', 'last_week', 'last_month', 'last_year'."),
          resolve_ai_overview: obool("Resolve a deferred AI Overview (server default true)."),
          include_html: obool("Include the raw Google HTML in the response. Large; leave off unless parsing it."),
        }),
        (i) => client.google.search(i)
      ),
      tool(
        "GOOGLE_AI_MODE",
        "Scavio Google AI Mode",
        "Get a Google AI Mode conversational answer with its source references, instead of a plain list of links. Costs 1 credit.",
        z.object({
          query: str("Question or prompt (1-500 characters)."),
          device: ostr("Device to emulate: 'desktop' or 'mobile'."),
          hl: HL,
          gl: GL,
          google_domain: GOOGLE_DOMAIN,
          location: LOCATION,
          uule: UULE,
          safe: ostr("SafeSearch filter; 'active' is the only value."),
          include_html: obool("Include the raw Google HTML in the response."),
        }),
        (i) => client.google.aiMode(i)
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
        (i) => client.google.mapsSearch(i)
      ),
      tool(
        "GOOGLE_MAPS_PLACE",
        "Scavio Google Maps Place",
        "Fetch Google Maps details for one place. Costs 1 credit.",
        z.object({
          place_id: ostr("Place ID (ChIJ...). Provide this or data_cid."),
          data_cid: ostr("Numeric CID. Provide this or place_id."),
        }),
        (i) => client.google.mapsPlace(i)
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
          sort_by: ostr("Sort order: 'relevance', 'newest', 'highest_rating', 'lowest_rating'."),
          hl: HL,
          gl: GL,
          google_domain: GOOGLE_DOMAIN,
        }),
        (i) => client.google.mapsReviews(i)
      ),
      tool(
        "GOOGLE_SHOPPING",
        "Scavio Google Shopping",
        "Search Google Shopping product listings across merchants. Costs 1 credit.",
        z.object({
          query: str("Product search query (1-500 characters)."),
          device: ostr("Device to emulate: 'desktop' or 'mobile'."),
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
        (i) => client.google.shopping(i)
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
          device: ostr("Device to emulate: 'desktop', 'mobile' or 'tablet'."),
          sort_by: ostr("Seller sort order: 'base_price', 'total_price', 'promotion', 'seller_rating'."),
          load_all_stores: obool("Load all available stores."),
          more_stores: obool("Fetch additional stores."),
          hl: HL,
          gl: GL,
          google_domain: GOOGLE_DOMAIN,
          location: LOCATION,
          uule: UULE,
        }),
        (i) => client.google.shoppingProduct(i)
      ),
      tool(
        "GOOGLE_SHOPPING_STORES",
        "Scavio Google Shopping Stores",
        "Fetch more sellers for a Google Shopping product: the pagination leg of scavio_google_shopping_product. Costs 1 credit.",
        z.object({
          catalog_id: str("Durable product catalog id."),
          next_page_token: str("Pagination cursor returned by scavio_google_shopping_product."),
        }),
        (i) => client.google.shoppingStores(i)
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
        (i) => client.google.flights(i)
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
        (i) => client.google.hotels(i)
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
        (i) => client.google.hotelsDetail(i)
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
        (i) => client.google.news(i)
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
          data_type: ostr("Dataset: 'TIMESERIES', 'GEO_MAP', 'GEO_MAP_0', 'RELATED_QUERIES', 'RELATED_TOPICS'."),
          cat: ostr("Category id."),
          gprop: ostr("Google property filter: 'images', 'news', 'youtube', 'froogle'."),
          region: ostr("Resolution for GEO_MAP data: 'COUNTRY', 'REGION', 'DMA', 'CITY'."),
        }),
        (i) => client.google.trends(i)
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
          sort: ostr("Sort order: 'relevance', 'search_volume', 'recency', 'title'."),
          status: ostr("Filter by trend status: 'all' or 'active'."),
        }),
        (i) => client.google.trending(i)
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
        (i) => client.amazon.search(i)
      ),
      tool(
        "AMAZON_PRODUCT",
        "Scavio Amazon Product",
        "Fetch full Amazon product details by ASIN. price is the buy-box price only. Costs 1 credit.",
        z.object({
          asin: str("Amazon Standard Identification Number (ASIN) of the product."),
          country: ostr("Marketplace country code (ISO 3166-1 alpha-2), not a domain: 'us' (default), 'gb' (the UK is gb, not uk), 'ca', 'de', 'fr', 'es', 'it', 'jp', 'in', 'au', 'br', 'mx', 'nl', 'pl', 'se', 'sg', 'ae', 'sa', 'eg', 'cn', 'be', 'tr'. An unknown code falls back to us."),
        }),
        (i) => client.amazon.product(i)
      ),
      tool(
        "AMAZON_OFFERS",
        "Scavio Amazon Offers",
        "List every seller offer for one Amazon ASIN: price, seller, condition, shipping, and which offer holds the buy box. Page 1 only. Costs 1 credit. Use this instead of AMAZON_PRODUCT when comparing sellers or checking who owns the buy box.",
        z.object({
          asin: str("Amazon Standard Identification Number (ASIN) of the product."),
          country: ostr("Marketplace country code (ISO 3166-1 alpha-2), not a domain: 'us' (default), 'gb' (the UK is gb, not uk), 'ca', 'de', 'fr', 'es', 'it', 'jp', 'in', 'au', 'br', 'mx', 'nl', 'pl', 'se', 'sg', 'ae', 'sa', 'eg', 'cn', 'be', 'tr'. An unknown code falls back to us."),
        }),
        (i) => client.amazon.offers(i)
      )
    );
  }

  if (all || enableWalmart) {
    tools.push(
      tool(
        "WALMART_SEARCH",
        "Scavio Walmart Search",
        "Search Walmart for products matching a query. Costs 1 credit.",
        z.object({
          query: str("The product search query."),
          domain: ostr("Walmart domain."),
          device: ostr("Device profile: 'desktop', 'mobile' or 'tablet'."),
          sort_by: ostr("Sort order: 'best_match', 'price_low', 'price_high', 'best_seller'."),
          start_page: onum("First page to return (1-indexed)."),
          min_price: onum("Minimum price filter (USD)."),
          max_price: onum("Maximum price filter (USD)."),
          fulfillment_speed: ostr("Delivery speed: 'today', 'tomorrow', '2_days', 'anytime'."),
          fulfillment_type: ostr("Fulfillment type filter; 'in_store' is the only value."),
          delivery_zip: ostr("Delivery ZIP/postal code."),
          store_id: ostr("Restrict to a store id."),
        }),
        (i) => client.walmart.search(i)
      ),
      tool(
        "WALMART_PRODUCT",
        "Scavio Walmart Product",
        "Fetch full Walmart product details by product id. Costs 1 credit.",
        z.object({
          product_id: str("Walmart product id."),
          domain: ostr("Walmart domain."),
          device: ostr("Device profile: 'desktop', 'mobile' or 'tablet'."),
          delivery_zip: ostr("Delivery ZIP/postal code."),
          store_id: ostr("Restrict to a store id."),
        }),
        (i) => client.walmart.product(i)
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
          upload_date: ostr("Upload date filter, e.g. 'last_hour', 'today', 'this_week', 'this_month', 'this_year'."),
          type: ostr("Result type, e.g. 'video', 'channel', 'playlist', 'movie'."),
          duration: ostr("Duration filter, e.g. 'short', 'medium', 'long'."),
          sort_by: ostr("Sort order: 'relevance', 'date', 'view_count', 'rating'."),
          features: z.array(z.string()).optional().describe("Feature filters, e.g. ['hd', '4k', 'subtitles', 'creative_commons', 'live', '360', '3d', 'hdr', 'vr180']."),
          cursor: ostr("Pagination cursor from a prior response."),
          hd: obool("Restrict to HD videos when true."),
          subtitles: obool("Restrict to videos with subtitles when true."),
          creative_commons: obool("Restrict to Creative Commons videos when true."),
          live: obool("Restrict to live videos when true."),
        }),
        (i) => client.youtube.search(i)
      ),
      tool(
        "YOUTUBE_SHORTS",
        "Scavio YouTube Shorts",
        "Search YouTube Shorts by keyword. Costs 2 credits.",
        z.object({
          query: str("The Shorts search query."),
          sort_by: ostr("Sort order: 'relevance', 'date', 'view_count', 'rating'."),
          cursor: ostr("Pagination cursor."),
        }),
        (i) => client.youtube.shorts(i)
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
        (i) => client.youtube.suggestions(i)
      ),
      tool(
        "YOUTUBE_VIDEO",
        "Scavio YouTube Video",
        "Fetch full details for a YouTube video (title, author, view count, description, captions, chapters). Costs 1 credit.",
        z.object({ video_id: str("YouTube video id or a full watch URL.") }),
        (i) => client.youtube.video(i)
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
        (i) => client.youtube.comments(i)
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
        (i) => client.youtube.commentReplies(i)
      ),
      tool(
        "YOUTUBE_TRANSCRIPT",
        "Scavio YouTube Transcript",
        "Fetch a YouTube video's transcript or timed subtitles. Costs 8 credits, the most expensive YouTube tool.",
        z.object({
          video_id: str("YouTube video id or a full watch URL."),
          language: ostr("Transcript language code (default 'en')."),
          format: ostr("'text' for a plain transcript, 'srt' for timed subtitles."),
        }),
        (i) => client.youtube.transcript(i)
      ),
      tool(
        "YOUTUBE_RELATED",
        "Scavio YouTube Related",
        "List videos related to a YouTube video. Costs 1 credit.",
        z.object({
          video_id: str("YouTube video id or a full watch URL."),
          cursor: ostr("Pagination cursor."),
        }),
        (i) => client.youtube.related(i)
      ),
      tool(
        "YOUTUBE_CHANNEL_SEARCH",
        "Scavio YouTube Channel Search",
        "Search YouTube channels by keyword. Costs 1 credit.",
        z.object({
          query: str("The channel search query."),
          cursor: ostr("Pagination cursor."),
        }),
        (i) => client.youtube.channelSearch(i)
      ),
      tool(
        "YOUTUBE_CHANNEL",
        "Scavio YouTube Channel",
        "Fetch a YouTube channel's details (subscribers, video count, views, links). Costs 1 credit.",
        z.object({ channel_id: str("YouTube channel id, @handle, or channel URL.") }),
        (i) => client.youtube.channel(i)
      ),
      tool(
        "YOUTUBE_CHANNEL_VIDEOS",
        "Scavio YouTube Channel Videos",
        "List a YouTube channel's uploaded videos. Costs 1 credit.",
        z.object({
          channel_id: str("YouTube channel id."),
          cursor: ostr("Pagination cursor."),
        }),
        (i) => client.youtube.channelVideos(i)
      ),
      tool(
        "YOUTUBE_CHANNEL_SHORTS",
        "Scavio YouTube Channel Shorts",
        "List a YouTube channel's Shorts. Costs 1 credit.",
        z.object({
          channel_id: str("YouTube channel id."),
          cursor: ostr("Pagination cursor."),
        }),
        (i) => client.youtube.channelShorts(i)
      ),
      tool(
        "YOUTUBE_CHANNEL_COMMUNITY",
        "Scavio YouTube Channel Community",
        "List a YouTube channel's community posts. Costs 1 credit.",
        z.object({
          channel_id: str("YouTube channel id."),
          cursor: ostr("Pagination cursor."),
        }),
        (i) => client.youtube.channelCommunity(i)
      ),
      tool(
        "YOUTUBE_CHANNEL_RESOLVE",
        "Scavio YouTube Channel Resolve",
        "Resolve a YouTube @handle or channel URL to a channel id. Costs 1 credit.",
        z.object({ channel: str("A channel @handle or channel URL.") }),
        (i) => client.youtube.channelResolve(i)
      ),
      tool(
        "YOUTUBE_STREAMS",
        "Scavio YouTube Streams",
        "Fetch direct playable/downloadable stream URLs for a YouTube video. Costs 3 credits.",
        z.object({ video_id: str("YouTube video id or a full watch URL.") }),
        (i) => client.youtube.streams(i)
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
        (i) => client.reddit.search(i)
      ),
      tool(
        "REDDIT_SEARCH_SUGGESTIONS",
        "Scavio Reddit Search Suggestions",
        "Fetch Reddit search autocomplete suggestions for a seed keyword. Costs 1 credit.",
        z.object({ query: str("The partial search query to expand.") }),
        (i) => client.reddit.searchSuggestions(i)
      ),
      tool(
        "REDDIT_POST",
        "Scavio Reddit Post",
        "Fetch one Reddit post by URL or post id. Costs 1 credit. data is a flat post object (title, text, score, upvote_ratio, num_comments, subreddit, author) and carries no comments: call REDDIT_POST_COMMENTS for those.",
        z.object({
          url: ostr("Full URL of the Reddit post. Provide this or post_id."),
          post_id: ostr("Post fullname (t3_...) or bare id. Provide this or url."),
        }),
        (i) => client.reddit.post(i)
      ),
      tool(
        "REDDIT_POST_COMMENTS",
        "Scavio Reddit Post Comments",
        "List the top-level comments on a Reddit post. Costs 1 credit per page. Each comment carries a reply_cursor for REDDIT_COMMENT_REPLIES; page with data.next_cursor while data.has_more.",
        z.object({
          post_id: str("Post fullname (t3_...) or bare id."),
          sort: ostr("Comment sort order: 'HOT', 'NEW', 'TOP', 'BEST', 'CONTROVERSIAL' (server default 'TOP')."),
          cursor: ostr("Pagination cursor from a prior response."),
        }),
        (i) => client.reddit.postComments(i)
      ),
      tool(
        "REDDIT_COMMENT_REPLIES",
        "Scavio Reddit Comment Replies",
        "List the replies to one Reddit comment. Costs 1 credit per page.",
        z.object({
          post_id: str("Post fullname (t3_...) or bare id."),
          cursor: str("The reply_cursor of a comment from REDDIT_POST_COMMENTS. Required, and not interchangeable with next_cursor."),
          sort: ostr("Comment sort order: 'HOT', 'NEW', 'TOP', 'BEST', 'CONTROVERSIAL' (server default 'TOP')."),
        }),
        (i) => client.reddit.commentReplies(i)
      ),
      tool(
        "REDDIT_SUBREDDIT",
        "Scavio Reddit Subreddit",
        "Fetch a subreddit's metadata: title, description, subscriber count, type, NSFW flag, icon, banner, creation date. Costs 1 credit.",
        z.object({ subreddit: str("Subreddit name, without the r/ prefix.") }),
        (i) => client.reddit.subreddit(i)
      ),
      tool(
        "REDDIT_SUBREDDIT_POSTS",
        "Scavio Reddit Subreddit Posts",
        "List a subreddit's post feed, under data.posts. Costs 1 credit per page.",
        z.object({
          subreddit: str("Subreddit name, without the r/ prefix."),
          sort: ostr("Feed sort order: 'BEST', 'HOT', 'NEW', 'TOP', 'CONTROVERSIAL', 'RISING' (server default 'HOT')."),
          cursor: ostr("Pagination cursor from a prior response."),
        }),
        (i) => client.reddit.subredditPosts(i)
      ),
      tool(
        "REDDIT_USER",
        "Scavio Reddit User",
        "Fetch a redditor's profile: id, name, employee/verified flags, account type, whether they accept private messages. Costs 1 credit.",
        z.object({ username: str("Reddit username, without the u/ prefix.") }),
        (i) => client.reddit.user(i)
      ),
      tool(
        "REDDIT_USER_POSTS",
        "Scavio Reddit User Posts",
        "List a redditor's submitted posts, under data.posts. Costs 1 credit per page.",
        z.object({
          username: str("Reddit username, without the u/ prefix."),
          sort: ostr("Sort order: 'HOT', 'NEW', 'TOP', 'BEST', 'CONTROVERSIAL' (server default 'NEW')."),
          cursor: ostr("Pagination cursor from a prior response."),
        }),
        (i) => client.reddit.userPosts(i)
      ),
      tool(
        "REDDIT_USER_COMMENTS",
        "Scavio Reddit User Comments",
        "List a redditor's comments, under data.comments, each with the post it belongs to. Costs 1 credit per page.",
        z.object({
          username: str("Reddit username, without the u/ prefix."),
          sort: ostr("Sort order: 'HOT', 'NEW', 'TOP', 'BEST', 'CONTROVERSIAL' (server default 'NEW')."),
          cursor: ostr("Pagination cursor from a prior response."),
        }),
        (i) => client.reddit.userComments(i)
      ),
      tool(
        "REDDIT_POPULAR",
        "Scavio Reddit Popular",
        "List the site-wide Reddit popular feed, under data.posts. Costs 1 credit per page.",
        z.object({ cursor: ostr("Pagination cursor from a prior response.") }),
        (i) => client.reddit.popular(i)
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
        (i) => client.tiktok.profile(i)
      ),
      tool(
        "TIKTOK_USER_POSTS",
        "Scavio TikTok User Posts",
        "List a TikTok user's posts by secUid. Costs 1 credit per page.",
        z.object({
          sec_user_id: str("TikTok secUid of the user."),
          cursor: ostr("Pagination cursor, as a string (default '0')."),
          count: onum("Number of posts to return (1-30)."),
          sort_type: ostr("'0' = latest, '1' = popular."),
        }),
        (i) => client.tiktok.userPosts(i)
      ),
      tool(
        "TIKTOK_VIDEO",
        "Scavio TikTok Video",
        "Fetch a TikTok video by id. Costs 1 credit.",
        z.object({ video_id: str("TikTok video id.") }),
        (i) => client.tiktok.video(i)
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
        (i) => client.tiktok.videoComments(i)
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
        (i) => client.tiktok.commentReplies(i)
      ),
      tool(
        "TIKTOK_SEARCH_VIDEOS",
        "Scavio TikTok Search Videos",
        "Search TikTok videos by keyword. Costs 1 credit per page.",
        z.object({
          keyword: str("Search keyword."),
          cursor: ostr("Pagination cursor, as a string (default '0')."),
          count: onum("Number of videos to return (1-30)."),
          sort_type: ostr("'0' = relevance, '1' = most likes."),
          publish_time: ostr("Age filter in days: '0' = all time, '1', '7', '30', '90', '180'."),
        }),
        (i) => client.tiktok.searchVideos(i)
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
        (i) => client.tiktok.searchUsers(i)
      ),
      tool(
        "TIKTOK_HASHTAG",
        "Scavio TikTok Hashtag",
        "Fetch a TikTok hashtag by name or id. Costs 1 credit.",
        z.object({
          hashtag_name: ostr("Hashtag name (without #). Provide this or hashtag_id."),
          hashtag_id: ostr("Hashtag id. Provide this or hashtag_name."),
        }),
        (i) => client.tiktok.hashtag(i)
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
        (i) => client.tiktok.hashtagVideos(i)
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
        (i) => client.tiktok.userFollowers(i)
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
        (i) => client.tiktok.userFollowings(i)
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
        (i) => client.tiktokShop.search(i)
      ),
      tool(
        "TIKTOK_SHOP_SEARCH_SUGGESTIONS",
        "Scavio TikTok Shop Search Suggestions",
        "Fetch TikTok Shop keyword autocomplete and expansion for a partial query. Costs 1 credit. Suggestions are not guaranteed prefix matches: a misspelling returns typo corrections, and results can include brand and shop names.",
        z.object({
          search: str("Partial search keyword (1-100 characters)."),
          region: TIKTOK_SHOP_REGION,
        }),
        (i) => client.tiktokShop.searchSuggestions(i)
      ),
      tool(
        "TIKTOK_SHOP_PRODUCT",
        "Scavio TikTok Shop Product",
        "Fetch full TikTok Shop product detail: description, images, variants with stock, shipping, shop profile, category path and top reviews. Costs 1 credit. Two hard limits: it returns NO price (upstream masks it, so read prices from TIKTOK_SHOP_SEARCH, TIKTOK_SHOP_SHOP_PRODUCTS or TIKTOK_SHOP_CATEGORY_PRODUCTS), and only about 44% of search product ids resolve here. A 404 is a normal outcome, not a transient error: skip that product instead of retrying, and try TIKTOK_SHOP_PRODUCT_REVIEWS, which often works for ids this cannot resolve.",
        z.object({
          product_id: str("TikTok Shop product id (6-25 digits)."),
          region: TIKTOK_SHOP_REGION,
        }),
        (i) => client.tiktokShop.product(i)
      ),
      tool(
        "TIKTOK_SHOP_PRODUCT_REVIEWS",
        "Scavio TikTok Shop Product Reviews",
        "List TikTok Shop product reviews with text, images, star histogram and verified-purchase flags, up to 200 per call. Costs 1 credit per page. total_reviews drifts between calls, so page with has_more rather than computing a page count.",
        z.object({
          product_id: str("TikTok Shop product id (6-25 digits)."),
          page: onum("1-based page number (1-500; server default 1)."),
          page_size: onum("Reviews per page (1-200; server default 20)."),
          sort: ostr("'relevant' (default) returns text-complete, image-heavy reviews; 'recent' is fresher but far more text-sparse."),
          rating: onum("Only reviews with this star rating (1-5)."),
          has_media: obool("Only reviews with a photo or video."),
          verified_only: obool("Only verified purchases. Ignored when has_media is true; upstream allows one filter at a time."),
          region: TIKTOK_SHOP_REGION,
        }),
        (i) => client.tiktokShop.productReviews(i)
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
          region: ostr("Marketplace region. Category listings are served for 'US' (default) and 'GB' only."),
        }),
        (i) => client.tiktokShop.categoryProducts(i)
      ),
      tool(
        "TIKTOK_SHOP_SHOP_PRODUCTS",
        "Scavio TikTok Shop Shop Products",
        "List a TikTok Shop seller's product catalog, 30 per page, with exact prices. Costs 1 credit per page. Shop follower count, location and shop-level rating are not here; call TIKTOK_SHOP_PRODUCT for the full shop profile.",
        z.object({
          shop_id: str("TikTok Shop seller id (also called seller_id elsewhere on TikTok)."),
          cursor: ostr("Opaque cursor from a prior response's next_cursor."),
          region: TIKTOK_SHOP_REGION,
        }),
        (i) => client.tiktokShop.shopProducts(i)
      ),
      tool(
        "TIKTOK_SHOP_RESOLVE",
        "Scavio TikTok Shop Resolve",
        "Resolve any TikTok Shop URL or share link to a product_id or shop_id, ready for the other TikTok Shop tools. Costs 1 credit. Accepts canonical product and store pages, tiktok.com/view links, affiliate share links and vt.tiktok.com short links.",
        z.object({ url: str("A TikTok Shop URL or share link.") }),
        (i) => client.tiktokShop.resolve(i)
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
        (i) => client.instagram.profile(i)
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
        (i) => client.instagram.userPosts(i)
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
        (i) => client.instagram.userReels(i)
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
        (i) => client.instagram.userTagged(i)
      ),
      tool(
        "INSTAGRAM_USER_STORIES",
        "Scavio Instagram User Stories",
        "Fetch an Instagram user's current stories. Costs 10 credits.",
        z.object({
          username: ostr("Instagram username. Provide this or user_id."),
          user_id: ostr("Instagram user id. Provide this or username."),
        }),
        (i) => client.instagram.userStories(i)
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
        (i) => client.instagram.post(i)
      ),
      tool(
        "INSTAGRAM_POST_COMMENTS",
        "Scavio Instagram Post Comments",
        "List comments on an Instagram post by shortcode or URL. Costs 10 credits.",
        z.object({
          shortcode: ostr("Post shortcode. Provide this or url."),
          url: ostr("Post URL. Provide this or shortcode."),
          cursor: ostr("Pagination cursor."),
          sort_order: ostr("Comment sort order: 'popular' or 'newest'."),
        }),
        (i) => client.instagram.postComments(i)
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
        (i) => client.instagram.commentReplies(i)
      ),
      tool(
        "INSTAGRAM_SEARCH_USERS",
        "Scavio Instagram Search Users",
        "Search Instagram users by keyword. Costs 10 credits.",
        z.object({
          keyword: str("Search keyword."),
          cursor: ostr("Pagination cursor."),
        }),
        (i) => client.instagram.searchUsers(i)
      ),
      tool(
        "INSTAGRAM_SEARCH_HASHTAGS",
        "Scavio Instagram Search Hashtags",
        "Search Instagram hashtags by keyword. Costs 10 credits.",
        z.object({
          keyword: str("Search keyword."),
          cursor: ostr("Pagination cursor."),
        }),
        (i) => client.instagram.searchHashtags(i)
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
        (i) => client.instagram.userFollowers(i)
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
        (i) => client.instagram.userFollowings(i)
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
          search_type: ostr("Result category: 'Top' (default), 'Latest', 'People', 'Photos', 'Videos'."),
          cursor: ostr("Pagination cursor from a prior response."),
        }),
        (i) => client.x.search(i)
      ),
      tool(
        "X_TWEET",
        "Scavio X Tweet",
        "Fetch full details for a single tweet: text, timestamp, language, engagement counts, source and reply-to reference. Costs 1 credit.",
        z.object({ tweet_id: str("Tweet id.") }),
        (i) => client.x.tweet(i)
      ),
      tool(
        "X_TWEET_COMMENTS",
        "Scavio X Tweet Comments",
        "List the replies to a tweet, ranked or chronological. Costs 1 credit per page. Page with data.next_cursor while data.has_more.",
        z.object({
          tweet_id: str("Tweet id."),
          rank: ostr("'top' for ranked replies (default) or 'latest' for chronological."),
          cursor: ostr("Pagination cursor from a prior response."),
        }),
        (i) => client.x.tweetComments(i)
      ),
      tool(
        "X_TWEET_RETWEETERS",
        "Scavio X Tweet Retweeters",
        "List the users who retweeted a tweet, under data.retweeters. Costs 1 credit per page.",
        z.object({
          tweet_id: str("Tweet id."),
          cursor: ostr("Pagination cursor from a prior response."),
        }),
        (i) => client.x.tweetRetweeters(i)
      ),
      tool(
        "X_USER",
        "Scavio X User",
        "Fetch an X user's profile: handle, name, description, follower/friends/statuses/media counts, verified flag, avatar, location, website, creation date. Costs 1 credit.",
        z.object({ screen_name: str("An X handle, without the @.") }),
        (i) => client.x.user(i)
      ),
      tool(
        "X_USER_TWEETS",
        "Scavio X User Tweets",
        "List an X user's tweets, under data.timeline, plus data.pinned and data.user. Costs 1 credit per page. There is no has_more here: stop when next_cursor is absent or the timeline comes back empty.",
        z.object({
          screen_name: str("An X handle, without the @."),
          cursor: ostr("Pagination cursor from a prior response."),
        }),
        (i) => client.x.userTweets(i)
      ),
      tool(
        "X_USER_REPLIES",
        "Scavio X User Replies",
        "List an X user's tweets and replies, under data.timeline. Costs 1 credit per page. There is no has_more here: stop when next_cursor is absent or the timeline comes back empty.",
        z.object({
          screen_name: str("An X handle, without the @."),
          cursor: ostr("Pagination cursor from a prior response."),
        }),
        (i) => client.x.userReplies(i)
      ),
      tool(
        "X_USER_MEDIA",
        "Scavio X User Media",
        "List an X user's media tweets (posts with photos or videos), under data.timeline. Costs 1 credit per page. There is no has_more here: stop when next_cursor is absent or the timeline comes back empty.",
        z.object({
          screen_name: str("An X handle, without the @."),
          cursor: ostr("Pagination cursor from a prior response."),
        }),
        (i) => client.x.userMedia(i)
      ),
      tool(
        "X_USER_FOLLOWERS",
        "Scavio X User Followers",
        "List an X user's followers. Costs 1 credit per page. Page with data.next_cursor while data.has_more.",
        z.object({
          screen_name: str("An X handle, without the @."),
          cursor: ostr("Pagination cursor from a prior response."),
        }),
        (i) => client.x.userFollowers(i)
      ),
      tool(
        "X_USER_FOLLOWINGS",
        "Scavio X User Followings",
        "List the accounts an X user follows, under data.following (singular). Costs 1 credit per page. Page with data.next_cursor while data.has_more.",
        z.object({
          screen_name: str("An X handle, without the @."),
          cursor: ostr("Pagination cursor from a prior response."),
        }),
        (i) => client.x.userFollowings(i)
      ),
      tool(
        "X_TRENDING",
        "Scavio X Trending",
        "List trending topics on X for a country. Costs 1 credit.",
        z.object({
          country: ostr("Country name, e.g. 'UnitedStates' (default), 'UnitedKingdom', 'Japan'."),
        }),
        (i) => client.x.trending(i)
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
        (i) => client.linkedin.person(i)
      ),
      tool(
        "LINKEDIN_PERSON_ABOUT",
        "Scavio LinkedIn Person About",
        "Fetch the about/overview slice of a LinkedIn member's profile: about text, headline, experience, education, honours and bio links. Costs 1 credit. Use instead of LINKEDIN_PERSON when only the narrative sections are needed.",
        z.object({
          username: ostr("Public identifier (vanity handle). Provide this or url."),
          url: ostr("Full LinkedIn profile URL. Provide this or username."),
        }),
        (i) => client.linkedin.personAbout(i)
      ),
      tool(
        "LINKEDIN_PERSON_POSTS",
        "Scavio LinkedIn Person Posts",
        "List a LinkedIn member's posts, with text, url, timestamps, a full reaction breakdown, comment and repost counts and attached media. Costs 10 credits per page. 50 per page; pass the previous response's next_cursor to page.",
        z.object({
          username: ostr("Public identifier (vanity handle). Provide this or url."),
          url: ostr("Full LinkedIn profile URL. Provide this or username."),
          type: ostr("Which feed: 'posts' (default), 'comments' (posts they commented on), or 'reactions' (posts they reacted to)."),
          cursor: ostr("Opaque cursor from a prior response's next_cursor."),
        }),
        (i) => client.linkedin.personPosts(i)
      ),
      tool(
        "LINKEDIN_COMPANY",
        "Scavio LinkedIn Company",
        "Fetch a LinkedIn company profile: about, website, industries, specialties, size, employee and follower counts, headquarters, all office locations, featured employees, similar and affiliated companies. Costs 1 credit.",
        z.object({
          company: ostr("Company universal name (slug), e.g. 'microsoft'. Provide this or url."),
          url: ostr("Full LinkedIn company URL. Provide this or company."),
        }),
        (i) => client.linkedin.company(i)
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
        (i) => client.linkedin.companyPosts(i)
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
        (i) => client.linkedin.searchJobs(i)
      ),
      tool(
        "LINKEDIN_JOB",
        "Scavio LinkedIn Job",
        "Fetch full details for one LinkedIn job listing, including the hiring company. Costs 30 credits, the most expensive Scavio tool: prefer the fields already returned by LINKEDIN_SEARCH_JOBS when they are enough. Roughly one job id in five has no detail record upstream and returns an unbilled 404.",
        z.object({
          job_id: ostr("Job listing id. Provide this or url."),
          url: ostr("Full LinkedIn job URL. Provide this or job_id."),
        }),
        (i) => client.linkedin.job(i)
      ),
      tool(
        "LINKEDIN_POST",
        "Scavio LinkedIn Post",
        "Fetch full details for one LinkedIn post: body text, timestamp, hashtags, links, media, like and comment counts, tagged companies and people, top visible comments and the author. Costs 1 credit.",
        z.object({
          post_id: ostr("Post id or activity urn. Provide this or url."),
          url: ostr("Full LinkedIn post URL. Provide this or post_id."),
        }),
        (i) => client.linkedin.post(i)
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
        (i) => client.linkedin.postComments(i)
      )
    );
  }

  return tools;
}

export default buildScavioTools;
