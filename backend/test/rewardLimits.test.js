import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { useTestDatabase } from '@snooker/db/testing';

// Capture what the backend sends the bot.
const botEvents = [];
const botStub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    botEvents.push(JSON.parse(body || '{}'));
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
}).listen(0);
await new Promise((r) => botStub.once('listening', r));

const dropTestDatabase = await useTestDatabase('limits');
process.env.NODE_ENV = 'test';
process.env.ALLOW_DEV_AUTH = 'true';
process.env.REWARD_PERIOD_KIND = 'daily';
process.env.REWARD_MIN_POINTS = '10';
process.env.REWARD_LIMIT_EXEMPT_TELEGRAM_IDS = '9001, 9002';
process.env.BOT_NOTIFY_URL = `http://127.0.0.1:${botStub.address().port}/internal/notify`;

const { getDb, closeDb, migrate, upsertUser } = await import('@snooker/db');
const {
  recordEligibleBreak, redeem, DAILY_ELIGIBLE_MATCH_CAP, DAILY_PAIR_MATCH_CAP, WALLET_CLAIM_COOLDOWN_MS,
} = await import('../src/services/rewards.js');
const { setPayoutWallet, removePayoutWallet } = await import('../src/services/wallets.js');
const { joinQueue } = await import('../src/services/matchmaking.js');
const { buildApp } = await import('../src/app.js');
const { newMatch } = await import('@snooker/sim');

await migrate();
const knex = getDb();
const server = buildApp({ requestLogging: false }).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  server.close();
  botStub.close();
  await closeDb();
  await dropTestDatabase();
});

let nextTg = 100;
const newUser = async (telegramId = nextTg++) => upsertUser({ id: telegramId, first_name: `U${telegramId}` });

let nextMatch = 0;
/** A finished PvP match in which `owner` made the match's highest break against `opponent`. */
async function play(owner, opponent, { breakValue = 20, now } = {}) {
  nextMatch += 1;
  const id = `lim-${nextMatch}`;
  await knex('matches').insert({
    id, mode: 'pvp', player_a: owner.id, player_b: opponent.id, status: 'completed', state: '{}', crypto_eligible: true,
  });
  const state = { ...newMatch([owner.id, opponent.id]), highBreaks: [breakValue, 0], ended: true, winner: 0 };
  const result = await recordEligibleBreak({ id, crypto_eligible: true }, state, { now });
  return { id, result };
}

const DAY = '2026-09-15';
const at = (time) => new Date(`${DAY}T${time}Z`);

test('the limits are 15 matches a day and 3 per opponent a day', () => {
  assert.equal(DAILY_ELIGIBLE_MATCH_CAP, 15);
  assert.equal(DAILY_PAIR_MATCH_CAP, 3);
  assert.equal(WALLET_CLAIM_COOLDOWN_MS, 24 * 60 * 60 * 1000);
});

test('the 16th eligible match in a UTC day earns nothing, and the match is marked why', async () => {
  const farmer = await newUser();
  for (let i = 0; i < 15; i += 1) {
    const { result } = await play(farmer, await newUser(), { now: at('10:00:00') });
    assert.equal(result.breakValue, 20, `match ${i + 1} should count`);
  }
  const { id, result } = await play(farmer, await newUser(), { now: at('23:59:59.999') });
  assert.equal(result.breakValue, 0);
  assert.equal(result.blockedBreak, 20);
  assert.equal(result.ineligibleReason, 'daily-match-cap');

  assert.equal(await knex('eligible_breaks').where({ match_id: id }).first(), undefined, 'no reward row');
  assert.equal((await knex('matches').where({ id }).first()).ineligible_reason, 'daily-match-cap');
  const user = await knex('users').where({ id: farmer.id }).first();
  assert.equal(user.lifetime_eligible_points, 15 * 20, 'withheld break adds no points');

  // A replay of the capped result stays capped.
  const replay = await recordEligibleBreak(
    { id, crypto_eligible: true },
    { ...newMatch([farmer.id, 0]), highBreaks: [20, 0], ended: true, winner: 0 },
    { now: at('23:59:59.999') },
  );
  assert.equal(replay.ineligibleReason, 'daily-match-cap');

  // The limit is per UTC calendar day: 00:00 UTC resets it.
  const tomorrow = await play(farmer, await newUser(), { now: new Date('2026-09-16T00:00:00Z') });
  assert.equal(tomorrow.result.breakValue, 20);
});

test('a capped player\'s opponent still earns their own break', async () => {
  const capped = await newUser();
  for (let i = 0; i < 15; i += 1) await play(capped, await newUser(), { now: at('09:00:00') });
  const rival = await newUser();
  const { result } = await play(rival, capped, { now: at('09:30:00') });
  assert.equal(result.breakValue, 20, 'the cap belongs to whoever made the break');
});

test('a 4th eligible match between the same two players in a day earns nothing', async () => {
  const a = await newUser();
  const b = await newUser();
  // Whoever makes the break, all three count toward the same pair.
  assert.equal((await play(a, b, { now: at('08:00:00') })).result.breakValue, 20);
  assert.equal((await play(b, a, { now: at('08:10:00') })).result.breakValue, 20);
  assert.equal((await play(a, b, { now: at('08:20:00') })).result.breakValue, 20);
  const fourth = await play(b, a, { now: at('08:30:00') });
  assert.equal(fourth.result.ineligibleReason, 'daily-pair-cap');

  const c = await newUser();
  assert.equal((await play(a, c, { now: at('08:40:00') })).result.breakValue, 20, 'other opponents are unaffected');
  assert.equal((await play(a, b, { now: new Date('2026-09-16T00:00:01Z') })).result.breakValue, 20, 'resets at 00:00 UTC');
});

test('a whitelisted test account skips both limits', async () => {
  const tester = await newUser(9001);
  const partner = await newUser();
  for (let i = 0; i < DAILY_ELIGIBLE_MATCH_CAP + 2; i += 1) {
    const { result } = await play(tester, partner, { now: at('12:00:00') });
    assert.equal(result.breakValue, 20, `whitelisted match ${i + 1} should count`);
  }
  // The exemption follows the break's owner: the partner is not whitelisted.
  const partnerBreak = await play(partner, tester, { now: at('12:30:00') });
  assert.equal(partnerBreak.result.ineligibleReason, 'daily-pair-cap');
});

test('hitting a limit never stops a player from being matched', async () => {
  const capped = await newUser();
  for (let i = 0; i < 15; i += 1) await play(capped, await newUser(), { now: new Date() });
  const other = await newUser();

  assert.equal((await joinQueue(capped.id)).status, 'queued');
  const paired = await joinQueue(other.id);
  assert.equal(paired.status, 'matched');
  const match = await knex('matches').where({ id: paired.matchId }).first();
  assert.equal(match.status, 'active');
  assert.equal(Boolean(match.crypto_eligible), true, 'the match itself is a normal PvP match');
  await knex('matches').where({ id: paired.matchId }).update({ status: 'completed' });
});

test('end to end: a capped player plays a match to the end, and the bot is told why it did not count', async () => {
  const call = async (p, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const login = async (tg) => (await call('/api/auth/telegram', { method: 'POST', body: { devUser: { id: tg, first_name: `E${tg}` } } })).body;
  const owner = await login(7001);
  const opponent = await login(7002);
  for (let i = 0; i < 15; i += 1) {
    await play({ id: owner.user.id }, await newUser(), { now: new Date() });
  }

  await call('/api/match/queue', { method: 'POST', token: owner.token });
  const { body } = await call('/api/match/queue', { method: 'POST', token: opponent.token });
  assert.ok(body.matchId, 'the capped player is matched normally');

  // The owner made a 30 in the unfinished frame; the opponent concedes.
  const row = await knex('matches').where({ id: body.matchId }).first();
  const state = JSON.parse(row.state);
  state.frame.highBreaks = [Number(state.players[0]) === Number(owner.user.id) ? 30 : 0, 0];
  if (Number(state.players[1]) === Number(owner.user.id)) state.frame.highBreaks = [0, 30];
  await knex('matches').where({ id: body.matchId }).update({ state: JSON.stringify(state) });

  botEvents.length = 0;
  const res = await call(`/api/match/${body.matchId}/concede`, { method: 'POST', token: opponent.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.match.ended, true);

  const done = await knex('matches').where({ id: body.matchId }).first();
  assert.equal(done.status, 'completed');
  assert.equal(done.ineligible_reason, 'daily-match-cap');
  assert.equal(await knex('eligible_breaks').where({ match_id: body.matchId }).first(), undefined);

  await new Promise((r) => setTimeout(r, 100));
  const toOwner = botEvents.find((e) => e.type === 'match-over' && Number(e.userId) === Number(owner.user.id));
  const toOpponent = botEvents.find((e) => e.type === 'match-over' && Number(e.userId) === Number(opponent.user.id));
  assert.deepEqual(toOwner.rewardLimit, { reason: 'daily-match-cap', breakValue: 30, limit: 15 });
  assert.equal(toOwner.eligibleBreak, 0);
  assert.equal(toOpponent.rewardLimit, null, 'only the player whose break was withheld is told');
});

test('quitting over and over cannot farm rewards past the daily limits', async () => {
  // Two players collude: one makes a break, the other quits at once (the pause
  // menu's Quit match is a concede with via "quit"). Each quit ends a real
  // match through the normal path, so the normal limits apply to it.
  const call = async (p, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const login = async (tg) => (await call('/api/auth/telegram', { method: 'POST', body: { devUser: { id: tg, first_name: `Q${tg}` } } })).body;

  /** Pair the two, give `farmer` a 25 in the open frame, and have `quitter` quit. */
  const quitAgainst = async (farmer, quitter) => {
    await call('/api/match/queue', { method: 'POST', token: farmer.token });
    const { body } = await call('/api/match/queue', { method: 'POST', token: quitter.token });
    assert.ok(body.matchId, 'paired');
    const row = await knex('matches').where({ id: body.matchId }).first();
    const state = JSON.parse(row.state);
    const farmerSeat = state.players.findIndex((p) => Number(p) === Number(farmer.user.id));
    state.frame.highBreaks = farmerSeat === 0 ? [25, 0] : [0, 25];
    await knex('matches').where({ id: body.matchId }).update({ state: JSON.stringify(state) });

    botEvents.length = 0;
    const res = await call(`/api/match/${body.matchId}/concede`, { method: 'POST', token: quitter.token, body: { via: 'quit' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.match.ended, true);
    assert.equal(Number(res.body.match.players[res.body.match.winner]), Number(farmer.user.id), 'the opponent of whoever quit wins');
    await new Promise((r) => setTimeout(r, 50));
    return { matchId: body.matchId, events: [...botEvents] };
  };

  const farmer = await login(7101);
  const partner = await login(7102);

  // The same pair: 3 count, the 4th is refused on the pair limit.
  for (let i = 1; i <= 4; i += 1) {
    const { matchId, events } = await quitAgainst(farmer, partner);
    const done = await knex('matches').where({ id: matchId }).first();
    const earned = await knex('eligible_breaks').where({ match_id: matchId }).first();
    if (i <= DAILY_PAIR_MATCH_CAP) {
      assert.equal(earned?.break_value, 25, `quit ${i} counts like any finished match`);
    } else {
      assert.equal(earned, undefined, `quit ${i} earns nothing`);
      assert.equal(done.ineligible_reason, 'daily-pair-cap');
    }
    // Both players are messaged, and the one who did not quit hears that they won.
    const toFarmer = events.find((e) => e.type === 'match-over' && Number(e.userId) === Number(farmer.user.id));
    const toPartner = events.find((e) => e.type === 'match-over' && Number(e.userId) === Number(partner.user.id));
    assert.equal(toFarmer.won, true);
    assert.equal(toFarmer.conceded, true);
    assert.equal(toFarmer.youConceded, false);
    assert.equal(toPartner.youConceded, true);
  }

  // New partners each time: 15 a day in all, then nothing.
  for (let i = DAILY_PAIR_MATCH_CAP + 1; i <= DAILY_ELIGIBLE_MATCH_CAP + 1; i += 1) {
    const { matchId } = await quitAgainst(farmer, await login(7200 + i));
    const earned = await knex('eligible_breaks').where({ match_id: matchId }).first();
    if (i <= DAILY_ELIGIBLE_MATCH_CAP) assert.equal(earned?.break_value, 25, `match ${i} of the day counts`);
    else assert.equal((await knex('matches').where({ id: matchId }).first()).ineligible_reason, 'daily-match-cap');
  }

  const total = await knex('eligible_breaks').where({ user_id: farmer.user.id }).sum({ points: 'break_value' }).first();
  assert.equal(Number(total.points), DAILY_ELIGIBLE_MATCH_CAP * 25, 'never more than 15 eligible matches in the day');
});

/** A closed period in which `user` holds `points` eligible points. */
async function closedPeriodWithPoints(user, points) {
  const starts = new Date(Date.now() - 3 * 86_400_000 - Math.floor(Math.random() * 1e6));
  const [{ id: periodId }] = await knex('reward_periods').insert({
    kind: 'daily', starts_at: starts, ends_at: new Date(starts.getTime() + 86_400_000), budget_tokens: 1000,
  }).returning('id');
  nextMatch += 1;
  const matchId = `cool-${nextMatch}`;
  await knex('matches').insert({ id: matchId, mode: 'pvp', status: 'completed', state: '{}', crypto_eligible: true });
  await knex('eligible_breaks').insert({
    match_id: matchId, user_id: user.id, period_id: periodId, break_value: points, award_day: '2026-09-01',
  });
  return periodId;
}

const ADDR_A = 'EQAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR_B = 'EQAbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

test('a wallet change blocks claims for 24 hours and messages the player', async () => {
  const player = await newUser();
  botEvents.length = 0;

  const first = await setPayoutWallet(player.id, { address: ADDR_A, network: 'testnet' });
  assert.equal(first.changed, true, 'a first link counts as a change');

  const periodId = await closedPeriodWithPoints(player, 40);
  const blocked = await redeem({ userId: player.id, periodId, requestId: `cool-${player.id}-1` });
  assert.equal(blocked.status, 'error');
  assert.match(blocked.reason, /wallet changed recently — claims unlock at/);

  await new Promise((r) => setTimeout(r, 100));
  const msg = botEvents.find((e) => e.type === 'wallet-changed' && Number(e.userId) === Number(player.id));
  assert.equal(msg.action, 'linked');
  assert.equal(msg.address, ADDR_A);

  // 24h later the claim goes through.
  await knex('users').where({ id: player.id }).update({ wallet_changed_at: new Date(Date.now() - WALLET_CLAIM_COOLDOWN_MS - 1000) });
  const ok = await redeem({ userId: player.id, periodId, requestId: `cool-${player.id}-2` });
  assert.equal(ok.status, 'queued');
});

test('re-proving the same wallet does not restart the cooldown or message anyone', async () => {
  const player = await newUser();
  await setPayoutWallet(player.id, { address: ADDR_A, network: 'testnet' });
  const past = new Date(Date.now() - WALLET_CLAIM_COOLDOWN_MS - 1000);
  await knex('users').where({ id: player.id }).update({ wallet_changed_at: past });
  botEvents.length = 0;

  const again = await setPayoutWallet(player.id, { address: ADDR_A, network: 'testnet' });
  assert.equal(again.changed, false);
  const periodId = await closedPeriodWithPoints(player, 40);
  assert.equal((await redeem({ userId: player.id, periodId, requestId: `same-${player.id}` })).status, 'queued');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(botEvents.filter((e) => e.type === 'wallet-changed').length, 0);
});

test('switching to a different wallet restarts the cooldown; unlinking messages the player', async () => {
  const player = await newUser();
  await setPayoutWallet(player.id, { address: ADDR_A, network: 'testnet' });
  await knex('users').where({ id: player.id }).update({ wallet_changed_at: new Date(Date.now() - 2 * WALLET_CLAIM_COOLDOWN_MS) });

  const switched = await setPayoutWallet(player.id, { address: ADDR_B, network: 'testnet' });
  assert.equal(switched.changed, true);
  const periodId = await closedPeriodWithPoints(player, 40);
  assert.equal((await redeem({ userId: player.id, periodId, requestId: `switch-${player.id}` })).status, 'error');

  botEvents.length = 0;
  assert.deepEqual(await removePayoutWallet(player.id), { removed: true });
  await new Promise((r) => setTimeout(r, 100));
  const msg = botEvents.find((e) => e.type === 'wallet-changed');
  assert.equal(msg.action, 'unlinked');
  assert.equal(msg.address, ADDR_B);
});

test('a whitelisted test account can claim straight after linking', async () => {
  const tester = await newUser(9002);
  await setPayoutWallet(tester.id, { address: ADDR_A, network: 'testnet' });
  const periodId = await closedPeriodWithPoints(tester, 40);
  assert.equal((await redeem({ userId: tester.id, periodId, requestId: `exempt-${tester.id}` })).status, 'queued');
});
