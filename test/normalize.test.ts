import { describe, expect, it } from 'vitest';
import { cleanText, nameSimilarity, normalizeDomain, normalizeName, normalizeUrl } from '../src/lib/normalize.js';

describe('normalizeName', () => {
  it.each([
    ['Siemens Energy L.L.C.', 'siemens energy'],
    ['SIEMENS ENERGY LLC', 'siemens energy'],
    [' Lynxeo', 'lynxeo'],
    ['Shandong Kerui Petroleum & Gas Equipment Co., Ltd', 'shandong kerui petroleum and gas equipment'],
    ['ADNOC', 'adnoc'],
    ['Abu Dhabi National Oil Company (ADNOC) P.J.S.C.', 'abu dhabi national oil company adnoc'],
    ['3P PRINZ', '3p prinz'],
    ['Saipem S.p.A.', 'saipem'],
    ['Wood Group Kenny Ltd.', 'wood group kenny'],
    ['Bilfinger GmbH', 'bilfinger'],
    ['Halliburton Inc', 'halliburton'],
    ['Velosi Asset Integrity FZ-LLC', 'velosi asset integrity'],
    ['Gulf Marine Services PLC', 'gulf marine services'],
    ['Al Masaood W.L.L.', 'al masaood'],
    ['Cognite AS', 'cognite'],
    ['The Example Company', 'example'],
    ['TotalEnergies SE', 'totalenergies se'],
    ['Équipements Pétroliers SARL', 'equipements petroliers'],
    ['Right Choice General Trading L.L.C', 'right choice general trading'],
    ['Pressbolt Middle East FZE', 'pressbolt middle east'],
    ['Emirates Steel Arkan P.J.S.C', 'emirates steel arkan'],
    ['NOV Inc.', 'nov'],
    ['KBR, Inc.', 'kbr'],
    ['Petrofac Limited', 'petrofac'],
    ['  extra   spaces   ltd ', 'extra spaces'],
    ['A.P. Moller - Maersk', 'ap moller maersk'],
    ['Co', 'co'], // never strips a name down to nothing
    ['LLC', 'llc'],
    ['Smith & Sons Co. LLC', 'smith and sons'],
    ['Patterson-UTI', 'patterson uti'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });
});

describe('normalizeUrl / normalizeDomain', () => {
  it.each([
    ['www.3pprinz.com', 'https://www.3pprinz.com/', '3pprinz.com'],
    ['https://shop.example.co.uk/path#x', 'https://shop.example.co.uk/path', 'example.co.uk'],
    ['HTTP://Example.COM', 'http://example.com/', 'example.com'],
    ['  ', undefined, undefined],
    ['not a url', undefined, undefined],
    ['ftp://example.com', undefined, undefined],
    ['localhost', undefined, undefined],
  ])('%s', (input, url, domain) => {
    expect(normalizeUrl(input)).toBe(url);
    expect(normalizeDomain(input)).toBe(domain);
  });
});

describe('cleanText / nameSimilarity', () => {
  it('cleans whitespace and empties', () => {
    expect(cleanText('  a \n b ')).toBe('a b');
    expect(cleanText('   ')).toBeUndefined();
    expect(cleanText(null)).toBeUndefined();
  });
  it('scores word overlap', () => {
    expect(nameSimilarity('Siemens Energy LLC', 'SIEMENS ENERGY')).toBe(1);
    expect(nameSimilarity('Siemens Energy', 'Siemens')).toBe(0.5);
    expect(nameSimilarity('Alpha', 'Beta')).toBe(0);
  });
});
