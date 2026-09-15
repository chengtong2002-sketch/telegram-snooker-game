import crypto from 'node:crypto';
import express from 'express';
import { webhookCallback } from 'grammy';
import { userById } from '@snooker/db';
import { config } from './config.js';
import { matchKeyboard, canOpenGame } from './keyboards.js';

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
  if (!lastShot) return '';
  if (lastShot.foul) {
    const reason = FOUL_TEXT[lastShot.foulReasons?.[0]] ?? 'fouled';
    return `They ${reason} — *${lastShot.penalty} points to you*.`;
  }
  if (lastShot.breakValue > 0) return `Their break ended on *${lastShot.breakValue}*.`;
  return 'They came up empty.';
}

/**
 * Small HTTP listener the backend calls when something happens that a player
 * needs to hear about. Kept in-process with the bot so only one thing holds the
 * Telegram token.
 */
export function startNotificationServer(bot) {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  // Webhook mode: Telegram posts updates to the same server. The path carries
  // the internal key so a stranger cannot inject updates.
  if (config.webhookUrl) {
    app.post(`/telegram/${config.internalApiKey}`, webhookCallback(bot, 'express'));
  }

  app.use('/internal', (req, res, next) => {
    const key = Buffer.from(req.get('x-internal-key') ?? '');
    const expected = Buffer.from(config.internalApiKey);
    if (expected.length === 0 || key.length !== expected.length || !crypto.timingSafeEqual(key, expected)) {
      return res.status(401).json({ error: 'bad internal key' });
    }
    return next();
  });

  app.post('/internal/notify', async (req, res) => {
    const event = req.body ?? {};
    try {
      const user = await userById(event.userId);
      if (!user) return res.status(404).json({ error: 'unknown user' });
      const chatId = Number(user.telegram_id);
      const kb = canOpenGame() ? matchKeyboard(event.matchId) : undefined;

      if (event.type === 'matched') {
        await bot.api.sendMessage(
          chatId,
          event.yourTurn
            ? '⚔️ Opponent found — *you break*. Best of 3.'
            : '⚔️ Opponent found. They break; I will ping you when it is your shot.',
          { parse_mode: 'Markdown', reply_markup: event.yourTurn ? kb : undefined },
        );
      } else if (event.type === 'your-turn') {
        const detail = describeLastShot(event.lastShot);
        await bot.api.sendMessage(
          chatId,
          [
            '🎱 *Your shot.*',
            detail,
            `Score ${event.scores?.[0] ?? 0}–${event.scores?.[1] ?? 0} · `
            + `${event.secondsToShoot ?? 25}s on the clock once you open the table.`,
          ].filter(Boolean).join('\n'),
          { parse_mode: 'Markdown', reply_markup: kb },
        );
      } else if (event.type === 'match-over') {
        const lines = [
          event.won ? '🏆 *You won the match.*' : 'Match over — your opponent took it.',
          `Frames ${event.framesWon?.[0] ?? 0}–${event.framesWon?.[1] ?? 0}.`,
        ];
        if (event.eligibleBreak > 0) {
          lines.push(
            '',
            `Your highest break was *${event.eligibleBreak}* — that is this match's`,
            'reward-eligible score. /status to see what it is currently worth.',
          );
        }
        await bot.api.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
      } else {
        return res.status(400).json({ error: `unknown event ${event.type}` });
      }
      return res.json({ ok: true });
    } catch (err) {
      // A blocked bot or deleted chat must not retry forever.
      const permanent = /blocked|chat not found|deactivated/i.test(err.message ?? '');
      return res.status(permanent ? 200 : 500).json({ ok: permanent, error: err.message });
    }
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  return app.listen(config.notifyPort, () => {
    console.log(`bot notification listener on :${config.notifyPort}`);
  });
}
