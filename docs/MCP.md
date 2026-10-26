# MCP server: use OpenHive from Claude, ChatGPT and other AI tools

OpenHive includes a Model Context Protocol server, so an AI assistant can draft posts, pull stats, build segments, edit automations and more — inside your publication.

- Endpoint: `https://YOUR_APP/mcp`
- Transport: Streamable HTTP (JSON responses)
- Auth: `Authorization: Bearer <OpenHive API key>` (create one in Settings → API keys & MCP)

## Connect Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "openhive": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://YOUR_APP/mcp", "--header", "Authorization: Bearer oh_live_XXXXXXXX"]
    }
  }
}
```

Restart Claude Desktop. You'll see the OpenHive tools in the tools menu.

## Connect Claude Code

```bash
claude mcp add --transport http openhive https://YOUR_APP/mcp --header "Authorization: Bearer oh_live_XXXXXXXX"
```

## Connect ChatGPT and other clients

Any client that supports remote MCP servers over HTTP with a custom header works: add the URL `https://YOUR_APP/mcp` and the `Authorization: Bearer …` header. For clients that only support local (stdio) servers, use `mcp-remote` as shown above.

## Tools

| Tool | What it does |
|---|---|
| `list_posts`, `get_post` | Browse posts with headline stats; read content as text |
| `draft_post`, `update_post` | Draft from Markdown (or a template), rewrite, append/prepend |
| `set_ab_test` | Subject line A/B test on a draft |
| `get_stats` | Open rate, CTR, revenue in plain English (or one post) |
| `compare_posts` | Compare dozens of posts in one request |
| `deliverability_by_provider` | Delivery, bounce, complaint, open rates per Gmail/Outlook/Yahoo/Apple |
| `reports` | Subscriber growth and earnings reports |
| `get_subscriber`, `add_subscriber`, `tag_subscriber` | Full history and engagement for any reader |
| `list_segments`, `create_segment_from_description` | Build segments by describing them (with a dry run) |
| `list_automations`, `create_automation`, `update_automation`, `enroll_subscriber` | Create and edit automations. Edits go to a draft version while the live one keeps running; `publish: true` makes them live, `status: "active"/"paused"` turns it on or off |
| `generate_image` | AI image straight into your media library |
| `manage_website` | Pages, redirects, SEO and crawler settings |
| `community` | Read and reply to community posts and DMs |
| `ads` | Ad offers and ad revenue reports |
| `podcasts` | Shows and episodes (see below) |
| `products` | Digital products and promo codes (see below) |
| `send_transactional` | Send one transactional email (template or subject + markdown/html/text, merge vars, idempotency key) |
| `search_docs` | Search these docs |

### `podcasts` actions

| Action | Arguments |
|---|---|
| `list_shows` | — |
| `create_show` / `update_show` | `title`, `description`, `author`, `owner_email`, `cover_url`, `language`, `category` (`"Technology"` or `"Business\|Marketing"`), `explicit`, `kind` (episodic/serial), `access` (public/premium/both), `copyright`; update needs `podcast_id`. Renaming never changes the feed URL. |
| `list_episodes` | `podcast_id`, optional `status` |
| `create_episode` / `update_episode` | `title`, `description` (show notes, HTML sanitized), `audio_url`, `season`, `number`, `episode_type` (full/trailer/bonus), `premium`, `explicit`, `image_url`, `transcript`, `status` (draft/published/scheduled), `publish_at` (ISO; future = scheduled). Create needs `podcast_id`, update needs `episode_id`. Publishing requires audio. |
| `archive_episode` / `unarchive_episode` | `episode_id` — archived episodes leave feeds and the site; unarchiving restores a draft |
| `delete_episode` | `episode_id` — permanent (audio file and download stats are removed) |

### `products` actions

Promo codes, coupons and offers are one concept in OpenHive (the "Offers & codes" page): a code with a percent or fixed discount that applies to paid subscriptions, products and/or event tickets.

| Action | Arguments |
|---|---|
| `list`, `get_product` | `product_id` (id or slug) for get — includes the codes that apply to it |
| `create_product` / `update_product` | `name`, `price` (USD; 0 = free lead magnet), `kind` (download/link/guide/template/ebook/membership/coaching), `description`, `link_url`, `content`, `status` (active/draft/archived) |
| `archive_product` | `product_id` — hidden from the shop, buyers keep access |
| `list_promo_codes` | optional `active_only` |
| `create_promo_code` (alias `create_coupon`) | `code`, `percent_off` or `amount_off` (USD), `applies_to` (all/subscription/product/event), `target_id`, `duration` (once/repeating/forever) + `duration_months`, `max_redemptions`, `expires_at` (ISO; a bare date means end of that day), `name` |
| `update_promo_code` | `code` or `promo_code_id`; `active`, `name`, `max_redemptions` (null = unlimited), `expires_at` (null = never). The discount itself can't change — create a new code. |
| `delete_promo_code` | `code` or `promo_code_id` |

## Example prompts

- "What was my open rate and revenue over the last 30 days?"
- "Compare my last 20 posts and tell me which subject line styles work best."
- "Draft next week's issue about our new podcast, with a paywall after the intro."
- "Make a segment of premium readers who haven't opened in 60 days and tell me how many there are."
- "Create a 3-email welcome automation for people who sign up from the link-in-bio page."
- "Reply to the latest community post thanking them."

Drafts created over MCP are never sent automatically — you review and send from the dashboard (or explicitly via the REST send API).

## Protocol details

- `initialize` returns protocol version `2025-06-18` and the `tools` capability.
- Supports `tools/list`, `tools/call`, `ping`, notifications and JSON-RPC batches.
- `GET /mcp` returns 405 (no SSE stream is needed; every response is a single JSON body).
- Tool results include both a text block and `structuredContent`.
- Rate limit: 180 calls per minute per key.
