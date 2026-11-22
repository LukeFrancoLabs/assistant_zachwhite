'use strict';

/**
 * demoMode — rich mock Pipeline Assistant data for director demos (`zwdemo`).
 * Never writes real logs. Never sends. Fake Salesforce-looking ids only.
 */

const path = require('path');

const DEMO_PORT = Math.max(1, Number(process.env.ASSISTANT_DEMO_PORT) || 9341);

function isDemo(argv = process.argv) {
  if (process.env.ZW_DEMO === '1' || process.env.ZW_DEMO === 'true') return true;
  return argv.some((a) => a === '--demo' || a === 'zwdemo');
}

function hoursAgo(h) {
  return new Date(Date.now() - h * 3600e3).toISOString();
}
function daysAgo(d) {
  return new Date(Date.now() - d * 864e5).toISOString();
}
function minutesAgo(m) {
  return new Date(Date.now() - m * 60e3).toISOString();
}
function daysFromNow(d) {
  return new Date(Date.now() + d * 864e5).toISOString();
}

function sfUrl(id) {
  return 'https://housecallpro.lightning.force.com/lightning/r/Account/' + id + '/view';
}

/** Fake 18-char Account ids (not real Salesforce records). */
const IDS = {
  peakAir: '001DEMO000000PA1AAA',
  coolRight: '001DEMO000000CR2BBB',
  northStar: '001DEMO000000NS3CCC',
  lakeHVAC: '001DEMO000000LH4DDD',
  metroPlumb: '001DEMO000000MP5EEE',
  sparkElec: '001DEMO000000SE6FFF',
  valleyHeat: '001DEMO000000VH7GGG',
  blueFlame: '001DEMO000000BF8HHH',
  summitAC: '001DEMO000000SA9III',
  harborMech: '001DEMO000000HM0JJJ',
  ironPipe: '001DEMO000000IP1KKK',
  greenTherm: '001DEMO000000GT2LLL',
  sparkleClean: '001DEMO000000SC3MMM',
  brightWash: '001DEMO000000BW4NNN',
};

function lead(name, id, extra = {}) {
  return {
    name,
    accountId: id,
    url: sfUrl(id),
    ...extra,
  };
}

function kitPayload() {
  try {
    return require('./dayDesk').kitPayload();
  } catch (_) {
    return [
      { id: 'day-after-demo', kind: 'email', key: 'day-after-demo', label: 'Day-after-demo email', hint: 'Send after a demo while it’s fresh', subject: 'Great chatting yesterday', preview: 'Thanks for the walkthrough…', command: 'zw --email --email-template day-after-demo --range 1-1' },
      { id: 'book-demo', kind: 'text', template: '9', label: 'Book a demo text', hint: 'Short booking-link text', preview: 'Hey {First} — here’s a link to grab time…', command: 'zw --text --template 9 --range 1-1' },
    ];
  }
}

function morning() {
  return [
    {
      kind: 'hold',
      priority: 1,
      title: 'Pro replied — held',
      ...lead('Peak Air Comfort', IDS.peakAir),
      at: minutesAgo(42),
      detail: 'Text reply while email was drafting — held so you can answer first.',
      status: 'new',
      action: 'Open in Salesforce · clear the hold, then follow up',
    },
    {
      kind: 'hold',
      priority: 1,
      title: 'Teammate texted — held',
      ...lead('CoolRight Services', IDS.coolRight),
      at: hoursAgo(3),
      detail: 'Another AE already texted this morning — board skipped the auto send.',
      status: 'new',
      action: 'Check Salesforce activity · decide who owns the thread',
    },
    {
      kind: 'interested',
      priority: 2,
      title: 'Interested reply — needs a follow-up',
      ...lead('North Star Heating', IDS.northStar),
      at: hoursAgo(5),
      detail: 'Yeah we could use help with online booking before summer — can you send times?',
      ageDays: 0.2,
      channel: 'text',
      action: 'Open in Salesforce · send a check-in from Quick kit',
    },
    {
      kind: 'interested',
      priority: 2,
      title: 'Interested reply — needs a follow-up',
      ...lead('Blue Flame Mechanical', IDS.blueFlame),
      at: daysAgo(1),
      detail: 'Interesting — we just hired two techs. Curious how Pipeline fits with ServiceTitan.',
      ageDays: 1.1,
      channel: 'email',
      action: 'Open in Salesforce · day-after / curiosity from Quick kit',
    },
    {
      kind: 'reengage',
      priority: 2,
      title: 'Re-engage list',
      ...lead('Valley Heat & Air', IDS.valleyHeat),
      at: daysAgo(2),
      detail: 'Nurture expired (reconnect was this week) — ready for a fresh push',
      stage: null,
      action: 'zw --email --email-template research-reengage',
    },
    {
      kind: 'board',
      priority: 3,
      title: 'Due: Day 3 · Text booking',
      ...lead('Lake Country HVAC', IDS.lakeHVAC),
      at: hoursAgo(1),
      detail: 'Text stage ready — HVAC drip',
      stage: 'hvac3',
      action: 'zw --text  (or email --board for the automatic stage)',
    },
    {
      kind: 'board',
      priority: 3,
      title: 'Due: Day 1 · Email opener',
      ...lead('Summit AC Pros', IDS.summitAC),
      at: hoursAgo(2),
      detail: 'Email stage ready — HVAC drip',
      stage: 'hvac2',
      action: 'zw --email --from-hand --range 1-1',
    },
    {
      kind: 'board',
      priority: 3,
      title: 'Due: Day-after-demo email',
      ...lead('Harbor Mechanical', IDS.harborMech),
      at: hoursAgo(4),
      detail: 'Email stage ready — post-demo board',
      stage: 'demo1',
      action: 'zw --email --email-template day-after-demo --range 1-1',
    },
  ];
}

function replies() {
  return [
    { at: hoursAgo(5), ...lead('North Star Heating', IDS.northStar), ch: 'text', reply: 'Yeah we could use help with online booking before summer — can you send times?', interested: true, optout: false, gift: false },
    { at: daysAgo(1), ...lead('Blue Flame Mechanical', IDS.blueFlame), ch: 'email', reply: 'Interesting — we just hired two techs. Curious how Pipeline fits with ServiceTitan.', interested: true, optout: false, gift: false },
    { at: daysAgo(1.5), ...lead('Metro Plumbing Co', IDS.metroPlumb), ch: 'text', reply: 'Not right now — check back after tax season.', interested: false, optout: false, gift: false },
    { at: daysAgo(2), ...lead('Spark Electric LLC', IDS.sparkElec), ch: 'email', reply: 'Please remove me from this list.', interested: false, optout: true, gift: false },
    { at: daysAgo(3), ...lead('Iron Pipe Pros', IDS.ironPipe), ch: 'text', reply: 'Got it thanks — owner is out until Thursday.', interested: false, optout: false, gift: false },
    { at: daysAgo(4), ...lead('Green Therm Comfort', IDS.greenTherm), ch: 'email', reply: 'Can you send the financing one-pager again?', interested: true, optout: false, gift: false },
    { at: daysAgo(5), ...lead('Peak Air Comfort', IDS.peakAir), ch: 'text', reply: 'We already looked at this last year.', interested: false, optout: false, gift: false },
    { at: daysAgo(6), ...lead('CoolRight Services', IDS.coolRight), ch: 'text', reply: 'Sure send the booking link.', interested: true, optout: false, gift: false },
  ];
}

function myLeads() {
  const summer = daysFromNow(190);
  return [
    {
      ...lead('Lake Country HVAC', IDS.lakeHVAC),
      tags: ['hvac', 'demo'],
      state: 'due',
      next: 'Day 3 · Text booking',
      dueNow: true,
      hold: null,
      lastAt: daysAgo(3),
      enrolledAt: daysAgo(3),
      board: 'drip-hvac',
      boardName: 'HVAC board (2 weeks)',
      onNurture: false,
      onReengage: false,
      expiresAt: null,
      expiresInDays: null,
      reconnectAt: null,
      reconnectLabel: null,
      spanDays: null,
      inRamp: false,
      nurtureCommand: 'node textLog.js --nurture-lead ' + IDS.lakeHVAC + ' --until summer',
      addCommand: null,
    },
    {
      ...lead('Summit AC Pros', IDS.summitAC),
      tags: ['hvac'],
      state: 'due',
      next: 'Day 1 · Email opener',
      dueNow: true,
      hold: null,
      lastAt: daysAgo(1),
      enrolledAt: daysAgo(1),
      board: 'drip-hvac',
      boardName: 'HVAC board (2 weeks)',
      onNurture: false,
      onReengage: false,
      expiresAt: null,
      expiresInDays: null,
      reconnectAt: null,
      reconnectLabel: null,
      spanDays: null,
      inRamp: false,
      nurtureCommand: 'node textLog.js --nurture-lead ' + IDS.summitAC + ' --until summer',
      addCommand: null,
    },
    {
      ...lead('Harbor Mechanical', IDS.harborMech),
      tags: ['referral', 'demo'],
      state: 'due',
      next: 'Day-after-demo email',
      dueNow: true,
      hold: null,
      lastAt: hoursAgo(20),
      enrolledAt: hoursAgo(20),
      board: 'post-demo',
      boardName: 'Post-demo follow-up',
      onNurture: false,
      onReengage: false,
      expiresAt: null,
      expiresInDays: null,
      reconnectAt: null,
      reconnectLabel: null,
      spanDays: null,
      inRamp: false,
      nurtureCommand: 'node textLog.js --nurture-lead ' + IDS.harborMech + ' --until summer',
      addCommand: null,
    },
    {
      ...lead('Green Therm Comfort', IDS.greenTherm),
      tags: ['nurture', 'hvac'],
      state: 'waiting',
      next: 'Quiet touch (nurture)',
      dueNow: false,
      hold: null,
      lastAt: daysAgo(12),
      enrolledAt: daysAgo(40),
      board: 'nurture',
      boardName: 'Nurture (slow drip)',
      onNurture: true,
      onReengage: false,
      expiresAt: summer,
      expiresInDays: 190,
      reconnectAt: summer,
      reconnectLabel: 'summer',
      spanDays: 191,
      inRamp: false,
      nurtureCommand: 'node textLog.js --nurture-lead ' + IDS.greenTherm + ' --until summer',
      addCommand: null,
    },
    {
      ...lead('Valley Heat & Air', IDS.valleyHeat),
      tags: ['reengage'],
      state: 'reengage',
      next: 'Re-engage push',
      dueNow: true,
      hold: null,
      lastAt: daysAgo(90),
      enrolledAt: daysAgo(100),
      board: null,
      boardName: null,
      onNurture: false,
      onReengage: true,
      expiresAt: null,
      expiresInDays: null,
      reconnectAt: null,
      reconnectLabel: null,
      spanDays: null,
      inRamp: false,
      nurtureCommand: 'node textLog.js --nurture-lead ' + IDS.valleyHeat + ' --until summer',
      addCommand: null,
    },
    {
      ...lead('Metro Plumbing Co', IDS.metroPlumb),
      tags: ['plumbing'],
      state: 'waiting',
      next: 'Day 5 · Email paid on-site',
      dueNow: false,
      hold: null,
      lastAt: daysAgo(2),
      enrolledAt: daysAgo(5),
      board: 'drip-plumbing',
      boardName: 'Plumbing board (2 weeks)',
      onNurture: false,
      onReengage: false,
      expiresAt: null,
      expiresInDays: null,
      reconnectAt: null,
      reconnectLabel: null,
      spanDays: null,
      inRamp: false,
      nurtureCommand: 'node textLog.js --nurture-lead ' + IDS.metroPlumb + ' --until summer',
      addCommand: null,
    },
    {
      ...lead('Sparkle Interior Clean', IDS.sparkleClean),
      tags: ['cleaning'],
      state: 'due',
      next: 'Day 3 · Text booking',
      dueNow: true,
      hold: null,
      lastAt: daysAgo(3),
      enrolledAt: daysAgo(3),
      board: 'drip-cleaning',
      boardName: 'Interior cleaning board (2 weeks)',
      onNurture: false,
      onReengage: false,
      expiresAt: null,
      expiresInDays: null,
      reconnectAt: null,
      reconnectLabel: null,
      spanDays: null,
      inRamp: false,
      nurtureCommand: 'node textLog.js --nurture-lead ' + IDS.sparkleClean + ' --until summer',
      addCommand: null,
    },
    {
      ...lead('Bright Side Pressure Wash', IDS.brightWash),
      tags: ['pressure-washing'],
      state: 'waiting',
      next: 'Day 1 · Email opener',
      dueNow: false,
      hold: null,
      lastAt: hoursAgo(18),
      enrolledAt: hoursAgo(18),
      board: 'drip-pressure-washing',
      boardName: 'Pressure washing board (2 weeks)',
      onNurture: false,
      onReengage: false,
      expiresAt: null,
      expiresInDays: null,
      reconnectAt: null,
      reconnectLabel: null,
      spanDays: null,
      inRamp: false,
      nurtureCommand: 'node textLog.js --nurture-lead ' + IDS.brightWash + ' --until summer',
      addCommand: null,
    },
  ];
}

function todaySends() {
  const rows = [
    { at: minutesAgo(12), ...lead('Summit AC Pros', IDS.summitAC), channel: 'email', template: 'HVAC drip · opener', subject: 'Missed calls before the heat hits', preview: 'Hey Mike — shops like yours lose after-hours AC calls…' },
    { at: minutesAgo(28), ...lead('Lake Country HVAC', IDS.lakeHVAC), channel: 'text', template: 'HVAC · booking', subject: null, preview: 'Hey Dana — quick link to book a 15-min walkthrough of online booking…' },
    { at: hoursAgo(1.2), ...lead('Harbor Mechanical', IDS.harborMech), channel: 'email', template: 'Day-after-demo', subject: 'Great chatting yesterday', preview: 'Thanks for walking me through your dispatch board…' },
    { at: hoursAgo(2), ...lead('Blue Flame Mechanical', IDS.blueFlame), channel: 'text', template: 'Respectful follow-up', subject: null, preview: 'Circling back — still a good time to look at Pipeline before summer?' },
    { at: hoursAgo(3.5), ...lead('North Star Heating', IDS.northStar), channel: 'text', template: 'HVAC · intro', subject: null, preview: 'Hey Sam — peak season’s coming. Mind if I send how HVAC shops keep booking…' },
    { at: hoursAgo(5), ...lead('CoolRight Services', IDS.coolRight), channel: 'email', template: 'Curiosity', subject: 'One idea for CoolRight’s booking queue', preview: 'Noticed a few shops routing after-hours calls into Pipeline…' },
    { at: hoursAgo(6), ...lead('Iron Pipe Pros', IDS.ironPipe), channel: 'text', template: 'Book a demo', subject: null, preview: 'Here’s a link whenever you’re free this week…' },
    { at: hoursAgo(7), ...lead('Spark Electric LLC', IDS.sparkElec), channel: 'email', template: 'Why now', subject: 'Before the spring rush', preview: 'Electrical shops that set Pipeline up in March…' },
    { at: hoursAgo(8), ...lead('Green Therm Comfort', IDS.greenTherm), channel: 'email', template: 'Nurture · soft check-in', subject: 'Still thinking summer?', preview: 'No rush — parking this until you’re closer to reconnect…' },
    { at: hoursAgo(9), ...lead('Peak Air Comfort', IDS.peakAir), channel: 'text', template: 'Account idea', subject: null, preview: 'One idea for Peak Air’s missed-call follow-up…' },
    { at: hoursAgo(10), ...lead('Metro Plumbing Co', IDS.metroPlumb), channel: 'email', template: 'Plumbing drip · financing', subject: 'When quotes stall on payment', preview: 'Bigger jobs stall when payment feels hard…' },
    { at: hoursAgo(11), ...lead('Valley Heat & Air', IDS.valleyHeat), channel: 'email', template: 'Research re-engage', subject: 'Ready when you are', preview: 'You asked to reconnect around now — here’s a short refresh…' },
  ];
  let texts = 0, emails = 0;
  for (const r of rows) { if (r.channel === 'email') emails++; else texts++; }
  return { sends: rows.length, texts, emails, rows };
}

function daydesk() {
  const today = todaySends();
  return {
    generatedAt: new Date().toISOString(),
    demo: true,
    morning: morning(),
    replies: replies(),
    kit: kitPayload(),
    myLeads: myLeads(),
    today,
    addLead: {
      hint: 'DEMO — After a call, add the pro here. Not ready until summer? Move to Nurture until then.',
      command: 'node textLog.js --add-lead <Salesforce account link> --tag referral --did email,text,call',
      alt: 'Demo mode — commands are examples only; nothing is written.',
      nurture: 'node textLog.js --nurture-lead <Salesforce account link> --until summer',
    },
    meta: {
      replyFeedReady: true,
      replyHint: null,
      sharedDir: path.join(__dirname, 'team-shared'),
      demo: true,
      demoNote: 'Director demo — mock leads and sends. Nothing is real Salesforce data.',
    },
  };
}

/** Slim rows for Sends tab / data.js (matches outreachDashboard.slim shape). */
function sendRows() {
  const today = todaySends().rows;
  const older = [
    { at: daysAgo(1), ...lead('Blue Flame Mechanical', IDS.blueFlame), channel: 'email', template: 'HVAC drip · financing', subject: 'Payment options that close bigger installs', preview: 'Card / ACH / financing without leaving the job…' },
    { at: daysAgo(1.2), ...lead('Lake Country HVAC', IDS.lakeHVAC), channel: 'text', template: 'HVAC · intro', subject: null, preview: 'Peak season angle — first touch' },
    { at: daysAgo(2), ...lead('Harbor Mechanical', IDS.harborMech), channel: 'email', template: 'Demo invite', subject: '15 minutes on Pipeline', preview: 'Would love to show the booking + Pipeline flow…' },
    { at: daysAgo(2.5), ...lead('North Star Heating', IDS.northStar), channel: 'text', template: 'Curiosity bump', subject: null, preview: 'Quick bump in case my last note got buried…' },
    { at: daysAgo(3), ...lead('Summit AC Pros', IDS.summitAC), channel: 'text', template: 'HVAC · intro', subject: null, preview: 'Missed-call angle for Summit…' },
    { at: daysAgo(4), ...lead('CoolRight Services', IDS.coolRight), channel: 'email', template: 'Day-after-demo', subject: 'Great chatting yesterday', preview: 'Loved seeing the dispatch board…' },
    { at: daysAgo(5), ...lead('Metro Plumbing Co', IDS.metroPlumb), channel: 'text', template: 'Plumbing · booking', subject: null, preview: 'Online booking for after-hours drain calls…' },
    { at: daysAgo(6), ...lead('Spark Electric LLC', IDS.sparkElec), channel: 'email', template: 'Electrical drip · opener', subject: 'Before panel upgrades stack up', preview: 'Electrical shops using Pipeline for quote follow-up…' },
    { at: daysAgo(7), ...lead('Iron Pipe Pros', IDS.ironPipe), channel: 'text', template: 'Respectful', subject: null, preview: 'No rush — happy to reconnect when timing’s better.' },
    { at: daysAgo(8), ...lead('Green Therm Comfort', IDS.greenTherm), channel: 'email', template: 'Nurture quiet', subject: 'Parking this until summer', preview: 'Per your note — quiet until closer to reconnect…' },
    { at: daysAgo(10), ...lead('Valley Heat & Air', IDS.valleyHeat), channel: 'text', template: 'Soft close', subject: null, preview: 'Happy to leave it here unless you want times…' },
    { at: daysAgo(12), ...lead('Peak Air Comfort', IDS.peakAir), channel: 'email', template: 'HVAC · reviews', subject: 'Maintenance plans on autopilot', preview: 'Google reviews + maintenance reminders…' },
  ];
  return today.concat(older).map((r) => ({
    at: r.at,
    channel: r.channel,
    accountId: r.accountId,
    name: r.name,
    url: r.url,
    email: null,
    template: r.template || null,
    subject: r.subject || null,
    text: r.preview || '',
    mode: 'live',
    step: null,
  }));
}

function outreachData() {
  const rows = sendRows();
  let texts = 0, emails = 0;
  const people = new Set();
  for (const r of rows) {
    if (r.channel === 'email') emails++; else texts++;
    people.add(String(r.accountId || r.name).toLowerCase());
  }
  return {
    v: 1,
    demo: true,
    generatedAt: new Date().toISOString(),
    run: {
      startedAt: hoursAgo(11),
      dryRun: false,
      demo: true,
      label: 'Director demo (mock)',
    },
    totals: { sends: rows.length + 48, texts: texts + 28, emails: emails + 20, people: people.size + 14 },
    truncated: true,
    fullLog: false,
    dataLog: { name: 'Demo AE', host: 'zwdemo', sends: rows.length },
    rows,
  };
}

function analytics() {
  return {
    demo: true,
    daily: { sends: 12, texts: 6, emails: 6 },
    weekly: { sends: 47, texts: 26, emails: 21 },
    monthly: { sends: 186, texts: 102, emails: 84 },
    allTime: { sends: 1240, texts: 710, emails: 530 },
    generatedAt: new Date().toISOString(),
  };
}

function dnc() {
  return {
    demo: true,
    count: 3,
    generatedAt: new Date().toISOString(),
    rows: [
      { accountId: IDS.sparkElec, name: 'Spark Electric LLC', reason: 'Opt-out reply', source: 'reply', at: daysAgo(2), url: sfUrl(IDS.sparkElec) },
      { accountId: '001DEMO000000DN1MMM', name: 'DoNotCall Mechanical', reason: 'Asked not to contact', source: 'manual', at: daysAgo(9), url: sfUrl('001DEMO000000DN1MMM') },
      { accountId: '001DEMO000000DN2NNN', name: 'Already Customer HVAC', reason: 'Current customer', source: 'status', at: daysAgo(20), url: sfUrl('001DEMO000000DN2NNN') },
    ],
  };
}

function health(port = DEMO_PORT) {
  return {
    ok: true,
    demo: true,
    port,
    title: 'Pipeline Assistant · DEMO',
    note: 'Mock leads and sends for directors — nothing is written to real logs.',
  };
}

module.exports = {
  isDemo,
  DEMO_PORT,
  daydesk,
  outreachData,
  analytics,
  dnc,
  health,
  IDS,
};

if (require.main === module) {
  const d = daydesk();
  console.log(`\n  zwdemo  morning=${d.morning.length}  replies=${d.replies.length}  myLeads=${d.myLeads.length}  today=${d.today.sends}\n`);
  for (const m of d.morning) console.log(`  • [${m.kind}] ${m.name} — ${m.title}`);
  console.log('');
}
