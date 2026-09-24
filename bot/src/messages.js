/**
 * Every formatted text the bot sends, kept apart from the handlers so each can
 * be tested without a bot, a database or a config.
 *
 * HTML, not Markdown: in HTML only <, > and & are special, so any value can be
 * escaped completely. Under legacy Markdown a name or handle with an underscore
 * or asterisk made Telegram reject the whole message, and the player got
 * nothing.
 *
 * Build text with the html`` tag below: it escapes every interpolated value,
 * so a name, handle, address or anything else from outside cannot open a tag.
 * Markup belongs in the literal parts only.
 *
 * One source line per line the player sees: Telegram breaks the text wherever a
 * newline is, so a sentence must never be wrapped across two source lines — the
 * phone wraps it to the screen by itself.
 */
import { SHOT_CLOCK_MS } from '@snooker/sim';

const PARSE_MODE = 'HTML';

/** Escape text for Telegram's HTML parse mode. */
export const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

/** Template tag: literal parts are markup, every ${value} is escaped. */
export const html = (strings, ...values) => strings.reduce(
  (out, s, i) => out + s + (i < values.length ? escapeHtml(values[i] ?? '') : ''),
  '',
);

const message = (lines) => ({ text: lines.filter((l) => l !== null).join('\n'), parse_mode: PARSE_MODE });

const shortAddress = (a = '') => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-6)}` : a);
const nameOf = (row) => (row.username ? `@${row.username}` : (row.first_name || 'Player'));

/* ---------- commands ---------- */

/** /start. */
export function welcomeMessage(from, { network }) {
  return message([
    html`🎱 <b>Snooker</b> — welcome, ${from?.first_name || 'player'}.`,
    '',
    html`Best of 3 frames, full 22-ball table, ${SHOT_CLOCK_MS / 1000}-second shot clock.`,
    '',
    '• /practice — play the AI. Free, unranked, <i>not</i> reward-eligible.',
    '• /play — get matched with a real opponent. Turn-based: you take your shot, I ping them, they take theirs.',
    '• /wallet — link a TON wallet so rewards have somewhere to land.',
    '• /leaderboard — highest breaks this period.',
    '',
    html`Rewards run on <b>${network}</b> and come out of a capped pool — the more points everyone earns in a period, the less each point pays. Skill only: nothing to stake, nothing to lose.`,
  ]);
}

/** /help. */
export function helpMessage() {
  return message([
    '<b>Commands</b>',
    '/practice — solo vs AI (not reward-eligible)',
    '/play — join the matchmaking queue',
    '/cancel — leave the queue',
    '/wallet — link or view your TON wallet',
    '/leaderboard — top breaks this period',
    '/status — your matches and reward standing',
    '',
    '<b>Fouls</b> — 4 points minimum, turn passes:',
    'missing everything · hitting the wrong ball first · potting the cue ball · knocking a ball off the table.',
  ]);
}

/** /leaderboard, for rows that exist (the empty board is plain text). */
export function leaderboardMessage(rows) {
  const medal = ['🥇', '🥈', '🥉'];
  return message([
    '🏆 <b>Highest breaks</b> — PvP only',
    '',
    ...rows.map((r, i) => html`${medal[i] ?? `${i + 1}.`} ${nameOf(r)} — break <b>${r.best_break}</b>`),
  ]);
}

/** /wallet when one is linked. */
export function walletLinkedMessage(wallet) {
  return message([
    html`👛 Linked wallet (${wallet.network}): <code>${shortAddress(wallet.address)}</code>`,
    '',
    'Open the wallet screen to change it.',
  ]);
}

/** /wallet when none is linked yet. */
export function walletUnlinkedMessage({ network }) {
  return message([
    'No wallet linked yet.',
    '',
    html`Linking uses TON Connect on <b>${network}</b>: you sign a proof of ownership.`,
    'Nothing is transferred, and the bot never sees a seed phrase.',
  ]);
}

/** /status summary, from the backend's status payload. */
export function statusMessage(s) {
  const lines = [
    html`Best break: <b>${s.user.bestBreak}</b>`,
    html`Frames: <b>${s.user.framesWon}</b> won of <b>${s.user.framesPlayed}</b>`,
    s.wallet
      ? html`Wallet: <code>${s.wallet.address.slice(0, 8)}…</code> (${s.wallet.network})`
      : 'Wallet: not linked',
  ];
  if (s.rewards) {
    lines.push(
      '',
      html`This period: <b>${s.rewards.points}</b> eligible points`,
      html`Pool: <b>${s.rewards.budget}</b> tokens across <b>${s.rewards.totalPoints}</b> points`,
      html`Provisional payout: <b>${s.rewards.tokens.toFixed(4)}</b> tokens${s.rewards.capped ? ' (share capped)' : ''}`,
    );
  }
  const open = (s.claims?.periods ?? []).filter((p) => p.claimable);
  if (open.length) {
    const day = (iso) => new Date(iso).toISOString().slice(0, 10);
    lines.push('', html`<b>Unclaimed rewards: ${Number(s.claims.totalTokens).toFixed(4)} tokens</b>`);
    for (const p of open.slice(0, 5)) {
      lines.push(html`• ${day(p.startsAt)} period: ${p.tokens.toFixed(4)} tokens, claim by ${day(p.expiresAt)}`);
    }
    if (open.length > 5) lines.push(html`• …and ${open.length - 5} more`);
    lines.push('Claim them from /wallet. Unclaimed rewards expire.');
  }
  return message(lines);
}

/** One of /status's per-match lines. */
export function statusMatchMessage(m, { yours }) {
  return message([
    html`Match <code>${m.id.slice(0, 8)}</code> — frames ${m.framesWon[0]}–${m.framesWon[1]}, `
      + (yours ? '<b>your shot</b>' : 'waiting on your opponent'),
  ]);
}

/* ---------- notifications (backend → bot → player) ---------- */

const FOUL_TEXT = {
  miss: 'missed everything',
  'wrong-ball-first': 'hit the wrong ball first',
  'cue-ball-potted': 'potted the cue ball',
  'ball-off-table': 'knocked a ball off the table',
  'wrong-ball-potted': 'potted the wrong ball',
  'multiple-colours-potted': 'potted two colours at once',
  'shot-clock-expired': 'ran out of shot clock',
};

function describeLastShot(lastShot) {
  if (!lastShot) return null;
  if (lastShot.foul) {
    const reason = FOUL_TEXT[lastShot.foulReasons?.[0]] ?? 'fouled';
    return html`They ${reason} — <b>${lastShot.penalty} points to you</b>.`;
  }
  if (lastShot.breakValue > 0) return html`Their break ended on <b>${lastShot.breakValue}</b>.`;
  return 'They came up empty.';
}

/** "matched": an opponent was found. */
export function matchedMessage(event) {
  return message([
    event.yourTurn
      ? '⚔️ Opponent found — <b>you break</b>. Best of 3.'
      : '⚔️ Opponent found. They break; I will ping you when it is your shot.',
  ]);
}

/** "your-turn". */
export function yourTurnMessage(event) {
  return message([
    '🎱 <b>Your shot.</b>',
    event.newFrame ? html`Frame ${event.newFrame} is racked — you break.` : describeLastShot(event.lastShot),
    html`Score ${event.scores?.[0] ?? 0}–${event.scores?.[1] ?? 0} · ${event.secondsToShoot ?? SHOT_CLOCK_MS / 1000}s on the clock.`,
  ]);
}

/** "frame-checkpoint": between frames, after one leaves it 1-0. */
export function frameCheckpointMessage(event) {
  const score = `${event.framesWon?.[0] ?? 0}–${event.framesWon?.[1] ?? 0}`;
  const next = Number(event.frame) + 1;
  return message(event.trailing
    ? [
      html`🎱 <b>Frame ${event.frame} complete</b> — your opponent leads ${score}.`,
      html`Continue to frame ${next}, or concede the match?`,
      html`Frame ${next} starts automatically in ${event.seconds}s if you do not choose.`,
      'Conceding never cancels a break you have already made.',
    ]
    : [
      html`🎱 <b>Frame ${event.frame} is yours</b> — you lead ${score}.`,
      html`Your opponent can continue or concede. Frame ${next} starts within ${event.seconds}s.`,
    ]);
}

/** "match-over". */
export function matchOverMessage(event) {
  let headline = event.won ? '🏆 <b>You won the match.</b>' : 'Match over — your opponent took it.';
  if (event.conceded && event.forfeit === 'idle') {
    headline = event.youConceded
      ? 'You forfeited the match — your shot clock ran out 3 times in a row.'
      : '🏆 <b>You won — your opponent stopped playing</b> (3 shot clocks in a row).';
  } else if (event.conceded) {
    headline = event.youConceded ? 'You conceded the match.' : '🏆 <b>You won — your opponent conceded.</b>';
  }
  const lines = [headline, html`Frames ${event.framesWon?.[0] ?? 0}–${event.framesWon?.[1] ?? 0}.`];
  if (event.eligibleBreak > 0) {
    lines.push(
      '',
      html`Your highest break was <b>${event.eligibleBreak}</b> — that is this match's reward-eligible score.`,
      '/status to see what it is currently worth.',
    );
  } else if (event.rewardLimit) {
    const { reason, breakValue, limit } = event.rewardLimit;
    lines.push(
      '',
      html`Your break of <b>${breakValue}</b> does not count toward rewards:`,
      reason === 'daily-pair-cap'
        ? html`you have already had ${limit} reward-eligible matches against this opponent today.`
        : html`you have reached today's limit of ${limit} reward-eligible matches.`,
      'You can keep playing — limits reset at 00:00 UTC.',
    );
  }
  return message(lines);
}

/** "match-abandoned": both players let the shot clock run out in turn. */
export function matchAbandonedMessage(event) {
  return message([
    'Match abandoned — neither player took a shot.',
    html`The shot clock ran out ${event.timeouts ?? 4} times in a row, so nobody wins and nothing from this match counts toward rewards.`,
    '/play to start a new one.',
  ]);
}

/**
 * "wallet-changed": sent on every payout wallet change, so a player whose
 * session was hijacked finds out while the 24h claim cooldown still protects
 * their rewards.
 */
export function walletChangedMessage({ action, address, network }, { supportHandle = '' } = {}) {
  const support = supportHandle ? html`contact ${supportHandle} right away` : 'contact support right away';
  if (action === 'unlinked') {
    return message([
      html`👛 <b>Your payout wallet was unlinked</b> (<code>${shortAddress(address)}</code>, ${network}).`,
      `If this wasn't you, ${support}.`,
    ]);
  }
  return message([
    html`👛 <b>Your payout wallet changed</b> to <code>${shortAddress(address)}</code> (${network}).`,
    'Rewards cannot be claimed for 24 hours after a wallet change.',
    `If this wasn't you, ${support} — someone may have access to your account.`,
  ]);
}
