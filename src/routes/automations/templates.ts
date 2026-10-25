// Prebuilt automation templates (welcome series, lead magnet, re-engagement, post-purchase, event drip, upgrade nurture).
import type { Step } from '../../lib/automations';
import { id } from '../../lib/util';

const p = (html: string) => ({ id: id(8), type: 'paragraph', data: { html } });
const h = (html: string) => ({ id: id(8), type: 'heading', data: { level: 2, html } });
const btn = (label: string, url: string) => ({ id: id(8), type: 'button', data: { label, url, align: 'center' } });
const email = (subject: string, preview: string, blocks: any[]): Step => ({ id: id(10), type: 'send_email', config: { subject, preview_text: preview, doc: { blocks } } });
const delay = (amount: number, unit: string): Step => ({ id: id(10), type: 'delay', config: { amount, unit } });
const tag = (t: string): Step => ({ id: id(10), type: 'add_tag', config: { tags: [t] } });

export interface AutomationTemplate { key: string; name: string; description: string; trigger: any; steps: () => Step[] }

export const TEMPLATES: AutomationTemplate[] = [
  {
    key: 'welcome', name: 'Welcome series (3 emails)', description: 'Greet new subscribers the moment they join, share your best work, then ask what they want to read.',
    trigger: { type: 'welcome', config: {} },
    steps: () => [
      email('Welcome to {{publication.name}} 👋', 'Here is what to expect', [
        p('Hi {{subscriber.first_name|there}},'),
        p("Thanks for subscribing to <strong>{{publication.name}}</strong>! You'll get a new issue in your inbox every week."),
        p('To make sure you never miss one, reply to this email with a quick "hi" — it helps your inbox know we are friends.'),
        btn('Read the latest issue', '{{publication.url}}'),
      ]),
      delay(2, 'days'),
      email('Our most-read posts', 'Start here', [
        h('Start here'),
        p('A few readers favourites to get you going:'),
        { id: id(8), type: 'list', data: { ordered: false, items: ['Our most popular post', 'A reader favourite', 'The issue that started it all'] } },
        btn('Browse the archive', '{{publication.url}}/archive'),
      ]),
      delay(3, 'days'),
      email('Quick question, {{subscriber.first_name|friend}}', 'What should we write about next?', [
        p("What brought you to {{publication.name}}? Hit reply and tell me — I read every response."),
        p('And if you know someone who would enjoy this newsletter, share your personal link:'),
        p('<a href="{{referral_url}}">{{referral_url}}</a>'),
      ]),
      tag('onboarded'),
    ],
  },
  {
    key: 'lead_magnet', name: 'Lead magnet delivery', description: 'Deliver a free download to people who sign up through a specific form, then follow up.',
    trigger: { type: 'signup', config: { sources: ['form'] } },
    steps: () => [
      email('Here is your free guide 🎁', 'Download link inside', [
        p('Hi {{subscriber.first_name|there}},'),
        p('As promised, here is your free guide. Click below to download it:'),
        btn('Download the guide', '{{publication.url}}'),
        p('Enjoy — and keep an eye on your inbox for our weekly issue.'),
      ]),
      tag('lead-magnet'),
      delay(3, 'days'),
      {
        id: id(10), type: 'condition', config: { rules: { op: 'and', rules: [{ field: 'last_open_at', cmp: 'within_days', value: 3 }] } },
        yes: [email('Did you get a chance to read it?', 'A few tips to get the most out of it', [p('Hope you enjoyed the guide! Here are three quick ways to put it into practice this week.')])],
        no: [email('Your guide is waiting', 'Still want it?', [p("Looks like you haven't opened your guide yet — here it is again."), btn('Download the guide', '{{publication.url}}')])],
      },
    ],
  },
  {
    key: 'reengage', name: 'Re-engagement', description: 'Win back subscribers who stopped opening, and clean up those who do not come back.',
    trigger: { type: 'inactive', config: { days: 60 } },
    steps: () => [
      email('Do you still want to hear from us?', 'Click to stay subscribed', [
        p('Hi {{subscriber.first_name|there}}, we noticed you have not opened {{publication.name}} in a while.'),
        p('If you still want to receive it, just click the button below. Otherwise, no hard feelings.'),
        btn('Yes, keep me subscribed', '{{publication.url}}'),
      ]),
      delay(7, 'days'),
      {
        id: id(10), type: 'condition', config: { rules: { op: 'and', rules: [{ field: 'last_open_at', cmp: 'within_days', value: 7 }] } },
        yes: [tag('re-engaged')],
        no: [tag('inactive'), { id: id(10), type: 'unsubscribe', config: {} }],
      },
    ],
  },
  {
    key: 'post_purchase', name: 'Post-purchase follow-up', description: 'Thank buyers, check in after they have used the product, and ask for a review.',
    trigger: { type: 'purchase', config: {} },
    steps: () => [
      tag('customer'),
      email('Thanks for your purchase! 🎉', 'Everything you need to get started', [p('Thank you for buying from {{publication.name}}! Your download link is in your receipt email.'), p('Reply anytime if you have questions.')]),
      delay(5, 'days'),
      email('How is it going?', 'We would love your feedback', [p('It has been a few days — how are you finding it?'), p('If you have a minute, leaving a review helps other readers decide.'), btn('Leave a review', '{{publication.url}}/shop')]),
    ],
  },
  {
    key: 'event_drip', name: 'Event reminder drip', description: 'Build anticipation after someone registers for an event and follow up with the replay.',
    trigger: { type: 'event_registered', config: {} },
    steps: () => [
      email("You're registered ✅", 'Save the date', [p("You're in! We'll send your join link before the event starts. Add it to your calendar using the invite attached to your confirmation.")]),
      delay(1, 'days'),
      email('What to prepare before the event', 'Get the most out of it', [p('Bring your questions — there will be a live Q&A at the end.')]),
      delay(3, 'days'),
      email('Thanks for joining! Here is the replay', 'Watch anytime', [p('Thanks for registering. Here is the replay and the slides.'), btn('Watch the replay', '{{publication.url}}/events')]),
    ],
  },
  {
    key: 'upgrade_nurture', name: 'Paid upgrade nurture', description: 'Show engaged free readers what premium includes and offer a trial.',
    trigger: { type: 'signup', config: {} },
    steps: () => [
      delay(7, 'days'),
      {
        id: id(10), type: 'condition', config: { rules: { op: 'and', rules: [{ field: 'tier', cmp: 'eq', value: 'free' }, { field: 'open_count', cmp: 'gt', value: 1 }] } },
        yes: [
          email('You might love premium', 'Here is what you are missing', [p("You've been reading {{publication.name}} for a week — thank you!"), p('Premium members get every deep-dive, the full archive and the community.'), btn('See premium plans', '{{publication.url}}/upgrade')]),
          delay(4, 'days'),
          { id: id(10), type: 'condition', config: { rules: { op: 'and', rules: [{ field: 'tier', cmp: 'eq', value: 'free' }] } }, yes: [email('A little gift: try premium', 'Limited-time trial', [p('Try premium free for a week — cancel anytime.'), btn('Start my trial', '{{publication.url}}/upgrade')])], no: [] },
        ],
        no: [],
      },
    ],
  },
];

export function templateByKey(key: string) {
  return TEMPLATES.find((t) => t.key === key);
}
