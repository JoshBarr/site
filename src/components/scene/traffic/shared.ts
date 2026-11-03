import type { Traffic } from "./sim";

// The traffic running on the highways, for other layers' vehicles on the
// same roads (buses) to share them with: set while the traffic layer's up.

interface Highways {
  traffic: Traffic | null;
}

export const highways: Highways = { traffic: null };
