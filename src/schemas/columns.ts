import type { ColumnDefinition, PermissionLevel, RolePermissions } from 'deepspace/schema'

export const text = (name: string, extra: Partial<ColumnDefinition> = {}): ColumnDefinition => ({
  name,
  storage: 'text',
  interpretation: { kind: 'plain' },
  ...extra,
})
export const num = (name: string, extra: Partial<ColumnDefinition> = {}): ColumnDefinition => ({
  name,
  storage: 'number',
  interpretation: { kind: 'plain' },
  ...extra,
})
export const bool = (name: string, extra: Partial<ColumnDefinition> = {}): ColumnDefinition => ({
  name,
  storage: 'number',
  interpretation: { kind: 'boolean' },
  ...extra,
})
export const json = (name: string, extra: Partial<ColumnDefinition> = {}): ColumnDefinition => ({
  name,
  storage: 'text',
  interpretation: { kind: 'json' },
  ...extra,
})

/**
 * Clients never write CrowdPilot collections: every mutation goes through the
 * worker's command route, which uses RBAC-bypassing record tools. So every
 * client role gets create/update/delete = false and only a read level.
 */
export function readOnly(read: PermissionLevel, adminRead: PermissionLevel = read): Record<string, RolePermissions> {
  const role = (r: PermissionLevel): RolePermissions => ({ read: r, create: false, update: false, delete: false })
  return { '*': role(read), viewer: role(read), member: role(read), admin: role(adminRead) }
}
