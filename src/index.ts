/**
 * Scavio tools for the OpenAI Agents SDK.
 *
 * Exposes the Scavio search API (Google, YouTube, Amazon, Walmart, Reddit, TikTok,
 * Instagram) as OpenAI Agents SDK tools. Build them with `buildScavioTools()` and
 * pass them to an Agent:
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
  enableInstagram?: boolean;
  /** Register every tool, ignoring the individual flags. */
  all?: boolean;
}

const str = (d: string) => z.string().describe(d);
const ostr = (d: string) => z.string().optional().describe(d);
const onum = (d: string) => z.number().optional().describe(d);
const obool = (d: string) => z.boolean().optional().describe(d);

/**
 * Map the tool's stable public params to the Scavio v2 Google SERP wire params:
 * country_code -> gl, language -> hl, page -> start ((page - 1) * 10, page > 1).
 * query, device, and nfpr are v2-native and pass through unchanged.
 */
export function googleV2Params(input: Record<string, unknown>): Record<string, unknown> {
  const { country_code, language, page, ...rest } = input;
  const out: Record<string, unknown> = { ...rest };
  if (country_code !== undefined) out.gl = country_code;
  if (language !== undefined) out.hl = language;
  if (typeof page === "number" && page > 1) out.start = (page - 1) * 10;
  return out;
}

/**
 * Build Scavio tools for an OpenAI Agents SDK Agent.
 *
 * Scavio is a single Search API over Google, YouTube, Amazon, Walmart, Reddit,
 * TikTok, and Instagram. Returns an array of tools to pass to `new Agent({ tools })`.
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
    enableInstagram = true,
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

  if (all || enableGoogle) {
    tools.push(
      tool(
        "GOOGLE_SEARCH",
        "Scavio Google Search",
        "Search Google for real-time web results (organic results, ads, and the AI Overview when present). Costs 1 credit.",
        z.object({
          query: str("The search query."),
          country_code: ostr("Two-letter country of the search, e.g. 'us'."),
          language: ostr("Two-letter UI language code, e.g. 'en'."),
          page: onum("Result page number (1-based)."),
          device: ostr("Device profile: 'desktop' or 'mobile'."),
          nfpr: obool("Disable auto-correction of the query when true."),
        }),
        (i) => client.google.search(googleV2Params(i) as unknown as Parameters<typeof client.google.search>[0])
      )
    );
  }

  if (all || enableAmazon) {
    tools.push(
      tool(
        "AMAZON_SEARCH",
        "Scavio Amazon Search",
        "Search Amazon for products matching a query.",
        z.object({
          query: str("The product search query."),
          domain: ostr("Amazon domain, e.g. 'amazon.com'."),
          country: ostr("Two-letter country code."),
          language: ostr("Two-letter language code."),
          currency: ostr("Currency code, e.g. 'USD'."),
          device: ostr("Device profile: 'desktop' or 'mobile'."),
          sort_by: ostr("Sort order for results."),
          start_page: onum("First page to return."),
          pages: onum("Number of pages to return."),
          category_id: ostr("Restrict to an Amazon category id."),
          merchant_id: ostr("Restrict to a merchant id."),
          zip_code: ostr("Delivery ZIP/postal code."),
          autoselect_variant: obool("Auto-select the best product variant when true."),
        }),
        (i) => client.amazon.search(i)
      ),
      tool(
        "AMAZON_PRODUCT",
        "Scavio Amazon Product",
        "Fetch full Amazon product details by ASIN.",
        z.object({
          asin: str("Amazon Standard Identification Number (ASIN) of the product."),
          domain: ostr("Amazon domain, e.g. 'amazon.com'."),
          country: ostr("Two-letter country code."),
          language: ostr("Two-letter language code."),
          currency: ostr("Currency code, e.g. 'USD'."),
          device: ostr("Device profile: 'desktop' or 'mobile'."),
          zip_code: ostr("Delivery ZIP/postal code."),
          autoselect_variant: obool("Auto-select the best product variant when true."),
        }),
        (i) => client.amazon.product(i)
      )
    );
  }

  if (all || enableWalmart) {
    tools.push(
      tool(
        "WALMART_SEARCH",
        "Scavio Walmart Search",
        "Search Walmart for products matching a query.",
        z.object({
          query: str("The product search query."),
          domain: ostr("Walmart domain."),
          device: ostr("Device profile: 'desktop' or 'mobile'."),
          sort_by: ostr("Sort order for results."),
          start_page: onum("First page to return."),
          min_price: onum("Minimum price filter."),
          max_price: onum("Maximum price filter."),
          fulfillment_speed: ostr("Fulfillment speed filter."),
          fulfillment_type: ostr("Fulfillment type filter."),
          delivery_zip: ostr("Delivery ZIP/postal code."),
          store_id: ostr("Restrict to a store id."),
        }),
        (i) => client.walmart.search(i)
      ),
      tool(
        "WALMART_PRODUCT",
        "Scavio Walmart Product",
        "Fetch full Walmart product details by product id.",
        z.object({
          product_id: str("Walmart product id."),
          domain: ostr("Walmart domain."),
          device: ostr("Device profile: 'desktop' or 'mobile'."),
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
          sort_by: ostr("Sort order for results."),
          cursor: ostr("Pagination cursor."),
        }),
        (i) => client.youtube.shorts(i)
      ),
      tool(
        "YOUTUBE_SUGGESTIONS",
        "Scavio YouTube Suggestions",
        "Fetch YouTube search autocomplete suggestions for a query.",
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
        "Fetch full details for a YouTube video (title, author, view count, description, captions, chapters).",
        z.object({ video_id: str("YouTube video id or a full watch URL.") }),
        (i) => client.youtube.video(i)
      ),
      tool(
        "YOUTUBE_METADATA",
        "Scavio YouTube Metadata",
        "Deprecated alias of scavio_youtube_video. Fetch details for a YouTube video by id.",
        z.object({ video_id: str("YouTube video id or a full watch URL.") }),
        (i) => client.youtube.video(i)
      ),
      tool(
        "YOUTUBE_COMMENTS",
        "Scavio YouTube Comments",
        "List comments on a YouTube video.",
        z.object({
          video_id: str("YouTube video id or a full watch URL."),
          cursor: ostr("Pagination cursor."),
        }),
        (i) => client.youtube.comments(i)
      ),
      tool(
        "YOUTUBE_COMMENT_REPLIES",
        "Scavio YouTube Comment Replies",
        "List replies to a YouTube comment.",
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
        "Fetch a YouTube video's transcript or timed subtitles. Costs 8 credits.",
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
        "List videos related to a YouTube video.",
        z.object({
          video_id: str("YouTube video id or a full watch URL."),
          cursor: ostr("Pagination cursor."),
        }),
        (i) => client.youtube.related(i)
      ),
      tool(
        "YOUTUBE_CHANNEL_SEARCH",
        "Scavio YouTube Channel Search",
        "Search YouTube channels by keyword.",
        z.object({
          query: str("The channel search query."),
          cursor: ostr("Pagination cursor."),
        }),
        (i) => client.youtube.channelSearch(i)
      ),
      tool(
        "YOUTUBE_CHANNEL",
        "Scavio YouTube Channel",
        "Fetch a YouTube channel's details (subscribers, video count, views, links).",
        z.object({ channel_id: str("YouTube channel id, @handle, or channel URL.") }),
        (i) => client.youtube.channel(i)
      ),
      tool(
        "YOUTUBE_CHANNEL_VIDEOS",
        "Scavio YouTube Channel Videos",
        "List a YouTube channel's uploaded videos.",
        z.object({
          channel_id: str("YouTube channel id."),
          cursor: ostr("Pagination cursor."),
        }),
        (i) => client.youtube.channelVideos(i)
      ),
      tool(
        "YOUTUBE_CHANNEL_SHORTS",
        "Scavio YouTube Channel Shorts",
        "List a YouTube channel's Shorts.",
        z.object({
          channel_id: str("YouTube channel id."),
          cursor: ostr("Pagination cursor."),
        }),
        (i) => client.youtube.channelShorts(i)
      ),
      tool(
        "YOUTUBE_CHANNEL_COMMUNITY",
        "Scavio YouTube Channel Community",
        "List a YouTube channel's community posts.",
        z.object({
          channel_id: str("YouTube channel id."),
          cursor: ostr("Pagination cursor."),
        }),
        (i) => client.youtube.channelCommunity(i)
      ),
      tool(
        "YOUTUBE_CHANNEL_RESOLVE",
        "Scavio YouTube Channel Resolve",
        "Resolve a YouTube @handle or channel URL to a channel id.",
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

  if (all || enableReddit) {
    tools.push(
      tool(
        "REDDIT_SEARCH",
        "Scavio Reddit Search",
        "Search Reddit posts, subreddits, or users.",
        z.object({
          query: str("The Reddit search query."),
          type: ostr("Search type, e.g. 'posts', 'subreddits', 'users'."),
          sort: ostr("Sort order, e.g. 'relevance', 'new', 'top'."),
          cursor: ostr("Pagination cursor."),
        }),
        (i) => client.reddit.search(i)
      ),
      tool(
        "REDDIT_POST",
        "Scavio Reddit Post",
        "Fetch a Reddit post and its comment thread by URL.",
        z.object({ url: str("Full URL of the Reddit post to fetch with its comments.") }),
        (i) => client.reddit.post(i)
      )
    );
  }

  if (all || enableTiktok) {
    tools.push(
      tool(
        "TIKTOK_PROFILE",
        "Scavio TikTok Profile",
        "Fetch a TikTok user profile by username or secUid.",
        z.object({
          username: ostr("TikTok username (without @). Provide this or sec_user_id."),
          sec_user_id: ostr("TikTok secUid. Provide this or username."),
        }),
        (i) => client.tiktok.profile(i)
      ),
      tool(
        "TIKTOK_USER_POSTS",
        "Scavio TikTok User Posts",
        "List a TikTok user's posts by secUid.",
        z.object({
          sec_user_id: str("TikTok secUid of the user."),
          cursor: ostr("Pagination cursor."),
          count: onum("Number of posts to return."),
          sort_type: ostr("Sort order for posts."),
        }),
        (i) => client.tiktok.userPosts(i)
      ),
      tool(
        "TIKTOK_VIDEO",
        "Scavio TikTok Video",
        "Fetch a TikTok video by id.",
        z.object({ video_id: str("TikTok video id.") }),
        (i) => client.tiktok.video(i)
      ),
      tool(
        "TIKTOK_VIDEO_COMMENTS",
        "Scavio TikTok Video Comments",
        "List comments on a TikTok video.",
        z.object({
          video_id: str("TikTok video id."),
          cursor: ostr("Pagination cursor."),
          count: onum("Number of comments to return."),
        }),
        (i) => client.tiktok.videoComments(i)
      ),
      tool(
        "TIKTOK_COMMENT_REPLIES",
        "Scavio TikTok Comment Replies",
        "List replies to a TikTok video comment.",
        z.object({
          video_id: str("TikTok video id."),
          comment_id: str("Parent comment id."),
          cursor: ostr("Pagination cursor."),
          count: onum("Number of replies to return."),
        }),
        (i) => client.tiktok.commentReplies(i)
      ),
      tool(
        "TIKTOK_SEARCH_VIDEOS",
        "Scavio TikTok Search Videos",
        "Search TikTok videos by keyword.",
        z.object({
          keyword: str("Search keyword."),
          cursor: ostr("Pagination cursor."),
          count: onum("Number of videos to return."),
          sort_type: ostr("Sort order for results."),
          publish_time: ostr("Publish-time filter."),
        }),
        (i) => client.tiktok.searchVideos(i)
      ),
      tool(
        "TIKTOK_SEARCH_USERS",
        "Scavio TikTok Search Users",
        "Search TikTok users by keyword.",
        z.object({
          keyword: str("Search keyword."),
          cursor: ostr("Pagination cursor."),
          count: onum("Number of users to return."),
        }),
        (i) => client.tiktok.searchUsers(i)
      ),
      tool(
        "TIKTOK_HASHTAG",
        "Scavio TikTok Hashtag",
        "Fetch a TikTok hashtag by name or id.",
        z.object({
          hashtag_name: ostr("Hashtag name (without #). Provide this or hashtag_id."),
          hashtag_id: ostr("Hashtag id. Provide this or hashtag_name."),
        }),
        (i) => client.tiktok.hashtag(i)
      ),
      tool(
        "TIKTOK_HASHTAG_VIDEOS",
        "Scavio TikTok Hashtag Videos",
        "List videos for a TikTok hashtag by id.",
        z.object({
          hashtag_id: str("Hashtag id."),
          cursor: ostr("Pagination cursor."),
          count: onum("Number of videos to return."),
        }),
        (i) => client.tiktok.hashtagVideos(i)
      ),
      tool(
        "TIKTOK_USER_FOLLOWERS",
        "Scavio TikTok User Followers",
        "List a TikTok user's followers by secUid.",
        z.object({
          sec_user_id: str("TikTok secUid of the user."),
          count: onum("Number of followers to return."),
          page_token: ostr("Pagination token."),
          min_time: onum("Minimum timestamp filter."),
        }),
        (i) => client.tiktok.userFollowers(i)
      ),
      tool(
        "TIKTOK_USER_FOLLOWINGS",
        "Scavio TikTok User Followings",
        "List the accounts a TikTok user follows, by secUid.",
        z.object({
          sec_user_id: str("TikTok secUid of the user."),
          count: onum("Number of followings to return."),
          page_token: ostr("Pagination token."),
          min_time: onum("Minimum timestamp filter."),
        }),
        (i) => client.tiktok.userFollowings(i)
      )
    );
  }

  if (all || enableInstagram) {
    tools.push(
      tool(
        "INSTAGRAM_PROFILE",
        "Scavio Instagram Profile",
        "Fetch an Instagram profile by username or user id.",
        z.object({
          username: ostr("Instagram username. Provide this or user_id."),
          user_id: ostr("Instagram user id. Provide this or username."),
        }),
        (i) => client.instagram.profile(i)
      ),
      tool(
        "INSTAGRAM_USER_POSTS",
        "Scavio Instagram User Posts",
        "List an Instagram user's posts.",
        z.object({
          username: ostr("Instagram username. Provide this or user_id."),
          user_id: ostr("Instagram user id. Provide this or username."),
          count: onum("Number of posts to return."),
          cursor: ostr("Pagination cursor."),
        }),
        (i) => client.instagram.userPosts(i)
      ),
      tool(
        "INSTAGRAM_USER_REELS",
        "Scavio Instagram User Reels",
        "List an Instagram user's reels.",
        z.object({
          username: ostr("Instagram username. Provide this or user_id."),
          user_id: ostr("Instagram user id. Provide this or username."),
          count: onum("Number of reels to return."),
          cursor: ostr("Pagination cursor."),
        }),
        (i) => client.instagram.userReels(i)
      ),
      tool(
        "INSTAGRAM_USER_TAGGED",
        "Scavio Instagram User Tagged",
        "List posts an Instagram user is tagged in.",
        z.object({
          username: ostr("Instagram username. Provide this or user_id."),
          user_id: ostr("Instagram user id. Provide this or username."),
          count: onum("Number of tagged posts to return."),
          cursor: ostr("Pagination cursor."),
        }),
        (i) => client.instagram.userTagged(i)
      ),
      tool(
        "INSTAGRAM_USER_STORIES",
        "Scavio Instagram User Stories",
        "Fetch an Instagram user's current stories.",
        z.object({
          username: ostr("Instagram username. Provide this or user_id."),
          user_id: ostr("Instagram user id. Provide this or username."),
        }),
        (i) => client.instagram.userStories(i)
      ),
      tool(
        "INSTAGRAM_POST",
        "Scavio Instagram Post",
        "Fetch an Instagram post by URL, media id, or shortcode.",
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
        "List comments on an Instagram post by shortcode or URL.",
        z.object({
          shortcode: ostr("Post shortcode. Provide this or url."),
          url: ostr("Post URL. Provide this or shortcode."),
          cursor: ostr("Pagination cursor."),
          sort_order: ostr("Comment sort order."),
        }),
        (i) => client.instagram.postComments(i)
      ),
      tool(
        "INSTAGRAM_COMMENT_REPLIES",
        "Scavio Instagram Comment Replies",
        "List replies to an Instagram post comment.",
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
        "Search Instagram users by keyword.",
        z.object({
          keyword: str("Search keyword."),
          cursor: ostr("Pagination cursor."),
        }),
        (i) => client.instagram.searchUsers(i)
      ),
      tool(
        "INSTAGRAM_SEARCH_HASHTAGS",
        "Scavio Instagram Search Hashtags",
        "Search Instagram hashtags by keyword.",
        z.object({
          keyword: str("Search keyword."),
          cursor: ostr("Pagination cursor."),
        }),
        (i) => client.instagram.searchHashtags(i)
      ),
      tool(
        "INSTAGRAM_USER_FOLLOWERS",
        "Scavio Instagram User Followers",
        "List an Instagram user's followers.",
        z.object({
          username: ostr("Instagram username. Provide this or user_id."),
          user_id: ostr("Instagram user id. Provide this or username."),
          count: onum("Number of followers to return."),
          cursor: ostr("Pagination cursor."),
        }),
        (i) => client.instagram.userFollowers(i)
      ),
      tool(
        "INSTAGRAM_USER_FOLLOWINGS",
        "Scavio Instagram User Followings",
        "List the accounts an Instagram user follows.",
        z.object({
          username: ostr("Instagram username. Provide this or user_id."),
          user_id: ostr("Instagram user id. Provide this or username."),
          count: onum("Number of followings to return."),
          cursor: ostr("Pagination cursor."),
        }),
        (i) => client.instagram.userFollowings(i)
      )
    );
  }

  return tools;
}

export default buildScavioTools;
