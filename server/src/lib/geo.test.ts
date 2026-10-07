import test from 'node:test'
import assert from 'node:assert/strict'
import { distanceM, insideFence, parseGeo } from './geo.js'

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
