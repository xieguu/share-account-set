export interface ViewportSize {
  width: number
  height: number
  deviceScaleFactor?: number
}

export interface TabInfo {
  id: string
  title: string
  url: string
  favicon?: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  isActive: boolean
}

export interface MouseInputPayload {
  type: 'mouse'
  event: 'move' | 'down' | 'up' | 'wheel' | 'click' | 'dblclick' | 'contextmenu'
  x: number
  y: number
  button?: 'left' | 'right' | 'middle' | 'none'
  buttons?: number
  clickCount?: number
  deltaX?: number
  deltaY?: number
  modifiers?: {
    ctrl?: boolean
    shift?: boolean
    alt?: boolean
    meta?: boolean
  }
}

export interface KeyboardInputPayload {
  type: 'key'
  event: 'down' | 'up' | 'press' | 'text'
  key: string
  code?: string
  keyCode?: number
  text?: string
  modifiers?: {
    ctrl?: boolean
    shift?: boolean
    alt?: boolean
    meta?: boolean
  }
}

export interface StreamConfig {
  fps: number
  quality: number
  width: number
  height: number
  mode: 'mjpeg' | 'websocket'
}

export interface CursorState {
  style: string
  x: number
  y: number
}

export type WSClientMessage =
  | MouseInputPayload
  | KeyboardInputPayload
  | { type: 'navigate'; url: string }
  | { type: 'nav_action'; action: 'back' | 'forward' | 'reload' | 'stop' | 'home' }
  | { type: 'tab_action'; action: 'create' | 'close' | 'switch'; tabId?: string; url?: string }
  | { type: 'viewport'; width: number; height: number }
  | { type: 'stream_config'; fps?: number; quality?: number; mode?: 'mjpeg' | 'websocket' }
  | { type: 'ping'; timestamp: number }

export type WSServerMessage =
  | { type: 'init'; sessionId: string; viewport: ViewportSize; tabs: TabInfo[]; activeTabId: string; config: StreamConfig }
  | { type: 'tabs'; tabs: TabInfo[]; activeTabId: string }
  | { type: 'page_state'; tabId: string; url: string; title: string; favicon?: string; isLoading: boolean; canGoBack: boolean; canGoForward: boolean }
  | { type: 'cursor'; style: string }
  | { type: 'pong'; timestamp: number; serverTime: number }
  | { type: 'metrics'; fps: number; frameCount: number; clientsCount: number }
  | { type: 'frame'; data: string; timestamp: number }
