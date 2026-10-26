// Automation templates library (45 flows, like Kit's): each is one or more entry points + a step tree with real
// email copy (editor blocks), delays, branches and tags. Stored as code; "Use template" creates a draft automation.
// Templates whose trigger type is not registered in TRIGGERS (e.g. 'cart_abandoned' before the commerce module adds it)
// are hidden by availableTemplates().
import type { Step } from './automations';
import { TRIGGERS, triggerList } from './automations';
import { id } from './util';

// ───────── tiny DSL ─────────
type Block = { id: string; type: string; data: any };
const p = (html: string): Block => ({ id: id(8), type: 'paragraph', data: { html } });
const h = (html: string, level = 2): Block => ({ id: id(8), type: 'heading', data: { level, html } });
const btn = (label: string, url: string): Block => ({ id: id(8), type: 'button', data: { label, url, align: 'center' } });
const ul = (...items: string[]): Block => ({ id: id(8), type: 'list', data: { ordered: false, items } });
const ol = (...items: string[]): Block => ({ id: id(8), type: 'list', data: { ordered: true, items } });
const quote = (html: string, cite = ''): Block => ({ id: id(8), type: 'quote', data: { html, cite, style: { variant: 'line' } } });
const hi: Block = { id: 'hi', type: 'paragraph', data: { html: 'Hi {{subscriber.first_name|there}},' } }; // re-id'd per email (no id() at module scope)
const sign = () => p('— The {{publication.name}} team');
/** send_email step: strings become paragraphs */
const email = (subject: string, preview: string, ...body: Array<string | Block>): Step => ({
  id: id(10), type: 'send_email',
  config: { subject, preview_text: preview, doc: { blocks: body.map((b) => (typeof b === 'string' ? p(b) : { ...b, id: id(8) })) } },
});
const wait = (amount: number, unit: 'minutes' | 'hours' | 'days' | 'weeks' = 'days'): Step => ({ id: id(10), type: 'delay', config: { amount, unit } });
const tag = (...tags: string[]): Step => ({ id: id(10), type: 'add_tag', config: { tags } });
const untag = (...tags: string[]): Step => ({ id: id(10), type: 'remove_tag', config: { tags } });
const field = (key: string, value: string): Step => ({ id: id(10), type: 'update_field', config: { key, value } });
const iff = (rules: any[], yes: Step[], no: Step[] = [], op: 'and' | 'or' = 'and'): Step => ({ id: id(10), type: 'condition', config: { rules: { op, rules } }, yes, no });
const split = (pct: number, a: Step[], b: Step[]): Step => ({ id: id(10), type: 'ab_split', config: { pct }, yes: a, no: b });
const waitFor = (rules: any[], days: number): Step => ({ id: id(10), type: 'wait_until', config: { mode: 'condition', rules: { op: 'and', rules }, timeout_days: days } });
const premium = (days: number): Step => ({ id: id(10), type: 'grant_premium', config: { days } });
const notify = (subject: string, body: string): Step => ({ id: id(10), type: 'notify', config: { email: '', subject, body } });
const unsub = (): Step => ({ id: id(10), type: 'unsubscribe', config: {} });
// rules
const opened = (days: number) => ({ field: 'last_open_at', cmp: 'within_days', value: days });
const clicked = (days: number) => ({ field: 'last_click_at', cmp: 'within_days', value: days });
const hasTag = (t: string) => ({ field: 'tag', cmp: 'has', value: t });
const noTag = (t: string) => ({ field: 'tag', cmp: 'not_has', value: t });
const isFree = { field: 'tier', cmp: 'eq', value: 'free' };
const isPremium = { field: 'tier', cmp: 'eq', value: 'premium' };
const boughtAny = { field: 'purchased', cmp: 'any', value: '' };
const clickedUrl = (s: string) => ({ field: 'clicked_url', cmp: 'contains', value: s });
const trig = (type: string, config: any = {}) => ({ type, config });

export interface AutomationTemplate {
  key: string; name: string; description: string; category: string; icon: string;
  triggers: Array<{ type: string; config: any }>;
  steps: () => Step[];
  /** kept for older callers: the first entry point */
  trigger: { type: string; config: any };
}

export const CATEGORIES = ['Welcome & onboarding', 'Lead magnets', 'Courses & drips', 'Launches & sales', 'E-commerce', 'Engagement & win-back', 'Events & webinars', 'Paid subscriptions', 'Referrals & growth', 'Feedback & surveys', 'Dates & milestones', 'Integrations'] as const;

type Def = Omit<AutomationTemplate, 'trigger'>;
const T = (d: Def): AutomationTemplate => ({ ...d, trigger: d.triggers[0] });
const U = '{{publication.url}}';

export const TEMPLATES: AutomationTemplate[] = [
  // ───────── Welcome & onboarding ─────────
  T({
    key: 'welcome', category: 'Welcome & onboarding', icon: '👋', name: 'Welcome series (3 emails)',
    description: 'Greet new subscribers the moment they join, share your best work, then ask what they want to read.',
    triggers: [trig('welcome')],
    steps: () => [
      email('Welcome to {{publication.name}} 👋', 'Here is what to expect', hi,
        "Thanks for subscribing to <strong>{{publication.name}}</strong>! You'll get a new issue in your inbox every week.",
        'To make sure you never miss one, reply to this email with a quick “hi” — it tells your inbox we are friends.', btn('Read the latest issue', U), sign()),
      wait(2),
      email('Our most-read posts', 'Start here', h('Start here'), 'A few reader favourites to get you going:',
        ul('<b>Our most popular post</b> — the one everyone forwards', '<b>A reader favourite</b> — short, practical, useful today', '<b>The issue that started it all</b>'),
        btn('Browse the archive', `${U}/archive`)),
      wait(3),
      email('Quick question, {{subscriber.first_name|friend}}', 'What should we write about next?',
        'What brought you to {{publication.name}}? Hit reply and tell me — I read every response.',
        'And if you know someone who would enjoy this newsletter, share your personal link: <a href="{{referral_url}}">{{referral_url}}</a>'),
      tag('onboarded'),
    ],
  }),
  T({
    key: 'welcome_single', category: 'Welcome & onboarding', icon: '✉️', name: 'Single welcome email',
    description: 'One warm, simple welcome email that sets expectations and links to your best post.',
    triggers: [trig('welcome')],
    steps: () => [
      email('You’re in! Welcome to {{publication.name}}', 'Here’s what happens next', hi,
        "You're officially subscribed. Every issue lands in this inbox — no spam, unsubscribe any time.",
        'While you wait for the next one, here is the post most readers start with:', btn('Start with our best post', U),
        'Talk soon,', sign()),
    ],
  }),
  T({
    key: 'welcome_5day', category: 'Welcome & onboarding', icon: '🗓️', name: '5-day welcome sequence',
    description: 'A daily email for the first five days: your story, best posts, how to get the most out of the newsletter, community and a reply ask.',
    triggers: [trig('welcome')],
    steps: () => [
      email('Day 1: Welcome — here’s why {{publication.name}} exists', 'The short story', hi,
        'Welcome aboard! Over the next five days I’ll send one short email a day so you get the most out of {{publication.name}}.',
        'Today: why this newsletter exists. I started it because I couldn’t find a single, honest source that cut through the noise — so I built one.',
        'Tomorrow I’ll send you the three posts readers say changed how they think.', sign()),
      wait(1),
      email('Day 2: The 3 posts to read first', 'Reader favourites', h('Start with these'),
        ol('<b>The fundamentals</b> — the post everything else builds on', '<b>The contrarian take</b> — the one that got the most replies', '<b>The practical guide</b> — bookmark this one'),
        btn('Open the archive', `${U}/archive`)),
      wait(1),
      email('Day 3: How to get the most out of each issue', 'Two minutes of setup', hi,
        ul('Move this email to your <b>Primary</b> tab (Gmail) or mark the sender as a VIP (Apple Mail).', 'Skim the summary at the top — every issue is built to be useful in 2 minutes.', 'Hit reply whenever something resonates. Replies shape future issues.')),
      wait(1),
      email('Day 4: Meet the other readers', 'You’re in good company',
        'Thousands of curious people read {{publication.name}} — founders, students, operators and hobbyists.',
        'If a friend would like it too, your personal invite link is <a href="{{referral_url}}">{{referral_url}}</a>. Every referral helps the newsletter grow.'),
      wait(1),
      email('Day 5: What should I write about next?', 'One question',
        'That’s the end of the welcome week! One last thing: <b>what’s the one topic you want me to cover?</b>',
        'Just hit reply — I read every message and many issues start from a reader question.', sign()),
      tag('onboarded'),
    ],
  }),
  T({
    key: 'welcome_interests', category: 'Welcome & onboarding', icon: '🧭', name: 'Welcome with interest picker',
    description: 'Ask new readers to click the topic they care about, tag them by interest, and follow up with matching content.',
    triggers: [trig('welcome')],
    steps: () => [
      email('Welcome! What are you most interested in?', 'One click to personalize your newsletter', hi,
        'Thanks for joining {{publication.name}}. To send you more of what you like, click the topic you care about most:',
        btn('Strategy & big ideas', `${U}/?interest=strategy`), btn('Tools & how-tos', `${U}/?interest=tools`), btn('News & analysis', `${U}/?interest=news`),
        'One click is all it takes — you’ll still get every issue.'),
      wait(2),
      iff([clickedUrl('interest=strategy')], [tag('interest-strategy'), email('Our best strategy essays', 'Hand-picked for you', 'You told us you love the big-picture stuff, so here are three essays to start with.', btn('Read the strategy collection', `${U}/archive`))],
        [iff([clickedUrl('interest=tools')], [tag('interest-tools'), email('The tools & how-tos readers love', 'Practical picks', 'You picked tools & how-tos — these step-by-step guides are the most saved posts on the site.', btn('See the guides', `${U}/archive`))],
          [iff([clickedUrl('interest=news')], [tag('interest-news'), email('How we cover the news', 'Signal over noise', 'You picked news & analysis. Each week we cover the three stories that matter and skip the rest.', btn('Read the latest analysis', U))], [tag('interest-unknown')])])]),
    ],
  }),
  T({
    key: 'welcome_founder', category: 'Welcome & onboarding', icon: '✍️', name: 'Personal note from the founder',
    description: 'A plain, personal welcome a day after signup that invites a reply — great for deliverability and relationships.',
    triggers: [trig('welcome')],
    steps: () => [
      wait(1),
      email('A quick hello (and a question)', 'From me, not a marketing team', 'Hey {{subscriber.first_name|there}},',
        'I’m the person who writes {{publication.name}}. I saw you joined yesterday and wanted to say thanks personally.',
        'Can I ask you one thing? <b>What made you subscribe?</b> Just hit reply — even a one-line answer helps me write better issues.',
        'Thanks again,', p('— {{publication.name}}')),
    ],
  }),
  T({
    key: 'welcome_referred', category: 'Welcome & onboarding', icon: '🤝', name: 'Welcome for referred readers',
    description: 'Readers who joined through a friend’s referral link get a welcome that mentions the referral and invites them to share too.',
    triggers: [trig('signup', { sources: ['referral'] })],
    steps: () => [
      email('A friend thought you’d like {{publication.name}}', 'Welcome — you were invited', hi,
        'You joined through a friend’s invite — welcome! They clearly have good taste.',
        'Here’s where to start:', btn('Read the latest issue', U),
        'Know someone else who’d enjoy it? Share your own link: <a href="{{referral_url}}">{{referral_url}}</a>'),
      tag('referred'),
    ],
  }),
  T({
    key: 'tag_nurture', category: 'Welcome & onboarding', icon: '🏷️', name: 'Tag-based nurture',
    description: 'When a subscriber gets a topic tag, send a short 3-email nurture series about that topic.',
    triggers: [trig('tag_added', { tag: 'interested' })],
    steps: () => [
      email('You’re interested in this — here’s where to start', 'Part 1 of 3', hi, 'Since you showed interest in this topic, here’s a short 3-part series. Part 1: the essentials everyone should know.', btn('Read part 1', U)),
      wait(3),
      email('Part 2: the mistakes most people make', 'Avoid these', 'The three most common mistakes — and what to do instead.', ol('Starting without a clear goal', 'Copying someone else’s playbook', 'Giving up right before it works')),
      wait(3),
      email('Part 3: your next step', 'Put it into practice', 'You now know more than most. Pick one thing from this series and try it this week — then reply and tell me how it went.'),
      tag('nurtured'),
    ],
  }),

  // ───────── Lead magnets ─────────
  T({
    key: 'lead_magnet', category: 'Lead magnets', icon: '🎁', name: 'Lead magnet delivery',
    description: 'Deliver a free download to people who sign up through a form, then follow up depending on whether they opened it.',
    triggers: [trig('signup', { sources: ['form'] })],
    steps: () => [
      email('Here is your free guide 🎁', 'Download link inside', hi, 'As promised, here is your free guide. Click below to download it:', btn('Download the guide', U), 'Enjoy — and keep an eye on your inbox for our weekly issue.'),
      tag('lead-magnet'),
      wait(3),
      iff([opened(3)], [email('Did you get a chance to read it?', 'A few tips to get the most out of it', 'Hope you enjoyed the guide! Here are three quick ways to put it into practice this week.', ol('Pick one idea and schedule 20 minutes for it', 'Share it with one colleague', 'Reply and tell me what you tried'))],
        [email('Your guide is waiting', 'Still want it?', "Looks like you haven't opened your guide yet — here it is again.", btn('Download the guide', U))]),
    ],
  }),
  T({
    key: 'lead_magnet_tag', category: 'Lead magnets', icon: '📥', name: 'Lead magnet by tag',
    description: 'Deliver a resource whenever a tag like “wants-checklist” is added (from a form, a link or the API).',
    triggers: [trig('tag_added', { tag: 'wants-checklist' })],
    steps: () => [
      email('Your checklist is ready ✅', 'Download it now', hi, 'Here’s the checklist you asked for. Print it, bookmark it, or forward it to your team.', btn('Get the checklist', U)),
      wait(2),
      email('How to use the checklist in 10 minutes', 'A quick walkthrough', 'Most people use the checklist once and forget it. Here’s how readers get the most out of it:', ol('Run through it every Monday', 'Mark the items you skipped and why', 'Share your results with us by replying')),
      tag('checklist-delivered'),
    ],
  }),
  T({
    key: 'lead_magnet_nurture', category: 'Lead magnets', icon: '🌱', name: 'Lead magnet + nurture to paid',
    description: 'Deliver the freebie, send three value emails, then introduce your paid offer to engaged readers only.',
    triggers: [trig('signup', { sources: ['form', 'magic_link'] })],
    steps: () => [
      email('Your download + what’s next', 'Your free resource is inside', hi, 'Here’s your free resource:', btn('Download now', U), 'Over the next week I’ll send three short emails that build on it.'),
      wait(2),
      email('The one idea that makes the guide work', 'Lesson 1', 'If you only remember one thing from the guide, make it this: consistency beats intensity. Small weekly progress compounds.'),
      wait(2),
      email('A real example', 'Lesson 2', 'Here’s how one reader applied the guide and what changed after 30 days.', quote('“I stopped guessing and finally had a system. It took an afternoon to set up.”', 'A reader')),
      wait(2),
      email('Common questions, answered', 'Lesson 3', ul('<b>How long does it take?</b> About an hour a week.', '<b>Do I need special tools?</b> No.', '<b>What if I fall behind?</b> Start again next week — that’s the point of a system.')),
      wait(2),
      iff([opened(7)], [email('Ready to go further?', 'For readers who want more', 'You’ve opened every lesson — thank you! If you want the deep-dives, templates and the full archive, premium is for you.', btn('See premium', `${U}/upgrade`))], [tag('cold-lead')]),
    ],
  }),
  T({
    key: 'quiz_results', category: 'Lead magnets', icon: '🧩', name: 'Quiz / assessment results follow-up',
    description: 'After someone completes a survey-based quiz, send their next steps and a three-day follow-up.',
    triggers: [trig('survey_submitted')],
    steps: () => [
      email('Your results are in', 'Here’s what they mean', hi, 'Thanks for taking the assessment! Based on your answers, here are the three areas to focus on first:', ol('Clarify your goal for the next 90 days', 'Remove one recurring time sink', 'Build a weekly review habit'), btn('Read the full guide', U)),
      wait(3),
      email('How are your first steps going?', 'A quick check-in', 'It’s been a few days since your assessment. Which of the three focus areas did you start with? Reply and let me know — I’ll send tailored resources.'),
      tag('quiz-taker'),
    ],
  }),

  // ───────── Courses & drips ─────────
  T({
    key: 'email_course_5', category: 'Courses & drips', icon: '🎓', name: '5-day email course',
    description: 'Deliver a free email course: one lesson a day for five days, then a graduation email with a next step.',
    triggers: [trig('tag_added', { tag: 'course' })],
    steps: () => [
      email('Lesson 1: Start here', 'Your 5-day course begins', hi, 'Welcome to the course! Each day for the next five days you’ll get one short lesson you can finish in 10 minutes.', h('Lesson 1: The foundation'), 'Today we set your goal. Write down one outcome you want by the end of this week.'),
      wait(1), email('Lesson 2: The framework', 'Day 2 of 5', h('Lesson 2: The framework'), 'Every great result follows the same loop: plan, do, review. Today, plan your next three actions.'),
      wait(1), email('Lesson 3: Common traps', 'Day 3 of 5', h('Lesson 3: Common traps'), ul('Doing too much at once', 'Skipping the review', 'Waiting for perfect conditions')),
      wait(1), email('Lesson 4: Putting it together', 'Day 4 of 5', h('Lesson 4: Putting it together'), 'Combine the framework with your goal. Block 30 minutes in your calendar for it — today.'),
      wait(1), email('Lesson 5: Graduation 🎓', 'You finished the course!', h('You did it!'), 'Congratulations on finishing the course. Keep going with the weekly newsletter — and if you want the advanced material, it’s in premium.', btn('Continue learning', `${U}/upgrade`)),
      tag('course-graduate'), untag('course'),
    ],
  }),
  T({
    key: 'email_course_weekly', category: 'Courses & drips', icon: '📚', name: '6-week weekly course',
    description: 'A slower course: one in-depth lesson every week for six weeks, with a mid-course check-in.',
    triggers: [trig('tag_added', { tag: 'weekly-course' })],
    steps: () => [
      email('Week 1: Welcome to the course', 'Your first lesson', hi, 'Every week for the next six weeks you’ll receive one in-depth lesson. Set aside 30 minutes to work through it.', btn('Open lesson 1', U)),
      wait(1, 'weeks'), email('Week 2: Building the habit', 'Lesson 2', 'This week is about consistency. Pick a fixed time each week for the course.', btn('Open lesson 2', U)),
      wait(1, 'weeks'), email('Week 3: Halfway check-in', 'How is it going?', 'You’re halfway! Reply with one thing you’ve learned so far and one thing that’s still unclear.', btn('Open lesson 3', U)),
      wait(1, 'weeks'), email('Week 4: Going deeper', 'Lesson 4', 'Now we refine. Look back at your notes from week 1 and see how far you’ve come.', btn('Open lesson 4', U)),
      wait(1, 'weeks'), email('Week 5: Advanced techniques', 'Lesson 5', 'This lesson covers the techniques experienced practitioners use.', btn('Open lesson 5', U)),
      wait(1, 'weeks'), email('Week 6: Final lesson & what’s next', 'You made it', 'This is the final lesson. Thank you for sticking with it!', btn('Open lesson 6', U)),
      tag('weekly-course-complete'),
    ],
  }),
  T({
    key: 'challenge_7day', category: 'Courses & drips', icon: '🔥', name: '7-day challenge',
    description: 'Run a 7-day challenge with a daily prompt, a mid-week nudge for non-openers, and a completion email.',
    triggers: [trig('tag_added', { tag: 'challenge' })],
    steps: () => [
      email('Day 1 of 7: Let’s go! 🔥', 'Your first challenge', hi, 'Welcome to the 7-day challenge! Each day you’ll get one small task. Today’s task: write down why you joined.'),
      wait(1), email('Day 2: Small wins', 'Today’s task', 'Today: complete one task you’ve been postponing for a week. Just one.'),
      wait(1), email('Day 3: Remove one obstacle', 'Today’s task', 'Today: identify the biggest thing slowing you down and remove it (or schedule its removal).'),
      wait(1),
      iff([opened(2)], [email('Day 4: You’re on a roll', 'Halfway there', 'You’re halfway through! Today: share your progress with one person.')],
        [email('Day 4: It’s not too late to catch up', 'Jump back in', 'Missed a day or two? No problem — start with today’s task: share your goal with one person.')]),
      wait(1), email('Day 5: Build the system', 'Today’s task', 'Today: turn what worked this week into a repeatable weekly routine.'),
      wait(1), email('Day 6: Reflect', 'Today’s task', 'Today: write three sentences about what changed this week.'),
      wait(1), email('Day 7: You finished the challenge! 🏆', 'Celebrate', 'You did it! Reply and tell me your biggest win — I’ll feature the best ones (anonymously) in a future issue.'),
      tag('challenge-complete'),
    ],
  }),
  T({
    key: 'evergreen_drip', category: 'Courses & drips', icon: '♻️', name: 'Evergreen best-of drip',
    description: 'New subscribers get your six best archive posts, one a week, so great older content keeps working.',
    triggers: [trig('welcome')],
    steps: () => [
      wait(1, 'weeks'), email('From the archive: our most-shared post', 'A classic', 'Every week for the next few weeks I’ll send one of our best older posts. Starting with the most-shared one ever.', btn('Read it', `${U}/archive`)),
      wait(1, 'weeks'), email('From the archive: the post that started it all', 'Where it began', 'This is the very first issue — rough around the edges, but the ideas still hold up.', btn('Read it', `${U}/archive`)),
      wait(1, 'weeks'), email('From the archive: the most practical guide', 'Bookmark this', 'Readers tell us they come back to this one again and again.', btn('Read it', `${U}/archive`)),
      wait(1, 'weeks'), email('From the archive: a reader favourite', 'Readers loved this', 'This one got more replies than any other post.', btn('Read it', `${U}/archive`)),
      wait(1, 'weeks'), email('From the archive: the contrarian take', 'Agree or disagree?', 'This post sparked a lot of debate. Read it and tell me where you land.', btn('Read it', `${U}/archive`)),
      wait(1, 'weeks'), email('From the archive: the big picture', 'One more classic', 'Last one in this series — the essay that ties everything together.', btn('Read it', `${U}/archive`)),
    ],
  }),

  // ───────── Launches & sales ─────────
  T({
    key: 'product_launch', category: 'Launches & sales', icon: '🚀', name: 'Product launch sequence',
    description: 'Tease, open, prove and close a launch for readers tagged “launch-interest”; buyers exit the sequence automatically.',
    triggers: [trig('tag_added', { tag: 'launch-interest' })],
    steps: () => [
      email('Something new is coming 👀', 'You’re on the early list', hi, 'You raised your hand, so you’ll hear first: we’re launching something new next week. Here’s a sneak peek of what it does and who it’s for.'),
      wait(3),
      email('It’s live: doors are open 🚀', 'Early-bird pricing for 72 hours', 'It’s here! As an early-list reader you get the early-bird price for the next 72 hours.', btn('Get it now', `${U}/shop`)),
      wait(1),
      iff([boughtAny], [tag('launch-buyer')], [
        email('What customers are saying', 'Real results', quote('“Worth every penny. I used it the same day.”', 'An early customer'), 'Here’s what’s inside and who it’s (and isn’t) for.', btn('See what’s inside', `${U}/shop`)),
        wait(2),
        iff([boughtAny], [tag('launch-buyer')], [email('Last chance: early-bird ends tonight ⏰', 'Final hours', 'The early-bird price ends at midnight. If it’s right for you, now’s the time.', btn('Get it before midnight', `${U}/shop`))]),
      ]),
    ],
  }),
  T({
    key: 'waitlist', category: 'Launches & sales', icon: '⏳', name: 'Waitlist / pre-launch',
    description: 'Confirm a waitlist spot, share behind-the-scenes progress, and ask waitlisters to refer friends to move up.',
    triggers: [trig('tag_added', { tag: 'waitlist' })],
    steps: () => [
      email('You’re on the waitlist ✅', 'We’ll let you know first', hi, 'You’re on the list! You’ll be among the first to get access.', 'Want to move up? Share your link: <a href="{{referral_url}}">{{referral_url}}</a>'),
      wait(5),
      email('Behind the scenes: what we’re building', 'A peek at progress', 'A quick update on progress — what’s done, what’s next, and one decision we’d love your input on. Hit reply with your thoughts.'),
      wait(7),
      email('Almost there…', 'Launch is close', 'We’re weeks away from opening the doors. Keep an eye on your inbox — waitlisters get first access and a launch discount.'),
    ],
  }),
  T({
    key: 'flash_sale', category: 'Launches & sales', icon: '⚡', name: '48-hour flash sale',
    description: 'Announce a short sale to a tagged audience, remind non-buyers halfway through, and close with a final call.',
    triggers: [trig('tag_added', { tag: 'flash-sale' })],
    steps: () => [
      email('48 hours only: 30% off ⚡', 'Our biggest discount of the year', hi, 'For the next 48 hours everything in the shop is 30% off.', btn('Shop the sale', `${U}/shop`)),
      wait(24, 'hours'),
      iff([boughtAny], [], [email('24 hours left on the sale', 'Halfway point', 'Just a heads-up: the sale ends in 24 hours.', btn('Shop now', `${U}/shop`))]),
      wait(20, 'hours'),
      iff([boughtAny], [], [email('Final hours: sale ends tonight', 'Last call', 'This is the last reminder — the discount disappears at midnight.', btn('Shop before midnight', `${U}/shop`))]),
      untag('flash-sale'),
    ],
  }),
  T({
    key: 'upsell', category: 'Launches & sales', icon: '⬆️', name: 'Post-purchase upsell',
    description: 'A week after a purchase, offer a complementary product to happy customers who opened your follow-ups.',
    triggers: [trig('purchase')],
    steps: () => [
      wait(7),
      iff([opened(7)], [email('Customers who bought this also loved…', 'A perfect next step', hi, 'Since you picked up your purchase last week, here’s the product customers most often add next — at 20% off for you this week.', btn('See the offer', `${U}/shop`))], [tag('upsell-skipped')]),
    ],
  }),

  // ───────── E-commerce ─────────
  T({
    key: 'cart_abandoned', category: 'E-commerce', icon: '🛒', name: 'Abandoned cart reminder',
    description: 'Remind shoppers who left items in their cart an hour later, then once more the next day.',
    triggers: [trig('cart_abandoned')],
    steps: () => [
      wait(1, 'hours'),
      email('You left something behind', 'Your cart is saved', hi, 'Looks like you didn’t finish checking out. No worries — we saved your cart for you.', btn('Return to your cart', `${U}/shop`)),
      wait(1),
      iff([boughtAny], [], [email('Still thinking it over?', 'Questions? Just reply', 'If you have questions about the product, hit reply — a real person will answer.', btn('Complete your order', `${U}/shop`))]),
    ],
  }),
  T({
    key: 'cart_abandoned_discount', category: 'E-commerce', icon: '🏷️', name: 'Abandoned cart with discount',
    description: 'Three-step cart recovery: reminder, social proof, then a time-limited discount for those who still haven’t bought.',
    triggers: [trig('cart_abandoned')],
    steps: () => [
      wait(2, 'hours'),
      email('Your cart is waiting 🛒', 'Pick up where you left off', hi, 'You were so close! Your items are still in your cart.', btn('Finish checkout', `${U}/shop`)),
      wait(1),
      iff([boughtAny], [tag('cart-recovered')], [
        email('Here’s what other customers say', 'Loved by readers', quote('“Exactly what I needed — wish I’d bought it sooner.”', 'A happy customer'), btn('Back to your cart', `${U}/shop`)),
        wait(2),
        iff([boughtAny], [tag('cart-recovered')], [email('A little something: 10% off your cart', 'Valid for 48 hours', 'Use code <b>COMEBACK10</b> at checkout for 10% off — valid for the next 48 hours.', btn('Use my discount', `${U}/shop`)), tag('cart-discount-sent')]),
      ]),
    ],
  }),
  T({
    key: 'post_purchase', category: 'E-commerce', icon: '📦', name: 'Post-purchase follow-up',
    description: 'Thank buyers, check in after they have used the product, and ask for a review.',
    triggers: [trig('purchase')],
    steps: () => [
      tag('customer'),
      email('Thanks for your purchase! 🎉', 'Everything you need to get started', 'Thank you for buying from {{publication.name}}! Your download link is in your receipt email.', 'Reply anytime if you have questions.'),
      wait(5),
      email('How is it going?', 'We would love your feedback', 'It has been a few days — how are you finding it?', 'If you have a minute, leaving a review helps other readers decide.', btn('Leave a review', `${U}/shop`)),
    ],
  }),
  T({
    key: 'review_request', category: 'E-commerce', icon: '⭐', name: 'Review request',
    description: 'Ask buyers for a review 10 days after purchase and send one gentle reminder if they haven’t clicked.',
    triggers: [trig('purchase')],
    steps: () => [
      wait(10),
      email('Would you leave a quick review?', 'It takes 60 seconds', hi, 'You’ve had your purchase for about 10 days. Would you share a quick review? It helps other readers and helps us improve.', btn('Leave a review', `${U}/shop`)),
      wait(4),
      iff([clicked(4)], [tag('reviewer')], [email('One more nudge (promise it’s the last)', 'Your opinion matters', 'If you have 60 seconds, a short review would mean a lot. Thank you!', btn('Write a review', `${U}/shop`))]),
    ],
  }),
  T({
    key: 'replenish', category: 'E-commerce', icon: '🔁', name: 'Reorder / renewal reminder',
    description: 'Thirty days after a purchase, remind customers it may be time to reorder or renew.',
    triggers: [trig('purchase')],
    steps: () => [
      wait(30),
      email('Time for a refill?', 'Reorder in one click', hi, 'It’s been about a month since your last order — many customers reorder around now.', btn('Reorder now', `${U}/shop`)),
    ],
  }),
  T({
    key: 'reengage', category: 'Engagement & win-back', icon: '💤', name: 'Re-engagement',
    description: 'Win back subscribers who stopped opening, and clean up those who do not come back.',
    triggers: [trig('inactive', { days: 60 })],
    steps: () => [
      email('Do you still want to hear from us?', 'Click to stay subscribed', 'Hi {{subscriber.first_name|there}}, we noticed you have not opened {{publication.name}} in a while.', 'If you still want to receive it, just click the button below. Otherwise, no hard feelings.', btn('Yes, keep me subscribed', U)),
      wait(7),
      iff([opened(7)], [tag('re-engaged')], [tag('inactive'), unsub()]),
    ],
  }),
  T({
    key: 'winback_survey', category: 'Engagement & win-back', icon: '🔄', name: 'Win-back with “what changed?”',
    description: 'Ask lapsed readers what changed, offer a lighter frequency, then share your best recent issue.',
    triggers: [trig('inactive', { days: 45 })],
    steps: () => [
      email('Did we do something wrong?', 'Help us get better', hi, 'You haven’t opened {{publication.name}} in a while, and I’d genuinely love to know why. Was it:', ul('Too many emails', 'Topics not relevant anymore', 'Just busy — not your fault!'), 'Hit reply with a word or two. It really helps.'),
      wait(5),
      iff([opened(5)], [tag('won-back')], [email('Here’s the best thing we published recently', 'In case you missed it', 'No pressure — here is the one recent issue I think you’d enjoy most.', btn('Read it', U)), tag('winback-attempted')]),
    ],
  }),
  T({
    key: 'sunset', category: 'Engagement & win-back', icon: '🌅', name: 'Sunset policy (list cleaning)',
    description: 'Protect deliverability: after 120 days without opens, send a final notice and unsubscribe people who don’t respond.',
    triggers: [trig('inactive', { days: 120 })],
    steps: () => [
      email('Should we stop emailing you?', 'We’ll unsubscribe you in 7 days unless you click', hi, 'It looks like you haven’t opened our emails in about four months. To keep our list healthy we’ll unsubscribe you in 7 days.', 'Want to stay? Click the button — that’s all it takes.', btn('Keep me subscribed', U)),
      wait(7),
      iff([clicked(7)], [tag('sunset-saved')], [iff([opened(7)], [tag('sunset-saved')], [tag('sunset-removed'), unsub()])]),
    ],
  }),
  T({
    key: 'superfan', category: 'Engagement & win-back', icon: '🏆', name: 'Super-fan thank you',
    description: 'Thank your most engaged readers when they reach super-fan status (tag) and invite them to help shape the newsletter.',
    triggers: [trig('tag_added', { tag: 'superfan' })],
    steps: () => [
      email('You’re one of our most engaged readers 🏆', 'A thank-you', hi, 'You’re in the top tier of {{publication.name}} readers — you open and click more than almost anyone. Thank you!', 'Would you be up for a 10-minute chat (or a few emails) about what you’d like to see next? Just reply “yes”.'),
      notify('A super-fan was tagged', 'A highly engaged reader just got the superfan tag.'),
    ],
  }),
  T({
    key: 'event_drip', category: 'Events & webinars', icon: '🎟️', name: 'Event reminder drip',
    description: 'Build anticipation after someone registers for an event and follow up with the replay.',
    triggers: [trig('event_registered')],
    steps: () => [
      email("You're registered ✅", 'Save the date', "You're in! We'll send your join link before the event starts. Add it to your calendar using the invite attached to your confirmation."),
      wait(1), email('What to prepare before the event', 'Get the most out of it', 'Bring your questions — there will be a live Q&amp;A at the end.'),
      wait(3), email('Thanks for joining! Here is the replay', 'Watch anytime', 'Thanks for registering. Here is the replay and the slides.', btn('Watch the replay', `${U}/events`)),
    ],
  }),
  T({
    key: 'webinar_reminders', category: 'Events & webinars', icon: '⏰', name: 'Webinar reminders',
    description: 'Confirmation, a day-before reminder and a starting-soon email for webinar registrants (from your events or a webhook).',
    triggers: [trig('event_registered'), trig('webhook', {})],
    steps: () => [
      email('You’re registered for the webinar ✅', 'Details inside', hi, 'You’re registered! Here’s what we’ll cover:', ul('The framework, step by step', 'Live examples', 'Q&amp;A — bring your questions'), 'Your join link is in the calendar invite and on the event page.', btn('Event details', `${U}/events`)),
      wait(1), email('Tomorrow: see you at the webinar', 'Reminder', 'Quick reminder that the webinar is tomorrow. Add it to your calendar so you don’t miss it.', btn('Add to calendar', `${U}/events`)),
      wait(23, 'hours'), email('Starting in 1 hour 🔴', 'Join link inside', 'We go live in about an hour. Grab a coffee and join a few minutes early.', btn('Join the webinar', `${U}/events`)),
    ],
  }),
  T({
    key: 'webinar_followup', category: 'Events & webinars', icon: '🎬', name: 'Webinar follow-up (attended vs missed)',
    description: 'After the webinar, attendees (tag “attended”) get the slides and an offer; no-shows get the replay.',
    triggers: [trig('event_registered')],
    steps: () => [
      waitFor([hasTag('attended')], 3),
      iff([hasTag('attended')],
        [email('Thanks for attending! Slides + a special offer', 'Your bonus inside', hi, 'Thank you for joining live! Here are the slides and, as promised, a special offer for attendees (valid 72 hours).', btn('Get the slides & offer', `${U}/events`))],
        [email('Sorry we missed you — here’s the replay', 'Watch it on your schedule', hi, 'Life happens! The full replay is ready whenever you are.', btn('Watch the replay', `${U}/events`))]),
      wait(3),
      email('Your questions from the webinar, answered', 'Q&amp;A recap', 'We couldn’t get to every question live, so here are answers to the most common ones.'),
    ],
  }),
  T({
    key: 'upgrade_nurture', category: 'Paid subscriptions', icon: '💳', name: 'Paid upgrade nurture',
    description: 'Show engaged free readers what premium includes and offer a trial.',
    triggers: [trig('signup')],
    steps: () => [
      wait(7),
      iff([isFree, { field: 'open_count', cmp: 'gt', value: 1 }], [
        email('You might love premium', 'Here is what you are missing', "You've been reading {{publication.name}} for a week — thank you!", 'Premium members get every deep-dive, the full archive and the community.', btn('See premium plans', `${U}/upgrade`)),
        wait(4),
        iff([isFree], [email('A little gift: try premium', 'Limited-time trial', 'Try premium free for a week — cancel anytime.', btn('Start my trial', `${U}/upgrade`))]),
      ]),
    ],
  }),
  T({
    key: 'paid_onboarding', category: 'Paid subscriptions', icon: '🎉', name: 'Onboarding for paid subscribers',
    description: 'Welcome new paying members, show them every premium perk, and check in after two weeks.',
    triggers: [trig('upgraded')],
    steps: () => [
      tag('paid-member'),
      email('Welcome to premium 🎉', 'Here’s everything you now have access to', hi, 'Thank you for supporting {{publication.name}} — you make this work possible.', h('Your premium perks'), ul('Every premium deep-dive, plus the full archive', 'Members-only community and events', 'Early access to new products'), btn('Explore premium', U)),
      wait(3), email('Start with these premium favourites', 'Hand-picked for new members', 'The three premium posts members tell us are worth the subscription on their own.', btn('Read them', `${U}/archive`)),
      wait(11), email('Two weeks in — how’s premium treating you?', 'A quick check-in', 'You’ve been a member for two weeks. Is there anything you’d like more (or less) of? Reply and tell me — paying members shape what comes next.'),
    ],
  }),
  T({
    key: 'trial_conversion', category: 'Paid subscriptions', icon: '🧪', name: 'Paid trial conversion',
    description: 'Give engaged free readers a 7-day premium trial, highlight perks during it, and ask them to subscribe before it ends.',
    triggers: [trig('tag_added', { tag: 'trial' })],
    steps: () => [
      premium(7),
      email('Your 7-day premium trial has started', 'Everything is unlocked', hi, 'For the next seven days you have full premium access. Here’s where to start:', btn('Explore premium', U)),
      wait(3), email('Halfway through your trial', 'Have you tried these?', 'Members love the archive and the members-only posts — make sure you check them out before your trial ends.'),
      wait(3),
      iff([isPremium, { field: 'subscription_status', cmp: 'eq', value: 'active' }], [tag('trial-converted')],
        [email('Your trial ends tomorrow', 'Keep your premium access', 'Your trial ends tomorrow. Subscribe now to keep everything you’ve unlocked.', btn('Keep premium', `${U}/upgrade`)), tag('trial-ended')]),
    ],
  }),
  T({
    key: 'churn_save', category: 'Paid subscriptions', icon: '🛟', name: 'Churn save (cancellation)',
    description: 'When a member downgrades or cancels: ask why, offer a pause or discount, and stay in touch as a free reader.',
    triggers: [trig('downgraded')],
    steps: () => [
      email('Sorry to see you go', 'Can I ask why?', hi, 'You just cancelled your premium membership. No hard feelings — could you reply with the main reason? It genuinely helps.', ul('Too expensive', 'Not using it enough', 'Content isn’t what I expected', 'Something else')),
      wait(3),
      email('Come back for 50% off', 'A one-time offer', 'If price was the issue, here’s a one-time offer: come back for 50% off your first three months.', btn('Rejoin at 50% off', `${U}/upgrade`)),
      wait(14),
      iff([isPremium], [tag('churn-saved')], [tag('churned'), email('You’re still on the free list', 'We’ll keep sending the free issues', 'You’ll keep getting our free issues. If you ever want premium again, it’s one click away.')]),
    ],
  }),
  T({
    key: 'referral_milestone', category: 'Referrals & growth', icon: '🎖️', name: 'Referral milestone thank-you',
    description: 'Celebrate subscribers who hit a referral milestone, tag them as ambassadors and let your team know.',
    triggers: [trig('referral_milestone')],
    steps: () => [
      email('You did it — thank you for sharing! 🎖️', 'Your reward is on its way', hi, 'You’ve now referred <b>{{referral_count}}</b> readers to {{publication.name}}. That’s amazing — thank you!', 'Your reward is unlocked. Keep sharing to reach the next milestone:', p('<a href="{{referral_url}}">{{referral_url}}</a>')),
      tag('ambassador'),
      notify('A subscriber reached a referral milestone', 'Consider sending a personal thank-you.'),
    ],
  }),
  T({
    key: 'referral_ask', category: 'Referrals & growth', icon: '📣', name: 'Ask engaged readers to refer',
    description: 'Two weeks after joining, ask readers who have been opening to share their referral link.',
    triggers: [trig('welcome')],
    steps: () => [
      wait(14),
      iff([opened(14)], [email('Know someone who’d enjoy this?', 'Your personal invite link', hi, 'You’ve been opening {{publication.name}} regularly — thank you! The best way to support it is to share it with one friend.', p('Your link: <a href="{{referral_url}}">{{referral_url}}</a>'), 'Every referral counts toward rewards.', btn('See referral rewards', `${U}/referrals`))]),
    ],
  }),
  T({
    key: 'survey_followup', category: 'Feedback & surveys', icon: '📝', name: 'Survey follow-up',
    description: 'Thank respondents, tell them what happens with their answers and follow up with results a week later.',
    triggers: [trig('survey_submitted')],
    steps: () => [
      email('Thanks for your feedback 🙏', 'Here’s what happens next', hi, 'Thank you for filling out the survey. Every answer is read, and the results directly shape what we publish next.'),
      tag('survey-respondent'),
      wait(7),
      email('What we learned from the survey', 'The results are in', 'Here are the top three things readers told us — and what we’re changing because of it.', ol('More practical how-tos', 'Shorter weekday issues', 'A monthly deep-dive')),
    ],
  }),
  T({
    key: 'nps', category: 'Feedback & surveys', icon: '📊', name: 'NPS / satisfaction check',
    description: 'After 30 days, ask readers how likely they are to recommend you; promoters get a referral ask.',
    triggers: [trig('welcome')],
    steps: () => [
      wait(30),
      email('Quick question: would you recommend us?', 'One click', hi, 'On a scale of 0–10, how likely are you to recommend {{publication.name}} to a friend? Click a number:',
        btn('9–10: Absolutely', `${U}/?nps=promoter`), btn('7–8: Probably', `${U}/?nps=passive`), btn('0–6: Not really', `${U}/?nps=detractor`)),
      wait(3),
      iff([clickedUrl('nps=promoter')], [tag('nps-promoter'), email('Thank you! One small favour…', 'Share with a friend', 'Thanks for the kind rating! Would you share {{publication.name}} with one friend? <a href="{{referral_url}}">{{referral_url}}</a>')],
        [iff([clickedUrl('nps=detractor')], [tag('nps-detractor'), email('How can we do better?', 'Your honest feedback', 'Thanks for being honest. What’s the one thing we could change to earn a 10? Hit reply.')])]),
    ],
  }),
  T({
    key: 'birthday', category: 'Dates & milestones', icon: '🎂', name: 'Birthday email',
    description: 'Send a birthday greeting (with an optional gift) every year, using a “birthday” date custom field.',
    triggers: [trig('date_field', { key: 'birthday', offset_days: 0 })],
    steps: () => [
      email('Happy birthday, {{subscriber.first_name|friend}}! 🎂', 'A little gift from us', hi, 'Everyone at {{publication.name}} wishes you a wonderful birthday!', 'As a small gift, here’s 20% off anything in the shop this week with code <b>BIRTHDAY20</b>.', btn('Claim your gift', `${U}/shop`)),
    ],
  }),
  T({
    key: 'anniversary', category: 'Dates & milestones', icon: '🥂', name: 'Subscription anniversary',
    description: 'Celebrate each year a reader has been subscribed, using a “joined_on” date custom field.',
    triggers: [trig('date_field', { key: 'joined_on', offset_days: 0 })],
    steps: () => [
      email('Happy anniversary! 🥂', 'Another year together', hi, 'Today marks another year since you joined {{publication.name}}. Thank you for reading, replying and sharing.', 'Here are the three most popular issues from the past year, in case you missed any:', btn('See the year’s best', `${U}/archive`)),
    ],
  }),
  T({
    key: 'renewal_reminder', category: 'Dates & milestones', icon: '📅', name: 'Renewal reminder',
    description: 'Remind members seven days before the date in their “renewal_date” field, then on the day itself.',
    triggers: [trig('date_field', { key: 'renewal_date', offset_days: -7 })],
    steps: () => [
      email('Your renewal is coming up in 7 days', 'No action needed', hi, 'Just a heads-up: your membership renews in seven days. No action is needed if you’d like to continue.', btn('Manage your membership', `${U}/account`)),
      wait(7),
      email('Your membership renews today', 'Thanks for staying', 'Your membership renews today — thank you for another year of support!'),
    ],
  }),

  // ───────── Integrations ─────────
  T({
    key: 'booking_followup', category: 'Integrations', icon: '📆', name: 'Calendly booking follow-up',
    description: 'Point a Calendly (or any scheduler) webhook at this automation: confirm the call, send prep notes and follow up afterwards.',
    triggers: [trig('webhook', { tags: ['booked-call'] })],
    steps: () => [
      email('Your call is booked ✅', 'How to prepare', hi, 'Thanks for booking a call! To make the most of our time, reply with the one question you most want answered.'),
      wait(1), email('A few things to look at before we talk', 'Prep notes', 'Here are a couple of resources that will help us skip the basics and get straight to your questions.', btn('Read the prep notes', U)),
      wait(3), email('Great talking with you', 'Next steps', 'Thanks for the call! Here’s a short recap and the resources we mentioned. Reply any time with questions.'),
    ],
  }),
  T({
    key: 'course_student_onboarding', category: 'Integrations', icon: '🧑‍🎓', name: 'Course platform student onboarding',
    description: 'For Thinkific, Kajabi, Teachable or Podia: when a student enrolls (webhook), welcome them and nudge them to finish lesson one.',
    triggers: [trig('webhook', { tags: ['student'] })],
    steps: () => [
      email('Welcome to the course! Start here', 'Your first lesson is ready', hi, 'You’re enrolled — welcome! The best predictor of finishing a course is starting it in the first 48 hours, so here’s lesson one.', btn('Start lesson 1', U)),
      wait(3), email('How’s lesson one going?', 'Stuck? Reply', 'Have you had a chance to start? If you’re stuck anywhere, reply and I’ll help.'),
      wait(7), email('You’re making progress 💪', 'Keep the momentum', 'Students who finish the first module in the first two weeks are 3× more likely to complete the course. You’ve got this!'),
    ],
  }),
  T({
    key: 'form_tool_lead', category: 'Integrations', icon: '📋', name: 'Typeform / Tally lead follow-up',
    description: 'Send form-tool submissions (Typeform, Tally, Jotform, Google Forms via Zapier) to this webhook and follow up personally.',
    triggers: [trig('webhook', { tags: ['form-lead'] })],
    steps: () => [
      email('Thanks — we got your submission', 'What happens next', hi, 'Thanks for filling out the form. We’ll review your answers and get back to you within two business days.'),
      notify('New form submission', 'A new lead came in through the form webhook.'),
      wait(2), email('A few resources while you wait', 'Hand-picked for you', 'While we review your submission, here are a few resources other people in your situation found useful.', btn('Browse resources', `${U}/archive`)),
    ],
  }),
];

/** Templates whose entry points all exist in this install (e.g. hides cart templates until 'cart_abandoned' is registered). */
export function availableTemplates(): AutomationTemplate[] {
  return TEMPLATES.filter((t) => t.triggers.length && t.triggers.every((x) => !!TRIGGERS[x.type]));
}

export function templateByKey(key: string): AutomationTemplate | undefined {
  return availableTemplates().find((t) => t.key === key);
}

/** Stored trigger JSON for a template (one entry point, or several packed). */
export function templateTrigger(t: AutomationTemplate): any {
  const list = t.triggers.map((x) => ({ type: x.type, config: JSON.parse(JSON.stringify(x.config || {})) }));
  return list.length === 1 ? list[0] : { ...list[0], triggers: list };
}

/** Light-weight outline for the picker preview: [{depth, label, kind}] */
export function outline(steps: Step[], depth = 0): Array<{ depth: number; type: string; text: string; branch?: string }> {
  const out: Array<{ depth: number; type: string; text: string; branch?: string }> = [];
  for (const s of steps) {
    const c = s.config || {};
    const text = s.type === 'send_email' ? c.subject : s.type === 'delay' ? `Wait ${c.amount} ${c.unit}` : s.type === 'add_tag' ? `Add tag ${(c.tags || []).join(', ')}` : s.type === 'remove_tag' ? `Remove tag ${(c.tags || []).join(', ')}`
      : s.type === 'condition' ? 'If / else' : s.type === 'ab_split' ? `Random split ${c.pct}%` : s.type === 'wait_until' ? 'Wait until condition' : s.type === 'grant_premium' ? `Grant premium ${c.days} days`
      : s.type === 'notify' ? 'Notify team' : s.type === 'unsubscribe' ? 'Unsubscribe' : s.type === 'update_field' ? `Set ${c.key}` : s.type;
    out.push({ depth, type: s.type, text });
    if (s.yes || s.no) {
      const [a, b] = s.type === 'ab_split' ? ['Path A', 'Path B'] : ['Yes', 'No'];
      if (s.yes?.length) { out.push({ depth: depth + 1, type: 'branch', text: a }); out.push(...outline(s.yes, depth + 1)); }
      if (s.no?.length) { out.push({ depth: depth + 1, type: 'branch', text: b }); out.push(...outline(s.no, depth + 1)); }
    }
  }
  return out;
}

export { triggerList };
