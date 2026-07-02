import { useState, useEffect } from 'react'
import AccountTab from './AccountTab'
import AnswerTemplateTab from './AnswerTemplateTab'
import StylingTab from './StylingTab'
import BehaviourTab from './BehaviourTab'

const TABS = [
  { key: 'account', label: 'Account' },
  { key: 'template', label: 'Answer Template' },
  { key: 'openai', label: 'OpenAI' },
  { key: 'styling', label: 'Styling' },
  { key: 'behaviour', label: 'Behaviour' }
]

function OpenAITab() {
  const [apiKey, setApiKey] = useState('')
  const [saved, setSaved] = useState(false)
  const [show, setShow] = useState(false)

  useEffect(() => {
    window.clearpilot.getSettings().then((res) => setApiKey(res.settings?.openai?.apiKey || ''))
  }, [])

  async function handleSave() {
    await window.clearpilot.saveSettings({ openai: { apiKey } })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">OpenAI API Key</label>
        <p className="text-xs text-gray-500 mb-2">
          Used directly by the desktop app for speaker/mic transcription via the Realtime API.
          Never sent to the ClearPilot server.
        </p>
        <div className="flex gap-2">
          <input
            type={show ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-proj-..."
            className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
          <button
            onClick={() => setShow((v) => !v)}
            className="px-3 py-2 text-xs border border-gray-300 rounded-md text-gray-600 hover:bg-gray-50"
          >
            {show ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
      <button
        onClick={handleSave}
        className="px-4 py-2 bg-purple-600 text-white text-sm rounded-md hover:bg-purple-700"
      >
        {saved ? 'Saved!' : 'Save'}
      </button>
    </div>
  )
}

export default function SettingsScreen({ user, onProfileUpdated, onAccountDeleted }) {
  const [activeTab, setActiveTab] = useState('account')

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="max-w-xl mx-auto px-8 py-10">
        <h1 className="text-2xl font-semibold tracking-tight mb-4">Settings</h1>

        <div className="flex gap-1 mb-6 border-b border-gray-200">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`text-sm px-3 py-2 -mb-px border-b-2 ${
                activeTab === tab.key
                  ? 'border-purple-600 text-purple-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === 'account' && (
          <AccountTab user={user} onProfileUpdated={onProfileUpdated} onAccountDeleted={onAccountDeleted} />
        )}
        {activeTab === 'template' && <AnswerTemplateTab user={user} onProfileUpdated={onProfileUpdated} />}
        {activeTab === 'openai' && <OpenAITab />}
        {activeTab === 'styling' && <StylingTab />}
        {activeTab === 'behaviour' && <BehaviourTab />}
      </div>
    </main>
  )
}
