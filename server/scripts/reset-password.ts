// Reset a person's password from the server console:  npm run reset-password
//
// For when nobody can sign in to set it from Manage → People (for example the only
// admin forgot theirs). Asks for the email and the new password (typed hidden), then
// stores only the bcrypt hash, the same way sign-in and Manage → People do.
// Run it on the machine that holds server/.env; it never prints the password.
//
// Options:  --email <address>   skip the email prompt
//           --activate          also re-activate the person if they were deactivated
import 'dotenv/config'
import readline from 'node:readline'
import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    if (hidden) {
      const anyRl = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream }
      anyRl._writeToOutput = (s: string) => {
        if (s.includes(question)) anyRl.output.write(s)
        else if (s === '\r\n' || s === '\n' || s === '\r') anyRl.output.write(s)
        else anyRl.output.write('*'.repeat(s.length))
      }
    }
    rl.question(question, (answer) => {
      rl.close()
      if (hidden) process.stdout.write('\n')
      resolve(answer)
    })
  })
}

async function main() {
  const email = (arg('email') ?? (await ask('Email: '))).trim().toLowerCase()
  if (!email.includes('@')) throw new Error('That is not an email address.')

  const person = await prisma.person.findUnique({ where: { email } })
  if (!person) throw new Error(`No one with the email ${email}. Check Manage → People, or run npm run seed for the first admin.`)

  const next = await ask('New password (at least 10 characters): ', true)
  if (next.length < 10) throw new Error('The new password needs at least 10 characters.')
  const again = await ask('Type it again: ', true)
  if (again !== next) throw new Error('The two passwords do not match. Nothing was changed.')

  const activate = process.argv.includes('--activate')
  await prisma.person.update({
    where: { id: person.id },
    data: { passwordHash: await bcrypt.hash(next, 12), ...(activate ? { active: true } : {}) },
  })

  console.log(`Password changed for ${person.name} <${person.email}> (role: ${person.role}).`)
  if (!person.active && !activate) {
    console.log('Note: this person is deactivated and still cannot sign in. Run again with --activate.')
  }
  console.log('If sign-in says "Too many failed sign-ins", wait 15 minutes or restart the API.')
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
