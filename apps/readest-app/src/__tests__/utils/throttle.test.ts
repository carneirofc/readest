import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { throttle } from '@/utils/throttle';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('throttle', () => {
  it('runs the first call at once and the last throttled call after the delay', () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 500);

    throttled('a');
    throttled('b');
    expect(fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('b');
  });

  // A component that unmounts with a trailing call pending must be able to drop
  // it, or it fires into a torn-down tree (and, in tests, after jsdom is gone).
  it('drops the pending trailing call on cancel', () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 500);

    throttled('a');
    throttled('b');
    throttled.cancel();

    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
