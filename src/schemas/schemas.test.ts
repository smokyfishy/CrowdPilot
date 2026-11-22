import { describe, expect, it } from 'vitest'
import { schemas } from '../schemas'
import { C } from './names'

const appOwned = schemas.filter((s) => !['users', 'settings'].includes(s.name))

describe('CrowdPilot schemas', () => {
  it('registers every CrowdPilot collection', () => {
    const names = schemas.map((s) => s.name)
    for (const name of Object.values(C)) expect(names).toContain(name)
  })

  it('grants no client role create/update/delete on any CrowdPilot collection', () => {
    for (const schema of appOwned) {
      for (const [role, p] of Object.entries(schema.permissions)) {
        expect({ collection: schema.name, role, create: p.create, update: p.update, delete: p.delete }).toEqual({
          collection: schema.name,
          role,
          create: false,
          update: false,
          delete: false,
        })
      }
    }
  })

  it('keeps command_receipts unreadable by every role', () => {
    const receipts = schemas.find((s) => s.name === C.receipts)
    expect(receipts).toBeDefined()
    for (const p of Object.values(receipts?.permissions ?? {})) expect(p.read).toBe(false)
  })

  it('does not expose the rooms directory to anonymous or viewer roles', () => {
    const rooms = schemas.find((s) => s.name === C.rooms)
    expect(rooms?.permissions['*'].read).toBe(false)
    expect(rooms?.permissions.viewer.read).toBe(false)
    expect(rooms?.permissions.member.read).toBe('own')
  })
})
