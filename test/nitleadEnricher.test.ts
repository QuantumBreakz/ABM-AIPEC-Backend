import { describe, expect, it } from 'vitest';
import {
  buildCompanyInboxContact,
  classifyEmailType,
  cleanEmail,
  cleanPhone,
  decodeCfEmail,
  domainMatchesBusiness,
  extractEmailsFromHtml,
  extractPeopleFromHtml,
  extractPeopleFromSnippets,
  extractPhonesFromHtml,
  parseDuckDuckGoHtml,
  rankEmails,
} from '../src/sources/nitleadEnricher.js';

describe('NitLead contact & email scraper helpers', () => {
  it('cleans emails and filters junk, image, and robotic addresses', () => {
    expect(cleanEmail('  MAILTO:Sales@AdosUAE.com?subject=hi  ')).toBe('sales@adosuae.com');
    expect(cleanEmail('logo@2x.png')).toBeNull();
    expect(cleanEmail('noreply@company.com')).toBeNull();
    expect(cleanEmail('user@example.com')).toBeNull();
    expect(cleanEmail('abc@sentry.io')).toBeNull();
    expect(cleanEmail('info@acmeprod.comin')).toBeNull();
    expect(cleanEmail('sfglyi@163.comfind')).toBeNull();
  });

  it('decodes Cloudflare data-cfemail XOR obfuscation', () => {
    // key = 0x2a, "info@abtech.com" XOR 0x2a
    const plain = 'info@abtech.com';
    const key = 0x2a;
    const hex = key.toString(16).padStart(2, '0') + [...plain].map((ch) => (ch.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');
    expect(decodeCfEmail(hex)).toBe('info@abtech.com');
  });

  it('extracts emails from mailto:, Cloudflare data-cfemail, JSON-LD, and raw HTML', () => {
    const plain = 'contact@acme.com';
    const key = 0x15;
    const hex = key.toString(16).padStart(2, '0') + [...plain].map((ch) => (ch.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');

    const html = `
      <html><head>
        <script type="application/ld+json">{"@type":"Organization","email":"sales@acme.com","telephone":"+971 2 555 1234"}</script>
      </head><body>
        <a href="mailto:info@acme.com">Email us</a>
        <span data-cfemail="${hex}">[email protected]</span>
        <p>Reach Ahmed at ahmed.mansoor@acme.com or call +971 4 321 9876 (2020-2026).</p>
      </body></html>
    `;
    const emails = extractEmailsFromHtml(html);
    expect(emails).toContain('info@acme.com');
    expect(emails).toContain('contact@acme.com');
    expect(emails).toContain('sales@acme.com');
    expect(emails).toContain('ahmed.mansoor@acme.com');

    const phones = extractPhonesFromHtml(html);
    expect(phones).toContain('+971 2 555 1234');
    expect(phones).toContain('+971 4 321 9876');
    expect(phones.some((p) => p.includes('2020'))).toBe(false);
  });

  it('validates phones and rejects year ranges and invalid lengths', () => {
    expect(cleanPhone('+971 2 501 5555')).toBe('+971 2 501 5555');
    expect(cleanPhone('2020-2026')).toBeNull();
    expect(cleanPhone('12345')).toBeNull();
    expect(cleanPhone('000000000')).toBeNull();
  });

  it('verifies domain-to-business match and skips aggregator sites', () => {
    expect(domainMatchesBusiness('https://www.abtech.com/contact', 'Abtech')).toBe(true);
    expect(domainMatchesBusiness('https://www.linkedin.com/company/abtech', 'Abtech')).toBe(false);
    expect(domainMatchesBusiness('https://www.random-unrelated.com', 'Abtech')).toBe(false);
  });

  it('ranks company-domain direct inboxes and decision-maker emails highest', () => {
    const ranked = rankEmails(['careers@abtech.com', 'random@other.org', 'info@abtech.com', 'support@abtech.com'], 'abtech.com');
    expect(ranked[0]).toBe('info@abtech.com');
    expect(classifyEmailType('info@abtech.com')).toBe('generic');
    expect(classifyEmailType('john.smith@abtech.com')).toBe('business');
  });

  it('extracts named people from JSON-LD, leadership cards, and first.last emails', () => {
    const html = `
      <html><head>
        <script type="application/ld+json">
          {"@type":"Organization","founder":{"@type":"Person","name":"Sarah Al Mansoori","jobTitle":"Chief Executive Officer","email":"sarah@acme.com"}}
        </script>
      </head><body>
        <div class="team-card">
          <h3>Tariq Hassan</h3>
          <p>Managing Director</p>
          <a href="mailto:tariq@acme.com">Email</a>
          <a href="https://ae.linkedin.com/in/tariq-hassan">LinkedIn</a>
        </div>
        <p>Contact john.smith@acme.com for engineering quotes.</p>
      </body></html>
    `;
    const people = extractPeopleFromHtml(html, 'website', 'acme.com');
    expect(people).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ firstName: 'Sarah', lastName: 'Al Mansoori', seniority: 'CXO' }),
        expect.objectContaining({
          firstName: 'Tariq',
          lastName: 'Hassan',
          title: 'Managing Director',
          profileUrl: 'https://www.linkedin.com/in/tariq-hassan',
        }),
        expect.objectContaining({ firstName: 'John', lastName: 'Smith' }),
      ]),
    );
  });

  it('builds a clean inbox contact fallback and parses DuckDuckGo HTML snippets', () => {
    const inbox = buildCompanyInboxContact([{ address: 'sales@adosuae.com', type: 'generic', provider: 'website' }]);
    expect(inbox).toMatchObject({ firstName: 'Sales', lastName: 'Team', title: 'Sales & Business Development' });

    const ddgHtml = `
      <div class="result">
        <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.linkedin.com%2Fin%2Fomar-khalid">Omar Khalid - Chief Executive Officer - Acme Engineering | LinkedIn</a>
        <div class="result__snippet">Omar Khalid is CEO at Acme Engineering Products. Contact info@acmeprod.com</div>
      </div>
    `;
    const hits = parseDuckDuckGoHtml(ddgHtml);
    expect(hits).toHaveLength(1);
    const people = extractPeopleFromSnippets(hits, 'Acme Engineering Products');
    expect(people[0]).toMatchObject({
      firstName: 'Omar',
      lastName: 'Khalid',
      seniority: 'CXO',
      profileUrl: 'https://www.linkedin.com/in/omar-khalid',
    });
  });
});
