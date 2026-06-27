// "Job Mode" - the combined-device experience. Mic and Speaker each independently ask
// Copilot a question (their controls live in CopilotScreen.jsx, right next to the
// conversation they feed). This tab is specifically for running both together, where the
// interaction changes: Speaker still triggers suggested answers, but Mic stops asking its
// own questions and instead becomes "what you actually said," judged against them.
export default function JudgeTab({ listenMode, listenError, onStartListening, onStopListening }) {
  const active = listenMode === 'both'

  function handleClick() {
    if (active) onStopListening()
    else onStartListening('both')
  }

  return (
    <div className="flex-1 overflow-y-auto px-8 py-6 space-y-6">
      <div>
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Job Mode</h2>
        <p className="text-xs text-gray-500 mb-3">
          Listens to both the interviewer (Speaker) and you (Mic) at once. Speaker still triggers a suggested
          Copilot answer; Mic no longer asks its own questions here - instead, what you actually said is judged
          against that suggestion, showing what you should have said.
        </p>
        <button
          onClick={handleClick}
          disabled
          title="Coming soon"
          className="text-sm px-4 py-2 rounded-lg border opacity-50 cursor-not-allowed border-gray-200 text-gray-400"
        >
          {active ? 'Stop Both' : 'Start Both'}
          <span className="block text-[10px]">Coming soon</span>
        </button>
      </div>

      {listenError && <p className="text-xs text-red-600">{listenError}</p>}
    </div>
  )
}
