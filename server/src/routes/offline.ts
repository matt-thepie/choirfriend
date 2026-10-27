import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db/index.ts';
import { resolveFileUrl, type FileRow } from '../db/pieces.ts';
import { requireAuth } from '../auth/middleware.ts';

/**
 * Score list for the offline sync. The service worker keeps sheet music
 * (kind 'pdf') available without a connection; audio stays online-only.
 * `inSetList` marks scores on songs in an active set list, which is what
 * the client syncs by default. Sheet music is never private, so every
 * signed-in member may see every row.
 */
const scoresStmt = db.prepare(`
  SELECT f.*, p.title AS piece_title,
    EXISTS (
      SELECT 1 FROM set_list_items i JOIN set_lists s ON s.id = i.set_list_id
      WHERE i.piece_id = f.piece_id AND s.status = 'active'
    ) AS in_set_list
  FROM files f JOIN pieces p ON p.id = f.piece_id
  WHERE f.kind = 'pdf'
  ORDER BY p.title COLLATE NOCASE, f.sort_order, f.id
`);

type ScoreRow = FileRow & { piece_title: string; in_set_list: number };

export const offlineRoutes: FastifyPluginAsync = async (app) => {
  app.get('/offline/scores', { preHandler: requireAuth }, async () => {
    const rows = scoresStmt.all() as unknown as ScoreRow[];
    return {
      scores: rows.map((r) => ({
        fileId: r.id,
        pieceId: r.piece_id,
        pieceTitle: r.piece_title,
        url: resolveFileUrl(r),
        sizeBytes: r.size_bytes ?? null,
        inSetList: r.in_set_list === 1,
      })),
    };
  });
};
