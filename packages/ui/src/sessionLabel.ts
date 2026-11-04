import { desktopUserAgent } from '@huddle/contracts'

const browsers: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\//, 'Opera'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
]
const platforms: [RegExp, string][] = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/Macintosh/, 'Mac'],
  [/Windows/, 'Windows'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
]
export function sessionLabel(userAgent: string | null) {
  if (!userAgent) return 'Session'
  if (userAgent.startsWith(desktopUserAgent)) return desktopUserAgent
  const browser = browsers.find(([pattern]) => pattern.test(userAgent))?.[1]
  if (!browser) return 'Session'
  const platform = platforms.find(([pattern]) => pattern.test(userAgent))?.[1]
  return platform ? `${browser} on ${platform}` : browser
}
