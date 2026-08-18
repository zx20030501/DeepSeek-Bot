declare module '@deepseek-ai/dsh-settings' {
  export function settingsNamespace(name: string): any
  export function installSettingsSection(...args: any[]): void
}

declare module '@deepseek-ai/dsh-credentials' {
  export function credentialRef(value: string): any
}

declare module '@deepseek-ai/dsh-host-webserver' {
  export interface WebRoute {
    kind: string
    path: string
    handler: (req: any, res: any) => void
  }
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  export type ClientContext = any
  export interface SnapshotStore<T> {
    getSnapshot(): T
    subscribe(listener: () => void): () => void
    update(mutator: (current: T) => void): void
  }
  export function createSnapshotStore<T>(initial: T): SnapshotStore<T>
}

declare module '@deepseek-ai/dsh-client-locale/client' {}
declare module '@deepseek-ai/dsh-client-ui-settings/client' {}
declare module '@deepseek-ai/dsh-client-ui-slots' { export type PropsRuntime<T = any> = Record<string, any> }
declare module '@deepseek-ai/dsh-client-ui-slots/client' {}

declare module 'react' {
  export function useEffect(effect: () => void | (() => void), dependencies?: readonly unknown[]): void
  export function useState<T>(initial: T): [T, (value: T | ((current: T) => T)) => void]
  export function useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T, getServerSnapshot?: () => T): T
  const React: any
  export default React
}

declare namespace React {
  type ReactNode = any
}

declare module 'react/jsx-runtime' {
  export const Fragment: any
  export const jsx: any
  export const jsxs: any
}

declare namespace JSX {
  interface IntrinsicElements {
    [elementName: string]: any
  }
}
