/** /join/:code — resolves a 6-character room code to its room and redirects. */
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { roomApi } from '@/client/api'

export default function JoinByCode() {
  const { code = '' } = useParams()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    roomApi.byCode(code).then((r) => {
      if (cancelled) return
      if (r.ok) navigate(`/room/${r.value.roomId}`, { replace: true })
      else setError(r.error.code === 'NOT_FOUND' ? `No room uses the code ${code.toUpperCase()}.` : r.error.message)
    })
    return () => {
      cancelled = true
    }
  }, [code, navigate])

  return (
    <div className="mx-auto grid max-w-md gap-4 px-4 py-24 text-center">
      <title>Joining · CrowdPilot</title>
      {error ? (
        <>
          <h1 className="font-display text-4xl text-foreground">Room not found</h1>
          <p className="text-muted-foreground">{error} Codes are six letters and numbers; ask the host to show theirs again.</p>
          <Link to="/" className="justify-self-center rounded-full border border-input px-5 py-2.5 text-sm font-semibold hover:bg-accent">
            Enter a different code
          </Link>
        </>
      ) : (
        <p className="text-muted-foreground" role="status">
          Finding room {code.toUpperCase()}…
        </p>
      )}
    </div>
  )
}
