import { Router } from '../asyncRouter.js';
import { requireAuth } from '../auth.js';
import { getDb, toJson, fromJson } from '@snooker/db';
import { applyShot } from '../services/matchService.js';
import { logger } from '../logger.js';

const router = Router();

const MAX_BATCH = 25;

/** JSON with object keys sorted, so key order alone never reads as different content. */
function canonical(value) {
  return JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : v));
}

/** Does this entry say the same thing as the result already stored under its id? */
function sameResult(stored, { userId, kind, matchId, payload }) {
  if (String(stored.user_id) !== String(userId) || stored.kind !== kind) return false;
  // Practice stats are never attached to a match, so their matchId is not compared.
  if (kind === 'shot' && String(stored.match_id ?? '') !== String(matchId ?? '')) return false;
  return canonical(fromJson(stored.payload)) === canonical(payload ?? {});
}

const CONFLICT = {
  status: 'rejected',
  conflict: true,
  reason: 'this resultId was already used for a different result; the first one stands',
};

/**
 * Drain the client's offline queue.
 *
 * Every entry carries a client-generated resultId, and that id is the dedupe
 * key. Replaying an entry unchanged (a flaky reconnect) is a `duplicate` and
 * repeats what happened the first time, including why it was rejected. The same
 * id with different content is a conflict: the first result stands and the new
 * one is `rejected` with `conflict: true`, never applied and never stored in
 * place of the original. The client drops rejected entries, so a conflict is not
 * retried. Entries are processed in order and reported individually.
 *
 * Client-side timestamps (when a shot was played or queued) are ignored: the
 * shot clock and the reward period both use the server's time of arrival.
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

    const described = { userId: req.user.id, kind, matchId, payload };
    const seen = await knex('sync_results').where({ result_id: resultId }).first();
    if (seen) {
      if (!sameResult(seen, described)) {
        out.push({ resultId, ...CONFLICT });
      } else if (seen.status === 'rejected') {
        out.push({ resultId, status: 'rejected', reason: seen.note ?? undefined });
      } else {
        out.push({ resultId, status: 'duplicate' });
      }
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
          conflict: result.conflict || undefined,
          outcome: result.outcome,
          match: result.match,
        });
        // A conflict must not become the stored record for an id someone else's
        // shot already owns.
        if (result.conflict) continue;
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
        // Two flushes of the same id can both get past `seen`; only one insert
        // lands. Whatever is stored now decides what this entry was.
        const stored = await knex('sync_results').where({ result_id: resultId }).first();
        out.push(sameResult(stored, described)
          ? { resultId, status: 'applied', cryptoEligible: false }
          : { resultId, ...CONFLICT });
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
