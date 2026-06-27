import { useState } from 'react'
import AccountTab from './AccountTab'
import StylingTab from './StylingTab'
import BehaviourTab from './BehaviourTab'

const TABS = [
  { key: 'account', label: 'Account' },
  { key: 'styling', label: 'Styling' },
  { key: 'behaviour', label: 'Behaviour' }
]

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
        {activeTab === 'styling' && <StylingTab />}
        {activeTab === 'behaviour' && <BehaviourTab />}
      </div>
    </main>
  )
}
