import { useState, type ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

interface Props {
  trigger: ReactNode
  title: string
  body: ReactNode
  confirmLabel?: string
  destructive?: boolean
  /** When set, the user must type this exact string to enable the confirm button. */
  typedConfirm?: string
  onConfirm: () => void | Promise<void>
}

export function ConfirmDialog({
  trigger,
  title,
  body,
  confirmLabel = 'Confirm',
  destructive,
  typedConfirm,
  onConfirm,
}: Props): React.ReactElement {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const ready = !typedConfirm || typed === typedConfirm

  async function handle(e: React.MouseEvent): Promise<void> {
    e.preventDefault()
    if (!ready || busy) return
    try {
      setBusy(true)
      await onConfirm()
      setOpen(false)
      setTyped('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="text-sm text-muted-foreground">{body}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {typedConfirm && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="confirm-input">
              Type <code className="font-mono">{typedConfirm}</code> to confirm
            </Label>
            <Input
              id="confirm-input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              data-testid="confirm-dialog-input"
              autoComplete="off"
            />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handle}
            disabled={!ready || busy}
            data-testid="confirm-dialog-confirm"
            className={cn(destructive && 'bg-destructive text-destructive-foreground hover:bg-destructive/90')}
          >
            {busy ? 'Working...' : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
