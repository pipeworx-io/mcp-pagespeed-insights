# @pipeworx/pagespeed-insights

Google's PageSpeed Insights — runs Lighthouse against any public URL on Google's
own infrastructure and returns the performance/accessibility/best-practices/SEO
scores, the lab timing metrics behind them, and the ranked list of specific
fixes with the milliseconds or bytes each would save; plus the real-user Chrome
UX Report data for that page and its origin.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1683+ live data sources.

## Tools

- `pagespeed_audit(url, strategy?, categories?, max_opportunities?, locale?)` —
  the lab run and its ranked opportunities.
- `pagespeed_field_metrics(url, strategy?)` — real-user Core Web Vitals for the
  page *and* its origin, with Google's pass/fail verdict.

## Auth

BYO with platform fallback: `_apiKey`, or `PLATFORM_GOOGLE_API_KEY` when that
secret is set on the gateway.

**The documented keyless path exists but is unusable.** Unkeyed requests are
billed to a single shared Google anonymous consumer project whose daily quota is
exhausted — three consecutive unkeyed calls returned HTTP 429, "Quota exceeded …
for consumer 'project_number:583797351490'" (verified live 2026-09-17). That
project number is the same for every anonymous caller on the internet, so the
quota is not ours to nurse and retrying does not help. The pack tries keyless
first and refuses with wording that says a key is required.

A key is free, instant and needs **no billing account**: create one at
<https://console.cloud.google.com/apis/credentials> and enable the PageSpeed
Insights API at
<https://console.cloud.google.com/apis/library/pagespeedonline.googleapis.com>.
Quota is 25,000 requests/day, 240/minute. The same key serves the
`chrome-ux-report` pack.

## Relationship to the `chrome-ux-report` pack

`chrome-ux-report` reports what real visitors experienced; it cannot tell you
*why*, because field data carries no diagnostics. This pack runs the page and
names the causes. Use crux for "is this site fast for real users", use this for
"what specifically is making it slow, and what do I fix first".

## Data sources

- `https://www.googleapis.com/pagespeedonline/v5/runPagespeed`

## Traps, verified live 2026-09-17

- **A call takes 10–40 seconds.** Google actually loads the page. The pack
  passes an explicit 60s budget; a caller batching ten URLs should expect
  minutes.
- **Lab and field disagree routinely and both are right.** The lab run is one
  load on a throttled emulated phone from a Google data centre; the field block
  is 28 days of real visits on real devices. A 95 lab score with failing field
  CWV means real users are on worse hardware than the emulation — and it is the
  field number Search uses. Both are returned, labelled, never blended.
- **`loadingExperience` is the page, `originLoadingExperience` is the site** —
  and for a low-traffic URL Google populates the *page* block with the
  **origin's** numbers and sets `origin_fallback: true`. Reading that as page
  data attributes the whole site's performance to one URL. Reported here as
  `is_origin_fallback`.
- **Category scores are 0–1 floats, not 0–100, and are nullable.** A category
  that errored returns `null`, not zero.
- **An unreachable target is an HTTP 400 from Google**, not a 404 or 5xx, with
  the useful part buried in `error.errors[].reason`. "Bad request" here often
  means "your site returned a 500 to Google's crawler".
- **CLS in this API is an integer ×100** (`5` means 0.05), while the CrUX API
  returns the same metric as a decimal string. The pack normalises to the
  decimal.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "pagespeed-insights": {
      "url": "https://gateway.pipeworx.io/pagespeed-insights/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/pagespeed-insights/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1683+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/pagespeed_audit \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.wikipedia.org"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/pagespeed_audit`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "pagespeed-insights": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-pagespeed-insights"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-pagespeed-insights
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Pagespeed Insights data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
