/** @jsxImportSource hono/jsx */
// Surveys (builder, results, responses, aggregate, CSV, segments from answers) and polls.
import { Hono } from 'hono';
import type { AppEnv, Ctx } from '../../types';
import { one, all, run, val, insert, update } from '../../lib/db';
import { recalcSegment } from '../../lib/segments';
import { aiText, aiEnabled } from '../../lib/ai';
import { audit } from '../../lib/auth';
import { siteUrl } from '../../lib/pub';
import { Card, Btn, LinkBtn, Field, Input, Textarea, Select, Table, Status, Empty, back, Muted, Help, ActionForm, Modal, OpenBtn, Copy, Bars, Stat, Stats, Badge, Json, LineChart } from '../../ui/components';
import { page } from './shared';
import { form, str, int, now, id, ago, num, pct, parseJSON, toCSV, fmtDate, fmtDateTime, DAY } from '../../lib/util';
import type { SurveyQ } from './public';

const app = new Hono<AppEnv>();
const KINDS: Array<[string, string]> = [['short', 'Short text'], ['long', 'Long text'], ['single', 'Single choice'], ['multi', 'Multiple choice'], ['dropdown', 'Dropdown'], ['rating', 'Rating (1–5)'], ['nps', 'NPS (0–10)'], ['date', 'Date']];
const STOP = new Set('the a an and or but to of in on for with is are was were be been it this that i you we they my your our their me us them at as by from so if not no yes do does did have has had just very really more most much can could would should will what which who how when where why about into than then there here its also get got like'.split(' '));

async function loadSurvey(c: Ctx) {
  return one<any>(c.env, 'SELECT * FROM surveys WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
}

app.get('/surveys', async (c) => {
  const pub = c.get('pub');
  const rows = await all<any>(c.env, `SELECT s.*, (SELECT COUNT(*) FROM survey_responses r WHERE r.survey_id = s.id) AS responses, (SELECT MAX(created_at) FROM survey_responses r WHERE r.survey_id = s.id) AS last_at FROM surveys s WHERE s.pub_id = ? ORDER BY s.created_at DESC`, pub.id);
  return page(c, { title: 'Surveys', sub: 'surveys', actions: <>{rows.length > 0 && <LinkBtn small href="/app/audience/surveys/all">Results across all surveys</LinkBtn>}<OpenBtn target="#new-survey" small>+ New survey</OpenBtn></> }, <>
    {rows.length ? (
      <Table<any> rows={rows} rowHref={(s) => `/app/audience/surveys/${s.id}`} cols={[
        { h: 'Survey', r: (s) => <a href={`/app/audience/surveys/${s.id}`}>{s.title}</a> },
        { h: 'Questions', r: (s) => parseJSON<any[]>(s.questions, []).length },
        { h: 'Status', r: (s) => <Status s={s.status === 'active' ? 'active' : 'ended'} /> },
        { h: 'Responses', r: (s) => <strong>{num(s.responses)}</strong> },
        { h: 'Last response', r: (s) => ago(s.last_at) },
        { h: '', r: (s) => <LinkBtn small href={`/app/audience/surveys/${s.id}/edit`}>Edit</LinkBtn> },
      ]} />
    ) : <Card><Empty icon="?" title="No surveys yet" body="Ask readers what they want next, run onboarding surveys after signup, and turn every answer into segments — no third-party form tool required." action={<OpenBtn target="#new-survey">Create a survey</OpenBtn>} /></Card>}
    <Modal id="new-survey" title="New survey">
      <form method="post" action="/app/audience/surveys">
        <Field label="Title"><Input name="title" required autofocus placeholder="What should we write about next?" /></Field>
        <Field label="Start from"><Select name="template" options={[['blank', 'Blank survey'], ['topics', 'Topic ideas (what to write next)'], ['onboarding', 'Onboarding: who are you?'], ['nps', 'Reader satisfaction (NPS)'], ['pricing', 'Pricing research']]} /></Field>
        <div class="form-actions"><Btn>Create</Btn></div>
      </form>
    </Modal>
  </>);
});

const q = (kind: string, label: string, options?: string[], required = false): SurveyQ => ({ id: id(6), kind, label, options, required });
const TEMPLATES = (): Record<string, SurveyQ[]> => ({
  blank: [q('short', 'Your question')],
  topics: [q('multi', 'Which topics do you want more of?', ['Tutorials', 'Interviews', 'Industry news', 'Opinion', 'Tools & resources'], true), q('long', 'What should we write about next?'), q('single', 'How often would you like to hear from us?', ['Daily', 'Weekly', 'Monthly'])],
  onboarding: [q('single', 'What best describes you?', ['Founder', 'Engineer', 'Designer', 'Marketer', 'Student', 'Other'], true), q('dropdown', 'Company size', ['Just me', '2–10', '11–50', '51–200', '200+']), q('short', 'What do you hope to get from this newsletter?')],
  nps: [q('nps', 'How likely are you to recommend this newsletter to a friend?', undefined, true), q('long', 'What is the main reason for your score?'), q('rating', 'How would you rate the writing quality?')],
  pricing: [q('single', 'Would you pay for a premium version?', ['Yes', 'Maybe', 'No'], true), q('single', 'What monthly price feels fair?', ['$3', '$5', '$8', '$12', '$20']), q('multi', 'Which premium perks matter most?', ['Extra posts', 'Archive access', 'Community', 'Podcast', 'Events'])],
});

app.post('/surveys', async (c) => {
  const f = await form(c.req);
  const sid = id(12);
  const T = TEMPLATES();
  const questions = (T[f.template] || T.blank).map((x) => ({ ...x, id: id(6) }));
  await insert(c.env, 'surveys', { id: sid, pub_id: c.get('pub').id, title: str(f.title, 200) || 'Untitled survey', questions: JSON.stringify(questions), status: 'active', created_at: now() });
  return back(c, `/app/audience/surveys/${sid}/edit`, 'Survey created');
});

app.get('/surveys/all', async (c) => {
  const pub = c.get('pub');
  const surveys = await all<any>(c.env, `SELECT s.id, s.title, s.questions, (SELECT COUNT(*) FROM survey_responses r WHERE r.survey_id = s.id) AS n, (SELECT COUNT(DISTINCT subscriber_id) FROM survey_responses r WHERE r.survey_id = s.id) AS people FROM surveys s WHERE s.pub_id = ? ORDER BY n DESC`, pub.id);
  const total = surveys.reduce((a, s) => a + s.n, 0);
  const respondents = await val<number>(c.env, 'SELECT COUNT(DISTINCT subscriber_id) FROM survey_responses WHERE pub_id = ? AND subscriber_id IS NOT NULL', pub.id);
  const active = await val<number>(c.env, `SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND status = 'active'`, pub.id);
  const since = now() - 30 * DAY;
  const daily = await all<any>(c.env, `SELECT date(created_at/1000, 'unixepoch') AS d, COUNT(*) AS n FROM survey_responses WHERE pub_id = ? AND created_at >= ? GROUP BY d ORDER BY d`, pub.id, since);
  const labels: string[] = [], values: number[] = [];
  for (let i = 29; i >= 0; i--) { const d = new Date(now() - i * DAY).toISOString().slice(0, 10); labels.push(d.slice(5)); values.push(daily.find((x) => x.d === d)?.n || 0); }
  // NPS across all nps questions
  let promoters = 0, detractors = 0, npsN = 0;
  const recent = await all<any>(c.env, `SELECT r.*, s.title, s.questions, sub.email FROM survey_responses r JOIN surveys s ON s.id = r.survey_id LEFT JOIN subscribers sub ON sub.id = r.subscriber_id WHERE r.pub_id = ? ORDER BY r.created_at DESC LIMIT 20`, pub.id);
  for (const s of surveys) {
    const npsQs = parseJSON<SurveyQ[]>(s.questions, []).filter((x) => x.kind === 'nps');
    if (!npsQs.length) continue;
    for (const r of await all<any>(c.env, 'SELECT answers FROM survey_responses WHERE survey_id = ?', s.id)) {
      const a = parseJSON<Record<string, any>>(r.answers, {});
      for (const nq of npsQs) if (a[nq.id] !== undefined) { const v = Number(a[nq.id]); npsN++; if (v >= 9) promoters++; else if (v <= 6) detractors++; }
    }
  }
  return page(c, { title: 'All survey results', sub: 'surveys', crumbs: [['/app/audience/surveys', 'Surveys']] }, <>
    <Stats>
      <Stat label="Total responses" value={num(total)} />
      <Stat label="Unique respondents" value={num(respondents)} sub={`${pct(respondents, active)} of active subscribers`} />
      <Stat label="Surveys" value={num(surveys.length)} />
      <Stat label="Overall NPS" value={npsN ? Math.round(((promoters - detractors) / npsN) * 100) : '—'} sub={npsN ? `${npsN} ratings` : 'no NPS questions answered'} />
    </Stats>
    <Card title="Responses, last 30 days"><LineChart labels={labels} series={[{ label: 'Responses', values }]} height={160} /></Card>
    <div class="grid g2">
      <Card title="Responses by survey"><Bars rows={surveys.map((s) => ({ label: <a href={`/app/audience/surveys/${s.id}`}>{s.title}</a>, value: s.n, sub: `${s.people} people` }))} /></Card>
      <Card title="Latest responses" pad={false}>
        <Table<any> rows={recent} empty="No responses yet." cols={[
          { h: 'Survey', r: (r) => <a href={`/app/audience/surveys/${r.survey_id}`}>{r.title}</a> },
          { h: 'Reader', r: (r) => r.subscriber_id ? <a href={`/app/audience/s/${r.subscriber_id}`}>{r.email}</a> : <Muted>anonymous</Muted> },
          { h: 'When', r: (r) => ago(r.created_at) },
        ]} />
      </Card>
    </div>
  </>);
});

app.get('/surveys/:id/edit', async (c) => {
  const s = await loadSurvey(c);
  if (!s) return back(c, '/app/audience/surveys', 'Survey not found', 'err');
  const responses = await val<number>(c.env, 'SELECT COUNT(*) FROM survey_responses WHERE survey_id = ?', s.id);
  return page(c, { title: `Edit: ${s.title}`, sub: 'surveys', crumbs: [['/app/audience/surveys', 'Surveys'], [`/app/audience/surveys/${s.id}`, s.title]], scripts: ['/static/audience-ui.js'] }, (
    <form method="post" action={`/app/audience/surveys/${s.id}`}>
      <div class="split">
        <div>
          {responses > 0 && <div class="callout warn">This survey has {num(responses)} responses. Changing question types or removing questions may make older answers harder to compare.</div>}
          <Json id="survey-kinds" data={KINDS} />
          <input type="hidden" name="questions" id="survey-questions" value={s.questions} />
          <div data-survey-builder="#survey-questions" />
        </div>
        <div>
          <Card title="Settings">
            <Field label="Title"><Input name="title" value={s.title} required /></Field>
            <Field label="Intro text"><Textarea name="description" value={s.description} rows={3} /></Field>
            <Field label="Thank-you message"><Input name="thank_you" value={s.thank_you} /></Field>
            <Field label="Status"><Select name="status" value={s.status} options={[['active', 'Accepting responses'], ['closed', 'Closed']]} /></Field>
            <div class="form-actions"><Btn>Save survey</Btn></div>
          </Card>
          <Card title="Share"><Copy value={`${siteUrl(c.env, c.get('pub'))}/survey/${s.id}`} /><Help>Link it from a post or email. Links inside emails identify the reader automatically, so every answer is tied to a real subscriber.</Help></Card>
        </div>
      </div>
    </form>
  ));
});

app.post('/surveys/:id', async (c) => {
  const s = await loadSurvey(c);
  if (!s) return back(c, '/app/audience/surveys', 'Survey not found', 'err');
  const f = await form(c.req);
  const qs = parseJSON<any[]>(f.questions, []).filter((x) => x && x.label).slice(0, 50).map((x) => ({
    id: String(x.id || id(6)).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20) || id(6), kind: KINDS.some(([k]) => k === x.kind) ? x.kind : 'short', label: String(x.label).slice(0, 300),
    options: Array.isArray(x.options) ? x.options.map((o: any) => String(o).slice(0, 200)).filter(Boolean).slice(0, 30) : undefined, required: !!x.required,
  }));
  await update(c.env, 'surveys', s.id, { title: str(f.title, 200) || s.title, description: str(f.description, 1000), thank_you: str(f.thank_you, 300) || 'Thanks for your response!', status: f.status === 'closed' ? 'closed' : 'active', questions: JSON.stringify(qs) }, c.get('pub').id);
  return back(c, `/app/audience/surveys/${s.id}`, 'Survey saved');
});

function topTerms(texts: string[], n = 12): Array<{ term: string; count: number }> {
  const counts = new Map<string, number>();
  for (const t of texts) {
    const words = t.toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
    const seen = new Set<string>();
    for (let i = 0; i < words.length; i++) {
      for (const term of [words[i], i + 1 < words.length ? `${words[i]} ${words[i + 1]}` : '']) if (term && !seen.has(term)) { seen.add(term); counts.set(term, (counts.get(term) || 0) + 1); }
    }
  }
  return [...counts.entries()].filter(([, v]) => v > 1).sort((a, b) => b[1] - a[1]).slice(0, n).map(([term, count]) => ({ term, count }));
}

app.get('/surveys/:id', async (c) => {
  const pub = c.get('pub');
  const s = await loadSurvey(c);
  if (!s) return back(c, '/app/audience/surveys', 'Survey not found', 'err');
  const qs = parseJSON<SurveyQ[]>(s.questions, []);
  const resp = await all<any>(c.env, 'SELECT answers, subscriber_id FROM survey_responses WHERE survey_id = ? ORDER BY created_at DESC LIMIT 20000', s.id);
  const answers = resp.map((r) => parseJSON<Record<string, any>>(r.answers, {}));
  const linked = resp.filter((r) => r.subscriber_id).length;
  const textAll: string[] = [];
  return page(c, {
    title: s.title, sub: 'surveys', crumbs: [['/app/audience/surveys', 'Surveys']],
    actions: <>
      <LinkBtn small href={`/app/audience/surveys/${s.id}/responses`}>Browse responses</LinkBtn>
      <LinkBtn small href={`/app/audience/surveys/${s.id}/export`}>Export CSV</LinkBtn>
      <LinkBtn small href={`/app/audience/surveys/${s.id}/edit`} kind="primary">Edit survey</LinkBtn>
      <ActionForm action={`/app/audience/surveys/${s.id}/duplicate`} label="Duplicate" />
      <ActionForm action={`/app/audience/surveys/${s.id}/delete`} label="Delete" kind="danger" confirm="Delete this survey and all its responses?" />
    </>,
  }, <>
    <Stats>
      <Stat label="Responses" value={num(resp.length)} />
      <Stat label="Tied to subscribers" value={pct(linked, resp.length || 1, 0)} sub={`${num(linked)} identified`} />
      <Stat label="Status" value={<Status s={s.status === 'active' ? 'active' : 'ended'} />} />
    </Stats>
    <Card title="Share link"><Copy value={`${siteUrl(c.env, pub)}/survey/${s.id}`} /></Card>
    {qs.map((qq, qi) => {
      const vals = answers.map((a) => a[qq.id]).filter((v) => v !== undefined && v !== '');
      let body: any;
      if (['single', 'multi', 'dropdown'].includes(qq.kind)) {
        const counts = new Map<string, number>();
        for (const o of qq.options || []) counts.set(o, 0);
        for (const v of vals) for (const x of Array.isArray(v) ? v : [v]) counts.set(String(x), (counts.get(String(x)) || 0) + 1);
        body = <div class="survey-bars">{[...counts.entries()].map(([label, n]) => (
          <div class="bar-row"><span class="bar-l">{label}</span><span class="bar-t"><span class="bar-f" style={`width:${vals.length ? (n / vals.length) * 100 : 0}%`} /></span><span class="bar-v">{n} · {pct(n, vals.length, 0)}</span>
            <form method="post" action={`/app/audience/surveys/${s.id}/segment`} class="inline-form"><input type="hidden" name="question_id" value={qq.id} /><input type="hidden" name="value" value={label} /><button class="btn btn-ghost btn-sm" title="Create a segment of readers who chose this">+ segment</button></form>
          </div>))}</div>;
      } else if (qq.kind === 'rating' || qq.kind === 'nps') {
        const max = qq.kind === 'nps' ? 10 : 5, min = qq.kind === 'nps' ? 0 : 1;
        const nums = vals.map(Number).filter((x) => !isNaN(x));
        const avg = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
        const prom = nums.filter((x) => x >= 9).length, det = nums.filter((x) => x <= 6).length;
        body = <>
          <p><strong>Average {avg.toFixed(1)}</strong> / {max}{qq.kind === 'nps' && nums.length ? <> · <strong>NPS {Math.round(((prom - det) / nums.length) * 100)}</strong> <Muted>({prom} promoters, {nums.length - prom - det} passives, {det} detractors)</Muted></> : null}</p>
          <Bars rows={Array.from({ length: max - min + 1 }, (_, i) => max - i).map((v) => ({ label: qq.kind === 'rating' ? '★'.repeat(v) : String(v), value: nums.filter((x) => x === v).length }))} />
        </>;
      } else {
        const texts = vals.map(String);
        textAll.push(...texts);
        const terms = topTerms(texts);
        body = <>
          {terms.length > 0 && <div class="row" style="margin-bottom:10px">{terms.map((t) => <Badge tone="blue">{t.term} · {t.count}</Badge>)}</div>}
          <ul class="list-plain small">{texts.slice(0, 15).map((t) => <li>{t}</li>)}</ul>
          {texts.length > 15 && <Help><a href={`/app/audience/surveys/${s.id}/responses`}>See all {texts.length} answers</a></Help>}
        </>;
      }
      return <Card title={<>{qi + 1}. {qq.label}</>} actions={<Muted>{num(vals.length)} answers · {KINDS.find(([k]) => k === qq.kind)?.[1]}</Muted>}>{vals.length ? body : <Help>No answers yet.</Help>}</Card>;
    })}
    {textAll.length > 0 && (
      <Card title="What should you write next?" actions={!aiEnabled(c.env) ? <Muted>Enable Workers AI for summaries</Muted> : null}>
        <Help>Recurring themes from open-ended answers are highlighted above each question.{aiEnabled(c.env) ? ' Ask AI to summarize them into post ideas:' : ''}</Help>
        {aiEnabled(c.env) && <form method="post" action={`/app/audience/surveys/${s.id}/summarize`} data-ajax-summary><Btn small kind="secondary">Summarize into post ideas</Btn><div class="ai-summary" style="white-space:pre-wrap;margin-top:10px" /></form>}
      </Card>
    )}
  </>);
});

app.post('/surveys/:id/summarize', async (c) => {
  const s = await loadSurvey(c);
  if (!s) return c.json({ error: 'not found' }, 404);
  const qs = parseJSON<SurveyQ[]>(s.questions, []).filter((x) => ['short', 'long'].includes(x.kind));
  const rows = await all<any>(c.env, 'SELECT answers FROM survey_responses WHERE survey_id = ? ORDER BY created_at DESC LIMIT 300', s.id);
  const texts = rows.flatMap((r) => { const a = parseJSON<Record<string, any>>(r.answers, {}); return qs.map((x) => a[x.id]).filter(Boolean).map(String); });
  const r = await aiText(c.env, `Survey "${s.title}" — reader answers:\n${texts.map((t) => '- ' + t.slice(0, 300)).join('\n').slice(0, 12000)}\n\nSummarize the main themes in 3-6 bullets, then suggest 5 specific post ideas the readers are asking for.`, 'You analyze newsletter reader feedback for the editor. Be concise and concrete.');
  return c.json(r.ok ? { text: r.text } : { error: r.text }, r.ok ? 200 : 400);
});

app.get('/surveys/:id/responses', async (c) => {
  const s = await loadSurvey(c);
  if (!s) return back(c, '/app/audience/surveys', 'Survey not found', 'err');
  const total = await val<number>(c.env, 'SELECT COUNT(*) FROM survey_responses WHERE survey_id = ?', s.id);
  const i = Math.min(Math.max(0, int(c.req.query('i'), 0)), Math.max(0, total - 1));
  const r = await one<any>(c.env, `SELECT r.*, sub.email, sub.name FROM survey_responses r LEFT JOIN subscribers sub ON sub.id = r.subscriber_id WHERE r.survey_id = ? ORDER BY r.created_at DESC LIMIT 1 OFFSET ?`, s.id, i);
  const qs = parseJSON<SurveyQ[]>(s.questions, []);
  const a = parseJSON<Record<string, any>>(r?.answers, {});
  return page(c, { title: `Responses: ${s.title}`, sub: 'surveys', crumbs: [['/app/audience/surveys', 'Surveys'], [`/app/audience/surveys/${s.id}`, s.title]] }, (
    !r ? <Card><Empty title="No responses yet" body="Share the survey link to start collecting answers." /></Card> : (
      <Card title={<>Response {i + 1} of {num(total)}</>} actions={<div class="row">{i > 0 && <LinkBtn small href={`?i=${i - 1}`}>← Newer</LinkBtn>}{i < total - 1 && <LinkBtn small href={`?i=${i + 1}`}>Older →</LinkBtn>}</div>}>
        <p>{r.subscriber_id ? <a href={`/app/audience/s/${r.subscriber_id}`}>{r.name ? `${r.name} · ` : ''}{r.email}</a> : <Muted>Anonymous</Muted>} <Muted>· {fmtDateTime(r.created_at, c.get('pub').timezone)}</Muted></p>
        <dl class="kv">{qs.map((qq) => <><dt>{qq.label}</dt><dd>{a[qq.id] === undefined ? <Muted>—</Muted> : Array.isArray(a[qq.id]) ? a[qq.id].join(', ') : String(a[qq.id])}</dd></>)}</dl>
        <form method="post" action={`/app/audience/surveys/${s.id}/responses/${r.id}/delete`} style="margin-top:14px"><Btn small kind="danger" confirm="Delete this response?">Delete response</Btn></form>
      </Card>
    )
  ));
});

app.post('/surveys/:id/responses/:rid/delete', async (c) => {
  await run(c.env, 'DELETE FROM survey_responses WHERE id = ? AND survey_id = ? AND pub_id = ?', c.req.param('rid'), c.req.param('id'), c.get('pub').id);
  return back(c, `/app/audience/surveys/${c.req.param('id')}/responses`, 'Response deleted');
});

app.get('/surveys/:id/export', async (c) => {
  const s = await loadSurvey(c);
  if (!s) return back(c, '/app/audience/surveys', 'Survey not found', 'err');
  const qs = parseJSON<SurveyQ[]>(s.questions, []);
  const rows = await all<any>(c.env, `SELECT r.*, sub.email, sub.name FROM survey_responses r LEFT JOIN subscribers sub ON sub.id = r.subscriber_id WHERE r.survey_id = ? ORDER BY r.created_at`, s.id);
  const out: unknown[][] = [['response_id', 'submitted_at', 'email', 'name', ...qs.map((x) => x.label)]];
  for (const r of rows) { const a = parseJSON<Record<string, any>>(r.answers, {}); out.push([r.id, new Date(r.created_at).toISOString(), r.email || '', r.name || '', ...qs.map((x) => (Array.isArray(a[x.id]) ? a[x.id].join('; ') : a[x.id] ?? ''))]); }
  return new Response(toCSV(out), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="survey-${s.id}.csv"` } });
});

app.post('/surveys/:id/segment', async (c) => {
  const pub = c.get('pub');
  const s = await loadSurvey(c);
  if (!s) return back(c, '/app/audience/surveys', 'Survey not found', 'err');
  const f = await form(c.req);
  const qq = parseJSON<SurveyQ[]>(s.questions, []).find((x) => x.id === f.question_id);
  const value = str(f.value, 200);
  const sid = id();
  await insert(c.env, 'segments', { id: sid, pub_id: pub.id, name: `${s.title}: ${value}`.slice(0, 120), description: `Answered "${value}" to "${qq?.label || 'question'}"`, kind: 'dynamic', rules: JSON.stringify({ op: 'and', rules: [{ field: 'survey', cmp: 'answer_equals', value: { survey_id: s.id, question_id: f.question_id, value } }] }), created_at: now() });
  await recalcSegment(c.env, pub.id, sid);
  return back(c, `/app/audience/segments/${sid}`, 'Segment created from survey answers');
});

app.post('/surveys/:id/duplicate', async (c) => {
  const s = await loadSurvey(c);
  if (!s) return back(c, '/app/audience/surveys', 'Survey not found', 'err');
  const nid = id(12);
  await insert(c.env, 'surveys', { id: nid, pub_id: s.pub_id, title: s.title + ' (copy)', description: s.description, questions: s.questions, status: 'active', thank_you: s.thank_you, created_at: now() });
  return back(c, `/app/audience/surveys/${nid}/edit`, 'Survey duplicated');
});

app.post('/surveys/:id/delete', async (c) => {
  await run(c.env, 'DELETE FROM surveys WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
  await audit(c, 'survey.delete', c.req.param('id'));
  return back(c, '/app/audience/surveys', 'Survey deleted');
});

// ───────── polls ─────────
app.get('/polls', async (c) => {
  const rows = await all<any>(c.env, `SELECT p.*, (SELECT COUNT(*) FROM poll_votes v WHERE v.poll_id = p.id) AS votes FROM polls p WHERE p.pub_id = ? ORDER BY p.created_at DESC`, c.get('pub').id);
  return page(c, { title: 'Polls', sub: 'polls', actions: <OpenBtn target="#new-poll" small>+ New poll</OpenBtn> }, <>
    <Help>Readers answer polls with one click right in the inbox (or on the web). Insert a poll into any post from the editor's block menu.</Help>
    {rows.length ? (
      <Table<any> rows={rows} rowHref={(p) => `/app/audience/polls/${p.id}`} cols={[
        { h: 'Question', r: (p) => <a href={`/app/audience/polls/${p.id}`}>{p.question}</a> },
        { h: 'Purpose', r: (p) => <Badge>{p.purpose}</Badge> },
        { h: 'Options', r: (p) => parseJSON<any[]>(p.options, []).length },
        { h: 'Votes', r: (p) => <strong>{num(p.votes)}</strong> },
        { h: 'Status', r: (p) => <Status s={p.closed ? 'ended' : 'active'} /> },
        { h: 'Created', r: (p) => ago(p.created_at) },
      ]} />
    ) : <Card><Empty icon="▤" title="No polls yet" body="Ask readers to pick topics, products or pricing with a single click." action={<OpenBtn target="#new-poll">Create a poll</OpenBtn>} /></Card>}
    <Modal id="new-poll" title="New poll">
      <form method="post" action="/app/audience/polls">
        <Field label="Question"><Input name="question" required autofocus placeholder="What should next week's deep dive cover?" /></Field>
        <Field label="Options" hint="One per line (2–10)"><Textarea name="options" rows={4} required placeholder={'Option A\nOption B\nOption C'} /></Field>
        <Field label="Purpose"><Select name="purpose" options={[['general', 'General'], ['topic', 'Pick a topic'], ['product', 'Product research'], ['pricing', 'Pricing research']]} /></Field>
        <div class="form-actions"><Btn>Create poll</Btn></div>
      </form>
    </Modal>
  </>);
});

app.post('/polls', async (c) => {
  const f = await form(c.req);
  const opts = str(f.options).split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 10);
  if (opts.length < 2) return back(c, '/app/audience/polls', 'A poll needs at least two options', 'err');
  const pid = id(12);
  await insert(c.env, 'polls', { id: pid, pub_id: c.get('pub').id, question: str(f.question, 300), options: JSON.stringify(opts.map((label) => ({ id: id(6), label: label.slice(0, 200) }))), purpose: ['general', 'topic', 'product', 'pricing'].includes(f.purpose) ? f.purpose : 'general', closed: 0, created_at: now() });
  return back(c, `/app/audience/polls/${pid}`, 'Poll created — insert it into a post from the editor');
});

app.get('/polls/:id', async (c) => {
  const pub = c.get('pub');
  const p = await one<any>(c.env, 'SELECT * FROM polls WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
  if (!p) return back(c, '/app/audience/polls', 'Poll not found', 'err');
  const opts = parseJSON<Array<{ id: string; label: string }>>(p.options, []);
  const counts = await all<any>(c.env, 'SELECT option_id, channel, COUNT(*) AS n FROM poll_votes WHERE poll_id = ? GROUP BY option_id, channel', p.id);
  const total = counts.reduce((a, b) => a + b.n, 0);
  const byOpt = (oid: string, ch?: string) => counts.filter((x) => x.option_id === oid && (!ch || x.channel === ch)).reduce((a, b) => a + b.n, 0);
  const email = counts.filter((x) => x.channel === 'email').reduce((a, b) => a + b.n, 0);
  const voters = await all<any>(c.env, `SELECT v.*, s.email, s.name FROM poll_votes v LEFT JOIN subscribers s ON s.id = v.subscriber_id WHERE v.poll_id = ? ORDER BY v.created_at DESC LIMIT 200`, p.id);
  const posts = await all<any>(c.env, `SELECT DISTINCT po.id, po.title FROM poll_votes v JOIN posts po ON po.id = v.post_id WHERE v.poll_id = ?`, p.id);
  return page(c, {
    title: p.question, sub: 'polls', crumbs: [['/app/audience/polls', 'Polls']],
    actions: <>
      <LinkBtn small href={`${siteUrl(c.env, pub)}/poll/${p.id}`} target="_blank">Public results</LinkBtn>
      <ActionForm action={`/app/audience/polls/${p.id}/toggle`} label={p.closed ? 'Reopen poll' : 'Close poll'} />
      <ActionForm action={`/app/audience/polls/${p.id}/delete`} label="Delete" kind="danger" confirm="Delete this poll and its votes? Posts containing it will hide the block." />
    </>,
  }, <>
    {!p.closed && <meta http-equiv="refresh" content="30" />}
    <Stats>
      <Stat label="Votes" value={num(total)} sub={p.closed ? 'closed' : 'live · refreshes every 30s'} />
      <Stat label="From email" value={num(email)} sub={pct(email, total)} />
      <Stat label="From web" value={num(total - email)} sub={pct(total - email, total)} />
      <Stat label="Identified voters" value={num(voters.filter((v) => v.subscriber_id).length)} />
    </Stats>
    <Card title="Results">
      {opts.map((o) => {
        const n = byOpt(o.id);
        return <div class="bar-row poll-row"><span class="bar-l"><strong>{o.label}</strong></span><span class="bar-t"><span class="bar-f" style={`width:${total ? (n / total) * 100 : 0}%`} /></span><span class="bar-v">{pct(n, total, 0)} · {n}</span>
          <span class="small muted nowrap">✉ {byOpt(o.id, 'email')} · 🌐 {byOpt(o.id, 'web')}</span>
          <form method="post" action={`/app/audience/polls/${p.id}/segment`} class="inline-form"><input type="hidden" name="option_id" value={o.id} /><button class="btn btn-ghost btn-sm">+ segment</button></form>
        </div>;
      })}
    </Card>
    <div class="split">
      <Card title="Voters" pad={false}>
        <Table<any> rows={voters} empty="No votes yet." cols={[
          { h: 'Reader', r: (v) => v.subscriber_id ? <a href={`/app/audience/s/${v.subscriber_id}`}>{v.email}</a> : <Muted>anonymous web visitor</Muted> },
          { h: 'Answer', r: (v) => opts.find((o) => o.id === v.option_id)?.label || v.option_id },
          { h: 'Channel', r: (v) => v.channel },
          { h: 'When', r: (v) => ago(v.created_at) },
        ]} />
      </Card>
      <div>
        <Card title="Use this poll">
          <Help>In the post editor type <code>/poll</code> and pick “{p.question.slice(0, 40)}”. In email each option is a one-click link; on the web readers vote inline.</Help>
          <Field label="Direct link"><Copy value={`${siteUrl(c.env, pub)}/poll/${p.id}`} /></Field>
          <Field label="Poll ID"><Copy value={p.id} /></Field>
        </Card>
        {posts.length > 0 && <Card title="Appears in">{posts.map((po) => <p><a href={`/app/posts/${po.id}`}>{po.title}</a></p>)}</Card>}
      </div>
    </div>
  </>);
});

app.post('/polls/:id/toggle', async (c) => {
  await run(c.env, 'UPDATE polls SET closed = 1 - closed WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
  return back(c, `/app/audience/polls/${c.req.param('id')}`, 'Poll updated');
});

app.post('/polls/:id/delete', async (c) => {
  await run(c.env, 'DELETE FROM polls WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
  return back(c, '/app/audience/polls', 'Poll deleted');
});

app.post('/polls/:id/segment', async (c) => {
  const pub = c.get('pub');
  const p = await one<any>(c.env, 'SELECT * FROM polls WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
  if (!p) return back(c, '/app/audience/polls', 'Poll not found', 'err');
  const f = await form(c.req);
  const opt = parseJSON<any[]>(p.options, []).find((o) => o.id === f.option_id);
  const sid = id();
  await insert(c.env, 'segments', { id: sid, pub_id: pub.id, name: `Poll: ${opt?.label || 'answer'}`.slice(0, 120), description: `Chose "${opt?.label}" in "${p.question}"`, kind: 'dynamic', rules: JSON.stringify({ op: 'and', rules: [{ field: 'poll', cmp: 'chose', value: { poll_id: p.id, option_id: f.option_id } }] }), created_at: now() });
  await recalcSegment(c.env, pub.id, sid);
  return back(c, `/app/audience/segments/${sid}`, 'Segment created from poll answers');
});

export default app;
