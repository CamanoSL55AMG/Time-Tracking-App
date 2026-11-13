import test from 'node:test'
import assert from 'node:assert/strict'
import { NO_DIVISION, divisionOpen, groupByDivision, loadOpen, personOpen, saveOpen, shortNames } from './peopleGroups.ts'

const row = (name: string, division?: string | null) => ({ id: name, name, division })

test('groups people by division, A to Z, with no division last', () => {
  const g = groupByDivision([row('Nate Hainzinger', ''), row('Kris Schmitt', 'Sound Services'), row('Shaun Olsen', 'CAD'), row('Zach Torp', null)])
  assert.deepEqual(
    g.map((x) => [x.label, x.rows.map((r) => r.name)]),
    [
      ['CAD', ['Shaun Olsen']],
      ['Sound Services', ['Kris Schmitt']],
      [NO_DIVISION, ['Nate Hainzinger', 'Zach Torp']],
    ],
  )
})

test('divisions match without case or extra spaces, like the server', () => {
  const g = groupByDivision([row('Kris Schmitt', 'Sound Services'), row('Steve Boyce', '  sound   services ')])
  assert.equal(g.length, 1)
  assert.equal(g[0].label, 'Sound Services')
  assert.equal(g[0].key, 'sound services')
  assert.equal(g[0].rows.length, 2)
})

test('keeps the order people came in inside a group', () => {
  const g = groupByDivision([row('Zed A', 'Install'), row('Amy B', 'Install')])
  assert.deepEqual(
    g[0].rows.map((r) => r.name),
    ['Zed A', 'Amy B'],
  )
})

test('nobody gives no groups', () => {
  assert.deepEqual(groupByDivision([]), [])
})

test('headers show just the first name', () => {
  const n = shortNames([row('Kris Schmitt'), row('Steve Boyce'), row('Cher')])
  assert.equal(n.get('Kris Schmitt'), 'Kris')
  assert.equal(n.get('Steve Boyce'), 'Steve')
  assert.equal(n.get('Cher'), 'Cher')
})

test('two people with the same first name get their last initial', () => {
  const n = shortNames([row('Mike Smith'), row('mike Torres'), row('Jake Coons')])
  assert.equal(n.get('Mike Smith'), 'Mike S.')
  assert.equal(n.get('mike Torres'), 'mike T.')
  assert.equal(n.get('Jake Coons'), 'Jake')
})

test('same first name and last initial: full names', () => {
  const n = shortNames([
    { id: 'a', name: 'Mike Smith' },
    { id: 'b', name: 'Mike Stone' },
    { id: 'c', name: 'Mike Torres' },
  ])
  assert.equal(n.get('a'), 'Mike Smith')
  assert.equal(n.get('b'), 'Mike Stone')
  assert.equal(n.get('c'), 'Mike T.')
})

test('divisions start open and people start closed', () => {
  const s = { divisions: {}, people: {} }
  assert.equal(divisionOpen(s, 'cad'), true)
  assert.equal(personOpen(s, 'p1'), false)
  assert.equal(divisionOpen({ divisions: { cad: false }, people: {} }, 'cad'), false)
  assert.equal(personOpen({ divisions: {}, people: { p1: true } }, 'p1'), true)
})

test('open state is remembered in this browser, and junk or no storage is ignored', () => {
  const store = new Map<string, string>()
  const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
  const g = globalThis as { localStorage?: unknown }
  const before = g.localStorage
  try {
    g.localStorage = undefined
    assert.deepEqual(loadOpen('k'), { divisions: {}, people: {} })
    saveOpen('k', { divisions: { cad: false }, people: {} }) // no storage: no throw

    g.localStorage = fake
    saveOpen('k', { divisions: { cad: false }, people: { p1: true } })
    assert.deepEqual(loadOpen('k'), { divisions: { cad: false }, people: { p1: true } })

    store.set('k', '{not json')
    assert.deepEqual(loadOpen('k'), { divisions: {}, people: {} })
    store.set('k', JSON.stringify({ divisions: { cad: 'yes' }, people: [1] }))
    assert.deepEqual(loadOpen('k'), { divisions: {}, people: {} })

    g.localStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    assert.deepEqual(loadOpen('k'), { divisions: {}, people: {} })
    saveOpen('k', { divisions: {}, people: {} })
  } finally {
    g.localStorage = before
  }
})
