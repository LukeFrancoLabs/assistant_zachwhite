'use strict';

/**
 * perfAnalytics — the dashboard's 📊 Performance tab (Analytics group).
 *
 * Everything is derived from the logs textLog.js already reads; nothing is written. A reply is credited to the
 * LAST message we sent that account in the reply's own channel before the reply arrived (a text reply → the last
 * text, an email reply → the last email; if that channel has none, the last message of any kind). That is a
 * best guess, not proof — a pro can answer an old text weeks later — so the tab says "credited to".
 *
 *   build({ rows, replies, won, indOf, zonesFor, isBanned, sfUrl }) → the JSON the page renders
 *   PANE_HTML / CLIENT_JS                                              → the pane markup and its script (textLog.js embeds both)
 */

const tcpa = require('./tcpa');

const k15 = (id) => String(id || '').toLowerCase().slice(0, 15);
const chOf = (r) => (r && r.channel === 'email' ? 'email' : 'text');
const ms = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? t : null; };
const NOTE_RE = /^\s*\[Top hit list\]/i;

const hourFmt = new Map();
/** Hour 0-23 and weekday 0-6 (Sun=0) of a moment in a zone. */
function localParts(t, tz) {
  if (!hourFmt.has(tz)) hourFmt.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false, weekday: 'short' }));
  const o = {}; for (const p of hourFmt.get(tz).formatToParts(new Date(t))) o[p.type] = p.value;
  return { hour: parseInt(o.hour, 10) % 24, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday) };
}

function build({ rows, replies, won, indOf, zonesFor, isBanned, sfUrl }) {
  const ET = 'America/New_York';
  // ---- outreach per account, oldest first
  const sends = rows.map((r) => ({ t: ms(r.at), ch: chOf(r), key: r.accountId ? k15(r.accountId) : `n:${String(r.accountName || '').toLowerCase()}`, name: r.accountName || '', id: r.accountId || null, tpl: r.templateName || '(no template)' })).filter((r) => r.t != null).sort((a, b) => a.t - b.t);
  const byAcct = new Map();
  for (const s of sends) { if (!byAcct.has(s.key)) byAcct.set(s.key, []); byAcct.get(s.key).push(s); }
  const zc = new Map();
  const zoneOf = (id) => { if (!id) return null; const k = k15(id); if (!zc.has(k)) { const z = zonesFor(id); zc.set(k, z && z.length === 1 ? z[0] : null); } return zc.get(k); };

  // template rows
  const tpl = new Map();
  const T = (s) => { const k = `${s.ch}|${s.tpl}`; if (!tpl.has(k)) tpl.set(k, { ch: s.ch, name: s.tpl, sends: 0, accts: new Set(), replied: new Set(), replies: 0, interested: 0, optout: 0, gift: 0, won: new Set() }); return tpl.get(k); };
  for (const s of sends) { const o = T(s); o.sends++; o.accts.add(s.key); }

  // ---- reply → credited message
  const lastBefore = (key, ch, t) => {
    const list = byAcct.get(key) || []; let same = null, any = null;
    for (const s of list) { if (s.t > t) break; any = s; if (s.ch === ch) same = s; }
    return same || any;
  };
  const rep = [];   // { key, ch, at, send, interested, optout, gift, text }
  let unattributed = 0, skipped = 0;
  for (const r of replies) {
    if (r.manual || NOTE_RE.test(r.reply || '')) { skipped++; continue; }
    const t = ms(r.at); const key = r.accountId ? k15(r.accountId) : null;
    const ch = chOf(r);
    const send = t != null && key ? lastBefore(key, ch, t) : null;
    if (!send) { unattributed++; continue; }
    rep.push({ key, ch, t, send, interested: !!r.interested, optout: !!r.optout, gift: !!r.gift, text: r.reply || '', name: r.accountName || send.name, id: r.accountId });
  }
  for (const r of rep) {
    const o = T(r.send); r.interested && !r.optout ? o.interested++ : 0; r.optout && o.optout++; r.gift && o.gift++;
    o.replies++; o.replied.add(r.key);
  }

  // ---- wins credited to the last touch before the close
  const winRows = [];
  const wonKeys = new Set();
  for (const w of won) {
    const key = k15(w.accountId); if (!key || wonKeys.has(key)) continue; wonKeys.add(key);
    const cd = ms(w.closeDate), at = ms(w.at);
    const t = cd != null && at != null ? Math.min(cd + 86400000, at) : (cd != null ? cd + 86400000 : at);
    const list = (byAcct.get(key) || []).filter((s) => t == null || s.t <= t);
    const last = list[list.length - 1] || null;
    const replied = rep.some((r) => r.key === key);
    if (last) T(last).won.add(key);
    winRows.push({ key, name: w.accountName || '', touches: list.length, ch: last ? last.ch : null, replied, tpl: last ? last.tpl : null });
  }

  const templates = [...tpl.values()].map((o) => ({ ch: o.ch, name: o.name, sends: o.sends, accounts: o.accts.size, replies: o.replies, replied: o.replied.size, interested: o.interested, optout: o.optout, gift: o.gift, won: o.won.size })).sort((a, b) => b.sends - a.sends);

  // ---- funnel (distinct accounts)
  const funnel = {};
  for (const ch of ['text', 'email', 'all']) {
    const inCh = (s) => ch === 'all' || s.ch === ch;
    const touched = new Set(sends.filter(inCh).map((s) => s.key));
    const rr = rep.filter((r) => ch === 'all' || r.ch === ch);
    const replied = new Set(rr.map((r) => r.key));
    const interested = new Set(rr.filter((r) => r.interested && !r.optout).map((r) => r.key));
    const optout = new Set(rr.filter((r) => r.optout).map((r) => r.key));
    const wins = winRows.filter((w) => ch === 'all' || w.ch === ch);
    funnel[ch] = { touched: touched.size, replied: replied.size, interested: interested.size, optout: optout.size, won: wins.length, wonReplied: wins.filter((w) => w.replied).length };
  }
  funnel.wonUntouched = winRows.filter((w) => !w.ch).length;
  const touchHist = [0, 0, 0, 0, 0]; for (const w of winRows) touchHist[Math.min(4, w.touches)]++;

  // ---- send time: hour and weekday (the pro's own zone when one zone is known, else ET)
  const hourX = { text: { s: Array(24).fill(0), r: Array(24).fill(0) }, email: { s: Array(24).fill(0), r: Array(24).fill(0) } };
  const dowX = { text: { s: Array(7).fill(0), r: Array(7).fill(0) }, email: { s: Array(7).fill(0), r: Array(7).fill(0) } };
  const partsOf = new Map();
  const parts = (s) => { if (!partsOf.has(s)) partsOf.set(s, localParts(s.t, zoneOf(s.id) || ET)); return partsOf.get(s); };
  for (const s of sends) { const p = parts(s); hourX[s.ch].s[p.hour]++; dowX[s.ch].s[p.dow]++; }
  for (const r of rep) { const p = parts(r.send); hourX[r.send.ch].r[p.hour]++; dowX[r.send.ch].r[p.dow]++; }
  const zoneKnown = sends.filter((s) => zoneOf(s.id)).length;

  // ---- industry and zone (distinct accounts)
  const cut = (labelOf) => {
    const m = new Map();
    const get = (l) => { if (!m.has(l)) m.set(l, { label: l, touched: new Set(), replied: new Set(), interested: new Set(), optout: new Set(), won: new Set() }); return m.get(l); };
    const lab = new Map();
    for (const s of sends) { if (!lab.has(s.key)) lab.set(s.key, labelOf(s)); get(lab.get(s.key)).touched.add(s.key); }
    for (const r of rep) { const g = get(lab.get(r.key) || 'Unknown'); g.replied.add(r.key); if (r.interested && !r.optout) g.interested.add(r.key); if (r.optout) g.optout.add(r.key); }
    for (const w of winRows) if (lab.has(w.key)) get(lab.get(w.key)).won.add(w.key);
    return [...m.values()].map((g) => ({ label: g.label, touched: g.touched.size, replied: g.replied.size, interested: g.interested.size, optout: g.optout.size, won: g.won.size })).sort((a, b) => b.touched - a.touched);
  };
  const byIndustry = cut((s) => (indOf(s.name, s.id) || {}).ind || 'Unknown');
  const byZone = cut((s) => { const z = zoneOf(s.id); return z ? (tcpa.ZONE_SHORT[z] || z) : 'Unknown'; });

  // ---- reply speed
  const BUCKETS = [['< 1 hour', 3600e3], ['1-4 hours', 4 * 3600e3], ['4-24 hours', 24 * 3600e3], ['1-3 days', 3 * 86400e3], ['3+ days', Infinity]];
  const speed = { buckets: BUCKETS.map((b) => b[0]), text: Array(5).fill(0), email: Array(5).fill(0), median: {} };
  const lags = { text: [], email: [] };
  for (const r of rep) { const lag = r.t - r.send.t; if (lag < 0) continue; lags[r.ch].push(lag); speed[r.ch][BUCKETS.findIndex((b) => lag < b[1])]++; }
  for (const ch of ['text', 'email']) { const a = lags[ch].sort((x, y) => x - y); speed.median[ch] = a.length ? Math.round(a[Math.floor(a.length / 2)] / 360000) / 10 : null; }   // hours, 1 decimal

  // ---- interested replies nobody has followed since (possible cold leads)
  const now = Date.now(), seen = new Set(), cold = [];
  for (const r of rep.slice().sort((a, b) => b.t - a.t)) {
    if (!r.interested || r.optout || seen.has(r.key)) continue; seen.add(r.key);
    if (wonKeys.has(r.key) || (r.id && isBanned(r.id))) continue;
    const after = (byAcct.get(r.key) || []).filter((s) => s.t > r.t).length;
    cold.push({ name: r.name, reply: r.text.replace(/\s+/g, ' ').slice(0, 160), at: new Date(r.t).toISOString(), ageDays: Math.round((now - r.t) / 864e4 * 10) / 10, ch: r.ch, after, url: r.id ? sfUrl(r.id) : null });
  }
  cold.sort((a, b) => (a.after === 0 ? 0 : 1) - (b.after === 0 ? 0 : 1) || b.ageDays - a.ageDays);

  return { templates, funnel, touchHist, hour: hourX, dow: dowX, zoneKnownPct: sends.length ? Math.round(100 * zoneKnown / sends.length) : 0, byIndustry, byZone, speed, cold, unattributed, skipped, replyTotal: rep.length, sendTotal: sends.length };
}

const PANE_HTML = `  <div id="pane-perf" class="eng" hidden>
    <div class="sub" style="margin-bottom:10px">What is working, all time. Each reply is <b>credited to the last message we sent that pro</b> in the same channel before it arrived (a best guess; a pro can answer an old message), and a win to the last message before it closed. Counts are distinct pros unless a column says messages.</div>
    <h3 class="eng-h">Template scorecard</h3>
    <div class="sub" style="margin-bottom:8px">Which message gets answered, and by whom. <b>Opt-out %</b> is the cost of the reply rate: a template that wins replies by annoying people shows up here.</div>
    <div class="scroll"><table id="ptpl"><thead><tr><th>Channel</th><th>Template</th><th>Messages</th><th>Pros</th><th>Replies</th><th>Reply %</th><th>Interested</th><th>Interested % of replies</th><th>Opt-outs</th><th>Opt-out % of replies</th><th>Gift-card asks</th><th>Wins</th></tr></thead><tbody></tbody></table></div>
    <h3 class="eng-h">Funnel to Closed Won</h3>
    <div class="eng-tiles" id="pfun"></div>
    <div class="eng-grid">
      <div class="eng-card"><h3>Touches before a win</h3><div class="eng-sub">Messages we had sent a pro by the time it closed</div><div id="ch-ptouch"></div></div>
      <div class="eng-card"><h3>Reply speed</h3><div class="eng-sub">How long after our message the reply came</div><div class="lg"><span><i style="background:var(--s1)"></i>Text</span><span><i style="background:var(--s2)"></i>Email</span></div><div id="ch-pspeed"></div><div class="eng-sub" id="pmed" style="margin-top:6px"></div></div>
    </div>
    <h3 class="eng-h">Best time to send</h3>
    <div class="sub" style="margin-bottom:8px" id="pzn"></div>
    <div class="eng-grid">
      <div class="eng-card"><h3>Text reply rate by send hour</h3><div class="eng-sub">Replies per 100 texts sent in that hour; hours under 25 sends are left blank</div><div id="ch-phour-t"></div></div>
      <div class="eng-card"><h3>Email reply rate by send hour</h3><div class="eng-sub">Replies per 100 emails sent in that hour; hours under 25 sends are left blank</div><div id="ch-phour-e"></div></div>
      <div class="eng-card"><h3>Reply rate by send day</h3><div class="eng-sub">Replies per 100 messages, by weekday</div><div class="lg"><span><i style="background:var(--s1)"></i>Text</span><span><i style="background:var(--s2)"></i>Email</span></div><div id="ch-pdow"></div></div>
    </div>
    <h3 class="eng-h">Who responds</h3>
    <div class="sub" style="margin-bottom:8px">Industries and time zones with at least 15 pros reached.</div>
    <div class="eng-grid">
      <div class="eng-card"><h3>By industry</h3><div class="scroll"><table id="pind"><thead><tr><th>Industry</th><th>Pros</th><th>Replied %</th><th>Interested</th><th>Opt-outs</th><th>Wins</th></tr></thead><tbody></tbody></table></div></div>
      <div class="eng-card"><h3>By time zone</h3><div class="scroll"><table id="pzone"><thead><tr><th>Zone</th><th>Pros</th><th>Replied %</th><th>Interested</th><th>Opt-outs</th><th>Wins</th></tr></thead><tbody></tbody></table></div></div>
    </div>
    <h3 class="eng-h">Interested replies to follow up</h3>
    <div class="sub" style="margin-bottom:8px" id="pcoldn"></div>
    <div class="scroll"><table id="pcold"><thead><tr><th>Replied</th><th>Business</th><th>Via</th><th>They said</th><th>Age</th><th>Messages since</th></tr></thead><tbody></tbody></table></div>
    <div class="eng-note" id="pnote"></div>
  </div>
`;

const CLIENT_JS = `
// ---- 📊 Performance (perfAnalytics.js): template scorecard, funnel, send time, who responds, cold interested replies
const pct = (a,b)=> b ? (Math.round(1000*a/b)/10)+'%' : '—';
function ptable(id, rows){ const body=document.querySelector('#'+id+' tbody'); body.innerHTML=rows.length?rows.map(r=>'<tr>'+r.map(c=>'<td>'+c+'</td>').join('')+'</tr>').join(''):'<tr><td colspan="12" class="muted">Nothing yet.</td></tr>'; }
function renderPerf(){
  const P = PERF, ico = (c)=> c==='email'?'✉️ Email':'💬 Text';
  ptable('ptpl', P.templates.map(t=>[ico(t.ch), escapeHtml(t.name), t.sends.toLocaleString(), t.accounts.toLocaleString(), t.replies, pct(t.replied,t.accounts), t.interested, pct(t.interested,t.replies), t.optout, pct(t.optout,t.replies), t.gift, t.won]));
  const F = P.funnel, fx = (k,l)=>'<div class="stat"><b>'+k+'</b><span>'+l+'</span></div>';
  document.getElementById('pfun').innerHTML = [['all','All'],['text','💬 Text'],['email','✉️ Email']].map(([c,l])=>fx(F[c].touched.toLocaleString()+' → '+F[c].replied+' → '+F[c].interested+' → '+F[c].won, l+': pros reached → replied → interested → won')).join('')
    + fx(F.all.wonReplied+' of '+F.all.won, 'wins that had a logged reply')+fx(F.wonUntouched,'wins with no message from us before they closed');
  hbars(document.getElementById('ch-ptouch'), ['0','1','2','3','4+'].map((l,i)=>({label:l+(l==='1'?' message':' messages'), value:P.touchHist[i], color:'var(--s1)', text:String(P.touchHist[i])})));
  colChart(document.getElementById('ch-pspeed'), P.speed.buckets.map(b=>({short:b.replace(' hours','h').replace(' hour','h').replace(' days','d'), full:b})), [{name:'Text', color:'var(--s1)', vals:P.speed.text},{name:'Email', color:'var(--s2)', vals:P.speed.email}], {label:'Reply speed', maxLabels:6});
  document.getElementById('pmed').textContent = 'Median: '+(P.speed.median.text==null?'—':P.speed.median.text+' h')+' for texts, '+(P.speed.median.email==null?'—':P.speed.median.email+' h')+' for emails.';
  document.getElementById('pzn').textContent = 'Hours are the pro\\'s own local time where we know the zone ('+P.zoneKnownPct+'% of sends); otherwise Eastern.';
  const hl = Array.from({length:24},(_,h)=>({short:(h%12||12)+(h<12?'a':'p'), full:(h%12||12)+(h<12?' AM':' PM')}));
  const rate = (x,i,min)=> x.s[i]>=min ? Math.round(1000*x.r[i]/x.s[i])/10 : 0;
  colChart(document.getElementById('ch-phour-t'), hl, [{name:'Replies per 100 texts', color:'var(--s1)', vals:hl.map((_,h)=>rate(P.hour.text,h,25))}], {label:'Text reply rate by hour', maxLabels:8});
  colChart(document.getElementById('ch-phour-e'), hl, [{name:'Replies per 100 emails', color:'var(--s2)', vals:hl.map((_,h)=>rate(P.hour.email,h,25))}], {label:'Email reply rate by hour', maxLabels:8});
  const dl = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=>({short:d, full:d}));
  colChart(document.getElementById('ch-pdow'), dl, [{name:'Text', color:'var(--s1)', vals:dl.map((_,d)=>rate(P.dow.text,d,25))},{name:'Email', color:'var(--s2)', vals:dl.map((_,d)=>rate(P.dow.email,d,25))}], {label:'Reply rate by weekday'});
  const cutRows = (list)=> list.filter(g=>g.touched>=15).map(g=>[escapeHtml(g.label), g.touched.toLocaleString(), pct(g.replied,g.touched), g.interested, g.optout, g.won]);
  ptable('pind', cutRows(P.byIndustry)); ptable('pzone', cutRows(P.byZone));
  const open = P.cold.filter(c=>c.after===0);
  document.getElementById('pcoldn').textContent = open.length+' interested repl'+(open.length===1?'y has':'ies have')+' had no message from us since ('+P.cold.length+' interested pros in all, not counting wins or do-not-contact). Unanswered ones first, oldest first.';
  ptable('pcold', P.cold.map(c=>[escapeHtml(fmt(c.at)), escapeHtml(c.name)+(c.url?' <a class="sfl" href="'+escapeHtml(c.url)+'" target="_blank" rel="noopener" title="Open in Salesforce">↗</a>':''), ico(c.ch), '<div class="rep-text">'+escapeHtml(c.reply)+'</div>', c.ageDays+' d', c.after?c.after:'<b>none</b>']));
  document.getElementById('pnote').textContent = P.replyTotal+' replies credited to a message; '+P.unattributed+' could not be matched to an account we messaged and '+P.skipped+' hit-list notes / hand-added rows were left out. '+P.sendTotal.toLocaleString()+' messages in the log.';
}
`;

module.exports = { build, PANE_HTML, CLIENT_JS };
