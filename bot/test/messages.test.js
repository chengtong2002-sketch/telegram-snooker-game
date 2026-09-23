import test from 'node:test';
import assert from 'node:assert/strict';

import { SHOT_CLOCK_MS } from '@snooker/sim';
import { welcomeMessage, escapeHtml } from '../src/messages.js';

const welcome = (first_name) => welcomeMessage({ first_name }, { network: 'testnet' });

test('the welcome is sent as HTML', () => {
  assert.equal(welcome('Nick').parse_mode, 'HTML');
});

test('the welcome breaks lines with real newlines, never a literal backslash-n', () => {
  const { text } = welcome('Nick');
  assert.ok(text.includes('\n'), 'no line breaks at all');
  assert.ok(!text.includes('\\n'), 'contains a literal \\n');
  assert.ok(!text.includes('\r'), 'contains a carriage return');
});

test('no sentence is wrapped across two lines', () => {
  // Telegram breaks at every newline, so a source-wrapped sentence shows up as
  // a ragged break mid-sentence on the phone. Every non-empty line must be
  // whole: it ends a sentence (or is the heading), and none is a continuation.
  const lines = welcome('Nick').text.split('\n').filter((l) => l !== '');
  for (const line of lines) {
    assert.doesNotMatch(line, /^\s/, `continuation line: "${line}"`);
    assert.match(line, /[.!?]$/, `line does not end a sentence: "${line}"`);
  }
});

test('paragraphs are separated by one blank line, with no blank line at either end', () => {
  const { text } = welcome('Nick');
  assert.doesNotMatch(text, /\n{3,}/);
  assert.ok(!text.startsWith('\n') && !text.endsWith('\n'));
});

test('the welcome says what it always said', () => {
  const { text } = welcome('Nick');
  assert.match(text, /welcome, Nick\./);
  assert.match(text, new RegExp(`${SHOT_CLOCK_MS / 1000}-second shot clock`));
  for (const cmd of ['/practice', '/play', '/wallet', '/leaderboard']) assert.ok(text.includes(cmd), cmd);
  assert.match(text, /Rewards run on <b>testnet<\/b>/);
  assert.match(text, /nothing to stake, nothing to lose\./);
});

test('HTML tags are balanced and only ones Telegram accepts', () => {
  const { text } = welcome('Nick');
  const tags = [...text.matchAll(/<\/?([a-z]+)>/g)];
  for (const [, name] of tags) assert.ok(['b', 'i'].includes(name), `unexpected <${name}>`);
  for (const name of ['b', 'i']) {
    const open = (text.match(new RegExp(`<${name}>`, 'g')) ?? []).length;
    const close = (text.match(new RegExp(`</${name}>`, 'g')) ?? []).length;
    assert.equal(open, close, `<${name}> unbalanced`);
  }
});

test('a name with markup characters is escaped, not parsed', () => {
  // Under the old Markdown mode an underscore or asterisk in a first name
  // made Telegram reject the message outright.
  const { text } = welcome('<b>Al_ex*</b> & co');
  assert.match(text, /welcome, &lt;b&gt;Al_ex\*&lt;\/b&gt; &amp; co\./);
  assert.equal((text.match(/<b>/g) ?? []).length, 2, 'the name injected a tag');
});

test('a missing name falls back to "player"', () => {
  assert.match(welcomeMessage({}, { network: 'testnet' }).text, /welcome, player\./);
  assert.match(welcomeMessage({ first_name: '' }, { network: 'testnet' }).text, /welcome, player\./);
});

test('escapeHtml escapes exactly the three characters HTML mode needs', () => {
  assert.equal(escapeHtml('a & b < c > d "e" \'f\''), 'a &amp; b &lt; c &gt; d "e" \'f\'');
});
