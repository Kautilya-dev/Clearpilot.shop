import { useEffect, useState } from 'react'

export default function BehaviourTab() {
  const [loading, setLoading] = useState(true)
  const [stealthEnabled, setStealthEnabled] = useState(false)
  const [alwaysOnTop, setAlwaysOnTop] = useState(false)
  const [opacityPct, setOpacityPct] = useState(100)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([window.clearpilot.getSettings(), window.clearpilot.getStealthStatus()]).then(
      ([settingsRes, stealthStatus]) => {
        if (settingsRes.success) {
          setAlwaysOnTop(settingsRes.settings.window.alwaysOnTop)
          setOpacityPct(Math.round(settingsRes.settings.window.opacity * 100))
        }
        setStealthEnabled(!!stealthStatus?.enabled)
        setLoading(false)
      }
    )
  }, [])

  async function handleStealthToggle(enabled) {
    setError('')
    const res = await window.clearpilot.toggleStealth(enabled)
    if (!res?.success) {
      setError(res?.error || 'Could not change stealth mode')
      return
    }
    setStealthEnabled(enabled)
    window.clearpilot.saveSettings({ behavior: { stealthMode: enabled } })
  }

  async function handleAlwaysOnTopToggle(enabled) {
    setAlwaysOnTop(enabled)
    await window.clearpilot.saveSettings({ window: { alwaysOnTop: enabled } })
  }

  async function handleOpacityChange(pct) {
    setOpacityPct(pct)
    await window.clearpilot.saveSettings({ window: { opacity: pct / 100 } })
  }

  if (loading) return <p className="text-sm text-gray-400">Loading...</p>

  return (
    <div className="space-y-6">
      {error && <p className="text-xs text-red-600">{error}</p>}

      <section className="border border-gray-200 rounded-xl p-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-700">Stealth Mode</h2>
          <p className="text-xs text-gray-500 mt-0.5">Hide this window from screen sharing and screenshots.</p>
        </div>
        <label className="inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={stealthEnabled}
            onChange={(e) => handleStealthToggle(e.target.checked)}
            className="sr-only peer"
          />
          <span className="w-9 h-5 bg-gray-200 peer-checked:bg-purple-600 rounded-full relative transition-colors after:absolute after:top-0.5 after:left-0.5 after:bg-white after:w-4 after:h-4 after:rounded-full after:transition-transform peer-checked:after:translate-x-4" />
        </label>
      </section>

      <section className="border border-gray-200 rounded-xl p-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-700">Always On Top</h2>
          <p className="text-xs text-gray-500 mt-0.5">Keep this window above all others.</p>
        </div>
        <label className="inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={alwaysOnTop}
            onChange={(e) => handleAlwaysOnTopToggle(e.target.checked)}
            className="sr-only peer"
          />
          <span className="w-9 h-5 bg-gray-200 peer-checked:bg-purple-600 rounded-full relative transition-colors after:absolute after:top-0.5 after:left-0.5 after:bg-white after:w-4 after:h-4 after:rounded-full after:transition-transform peer-checked:after:translate-x-4" />
        </label>
      </section>

      <section className="border border-gray-200 rounded-xl p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-700">Transparency</h2>
          <span className="text-xs text-gray-500">{opacityPct}%</span>
        </div>
        <input
          type="range"
          min={40}
          max={100}
          value={opacityPct}
          onChange={(e) => handleOpacityChange(Number(e.target.value))}
          className="w-full"
        />
      </section>
    </div>
  )
}
