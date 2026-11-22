import { Link } from 'react-router-dom'
import { Logo } from '../components/brand/Logo'

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 text-center">
      <title>Page not found · CrowdPilot</title>
      <meta name="robots" content="noindex" />
      <Logo compact />
      <div>
        <h1 className="font-display text-5xl text-foreground">Nothing is playing here</h1>
        <p className="mt-3 text-muted-foreground">This page doesn't exist. Check the link, or start from the beginning.</p>
      </div>
      <Link to="/" className="rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90">
        Go to CrowdPilot
      </Link>
    </div>
  )
}
