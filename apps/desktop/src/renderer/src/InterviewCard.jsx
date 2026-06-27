export const STATE_STYLES = {
  active: 'bg-purple-50 text-purple-700',
  completed: 'bg-green-50 text-green-700',
  archived: 'bg-gray-100 text-gray-500'
}

export default function InterviewCard({ interview, onClick, onDelete }) {
  return (
    <div className="border border-gray-200 rounded-xl p-4 hover:border-purple-300 transition">
      <button onClick={onClick} className="w-full text-left">
        <div className="flex items-start justify-between gap-3 mb-2">
          <p className="text-sm font-medium">{interview.title}</p>
          <span
            className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${STATE_STYLES[interview.state] || 'bg-gray-100 text-gray-500'}`}
          >
            {interview.state}
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {interview.subjects.map((s) => (
            <span key={s.id} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
              {s.name}
            </span>
          ))}
        </div>
      </button>
      {onDelete && (
        <div className="flex justify-between items-center mt-2 pt-2 border-t border-gray-100">
          <p className="text-xs text-gray-400">{new Date(interview.created_at).toLocaleDateString()}</p>
          <button onClick={onDelete} className="text-xs text-gray-400 hover:text-red-600">
            Delete
          </button>
        </div>
      )}
    </div>
  )
}
