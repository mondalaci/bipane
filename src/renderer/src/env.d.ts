/// <reference types="vite/client" />

import type { BipaneApi } from '@shared/api'

declare global {
  interface Window {
    bipane: BipaneApi
  }
}

export {}
