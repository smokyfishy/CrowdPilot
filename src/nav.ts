/**
 * Navigation Config — what appears in the top bar. Routes come from src/pages/.
 */

import type { Role } from './constants'

export interface NavItem {
  path: string
  label: string
  roles?: Role[]
  devOnly?: boolean
}

export const nav: NavItem[] = [
  { path: '/mix', label: 'Generate AI Mix' },
  { path: '/api-status', label: 'API status', devOnly: true },
]
