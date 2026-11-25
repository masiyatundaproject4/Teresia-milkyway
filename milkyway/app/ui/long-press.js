const INTERACTIVE = 'input, textarea, select, audio, video, [contenteditable="true"]';

export function bindLongPress(element, action, delay = 550) {
  let timer = 0;
  let pointer = null;
  let startX = 0;
  let startY = 0;
  let lastTriggeredAt = 0;

  const clear = () => {
    clearTimeout(timer);
    timer = 0;
    pointer = null;
  };
  const start = event => {
    if (event.button !== undefined && event.button !== 0) return;
    if (event.target.closest?.(INTERACTIVE)) return;
    clear();
    pointer = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    timer = setTimeout(() => {
      timer = 0;
      lastTriggeredAt = Date.now();
      action(event);
    }, delay);
  };
  const move = event => {
    if (event.pointerId !== pointer) return;
    if (Math.hypot(event.clientX - startX, event.clientY - startY) > 12) clear();
  };
  const context = event => {
    event.preventDefault();
    if (Date.now() - lastTriggeredAt > 800) {
      lastTriggeredAt = Date.now();
      action(event);
    }
    clear();
  };
  const suppressClick = event => {
    if (Date.now() - lastTriggeredAt > 800) return;
    event.preventDefault();
    event.stopPropagation();
  };

  element.addEventListener('pointerdown', start);
  element.addEventListener('pointermove', move);
  element.addEventListener('pointerup', clear);
  element.addEventListener('pointercancel', clear);
  element.addEventListener('pointerleave', clear);
  element.addEventListener('contextmenu', context);
  element.addEventListener('click', suppressClick, true);
  return () => {
    clear();
    element.removeEventListener('pointerdown', start);
    element.removeEventListener('pointermove', move);
    element.removeEventListener('pointerup', clear);
    element.removeEventListener('pointercancel', clear);
    element.removeEventListener('pointerleave', clear);
    element.removeEventListener('contextmenu', context);
    element.removeEventListener('click', suppressClick, true);
  };
}
