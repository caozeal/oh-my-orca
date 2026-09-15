import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StartedMacOSProviderSocket } from './macos-native-provider-transport'

const {
  chmodSyncMock,
  connectMacOSProviderSocketMock,
  mkdtempSyncMock,
  rmSyncMock,
  spawnMock,
  spawnSyncMock,
  writeFileSyncMock
} = vi.hoisted(() => ({
  chmodSyncMock: vi.fn(),
  connectMacOSProviderSocketMock: vi.fn(),
  mkdtempSyncMock: vi.fn(),
  rmSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock
}))

vi.mock('fs', () => ({
  chmodSync: chmodSyncMock,
  mkdtempSync: mkdtempSyncMock,
  rmSync: rmSyncMock,
  writeFileSync: writeFileSyncMock
}))

vi.mock('./macos-native-provider-socket', () => ({
  connectMacOSProviderSocket: connectMacOSProviderSocketMock
}))

const HELPER_APP_PATH = '/Applications/Orca Computer Use.app'
const SOCKET_DIRECTORY = 'orca-computer-use-transport-test'
const SOCKET_PATH = join(SOCKET_DIRECTORY, 'provider.sock')
const SOCKET_TOKEN_PATH = join(SOCKET_DIRECTORY, 'provider.token')
const PROVIDER_PATTERN = `orca-computer-use-macos --agent ${SOCKET_PATH}`

class FakeStderr extends EventEmitter {
  setEncoding(): void {}
}

class FakeProvider extends EventEmitter {
  stderr = new FakeStderr()
  unref = vi.fn()
}

type StartProvider = (options: {
  helperAppPath: string
  isCurrent: (socketPath: string) => boolean
}) => Promise<StartedMacOSProviderSocket>

type TransportHarness = {
  start: StartProvider
  stalledSocket: Error & { code: string }
}

// Why: resetModules hands the transport a fresh error class, so the test builds
// its errors from the same registry or the instanceof check cannot hold.
async function loadHarness(): Promise<TransportHarness> {
  vi.resetModules()
  const [{ startMacOSNativeProviderSocket }, { RuntimeClientError: RuntimeError }] =
    await Promise.all([
      import('./macos-native-provider-transport'),
      import('./runtime-client-error')
    ])
  return {
    start: startMacOSNativeProviderSocket,
    stalledSocket: new RuntimeError(
      'action_timeout',
      'native macOS helper app did not open its socket: connect ENOENT'
    )
  }
}

describe('startMacOSNativeProviderSocket', () => {
  const providers: FakeProvider[] = []

  beforeEach(() => {
    providers.length = 0
    mkdtempSyncMock.mockReturnValue(SOCKET_DIRECTORY)
    spawnMock.mockImplementation(() => {
      const provider = new FakeProvider()
      providers.push(provider)
      return provider
    })
    spawnSyncMock.mockReturnValue({ status: 0 })
  })

  afterEach(() => {
    chmodSyncMock.mockReset()
    connectMacOSProviderSocketMock.mockReset()
    mkdtempSyncMock.mockReset()
    rmSyncMock.mockReset()
    spawnMock.mockReset()
    spawnSyncMock.mockReset()
    writeFileSyncMock.mockReset()
  })

  // Why: the helper only owns its Accessibility grant when LaunchServices starts
  // it; a bare spawn hands the grant decision to the Orca app instead.
  it('launches the helper app bundle through LaunchServices', async () => {
    connectMacOSProviderSocketMock.mockRejectedValue(new Error('socket did not open'))
    const { start } = await loadHarness()

    await expect(start({ helperAppPath: HELPER_APP_PATH, isCurrent: () => true })).rejects.toThrow(
      'socket did not open'
    )

    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['-n', HELPER_APP_PATH, '--args', '--agent', SOCKET_PATH, '--token-file', SOCKET_TOKEN_PATH],
      { detached: true, stdio: ['ignore', 'ignore', 'pipe'] }
    )
    expect(writeFileSyncMock).toHaveBeenCalledWith(SOCKET_TOKEN_PATH, expect.any(String), {
      encoding: 'utf8',
      mode: 0o600
    })
  })

  it('stops only the helper launched for this socket path', async () => {
    connectMacOSProviderSocketMock.mockRejectedValue(new Error('socket did not open'))
    const { start } = await loadHarness()

    await expect(start({ helperAppPath: HELPER_APP_PATH, isCurrent: () => true })).rejects.toThrow(
      'socket did not open'
    )

    expect(spawnSyncMock).toHaveBeenCalledWith('/usr/bin/pkill', ['-f', PROVIDER_PATTERN], {
      stdio: 'ignore'
    })
    expect(rmSyncMock).toHaveBeenCalledWith(SOCKET_DIRECTORY, { recursive: true, force: true })
  })

  // Why: `open` exits as soon as LaunchServices owns the app, so a clean exit is
  // handover, not the helper dying before it connected.
  it('keeps waiting for the socket when the launch command exits cleanly', async () => {
    connectMacOSProviderSocketMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(undefined), 0))
    )
    const { start } = await loadHarness()

    const started = start({ helperAppPath: HELPER_APP_PATH, isCurrent: () => true })
    providers[0]!.emit('exit', 0, null)

    await expect(started).resolves.toMatchObject({ socketPath: SOCKET_PATH })
  })

  it('rejects a launch command that exits non-zero', async () => {
    connectMacOSProviderSocketMock.mockImplementation(() => new Promise(() => {}))
    const { start } = await loadHarness()

    const started = start({ helperAppPath: HELPER_APP_PATH, isCurrent: () => true })
    providers[0]!.emit('exit', 13, null)

    await expect(started).rejects.toThrow('native macOS helper app launch command failed: code 13')
  })

  it('rejects a launch command that fails to start', async () => {
    connectMacOSProviderSocketMock.mockImplementation(() => new Promise(() => {}))
    const { start } = await loadHarness()

    const started = start({ helperAppPath: HELPER_APP_PATH, isCurrent: () => true })
    providers[0]!.emit('error', new Error('spawn ENOENT'))

    await expect(started).rejects.toThrow('native macOS helper app failed to start: spawn ENOENT')
  })

  // Why: LaunchServices hides the helper's exit code, so the stalled socket plus a
  // process check is what separates a hung helper from one that never started.
  it('reports a helper that runs but never opens its socket', async () => {
    const { start, stalledSocket } = await loadHarness()
    connectMacOSProviderSocketMock.mockRejectedValue(stalledSocket)

    await expect(start({ helperAppPath: HELPER_APP_PATH, isCurrent: () => true })).rejects.toThrow(
      'The helper process is running but did not open its socket.'
    )
    expect(spawnSyncMock).toHaveBeenCalledWith('/usr/bin/pgrep', ['-f', PROVIDER_PATTERN], {
      stdio: 'ignore'
    })
  })

  it('surfaces launch stderr when no helper process is running', async () => {
    const { start, stalledSocket } = await loadHarness()
    connectMacOSProviderSocketMock.mockRejectedValue(stalledSocket)
    spawnSyncMock.mockImplementation((command: string) => ({
      status: command === '/usr/bin/pgrep' ? 1 : 0
    }))

    const started = start({ helperAppPath: HELPER_APP_PATH, isCurrent: () => true })
    providers[0]!.stderr.emit('data', 'The application cannot be opened.')

    await expect(started).rejects.toThrow(
      'No helper process is running: The application cannot be opened.'
    )
  })
})
