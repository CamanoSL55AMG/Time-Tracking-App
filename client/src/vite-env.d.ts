/// <reference types="vite/client" />

// The parts of Google Identity Services (https://accounts.google.com/gsi/client) the sign-in page uses.
interface GoogleCredentialResponse {
  credential: string
}
interface Window {
  google?: {
    accounts: {
      id: {
        initialize: (options: { client_id: string; callback: (r: GoogleCredentialResponse) => void; ux_mode?: 'popup' | 'redirect' }) => void
        renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void
      }
    }
  }
}

// This build's id, baked in by vite.config.ts; the same id is written to version.json.
declare const __APP_BUILD__: string
