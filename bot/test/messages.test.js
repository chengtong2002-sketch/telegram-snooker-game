import test from 'node:test';
import assert from 'node:assert/strict';

import { SHOT_CLOCK_MS } from '@snooker/sim';
import {
  escapeHtml, html,
  welcomeMessage, helpMessage, leaderboardMessage, walletLinkedMessage, walletUnlinkedMessage,
  statusMessage, statusMatchMessage,
  matchedMessage, yourTurnMessage, frameCheckpointMessage, matchOverMessage, walletChangedMessage,
} from '../src/messages.js';

/**
 * A value that would break every format at once: an HTML tag, an entity, and
 * each character legacy Markdown treats as markup. Under Markdown an underscore
 * or asterisk in a name made Telegram reject the whole message.
 */
const HOSTILE = '<b>Al_ex*</b> & `co` [x](y)';
const ESCAPED = '&lt;b&gt;Al_ex*&lt;/b&gt; &amp; `co` [x](y)';

const ALLOWED_TAGS = ['b', 'i', 'code'];

/** What every message must satisfy, whatever went into it. */
function assertWellFormed(label, msg) {
  assert.equal(msg.parse_mode, 'HTML', `${label}: parse_mode`);
  const { text } = msg;
  assert.ok(!text.includes('\\n'), `${label}: literal \\n`);
  assert.ok(!text.includes('\r'), `${label}: carriage return`);
  assert.doesNotMatch(text, /\n{3,}/, `${label}: more than one blank line`);
  assert.ok(!text.startsWith('\n') && !text.endsWith('\n'), `${label}: blank line at an end`);
  for (const line of text.split('\n')) assert.doesNotMatch(line, /^\s/, `${label}: continuation line "${line}"`);
  // Every raw tag is one Telegram accepts, and they balance.
  for (const [, name] of text.matchAll(/<\/?([a-z]+)[^>]*>/g)) {
    assert.ok(ALLOWED_TAGS.includes(name), `${label}: unexpected <${name}>`);
  }
  for (const name of ALLOWED_TAGS) {
    const open = (text.match(new RegExp(`<${name}>`, 'g')) ?? []).length;
    const close = (text.match(new RegExp(`</${name}>`, 'g')) ?? []).length;
    assert.equal(open, close, `${label}: <${name}> unbalanced`);
  }
  // A bare & must be the start of an entity, or Telegram rejects the message.
  assert.doesNotMatch(text, /&(?!amp;|lt;|gt;)/, `${label}: unescaped &`);
}

/** Every message, built with HOSTILE in each field that comes from outside. */
const ALL = {
  welcome: () => welcomeMessage({ first_name: HOSTILE }, { network: HOSTILE }),
  help: () => helpMessage(),
  'leaderboard (username)': () => leaderboardMessage([{ username: HOSTILE, best_break: 12 }]),
  'leaderboard (first name)': () => leaderboardMessage([{ username: null, first_name: HOSTILE, best_break: 12 }]),
  'wallet linked': () => walletLinkedMessage({ address: `EQ${HOSTILE}${HOSTILE}`, network: HOSTILE }),
  'wallet unlinked': () => walletUnlinkedMessage({ network: HOSTILE }),
  status: () => statusMessage({
    user: { id: 1, bestBreak: 64, framesWon: 3, framesPlayed: 5 },
    wallet: { address: HOSTILE, network: HOSTILE },
    rewards: { points: 11, budget: 1000, totalPoints: 40, tokens: 250, capped: true },
    claims: {
      totalTokens: 250,
      periods: [{ claimable: true, startsAt: '2026-09-22T00:00:00Z', expiresAt: '2026-10-22T00:00:00Z', tokens: 250 }],
    },
  }),
  'status match': () => statusMatchMessage({ id: HOSTILE, framesWon: [1, 0] }, { yours: true }),
  matched: () => matchedMessage({ yourTurn: true }),
  'your turn (foul)': () => yourTurnMessage({ lastShot: { foul: true, foulReasons: ['miss'], penalty: 4 }, scores: [3, 9] }),
  'your turn (new frame)': () => yourTurnMessage({ newFrame: 2, scores: [0, 0] }),
  'frame checkpoint (trailing)': () => frameCheckpointMessage({ trailing: true, frame: 1, framesWon: [0, 1], seconds: 60 }),
  'frame checkpoint (leading)': () => frameCheckpointMessage({ trailing: false, frame: 1, framesWon: [1, 0], seconds: 60 }),
  'match over (eligible)': () => matchOverMessage({ won: true, framesWon: [2, 1], eligibleBreak: 23 }),
  'match over (limited)': () => matchOverMessage({
    won: false, framesWon: [1, 2], rewardLimit: { reason: 'daily-pair-cap', breakValue: 9, limit: 3 },
  }),
  'wallet changed': () => walletChangedMessage({ action: 'linked', address: HOSTILE, network: HOSTILE }, { supportHandle: HOSTILE }),
  'wallet unlinked (notice)': () => walletChangedMessage({ action: 'unlinked', address: HOSTILE, network: HOSTILE }, { supportHandle: HOSTILE }),
};

test('every message is well-formed HTML even with hostile values in every field', () => {
  for (const [label, build] of Object.entries(ALL)) assertWellFormed(label, build());
});

test('a hostile value never reaches Telegram as markup', () => {
  for (const [label, build] of Object.entries(ALL)) {
    const { text } = build();
    assert.ok(!text.includes(HOSTILE.slice(0, 11)), `${label}: raw "<b>Al_ex*</b>" survived`);
  }
});

test('no Markdown markup is left in any message', () => {
  // Built with plain values, so any * or ` in the output is a leftover marker
  // that would now show up literally.
  const plain = {
    ...ALL,
    welcome: () => welcomeMessage({ first_name: 'Nick' }, { network: 'testnet' }),
    'leaderboard (username)': () => leaderboardMessage([{ username: 'nick', best_break: 12 }]),
    'leaderboard (first name)': () => leaderboardMessage([{ username: null, first_name: 'Nick', best_break: 12 }]),
    'wallet linked': () => walletLinkedMessage({ address: 'EQDzWYEn1r4XzSHoAqLqQJSSWJCApmqRZ', network: 'testnet' }),
    'wallet unlinked': () => walletUnlinkedMessage({ network: 'testnet' }),
    status: () => statusMessage({ user: { bestBreak: 1, framesWon: 1, framesPlayed: 1 }, wallet: null }),
    'status match': () => statusMatchMessage({ id: 'abcdef1234', framesWon: [1, 0] }, { yours: true }),
    'wallet changed': () => walletChangedMessage({ action: 'linked', address: 'EQabc', network: 'testnet' }, { supportHandle: '@help' }),
    'wallet unlinked (notice)': () => walletChangedMessage({ action: 'unlinked', address: 'EQabc', network: 'testnet' }),
  };
  for (const [label, build] of Object.entries(plain)) {
    assert.doesNotMatch(build().text, /[*`]/, `${label}: Markdown marker left in`);
  }
});

/* ---------- /start ---------- */

const welcome = (first_name) => welcomeMessage({ first_name }, { network: 'testnet' });

test('no welcome sentence is wrapped across two lines', () => {
  // Telegram breaks at every newline, so a source-wrapped sentence shows up as
  // a ragged break mid-sentence on the phone.
  for (const line of welcome('Nick').text.split('\n').filter((l) => l !== '')) {
    assert.match(line, /[.!?]$/, `line does not end a sentence: "${line}"`);
  }
});

test('the welcome says what it always said', () => {
  const { text } = welcome('Nick');
  assert.match(text, /welcome, Nick\./);
  assert.match(text, new RegExp(`${SHOT_CLOCK_MS / 1000}-second shot clock`));
  for (const cmd of ['/practice', '/play', '/wallet', '/leaderboard']) assert.ok(text.includes(cmd), cmd);
  assert.match(text, /Rewards run on <b>testnet<\/b>/);
  assert.match(text, /nothing to stake, nothing to lose\./);
});

test('the welcome escapes a hostile name', () => {
  assert.ok(welcome(HOSTILE).text.includes(`welcome, ${ESCAPED}.`));
});

test('a missing name falls back to "player"', () => {
  assert.match(welcomeMessage({}, { network: 'testnet' }).text, /welcome, player\./);
  assert.match(welcome('').text, /welcome, player\./);
});

/* ---------- /help ---------- */

test('/help lists every command, and the foul list is one line', () => {
  const { text } = helpMessage();
  for (const cmd of ['/practice', '/play', '/cancel', '/wallet', '/leaderboard', '/status']) assert.ok(text.includes(cmd), cmd);
  assert.ok(text.includes('missing everything · hitting the wrong ball first · potting the cue ball · knocking a ball off the table.'));
});

/* ---------- /leaderboard ---------- */

test('/leaderboard escapes a hostile username and first name', () => {
  const byHandle = leaderboardMessage([{ username: HOSTILE, best_break: 12 }]).text;
  assert.ok(byHandle.includes(`🥇 @${ESCAPED} — break <b>12</b>`));
  const byName = leaderboardMessage([{ first_name: HOSTILE, best_break: 7 }]).text;
  assert.ok(byName.includes(`🥇 ${ESCAPED} — break <b>7</b>`));
});

test('/leaderboard keeps an underscore in a handle as it is', () => {
  // Markdown needed "\_" here, and a missed one failed the send. HTML needs nothing.
  assert.ok(leaderboardMessage([{ username: 'snooker_king', best_break: 30 }]).text.includes('@snooker_king'));
});

test('/leaderboard numbers ranks past the medals and falls back to "Player"', () => {
  const rows = [1, 2, 3, 4].map((i) => ({ username: `p${i}`, best_break: 50 - i }));
  rows.push({ username: null, first_name: null, best_break: 1 });
  const { text } = leaderboardMessage(rows);
  assert.match(text, /🥇 @p1/);
  assert.match(text, /🥉 @p3/);
  assert.match(text, /4\. @p4/);
  assert.match(text, /5\. Player — break <b>1<\/b>/);
});

/* ---------- /wallet ---------- */

test('/wallet shortens the address inside <code> and escapes what it shows', () => {
  const addr = 'EQDzWYEn1r4XzSHoAqLqQJSSWJCApmqRZyKH3CDT5_gxSvvQ';
  assert.ok(walletLinkedMessage({ address: addr, network: 'testnet' }).text
    .includes('👛 Linked wallet (testnet): <code>EQDzWY…gxSvvQ</code>'));
  const hostile = walletLinkedMessage({ address: `<b>A&${'x'.repeat(20)}<i>`, network: HOSTILE }).text;
  // First six characters "<b>A&x", last six "xxx<i>", each escaped.
  assert.ok(hostile.includes('<code>&lt;b&gt;A&amp;x…xxx&lt;i&gt;</code>'));
  assert.ok(hostile.includes(`(${ESCAPED})`));
});

test('/wallet with nothing linked names the network', () => {
  assert.match(walletUnlinkedMessage({ network: 'testnet' }).text, /TON Connect on <b>testnet<\/b>/);
});

/* ---------- /status ---------- */

test('/status escapes the wallet address and network, and keeps the numbers', () => {
  const { text } = ALL.status();
  assert.ok(text.includes(`Wallet: <code>${escapeHtml(HOSTILE.slice(0, 8))}…</code> (${ESCAPED})`));
  assert.ok(text.includes('Best break: <b>64</b>'));
  assert.ok(text.includes('Provisional payout: <b>250.0000</b> tokens (share capped)'));
  assert.ok(text.includes('<b>Unclaimed rewards: 250.0000 tokens</b>'));
  assert.ok(text.includes('• 2026-09-22 period: 250.0000 tokens, claim by 2026-10-22'));
});

test('/status per-match line escapes the match id', () => {
  const { text } = statusMatchMessage({ id: '<i>d</i>12345', framesWon: [1, 0] }, { yours: false });
  // The first eight characters are the whole "<i>d</i>".
  assert.equal(text, 'Match <code>&lt;i&gt;d&lt;/i&gt;</code> — frames 1–0, waiting on your opponent');
});

/* ---------- notifications ---------- */

test('your-turn describes the foul and the score', () => {
  const { text } = ALL['your turn (foul)']();
  assert.equal(text, [
    '🎱 <b>Your shot.</b>',
    'They missed everything — <b>4 points to you</b>.',
    `Score 3–9 · ${SHOT_CLOCK_MS / 1000}s on the clock.`,
  ].join('\n'));
});

test('your-turn with no last shot leaves no empty line', () => {
  const { text } = yourTurnMessage({ scores: [0, 0], secondsToShoot: 30 });
  assert.equal(text, '🎱 <b>Your shot.</b>\nScore 0–0 · 30s on the clock.');
});

test('frame checkpoint counts the next frame as a number, even from a string', () => {
  // "1" + 1 would have been "11" under the old template.
  assert.match(frameCheckpointMessage({ trailing: true, frame: '1', framesWon: [0, 1], seconds: 60 }).text, /Continue to frame 2,/);
});

test('match over keeps the eligible-break sentence on one line', () => {
  assert.ok(ALL['match over (eligible)']().text
    .includes("Your highest break was <b>23</b> — that is this match's reward-eligible score."));
});

test('wallet-changed shows a support handle with its underscore, escaped', () => {
  const plain = walletChangedMessage({ action: 'linked', address: 'EQabc', network: 'testnet' }, { supportHandle: '@snooker_help' }).text;
  assert.ok(plain.includes('contact @snooker_help right away'), 'handle mangled');
  assert.ok(!plain.includes('\\_'), 'Markdown escape left in');
  const hostile = ALL['wallet changed']().text;
  assert.ok(hostile.includes(`contact ${ESCAPED} right away — someone may have access`));
});

test('wallet-changed without a support handle still says what to do', () => {
  assert.match(walletChangedMessage({ action: 'unlinked', address: 'EQabc', network: 'testnet' }).text, /contact support right away\./);
});

/* ---------- the helpers ---------- */

test('escapeHtml escapes exactly the three characters HTML mode needs', () => {
  assert.equal(escapeHtml('a & b < c > d "e" \'f\''), 'a &amp; b &lt; c &gt; d "e" \'f\'');
});

test('html`` escapes every value and leaves the literal markup alone', () => {
  assert.equal(html`<b>${'<i>'}</b> ${null} ${undefined} ${0}`, '<b>&lt;i&gt;</b>   0');
});
