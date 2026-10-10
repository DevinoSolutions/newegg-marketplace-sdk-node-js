/**
 * Minimal RFC 4180-style delimited-text reader for report files. Newegg report files are CSV or
 * tab-delimited TXT with quoted fields that may contain embedded newlines (observed live on the
 * Item Basic Information report), so a line split is NOT safe: this is a small state machine.
 */

function detectDelimiter(text: string): "," | "\t" {
  let commas = 0;
  let tabs = 0;
  let inQuotes = false;
  for (const char of text) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes) {
      if (char === "\n") break;
      if (char === ",") commas += 1;
      else if (char === "\t") tabs += 1;
    }
  }
  return tabs > commas ? "\t" : ",";
}

/** Parses delimited text into rows of fields. Blank lines are skipped; a leading BOM is dropped. */
export function parseDelimited(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;

  const endField = (): void => {
    row.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRow = (): void => {
    endField();
    // A row consisting of a single empty field is a blank line.
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (inQuotes) {
      if (char === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
    } else if (char === delimiter) {
      endField();
    } else if (char === "\r") {
      if (text.charAt(i + 1) === "\n") i += 1;
      endRow();
    } else if (char === "\n") {
      endRow();
    } else {
      field += char;
      fieldStarted = true;
    }
  }
  if (fieldStarted || field !== "" || row.length > 0) endRow();
  return rows;
}

/** Lowercased header with every non-alphanumeric run removed ("Seller Part #" -> "sellerpartnumber"). */
export function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/#/g, " number ")
    .replace(/[^a-z0-9]+/g, "");
}
