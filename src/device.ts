type Battery = EventTarget & { charging: boolean; level: number }
type Browser = Navigator & {
  deviceMemory?: number
  standalone?: boolean
  getBattery?: () => Promise<Battery>
}

export function deviceCapabilities() {
  const browser = globalThis.navigator as Browser | undefined
  const ua = browser?.userAgent ?? ''
  const android = /Android/i.test(ua)
  const iphone = /iPhone|iPod/i.test(ua)
  const ipad = /iPad/i.test(ua) || browser?.platform === 'MacIntel' && browser.maxTouchPoints > 1
  const touch = globalThis.matchMedia?.('(pointer: coarse)').matches
  const mobile = android || iphone || ipad || /Mobile/i.test(ua) || !!touch
  const cores = browser?.hardwareConcurrency || 2
  const memory = browser?.deviceMemory
  const wasm = typeof WebAssembly !== 'undefined'
  const sharedMemory = globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined'
  const chrome = /Chrome\/|CriOS\//.test(ua)
  return {
    android, iphone, ipad, mobile, cores, memory, wasm, sharedMemory, chrome,
    mobileSafari: (iphone || ipad) && /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua),
    standalone: !!browser?.standalone || !!globalThis.matchMedia?.('(display-mode: standalone)').matches,
    constrained: cores < 6 || memory === undefined || memory < 4 || !wasm,
  }
}

let battery: Promise<Battery | undefined> | undefined
export function deviceBattery() {
  const browser = globalThis.navigator as Browser | undefined
  return battery ??= (async () => {
    try { return await browser?.getBattery?.() }
    catch { return undefined }
  })()
}

export const lowBattery = (battery?: Battery) => !!battery && !battery.charging && battery.level <= .2
