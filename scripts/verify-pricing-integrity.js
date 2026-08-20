#!/usr/bin/env node
/**
 * Pricing integrity check — runs on every Netlify build.
 *
 * The site intentionally has two temporary introductory prices: the $495
 * Foundry Audit checkout and the $999 Forge founding rate. This check verifies
 * that those are labelled as introductory, while standard prices, contact
 * routing, structured data, and terms remain aligned.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const pricing = read('pricing/index.html');
const home = read('index.html');
const terms = read('terms/index.html');
const contact = read('contact/index.html');
const llms = read('llms.txt');
const privacy = read('privacy/index.html');

const problems = [];
const requireText = (label, source, text) => {
  if (!source.includes(text)) problems.push(`${label} is missing: ${text}`);
};
const forbidText = (label, source, text) => {
  if (source.includes(text)) problems.push(`${label} still contains legacy text: ${text}`);
};

for (const text of ['"price": "795"', '"price": "1500"', '"price": "2500"',
  '$1,500 <span>one time</span>', '$1,250 <span>/month</span>', 'From $2,500 <span>/month</span>']) {
  requireText('pricing/index.html', pricing, text);
}
requireText('pricing/index.html', pricing, 'September 19, 2026 or for the first 10 paid audits');
requireText('pricing/index.html', pricing, '/contact/?reason=fix-sprint');
requireText('pricing/index.html', pricing, '/contact/?reason=forge-monitor');
requireText('pricing/index.html', pricing, '/contact/?reason=category-leader');
forbidText('pricing/index.html', pricing, 'bJeaEWblg9Ok7or8xlfjG01');
forbidText('pricing/index.html', pricing, '7sY5kC1KGgcIbEHaFtfjG02');
forbidText('pricing/index.html', pricing, 'FOUNDING5');
forbidText('pricing/index.html', pricing, '$1,999');
forbidText('pricing/index.html', pricing, '$799');

for (const [label, source] of [['index.html', home], ['terms/index.html', terms],
  ['contact/index.html', contact], ['llms.txt', llms]]) {
  requireText(label, source, '$1,250');
}
requireText('index.html', home, '$2,500');
requireText('terms/index.html', terms, 'No retroactive discount adjustment');
requireText('contact/index.html', contact, 'Fix Sprint ($1,500 one-time)');
requireText('llms.txt', llms, '**Fix Sprint** — $1,500 one-time');
requireText('privacy/index.html', privacy, '<td>Stripe, Inc.</td>');
requireText('privacy/index.html', privacy, 'AnswerFoundry does not receive or store complete card numbers');

if (problems.length) {
  console.error('\n❌ PRICING INTEGRITY CHECK FAILED\n\n' +
    problems.map(p => `  - ${p}`).join('\n') +
    '\n\nKeep standard prices, launch labels, checkout routing, terms, and machine-readable pricing aligned.\n');
  process.exit(1);
}

console.log('✅ Pricing integrity check passed: public pricing, routing, terms, and structured data are aligned.');
