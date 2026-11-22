import { useEffect, useState } from 'react'
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Switch } from '@/components/ui'
import type { RoomState } from '@/domain/types'
import type { RoomCommand } from '@/server/commands'

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  room: RoomState
  run: (cmd: RoomCommand) => Promise<{ ok: boolean }>
}

export function SettingsDialog({ open, onOpenChange, room, run }: SettingsDialogProps) {
  const [name, setName] = useState(room.name)
  const [limit, setLimit] = useState(room.perGuestLimit)
  const [confirmClose, setConfirmClose] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setName(room.name)
      setLimit(room.perGuestLimit)
      setConfirmClose(false)
    }
  }, [open, room.name, room.perGuestLimit])

  async function save() {
    const patch: Extract<RoomCommand, { type: 'updateSettings' }>['patch'] = {}
    if (name.trim() && name.trim() !== room.name) patch.name = name.trim()
    if (limit !== room.perGuestLimit) patch.perGuestLimit = limit
    if (Object.keys(patch).length === 0) return onOpenChange(false)
    setSaving(true)
    const r = await run({ type: 'updateSettings', patch })
    setSaving(false)
    if (r.ok) onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-3xl font-normal">Room settings</DialogTitle>
          <DialogDescription>Changes apply to everyone in the room right away.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-5">
          <div className="grid gap-1.5">
            <Label htmlFor="settings-name">Room name</Label>
            <Input id="settings-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="settings-requests">Guests can add songs</Label>
              <p className="text-sm text-muted-foreground">Turn off to pause requests. Voting stays on.</p>
            </div>
            <Switch
              id="settings-requests"
              checked={room.guestRequestsEnabled}
              onCheckedChange={(checked) => run({ type: 'updateSettings', patch: { guestRequestsEnabled: checked } })}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="settings-anon">Guests can join without signing in</Label>
              <p className="text-sm text-muted-foreground">People already in the room stay in.</p>
            </div>
            <Switch
              id="settings-anon"
              checked={room.allowAnonymousGuests}
              onCheckedChange={(checked) => run({ type: 'updateSettings', patch: { allowAnonymousGuests: checked } })}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="settings-limit">Songs each guest can have waiting</Label>
            <div className="flex items-center gap-3">
              <input
                id="settings-limit"
                type="range"
                min={1}
                max={10}
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
                className="flex-1 accent-[var(--color-primary)]"
              />
              <span className="w-6 text-right font-semibold tabular-nums">{limit}</span>
            </div>
          </div>

          <div className="grid gap-2 border-t border-border pt-5">
            {confirmClose ? (
              <div className="grid gap-3 rounded-lg border border-destructive/50 p-4">
                <p className="text-sm text-foreground">End the room for everyone? Playback stops and the link stops accepting new guests. This can't be undone.</p>
                <div className="flex gap-2">
                  <Button variant="destructive" onClick={() => run({ type: 'closeRoom' }).then(() => onOpenChange(false))}>
                    End room
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirmClose(false)}>
                    Keep it open
                  </Button>
                </div>
              </div>
            ) : (
              <Button variant="ghost" className="w-fit text-destructive hover:text-destructive" onClick={() => setConfirmClose(true)}>
                End room…
              </Button>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
