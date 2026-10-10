import { useEffect, useRef } from 'react';
import { useEnv } from '@/context/EnvContext';
import { BookOrbitClient as BookOrbitSyncClient } from '@/services/bookorbit/BookOrbitClient';
import { BookOrbitAuthError, BookOrbitRequestError } from '@/services/bookorbit/client';
import { createBookOrbitClient } from '@/services/bookorbit/createClient';
import { BookOrbitPushError, pushBookToBookOrbit } from '@/services/bookorbit/pushBook';
import { useBookDataStore } from '@/store/bookDataStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useTranslation } from '@/hooks/useTranslation';
import { getLocalBookFilename } from '@/utils/book';
import { eventDispatcher } from '@/utils/event';

/**
 * Handles the book menu's "Push Book" for one open book: uploads its file
 * into the user's BookOrbit library (see services/bookorbit/pushBook.ts).
 * Lives in the long-lived reader tree, not the menu, which unmounts on click.
 */
export const useBookOrbitPushBook = (bookKey: string) => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const { getBookData } = useBookDataStore();
  const pushing = useRef(false);

  useEffect(() => {
    const toast = (type: 'info' | 'error' | 'warning', message: string, timeout = 5000) =>
      eventDispatcher.dispatch('toast', { type, message, timeout });

    const errorMessage = (error: unknown): string => {
      if (error instanceof BookOrbitAuthError) {
        return _('BookOrbit rejected your credentials. Reconnect in Settings > Integrations.');
      }
      const code =
        error instanceof BookOrbitPushError
          ? error.code
          : error instanceof BookOrbitRequestError
            ? error.errorCode
            : undefined;
      switch (code) {
        case 'choose-library':
          return _('Choose a library for pushed books in Settings > Integrations > BookOrbit.');
        case 'no-permission':
          return _('Your BookOrbit account is not allowed to upload books.');
        case 'UPLOAD_DESTINATION_CONFLICT':
          return _('A file with this name already exists in your BookOrbit library.');
        case 'UPLOAD_FORMAT_UNSUPPORTED':
        case 'UPLOAD_FORMAT_NOT_ALLOWED':
          return _('Your BookOrbit library does not accept this format.');
        case 'UPLOAD_TOO_LARGE':
          return _("This book is larger than BookOrbit's upload limit.");
      }
      const detail = error instanceof Error ? error.message : String(error);
      return `${_('Failed to push the book to BookOrbit')}: ${detail}`;
    };

    const handlePush = async (event: CustomEvent) => {
      if (event.detail?.bookKey !== bookKey || pushing.current || !appService) return;
      const book = getBookData(bookKey)?.book;
      if (!book) return;
      const bookorbit = useSettingsStore.getState().settings.bookorbit;
      const client = createBookOrbitClient();
      if (!client) {
        // Connections made before the password was kept have only the
        // KOReader key, which BookOrbit's upload API does not accept.
        toast('error', _('Reconnect BookOrbit in Settings > Integrations to push books.'));
        return;
      }

      pushing.current = true;
      toast('info', _('Pushing to BookOrbit…'), 60_000);
      try {
        const { file } = await appService.loadBookContent(book);
        const syncClient = bookorbit.userkey ? new BookOrbitSyncClient(bookorbit) : null;
        const result = await pushBookToBookOrbit({
          client,
          file,
          filename: getLocalBookFilename(book).split('/').pop()!,
          hash: book.hash,
          libraryId: bookorbit.uploadLibraryId,
          findExisting: syncClient
            ? async (hash) => {
                const { matches } = await syncClient.matchCheck([
                  { hash, title: book.title, authors: book.author, source: 'current_file' },
                ]);
                return matches.find((m) => m.hash === hash)?.bookId ?? null;
              }
            : undefined,
          onProgress: (fraction) =>
            toast(
              'info',
              _('Pushing to BookOrbit… {{percent}}%', { percent: Math.round(fraction * 100) }),
              60_000,
            ),
        });
        toast(
          'info',
          result.status === 'exists'
            ? _('This book is already in your BookOrbit library.')
            : _('Book pushed to BookOrbit.'),
        );
      } catch (error) {
        console.warn('[BookOrbit] push failed', error);
        toast('error', errorMessage(error), 8000);
      } finally {
        pushing.current = false;
      }
    };

    eventDispatcher.on('bookorbit-push-book', handlePush);
    return () => eventDispatcher.off('bookorbit-push-book', handlePush);
  }, [bookKey, appService, getBookData, _]);
};
