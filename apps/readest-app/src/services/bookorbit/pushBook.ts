// "Push to BookOrbit": upload the open book's file into the user's BookOrbit
// library through the resumable upload-session API.
//
// Sessions rather than the one-shot `POST /libraries/:id/upload` because the
// Tauri HTTP plugin copies a request body into a JS number array to cross
// IPC; bounded chunks keep a large PDF or comic from costing gigabytes of
// memory, and give a progress signal for free. The idempotency key is derived
// from the book, so pushing again after a dropped connection resumes the
// session instead of starting over.
//
// BookOrbit indexes uploaded files by KOReader's partial MD5, which is
// Readest's book hash, so a pushed book is matched by the sync integration
// with no linking step.
import { md5Fingerprint } from '@/utils/md5';
import type { BookOrbitClient, BookOrbitUploadSession } from './client';

/** Below BookOrbit's 16 MiB chunk cap, and small enough to cross Tauri IPC. */
export const PUSH_CHUNK_BYTES = 4 * 1024 * 1024;
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * `choose-library`: several libraries and none picked in settings.
 * `no-permission`: the account may not upload to any library.
 * Otherwise BookOrbit's own `errorCode` (e.g. `UPLOAD_DESTINATION_CONFLICT`).
 */
export class BookOrbitPushError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message || code);
    this.name = 'BookOrbitPushError';
  }
}

export interface PushBookDeps {
  client: Pick<
    BookOrbitClient,
    | 'getUploadCapabilities'
    | 'createUploadSession'
    | 'appendUploadChunk'
    | 'getUploadSession'
    | 'completeUploadSession'
  >;
  file: Blob;
  /** Its extension is what BookOrbit detects the format from. */
  filename: string;
  /** KOReader partial MD5 of `file`. */
  hash: string;
  /** The library picked in settings; needed only when there are several. */
  libraryId?: number;
  /** The BookOrbit book id already holding this hash, or null. */
  findExisting?: (hash: string) => Promise<number | null>;
  /** Fraction of the bytes sent, 0..1. */
  onProgress?: (fraction: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

export type PushBookResult = { status: 'exists' | 'uploaded'; bookId: number };

const RESTARTABLE = new Set<BookOrbitUploadSession['status']>(['failed', 'cancelled', 'expired']);

export const pushBookToBookOrbit = async (deps: PushBookDeps): Promise<PushBookResult> => {
  const { client, file, filename, hash, onProgress } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const existing = await deps.findExisting?.(hash).catch(() => null);
  if (existing) return { status: 'exists', bookId: existing };

  const { libraries } = await client.getUploadCapabilities();
  if (!libraries.length) throw new BookOrbitPushError('no-permission');
  const library =
    libraries.length === 1 ? libraries[0] : libraries.find((l) => l.id === deps.libraryId);
  if (!library) throw new BookOrbitPushError('choose-library');

  const request = {
    filename,
    sizeBytes: file.size,
    idempotencyKey: `readest:${hash}:${md5Fingerprint(`${filename}|${file.size}|${library.id}`)}`,
    target: { kind: 'library' as const, libraryId: library.id },
  };
  let session = await client.createUploadSession(request);
  // The key outlives a failed or expired session; a new attempt needs a new one.
  if (RESTARTABLE.has(session.status)) {
    session = await client.createUploadSession({
      ...request,
      idempotencyKey: `${request.idempotencyKey}:${Date.now()}`,
    });
  }

  let offset = session.receivedBytes;
  while (session.status === 'receiving' && offset < file.size) {
    onProgress?.(offset / file.size);
    session = await client.appendUploadChunk(
      session.id,
      offset,
      file.slice(offset, offset + PUSH_CHUNK_BYTES),
    );
    offset = session.receivedBytes;
  }
  onProgress?.(1);

  if (session.status === 'receiving') session = await client.completeUploadSession(session.id);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (session.status === 'processing' && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    session = await client.getUploadSession(session.id);
  }

  if (session.status === 'completed' && session.bookId) {
    return { status: 'uploaded', bookId: session.bookId };
  }
  throw new BookOrbitPushError(
    session.errorCode ?? (session.status === 'processing' ? 'timeout' : 'failed'),
    session.errorMessage,
  );
};
