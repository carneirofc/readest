import { describe, it, expect, afterEach } from 'vitest';
import { buildSectionTextModel, applyGlosses, clearGlosses } from '@/app/reader/utils/wordlensRuby';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Word Lens rendering (browser)', () => {
  it('renders a gloss above a word, then clears cleanly', () => {
    document.body.innerHTML = `<div id="root" style="font-size:16px;line-height:1.2"><p>A cryptic note appears.</p></div>`;
    const root = document.getElementById('root')!;

    const model = buildSectionTextModel(document);
    const start = model.text.indexOf('cryptic');
    applyGlosses(document, model, [
      { start, end: start + 'cryptic'.length, word: 'cryptic', gloss: '晦涩的' },
    ]);

    const ruby = document.querySelector('ruby.wl-gloss')!;
    const rt = ruby.querySelector('rt')!;
    expect(rt.textContent).toBe('晦涩的');
    // The annotation gets its own box sitting above the base word. Whether it
    // also grows the line box depends on the engine: Chromium builds from
    // Playwright 1.63 on let the annotation overflow into the leading instead,
    // so assert the placement rather than the line height.
    const rubyBox = ruby.getBoundingClientRect();
    const rtBox = rt.getBoundingClientRect();
    expect(rtBox.height).toBeGreaterThan(0);
    expect(rtBox.top).toBeLessThan(rubyBox.top);
    expect(rtBox.left).toBeGreaterThanOrEqual(rubyBox.left - 1);
    expect(rtBox.right).toBeLessThanOrEqual(rubyBox.right + 1);

    clearGlosses(document);
    expect(document.querySelector('ruby.wl-gloss')).toBeNull();
    expect(root.textContent).toBe('A cryptic note appears.');
  });
});
