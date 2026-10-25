/** @jsxImportSource hono/jsx */
// Embeddable subscribe forms (iframe + JS), attribution script, and the CORS form endpoint /f/:id.
import { Hono } from 'hono';
import type { AppEnv, Ctx, Publication } from '../../types';
import { one, all, run } from '../../lib/db';
import { formConfig, formCSS, formMarkup } from '../../lib/forms';
import { processSignup } from '../../lib/signup';
import { respondSignup } from './public';
import { form, esc } from '../../lib/util';

const root = new Hono<AppEnv>();

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type, accept', 'access-control-max-age': '86400' };

async function loadForm(c: Ctx, formId: string) {
  const f = await one<any>(c.env, 'SELECT * FROM forms WHERE id = ?', formId);
  if (!f) return null;
  const pub = await one<Publication>(c.env, 'SELECT * FROM publications WHERE id = ?', f.pub_id);
  if (!pub) return null;
  if (!f.live) return null; // only published forms are served
  const cfg = formConfig(f.live);
  const lists = await all<{ id: string; name: string }>(c.env, 'SELECT id, name FROM lists WHERE pub_id = ?', pub.id);
  const fields = await all<{ key: string; label: string }>(c.env, 'SELECT key, label FROM custom_fields WHERE pub_id = ?', pub.id);
  return { f, pub, cfg, lists, fields };
}

/** Client script shared by iframe and JS embeds: UTM capture + fetch submit + popup display. */
export function clientScript(endpoint: string, popup: string | null): string {
  return `(function(){
var EP=${JSON.stringify(endpoint)};
function attr(){try{var s=localStorage.getItem('oh_attr');var a=s?JSON.parse(s):{};var p=new URLSearchParams(location.search);var keys=['utm_source','utm_medium','utm_campaign','utm_term','utm_content','ref','ref_pub'];var got=false;keys.forEach(function(k){if(p.get(k)){a[k]=p.get(k);got=true}});if(got||!a.landing){a.landing=a.landing||location.pathname;a.referrer=a.referrer||document.referrer;localStorage.setItem('oh_attr',JSON.stringify(a))}return a}catch(e){return{}}}
function wire(root){root.querySelectorAll('form[data-ohf-form]').forEach(function(f){if(f.__oh)return;f.__oh=1;var u=f.querySelector('[data-ohf-utm]');if(u)u.value=JSON.stringify(attr());
f.addEventListener('submit',function(e){e.preventDefault();var b=f.querySelector('button[type=submit]');var m=f.querySelector('.ohf-msg');b.disabled=true;m.className='ohf-msg';m.textContent='';
fetch(EP,{method:'POST',body:new FormData(f),headers:{accept:'application/json'}}).then(function(r){return r.json()}).then(function(j){b.disabled=false;
if(j.confirm){var h=f.querySelector('input[name=_human]');if(!h){h=document.createElement('input');h.type='hidden';h.name='_human';f.appendChild(h)}h.value=j.human;m.textContent='Please click once more to confirm you are human.';return}
if(!j.ok){m.className='ohf-msg ohf-err';m.textContent=j.error||'Something went wrong.';if(j.suggestion){var s=document.createElement('button');s.type='button';s.className='ohf-sug';s.textContent=' Use '+j.suggestion;s.onclick=function(){f.querySelector('input[name=email]').value=j.suggestion;f.requestSubmit()};m.appendChild(s)}return}
try{localStorage.setItem('oh_subscribed','1')}catch(e){}
if(j.redirect){(window.top||window).location.href=j.redirect;return}
f.innerHTML='<div class="ohf-msg ohf-ok"></div>';f.querySelector('.ohf-ok').textContent=j.message||'Thanks for subscribing!';
var pop=f.closest('.ohf-pop');if(pop)setTimeout(function(){pop.remove()},2500)}).catch(function(){b.disabled=false;m.className='ohf-msg ohf-err';m.textContent='Network error, please try again.'})})})}
window.__ohWire=wire;
${popup ? `function popup(){var cfg=${popup};var key='oh_pop_'+cfg.id;try{if(localStorage.getItem('oh_subscribed'))return;var last=+localStorage.getItem(key)||0;if(Date.now()-last<(cfg.frequency_days||7)*864e5)return}catch(e){}
var tpl=document.getElementById('ohf-pop-'+cfg.id);if(!tpl)return;var shown=false;function show(){if(shown)return;shown=true;try{localStorage.setItem(key,String(Date.now()))}catch(e){}var o=document.createElement('div');o.className='ohf-pop';o.setAttribute('style','position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:2147483000;padding:16px');o.innerHTML='<div style="position:relative;max-width:460px;width:100%">'+tpl.innerHTML+'<button type="button" aria-label="Close" style="position:absolute;top:8px;right:10px;border:0;background:none;font-size:20px;cursor:pointer;color:#6b7280">\\u2715</button></div>';o.addEventListener('click',function(e){if(e.target===o||e.target.getAttribute('aria-label')==='Close')o.remove()});document.body.appendChild(o);wire(o)}
if(cfg.delay)setTimeout(show,cfg.delay*1000);if(cfg.scroll)addEventListener('scroll',function(){if((scrollY+innerHeight)/document.body.scrollHeight*100>=cfg.scroll)show()},{passive:true});if(cfg.exit)document.addEventListener('mouseout',function(e){if(!e.relatedTarget&&e.clientY<10)show()});if(!cfg.delay&&!cfg.scroll&&!cfg.exit)show()}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',popup);else popup();` : ''}
})();`;
}

// Iframe embed: /embed/form/:id   ·   JS embed: /embed/form/:id.js
root.get('/embed/form/:file', async (c) => {
  const file = c.req.param('file');
  const isJs = file.endsWith('.js');
  const formId = file.replace(/\.js$/, '');
  const d = await loadForm(c, formId);
  if (!d) return isJs ? c.text('/* OpenHive: form not found */', 404, { 'content-type': 'application/javascript' }) : c.text('Form not found', 404);
  const app = c.env.APP_URL.replace(/\/$/, '');
  const endpoint = `${app}/f/${d.f.id}`;
  c.executionCtx.waitUntil(run(c.env, 'UPDATE forms SET views = views + 1 WHERE id = ?', d.f.id));
  const tsKey = d.cfg.turnstile ? c.env.TURNSTILE_SITE_KEY : undefined;
  const markup = formMarkup(d.cfg, { formId: d.f.id, layout: d.f.layout, action: endpoint, lists: d.lists, fields: d.fields, turnstileKey: tsKey, source: d.f.kind === 'popup' ? 'popup' : 'form' });
  const css = formCSS(d.cfg.style, `.ohf[data-ohf="${d.f.id}"]`);
  if (isJs) {
    const popupCfg = d.f.kind === 'popup' ? JSON.stringify({ id: d.f.id, ...d.cfg.popup }) : null;
    const js = `(function(){var s=document.currentScript;var css=${JSON.stringify(css)};var html=${JSON.stringify(markup)};
if(!document.getElementById('ohf-css-${d.f.id}')){var st=document.createElement('style');st.id='ohf-css-${d.f.id}';st.textContent=css;document.head.appendChild(st)}
${tsKey ? `if(!document.getElementById('cf-ts')){var t=document.createElement('script');t.id='cf-ts';t.src='https://challenges.cloudflare.com/turnstile/v0/api.js';t.async=true;document.head.appendChild(t)}` : ''}
${d.f.kind === 'popup' ? `var tpl=document.createElement('template');tpl.id='ohf-pop-${d.f.id}';tpl.innerHTML=html;document.body?document.body.appendChild(tpl):document.addEventListener('DOMContentLoaded',function(){document.body.appendChild(tpl)});` : `var targets=document.querySelectorAll('[data-openhive-form="${d.f.id}"]');var box;if(targets.length){targets.forEach(function(t){t.innerHTML=html})}else{box=document.createElement('div');box.innerHTML=html;s.parentNode.insertBefore(box,s.nextSibling)}`}
})();
${clientScript(endpoint, popupCfg)}
${d.f.kind === 'popup' ? '' : `window.__ohWire&&window.__ohWire(document);`}`;
    return c.body(js, 200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=60', 'access-control-allow-origin': '*' });
  }
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(d.cfg.title)}</title><style>html,body{margin:0;background:transparent}${css}</style>${tsKey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ''}</head><body>${markup}<script>${clientScript(endpoint, null)};window.__ohWire(document);
(function(){function h(){parent.postMessage({openhive:'resize',id:${JSON.stringify(d.f.id)},height:document.documentElement.scrollHeight},'*')}h();new ResizeObserver(h).observe(document.body)})();</script></body></html>`;
  return c.html(html, 200, { 'cache-control': 'public, max-age=60' });
});

// Attribution script for any website: first-touch UTMs/referrer → OpenHive forms + links
root.get('/embed/attribution.js', (c) => {
  const app = c.env.APP_URL.replace(/\/$/, '');
  const js = `(function(){var KEY='oh_attr',TTL=30*864e5;function load(){try{var a=JSON.parse(localStorage.getItem(KEY)||'{}');if(a._at&&Date.now()-a._at>TTL)a={};return a}catch(e){return{}}}
function save(a){try{localStorage.setItem(KEY,JSON.stringify(a))}catch(e){}}
var a=load(),p=new URLSearchParams(location.search),keys=['utm_source','utm_medium','utm_campaign','utm_term','utm_content','ref','ref_pub'],touched=false;
keys.forEach(function(k){if(p.get(k)){if(!a[k]||!a._first)a[k]=p.get(k);touched=true}});
if(!a._at){a._at=Date.now();a.landing=location.pathname;a.referrer=document.referrer||'';touched=true}
if(touched){a._first=1;save(a)}
function payload(){var x=load();var o={};keys.concat(['landing','referrer']).forEach(function(k){if(x[k])o[k]=x[k]});return JSON.stringify(o)}
function apply(){document.querySelectorAll('input[data-ohf-utm],form[action*="/f/"] input[name=utm],form[action*="/subscribe"] input[name=utm]').forEach(function(i){i.value=payload()});
document.querySelectorAll('iframe[src^="${app}/embed/form/"]').forEach(function(f){if(f.dataset.ohAttr)return;f.dataset.ohAttr=1;var x=load(),u=new URL(f.src);keys.forEach(function(k){if(x[k])u.searchParams.set(k,x[k])});f.src=u.toString()})}
window.OpenHive=window.OpenHive||{};window.OpenHive.attribution=function(){return JSON.parse(payload())};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',apply);else apply();new MutationObserver(apply).observe(document.documentElement,{childList:true,subtree:true});
addEventListener('message',function(e){if(e.data&&e.data.openhive==='resize'){document.querySelectorAll('iframe[src*="/embed/form/'+e.data.id+'"]').forEach(function(f){f.style.height=e.data.height+'px'})}});})();`;
  return c.body(js, 200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' });
});

root.options('/f/:id', (c) => c.body(null, 204, CORS));

root.post('/f/:id', async (c) => {
  const d = await loadForm(c, c.req.param('id'));
  if (!d) return c.json({ ok: false, error: 'Form not found' }, 404, CORS);
  c.set('pub', d.pub);
  c.set('reader', null);
  const ct = c.req.header('content-type') || '';
  const body: Record<string, any> = ct.includes('application/json') ? await c.req.json() : await form(c.req);
  const res = await processSignup(c.env, c.req.raw, d.pub, body, { formId: d.f.id });
  const wantsJson = (c.req.header('accept') || '').includes('application/json') || ct.includes('application/json');
  const resp = await respondSignup(c, res, body, wantsJson ? 'json' : 'site');
  for (const [k, v] of Object.entries(CORS)) resp.headers.set(k, v);
  return resp;
});

export default root;
