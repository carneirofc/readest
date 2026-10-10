import { describe, expect, it, vi } from 'vitest';
import type {
  BookOrbitUploadCapabilities,
  BookOrbitUploadSession,
  BookOrbitUploadSessionCreate,
} from '@/services/bookorbit/client';
import {
  BookOrbitPushError,
  PUSH_CHUNK_BYTES,
  pushBookToBookOrbit,
  type PushBookDeps,
} from '@/services/bookorbit/pushBook';

const HASH = 'a'.repeat(32);

const library = (id: number) => ({
  id,
  name: `Library ${id}`,
  allowedFormats: [],
  organizationMode: 'book_per_folder' as const,
  folders: [{ id: id * 10, name: 'books' }],
});

const capabilities = (ids: number[]): BookOrbitUploadCapabilities => ({
  maxFileSizeBytes: 500 * 1024 * 1024,
  chunkSizeBytes: 16 * 1024 * 1024,
  canUploadToLibrary: ids.length > 0,
  libraries: ids.map(library),
});

const session = (patch: Partial<BookOrbitUploadSession> = {}): BookOrbitUploadSession => ({
  id: 'sess-1',
  sizeBytes: 0,
  receivedBytes: 0,
  chunkSizeBytes: 16 * 1024 * 1024,
  status: 'receiving',
  ...patch,
});

const makeDeps = (size: number, overrides: Partial<PushBookDeps> = {}) => {
  const file = new File([new Uint8Array(size)], 'local.epub');
  let received = 0;
  const client = {
    getUploadCapabilities: vi.fn(async () => capabilities([1])),
    createUploadSession: vi.fn(async (_request: BookOrbitUploadSessionCreate) =>
      session({ sizeBytes: size }),
    ),
    appendUploadChunk: vi.fn(async (_id: string, offset: number, chunk: Blob) => {
      expect(offset).toBe(received);
      received += chunk.size;
      return session({ sizeBytes: size, receivedBytes: received });
    }),
    completeUploadSession: vi.fn(async () =>
      session({ sizeBytes: size, receivedBytes: size, status: 'processing' }),
    ),
    getUploadSession: vi.fn(async () =>
      session({ sizeBytes: size, receivedBytes: size, status: 'completed', bookId: 42 }),
    ),
  };
  const deps: PushBookDeps = {
    client,
    file,
    filename: 'Moby Dick.epub',
    hash: HASH,
    findExisting: vi.fn(async () => null),
    sleep: async () => {},
    ...overrides,
  };
  return { deps, client };
};

describe('pushBookToBookOrbit', () => {
  it('skips the upload when BookOrbit already has the book', async () => {
    const { deps, client } = makeDeps(10, { findExisting: vi.fn(async () => 7) });

    await expect(pushBookToBookOrbit(deps)).resolves.toEqual({ status: 'exists', bookId: 7 });
    expect(client.createUploadSession).not.toHaveBeenCalled();
  });

  it('uploads into the only library in sequential chunks and waits for the import', async () => {
    const size = PUSH_CHUNK_BYTES * 2 + 5;
    const onProgress = vi.fn();
    const { deps, client } = makeDeps(size, { onProgress });

    await expect(pushBookToBookOrbit(deps)).resolves.toEqual({ status: 'uploaded', bookId: 42 });

    const request = client.createUploadSession.mock.calls[0]![0]!;
    expect(request).toMatchObject({
      filename: 'Moby Dick.epub',
      sizeBytes: size,
      target: { kind: 'library', libraryId: 1 },
    });
    // Same book, same target: the same key, so a retried push resumes the session.
    expect(request.idempotencyKey).toMatch(/^readest:a{32}:[0-9a-f]{7}$/);
    expect(client.appendUploadChunk).toHaveBeenCalledTimes(3);
    expect(client.completeUploadSession).toHaveBeenCalledWith('sess-1');
    expect(onProgress).toHaveBeenLastCalledWith(1);
  });

  it('resumes an interrupted session from the bytes the server already has', async () => {
    const size = PUSH_CHUNK_BYTES + 3;
    const { deps, client } = makeDeps(size);
    client.createUploadSession.mockResolvedValueOnce(
      session({ sizeBytes: size, receivedBytes: PUSH_CHUNK_BYTES }),
    );
    client.appendUploadChunk.mockImplementationOnce(async (_id, offset, chunk) => {
      expect(offset).toBe(PUSH_CHUNK_BYTES);
      expect(chunk.size).toBe(3);
      return session({ sizeBytes: size, receivedBytes: size });
    });

    await pushBookToBookOrbit(deps);

    expect(client.appendUploadChunk).toHaveBeenCalledTimes(1);
  });

  it('starts a new session when the previous one for this book failed', async () => {
    const { deps, client } = makeDeps(10);
    client.createUploadSession.mockResolvedValueOnce(session({ sizeBytes: 10, status: 'failed' }));

    await pushBookToBookOrbit(deps);

    const [first, second] = client.createUploadSession.mock.calls.map((c) => c[0]!.idempotencyKey);
    expect(second).not.toBe(first);
  });

  it('asks for a library when there are several and none is chosen', async () => {
    const { deps, client } = makeDeps(10);
    client.getUploadCapabilities.mockResolvedValueOnce(capabilities([1, 2]));

    await expect(pushBookToBookOrbit(deps)).rejects.toMatchObject({ code: 'choose-library' });
  });

  it('uses the chosen library when there are several', async () => {
    const { deps, client } = makeDeps(10, { libraryId: 2 });
    client.getUploadCapabilities.mockResolvedValueOnce(capabilities([1, 2]));

    await pushBookToBookOrbit(deps);

    expect(client.createUploadSession.mock.calls[0]![0].target).toEqual({
      kind: 'library',
      libraryId: 2,
    });
  });

  it('reports a missing upload permission', async () => {
    const { deps, client } = makeDeps(10);
    client.getUploadCapabilities.mockResolvedValueOnce(capabilities([]));

    await expect(pushBookToBookOrbit(deps)).rejects.toMatchObject({ code: 'no-permission' });
  });

  it('surfaces the server error code when the import fails', async () => {
    const { deps, client } = makeDeps(10);
    client.getUploadSession.mockResolvedValueOnce(
      session({
        status: 'failed',
        errorCode: 'UPLOAD_DESTINATION_CONFLICT',
        errorMessage: 'A file named Moby Dick.epub already exists',
      }),
    );

    const error = await pushBookToBookOrbit(deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BookOrbitPushError);
    expect(error).toMatchObject({ code: 'UPLOAD_DESTINATION_CONFLICT' });
  });
});
