// Central event bus. emit() records subscriber activity, fans out to webhooks, and triggers automations.
import type { Env } from '../types';
import { insert } from './db';
import { id, now } from './util';

/** Public webhook event names (versioned payloads, see webhooks.ts). */
export const WEBHOOK_EVENTS = [
  'subscription.created', 'subscription.confirmed', 'subscription.deleted',
  'subscription.upgraded', 'subscription.downgraded', 'subscription.paused', 'subscription.resumed',
  'tier.created', 'tier.deleted', 'tier.paused', 'tier.resumed',
  'list.subscribed', 'list.unsubscribed',
  'post.sent', 'post.scheduled', 'post.updated',
  'survey.response_submitted', 'poll.vote',
  'podcast.episode.published', 'podcast.episode.updated', 'podcast.episode.archived', 'podcast.episode.deleted',
  'podcast.private_feed.accessed',
  'order.paid', 'event.registered', 'referral.milestone', 'community.post.created',
] as const;

type Listener = (env: Env, e: BusEvent) => Promise<void>;
const listeners: Listener[] = [];

export interface BusEvent {
  pubId: string;
  type: string;            // e.g. 'subscription.created', 'email.opened', 'tag.added'
  subscriberId?: string | null;
  refId?: string | null;
  data?: Record<string, unknown>;
  /** set false to skip activity row (e.g. tier events with no subscriber) */
  activity?: boolean;
}

/** Register a listener (webhooks + automations register themselves in their modules). */
export function onEvent(fn: Listener) {
  listeners.push(fn);
}

export async function emit(env: Env, e: BusEvent): Promise<void> {
  if (e.subscriberId && e.activity !== false) {
    await insert(env, 'activity', {
      id: id(), pub_id: e.pubId, subscriber_id: e.subscriberId, type: e.type, ref_id: e.refId ?? null,
      data: JSON.stringify(e.data ?? {}), created_at: now(),
    });
  }
  for (const l of listeners) {
    try {
      await l(env, e);
    } catch (err) {
      console.error('event listener failed', e.type, err);
    }
  }
}
