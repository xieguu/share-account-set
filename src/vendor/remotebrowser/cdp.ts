import type { CDPSession, Page } from 'playwright'
import type { MouseInputPayload, KeyboardInputPayload } from './types.js'

export function computeModifiersBitmask(modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }): number {
  if (!modifiers) return 0
  let bitmask = 0
  if (modifiers.alt) bitmask |= 1
  if (modifiers.ctrl) bitmask |= 2
  if (modifiers.meta) bitmask |= 4
  if (modifiers.shift) bitmask |= 8
  return bitmask
}

export async function dispatchCdpMouseEvent(cdp: CDPSession, mouse: MouseInputPayload): Promise<void> {
  const modifiers = computeModifiersBitmask(mouse.modifiers)
  const x = Math.max(0, Math.round(mouse.x))
  const y = Math.max(0, Math.round(mouse.y))

  const buttonMap: Record<string, string> = {
    left: 'left',
    right: 'right',
    middle: 'middle',
    none: 'none'
  }

  const button = mouse.button ? (buttonMap[mouse.button] || 'left') : 'none'
  const buttons = mouse.buttons ?? (mouse.event === 'down' ? (button === 'right' ? 2 : button === 'middle' ? 4 : 1) : 0)

  switch (mouse.event) {
    case 'move':
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
        button: button as any,
        buttons,
        modifiers
      })
      break

    case 'down':
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: (button === 'none' ? 'left' : button) as any,
        buttons: buttons || 1,
        clickCount: mouse.clickCount || 1,
        modifiers
      })
      break

    case 'up':
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: (button === 'none' ? 'left' : button) as any,
        buttons: 0,
        clickCount: mouse.clickCount || 1,
        modifiers
      })
      break

    case 'click':
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: (button === 'none' ? 'left' : button) as any,
        buttons: 1,
        clickCount: 1,
        modifiers
      })
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: (button === 'none' ? 'left' : button) as any,
        buttons: 0,
        clickCount: 1,
        modifiers
      })
      break

    case 'dblclick':
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        buttons: 1,
        clickCount: 2,
        modifiers
      })
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        buttons: 0,
        clickCount: 2,
        modifiers
      })
      break

    case 'contextmenu':
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'right',
        buttons: 2,
        clickCount: 1,
        modifiers
      })
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'right',
        buttons: 0,
        clickCount: 1,
        modifiers
      })
      break

    case 'wheel':
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX: mouse.deltaX || 0,
        deltaY: mouse.deltaY || 0,
        modifiers
      })
      break
  }
}

// RelayHub modification: keep keyboard dispatch on the selected CDP target.
// No Playwright keyboard shortcut path or silent fallback; preserve down/up state.
export async function dispatchCdpKeyEvent(_page: Page, cdp: CDPSession, keyMsg: KeyboardInputPayload): Promise<void> {
  const modifiers = computeModifiersBitmask(keyMsg.modifiers)

  if (keyMsg.event === 'text' && keyMsg.text) {
    await cdp.send('Input.insertText', { text: keyMsg.text })
    return
  }

  const enterText = keyMsg.key === 'Enter' && !keyMsg.modifiers?.ctrl && !keyMsg.modifiers?.meta && !keyMsg.modifiers?.alt
  const type = keyMsg.event === 'up' ? 'keyUp' : enterText ? 'keyDown' : 'rawKeyDown'
  await cdp.send('Input.dispatchKeyEvent', {
    type,
    key: keyMsg.key,
    code: keyMsg.code || '',
    windowsVirtualKeyCode: keyMsg.keyCode || 0,
    ...(keyMsg.event !== 'up' && enterText ? { text: '\r', unmodifiedText: '\r' } : keyMsg.text ? { text: keyMsg.text } : {}),
    modifiers
  })
}
