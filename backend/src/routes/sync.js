import { Router } from '../asyncRouter.js';
import { requireAuth } from '../auth.js';
import { getDb, toJson } from '@snooker/db';
import { applyShot } from '../services/matchService.js';
import { logger } from '../logger.js';

const router = Router();

const MAX_BATCH = 25;

/**
 * Drain the client's offline queue.
 *
 * Every entry carries a client-generated resultId. That id is the dedupe key:
 * replaying the same batch after a flaky reconnect produces `duplicate`, not a
 * second shot. Entries are processed in order and reported individually so the
 * client can drop the settled ones and keep retrying the rest.
 */
router.post('/', requireAuth, async (req, res) => {
  const entries = Array.isArray(req.body?.results) ? req.body.results : [];
  if (entries.length === 0) return res.json({ results: [] });
  if (entries.length > MAX_BATCH) {
    return res.status(413).json({ error: `at most ${MAX_BATCH} results per sync` });
  }

  const knex = getDb();
  const out = [];

  for (const entry of entries) {
    const { resultId, kind, matchId, payload } = entry ?? {};
    if (!resultId || typeof resultId !== 'string' || resultId.length > 64) {
      out.push({ resultId: resultId ?? null, status: 'rejected', reason: 'bad resultId' });
      continue;
    }

    const seen = await knex('sync_results').where({ result_id: resultId }).first();
    if (seen) {
      out.push({ resultId, status: 'duplicate' });
      continue;
    }

    try {
      if (kind === 'shot') {
        const result = await applyShot({
          matchId, userId: req.user.id, resultId, shot: payload?.shot,
        });
        out.push({
          resultId,
          status: result.status === 'error' ? 'rejected' : result.status,
          reason: result.reason,
          outcome: result.outcome,
          match: result.match,
        });
        await knex('sync_results').insert({
          result_id: resultId,
          user_id: req.user.id,
          match_id: matchId ?? null,
          kind: 'shot',
          payload: toJson(payload ?? {}),
          status: result.status === 'error' ? 'rejected' : 'applied',
          note: result.reason ?? null,
        }).onConflict('result_id').ignore();
        continue;
      }

      if (kind === 'practice-stat') {
        // Recorded for analytics only. Practice can never award points — this
        // path deliberately touches neither eligible_breaks nor users.best_break.
        await knex('sync_results').insert({
          result_id: resultId,
          user_id: req.user.id,
          match_id: null,
          kind: 'practice-stat',
          payload: toJson(payload ?? {}),
          status: 'applied',
          note: 'practice is not crypto-eligible',
        }).onConflict('result_id').ignore();
        out.push({ resultId, status: 'applied', cryptoEligible: false });
        continue;
      }

      out.push({ resultId, status: 'rejected', reason: `unknown kind ${kind}` });
      await knex('sync_results').insert({
        result_id: resultId,
        user_id: req.user.id,
        match_id: matchId ?? null,
        kind: String(kind ?? 'unknown').slice(0, 24),
        payload: toJson(payload ?? {}),
        status: 'rejected',
        note: 'unknown kind',
      }).onConflict('result_id').ignore();
    } catch (err) {
      logger.error({ err: err.message, resultId }, 'sync entry failed');
      out.push({ resultId, status: 'retry', reason: 'server error' });
    }
  }

  return res.json({ results: out });
});

export default router;
