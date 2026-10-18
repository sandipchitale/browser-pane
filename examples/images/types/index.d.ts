/** An image the mod found for an [Image #N] tag. */
export type ImagesFile = { path: string }

declare module 'claude-code' {
  interface PluginState {
    'browser-pane-images': {
      draft: string
      files: Record<string, ImagesFile>
      origins: Record<string, string>
      cleared: Record<string, boolean>
    }
  }
}
