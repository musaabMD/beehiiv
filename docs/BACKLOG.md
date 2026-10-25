# OpenHive Backlog

Every item below must be built and working. Each line is tagged with the module that owns it.
`[ops]` = an operational/people/scale claim: we ship the software side (config, tooling, docs) and note what an operator must do.
Tick an item (`[x]`) only after it works end to end in `wrangler dev`.

Modules: auth, dashboard, posts, website, podcasts, community, events, audience, automations, monetize, grow, settings, api, mcp, core (src/lib).

## Deliverability & protection
- [ ] (core) [ops] 99.3% delivery rate — deliverability dashboard per publication showing delivered/bounced/complained rates
- [ ] (core) [ops] deliverability expertise — built-in deliverability checklist + docs/DELIVERABILITY.md
- [ ] (core) [ops] infrastructure to send 3M+ emails per minute — batched, queue-driven sender that fans out via cron + waitUntil; throughput setting
- [ ] (core) validating every email submission (1st and 3rd party: forms, API, imports)
- [ ] (core) automated bot-detection to prevent spam signups
- [ ] (core) [ops] feedback-loop program registration — FBL inbound endpoint + docs
- [ ] (core) ingesting feedback-loop data and building suppression lists (/hooks/fbl, /hooks/bounce)
- [ ] (core) tagging every email (Feedback-ID header) so Gmail reports complaint rates per newsletter
- [ ] (core) classifying every bounce (hard, soft, mailbox full, DNS failure) → retry vs never again
- [ ] (core) three layers of suppression: global, per-publication, transactional
- [ ] (core) temporary suppressions that expire, permanent ones that never do
- [ ] (core) one-click unsubscribe (RFC 8058 List-Unsubscribe + List-Unsubscribe-Post)
- [ ] (core) [ops] warming new IPs and domains on a schedule — per-domain daily warmup caps
- [ ] (core) [ops] blocklist monitoring — DNSBL check of sending domains on cron, pause sender when listed
- [ ] (core) retrying deferred mail for 24+ hours before calling it a bounce
- [ ] (core) blocking disposable, invalid, and typo'd addresses before they reach the list
- [ ] (core) rate limiting every signup endpoint
- [ ] (core) filtering bot clicks out of every report
- [ ] (core) an acquisition source on every subscriber
- [ ] (audience) engagement history for every reader, across every post
- [ ] (settings) multiple sender addresses for different emails
- [ ] (settings) custom domain configuration aligned with DKIM, SPF, DMARC (DNS record generator + live DNS check)

## Editor (posts)
- [ ] (posts) true WYSIWYG editor, no HTML required
- [ ] (posts) table-based, inline-styled email HTML that holds up in Outlook
- [ ] (posts) real-time collaborative editing (Durable Object)
- [ ] (posts) dynamic content: sections per segment/tier in a single send
- [ ] (posts) separate email and web versions of every post from one draft
- [ ] (posts) free and premium versions split by a paywall break
- [ ] (posts) merge tags + simulated subscriber preview
- [ ] (posts) templates with saved colors, fonts, spacing + default post style
- [ ] (posts) columns, tables, buttons, blockquotes, sections, file attachments, table of contents with anchors
- [ ] (posts) native embeds: X, YouTube, TikTok, Instagram, Bluesky, Stocktwits, podcast episodes
- [ ] (posts) polls, referral blocks, recommendations, ad slots in the post
- [ ] (posts) AI writer, AI images, AI agent one shortcut away (⌘J)
- [ ] (posts) images resized and optimized automatically
- [ ] (posts) live email-size gauge (Gmail clips at 102KB)
- [ ] (posts) custom HTML blocks, sanitized
- [ ] (posts) hide video/iframes/audio in email, keep on web
- [ ] (posts) links and embeds clickable in Outlook
- [ ] (posts) vertical alignment in columns
- [ ] (posts) audio versions of newsletters (TTS)
- [ ] (posts) random cohort sends (split list, test content)
- [ ] (posts) slash commands
- [ ] (posts) markdown and keyboard shortcuts
- [ ] (posts) pasting from Google Docs with formatting intact
- [ ] (posts) search and replace across the post
- [ ] (posts) comment threads in the draft
- [ ] (posts) footnotes and citations (inbox + web)
- [ ] (posts) code blocks
- [ ] (posts) AI rewrite, translate, fix spelling/grammar in place
- [ ] (posts) autosave
- [ ] (posts) subject line A/B testing in the send flow
- [ ] (posts) drag-and-drop images from computer, media library, or URL
- [ ] (posts) rich-text image captions, titles, alt text
- [ ] (posts) inline audio files
- [ ] (posts) file attachments
- [ ] (posts) sections with backgrounds, borders, spacing
- [ ] (posts) blockquotes with custom borders, colors, styles
- [ ] (posts) content breaks and dividers

## API
- [ ] (api) REST API for subscribers, posts, segments, automations, and more
- [ ] (api) send API to create and send newsletters
- [ ] (api) create/update/delete subscribers in real time
- [ ] (api) read/write custom fields
- [ ] (api) tag subscribers
- [ ] (api) enroll subscribers into automations
- [ ] (api) opens, clicks, engagement per post
- [ ] (api) post HTML rendered free vs premium, email vs web
- [ ] (api) create posts from a template, append/prepend content
- [ ] (api) segments and their subscribers
- [ ] (api) tiers and premium subscriptions
- [ ] (api) referral program data and milestones
- [ ] (api) poll and survey responses
- [ ] (api) cursor pagination for millions of records
- [ ] (api) rate limits
- [ ] (settings) API keys create/revoke

## MCP server (AI tools)
- [ ] (mcp) MCP server endpoint (/mcp, streamable HTTP, API-key auth)
- [ ] (mcp) draft and edit posts
- [ ] (mcp) open rates, CTR, revenue in plain English
- [ ] (mcp) compare performance across posts
- [ ] (mcp) subscriber full history
- [ ] (mcp) build segments by describing them
- [ ] (mcp) create/edit automations
- [ ] (mcp) generate AI images into media library
- [ ] (mcp) website pages, redirects, SEO
- [ ] (mcp) read/reply community posts and DMs
- [ ] (mcp) ad offers and ad revenue reports
- [ ] (mcp) podcast shows and episodes
- [ ] (mcp) digital products, coupons, promo codes
- [ ] (mcp) subscriber growth and earnings reports
- [ ] (mcp) subject line A/B tests
- [ ] (mcp) deliverability by mailbox provider per post
- [ ] (mcp) searching docs

## Team & workspace (settings/auth)
- [ ] (settings) invite teammates by email
- [ ] (settings) admin, member, contributor roles
- [ ] (settings) admins control billing, exports, integrations, payments, domains
- [ ] (settings) members: full access minus admin
- [ ] (settings) contributors: draft posts and automations only
- [ ] (settings) roles at workspace or publication level
- [ ] (settings) multiple publications under one workspace
- [ ] (settings) workspace grouping and search for people on multiple teams
- [ ] (posts) multiple authors per post with bylines
- [ ] (settings) guest authors
- [ ] (settings) author profiles: bio, avatar, social links
- [ ] (community) community roles mapped to workspace roles
- [ ] (posts) real-time collaboration + comment threads on drafts
- [ ] (settings) removing access instantly
- [ ] (settings) publication transfers with written consent
- [ ] (auth) secure single-use magic links to log in from desktop

## Website builder
- [ ] (website) no-code website builder on custom domain
- [ ] (website) AI website builder from prompts or screenshots
- [ ] (website) AI custom elements for live widgets
- [ ] (website) drag-and-drop editing + HTML access
- [ ] (website) theme tokens: fonts, colors, borders, shadows
- [ ] (website) global navbar, footer, signup/login modals
- [ ] (website) saving sections, blocks, pages as templates
- [ ] (website) version history with one-click restore
- [ ] (website) custom pages with SEO and paywalls
- [ ] (website) redirects
- [ ] (website) custom robots.txt
- [ ] (website) auto-generated meta titles/descriptions
- [ ] (website) Google News schema
- [ ] (website) fast LCP (SSR, no client framework, preloads, cache headers)
- [ ] (website) image carousels and grids
- [ ] (website) YouTube blocks that update with new videos
- [ ] (podcasts) automatic page per podcast episode
- [ ] (website) pop-ups and gated content

## Automations
- [ ] (automations) visual automation builder
- [ ] (automations) triggers: signup source, behavior, purchases, engagement
- [ ] (automations) welcome sequences
- [ ] (automations) delays and wait steps
- [ ] (automations) branching on subscriber attributes
- [ ] (automations) reusable condition sets
- [ ] (automations) email steps with the newsletter editor
- [ ] (automations) webhook steps with retries
- [ ] (automations) enroll via API
- [ ] (automations) per-subscriber journey tracking
- [ ] (automations) opens/clicks per email in every flow
- [ ] (automations) edit draft version while live keeps running
- [ ] (automations) compare draft vs live
- [ ] (automations) reorder steps in bulk
- [ ] (audience) segment conditions: automation started
- [ ] (monetize) product delivery and follow-ups triggered by purchases

## Digital products (monetize)
- [ ] (monetize) sell files, links, guides, templates, ebooks
- [ ] (monetize) memberships and time-based products
- [ ] (monetize) 1:1 coaching sessions and appointments
- [ ] (monetize) 0% platform fees
- [ ] (monetize) storefront on the website
- [ ] (monetize) products sold inside emails and automations
- [ ] (monetize) free products as lead magnets
- [ ] (monetize) product variants
- [ ] (monetize) discount and promotion codes
- [ ] (monetize) product reviews with moderation
- [ ] (monetize) product tags
- [ ] (monetize) orders dashboard with buyer details
- [ ] (monetize) sales totals per product
- [ ] (monetize) duplicate product
- [ ] (monetize) automatic delivery on purchase
- [ ] (monetize) payouts through Stripe

## Events / webinars
- [ ] (events) live webinars up to 10,000 attendees
- [ ] (events) ticket sales in 10 currencies
- [ ] (events) native streaming with video, screen share, chat (WebRTC + Durable Object chat)
- [ ] (events) no Zoom required
- [ ] (events) up to 5 automated reminder emails
- [ ] (events) calendar invites (.ics) sent automatically
- [ ] (events) recording of every session
- [ ] (events) sell the replay as a product
- [ ] (events) 0% platform fees on tickets
- [ ] (events) free webinars that grow the list
- [ ] (events) discount codes on tickets
- [ ] (events) 1:1 coaching bookings
- [ ] (events) buyers linked to subscriber profile
- [ ] (events) promote events in newsletter and site
- [ ] (events) orders and revenue reporting per event

## Community
- [ ] (community) channels, posts, comments
- [ ] (community) channels free or gated to tiers
- [ ] (community) sync newsletter posts into community
- [ ] (community) direct messages
- [ ] (community) threaded comments
- [ ] (community) pinned posts
- [ ] (community) moderation queue for reports
- [ ] (community) ban/unban members
- [ ] (community) admin, manager, moderator roles
- [ ] (community) invite subscribers, segments, or emails
- [ ] (community) surface most engaged subscribers to invite
- [ ] (community) metrics: new members, posts, activity
- [ ] (community) notification emails with own from name
- [ ] (community) channel ordering and default channel
- [ ] (events) Luma calendar integration
- [ ] (community) Discord integration syncing roles with tiers

## Podcasts
- [ ] (podcasts) native hosting, zero fees (R2)
- [ ] (podcasts) distribution to Apple, Spotify, YouTube (RSS + submission guide)
- [ ] (podcasts) automatic webpage per episode
- [ ] (podcasts) automatic transcripts (Workers AI Whisper when bound; manual upload otherwise)
- [ ] (podcasts) IAB-style analytics by country, app, device
- [ ] (podcasts) bot filtering on downloads
- [ ] (podcasts) downloads and unique listeners per episode/show
- [ ] (podcasts) private feeds for paying subscribers
- [ ] (podcasts) bundle podcast with paid subscription
- [ ] (podcasts) import from other hosts preserving GUIDs
- [ ] (podcasts) RSS redirects
- [ ] (podcasts) scheduled episodes
- [ ] (podcasts) Apple categories and metadata
- [ ] (posts) podcast players embedded in posts
- [ ] (podcasts) full episode library on site
- [ ] (podcasts) webhooks for episode and private-feed events

## Segments & lists (audience)
- [ ] (audience) segments on behavior, attributes, engagement
- [ ] (audience) dynamic segments
- [ ] (audience) static segments
- [ ] (audience) filter by acquisition source incl. magic links
- [ ] (audience) filter by custom fields and tags
- [ ] (audience) filter by tier and paid trial status
- [ ] (audience) filter by automation started
- [ ] (audience) reusable condition sets
- [ ] (audience) recalculate segment on demand
- [ ] (posts) send to a segment or exclude one
- [ ] (posts) segments power dynamic content
- [ ] (automations) segments as automation conditions
- [ ] (audience) add a segment to a newsletter list
- [ ] (audience) multiple newsletter lists per publication
- [ ] (audience) export any segment

## Webhooks (settings)
- [ ] (settings) subscriber created, confirmed, deleted
- [ ] (settings) upgrade, downgrade, pause, resume
- [ ] (settings) tier created, deleted, paused, resumed
- [ ] (settings) list subscribe/unsubscribe
- [ ] (settings) post sent, scheduled, updated
- [ ] (settings) survey response
- [ ] (settings) podcast episode published, updated, archived, deleted
- [ ] (settings) private feed access
- [ ] (settings) choose events per endpoint
- [ ] (settings) signing secret per endpoint
- [ ] (settings) automatic retries
- [ ] (settings) log of every attempt
- [ ] (settings) manual retry
- [ ] (settings) disable endpoint without deleting
- [ ] (settings) versioned payloads
- [ ] (automations) webhook steps in automations

## Surveys & polls (audience)
- [ ] (audience) survey forms with multiple question types
- [ ] (audience) one-click polls in the inbox
- [ ] (audience) every answer tied to a subscriber
- [ ] (audience) live poll results
- [ ] (audience) per-question breakdowns
- [ ] (audience) aggregate results across surveys
- [ ] (audience) browse individual responses
- [ ] (audience) webhook on survey submit
- [ ] (api) survey and poll data via API
- [ ] (audience) polls on web and email
- [ ] (audience) signup flows through a survey
- [ ] (audience) surveys that tell you what to write next
- [ ] (audience) polls for topics, products, pricing
- [ ] (audience) responses → segments

## Templates (posts)
- [ ] (posts) library of designed post templates
- [ ] (posts) custom colors, fonts, spacing per template
- [ ] (posts) default style for new posts
- [ ] (posts) content outlines in templates
- [ ] (posts) separate email and web styling
- [ ] (posts) theme tokens per template
- [ ] (posts) duplicate templates
- [ ] (settings) custom email footer on every post
- [ ] (posts) templates with sponsor slots, referral blocks, recommendations
- [ ] (api) create posts from templates via API
- [ ] (api) template changes picked up by API-created posts
- [ ] (website) website templates
- [ ] (website) saved sections, blocks, pages
- [ ] (automations) welcome email templates
- [ ] (posts) team-shared templates

## Ads & sponsorships (monetize)
- [ ] (monetize) [ops] native ad network — ad marketplace where advertisers (any OpenHive instance admin) post campaigns
- [ ] (monetize) [ops] brand roster — advertiser directory
- [ ] (monetize) ads available to claim for upcoming posts
- [ ] (monetize) drop an ad into a post in one click
- [ ] (monetize) earnings and payouts per placement
- [ ] (monetize) ad revenue reports per post
- [ ] (monetize) history of accepted/declined opportunities
- [ ] (monetize) bot-filtered clicks
- [ ] (monetize) custom link parameters for attribution
- [ ] (monetize) brand safety review on every campaign
- [ ] (monetize) payouts to wallet
- [ ] (monetize) direct sponsorships
- [ ] (monetize) sponsorship products with formats and pricing
- [ ] (monetize) scheduled sponsor placements with advertiser details

## Paid subscriptions (monetize)
- [ ] (monetize) 0% platform fees
- [ ] (monetize) multiple paid tiers
- [ ] (monetize) monthly and annual plans
- [ ] (monetize) free trials
- [ ] (monetize) paid trials ($1 for 30 days)
- [ ] (monetize) metered paywalls
- [ ] (posts) paywall break in any post
- [ ] (monetize) discount offers
- [ ] (monetize) gift subscriptions
- [ ] (monetize) group subscriptions (seats)
- [ ] (monetize) custom group deals
- [ ] (monetize) pause and resume subscriptions
- [ ] (monetize) private podcast feeds and gated channels as perks
- [ ] (monetize) payouts through Stripe Connect

## Recommendations & boosts (grow)
- [ ] (grow) [ops] recommendation network — directory of all publications on the instance
- [ ] (grow) get recommended by other newsletters
- [ ] (grow) free reciprocal recommendations
- [ ] (grow) paid recommendations (boosts): pay to grow / get paid
- [ ] (grow) discover partners
- [ ] (grow) AI-suggested partners
- [ ] (grow) applications with accept/reject
- [ ] (grow) engagement and spend insights per partner
- [ ] (grow) pause/resume/end partnerships
- [ ] (grow) fraud detection on paid recommendations
- [ ] (grow) clawback payouts for fake subscribers
- [ ] (grow) recommendations inside the newsletter
- [ ] (grow) attribution per partner subscriber

## Magic links (grow/auth)
- [ ] (grow) one-click subscribes via magic links
- [ ] (grow) one-click subscribe links, no form
- [ ] (grow) UTM parameters carried through
- [ ] (grow) rate limiting
- [ ] (grow) bot detection and honeypots
- [ ] (grow) confirmation step only when suspicious
- [ ] (grow) double opt-in respected
- [ ] (grow) redirect new subscribers to site
- [ ] (audience) magic links as filterable source
- [ ] (grow) shareable links for other newsletters, socials, ads
- [ ] (auth) login magic links for paid readers
- [ ] (auth) single-use tokens that expire in minutes
- [ ] (auth) rate limits on login requests
- [ ] (auth) timing-attack protection
- [ ] (auth) log in on desktop from a link opened on mobile
- [ ] (auth) faster logins across all publications on the instance

## Subscribe forms (audience)
- [ ] (audience) embeddable subscribe forms
- [ ] (audience) full-width, fixed-width, slim embeds
- [ ] (audience) attribution script
- [ ] (audience) custom colors, fonts, styling
- [ ] (audience) theme tokens per form
- [ ] (audience) draft/publish workflow for forms
- [ ] (audience) compare draft vs live
- [ ] (audience) multiple forms
- [ ] (audience) custom success: message or redirect
- [ ] (website) pop-ups on site
- [ ] (website) gate posts to subscribers only
- [ ] (audience) readers pick lists to join
- [ ] (audience) signup flows after subscribing
- [ ] (audience) bot protection on submissions
- [ ] (audience) works on WordPress, Webflow, anywhere

## Link in bio (grow)
- [ ] (grow) customizable link-in-bio page
- [ ] (grow) hosted on own site and domain
- [ ] (grow) subscribe form built in
- [ ] (grow) brand colors, fonts, buttons
- [ ] (grow) social links
- [ ] (grow) latest posts
- [ ] (grow) products and paid tiers
- [ ] (grow) Linktree integration capturing signups (embed URL + guide)
- [ ] (grow) every visitor a potential subscriber
- [ ] (grow) social traffic into subscribers
- [ ] (grow) visits in website analytics
- [ ] (grow) signups tagged with source
- [ ] (grow) mobile-first design
- [ ] (grow) no third-party link tool
- [ ] (grow) updated instantly from the dashboard

## Analytics (dashboard)
- [ ] (dashboard) real-time website analytics
- [ ] (dashboard) traffic by channel
- [ ] (dashboard) filters: location, device, OS, referral source
- [ ] (dashboard) website + newsletter analytics together
- [ ] (dashboard) breakdowns by page, referrer
- [ ] (dashboard) custom conditions on reports
- [ ] (dashboard) AI crawler and bot analytics: served vs blocked
- [ ] (website) control which crawlers can index
- [ ] (core) UTM tracking on every link
- [ ] (settings) custom link parameters per publication
- [ ] (audience) acquisition source on every subscriber
- [ ] (settings) Google Analytics integration
- [ ] (dashboard) podcast analytics alongside site
- [ ] (dashboard) trends over time
- [ ] (dashboard) traffic connected to subscribers produced
- [ ] (settings) integrations: Linktree, HubSpot, ManyChat, Meta, Zapier-style outbound + inbound webhooks
- [ ] [ops] human support team — docs/SUPPORT.md + in-app help/docs search

## Stack consolidation (everything on Cloudflare, no extra vendors)
- [ ] email sending → Cloudflare Email Sending binding
- [ ] web hosting → Cloudflare Workers + static assets
- [ ] database + queue → D1 + jobs table driven by Cron Triggers
- [ ] payments → Stripe (direct API, optional; test mode simulates)
- [ ] auth → built in (PBKDF2, sessions, magic links)
- [ ] monitoring + alerting → Workers observability + in-app error log + alert emails
- [ ] workflow engine → built-in automations engine
- [ ] bot protection → built-in guard + optional Turnstile
- [ ] email validation → built-in syntax/MX/disposable/typo checks
- [ ] email rendering → built-in table-based renderer + preview
- [ ] click verification → built-in bot-click filter
- [ ] media storage + CDN → R2
- [ ] product analytics → built-in analytics

## Launch
- [ ] (root) landing page at / selling the source for $30 one-time (PURCHASE_URL, PRICE_LABEL)
- [ ] static copy of landing page in landing/index.html for Lnkbase.com/beehiiv
- [ ] README with setup + deploy
