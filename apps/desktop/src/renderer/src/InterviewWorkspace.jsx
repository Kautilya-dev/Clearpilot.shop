import { useState } from 'react'
import MaterialsTab from './MaterialsTab'
import QATab from './QATab'
import CopilotScreen from './CopilotScreen'

const TABS = [
  { key: 'materials', label: 'Materials' },
  { key: 'qa', label: 'Q&A' },
  { key: 'copilot', label: 'Copilot' }
]

export default function InterviewWorkspace({ interview, onBack }) {
  const [activeTab, setActiveTab] = useState('copilot')

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="border-b border-gray-200 px-8 pt-4 shrink-0">
        <button onClick={onBack} className="text-xs text-gray-400 hover:text-gray-600 inline-flex items-center gap-1 mb-2">
          &larr; All interviews
        </button>
        <h1 className="text-xl font-semibold tracking-tight">{interview.title}</h1>
        <div className="flex items-center gap-1.5 flex-wrap mt-2 mb-3">
          {interview.subjects.map((s) => (
            <span key={s.id} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
              {s.name}
            </span>
          ))}
        </div>
        <div className="flex gap-1">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`text-sm px-3 py-1.5 rounded-lg ${
                activeTab === tab.key ? 'bg-purple-50 text-purple-700' : 'text-gray-500 hover:bg-gray-50'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Rendered together (not conditionally mounted) so switching tabs doesn't lose an
          in-progress Copilot conversation or re-fetch Materials/Q&A lists every time. */}
      <div className={activeTab === 'materials' ? 'contents' : 'hidden'}>
        <MaterialsTab interviewId={interview.id} />
      </div>
      <div className={activeTab === 'qa' ? 'contents' : 'hidden'}>
        <QATab interviewId={interview.id} />
      </div>
      <div className={activeTab === 'copilot' ? 'contents' : 'hidden'}>
        <CopilotScreen interview={interview} />
      </div>
    </div>
  )
}
