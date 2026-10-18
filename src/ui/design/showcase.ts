// Live reference page for the design system (design-system.html).
import './components.css';
import './showcase.css';
import { mountIcons } from './icons.ts';
import { mountKeys } from './keys.ts';

mountIcons();
mountKeys();

// Keep the slider fill in step with its value.
for (const slider of document.querySelectorAll<HTMLInputElement>('.slider')) {
  const paint = () => slider.style.setProperty('--value', `${slider.value}%`);
  slider.addEventListener('input', paint);
  paint();
}

// Segmented tabs and option lists are single-select.
for (const group of document.querySelectorAll('[role=tablist], [role=listbox]')) {
  group.addEventListener('click', (event) => {
    const item = (event.target as Element).closest('[role=tab], [role=option]');
    if (!item) return;
    for (const other of group.querySelectorAll('[aria-selected]')) other.setAttribute('aria-selected', String(other === item));
  });
}

// Dials: drag vertically to turn.
for (const dial of document.querySelectorAll<HTMLElement>('.dial')) {
  let angle = 0;
  dial.addEventListener('pointerdown', (down) => {
    const start = down.clientY;
    const from = angle;
    dial.setPointerCapture(down.pointerId);
    const move = (e: PointerEvent) => {
      angle = Math.max(-135, Math.min(135, from + (start - e.clientY) * 2));
      dial.style.setProperty('--angle', `${angle}deg`);
    };
    dial.addEventListener('pointermove', move);
    dial.addEventListener('pointerup', () => dial.removeEventListener('pointermove', move), { once: true });
  });
}
