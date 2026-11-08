import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { decideAccept, defaultTermsDir, gateDecision, isExemptPath, loadManifest, pendingDocuments, statusOf, type Manifest } from './terms.js'
import { isOn } from '../lib/flag.js'

type Entry = { id: string; title?: string; kind: string; version?: string; file?: string }

const STANDARD: Entry[] = [
  { id: 'logbook-privacy', kind: 'privacy' },
  { id: 'logbook-eula', kind: 'eula' },
  { id: 'aic-platform-terms', kind: 'global' },
]

/** A throwaway terms folder. Files are written for every entry unless skipped. */
function folder(entries: Entry[], opts: { skipFile?: string; emptyFile?: string } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terms-'))
  const documents = entries.map((e) => ({ title: `Title of ${e.id}`, version: 'v1', file: `${e.id}.md`, ...e }))
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ app: 'logbook', documents }))
  for (const d of documents) {
    if (d.file === opts.skipFile) continue
    fs.writeFileSync(path.join(dir, d.file), d.file === opts.emptyFile ? '  \n' : `# ${d.title}\n\nText of ${d.id}.\n`)
  }
  return dir
}

function manifest(entries: Entry[] = STANDARD): Manifest {
  const r = loadManifest(folder(entries))
  assert.ok(r.ok, r.ok ? '' : r.error)
  return r.manifest
}

test('the repo legal folder loads, in order, global last, with matching hashes', () => {
  const dir = defaultTermsDir()
  const r = loadManifest(dir)
  assert.ok(r.ok, r.ok ? '' : r.error)
  assert.deepEqual(
    r.manifest.documents.map((d) => [d.id, d.title, d.kind]),
    [
      ['logbook-privacy', 'Logbook Privacy Policy', 'privacy'],
      ['logbook-eula', 'Logbook End User License Agreement', 'eula'],
      ['aic-platform-terms', 'AIC Platform Terms', 'global'],
    ],
  )
  for (const d of r.manifest.documents) {
    assert.equal(d.sha256, createHash('sha256').update(fs.readFileSync(path.join(dir, d.file))).digest('hex'))
  }
})

test('pendingDocuments keeps manifest order and drops accepted current versions', () => {
  const m = manifest()
  assert.deepEqual(pendingDocuments(m, []).map((d) => d.id), ['logbook-privacy', 'logbook-eula', 'aic-platform-terms'])
  assert.deepEqual(pendingDocuments(m, [{ documentId: 'logbook-eula', version: 'v1' }]).map((d) => d.id), ['logbook-privacy', 'aic-platform-terms'])
  const all = m.documents.map((d) => ({ documentId: d.id, version: d.version }))
  assert.deepEqual(pendingDocuments(m, all), [])
})

test('a version bump makes that document pending again; old versions do not count', () => {
  const bumped = manifest([STANDARD[0], { ...STANDARD[1], version: 'v2' }, STANDARD[2]])
  const acceptedV1 = STANDARD.map((e) => ({ documentId: e.id, version: 'v1' }))
  assert.deepEqual(pendingDocuments(bumped, acceptedV1).map((d) => d.id), ['logbook-eula'])
  const s = statusOf(true, bumped, acceptedV1)
  assert.equal(s.complete, false)
  assert.deepEqual(s.pending.map((d) => [d.id, d.version]), [['logbook-eula', 'v2']])
  assert.deepEqual(s.documents.map((d) => d.accepted), [true, false, true])
})

test('status with the gate off is complete and lists nothing pending', () => {
  const s = statusOf(false, manifest(), [])
  assert.equal(s.enabled, false)
  assert.equal(s.complete, true)
  assert.deepEqual(s.pending, [])
  assert.equal(s.documents.length, 3)
  assert.deepEqual(statusOf(false, null, []), { enabled: false, complete: true, pending: [], documents: [] })
})

test('accept: the first pending document at its current version is recorded', () => {
  const m = manifest()
  const d = decideAccept(m, [], { documentId: 'logbook-privacy', version: 'v1' })
  assert.equal(d.action, 'record')
  assert.equal(d.action === 'record' && d.doc.id, 'logbook-privacy')
})

test('accept out of order is refused', () => {
  const m = manifest()
  const d = decideAccept(m, [], { documentId: 'logbook-eula', version: 'v1' })
  assert.deepEqual(d.action === 'refuse' && d.code, 'terms_out_of_order')
  const g = decideAccept(m, [{ documentId: 'logbook-privacy', version: 'v1' }], { documentId: 'aic-platform-terms', version: 'v1' })
  assert.deepEqual(g.action === 'refuse' && g.code, 'terms_out_of_order')
})

test('accept with the wrong version is refused', () => {
  const m = manifest()
  const d = decideAccept(m, [], { documentId: 'logbook-privacy', version: 'v0' })
  assert.deepEqual(d.action === 'refuse' && d.code, 'terms_version_changed')
})

test('accepting an already accepted current version is a no-op; unknown ids are refused', () => {
  const m = manifest()
  const d = decideAccept(m, [{ documentId: 'logbook-privacy', version: 'v1' }], { documentId: 'logbook-privacy', version: 'v1' })
  assert.equal(d.action, 'noop')
  const u = decideAccept(m, [], { documentId: 'nope', version: 'v1' })
  assert.deepEqual(u.action === 'refuse' && u.code, 'terms_unknown_document')
})

test('manifest validation: missing file, empty file, global not last, duplicate id, bad kind, two globals', () => {
  const bad = (dir: string, re: RegExp) => {
    const r = loadManifest(dir)
    assert.equal(r.ok, false)
    assert.match(r.ok ? '' : r.error, re)
  }
  bad(folder(STANDARD, { skipFile: 'logbook-eula.md' }), /missing/)
  bad(folder(STANDARD, { emptyFile: 'logbook-eula.md' }), /empty/)
  bad(folder([STANDARD[0], STANDARD[2], STANDARD[1]]), /last/)
  bad(folder([STANDARD[0], STANDARD[0], STANDARD[2]]), /duplicate/)
  bad(folder([{ id: 'x', kind: 'tos' }, STANDARD[2]]), /kind/)
  bad(folder([{ ...STANDARD[2], id: 'g1' }, STANDARD[2]]), /exactly one/)
  bad(folder([STANDARD[0], { ...STANDARD[1], file: '../etc.md' }, STANDARD[2]]), /plain file name/)
  bad(fs.mkdtempSync(path.join(os.tmpdir(), 'terms-none-')), /manifest\.json/)
})

test('flag parsing', () => {
  for (const v of ['true', 'TRUE', '1', 'yes', 'on', ' On ']) assert.equal(isOn(v), true, v)
  for (const v of [undefined, '', 'false', '0', 'no', 'off', 'enabled', 'truthy']) assert.equal(isOn(v), false, String(v))
})

test('gate: flag off passes everything', () => {
  assert.equal(gateDecision({ enabled: false, via: 'session', path: '/me/state', manifestOk: false, pendingCount: 3 }), 'pass')
})

test('gate: API keys and anonymous calls are never held', () => {
  assert.equal(gateDecision({ enabled: true, via: 'key', path: '/punches/in', manifestOk: true, pendingCount: 3 }), 'pass')
  assert.equal(gateDecision({ enabled: true, via: 'key', path: '/punches/in', manifestOk: false, pendingCount: 0 }), 'pass')
  assert.equal(gateDecision({ enabled: true, via: null, path: '/me/state', manifestOk: true, pendingCount: 3 }), 'pass')
})

test('gate: exempt paths pass for a person with documents pending', () => {
  for (const p of ['/auth/me', '/auth/login', '/auth/sso', '/auth/google', '/auth/config', '/auth/dashboard/start', '/auth/dashboard/callback', '/terms/status', '/terms/accept', '/terms/documents/logbook-eula', '/auth/password', '/health', '/AUTH/ME/', '/terms/status/']) {
    assert.equal(isExemptPath(p), true, p)
    assert.equal(gateDecision({ enabled: true, via: 'session', path: p, manifestOk: true, pendingCount: 2 }), 'pass', p)
  }
  for (const p of ['/me/state', '/terms/documents/a/b', '/terms', '/auth/me/x', '/punches/in']) assert.equal(isExemptPath(p), false, p)
})

test('gate: a person with documents pending is refused; one who is complete passes', () => {
  assert.equal(gateDecision({ enabled: true, via: 'session', path: '/me/state', manifestOk: true, pendingCount: 1 }), 'terms_required')
  assert.equal(gateDecision({ enabled: true, via: 'session', path: '/me/state', manifestOk: true, pendingCount: 0 }), 'pass')
})

test('gate: a broken manifest with the flag on closes the app to people', () => {
  assert.equal(gateDecision({ enabled: true, via: 'session', path: '/me/state', manifestOk: false, pendingCount: 0 }), 'terms_unavailable')
})
