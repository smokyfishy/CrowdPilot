import { useState } from 'react'
import { cn } from '@/lib/utils'

interface ArtworkProps {
  src?: string
  title: string
  className?: string
  /** Decorative when the title is already shown next to it (the default). */
  decorative?: boolean
}

function initials(title: string): string {
  const words = title.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean)
  return (words[0]?.[0] ?? '♪').concat(words[1]?.[0] ?? '').toUpperCase()
}

/** Square track artwork. YouTube thumbnails are 16:9, so they are cropped to the centre square. */
export function Artwork({ src, title, className, decorative = true }: ArtworkProps) {
  const [failed, setFailed] = useState(false)
  const showImage = src && !failed
  return (
    <div
      className={cn('relative aspect-square max-w-full shrink-0 overflow-hidden rounded-md bg-secondary', className)}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : `Artwork for ${title}`}
      aria-hidden={decorative || undefined}
    >
      {showImage ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="absolute inset-0 grid place-items-center font-display text-[1.4em] text-muted-foreground">
          {initials(title)}
        </span>
      )}
    </div>
  )
}
