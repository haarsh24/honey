import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIST, formatIST, nextOccurrence, startOfPeriod } from '../src/time.js';
import { parseModelJson, verifySignature, normalizePhone, chunkText, sanitizeTemplateParam } from '../src/util.js';

test('parseIST / formatIST round trip', () => {
  const ms = parseIST('2026-10-15 18:00');
  assert.equal(ms, Date.UTC(2026, 9, 15, 12, 30));
  assert.equal(formatIST(ms), '2026-10-15 18:00');
});

test('parseIST rejects bad input', () => {
  assert.equal(parseIST('2026-02-31 10:00'), null);
  assert.equal(parseIST('2026-10-15'), null);
  assert.equal(parseIST('tomorrow'), null);
  assert.equal(parseIST('2026-10-15 25:00'), null);
  assert.notEqual(parseIST('2026-10-15', '12:00'), null);
});

test('nextOccurrence daily/weekly/monthly', () => {
  const due = parseIST('2026-01-31 09:00');
  const now = parseIST('2026-02-01 00:00');
  assert.equal(formatIST(nextOccurrence(due, 'daily', now)), '2026-02-01 09:00');
  assert.equal(formatIST(nextOccurrence(due, 'weekly', now)), '2026-02-07 09:00');
  assert.equal(formatIST(nextOccurrence(due, 'monthly', now)), '2026-02-28 09:00');
  assert.equal(nextOccurrence(due, 'none', now), null);
});

test('startOfPeriod week starts Monday', () => {
  const thu = parseIST('2026-10-15 10:00');
  assert.equal(formatIST(startOfPeriod('week', thu)), '2026-10-12 00:00');
  assert.equal(formatIST(startOfPeriod('month', thu)), '2026-10-01 00:00');
  assert.equal(formatIST(startOfPeriod('today', thu)), '2026-10-15 00:00');
});

test('parseModelJson tolerates fences and chatter', () => {
  assert.deepEqual(parseModelJson('```json\n{"reply":"hi"}\n```'), { reply: 'hi' });
  assert.deepEqual(parseModelJson('Sure! {"tool":"x","args":{}} done'), { tool: 'x', args: {} });
  assert.equal(parseModelJson('no json here'), null);
});

test('verifySignature', async () => {
  const body = '{"a":1}';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('s3cret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))).toString('hex');
  assert.equal(await verifySignature(body, `sha256=${sig}`, 's3cret'), true);
  assert.equal(await verifySignature(body, `sha256=${sig}`, 'wrong'), false);
  assert.equal(await verifySignature(body, null, 's3cret'), false);
  assert.equal(await verifySignature(body, 'sha256=abc', 's3cret'), false);
});

test('normalizePhone, chunkText, sanitizeTemplateParam', () => {
  assert.equal(normalizePhone('+91 98765 43210'), '919876543210');
  assert.equal(normalizePhone('9876543210'), '919876543210');
  assert.ok(chunkText('a'.repeat(9000)).length >= 3);
  const s = sanitizeTemplateParam('line1\n\n\tline2    x');
  assert.ok(!/[\n\t]/.test(s) && !/ {4}/.test(s));
});
