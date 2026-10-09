import type { Prisma } from '@prisma/client'
import type { Tx } from '../db.js'

// The change feed. Written in the same transaction as the change it describes, so
// a reader of /events never sees an event for something that did not commit.

export type EventType =
  | 'punch.started'
  | 'punch.ended'
  | 'punch.switched'
  | 'punch.edited'
  | 'punch.added'
  | 'job.upserted'
  | 'person.upserted'
  | 'approval.signed'
  | 'approval.approved'
  | 'approval.reopened'
  | 'webhook.test'

export const EVENT_TYPES: EventType[] = [
  'punch.started',
  'punch.ended',
  'punch.switched',
  'punch.edited',
  'punch.added',
  'job.upserted',
  'person.upserted',
  'approval.signed',
  'approval.approved',
  'approval.reopened',
  'webhook.test',
]

export async function emit(tx: Tx, companyId: string, type: EventType, payload: Record<string, unknown>): Promise<void> {
  await tx.event.create({
    data: { companyId, type, payload: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue },
  })
}
