/**
 * Everything specific to adipec.com lives here. Findings behind this file: docs/adipec-source.md.
 * The exhibitor-list page is a Vue app that reads these JSON endpoints; we call the same endpoints
 * the public page calls, politely, through lib/fetcher.ts.
 */
import { cleanText, normalizeUrl } from '../lib/normalize.js';

const API = 'https://www.adipec.com/api/exhibitorproxy/';

export const adipec = {
  listUrl: `${API}getallexhibitorslist`,
  categoriesUrl: `${API}getalllevelproductcategorieslist`,
  detailUrl: (id: string | number) => `${API}getExhibitorById?exhibitorid=${encodeURIComponent(id)}`,
  profileUrl: (id: string | number) => `https://www.adipec.com/exhibition/exhibitordetails?exhibitorid=${encodeURIComponent(id)}`,
};

// ---------- raw shapes (only the fields we use) ----------
export type ListRow = {
  Id: number;
  StandOppId: string | null;
  CompanyName: string;
  CountryName?: string | null;
  StandNumber?: string | null;
  Hall?: string | null;
  SponsorType?: string | null;
};

export type Detail = ListRow & {
  Address?: string | null;
  City?: string | null;
  WebsiteLink?: string | null;
  Facebook?: string | null;
  Twitter?: string | null;
  LinkedIn?: string | null;
  YouTube?: string | null;
  Instagram?: string | null;
  CompanyDescriptionTitle?: string | null;
  Description?: string | null;
  ProductCategory?: string | null;
  ExhibitorType?: string | null;
};

export type CategoryNode = { Name: string; Id: number; Children?: CategoryNode[] | null };

// ---------- parsing (pure functions, unit tested) ----------

/**
 * Rows for one edition. Real exhibitor rows have a stand id like "ADIPEC26-…"; rows without it are the
 * site's own test banners ("DMGTEST…"), which we skip. Everything else is kept, including sponsor rows
 * the public page hides, because the PTC says never drop a discovered exhibitor.
 */
export function editionRows(rows: ListRow[], edition: number) {
  const prefix = `ADIPEC${String(edition % 100).padStart(2, '0')}`;
  const kept = rows.filter((r) => typeof r.StandOppId === 'string' && r.StandOppId.startsWith(prefix) && cleanText(r.CompanyName));
  return { kept, skipped: rows.length - kept.length };
}

/** "The ADIPEC exhibitor list enables you to explore <strong>2,260 exhibitors" → 2260 */
export function parseAdvertisedCount(html: string): number | undefined {
  const m = html.match(/explore\s*(?:<[^>]+>\s*)*([\d,]+)\s*(?:<[^>]+>\s*)*exhibitors/i);
  return m ? Number(m[1].replace(/,/g, '')) : undefined;
}

/** Flatten the category tree into id → "Top > Middle > Leaf". */
export function categoryPaths(tree: CategoryNode[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (nodes: CategoryNode[] | null | undefined, path: string[]) => {
    for (const n of nodes ?? []) {
      const p = [...path, cleanText(n.Name) ?? String(n.Id)];
      out.set(String(n.Id), p.join(' > '));
      walk(n.Children, p);
    }
  };
  walk(tree, []);
  return out;
}

// The site fills this in when an exhibitor wrote no description. It is not company information.
const PLACEHOLDER_DESCRIPTIONS = new Set(['adipec is an energy event']);

export type ParsedProfile = {
  name?: string;
  stand?: string;
  country?: string;
  category?: string; // top-level categories, e.g. "O&G, Maritime"
  description?: string;
  website?: string;
  socials: { linkedin?: string; facebook?: string; instagram?: string; x?: string; youtube?: string };
  extra: Record<string, string>;
  missing: string[]; // human-readable list of what the profile didn't have
};

export function parseDetail(d: Detail, paths: Map<string, string>): ParsedProfile {
  const desc = cleanText(d.Description) ?? cleanText(d.CompanyDescriptionTitle);
  const description = desc && !PLACEHOLDER_DESCRIPTIONS.has(desc.toLowerCase().replace(/\s+/g, ' ')) ? desc : undefined;

  const catIds = (d.ProductCategory ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const catPaths = catIds.map((id) => paths.get(id)).filter((p): p is string => !!p);
  const topLevel = [...new Set(catPaths.map((p) => p.split(' > ')[0]))];

  const extra: Record<string, string> = {};
  const put = (k: string, v?: string | null) => {
    const c = cleanText(v);
    if (c) extra[k] = c;
  };
  put('hall', d.Hall);
  put('address', d.Address);
  put('city', d.City);
  put('exhibitorType', d.ExhibitorType);
  put('sponsorType', d.SponsorType);
  put('standOppId', d.StandOppId);
  if (catPaths.length) extra.productCategories = catPaths.join('; ');

  const p: ParsedProfile = {
    name: cleanText(d.CompanyName),
    stand: cleanText(d.StandNumber),
    country: cleanText(d.CountryName),
    category: topLevel.join(', ') || undefined,
    description,
    website: normalizeUrl(d.WebsiteLink),
    socials: {
      linkedin: normalizeUrl(d.LinkedIn),
      facebook: normalizeUrl(d.Facebook),
      instagram: normalizeUrl(d.Instagram),
      x: normalizeUrl(d.Twitter),
      youtube: normalizeUrl(d.YouTube),
    },
    extra,
    missing: [],
  };
  if (!p.website) p.missing.push('website');
  if (!p.description) p.missing.push('description');
  if (!p.country) p.missing.push('country');
  if (!p.category) p.missing.push('category');
  return p;
}
