import { upsertUser, activeWallet, leaderboard } from '@snooker/db';
import * as api from '../api.js';
import { config } from '../config.js';
import {
  welcomeMessage, helpMessage, leaderboardMessage, walletLinkedMessage, walletUnlinkedMessage,
  statusMessage, statusMatchMessage,
} from '../messages.js';
import {
  menuKeyboard, matchKeyboard, practiceKeyboard, walletKeyboard, canOpenGame,
} from '../keyboards.js';

const NO_GAME_URL = 'The game front-end is not deployed yet (GAME_URL is unset), so I cannot open it.';

// --- handlers, shared by slash commands and the inline menu ----------------

async function handleStart(ctx) {
  await upsertUser(ctx.from);
  const { text, parse_mode } = welcomeMessage(ctx.from, { network: config.tonNetwork });
  return ctx.reply(text, { parse_mode, reply_markup: menuKeyboard() });
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
  const { text, parse_mode } = leaderboardMessage(rows);
  return ctx.reply(text, { parse_mode });
}

async function handleWallet(ctx) {
  const user = await upsertUser(ctx.from);
  const wallet = await activeWallet(user.id);
  if (wallet) {
    const { text, parse_mode } = walletLinkedMessage(wallet);
    return ctx.reply(text, { parse_mode, reply_markup: canOpenGame() ? walletKeyboard() : undefined });
  }
  if (!canOpenGame()) return ctx.reply(NO_GAME_URL);
  const { text, parse_mode } = walletUnlinkedMessage({ network: config.tonNetwork });
  return ctx.reply(text, { parse_mode, reply_markup: walletKeyboard() });
}

async function handleStatus(ctx) {
  try {
    const s = await api.status(ctx.from);
    const summary = statusMessage(s);
    await ctx.reply(summary.text, { parse_mode: summary.parse_mode });

    for (const m of s.matches.slice(0, 3)) {
      const yours = Number(m.turnUserId) === Number(s.user.id);
      const { text, parse_mode } = statusMatchMessage(m, { yours });
      await ctx.reply(text, { parse_mode, reply_markup: yours && canOpenGame() ? matchKeyboard(m.id) : undefined });
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

const HELP = helpMessage();

export function registerCommands(bot) {
  bot.command('start', handleStart);
  bot.command('help', (ctx) => ctx.reply(HELP.text, { parse_mode: HELP.parse_mode }));
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
