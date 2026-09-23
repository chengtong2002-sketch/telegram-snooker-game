/**
 * Message texts, kept apart from the handlers so they can be tested without a
 * bot, a database or a config.
 *
 * HTML, not Markdown: in HTML only <, > and & are special, so a player's name
 * can be escaped completely. Under legacy Markdown a first name with an
 * underscore or asterisk made Telegram reject the whole message.
 */
import { SHOT_CLOCK_MS } from '@snooker/sim';

/** Escape text for Telegram's HTML parse mode. */
export const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

/**
 * The /start welcome. One source line per line the player sees: Telegram
 * breaks the text wherever a newline is, so a sentence must never be wrapped
 * across two source lines — the phone wraps it to the screen by itself.
 *
 * @param {{ first_name?: string }} from  the Telegram user
 * @param {{ network: string }} opts      TON network rewards run on
 * @returns {{ text: string, parse_mode: 'HTML' }}
 */
export function welcomeMessage(from, { network }) {
  const name = escapeHtml(from?.first_name || 'player');
  const text = [
    `🎱 <b>Snooker</b> — welcome, ${name}.`,
    '',
    `Best of 3 frames, full 22-ball table, ${SHOT_CLOCK_MS / 1000}-second shot clock.`,
    '',
    '• /practice — play the AI. Free, unranked, <i>not</i> reward-eligible.',
    '• /play — get matched with a real opponent. Turn-based: you take your shot, I ping them, they take theirs.',
    '• /wallet — link a TON wallet so rewards have somewhere to land.',
    '• /leaderboard — highest breaks this period.',
    '',
    `Rewards run on <b>${escapeHtml(network)}</b> and come out of a capped pool — the more points everyone earns in a period, the less each point pays. Skill only: nothing to stake, nothing to lose.`,
  ].join('\n');
  return { text, parse_mode: 'HTML' };
}
