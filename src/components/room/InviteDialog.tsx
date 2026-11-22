import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Copy, Share2 } from 'lucide-react'
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, useToast } from '@/components/ui'

interface InviteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  roomName: string
  roomId: string
  code?: string
}

export function InviteDialog({ open, onOpenChange, roomName, roomId, code }: InviteDialogProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const { success, error } = useToast()
  const [canShare, setCanShare] = useState(false)
  const link = typeof window !== 'undefined' ? `${window.location.origin}/room/${roomId}` : `/room/${roomId}`

  useEffect(() => {
    setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function')
  }, [])

  useEffect(() => {
    if (!open) return
    // The canvas mounts with the dialog; draw on the next frame.
    const id = requestAnimationFrame(() => {
      if (canvasRef.current) {
        void QRCode.toCanvas(canvasRef.current, link, {
          width: 220,
          margin: 1,
          color: { dark: '#151413', light: '#ece6dc' },
          errorCorrectionLevel: 'M',
        })
      }
    })
    return () => cancelAnimationFrame(id)
  }, [open, link])

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text)
      success(`${what} copied`)
    } catch {
      error(`Couldn't copy the ${what.toLowerCase()}`, 'Select it and copy it manually.')
    }
  }

  async function share() {
    try {
      await navigator.share({ title: roomName, text: `Join ${roomName} on CrowdPilot`, url: link })
    } catch {
      // dismissed by the user
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-3xl font-normal">Invite people</DialogTitle>
          <DialogDescription>Scan the code, open the link, or type the room code at the CrowdPilot home page.</DialogDescription>
        </DialogHeader>
        <div className="grid justify-items-center gap-5">
          <canvas ref={canvasRef} width={220} height={220} className="rounded-lg" aria-label={`QR code for ${link}`} role="img" />
          {code && (
            <button
              type="button"
              onClick={() => copy(code, 'Room code')}
              className="text-4xl font-semibold tracking-[0.2em] text-foreground tabular-nums"
              aria-label={`Room code ${code.split('').join(' ')}. Copy`}
            >
              {code}
            </button>
          )}
          <div className="flex w-full items-center gap-2 rounded-full border border-input bg-background py-1 pl-4 pr-1">
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{link}</span>
            <Button size="sm" onClick={() => copy(link, 'Link')}>
              <Copy aria-hidden /> Copy link
            </Button>
          </div>
          {canShare && (
            <Button variant="outline" className="w-full" onClick={share}>
              <Share2 aria-hidden /> Share
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
