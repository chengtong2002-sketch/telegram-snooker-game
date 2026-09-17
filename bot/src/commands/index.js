import { upsertUser, activeWallet, leaderboard } from '@snooker/db';
import { SHOT_CLOCK_MS } from '@snooker/sim';
import * as api from '../api.js';
import { config } from '../config.js';
import {
  menuKeyboard, matchKeyboard, practiceKeyboard, walletKeyboard, canOpenGame,
} from '../keyboards.js';

const NO_GAME_URL = 'The game front-end is not deployed yet (GAME_URL is unset), so I cannot open it.';

const nameOf = (row) => (row.username ? `@${row.username}` : (row.first_name ?? 'Player'));

// --- handlers, shared by slash commands and the inline menu ----------------

async function handleStart(ctx) {
  await upsertUser(ctx.from);
  return ctx.reply(
    [
      `🎱 *Snooker* — welcome, ${ctx.from.first_name ?? 'player'}.`,
      '',
      `Best of 3 frames, full 22-ball table, ${SHOT_CLOCK_MS / 1000}-second shot clock.`,
      '',
      '• */practice* — play the AI. Free, unranked, *not* reward-eligible.',
      '• */play* — get matched with a real opponent. Turn-based: you take your shot,',
      '  I ping them, they take theirs.',
      '• */wallet* — link a TON wallet so rewards have somewhere to land.',
      '• */leaderboard* — highest breaks this period.',
      '',
      `Rewards run on *${config.tonNetwork}* and come out of a capped pool — the more`,
      'points everyone earns in a period, the less each point pays. Skill only:',
      'nothing to stake, nothing to lose.',
    ].join('\n'),
    { parse_mode: 'Markdown', reply_markup: menuKeyboard() },
  );
}

async function handlePractice(ctx) {
  await upsertUser(ctx.from);
  if (!canOpenGame()) return ctx.reply(NO_GAME_URL);
  return ctx.reply(
    'Practice frame vs the AI. Nothing here counts toward rewards — it is for getting your aim in.',
    { reply_markup: practiceKeyboard() },
  );
}

async function handlePlay(ctx) {
  await upsertUser(ctx.from);
  try {
    const result = await api.joinQueue(ctx.from);
    if (result.status === 'queued') {
      return ctx.reply(
        `🔎 Looking for an opponent… (${result.queueSize} waiting)\n`
        + 'I will message you the moment someone joins. /cancel to stop waiting.',
      );
    }
    if (result.status === 'already-playing') {
      return ctx.reply('You already have a match running.', {
        reply_markup: matchKeyboard(result.match.id),
      });
    }
    if (result.status === 'matched') {
      // Both players also get a push from the backend; this is the instant ack.
      return ctx.reply('⚔️ Opponent found!', { reply_markup: matchKeyboard(result.matchId) });
    }
    return ctx.reply('Matchmaking is unavailable right now — try again shortly.');
  } catch (err) {
    return ctx.reply(`Could not reach the game server: ${err.message}`);
  }
}

async function handleLeaderboard(ctx) {
  const rows = await leaderboard({ limit: 10 });
  if (rows.length === 0) {
    return ctx.reply('No reward-eligible breaks yet this period. /play to put one up.');
  }
  const medal = ['🥇', '🥈', '🥉'];
  const lines = rows.map((r, i) => `${medal[i] ?? `${i + 1}.`} ${nameOf(r)} — break *${r.best_break}*`);
  return ctx.reply(
    ['🏆 *Highest breaks* — PvP only', '', ...lines].join('\n'),
    { parse_mode: 'Markdown' },
  );
}

async function handleWallet(ctx) {
  const user = await upsertUser(ctx.from);
  const wallet = await activeWallet(user.id);
  if (wallet) {
    const short = `${wallet.address.slice(0, 6)}…${wallet.address.slice(-6)}`;
    return ctx.reply(
      `👛 Linked wallet (${wallet.network}): \`${short}\`\n\nOpen the wallet screen to change it.`,
      { parse_mode: 'Markdown', reply_markup: canOpenGame() ? walletKeyboard() : undefined },
    );
  }
  if (!canOpenGame()) return ctx.reply(NO_GAME_URL);
  return ctx.reply(
    [
      'No wallet linked yet.',
      '',
      `Linking uses TON Connect on *${config.tonNetwork}*: you sign a proof of ownership.`,
      'Nothing is transferred, and the bot never sees a seed phrase.',
    ].join('\n'),
    { parse_mode: 'Markdown', reply_markup: walletKeyboard() },
  );
}

async function handleStatus(ctx) {
  try {
    const s = await api.status(ctx.from);
    const lines = [
      `Best break: *${s.user.bestBreak}*`,
      `Frames: *${s.user.framesWon}* won of *${s.user.framesPlayed}*`,
      s.wallet
        ? `Wallet: \`${s.wallet.address.slice(0, 8)}…\` (${s.wallet.network})`
        : 'Wallet: not linked',
    ];
    if (s.rewards) {
      lines.push(
        '',
        `This period: *${s.rewards.points}* eligible points`,
        `Pool: *${s.rewards.budget}* tokens across *${s.rewards.totalPoints}* points`,
        `Provisional payout: *${s.rewards.tokens.toFixed(4)}* tokens${s.rewards.capped ? ' (share capped)' : ''}`,
      );
    }
    const open = (s.claims?.periods ?? []).filter((p) => p.claimable);
    if (open.length) {
      const day = (iso) => new Date(iso).toISOString().slice(0, 10);
      lines.push('', `*Unclaimed rewards: ${Number(s.claims.totalTokens).toFixed(4)} tokens*`);
      for (const p of open.slice(0, 5)) {
        lines.push(`• ${day(p.startsAt)} period: ${p.tokens.toFixed(4)} tokens, claim by ${day(p.expiresAt)}`);
      }
      if (open.length > 5) lines.push(`• …and ${open.length - 5} more`);
      lines.push('Claim them from /wallet. Unclaimed rewards expire.');
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });

    for (const m of s.matches.slice(0, 3)) {
      const yours = Number(m.turnUserId) === Number(s.user.id);
      await ctx.reply(
        `Match \`${m.id.slice(0, 8)}\` — frames ${m.framesWon[0]}–${m.framesWon[1]}, `
        + (yours ? '*your shot*' : 'waiting on your opponent'),
        { parse_mode: 'Markdown', reply_markup: yours && canOpenGame() ? matchKeyboard(m.id) : undefined },
      );
    }
    return undefined;
  } catch (err) {
    return ctx.reply(`Could not reach the game server: ${err.message}`);
  }
}

async function handleCancel(ctx) {
  try {
    const result = await api.leaveQueue(ctx.from);
    return ctx.reply(result.status === 'left' ? 'Left the queue.' : 'You were not in the queue.');
  } catch (err) {
    return ctx.reply(`Could not reach the game server: ${err.message}`);
  }
}

const HELP = [
  '*Commands*',
  '/practice — solo vs AI (not reward-eligible)',
  '/play — join the matchmaking queue',
  '/cancel — leave the queue',
  '/wallet — link or view your TON wallet',
  '/leaderboard — top breaks this period',
  '/status — your matches and reward standing',
  '',
  '*Fouls* — 4 points minimum, turn passes:',
  'missing everything · hitting the wrong ball first · potting the cue ball ·',
  'knocking a ball off the table.',
].join('\n');

export function registerCommands(bot) {
  bot.command('start', handleStart);
  bot.command('help', (ctx) => ctx.reply(HELP, { parse_mode: 'Markdown' }));
  bot.command('practice', handlePractice);
  bot.command('play', handlePlay);
  bot.command('cancel', handleCancel);
  bot.command('wallet', handleWallet);
  bot.command('leaderboard', handleLeaderboard);
  bot.command('status', handleStatus);

  bot.callbackQuery('play', async (ctx) => {
    await ctx.answerCallbackQuery();
    return handlePlay(ctx);
  });
  bot.callbackQuery('leaderboard', async (ctx) => {
    await ctx.answerCallbackQuery();
    return handleLeaderboard(ctx);
  });
  bot.callbackQuery('wallet', async (ctx) => {
    await ctx.answerCallbackQuery();
    return handleWallet(ctx);
  });
}

export const COMMAND_LIST = [
  { command: 'play', description: 'Find a real opponent' },
  { command: 'practice', description: 'Play the AI (not reward-eligible)' },
  { command: 'wallet', description: 'Link your TON wallet' },
  { command: 'leaderboard', description: 'Highest breaks this period' },
  { command: 'status', description: 'Your matches and rewards' },
  { command: 'cancel', description: 'Leave the matchmaking queue' },
  { command: 'help', description: 'How the game works' },
];
