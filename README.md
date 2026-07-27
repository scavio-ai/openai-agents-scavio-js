# openai-agents-scavio

[Scavio](https://scavio.dev) real-time search tools for the [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) (TypeScript) — Google, YouTube, Amazon, Walmart, Reddit, TikTok, and Instagram, with one API key.

## Install

```bash
npm install openai-agents-scavio @openai/agents zod
```

## Setup

Get a Scavio API key from the [Scavio Dashboard](https://dashboard.scavio.dev) (new accounts get free credits, no credit card). Set `SCAVIO_API_KEY` or pass `{ apiKey }`.

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

Expose only the providers you need:

```typescript
const tools = buildScavioTools({
  enableGoogle: true,
  enableReddit: true,
  enableAmazon: false,
  enableWalmart: false,
  enableYoutube: false,
  enableTiktok: false,
  enableInstagram: false,
});
```

Pass `{ all: true }` to register every tool regardless of the individual flags.

## Tools

`buildScavioTools()` returns 32 tools, one per Scavio endpoint, named `scavio_<provider>_<action>` (e.g. `scavio_google_search`, `scavio_amazon_product`). Each returns the structured Scavio JSON response.

## Use every endpoint via MCP

For the full Scavio API with no install, point the Agents SDK at the hosted MCP server:

```typescript
import { Agent, MCPServerStreamableHttp } from "@openai/agents";

const server = new MCPServerStreamableHttp({
  url: "https://mcp.scavio.dev/mcp",
  name: "scavio",
  requestInit: { headers: { "x-api-key": process.env.SCAVIO_API_KEY! } },
});

const agent = new Agent({ name: "Search Assistant", mcpServers: [server] });
```

## Credits

Most calls cost 1 credit (Google included). Instagram costs 8-10 credits per call, except user posts which costs 2. See [scavio.dev/docs](https://scavio.dev/docs).

## Links

- Scavio: https://scavio.dev
- Docs: https://scavio.dev/docs/openai-agents
- Dashboard: https://dashboard.scavio.dev
