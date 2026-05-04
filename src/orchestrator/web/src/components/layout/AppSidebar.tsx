import { Link, useLocation } from 'react-router-dom'
import { ListChecks, FolderKanban, Users } from 'lucide-react'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar'
import { ThemeToggle } from '@/components/layout/ThemeToggle'
import { ServerHealthIndicator } from '@/components/layout/ServerHealthIndicator'

interface NavItem {
  label: string
  to: string
  icon: typeof ListChecks
  /** Match exactly when truthy, otherwise prefix-match. */
  exact?: boolean
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Runs', to: '/', icon: ListChecks, exact: true },
  { label: 'Workspaces', to: '/workspaces', icon: FolderKanban },
  { label: 'Teams', to: '/teams', icon: Users },
]

function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.to
  return pathname === item.to || pathname.startsWith(item.to + '/')
}

export function AppSidebar(): React.ReactElement {
  const { pathname } = useLocation()
  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <span className="font-semibold text-sm">otacon</span>
          <span className="ml-auto text-xs text-muted-foreground">
            orchestrator
          </span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon
                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive(pathname, item)}
                      data-testid={`nav-${item.label.toLowerCase()}`}
                    >
                      <Link to={item.to}>
                        <Icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div className="flex items-center justify-between gap-2 px-2 py-1.5">
          <ServerHealthIndicator />
          <ThemeToggle />
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
