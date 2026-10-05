// Library search must match CBZ ComicInfo.xml metadata (artists, characters,
// story arc…) plus series and publisher, not just title and author.
import { describe, expect, it } from 'vitest';

import { createBookFilter } from '@/app/library/utils/libraryUtils';
import { Book } from '@/types/book';

const comic: Book = {
  hash: 'hash-1',
  format: 'CBZ',
  title: 'Issue One',
  author: 'Some Writer',
  createdAt: 0,
  updatedAt: 0,
  metadata: {
    title: 'Issue One',
    author: 'Some Writer',
    language: 'en',
    series: 'Night Watch',
    publisher: 'Pulp House',
    comicInfo: {
      Penciller: 'Jane Inkwell',
      Characters: 'Spider Kid (Earth-2), Doc Gear',
      StoryArc: 'Clockwork Summer',
    },
  },
};

describe('createBookFilter with ComicInfo metadata', () => {
  it('matches ComicInfo field values', () => {
    expect(createBookFilter('inkwell')(comic)).toBe(true);
    expect(createBookFilter('doc gear')(comic)).toBe(true);
    expect(createBookFilter('clockwork')(comic)).toBe(true);
  });

  it('matches when the query is not a valid regex', () => {
    // Unbalanced paren: falls back to a plain substring match.
    expect(createBookFilter('kid (earth')(comic)).toBe(true);
  });

  it('matches series and publisher', () => {
    expect(createBookFilter('night watch')(comic)).toBe(true);
    expect(createBookFilter('pulp house')(comic)).toBe(true);
  });

  it('does not match unrelated terms', () => {
    expect(createBookFilter('dragon')(comic)).toBe(false);
  });
});
