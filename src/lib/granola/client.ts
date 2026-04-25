// Granola API client. Bearer auth with grn_* keys.
// Public docs: https://docs.granola.ai/introduction
// Rate limit: 25 req / 5s burst, 5 req/s sustained -> we sleep 250ms between requests.

const GRANOLA_BASE = 'https://api.granola.ai/v1';

export interface GranolaNoteSummary {
  id: string;                 // not_xxxxxxxxxxxxxx
  object: 'note';
  title: string | null;
  owner: { name: string | null; email: string };
  created_at: string;          // ISO 8601
  updated_at: string;
}

export interface GranolaTranscriptItem {
  speaker?: { source?: 'microphone' | 'speaker' };
  text: string;
  diarization_label?: string;
}

export interface GranolaNoteFull extends GranolaNoteSummary {
  summary?: string | null;
  transcript?: GranolaTranscriptItem[];
}

export interface ListNotesParams {
  apiKey: string;
  createdAfter?: string;       // ISO 8601
  cursor?: string;
  // Hard cap on total pages we'll walk in one call. Stops runaway loops if
  // pagination misbehaves; backfill hits this comfortably.
  maxPages?: number;
}

async function granolaFetch(path: string, apiKey: string): Promise<Response> {
  const res = await fetch(`${GRANOLA_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  });
  if (res.status === 429) {
    // Honor server-side rate limit. Back off 1s and retry once.
    await sleep(1000);
    return fetch(`${GRANOLA_BASE}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
  }
  return res;
}

export async function* listAllNotes({
  apiKey,
  createdAfter,
  cursor,
  maxPages = 200,
}: ListNotesParams): AsyncGenerator<GranolaNoteSummary> {
  let nextCursor = cursor;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams();
    if (createdAfter) params.set('created_after', createdAfter);
    if (nextCursor) params.set('cursor', nextCursor);

    const path = `/notes${params.toString() ? `?${params}` : ''}`;
    const res = await granolaFetch(path, apiKey);

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Granola list-notes ${res.status}: ${body.slice(0, 200)}`);
    }

    const data: { notes: GranolaNoteSummary[]; hasMore: boolean; cursor: string | null } = await res.json();
    for (const n of data.notes || []) yield n;

    if (!data.hasMore || !data.cursor) return;
    nextCursor = data.cursor;
    await sleep(250);   // sustain ~4 req/s, comfortable margin under 5/s limit
  }
}

export async function getNoteWithTranscript(noteId: string, apiKey: string): Promise<GranolaNoteFull | null> {
  const res = await granolaFetch(`/notes/${noteId}?include=transcript`, apiKey);
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Granola get-note ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

export function transcriptItemsToText(items: GranolaTranscriptItem[] | undefined): string {
  if (!items?.length) return '';
  return items
    .map(it => {
      const speaker = it.diarization_label || (it.speaker?.source === 'microphone' ? 'Me' : 'Other');
      return `${speaker}: ${it.text}`;
    })
    .join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
