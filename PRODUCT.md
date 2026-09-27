# Product

## Register

product

## Users

Arabic-speaking anime fans (RTL UI, Arabic strings throughout) watching on Windows/Linux desktops, mostly at night in dim rooms. They come to binge or catch the newest episode the moment it airs; sessions are long and poster-driven browsing is the main discovery mode. Same account syncs with the mobile app.

## Product Purpose

Pantoufa is a backend-free desktop anime streaming app that scrapes witanime + anime4up and plays every server natively through a built-in video proxy. Success = the user finds tonight's episode in under three clicks and playback starts without fiddling with servers.

## Brand Personality

Cinematic, immersive, confident. The artwork is the interface; chrome stays out of the way. Feels like a private theater, not a website.

## Anti-references

- Netflix-clone top-nav with glassmorphism cards (the previous design).
- Generic SaaS dark mode: gray cards, borders everywhere, badge soup.
- Ad-cluttered anime streaming sites the sources themselves look like.

## Design Principles

1. **Art first, chrome last** — posters and stills carry the screen; UI elements earn their pixels.
2. **Night-room legible** — near-black canvas, text contrast ≥ 4.5:1, no washed-out grays.
3. **Three clicks to playing** — every surface optimizes the path resume → episode → play.
4. **Arabic is the first-class script** — type system chosen for Arabic rendering, not Latin with fallback.
5. **Fast is a feature** — lazy routes, no render churn, instant-feeling navigation.

## Accessibility & Inclusion

RTL-first layout (logical properties everywhere). Reduced-motion alternatives for all animation. Keyboard-reachable player controls. WCAG AA contrast on text.
