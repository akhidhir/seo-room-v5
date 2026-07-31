# SearchFit prompt texts

Prompt texts extracted from the searchfit-seo plugin's skill files, adapted for pasting into the Claude Audit prompt box (or later, loading into the prompt library).

## Coverage

| Skill file | What it audits | Areas covered |
|---|---|---|
| `ai-visibility.md` | How the brand appears in AI-generated answers (ChatGPT, Claude, Gemini, Perplexity) — presence, accuracy, sentiment, position, consistency; scored 0-100; content/technical/authority signal fixes | GEO/AI Search (primary); Competitor Pages (partial — competitor visibility comparison); Strategic Planning (partial — action plan) |
| `broken-links.md` | Internal, external and backlink 404s; status codes; redirect chains 3+ hops; link references in templates/code | Technical SEO (partial); Full Site Audit (partial) |
| `content-brief.md` | Produces a writer-ready brief: keyword/intent, title options, meta, full H1-H3 outline, keyword usage table, internal/external links, images, schema type, differentiation | E-E-A-T Content (primary); Single Page Analysis (partial); Strategic Planning (partial) |
| `content-strategy.md` | Topical authority map (pillar/cluster/supporting), content gap analysis, intent mapping, priority matrix, 12-week calendar, internal linking plan, KPIs | Strategic Planning (primary); E-E-A-T Content; Competitor Pages (partial — gap analysis) |
| `content-translation.md` | Translation vs localization, per-market keyword research, URL strategy (subdir/subdomain/ccTLD), hreflang rules, lang attribute, per-language canonicals, 11-point QA checklist | Hreflang/i18n (primary); E-E-A-T Content (partial) |
| `internal-linking.md` | Orphan pages, dead ends, over-linked pages (100+), shallow pages (4+ clicks), weak anchor text, one-way links; hub-and-spoke and cluster models; link priority guidelines | Full Site Audit (primary — site architecture); Technical SEO (partial) |
| `keyword-clustering.md` | Cleans/dedupes keyword lists, clusters by intent + SERP overlap, one-cluster-one-page rule (3-15 keywords), maps clusters to pages, funnel and modifier patterns, content roadmap | Strategic Planning (primary) |
| `on-page-seo.md` | Single page: title, meta description, slug, heading structure, content quality/LSI, images/alt, internal links, schema; before/after rewrites | Single Page Analysis (primary); E-E-A-T Content; Image Optimization (partial); Schema Markup (partial) |
| `schema-markup.md` | JSON-LD generation for Organization, Article/BlogPosting, Product, FAQPage, HowTo, BreadcrumbList, LocalBusiness, SoftwareApplication, VideoObject, Review; validation rules; never fabricate data | Schema Markup (primary); Local SEO (name-only — LocalBusiness listed with no guidance) |
| `seo-audit.md` | 8-part site audit: crawlability/indexation, meta tags & head, headings, images, performance signals, structured data, internal linking, mobile & accessibility; scored 0-100 with Critical/Warning/Opportunity buckets | Full Site Audit (primary); Technical SEO; Schema Markup; Image Optimization; Sitemap |
| `technical-seo.md` | 8-part technical audit: robots.txt, XML sitemap, crawl directives, status codes/duplicates, Core Web Vitals + performance, mobile, security/HTTPS, structured data, hreflang, URL structure; per-section scores | Technical SEO (primary); Sitemap; Hreflang/i18n (partial); Schema Markup (partial) |

## Gaps

Of the 14 areas, these have **no** skill covering them:

- **Local SEO** — nothing beyond `LocalBusiness` appearing in the schema type list. No NAP, GBP, citations, service-area or suburb guidance.
- **Maps Intelligence** — no coverage at all. No grid scanning, local pack, map rankings or proximity analysis.
- **Competitor Pages** — no dedicated skill. Competitors appear only as inputs inside `ai-visibility.md` and `content-strategy.md`; there is no competitor page teardown or comparison audit.
- **Programmatic SEO** — no coverage at all. No templated/bulk page generation, no scaled location or service page patterns.

Partial only (covered as sub-checks, not as a standalone prompt):

- **Image Optimization** — alt text, file names, formats and lazy loading appear as checklist items inside `seo-audit.md`, `technical-seo.md` and `on-page-seo.md`, but there is no dedicated image audit.
- **Sitemap** — covered as checks inside `technical-seo.md` and `seo-audit.md` only.
