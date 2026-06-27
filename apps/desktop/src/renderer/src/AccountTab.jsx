import { useEffect, useState } from 'react'

export default function AccountTab({ user, onProfileUpdated, onAccountDeleted }) {
  const [displayName, setDisplayName] = useState(user?.display_name || '')
  const [profileBusy, setProfileBusy] = useState(false)
  const [profileMessage, setProfileMessage] = useState('')
  const [profileError, setProfileError] = useState('')

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [passwordMessage, setPasswordMessage] = useState('')
  const [passwordError, setPasswordError] = useState('')

  const [deleteConfirming, setDeleteConfirming] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  useEffect(() => {
    setDisplayName(user?.display_name || '')
  }, [user])

  async function handleSaveProfile(e) {
    e.preventDefault()
    setProfileBusy(true)
    setProfileError('')
    setProfileMessage('')
    const res = await window.clearpilot.updateProfile(displayName.trim())
    setProfileBusy(false)
    if (res.success) {
      setProfileMessage('Saved.')
      onProfileUpdated(res.user)
    } else {
      setProfileError(res.error || 'Could not save')
    }
  }

  async function handleChangePassword(e) {
    e.preventDefault()
    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters.')
      return
    }
    setPasswordBusy(true)
    setPasswordError('')
    setPasswordMessage('')
    const res = await window.clearpilot.changePassword(currentPassword, newPassword)
    setPasswordBusy(false)
    if (res.success) {
      setPasswordMessage('Password updated.')
      setCurrentPassword('')
      setNewPassword('')
    } else {
      setPasswordError(res.error || 'Could not update password')
    }
  }

  async function handleDeleteAccount() {
    if (!deleteConfirming) {
      setDeleteConfirming(true)
      return
    }
    if (
      !window.confirm(
        'This permanently deletes your account and all interviews, materials, and Q&A. This cannot be undone. Continue?'
      )
    ) {
      return
    }
    setDeleteBusy(true)
    setDeleteError('')
    const res = await window.clearpilot.deleteAccount()
    setDeleteBusy(false)
    if (res.success) onAccountDeleted()
    else setDeleteError(res.error || 'Could not delete account')
  }

  return (
    <div className="space-y-8">
      <section className="border border-gray-200 rounded-xl p-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-700">Profile</h2>
        <form onSubmit={handleSaveProfile} className="space-y-2">
          <label className="block">
            <span className="text-xs text-gray-500">Display name</span>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="field-input mt-1"
            />
          </label>
          <label className="block">
            <span className="text-xs text-gray-500">Email</span>
            <input value={user?.email || ''} disabled className="field-input mt-1 bg-gray-50 text-gray-400" />
          </label>
          {profileError && <p className="text-xs text-red-600">{profileError}</p>}
          {profileMessage && <p className="text-xs text-green-600">{profileMessage}</p>}
          <button
            type="submit"
            disabled={profileBusy}
            className="text-xs bg-purple-600 text-white rounded-lg px-3 py-1.5 disabled:opacity-50"
          >
            Save
          </button>
        </form>
      </section>

      <section className="border border-gray-200 rounded-xl p-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-700">Change Password</h2>
        <form onSubmit={handleChangePassword} className="space-y-2">
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder="Current password"
            className="field-input"
          />
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="New password (min 8 characters)"
            className="field-input"
          />
          {passwordError && <p className="text-xs text-red-600">{passwordError}</p>}
          {passwordMessage && <p className="text-xs text-green-600">{passwordMessage}</p>}
          <button
            type="submit"
            disabled={passwordBusy}
            className="text-xs bg-purple-600 text-white rounded-lg px-3 py-1.5 disabled:opacity-50"
          >
            Update password
          </button>
        </form>
      </section>

      <section className="border border-red-200 rounded-xl p-4 space-y-2">
        <h2 className="text-sm font-semibold text-red-700">Delete Account</h2>
        <p className="text-xs text-gray-500">
          Permanently deletes your account and all interviews, materials, and Q&amp;A. This cannot be undone.
        </p>
        {deleteError && <p className="text-xs text-red-600">{deleteError}</p>}
        <button
          onClick={handleDeleteAccount}
          disabled={deleteBusy}
          className="text-xs bg-red-600 text-white rounded-lg px-3 py-1.5 disabled:opacity-50"
        >
          {deleteConfirming ? 'Click again to confirm' : 'Delete my account'}
        </button>
      </section>
    </div>
  )
}
