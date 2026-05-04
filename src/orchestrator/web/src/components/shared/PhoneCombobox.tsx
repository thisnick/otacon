import { useEffect, useState } from 'react'
import { Check, ChevronsUpDown, Phone } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { listPhones } from '@/lib/api-client'
import type { PhoneEntry } from '@/lib/types'

interface Props {
  value: string
  onChange: (next: string) => void
  /** When true, allow free-form entry of a phone number not in the registry. */
  allowFreeform?: boolean
  placeholder?: string
}

export function PhoneCombobox({
  value,
  onChange,
  allowFreeform = true,
  placeholder = 'Pick a phone number',
}: Props): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [phones, setPhones] = useState<PhoneEntry[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    let cancelled = false
    listPhones()
      .then((list) => {
        if (!cancelled) setPhones(list)
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const matchedRegistry = phones.find((p) => p.phoneNumber === value)
  const display = matchedRegistry?.displayLabel ?? value ?? placeholder

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
          data-testid="phone-combobox-trigger"
        >
          <span className="flex items-center gap-2 truncate">
            <Phone className="size-4 text-muted-foreground" />
            <span className={cn(!value && 'text-muted-foreground')}>
              {value ? display : placeholder}
            </span>
          </span>
          <ChevronsUpDown className="size-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command shouldFilter={true}>
          <CommandInput
            placeholder="Search phone number..."
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            {loadError && (
              <div className="p-3 text-xs text-destructive">
                Couldn't load phones: {loadError}
              </div>
            )}
            <CommandEmpty>
              {allowFreeform && search ? (
                <button
                  type="button"
                  onClick={() => {
                    onChange(search)
                    setOpen(false)
                  }}
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-accent"
                  data-testid="phone-combobox-freeform"
                >
                  Use "{search}" anyway
                </button>
              ) : (
                <div className="p-3 text-sm text-muted-foreground">
                  No phones found.
                </div>
              )}
            </CommandEmpty>
            {phones.length > 0 && (
              <CommandGroup heading="Registry phones">
                {phones.map((p) => (
                  <CommandItem
                    key={p.phoneNumber}
                    value={`${p.phoneNumber} ${p.displayLabel}`}
                    onSelect={() => {
                      onChange(p.phoneNumber)
                      setOpen(false)
                    }}
                    data-testid={`phone-combobox-item-${p.phoneNumber}`}
                  >
                    <Check
                      className={cn(
                        'size-4',
                        value === p.phoneNumber ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    <span className="font-mono text-xs">{p.phoneNumber}</span>
                    <span className="text-xs text-muted-foreground truncate">
                      {p.displayLabel}
                    </span>
                    <span
                      className={cn(
                        'ml-auto text-xs',
                        p.status === 'online'
                          ? 'text-emerald-600'
                          : 'text-muted-foreground',
                      )}
                    >
                      {p.status}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
