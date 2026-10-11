import { describe, expect, it } from 'vitest';
import { createWatchedFolderFilter } from '@/services/watchedFolderRules';

const imports = (rules: string | undefined, path: string) => createWatchedFolderFilter(rules)(path);

describe('createWatchedFolderFilter', () => {
  describe('built-in HTML default', () => {
    it('ignores web-page formats with no rules', () => {
      for (const p of ['a.html', 'x/b.htm', 'c.mhtml', 'd/e/f.mht']) {
        expect(imports(undefined, p)).toBe(false);
      }
    });

    it('still imports real book formats', () => {
      for (const p of ['a.epub', 'x/b.cbz', 'c.pdf', 'notes.txt']) {
        expect(imports(undefined, p)).toBe(true);
      }
    });

    it('can be re-included by a negated rule', () => {
      expect(imports('!*.html', 'a.html')).toBe(true);
      expect(imports('!*.html', 'x/y/a.html')).toBe(true);
      // Only html was re-included.
      expect(imports('!*.html', 'a.htm')).toBe(false);
    });

    it('re-includes everything web-page with a single wildcard negation', () => {
      expect(imports('!*.htm*\n!*.mht', 'a.mhtml')).toBe(false);
      expect(imports('!*.htm*', 'a.html')).toBe(true);
      expect(imports('!*.htm*', 'a.htm')).toBe(true);
    });
  });

  describe('gitignore syntax', () => {
    it('ignores blank lines and # comments', () => {
      expect(imports('# *.epub\n\n   \n', 'a.epub')).toBe(true);
    });

    it('matches an unanchored pattern at any depth', () => {
      expect(imports('*.cbz', 'a.cbz')).toBe(false);
      expect(imports('*.cbz', 'x/y/a.cbz')).toBe(false);
      expect(imports('draft.epub', 'x/draft.epub')).toBe(false);
    });

    it('trailing slash matches directories only, at any depth', () => {
      expect(imports('cache/', 'cache/a.epub')).toBe(false);
      expect(imports('cache/', 'x/cache/y/a.epub')).toBe(false);
      // A file named like the directory is not a directory.
      expect(imports('cache/', 'cache')).toBe(true);
      expect(imports('cache/', 'cachemore/a.epub')).toBe(true);
    });

    it('leading slash anchors to the watched folder root', () => {
      expect(imports('/cache/', 'cache/a.epub')).toBe(false);
      expect(imports('/cache/', 'x/cache/a.epub')).toBe(true);
    });

    it('a slash inside the pattern anchors it', () => {
      expect(imports('docs/*.epub', 'docs/a.epub')).toBe(false);
      expect(imports('docs/*.epub', 'x/docs/a.epub')).toBe(true);
      expect(imports('docs/*.epub', 'docs/sub/a.epub')).toBe(true);
    });

    it('* does not cross a slash, ** does', () => {
      expect(imports('a/*.epub', 'a/b/c.epub')).toBe(true);
      expect(imports('a/**/c.epub', 'a/b/c.epub')).toBe(false);
      expect(imports('a/**/c.epub', 'a/c.epub')).toBe(false);
      expect(imports('a/**', 'a/b/c.epub')).toBe(false);
      expect(imports('**/drafts/**', 'x/drafts/y/z.epub')).toBe(false);
    });

    it('? matches exactly one non-slash character', () => {
      expect(imports('vol?.cbz', 'vol1.cbz')).toBe(false);
      expect(imports('vol?.cbz', 'vol10.cbz')).toBe(true);
    });

    it('the last matching rule wins', () => {
      expect(imports('*.epub\n!keep.epub', 'keep.epub')).toBe(true);
      expect(imports('!keep.epub\n*.epub', 'keep.epub')).toBe(false);
    });

    it('cannot re-include a file whose parent directory is ignored', () => {
      expect(imports('cache/\n!cache/keep.epub', 'cache/keep.epub')).toBe(false);
    });

    it('a rule can include a file inside an otherwise ignored html cache', () => {
      expect(imports('!cache/**/*.html', 'cache/site/a.html')).toBe(true);
    });

    it('is case-insensitive and tolerates backslash paths', () => {
      expect(imports('*.CBZ', 'a.cbz')).toBe(false);
      expect(imports('cache/', 'x\\cache\\a.epub')).toBe(false);
      expect(imports(undefined, 'PAGE.HTML')).toBe(false);
    });

    it('treats regex metacharacters in a pattern literally', () => {
      expect(imports('a+b (1).epub', 'a+b (1).epub')).toBe(false);
      expect(imports('a+b (1).epub', 'aab (1).epub')).toBe(true);
    });

    it('supports escaping a leading # or !', () => {
      expect(imports('\\#tagged.epub', '#tagged.epub')).toBe(false);
      expect(imports('\\!bang.epub', '!bang.epub')).toBe(false);
    });
  });
});
