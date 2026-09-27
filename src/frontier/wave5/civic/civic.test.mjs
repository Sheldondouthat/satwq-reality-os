import assert from 'node:assert/strict';
import test from 'node:test';
import { feedGlyph, feedLabel, itemSubtitle, timeAgo } from './model.js';

test('feedLabel maps known feeds', () => {
  assert.equal(feedLabel('federal-register'), 'Federal Register');
  assert.equal(feedLabel('hacker-news'), 'Hacker News');
  assert.equal(feedLabel('nyc-311'), 'NYC 311');
  assert.equal(feedLabel('bogus'), 'bogus');
});

test('feedGlyph returns a glyph for known feeds', () => {
  assert.ok(feedGlyph('hacker-news').length > 0);
  assert.equal(feedGlyph('bogus'), '•');
});

test('timeAgo buckets elapsed time', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  assert.equal(timeAgo(new Date(now - 30_000).toISOString(), now), 'just now');
  assert.equal(timeAgo(new Date(now - 5 * 60_000).toISOString(), now), '5m ago');
  assert.equal(timeAgo(new Date(now - 3 * 3600_000).toISOString(), now), '3h ago');
  assert.equal(timeAgo(new Date(now - 2 * 86400_000).toISOString(), now), '2d ago');
  assert.equal(timeAgo(new Date(now - 90 * 86400_000).toISOString(), now), '3mo ago');
  assert.equal(timeAgo('not-a-date', now), 'date n/a');
  assert.equal(timeAgo(new Date(now + 60_000).toISOString(), now), 'upcoming');
});

test('itemSubtitle joins kind/by/score/comments', () => {
  const s = itemSubtitle({ kind: 'story', by: 'pg', score: 10, comments: 3 });
  assert.ok(s.includes('by pg'));
  assert.ok(s.includes('10 pts'));
  assert.ok(s.includes('3 comments'));
});

test('itemSubtitle tolerates sparse items', () => {
  assert.equal(itemSubtitle({}), '');
  assert.equal(itemSubtitle(null), '');
});
