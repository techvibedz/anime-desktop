/**
 * SVG filter used by `.lg-refract` (src/global.css): a displacement map that is
 * neutral (0.5) in the middle and pushes the backdrop outward near the edges,
 * so content behind a glass control bends at its rim like a lens — the
 * defining Liquid Glass cue. Mounted once at the app root.
 */
const MAP =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100' preserveAspectRatio='none'>` +
      `<defs>` +
      `<linearGradient id='x' x1='0' x2='1' y1='0' y2='0'>` +
      `<stop offset='0' stop-color='rgb(0,128,0)'/><stop offset='0.22' stop-color='rgb(128,128,0)'/>` +
      `<stop offset='0.78' stop-color='rgb(128,128,0)'/><stop offset='1' stop-color='rgb(255,128,0)'/>` +
      `</linearGradient>` +
      `<linearGradient id='y' x1='0' x2='0' y1='0' y2='1'>` +
      `<stop offset='0' stop-color='rgb(0,0,0)'/><stop offset='0.22' stop-color='rgb(0,128,0)'/>` +
      `<stop offset='0.78' stop-color='rgb(0,128,0)'/><stop offset='1' stop-color='rgb(0,255,0)'/>` +
      `</linearGradient>` +
      `</defs>` +
      `<rect width='100' height='100' fill='url(#x)'/>` +
      `<rect width='100' height='100' fill='url(#y)' style='mix-blend-mode:screen'/>` +
    `</svg>`,
  );

export function LiquidGlassDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden focusable="false">
      <filter id="lg-refract" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB" primitiveUnits="objectBoundingBox">
        <feImage href={MAP} x="0" y="0" width="1" height="1" preserveAspectRatio="none" result="map" />
        <feDisplacementMap in="SourceGraphic" in2="map" scale="0.12" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  );
}
