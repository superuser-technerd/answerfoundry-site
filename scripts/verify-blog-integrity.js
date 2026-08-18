#!/usr/bin/env node
/**
 * Blog integrity check — runs on every Netlify build.
 *
 * Fails the build (non-zero exit) if any post file in blog/*.html is not
 * linked from ALL of: blog/index.html cards, blog/index.html JSON-LD
 * blogPost[], blog/index.html JSON-LD ItemList, and sitemap.xml.
 *
 * Why this exists: on 2026-08-15/16/17 an automated daily-post run
 * overwrote blog/index.html and sitemap.xml instead of adding to them,
 * silently orphaning 3 published posts for days (the files stayed live,
 * they just had no link pointing at them anywhere). The build still
 * "succeeded" because nothing checked whether the link graph was intact.
 * This script is that check. If it ever fails, do NOT patch around it —
 * fix index.html / sitemap.xml so every post is linked, then re-deploy.
 */
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const blogDir = path.join(repoRoot, 'blog');
const indexPath = path.join(blogDir, 'index.html');
const sitemapPath = path.join(repoRoot, 'sitemap.xml');

function fail(msg) {
  console.error('\n\u274c BLOG INTEGRITY CHECK FAILED\n\n' + msg + '\n');
  process.exit(1);
}

const files = fs.readdirSync(blogDir)
  .filter(f => f.endsWith('.html') && f !== 'index.html')
  .map(f => f.replace(/\.html$/, ''))
  .sort();

const indexHtml = fs.readFileSync(indexPath, 'utf8');
const sitemapXml = fs.readFileSync(sitemapPath, 'utf8');

const cardSlugs = [...indexHtml.matchAll(/<a class='readmore' href='\/blog\/([a-z0-9\-]+)'/g)]
  .map(m => m[1]).sort();

const blogPostSlugs = [...indexHtml.matchAll(/"url":\s*"https:\/\/answerfoundry\.ai\/blog\/([a-z0-9\-]+)\.html",\s*\n?"datePublished"/g)]
  .map(m => m[1]).sort();

const typeIdx = indexHtml.indexOf('"@type": "ItemList"');
let itemListSlugs = [];
if (typeIdx !== -1) {
  const ilStart = indexHtml.indexOf('"itemListElement": [', typeIdx) + '"itemListElement": ['.length;
  const ilEnd = indexHtml.indexOf(']', ilStart);
  const ilBlock = indexHtml.slice(ilStart, ilEnd);
  itemListSlugs = [...ilBlock.matchAll(/blog\/([a-z0-9\-]+)\.html/g)].map(m => m[1]).sort();
}

const sitemapSlugs = [...sitemapXml.matchAll(/<loc>https:\/\/answerfoundry\.ai\/blog\/([a-z0-9\-]+)\.html<\/loc>/g)]
  .map(m => m[1]).sort();

const sets = {
  'blog/index.html cards': cardSlugs,
  'blog/index.html JSON-LD blogPost[]': blogPostSlugs,
  'blog/index.html JSON-LD ItemList': itemListSlugs,
  'sitemap.xml': sitemapSlugs,
};

const fileSet = new Set(files);
const problems = [];

for (const [label, slugs] of Object.entries(sets)) {
  const slugSet = new Set(slugs);
  const missing = files.filter(f => !slugSet.has(f));
  const extra = slugs.filter(s => !fileSet.has(s));
  if (missing.length) problems.push(label + ' is missing: ' + missing.join(', '));
  if (extra.length) problems.push(label + ' references files that do not exist in blog/: ' + extra.join(', '));
}

if (problems.length) {
  fail(
    problems.map(p => '  - ' + p).join('\n') +
    '\n\nEvery .html file in blog/ must be linked from blog/index.html (card + JSON-LD blogPost[] + JSON-LD ItemList) and sitemap.xml.\n' +
    'This most commonly happens when an edit REPLACES index.html/sitemap.xml content instead of ADDING to it.\n' +
    'Fix the file(s) named above so every post is linked, then re-deploy. Do not disable this check to work around it.'
  );
}

console.log('\u2705 Blog integrity check passed: ' + files.length + ' posts, all linked from index.html and sitemap.xml.');
