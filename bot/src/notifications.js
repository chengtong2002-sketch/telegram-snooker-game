import crypto from 'node:crypto';
import express from 'express';
import { webhookCallback } from 'grammy';
import { userById } from '@snooker/db';
import { config } from './config.js';
import { matchKeyboard, canOpenGame } from './keyboards.js';
import { isPermanentSendFailure } from './sendFailures.js';
import {
  matchedMessage, yourTurnMessage, frameCheckpointMessage, matchOverMessage, matchAbandonedMessage,
  walletChangedMessage, coinsAddedMessage,
} from './messages.js';

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

      // Each text is HTML with every outside value escaped (see messages.js).
      const send = ({ text, parse_mode }, reply_markup) => bot.api.sendMessage(chatId, text, { parse_mode, reply_markup });

      if (event.type === 'matched') {
        await send(matchedMessage(event), event.yourTurn ? kb : undefined);
      } else if (event.type === 'your-turn') {
        await send(yourTurnMessage(event), kb);
      } else if (event.type === 'frame-checkpoint') {
        await send(
          frameCheckpointMessage(event),
          event.trailing && canOpenGame() ? matchKeyboard(event.matchId, '🎱 Continue or concede') : undefined,
        );
      } else if (event.type === 'match-over') {
        await send(matchOverMessage(event));
      } else if (event.type === 'match-abandoned') {
        await send(matchAbandonedMessage(event));
      } else if (event.type === 'coins-added') {
        // A card or wallet payment (Revenue Monster) the backend has credited.
        await send(coinsAddedMessage(event));
      } else if (event.type === 'wallet-changed') {
        await send(walletChangedMessage(event, { supportHandle: config.supportHandle }));
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
