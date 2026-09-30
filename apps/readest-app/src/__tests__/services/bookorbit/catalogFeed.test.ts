import { describe, expect, it } from 'vitest';
import {
  BOOKORBIT_CATALOG_ID,
  adaptBookOrbitCatalogJson,
  getBookOrbitCatalog,
  getBookOrbitCatalogHeaders,
} from '@/services/bookorbit/catalogFeed';
import type { OPDSFeed, OPDSPublication } from '@/types/opds';

const BASE = 'https://books.example.com/api/v1/koreader/plugin/catalog';

const settings = {
  serverUrl: 'https://books.example.com/',
  username: 'alice',
  userkey: 'md5key',
  customHeaders: { 'CF-Access-Client-Id': 'abc' },
};

describe('getBookOrbitCatalog', () => {
  it('returns a virtual catalog rooted at the KOReader catalog API', () => {
    expect(getBookOrbitCatalog(settings)).toEqual({
      id: BOOKORBIT_CATALOG_ID,
      name: 'BookOrbit',
      url: `${BASE}/root`,
    });
  });

  it('returns null until BookOrbit credentials are configured', () => {
    expect(getBookOrbitCatalog({ ...settings, userkey: '' })).toBeNull();
    expect(getBookOrbitCatalog({ ...settings, serverUrl: '' })).toBeNull();
    expect(getBookOrbitCatalog(undefined)).toBeNull();
  });
});

describe('getBookOrbitCatalogHeaders', () => {
  it('sends the KOReader credentials alongside the custom headers', () => {
    expect(getBookOrbitCatalogHeaders(settings)).toEqual({
      'CF-Access-Client-Id': 'abc',
      'X-Auth-User': 'alice',
      'X-Auth-Key': 'md5key',
    });
  });
});

describe('adaptBookOrbitCatalogJson', () => {
  it('maps the root into navigation with a templated search link', () => {
    const feed = adaptBookOrbitCatalogJson(
      {
        sections: [
          {
            id: 'libraries',
            title: 'Libraries',
            section: 'libraries',
            href: '/api/v1/koreader/plugin/catalog/sections/libraries',
          },
          {
            id: 'recent',
            title: 'Recently added',
            section: 'recent',
            booksHref: '/api/v1/koreader/plugin/catalog/books?sort=recently_added',
          },
        ],
      },
      `${BASE}/root`,
    ) as OPDSFeed;

    expect(feed.metadata.title).toBe('BookOrbit');
    expect(feed.navigation).toEqual([
      {
        title: 'Libraries',
        href: 'https://books.example.com/api/v1/koreader/plugin/catalog/sections/libraries',
        type: 'application/opds+json',
      },
      {
        title: 'Recently added',
        href: 'https://books.example.com/api/v1/koreader/plugin/catalog/books?sort=recently_added',
        type: 'application/opds+json',
      },
    ]);
    expect(feed.links).toContainEqual({
      rel: 'search',
      href: 'https://books.example.com/api/v1/koreader/plugin/catalog/books{?q}',
      type: 'application/opds+json',
      templated: true,
    });
  });

  it('maps a section response into navigation with paging links and counts', () => {
    const feed = adaptBookOrbitCatalogJson(
      {
        section: 'authors',
        items: [
          {
            id: 'a1',
            title: 'Ursula K. Le Guin',
            section: 'authors',
            count: 12,
            booksHref: '/api/v1/koreader/plugin/catalog/books?author=Ursula',
          },
          { id: 'empty', title: 'No link', section: 'authors' },
        ],
        nextUrl: '/api/v1/koreader/plugin/catalog/sections/authors?page=2',
        previousUrl: null,
      },
      `${BASE}/sections/authors`,
    ) as OPDSFeed;

    expect(feed.navigation).toEqual([
      {
        title: 'Ursula K. Le Guin',
        href: 'https://books.example.com/api/v1/koreader/plugin/catalog/books?author=Ursula',
        type: 'application/opds+json',
        properties: { numberOfItems: 12 },
      },
    ]);
    expect(feed.links).toContainEqual({
      rel: 'next',
      href: 'https://books.example.com/api/v1/koreader/plugin/catalog/sections/authors?page=2',
      type: 'application/opds+json',
    });
    expect(feed.links.find((l) => l.rel === 'previous')).toBeUndefined();
  });

  it('maps a books page into publications that link to their detail document', () => {
    const feed = adaptBookOrbitCatalogJson(
      {
        items: [
          {
            id: 7,
            title: 'A Wizard of Earthsea',
            authors: ['Ursula K. Le Guin'],
            seriesName: 'Earthsea',
            seriesIndex: 1,
            formats: ['epub'],
            hasCover: true,
            thumbnailUrl: '/api/v1/koreader/plugin/catalog/books/7/thumbnail',
            detailUrl: '/api/v1/koreader/plugin/catalog/books/7',
            updatedAt: '2026-09-01T00:00:00.000Z',
          },
        ],
        total: 41,
        page: 1,
        size: 20,
        nextUrl: '/api/v1/koreader/plugin/catalog/books?page=2&size=20',
        previousUrl: null,
      },
      `${BASE}/books`,
    ) as OPDSFeed;

    expect(feed.metadata.numberOfItems).toBe(41);
    expect(feed.publications).toHaveLength(1);
    const [pub] = feed.publications!;
    expect(pub!.metadata).toMatchObject({
      id: 'bookorbit:7',
      title: 'A Wizard of Earthsea',
      subtitle: 'Earthsea #1',
      updated: '2026-09-01T00:00:00.000Z',
      author: [{ name: 'Ursula K. Le Guin', links: [] }],
    });
    expect(pub!.links).toEqual([
      {
        rel: 'self',
        href: 'https://books.example.com/api/v1/koreader/plugin/catalog/books/7',
        type: 'application/opds-publication+json',
      },
    ]);
    expect(pub!.images).toEqual([
      {
        rel: 'http://opds-spec.org/image/thumbnail',
        href: 'https://books.example.com/api/v1/koreader/plugin/catalog/books/7/thumbnail',
        type: 'image/jpeg',
      },
    ]);
    expect(feed.links).toContainEqual({
      rel: 'next',
      href: 'https://books.example.com/api/v1/koreader/plugin/catalog/books?page=2&size=20',
      type: 'application/opds+json',
    });
  });

  it('maps a book detail into a publication with one acquisition link per file', () => {
    const pub = adaptBookOrbitCatalogJson(
      {
        id: 7,
        title: 'A Wizard of Earthsea',
        subtitle: null,
        authors: ['Ursula K. Le Guin'],
        seriesName: null,
        seriesIndex: null,
        description: 'A young mage.',
        publisher: 'Parnassus',
        publishedDate: '1968-01-01',
        language: 'en',
        isbn13: '9780547773742',
        genres: ['Fantasy'],
        hasCover: false,
        thumbnailUrl: null,
        detailUrl: '/api/v1/koreader/plugin/catalog/books/7',
        updatedAt: '2026-09-01T00:00:00.000Z',
        files: [
          {
            id: 70,
            format: 'epub',
            downloadUrl: '/api/v1/koreader/plugin/catalog/files/70/download',
          },
          {
            id: 71,
            format: 'cbz',
            downloadUrl: '/api/v1/koreader/plugin/catalog/files/71/download',
          },
          {
            id: 72,
            format: 'm4b',
            downloadUrl: '/api/v1/koreader/plugin/catalog/files/72/download',
          },
        ],
      },
      `${BASE}/books/7`,
    ) as OPDSPublication;

    expect(pub.metadata).toMatchObject({
      title: 'A Wizard of Earthsea',
      description: 'A young mage.',
      publisher: 'Parnassus',
      published: '1968-01-01',
      language: 'en',
      identifier: 'urn:isbn:9780547773742',
      subject: [{ name: 'Fantasy' }],
    });
    expect(pub.metadata.subtitle).toBeUndefined();
    expect(pub.images).toEqual([]);
    // Audio files are left out: they have no single-file acquisition in Readest.
    expect(pub.links).toEqual([
      {
        rel: 'http://opds-spec.org/acquisition',
        href: 'https://books.example.com/api/v1/koreader/plugin/catalog/files/70/download',
        type: 'application/epub+zip',
      },
      {
        rel: 'http://opds-spec.org/acquisition',
        href: 'https://books.example.com/api/v1/koreader/plugin/catalog/files/71/download',
        type: 'application/vnd.comicbook+zip',
      },
    ]);
  });

  it('returns null for JSON that is not a BookOrbit catalog response', () => {
    expect(adaptBookOrbitCatalogJson({ foo: 1 }, `${BASE}/root`)).toBeNull();
    expect(adaptBookOrbitCatalogJson(null, `${BASE}/root`)).toBeNull();
  });
});
