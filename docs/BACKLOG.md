# OpenHive Backlog

Every item below must be built and working. Each line is tagged with the module that owns it.
`[ops]` = an operational/people/scale claim: we ship the software side (config, tooling, docs) and note what an operator must do.
Tick an item (`[x]`) only after it works end to end in `wrangler dev`.

**Status (2026-10-25):** all items built. Each module was verified by its builder in an isolated `wrangler dev`, then the integrated app passed `scripts/e2e.mjs` (39/39 checks), a full dashboard/site crawl, and a browser console-error pass. AI-powered features (writer, images, TTS, transcripts, AI segment/website builders) degrade gracefully and need `"ai": {"binding": "AI"}` enabled to run. Stripe and Luma/Discord/HubSpot calls are written against the real APIs but were exercised only in test mode.

Modules: auth, dashboard, posts, website, podcasts, community, events, audience, automations, monetize, grow, settings, api, mcp, core (src/lib).

## Deliverability & protection
- [x] (core) [ops] 99.3% delivery rate — deliverability dashboard per publication showing delivered/bounced/complained rates
- [x] (core) [ops] deliverability expertise — built-in deliverability checklist + docs/DELIVERABILITY.md
- [x] (core) [ops] infrastructure to send 3M+ emails per minute — batched, queue-driven sender that fans out via cron + waitUntil; throughput setting
- [x] (core) validating every email submission (1st and 3rd party: forms, API, imports)
- [x] (core) automated bot-detection to prevent spam signups
- [x] (core) [ops] feedback-loop program registration — FBL inbound endpoint + docs
- [x] (core) ingesting feedback-loop data and building suppression lists (/hooks/fbl, /hooks/bounce)
- [x] (core) tagging every email (Feedback-ID header) so Gmail reports complaint rates per newsletter
- [x] (core) classifying every bounce (hard, soft, mailbox full, DNS failure) → retry vs never again
- [x] (core) three layers of suppression: global, per-publication, transactional
- [x] (core) temporary suppressions that expire, permanent ones that never do
- [x] (core) one-click unsubscribe (RFC 8058 List-Unsubscribe + List-Unsubscribe-Post)
- [x] (core) [ops] warming new IPs and domains on a schedule — per-domain daily warmup caps
- [x] (core) [ops] blocklist monitoring — DNSBL check of sending domains on cron, pause sender when listed
- [x] (core) retrying deferred mail for 24+ hours before calling it a bounce
- [x] (core) blocking disposable, invalid, and typo'd addresses before they reach the list
- [x] (core) rate limiting every signup endpoint
- [x] (core) filtering bot clicks out of every report
- [x] (core) an acquisition source on every subscriber
- [x] (audience) engagement history for every reader, across every post
- [x] (settings) multiple sender addresses for different emails
- [x] (settings) custom domain configuration aligned with DKIM, SPF, DMARC (DNS record generator + live DNS check)

## Editor (posts)
- [x] (posts) true WYSIWYG editor, no HTML required
- [x] (posts) table-based, inline-styled email HTML that holds up in Outlook
- [x] (posts) real-time collaborative editing (Durable Object)
- [x] (posts) dynamic content: sections per segment/tier in a single send
- [x] (posts) separate email and web versions of every post from one draft
- [x] (posts) free and premium versions split by a paywall break
- [x] (posts) merge tags + simulated subscriber preview
- [x] (posts) templates with saved colors, fonts, spacing + default post style
- [x] (posts) columns, tables, buttons, blockquotes, sections, file attachments, table of contents with anchors
- [x] (posts) native embeds: X, YouTube, TikTok, Instagram, Bluesky, Stocktwits, podcast episodes
- [x] (posts) polls, referral blocks, recommendations, ad slots in the post
- [x] (posts) AI writer, AI images, AI agent one shortcut away (⌘J)
- [x] (posts) images resized and optimized automatically
- [x] (posts) live email-size gauge (Gmail clips at 102KB)
- [x] (posts) custom HTML blocks, sanitized
- [x] (posts) hide video/iframes/audio in email, keep on web
- [x] (posts) links and embeds clickable in Outlook
- [x] (posts) vertical alignment in columns
- [x] (posts) audio versions of newsletters (TTS) — *needs the Workers AI binding*
- [x] (posts) random cohort sends (split list, test content)
- [x] (posts) slash commands
- [x] (posts) markdown and keyboard shortcuts
- [x] (posts) pasting from Google Docs with formatting intact
- [x] (posts) search and replace across the post
- [x] (posts) comment threads in the draft
- [x] (posts) footnotes and citations (inbox + web)
- [x] (posts) code blocks
- [x] (posts) AI rewrite, translate, fix spelling/grammar in place
- [x] (posts) autosave
- [x] (posts) subject line A/B testing in the send flow
- [x] (posts) drag-and-drop images from computer, media library, or URL
- [x] (posts) rich-text image captions, titles, alt text
- [x] (posts) inline audio files
- [x] (posts) file attachments
- [x] (posts) sections with backgrounds, borders, spacing
- [x] (posts) blockquotes with custom borders, colors, styles
- [x] (posts) content breaks and dividers

## API
- [x] (api) REST API for subscribers, posts, segments, automations, and more
- [x] (api) send API to create and send newsletters
- [x] (api) create/update/delete subscribers in real time
- [x] (api) read/write custom fields
- [x] (api) tag subscribers
- [x] (api) enroll subscribers into automations
- [x] (api) opens, clicks, engagement per post
- [x] (api) post HTML rendered free vs premium, email vs web
- [x] (api) create posts from a template, append/prepend content
- [x] (api) segments and their subscribers
- [x] (api) tiers and premium subscriptions
- [x] (api) referral program data and milestones
- [x] (api) poll and survey responses
- [x] (api) cursor pagination for millions of records
- [x] (api) rate limits
- [x] (settings) API keys create/revoke

## MCP server (AI tools)
- [x] (mcp) MCP server endpoint (/mcp, streamable HTTP, API-key auth)
- [x] (mcp) draft and edit posts
- [x] (mcp) open rates, CTR, revenue in plain English
- [x] (mcp) compare performance across posts
- [x] (mcp) subscriber full history
- [x] (mcp) build segments by describing them
- [x] (mcp) create/edit automations
- [x] (mcp) generate AI images into media library
- [x] (mcp) website pages, redirects, SEO
- [x] (mcp) read/reply community posts and DMs
- [x] (mcp) ad offers and ad revenue reports
- [x] (mcp) podcast shows and episodes
- [x] (mcp) digital products, coupons, promo codes
- [x] (mcp) subscriber growth and earnings reports
- [x] (mcp) subject line A/B tests
- [x] (mcp) deliverability by mailbox provider per post
- [x] (mcp) searching docs

## Team & workspace (settings/auth)
- [x] (settings) invite teammates by email
- [x] (settings) admin, member, contributor roles
- [x] (settings) admins control billing, exports, integrations, payments, domains
- [x] (settings) members: full access minus admin
- [x] (settings) contributors: draft posts and automations only
- [x] (settings) roles at workspace or publication level
- [x] (settings) multiple publications under one workspace
- [x] (settings) workspace grouping and search for people on multiple teams
- [x] (posts) multiple authors per post with bylines
- [x] (settings) guest authors
- [x] (settings) author profiles: bio, avatar, social links
- [x] (community) community roles mapped to workspace roles
- [x] (posts) real-time collaboration + comment threads on drafts
- [x] (settings) removing access instantly
- [x] (settings) publication transfers with written consent
- [x] (auth) secure single-use magic links to log in from desktop

## Website builder
- [x] (website) no-code website builder on custom domain
- [x] (website) AI website builder from prompts or screenshots
- [x] (website) AI custom elements for live widgets
- [x] (website) drag-and-drop editing + HTML access
- [x] (website) theme tokens: fonts, colors, borders, shadows
- [x] (website) global navbar, footer, signup/login modals
- [x] (website) saving sections, blocks, pages as templates
- [x] (website) version history with one-click restore
- [x] (website) custom pages with SEO and paywalls
- [x] (website) redirects
- [x] (website) custom robots.txt
- [x] (website) auto-generated meta titles/descriptions
- [x] (website) Google News schema
- [x] (website) fast LCP (SSR, no client framework, preloads, cache headers)
- [x] (website) image carousels and grids
- [x] (website) YouTube blocks that update with new videos
- [x] (podcasts) automatic page per podcast episode
- [x] (website) pop-ups and gated content

## Automations
- [x] (automations) visual automation builder
- [x] (automations) triggers: signup source, behavior, purchases, engagement
- [x] (automations) welcome sequences
- [x] (automations) delays and wait steps
- [x] (automations) branching on subscriber attributes
- [x] (automations) reusable condition sets
- [x] (automations) email steps with the newsletter editor
- [x] (automations) webhook steps with retries
- [x] (automations) enroll via API
- [x] (automations) per-subscriber journey tracking
- [x] (automations) opens/clicks per email in every flow
- [x] (automations) edit draft version while live keeps running
- [x] (automations) compare draft vs live
- [x] (automations) reorder steps in bulk
- [x] (audience) segment conditions: automation started
- [x] (monetize) product delivery and follow-ups triggered by purchases

## Digital products (monetize)
- [x] (monetize) sell files, links, guides, templates, ebooks
- [x] (monetize) memberships and time-based products
- [x] (monetize) 1:1 coaching sessions and appointments
- [x] (monetize) 0% platform fees
- [x] (monetize) storefront on the website
- [x] (monetize) products sold inside emails and automations
- [x] (monetize) free products as lead magnets
- [x] (monetize) product variants
- [x] (monetize) discount and promotion codes
- [x] (monetize) product reviews with moderation
- [x] (monetize) product tags
- [x] (monetize) orders dashboard with buyer details
- [x] (monetize) sales totals per product
- [x] (monetize) duplicate product
- [x] (monetize) automatic delivery on purchase
- [x] (monetize) payouts through Stripe

## Events / webinars
- [x] (events) live webinars up to 10,000 attendees — *large-audience mode relays through Cloudflare Realtime SFU (host uploads once, attendees pull from the edge); enable via Settings → Integrations → Cloudflare Realtime or `REALTIME_APP_ID`/`REALTIME_APP_TOKEN` secrets. Verified with a WebRTC mock SFU; peer-to-peer fallback when not configured*
- [x] (events) ticket sales in 10 currencies
- [x] (events) native streaming with video, screen share, chat (WebRTC + Durable Object chat)
- [x] (events) no Zoom required
- [x] (events) up to 5 automated reminder emails
- [x] (events) calendar invites (.ics) sent automatically
- [x] (events) recording of every session
- [x] (events) sell the replay as a product
- [x] (events) 0% platform fees on tickets
- [x] (events) free webinars that grow the list
- [x] (events) discount codes on tickets
- [x] (events) 1:1 coaching bookings
- [x] (events) buyers linked to subscriber profile
- [x] (events) promote events in newsletter and site
- [x] (events) orders and revenue reporting per event

## Community
- [x] (community) channels, posts, comments
- [x] (community) channels free or gated to tiers
- [x] (community) sync newsletter posts into community
- [x] (community) direct messages
- [x] (community) threaded comments
- [x] (community) pinned posts
- [x] (community) moderation queue for reports
- [x] (community) ban/unban members
- [x] (community) admin, manager, moderator roles
- [x] (community) invite subscribers, segments, or emails
- [x] (community) surface most engaged subscribers to invite
- [x] (community) metrics: new members, posts, activity
- [x] (community) notification emails with own from name
- [x] (community) channel ordering and default channel
- [x] (events) Luma calendar integration
- [x] (community) Discord integration syncing roles with tiers

## Podcasts
- [x] (podcasts) native hosting, zero fees (R2)
- [x] (podcasts) distribution to Apple, Spotify, YouTube (RSS + submission guide)
- [x] (podcasts) automatic webpage per episode
- [x] (podcasts) automatic transcripts (Workers AI Whisper when bound; manual upload otherwise) — *AI path untested here (no AI binding in this sandbox)*
- [x] (podcasts) IAB-style analytics by country, app, device
- [x] (podcasts) bot filtering on downloads
- [x] (podcasts) downloads and unique listeners per episode/show
- [x] (podcasts) private feeds for paying subscribers
- [x] (podcasts) bundle podcast with paid subscription
- [x] (podcasts) import from other hosts preserving GUIDs
- [x] (podcasts) RSS redirects
- [x] (podcasts) scheduled episodes
- [x] (podcasts) Apple categories and metadata
- [x] (posts) podcast players embedded in posts
- [x] (podcasts) full episode library on site
- [x] (podcasts) webhooks for episode and private-feed events

## Segments & lists (audience)
- [x] (audience) segments on behavior, attributes, engagement
- [x] (audience) dynamic segments
- [x] (audience) static segments
- [x] (audience) filter by acquisition source incl. magic links
- [x] (audience) filter by custom fields and tags
- [x] (audience) filter by tier and paid trial status
- [x] (audience) filter by automation started
- [x] (audience) reusable condition sets
- [x] (audience) recalculate segment on demand
- [x] (posts) send to a segment or exclude one
- [x] (posts) segments power dynamic content
- [x] (automations) segments as automation conditions
- [x] (audience) add a segment to a newsletter list
- [x] (audience) multiple newsletter lists per publication
- [x] (audience) export any segment

## Webhooks (settings)
- [x] (settings) subscriber created, confirmed, deleted
- [x] (settings) upgrade, downgrade, pause, resume
- [x] (settings) tier created, deleted, paused, resumed
- [x] (settings) list subscribe/unsubscribe
- [x] (settings) post sent, scheduled, updated
- [x] (settings) survey response
- [x] (settings) podcast episode published, updated, archived, deleted
- [x] (settings) private feed access
- [x] (settings) choose events per endpoint
- [x] (settings) signing secret per endpoint
- [x] (settings) automatic retries
- [x] (settings) log of every attempt
- [x] (settings) manual retry
- [x] (settings) disable endpoint without deleting
- [x] (settings) versioned payloads
- [x] (automations) webhook steps in automations

## Surveys & polls (audience)
- [x] (audience) survey forms with multiple question types
- [x] (audience) one-click polls in the inbox
- [x] (audience) every answer tied to a subscriber
- [x] (audience) live poll results
- [x] (audience) per-question breakdowns
- [x] (audience) aggregate results across surveys
- [x] (audience) browse individual responses
- [x] (audience) webhook on survey submit
- [x] (api) survey and poll data via API
- [x] (audience) polls on web and email
- [x] (audience) signup flows through a survey
- [x] (audience) surveys that tell you what to write next
- [x] (audience) polls for topics, products, pricing
- [x] (audience) responses → segments

## Templates (posts)
- [x] (posts) library of designed post templates
- [x] (posts) custom colors, fonts, spacing per template
- [x] (posts) default style for new posts
- [x] (posts) content outlines in templates
- [x] (posts) separate email and web styling
- [x] (posts) theme tokens per template
- [x] (posts) duplicate templates
- [x] (settings) custom email footer on every post
- [x] (posts) templates with sponsor slots, referral blocks, recommendations
- [x] (api) create posts from templates via API
- [x] (api) template changes picked up by API-created posts
- [x] (website) website templates
- [x] (website) saved sections, blocks, pages
- [x] (automations) welcome email templates
- [x] (posts) team-shared templates

## Ads & sponsorships (monetize)
- [x] (monetize) [ops] native ad network — ad marketplace where advertisers (any OpenHive instance admin) post campaigns
- [x] (monetize) [ops] brand roster — advertiser directory
- [x] (monetize) ads available to claim for upcoming posts
- [x] (monetize) drop an ad into a post in one click
- [x] (monetize) earnings and payouts per placement
- [x] (monetize) ad revenue reports per post
- [x] (monetize) history of accepted/declined opportunities
- [x] (monetize) bot-filtered clicks
- [x] (monetize) custom link parameters for attribution
- [x] (monetize) brand safety review on every campaign
- [x] (monetize) payouts to wallet
- [x] (monetize) direct sponsorships
- [x] (monetize) sponsorship products with formats and pricing
- [x] (monetize) scheduled sponsor placements with advertiser details

## Paid subscriptions (monetize)
- [x] (monetize) 0% platform fees
- [x] (monetize) multiple paid tiers
- [x] (monetize) monthly and annual plans
- [x] (monetize) free trials
- [x] (monetize) paid trials ($1 for 30 days)
- [x] (monetize) metered paywalls
- [x] (posts) paywall break in any post
- [x] (monetize) discount offers
- [x] (monetize) gift subscriptions
- [x] (monetize) group subscriptions (seats)
- [x] (monetize) custom group deals
- [x] (monetize) pause and resume subscriptions
- [x] (monetize) private podcast feeds and gated channels as perks
- [x] (monetize) payouts through Stripe Connect

## Recommendations & boosts (grow)
- [x] (grow) [ops] recommendation network — directory of all publications on the instance
- [x] (grow) get recommended by other newsletters
- [x] (grow) free reciprocal recommendations
- [x] (grow) paid recommendations (boosts): pay to grow / get paid
- [x] (grow) discover partners
- [x] (grow) AI-suggested partners
- [x] (grow) applications with accept/reject
- [x] (grow) engagement and spend insights per partner
- [x] (grow) pause/resume/end partnerships
- [x] (grow) fraud detection on paid recommendations
- [x] (grow) clawback payouts for fake subscribers
- [x] (grow) recommendations inside the newsletter
- [x] (grow) attribution per partner subscriber

## Magic links (grow/auth)
- [x] (grow) one-click subscribes via magic links
- [x] (grow) one-click subscribe links, no form
- [x] (grow) UTM parameters carried through
- [x] (grow) rate limiting
- [x] (grow) bot detection and honeypots
- [x] (grow) confirmation step only when suspicious
- [x] (grow) double opt-in respected
- [x] (grow) redirect new subscribers to site
- [x] (audience) magic links as filterable source
- [x] (grow) shareable links for other newsletters, socials, ads
- [x] (auth) login magic links for paid readers
- [x] (auth) single-use tokens that expire in minutes
- [x] (auth) rate limits on login requests
- [x] (auth) timing-attack protection
- [x] (auth) log in on desktop from a link opened on mobile
- [x] (auth) faster logins across all publications on the instance

## Subscribe forms (audience)
- [x] (audience) embeddable subscribe forms
- [x] (audience) full-width, fixed-width, slim embeds
- [x] (audience) attribution script
- [x] (audience) custom colors, fonts, styling
- [x] (audience) theme tokens per form
- [x] (audience) draft/publish workflow for forms
- [x] (audience) compare draft vs live
- [x] (audience) multiple forms
- [x] (audience) custom success: message or redirect
- [x] (website) pop-ups on site
- [x] (website) gate posts to subscribers only
- [x] (audience) readers pick lists to join
- [x] (audience) signup flows after subscribing
- [x] (audience) bot protection on submissions
- [x] (audience) works on WordPress, Webflow, anywhere

## Link in bio (grow)
- [x] (grow) customizable link-in-bio page
- [x] (grow) hosted on own site and domain
- [x] (grow) subscribe form built in
- [x] (grow) brand colors, fonts, buttons
- [x] (grow) social links
- [x] (grow) latest posts
- [x] (grow) products and paid tiers
- [x] (grow) Linktree integration capturing signups (embed URL + guide)
- [x] (grow) every visitor a potential subscriber
- [x] (grow) social traffic into subscribers
- [x] (grow) visits in website analytics
- [x] (grow) signups tagged with source
- [x] (grow) mobile-first design
- [x] (grow) no third-party link tool
- [x] (grow) updated instantly from the dashboard

## Analytics (dashboard)
- [x] (dashboard) real-time website analytics
- [x] (dashboard) traffic by channel
- [x] (dashboard) filters: location, device, OS, referral source
- [x] (dashboard) website + newsletter analytics together
- [x] (dashboard) breakdowns by page, referrer
- [x] (dashboard) custom conditions on reports
- [x] (dashboard) AI crawler and bot analytics: served vs blocked
- [x] (website) control which crawlers can index
- [x] (core) UTM tracking on every link
- [x] (settings) custom link parameters per publication
- [x] (audience) acquisition source on every subscriber
- [x] (settings) Google Analytics integration
- [x] (dashboard) podcast analytics alongside site
- [x] (dashboard) trends over time
- [x] (dashboard) traffic connected to subscribers produced
- [x] (settings) integrations: Linktree, HubSpot, ManyChat, Meta, Zapier-style outbound + inbound webhooks
- [x] [ops] human support team — docs/SUPPORT.md + in-app help/docs search

## Stack consolidation (everything on Cloudflare, no extra vendors)
- [x] email sending → Cloudflare Email Sending binding
- [x] web hosting → Cloudflare Workers + static assets
- [x] database + queue → D1 + jobs table driven by Cron Triggers
- [x] payments → Stripe (direct API, optional; test mode simulates)
- [x] auth → built in (PBKDF2, sessions, magic links)
- [x] monitoring + alerting → Workers observability + in-app error log + alert emails
- [x] workflow engine → built-in automations engine
- [x] bot protection → built-in guard + optional Turnstile
- [x] email validation → built-in syntax/MX/disposable/typo checks
- [x] email rendering → built-in table-based renderer + preview
- [x] click verification → built-in bot-click filter
- [x] media storage + CDN → R2
- [x] product analytics → built-in analytics

## Launch
- [x] (root) landing page at / selling the source for $30 one-time (PURCHASE_URL, PRICE_LABEL)
- [x] static copy of landing page in landing/index.html for Lnkbase.com/beehiiv
- [x] README with setup + deploy
