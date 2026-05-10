# pi-sidebar

Shared status-card sidebar helpers for Pi extensions.

## Why

Multiple Pi extensions may want to show compact status cards in the top-right overlay. If each extension manages its own overlay independently, cards can overlap, flicker, or fight for the same space.

`pi-sidebar` provides a tiny shared registry for status-card layout. Packages that use the same global registry can stack cards consistently even when they are installed and loaded independently.

This is especially useful for:

- Sharing one top-right status-card area across extensions
- Avoiding overlay collisions between independently packaged extensions
- Keeping sidebar visibility and card ordering consistent
- Letting packages remain decoupled while coordinating layout

## What it does

This helper package exports status-card primitives:

- **Shared registry**: stores card state under the `Symbol.for('pi.agent.statusCards.state')` global key.
- **Card lifecycle helpers**: register, unregister, and update status-card layout.
- **Stacking layout**: computes top offsets for visible cards based on order, height, and gaps.
- **Sidebar visibility helpers**: toggles and checks whether the shared sidebar should render.
- **Card rendering helper**: renders a bordered status-card using Pi theme colors.

## Usage

This package does not register Pi tools or slash commands directly. It is intended as a library dependency or vendored helper for other Pi packages.

Packages that expose user-facing Pi behavior should document their own installation steps instead of asking users to install `pi-sidebar` directly.

## Runtime dependencies

This package expects Pi's TUI/theme types at runtime through the host extension environment. It has no external service dependency.
