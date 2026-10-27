/**
 * URL <-> view state for the app. The app is a single page, but each place a
 * member can be has a URL so the browser's back button, reloads and shared
 * links all work:
 *
 *   /                          Set lists (landing page)
 *   /repertoire                Repertoire table
 *   /setlists/all              the virtual "All songs" list
 *   /setlists/:id              a stored set list
 *   /songs/:id[?list=all|:id]  a song; `list` keeps the set-list breadcrumb
 *   /songs/:id/view/:fileId    a PDF in the annotating viewer (+ &read=1)
 */

export interface Route {
  tab: 'songs' | 'setlists';
  /** null = not in the set list area; 0 = "All songs"; >0 = stored list. */
  setListId: number | null;
  pieceId: number | null;
  viewerFileId: number | null;
  /** viewerFileId is an editable score shown as a flowing score, not a PDF. */
  flow: boolean;
  readMode: boolean;
}

export const HOME_ROUTE: Route = { tab: 'setlists', setListId: null, pieceId: null, viewerFileId: null, flow: false, readMode: false };

export function formatRoute(r: Route): string {
  if (r.pieceId !== null) {
    let path = `/songs/${r.pieceId}`;
    if (r.viewerFileId !== null) path += `/${r.flow ? 'flow' : 'view'}/${r.viewerFileId}`;
    const q = new URLSearchParams();
    if (r.tab === 'setlists' && r.setListId !== null) q.set('list', r.setListId === 0 ? 'all' : String(r.setListId));
    if (r.viewerFileId !== null && r.readMode) q.set('read', '1');
    const qs = q.toString();
    return qs ? `${path}?${qs}` : path;
  }
  if (r.tab === 'songs') return '/repertoire';
  if (r.setListId === null) return '/';
  return r.setListId === 0 ? '/setlists/all' : `/setlists/${r.setListId}`;
}

function parseListParam(v: string | null): number | null {
  if (v === null) return null;
  if (v === 'all') return 0;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function parseRoute(loc: { pathname: string; search: string }): Route {
  const parts = loc.pathname.split('/').filter(Boolean);
  const q = new URLSearchParams(loc.search);
  if (parts.length === 0) return HOME_ROUTE;
  if (parts[0] === 'repertoire') return { ...HOME_ROUTE, tab: 'songs' };
  if (parts[0] === 'setlists' && parts.length === 2) {
    const id = parseListParam(parts[1]);
    return id === null ? HOME_ROUTE : { ...HOME_ROUTE, setListId: id };
  }
  if (parts[0] === 'songs' && parts.length >= 2) {
    const pieceId = Number(parts[1]);
    if (!Number.isInteger(pieceId) || pieceId <= 0) return HOME_ROUTE;
    const listId = parseListParam(q.get('list'));
    const base: Route = listId === null ? { ...HOME_ROUTE, tab: 'songs', pieceId } : { ...HOME_ROUTE, setListId: listId, pieceId };
    if (parts.length === 4 && (parts[2] === 'view' || parts[2] === 'flow')) {
      const fileId = Number(parts[3]);
      if (Number.isInteger(fileId) && fileId > 0) {
        return { ...base, viewerFileId: fileId, flow: parts[2] === 'flow', readMode: q.get('read') === '1' };
      }
    }
    return base;
  }
  return HOME_ROUTE;
}
