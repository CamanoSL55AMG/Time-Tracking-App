import jwt from 'jsonwebtoken'
import { config } from '../config.js'

export interface SessionClaims {
  sub: string // person id
  cid: string // company id
}

export function signSession(claims: SessionClaims): string {
  return jwt.sign(claims, config.jwtSecret, { algorithm: 'HS256', expiresIn: `${config.sessionDays}d` })
}

export function verifySession(token: string): SessionClaims | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] })
    if (typeof decoded !== 'object' || decoded === null) return null
    const { sub, cid } = decoded as Record<string, unknown>
    if (typeof sub !== 'string' || typeof cid !== 'string') return null
    return { sub, cid }
  } catch {
    return null
  }
}
