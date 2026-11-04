import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inlineMessage, plainText, ucwaDate, ucwaDelivery, ucwaPresence } from '../src/connectors/skype-normalize';

test('UCWA inline bodies decode Unicode without interpreting HTML', () => {
  assert.deepEqual(inlineMessage('data:text/plain;charset=utf-8,Hello%20%F0%9F%91%8B'), { text: 'Hello 👋', html: false });
  assert.deepEqual(inlineMessage('data:text/plain;base64,SGVsbG8g8J+Riw=='), { text: 'Hello 👋', html: false });
  assert.deepEqual(inlineMessage('data:text/html,%3Cp%3EHello%20%26amp%3B%20goodbye%3C%2Fp%3E'), { text: 'Hello & goodbye', html: true });
  assert.throws(() => inlineMessage('https://service.example.org/messageBody'));
  assert.throws(() => inlineMessage('data:text/plain;base64,%%%%'));
});
test('untrusted message markup becomes inert text', () => {
  const value = plainText('<script>throw 1</script><p>Hello<br>world</p><img src=x onerror=alert(1)>', true);
  assert.ok(!value.includes('<')); assert.ok(!value.includes('throw')); assert.ok(value.includes('Hello'));
});
test('UCWA timestamps, presence and delivery are normalized conservatively', () => {
  assert.equal(ucwaDate('/Date(0)/'), '1970-01-01T00:00:00.000Z');
  assert.equal(ucwaDate('/Date(1470000000000+0200)/'), '2016-07-31T21:20:00.000Z');
  assert.equal(ucwaPresence('Busy'), 'busy'); assert.equal(ucwaPresence('Online'), 'online');
  assert.equal(ucwaDelivery('Succeeded'), 'delivered'); assert.equal(ucwaDelivery('Failed'), 'failed');
  assert.equal(ucwaDelivery('Unknown'), 'accepted');
});
