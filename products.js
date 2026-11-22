'use strict';

/**
 * products — plans pitched on an opportunity (Essentials / Max / Above).
 *
 * WHY: reps save what was pitched so proposals use the right price, and email
 * blasts can target e.g. Essentials-only end-of-year promos without confusing
 * Pros who were pitched Max or Key Accounts.
 *
 * Storage: manual-shark.jsonl rows with type "product" (see manualShark.setLeadProducts).
 * Blast: emailBlast.fromBoard({ product, noHigher: true }) — DNC / banned already out via cadence.members.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'products.json');

function loadCatalog() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const list = Array.isArray(j.products) ? j.products : [];
    return list.filter((p) => p && p.id).map((p) => ({
      id: String(p.id).toLowerCase().trim(),
      name: p.name || p.id,
      tier: Number(p.tier) || 1,
      priceMonthly: p.priceMonthly != null ? Number(p.priceMonthly) : null,
      priceLabel: p.priceLabel || (p.priceMonthly != null ? ('$' + p.priceMonthly + '/mo') : 'custom'),
      promoLabel: p.promoLabel || null,
      summary: p.summary || '',
      proposalBullets: Array.isArray(p.proposalBullets) ? p.proposalBullets : [],
    }));
  } catch (_) {
    return [];
  }
}

function byId() {
  const m = new Map();
  for (const p of loadCatalog()) m.set(p.id, p);
  return m;
}

function normalizeIds(input) {
  const raw = Array.isArray(input)
    ? input
    : String(input == null ? '' : input).split(/[\s,+]+/);
  const catalog = byId();
  const ids = [];
  const unknown = [];
  for (const x of raw) {
    const id = String(x || '').toLowerCase().trim().replace(/^#/, '');
    if (!id) continue;
    if (!catalog.has(id)) { unknown.push(id); continue; }
    if (!ids.includes(id)) ids.push(id);
  }
  if (unknown.length) return { error: `unknown product(s): ${unknown.join(', ')} (known: ${[...catalog.keys()].join(', ')})` };
  if (!ids.length) return { error: 'name at least one product (essentials, max, above)' };
  return { ids };
}

function resolve(ids) {
  const catalog = byId();
  const products = (ids || []).map((id) => catalog.get(String(id).toLowerCase())).filter(Boolean);
  let primary = null;
  let maxTier = 0;
  for (const p of products) {
    if (!primary || p.tier > primary.tier) primary = p;
    if (p.tier > maxTier) maxTier = p.tier;
  }
  return { products, primary, maxTier };
}

/** Fill proposal placeholders from a primary product. */
function proposalTokens(product) {
  if (!product) {
    return {
      product_name: 'Housecall Pro',
      product_price: '',
      product_promo: '',
      product_summary: '',
      product_bullets: '',
    };
  }
  return {
    product_name: product.name,
    product_price: product.priceLabel || '',
    product_promo: product.promoLabel || product.priceLabel || '',
    product_summary: product.summary || '',
    product_bullets: (product.proposalBullets || []).map((b) => '• ' + b).join('\n'),
  };
}

/**
 * Does this lead match a product-filtered blast?
 *   productId  — required product id (e.g. essentials)
 *   noHigher   — if true, exclude anyone whose highest pitched tier is above that product
 *                (Essentials EOY sale → noHigher:true so Max/Above never see it)
 */
function matchesFilter(info, { productId, noHigher = false } = {}) {
  const want = String(productId || '').toLowerCase().trim();
  if (!want) return true;
  const catalog = byId();
  const target = catalog.get(want);
  if (!target) return false;
  const list = Array.isArray(info)
    ? info.map((x) => String(x).toLowerCase())
    : ((info && info.ids) || []).map((x) => String(x).toLowerCase());
  const primaryId = Array.isArray(info) ? null : (info && info.primary) || null;
  const has = list.includes(want) || String(primaryId || '').toLowerCase() === want;
  if (!has) return false;
  if (!noHigher) return true;
  const idsForTier = list.length ? list : (primaryId ? [primaryId] : []);
  const { maxTier } = resolve(idsForTier);
  return maxTier <= target.tier;
}

function matchesLead(lead, opts) {
  const ids = (lead && lead.productIds)
    || ((lead && lead.products) || []).map((p) => (typeof p === 'string' ? p : p.id)).filter(Boolean);
  const primary = lead && (lead.primaryProductId || (lead.primaryProduct && lead.primaryProduct.id) || null);
  return matchesFilter({ ids: ids || [], primary }, opts);
}

module.exports = {
  FILE,
  loadCatalog,
  byId,
  normalizeIds,
  resolve,
  proposalTokens,
  matchesFilter,
  matchesLead,
};

if (require.main === module) {
  for (const p of loadCatalog()) {
    console.log(`  ${p.id.padEnd(12)} tier ${p.tier}  ${p.priceLabel.padEnd(12)}  ${p.name}`);
  }
}
