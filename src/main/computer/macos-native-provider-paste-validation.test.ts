import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../shared/clipboard-text'

const {
  chmodSyncMock,
  connectMacOSProviderSocketMock,
  mkdtempSyncMock,
  resolveMacOSComputerUseAppPathMock,
  rmSyncMock,
  spawnMock,
  spawnSyncMock,
  writeFileSyncMock
} = vi.hoisted(() => ({
  chmodSyncMock: vi.fn(),
  connectMacOSProviderSocketMock: vi.fn(),
  mkdtempSyncMock: vi.fn(),
  resolveMacOSComputerUseAppPathMock: vi.fn(),
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

vi.mock('./macos-native-provider-paths', () => ({
  resolveMacOSComputerUseAppPath: resolveMacOSComputerUseAppPathMock
}))

vi.mock('./macos-native-provider-socket', () => ({
  connectMacOSProviderSocket: connectMacOSProviderSocketMock
}))

class FakeSocket extends EventEmitter {
  destroyed = false
  writes: string[] = []

  setEncoding(): void {}

  write(line: string, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(line)
    callback?.(null)
    return true
  }

  end(): void {
    this.destroyed = true
  }

  destroy(): this {
    this.destroyed = true
    return this
  }
}

class FakeProvider extends EventEmitter {
  stderr = null
  unref = vi.fn()
}

async function loadClientModule() {
  vi.resetModules()
  return await import('./macos-native-provider-client')
}

function macOSProviderCapabilities() {
  return {
    platform: 'darwin',
    provider: 'orca-computer-use-macos',
    providerVersion: '1.0.0',
    protocolVersion: 1,
    supports: {
      actions: {
        pasteText: true
      }
    }
  }
}

describe('MacOSNativeProviderClient paste validation', () => {
  const sockets: FakeSocket[] = []
  const providers: FakeProvider[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    sockets.length = 0
    providers.length = 0
    mkdtempSyncMock.mockImplementation((prefix: string) => `${prefix}${sockets.length}`)
    resolveMacOSComputerUseAppPathMock.mockReturnValue('/Applications/Orca Computer Use.app')
    spawnMock.mockImplementation(() => {
      const provider = new FakeProvider()
      providers.push(provider)
      return provider
    })
    spawnSyncMock.mockReturnValue({ status: 0 })
    connectMacOSProviderSocketMock.mockImplementation(async () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    })
  })

  afterEach(() => {
    chmodSyncMock.mockReset()
    connectMacOSProviderSocketMock.mockReset()
    mkdtempSyncMock.mockReset()
    resolveMacOSComputerUseAppPathMock.mockReset()
    rmSyncMock.mockReset()
    spawnMock.mockReset()
    spawnSyncMock.mockReset()
    writeFileSyncMock.mockReset()
    vi.useRealTimers()
  })

  it('yields while validating large accepted pasteText payloads before starting the helper', async () => {
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()
    const text = 'é'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)

    const call = client.action('pasteText', { app: 'TextEdit', text })
    await Promise.resolve()

    expect(providers).toHaveLength(0)
    expect(sockets).toHaveLength(0)
    expect(spawnMock).not.toHaveBeenCalled()
    expect(connectMacOSProviderSocketMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    const socket = sockets[0]!
    await vi.waitFor(() => expect(socket.writes).toHaveLength(1))
    const handshakeRequest = JSON.parse(socket.writes[0]!) as { id: number }
    socket.emit(
      'data',
      `${JSON.stringify({
        id: handshakeRequest.id,
        ok: true,
        result: macOSProviderCapabilities()
      })}\n`
    )
    await vi.waitFor(() => expect(socket.writes).toHaveLength(2))
    const actionRequest = JSON.parse(socket.writes[1]!) as { id: number }
    socket.emit(
      'data',
      `${JSON.stringify({
        id: actionRequest.id,
        ok: true,
        result: { action: { path: 'clipboard', actionName: 'paste' } }
      })}\n`
    )

    await expect(call).resolves.toMatchObject({
      action: { path: 'clipboard' }
    })
  })
})
