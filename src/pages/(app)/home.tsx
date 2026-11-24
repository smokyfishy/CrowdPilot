/** Old post-sign-in address: forwards to the mix generator. */
import { Navigate } from 'react-router-dom'

export default function Home() {
  return <Navigate to="/mix" replace />
}
