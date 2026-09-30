// Browsing a BookOrbit library through the OPDS browser. BookOrbit's OPDS feed
// needs a separate OPDS account and an admin toggle, but the JSON catalog its
// KOReader plugin uses accepts the sync credentials Readest already holds, so
// the OPDS page fetches that API and this module maps each response onto the
// OPDS 2.0 shapes the page already renders.
import { getMimeTypeFromFileExt } from '@/libs/document';
import type { OPDSFeed, OPDSGenericLink, OPDSNavigationItem, OPDSPublication } from '@/types/opds';
import { REL } from '@/types/opds';
import type { BookOrbitSettings } from '@/types/settings';
import { normalizeCustomHeaders } from '@/utils/customHeaders';

export const BOOKORBIT_CATALOG_ID = 'bookorbit';

const CATALOG_PATH = '/api/v1/koreader/plugin/catalog';
const OPDS2 = 'application/opds+json';
const OPDS2_PUBLICATION = 'application/opds-publication+json';

type Credentials = Pick<BookOrbitSettings, 'serverUrl' | 'username' | 'userkey' | 'customHeaders'>;

export const getBookOrbitCatalog = (settings?: Credentials | null) => {
  if (!settings?.serverUrl || !settings.username || !settings.userkey) return null;
  return {
    id: BOOKORBIT_CATALOG_ID,
    name: 'BookOrbit',
    url: `${settings.serverUrl.replace(/\/+$/, '')}${CATALOG_PATH}/root`,
  };
};

export const getBookOrbitCatalogHeaders = (settings: Credentials): Record<string, string> => ({
  ...normalizeCustomHeaders(settings.customHeaders),
  'X-Auth-User': settings.username,
  'X-Auth-Key': settings.userkey,
});

// Wire shapes, trimmed to the fields read here (see @bookorbit/types koreader.ts).
interface CatalogEntry {
  title: string;
  count?: number;
  href?: string;
  booksHref?: string;
}

interface CatalogFile {
  format: string;
  downloadUrl: string;
}

interface CatalogBook {
  id: number;
  title: string;
  authors: string[];
  seriesName?: string | null;
  seriesIndex?: number | string | null;
  thumbnailUrl: string | null;
  detailUrl: string;
  updatedAt?: string;
  subtitle?: string | null;
  description?: string | null;
  publisher?: string | null;
  publishedDate?: string | null;
  language?: string | null;
  isbn13?: string | null;
  isbn10?: string | null;
  genres?: string[];
  files?: CatalogFile[];
}

interface Paged {
  total?: number;
  nextUrl?: string | null;
  previousUrl?: string | null;
}

// Hrefs come back as server-absolute paths. They are resolved here, against the
// server URL, because on web the page's base URL is the same-origin proxy.
type Resolve = (href: string) => string;

const pagingLinks = ({ nextUrl, previousUrl }: Paged, abs: Resolve): OPDSGenericLink[] => [
  ...(previousUrl ? [{ rel: 'previous', href: abs(previousUrl), type: OPDS2 }] : []),
  ...(nextUrl ? [{ rel: 'next', href: abs(nextUrl), type: OPDS2 }] : []),
];

const toNavigation = (entries: CatalogEntry[], abs: Resolve): OPDSNavigationItem[] =>
  entries.flatMap((entry) => {
    const href = entry.href || entry.booksHref;
    if (!href) return [];
    return [
      {
        title: entry.title,
        href: abs(href),
        type: OPDS2,
        ...(entry.count !== undefined ? { properties: { numberOfItems: entry.count } } : {}),
      },
    ];
  });

const toPublication = (book: CatalogBook, abs: Resolve): OPDSPublication => {
  const series = book.seriesName
    ? `${book.seriesName}${book.seriesIndex != null ? ` #${book.seriesIndex}` : ''}`
    : undefined;
  const isbn = book.isbn13 || book.isbn10;
  const links: OPDSPublication['links'] = book.files
    ? book.files.flatMap((file) => {
        const type = getMimeTypeFromFileExt(file.format);
        // Audio and other non-book files have no single-file import path.
        if (type === 'application/octet-stream') return [];
        return [{ rel: REL.ACQ, href: abs(file.downloadUrl), type }];
      })
    : [{ rel: 'self', href: abs(book.detailUrl), type: OPDS2_PUBLICATION }];
  return {
    metadata: {
      id: `bookorbit:${book.id}`,
      title: book.title,
      subtitle: book.subtitle || series,
      updated: book.updatedAt,
      author: book.authors.map((name) => ({ name, links: [] })),
      ...(book.description ? { description: book.description } : {}),
      ...(book.publisher ? { publisher: book.publisher } : {}),
      ...(book.publishedDate ? { published: book.publishedDate } : {}),
      ...(book.language ? { language: book.language } : {}),
      ...(isbn ? { identifier: `urn:isbn:${isbn}` } : {}),
      ...(book.genres?.length ? { subject: book.genres.map((name) => ({ name })) } : {}),
    },
    links,
    images: book.thumbnailUrl
      ? [{ rel: REL.THUMBNAIL[0], href: abs(book.thumbnailUrl), type: 'image/jpeg' }]
      : [],
  };
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object';

/**
 * Map one BookOrbit catalog response onto the OPDS model: the root and a
 * section become navigation feeds, a books page becomes a publication feed
 * (each entry links to its detail document), and a book detail becomes a full
 * publication with one acquisition link per downloadable file. Returns null for
 * anything else.
 */
export const adaptBookOrbitCatalogJson = (
  json: unknown,
  url: string,
): OPDSFeed | OPDSPublication | null => {
  if (!isObject(json)) return null;
  const abs: Resolve = (href) => new URL(href, url).href;
  const selfLink = { rel: 'self', href: url, type: OPDS2 };

  if (Array.isArray(json['sections'])) {
    return {
      metadata: { title: 'BookOrbit' },
      links: [
        selfLink,
        // Built by hand: URL parsing would percent-encode the template braces.
        {
          rel: 'search',
          href: `${new URL(url).origin}${CATALOG_PATH}/books{?q}`,
          type: OPDS2,
          templated: true,
        },
      ],
      navigation: toNavigation(json['sections'] as CatalogEntry[], abs),
    };
  }
  if (typeof json['section'] === 'string' && Array.isArray(json['items'])) {
    return {
      metadata: {},
      links: [selfLink, ...pagingLinks(json as Paged, abs)],
      navigation: toNavigation(json['items'] as CatalogEntry[], abs),
    };
  }
  if (Array.isArray(json['items']) && typeof json['total'] === 'number') {
    return {
      metadata: { numberOfItems: json['total'] },
      links: [selfLink, ...pagingLinks(json as Paged, abs)],
      publications: (json['items'] as CatalogBook[]).map((book) => toPublication(book, abs)),
    };
  }
  if (typeof json['id'] === 'number' && Array.isArray(json['files'])) {
    return toPublication(json as unknown as CatalogBook, abs);
  }
  return null;
};
