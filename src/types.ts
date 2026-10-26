import type { Context, Hono } from 'hono';

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket; // falls back to D1 storage (lib/mediashim) when R2 isn't bound
  ASSETS: Fetcher;
  COLLAB: DurableObjectNamespace;
  LIVE: DurableObjectNamespace;
  CHAT: DurableObjectNamespace;
  EMAIL?: SendEmail;
  AI?: Ai;
  IMAGES?: ImagesBinding; // Cloudflare Images: server-side resize of imported images
  APP_NAME: string;
  APP_URL: string;
  MAIL_FROM: string;
  PURCHASE_URL: string;
  PRICE_LABEL: string;
  PLATFORM_FEE_PERCENT: string;
  CONTACT_EMAIL?: string;
  TRY_IT?: string;            // '1' turns on /try ("send me a sample issue", real email even in simulate mode) — demo only
  TRY_PUB_SLUG?: string;      // publication whose latest post is sent (default 'demo')
  TRY_POST_ID?: string;       // optional: send this post instead of the latest published one
  TRY_DAILY_CAP?: string;     // max sample emails per day (default 100)     // shown in the marketing site footer
  // optional secrets
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  EMAIL_MODE?: string; // 'simulate' forces outbox-only; default sends via binding when present
  SUPERADMIN_EMAILS?: string; // comma separated
  REALTIME_APP_ID?: string;   // Cloudflare Realtime SFU app (large live events)
  REALTIME_APP_TOKEN?: string;
  REALTIME_API_BASE?: string; // override for testing / self-hosted SFU
  GIPHY_API_KEY?: string;     // GIF search in the editor (or per-publication in Integrations)
  DISCORD_CLIENT_ID?: string;     // Discord OAuth2 app for verified member linking (or per publication in Community → Settings)
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_API_BASE?: string;      // override for testing (default https://discord.com/api)
  // Inbound mail (Email Routing → email() handler). See docs/DELIVERABILITY.md.
  INBOUND_FORWARD_TO?: string;  // verified destination for human replies that reach a routed address (otherwise rejected)
  BOUNCE_ADDRESS?: string;      // shown in Settings → Email; default bounces@<MAIL_FROM domain>
  FBL_ADDRESS?: string;         // address you register with mailbox-provider FBLs; default fbl@<MAIL_FROM domain>
  MAIL_FROM_WARMUP?: string;    // 'off' disables warm-up caps for the default MAIL_FROM domain
  // Hosted service (Lnkbase Newsletter)
  SHARED_FROM_DOMAIN?: string;  // publications without a verified domain send from <slug>@<this>; default MAIL_FROM's domain
}

export type Role = 'owner' | 'admin' | 'member' | 'contributor';

export interface User {
  id: string; email: string; name: string; avatar_url: string | null; bio: string | null;
  socials: string; is_guest: number; is_superadmin: number; email_verified: number; created_at: number;
}

export interface Publication {
  id: string; workspace_id: string; slug: string; name: string; description: string;
  logo_url: string | null; favicon_url: string | null; language: string; timezone: string; category: string | null;
  from_name: string | null; reply_to: string | null; footer_html: string; address: string;
  theme: string; email_style: string; settings: string; custom_domain: string | null; status: string; created_at: number;
}

export interface Subscriber {
  id: string; pub_id: string; email: string; name: string; status: string; tier: string; tier_id: string | null;
  trial_ends_at: number | null; source: string; source_detail: string | null;
  utm_source: string | null; utm_medium: string | null; utm_campaign: string | null; utm_term: string | null; utm_content: string | null;
  referrer_url: string | null; landing_path: string | null; referral_code: string; referred_by: string | null; referral_count: number;
  custom: string; country: string | null; ip: string | null; stripe_customer_id: string | null;
  confirmed_at: number | null; unsubscribed_at: number | null; unsubscribe_reason: string | null;
  last_open_at: number | null; last_click_at: number | null; open_count: number; click_count: number; received_count: number;
  engagement: number; created_at: number; updated_at: number;
}

export interface Post {
  id: string; pub_id: string; title: string; subtitle: string; slug: string; content: string; email_content: string | null;
  status: string; platform: string; audience: string; tier_ids: string; list_id: string | null; segment_ids: string; exclude_segment_ids: string;
  email_subject: string | null; preview_text: string; ab_test: string | null; cohort_test: string | null; sender_id: string | null;
  thumbnail_url: string | null; seo: string; template_id: string | null; style: string; comments_enabled: number; hide_from_feed: number;
  audio_key: string | null; word_count: number; scheduled_at: number | null; published_at: number | null; created_by: string | null;
  created_at: number; updated_at: number;
}

/** Variables set by middleware. Dashboard routes always have user+pub+role; site routes have pub (+reader). */
export interface Vars {
  user: User;
  pub: Publication;
  role: Role;
  pubs: Array<Publication & { role: Role }>;
  reader: { email: string; subscriber: Subscriber | null; premium: boolean } | null;
  apiPub: Publication;
  flash: { kind: 'ok' | 'err'; msg: string } | null;
  csp_nonce: string;
}

export type AppEnv = { Bindings: Env; Variables: Vars };
export type Ctx = Context<AppEnv>;
export type App = Hono<AppEnv>;

/** Every route module exports this shape. See docs/ARCHITECTURE.md */
export interface Module {
  /** mounted at /app/<name>  (requires login + publication) */
  dash?: App;
  /** mounted at /s/:slug  and on custom domains (publication resolved) */
  site?: App;
  /** mounted at / (public, no pub context) */
  root?: App;
}
