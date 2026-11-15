import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { z } from 'zod'

/** null is the system default, which follows the OS as it changes. */
export type AudioDevice = { id: string; label: string } | null
export type AudioSide = 'input' | 'output'
export type VoiceSettings = Record<AudioSide, { device: AudioDevice; volume: number }>

export const VOICE_STORAGE_KEY = 'huddle.voice.v1'
const DEFAULT_SIDE = { device: null, volume: 1 }
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = { input: DEFAULT_SIDE, output: DEFAULT_SIDE }

// Each side falls back on its own, so one corrupt half never costs the other.
const StoredSide = z
  .object({
    device: z.object({ id: z.string().min(1).max(1024), label: z.string().max(1024) }).nullable(),
    volume: z.number().min(0).max(1),
  })
  .catch(DEFAULT_SIDE)
const Stored = z.object({ input: StoredSide, output: StoredSide }).catch(DEFAULT_VOICE_SETTINGS)

function load(): VoiceSettings {
  try {
    return Stored.parse(JSON.parse(localStorage.getItem(VOICE_STORAGE_KEY) ?? 'null'))
  } catch {
    return DEFAULT_VOICE_SETTINGS
  }
}

let settings = load()
const listeners = new Set<() => void>()
function notify() {
  for (const listener of listeners) listener()
}
function reload() {
  const next = load()
  if (JSON.stringify(next) === JSON.stringify(settings)) return
  settings = next
  notify()
}
function onStorage({ key }: StorageEvent) {
  if (key === null || key === VOICE_STORAGE_KEY) reload()
}

export const voiceSettings = () => settings

/** Another window's change arrives through `storage` while anything is subscribed. */
export function subscribeVoiceSettings(listener: () => void) {
  if (!listeners.size) {
    settings = load()
    window.addEventListener('storage', onStorage)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) window.removeEventListener('storage', onStorage)
  }
}
export function useVoiceSettings(): VoiceSettings {
  return useSyncExternalStore(subscribeVoiceSettings, voiceSettings)
}

function commit(next: VoiceSettings) {
  settings = next
  try {
    localStorage.setItem(VOICE_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // The choice still applies in this window; it just won't outlive it.
  }
  notify()
}
export function setVoiceDevice(side: AudioSide, device: AudioDevice) {
  commit({ ...settings, [side]: { ...settings[side], device } })
}
export function setVoiceVolume(side: AudioSide, volume: number) {
  const clamped = Math.min(1, Math.max(0, volume))
  commit({ ...settings, [side]: { ...settings[side], volume: clamped } })
}

export const sinkSupported = () =>
  typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype

const KIND = { input: 'audioinput', output: 'audiooutput' } as const
// Chrome lists the OS default and Windows' communications device again under these ids.
const ALIASES = new Set(['default', 'communications'])

/** The stored device among those listed now. Browsers rotate device IDs, for example when site
 *  data is cleared, so a device listed under the stored name is the same device. */
export function findDevice(listed: { id: string; label: string }[], stored: AudioDevice) {
  if (!stored) return null
  return (
    listed.find((item) => item.id === stored.id) ??
    (stored.label ? listed.find((item) => item.label === stored.label) : undefined) ??
    null
  )
}

/** The ID of the stored device when the system lists it right now, or null for the default. */
export async function presentDevice(side: AudioSide): Promise<string | null> {
  try {
    const listed = (await navigator.mediaDevices.enumerateDevices())
      .filter((item) => item.kind === KIND[side] && !ALIASES.has(item.deviceId))
      .map((item) => ({ id: item.deviceId, label: item.label }))
    return findDevice(listed, settings[side].device)?.id ?? null
  } catch {
    return null
  }
}

export type DeviceList = {
  /** The label of the device the OS uses as its default, when the browser says. */
  system: string | null
  devices: { id: string; label: string }[]
}
export type AudioDevices =
  | { kind: 'unsupported' }
  | { kind: 'locked' }
  | { kind: 'denied' }
  | { kind: 'ready'; inputs: DeviceList; outputs: DeviceList; sinkSupported: boolean }

function listOf(entries: MediaDeviceInfo[]): DeviceList {
  const alias = entries.find((entry) => entry.deviceId === 'default')
  const twin = alias && entries.find((e) => !ALIASES.has(e.deviceId) && e.groupId === alias.groupId)
  return {
    system: twin?.label || alias?.label.replace(/^Default - /, '') || null,
    devices: entries
      .filter((entry) => !ALIASES.has(entry.deviceId))
      .map((entry) => ({ id: entry.deviceId, label: entry.label })),
  }
}

async function microphonePermission(): Promise<PermissionState | null> {
  try {
    return (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state
  } catch {
    return null
  }
}

async function readDevices(): Promise<AudioDevices> {
  const media = navigator.mediaDevices
  if (!media?.enumerateDevices || !media.getUserMedia) return { kind: 'unsupported' }
  const permission = await microphonePermission()
  if (permission === 'denied') return { kind: 'denied' }
  const listed = await media.enumerateDevices()
  const inputs = listed.filter((entry) => entry.kind === 'audioinput')
  const outputs = listed.filter((entry) => entry.kind === 'audiooutput')
  // Browsers hide labels until someone allows the microphone.
  const locked = inputs.length ? inputs.some((entry) => !entry.label) : permission !== 'granted'
  if (locked) return { kind: 'locked' }
  return {
    kind: 'ready',
    inputs: listOf(inputs),
    outputs: listOf(outputs),
    sinkSupported: sinkSupported(),
  }
}

/** The devices the system reports, kept current as devices come and go. `null` until first read. */
export function useAudioDevices() {
  const [devices, setDevices] = useState<AudioDevices | null>(null)
  const reads = useRef(0)
  const refresh = useCallback(async () => {
    const read = ++reads.current
    const next = await readDevices().catch((): AudioDevices => ({ kind: 'locked' }))
    if (read === reads.current) setDevices(next)
  }, [])
  useEffect(() => {
    void refresh()
    const media = navigator.mediaDevices
    const onChange = () => void refresh()
    media?.addEventListener?.('devicechange', onChange)
    let permission: PermissionStatus | null = null
    let gone = false
    navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((status) => {
        if (gone) return
        permission = status
        status.addEventListener('change', onChange)
      })
      .catch(() => {})
    return () => {
      gone = true
      reads.current++
      media?.removeEventListener?.('devicechange', onChange)
      permission?.removeEventListener('change', onChange)
    }
  }, [refresh])
  return {
    devices,
    refresh,
    /** Asks for the microphone only to learn device names, and lets it go at once. */
    async allow() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        for (const track of stream.getTracks()) track.stop()
      } finally {
        await refresh()
      }
    },
  }
}
