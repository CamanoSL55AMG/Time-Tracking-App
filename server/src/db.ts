import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient({ log: ['warn', 'error'] })

/** The transaction client type, for helpers that run inside prisma.$transaction. */
export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
