'use strict';

/**
 * industry — a GUESS at a pro's trade from the words in their business name. No lookups, no AI: plain rules, first match wins, so the specific
 * rules come first ("pool cleaning" is a pool company, "window cleaning" is not a house cleaner, "garage door" is not a door shop).
 *
 *   guess("Precision Roofing LLC") → { industry: 'Roofing & gutters', why: 'roofing', weak: false }
 *   guess("Dorsett Does It")       → null        (nothing in the name says what they do)
 *
 * `weak: true` marks a guess made from a generic word (repair, maintenance, construction, wash…): it is usually right, but the dashboard shows it
 * muted so it reads as less sure. `why` is the word that matched (shown as a tooltip).
 */

// [label, regex, weak?]  — the regex runs on the lower-cased name with punctuation turned into spaces (see norm()).
const RULES = [
  // ── specific combinations first (they contain words that a later, more general rule would otherwise take) ──
  ['Foundation & waterproofing', /waterproof|foundation|basement|crawl ?space|mudjack|underpinning|french drain/],
  ['Window cleaning', /\bwindows?\b.*clean|\bwindows?\b.*\bwash|\bwindow (clean|wash)\w*|\bglass clean/],
  ['Carpet & upholstery cleaning', /carpet\b.*clean|clean.*\bcarpet|carpet ?(care|steam)\w*|upholster\w*|\brug (clean|care)\w*|steam clean\w*|\bgrout\b|stanley steemer|chem ?dry|zerorez/],
  ['Locksmith', /locksmith|lock smith|autolock\w*|\bcar ?unlock\w*|\block(s)? (and|n) (key|safe)|\b(auto|automotive|car|vehicle) keys?\b|\bkeys? (and|n) (lock|remote)/],
  ['Auto services', /\bdetail(ing|er|ers)?\b|\btint(ing|s)?\b|\bdentguys\b|\bdent (repair|removal)\b|\bpdr\b|\bdeatil\w*|\bcar ?wash\b|\bauto ?wash\b|\bauto(motive|mobile|body|glass)?\b|\boil change\w*|\bquick lube\b|\bbrakes?\b|\bsmog\b|\bmechanic\b|\bmechanics\b|\btires?\b|\btow(ing)?\b|\bcollision\b|\bwindshield\b|\broadside\b|\bpaintless\b|\bwindow tint\w*|\bcar (care|audio|repair)\b|\btruck (repair|accessor\w*)\b|\bmotors?\b|\bbody shop\b|\bwraps?\b/],
  ['Pressure washing', /pressure ?(wash|clean)\w*|power ?(wash|clean)\w*|soft ?wash\w*|\bhydro ?(wash|jet|clean)\w*/],
  ['Pool & spa', /\bpools?\b|hot ?tubs?|\bswim\w*|\bspas? (and|&) pools?|\bpool\w+/],
  ['Tree service', /\btrees?\b|\btreez\b|tree ?(care|service|removal|trimming|experts?)|\barborist\w*|\bstump\w*|\btimber\b|\blogging\b/],
  ['Pest control', /\bpests?\b|\bexterminador\w*|\bplagas\b|\bfumig\w*|exterminat\w*|\btermite\w*|\brodent\w*|\bmosquito\w*|\bbed ?bugs?\b|\bwildlife\b|\bcritters?\b|\bbug (control|out|busters?)\b|\borkin\b|\bterminix\b|\btruly nolen\b/],
  ['Junk removal & hauling', /\bjunk\w*|\bdumpsters?\b|\bdebris\b|\btrash\b|\brubbish\b|\bgarbage\b|\bclean ?outs?\b|\bdemolition\b|\bdemo (and|&) (haul|removal)/],
  ['Moving', /\bmov(ers?|ing)\b|[a-z]movers\b|\brelocat\w*|\bmudanzas?\b/],
  ['Junk removal & hauling', /\bhaul(ing|ers?|away)?\b/],
  ['Chimney & fireplace', /\bchimney\w*|\bfireplace\w*|\bhearth\b|\bflue\b/],
  ['Flooring', /\bfloor(s|ing)?\b|\bhardwood\b|\blaminate\b|\bepoxy\b|\btile\b|\btiles\b|\btiling\b|\bvinyl plank|\bcarpet(s)?\b|\brefinish\w* floors?/],
  ['Garage doors', /garage ?doors?|overhead doors?|\bgarage\b|\bgate (openers?|repair)/],
  ['Windows & doors', /\bwindows?\b|\bdoors\b|\band doors?\b|\bdoor (and|install\w*|repair|replacement|co|company|center|shop|depot|pros?|works)\b|\bglass\b|\bscreens?\b|\brescree\w*|\bshutters?\b|\bblinds?\b/],

  // ── the main trades ──
  ['HVAC', /\bhvac\b|\bheating\b|\bcooling\b|air ?condition\w*|\bac (repair|service|install\w*)\b|\bam ac\b|\bfurnaces?\b|heat ?pumps?|refrigerat\w*|\bduct(s|work)?\b|\bclimate (control|care|pros?|solutions?)\b|\bair (care|comfort|pros?|experts?|solutions?|systems?|quality|tech|works|mechanical|conditioning|flow|service|services)\b|\bfresh air\b|\bcomfort (air|systems?|heating|cooling|solutions?)\b|\bmini ?splits?\b|\bboilers?\b|\bthermostats?\b|\baire serv\b|\bservice experts\b|\bbenjamin franklin\b.*\bair\b/],
  ['HVAC', /\bmechanical(s)?\b|\bheat\b|\bair\b/, true],
  ['Plumbing', /plumb\w*|\bdrains?\b|\bdraining\b|\bsewer\w*|\brooter\b|\bseptic\b|\bwater heaters?\b|\bpipes?\b|\bpiping\b|\bleak (detection|repair)\b|\bhydro ?jetting\b|\btrenchless\b|\bfaucets?\b|\bsump\b|\bwater (softener|treatment|filtration|wells?|systems?)\b|\bmr rooter\b/],
  ['Plumbing', /\bsinks?\b|\bclear ?flow\b/, true],
  ['Electrical', /\belectric(al|ian|ians|s)?\b|\bwiring\b|\bev charg\w*|\bvoltage\b|\bgenerators?\b|\bstandby\b|\belectricista\b|\bmister sparky\b|\bmr electric\b/],
  ['Roofing & gutters', /\broof\w*|\bshingles?\b|\bgutters?\b|\bsoffit\w*|\bfascia\b|\bsiding\b|\btechos\b/],
  ['Roofing & gutters', /\bexteriors?\b/, true],
  ['Solar & insulation', /\bsolar\b|\binsulat\w*|\bspray foam\b|\bfoam\b|\bphotovoltaic\b|\benergy (efficien\w*|savers?|solutions?|audit\w*)\b/],
  ['Business services', /\bconsult\w*|\baccounting\b|\binsurance\b|\bstaffing\b|\blaw (firm|offices?)\b|\battorney\b|\bbookkeeping\b|\bfinancial\b/],
  ['Solar & insulation', /\benergy\b/, true],
  ['Painting', /paint\w*|\bpainters?\b|\bpintura\w*|\bcoatings?\b|\bdrywall\b|\bplaster\w*|\bstucco\b/],
  ['Painting', /\bfinish(es|ing|ers)?\b/, true],
  ['Concrete & masonry', /\bconcrete\b|\bmasonry\b|\bbrick\w*|\bpav(ing|ers?|ement)\b|\basphalt\b|\bseal ?coat\w*|\bdriveways?\b|\bhardscap\w*|\bretaining walls?\b|\bcement\b/],
  ['Concrete & masonry', /\bstone\b|\bpatios?\b/, true],
  ['Excavation & grading', /\bexcavat\w*|\bgrading\b|\bearthwork\b|\bbulldoz\w*|\bbackhoe\b|\bland clearing\b|\bsite ?work\b|\bbobcat\b|\bhauling and grading\b/],
  ['Fence & deck', /\bfenc(e|es|ing)\b|\bdecks?\b|\bdecking\b|\bpergolas?\b|\brailings?\b|\bgazebos?\b/],
  ['Landscaping & lawn', /\boutdoors?\b/, true],
  ['Landscaping & lawn', /lawn\w*|landscap\w*|\bmow(ing|ers?)?\b|\bturf\b|\byards?\b|\bgard(en|ens|ening)\b|\birrigation\b|\bsprinklers?\b|\bgrass\b|\bsnow\b|\bgrounds? (care|keeping|maintenance)\b|\bjardin\w*|\bsod\b|\bmulch\b|\bweed\b|\bhedge\w*|\boutdoor (living|services?|solutions?)\b|\bgreen ?(thumb|scapes?)\b|\btrugreen\b|\bweed man\b/],
  ['Appliance repair', /\bappliances?\b|\bwashers? (and|&) dryers?\b/],
  ['Restoration', /\brestoration\b|\bwater damage\b|\bfire (damage|and water)\b|\bmold\b|\bremediation\b|\bdisaster\b|\bflood\b|\bmitigation\b|\bsmoke damage\b|\bservpro\b|\bservicemaster\b|\bbelfor\b|\bpuroclean\b/],
  ['Security & smart home', /\bsecurity\b|\balarms?\b|\bcameras?\b|\bcctv\b|\bsmart ?home\b|\bsurveillance\b|\bhome automation\b|\baudio ?video\b|\btheat(er|re)\b|\bnetworking\b|\bcabling\b/],
  ['Kitchen & bath', /\bkitchens?\b|\bbath(room|rooms|s)?\b|\bcabinet\w*|\bcountertops?\b|\bgranite\b|\bquartz\b/],
  ['Welding & metal', /\bweld(ing|ers?)?\b|\bfabricat\w*|\bmetal(s|work)?\b|\bsteel\b|\biron\b|\bsheet metal\b|\balumin\w*/],
  ['Inspection', /\binspect(ion|ions|or|ors)\b/],
  ['Cleaning', /clean|\bklean|\bkleen|\bmaids?\b|\bmerry maids?\b|\bmolly maid\b|\bjanitorial\b|\bhouse ?keep\w*|\bsanitiz\w*|\bdisinfect\w*|\blimpieza\b|\bfacilit(y|ies) (services?|maintenance)\b|\blaundry\b/],
  ['Locksmith', /\blocks?\b/, true],
  ['Cleaning', /\bspotless\b|\bpristine\b|\bsparkl\w*|\bshin(e|ing|y)\b|\bsqueaky\b|\bgleam\w*|\bglitz\b|\bsparkle\b|\bcrumb ?busters?\b/, true],
  ['Handyman & repair', /\bhandy ?(man|men|woman|person|guys?|pro|pros|boys?|service)\b|\bhandyman\b|\bhandy\b|\bodd jobs?\b|\bfix(it|er|ers)?\b|\bhome repairs?\b|\bhouse repairs?\b|\bhandi\w*|\bjack of all trades\b|\bman of many hats\b|\b(we )?do(es)? (it )?all\b|\bmr handyman\b/],
  ['Handyman & repair', /\brepairs?\b|\bmaintenance\b|\brestor(e|ing)\b|\btune ?up\b|\bhome help\b|\bhelping hands\b|\binstall(s|ation|ations|ers?)\b|\bassembly\b|\btrades\b/, true],
  ['Remodeling & construction', /remodel\w*|renovat\w*|construct\w*|\bcontruction\b|\bbuilders?\b|\bcontractors?\b|\bcontracting\b|\bcarpent\w*|\bframing\b|\bcustom homes?\b|\bhome improvement\w*|\bimprovements?\b|\bdesign (and|&) build\b|\bgeneral contract\w*|\badditions?\b|\bhome builders?\b|\bconstrucciones?\b|\bcarpinter\w*/],
  ['Remodeling & construction', /\bbuilding\b|\bbuilt\b|\bbuild\b|\bbuilds\b|\bwoodwork\w*|\bwood (craft|work|working|shop)\b|\binteriors?\b/, true],
  ['Property management', /\bproperty (management|managers?)\b|\bproperty (services|care|solutions)\b|\brentals?\b|\breal estate\b|\brealty\b|\brealtors?\b|\bhome watch\b/],
  ['Pet services', /\bdogs?\b|\bpets?\b|\bgroom\w*|\bkennels?\b|\bcanine\b|\bk9\b|\bveterinar\w*/],
  ['Trucking & transport', /\btrucking\b|\bfreight\b|\blogistics\b|\btransport\w*|\bhot ?shot\b|\bdelivery\b|\bcourier\b|\bcargo\b/],
  ['Marine', /\bmarine\b|\bboats?\b|\byachts?\b|\bdock\b|\bdocks\b/],
  ['Photography & media', /\bphotograph\w*|\bvideo\b|\bmedia\b|\bfilm\b|\bcreative\b|\bmarketing\b|\bdesign studio\b|\bweb(site)? design\b/],
];

const COMPILED = RULES.map(([label, re, weak]) => ({ label, re, weak: !!weak }));

/** Lower-case, & → and, apostrophes dropped, anything else that is not a letter or digit becomes a space. */
function norm(name) {
  return ' ' + String(name == null ? '' : name).toLowerCase()
    .replace(/\ba\/c\b/g, ' air conditioning ')
    .replace(/&|\+/g, ' and ')
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9À-ɏ]+/g, ' ')
    .replace(/\s+/g, ' ').trim() + ' ';
}

/** → { industry, why, weak } | null */
function guess(name) {
  const n = norm(name);
  if (n.trim().length < 3) return null;
  for (const pass of [false, true]) {                 // every specific rule first; the generic-word (weak) rules only when none of them fits
    for (const r of COMPILED) {
      if (r.weak !== pass) continue;
      const m = n.match(r.re);
      if (m) return { industry: r.label, why: m[0].trim(), weak: r.weak };
    }
  }
  return null;
}

/** The labels in the order a dropdown should list them (rule order, each once). */
const INDUSTRIES = [...new Set(RULES.map((r) => r[0]))];

module.exports = { guess, norm, INDUSTRIES, RULES };
