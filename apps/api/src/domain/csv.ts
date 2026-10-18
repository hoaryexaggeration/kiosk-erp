/**
 * Minimal RFC 4180 CSV reader.
 *
 * Why hand-rolled rather than a dependency: the import path must be auditable and must not silently
 * reinterpret a shopkeeper's file. This reader only does the quoting rules — it makes no attempt to
 * guess types, trim values or "fix" a ragged row, because every such convenience is a place where a
 * price could quietly change meaning. Whoever consumes the cells decides what they mean, and every
 * decision it makes is reported back to the operator row by row.
 *
 * Supported: comma separation, double-quoted cells, `""` as an escaped quote inside a quoted cell,
 * newlines inside quoted cells, CRLF or LF line endings, and a leading UTF-8 BOM (Excel writes one,
 * and it would otherwise corrupt the first header name).
 *
 * `line` is the 1-based physical line the row started on, so an error report points at the line the
 * operator sees in their spreadsheet — including rows that were skipped as blank.
 */
export interface CsvRow {
  line: number;
  cells: string[];
}

export function parseCsv(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let rowStartLine = 1;
  let index = 0;

  // Strip a UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) index = 1;

  const endCell = () => {
    cells.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    rows.push({ line: rowStartLine, cells });
    cells = [];
    rowStartLine = line;
  };

  while (index < text.length) {
    const ch = text[index];
    if (quoted) {
      if (ch === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      if (ch === '\n') line += 1;
      cell += ch;
      index += 1;
      continue;
    }
    if (ch === '"' && cell.length === 0) {
      quoted = true;
      index += 1;
      continue;
    }
    if (ch === ',') {
      endCell();
      index += 1;
      continue;
    }
    if (ch === '\r') {
      index += 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      line += 1;
      rowStartLine = line;
      index += 1;
      continue;
    }
    cell += ch;
    index += 1;
  }

  // A file that ends without a newline still has a final row; one that ends with a newline does not.
  if (cell.length > 0 || cells.length > 0) endRow();

  // Drop blank lines (a trailing newline, or spreadsheet padding) without disturbing line numbers.
  return rows.filter((row) => row.cells.some((value) => value.trim().length > 0));
}
