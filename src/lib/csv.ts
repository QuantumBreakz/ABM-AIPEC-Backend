// CSV writing for exports and reports. Same format the frontend's mock produces.

/** Byte order mark: tells Excel the file is UTF-8, so non-English characters show correctly. */
export const BOM = '﻿';

/** Stop spreadsheets from running a cell as a formula (=, +, -, @, tab, CR). */
const safe = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

export type Cell = string | number | null | undefined | Date;

/** One CSV line, CRLF-terminated. Cells with quotes, commas or line breaks are quoted. */
export function csvLine(row: Cell[]): string {
  return `${row
    .map((v) => {
      const text = safe(v === undefined || v === null ? '' : v instanceof Date ? v.toISOString() : String(v));
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    })
    .join(',')}\r\n`;
}

export const toCsv = (rows: Cell[][]) => BOM + rows.map(csvLine).join('');
