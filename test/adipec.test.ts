import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adipec, categoryPaths, editionRows, parseAdvertisedCount, parseDetail } from '../src/sources/adipec.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/adipec/${name}`, import.meta.url), 'utf8');
const json = (name: string) => JSON.parse(fixture(name));

describe('adipec source parsing', () => {
  it('keeps only rows with this edition’s stand id, including sponsor rows the site hides', () => {
    const { kept, skipped } = editionRows(json('list.json').Result, 2026);
    expect(kept.map((r) => r.Id)).toEqual([101, 102, 103, 104]);
    expect(skipped).toBe(3); // test banner, 2025 row, row without stand id
  });

  it('reads the advertised count from the page', () => {
    expect(parseAdvertisedCount(fixture('list-page.html'))).toBe(2260);
    expect(parseAdvertisedCount('<p>nothing here</p>')).toBeUndefined();
  });

  it('flattens the category tree into paths', () => {
    const paths = categoryPaths(json('categories.json'));
    expect(paths.get('3')).toBe('O&G > Upstream > Drilling Contractor');
    expect(paths.get('4')).toBe('Maritime');
  });

  it('parses a full profile', () => {
    const p = parseDetail(json('detail-101.json'), categoryPaths(json('categories.json')));
    expect(p).toMatchObject({
      name: 'Example Drilling L.L.C.',
      stand: '1101',
      country: 'United Arab Emirates',
      category: 'O&G',
      description: 'Example Drilling provides invented drilling services.',
      website: 'https://www.exampledrilling.example/',
      socials: { linkedin: 'https://www.linkedin.com/company/example-drilling', x: 'https://twitter.com/exampledrilling' },
      missing: [],
    });
    expect(p.extra).toMatchObject({
      city: 'Abu Dhabi',
      address: 'Example Tower, Street 1',
      productCategories: 'O&G; O&G > Upstream > Drilling Contractor',
    });
  });

  it('treats the site’s placeholder description as missing and lists what is missing', () => {
    const p = parseDetail(json('detail-102.json'), new Map());
    expect(p.description).toBeUndefined();
    expect(p.missing).toEqual(['website', 'description', 'category']);
  });

  it('builds the public profile link', () => {
    expect(adipec.profileUrl(101)).toBe('https://www.adipec.com/exhibition/exhibitordetails?exhibitorid=101');
  });
});
