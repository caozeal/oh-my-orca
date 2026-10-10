import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type net from 'node:net'
import { release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { connectMacOSProviderSocket } from './macos-native-provider-socket'
import {
  reapMacOSProviderProcess,
  type MacOSProviderProcessOwner
} from './macos-native-provider-process-reaping'
import { RuntimeClientError } from './runtime-client-error'

const HELPER_CONNECT_TIMEOUT_MS = 10_000
const HELPER_EXECUTABLE_NAME = 'orca-computer-use-macos'

export type StartedMacOSProviderSocket = {
  socket: net.Socket
  socketDirectory: string
  socketPath: string
  socketToken: string
}

export function isMacOS14OrNewer(): boolean {
  const darwinMajor = Number.parseInt(release().split('.')[0] ?? '', 10)
  return Number.isFinite(darwinMajor) && darwinMajor >= 23
}

// Why: Node treats unhandled socket 'error' events as process exceptions, so
// stale helper sockets keep a no-op listener that does not retain the client.
export function ignoreStaleSocketError(): void {}

export function attachMacOSNativeProviderSocketListeners(
  socket: net.Socket,
  listeners: {
    data: (chunk: string) => void
    close: () => void
    error: (error: Error) => void
  }
): () => void {
  socket.on('data', listeners.data)
  socket.on('close', listeners.close)
  socket.on('error', listeners.error)
  return () => {
    socket.off('data', listeners.data)
    socket.off('close', listeners.close)
    socket.off('error', listeners.error)
    socket.off('error', ignoreStaleSocketError)
    socket.on('error', ignoreStaleSocketError)
  }
}

export class NativeProviderLineBuffer {
  private pending = ''
  private hasCompleteLine = false

  push(chunk: string, handleLine: (line: string) => void): void {
    this.pending += chunk
    this.hasCompleteLine ||= chunk.endsWith('\n') || chunk.includes('\n')
    if (!this.hasCompleteLine) {
      return
    }
    // Keep complete lines retryable if a callback throws.
    this.pending = consumeNativeProviderLines(this.pending, handleLine)
    this.hasCompleteLine = false
  }

  clear(): void {
    this.pending = ''
    this.hasCompleteLine = false
  }
}

export function consumeNativeProviderLines(
  buffer: string,
  handleLine: (line: string) => void
): string {
  let remaining = buffer
  while (true) {
    const newline = remaining.indexOf('\n')
    if (newline === -1) {
      return remaining
    }
    const line = remaining.slice(0, newline)
    remaining = remaining.slice(newline + 1)
    if (line.trim()) {
      handleLine(line)
    }
  }
}

export async function startMacOSNativeProviderSocket({
  helperAppPath,
  isCurrent,
  providerProcess
}: {
  helperAppPath: string
  isCurrent: (socketPath: string) => boolean
  providerProcess: MacOSProviderProcessOwner
}): Promise<StartedMacOSProviderSocket> {
  const socketDirectory = mkdtempSync(join(tmpdir(), 'orca-computer-use-'))
  chmodSync(socketDirectory, 0o700)
  const socketPath = join(socketDirectory, 'provider.sock')
  const socketToken = randomUUID()
  const socketTokenPath = join(socketDirectory, 'provider.token')
  writeFileSync(socketTokenPath, socketToken, { encoding: 'utf8', mode: 0o600 })
  // Why: the helper only owns its TCC grants when LaunchServices launches it.
  // Spawning it directly makes macOS treat the responsible process — the Orca
  // app — as the Accessibility client, so the helper's own grant is never read
  // and every accessibility call is denied.
  const provider = spawnProvider(helperAppPath, socketPath, socketTokenPath)
  // Why: own the launch from birth. Adopting only after connect leaves a window
  // where a quit during startup strands it with nobody holding the handle.
  providerProcess.adopt(provider)
  const providerFailure = waitForProviderLaunchFailure(provider)
  const connectAbort = new AbortController()
  try {
    const socket = await Promise.race([
      connectMacOSProviderSocket(socketPath, HELPER_CONNECT_TIMEOUT_MS, connectAbort.signal),
      providerFailure.promise
    ])
    providerFailure.cleanup()
    rmSync(socketTokenPath, { force: true })
    if (!isCurrent(socketPath)) {
      socket.destroy()
      throw new RuntimeClientError(
        'accessibility_error',
        'native macOS provider startup was superseded'
      )
    }
    return { socket, socketDirectory, socketPath, socketToken }
  } catch (error) {
    connectAbort.abort()
    providerFailure.cleanup()
    // Why: `open` exits once LaunchServices owns the app, so the helper is left
    // as a launchd child and this socket path is the only handle on it.
    stopProviderForSocket(socketPath)
    // Why: escalate on the spawned handle too, so an `open` wedged past spawn
    // cannot outlive the failed attempt.
    reapMacOSProviderProcess(provider)
    // Each attempt owns a unique directory, even after its generation is superseded.
    cleanupSocketDirectory(socketDirectory)
    throw withProviderStartupHint(error, socketPath, providerFailure.stderr)
  }
}

function cleanupSocketDirectory(socketDirectory: string): void {
  rmSync(socketDirectory, { recursive: true, force: true })
}

function spawnProvider(
  helperAppPath: string,
  socketPath: string,
  socketTokenPath: string
): ChildProcess {
  const provider = spawn(
    '/usr/bin/open',
    ['-n', helperAppPath, '--args', '--agent', socketPath, '--token-file', socketTokenPath],
    { detached: true, stdio: ['ignore', 'ignore', 'pipe'] }
  )
  provider.unref()
  return provider
}

function waitForProviderLaunchFailure(provider: ChildProcess): {
  promise: Promise<never>
  cleanup: () => void
  stderr: () => string
} {
  let cleanup = (): void => {}
  let stderrText = ''
  const promise = new Promise<never>((_resolve, reject) => {
    const fail = (error: Error) => {
      reject(
        new RuntimeClientError(
          'accessibility_error',
          `native macOS helper app failed to start: ${error.message}`
        )
      )
    }
    const exit = (code: number | null, signal: NodeJS.Signals | null) => {
      // Why: `open` exits 0 as soon as LaunchServices takes over the app, so a
      // clean exit is not the helper dying — only a non-zero one is a failure.
      if (code === 0) {
        return
      }
      const detail = typeof code === 'number' ? `code ${code}` : `signal ${signal ?? 'unknown'}`
      reject(
        new RuntimeClientError(
          'accessibility_error',
          `native macOS helper app launch command failed: ${detail}`
        )
      )
    }
    const onStderrData = (chunk: string): void => {
      stderrText += chunk
    }
    provider.stderr?.setEncoding('utf8')
    provider.stderr?.on('data', onStderrData)
    provider.once('error', fail)
    provider.once('exit', exit)
    cleanup = () => {
      provider.off('error', fail)
      provider.off('exit', exit)
      provider.stderr?.off('data', onStderrData)
    }
  })
  return { promise, cleanup, stderr: () => stderrText }
}

/** Identifies one helper by the socket path it was launched with. */
function providerProcessPattern(socketPath: string): string {
  return `${HELPER_EXECUTABLE_NAME} --agent ${socketPath}`
}

function providerProcessIsRunning(socketPath: string): boolean {
  const found = spawnSync('/usr/bin/pgrep', ['-f', providerProcessPattern(socketPath)], {
    stdio: 'ignore'
  })
  return found.status === 0
}

function stopProviderForSocket(socketPath: string): void {
  spawnSync('/usr/bin/pkill', ['-f', providerProcessPattern(socketPath)], { stdio: 'ignore' })
}

function withProviderStartupHint(
  error: unknown,
  socketPath: string,
  launchStderr: () => string
): unknown {
  // Why: LaunchServices owns the helper now, so its exit code is unobservable and
  // a stalled socket is the only remaining evidence of how startup failed.
  if (!(error instanceof RuntimeClientError) || error.code !== 'action_timeout') {
    return error
  }
  const detail = launchStderr().trim()
  const hint = providerProcessIsRunning(socketPath)
    ? 'The helper process is running but did not open its socket.'
    : `No helper process is running${detail ? `: ${detail}` : '.'}`
  return new RuntimeClientError(error.code, `${error.message} ${hint}`)
}
