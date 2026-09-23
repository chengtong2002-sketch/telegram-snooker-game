import crypto from 'node:crypto';
import express from 'express';
import { webhookCallback } from 'grammy';
import { userById } from '@snooker/db';
import { config } from './config.js';
import { matchKeyboard, canOpenGame } from './keyboards.js';
import { SHOT_CLOCK_MS } from '@snooker/sim';
import { isPermanentSendFailure } from './sendFailures.js';

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

const shortAddress = (a = '') => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-6)}` : a);

/**
 * Sent on every payout wallet change, so a player whose session was hijacked
 * finds out while the 24h claim cooldown still protects their rewards.
 */
export function walletChangedText({ action, address, network }) {
  // Underscores in a handle would open a Markdown italic and fail the send.
  const support = config.supportHandle
    ? `contact ${config.supportHandle.replace(/_/g, '\\_')} right away`
    : 'contact support right away';
  if (action === 'unlinked') {
    return [
      `👛 *Your payout wallet was unlinked* (\`${shortAddress(address)}\`, ${network}).`,
      `If this wasn't you, ${support}.`,
    ].join('\n');
  }
  return [
    `👛 *Your payout wallet changed* to \`${shortAddress(address)}\` (${network}).`,
    'Rewards cannot be claimed for 24 hours after a wallet change.',
    `If this wasn't you, ${support} — someone may have access to your account.`,
  ].join('\n');
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
        const detail = event.newFrame
          ? `Frame ${event.newFrame} is racked — you break.`
          : describeLastShot(event.lastShot);
        await bot.api.sendMessage(
          chatId,
          [
            '🎱 *Your shot.*',
            detail,
            `Score ${event.scores?.[0] ?? 0}–${event.scores?.[1] ?? 0} · `
            + `${event.secondsToShoot ?? SHOT_CLOCK_MS / 1000}s on the clock.`,
          ].filter(Boolean).join('\n'),
          { parse_mode: 'Markdown', reply_markup: kb },
        );
      } else if (event.type === 'frame-checkpoint') {
        const score = `${event.framesWon?.[0] ?? 0}–${event.framesWon?.[1] ?? 0}`;
        const text = event.trailing
          ? [
            `🎱 *Frame ${event.frame} complete* — your opponent leads ${score}.`,
            `Continue to frame ${event.frame + 1}, or concede the match?`,
            `Frame ${event.frame + 1} starts automatically in ${event.seconds}s if you do not choose.`,
            'Conceding never cancels a break you have already made.',
          ]
          : [
            `🎱 *Frame ${event.frame} is yours* — you lead ${score}.`,
            `Your opponent can continue or concede. Frame ${event.frame + 1} starts within ${event.seconds}s.`,
          ];
        await bot.api.sendMessage(chatId, text.join('\n'), {
          parse_mode: 'Markdown',
          reply_markup: event.trailing && canOpenGame() ? matchKeyboard(event.matchId, '🎱 Continue or concede') : undefined,
        });
      } else if (event.type === 'match-over') {
        let headline = event.won ? '🏆 *You won the match.*' : 'Match over — your opponent took it.';
        if (event.conceded) {
          headline = event.youConceded ? 'You conceded the match.' : '🏆 *You won — your opponent conceded.*';
        }
        const lines = [headline, `Frames ${event.framesWon?.[0] ?? 0}–${event.framesWon?.[1] ?? 0}.`];
        if (event.eligibleBreak > 0) {
          lines.push(
            '',
            `Your highest break was *${event.eligibleBreak}* — that is this match's`,
            'reward-eligible score. /status to see what it is currently worth.',
          );
        } else if (event.rewardLimit) {
          const { reason, breakValue, limit } = event.rewardLimit;
          lines.push(
            '',
            `Your break of *${breakValue}* does not count toward rewards:`,
            reason === 'daily-pair-cap'
              ? `you have already had ${limit} reward-eligible matches against this opponent today.`
              : `you have reached today's limit of ${limit} reward-eligible matches.`,
            'You can keep playing — limits reset at 00:00 UTC.',
          );
        }
        await bot.api.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
      } else if (event.type === 'wallet-changed') {
        await bot.api.sendMessage(chatId, walletChangedText(event), { parse_mode: 'Markdown' });
      } else {
        return res.status(400).json({ error: `unknown event ${event.type}` });
      }
      return res.json({ ok: true });
    } catch (err) {
      // A blocked bot, a deleted chat or a send aimed at another bot must not
      // be retried forever: 200 tells the backend there is nothing to chase.
      const permanent = isPermanentSendFailure(err);
      return res.status(permanent ? 200 : 500).json({ ok: permanent, error: err.message });
    }
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  return app.listen(config.notifyPort, () => {
    console.log(`bot notification listener on :${config.notifyPort}`);
  });
}
