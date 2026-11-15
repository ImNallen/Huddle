import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { ChevronDown, Mic, MicOff, TriangleAlert, Volume2 } from 'lucide-react'
import { Alert } from './primitives'
import { callsUnsupported, microphoneDenied, microphoneProblem } from './voiceCall'
import {
  findDevice,
  presentDevice,
  setVoiceDevice,
  setVoiceVolume,
  sinkSupported,
  useAudioDevices,
  useVoiceSettings,
  voiceSettings,
  type AudioSide,
  type DeviceList,
  type VoiceSettings,
} from './voiceSettings'

const COPY = {
  input: {
    device: 'Input device',
    volume: 'Input volume',
    fallback: 'Default microphone',
    missing: 'Your microphone',
  },
  output: {
    device: 'Output device',
    volume: 'Output volume',
    fallback: 'Default speakers',
    missing: 'Your speakers',
  },
}

export type MicTest =
  | { phase: 'idle' }
  | { phase: 'listening'; secondsLeft: number }
  | { phase: 'playing' }

const LISTEN_SECONDS = 4
const BARS = 32
const HOT_BARS = 5
const FLOOR_DB = -48
const WINDOW = 1024

/** Bars lit for a peak sample, on a decibel scale so quiet speech still moves the meter. */
function barsFor(peak: number) {
  if (peak <= 0) return 0
  const share = (20 * Math.log10(peak) - FLOOR_DB) / -FLOOR_DB
  return Math.round(Math.min(1, Math.max(0, share)) * BARS)
}
function peakOf(samples: Float32Array) {
  let peak = 0
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
  return peak
}

class Refused extends Error {}

type MicTestRun = {
  device: string | null
  phase: () => MicTest['phase']
  follow: (settings: VoiceSettings) => void
  stop: () => void
}

/** Records a few seconds through the input volume, then plays them on the chosen output. Every
 *  track, context, and object URL is released on every path, including `stop`. */
function startMicTest(
  onPhase: (test: MicTest) => void,
  onLevel: (bars: number) => void,
  onEnd: (problem: string) => void,
): MicTestRun {
  let over = false
  let phase: MicTest['phase'] = 'listening'
  let stream: MediaStream | null = null
  let context: AudioContext | null = null
  let gain: GainNode | null = null
  let sound: HTMLAudioElement | null = null
  let url = ''
  let frame = 0
  let timer = 0
  const device = voiceSettings().input.device?.id ?? null
  let shown = 0
  // Peaks fall back a bar per frame, so a short sound stays readable.
  const meterTo = (bars: number) => {
    shown = Math.max(bars, shown - 1)
    onLevel(shown)
  }

  function release() {
    over = true
    cancelAnimationFrame(frame)
    clearInterval(timer)
    for (const track of stream?.getTracks() ?? []) track.stop()
    if (context?.state !== 'closed') void context?.close().catch(() => {})
    if (sound) {
      sound.pause()
      sound.removeAttribute('src')
      sound.load()
    }
    if (url) URL.revokeObjectURL(url)
  }
  function show(next: MicTest) {
    phase = next.phase
    onPhase(next)
  }
  async function run() {
    const input = await presentDevice('input')
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: input ? { deviceId: { exact: input } } : true,
      })
    } catch (error) {
      throw new Refused(microphoneProblem(error))
    }
    if (over) return release()
    const listening = new AudioContext()
    context = listening
    // Created after the permission prompt, so it may start suspended and record silence.
    void listening.resume().catch(() => {})
    gain = listening.createGain()
    gain.gain.value = voiceSettings().input.volume
    const analyser = listening.createAnalyser()
    analyser.fftSize = WINDOW
    const recording = listening.createMediaStreamDestination()
    listening.createMediaStreamSource(stream).connect(gain)
    gain.connect(analyser)
    gain.connect(recording)
    const recorder = new MediaRecorder(recording.stream)
    const chunks: Blob[] = []
    recorder.ondataavailable = (event) => chunks.push(event.data)
    const recorded = new Promise((resolve) => (recorder.onstop = resolve))
    recorder.start()
    const samples = new Float32Array(WINDOW)
    const meter = () => {
      analyser.getFloatTimeDomainData(samples)
      meterTo(barsFor(peakOf(samples)))
      frame = requestAnimationFrame(meter)
    }
    meter()
    let secondsLeft = LISTEN_SECONDS
    show({ phase: 'listening', secondsLeft })
    timer = window.setInterval(() => {
      secondsLeft -= 1
      if (secondsLeft > 0) return show({ phase: 'listening', secondsLeft })
      clearInterval(timer)
      recorder.stop()
    }, 1000)
    await recorded
    if (over) return
    cancelAnimationFrame(frame)
    // The microphone closes before playback, so the test never hears itself.
    for (const track of stream.getTracks()) track.stop()
    gain = null
    shown = 0
    onLevel(0)
    show({ phase: 'playing' })

    const blob = new Blob(chunks, { type: recorder.mimeType })
    const peaks = await listening
      .decodeAudioData(await blob.arrayBuffer())
      .then((buffer) => {
        const data = buffer.getChannelData(0)
        const list: number[] = []
        for (let start = 0; start < data.length; start += WINDOW)
          list.push(barsFor(peakOf(data.subarray(start, start + WINDOW))))
        return { list, rate: buffer.sampleRate }
      })
      .catch(() => null)
    if (over) return
    url = URL.createObjectURL(blob)
    const playing = new Audio(url)
    sound = playing
    playing.volume = voiceSettings().output.volume
    const output = await presentDevice('output')
    if (output && sinkSupported()) await playing.setSinkId(output)
    if (over) return
    const ended = new Promise((resolve, reject) => {
      playing.onended = resolve
      playing.onerror = reject
    })
    await playing.play()
    const follow = () => {
      if (peaks) meterTo(peaks.list[Math.floor((playing.currentTime * peaks.rate) / WINDOW)] ?? 0)
      frame = requestAnimationFrame(follow)
    }
    follow()
    await ended
    if (over) return
    release()
    onEnd('')
  }
  void run().catch((error: unknown) => {
    if (over) return
    release()
    onEnd(
      error instanceof Refused
        ? error.message
        : phase === 'listening'
          ? "Your microphone didn't start. Try again."
          : "Huddle couldn't play your test back. Try again.",
    )
  })
  return {
    device,
    phase: () => phase,
    follow(settings) {
      gain?.gain.setTargetAtTime(settings.input.volume, gain.context.currentTime, 0.02)
      if (sound) sound.volume = settings.output.volume
    },
    stop: release,
  }
}

function useMicTest(settings: VoiceSettings) {
  const [test, setTest] = useState<MicTest>({ phase: 'idle' })
  const [level, setLevel] = useState(0)
  const [problem, setProblem] = useState('')
  const running = useRef<MicTestRun | null>(null)
  const stop = useCallback(() => {
    running.current?.stop()
    running.current = null
    setTest({ phase: 'idle' })
    setLevel(0)
  }, [])
  const start = useCallback(() => {
    running.current?.stop()
    setProblem('')
    setTest({ phase: 'listening', secondsLeft: LISTEN_SECONDS })
    running.current = startMicTest(setTest, setLevel, (message) => {
      running.current = null
      setTest({ phase: 'idle' })
      setLevel(0)
      setProblem(message)
    })
  }, [])
  useEffect(() => () => running.current?.stop(), [])
  useEffect(() => running.current?.follow(settings), [settings])
  const device = settings.input.device?.id ?? null
  useEffect(() => {
    const run = running.current
    // A new input applies to the meter at once, so listening starts over on it.
    if (run && run.phase() === 'listening' && run.device !== device) start()
  }, [device, start])
  return { test, level, problem, start, stop }
}

const NOTES = [
  { frequency: 659.25, at: 0 },
  { frequency: 987.77, at: 0.16 },
]

/** A two-note chime through an `<audio>` element, so the output device and volume apply. */
function playChime(onEnd: (problem: string) => void) {
  let over = false
  let timer = 0
  const context = new AudioContext()
  const destination = context.createMediaStreamDestination()
  const sound = new Audio()
  sound.srcObject = destination.stream
  sound.volume = voiceSettings().output.volume
  function release() {
    over = true
    clearTimeout(timer)
    sound.pause()
    sound.srcObject = null
    if (context.state !== 'closed') void context.close().catch(() => {})
  }
  async function run() {
    const output = await presentDevice('output')
    if (output && sinkSupported()) await sound.setSinkId(output)
    if (over) return
    await context.resume()
    await sound.play()
    const start = context.currentTime + 0.05
    for (const { frequency, at } of NOTES) {
      const tone = context.createOscillator()
      const envelope = context.createGain()
      tone.frequency.value = frequency
      envelope.gain.setValueAtTime(0, start + at)
      envelope.gain.linearRampToValueAtTime(0.3, start + at + 0.015)
      envelope.gain.exponentialRampToValueAtTime(0.001, start + at + 0.9)
      tone.connect(envelope).connect(destination)
      tone.start(start + at)
      tone.stop(start + at + 0.95)
    }
    timer = window.setTimeout(() => {
      release()
      onEnd('')
    }, 1300)
  }
  void run().catch(() => {
    if (over) return
    release()
    onEnd("Huddle couldn't play the test sound. Try again.")
  })
  return {
    release,
    follow(volume: number) {
      sound.volume = volume
    },
  }
}

function DeviceField({
  side,
  list,
  settings,
}: {
  side: AudioSide
  list: DeviceList | null
  settings: VoiceSettings
}) {
  const id = useId()
  const { device } = settings[side]
  const present = list && findDevice(list.devices, device)
  return (
    <div className="voice-field">
      <label htmlFor={id}>{COPY[side].device}</label>
      <span className="voice-select">
        <select
          id={id}
          value={present ? present.id : ''}
          disabled={!list}
          onChange={(event) => {
            const chosen = list?.devices.find((item) => item.id === event.target.value)
            setVoiceDevice(side, chosen ? { id: chosen.id, label: chosen.label } : null)
          }}
        >
          <option value="">
            {list?.system ? `Default · ${list.system}` : COPY[side].fallback}
          </option>
          {list?.devices.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        <ChevronDown size={16} aria-hidden="true" />
      </span>
      {list && device && !present && (
        <p className="voice-note">
          <TriangleAlert size={14} aria-hidden="true" />
          {device.label || COPY[side].missing} disconnected. Using the default until it's back.
        </p>
      )}
    </div>
  )
}

function VolumeField({
  side,
  disabled,
  settings,
}: {
  side: AudioSide
  disabled?: boolean
  settings: VoiceSettings
}) {
  const id = useId()
  const percent = Math.round(settings[side].volume * 100)
  return (
    <div className="voice-field">
      <label htmlFor={id}>{COPY[side].volume}</label>
      <span className="voice-volume">
        <input
          id={id}
          type="range"
          min={0}
          max={100}
          step={1}
          value={percent}
          disabled={disabled}
          aria-valuetext={`${percent}%`}
          style={{ '--fill': `${percent}%` } as CSSProperties}
          onChange={(event) => setVoiceVolume(side, Number(event.target.value) / 100)}
        />
        <output aria-hidden="true">{percent}%</output>
      </span>
    </div>
  )
}

function Meter({ bars, disabled }: { bars: number; disabled: boolean }) {
  return (
    <div
      className={`voice-meter ${disabled ? 'is-disabled' : ''}`}
      role="meter"
      aria-label="Microphone level"
      aria-valuemin={0}
      aria-valuemax={BARS}
      aria-valuenow={bars}
    >
      {Array.from({ length: BARS }, (_, index) => (
        <i
          key={index}
          className={index < bars ? (index >= BARS - HOT_BARS ? 'is-hot' : 'is-lit') : undefined}
        />
      ))}
    </div>
  )
}

const TEST_COPY = {
  idle: {
    title: 'Mic test',
    body: () => 'Talk for a few seconds. Huddle plays it back so you hear what others hear.',
  },
  listening: {
    title: 'Listening…',
    body: (test: MicTest) =>
      test.phase === 'listening'
        ? `Say something. Playback starts in ${test.secondsLeft} ${test.secondsLeft === 1 ? 'second' : 'seconds'}.`
        : '',
  },
  playing: { title: 'Playing back', body: () => 'This is how you sound to others.' },
} satisfies Record<MicTest['phase'], { title: string; body: (test: MicTest) => string }>

export function VoiceTab() {
  const settings = useVoiceSettings()
  const { devices, allow } = useAudioDevices()
  const [allowProblem, setAllowProblem] = useState('')
  const mic = useMicTest(settings)
  const [chiming, setChiming] = useState(false)
  const [chimeProblem, setChimeProblem] = useState('')
  const chime = useRef<ReturnType<typeof playChime> | null>(null)
  useEffect(() => () => chime.current?.release(), [])
  useEffect(() => {
    chime.current?.follow(settings.output.volume)
  }, [settings.output.volume])

  const ready = devices?.kind === 'ready' ? devices : null
  const routing = ready ? ready.sinkSupported : sinkSupported()
  const testing = mic.test.phase !== 'idle'
  const copy = TEST_COPY[mic.test.phase]
  async function askForMicrophone() {
    setAllowProblem('')
    try {
      await allow()
    } catch (error) {
      setAllowProblem(microphoneProblem(error))
    }
  }
  const banner =
    devices?.kind === 'locked'
      ? {
          text: 'Allow the microphone to choose a device and test how you sound.',
          action: 'Allow microphone',
        }
      : devices?.kind === 'denied'
        ? { text: microphoneDenied(), action: 'Try again' }
        : devices?.kind === 'unsupported'
          ? { text: callsUnsupported(), action: null }
          : null
  return (
    <>
      <section className="voice-card" aria-labelledby="voice-microphone">
        <h2 id="voice-microphone">
          <Mic size={18} aria-hidden="true" />
          Microphone
        </h2>
        {banner && (
          <div className="voice-banner">
            <MicOff size={18} aria-hidden="true" />
            <p>{banner.text}</p>
            {banner.action && (
              <button
                type="button"
                className="button primary small"
                onClick={() => void askForMicrophone()}
              >
                {banner.action}
              </button>
            )}
          </div>
        )}
        <Alert message={devices?.kind === 'denied' ? '' : allowProblem} />
        <div className="voice-fields">
          <DeviceField side="input" list={ready?.inputs ?? null} settings={settings} />
          <VolumeField side="input" disabled={!ready} settings={settings} />
        </div>
        <div className={`voice-test ${ready ? '' : 'is-disabled'}`}>
          <div className="voice-test-text">
            <strong role="status">{copy.title}</strong>
            <p>{copy.body(mic.test)}</p>
          </div>
          <Meter bars={mic.level} disabled={!ready} />
          <button
            type="button"
            className="voice-button"
            disabled={!ready && !testing}
            onClick={testing ? mic.stop : mic.start}
          >
            {testing ? 'Stop test' : 'Test microphone'}
          </button>
        </div>
        <Alert message={mic.problem} />
      </section>
      <section className="voice-card" aria-labelledby="voice-speakers">
        <h2 id="voice-speakers">
          <Volume2 size={18} aria-hidden="true" />
          Speakers
        </h2>
        <div className="voice-fields">
          {routing ? (
            <DeviceField side="output" list={ready?.outputs ?? null} settings={settings} />
          ) : (
            <div className="voice-field">
              <span className="voice-field-label">{COPY.output.device}</span>
              <span className="voice-system">Set by your system</span>
              <p className="voice-note">Change speakers in your computer's sound settings.</p>
            </div>
          )}
          <VolumeField side="output" settings={settings} />
        </div>
        <div className="voice-test">
          <div className="voice-test-text">
            <strong>Speaker test</strong>
            <p>Plays a short chime on the device above.</p>
          </div>
          <button
            type="button"
            className="voice-button"
            disabled={chiming}
            onClick={() => {
              setChimeProblem('')
              setChiming(true)
              chime.current = playChime((problem) => {
                chime.current = null
                setChiming(false)
                setChimeProblem(problem)
              })
            }}
          >
            {chiming ? 'Playing…' : 'Play test sound'}
          </button>
        </div>
        <Alert message={chimeProblem} />
      </section>
      <p className="settings-footnote">
        Audio choices stay on this device. During a call, changes apply right away.
      </p>
    </>
  )
}
