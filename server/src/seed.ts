/**
 * First-boot seed. If no pieces exist, create a single demo piece pointing
 * at the client-bundled sample.pdf so the viewer has something to render.
 *
 * Once real pieces exist, this never runs again. It's idempotent and safe
 * to call on every boot.
 */

import { createFile, createPiece, pieceCount } from './db/pieces.ts';

export function seedIfEmpty(): void {
  if (pieceCount() > 0) return;

  const piece = createPiece({
    title: 'Sample Piece',
    composer: 'Trad.',
    notes: 'Placeholder piece bundled with choirfriend for dev/demo. Replace with real repertoire once B2 uploads are wired up.',
  });

  createFile({
    pieceId: piece.id,
    kind: 'pdf',
    storage: 'local',
    storageKey: 'sample.pdf',
    filename: 'sample.pdf',
    mimeType: 'application/pdf',
    sortOrder: 0,
  });

  console.log(`[seed] Created demo piece #${piece.id} (${piece.title})`);
}
