/**
 * `.gitignore`-style include/ignore rules for the files a watched folder
 * auto-imports.
 *
 * Rules are one pattern per line, evaluated against each file's path relative
 * to the watched folder, and the last matching rule wins:
 *   - `#` starts a comment; blank lines are skipped
 *   - `!pattern` re-includes what an earlier rule ignored
 *   - a trailing `/` matches directories only
 *   - a leading `/`, or a `/` anywhere else, anchors the pattern to the folder
 *     root; otherwise it matches at any depth
 *   - `*` and `?` stay inside one path segment, `**` crosses segments
 *   - `\` escapes the next character (e.g. a leading `\#` or `\!`)
 *
 * As in git, a file inside an ignored directory cannot be re-included.
 * Matching is case-insensitive, like the extension check it sits next to.
 *
 * Web-page formats are ignored by default: a folder that holds saved or cached
 * pages (a scraper's HTTP cache, a browser's save-as directory) would
 * otherwise turn every page into a coverless library entry. Add `!*.html` to
 * bring them back.
 */

const DEFAULT_RULES = ['*.html', '*.htm', '*.mhtml', '*.mht'];

interface Rule {
  negated: boolean;
  dirOnly: boolean;
  regex: RegExp;
}

const escapeRegex = (char: string) => char.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/** Translate a gitignore glob body (no leading `/`, no trailing `/`) to regex source. */
const globToRegexSource = (glob: string): string => {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === '\\' && i + 1 < glob.length) {
      source += escapeRegex(glob[++i]!);
    } else if (char === '*' && glob[i + 1] === '*') {
      const atSegmentStart = i === 0 || glob[i - 1] === '/';
      if (atSegmentStart && glob[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else if (atSegmentStart && i + 2 === glob.length) {
        source += '.*';
        i += 1;
      } else {
        // `**` glued to other characters behaves like a single `*`.
        source += '[^/]*';
        i += 1;
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegex(char);
    }
  }
  return source;
};

const parseRule = (line: string): Rule | null => {
  let pattern = line.trimEnd();
  if (!pattern || pattern.startsWith('#')) return null;
  const negated = pattern.startsWith('!');
  if (negated) pattern = pattern.slice(1);
  const dirOnly = pattern.endsWith('/');
  if (dirOnly) pattern = pattern.slice(0, -1);
  const anchored = pattern.includes('/');
  if (pattern.startsWith('/')) pattern = pattern.slice(1);
  if (!pattern) return null;
  const prefix = anchored ? '^' : '^(?:.*/)?';
  return { negated, dirOnly, regex: new RegExp(`${prefix}${globToRegexSource(pattern)}$`, 'i') };
};

const parseRules = (text: string): Rule[] =>
  [...DEFAULT_RULES, ...text.split(/\r?\n/)].flatMap((line) => parseRule(line) ?? []);

/**
 * Build a predicate answering "should this file be auto-imported?" for paths
 * relative to a watched folder. `rules` is the folder's rules text, if any.
 */
export const createWatchedFolderFilter = (rules?: string): ((relativePath: string) => boolean) => {
  const parsed = parseRules(rules ?? '');
  const ignores = (path: string, isDir: boolean) => {
    let ignored = false;
    for (const rule of parsed) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.regex.test(path)) ignored = !rule.negated;
    }
    return ignored;
  };

  return (relativePath) => {
    const segments = relativePath
      .replace(/\\/g, '/')
      .replace(/^(\.\/|\/)+/, '')
      .split('/')
      .filter(Boolean);
    // Walk down from the root so an ignored directory shadows its contents.
    for (let i = 0; i < segments.length; i++) {
      const isDir = i < segments.length - 1;
      if (ignores(segments.slice(0, i + 1).join('/'), isDir)) return false;
    }
    return segments.length > 0;
  };
};
