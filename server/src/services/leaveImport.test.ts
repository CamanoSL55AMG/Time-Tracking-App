import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { buildRows, checkMapping, guessMapping, parseHours } from './leaveImport.js'
import { parseCsv, parseXlsx, readSheet } from '../lib/sheet.js'

const types = [
  { id: 't-sick', key: 'sick', name: 'Sick leave' },
  { id: 't-vac', key: 'vacation', name: 'Vacation' },
]
const people = [
  { id: 'p1', name: 'Pat Example', email: 'pat@example.com', initials: 'PE', active: true },
  { id: 'p2', name: 'Sam Sample', email: 'sam@example.com', initials: 'SS', active: true },
  { id: 'p3', name: 'Lee Test', email: 'lee.one@example.com', initials: 'LT', active: true },
  { id: 'p4', name: 'Lee Test', email: 'lee.two@example.com', initials: 'LT', active: true },
]

const sheet = parseCsv(
  [
    'Leave balances as of 11/15/2026,,,,',
    'Employee,Email,Sick used,Sick balance,Vacation balance',
    'Pat Example,,4,"12.50",40 hrs',
    '"Sample, Sam",,0,8,(4)',
    'Lee Test,,0,1,2',
    'Nobody Here,,0,3,',
    ',,,,',
    'Total,,4,24.5,38',
  ].join('\r\n'),
)

test('hours are read the way people type them', () => {
  assert.equal(parseHours('12.5'), 12.5)
  assert.equal(parseHours('1,024.0'), 1024)
  assert.equal(parseHours('40 hrs'), 40)
  assert.equal(parseHours('(4)'), -4)
  assert.equal(parseHours(''), null)
  assert.equal(parseHours('n/a'), 'bad')
})

test('the heading row and balance columns are guessed, preferring "balance" over "used"', () => {
  const m = guessMapping(sheet, types)
  assert.equal(m.headerRow, 1)
  assert.equal(m.nameCol, 0)
  assert.equal(m.emailCol, 1)
  assert.deepEqual(m.columns, [
    { col: 3, leaveTypeId: 't-sick' },
    { col: 4, leaveTypeId: 't-vac' },
  ])
})

test('rows match by name (either order), flag the unknown and the ambiguous, skip blanks and totals', () => {
  const rows = buildRows(sheet, guessMapping(sheet, types), people)
  assert.deepEqual(rows.map((r) => [r.sheetRow, r.personId, r.match]), [
    [3, 'p1', 'name'],
    [4, 'p2', 'name'],
    [5, null, 'ambiguous'],
    [6, null, 'none'],
  ])
  assert.deepEqual(rows[0].balances.map((b) => b.hours), [12.5, 40])
  assert.deepEqual(rows[1].balances.map((b) => b.hours), [8, -4])
  assert.equal(rows[3].balances[1].hours, null) // blank stays blank, nothing posted
})

test('a row picked by hand wins, and the same person twice is flagged', () => {
  const rows = buildRows(sheet, guessMapping(sheet, types), people, { 5: 'p3', 6: 'p1' })
  assert.equal(rows[2].personId, 'p3')
  assert.equal(rows[2].match, 'chosen')
  assert.ok(rows[3].problems.some((p) => p.includes('also on row 3')))
})

test('email beats name', () => {
  const s = parseCsv('Name,Email,Sick\nWrong Name,sam@example.com,5\n')
  const rows = buildRows(s, guessMapping(s, types), people)
  assert.equal(rows[0].personId, 'p2')
  assert.equal(rows[0].match, 'email')
})

test('a mapping is checked before anything is read', () => {
  const ids = new Set(types.map((t) => t.id))
  assert.equal(checkMapping({ headerRow: 0, nameCol: null, emailCol: null, columns: [{ col: 1, leaveTypeId: 't-sick' }] }, 5, ids), 'Pick the column with the name or the email.')
  assert.equal(checkMapping({ headerRow: 0, nameCol: 0, emailCol: null, columns: [] }, 5, ids), 'Pick at least one balance column.')
  assert.equal(checkMapping({ headerRow: 0, nameCol: 0, emailCol: null, columns: [{ col: 9, leaveTypeId: 't-sick' }] }, 5, ids), 'That column is not in the sheet.')
  assert.equal(checkMapping({ headerRow: 0, nameCol: 0, emailCol: null, columns: [{ col: 1, leaveTypeId: 't-sick' }, { col: 2, leaveTypeId: 't-sick' }] }, 5, ids), 'Each leave type can come from one column only.')
  assert.equal(checkMapping({ headerRow: 0, nameCol: 0, emailCol: null, columns: [{ col: 1, leaveTypeId: 't-sick' }] }, 5, ids), null)
})

// A minimal .xlsx built here, the way Excel stores it: a zip of XML parts.
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8')
    const data = deflateRawSync(raw)
    const nameBuf = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, data)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

test('an .xlsx is read: shared strings, numbers, inline text, gaps and the first sheet in workbook order', () => {
  const book = zip({
    'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Balances" sheetId="1" r:id="rId7"/><sheet name="Old" sheetId="2" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId7" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>Name</t></si><si><t>Sick</t></si><si><r><t>Pat </t></r><r><t>Example</t></r></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>wrong sheet</t></is></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
      '<row r="3"><c r="A3" t="s"><v>2</v></c><c r="C3"><f>SUM(1,2)</f><v>12.5</v></c></row></sheetData></worksheet>',
  })
  const rows = parseXlsx(book)
  assert.deepEqual(rows, [['Name', '', 'Sick'], [], ['Pat Example', '', '12.5']])
  assert.deepEqual(readSheet('balances.xlsx', book), rows)
})

test('an old .xls is turned away with a clear code', () => {
  assert.throws(() => readSheet('balances.xls', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3])), /old_xls/)
})
