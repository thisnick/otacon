import type { ReactNode } from 'react'
import { Card, CardContent } from '@/components/ui/card'

interface Props {
  title: string
  description?: ReactNode
  action?: ReactNode
}

export function EmptyState({ title, description, action }: Props): React.ReactElement {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
        <h3 className="text-base font-medium">{title}</h3>
        {description && (
          <div className="text-sm text-muted-foreground max-w-md">{description}</div>
        )}
        {action}
      </CardContent>
    </Card>
  )
}
