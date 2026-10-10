import type { Scheme, Tab } from '../types'
import { palette } from './tokens'

// The dashboard's own navigation icons (components/app-navigation.tsx), as
// lucide draws them: a 24-unit grid, a two-unit round stroke, no fill.
const SHAPES: Record<Exclude<Tab, 'linear'>, string> = {
  // GitBranch
  git: '<path d="M15 6a9 9 0 0 0-9 9V3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>',
  // Inbox
  errors:
    '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  // Server
  services:
    '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  // Bot
  console:
    '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
}

// Linear's own mark (features/linear/linear-logo.tsx): a filled shape, not a stroke.
const LINEAR =
  '<path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z"/>'

type Ink = 'ink' | 'inkDim' | 'paper'

/**
 * A style sheet giving each class its colour from the palette. A drawing is
 * an image and follows no theme of its own: under a theme that is light or
 * dark by name the colours are that palette's; under one that follows the
 * system (`auto`), the dark palette's, with the light one's wherever the
 * system is light.
 */
function inks(scheme: Scheme, classes: Readonly<Record<string, readonly ['stroke' | 'fill', Ink]>>): string {
  const rules = (isLight: boolean): string =>
    Object.entries(classes)
      .map(([name, [property, ink]]) => `.${name}{${property}:${palette(isLight)[ink]}}`)
      .join('')
  if (scheme !== 'auto') return `<style>${rules(scheme === 'light')}</style>`

  return `<style>${rules(false)}@media (prefers-color-scheme: light){${rules(true)}}</style>`
}

/** A view's icon as an SVG document, in the ink of the view in front or of one at rest. */
export function tabIcon(tab: Tab, ink: 'ink' | 'inkDim', scheme: Scheme): string {
  if (tab === 'linear') {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${inks(scheme, { a: ['fill', ink] })}<g class="a">${LINEAR}</g></svg>`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inks(scheme, { a: ['stroke', ink] })}<g class="a">${SHAPES[tab]}</g></svg>`
}

/**
 * NoMoreIDE's mark (assets/nomoreide-logo.svg without its tile): a folder
 * with a prompt in it. The folder is ink, the prompt cut out of it paper.
 */
export function logo(scheme: Scheme): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="2 8 60 54">${inks(scheme, { a: ['fill', 'ink'], b: ['stroke', 'paper'] })}<path class="a" d="M5 17C5 13.69 7.69 11 11 11H25L31 17H53C56.31 17 59 19.69 59 23V53C59 56.31 56.31 59 53 59H11C7.69 59 5 56.31 5 53V17Z"/><path class="b" d="M22 31L30 39L22 47" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="4.5"/><path class="b" d="M36 47H48" fill="none" stroke-linecap="round" stroke-width="4.5"/></svg>`
}

/** A meter: a rounded track `width` by `height`, its first `filled` units inked. */
export function meterSvg(scheme: Scheme, width: number, height: number, filled: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${inks(scheme, { a: ['fill', 'inkDim'], b: ['fill', 'ink'] })}<rect class="a" width="${width}" height="${height}" rx="${height / 2}" fill-opacity="0.28"/><rect class="b" width="${filled}" height="${height}" rx="${height / 2}"/></svg>`
}
