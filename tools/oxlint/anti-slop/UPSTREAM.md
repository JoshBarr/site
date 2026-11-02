# Upstream

Vendored from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop)
(MIT), commit `13909c9e07590f5a85d93c62712259fe14a883f7` (2026-10-13): the
plugin bundled with its install skill, `skills/install-anti-slop/assets/anti-slop/`,
copied here unchanged.

Installed against `oxlint` and `@oxlint/plugins` 1.90.0. Upstream pins 1.78.0.

## Local changes

- `package.json` added, marking these files as ES modules, so Node loads
  them without warning.

## Configuration (in `.oxlintrc.json`)

- Every generic rule is on, at `error`, except `no-shape-in-symbol-names`:
  "shape" is a domain term here (GTFS route shapes, cloud shape noise,
  three.js `Shape`).
- The Effect rules (`effect/`) are copied but not enabled: the app doesn't
  use Effect.
