## Showing live flights around WLG

We live on the flight path. It would be super nice to show the incoming/outgoing air traffic in the scene, with faint paths of where they've been.

We can get data from adsb.lol and show it.

### Fetch transponder data

```ts
// Configuration constants
const API_URL = "https://adsb.lol";
const CURFEW_START_HOUR = 1; // 1:00 AM
const CURFEW_END_HOUR = 5; // 5:00 AM
const CURFEW_END_MINUTE = 30; // 5:30 AM

async function fetchWellingtonAircraftData() {
  try {
    // 1. CURFEW CHECK: Determine if polling should be active based on local NZ time
    const nzDate = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Pacific/Auckland" })
    );
    const hours = nzDate.getHours();
    const minutes = nzDate.getMinutes();

    // Check if current time falls within 1:00 AM - 5:30 AM
    const isAfterCurfewStart = hours >= CURFEW_START_HOUR;
    const isBeforeCurfewEnd =
      hours < CURFEW_END_HOUR ||
      (hours === CURFEW_END_HOUR && minutes < CURFEW_END_MINUTE);

    if (isAfterCurfewStart && isBeforeCurfewEnd) {
      console.log(
        "Wellington Airport curfew active (1:00 AM - 5:30 AM). Polling suspended."
      );

      // OPTIONAL: Clear any leftover planes from the sky if they didn't purge cleanly
      if (activePlanes.size > 0) {
        clearAllActivePlanes();
      }
      return null;
    }

    // 2. NETWORK FETCH
    const response = await fetch(API_URL);

    if (!response.ok) {
      throw new Error(`HTTP network error! Status: ${response.status}`);
    }

    const data = await response.json();

    // 3. VALIDATION: Handle empty airspace or structural exceptions safely
    if (!data || !data.ac || !Array.isArray(data.ac) || data.ac.length === 0) {
      console.log(
        "Airspace quiet. No aircraft currently detected inside the 50km Wellington radius."
      );
      return []; // Return empty array safely to allow your clean-up loops to run
    }

    // Return the clean, validated array of aircraft objects
    return data.ac;
  } catch (error) {
    // Gracefully log errors without crashing your Three.js requestAnimationFrame render loop
    console.error(
      "Failed to fetch live flight streams from ADSB cluster:",
      error
    );
    return null;
  }
}

// Helper function to empty out your Three.js Map cache during curfew hours
function clearAllActivePlanes() {
  for (const [icao, planeData] of activePlanes.entries()) {
    scene.remove(planeData.mesh);
    scene.remove(planeData.pathMesh);
    planeData.pathGeometry.dispose();
    activePlanes.delete(icao);
  }
  console.log("Cleared 3D environment for the night.");
}

// Wrapper engine loop running every 10 seconds
setInterval(async () => {
  const aircraftList = await fetchWellingtonAircraftData();

  // Skip updating meshes if curfew is active or network dropped
  if (aircraftList === null) return;

  // Process flights (Case A, Case B, and Case C from your original Three.js script)
  processThreeJsFlightUpdates(aircraftList);
}, 10000);
```

### Render in the scene

```ts
import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

// -------------------------------------------------------------
// 1. GLOBAL SCENE CONFIGURATION & CONSTANTS
// -------------------------------------------------------------
const WLG_LAT = -41.327;
const WLG_LON = 174.805;
const SCALE = 0.001;
const MAX_PATH_POINTS = 40; // Total segments tracked before dropping off

const activePlanes = new Map();

// Define your color structure (RGB format normalized between 0.0 and 1.0)
const TRAIL_COLOR_START = { r: 0.0, g: 1.0, b: 1.0 }; // Glowing Neon Cyan
const TRAIL_COLOR_END = { r: 0.05, g: 0.05, b: 0.1 }; // Fades down to match a dark sky/scene color

// Global material with vertex colors enabled
const fadingPathMaterial = new LineMaterial({
  vertexColors: true,
  linewidth: 4,
  dashed: false,
  resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
});

// -------------------------------------------------------------
// 2. HELPER: LAT/LON GPS TO METRIC 3D SPACE
// -------------------------------------------------------------
function gpsToThree(lat, lon, altFeet) {
  const z = (lat - WLG_LAT) * 111000 * SCALE;
  const x =
    (lon - WLG_LON) * (111000 * Math.cos((WLG_LAT * Math.PI) / 180)) * SCALE;
  const y = altFeet * 0.3048 * SCALE;
  return new THREE.Vector3(x, y, z);
}

// -------------------------------------------------------------
// 3. MAIN CORE DATA LOOP AND TRAIL GENERATOR
// -------------------------------------------------------------
async function updateWellingtonFlights() {
  try {
    const response = await fetch("https://adsb.lol");
    const data = await response.json();
    const currentInFlight = new Set();

    if (data.ac) {
      data.ac.forEach((aircraft) => {
        if (!aircraft.lat || !aircraft.lon || aircraft.alt_baro === "ground")
          return;

        const icao = aircraft.hex;
        const callsign = (aircraft.flight || "UNK").trim();
        const position = gpsToThree(
          aircraft.lat,
          aircraft.lon,
          aircraft.alt_baro
        );

        currentInFlight.add(icao);

        if (activePlanes.has(icao)) {
          // ---------------------------------------------------------
          // CASE A: PLANE ALREADY EXISTS - CALCULATE DYNAMIC COLORS & GEOMETRY
          // ---------------------------------------------------------
          const planeData = activePlanes.get(icao);

          // Core mesh transform modifications
          planeData.mesh.position.lerp(position, 0.15);
          planeData.mesh.rotation.y = -aircraft.track * (Math.PI / 180);

          // Push latest verified raw flight coordinate
          planeData.history.push(position.clone());
          if (planeData.history.length > MAX_PATH_POINTS) {
            planeData.history.shift();
          }

          const pointsArray = [];
          const colorsArray = [];
          const totalPoints = planeData.history.length;

          planeData.history.forEach((p, index) => {
            // Append position coordinate indexes
            pointsArray.push(p.x, p.y, p.z);

            // Linear Interpolation calculation factor (0 = oldest point, 1 = newest point)
            const t = index / (totalPoints - 1);

            // Blend between the starting neon cyan color and background fading shadow color
            const r =
              TRAIL_COLOR_END.r + (TRAIL_COLOR_START.r - TRAIL_COLOR_END.r) * t;
            const g =
              TRAIL_COLOR_END.g + (TRAIL_COLOR_START.g - TRAIL_COLOR_END.g) * t;
            const b =
              TRAIL_COLOR_END.b + (TRAIL_COLOR_START.b - TRAIL_COLOR_END.b) * t;

            colorsArray.push(r, g, b);
          });

          // Update parameters dynamically inside the vertex data blocks
          planeData.pathGeometry.setPositions(pointsArray);
          planeData.pathGeometry.setColors(colorsArray);
          planeData.pathMesh.computeLineDistances();
        } else {
          // ---------------------------------------------------------
          // CASE B: NEW PLANE ARRIVED - INITIALIZE STRUCTURAL BUFFER
          // ---------------------------------------------------------
          const geometry = new THREE.ConeGeometry(0.4, 1.8, 4);
          const material = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
          const mesh = new THREE.Mesh(geometry, material);
          mesh.position.copy(position);
          scene.add(mesh);

          // Initialize array using double duplicates to satisfy LineGeometry's requirement for >= 2 vectors
          const history = [position.clone(), position.clone()];

          const pathGeometry = new LineGeometry();
          pathGeometry.setPositions([
            position.x,
            position.y,
            position.z,
            position.x,
            position.y,
            position.z,
          ]);

          // Assign identical initial starting base colors to avoid structural validation crashes
          pathGeometry.setColors([
            TRAIL_COLOR_START.r,
            TRAIL_COLOR_START.g,
            TRAIL_COLOR_START.b,
            TRAIL_COLOR_START.r,
            TRAIL_COLOR_START.g,
            TRAIL_COLOR_START.b,
          ]);

          const pathMesh = new Line2(pathGeometry, fadingPathMaterial);
          scene.add(pathMesh);

          activePlanes.set(icao, {
            mesh,
            callsign,
            history,
            pathGeometry,
            pathMesh,
          });
        }
      });
    }

    // -------------------------------------------------------------
    // DISPOSAL MANAGEMENT: SCRUB LANDED PLANES & FREE MEMORY
    // -------------------------------------------------------------
    for (const [icao, planeData] of activePlanes.entries()) {
      if (!currentInFlight.has(icao)) {
        scene.remove(planeData.mesh);
        scene.remove(planeData.pathMesh);
        planeData.pathGeometry.dispose(); // Drop GPU layout array blocks cleanly
        activePlanes.delete(icao);
      }
    }
  } catch (error) {
    console.error(
      "Critical stream error handling dynamic trail generation:",
      error
    );
  }
}

// -------------------------------------------------------------
// 4. EVENT LISTENER HOOK CONFIGURATIONS
// -------------------------------------------------------------
window.addEventListener("resize", () => {
  fadingPathMaterial.resolution.set(window.innerWidth, window.innerHeight);
});

// Run loop interval sequence
setInterval(updateWellingtonFlights, 10000);
updateWellingtonFlights();
```
