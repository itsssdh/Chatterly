import type { JSX as ReactJSX } from 'react'
import type { ChatterlyApi } from '@shared/ipc'

declare global {
  namespace JSX {
    type Element = ReactJSX.Element
  }
  interface Window {
    api: ChatterlyApi
  }
}
