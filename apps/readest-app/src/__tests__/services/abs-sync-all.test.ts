import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ABS_SYNC_FRESH_MS, syncAllAbsServers } from '@/services/audiobookshelf/librarySync';
import { useABSServerStore } from '@/store/absServerStore';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import type { ABSLibraryItem, ABSServer } from '@/types/audiobookshelf';
import type { AppService } from '@/types/system';
import type { SystemSettings } from '@/types/settings';

vi.mock('@/services/sync/replicaPublish', () => ({
  publishReplicaUpsert: vi.fn(),
  publishReplicaDelete: vi.fn(),
}));
vi.mock('@/libs/storage', () => ({ downloadFile: vi.fn() }));

const items: ABSLibraryItem[] = [];
const client = {
  getLibraries: vi.fn(async () => [{ id: 'lib1', mediaType: 'book' }]),
  getLibraryItems: vi.fn(async () => items),
  getMe: vi.fn(async () => ({ mediaProgress: [] })),
  buildCoverUrl: (id: string) => `http://abs.local/api/items/${id}/cover`,
};
vi.mock('@/services/audiobookshelf/createClient', () => ({
  createAbsClient: () => client,
}));

const makeServer = (overrides: Partial<ABSServer> = {}): ABSServer => ({
  id: 'srv1',
  contentId: 'srv1',
  addedAt: 1,
  name: 'Home',
  url: 'http://abs.local',
  ...overrides,
});

const makeAppService = () =>
  ({
    exists: vi.fn(async () => true),
    saveLibraryBooks: vi.fn(async () => {}),
  }) as unknown as AppService;

describe('syncAllAbsServers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    items.length = 0;
    useLibraryStore.setState({ library: [] });
    useSettingsStore.setState({
      settings: { absServers: [] } as unknown as SystemSettings,
      setSettings: (s: SystemSettings) => useSettingsStore.setState({ settings: s }),
      saveSettings: vi.fn(),
    } as unknown as ReturnType<typeof useSettingsStore.getState>);
  });

  it('skips a server synced within the freshness window', async () => {
    useABSServerStore.setState({ servers: [makeServer({ lastSyncedAt: Date.now() - 1000 })] });

    await syncAllAbsServers(makeAppService());

    expect(client.getLibraries).not.toHaveBeenCalled();
  });

  it('syncs a stale or never-synced server', async () => {
    useABSServerStore.setState({
      servers: [makeServer({ lastSyncedAt: Date.now() - ABS_SYNC_FRESH_MS - 1 })],
    });

    await syncAllAbsServers(makeAppService());

    expect(client.getLibraries).toHaveBeenCalledTimes(1);
  });

  it('force bypasses the freshness window', async () => {
    useABSServerStore.setState({ servers: [makeServer({ lastSyncedAt: Date.now() - 1000 })] });

    await syncAllAbsServers(makeAppService(), { force: true });

    expect(client.getLibraries).toHaveBeenCalledTimes(1);
  });

  it('does not rewrite the library when the server has nothing new', async () => {
    useABSServerStore.setState({ servers: [makeServer()] });
    const appService = makeAppService();

    await syncAllAbsServers(appService, { force: true });

    expect(client.getLibraries).toHaveBeenCalledTimes(1);
    expect(appService.saveLibraryBooks).not.toHaveBeenCalled();
  });

  it('shelves new items and saves once', async () => {
    items.push({
      id: 'i1',
      mediaType: 'book',
      media: { metadata: { title: 'Peter Pan', authorName: 'A' }, duration: 10, numAudioFiles: 1 },
    });
    useABSServerStore.setState({ servers: [makeServer()] });
    const appService = makeAppService();

    await syncAllAbsServers(appService, { force: true });

    expect(useLibraryStore.getState().library).toHaveLength(1);
    expect(appService.saveLibraryBooks).toHaveBeenCalledTimes(1);
  });
});
