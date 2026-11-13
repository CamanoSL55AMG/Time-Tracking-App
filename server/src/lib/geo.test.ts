import test from 'node:test'
import assert from 'node:assert/strict'
import { distanceM, geoFlag, insideFence, parseGeo, resolveGeoStatus } from './geo.js'

const shop = { lat: 47.8209, lng: -122.3151, radiusM: 150 }

test('distance is about right', () => {
  // One degree of latitude is roughly 111 km.
  const d = distanceM({ lat: 47, lng: -122 }, { lat: 48, lng: -122 })
  assert.ok(d > 110_000 && d < 112_500, String(d))
  assert.equal(distanceM(shop, shop), 0)
})

test('fence', () => {
  assert.equal(insideFence({ lat: 47.8209, lng: -122.3151 }, shop), true)
  assert.equal(insideFence({ lat: 47.84, lng: -122.3151 }, shop), false)
  assert.equal(insideFence(null, shop), null)
  assert.equal(insideFence({ lat: 47.8209, lng: -122.3151 }, null), null)
})

test('a vague reading near the fence still counts as inside', () => {
  const near = { lat: 47.8209 + 0.002, lng: -122.3151 } // ~220 m north
  assert.equal(insideFence(near, shop), false)
  assert.equal(insideFence({ ...near, accuracyM: 100 }, shop), true)
})

test('parseGeo rejects nonsense', () => {
  assert.deepEqual(parseGeo({ lat: 47.8, lng: -122.3, accuracyM: 9 }), { lat: 47.8, lng: -122.3, accuracyM: 9 })
  assert.deepEqual(parseGeo({ lat: '47.8', lng: '-122.3' }), { lat: 47.8, lng: -122.3, accuracyM: undefined })
  assert.equal(parseGeo({ lat: 147.8, lng: -122.3 }), null)
  assert.equal(parseGeo({ lat: 'x', lng: 1 }), null)
  assert.equal(parseGeo(undefined), null)
  assert.equal(parseGeo('47,-122'), null)
})

test('a real position is always "captured"', () => {
  assert.equal(resolveGeoStatus({ lat: 47.8, lng: -122.3 }, 'denied'), 'captured')
  assert.equal(resolveGeoStatus({ lat: 47.8, lng: -122.3 }, undefined), 'captured')
})

test('without a position, only a failed-read status the phone reported is kept', () => {
  assert.equal(resolveGeoStatus(null, 'denied'), 'denied')
  assert.equal(resolveGeoStatus(null, ' DENIED '), 'denied')
  assert.equal(resolveGeoStatus(null, 'timeout'), 'timeout')
  assert.equal(resolveGeoStatus(null, 'unavailable'), 'unavailable')
  assert.equal(resolveGeoStatus(undefined, 'unsupported'), 'unsupported')
  // Nothing said (an integration, an old copy of the app): unknown, not flagged.
  assert.equal(resolveGeoStatus(null, undefined), null)
  // "captured" with no position, or rubbish, is not believed.
  assert.equal(resolveGeoStatus(null, 'captured'), null)
  assert.equal(resolveGeoStatus(null, 'nope'), null)
  assert.equal(resolveGeoStatus(null, 42), null)
})

test('geoFlag: declined is its own flag, other misses are "missing", the rest nothing', () => {
  assert.equal(geoFlag('denied'), 'declined')
  assert.equal(geoFlag('timeout'), 'missing')
  assert.equal(geoFlag('unavailable'), 'missing')
  assert.equal(geoFlag('unsupported'), 'missing')
  assert.equal(geoFlag('captured'), null)
  assert.equal(geoFlag(null), null)
  assert.equal(geoFlag(undefined), null)
})
