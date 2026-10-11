import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { AppService } from '@/types/system';
import type { ABSServer } from '@/types/audiobookshelf';
import type { SystemSettings } from '@/types/settings';
import type { EnvConfigType } from '@/services/environment';

const appService = {} as AppService;
const envConfig = { getAppService: async () => appService } as EnvConfigType;

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService, envConfig }),
}));
// absServerStore publishes replica upserts/deletes from its mutators; those
// aren't exercised here (state is seeded directly via setState), but the
// module still imports replicaPublish at load time.
vi.mock('@/services/sync/replicaPublish', () => ({
  publishReplicaUpsert: vi.fn(),
  publishReplicaDelete: vi.fn(),
}));
vi.mock('@/services/audiobookshelf/librarySync', () => ({
  syncAllAbsServers: vi.fn(),
  backfillAbsCovers: vi.fn(),
}));

import { backfillAbsCovers, syncAllAbsServers } from '@/services/audiobookshelf/librarySync';
import { useABSServerStore } from '@/store/absServerStore';
import { useSettingsStore } from '@/store/settingsStore';
import { eventDispatcher } from '@/utils/event';
import { ABS_STARTUP_DELAY_MS, useABSSync } from '@/hooks/useABSSync';

const mockedSync = vi.mocked(syncAllAbsServers);
const mockedBackfill = vi.mocked(backfillAbsCovers);

// contentId/addedAt already set so loadABSServers' backfill is a no-op and
// doesn't fire an unrelated saveSettings call.
const server: ABSServer = {
  id: 's1',
  contentId: 's1',
  addedAt: 1,
  name: 'Home',
  url: 'http://abs.local',
};

const makeSettings = (overrides: Partial<SystemSettings> = {}): SystemSettings =>
  ({
    absServers: [],
    ...overrides,
  }) as unknown as SystemSettings;

// The startup refresh is deferred so the shelf (and a book open) is never
// competing with it; `settle` plays out that delay plus the async chain.
const settle = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ABS_STARTUP_DELAY_MS + 1);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  useABSServerStore.setState({ servers: [] });
  useSettingsStore.setState({
    settings: makeSettings(),
    setSettings: (s: SystemSettings) => useSettingsStore.setState({ settings: s }),
    saveSettings: vi.fn(),
  } as unknown as ReturnType<typeof useSettingsStore.getState>);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  useABSServerStore.setState({ servers: [] });
});

describe('useABSSync', () => {
  test('syncs once on mount when the store is already hydrated with servers', async () => {
    useABSServerStore.setState({ servers: [server] });
    useSettingsStore.setState({ settings: makeSettings({ absServers: [server] }) });
    mockedSync.mockResolvedValue();

    renderHook(() => useABSSync());
    await settle();

    expect(mockedSync).toHaveBeenCalledTimes(1);
    expect(mockedSync).toHaveBeenCalledWith(appService, { force: false });
  });

  test('backfills covers before the authenticated sync so a failing login cannot block them', async () => {
    useABSServerStore.setState({ servers: [server] });
    const order: string[] = [];
    mockedBackfill.mockImplementation(async () => {
      order.push('backfill');
    });
    mockedSync.mockImplementation(async () => {
      order.push('sync');
    });

    renderHook(() => useABSSync());
    await settle();

    expect(order).toEqual(['backfill', 'sync']);
    expect(mockedBackfill).toHaveBeenCalledWith(appService);
  });

  test('does not sync when neither the store nor settings have servers', async () => {
    mockedSync.mockResolvedValue();

    renderHook(() => useABSSync());
    await settle();

    expect(mockedSync).not.toHaveBeenCalled();
  });

  test('hydrates the empty store from settings on mount, then syncs', async () => {
    // Reproduces the fresh-boot bug: the store was never populated (no
    // IntegrationsPanel mount, no replica pull), but settings.absServers
    // already has the persisted server. The hook must hydrate before its
    // empty-store no-op check runs.
    useSettingsStore.setState({ settings: makeSettings({ absServers: [server] }) });
    mockedSync.mockResolvedValue();

    renderHook(() => useABSSync());
    await settle();

    expect(useABSServerStore.getState().getAvailableServers()).toEqual([server]);
    expect(mockedSync).toHaveBeenCalledTimes(1);
    expect(mockedSync).toHaveBeenCalledWith(appService, { force: false });
  });

  // `EnvProvider` publishes `appService` BEFORE `appService.loadSettings()`
  // resolves, so the mount-time hydration can read the `{}` placeholder
  // settings. Caching that empty result stranded ABS sync for the whole
  // session — and left every `saveABSServers` publishing an empty list.
  test('re-hydrates when the first attempt ran before settings loaded', async () => {
    useSettingsStore.setState({ settings: {} as SystemSettings });
    mockedSync.mockResolvedValue();

    renderHook(() => useABSSync());
    await settle();
    expect(mockedSync).not.toHaveBeenCalled();

    // Settings land after that first attempt.
    useSettingsStore.setState({ settings: makeSettings({ absServers: [server] }) });
    await act(async () => {
      await eventDispatcher.dispatch('sync-abs-servers');
    });

    expect(useABSServerStore.getState().getAvailableServers()).toEqual([server]);
    expect(mockedSync).toHaveBeenCalledTimes(1);
  });

  test('the sync-abs-servers event triggers a run', async () => {
    mockedSync.mockResolvedValue();

    renderHook(() => useABSSync());
    await settle();
    expect(mockedSync).not.toHaveBeenCalled();

    useABSServerStore.setState({ servers: [server] });
    await act(async () => {
      await eventDispatcher.dispatch('sync-abs-servers');
    });

    expect(mockedSync).toHaveBeenCalledTimes(1);
  });

  test('unmount clears the interval', async () => {
    useABSServerStore.setState({ servers: [server] });
    useSettingsStore.setState({ settings: makeSettings({ absServers: [server] }) });
    mockedSync.mockResolvedValue();

    const { unmount } = renderHook(() => useABSSync());
    await settle();
    expect(mockedSync).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    });

    expect(mockedSync).toHaveBeenCalledTimes(1);
  });

  test('does not sync before the startup delay elapses', async () => {
    useABSServerStore.setState({ servers: [server] });
    mockedSync.mockResolvedValue();

    renderHook(() => useABSSync());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ABS_STARTUP_DELAY_MS - 1);
    });

    expect(mockedSync).not.toHaveBeenCalled();
    expect(mockedBackfill).not.toHaveBeenCalled();
  });

  test('unmount before the startup delay cancels the pending sync', async () => {
    useABSServerStore.setState({ servers: [server] });
    mockedSync.mockResolvedValue();

    const { unmount } = renderHook(() => useABSSync());
    unmount();
    await settle();

    expect(mockedSync).not.toHaveBeenCalled();
  });

  test('an explicit sync request runs immediately and forces past the freshness window', async () => {
    useABSServerStore.setState({ servers: [server] });
    mockedSync.mockResolvedValue();

    renderHook(() => useABSSync());
    await act(async () => {
      await eventDispatcher.dispatch('sync-abs-servers');
    });

    expect(mockedSync).toHaveBeenCalledTimes(1);
    expect(mockedSync).toHaveBeenCalledWith(appService, { force: true });
  });

  test('interval ticks sync without forcing and skip the full-library cover backfill', async () => {
    useABSServerStore.setState({ servers: [server] });
    mockedSync.mockResolvedValue();

    renderHook(() => useABSSync());
    await settle();
    expect(mockedBackfill).toHaveBeenCalledTimes(1);
    mockedBackfill.mockClear();
    mockedSync.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    });

    expect(mockedSync).toHaveBeenCalledWith(appService, { force: false });
    expect(mockedBackfill).not.toHaveBeenCalled();
  });

  test('interval ticks do nothing while the document is hidden', async () => {
    useABSServerStore.setState({ servers: [server] });
    mockedSync.mockResolvedValue();

    renderHook(() => useABSSync());
    await settle();
    mockedSync.mockClear();

    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      });
      expect(mockedSync).not.toHaveBeenCalled();
    } finally {
      hidden.mockRestore();
    }
  });
});
