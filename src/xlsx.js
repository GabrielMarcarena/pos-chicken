// A small, dependency-free .xlsx writer: text, numbers, dates, formulas (with cached values), column widths,
// frozen header row, filters, conditional formatting, merged cells, custom cell styles and print setup.
import { zip } from './zip.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

export function colName(n) { // 1 -> A, 27 -> AA
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

const STYLE = { default: 0, header: 1, money: 2, date: 3, weight: 4, bold: 5, wrap: 6, boldMoney: 7 };
const BASE_XFS = 8; // the eight named styles above
export const DXF = { red: 0, amber: 1, gray: 2 };

// ---- Custom styles ----------------------------------------------------------------------------------
// style({ bold, italic, size, color, fill, border: 'thin'|'medium', align, valign, wrap, format }) returns a style number
// that can be used as the `s` of a cell. Identical specs share one style.
const NUM_FORMATS = {
  text: 0, int: 1,
  peso: 166,   // ₱1,234.50, and nothing at all for zero (so empty report boxes stay empty)
  kg: 167,     // 3.6, 5.4, 1.25
  count: 168,  // 3, and nothing at all for zero
};
const customFonts = [];
const customFills = [];
const customXfs = [];
const styleCache = new Map();

const fontXml = (f) => `<font>${f.bold ? '<b/>' : ''}${f.italic ? '<i/>' : ''}<sz val="${f.size}"/>${f.color ? `<color rgb="FF${f.color}"/>` : ''}<name val="Arial"/></font>`;
const fillXml = (hex) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${hex}"/><bgColor indexed="64"/></patternFill></fill>`;

function indexOf(list, xml, offset) {
  let i = list.indexOf(xml);
  if (i === -1) { list.push(xml); i = list.length - 1; }
  return offset + i;
}

export function style(spec = {}) {
  const key = JSON.stringify(spec);
  if (styleCache.has(key)) return styleCache.get(key);
  const font = indexOf(customFonts, fontXml({ bold: !!spec.bold, italic: !!spec.italic, size: spec.size ?? 10, color: spec.color ?? null }), 3);
  const fill = spec.fill ? indexOf(customFills, fillXml(spec.fill), 3) : 0;
  const border = spec.border === 'medium' ? 2 : spec.border ? 1 : 0;
  const numFmt = NUM_FORMATS[spec.format ?? 'text'];
  const xf = `<xf numFmtId="${numFmt}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">`
    + `<alignment horizontal="${spec.align ?? 'general'}" vertical="${spec.valign ?? 'center'}"${spec.wrap ? ' wrapText="1"' : ''}/></xf>`;
  const id = BASE_XFS + customXfs.length;
  customXfs.push(xf);
  styleCache.set(key, id);
  return id;
}

/** "2026-10-09" -> Excel date serial number */
export const dateSerial = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000) + 25569;
};

// Cell helpers: use plain strings/numbers for ordinary cells.
export const date = (iso) => (iso ? { v: dateSerial(iso), s: 'date' } : null);
export const money = (n) => (n === null || n === undefined ? null : { v: n, s: 'money' });
export const weight = (n) => (n === null || n === undefined ? null : { v: n, s: 'weight' });
export const formula = (f, cached, s) => ({ f, v: cached, s });
export const header = (text) => ({ v: text, s: 'header' });

export class Sheet {
  constructor(name) {
    this.name = name;
    this.rows = [];
    this.widths = [];
    this.heights = {};      // row number -> height in points
    this.merges = [];       // "A1:C1"
    this.freezeHeader = false;
    this.filter = false;
    this.print = null;      // { landscape: true, fitWidth: true }
    this.rules = [];        // { sqref, formula, dxf }
  }
  addRow(cells) { this.rows.push(cells); return this; }

  xml(selected) {
    const out = [];
    const cols = this.rows.reduce((m, r) => Math.max(m, r.length), 1);
    out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    out.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
    if (this.print?.fitWidth) out.push('<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>');
    out.push(`<dimension ref="A1:${colName(cols)}${Math.max(this.rows.length, 1)}"/>`);
    out.push('<sheetViews><sheetView workbookViewId="0"' + (selected ? ' tabSelected="1"' : '') + '>');
    if (this.freezeHeader) out.push('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    out.push('</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>');
    if (this.widths.length) {
      out.push('<cols>' + this.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>');
    }
    out.push('<sheetData>');
    this.rows.forEach((cells, r) => {
      const ht = this.heights[r + 1];
      out.push(`<row r="${r + 1}"${ht ? ` ht="${ht}" customHeight="1"` : ''}>`);
      cells.forEach((cell, c) => {
        if (cell === null || cell === undefined || cell === '') return;
        const ref = `${colName(c + 1)}${r + 1}`;
        const obj = typeof cell === 'object' ? cell : { v: cell };
        const s = typeof obj.s === 'number' ? obj.s : STYLE[obj.s ?? 'default'];
        const styleAttr = s ? ` s="${s}"` : '';
        if (obj.f !== undefined) {
          const isText = typeof obj.v === 'string';
          out.push(`<c r="${ref}"${styleAttr}${isText ? ' t="str"' : ''}><f>${esc(obj.f)}</f><v>${esc(obj.v ?? 0)}</v></c>`);
        } else if (obj.v === null || obj.v === undefined || obj.v === '') {
          out.push(`<c r="${ref}"${styleAttr}/>`);   // an empty box that only carries a border or colour
        } else if (typeof obj.v === 'number') {
          out.push(`<c r="${ref}"${styleAttr}><v>${obj.v}</v></c>`);
        } else {
          out.push(`<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${esc(obj.v)}</t></is></c>`);
        }
      });
      out.push('</row>');
    });
    out.push('</sheetData>');
    if (this.filter && this.rows.length) out.push(`<autoFilter ref="A1:${colName(cols)}${this.rows.length}"/>`);
    if (this.merges.length) out.push(`<mergeCells count="${this.merges.length}">${this.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`);
    let priority = 1;
    for (const rule of this.rules) {
      out.push(`<conditionalFormatting sqref="${rule.sqref}"><cfRule type="expression" dxfId="${DXF[rule.dxf]}" priority="${priority++}"><formula>${esc(rule.formula)}</formula></cfRule></conditionalFormatting>`);
    }
    out.push('<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>');
    if (this.print) out.push(`<pageSetup paperSize="9" orientation="${this.print.landscape ? 'landscape' : 'portrait'}"${this.print.fitWidth ? ' fitToWidth="1" fitToHeight="0"' : ''}/>`);
    out.push('</worksheet>');
    return out.join('');
  }
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="5"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="165" formatCode="0.000"/><numFmt numFmtId="166" formatCode="&quot;₱&quot;#,##0.00;\\-&quot;₱&quot;#,##0.00;;@"/><numFmt numFmtId="167" formatCode="0.0##"/><numFmt numFmtId="168" formatCode="0;\\-0;;@"/></numFmts>
<fonts count="${3 + customFonts.length}"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font>${customFonts.join('')}</fonts>
<fills count="${3 + customFills.length}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF14573F"/><bgColor indexed="64"/></patternFill></fill>${customFills.join('')}</fills>
<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FF7A7A7A"/></left><right style="thin"><color rgb="FF7A7A7A"/></right><top style="thin"><color rgb="FF7A7A7A"/></top><bottom style="thin"><color rgb="FF7A7A7A"/></bottom><diagonal/></border><border><left style="medium"><color rgb="FF000000"/></left><right style="medium"><color rgb="FF000000"/></right><top style="medium"><color rgb="FF000000"/></top><bottom style="medium"><color rgb="FF000000"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${BASE_XFS + customXfs.length}">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
<xf numFmtId="4" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>
${customXfs.join('\n')}
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="3">
<dxf><font><color rgb="FF9C0006"/></font><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf>
<dxf><font><color rgb="FF7F6000"/></font><fill><patternFill><bgColor rgb="FFFFEB9C"/></patternFill></fill></dxf>
<dxf><font><color rgb="FF595959"/></font><fill><patternFill><bgColor rgb="FFE7E6E6"/></patternFill></fill></dxf>
</dxfs>
</styleSheet>`;
}

/** sheets: Sheet[] -> Buffer of the .xlsx file */
export function buildWorkbook(sheets) {
  const n = sheets.length;
  const names = sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  const filters = sheets.map((s, i) => (s.filter && s.rows.length
    ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${s.name}'!$A$1:$${colName(s.rows.reduce((m, r) => Math.max(m, r.length), 1))}$${s.rows.length}</definedName>` : '')).join('');
  const files = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${names}</sheets>${filters ? `<definedNames>${filters}</definedNames>` : ''}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: stylesXml() },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: s.xml(i === 0) })),
  ];
  return zip(files);
}
