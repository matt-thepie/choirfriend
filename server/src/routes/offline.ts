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

/** Flowing scores (MusicXML made from editable scores) go offline too. */
const flowingStmt = db.prepare(`
  SELECT r.file_id, r.storage, r.storage_key, r.size_bytes, f.piece_id, p.title AS piece_title,
    EXISTS (
      SELECT 1 FROM set_list_items i JOIN set_lists s ON s.id = i.set_list_id
      WHERE i.piece_id = f.piece_id AND s.status = 'active'
    ) AS in_set_list
  FROM score_renditions r JOIN files f ON f.id = r.file_id JOIN pieces p ON p.id = f.piece_id
  WHERE r.status = 'ready' AND r.storage_key IS NOT NULL
  ORDER BY p.title COLLATE NOCASE, f.sort_order, f.id
`);

interface FlowingRow {
  file_id: number;
  storage: 'b2' | 'local';
  storage_key: string;
  size_bytes: number | null;
  piece_id: number;
  piece_title: string;
  in_set_list: number;
}

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
      })).concat(
        (flowingStmt.all() as unknown as FlowingRow[]).map((r) => ({
          fileId: r.file_id,
          pieceId: r.piece_id,
          pieceTitle: r.piece_title,
          url: resolveFileUrl({ storage: r.storage, storage_key: r.storage_key } as FileRow),
          sizeBytes: r.size_bytes ?? null,
          inSetList: r.in_set_list === 1,
        })),
      ),
    };
  });
};
